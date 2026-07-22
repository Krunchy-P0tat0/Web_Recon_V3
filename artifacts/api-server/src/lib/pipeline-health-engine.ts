/**
 * pipeline-health-engine.ts — Phase 6.2 Self-Healing
 *
 * Dedicated per-stage health checks for the full reconstruction pipeline:
 *   1. Crawl       — scrape job throughput, stuck workers, error rates
 *   2. Manifest    — snapshot completeness, orphans, staleness
 *   3. Diff        — differential history health, failed diffs
 *   4. Generation  — generation + construction report health
 *   5. Deployment  — plan freshness + execution success rate
 *
 * Design contract:
 *   - Pure DB reads — no mutations (repair is in pipeline-repair-engine.ts)
 *   - Never throws — all errors captured in the stage result
 *   - Called every PIPELINE_CHECK_INTERVAL_MS by the runner
 *
 * Note on db.execute(): returns QueryResult<Record<string,unknown>> — access
 * rows via `.rows[0]`, NOT via array destructuring on the result itself.
 */

import { db, scrapeJobsTable, manifestSnapshotsTable, differentialHistoryTable, generationReportsTable, constructionReportsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { listExecutions } from "./deployment-audit-store";
import { logger } from "./logger";

// Suppress unused-import warnings for tables only used in select() calls
void differentialHistoryTable;
void generationReportsTable;
void constructionReportsTable;

// ── Shared types ──────────────────────────────────────────────────────────────

export type StageStatus = "healthy" | "degraded" | "critical" | "unknown";

export interface StageFinding {
  severity: "info" | "warn" | "error";
  message: string;
  count?: number;
  ids?: string[];
}

// Utility: extract a count from db.execute() result row
function countFromRow(row: Record<string, unknown> | undefined): number {
  return parseInt(String(row?.["n"] ?? "0"), 10);
}

// ── 1. Crawl stage ────────────────────────────────────────────────────────────

export interface CrawlStageHealth {
  status: StageStatus;
  totalJobs: number;
  byStatus: Record<string, number>;
  stuckWorkerCount: number;           // running > 90min
  stuckJobIds: string[];
  failedCount: number;
  deadLetterCount: number;
  recentDoneCount: number;            // done in last 24h
  avgArticlesPerJob: number | null;
  errorRatePercent: number;           // failed / (done + failed) * 100
  findings: StageFinding[];
}

const CRAWL_STUCK_THRESHOLD_MINUTES = 90;

export async function checkCrawlStage(): Promise<CrawlStageHealth> {
  try {
    const byStatusRows = await db
      .select({ status: scrapeJobsTable.status, count: sql<number>`cast(count(*) as int)` })
      .from(scrapeJobsTable)
      .groupBy(scrapeJobsTable.status);

    const byStatus: Record<string, number> = {};
    let totalJobs = 0;
    for (const row of byStatusRows) {
      byStatus[row.status] = row.count;
      totalJobs += row.count;
    }

    // Stuck workers: running for > threshold
    const stuckThreshold = new Date(Date.now() - CRAWL_STUCK_THRESHOLD_MINUTES * 60_000);
    const stuckResult = await db.execute(sql`
      SELECT job_id FROM scrape_jobs
      WHERE status = 'running'
        AND COALESCE(claimed_at, updated_at) < ${stuckThreshold}
      ORDER BY updated_at ASC LIMIT 20
    `);
    const stuckJobIds = (stuckResult.rows as Array<{ job_id: string }>).map((r) => r.job_id);

    // Recent done jobs (last 24h)
    const since24h = new Date(Date.now() - 24 * 60 * 60_000);
    const recentDoneResult = await db.execute(sql`
      SELECT cast(count(*) as int) as n FROM scrape_jobs
      WHERE status = 'done' AND completed_at > ${since24h}
    `);
    const recentDoneCount = countFromRow(recentDoneResult.rows[0] as Record<string, unknown> | undefined);

    // Average articles per completed job
    const avgResult = await db.execute(sql`
      SELECT avg(total_articles)::numeric(10,1) as avg FROM scrape_jobs WHERE status = 'done'
    `);
    const avgRow = avgResult.rows[0] as Record<string, unknown> | undefined;
    const avgArticlesPerJob = parseFloat(String(avgRow?.["avg"] ?? "0")) || null;

    const failedCount     = byStatus["failed"]      ?? 0;
    const deadLetterCount = byStatus["dead_letter"]  ?? 0;
    const doneCount       = byStatus["done"]          ?? 0;
    const errorRatePercent = (doneCount + failedCount) > 0
      ? Math.round((failedCount / (doneCount + failedCount)) * 1000) / 10
      : 0;

    const findings: StageFinding[] = [];
    if (stuckJobIds.length > 0)
      findings.push({ severity: "error", message: `${stuckJobIds.length} job(s) stuck in 'running' > ${CRAWL_STUCK_THRESHOLD_MINUTES}m`, count: stuckJobIds.length, ids: stuckJobIds.slice(0, 5) });
    if (errorRatePercent > 50)
      findings.push({ severity: "error", message: `High error rate: ${errorRatePercent}% of completed jobs failed` });
    else if (errorRatePercent > 20)
      findings.push({ severity: "warn", message: `Elevated error rate: ${errorRatePercent}%` });
    if (deadLetterCount > 0)
      findings.push({ severity: "warn", message: `${deadLetterCount} job(s) in dead_letter queue`, count: deadLetterCount });
    if (recentDoneCount === 0 && totalJobs > 0)
      findings.push({ severity: "info", message: "No jobs completed in the last 24h" });

    const status: StageStatus =
      stuckJobIds.length > 3 || errorRatePercent > 50 ? "critical" :
      stuckJobIds.length > 0 || errorRatePercent > 20 || deadLetterCount > 2 ? "degraded" :
      "healthy";

    return { status, totalJobs, byStatus, stuckWorkerCount: stuckJobIds.length, stuckJobIds, failedCount, deadLetterCount, recentDoneCount, avgArticlesPerJob, errorRatePercent, findings };
  } catch (err) {
    logger.error({ err }, "PIPELINE-HEALTH: crawl stage check failed");
    return { status: "unknown", totalJobs: 0, byStatus: {}, stuckWorkerCount: 0, stuckJobIds: [], failedCount: 0, deadLetterCount: 0, recentDoneCount: 0, avgArticlesPerJob: null, errorRatePercent: 0, findings: [{ severity: "error", message: `DB error: ${String(err)}` }] };
  }
}

// ── 2. Manifest stage ─────────────────────────────────────────────────────────

export interface ManifestStageHealth {
  status: StageStatus;
  totalSnapshots: number;
  snapshotsForDoneJobs: number;       // done jobs with a snapshot
  orphanedSnapshotCount: number;      // snapshots with no corresponding job
  missingSnapshotCount: number;       // done jobs with NO snapshot
  staleSnapshotCount: number;         // snapshots not updated in 7d
  schemaVersions: string[];
  findings: StageFinding[];
}

export async function checkManifestStage(): Promise<ManifestStageHealth> {
  try {
    const totalResult = await db.execute(sql`SELECT cast(count(*) as int) as n FROM manifest_snapshots`);
    const totalSnapshots = countFromRow(totalResult.rows[0] as Record<string, unknown> | undefined);

    // Done jobs with a snapshot
    const withSnapshotResult = await db.execute(sql`
      SELECT cast(count(*) as int) as n FROM scrape_jobs sj
      WHERE sj.status = 'done'
        AND EXISTS (SELECT 1 FROM manifest_snapshots ms WHERE ms.job_id = sj.job_id)
    `);
    const snapshotsForDoneJobs = countFromRow(withSnapshotResult.rows[0] as Record<string, unknown> | undefined);

    // Done jobs WITHOUT a snapshot
    const missingResult = await db.execute(sql`
      SELECT cast(count(*) as int) as n FROM scrape_jobs sj
      WHERE sj.status = 'done'
        AND NOT EXISTS (SELECT 1 FROM manifest_snapshots ms WHERE ms.job_id = sj.job_id)
    `);
    const missingSnapshotCount = countFromRow(missingResult.rows[0] as Record<string, unknown> | undefined);

    // Orphaned snapshots (no matching job)
    const orphanResult = await db.execute(sql`
      SELECT cast(count(*) as int) as n FROM manifest_snapshots ms
      WHERE NOT EXISTS (SELECT 1 FROM scrape_jobs sj WHERE sj.job_id = ms.job_id)
    `);
    const orphanedSnapshotCount = countFromRow(orphanResult.rows[0] as Record<string, unknown> | undefined);

    // Stale (>7d)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000);
    const staleResult = await db.execute(sql`
      SELECT cast(count(*) as int) as n FROM manifest_snapshots WHERE updated_at < ${sevenDaysAgo}
    `);
    const staleSnapshotCount = countFromRow(staleResult.rows[0] as Record<string, unknown> | undefined);

    // Schema versions
    const versionRows = await db
      .select({ v: manifestSnapshotsTable.schemaVersion })
      .from(manifestSnapshotsTable)
      .groupBy(manifestSnapshotsTable.schemaVersion);
    const schemaVersions = versionRows.map((r) => String(r.v ?? "unknown"));

    const findings: StageFinding[] = [];
    if (missingSnapshotCount > 0)
      findings.push({ severity: "warn", message: `${missingSnapshotCount} done job(s) have no manifest snapshot`, count: missingSnapshotCount });
    if (orphanedSnapshotCount > 0)
      findings.push({ severity: "warn", message: `${orphanedSnapshotCount} orphaned manifest snapshot(s) (no matching job)`, count: orphanedSnapshotCount });
    if (staleSnapshotCount > 5)
      findings.push({ severity: "info", message: `${staleSnapshotCount} stale snapshot(s) not updated in 7 days` });
    const unknownVersions = schemaVersions.filter((v) => v !== "1.0" && v !== "unknown");
    if (unknownVersions.length > 0)
      findings.push({ severity: "warn", message: `Non-standard schema versions detected: ${unknownVersions.join(", ")}` });

    const status: StageStatus =
      missingSnapshotCount > 5 ? "critical" :
      missingSnapshotCount > 0 || orphanedSnapshotCount > 0 ? "degraded" :
      "healthy";

    return { status, totalSnapshots, snapshotsForDoneJobs, orphanedSnapshotCount, missingSnapshotCount, staleSnapshotCount, schemaVersions, findings };
  } catch (err) {
    logger.error({ err }, "PIPELINE-HEALTH: manifest stage check failed");
    return { status: "unknown", totalSnapshots: 0, snapshotsForDoneJobs: 0, orphanedSnapshotCount: 0, missingSnapshotCount: 0, staleSnapshotCount: 0, schemaVersions: [], findings: [{ severity: "error", message: `DB error: ${String(err)}` }] };
  }
}

// ── 3. Diff stage ─────────────────────────────────────────────────────────────

export interface DiffStageHealth {
  status: StageStatus;
  totalDiffs: number;
  recentDiffCount: number;            // diffs created in last 24h
  suspectDiffCount: number;           // pages_scanned > 0 but zero changes detected
  orphanedDiffCount: number;          // base_job_id set but base job no longer exists
  avgChangedArticles: number | null;  // avg(new_count + changed_count)
  findings: StageFinding[];
}

export async function checkDiffStage(): Promise<DiffStageHealth> {
  try {
    const totalResult = await db.execute(sql`SELECT cast(count(*) as int) as n FROM differential_history`);
    const totalDiffs = countFromRow(totalResult.rows[0] as Record<string, unknown> | undefined);

    // Recent diffs (last 24h)
    const since24h = new Date(Date.now() - 24 * 60 * 60_000);
    const recentResult = await db.execute(sql`
      SELECT cast(count(*) as int) as n FROM differential_history WHERE created_at > ${since24h}
    `);
    const recentDiffCount = countFromRow(recentResult.rows[0] as Record<string, unknown> | undefined);

    // Suspect diffs: scanned pages but zero new+changed (potential scraper issue)
    const suspectResult = await db.execute(sql`
      SELECT cast(count(*) as int) as n FROM differential_history
      WHERE pages_scanned > 0 AND (new_count + changed_count) = 0
    `);
    const suspectDiffCount = countFromRow(suspectResult.rows[0] as Record<string, unknown> | undefined);

    // Orphaned diffs: base_job_id refers to a job that no longer exists
    const orphanResult = await db.execute(sql`
      SELECT cast(count(*) as int) as n FROM differential_history dh
      WHERE dh.base_job_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM scrape_jobs sj WHERE sj.job_id = dh.base_job_id)
    `);
    const orphanedDiffCount = countFromRow(orphanResult.rows[0] as Record<string, unknown> | undefined);

    // Average changed articles (new + changed) per diff run
    const avgResult = await db.execute(sql`
      SELECT avg(new_count + changed_count)::numeric(10,1) as avg
      FROM differential_history
      WHERE (new_count + changed_count) > 0
    `);
    const avgRow = avgResult.rows[0] as Record<string, unknown> | undefined;
    const avgChangedArticles = parseFloat(String(avgRow?.["avg"] ?? "0")) || null;

    const findings: StageFinding[] = [];
    if (suspectDiffCount > 0)
      findings.push({ severity: "warn", message: `${suspectDiffCount} diff run(s) scanned pages but detected zero changes — may indicate scraper issues`, count: suspectDiffCount });
    if (orphanedDiffCount > 0)
      findings.push({ severity: "warn", message: `${orphanedDiffCount} diff record(s) whose base job no longer exists`, count: orphanedDiffCount });
    if (totalDiffs === 0)
      findings.push({ severity: "info", message: "No differential history records yet — diff mode not used" });

    const status: StageStatus =
      suspectDiffCount > 5 ? "critical" :
      suspectDiffCount > 0 || orphanedDiffCount > 0 ? "degraded" :
      "healthy";

    return { status, totalDiffs, recentDiffCount, suspectDiffCount, orphanedDiffCount, avgChangedArticles, findings };
  } catch (err) {
    logger.error({ err }, "PIPELINE-HEALTH: diff stage check failed");
    return { status: "unknown", totalDiffs: 0, recentDiffCount: 0, suspectDiffCount: 0, orphanedDiffCount: 0, avgChangedArticles: null, findings: [{ severity: "error", message: `DB error: ${String(err)}` }] };
  }
}

// ── 4. Generation stage ───────────────────────────────────────────────────────

export interface GenerationStageHealth {
  status: StageStatus;
  totalGenerationReports: number;
  totalConstructionReports: number;
  failedGenerations: number;
  failedConstructions: number;
  recentGenerationCount: number;      // last 24h
  avgGenerationDurationMs: number | null;
  completionRatePercent: number;
  findings: StageFinding[];
}

export async function checkGenerationStage(): Promise<GenerationStageHealth> {
  try {
    const [genTotalResult, conTotalResult] = await Promise.all([
      db.execute(sql`SELECT cast(count(*) as int) as n FROM generation_reports`),
      db.execute(sql`SELECT cast(count(*) as int) as n FROM construction_reports`),
    ]);
    const totalGenerationReports  = countFromRow(genTotalResult.rows[0] as Record<string, unknown> | undefined);
    const totalConstructionReports = countFromRow(conTotalResult.rows[0] as Record<string, unknown> | undefined);

    // Failed generations and constructions
    const [genFailedResult, conFailedResult] = await Promise.all([
      db.execute(sql`SELECT cast(count(*) as int) as n FROM generation_reports WHERE status IN ('error', 'failed')`),
      db.execute(sql`SELECT cast(count(*) as int) as n FROM construction_reports WHERE status IN ('error', 'failed')`),
    ]);
    const failedGenerations  = countFromRow(genFailedResult.rows[0] as Record<string, unknown> | undefined);
    const failedConstructions = countFromRow(conFailedResult.rows[0] as Record<string, unknown> | undefined);

    // Recent (last 24h)
    const since24h = new Date(Date.now() - 24 * 60 * 60_000);
    const recentGenResult = await db.execute(sql`
      SELECT cast(count(*) as int) as n FROM generation_reports WHERE created_at > ${since24h}
    `);
    const recentGenerationCount = countFromRow(recentGenResult.rows[0] as Record<string, unknown> | undefined);

    // Average duration
    const avgResult = await db.execute(sql`
      SELECT avg(duration_ms)::numeric(10,0) as avg FROM generation_reports WHERE duration_ms IS NOT NULL
    `);
    const avgRow = avgResult.rows[0] as Record<string, unknown> | undefined;
    const avgGenerationDurationMs = parseFloat(String(avgRow?.["avg"] ?? "0")) || null;

    const total = totalGenerationReports;
    const completionRatePercent = total > 0
      ? Math.round(((total - failedGenerations) / total) * 1000) / 10
      : 100;

    const findings: StageFinding[] = [];
    if (failedGenerations > 0)
      findings.push({ severity: "error", message: `${failedGenerations} failed generation report(s)`, count: failedGenerations });
    if (failedConstructions > 0)
      findings.push({ severity: "error", message: `${failedConstructions} failed construction report(s)`, count: failedConstructions });
    if (completionRatePercent < 70 && total > 0)
      findings.push({ severity: "error", message: `Low generation completion rate: ${completionRatePercent}%` });
    else if (completionRatePercent < 90 && total > 0)
      findings.push({ severity: "warn", message: `Generation completion rate: ${completionRatePercent}%` });
    if (total === 0)
      findings.push({ severity: "info", message: "No generation reports yet — generation pipeline not yet triggered" });

    const status: StageStatus =
      (failedGenerations > 3 || completionRatePercent < 70) ? "critical" :
      (failedGenerations > 0 || failedConstructions > 0 || completionRatePercent < 90) ? "degraded" :
      "healthy";

    return { status, totalGenerationReports, totalConstructionReports, failedGenerations, failedConstructions, recentGenerationCount, avgGenerationDurationMs, completionRatePercent, findings };
  } catch (err) {
    logger.error({ err }, "PIPELINE-HEALTH: generation stage check failed");
    return { status: "unknown", totalGenerationReports: 0, totalConstructionReports: 0, failedGenerations: 0, failedConstructions: 0, recentGenerationCount: 0, avgGenerationDurationMs: null, completionRatePercent: 0, findings: [{ severity: "error", message: `DB error: ${String(err)}` }] };
  }
}

// ── 5. Deployment stage ───────────────────────────────────────────────────────

export interface DeploymentStageHealth {
  status: StageStatus;
  totalExecutions: number;
  successCount: number;
  failedCount: number;
  rolledBackCount: number;
  runningCount: number;
  successRatePercent: number;
  intelligencePlanFresh: boolean;     // deployment-plan.json written in last 60min
  lastDeployedAt: string | null;
  findings: StageFinding[];
}

export async function checkDeploymentStage(): Promise<DeploymentStageHealth> {
  try {
    const executions = listExecutions();
    const successCount    = executions.filter((e) => e.status === "success").length;
    const failedCount     = executions.filter((e) => e.status === "failed").length;
    const rolledBackCount = executions.filter((e) => e.status === "rolled_back").length;
    const runningCount    = executions.filter((e) => e.status === "running" || e.status === "pending").length;
    const totalExecutions = executions.length;

    const successRatePercent = totalExecutions > 0
      ? Math.round((successCount / totalExecutions) * 1000) / 10
      : 100;

    const lastExecution = executions
      .filter((e) => e.completedAt)
      .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime())[0];
    const lastDeployedAt = lastExecution?.completedAt ?? null;

    // Check deployment-plan.json freshness (written by Phase 6.1)
    let intelligencePlanFresh = false;
    try {
      const fs = await import("fs/promises");
      const path = await import("path");
      const planPath = path.resolve(process.cwd(), "deployment-plan.json");
      const stat = await fs.stat(planPath);
      intelligencePlanFresh = Date.now() - stat.mtimeMs < 60 * 60_000; // fresh if < 1h old
    } catch {
      intelligencePlanFresh = false;
    }

    const findings: StageFinding[] = [];
    if (failedCount > 0 && successCount === 0 && totalExecutions > 0)
      findings.push({ severity: "error", message: `All ${failedCount} deployment(s) have failed — no successful executions` });
    else if (failedCount > successCount && totalExecutions > 0)
      findings.push({ severity: "error", message: `More failures than successes: ${failedCount} failed vs ${successCount} succeeded` });
    if (runningCount > 2)
      findings.push({ severity: "warn", message: `${runningCount} deployment(s) currently running — check for stuck executions` });
    if (!intelligencePlanFresh)
      findings.push({ severity: "info", message: "deployment-plan.json is stale or missing — run POST /api/deploy/intelligence" });

    const status: StageStatus =
      (failedCount > 0 && successCount === 0 && totalExecutions > 0) ? "critical" :
      (failedCount > successCount && totalExecutions > 0) || runningCount > 2 ? "degraded" :
      "healthy";

    return { status, totalExecutions, successCount, failedCount, rolledBackCount, runningCount, successRatePercent, intelligencePlanFresh, lastDeployedAt, findings };
  } catch (err) {
    logger.error({ err }, "PIPELINE-HEALTH: deployment stage check failed");
    return { status: "unknown", totalExecutions: 0, successCount: 0, failedCount: 0, rolledBackCount: 0, runningCount: 0, successRatePercent: 0, intelligencePlanFresh: false, lastDeployedAt: null, findings: [{ severity: "error", message: `Check error: ${String(err)}` }] };
  }
}

// ── Overall pipeline health ───────────────────────────────────────────────────

export type PipelineOverallStatus = "healthy" | "degraded" | "critical" | "unknown";

export interface PipelineHealthReport {
  version: "1.0";
  phase: "6.2";
  generatedAt: string;
  durationMs: number;
  overallStatus: PipelineOverallStatus;
  stages: {
    crawl:      CrawlStageHealth;
    manifest:   ManifestStageHealth;
    diff:       DiffStageHealth;
    generation: GenerationStageHealth;
    deployment: DeploymentStageHealth;
  };
  summary: {
    totalFindings: number;
    errorCount: number;
    warnCount: number;
    healthyStages: number;
    degradedStages: number;
    criticalStages: number;
  };
}

function rollUpPipelineStatus(
  stages: PipelineHealthReport["stages"]
): PipelineOverallStatus {
  const statuses = Object.values(stages).map((s) => s.status);
  if (statuses.some((s) => s === "critical"))  return "critical";
  if (statuses.some((s) => s === "unknown"))   return "unknown";
  if (statuses.some((s) => s === "degraded"))  return "degraded";
  return "healthy";
}

export async function runPipelineHealthChecks(): Promise<PipelineHealthReport> {
  const t0 = Date.now();
  logger.debug("PIPELINE-HEALTH: running all stage checks");

  const [crawl, manifest, diff, generation, deployment] = await Promise.all([
    checkCrawlStage(),
    checkManifestStage(),
    checkDiffStage(),
    checkGenerationStage(),
    checkDeploymentStage(),
  ]);

  const stages = { crawl, manifest, diff, generation, deployment };
  const overallStatus = rollUpPipelineStatus(stages);

  const allFindings = [
    ...crawl.findings,
    ...manifest.findings,
    ...diff.findings,
    ...generation.findings,
    ...deployment.findings,
  ];

  const stageValues = Object.values(stages);

  return {
    version: "1.0",
    phase: "6.2",
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    overallStatus,
    stages,
    summary: {
      totalFindings: allFindings.length,
      errorCount: allFindings.filter((f) => f.severity === "error").length,
      warnCount:  allFindings.filter((f) => f.severity === "warn").length,
      healthyStages:  stageValues.filter((s) => s.status === "healthy").length,
      degradedStages: stageValues.filter((s) => s.status === "degraded").length,
      criticalStages: stageValues.filter((s) => s.status === "critical").length,
    },
  };
}
