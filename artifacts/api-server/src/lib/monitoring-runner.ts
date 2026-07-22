/**
 * monitoring-runner.ts — Phase E1 Background Monitor
 *
 * Starts a recurring timer that calls runAllChecks() and:
 *   1. Stores the report in memory (latest report always accessible)
 *   2. Writes health-report.json to the workspace root
 *   3. Uploads monitoring/health-report.json to R2 (when configured)
 *
 * The runner is started once at server boot from index.ts.
 */

import { promises as fs } from "fs";
import path from "path";
import { runAllChecks, type HealthReport } from "./monitoring-engine";
import { runRecoveryAndRepair } from "./e2-recovery-runner";
import { getDefaultCloudProvider } from "../cloud";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_SECONDS = 60;
const REPORT_CLOUD_KEY = "monitoring/health-report.json";

// Walk up: artifacts/api-server → artifacts → workspace root
const REPORT_PATH = path.resolve(process.cwd(), "../../health-report.json");

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let _latestReport: HealthReport | null = null;
let _runnerStarted = false;
let _port = 8080;

export function getLatestReport(): HealthReport | null {
  return _latestReport;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

async function saveToDisk(report: HealthReport): Promise<void> {
  try {
    await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
    logger.debug({ path: REPORT_PATH }, "MONITOR: health-report.json written to disk");
  } catch (err) {
    logger.warn({ err, path: REPORT_PATH }, "MONITOR: failed to write health-report.json to disk");
  }
}

async function uploadToCloud(report: HealthReport): Promise<void> {
  const provider = getDefaultCloudProvider();
  if (!provider.isConfigured()) return;

  try {
    const data = Buffer.from(JSON.stringify(report, null, 2), "utf8");
    const result = await provider.upload({
      key: REPORT_CLOUD_KEY,
      data,
      contentType: "application/json",
      checkDuplicate: false,
    });
    logger.debug(
      { key: REPORT_CLOUD_KEY, url: result.url, bytes: result.bytesUploaded },
      "MONITOR: health-report.json uploaded to cloud"
    );
  } catch (err) {
    logger.warn({ err, key: REPORT_CLOUD_KEY }, "MONITOR: failed to upload health-report.json to cloud (non-fatal)");
  }
}

// ---------------------------------------------------------------------------
// Single check cycle
// ---------------------------------------------------------------------------

async function runCycle(intervalSeconds: number): Promise<void> {
  try {
    // E1 — health monitoring
    const report = await runAllChecks(_port, intervalSeconds);
    _latestReport = report;

    logger.info(
      {
        overallStatus: report.overallStatus,
        routes: `${report.checks.routes.passed}/${report.checks.routes.totalProbed}`,
        cloud: report.checks.assets.cloudConfigured ? report.checks.assets.cloudProvider : "noop",
        manifests: report.checks.manifests.totalSnapshots,
        deployments: report.checks.deployments.total,
      },
      "MONITOR: health check cycle complete"
    );

    // Persist E1 health report
    await Promise.all([saveToDisk(report), uploadToCloud(report)]);

    // E2 + E3 — recovery and repair (runs after health report is persisted)
    void runRecoveryAndRepair(report);
  } catch (err) {
    logger.error({ err }, "MONITOR: health check cycle threw unexpectedly");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Starts the monitoring loop. Safe to call multiple times — only starts once.
 *
 * @param port          The local port the API server is bound to.
 * @param intervalSec   How often to run health checks (default: 60s).
 */
export function startMonitoringLoop(
  port: number,
  intervalSec = DEFAULT_INTERVAL_SECONDS
): void {
  if (_runnerStarted) {
    logger.warn("MONITOR: startMonitoringLoop called more than once — ignoring");
    return;
  }

  _runnerStarted = true;
  _port = port;

  logger.info({ port, intervalSec }, "MONITOR: starting monitoring loop");

  // Run first check after a short warm-up delay so the server is fully ready
  const WARMUP_MS = 5000;
  setTimeout(() => {
    void runCycle(intervalSec);
    setInterval(() => void runCycle(intervalSec), intervalSec * 1000);
  }, WARMUP_MS);
}
