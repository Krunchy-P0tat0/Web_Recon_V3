/**
 * e2-recovery-engine.ts — Phase E2: System Recovery Engine
 *
 * Detects and automatically repairs failures across four system dimensions:
 *
 *   1. Routes      — Classify broken route probes (timeout / server_error / unreachable)
 *   2. Assets      — Re-upload missing R2 artifacts for completed jobs
 *   3. Manifests   — Repair stale "running" jobs; detect schema inconsistencies
 *   4. Deployments — Detect stuck executions; flag rollback opportunities
 *
 * Every repair action is recorded with outcome (repaired / failed / skipped).
 * The resulting SystemRecoveryReport is persisted as recovery-report.json and
 * uploaded to monitoring/recovery-report.json in R2.
 *
 * Design contract:
 *   - Auto-repairs ONLY perform safe, idempotent mutations (re-uploads, status resets)
 *   - Nothing that modifies live scrape workers or disrupts in-progress jobs
 *   - All mutations are logged with before/after state
 *   - Never throws — all errors are captured in the report
 */

import { db, scrapeJobsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { getDefaultCloudProvider } from "../cloud";
import { loadManifest } from "./manifest-store";
import { renderManifestJson } from "./manifest-export";
import { listExecutions, getPreviousSuccessfulForJob } from "./deployment-audit-store";
import { logger } from "./logger";
import type { HealthReport, RouteProbe } from "./monitoring-engine";

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export type RepairOutcome = "repaired" | "failed" | "skipped" | "diagnosed";

export interface RepairAction {
  id: string;
  dimension: "routes" | "assets" | "manifests" | "deployments";
  type: string;
  target: string;
  outcome: RepairOutcome;
  detail: string;
  durationMs: number;
  autoExecuted: boolean;
}

// ── Routes ──────────────────────────────────────────────────────────────────

export type RouteFailureKind = "timeout" | "server_error" | "unreachable" | "unknown";

export interface BrokenRoute {
  path: string;
  method: string;
  statusCode: number | null;
  latencyMs: number;
  failureKind: RouteFailureKind;
  canAutoRepair: boolean;
  diagnosis: string;
}

export interface RouteRecoveryResult {
  brokenCount: number;
  diagnosedCount: number;
  broken: BrokenRoute[];
  repairActions: RepairAction[];
}

// ── Assets ───────────────────────────────────────────────────────────────────

export interface MissingAsset {
  jobId: string;
  key: string;
  assetType: "manifest_json" | "index_html";
}

export interface AssetRecoveryResult {
  cloudConfigured: boolean;
  scannedJobs: number;
  missingCount: number;
  repairedCount: number;
  failedCount: number;
  missing: MissingAsset[];
  repairActions: RepairAction[];
}

// ── Manifests ────────────────────────────────────────────────────────────────

export interface StaleJob {
  jobId: string;
  status: string;
  stuckForMinutes: number;
  action: "marked_dead_letter" | "flagged" | "skipped";
}

export interface SchemaAnomaly {
  jobId: string;
  schemaVersion: string | null;
  issue: string;
}

export interface ManifestRecoveryResult {
  scannedSnapshots: number;
  staleRunningJobs: number;
  repairedStaleJobs: number;
  schemaAnomalies: SchemaAnomaly[];
  staleJobs: StaleJob[];
  repairActions: RepairAction[];
}

// ── Deployments ──────────────────────────────────────────────────────────────

export interface StuckExecution {
  id: string;
  jobId: string;
  framework: string;
  stuckForMinutes: number;
  hasRollbackTarget: boolean;
  action: "rollback_triggered" | "flagged" | "skipped";
}

export interface DeploymentRecoveryResult {
  totalExecutions: number;
  stuckCount: number;
  failedCount: number;
  rollbacksTriggered: number;
  stuckExecutions: StuckExecution[];
  repairActions: RepairAction[];
}

// ── Top-level report ─────────────────────────────────────────────────────────

export interface SystemRecoveryReport {
  version: "1.0";
  generatedAt: string;
  durationMs: number;
  basedOnHealthReport: string | null;
  totalActionsAttempted: number;
  totalActionsSucceeded: number;
  totalActionsFailed: number;
  findings: {
    routes: RouteRecoveryResult;
    assets: AssetRecoveryResult;
    manifests: ManifestRecoveryResult;
    deployments: DeploymentRecoveryResult;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Jobs stuck in "running" longer than this are considered stale */
const STALE_JOB_THRESHOLD_MINUTES = 90;

/** Deployments running longer than this without completion are stuck */
const STUCK_DEPLOYMENT_THRESHOLD_MINUTES = 30;

// ---------------------------------------------------------------------------
// 1. Route recovery — classify broken probes
// ---------------------------------------------------------------------------

function classifyRouteFailure(probe: RouteProbe): RouteFailureKind {
  if (probe.error === "timeout") return "timeout";
  if (probe.statusCode === null) return "unreachable";
  if (probe.statusCode >= 500) return "server_error";
  return "unknown";
}

function diagnoseRoute(probe: RouteProbe, kind: RouteFailureKind): string {
  switch (kind) {
    case "timeout":
      return `Route ${probe.method} ${probe.path} timed out after ${probe.latencyMs}ms — possible DB query block or resource exhaustion`;
    case "server_error":
      return `Route ${probe.method} ${probe.path} returned HTTP ${probe.statusCode ?? "?"} — server-side error; check logs for stack trace`;
    case "unreachable":
      return `Route ${probe.method} ${probe.path} is unreachable (no response) — possible port binding issue or process crash`;
    default:
      return `Route ${probe.method} ${probe.path} failed with statusCode=${probe.statusCode ?? "null"} — cause unknown`;
  }
}

function recoverRoutes(healthReport: HealthReport): RouteRecoveryResult {
  const failedProbes = healthReport.checks.routes.probes.filter((p) => !p.pass);
  const broken: BrokenRoute[] = failedProbes.map((p) => {
    const failureKind = classifyRouteFailure(p);
    return {
      path: p.path,
      method: p.method,
      statusCode: p.statusCode,
      latencyMs: p.latencyMs,
      failureKind,
      canAutoRepair: false, // Route fixes require code changes — not auto-repairable
      diagnosis: diagnoseRoute(p, failureKind),
    };
  });

  const repairActions: RepairAction[] = broken.map((b) => ({
    id: `route:${b.method}:${b.path.replace(/\//g, "_")}`,
    dimension: "routes",
    type: "diagnose_broken_route",
    target: `${b.method} ${b.path}`,
    outcome: "diagnosed",
    detail: b.diagnosis,
    durationMs: 0,
    autoExecuted: false,
  }));

  return {
    brokenCount: broken.length,
    diagnosedCount: broken.length,
    broken,
    repairActions,
  };
}

// ---------------------------------------------------------------------------
// 2. Asset recovery — re-upload missing R2 artifacts for completed jobs
// ---------------------------------------------------------------------------

async function recoverAssets(): Promise<AssetRecoveryResult> {
  const provider = getDefaultCloudProvider();
  const repairActions: RepairAction[] = [];
  const missing: MissingAsset[] = [];

  if (!provider.isConfigured()) {
    return {
      cloudConfigured: false,
      scannedJobs: 0,
      missingCount: 0,
      repairedCount: 0,
      failedCount: 0,
      missing,
      repairActions,
    };
  }

  // Fetch all completed jobs
  let doneJobs: Array<{ jobId: string }> = [];
  try {
    const rows = await db.execute(sql`
      SELECT job_id FROM scrape_jobs WHERE status = 'done' ORDER BY completed_at DESC LIMIT 20
    `);
    doneJobs = (rows.rows as Array<{ job_id: string }>).map((r) => ({ jobId: r.job_id }));
  } catch (err) {
    logger.warn({ err }, "E2-RECOVERY: failed to list completed jobs for asset scan");
    return {
      cloudConfigured: true,
      scannedJobs: 0,
      missingCount: 0,
      repairedCount: 0,
      failedCount: 0,
      missing,
      repairActions,
    };
  }

  let repairedCount = 0;
  let failedCount = 0;

  for (const { jobId } of doneJobs) {
    const manifestKey = `jobs/${jobId}/_manifest.json`;
    const indexKey = `jobs/${jobId}/index.html`;

    // Check _manifest.json
    let manifestMissing = false;
    try {
      manifestMissing = !(await provider.verify(manifestKey));
    } catch {
      manifestMissing = true;
    }

    if (manifestMissing) {
      missing.push({ jobId, key: manifestKey, assetType: "manifest_json" });
      const start = Date.now();
      let outcome: RepairOutcome = "failed";
      let detail = "";

      try {
        const manifest = await loadManifest(jobId);
        if (manifest) {
          const json = renderManifestJson(manifest);
          await provider.upload({
            key: manifestKey,
            data: Buffer.from(json, "utf8"),
            contentType: "application/json",
            checkDuplicate: false,
          });
          outcome = "repaired";
          detail = `Re-uploaded _manifest.json (${json.length} bytes) from DB snapshot`;
          repairedCount++;
          logger.info({ jobId, key: manifestKey }, "E2-RECOVERY: _manifest.json re-uploaded");
        } else {
          detail = "DB manifest snapshot not found — cannot re-upload";
          failedCount++;
        }
      } catch (err) {
        detail = `Re-upload failed: ${err instanceof Error ? err.message : String(err)}`;
        failedCount++;
        logger.warn({ jobId, key: manifestKey, err }, "E2-RECOVERY: _manifest.json re-upload failed");
      }

      repairActions.push({
        id: `asset:manifest_json:${jobId.slice(0, 8)}`,
        dimension: "assets",
        type: "reupload_manifest_json",
        target: manifestKey,
        outcome,
        detail,
        durationMs: Date.now() - start,
        autoExecuted: true,
      });
    }

    // Check index.html (existence only — don't download large HTML for verification)
    let indexMissing = false;
    try {
      indexMissing = !(await provider.verify(indexKey));
    } catch {
      indexMissing = true;
    }

    if (indexMissing) {
      missing.push({ jobId, key: indexKey, assetType: "index_html" });
      repairActions.push({
        id: `asset:index_html:${jobId.slice(0, 8)}`,
        dimension: "assets",
        type: "flag_missing_index_html",
        target: indexKey,
        outcome: "diagnosed",
        detail: `index.html missing in R2 for job ${jobId.slice(0, 8)} — manual ZIP regeneration required via POST /scrape/regenerate/${jobId}`,
        durationMs: 0,
        autoExecuted: false,
      });
    }
  }

  return {
    cloudConfigured: true,
    scannedJobs: doneJobs.length,
    missingCount: missing.length,
    repairedCount,
    failedCount,
    missing,
    repairActions,
  };
}

// ---------------------------------------------------------------------------
// 3. Manifest recovery — stale jobs + schema anomalies
// ---------------------------------------------------------------------------

async function recoverManifests(): Promise<ManifestRecoveryResult> {
  const repairActions: RepairAction[] = [];
  const staleJobs: StaleJob[] = [];
  const schemaAnomalies: SchemaAnomaly[] = [];

  let scannedSnapshots = 0;
  let staleRunningJobs = 0;
  let repairedStaleJobs = 0;

  try {
    // ── Detect jobs stuck in "running" beyond threshold ──────────────────────
    const staleThreshold = new Date(
      Date.now() - STALE_JOB_THRESHOLD_MINUTES * 60 * 1000
    );
    const staleRows = await db.execute(sql`
      SELECT job_id, status, updated_at, claimed_at
      FROM scrape_jobs
      WHERE status = 'running'
        AND COALESCE(claimed_at, updated_at) < ${staleThreshold}
      ORDER BY updated_at ASC
      LIMIT 10
    `);

    const staleRecords = staleRows.rows as Array<{
      job_id: string;
      status: string;
      updated_at: Date;
      claimed_at: Date | null;
    }>;

    staleRunningJobs = staleRecords.length;

    for (const record of staleRecords) {
      const lastActivity = record.claimed_at ?? record.updated_at;
      const stuckForMinutes = Math.round(
        (Date.now() - new Date(lastActivity).getTime()) / 60000
      );
      const start = Date.now();

      let action: StaleJob["action"] = "skipped";
      let outcome: RepairOutcome = "skipped";
      let detail = "";

      // Auto-repair: mark as dead_letter so the job is not re-claimed
      try {
        await db
          .update(scrapeJobsTable)
          .set({
            status: "dead_letter",
            errorMessage: `auto_recovery: job stuck in running state for ${stuckForMinutes}m — marked dead_letter by E2 recovery engine`,
            updatedAt: new Date(),
            claimedBy: null,
            claimedAt: null,
          })
          .where(eq(scrapeJobsTable.jobId, record.job_id));

        action = "marked_dead_letter";
        outcome = "repaired";
        detail = `Job stuck in 'running' for ${stuckForMinutes}m — reset to dead_letter`;
        repairedStaleJobs++;
        logger.warn(
          { jobId: record.job_id, stuckForMinutes },
          "E2-RECOVERY: stale running job marked dead_letter"
        );
      } catch (err) {
        action = "flagged";
        outcome = "failed";
        detail = `Could not reset stale job: ${err instanceof Error ? err.message : String(err)}`;
        logger.error(
          { jobId: record.job_id, err },
          "E2-RECOVERY: failed to reset stale running job"
        );
      }

      staleJobs.push({ jobId: record.job_id, status: record.status, stuckForMinutes, action });
      repairActions.push({
        id: `manifest:stale_job:${record.job_id.slice(0, 8)}`,
        dimension: "manifests",
        type: "reset_stale_running_job",
        target: record.job_id,
        outcome,
        detail,
        durationMs: Date.now() - start,
        autoExecuted: true,
      });
    }

    // ── Detect schema anomalies ──────────────────────────────────────────────
    const snapshotRows = await db.execute(sql`
      SELECT ms.job_id, ms.schema_version
      FROM manifest_snapshots ms
      WHERE ms.schema_version IS NULL OR ms.schema_version NOT IN ('1.0')
      LIMIT 20
    `);
    const anomalyRecords = snapshotRows.rows as Array<{
      job_id: string;
      schema_version: string | null;
    }>;

    for (const r of anomalyRecords) {
      schemaAnomalies.push({
        jobId: r.job_id,
        schemaVersion: r.schema_version,
        issue: `Unexpected schema version: "${r.schema_version ?? "null"}" — expected "1.0"`,
      });
    }

    // Count total snapshots
    const countResult = await db.execute(sql`SELECT COUNT(*) AS n FROM manifest_snapshots`);
    const countRow = countResult.rows[0] as Record<string, unknown> | undefined;
    scannedSnapshots = parseInt(String(countRow?.["n"] ?? "0"), 10);
  } catch (err) {
    logger.error({ err }, "E2-RECOVERY: manifest recovery check threw");
    repairActions.push({
      id: "manifest:check_error",
      dimension: "manifests",
      type: "check_error",
      target: "manifest_snapshots",
      outcome: "failed",
      detail: `DB query failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: 0,
      autoExecuted: false,
    });
  }

  return {
    scannedSnapshots,
    staleRunningJobs,
    repairedStaleJobs,
    schemaAnomalies,
    staleJobs,
    repairActions,
  };
}

// ---------------------------------------------------------------------------
// 4. Deployment recovery — stuck executions + rollback opportunities
// ---------------------------------------------------------------------------

function recoverDeployments(): DeploymentRecoveryResult {
  const repairActions: RepairAction[] = [];
  const stuckExecutions: StuckExecution[] = [];

  const stuckThresholdMs = STUCK_DEPLOYMENT_THRESHOLD_MINUTES * 60 * 1000;
  const allExecutions = listExecutions();
  let rollbacksTriggered = 0;

  const stuck = allExecutions.filter(
    (e) =>
      (e.status === "running" || e.status === "pending") &&
      Date.now() - new Date(e.startedAt).getTime() > stuckThresholdMs
  );

  const failed = allExecutions.filter((e) => e.status === "failed");

  for (const execution of stuck) {
    const stuckForMinutes = Math.round(
      (Date.now() - new Date(execution.startedAt).getTime()) / 60000
    );
    const rollbackTarget =
      execution.jobId !== null
        ? getPreviousSuccessfulForJob(execution.jobId, execution.id)
        : undefined;
    const hasRollbackTarget = rollbackTarget !== undefined;

    // Auto-rollback is not executed here — it requires the deployment executor
    // which has external side-effects. Flag for E3 repair planner instead.
    const action: StuckExecution["action"] = hasRollbackTarget ? "flagged" : "skipped";

    stuckExecutions.push({
      id: execution.id,
      jobId: execution.jobId ?? "unknown",
      framework: execution.framework ?? "unknown",
      stuckForMinutes,
      hasRollbackTarget,
      action,
    });

    repairActions.push({
      id: `deployment:stuck:${execution.id.slice(0, 8)}`,
      dimension: "deployments",
      type: hasRollbackTarget ? "flag_rollback_available" : "flag_stuck_no_rollback",
      target: execution.id,
      outcome: "diagnosed",
      detail: hasRollbackTarget
        ? `Execution stuck for ${stuckForMinutes}m — rollback target available (${rollbackTarget!.id.slice(0, 8)})`
        : `Execution stuck for ${stuckForMinutes}m — no previous successful execution to roll back to`,
      durationMs: 0,
      autoExecuted: false,
    });
  }

  return {
    totalExecutions: allExecutions.length,
    stuckCount: stuck.length,
    failedCount: failed.length,
    rollbacksTriggered,
    stuckExecutions,
    repairActions,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runSystemRecovery(
  healthReport: HealthReport
): Promise<SystemRecoveryReport> {
  const startMs = Date.now();
  logger.info("E2-RECOVERY: starting system recovery cycle");

  const [assets, manifests] = await Promise.all([
    recoverAssets(),
    recoverManifests(),
  ]);

  const routes = recoverRoutes(healthReport);
  const deployments = recoverDeployments();

  const allActions = [
    ...routes.repairActions,
    ...assets.repairActions,
    ...manifests.repairActions,
    ...deployments.repairActions,
  ];

  const attempted = allActions.filter((a) => a.autoExecuted).length;
  const succeeded = allActions.filter(
    (a) => a.autoExecuted && a.outcome === "repaired"
  ).length;
  const failedActions = allActions.filter(
    (a) => a.autoExecuted && a.outcome === "failed"
  ).length;

  logger.info(
    {
      attempted,
      succeeded,
      failedActions,
      routesBroken: routes.brokenCount,
      assetsMissing: assets.missingCount,
      assetsRepaired: assets.repairedCount,
      staleJobs: manifests.staleRunningJobs,
      staleRepaired: manifests.repairedStaleJobs,
      stuckDeployments: deployments.stuckCount,
    },
    "E2-RECOVERY: system recovery cycle complete"
  );

  return {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
    basedOnHealthReport: healthReport.generatedAt,
    totalActionsAttempted: attempted,
    totalActionsSucceeded: succeeded,
    totalActionsFailed: failedActions,
    findings: { routes, assets, manifests, deployments },
  };
}
