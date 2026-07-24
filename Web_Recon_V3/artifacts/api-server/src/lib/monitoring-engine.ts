/**
 * monitoring-engine.ts — Phase E1 Monitoring Engine
 *
 * Continuously measures health across four dimensions:
 *   1. Routes     — HTTP probe all API endpoints for reachability and latency
 *   2. Assets     — Cloud storage (R2) connectivity and key verifiability
 *   3. Manifests  — DB snapshot health: counts, schema versions, staleness
 *   4. Deployments — Execution audit summary from in-memory store
 *
 * Pure functions — no I/O side effects except the DB reads and HTTP probes.
 * The runner (monitoring-runner.ts) calls runAllChecks() on a timer and
 * persists the resulting HealthReport.
 */

import http from "http";
import { db, manifestSnapshotsTable, scrapeJobsTable, generationReportsTable, constructionReportsTable } from "@workspace/db";
import { sql, desc } from "drizzle-orm";
import { getDefaultCloudProvider } from "../cloud";
import { generateAuditJson } from "./deployment-audit-store";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// HealthReport — the canonical output shape persisted as health-report.json
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "warn" | "fail";
export type OverallStatus = "healthy" | "degraded" | "critical";

export interface RouteProbe {
  path: string;
  method: string;
  statusCode: number | null;
  latencyMs: number;
  pass: boolean;
  error?: string;
}

export interface RoutesCheck {
  status: CheckStatus;
  totalProbed: number;
  passed: number;
  failed: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  probes: RouteProbe[];
}

export interface AssetProbe {
  key: string;
  exists: boolean;
  latencyMs: number;
  error?: string;
}

export interface AssetsCheck {
  status: CheckStatus;
  cloudProvider: string;
  cloudConfigured: boolean;
  sentinelWritten: boolean;
  keysVerified: number;
  keysMissing: number;
  probes: AssetProbe[];
}

export interface ManifestsCheck {
  status: CheckStatus;
  totalSnapshots: number;
  totalJobs: number;
  jobsByStatus: Record<string, number>;
  schemaVersions: string[];
  recentActivityWithin24h: boolean;
  staleSnapshotCount: number;
  generationReports: number;
  constructionReports: number;
}

export interface DeploymentsCheck {
  status: CheckStatus;
  total: number;
  success: number;
  failed: number;
  rolledBack: number;
  running: number;
  avgDurationMs: number | null;
  firstDeployedAt: string | null;
  lastDeployedAt: string | null;
}

export interface HealthReport {
  version: "1.0";
  generatedAt: string;
  overallStatus: OverallStatus;
  uptimeSeconds: number;
  intervalSeconds: number;
  checks: {
    routes: RoutesCheck;
    assets: AssetsCheck;
    manifests: ManifestsCheck;
    deployments: DeploymentsCheck;
  };
}

// ---------------------------------------------------------------------------
// Server start time — used for uptimeSeconds
// ---------------------------------------------------------------------------

const SERVER_START_MS = Date.now();

// ---------------------------------------------------------------------------
// 1. Routes check — probe all API endpoints
// ---------------------------------------------------------------------------

const ROUTE_PROBES: Array<{ method: string; path: string }> = [
  { method: "GET", path: "/api/healthz" },
  { method: "GET", path: "/api/scrape/jobs" },
  { method: "GET", path: "/api/deploy/frameworks" },
  { method: "GET", path: "/api/deploy/targets" },
  { method: "GET", path: "/api/deploy/audit" },
  { method: "GET", path: "/api/deploy/executions" },
  { method: "GET", path: "/api/monitor/health" },
  { method: "GET", path: "/api/monitor/pipeline" },
  { method: "GET", path: "/api/monitor/status" },
];

// Paths that may return 503 during warm-up but are still "reachable" (not broken)
const WARM_UP_TOLERANT_PATHS = new Set([
  "/api/monitor/health",
  "/api/monitor/pipeline",
  "/api/monitor/pipeline/repair",
]);

function httpProbe(
  port: number,
  method: string,
  path: string,
  timeoutMs = 5000
): Promise<RouteProbe> {
  return new Promise((resolve) => {
    const start = Date.now();

    const req = http.request(
      { hostname: "127.0.0.1", port, path, method },
      (res) => {
        res.resume();
        res.on("end", () => {
          const latencyMs = Date.now() - start;
          const code = res.statusCode ?? 0;
          // Warm-up tolerant routes: 503 means "not ready yet", not "broken"
          const pass = code < 500 || (WARM_UP_TOLERANT_PATHS.has(path) && code === 503);
          resolve({ path, method, statusCode: res.statusCode ?? null, latencyMs, pass });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({
        path,
        method,
        statusCode: null,
        latencyMs: timeoutMs,
        pass: false,
        error: "timeout",
      });
    });

    req.on("error", (err) => {
      resolve({
        path,
        method,
        statusCode: null,
        latencyMs: Date.now() - start,
        pass: false,
        error: err.message,
      });
    });

    req.end();
  });
}

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedMs.length) - 1;
  return sortedMs[Math.max(0, idx)]!;
}

export async function checkRoutes(port: number): Promise<RoutesCheck> {
  const probes = await Promise.all(
    ROUTE_PROBES.map((r) => httpProbe(port, r.method, r.path))
  );

  const passed = probes.filter((p) => p.pass).length;
  const failed = probes.length - passed;
  const latencies = probes.map((p) => p.latencyMs).sort((a, b) => a - b);
  const avgLatencyMs =
    latencies.length > 0
      ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)
      : 0;
  const p95LatencyMs = percentile(latencies, 95);

  let status: CheckStatus = "pass";
  if (failed > 0 || p95LatencyMs > 3000) status = "warn";
  if (failed >= Math.ceil(probes.length / 2) || p95LatencyMs > 8000) status = "fail";

  return { status, totalProbed: probes.length, passed, failed, avgLatencyMs, p95LatencyMs, probes };
}

// ---------------------------------------------------------------------------
// 2. Assets check — R2 cloud connectivity
// ---------------------------------------------------------------------------

const SENTINEL_KEY = "monitoring/sentinel.txt";
const SENTINEL_DATA = Buffer.from(`monitoring-sentinel-${Date.now()}`);

export async function checkAssets(): Promise<AssetsCheck> {
  const provider = getDefaultCloudProvider();
  const cloudConfigured = provider.isConfigured();

  if (!cloudConfigured) {
    return {
      status: "warn",
      cloudProvider: provider.providerName,
      cloudConfigured: false,
      sentinelWritten: false,
      keysVerified: 0,
      keysMissing: 0,
      probes: [],
    };
  }

  const probes: AssetProbe[] = [];

  // Write a sentinel key to confirm write access
  let sentinelWritten = false;
  {
    const start = Date.now();
    try {
      await provider.upload({
        key: SENTINEL_KEY,
        data: SENTINEL_DATA,
        contentType: "text/plain",
        checkDuplicate: false,
      });
      sentinelWritten = true;
      probes.push({ key: SENTINEL_KEY, exists: true, latencyMs: Date.now() - start });
    } catch (err) {
      probes.push({
        key: SENTINEL_KEY,
        exists: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Verify the sentinel key we just wrote
  {
    const start = Date.now();
    try {
      const exists = await provider.verify(SENTINEL_KEY);
      probes.push({ key: `${SENTINEL_KEY}:verify`, exists, latencyMs: Date.now() - start });
    } catch (err) {
      probes.push({
        key: `${SENTINEL_KEY}:verify`,
        exists: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Check for the health-report itself (non-fatal if missing on first run)
  {
    const start = Date.now();
    try {
      const exists = await provider.verify("monitoring/health-report.json");
      probes.push({ key: "monitoring/health-report.json", exists, latencyMs: Date.now() - start });
    } catch (err) {
      probes.push({
        key: "monitoring/health-report.json",
        exists: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const keysVerified = probes.filter((p) => p.exists).length;
  // health-report.json missing on first run is expected — exclude from missing count
  const keysMissing = probes.filter(
    (p) => !p.exists && p.key !== "monitoring/health-report.json"
  ).length;

  let status: CheckStatus = "pass";
  if (!sentinelWritten) status = "warn";
  if (!cloudConfigured || !sentinelWritten) status = "fail";

  return { status, cloudProvider: provider.providerName, cloudConfigured, sentinelWritten, keysVerified, keysMissing, probes };
}

// ---------------------------------------------------------------------------
// 3. Manifests check — DB snapshot health
// ---------------------------------------------------------------------------

export async function checkManifests(): Promise<ManifestsCheck> {
  try {
    // Total snapshot count
    const [snapCount] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(manifestSnapshotsTable);

    // Total jobs + status breakdown
    const jobRows = await db
      .select({
        status: scrapeJobsTable.status,
        count: sql<number>`cast(count(*) as int)`,
      })
      .from(scrapeJobsTable)
      .groupBy(scrapeJobsTable.status);

    const jobsByStatus: Record<string, number> = {};
    let totalJobs = 0;
    for (const row of jobRows) {
      jobsByStatus[row.status] = row.count;
      totalJobs += row.count;
    }

    // Schema versions in use
    const versionRows = await db
      .select({ v: manifestSnapshotsTable.schemaVersion })
      .from(manifestSnapshotsTable)
      .groupBy(manifestSnapshotsTable.schemaVersion);
    const schemaVersions = versionRows.map((r) => String(r.v ?? "unknown"));

    // Most recent snapshot — check for activity within 24h
    const [recent] = await db
      .select({ updatedAt: manifestSnapshotsTable.updatedAt })
      .from(manifestSnapshotsTable)
      .orderBy(desc(manifestSnapshotsTable.updatedAt))
      .limit(1);
    const recentActivityWithin24h = recent
      ? Date.now() - new Date(recent.updatedAt!).getTime() < 24 * 60 * 60 * 1000
      : false;

    // Stale snapshots — not updated in 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [staleRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(manifestSnapshotsTable)
      .where(sql`${manifestSnapshotsTable.updatedAt} < ${sevenDaysAgo}`);

    // Generation + construction report counts
    const [genRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(generationReportsTable);
    const [conRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(constructionReportsTable);

    const totalSnapshots = snapCount?.count ?? 0;
    const staleSnapshotCount = staleRow?.count ?? 0;

    let status: CheckStatus = "pass";
    if (staleSnapshotCount > 0) status = "warn";
    if (totalSnapshots === 0 && totalJobs > 0) status = "warn";

    return {
      status,
      totalSnapshots,
      totalJobs,
      jobsByStatus,
      schemaVersions,
      recentActivityWithin24h,
      staleSnapshotCount,
      generationReports: genRow?.count ?? 0,
      constructionReports: conRow?.count ?? 0,
    };
  } catch (err) {
    logger.error({ err }, "MONITOR: manifests check failed");
    return {
      status: "fail",
      totalSnapshots: 0,
      totalJobs: 0,
      jobsByStatus: {},
      schemaVersions: [],
      recentActivityWithin24h: false,
      staleSnapshotCount: 0,
      generationReports: 0,
      constructionReports: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// 4. Deployments check — in-memory audit store
// ---------------------------------------------------------------------------

export function checkDeployments(): DeploymentsCheck {
  try {
    const audit = generateAuditJson();
    const s = audit.summary;

    let status: CheckStatus = "pass";
    if (s.failed > 0 && s.success === 0) status = "warn";
    if (s.running > 2) status = "warn";
    if (s.failed > s.success && s.total > 0) status = "fail";

    return {
      status,
      total: s.total,
      success: s.success,
      failed: s.failed,
      rolledBack: s.rolledBack,
      running: s.running,
      avgDurationMs: s.avgDurationMs,
      firstDeployedAt: s.firstDeployedAt,
      lastDeployedAt: s.lastDeployedAt,
    };
  } catch (err) {
    logger.error({ err }, "MONITOR: deployments check failed");
    return {
      status: "fail",
      total: 0,
      success: 0,
      failed: 0,
      rolledBack: 0,
      running: 0,
      avgDurationMs: null,
      firstDeployedAt: null,
      lastDeployedAt: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Overall status roll-up
// ---------------------------------------------------------------------------

function rollUpStatus(checks: HealthReport["checks"]): OverallStatus {
  const statuses = [
    checks.routes.status,
    checks.assets.status,
    checks.manifests.status,
    checks.deployments.status,
  ];
  if (statuses.some((s) => s === "fail")) return "critical";
  if (statuses.some((s) => s === "warn")) return "degraded";
  return "healthy";
}

// ---------------------------------------------------------------------------
// runAllChecks — main entry point
// ---------------------------------------------------------------------------

export async function runAllChecks(
  port: number,
  intervalSeconds: number
): Promise<HealthReport> {
  logger.debug({ port }, "MONITOR: running all health checks");

  const [routes, assets, manifests] = await Promise.all([
    checkRoutes(port),
    checkAssets(),
    checkManifests(),
  ]);

  const deployments = checkDeployments();

  const checks = { routes, assets, manifests, deployments };

  return {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    overallStatus: rollUpStatus(checks),
    uptimeSeconds: Math.round((Date.now() - SERVER_START_MS) / 1000),
    intervalSeconds,
    checks,
  };
}
