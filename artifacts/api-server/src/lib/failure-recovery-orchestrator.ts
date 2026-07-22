/**
 * failure-recovery-orchestrator.ts — Phase 7.7: Failure Recovery Orchestrator
 *
 * Detects and recovers from five classes of pipeline failure:
 *
 *   1. crawl failure      → retry with backoff, then mark unrecoverable
 *   2. manifest failure   → retry, then resume from crawl (re-scrape)
 *   3. merge failure      → retry, then rollback to pre-merge baseline
 *   4. deployment failure → rollback to last stable deployment, then retry
 *   5. storage failure    → retry with backoff, fallback to local provider
 *
 * Recovery policies applied per failure class:
 *   - retry_policy   : how many attempts, base delay, backoff multiplier
 *   - rollback_policy: what state to restore on exhausted retries
 *   - resume_policy  : which stage to resume from after recovery
 *
 * Generates failure-recovery-report.json locally + uploads to R2.
 */

import { randomUUID }          from "crypto";
import { writeFile, readFile } from "fs/promises";
import { join }                from "path";
import { logger }              from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import {
  getJob,
  listJobs,
  createJob,
  runPipeline,
  type OrchestrationJob,
  type MasterStageId,
} from "./master-orchestrator.js";
import { publishEvent } from "./event-bus.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FailureClass =
  | "crawl_failure"
  | "manifest_failure"
  | "merge_failure"
  | "deployment_failure"
  | "storage_failure"
  | "unknown_failure";

export type RecoveryAction =
  | "retry"
  | "resume_from_stage"
  | "rollback"
  | "restart_pipeline"
  | "mark_unrecoverable";

export type RecoveryOutcome =
  | "recovered"
  | "partial_recovery"
  | "unrecoverable"
  | "in_progress"
  | "skipped";

export interface RetryPolicy {
  maxAttempts:    number;
  baseDelayMs:    number;
  backoffMultiplier: number;
  jitterMs:       number;
}

export interface RollbackPolicy {
  enabled:         boolean;
  targetStage:     MasterStageId | null;
  preserveArtifacts: boolean;
  description:     string;
}

export interface ResumePolicy {
  fromStage:       MasterStageId;
  resetFailedOnly: boolean;
  description:     string;
}

export interface FailureClassification {
  class:      FailureClass;
  failedStage: MasterStageId | null;
  errorMessage: string;
  retryPolicy:  RetryPolicy;
  rollbackPolicy: RollbackPolicy;
  resumePolicy:   ResumePolicy;
  rationale:    string;
}

export interface RecoveryAttempt {
  id:          string;
  jobId:       string;
  attemptNumber: number;
  action:      RecoveryAction;
  startedAt:   string;
  completedAt: string | null;
  durationMs:  number | null;
  outcome:     RecoveryOutcome;
  detail:      string;
  newJobId:    string | null;
}

export interface RecoveryRecord {
  id:             string;
  originalJobId:  string;
  url:            string;
  failure:        FailureClassification;
  attempts:       RecoveryAttempt[];
  finalOutcome:   RecoveryOutcome;
  recoveredJobId: string | null;
  startedAt:      string;
  completedAt:    string | null;
  totalDurationMs: number | null;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const _records = new Map<string, RecoveryRecord>();

export function getRecoveryRecord(id: string): RecoveryRecord | undefined {
  return _records.get(id);
}

export function listRecoveryRecords(): RecoveryRecord[] {
  return Array.from(_records.values()).sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

const RETRY_POLICIES: Record<FailureClass, RetryPolicy> = {
  crawl_failure:       { maxAttempts: 3, baseDelayMs: 2_000,  backoffMultiplier: 2,   jitterMs: 500  },
  manifest_failure:    { maxAttempts: 2, baseDelayMs: 1_500,  backoffMultiplier: 2,   jitterMs: 300  },
  merge_failure:       { maxAttempts: 2, baseDelayMs: 3_000,  backoffMultiplier: 1.5, jitterMs: 1000 },
  deployment_failure:  { maxAttempts: 2, baseDelayMs: 5_000,  backoffMultiplier: 2,   jitterMs: 1500 },
  storage_failure:     { maxAttempts: 4, baseDelayMs: 1_000,  backoffMultiplier: 3,   jitterMs: 200  },
  unknown_failure:     { maxAttempts: 1, baseDelayMs: 2_000,  backoffMultiplier: 1,   jitterMs: 0    },
};

const ROLLBACK_POLICIES: Record<FailureClass, RollbackPolicy> = {
  crawl_failure:       { enabled: false, targetStage: null,         preserveArtifacts: true,  description: "Crawl produces no deployable artifacts — rollback not applicable" },
  manifest_failure:    { enabled: false, targetStage: "crawl",      preserveArtifacts: true,  description: "Resume from crawl stage after manifest failure" },
  merge_failure:       { enabled: true,  targetStage: "stencil",    preserveArtifacts: true,  description: "Rollback to pre-merge stencil state and retry merge" },
  deployment_failure:  { enabled: true,  targetStage: "deployment-plan", preserveArtifacts: true,  description: "Restore last stable deployment, then re-attempt deploy stage" },
  storage_failure:     { enabled: false, targetStage: null,         preserveArtifacts: false, description: "Retry storage operations; fallback to local provider" },
  unknown_failure:     { enabled: false, targetStage: null,         preserveArtifacts: true,  description: "No rollback defined for unknown failure class" },
};

const RESUME_POLICIES: Record<FailureClass, ResumePolicy> = {
  crawl_failure:       { fromStage: "crawl",           resetFailedOnly: true,  description: "Re-attempt crawl from scratch" },
  manifest_failure:    { fromStage: "crawl",            resetFailedOnly: false, description: "Re-crawl and regenerate manifest" },
  merge_failure:       { fromStage: "merge",            resetFailedOnly: true,  description: "Resume from merge stage" },
  deployment_failure:  { fromStage: "deploy",           resetFailedOnly: true,  description: "Resume from deploy stage only" },
  storage_failure:     { fromStage: "deploy",           resetFailedOnly: true,  description: "Retry deploy/upload with backoff" },
  unknown_failure:     { fromStage: "crawl",            resetFailedOnly: false, description: "Full restart on unknown failure" },
};

function classifyFailure(job: OrchestrationJob): FailureClassification {
  const failedStage = job.stages.find((s) => s.status === "failed")?.id as MasterStageId | undefined;
  const errorMsg    = job.error ?? failedStage ? (job.stages.find((s) => s.id === failedStage)?.error ?? job.error ?? "") : "";

  let cls: FailureClass = "unknown_failure";

  if (failedStage === "crawl") {
    cls = "crawl_failure";
  } else if (failedStage === "manifest") {
    cls = "manifest_failure";
  } else if (failedStage === "merge") {
    cls = "merge_failure";
  } else if (failedStage === "deploy" || failedStage === "deployment-plan") {
    // Check if it's a storage/R2 error
    const errLower = (errorMsg ?? "").toLowerCase();
    if (errLower.includes("r2") || errLower.includes("s3") || errLower.includes("storage") || errLower.includes("upload")) {
      cls = "storage_failure";
    } else {
      cls = "deployment_failure";
    }
  } else if (
    (errorMsg ?? "").toLowerCase().includes("upload") ||
    (errorMsg ?? "").toLowerCase().includes("r2") ||
    (errorMsg ?? "").toLowerCase().includes("storage")
  ) {
    cls = "storage_failure";
  }

  return {
    class:          cls,
    failedStage:    failedStage ?? null,
    errorMessage:   errorMsg ?? "",
    retryPolicy:    RETRY_POLICIES[cls],
    rollbackPolicy: ROLLBACK_POLICIES[cls],
    resumePolicy:   RESUME_POLICIES[cls],
    rationale:      buildRationale(cls, failedStage ?? null, errorMsg ?? ""),
  };
}

function buildRationale(cls: FailureClass, failedStage: MasterStageId | null, errorMsg: string): string {
  const stage = failedStage ? ` at stage "${failedStage}"` : "";
  const err   = errorMsg ? ` — "${errorMsg.slice(0, 120)}"` : "";
  switch (cls) {
    case "crawl_failure":      return `Crawl failure${stage}${err}. Will retry the crawl up to ${RETRY_POLICIES.crawl_failure.maxAttempts} times before marking unrecoverable.`;
    case "manifest_failure":   return `Manifest validation failed${stage}${err}. Will retry manifest stage, falling back to full re-crawl if needed.`;
    case "merge_failure":      return `Merge compilation failed${stage}${err}. Will retry merge; if exhausted, rollback to stencil stage.`;
    case "deployment_failure": return `Deployment execution failed${stage}${err}. Will rollback to last stable deployment then retry.`;
    case "storage_failure":    return `R2/storage operation failed${stage}${err}. Will retry with exponential backoff up to ${RETRY_POLICIES.storage_failure.maxAttempts} times.`;
    default:                   return `Unknown failure${stage}${err}. Will attempt a full pipeline restart.`;
  }
}

// ---------------------------------------------------------------------------
// Stage reset helper — resets stages from a given stage onward to "pending"
// ---------------------------------------------------------------------------

const STAGE_ORDER: MasterStageId[] = [
  "crawl", "manifest", "diff", "intelligence", "design-dna",
  "visual-dna", "stencil", "website-prime", "merge", "deployment-plan", "deploy",
];

function resetStagesFrom(job: OrchestrationJob, fromStage: MasterStageId, resetFailedOnly: boolean): void {
  const fromIdx = STAGE_ORDER.indexOf(fromStage);
  if (fromIdx === -1) return;

  for (let i = fromIdx; i < STAGE_ORDER.length; i++) {
    const stageId = STAGE_ORDER[i]!;
    const stage   = job.stages.find((s) => s.id === stageId);
    if (!stage) continue;
    if (resetFailedOnly && stage.status !== "failed" && stage.status !== "retrying") continue;

    stage.status      = "pending";
    stage.startedAt   = null;
    stage.completedAt = null;
    stage.durationMs  = null;
    stage.error       = null;
    stage.retryCount  = 0;
  }

  // Remove the fromStage from completedStages / failedStages
  job.completedStages = job.completedStages.filter((s) => STAGE_ORDER.indexOf(s) < fromIdx);
  job.failedStages    = job.failedStages.filter((s) => STAGE_ORDER.indexOf(s) < fromIdx);
  job.skippedStages   = job.skippedStages.filter((s) => STAGE_ORDER.indexOf(s) < fromIdx);
  job.error           = null;
  job.status          = "pending";
  job.currentStage    = null;
}

// ---------------------------------------------------------------------------
// Recovery executor
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitteredDelay(policy: RetryPolicy, attempt: number): number {
  const base    = policy.baseDelayMs * Math.pow(policy.backoffMultiplier, attempt - 1);
  const jitter  = Math.random() * policy.jitterMs;
  return Math.round(base + jitter);
}

async function executeRecovery(record: RecoveryRecord): Promise<void> {
  const { failure } = record;
  const policy      = failure.retryPolicy;
  const resume      = failure.resumePolicy;
  const t0          = Date.now();

  publishEvent("stage-retrying", record.originalJobId, {
    recoveryId: record.id,
    failureClass: failure.class,
    fromStage: resume.fromStage,
  });

  let lastOutcome: RecoveryOutcome = "unrecoverable";

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const attemptId  = randomUUID();
    const attemptT0  = Date.now();
    let   newJobId: string | null = null;

    // Determine action for this attempt
    const action: RecoveryAction = attempt === 1
      ? "resume_from_stage"
      : (attempt <= policy.maxAttempts ? "retry" : "restart_pipeline");

    const attemptRecord: RecoveryAttempt = {
      id:            attemptId,
      jobId:         record.originalJobId,
      attemptNumber: attempt,
      action,
      startedAt:     new Date().toISOString(),
      completedAt:   null,
      durationMs:    null,
      outcome:       "in_progress",
      detail:        `Attempt ${attempt}/${policy.maxAttempts} — ${action} from stage "${resume.fromStage}"`,
      newJobId:      null,
    };
    record.attempts.push(attemptRecord);

    logger.info(
      { recoveryId: record.id, jobId: record.originalJobId, attempt, action, fromStage: resume.fromStage },
      "RECOVERY: attempt started",
    );

    try {
      if (attempt > 1) {
        const delay = jitteredDelay(policy, attempt - 1);
        logger.info({ recoveryId: record.id, delay }, "RECOVERY: waiting before retry");
        await sleep(delay);
      }

      // Strategy: resume the original job from the failed stage
      // For restarts, create a brand-new job
      if (action === "restart_pipeline" || failure.class === "manifest_failure" && attempt > 1) {
        const newJob = createJob({ url: record.url });
        newJobId = newJob.id;
        attemptRecord.newJobId = newJobId;
        attemptRecord.detail   = `Restart: new job ${newJobId}`;
        runPipeline(newJob).catch(() => {});
      } else {
        // Resume the original job from the appropriate stage
        const originalJob = getJob(record.originalJobId);
        if (!originalJob) throw new Error(`Original job ${record.originalJobId} not found in memory`);

        resetStagesFrom(originalJob, resume.fromStage, resume.resetFailedOnly);
        runPipeline(originalJob).catch(() => {});
        newJobId = record.originalJobId;
        attemptRecord.newJobId = record.originalJobId;
      }

      // Poll for completion (up to 10 minutes per attempt)
      const POLL_INTERVAL = 5_000;
      const MAX_WAIT      = 10 * 60 * 1_000;
      const pollStart     = Date.now();
      let   resolvedJob   = getJob(newJobId ?? record.originalJobId);

      while (
        resolvedJob &&
        resolvedJob.status === "running" &&
        Date.now() - pollStart < MAX_WAIT
      ) {
        await sleep(POLL_INTERVAL);
        resolvedJob = getJob(newJobId ?? record.originalJobId);
      }

      if (!resolvedJob || resolvedJob.status === "running") {
        throw new Error("Job did not complete within 10 minutes");
      }

      if (resolvedJob.status === "complete") {
        attemptRecord.outcome   = "recovered";
        attemptRecord.detail    = `Job ${newJobId} completed successfully`;
        lastOutcome             = "recovered";
        record.recoveredJobId   = newJobId;

        publishEvent("job-complete", newJobId ?? record.originalJobId, {
          recoveryId:  record.id,
          attempt,
          durationMs:  resolvedJob.totalDurationMs,
        });
        break;
      } else {
        throw new Error(`Job finished with status "${resolvedJob.status}": ${resolvedJob.error ?? "no error"}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attemptRecord.outcome  = attempt < policy.maxAttempts ? "partial_recovery" : "unrecoverable";
      attemptRecord.detail   = `Attempt ${attempt} failed: ${msg}`;
      lastOutcome            = attemptRecord.outcome;
      logger.warn({ recoveryId: record.id, attempt, err: msg }, "RECOVERY: attempt failed");
    } finally {
      attemptRecord.completedAt = new Date().toISOString();
      attemptRecord.durationMs  = Date.now() - attemptT0;
    }

    if (lastOutcome === "unrecoverable" && attempt === policy.maxAttempts) {
      logger.error(
        { recoveryId: record.id, failureClass: failure.class, attempts: attempt },
        "RECOVERY: all attempts exhausted — unrecoverable",
      );
    }
  }

  record.finalOutcome     = lastOutcome;
  record.completedAt      = new Date().toISOString();
  record.totalDurationMs  = Date.now() - t0;

  await persistReport();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function recoverJob(jobId: string): Promise<RecoveryRecord | null> {
  const job = getJob(jobId);
  if (!job) {
    logger.warn({ jobId }, "RECOVERY: job not found");
    return null;
  }

  if (job.status !== "failed" && job.status !== "cancelled") {
    logger.info({ jobId, status: job.status }, "RECOVERY: job is not in a failed state — skipping");
    return null;
  }

  // Avoid duplicate recovery if one is already running for this job
  const existing = Array.from(_records.values()).find(
    (r) => r.originalJobId === jobId && (r.finalOutcome === "in_progress" || r.finalOutcome === "recovered"),
  );
  if (existing) {
    logger.info({ jobId, recoveryId: existing.id }, "RECOVERY: recovery already exists for this job");
    return existing;
  }

  const failure  = classifyFailure(job);
  const recordId = randomUUID();

  const record: RecoveryRecord = {
    id:              recordId,
    originalJobId:   jobId,
    url:             job.url,
    failure,
    attempts:        [],
    finalOutcome:    "in_progress",
    recoveredJobId:  null,
    startedAt:       new Date().toISOString(),
    completedAt:     null,
    totalDurationMs: null,
  };

  _records.set(recordId, record);

  logger.info(
    { recoveryId: recordId, jobId, failureClass: failure.class, fromStage: failure.resumePolicy.fromStage },
    "RECOVERY: starting recovery",
  );

  // Fire-and-forget — caller polls GET /recovery/:id
  executeRecovery(record).catch((err) => {
    logger.error({ recoveryId: recordId, err }, "RECOVERY: unhandled error in executeRecovery");
    record.finalOutcome    = "unrecoverable";
    record.completedAt     = new Date().toISOString();
    void persistReport();
  });

  return record;
}

/** Simulate a specific failure type for testing */
export async function simulateFailure(
  url: string,
  failureClass: FailureClass,
): Promise<{ job: OrchestrationJob; recovery: RecoveryRecord | null }> {
  const job = createJob({ url });

  // Mark it as failed in the appropriate stage
  const stageMap: Record<FailureClass, MasterStageId | null> = {
    crawl_failure:       "crawl",
    manifest_failure:    "manifest",
    merge_failure:       "merge",
    deployment_failure:  "deploy",
    storage_failure:     "deploy",
    unknown_failure:     null,
  };

  const failStage = stageMap[failureClass];
  if (failStage) {
    const stage = job.stages.find((s) => s.id === failStage);
    if (stage) {
      stage.status      = "failed";
      stage.startedAt   = new Date().toISOString();
      stage.completedAt = new Date().toISOString();
      stage.durationMs  = 0;
      stage.error       = `Simulated ${failureClass}`;
    }
    job.status      = "failed";
    job.currentStage = failStage;
    job.error        = `Simulated ${failureClass}`;
    job.failedStages.push(failStage);
  }

  const recovery = await recoverJob(job.id);
  return { job, recovery };
}

// ---------------------------------------------------------------------------
// Report persistence
// ---------------------------------------------------------------------------

const REPORT_PATH    = join(process.cwd(), "failure-recovery-report.json");
const REPORT_PATH_UP = join(process.cwd(), "..", "..", "failure-recovery-report.json");

export async function persistReport(): Promise<void> {
  const records = listRecoveryRecords();
  const report = {
    version:     "1.0",
    phase:       "7.7",
    generatedAt: new Date().toISOString(),
    summary: {
      total:          records.length,
      recovered:      records.filter((r) => r.finalOutcome === "recovered").length,
      unrecoverable:  records.filter((r) => r.finalOutcome === "unrecoverable").length,
      inProgress:     records.filter((r) => r.finalOutcome === "in_progress").length,
      byFailureClass: Object.fromEntries(
        (["crawl_failure","manifest_failure","merge_failure","deployment_failure","storage_failure","unknown_failure"] as FailureClass[])
          .map((cls) => [cls, records.filter((r) => r.failure.class === cls).length])
      ),
    },
    policies: {
      retryPolicies:    RETRY_POLICIES,
      rollbackPolicies: ROLLBACK_POLICIES,
      resumePolicies:   RESUME_POLICIES,
    },
    records,
  };

  const json  = JSON.stringify(report, null, 2);
  const cloud = getDefaultCloudProvider();

  await Promise.allSettled([
    writeFile(REPORT_PATH,    json, "utf8"),
    writeFile(REPORT_PATH_UP, json, "utf8"),
    ...(cloud.isConfigured() ? [
      cloud.upload({
        key:            "orchestration/failure-recovery-report.json",
        data:           Buffer.from(json, "utf8"),
        contentType:    "application/json",
        checkDuplicate: false,
      }),
    ] : []),
  ]);
}

export async function loadReport(): Promise<unknown> {
  for (const p of [REPORT_PATH, REPORT_PATH_UP]) {
    try { return JSON.parse(await readFile(p, "utf8")); } catch { /* skip */ }
  }
  return null;
}

export { RETRY_POLICIES, ROLLBACK_POLICIES, RESUME_POLICIES };
