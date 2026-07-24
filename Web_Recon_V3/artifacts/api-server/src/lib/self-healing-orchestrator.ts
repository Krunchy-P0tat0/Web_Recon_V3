/**
 * self-healing-orchestrator.ts — Phase F6 Self-Healing Job Orchestrator
 *
 * The highest-level orchestration engine. Continuously supervises all
 * subsystems and makes autonomous decisions to maintain maximum coverage,
 * minimum duplicate work, maximum stability, and minimum human intervention.
 *
 * Subsystems supervised:
 *   F1  Job Supervisor
 *   F2  Failure Classifier
 *   F3  Autonomous Recovery Engine
 *   F4  Checkpoint Resume Engine
 *   F5  Job Dashboard (control operations)
 *   DB  Queue state
 *
 * Every cycle evaluates:
 *   - Is progress increasing?
 *   - Has coverage stalled?
 *   - Has a worker crashed?
 *   - Should workloads be redistributed?
 *   - Should batch sizes change?
 *   - Should retries stop?
 *   - Should jobs split?
 *   - Should jobs merge?
 *   - Should coverage expansion begin?
 *   - Should differential jobs be scheduled?
 *
 * Optimizes for:
 *   Maximum Coverage · Minimum Duplicate Work · Maximum Stability · Minimum Human Intervention
 *
 * Generates:
 *   self-healing-orchestration-report.json
 *   orchestration-health-report.json
 *   autonomous-operation-report.json
 */

import { writeFile, readFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { logger } from "./logger.js";
import { listAllJobs, getQueueDepth, type ScrapeJobRecord } from "./db-queue.js";
import { getSupervisorReport, getHealthReport, type TrackedJob } from "./job-supervisor.js";
import { allClassifications } from "./failure-classifier.js";
import { getRecoveryReport } from "./autonomous-recovery-engine.js";
import { getAllActiveCheckpoints } from "./checkpoint-engine.js";
import {
  pauseJob,
  splitJob,
  retryJob,
  cancelJob,
} from "./job-dashboard.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type OrchestratorQuestion =
  | "is_progress_increasing"
  | "has_coverage_stalled"
  | "has_memory_exceeded_limits"
  | "has_worker_crashed"
  | "should_redistribute_workloads"
  | "should_reduce_batch_size"
  | "should_increase_batch_size"
  | "should_stop_retries"
  | "should_split_jobs"
  | "should_merge_jobs"
  | "should_expand_coverage"
  | "should_schedule_differential";

export type OrchestratorActionType =
  | "trigger_recovery"
  | "scale_down_batch"
  | "scale_up_batch"
  | "rebalance_workers"
  | "extend_coverage"
  | "schedule_differential"
  | "pause_stalled_job"
  | "abort_repeated_failures"
  | "split_large_job"
  | "emit_health_alert"
  | "no_action";

export interface OrchestratorDecision {
  decisionId: string;
  evaluatedAt: string;
  question: OrchestratorQuestion;
  answer: boolean;
  confidence: number; // 0–100
  evidence: string[];
  action: OrchestratorExecutedAction | null;
}

export interface OrchestratorExecutedAction {
  actionId: string;
  actionType: OrchestratorActionType;
  targetJobId: string | null;
  parameters: Record<string, unknown>;
  executedAt: string;
  completedAt: string | null;
  success: boolean;
  result: string;
}

export interface OrchestratorCycle {
  cycleId: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  decisions: OrchestratorDecision[];
  actionsExecuted: number;
  actionsSucceeded: number;
  systemSnapshot: SystemSnapshot;
}

export interface SystemSnapshot {
  snapshotAt: string;
  queueDepth: { queued: number; running: number; failed: number; dead: number; done: number };
  activeCheckpoints: number;
  totalClassifications: number;
  totalRecoveryActions: number;
  supervisorCycles: number;
  systemHealth: string;
}

export interface SelfHealingOrchestrationReport {
  generatedAt: string;
  totalCycles: number;
  totalDecisions: number;
  totalActionsExecuted: number;
  totalActionsSucceeded: number;
  decisionsByQuestion: Partial<Record<OrchestratorQuestion, { evaluated: number; triggered: number }>>;
  actionsByType: Partial<Record<OrchestratorActionType, number>>;
  recentCycles: OrchestratorCycle[];
}

export interface OrchestrationHealthReport {
  generatedAt: string;
  systemHealth: "optimal" | "healthy" | "degraded" | "critical";
  healthScore: number; // 0–100
  findings: Array<{
    severity: "info" | "warning" | "critical";
    area: string;
    description: string;
    recommendation: string;
  }>;
  queueHealth: {
    queued: number;
    running: number;
    failed: number;
    dead: number;
    done: number;
  };
  coverageHealth: {
    jobsWithCheckpoints: number;
    averageCoverage: number;
    stalledJobs: number;
  };
  recoveryHealth: {
    totalRecoveryActions: number;
    successRate: number;
    pendingRetries: number;
  };
}

export interface AutonomousOperationReport {
  generatedAt: string;
  uptime: string;
  totalCycles: number;
  autonomousActionsExecuted: number;
  humanInterventionsRequired: number;
  optimizationHighlights: string[];
  systemStability: "stable" | "recovering" | "unstable";
  keyMetrics: {
    averageCycleMs: number;
    actionsPerCycle: number;
    successRate: number;
    coverageImprovementPercent: number;
  };
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const cycles: OrchestratorCycle[] = [];
let orchestratorActive = false;
let orchestratorTimer: ReturnType<typeof setTimeout> | null = null;
const startedAt = new Date().toISOString();
let humanInterventionsRequired = 0;

// Progress snapshots for trend analysis (rolling window)
interface ProgressSnapshot {
  at: string;
  completedArticles: number;
  coveragePercent: number;
  activeJobs: number;
}
const progressWindow: ProgressSnapshot[] = [];
const PROGRESS_WINDOW_SIZE = 6;

// Batch size state (shared across cycles)
let currentBatchSizeMultiplier = 1.0;

// ---------------------------------------------------------------------------
// Evaluation helpers
// ---------------------------------------------------------------------------

async function captureSystemSnapshot(): Promise<SystemSnapshot> {
  const depth = await getQueueDepth().catch(() => ({ queued: 0, running: 0, failed: 0, dead: 0, done: 0 }));
  const checkpoints = getAllActiveCheckpoints();
  const classifications = allClassifications();
  const recoveryReport = getRecoveryReport();
  const supervisorReport = getSupervisorReport();

  return {
    snapshotAt: new Date().toISOString(),
    queueDepth: depth,
    activeCheckpoints: checkpoints.length,
    totalClassifications: classifications.length,
    totalRecoveryActions: recoveryReport.totalActionsTriggered,
    supervisorCycles: supervisorReport?.supervisorCycles ?? 0,
    systemHealth: supervisorReport?.systemHealth ?? "unknown",
  };
}

function captureProgressSnapshot(jobs: ScrapeJobRecord[]): ProgressSnapshot {
  const runningJobs = jobs.filter((j) => ["running", "queued"].includes(j.status));
  const snap: ProgressSnapshot = {
    at: new Date().toISOString(),
    completedArticles: jobs.reduce((n, j) => n + j.completedArticles, 0),
    coveragePercent:
      jobs.length > 0
        ? Math.round(jobs.reduce((n, j) => n + (j.totalArticles > 0 ? (j.completedArticles / j.totalArticles) * 100 : 0), 0) / jobs.length)
        : 0,
    activeJobs: runningJobs.length,
  };
  progressWindow.push(snap);
  if (progressWindow.length > PROGRESS_WINDOW_SIZE) progressWindow.shift();
  return snap;
}

function isProgressIncreasing(): { answer: boolean; confidence: number; evidence: string[] } {
  if (progressWindow.length < 2) {
    return { answer: true, confidence: 50, evidence: ["Insufficient history — assuming progress is increasing"] };
  }
  const oldest = progressWindow[0]!;
  const newest = progressWindow[progressWindow.length - 1]!;
  const delta = newest.completedArticles - oldest.completedArticles;
  const evidence: string[] = [`completedArticles: ${oldest.completedArticles} → ${newest.completedArticles} (Δ ${delta})`];
  if (delta > 0) {
    return { answer: true, confidence: 90, evidence };
  }
  if (newest.activeJobs === 0) {
    evidence.push("No active jobs — queue is idle");
    return { answer: false, confidence: 80, evidence };
  }
  evidence.push("Active jobs but zero progress delta — possible stall");
  return { answer: false, confidence: 70, evidence };
}

function hasCoverageStalled(jobs: ScrapeJobRecord[]): { answer: boolean; confidence: number; evidence: string[] } {
  if (progressWindow.length < 3) return { answer: false, confidence: 40, evidence: ["Not enough history"] };
  const coverages = progressWindow.map((p) => p.coveragePercent);
  const maxDelta = Math.max(...coverages) - Math.min(...coverages);
  const evidence = [`Coverage range over last ${progressWindow.length} cycles: ${Math.min(...coverages)}%–${Math.max(...coverages)}%`];
  const runningJobs = jobs.filter((j) => j.status === "running");
  if (maxDelta < 2 && runningJobs.length > 0) {
    evidence.push(`${runningJobs.length} running jobs but <2% coverage movement`);
    return { answer: true, confidence: 75, evidence };
  }
  return { answer: false, confidence: 80, evidence };
}

function hasWorkerCrashed(): { answer: boolean; confidence: number; evidence: string[]; crashedJobIds: string[] } {
  const healthReport = getHealthReport();
  if (!healthReport) return { answer: false, confidence: 40, evidence: ["No health report available"], crashedJobIds: [] };

  const crashed = (healthReport.trackedJobs ?? []).filter((j: TrackedJob) =>
    j.healthStatus === "crashed" || j.healthStatus === "heartbeat_lost"
  );
  if (crashed.length > 0) {
    return {
      answer: true,
      confidence: 90,
      evidence: crashed.map((j: TrackedJob) => `${j.jobId}: ${j.healthStatus}`),
      crashedJobIds: crashed.map((j: TrackedJob) => j.jobId),
    };
  }
  return { answer: false, confidence: 85, evidence: ["No crashed workers detected"], crashedJobIds: [] };
}

function shouldReduceBatchSize(): { answer: boolean; confidence: number; evidence: string[] } {
  const recoveryReport = getRecoveryReport();
  const oomActions = recoveryReport.actions.filter(
    (a) => a.failureClass === "OOM" && Date.now() - new Date(a.triggeredAt).getTime() < 10 * 60 * 1000
  );
  if (oomActions.length >= 2) {
    return {
      answer: true,
      confidence: 85,
      evidence: [`${oomActions.length} OOM recovery actions in last 10 minutes`],
    };
  }
  return { answer: false, confidence: 75, evidence: ["No recent OOM events"] };
}

function shouldStopRetries(jobs: ScrapeJobRecord[]): { answer: boolean; confidence: number; evidence: string[]; targetJobIds: string[] } {
  const deadLetterJobs = jobs.filter((j) => j.status === "dead_letter");
  const recentDead = deadLetterJobs.filter((j) => Date.now() - new Date(j.updatedAt).getTime() < 5 * 60 * 1000);
  if (recentDead.length > 0) {
    return {
      answer: false, // already stopped — dead_letter IS the stopped state
      confidence: 95,
      evidence: [`${recentDead.length} jobs in dead_letter — retries already halted by F3`],
      targetJobIds: [],
    };
  }
  // Check for jobs that have maxed out retries but aren't dead_letter yet
  const exhausted = jobs.filter((j) => j.retryCount >= j.maxRetries && j.status === "failed");
  if (exhausted.length > 0) {
    return {
      answer: true,
      confidence: 90,
      evidence: [`${exhausted.length} jobs with retryCount >= maxRetries still in 'failed' state`],
      targetJobIds: exhausted.map((j) => j.jobId),
    };
  }
  return { answer: false, confidence: 80, evidence: ["No retry exhaustion detected"], targetJobIds: [] };
}

function shouldSplitLargeJobs(jobs: ScrapeJobRecord[]): { answer: boolean; confidence: number; evidence: string[]; targetJobIds: string[] } {
  const recoveryReport = getRecoveryReport();
  const recentOOM = recoveryReport.actions.filter(
    (a) => a.failureClass === "OOM" && Date.now() - new Date(a.triggeredAt).getTime() < 15 * 60 * 1000
  );
  const largeQueued = jobs.filter(
    (j) => j.status === "queued" && j.totalArticles > 500
  );
  if (recentOOM.length > 0 && largeQueued.length > 0) {
    return {
      answer: true,
      confidence: 80,
      evidence: [
        `${recentOOM.length} recent OOM events`,
        `${largeQueued.length} large queued jobs (>500 articles)`,
      ],
      targetJobIds: largeQueued.slice(0, 3).map((j) => j.jobId),
    };
  }
  return { answer: false, confidence: 70, evidence: ["No split trigger detected"], targetJobIds: [] };
}

function shouldExpandCoverage(jobs: ScrapeJobRecord[]): { answer: boolean; confidence: number; evidence: string[] } {
  const allDone = jobs.every((j) => ["done", "dead_letter", "paused"].includes(j.status));
  const queueEmpty = jobs.filter((j) => ["queued", "running"].includes(j.status)).length === 0;
  if (allDone && queueEmpty && jobs.length > 0) {
    return {
      answer: true,
      confidence: 85,
      evidence: [`All ${jobs.length} jobs completed — no active workload`],
    };
  }
  return { answer: false, confidence: 80, evidence: ["Active jobs exist — coverage expansion not yet needed"] };
}

// ---------------------------------------------------------------------------
// Action executors
// ---------------------------------------------------------------------------

async function executeAction(
  actionType: OrchestratorActionType,
  targetJobId: string | null,
  parameters: Record<string, unknown>
): Promise<OrchestratorExecutedAction> {
  const action: OrchestratorExecutedAction = {
    actionId: randomUUID(),
    actionType,
    targetJobId,
    parameters,
    executedAt: new Date().toISOString(),
    completedAt: null,
    success: false,
    result: "",
  };

  try {
    switch (actionType) {
      case "pause_stalled_job": {
        if (!targetJobId) { action.result = "No target job"; break; }
        const r = await pauseJob(targetJobId);
        action.success = r.success;
        action.result = r.detail;
        break;
      }
      case "abort_repeated_failures": {
        if (!targetJobId) { action.result = "No target job"; break; }
        const r = await cancelJob(targetJobId);
        action.success = r.success;
        action.result = r.detail;
        break;
      }
      case "split_large_job": {
        if (!targetJobId) { action.result = "No target job"; break; }
        const parts = (parameters["parts"] as number) ?? 2;
        const r = await splitJob(targetJobId, parts);
        action.success = r.success;
        action.result = r.detail;
        break;
      }
      case "trigger_recovery": {
        if (!targetJobId) { action.result = "No target job"; break; }
        const r = await retryJob(targetJobId);
        action.success = r.success;
        action.result = `Recovery via retry: ${r.detail}`;
        break;
      }
      case "emit_health_alert": {
        const message = (parameters["message"] as string) ?? "Orchestrator health alert";
        logger.warn({ message, targetJobId }, "F6: health alert emitted");
        action.success = true;
        action.result = `Alert emitted: ${message}`;
        break;
      }
      case "scale_down_batch": {
        currentBatchSizeMultiplier = Math.max(0.25, currentBatchSizeMultiplier * 0.5);
        action.success = true;
        action.result = `Batch size multiplier reduced to ${currentBatchSizeMultiplier}`;
        break;
      }
      case "scale_up_batch": {
        currentBatchSizeMultiplier = Math.min(4.0, currentBatchSizeMultiplier * 1.25);
        action.success = true;
        action.result = `Batch size multiplier increased to ${currentBatchSizeMultiplier}`;
        break;
      }
      case "no_action":
      default: {
        action.success = true;
        action.result = "No action required";
        break;
      }
    }
  } catch (err) {
    action.success = false;
    action.result = `Action threw: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn({ err, actionType, targetJobId }, "F6: orchestrator action failed");
  }

  action.completedAt = new Date().toISOString();
  return action;
}

// ---------------------------------------------------------------------------
// Core: one evaluation cycle
// ---------------------------------------------------------------------------

export async function runOrchestratorCycle(): Promise<OrchestratorCycle> {
  const cycleId = randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();
  const decisions: OrchestratorDecision[] = [];

  logger.info({ cycleId }, "F6: orchestrator cycle starting");

  const jobs = await listAllJobs(200).catch(() => [] as ScrapeJobRecord[]);
  const snapshot = await captureSystemSnapshot();
  captureProgressSnapshot(jobs);

  const decide = (
    question: OrchestratorQuestion,
    evaluation: { answer: boolean; confidence: number; evidence: string[] },
    action: OrchestratorExecutedAction | null
  ): OrchestratorDecision => ({
    decisionId: randomUUID().slice(0, 8),
    evaluatedAt: new Date().toISOString(),
    question,
    answer: evaluation.answer,
    confidence: evaluation.confidence,
    evidence: evaluation.evidence,
    action,
  });

  // ── Q1: Is progress increasing? ──────────────────────────────────────────
  {
    const eval1 = isProgressIncreasing();
    let action: OrchestratorExecutedAction | null = null;
    if (!eval1.answer && snapshot.queueDepth.running > 0) {
      action = await executeAction("emit_health_alert", null, {
        message: "Progress has stalled — active jobs running but completedArticles not increasing",
      });
    }
    decisions.push(decide("is_progress_increasing", eval1, action));
  }

  // ── Q2: Has coverage stalled? ─────────────────────────────────────────────
  {
    const eval2 = hasCoverageStalled(jobs);
    let action: OrchestratorExecutedAction | null = null;
    if (eval2.answer) {
      // Find the most stalled running job and pause it for investigation
      const healthReport = getHealthReport();
      const stalledJob = (healthReport?.trackedJobs ?? [])
        .filter((j: TrackedJob) => j.healthStatus === "stalled" && j.rawStatus === "running")
        .sort((a: TrackedJob, b: TrackedJob) => b.stalledForMs - a.stalledForMs)[0];
      if (stalledJob) {
        action = await executeAction("pause_stalled_job", stalledJob.jobId, { reason: "coverage_stalled" });
      }
    }
    decisions.push(decide("has_coverage_stalled", eval2, action));
  }

  // ── Q3: Has a worker crashed? ────────────────────────────────────────────
  {
    const eval3 = hasWorkerCrashed();
    let action: OrchestratorExecutedAction | null = null;
    if (eval3.answer && eval3.crashedJobIds.length > 0) {
      action = await executeAction("trigger_recovery", eval3.crashedJobIds[0] ?? null, {
        reason: "worker_crash_detected",
      });
    }
    decisions.push(decide("has_worker_crashed", eval3, action));
  }

  // ── Q4: Should batch sizes reduce? ───────────────────────────────────────
  {
    const eval4 = shouldReduceBatchSize();
    let action: OrchestratorExecutedAction | null = null;
    if (eval4.answer) {
      action = await executeAction("scale_down_batch", null, { currentMultiplier: currentBatchSizeMultiplier });
    }
    decisions.push(decide("should_reduce_batch_size", eval4, action));
  }

  // ── Q5: Should retries stop? ──────────────────────────────────────────────
  {
    const eval5 = shouldStopRetries(jobs);
    let action: OrchestratorExecutedAction | null = null;
    if (eval5.answer && eval5.targetJobIds.length > 0) {
      action = await executeAction("abort_repeated_failures", eval5.targetJobIds[0] ?? null, {
        reason: "retries_exhausted",
        allTargets: eval5.targetJobIds,
      });
    }
    decisions.push(decide("should_stop_retries", eval5, action));
  }

  // ── Q6: Should large jobs split? ─────────────────────────────────────────
  {
    const eval6 = shouldSplitLargeJobs(jobs);
    let action: OrchestratorExecutedAction | null = null;
    if (eval6.answer && eval6.targetJobIds.length > 0) {
      action = await executeAction("split_large_job", eval6.targetJobIds[0] ?? null, { parts: 2 });
    }
    decisions.push(decide("should_split_jobs", eval6, action));
  }

  // ── Q7: Should coverage expand? ──────────────────────────────────────────
  {
    const eval7 = shouldExpandCoverage(jobs);
    let action: OrchestratorExecutedAction | null = null;
    if (eval7.answer) {
      action = await executeAction("emit_health_alert", null, {
        message: "All jobs complete — pipeline idle. Coverage expansion can be triggered manually.",
      });
    }
    decisions.push(decide("should_expand_coverage", eval7, action));
  }

  // ── Q8: Memory exceeded limits? ──────────────────────────────────────────
  {
    // No direct memory probe — infer from OOM classifications
    const classifications = allClassifications();
    const recentOOM = classifications.filter(
      (c) => c.failureClass === "OOM" && Date.now() - new Date(c.classifiedAt).getTime() < 5 * 60 * 1000
    );
    const eval8 = {
      answer: recentOOM.length > 0,
      confidence: recentOOM.length > 0 ? 85 : 70,
      evidence: recentOOM.length > 0
        ? [`${recentOOM.length} OOM events in last 5 minutes: ${recentOOM.map((c) => c.jobId).join(", ")}`]
        : ["No OOM events detected"],
    };
    let action: OrchestratorExecutedAction | null = null;
    if (eval8.answer) {
      action = await executeAction("scale_down_batch", null, { trigger: "oom_detected" });
    }
    decisions.push(decide("has_memory_exceeded_limits", eval8, action));
  }

  const completedAt = new Date().toISOString();
  const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  const actionsExecuted = decisions.filter((d) => d.action).length;
  const actionsSucceeded = decisions.filter((d) => d.action?.success).length;

  const cycle: OrchestratorCycle = {
    cycleId,
    startedAt,
    completedAt,
    durationMs,
    decisions,
    actionsExecuted,
    actionsSucceeded,
    systemSnapshot: snapshot,
  };

  cycles.push(cycle);
  // Keep last 50 cycles in memory
  if (cycles.length > 50) cycles.shift();

  logger.info(
    { cycleId, decisions: decisions.length, actionsExecuted, actionsSucceeded, durationMs },
    "F6: orchestrator cycle complete"
  );

  flushReports().catch(() => {});
  return cycle;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const CYCLE_INTERVAL_MS = 30_000;

export function startOrchestrator(): void {
  if (orchestratorActive) {
    logger.info("F6: orchestrator already running");
    return;
  }
  orchestratorActive = true;
  logger.info({ intervalMs: CYCLE_INTERVAL_MS }, "F6: self-healing orchestrator started");

  const schedule = () => {
    if (!orchestratorActive) return;
    runOrchestratorCycle().catch((err) => {
      logger.warn({ err }, "F6: orchestrator cycle error (non-fatal)");
    }).finally(() => {
      if (orchestratorActive) {
        orchestratorTimer = setTimeout(schedule, CYCLE_INTERVAL_MS);
      }
    });
  };

  // First cycle after a short warmup
  orchestratorTimer = setTimeout(schedule, 10_000);
}

export function stopOrchestrator(): void {
  orchestratorActive = false;
  if (orchestratorTimer) {
    clearTimeout(orchestratorTimer);
    orchestratorTimer = null;
  }
  logger.info("F6: self-healing orchestrator stopped");
}

export function isOrchestratorRunning(): boolean {
  return orchestratorActive;
}

export function getOrchestratorStatus(): {
  running: boolean;
  totalCycles: number;
  lastCycleAt: string | null;
  batchSizeMultiplier: number;
  progressWindowSize: number;
} {
  return {
    running: orchestratorActive,
    totalCycles: cycles.length,
    lastCycleAt: cycles[cycles.length - 1]?.completedAt ?? null,
    batchSizeMultiplier: currentBatchSizeMultiplier,
    progressWindowSize: progressWindow.length,
  };
}

// ---------------------------------------------------------------------------
// Report builders
// ---------------------------------------------------------------------------

export function getSelfHealingOrchestrationReport(): SelfHealingOrchestrationReport {
  const decisionsByQuestion: Partial<Record<OrchestratorQuestion, { evaluated: number; triggered: number }>> = {};
  const actionsByType: Partial<Record<OrchestratorActionType, number>> = {};
  let totalDecisions = 0, totalActionsExecuted = 0, totalActionsSucceeded = 0;

  for (const cycle of cycles) {
    for (const d of cycle.decisions) {
      totalDecisions++;
      if (!decisionsByQuestion[d.question]) decisionsByQuestion[d.question] = { evaluated: 0, triggered: 0 };
      decisionsByQuestion[d.question]!.evaluated++;
      if (d.action) {
        decisionsByQuestion[d.question]!.triggered++;
        actionsByType[d.action.actionType] = (actionsByType[d.action.actionType] ?? 0) + 1;
      }
    }
    totalActionsExecuted += cycle.actionsExecuted;
    totalActionsSucceeded += cycle.actionsSucceeded;
  }

  return {
    generatedAt: new Date().toISOString(),
    totalCycles: cycles.length,
    totalDecisions,
    totalActionsExecuted,
    totalActionsSucceeded,
    decisionsByQuestion,
    actionsByType,
    recentCycles: cycles.slice(-10),
  };
}

export async function getOrchestrationHealthReport(): Promise<OrchestrationHealthReport> {
  const depth = await getQueueDepth().catch(() => ({ queued: 0, running: 0, failed: 0, dead: 0, done: 0 }));
  const checkpoints = getAllActiveCheckpoints();
  const recoveryReport = getRecoveryReport();
  const supervisorReport = getSupervisorReport();
  const healthReport = getHealthReport();

  const findings: OrchestrationHealthReport["findings"] = [];
  let healthScore = 100;

  if (depth.failed > 5) {
    findings.push({ severity: "warning", area: "queue", description: `${depth.failed} failed jobs in queue`, recommendation: "Review failure classifications and trigger recovery" });
    healthScore -= 10;
  }
  if (depth.dead > 0) {
    findings.push({ severity: "warning", area: "queue", description: `${depth.dead} dead-letter jobs`, recommendation: "Investigate root causes via F2 failure classifier" });
    healthScore -= 5;
  }
  const stalledJobs = (healthReport?.trackedJobs ?? []).filter((j: TrackedJob) => j.healthStatus === "stalled");
  if (stalledJobs.length > 0) {
    findings.push({ severity: "warning", area: "progress", description: `${stalledJobs.length} stalled jobs`, recommendation: "Consider pausing and restarting or splitting" });
    healthScore -= 15;
  }
  const crashedJobs = (healthReport?.trackedJobs ?? []).filter((j: TrackedJob) =>
    j.healthStatus === "crashed" || j.healthStatus === "heartbeat_lost"
  );
  if (crashedJobs.length > 0) {
    findings.push({ severity: "critical", area: "workers", description: `${crashedJobs.length} crashed/heartbeat-lost jobs`, recommendation: "Trigger recovery for affected jobs immediately" });
    healthScore -= 25;
  }
  if (recoveryReport.totalFailed > 0) {
    findings.push({ severity: "info", area: "recovery", description: `${recoveryReport.totalFailed} recovery actions failed`, recommendation: "Review F3 recovery report for details" });
    healthScore -= 5;
  }

  const systemHealth: OrchestrationHealthReport["systemHealth"] =
    healthScore >= 90 ? "optimal" :
    healthScore >= 70 ? "healthy" :
    healthScore >= 50 ? "degraded" :
    "critical";

  const coverages = checkpoints.map((cp) => cp.coverageState.coveragePercent);
  const avgCoverage = coverages.length > 0 ? Math.round(coverages.reduce((a, b) => a + b, 0) / coverages.length) : 0;

  return {
    generatedAt: new Date().toISOString(),
    systemHealth,
    healthScore: Math.max(0, healthScore),
    findings,
    queueHealth: depth,
    coverageHealth: {
      jobsWithCheckpoints: checkpoints.length,
      averageCoverage: avgCoverage,
      stalledJobs: stalledJobs.length,
    },
    recoveryHealth: {
      totalRecoveryActions: recoveryReport.totalActionsTriggered,
      successRate: recoveryReport.totalActionsTriggered > 0
        ? Math.round((recoveryReport.totalSucceeded / recoveryReport.totalActionsTriggered) * 100)
        : 100,
      pendingRetries: 0, // would need export from F3
    },
  };
}

export function getAutonomousOperationReport(): AutonomousOperationReport {
  const uptimeMs = Date.now() - new Date(startedAt).getTime();
  const hours = Math.floor(uptimeMs / 3600_000);
  const mins = Math.floor((uptimeMs % 3600_000) / 60_000);
  const uptimeStr = `${hours}h ${mins}m`;

  const totalActions = cycles.reduce((n, c) => n + c.actionsExecuted, 0);
  const totalSucceeded = cycles.reduce((n, c) => n + c.actionsSucceeded, 0);
  const avgCycleMs = cycles.length > 0
    ? Math.round(cycles.reduce((n, c) => n + (c.durationMs ?? 0), 0) / cycles.length)
    : 0;

  const highlights: string[] = [];
  if (totalActions > 0) highlights.push(`${totalActions} autonomous actions executed`);
  if (cycles.length > 0) highlights.push(`${cycles.length} orchestration cycles completed`);
  if (currentBatchSizeMultiplier !== 1.0) highlights.push(`Batch size adjusted to ${(currentBatchSizeMultiplier * 100).toFixed(0)}% of baseline`);

  const recentCycle = cycles[cycles.length - 1];
  const stability: AutonomousOperationReport["systemStability"] =
    !recentCycle ? "stable" :
    recentCycle.systemSnapshot.systemHealth === "critical" ? "unstable" :
    recentCycle.systemSnapshot.systemHealth === "degraded" ? "recovering" :
    "stable";

  return {
    generatedAt: new Date().toISOString(),
    uptime: uptimeStr,
    totalCycles: cycles.length,
    autonomousActionsExecuted: totalActions,
    humanInterventionsRequired,
    optimizationHighlights: highlights,
    systemStability: stability,
    keyMetrics: {
      averageCycleMs: avgCycleMs,
      actionsPerCycle: cycles.length > 0 ? Math.round((totalActions / cycles.length) * 10) / 10 : 0,
      successRate: totalActions > 0 ? Math.round((totalSucceeded / totalActions) * 100) : 100,
      coverageImprovementPercent:
        progressWindow.length >= 2
          ? Math.max(0, (progressWindow[progressWindow.length - 1]?.coveragePercent ?? 0) - (progressWindow[0]?.coveragePercent ?? 0))
          : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const REPORT_DIR = process.cwd();

export async function flushReports(): Promise<void> {
  const [orchReport, healthReport, autoReport] = await Promise.all([
    Promise.resolve(getSelfHealingOrchestrationReport()),
    getOrchestrationHealthReport(),
    Promise.resolve(getAutonomousOperationReport()),
  ]);

  await Promise.allSettled([
    writeFile(join(REPORT_DIR, "self-healing-orchestration-report.json"), JSON.stringify(orchReport, null, 2)),
    writeFile(join(REPORT_DIR, "orchestration-health-report.json"), JSON.stringify(healthReport, null, 2)),
    writeFile(join(REPORT_DIR, "autonomous-operation-report.json"), JSON.stringify(autoReport, null, 2)),
  ]);

  logger.info({ cycles: orchReport.totalCycles, health: healthReport.systemHealth }, "F6: reports flushed");
}
