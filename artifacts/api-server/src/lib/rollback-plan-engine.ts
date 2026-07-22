/**
 * rollback-plan-engine.ts — Phase 6.5 Deployment Recovery Engine
 *
 * Generates a structured rollback-plan.json for every deployment execution.
 * The plan provides everything needed for single-click rollback:
 *
 *   1. Rollback target   — URL of the previous stable deployment
 *   2. Deployment version — semver + executionId of the target state
 *   3. DB rollback       — schema migration awareness (which tables changed)
 *   4. Storage rollback  — R2 keys deployed by the current execution
 *
 * Design contract:
 *   - Never throws — all errors captured in the plan
 *   - Deterministic — same inputs → same plan
 *   - Blocking gate — must be generated before a deployment is allowed to proceed
 *   - Written to disk + R2 (rollback-plan.json)
 */

import { writeFile } from "fs/promises";
import { join }      from "path";
import { logger }    from "./logger.js";
import type { DeploymentExecution } from "./deployment-executor.js";
import { listExecutions }           from "./deployment-audit-store.js";
import type { CloudProvider }       from "../cloud/provider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RollbackReadiness =
  | "ROLLBACK_AVAILABLE"    // A previous stable deployment exists
  | "NO_PRIOR_DEPLOYMENT"   // This is the first-ever deployment for the job
  | "ROLLBACK_IN_PROGRESS"  // Already rolling back
  | "INSUFFICIENT_HISTORY"; // Not enough data to determine rollback target

export type DbRollbackRisk = "NONE" | "LOW" | "MEDIUM" | "HIGH";

export interface RollbackTarget {
  executionId: string;
  jobId: string | null;
  deployedAt: string;
  deploymentUrl: string;
  framework: string | null;
  filesDeployed: number;
  bytesDeployed: number;
}

export interface DbRollbackRequirements {
  risk: DbRollbackRisk;
  notes: string;
  schemaTablesInScope: string[];
  migrationStepsRequired: string[];
  automatable: boolean;
}

export interface StorageRollbackRequirements {
  r2PrefixToCleanup: string | null;
  estimatedFilesToDelete: number;
  estimatedBytesToFree: number;
  retainPreviousDeployment: boolean;
  cleanupCommand: string | null;
}

export interface RollbackStep {
  order: number;
  action: string;
  detail: string;
  automated: boolean;
  apiEndpoint: string | null;
}

export interface RollbackPlan {
  version: "1.0";
  phase: "6.5";
  generatedAt: string;
  durationMs: number;
  executionId: string;
  jobId: string | null;
  readiness: RollbackReadiness;
  rollbackTarget: RollbackTarget | null;
  dbRollbackRequirements: DbRollbackRequirements;
  storageRollbackRequirements: StorageRollbackRequirements;
  rollbackSteps: RollbackStep[];
  singleClickEndpoint: string | null;
  summary: {
    canRollback: boolean;
    estimatedRollbackSeconds: number;
    riskLevel: "LOW" | "MEDIUM" | "HIGH";
    blockers: string[];
  };
}

// ---------------------------------------------------------------------------
// DB rollback analysis
// ---------------------------------------------------------------------------

const SCHEMA_TABLES = [
  "scrape_jobs",
  "manifest_snapshots",
  "differential_history",
  "generation_reports",
  "construction_reports",
];

function analyzeDbRollback(execution: DeploymentExecution): DbRollbackRequirements {
  // For R2-static deployments, no DB schema changes occur during deployment.
  // The DB risk is always LOW for static site deployments.
  // If the framework touches a DB (e.g. SSR), risk escalates.
  const isSsr = ["next", "nuxt", "remix", "sveltekit"].some(
    (f) => execution.framework?.toLowerCase().includes(f)
  );

  if (isSsr) {
    return {
      risk: "MEDIUM",
      notes:
        "SSR framework detected. Ensure database migrations are backward-compatible before rolling back. " +
        "Data written during this deployment version may not be readable by the previous version's schema.",
      schemaTablesInScope: SCHEMA_TABLES,
      migrationStepsRequired: [
        "Verify no destructive migrations ran during this deployment",
        "Check that previous version's ORM queries are compatible with current schema",
        "If breaking migrations exist, apply rollback migrations before redirecting traffic",
      ],
      automatable: false,
    };
  }

  return {
    risk: "NONE",
    notes:
      "Static site deployment (r2-static). No database schema changes occur during deployment. " +
      "Rollback is purely a storage + URL redirect operation with zero DB impact.",
    schemaTablesInScope: [],
    migrationStepsRequired: [],
    automatable: true,
  };
}

// ---------------------------------------------------------------------------
// Storage rollback analysis
// ---------------------------------------------------------------------------

function analyzeStorageRollback(execution: DeploymentExecution): StorageRollbackRequirements {
  const r2Prefix = `deployments/${execution.id}`;

  if (execution.status === "failed" || execution.filesDeployed === 0) {
    return {
      r2PrefixToCleanup: r2Prefix,
      estimatedFilesToDelete: execution.filesDeployed,
      estimatedBytesToFree: execution.bytesDeployed,
      retainPreviousDeployment: true,
      cleanupCommand: execution.filesDeployed > 0
        ? `DELETE all objects under r2://${process.env["R2_BUCKET_NAME"] ?? "<bucket>"}/${r2Prefix}/`
        : null,
    };
  }

  return {
    r2PrefixToCleanup: r2Prefix,
    estimatedFilesToDelete: execution.filesDeployed,
    estimatedBytesToFree: execution.bytesDeployed,
    retainPreviousDeployment: true,
    cleanupCommand:
      `DELETE objects under r2://${process.env["R2_BUCKET_NAME"] ?? "<bucket>"}/${r2Prefix}/ ` +
      `(${execution.filesDeployed} files, ${Math.round(execution.bytesDeployed / 1024)}kb). ` +
      `Previous deployment remains live at its own prefix.`,
  };
}

// ---------------------------------------------------------------------------
// Rollback step plan
// ---------------------------------------------------------------------------

function buildRollbackSteps(
  execution: DeploymentExecution,
  target: RollbackTarget | null,
  readiness: RollbackReadiness
): RollbackStep[] {
  if (readiness === "NO_PRIOR_DEPLOYMENT") {
    return [
      {
        order: 1,
        action: "MANUAL_RESTORE",
        detail: "No prior deployment exists. Restore from source: re-run the full pipeline from scrape → generate → deploy.",
        automated: false,
        apiEndpoint: "POST /api/orchestrate",
      },
    ];
  }

  if (!target) return [];

  return [
    {
      order: 1,
      action: "TRIGGER_ROLLBACK",
      detail: `Call the single-click rollback endpoint. This instantly redirects traffic to ${target.deploymentUrl}`,
      automated: true,
      apiEndpoint: `POST /api/deploy/executions/${execution.id}/rollback`,
    },
    {
      order: 2,
      action: "VERIFY_ROLLBACK",
      detail: `Confirm ${target.deploymentUrl} is reachable and serving expected content.`,
      automated: false,
      apiEndpoint: null,
    },
    {
      order: 3,
      action: "CLEANUP_FAILED_DEPLOYMENT",
      detail: `Optionally delete R2 objects under deployments/${execution.id}/ to reclaim storage.`,
      automated: false,
      apiEndpoint: null,
    },
    {
      order: 4,
      action: "ROOT_CAUSE_ANALYSIS",
      detail: "Investigate the failure via POST /api/monitor/recover to generate a repair plan before re-deploying.",
      automated: false,
      apiEndpoint: "POST /api/monitor/recover",
    },
  ];
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function buildSummary(
  readiness: RollbackReadiness,
  db: DbRollbackRequirements,
  storage: StorageRollbackRequirements
): RollbackPlan["summary"] {
  const canRollback = readiness === "ROLLBACK_AVAILABLE";

  const blockers: string[] = [];
  if (!canRollback) blockers.push(`Rollback readiness: ${readiness}`);
  if (db.risk === "HIGH") blockers.push("High DB rollback risk — manual migration required");
  if (!storage.retainPreviousDeployment) blockers.push("Previous deployment was deleted — no storage target");

  const riskLevel =
    db.risk === "HIGH"   ? "HIGH" :
    db.risk === "MEDIUM" ? "MEDIUM" :
    "LOW";

  return {
    canRollback,
    estimatedRollbackSeconds: canRollback ? 2 : 0,
    riskLevel,
    blockers,
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const LOCAL_PATH     = join(process.cwd(), "rollback-plan.json");
const WORKSPACE_PATH = join(process.cwd(), "..", "..", "rollback-plan.json");

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function generateRollbackPlan(
  execution: DeploymentExecution,
  cloudProvider?: CloudProvider
): Promise<RollbackPlan> {
  const t0 = Date.now();
  logger.info({ executionId: execution.id }, "ROLLBACK-PLAN: generating plan");

  // ── Find rollback target (most recent prior success for same job) ──────────
  let rollbackTarget: RollbackTarget | null = null;
  let readiness: RollbackReadiness;

  if (!execution.jobId) {
    readiness = "INSUFFICIENT_HISTORY";
  } else {
    const allForJob = listExecutions().filter(
      (e) => e.jobId === execution.jobId && e.id !== execution.id && e.status === "success"
    );
    const prior = allForJob[0] ?? null;

    if (!prior) {
      readiness = "NO_PRIOR_DEPLOYMENT";
    } else if (!prior.deploymentUrl) {
      readiness = "INSUFFICIENT_HISTORY";
    } else {
      readiness = "ROLLBACK_AVAILABLE";
      rollbackTarget = {
        executionId:   prior.id,
        jobId:         prior.jobId,
        deployedAt:    prior.completedAt ?? prior.startedAt,
        deploymentUrl: prior.deploymentUrl,
        framework:     prior.framework,
        filesDeployed: prior.filesDeployed,
        bytesDeployed: prior.bytesDeployed,
      };
    }
  }

  const db      = analyzeDbRollback(execution);
  const storage = analyzeStorageRollback(execution);
  const steps   = buildRollbackSteps(execution, rollbackTarget, readiness);
  const summary = buildSummary(readiness, db, storage);

  const plan: RollbackPlan = {
    version:    "1.0",
    phase:      "6.5",
    generatedAt: new Date().toISOString(),
    durationMs:  Date.now() - t0,
    executionId: execution.id,
    jobId:       execution.jobId,
    readiness,
    rollbackTarget,
    dbRollbackRequirements:      db,
    storageRollbackRequirements: storage,
    rollbackSteps: steps,
    singleClickEndpoint: readiness === "ROLLBACK_AVAILABLE"
      ? `/api/deploy/executions/${execution.id}/rollback`
      : null,
    summary,
  };

  logger.info(
    {
      executionId: execution.id,
      readiness,
      canRollback:  summary.canRollback,
      riskLevel:    summary.riskLevel,
      durationMs:   plan.durationMs,
    },
    "ROLLBACK-PLAN: plan generated"
  );

  // ── Persist ───────────────────────────────────────────────────────────────
  const json = JSON.stringify(plan, null, 2);
  const writes: Promise<void>[] = [
    writeFile(LOCAL_PATH,     json, "utf8").catch((err) => logger.warn({ err }, "ROLLBACK-PLAN: local write failed")),
    writeFile(WORKSPACE_PATH, json, "utf8").catch((err) => logger.warn({ err }, "ROLLBACK-PLAN: workspace write failed")),
  ];

  if (execution.jobId && cloudProvider?.isConfigured()) {
    writes.push(
      cloudProvider.upload({
        key:          `jobs/${execution.jobId}/rollback-plan.json`,
        data:         Buffer.from(json, "utf8"),
        contentType:  "application/json",
        checkDuplicate: false,
      })
      .then(() => logger.info({ executionId: execution.id }, "ROLLBACK-PLAN: uploaded to R2"))
      .catch((err) => logger.warn({ err }, "ROLLBACK-PLAN: R2 upload failed (non-fatal)"))
    );
  }

  await Promise.allSettled(writes);
  return plan;
}
