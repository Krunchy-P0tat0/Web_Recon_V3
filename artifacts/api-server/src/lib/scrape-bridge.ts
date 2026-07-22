/**
 * scrape-bridge.ts — Thin bridge between the orchestrator and the job queue.
 *
 * Provides submitScrapeJob() and waitForJobCompletion() so the orchestrator
 * can kick off and await crawl jobs without importing the full scraper module.
 */

import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db, scrapeJobsTable } from "@workspace/db";
import { logger } from "./logger";

export interface SubmitScrapeJobOptions {
  url: string;
  includeImages?: boolean;
  diffMode?: boolean;
  baseJobId?: string;
  customJobId?: string;
  /** When true, the worker performs a full BFS crawl before scraping. */
  crawlAllPages?: boolean;
  /** Coverage ratio (0–100) that must be met before the stencil phase. */
  coverageThreshold?: number;
}

/**
 * Insert a new scrape job into the queue and return its jobId.
 * The background worker loop picks it up automatically.
 */
export async function submitScrapeJob(opts: SubmitScrapeJobOptions): Promise<string> {
  const jobId = opts.customJobId ?? randomUUID();

  await db.insert(scrapeJobsTable).values({
    jobId,
    seedUrl: opts.url,
    status: "queued",
    includeImages: opts.includeImages ?? true,
    diffMode: opts.diffMode ?? false,
    baseJobId: opts.baseJobId ?? null,
    articlesJson: "[]",
    crawlAllPages: opts.crawlAllPages ?? false,
    coverageThreshold: opts.coverageThreshold ?? 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  logger.info(
    { jobId, url: opts.url, diffMode: opts.diffMode, crawlAllPages: opts.crawlAllPages, coverageThreshold: opts.coverageThreshold },
    "Scrape job submitted to queue"
  );
  return jobId;
}

/**
 * Poll the DB until the job reaches a terminal state (done / dead_letter / failed).
 * Throws if the job fails permanently.
 */
export async function waitForJobCompletion(
  jobId: string,
  pollIntervalMs = 3000,
  timeoutMs = 30 * 60 * 1000, // 30 min default
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const log = logger.child({ jobId });

  while (Date.now() < deadline) {
    const [record] = await db
      .select()
      .from(scrapeJobsTable)
      .where(eq(scrapeJobsTable.jobId, jobId))
      .limit(1);

    if (!record) throw new Error(`Job ${jobId} not found while polling`);

    const { status } = record;
    log.debug({ status }, "Polling job status");

    if (status === "done") return;

    if (status === "dead_letter") {
      throw new Error(
        `Job ${jobId} permanently failed (dead_letter): ${record.errorMessage ?? "unknown error"}`,
      );
    }

    // AD-3: fast-fail when the job is in a failed state with no retries remaining
    if (status === "failed" && record.retryCount >= record.maxRetries) {
      throw new Error(
        `Job ${jobId} permanently failed after ${record.retryCount}/${record.maxRetries} retries: ${record.errorMessage ?? "unknown error"}`,
      );
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Job ${jobId} timed out after ${timeoutMs / 1000}s`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
