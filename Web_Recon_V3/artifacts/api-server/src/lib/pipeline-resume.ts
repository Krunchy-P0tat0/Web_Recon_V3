/**
 * pipeline-resume.ts — Phase D3.5 Pipeline Resume Engine
 *
 * Solves the core crash-recovery problem:
 *   "A restart should NEVER mean starting over."
 *
 * On server startup, this module:
 *   1. Queries the DB for recent orchestration jobs
 *   2. Reconstructs their in-memory state
 *   3. Makes them queryable via getJob() / listJobs()
 *
 * When a user (or the system) triggers a resume:
 *   1. Loads the full job state from DB
 *   2. Identifies the first incomplete stage
 *   3. Calls runPipeline() — which now skips completed stages
 *
 * Key guarantee: completed stages are NEVER re-run unless the user
 * explicitly requests a full restart.
 */

import { desc, or, eq } from "drizzle-orm";
import { logger } from "./logger.js";
import { db, orchestrationJobsTable } from "../db/index.js";
import type { OrchestrationJobRecord } from "@workspace/db";
import {
  createJob,
  getJob,
  _registerJob,
  type OrchestrationJob,
  type MasterStageId,
  type MasterStageStatus,
  type MasterStageResult,
} from "./master-orchestrator.js";

// ---------------------------------------------------------------------------
// Stage label map (mirrors master-orchestrator.ts)
// ---------------------------------------------------------------------------

const STAGE_LABELS: Record<MasterStageId, string> = {
  "crawl":           "Crawl — scrape all pages",
  "manifest":        "Manifest — verify content manifest",
  "diff":            "Diff — detect changes vs baseline",
  "intelligence":    "Intelligence — deployment environment analysis",
  "design-dna":      "Design DNA — archetype classification",
  "visual-dna":      "Visual DNA — layout & colour analysis",
  "stencil":         "Stencil — select & assemble stencil",
  "website-prime":   "Website Prime — generate site blueprint",
  "merge":           "Merge — compile merge plan",
  "deployment-plan": "Deployment Plan — multi-framework plan",
  "deploy":          "Deploy — execute & verify deployment",
  "certification":   "Certification — production readiness gate",
};

const ALL_STAGE_IDS: MasterStageId[] = [
  "crawl", "manifest", "diff", "intelligence", "design-dna",
  "visual-dna", "stencil", "website-prime", "merge",
  "deployment-plan", "deploy", "certification",
];

// ---------------------------------------------------------------------------
// Reconstruct an OrchestrationJob from a DB record
// ---------------------------------------------------------------------------

function reconstructJob(record: OrchestrationJobRecord): OrchestrationJob {
  const plan = record.executionPlan;
  const stageRecords: Map<string, { status: string; startedAt?: string; completedAt?: string; error?: string }> = new Map();

  if (plan?.stages) {
    for (const s of plan.stages) {
      stageRecords.set(s.name, s);
    }
  }

  const stages: MasterStageResult[] = ALL_STAGE_IDS.map((id) => {
    const persisted = stageRecords.get(id);
    const status: MasterStageStatus =
      persisted?.status === "complete" ? "complete" :
      persisted?.status === "failed"   ? "failed"   :
      persisted?.status === "skipped"  ? "skipped"  :
      persisted?.status === "running"  ? "pending"  : // treat running-at-crash as pending
      "pending";

    return {
      id,
      label:       STAGE_LABELS[id],
      status,
      startedAt:   persisted?.startedAt  ?? null,
      completedAt: persisted?.completedAt ?? null,
      durationMs:  null,
      retryCount:  0,
      maxRetries:  2,
      error:       (status === "failed" ? (persisted?.error ?? null) : null),
      metadata:    {},
    };
  });

  const completedStages: MasterStageId[] = stages
    .filter((s) => s.status === "complete")
    .map((s) => s.id);

  const skippedStages: MasterStageId[] = stages
    .filter((s) => s.status === "skipped")
    .map((s) => s.id);

  const failedStages: MasterStageId[] = stages
    .filter((s) => s.status === "failed")
    .map((s) => s.id);

  // Map DB status back to OrchestrationJob status
  const jobStatus: OrchestrationJob["status"] =
    record.status === "complete" ? "complete" :
    record.status === "failed"   ? "failed"   :
    // Jobs that were running when server crashed become "failed" so they can be resumed
    "failed";

  return {
    id:                    record.orchestrationId,
    url:                   record.url,
    includeDiff:           record.baseJobId != null,
    baseJobId:             record.baseJobId ?? null,
    status:                jobStatus,
    currentStage:          null,
    completedStages,
    failedStages,
    skippedStages,
    stages,
    underlyingJobId:       record.underlyingJobId ?? null,
    deploymentExecutionId: null,
    startedAt:             record.createdAt.toISOString(),
    completedAt:           record.completedAt?.toISOString() ?? null,
    totalDurationMs:       null,
    error:                 record.errorMessage ?? null,
    coverageThreshold:     0,
  };
}

// ---------------------------------------------------------------------------
// Load a single job from DB
// ---------------------------------------------------------------------------

export async function loadJobFromDB(jobId: string): Promise<OrchestrationJob | null> {
  try {
    const [record] = await db
      .select()
      .from(orchestrationJobsTable)
      .where(eq(orchestrationJobsTable.orchestrationId, jobId))
      .limit(1);

    if (!record) return null;
    return reconstructJob(record);
  } catch (err) {
    logger.warn({ err, jobId }, "PIPELINE-RESUME: failed to load job from DB");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Restore recent jobs into in-memory store on server startup
// ---------------------------------------------------------------------------

/**
 * Load the most recent N orchestration jobs from DB and register them
 * in-memory so they show up in listJobs() / getJob() immediately after restart.
 *
 * Returns the number of jobs restored.
 */
export async function restoreJobsFromDB(limit = 50): Promise<number> {
  try {
    const records = await db
      .select()
      .from(orchestrationJobsTable)
      .orderBy(desc(orchestrationJobsTable.createdAt))
      .limit(limit);

    let restored = 0;
    for (const record of records) {
      const jobId = record.orchestrationId;
      if (getJob(jobId)) continue; // already in memory

      try {
        const job = reconstructJob(record);
        _registerJob(job);
        restored++;
      } catch (innerErr) {
        logger.warn({ err: innerErr, jobId }, "PIPELINE-RESUME: failed to reconstruct job — skipping");
      }
    }

    if (restored > 0) {
      logger.info({ restored, total: records.length }, "PIPELINE-RESUME: jobs restored from DB");
    }

    return restored;
  } catch (err) {
    logger.warn({ err }, "PIPELINE-RESUME: DB restore failed (non-fatal — starting with empty job list)");
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Find jobs that can be resumed
// ---------------------------------------------------------------------------

export interface ResumableJob {
  jobId:           string;
  url:             string;
  completedStages: MasterStageId[];
  resumeFromStage: MasterStageId | null;
  completedPct:    number;
  status:          string;
  startedAt:       string;
}

/**
 * Return jobs that have partial progress and can be resumed.
 * Excludes jobs that are fully complete.
 */
export async function findResumableJobs(): Promise<ResumableJob[]> {
  try {
    const records = await db
      .select()
      .from(orchestrationJobsTable)
      .where(or(
        eq(orchestrationJobsTable.status, "crawling"),
        eq(orchestrationJobsTable.status, "diffing"),
        eq(orchestrationJobsTable.status, "analyzing"),
        eq(orchestrationJobsTable.status, "generating"),
        eq(orchestrationJobsTable.status, "merging"),
        eq(orchestrationJobsTable.status, "deploying"),
        eq(orchestrationJobsTable.status, "failed"),
      ))
      .orderBy(desc(orchestrationJobsTable.createdAt))
      .limit(20);

    const resumable: ResumableJob[] = [];

    for (const record of records) {
      const job = reconstructJob(record);
      if (job.completedStages.length === 0) continue; // nothing to resume from

      const firstIncomplete = ALL_STAGE_IDS.find(
        (id) => !job.completedStages.includes(id) && !job.skippedStages.includes(id)
      ) ?? null;

      resumable.push({
        jobId:           job.id,
        url:             job.url,
        completedStages: job.completedStages,
        resumeFromStage: firstIncomplete,
        completedPct:    Math.round(((job.completedStages.length + job.skippedStages.length) / ALL_STAGE_IDS.length) * 100),
        status:          record.status,
        startedAt:       record.createdAt.toISOString(),
      });
    }

    return resumable;
  } catch (err) {
    logger.warn({ err }, "PIPELINE-RESUME: findResumableJobs failed");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Resume a pipeline
// ---------------------------------------------------------------------------

/**
 * Load job from DB (or memory), patch its status back to "pending",
 * and return it ready for runPipeline().
 *
 * runPipeline() will skip all stages already in completedStages.
 */
export async function buildResumeJob(jobId: string): Promise<{
  job: OrchestrationJob;
  resumeFromStage: MasterStageId | null;
}> {
  // Prefer in-memory (already restored) over DB round-trip
  let job = getJob(jobId) ?? await loadJobFromDB(jobId);

  if (!job) throw new Error(`Job ${jobId} not found in memory or DB`);

  // Re-register if it came from DB
  if (!getJob(jobId)) _registerJob(job);

  // Reset terminal status so runPipeline can proceed
  job.status       = "pending";
  job.error        = null;
  job.completedAt  = null;
  job.currentStage = null;

  const firstIncomplete = ALL_STAGE_IDS.find(
    (id) => !job!.completedStages.includes(id) && !job!.skippedStages.includes(id)
  ) ?? null;

  logger.info(
    {
      jobId,
      completedStages: job.completedStages,
      resumeFromStage: firstIncomplete,
      url: job.url,
    },
    "PIPELINE-RESUME: job ready for resume"
  );

  return { job, resumeFromStage: firstIncomplete };
}
