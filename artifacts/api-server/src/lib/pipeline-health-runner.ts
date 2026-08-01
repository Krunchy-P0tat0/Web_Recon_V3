/**
 * pipeline-health-runner.ts — Phase 6.2 Self-Healing Background Runner
 *
 * Runs the pipeline health check + repair cycle on a short interval.
 * Writes pipeline-health.json and pipeline-repair.json to:
 *   - Workspace root (../../ relative to api-server CWD)
 *   - R2 at monitoring/pipeline-health.json and monitoring/pipeline-repair.json
 *
 * Started once at server boot (called from index.ts alongside startMonitoringLoop).
 */

import { promises as fs } from "fs";
import path from "path";
import { runPipelineHealthChecks, type PipelineHealthReport } from "./pipeline-health-engine";
import { runPipelineRepair, type PipelineRepairReport } from "./pipeline-repair-engine";
import { getDefaultCloudProvider } from "../cloud";
import { logger } from "./logger";

// ── Config ────────────────────────────────────────────────────────────────────

const PIPELINE_INTERVAL_SECONDS = 30;  // faster than full E1 check (60s)
const WARMUP_MS = 8000;                // slightly after E1 warm-up (5s)

// Paths (walk up from artifacts/api-server CWD → workspace root)
const PIPELINE_HEALTH_PATH = path.resolve(process.cwd(), "../../pipeline-health.json");
const PIPELINE_REPAIR_PATH = path.resolve(process.cwd(), "../../pipeline-repair.json");

const PIPELINE_HEALTH_CLOUD_KEY = "monitoring/pipeline-health.json";
const PIPELINE_REPAIR_CLOUD_KEY = "monitoring/pipeline-repair.json";

// ── In-memory state ───────────────────────────────────────────────────────────

let _latestPipelineHealth: PipelineHealthReport | null = null;
let _latestPipelineRepair: PipelineRepairReport | null = null;
let _pipelineRunnerStarted = false;
let _cycleCount = 0;

export function getLatestPipelineHealth(): PipelineHealthReport | null {
  return _latestPipelineHealth;
}

export function getLatestPipelineRepair(): PipelineRepairReport | null {
  return _latestPipelineRepair;
}

export function getPipelineCycleCount(): number {
  return _cycleCount;
}

// ── Persistence ───────────────────────────────────────────────────────────────

async function persist<T>(filePath: string, cloudKey: string, data: T): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  await Promise.allSettled([
    fs.writeFile(filePath, json, "utf8"),
    (async () => {
      const provider = getDefaultCloudProvider();
      if (provider.isConfigured()) {
        await provider.upload({
          key:            cloudKey,
          data:           Buffer.from(json, "utf8"),
          contentType:    "application/json",
          checkDuplicate: false,
        });
      }
    })(),
  ]);
}

// ── Single cycle ──────────────────────────────────────────────────────────────

async function runPipelineCycle(): Promise<void> {
  const cycleId = ++_cycleCount;
  try {
    // Phase 6.2-A: health checks for all 5 stages
    const health = await runPipelineHealthChecks();
    _latestPipelineHealth = health;

    logger.info(
      {
        cycle:         cycleId,
        overallStatus: health.overallStatus,
        healthy:       health.summary.healthyStages,
        degraded:      health.summary.degradedStages,
        critical:      health.summary.criticalStages,
        findings:      health.summary.totalFindings,
        durationMs:    health.durationMs,
      },
      "PIPELINE-HEALTH: cycle complete"
    );

    // Phase 6.2-B: auto-repair (only runs when there are degraded/critical stages)
    if (health.overallStatus !== "healthy") {
      const repair = await runPipelineRepair(health);
      _latestPipelineRepair = repair;

      logger.info(
        {
          cycle:        cycleId,
          attempted:    repair.totalActionsAttempted,
          succeeded:    repair.totalActionsSucceeded,
          failed:       repair.totalActionsFailed,
          manual:       repair.manualActionRequired.length,
          autoHealed:   repair.autoHealedIssues.length,
        },
        "PIPELINE-REPAIR: cycle complete"
      );

      await persist(PIPELINE_REPAIR_PATH, PIPELINE_REPAIR_CLOUD_KEY, repair);
    }

    // Always persist health report
    await persist(PIPELINE_HEALTH_PATH, PIPELINE_HEALTH_CLOUD_KEY, health);
  } catch (err) {
    logger.error({ cycle: cycleId, err }, "PIPELINE-RUNNER: cycle threw unexpectedly");
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Starts the pipeline health + repair loop.
 * Safe to call multiple times — only starts once.
 */
export function startPipelineHealthLoop(): void {
  if (_pipelineRunnerStarted) {
    logger.warn("PIPELINE-RUNNER: already started — ignoring duplicate call");
    return;
  }

  _pipelineRunnerStarted = true;
  logger.info({ intervalSeconds: PIPELINE_INTERVAL_SECONDS, warmupMs: WARMUP_MS }, "PIPELINE-RUNNER: starting loop");

  setTimeout(() => {
    void runPipelineCycle();
    setInterval(() => void runPipelineCycle(), PIPELINE_INTERVAL_SECONDS * 1000);
  }, WARMUP_MS);
}

/**
 * Trigger an immediate on-demand pipeline health check + repair cycle.
 * Used by the API route POST /api/monitor/pipeline/repair.
 */
export async function triggerPipelineCycleNow(): Promise<{
  health: PipelineHealthReport;
  repair: PipelineRepairReport;
}> {
  logger.info("PIPELINE-RUNNER: on-demand cycle triggered");
  const health = await runPipelineHealthChecks();
  _latestPipelineHealth = health;

  const repair = await runPipelineRepair(health);
  _latestPipelineRepair = repair;

  await Promise.allSettled([
    persist(PIPELINE_HEALTH_PATH, PIPELINE_HEALTH_CLOUD_KEY, health),
    persist(PIPELINE_REPAIR_PATH, PIPELINE_REPAIR_CLOUD_KEY, repair),
  ]);

  return { health, repair };
}
