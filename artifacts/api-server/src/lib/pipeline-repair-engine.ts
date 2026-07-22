/**
 * pipeline-repair-engine.ts — Phase 6.2 Self-Healing
 *
 * Automated repair actions for each pipeline stage.
 * Called after each pipeline health check cycle.
 *
 * Repair philosophy:
 *   - Only idempotent, safe mutations
 *   - Log every action with before/after state
 *   - Never throws — errors captured in RepairResult
 *   - Conservative timeouts before acting
 */

import { db, scrapeJobsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import type { PipelineHealthReport } from "./pipeline-health-engine";

// ── Types ─────────────────────────────────────────────────────────────────────

export type RepairOutcome = "repaired" | "skipped" | "failed" | "diagnosed";

export interface PipelineRepairAction {
  id: string;
  stage: "crawl" | "manifest" | "diff" | "generation" | "deployment";
  type: string;
  target: string;
  outcome: RepairOutcome;
  detail: string;
  durationMs: number;
  autoExecuted: boolean;
}

export interface PipelineRepairReport {
  version: "1.0";
  phase: "6.2";
  generatedAt: string;
  durationMs: number;
  basedOnPipelineReport: string;
  totalActionsAttempted: number;
  totalActionsSucceeded: number;
  totalActionsFailed: number;
  byStage: Record<string, PipelineRepairAction[]>;
  actions: PipelineRepairAction[];
  autoHealedIssues: string[];
  manualActionRequired: string[];
}

// ── Crawl stage repairs ───────────────────────────────────────────────────────

async function repairCrawlStage(
  health: PipelineHealthReport["stages"]["crawl"]
): Promise<PipelineRepairAction[]> {
  const actions: PipelineRepairAction[] = [];

  // Auto-repair: reset stuck workers to 'failed'
  for (const jobId of health.stuckJobIds) {
    const t0 = Date.now();
    try {
      const rows = await db.execute(sql`
        SELECT job_id, retry_count, max_retries FROM scrape_jobs
        WHERE job_id = ${jobId} AND status = 'running'
      `);
      const row = rows.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        actions.push({ id: `crawl:stuck:${jobId.slice(0,8)}`, stage: "crawl", type: "reset_stuck_job", target: jobId, outcome: "skipped", detail: "Job no longer in running state — skipping", durationMs: Date.now()-t0, autoExecuted: true });
        continue;
      }

      const retryCount = parseInt(String(row["retry_count"] ?? "0"), 10);
      const maxRetries = parseInt(String(row["max_retries"] ?? "3"), 10);
      const newStatus   = retryCount < maxRetries ? "failed" : "dead_letter";

      await db.update(scrapeJobsTable)
        .set({
          status:       newStatus,
          errorMessage: `auto_repair:6.2: job stuck in running state — reset to ${newStatus} (retry ${retryCount}/${maxRetries})`,
          updatedAt:    new Date(),
          claimedBy:    null,
          claimedAt:    null,
        })
        .where(eq(scrapeJobsTable.jobId, jobId));

      logger.warn({ jobId, newStatus, retryCount, maxRetries }, "PIPELINE-REPAIR: stuck crawl job reset");
      actions.push({ id: `crawl:stuck:${jobId.slice(0,8)}`, stage: "crawl", type: "reset_stuck_job", target: jobId, outcome: "repaired", detail: `Reset to '${newStatus}' after ${retryCount}/${maxRetries} retries`, durationMs: Date.now()-t0, autoExecuted: true });
    } catch (err) {
      actions.push({ id: `crawl:stuck:${jobId.slice(0,8)}`, stage: "crawl", type: "reset_stuck_job", target: jobId, outcome: "failed", detail: `DB update failed: ${String(err)}`, durationMs: Date.now()-t0, autoExecuted: true });
      logger.error({ jobId, err }, "PIPELINE-REPAIR: failed to reset stuck crawl job");
    }
  }

  // Diagnose: dead letter queue buildup
  if (health.deadLetterCount > 5) {
    actions.push({ id: "crawl:dead_letter_buildup", stage: "crawl", type: "diagnose_dead_letter", target: "scrape_jobs", outcome: "diagnosed", detail: `${health.deadLetterCount} jobs in dead_letter queue. Review error messages and consider resubmitting valid URLs.`, durationMs: 0, autoExecuted: false });
  }

  return actions;
}

// ── Manifest stage repairs ────────────────────────────────────────────────────

async function repairManifestStage(
  health: PipelineHealthReport["stages"]["manifest"]
): Promise<PipelineRepairAction[]> {
  const actions: PipelineRepairAction[] = [];

  if (health.missingSnapshotCount > 0) {
    actions.push({
      id: "manifest:missing_snapshots",
      stage: "manifest",
      type: "diagnose_missing_snapshots",
      target: "manifest_snapshots",
      outcome: "diagnosed",
      detail: `${health.missingSnapshotCount} done job(s) have no manifest snapshot. These jobs completed before manifest capture was enabled, or the snapshot write failed. Re-run via POST /api/orchestrate with the original seed URL.`,
      durationMs: 0,
      autoExecuted: false,
    });
  }

  if (health.orphanedSnapshotCount > 0) {
    actions.push({
      id: "manifest:orphaned",
      stage: "manifest",
      type: "diagnose_orphaned_snapshots",
      target: "manifest_snapshots",
      outcome: "diagnosed",
      detail: `${health.orphanedSnapshotCount} manifest snapshot(s) have no matching scrape job. These are orphaned records safe to archive: DELETE FROM manifest_snapshots WHERE job_id NOT IN (SELECT job_id FROM scrape_jobs).`,
      durationMs: 0,
      autoExecuted: false,
    });
  }

  return actions;
}

// ── Diff stage repairs ────────────────────────────────────────────────────────

async function repairDiffStage(
  health: PipelineHealthReport["stages"]["diff"]
): Promise<PipelineRepairAction[]> {
  const actions: PipelineRepairAction[] = [];

  if (health.suspectDiffCount > 0) {
    actions.push({
      id: "diff:suspect_diffs",
      stage: "diff",
      type: "diagnose_suspect_diffs",
      target: "differential_history",
      outcome: "diagnosed",
      detail: `${health.suspectDiffCount} diff run(s) scanned pages but detected zero new or changed articles. This may indicate the scraper is not finding content changes, or the baseline snapshot is stale. Re-run with a fresh base_job_id via POST /api/diff/run.`,
      durationMs: 0,
      autoExecuted: false,
    });
  }

  if (health.orphanedDiffCount > 0) {
    actions.push({
      id: "diff:orphaned",
      stage: "diff",
      type: "diagnose_orphaned_diffs",
      target: "differential_history",
      outcome: "diagnosed",
      detail: `${health.orphanedDiffCount} diff record(s) reference a base job that no longer exists. These are historical records from deleted jobs and can be safely retained for audit purposes.`,
      durationMs: 0,
      autoExecuted: false,
    });
  }

  return actions;
}

// ── Generation stage repairs ──────────────────────────────────────────────────

async function repairGenerationStage(
  health: PipelineHealthReport["stages"]["generation"]
): Promise<PipelineRepairAction[]> {
  const actions: PipelineRepairAction[] = [];

  if (health.failedGenerations > 0) {
    actions.push({
      id: "generation:failed",
      stage: "generation",
      type: "diagnose_failed_generations",
      target: "generation_reports",
      outcome: "diagnosed",
      detail: `${health.failedGenerations} failed generation report(s). Check the API server logs for stack traces. Re-trigger via POST /api/generation/run with the affected job ID.`,
      durationMs: 0,
      autoExecuted: false,
    });
  }

  if (health.failedConstructions > 0) {
    actions.push({
      id: "generation:failed_construction",
      stage: "generation",
      type: "diagnose_failed_constructions",
      target: "construction_reports",
      outcome: "diagnosed",
      detail: `${health.failedConstructions} failed construction report(s). Construction failures typically indicate a missing stencil or template. Check stencil registry and re-run via POST /api/construction/run.`,
      durationMs: 0,
      autoExecuted: false,
    });
  }

  return actions;
}

// ── Deployment stage repairs ──────────────────────────────────────────────────

async function repairDeploymentStage(
  health: PipelineHealthReport["stages"]["deployment"]
): Promise<PipelineRepairAction[]> {
  const actions: PipelineRepairAction[] = [];

  if (!health.intelligencePlanFresh) {
    actions.push({
      id: "deployment:stale_plan",
      stage: "deployment",
      type: "diagnose_stale_plan",
      target: "deployment-plan.json",
      outcome: "diagnosed",
      detail: "deployment-plan.json is stale or missing. POST /api/deploy/intelligence to regenerate it with current environment detection (hosting, DB, storage, recommended target).",
      durationMs: 0,
      autoExecuted: false,
    });
  }

  if (health.failedCount > 0 && health.successCount === 0 && health.totalExecutions > 0) {
    actions.push({
      id: "deployment:all_failed",
      stage: "deployment",
      type: "diagnose_all_failed_executions",
      target: "deployment_executions",
      outcome: "diagnosed",
      detail: `All ${health.failedCount} deployment execution(s) have failed. Review the deployment-execution.ts logs. Common causes: R2 credentials missing, ZIP not found, or invalid job ID. Check GET /api/deploy/executions for error details.`,
      durationMs: 0,
      autoExecuted: false,
    });
  }

  return actions;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runPipelineRepair(
  pipelineReport: PipelineHealthReport
): Promise<PipelineRepairReport> {
  const t0 = Date.now();
  logger.info({ overallStatus: pipelineReport.overallStatus }, "PIPELINE-REPAIR: starting repair cycle");

  const [crawlActions, manifestActions, diffActions, generationActions, deploymentActions] =
    await Promise.all([
      repairCrawlStage(pipelineReport.stages.crawl),
      repairManifestStage(pipelineReport.stages.manifest),
      repairDiffStage(pipelineReport.stages.diff),
      repairGenerationStage(pipelineReport.stages.generation),
      repairDeploymentStage(pipelineReport.stages.deployment),
    ]);

  const allActions = [
    ...crawlActions,
    ...manifestActions,
    ...diffActions,
    ...generationActions,
    ...deploymentActions,
  ];

  const attempted  = allActions.filter((a) => a.autoExecuted).length;
  const succeeded  = allActions.filter((a) => a.autoExecuted && a.outcome === "repaired").length;
  const failedActs = allActions.filter((a) => a.autoExecuted && a.outcome === "failed").length;

  const autoHealedIssues = allActions
    .filter((a) => a.outcome === "repaired")
    .map((a) => a.detail);

  const manualActionRequired = allActions
    .filter((a) => a.outcome === "diagnosed")
    .map((a) => `[${a.stage.toUpperCase()}] ${a.detail}`);

  logger.info(
    { attempted, succeeded, failedActs, manual: manualActionRequired.length },
    "PIPELINE-REPAIR: repair cycle complete"
  );

  return {
    version: "1.0",
    phase: "6.2",
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    basedOnPipelineReport: pipelineReport.generatedAt,
    totalActionsAttempted: attempted,
    totalActionsSucceeded: succeeded,
    totalActionsFailed: failedActs,
    byStage: {
      crawl:      crawlActions,
      manifest:   manifestActions,
      diff:       diffActions,
      generation: generationActions,
      deployment: deploymentActions,
    },
    actions: allActions,
    autoHealedIssues,
    manualActionRequired,
  };
}
