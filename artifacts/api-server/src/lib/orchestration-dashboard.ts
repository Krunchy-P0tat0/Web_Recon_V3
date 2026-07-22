/**
 * orchestration-dashboard.ts — Phase 7.5: Execution Dashboard Engine
 *
 * Aggregates data from every phase into a unified job view:
 *   Phase 7.1  — master orchestrator (stage results, timing, retries)
 *   Phase 7.2  — state machine (deterministic state, history)
 *   Phase 7.3  — decision engine (decisions made for this job)
 *   Phase 7.4  — human override (approval requests for this job)
 *   Phase F    — legacy DB orchestration jobs
 *   Event bus  — recent events for this job
 *
 * Generates dashboard-report.json locally + R2.
 */

import { writeFile, readFile } from "fs/promises";
import { join }                from "path";
import { logger }              from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import { listJobs, getJob }    from "./master-orchestrator.js";
import { getMachineByPipelineJobId, listMachines } from "./pipeline-state-machine.js";
import { listApprovalRequests } from "./human-override-engine.js";
import { loadReport as loadDecisionReport } from "./decision-engine.js";
import { eventBus }            from "./event-bus.js";
import { listOrchestrationJobs, getOrchestrationJob } from "./workflow-orchestrator.js";

// ---------------------------------------------------------------------------
// Unified job view types
// ---------------------------------------------------------------------------

export interface StageMetric {
  id:          string;
  label:       string;
  status:      string;
  durationMs:  number | null;
  retryCount:  number;
  error:       string | null;
  startedAt:   string | null;
  completedAt: string | null;
}

export interface JobMetrics {
  totalDurationMs:   number | null;
  avgStageDurationMs: number | null;
  totalRetries:      number;
  stagesComplete:    number;
  stagesFailed:      number;
  stagesSkipped:     number;
  stagesTotal:       number;
  throughputPagesPerSec: number | null;
  approvalsPending:  number;
  approvalsGranted:  number;
  approvalsRejected: number;
}

export interface DashboardJob {
  // Identity
  pipelineJobId:   string;
  legacyJobId:     string | null;
  stateMachineId:  string | null;
  url:             string;
  source:          "pipeline" | "legacy";

  // Status
  status:          string;
  currentStage:    string | null;
  smState:         string | null;
  paused:          boolean;

  // Timing
  startedAt:       string;
  completedAt:     string | null;
  totalDurationMs: number | null;

  // Data
  stages:          StageMetric[];
  metrics:         JobMetrics;
  recentEvents:    import("./event-bus.js").PipelineEvent[];
  approvals:       import("./human-override-engine.js").ApprovalRequest[];

  // Error
  error:           string | null;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

async function buildDashboardJob(pipelineJobId: string): Promise<DashboardJob | null> {
  const job = getJob(pipelineJobId);
  if (!job) return null;

  const machine     = getMachineByPipelineJobId(pipelineJobId);
  const approvals   = listApprovalRequests({ checkpointId: undefined }).filter(
    (r) => r.pipelineJobId === pipelineJobId
  );
  const recentEvents = eventBus.getBuffer(pipelineJobId).slice(-50);

  const stages: StageMetric[] = job.stages.map((s) => ({
    id:          s.id,
    label:       s.label,
    status:      s.status,
    durationMs:  s.durationMs,
    retryCount:  s.retryCount,
    error:       s.error,
    startedAt:   s.startedAt,
    completedAt: s.completedAt,
  }));

  const completedStages = stages.filter((s) => s.status === "complete");
  const failedStages    = stages.filter((s) => s.status === "failed");
  const skippedStages   = stages.filter((s) => s.status === "skipped");
  const durations       = completedStages.map((s) => s.durationMs).filter((d): d is number => d !== null);
  const avgDuration     = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null;
  const totalRetries    = stages.reduce((sum, s) => sum + s.retryCount, 0);

  const metrics: JobMetrics = {
    totalDurationMs:    job.totalDurationMs,
    avgStageDurationMs: avgDuration,
    totalRetries,
    stagesComplete:     completedStages.length,
    stagesFailed:       failedStages.length,
    stagesSkipped:      skippedStages.length,
    stagesTotal:        stages.length,
    throughputPagesPerSec: null,  // enriched separately if manifest available
    approvalsPending:   approvals.filter((a) => a.status === "pending").length,
    approvalsGranted:   approvals.filter((a) => a.status === "approved" || a.status === "auto-approved").length,
    approvalsRejected:  approvals.filter((a) => a.status === "rejected").length,
  };

  return {
    pipelineJobId,
    legacyJobId:    null,
    stateMachineId: machine?.id ?? null,
    url:            job.url,
    source:         "pipeline",
    status:         job.status,
    currentStage:   job.currentStage,
    smState:        machine?.state ?? null,
    paused:         machine?.paused ?? false,
    startedAt:      job.startedAt,
    completedAt:    job.completedAt,
    totalDurationMs:job.totalDurationMs,
    stages,
    metrics,
    recentEvents,
    approvals,
    error:          job.error,
  };
}

/** Build a lightweight legacy job view (Phase F DB jobs) */
async function buildLegacyJob(legacyJob: Awaited<ReturnType<typeof getOrchestrationJob>>): Promise<DashboardJob | null> {
  if (!legacyJob) return null;
  const plan = legacyJob.executionPlan as { stages?: { name: string; status: string; startedAt?: string; completedAt?: string; error?: string }[] } | null;
  const stages: StageMetric[] = (plan?.stages ?? []).map((s) => ({
    id:          s.name,
    label:       s.name,
    status:      s.status,
    durationMs:  s.startedAt && s.completedAt
      ? new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime()
      : null,
    retryCount:  0,
    error:       s.error ?? null,
    startedAt:   s.startedAt ?? null,
    completedAt: s.completedAt ?? null,
  }));

  const metrics: JobMetrics = {
    totalDurationMs:    legacyJob.completedAt
      ? legacyJob.completedAt.getTime() - legacyJob.createdAt.getTime()
      : null,
    avgStageDurationMs: null,
    totalRetries:       0,
    stagesComplete:     stages.filter((s) => s.status === "complete").length,
    stagesFailed:       stages.filter((s) => s.status === "failed").length,
    stagesSkipped:      0,
    stagesTotal:        stages.length,
    throughputPagesPerSec: null,
    approvalsPending:   0,
    approvalsGranted:   0,
    approvalsRejected:  0,
  };

  return {
    pipelineJobId:   legacyJob.orchestrationId,
    legacyJobId:     legacyJob.orchestrationId,
    stateMachineId:  null,
    url:             legacyJob.url,
    source:          "legacy",
    status:          legacyJob.status,
    currentStage:    legacyJob.status,
    smState:         null,
    paused:          false,
    startedAt:       legacyJob.createdAt.toISOString(),
    completedAt:     legacyJob.completedAt?.toISOString() ?? null,
    totalDurationMs: metrics.totalDurationMs,
    stages,
    metrics,
    recentEvents:    [],
    approvals:       [],
    error:           legacyJob.errorMessage ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listDashboardJobs(): Promise<DashboardJob[]> {
  const [pipelineJobs, legacyJobs] = await Promise.all([
    Promise.resolve(listJobs()),
    listOrchestrationJobs().catch(() => [] as Awaited<ReturnType<typeof listOrchestrationJobs>>),
  ]);

  const seenIds = new Set<string>();
  const results: DashboardJob[] = [];

  // Phase 7.1 pipeline jobs first
  for (const j of pipelineJobs) {
    seenIds.add(j.id);
    const view = await buildDashboardJob(j.id);
    if (view) results.push(view);
  }

  // Legacy Phase F jobs (de-duped — skip if we already have it as a pipeline job)
  for (const lj of legacyJobs) {
    if (seenIds.has(lj.orchestrationId)) continue;
    const view = await buildLegacyJob(lj);
    if (view) results.push(view);
  }

  return results.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

export async function getDashboardJob(id: string): Promise<DashboardJob | null> {
  // Try Phase 7.1 first
  if (getJob(id)) {
    return buildDashboardJob(id);
  }
  // Fall back to legacy
  const legacy = await getOrchestrationJob(id).catch(() => null);
  if (legacy) return buildLegacyJob(legacy);
  return null;
}

export function getJobLogs(pipelineJobId: string): {
  pipelineJobId: string;
  events:        import("./event-bus.js").PipelineEvent[];
  stageHistory:  import("./pipeline-state-machine.js").StateTransitionEvent[];
  approvals:     import("./human-override-engine.js").ApprovalRequest[];
} {
  const machine    = getMachineByPipelineJobId(pipelineJobId);
  const events     = eventBus.getBuffer(pipelineJobId);
  const approvals  = listApprovalRequests().filter((r) => r.pipelineJobId === pipelineJobId);

  return {
    pipelineJobId,
    events,
    stageHistory: machine?.history ?? [],
    approvals,
  };
}

// ---------------------------------------------------------------------------
// Dashboard report generator
// ---------------------------------------------------------------------------

const REPORT_PATH    = join(process.cwd(), "dashboard-report.json");
const REPORT_PATH_UP = join(process.cwd(), "..", "..", "dashboard-report.json");

export async function generateDashboardReport(): Promise<unknown> {
  const jobs     = await listDashboardJobs();
  const machines = listMachines();

  const report = {
    version:     "1.0",
    phase:       "7.5",
    generatedAt: new Date().toISOString(),
    summary: {
      totalJobs:     jobs.length,
      running:       jobs.filter((j) => j.status === "running").length,
      complete:      jobs.filter((j) => j.status === "complete").length,
      failed:        jobs.filter((j) => j.status === "failed").length,
      paused:        jobs.filter((j) => j.paused).length,
      stateMachines: machines.length,
    },
    jobs,
  };

  const json  = JSON.stringify(report, null, 2);
  const cloud = getDefaultCloudProvider();

  await Promise.allSettled([
    writeFile(REPORT_PATH,    json, "utf8"),
    writeFile(REPORT_PATH_UP, json, "utf8"),
    ...(cloud.isConfigured() ? [
      cloud.upload({
        key:            "orchestration/dashboard-report.json",
        data:           Buffer.from(json, "utf8"),
        contentType:    "application/json",
        checkDuplicate: false,
      }),
    ] : []),
  ]);

  logger.info({ jobCount: jobs.length }, "DASHBOARD: report generated");
  return report;
}

export async function loadDashboardReport(): Promise<unknown> {
  for (const p of [REPORT_PATH, REPORT_PATH_UP]) {
    try { return JSON.parse(await readFile(p, "utf8")); } catch { /* skip */ }
  }
  return null;
}
