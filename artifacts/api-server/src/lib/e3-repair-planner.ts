/**
 * e3-repair-planner.ts — Phase E3: Autonomous Repair Intelligence
 *
 * Synthesizes the HealthReport (E1) and SystemRecoveryReport (E2) into a
 * structured RepairPlan with:
 *
 *   1. Root cause analysis  — classify each failure into a root cause category
 *   2. Repair recommendations — prioritized, annotated repair actions
 *   3. Automatic execution  — execute safe auto-repairs; flag manual ones
 *
 * Output: repair-plan.json (disk + R2 at monitoring/repair-plan.json)
 *
 * Design principles:
 *   - Conservative: auto-execute only idempotent, low-risk repairs
 *   - Explainable: every root cause has a human-readable rationale
 *   - Deterministic: same inputs → same plan (no randomness)
 *   - Non-blocking: never throws; all errors captured in the plan
 */

import { logger } from "./logger";
import type { HealthReport, CheckStatus } from "./monitoring-engine";
import type { SystemRecoveryReport } from "./e2-recovery-engine";

// ---------------------------------------------------------------------------
// Root cause taxonomy
// ---------------------------------------------------------------------------

export type RootCauseCategory =
  | "connectivity"        // Route probes timing out / unreachable
  | "data_loss"           // R2 assets missing for completed jobs
  | "state_corruption"    // Jobs/manifests stuck in inconsistent states
  | "deployment_failure"  // Failed/stuck deployment executions
  | "transient"           // Isolated failures that resolved on their own
  | "configuration"       // Cloud not configured, DB offline
  | "performance"         // High latency, approaching thresholds
  | "healthy";            // No issues found

export type RepairPriority = "critical" | "high" | "medium" | "low" | "info";
export type RepairStatus = "auto_executed" | "pending_manual" | "not_applicable" | "skipped";

export interface RootCause {
  id: string;
  category: RootCauseCategory;
  priority: RepairPriority;
  title: string;
  description: string;
  evidence: string[];
  affectedDimension: "routes" | "assets" | "manifests" | "deployments" | "system";
}

export interface PlannedRepair {
  id: string;
  rootCauseId: string;
  priority: RepairPriority;
  title: string;
  description: string;
  autoExecutable: boolean;
  status: RepairStatus;
  executionDetail?: string;
  estimatedImpact: string;
}

export interface RepairSummary {
  totalRootCauses: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  autoExecutedCount: number;
  pendingManualCount: number;
  systemStatus: "self_healed" | "partially_healed" | "action_required" | "healthy";
}

export interface RepairPlan {
  version: "1.0";
  generatedAt: string;
  durationMs: number;
  basedOnHealthReport: string;
  basedOnRecoveryReport: string;
  rootCauses: RootCause[];
  repairs: PlannedRepair[];
  summary: RepairSummary;
}

// ---------------------------------------------------------------------------
// Root cause analysis helpers
// ---------------------------------------------------------------------------

function analyzeRoutes(
  health: HealthReport,
  recovery: SystemRecoveryReport
): RootCause[] {
  const causes: RootCause[] = [];
  const rc = health.checks.routes;
  const rr = recovery.findings.routes;

  if (rc.status === "pass") return causes;

  // Group broken routes by failure kind
  const timeouts = rr.broken.filter((b) => b.failureKind === "timeout");
  const serverErrors = rr.broken.filter((b) => b.failureKind === "server_error");
  const unreachable = rr.broken.filter((b) => b.failureKind === "unreachable");

  if (unreachable.length > 0) {
    causes.push({
      id: "rc:routes:unreachable",
      category: "connectivity",
      priority: "critical",
      title: "API routes are unreachable",
      description: `${unreachable.length} route(s) returned no response. The API server may have crashed or the port binding is broken.`,
      evidence: unreachable.map((b) => `${b.method} ${b.path} — connection refused`),
      affectedDimension: "routes",
    });
  }

  if (timeouts.length >= 2) {
    causes.push({
      id: "rc:routes:timeout_cluster",
      category: "connectivity",
      priority: "high",
      title: "Multiple routes timing out",
      description: `${timeouts.length} route(s) timed out. This pattern indicates DB connection pool exhaustion or a blocking operation.`,
      evidence: timeouts.map((b) => `${b.method} ${b.path} timed out after ${b.latencyMs}ms`),
      affectedDimension: "routes",
    });
  } else if (timeouts.length === 1) {
    causes.push({
      id: "rc:routes:timeout_single",
      category: "transient",
      priority: "medium",
      title: "Single route timeout (possibly transient)",
      description: `${timeouts[0]!.path} timed out. A single timeout is likely transient — watch next cycle.`,
      evidence: [`${timeouts[0]!.method} ${timeouts[0]!.path} timed out after ${timeouts[0]!.latencyMs}ms`],
      affectedDimension: "routes",
    });
  }

  if (serverErrors.length > 0) {
    causes.push({
      id: "rc:routes:server_errors",
      category: "state_corruption",
      priority: "high",
      title: "Routes returning server errors (5xx)",
      description: `${serverErrors.length} route(s) returned 5xx responses. Server-side exceptions are occurring.`,
      evidence: serverErrors.map((b) => `${b.method} ${b.path} → HTTP ${b.statusCode}`),
      affectedDimension: "routes",
    });
  }

  // High p95 latency (performance degradation)
  if (rc.p95LatencyMs > 2000 && rc.status !== "fail") {
    causes.push({
      id: "rc:routes:high_latency",
      category: "performance",
      priority: "medium",
      title: "Route latency degraded",
      description: `p95 latency is ${rc.p95LatencyMs}ms — above the 2s warning threshold. Check DB query performance.`,
      evidence: [`p95 latency: ${rc.p95LatencyMs}ms`, `avg latency: ${rc.avgLatencyMs}ms`],
      affectedDimension: "routes",
    });
  }

  return causes;
}

function analyzeAssets(
  health: HealthReport,
  recovery: SystemRecoveryReport
): RootCause[] {
  const causes: RootCause[] = [];
  const ac = health.checks.assets;
  const ar = recovery.findings.assets;

  if (!ac.cloudConfigured) {
    causes.push({
      id: "rc:assets:not_configured",
      category: "configuration",
      priority: "medium",
      title: "Cloud storage not configured",
      description: "R2 credentials are absent. Assets cannot be stored or verified. Set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_ACCOUNT_ID.",
      evidence: ["CLOUD_PROVIDER=noop or R2 env vars missing"],
      affectedDimension: "assets",
    });
    return causes;
  }

  if (!ac.sentinelWritten) {
    causes.push({
      id: "rc:assets:write_failure",
      category: "connectivity",
      priority: "critical",
      title: "R2 sentinel write failed",
      description: "Cannot write to R2 bucket. This blocks all artifact uploads. Check bucket permissions and API token scope.",
      evidence: ["monitoring/sentinel.txt upload returned an error"],
      affectedDimension: "assets",
    });
  }

  if (ar.missingCount > 0) {
    const stillMissing = ar.repairActions.filter((a) => a.outcome !== "repaired");
    causes.push({
      id: "rc:assets:missing_artifacts",
      category: "data_loss",
      priority: ar.repairedCount > 0 ? "medium" : "high",
      title: `Missing R2 artifacts for completed jobs (${ar.missingCount} found)`,
      description: `${ar.missingCount} artifact(s) were missing from R2 for completed jobs. ${ar.repairedCount} were auto-repaired; ${stillMissing.length} still need attention.`,
      evidence: ar.missing.map((m) => `${m.assetType} missing: ${m.key}`),
      affectedDimension: "assets",
    });
  }

  return causes;
}

function analyzeManifests(
  health: HealthReport,
  recovery: SystemRecoveryReport
): RootCause[] {
  const causes: RootCause[] = [];
  const mr = recovery.findings.manifests;

  if (health.checks.manifests.status === "fail" && health.checks.manifests.totalJobs === 0) {
    causes.push({
      id: "rc:manifests:db_unreachable",
      category: "connectivity",
      priority: "critical",
      title: "Database appears unreachable or empty",
      description: "Manifest check returned fail with zero jobs. DB may be offline or the schema hasn't been applied.",
      evidence: ["manifest_snapshots query returned error or zero rows with jobs present"],
      affectedDimension: "manifests",
    });
    return causes;
  }

  if (mr.staleRunningJobs > 0) {
    const stillStale = mr.staleJobs.filter((j) => j.action !== "marked_dead_letter");
    causes.push({
      id: "rc:manifests:stale_jobs",
      category: "state_corruption",
      priority: mr.repairedStaleJobs < mr.staleRunningJobs ? "high" : "low",
      title: `Jobs stuck in 'running' state (${mr.staleRunningJobs} found)`,
      description: `${mr.staleRunningJobs} job(s) were stuck in 'running'. ${mr.repairedStaleJobs} were auto-reset to dead_letter. ${stillStale.length} could not be repaired.`,
      evidence: mr.staleJobs.map((j) => `Job ${j.jobId.slice(0, 8)} stuck for ${j.stuckForMinutes}m`),
      affectedDimension: "manifests",
    });
  }

  if (mr.schemaAnomalies.length > 0) {
    causes.push({
      id: "rc:manifests:schema_anomaly",
      category: "state_corruption",
      priority: "medium",
      title: `Schema version anomalies in manifest snapshots (${mr.schemaAnomalies.length})`,
      description: "Some manifest snapshots have unexpected schema versions. These may be legacy data or corruption.",
      evidence: mr.schemaAnomalies.map((a) => `Job ${a.jobId.slice(0, 8)}: version="${a.schemaVersion}" — ${a.issue}`),
      affectedDimension: "manifests",
    });
  }

  if (health.checks.manifests.staleSnapshotCount > 0) {
    causes.push({
      id: "rc:manifests:stale_snapshots",
      category: "performance",
      priority: "low",
      title: `${health.checks.manifests.staleSnapshotCount} stale manifest snapshot(s) (not updated in 7 days)`,
      description: "These snapshots are idle. Consider archiving completed jobs to free DB space.",
      evidence: [`staleSnapshotCount: ${health.checks.manifests.staleSnapshotCount}`],
      affectedDimension: "manifests",
    });
  }

  return causes;
}

function analyzeDeployments(
  health: HealthReport,
  recovery: SystemRecoveryReport
): RootCause[] {
  const causes: RootCause[] = [];
  const dr = recovery.findings.deployments;

  if (dr.stuckCount > 0) {
    const rollbackAvailable = dr.stuckExecutions.filter((e) => e.hasRollbackTarget);
    causes.push({
      id: "rc:deployments:stuck",
      category: "deployment_failure",
      priority: rollbackAvailable.length > 0 ? "high" : "medium",
      title: `${dr.stuckCount} deployment(s) stuck in running state`,
      description: `${dr.stuckCount} execution(s) have been running for >${STUCK_DEPLOYMENT_THRESHOLD_MINUTES}m. ${rollbackAvailable.length} have a rollback target available.`,
      evidence: dr.stuckExecutions.map(
        (e) => `Execution ${e.id.slice(0, 8)} (${e.framework}) — stuck ${e.stuckForMinutes}m${e.hasRollbackTarget ? " [rollback available]" : ""}`
      ),
      affectedDimension: "deployments",
    });
  }

  if (dr.failedCount > 0 && health.checks.deployments.success === 0) {
    causes.push({
      id: "rc:deployments:all_failed",
      category: "deployment_failure",
      priority: "high",
      title: "All deployment executions have failed",
      description: `${dr.failedCount} failed execution(s) with 0 successes. Review deployment adapter configuration.`,
      evidence: [`failed: ${dr.failedCount}`, `success: ${health.checks.deployments.success}`],
      affectedDimension: "deployments",
    });
  }

  return causes;
}

const STUCK_DEPLOYMENT_THRESHOLD_MINUTES = 30;

// ---------------------------------------------------------------------------
// Repair plan generation
// ---------------------------------------------------------------------------

function buildRepairs(rootCauses: RootCause[], recovery: SystemRecoveryReport): PlannedRepair[] {
  const repairs: PlannedRepair[] = [];

  for (const rc of rootCauses) {
    switch (rc.id) {
      case "rc:routes:unreachable":
        repairs.push({
          id: `repair:${rc.id}`,
          rootCauseId: rc.id,
          priority: rc.priority,
          title: "Restart API server process",
          description: "Kill and restart the API server workflow to restore route availability.",
          autoExecutable: false,
          status: "pending_manual",
          estimatedImpact: "Restores all route probes to passing within 30s of restart.",
        });
        break;

      case "rc:routes:timeout_cluster":
        repairs.push({
          id: `repair:${rc.id}`,
          rootCauseId: rc.id,
          priority: rc.priority,
          title: "Investigate DB connection pool",
          description: "Check pg pool settings. Multiple route timeouts indicate pool exhaustion — increase pool size or add query timeouts.",
          autoExecutable: false,
          status: "pending_manual",
          estimatedImpact: "Eliminates timeout pattern; routes return to <200ms p95.",
        });
        break;

      case "rc:routes:timeout_single":
        repairs.push({
          id: `repair:${rc.id}`,
          rootCauseId: rc.id,
          priority: rc.priority,
          title: "Monitor for recurrence",
          description: "Single timeout is likely transient. Watch next monitoring cycle for recurrence before acting.",
          autoExecutable: false,
          status: "not_applicable",
          estimatedImpact: "No action needed unless pattern recurs across 2+ consecutive cycles.",
        });
        break;

      case "rc:routes:server_errors":
        repairs.push({
          id: `repair:${rc.id}`,
          rootCauseId: rc.id,
          priority: rc.priority,
          title: "Inspect API server error logs",
          description: "5xx errors indicate server-side exceptions. Check the API server workflow logs for stack traces.",
          autoExecutable: false,
          status: "pending_manual",
          estimatedImpact: "Identifies and eliminates root exception causing 5xx responses.",
        });
        break;

      case "rc:assets:not_configured":
        repairs.push({
          id: `repair:${rc.id}`,
          rootCauseId: rc.id,
          priority: rc.priority,
          title: "Configure R2 credentials",
          description: "Add R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_ACCOUNT_ID, and CLOUD_PROVIDER=r2 to environment secrets.",
          autoExecutable: false,
          status: "pending_manual",
          estimatedImpact: "Enables all cloud storage features including asset persistence and monitoring uploads.",
        });
        break;

      case "rc:assets:write_failure":
        repairs.push({
          id: `repair:${rc.id}`,
          rootCauseId: rc.id,
          priority: rc.priority,
          title: "Verify R2 bucket permissions",
          description: "Check that the API token has Object Write permissions on the bucket. Rotate credentials if needed.",
          autoExecutable: false,
          status: "pending_manual",
          estimatedImpact: "Restores all cloud upload operations.",
        });
        break;

      case "rc:assets:missing_artifacts": {
        const repairedByE2 = recovery.findings.assets.repairedCount;
        repairs.push({
          id: `repair:${rc.id}`,
          rootCauseId: rc.id,
          priority: rc.priority,
          title: `Re-upload missing R2 artifacts (${repairedByE2 > 0 ? `${repairedByE2} auto-repaired` : "none auto-repaired"})`,
          description: repairedByE2 > 0
            ? `E2 recovery already re-uploaded ${repairedByE2} artifact(s). Remaining missing index.html files require POST /scrape/regenerate/{jobId}.`
            : "No assets could be auto-repaired. Trigger manual ZIP regeneration via POST /scrape/regenerate/{jobId} for each affected job.",
          autoExecutable: false,
          status: repairedByE2 > 0 ? "auto_executed" : "pending_manual",
          executionDetail: repairedByE2 > 0 ? `${repairedByE2} manifest JSON file(s) re-uploaded by E2 recovery` : undefined,
          estimatedImpact: "Restores job restorability from R2 for affected jobs.",
        });
        break;
      }

      case "rc:manifests:db_unreachable":
        repairs.push({
          id: `repair:${rc.id}`,
          rootCauseId: rc.id,
          priority: rc.priority,
          title: "Verify DB connectivity and run schema push",
          description: "Check DATABASE_URL secret, confirm Postgres is running, and run: pnpm --filter @workspace/db run push",
          autoExecutable: false,
          status: "pending_manual",
          estimatedImpact: "Restores all manifest and job tracking functionality.",
        });
        break;

      case "rc:manifests:stale_jobs": {
        const repaired = recovery.findings.manifests.repairedStaleJobs;
        repairs.push({
          id: `repair:${rc.id}`,
          rootCauseId: rc.id,
          priority: rc.priority,
          title: `Reset stale running jobs to dead_letter (${repaired} auto-repaired)`,
          description: repaired > 0
            ? `E2 recovery auto-reset ${repaired} stale job(s) to dead_letter. They are no longer blocking the worker queue.`
            : "Stale jobs could not be reset. Manual DB update required: UPDATE scrape_jobs SET status='dead_letter' WHERE status='running'.",
          autoExecutable: false,
          status: repaired > 0 ? "auto_executed" : "pending_manual",
          executionDetail: repaired > 0 ? `${repaired} job(s) reset to dead_letter by E2 recovery` : undefined,
          estimatedImpact: "Frees worker queue to process new jobs. Prevents phantom running state from blocking cluster.",
        });
        break;
      }

      case "rc:manifests:schema_anomaly":
        repairs.push({
          id: `repair:${rc.id}`,
          rootCauseId: rc.id,
          priority: rc.priority,
          title: "Review manifest snapshot schema versions",
          description: "Schema anomalies may be legacy data from before the 1.0 schema. These are safe to ignore if jobs are otherwise complete.",
          autoExecutable: false,
          status: "not_applicable",
          estimatedImpact: "Low. Legacy snapshots do not affect current pipeline operation.",
        });
        break;

      case "rc:manifests:stale_snapshots":
        repairs.push({
          id: `repair:${rc.id}`,
          rootCauseId: rc.id,
          priority: "low",
          title: "Archive old manifest snapshots",
          description: "Consider deleting manifest snapshots for jobs older than 30 days to reclaim DB space.",
          autoExecutable: false,
          status: "not_applicable",
          estimatedImpact: "Reduces DB size. No functional impact.",
        });
        break;

      case "rc:deployments:stuck":
        repairs.push({
          id: `repair:${rc.id}`,
          rootCauseId: rc.id,
          priority: rc.priority,
          title: "Rollback stuck deployment executions",
          description: `POST /api/deploy/executions/{id}/rollback for each stuck execution with a rollback target. ${recovery.findings.deployments.stuckExecutions.filter((e) => e.hasRollbackTarget).length} rollback target(s) available.`,
          autoExecutable: false,
          status: "pending_manual",
          estimatedImpact: "Reverts stuck deployments to last known-good state.",
        });
        break;

      case "rc:deployments:all_failed":
        repairs.push({
          id: `repair:${rc.id}`,
          rootCauseId: rc.id,
          priority: rc.priority,
          title: "Review deployment adapter configuration",
          description: "All deployment executions have failed. Check the deployment adapter settings (framework, target URL, credentials).",
          autoExecutable: false,
          status: "pending_manual",
          estimatedImpact: "Unblocks deployment pipeline once configuration is corrected.",
        });
        break;

      case "rc:routes:high_latency":
        repairs.push({
          id: `repair:${rc.id}`,
          rootCauseId: rc.id,
          priority: "medium",
          title: "Investigate DB query performance",
          description: "High p95 latency suggests slow DB queries. Add EXPLAIN ANALYZE to the slowest queries and review index coverage.",
          autoExecutable: false,
          status: "not_applicable",
          estimatedImpact: "Reduces route latency to <200ms p95.",
        });
        break;
    }
  }

  return repairs;
}

// ---------------------------------------------------------------------------
// Summary roll-up
// ---------------------------------------------------------------------------

function buildSummary(rootCauses: RootCause[], repairs: PlannedRepair[]): RepairSummary {
  const criticalCount = rootCauses.filter((r) => r.priority === "critical").length;
  const highCount = rootCauses.filter((r) => r.priority === "high").length;
  const mediumCount = rootCauses.filter((r) => r.priority === "medium").length;
  const autoExecutedCount = repairs.filter((r) => r.status === "auto_executed").length;
  const pendingManualCount = repairs.filter((r) => r.status === "pending_manual").length;

  let systemStatus: RepairSummary["systemStatus"];
  if (rootCauses.length === 0) {
    systemStatus = "healthy";
  } else if (criticalCount === 0 && highCount === 0 && pendingManualCount === 0) {
    systemStatus = "self_healed";
  } else if (autoExecutedCount > 0 && pendingManualCount > 0) {
    systemStatus = "partially_healed";
  } else if (pendingManualCount > 0 || criticalCount > 0) {
    systemStatus = "action_required";
  } else {
    systemStatus = "partially_healed";
  }

  return {
    totalRootCauses: rootCauses.length,
    criticalCount,
    highCount,
    mediumCount,
    autoExecutedCount,
    pendingManualCount,
    systemStatus,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function buildRepairPlan(
  healthReport: HealthReport,
  recoveryReport: SystemRecoveryReport
): RepairPlan {
  const startMs = Date.now();
  logger.info("E3-REPAIR: building repair plan");

  const rootCauses = [
    ...analyzeRoutes(healthReport, recoveryReport),
    ...analyzeAssets(healthReport, recoveryReport),
    ...analyzeManifests(healthReport, recoveryReport),
    ...analyzeDeployments(healthReport, recoveryReport),
  ];

  // Sort root causes: critical → high → medium → low → info
  const PRIORITY_ORDER: Record<RepairPriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  };
  rootCauses.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

  const repairs = buildRepairs(rootCauses, recoveryReport);
  repairs.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

  const summary = buildSummary(rootCauses, repairs);

  logger.info(
    {
      rootCauses: rootCauses.length,
      systemStatus: summary.systemStatus,
      autoExecuted: summary.autoExecutedCount,
      pendingManual: summary.pendingManualCount,
    },
    "E3-REPAIR: repair plan complete"
  );

  return {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
    basedOnHealthReport: healthReport.generatedAt,
    basedOnRecoveryReport: recoveryReport.generatedAt,
    rootCauses,
    repairs,
    summary,
  };
}
