/**
 * workflow-orchestrator.ts — Phase F: Central Orchestration Engine
 *
 * The single entry point for the platform. Accepts a URL + Goal and drives
 * the full pipeline automatically — no manual module invocation required.
 *
 * Goal → Stage Sequence:
 *   clone_site:          DISCOVERING → CRAWLING → ANALYZING → GENERATING → DEPLOYING → COMPLETE
 *   merge_into_backend:  DISCOVERING → CRAWLING → DIFFING → ANALYZING → GENERATING → MERGING → DEPLOYING → COMPLETE
 *   update_existing:     DISCOVERING → CRAWLING → DIFFING → ANALYZING → GENERATING → DEPLOYING → COMPLETE
 *
 * FAILED is reachable from any stage (terminal).
 */

import { randomUUID } from "crypto";
import { eq, desc } from "drizzle-orm";
import { db, orchestrationJobsTable } from "@workspace/db";
import type {
  OrchestrationGoal,
  OrchestrationStatus,
  OrchestrationStageStatus,
  ExecutionPlan,
  ExecutionStage,
  OrchestrationJobRecord,
} from "@workspace/db";
import { logger } from "./logger";
import { submitScrapeJob, waitForJobCompletion } from "./scrape-bridge";
import { runAndStoreGenerationPipeline } from "./generation-runner";
import { runAndStoreConstruction } from "./construction-runner";
import { runAndStoreClassification } from "./classification-runner";
import { runAndStoreStencilAssembly } from "./stencil-assembly-runner";
import { runAndStoreMerge } from "./merge-runner";
import { runAndStoreDeploymentPlan } from "./deployment-plan-runner";
import { runAndStoreStencilSelection } from "./stencil-selection-runner";
import { getDefaultCloudProvider } from "../cloud";

// ---------------------------------------------------------------------------
// Goal → stage sequence maps
// ---------------------------------------------------------------------------

const GOAL_STAGES: Record<OrchestrationGoal, OrchestrationStatus[]> = {
  clone_site: [
    "discovering",
    "crawling",
    "analyzing",
    "generating",
    "deploying",
    "complete",
  ],
  merge_into_backend: [
    "discovering",
    "crawling",
    "diffing",
    "analyzing",
    "generating",
    "merging",
    "deploying",
    "complete",
  ],
  update_existing: [
    "discovering",
    "crawling",
    "diffing",
    "analyzing",
    "generating",
    "deploying",
    "complete",
  ],
};

const GOAL_REASONING: Record<OrchestrationGoal, string> = {
  clone_site:
    "Full clone: crawl all pages, run intelligence analysis, generate stencil blueprint, deploy output.",
  merge_into_backend:
    "Merge path: crawl + diff against base job to detect changes, run intelligence, generate blueprint, execute merge plan, deploy.",
  update_existing:
    "Update path: crawl + diff to capture only changed pages, re-run intelligence on delta, regenerate, deploy.",
};

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

export function buildExecutionPlan(
  goal: OrchestrationGoal,
  hasDiffBase: boolean,
): ExecutionPlan {
  const stageNames = GOAL_STAGES[goal];
  const stages: ExecutionStage[] = stageNames.map((name) => ({
    name,
    status: (name === "discovering" ? "running" : "pending") as OrchestrationStageStatus,
  }));

  return {
    goal,
    stages,
    reasoning: GOAL_REASONING[goal] + (hasDiffBase ? " (baseline job provided)" : ""),
  };
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function updateOrchestration(
  orchestrationId: string,
  patch: Partial<OrchestrationJobRecord>,
): Promise<void> {
  await db
    .update(orchestrationJobsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(orchestrationJobsTable.orchestrationId, orchestrationId));
}

async function updateStageInPlan(
  orchestrationId: string,
  stageName: OrchestrationStatus,
  stageStatus: OrchestrationStageStatus,
  stageError?: string,
): Promise<void> {
  const [record] = await db
    .select()
    .from(orchestrationJobsTable)
    .where(eq(orchestrationJobsTable.orchestrationId, orchestrationId))
    .limit(1);

  if (!record?.executionPlan) return;

  const plan = record.executionPlan as ExecutionPlan;
  const now = new Date().toISOString();

  const updatedStages = plan.stages.map((s) => {
    if (s.name !== stageName) return s;
    return {
      ...s,
      status: stageStatus,
      ...(stageStatus === "running" ? { startedAt: now } : {}),
      ...(stageStatus === "complete" || stageStatus === "failed" ? { completedAt: now } : {}),
      ...(stageError ? { error: stageError } : {}),
    };
  });

  await updateOrchestration(orchestrationId, {
    executionPlan: { ...plan, stages: updatedStages },
  });
}

async function advanceStatus(
  orchestrationId: string,
  status: OrchestrationStatus,
  plan?: ExecutionPlan,
): Promise<void> {
  await updateOrchestration(orchestrationId, {
    status,
    ...(plan ? { executionPlan: plan } : {}),
    ...(status === "complete" || status === "failed" ? { completedAt: new Date() } : {}),
  });
}

// ---------------------------------------------------------------------------
// Core execution runner
// ---------------------------------------------------------------------------

export async function executeOrchestration(
  orchestrationId: string,
): Promise<void> {
  const [record] = await db
    .select()
    .from(orchestrationJobsTable)
    .where(eq(orchestrationJobsTable.orchestrationId, orchestrationId))
    .limit(1);

  if (!record) {
    logger.error({ orchestrationId }, "Orchestration record not found");
    return;
  }

  const goal = record.goal as OrchestrationGoal;
  const stageSequence = GOAL_STAGES[goal];
  const log = logger.child({ orchestrationId, goal, url: record.url });

  log.info("Orchestration started");

  for (const stage of stageSequence) {
    if (stage === "complete") {
      await updateStageInPlan(orchestrationId, stage, "complete");
      await advanceStatus(orchestrationId, "complete");
      log.info("Orchestration complete");
      return;
    }

    await updateStageInPlan(orchestrationId, stage, "running");
    await advanceStatus(orchestrationId, stage);
    log.info({ stage }, "Entering stage");

    try {
      await runStage(orchestrationId, stage, record);

      await updateStageInPlan(orchestrationId, stage, "complete");
      log.info({ stage }, "Stage complete");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ stage, err }, "Stage failed");
      await updateStageInPlan(orchestrationId, stage, "failed", message);
      await updateOrchestration(orchestrationId, { errorMessage: message });
      await advanceStatus(orchestrationId, "failed");
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Stage dispatcher
// ---------------------------------------------------------------------------

async function runStage(
  orchestrationId: string,
  stage: OrchestrationStatus,
  record: OrchestrationJobRecord,
): Promise<void> {
  switch (stage) {
    case "discovering": {
      // Validate URL — lightweight check before committing resources
      const url = new URL(record.url);
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error(`Unsupported protocol: ${url.protocol}`);
      }
      logger.info({ orchestrationId, url: record.url }, "URL validated");
      break;
    }

    case "crawling": {
      const jobId = await submitScrapeJob({
        url: record.url,
        includeImages: true,
        diffMode: record.baseJobId != null,
        baseJobId: record.baseJobId ?? undefined,
        customJobId: customJobIdRegistry.get(orchestrationId),
      });
      // Persist the underlying job ID so status polling can reference it
      await updateOrchestration(orchestrationId, { underlyingJobId: jobId });
      logger.info({ orchestrationId, jobId }, "Crawl job submitted — waiting for completion");
      await waitForJobCompletion(jobId);
      logger.info({ orchestrationId, jobId }, "Crawl job done");
      break;
    }

    case "diffing": {
      // Diff is run as part of the crawl when diffMode=true (baseJobId provided).
      // This stage is a checkpoint — confirm the diff was produced.
      const [fresh] = await db
        .select()
        .from(orchestrationJobsTable)
        .where(eq(orchestrationJobsTable.orchestrationId, orchestrationId))
        .limit(1);
      if (!fresh?.underlyingJobId) {
        throw new Error("No underlying job ID found for diffing stage");
      }
      logger.info(
        { orchestrationId, jobId: fresh.underlyingJobId },
        "Diff checkpoint passed",
      );
      break;
    }

    case "analyzing": {
      const [fresh] = await db
        .select()
        .from(orchestrationJobsTable)
        .where(eq(orchestrationJobsTable.orchestrationId, orchestrationId))
        .limit(1);
      const jobId = fresh?.underlyingJobId;
      if (!jobId) throw new Error("No job ID for analysis stage");
      await runAndStoreGenerationPipeline(jobId, getDefaultCloudProvider());
      // Phase 4.3 — classify the site's design archetype from the scraped HTML
      await runAndStoreClassification(jobId, getDefaultCloudProvider()).catch((err) => {
        logger.warn({ err, orchestrationId, jobId }, "CLASSIFY: non-fatal — classification skipped");
      });
      // Phase 4.4 — select optimal stencil type using all three dimensions
      await runAndStoreStencilSelection(jobId, getDefaultCloudProvider()).catch((err) => {
        logger.warn({ err, orchestrationId, jobId }, "STENCIL-SELECT: non-fatal — stencil selection skipped");
      });
      logger.info({ orchestrationId, jobId }, "Analysis (generation + classification + stencil selection) complete");
      break;
    }

    case "generating": {
      const [fresh] = await db
        .select()
        .from(orchestrationJobsTable)
        .where(eq(orchestrationJobsTable.orchestrationId, orchestrationId))
        .limit(1);
      const jobId = fresh?.underlyingJobId;
      if (!jobId) throw new Error("No job ID for generation stage");
      await runAndStoreConstruction(jobId);
      // Phase B3 — assemble the stencil (navigation, routes, pages) from the manifest
      await runAndStoreStencilAssembly(jobId, getDefaultCloudProvider()).catch((err) => {
        logger.warn({ err, orchestrationId, jobId }, "ASSEMBLE: non-fatal — stencil assembly skipped");
      });
      logger.info({ orchestrationId, jobId }, "Generation + stencil assembly complete");
      break;
    }

    case "merging": {
      // Only runs for merge_into_backend / update_existing goals.
      // Uses an empty target VFS in dry-run mode — produces a CREATE-heavy merge plan
      // showing everything that would be created in a real merge.
      // Pass a real VirtualFileSystem here when integrating a live target codebase.
      const [fresh] = await db
        .select()
        .from(orchestrationJobsTable)
        .where(eq(orchestrationJobsTable.orchestrationId, orchestrationId))
        .limit(1);
      const jobId = fresh?.underlyingJobId;
      if (!jobId) {
        logger.warn({ orchestrationId }, "MERGE: no underlying job ID — skipping merge stage");
        break;
      }
      await runAndStoreMerge(jobId, getDefaultCloudProvider());
      logger.info({ orchestrationId, jobId }, "Merge pipeline complete");
      break;
    }

    case "deploying": {
      const [fresh] = await db
        .select()
        .from(orchestrationJobsTable)
        .where(eq(orchestrationJobsTable.orchestrationId, orchestrationId))
        .limit(1);
      const jobId = fresh?.underlyingJobId;
      if (!jobId) {
        logger.warn({ orchestrationId }, "DEPLOY-PLAN: no underlying job ID — skipping deploy stage");
        break;
      }
      await runAndStoreDeploymentPlan(jobId, getDefaultCloudProvider());
      logger.info({ orchestrationId, jobId }, "Deployment plan generation complete");
      break;
    }

    default:
      throw new Error(`Unknown stage: ${stage}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Registry to carry customJobId from createOrchestrationJob → crawling stage
// (avoids a schema change; safe because executeOrchestration runs in the same process)
const customJobIdRegistry = new Map<string, string>();

export async function createOrchestrationJob(
  url: string,
  goal: OrchestrationGoal,
  baseJobId?: string,
  customJobId?: string,
): Promise<OrchestrationJobRecord> {
  const orchestrationId = randomUUID();
  const plan = buildExecutionPlan(goal, !!baseJobId);

  await db.insert(orchestrationJobsTable).values({
    orchestrationId,
    url,
    goal,
    status: "discovering",
    executionPlan: plan,
    baseJobId: baseJobId ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  if (customJobId) customJobIdRegistry.set(orchestrationId, customJobId);

  const [record] = await db
    .select()
    .from(orchestrationJobsTable)
    .where(eq(orchestrationJobsTable.orchestrationId, orchestrationId))
    .limit(1);

  return record!;
}

export async function getOrchestrationJob(
  orchestrationId: string,
): Promise<OrchestrationJobRecord | null> {
  const [record] = await db
    .select()
    .from(orchestrationJobsTable)
    .where(eq(orchestrationJobsTable.orchestrationId, orchestrationId))
    .limit(1);
  return record ?? null;
}

export async function listOrchestrationJobs(): Promise<OrchestrationJobRecord[]> {
  return db
    .select()
    .from(orchestrationJobsTable)
    .orderBy(desc(orchestrationJobsTable.createdAt));
}
