/**
 * job-supervisor.ts — Phase F1 Autonomous Job Supervisor
 *
 * Central orchestrator for monitoring every active Job Set and child job.
 *
 * Responsibilities:
 *   - Track every Job Set and child job
 *   - Monitor progress, health, and checkpoints
 *   - Detect stalled jobs, failed jobs, idle workers, resource starvation
 *   - Detect excessive retry loops and heartbeat loss
 *   - Detect abnormal termination and worker crashes
 *
 * Child job states tracked:
 *   Queued | Running | Paused | Completed | Retrying | Failed | Cancelled
 *
 * Generates:
 *   job-supervisor-report.json
 *   job-health-report.json
 *   worker-status-report.json
 *
 * Integrates directly above the Job Set scheduler (job-worker.ts).
 */

import { writeFile, readFile } from "fs/promises";
import { join } from "path";
import { logger } from "./logger.js";
import { listAllJobs, getQueueDepth } from "./db-queue.js";
import { workerStatus } from "./job-worker.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ChildJobStatus =
  | "Queued"
  | "Running"
  | "Paused"
  | "Completed"
  | "Retrying"
  | "Failed"
  | "Cancelled";

export type JobHealthStatus =
  | "healthy"
  | "stalled"
  | "slow"
  | "heartbeat_lost"
  | "crashed"
  | "excessive_retries"
  | "resource_starved"
  | "idle_worker"
  | "dead_letter";

export type SystemHealth = "healthy" | "degraded" | "critical";

export interface JobProgressSnapshot {
  completedArticles: number;
  totalArticles: number;
  progressPercent: number;
  snapshotAt: string;
}

export interface TrackedJob {
  jobId: string;
  seedUrl: string;
  rawStatus: string;
  childStatus: ChildJobStatus;
  healthStatus: JobHealthStatus;
  completedArticles: number;
  totalArticles: number;
  progressPercent: number;
  retryCount: number;
  maxRetries: number;
  workerId: string | null;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  stalledForMs: number;
  progressRatePerMinute: number;
  zeroProgressWindowMs: number;
  lastProgressAt: string | null;
  alerts: string[];
  errorMessage: string | null;
  diffMode: boolean;
}

export interface WorkerStatusEntry {
  workerId: string;
  inFlight: number;
  active: boolean;
  lastSeenAt: string;
  status: "active" | "idle" | "lost";
}

export interface QueueHealth {
  queued: number;
  running: number;
  failed: number;
  dead: number;
  done: number;
}

export interface SupervisorReport {
  generatedAt: string;
  supervisionCycleCount: number;
  lastCycleAt: string;
  totalTrackedJobs: number;
  totalActiveJobs: number;
  totalStalledJobs: number;
  totalFailedJobs: number;
  totalDeadLetterJobs: number;
  systemHealth: SystemHealth;
  queueHealth: QueueHealth;
  alerts: string[];
  jobs: TrackedJob[];
  workers: WorkerStatusEntry[];
}

export interface JobHealthReport {
  generatedAt: string;
  totalJobs: number;
  healthSummary: Record<JobHealthStatus, number>;
  unhealthyJobs: Array<{
    jobId: string;
    seedUrl: string;
    healthStatus: JobHealthStatus;
    childStatus: ChildJobStatus;
    alerts: string[];
    stalledForMs: number;
    retryCount: number;
  }>;
}

export interface WorkerStatusReport {
  generatedAt: string;
  totalWorkers: number;
  activeWorkers: number;
  idleWorkers: number;
  lostWorkers: number;
  totalInFlight: number;
  workers: WorkerStatusEntry[];
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

const SUPERVISION_INTERVAL_MS = 15_000;
const STALL_THRESHOLD_MS      = 5 * 60_000;   // 5 min of zero progress → stalled
const HEARTBEAT_LOSS_MS       = 10 * 60_000;  // 10 min since last update → heartbeat lost
const SLOW_THRESHOLD_MS       = 2 * 60_000;   // 2 min of zero progress → slow
const RESOURCE_STARVE_MS      = 3 * 60_000;   // 3 min queued jobs with no worker pickup
const MAX_RETRY_WARNING       = 2;            // retryCount >= this → excessive retries alert
const REPORT_DIR              = process.cwd();

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface ProgressHistory {
  completedArticles: number;
  recordedAt: number;
}

const _progressHistory = new Map<string, ProgressHistory>();
const _lastProgressAt  = new Map<string, number>();
let _cycleCount = 0;
let _lastCycleAt = new Date().toISOString();
let _supervisorRunning = false;
let _supervisorTimer: ReturnType<typeof setTimeout> | null = null;

// In-memory report cache for GET endpoints
let _latestSupervisorReport: SupervisorReport | null = null;
let _latestHealthReport: JobHealthReport | null = null;
let _latestWorkerReport: WorkerStatusReport | null = null;

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

function mapRawStatus(raw: string, retryCount: number, maxRetries: number): ChildJobStatus {
  switch (raw) {
    case "queued":      return retryCount > 0 ? "Retrying" : "Queued";
    case "running":     return "Running";
    case "done":        return "Completed";
    case "failed":      return retryCount >= maxRetries ? "Failed" : "Retrying";
    case "dead_letter": return "Failed";
    case "cancelled":   return "Cancelled";
    case "paused":      return "Paused";
    default:            return "Queued";
  }
}

// ---------------------------------------------------------------------------
// Health assessment
// ---------------------------------------------------------------------------

function assessJobHealth(
  rawStatus: string,
  retryCount: number,
  maxRetries: number,
  updatedAt: Date,
  completedArticles: number,
  totalArticles: number,
  jobId: string,
  claimedAt: Date | null
): { healthStatus: JobHealthStatus; stalledForMs: number; alerts: string[]; zeroProgressWindowMs: number } {
  const now = Date.now();
  const alerts: string[] = [];
  const msSinceUpdate = now - updatedAt.getTime();
  const prev = _progressHistory.get(jobId);

  let stalledForMs = 0;
  let zeroProgressWindowMs = 0;

  if (rawStatus === "dead_letter") {
    alerts.push(`Job reached dead-letter after ${retryCount} retries`);
    return { healthStatus: "dead_letter", stalledForMs, alerts, zeroProgressWindowMs };
  }

  if (rawStatus === "failed") {
    if (retryCount >= maxRetries) {
      alerts.push(`Job exhausted all ${maxRetries} retries`);
      return { healthStatus: "dead_letter", stalledForMs, alerts, zeroProgressWindowMs };
    }
    return { healthStatus: "healthy", stalledForMs, alerts, zeroProgressWindowMs };
  }

  if (rawStatus !== "running" && rawStatus !== "queued") {
    return { healthStatus: "healthy", stalledForMs, alerts, zeroProgressWindowMs };
  }

  // Excessive retries
  if (retryCount >= MAX_RETRY_WARNING) {
    alerts.push(`Excessive retries detected: ${retryCount}/${maxRetries}`);
    return { healthStatus: "excessive_retries", stalledForMs, alerts, zeroProgressWindowMs };
  }

  // Heartbeat loss check (no DB update for a long time)
  if (rawStatus === "running" && msSinceUpdate > HEARTBEAT_LOSS_MS) {
    stalledForMs = msSinceUpdate;
    alerts.push(`Heartbeat lost: no update for ${Math.round(msSinceUpdate / 60000)} min`);
    return { healthStatus: "heartbeat_lost", stalledForMs, alerts, zeroProgressWindowMs };
  }

  // Resource starvation: queued but never claimed
  if (rawStatus === "queued" && !claimedAt && msSinceUpdate > RESOURCE_STARVE_MS) {
    alerts.push(`Job queued but never claimed for ${Math.round(msSinceUpdate / 60000)} min`);
    return { healthStatus: "resource_starved", stalledForMs, alerts, zeroProgressWindowMs };
  }

  // Progress stall detection
  if (rawStatus === "running" && totalArticles > 0) {
    const lastProgressTs = _lastProgressAt.get(jobId);

    if (prev && prev.completedArticles === completedArticles && lastProgressTs) {
      zeroProgressWindowMs = now - lastProgressTs;

      if (zeroProgressWindowMs > STALL_THRESHOLD_MS) {
        stalledForMs = zeroProgressWindowMs;
        alerts.push(`Stalled: zero progress for ${Math.round(zeroProgressWindowMs / 60000)} min`);
        return { healthStatus: "stalled", stalledForMs, alerts, zeroProgressWindowMs };
      }

      if (zeroProgressWindowMs > SLOW_THRESHOLD_MS) {
        stalledForMs = zeroProgressWindowMs;
        alerts.push(`Slow: no progress for ${Math.round(zeroProgressWindowMs / 60000)} min`);
        return { healthStatus: "slow", stalledForMs, alerts, zeroProgressWindowMs };
      }
    }
  }

  return { healthStatus: "healthy", stalledForMs, alerts, zeroProgressWindowMs };
}

// ---------------------------------------------------------------------------
// Progress rate calculation
// ---------------------------------------------------------------------------

function calculateProgressRate(
  jobId: string,
  completedArticles: number
): number {
  const now = Date.now();
  const prev = _progressHistory.get(jobId);

  if (!prev) {
    _progressHistory.set(jobId, { completedArticles, recordedAt: now });
    return 0;
  }

  const deltaArticles = completedArticles - prev.completedArticles;
  const deltaMs = now - prev.recordedAt;

  if (deltaMs > 0 && deltaArticles > 0) {
    _lastProgressAt.set(jobId, now);
    _progressHistory.set(jobId, { completedArticles, recordedAt: now });
    return (deltaArticles / deltaMs) * 60_000;
  }

  if (!_lastProgressAt.has(jobId)) {
    _lastProgressAt.set(jobId, now);
  }

  _progressHistory.set(jobId, { completedArticles, recordedAt: now });
  return 0;
}

// ---------------------------------------------------------------------------
// Worker tracking
// ---------------------------------------------------------------------------

function buildWorkerEntry(): WorkerStatusEntry {
  const ws = workerStatus();
  const now = new Date().toISOString();

  return {
    workerId: ws.workerId,
    inFlight: ws.inFlight,
    active: ws.active,
    lastSeenAt: now,
    status: !ws.active ? "lost" : ws.inFlight === 0 ? "idle" : "active",
  };
}

// ---------------------------------------------------------------------------
// System health determination
// ---------------------------------------------------------------------------

function determineSystemHealth(
  stalledCount: number,
  heartbeatLostCount: number,
  deadLetterCount: number,
  totalRunning: number
): SystemHealth {
  if (heartbeatLostCount > 0 || (stalledCount > 1 && totalRunning > 0)) return "critical";
  if (stalledCount > 0 || deadLetterCount > 0) return "degraded";
  return "healthy";
}

// ---------------------------------------------------------------------------
// Report builders
// ---------------------------------------------------------------------------

function buildSupervisorReport(
  jobs: TrackedJob[],
  workers: WorkerStatusEntry[],
  queueHealth: QueueHealth
): SupervisorReport {
  const systemAlerts: string[] = [];
  const stalledJobs    = jobs.filter(j => j.healthStatus === "stalled" || j.healthStatus === "heartbeat_lost");
  const failedJobs     = jobs.filter(j => j.childStatus === "Failed");
  const deadLetterJobs = jobs.filter(j => j.healthStatus === "dead_letter");
  const activeJobs     = jobs.filter(j => j.childStatus === "Running" || j.childStatus === "Queued");

  if (stalledJobs.length > 0) {
    systemAlerts.push(`${stalledJobs.length} stalled job(s) detected`);
  }
  if (deadLetterJobs.length > 0) {
    systemAlerts.push(`${deadLetterJobs.length} dead-letter job(s) require manual intervention`);
  }
  if (queueHealth.queued > 0 && workers.every(w => w.inFlight === 0)) {
    systemAlerts.push(`${queueHealth.queued} queued job(s) with no active workers`);
  }

  return {
    generatedAt: new Date().toISOString(),
    supervisionCycleCount: _cycleCount,
    lastCycleAt: _lastCycleAt,
    totalTrackedJobs: jobs.length,
    totalActiveJobs: activeJobs.length,
    totalStalledJobs: stalledJobs.length,
    totalFailedJobs: failedJobs.length,
    totalDeadLetterJobs: deadLetterJobs.length,
    systemHealth: determineSystemHealth(
      stalledJobs.length,
      jobs.filter(j => j.healthStatus === "heartbeat_lost").length,
      deadLetterJobs.length,
      queueHealth.running
    ),
    queueHealth,
    alerts: systemAlerts,
    jobs,
    workers,
  };
}

function buildHealthReport(jobs: TrackedJob[]): JobHealthReport {
  const healthSummary = {} as Record<JobHealthStatus, number>;
  const unhealthyJobs: JobHealthReport["unhealthyJobs"] = [];

  for (const j of jobs) {
    healthSummary[j.healthStatus] = (healthSummary[j.healthStatus] ?? 0) + 1;

    if (j.healthStatus !== "healthy") {
      unhealthyJobs.push({
        jobId: j.jobId,
        seedUrl: j.seedUrl,
        healthStatus: j.healthStatus,
        childStatus: j.childStatus,
        alerts: j.alerts,
        stalledForMs: j.stalledForMs,
        retryCount: j.retryCount,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    totalJobs: jobs.length,
    healthSummary,
    unhealthyJobs,
  };
}

function buildWorkerReport(workers: WorkerStatusEntry[]): WorkerStatusReport {
  return {
    generatedAt: new Date().toISOString(),
    totalWorkers: workers.length,
    activeWorkers: workers.filter(w => w.status === "active").length,
    idleWorkers: workers.filter(w => w.status === "idle").length,
    lostWorkers: workers.filter(w => w.status === "lost").length,
    totalInFlight: workers.reduce((s, w) => s + w.inFlight, 0),
    workers,
  };
}

// ---------------------------------------------------------------------------
// Disk persistence
// ---------------------------------------------------------------------------

async function persistReports(
  supervisorReport: SupervisorReport,
  healthReport: JobHealthReport,
  workerReport: WorkerStatusReport
): Promise<void> {
  await Promise.all([
    writeFile(
      join(REPORT_DIR, "job-supervisor-report.json"),
      JSON.stringify(supervisorReport, null, 2),
      "utf8"
    ),
    writeFile(
      join(REPORT_DIR, "job-health-report.json"),
      JSON.stringify(healthReport, null, 2),
      "utf8"
    ),
    writeFile(
      join(REPORT_DIR, "worker-status-report.json"),
      JSON.stringify(workerReport, null, 2),
      "utf8"
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Core supervision cycle
// ---------------------------------------------------------------------------

async function runSupervisionCycle(): Promise<void> {
  _cycleCount++;
  _lastCycleAt = new Date().toISOString();

  try {
    const [rawJobs, queueDepth] = await Promise.all([
      listAllJobs(200),
      getQueueDepth(),
    ]);

    const workerEntry = buildWorkerEntry();
    const workers: WorkerStatusEntry[] = [workerEntry];

    const trackedJobs: TrackedJob[] = rawJobs.map((j) => {
      const childStatus = mapRawStatus(j.status, j.retryCount, j.maxRetries);
      const progressPercent = j.totalArticles > 0
        ? Math.round((j.completedArticles / j.totalArticles) * 100)
        : 0;
      const progressRate = calculateProgressRate(j.jobId, j.completedArticles);
      const lastProgressAt = _lastProgressAt.has(j.jobId)
        ? new Date(_lastProgressAt.get(j.jobId)!).toISOString()
        : null;

      const { healthStatus, stalledForMs, alerts, zeroProgressWindowMs } = assessJobHealth(
        j.status,
        j.retryCount,
        j.maxRetries,
        j.updatedAt,
        j.completedArticles,
        j.totalArticles,
        j.jobId,
        j.claimedAt ?? null
      );

      return {
        jobId: j.jobId,
        seedUrl: j.seedUrl,
        rawStatus: j.status,
        childStatus,
        healthStatus,
        completedArticles: j.completedArticles,
        totalArticles: j.totalArticles,
        progressPercent,
        retryCount: j.retryCount,
        maxRetries: j.maxRetries,
        workerId: j.claimedBy ?? null,
        createdAt: j.createdAt.toISOString(),
        updatedAt: j.updatedAt.toISOString(),
        claimedAt: j.claimedAt ? j.claimedAt.toISOString() : null,
        stalledForMs,
        progressRatePerMinute: Math.round(progressRate * 10) / 10,
        zeroProgressWindowMs,
        lastProgressAt,
        alerts,
        errorMessage: j.errorMessage ?? null,
        diffMode: j.diffMode ?? false,
      };
    });

    const queueHealth: QueueHealth = {
      queued: queueDepth.queued,
      running: queueDepth.running,
      failed: queueDepth.failed,
      dead: queueDepth.dead,
      done: queueDepth.done,
    };

    const supervisorReport = buildSupervisorReport(trackedJobs, workers, queueHealth);
    const healthReport      = buildHealthReport(trackedJobs);
    const workerReport      = buildWorkerReport(workers);

    _latestSupervisorReport = supervisorReport;
    _latestHealthReport     = healthReport;
    _latestWorkerReport     = workerReport;

    await persistReports(supervisorReport, healthReport, workerReport);

    const unhealthyCount = healthReport.unhealthyJobs.length;
    if (unhealthyCount > 0) {
      logger.warn(
        {
          cycle: _cycleCount,
          systemHealth: supervisorReport.systemHealth,
          unhealthyJobs: unhealthyCount,
          stalled: supervisorReport.totalStalledJobs,
          alerts: supervisorReport.alerts,
        },
        "SUPERVISOR: unhealthy jobs detected"
      );
    } else {
      logger.debug(
        {
          cycle: _cycleCount,
          tracked: trackedJobs.length,
          queueHealth,
        },
        "SUPERVISOR: cycle complete — all jobs healthy"
      );
    }
  } catch (err) {
    logger.error({ err, cycle: _cycleCount }, "SUPERVISOR: supervision cycle error");
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function scheduleNextCycle(): void {
  if (!_supervisorRunning) return;
  _supervisorTimer = setTimeout(async () => {
    await runSupervisionCycle();
    scheduleNextCycle();
  }, SUPERVISION_INTERVAL_MS);
}

/**
 * Start the Job Supervisor. Safe to call multiple times — only starts once.
 * Call this in startWorkerLoop() before the first job poll.
 */
export async function startJobSupervisor(): Promise<void> {
  if (_supervisorRunning) return;
  _supervisorRunning = true;

  logger.info(
    {
      intervalMs: SUPERVISION_INTERVAL_MS,
      stallThresholdMs: STALL_THRESHOLD_MS,
      heartbeatLossMs: HEARTBEAT_LOSS_MS,
    },
    "SUPERVISOR: job supervisor started"
  );

  // Run first cycle immediately to populate reports
  await runSupervisionCycle();
  scheduleNextCycle();
}

/**
 * Stop the supervisor loop.
 */
export function stopJobSupervisor(): void {
  _supervisorRunning = false;
  if (_supervisorTimer) {
    clearTimeout(_supervisorTimer);
    _supervisorTimer = null;
  }
  logger.info("SUPERVISOR: job supervisor stopped");
}

// ---------------------------------------------------------------------------
// Report accessors (for HTTP routes)
// ---------------------------------------------------------------------------

export function getSupervisorReport(): SupervisorReport | null {
  return _latestSupervisorReport;
}

export function getHealthReport(): JobHealthReport | null {
  return _latestHealthReport;
}

export function getWorkerReport(): WorkerStatusReport | null {
  return _latestWorkerReport;
}

/**
 * Force-run a supervision cycle immediately and return fresh reports.
 */
export async function forceCycle(): Promise<{
  supervisorReport: SupervisorReport;
  healthReport: JobHealthReport;
  workerReport: WorkerStatusReport;
}> {
  await runSupervisionCycle();
  return {
    supervisorReport: _latestSupervisorReport!,
    healthReport: _latestHealthReport!,
    workerReport: _latestWorkerReport!,
  };
}

/**
 * Load cached reports from disk at startup so HTTP endpoints work immediately.
 */
export async function loadPersistedReports(): Promise<void> {
  try {
    const [sv, hr, wr] = await Promise.all([
      readFile(join(REPORT_DIR, "job-supervisor-report.json"), "utf8").catch(() => null),
      readFile(join(REPORT_DIR, "job-health-report.json"), "utf8").catch(() => null),
      readFile(join(REPORT_DIR, "worker-status-report.json"), "utf8").catch(() => null),
    ]);
    if (sv) _latestSupervisorReport = JSON.parse(sv) as SupervisorReport;
    if (hr) _latestHealthReport      = JSON.parse(hr) as JobHealthReport;
    if (wr) _latestWorkerReport       = JSON.parse(wr) as WorkerStatusReport;
    logger.info("SUPERVISOR: loaded persisted reports from disk");
  } catch {
    // Not an error on first boot
  }
}
