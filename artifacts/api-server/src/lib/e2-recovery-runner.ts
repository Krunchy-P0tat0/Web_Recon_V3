/**
 * e2-recovery-runner.ts — Phase E2+E3 Background Runner
 *
 * Called at the end of each E1 monitoring cycle.
 * Runs the recovery engine (E2) and repair planner (E3), then:
 *   1. Stores latest reports in memory
 *   2. Writes recovery-report.json and repair-plan.json to workspace root
 *   3. Uploads to monitoring/recovery-report.json and monitoring/repair-plan.json in R2
 */

import { promises as fs } from "fs";
import path from "path";
import { runSystemRecovery, type SystemRecoveryReport } from "./e2-recovery-engine";
import { buildRepairPlan, type RepairPlan } from "./e3-repair-planner";
import { getDefaultCloudProvider } from "../cloud";
import { logger } from "./logger";
import type { HealthReport } from "./monitoring-engine";

// ---------------------------------------------------------------------------
// Paths (relative to api-server cwd → workspace root)
// ---------------------------------------------------------------------------

const RECOVERY_REPORT_PATH = path.resolve(process.cwd(), "../../recovery-report.json");
const REPAIR_PLAN_PATH = path.resolve(process.cwd(), "../../repair-plan.json");

const RECOVERY_CLOUD_KEY = "monitoring/recovery-report.json";
const REPAIR_PLAN_CLOUD_KEY = "monitoring/repair-plan.json";

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let _latestRecovery: SystemRecoveryReport | null = null;
let _latestRepairPlan: RepairPlan | null = null;

export function getLatestRecoveryReport(): SystemRecoveryReport | null {
  return _latestRecovery;
}

export function getLatestRepairPlan(): RepairPlan | null {
  return _latestRepairPlan;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function saveToDisk<T>(filePath: string, data: T): Promise<void> {
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
    logger.debug({ path: filePath }, "E2-RUNNER: report written to disk");
  } catch (err) {
    logger.warn({ err, path: filePath }, "E2-RUNNER: failed to write report to disk");
  }
}

async function uploadToCloud(key: string, data: unknown): Promise<void> {
  const provider = getDefaultCloudProvider();
  if (!provider.isConfigured()) return;

  try {
    const buf = Buffer.from(JSON.stringify(data, null, 2), "utf8");
    await provider.upload({ key, data: buf, contentType: "application/json", checkDuplicate: false });
    logger.debug({ key }, "E2-RUNNER: report uploaded to cloud");
  } catch (err) {
    logger.warn({ err, key }, "E2-RUNNER: failed to upload report to cloud (non-fatal)");
  }
}

// ---------------------------------------------------------------------------
// Main cycle — called by monitoring-runner after each health check
// ---------------------------------------------------------------------------

export async function runRecoveryAndRepair(healthReport: HealthReport): Promise<void> {
  try {
    // Phase E2: run system recovery
    const recovery = await runSystemRecovery(healthReport);
    _latestRecovery = recovery;

    // Phase E3: build repair plan from health + recovery reports
    const repairPlan = buildRepairPlan(healthReport, recovery);
    _latestRepairPlan = repairPlan;

    // Persist both reports in parallel
    await Promise.all([
      saveToDisk(RECOVERY_REPORT_PATH, recovery),
      saveToDisk(REPAIR_PLAN_PATH, repairPlan),
      uploadToCloud(RECOVERY_CLOUD_KEY, recovery),
      uploadToCloud(REPAIR_PLAN_CLOUD_KEY, repairPlan),
    ]);

    logger.info(
      {
        systemStatus: repairPlan.summary.systemStatus,
        rootCauses: repairPlan.summary.totalRootCauses,
        autoExecuted: repairPlan.summary.autoExecutedCount,
        pendingManual: repairPlan.summary.pendingManualCount,
        recoveryActionsSucceeded: recovery.totalActionsSucceeded,
      },
      "E2-RUNNER: recovery + repair cycle complete"
    );
  } catch (err) {
    logger.error({ err }, "E2-RUNNER: recovery/repair cycle threw unexpectedly (non-fatal)");
  }
}
