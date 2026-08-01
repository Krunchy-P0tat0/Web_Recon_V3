import {
  db,
  scrapeJobsTable,
  differentialHistoryTable,
  type ScrapeJobRecord,
  type DiffHistoryRecord,
  type InsertDiffHistory,
} from "@workspace/db";
import { eq, sql, desc } from "drizzle-orm";
import { logger } from "./logger";
import type { ArticleLink } from "./scraper";

export type { ScrapeJobRecord, DiffHistoryRecord };

function mapRawRow(raw: Record<string, unknown>): ScrapeJobRecord {
  return {
    jobId: raw["job_id"] as string,
    seedUrl: raw["seed_url"] as string,
    status: raw["status"] as string,
    totalArticles: raw["total_articles"] as number,
    completedArticles: raw["completed_articles"] as number,
    includeImages: raw["include_images"] as boolean,
    retryCount: raw["retry_count"] as number,
    maxRetries: raw["max_retries"] as number,
    errorMessage: (raw["error_message"] as string | null) ?? null,
    currentArticle: (raw["current_article"] as string | null) ?? null,
    zipPath: (raw["zip_path"] as string | null) ?? null,
    downloadUrl: (raw["download_url"] as string | null) ?? null,
    articlesJson: raw["articles_json"] as string,
    claimedBy: (raw["claimed_by"] as string | null) ?? null,
    createdAt: raw["created_at"] as Date,
    updatedAt: raw["updated_at"] as Date,
    claimedAt: (raw["claimed_at"] as Date | null) ?? null,
    completedAt: (raw["completed_at"] as Date | null) ?? null,
    diffMode: (raw["diff_mode"] as boolean | null) ?? false,
    baseJobId: (raw["base_job_id"] as string | null) ?? null,
  };
}

export async function enqueueJob(
  jobId: string,
  seedUrl: string,
  totalArticles: number,
  includeImages: boolean,
  articles: ArticleLink[],
  diffMode = false,
  baseJobId: string | null = null
): Promise<void> {
  await db.insert(scrapeJobsTable).values({
    jobId,
    seedUrl,
    status: "queued",
    totalArticles,
    completedArticles: 0,
    includeImages,
    retryCount: 0,
    maxRetries: 3,
    articlesJson: JSON.stringify(articles),
    createdAt: new Date(),
    updatedAt: new Date(),
    diffMode,
    baseJobId: baseJobId ?? undefined,
  });
  logger.info({ jobId, totalArticles, diffMode, baseJobId }, "QUEUE: job enqueued");
}

// ---------------------------------------------------------------------------
// Claim: picks up queued jobs AND failed jobs eligible for retry
// ---------------------------------------------------------------------------

export async function claimNextJob(
  workerId: string
): Promise<ScrapeJobRecord | null> {
  try {
    const rows = await db.execute(sql`
      UPDATE scrape_jobs
      SET status     = 'running',
          claimed_by = ${workerId},
          claimed_at = NOW(),
          updated_at = NOW()
      WHERE job_id = (
        SELECT job_id FROM scrape_jobs
        WHERE (
          status = 'queued'
          OR (status = 'failed' AND retry_count < max_retries)
        )
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `);
    const raw = rows.rows[0] as Record<string, unknown> | undefined;
    const record = raw ? mapRawRow(raw) : null;
    if (record) {
      logger.info(
        { jobId: record.jobId, workerId, retryCount: record.retryCount },
        "QUEUE: job claimed"
      );
    }
    return record;
  } catch (err) {
    logger.error({ err, workerId }, "QUEUE: failed to claim job");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export async function updateJobProgress(
  jobId: string,
  updates: {
    completedArticles?: number;
    currentArticle?: string | null;
  }
): Promise<void> {
  try {
    await db
      .update(scrapeJobsTable)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(scrapeJobsTable.jobId, jobId));
  } catch {
    // Non-critical progress sync — swallow to avoid spamming logs
  }
}

// ---------------------------------------------------------------------------
// ZIP path update (post-regeneration)
// ---------------------------------------------------------------------------

/**
 * Updates the zip_path and download_url on a completed job record.
 * Called after regeneration so the download endpoint can find the new ZIP.
 */
export async function updateJobZipPath(
  jobId: string,
  zipPath: string | null,
  downloadUrl: string | null
): Promise<void> {
  await db
    .update(scrapeJobsTable)
    .set({ zipPath, downloadUrl, updatedAt: new Date() })
    .where(eq(scrapeJobsTable.jobId, jobId));
  logger.info({ jobId, zipPath }, "QUEUE: zip path updated");
}

// ---------------------------------------------------------------------------
// Terminal states
// ---------------------------------------------------------------------------

export async function markJobDone(
  jobId: string,
  zipPath: string | null,
  downloadUrl: string | null
): Promise<void> {
  await db
    .update(scrapeJobsTable)
    .set({
      status: "done",
      zipPath,
      downloadUrl,
      completedAt: new Date(),
      updatedAt: new Date(),
      currentArticle: null,
    })
    .where(eq(scrapeJobsTable.jobId, jobId));
  logger.info({ jobId }, "QUEUE: job marked done");
}

export async function markJobFailed(
  jobId: string,
  errorMessage: string,
  retryCount: number,
  maxRetries: number
): Promise<void> {
  const isDeadLetter = retryCount >= maxRetries;
  const newStatus = isDeadLetter ? "dead_letter" : "failed";
  await db
    .update(scrapeJobsTable)
    .set({
      status: newStatus,
      errorMessage,
      retryCount: retryCount + 1,
      updatedAt: new Date(),
      claimedBy: null,
      claimedAt: null,
    })
    .where(eq(scrapeJobsTable.jobId, jobId));
  if (isDeadLetter) {
    logger.warn({ jobId, retryCount }, "QUEUE: job moved to dead-letter");
  } else {
    logger.warn(
      { jobId, retryCount, newStatus },
      "QUEUE: job marked failed — eligible for retry"
    );
  }
}

// ---------------------------------------------------------------------------
// Crash recovery — reset interrupted 'running' jobs back to 'queued'
// so the worker re-picks them up on next poll rather than treating them
// as failures that consume a retry slot.
// ---------------------------------------------------------------------------

export async function recoverInterruptedJobs(): Promise<number> {
  try {
    const result = await db
      .update(scrapeJobsTable)
      .set({
        status: "queued",
        updatedAt: new Date(),
        errorMessage: "recovered_from_crash",
        claimedBy: null,
        claimedAt: null,
      })
      .where(eq(scrapeJobsTable.status, "running"));
    const count = result.rowCount ?? 0;
    if (count > 0) {
      logger.warn({ count }, "QUEUE: interrupted jobs re-queued for retry");
    }
    return count;
  } catch (err) {
    logger.error({ err }, "QUEUE: failed to recover interrupted jobs");
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export async function getJobRecord(
  jobId: string
): Promise<ScrapeJobRecord | null> {
  try {
    const [row] = await db
      .select()
      .from(scrapeJobsTable)
      .where(eq(scrapeJobsTable.jobId, jobId))
      .limit(1);
    return row ?? null;
  } catch (err) {
    logger.error({ err, jobId }, "QUEUE: failed to fetch job record");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Job history
// ---------------------------------------------------------------------------

export async function listAllJobs(limit = 50): Promise<ScrapeJobRecord[]> {
  try {
    const rows = await db.execute(sql`
      SELECT *
      FROM scrape_jobs
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);
    return (rows.rows as Record<string, unknown>[]).map(mapRawRow);
  } catch (err) {
    logger.error({ err }, "QUEUE: failed to list jobs");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Differential history — insert + query
// ---------------------------------------------------------------------------

export async function insertDiffHistory(entry: InsertDiffHistory): Promise<void> {
  try {
    await db.insert(differentialHistoryTable).values(entry);
    logger.info({ jobId: entry.jobId }, "QUEUE: diff history record inserted");
  } catch (err) {
    logger.error({ err, jobId: entry.jobId }, "QUEUE: failed to insert diff history");
    throw err;
  }
}

export async function getDiffHistoryForJob(
  jobId: string
): Promise<DiffHistoryRecord | null> {
  try {
    const [row] = await db
      .select()
      .from(differentialHistoryTable)
      .where(eq(differentialHistoryTable.jobId, jobId))
      .limit(1);
    return row ?? null;
  } catch (err) {
    logger.error({ err, jobId }, "QUEUE: failed to fetch diff history for job");
    return null;
  }
}

export async function listDiffHistoryForSeedUrl(
  seedUrl: string,
  limit = 100
): Promise<DiffHistoryRecord[]> {
  try {
    return await db
      .select()
      .from(differentialHistoryTable)
      .where(eq(differentialHistoryTable.seedUrl, seedUrl))
      .orderBy(desc(differentialHistoryTable.computedAt))
      .limit(limit);
  } catch (err) {
    logger.error({ err, seedUrl }, "QUEUE: failed to list diff history for seed URL");
    return [];
  }
}

export async function listAllDiffHistory(limit = 100): Promise<DiffHistoryRecord[]> {
  try {
    return await db
      .select()
      .from(differentialHistoryTable)
      .orderBy(desc(differentialHistoryTable.computedAt))
      .limit(limit);
  } catch (err) {
    logger.error({ err }, "QUEUE: failed to list all diff history");
    return [];
  }
}

export async function getDiffGlobalSummary(): Promise<{
  totalDiffRuns: number;
  totalBandwidthSavedBytes: number;
  totalStorageSavedBytes: number;
  totalProcessingTimeSavedMs: number;
  totalPagesSkipped: number;
  averageSkipRatePercent: number;
  uniqueSeedUrls: number;
}> {
  try {
    const rows = await db.execute(sql`
      SELECT
        COUNT(*)::int                         AS total_runs,
        SUM(bandwidth_saved_bytes)::bigint    AS total_bw,
        SUM(storage_saved_bytes)::bigint      AS total_storage,
        SUM(processing_time_saved_ms)::bigint AS total_time,
        SUM(unchanged_count)::int             AS total_skipped,
        ROUND(AVG(skip_rate_percent))::int    AS avg_skip_rate,
        COUNT(DISTINCT seed_url)::int         AS unique_seed_urls
      FROM differential_history
    `);
    const r = (rows.rows[0] ?? {}) as Record<string, unknown>;
    return {
      totalDiffRuns: (r["total_runs"] as number) ?? 0,
      totalBandwidthSavedBytes: Number(r["total_bw"] ?? 0),
      totalStorageSavedBytes: Number(r["total_storage"] ?? 0),
      totalProcessingTimeSavedMs: Number(r["total_time"] ?? 0),
      totalPagesSkipped: (r["total_skipped"] as number) ?? 0,
      averageSkipRatePercent: (r["avg_skip_rate"] as number) ?? 0,
      uniqueSeedUrls: (r["unique_seed_urls"] as number) ?? 0,
    };
  } catch (err) {
    logger.error({ err }, "QUEUE: failed to compute global diff summary");
    return {
      totalDiffRuns: 0,
      totalBandwidthSavedBytes: 0,
      totalStorageSavedBytes: 0,
      totalProcessingTimeSavedMs: 0,
      totalPagesSkipped: 0,
      averageSkipRatePercent: 0,
      uniqueSeedUrls: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Observability — queue depth snapshot
// ---------------------------------------------------------------------------

export async function getQueueDepth(): Promise<{
  queued: number;
  running: number;
  failed: number;
  dead: number;
  done: number;
}> {
  try {
    const rows = await db.execute(sql`
      SELECT status, COUNT(*)::int AS count
      FROM scrape_jobs
      GROUP BY status
    `);
    const depth = { queued: 0, running: 0, failed: 0, dead: 0, done: 0 };
    for (const row of rows.rows as Array<{ status: string; count: number }>) {
      switch (row.status) {
        case "queued": depth.queued = row.count; break;
        case "running": depth.running = row.count; break;
        case "failed": depth.failed = row.count; break;
        case "dead_letter": depth.dead = row.count; break;
        case "done": depth.done = row.count; break;
      }
    }
    return depth;
  } catch {
    return { queued: 0, running: 0, failed: 0, dead: 0, done: 0 };
  }
}
