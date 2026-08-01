/**
 * one-click-reconstruction.ts — Phase 7.8: One-Click Reconstruction Engine
 *
 * Exposes the entire 11-stage pipeline through a single operation:
 *
 *   Input:  URL
 *   Output: Deployment URL
 *
 *   URL → Scrape → Manifest → Diff → Intelligence → DesignDNA
 *       → VisualDNA → Stencil → WebsitePrime → Merge → Deployment → Live Website
 *
 * Features:
 *   - Single POST kicks off the full pipeline
 *   - Optional blocking mode: wait for completion and return deployment URL
 *   - Tracks all one-click jobs with rich status
 *   - Generates one-click-reconstruction-report.json (disk + R2)
 *   - Integrates with Phase 7.7 failure recovery on non-blocking mode
 */

import { randomUUID }          from "crypto";
import { writeFile, readFile } from "fs/promises";
import { join }                from "path";
import { logger }              from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import {
  createJob,
  runPipeline,
  getJob,
  type OrchestrationJob,
} from "./master-orchestrator.js";
import { publishEvent } from "./event-bus.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OneClickStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "recovering";

export interface OneClickStageSnapshot {
  id:          string;
  label:       string;
  status:      string;
  durationMs:  number | null;
  error:       string | null;
}

export interface OneClickJob {
  id:              string;
  url:             string;
  pipelineJobId:   string;
  status:          OneClickStatus;
  deploymentUrl:   string | null;
  startedAt:       string;
  completedAt:     string | null;
  totalDurationMs: number | null;
  stages:          OneClickStageSnapshot[];
  error:           string | null;
  recoveryId:      string | null;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const _jobs = new Map<string, OneClickJob>();

export function getOneClickJob(id: string): OneClickJob | undefined {
  return _jobs.get(id);
}

export function listOneClickJobs(): OneClickJob[] {
  return Array.from(_jobs.values()).sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
}

// ---------------------------------------------------------------------------
// Snapshot helper
// ---------------------------------------------------------------------------

function snapshotStages(pipeline: OrchestrationJob): OneClickStageSnapshot[] {
  return pipeline.stages.map((s) => ({
    id:         s.id,
    label:      s.label,
    status:     s.status,
    durationMs: s.durationMs,
    error:      s.error,
  }));
}

function extractDeploymentUrl(pipeline: OrchestrationJob): string | null {
  const deployStage = pipeline.stages.find((s) => s.id === "deploy");
  if (!deployStage || deployStage.status !== "complete") return null;
  const meta = deployStage.metadata as Record<string, unknown>;
  if (typeof meta["deploymentUrl"] === "string") return meta["deploymentUrl"];
  return null;
}

// ---------------------------------------------------------------------------
// Polling watcher — keeps the OneClickJob in sync with the pipeline
// ---------------------------------------------------------------------------

async function watchPipeline(ocJob: OneClickJob, pipeline: OrchestrationJob): Promise<void> {
  const POLL_MS    = 3_000;
  const MAX_WAIT   = 30 * 60 * 1_000;  // 30 minute ceiling
  const startMs    = Date.now();

  while (Date.now() - startMs < MAX_WAIT) {
    await new Promise((r) => setTimeout(r, POLL_MS));

    const live = getJob(pipeline.id);
    if (!live) break;

    ocJob.stages = snapshotStages(live);

    if (live.status === "complete") {
      ocJob.status         = "complete";
      ocJob.deploymentUrl  = extractDeploymentUrl(live);
      ocJob.completedAt    = live.completedAt ?? new Date().toISOString();
      ocJob.totalDurationMs= live.totalDurationMs;
      ocJob.error          = null;

      publishEvent("deployment-complete", live.id, {
        oneClickJobId: ocJob.id,
        deploymentUrl: ocJob.deploymentUrl,
        durationMs:    ocJob.totalDurationMs,
      });

      logger.info(
        { oneClickJobId: ocJob.id, pipelineJobId: live.id, deploymentUrl: ocJob.deploymentUrl },
        "ONE-CLICK: reconstruction complete",
      );
      break;
    }

    if (live.status === "failed" || live.status === "cancelled") {
      ocJob.status         = "failed";
      ocJob.completedAt    = live.completedAt ?? new Date().toISOString();
      ocJob.totalDurationMs= live.totalDurationMs;
      ocJob.error          = live.error;
      ocJob.stages         = snapshotStages(live);

      logger.warn(
        { oneClickJobId: ocJob.id, pipelineJobId: live.id, error: live.error },
        "ONE-CLICK: reconstruction failed",
      );
      break;
    }

    // Still running — update stage snapshot
    ocJob.status = "running";
  }

  await persistReport();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LaunchOptions {
  url:        string;
  baseJobId?: string | null;
  /** If true, resolve only after the pipeline completes (up to timeoutMs). */
  waitForCompletion?: boolean;
  timeoutMs?: number;
}

export interface LaunchResult {
  oneClickJobId: string;
  pipelineJobId: string;
  url:           string;
  status:        OneClickStatus;
  deploymentUrl: string | null;
  startedAt:     string;
  pollUrl:       string;
  message:       string;
}

export async function launchReconstruction(opts: LaunchOptions): Promise<LaunchResult> {
  const { url, baseJobId, waitForCompletion = false, timeoutMs = 20 * 60 * 1_000 } = opts;

  const pipeline = createJob({ url, baseJobId });

  const ocJobId = randomUUID();
  const ocJob: OneClickJob = {
    id:              ocJobId,
    url,
    pipelineJobId:   pipeline.id,
    status:          "queued",
    deploymentUrl:   null,
    startedAt:       new Date().toISOString(),
    completedAt:     null,
    totalDurationMs: null,
    stages:          snapshotStages(pipeline),
    error:           null,
    recoveryId:      null,
  };

  _jobs.set(ocJobId, ocJob);

  publishEvent("job-started", pipeline.id, {
    oneClickJobId: ocJobId,
    url,
    mode: waitForCompletion ? "blocking" : "async",
  });

  logger.info(
    { oneClickJobId: ocJobId, pipelineJobId: pipeline.id, url, waitForCompletion },
    "ONE-CLICK: reconstruction launched",
  );

  // Start pipeline — always fire-and-forget from runPipeline perspective
  ocJob.status = "running";
  const pipelinePromise = runPipeline(pipeline);
  void watchPipeline(ocJob, pipeline);

  if (waitForCompletion) {
    // Race the pipeline against a timeout
    await Promise.race([
      pipelinePromise,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("One-click timeout exceeded")), timeoutMs),
      ),
    ]).catch((err) => {
      logger.warn({ oneClickJobId: ocJobId, err }, "ONE-CLICK: blocking wait timed out or failed");
    });

    // Sync status from completed pipeline
    const live = getJob(pipeline.id);
    if (live) {
      ocJob.stages         = snapshotStages(live);
      ocJob.status         = live.status === "complete" ? "complete" : "failed";
      ocJob.deploymentUrl  = extractDeploymentUrl(live);
      ocJob.completedAt    = live.completedAt;
      ocJob.totalDurationMs= live.totalDurationMs;
      ocJob.error          = live.error;
    }
  }

  await persistReport();

  return {
    oneClickJobId: ocJobId,
    pipelineJobId: pipeline.id,
    url,
    status:        ocJob.status,
    deploymentUrl: ocJob.deploymentUrl,
    startedAt:     ocJob.startedAt,
    pollUrl:       `/api/reconstruct/${ocJobId}`,
    message:       waitForCompletion
      ? `Reconstruction ${ocJob.status === "complete" ? "complete" : "failed"}.`
      : "Reconstruction launched. Poll pollUrl for live status.",
  };
}

// ---------------------------------------------------------------------------
// Report persistence
// ---------------------------------------------------------------------------

const REPORT_PATH    = join(process.cwd(), "one-click-reconstruction-report.json");
const REPORT_PATH_UP = join(process.cwd(), "..", "..", "one-click-reconstruction-report.json");

export async function persistReport(): Promise<void> {
  const jobs = listOneClickJobs();
  const report = {
    version:     "1.0",
    phase:       "7.8",
    generatedAt: new Date().toISOString(),
    pipeline: [
      "URL", "Scrape", "Manifest", "Diff", "Intelligence",
      "DesignDNA", "VisualDNA", "Stencil", "WebsitePrime",
      "Merge", "Deployment", "Live Website",
    ],
    summary: {
      total:     jobs.length,
      complete:  jobs.filter((j) => j.status === "complete").length,
      running:   jobs.filter((j) => j.status === "running").length,
      failed:    jobs.filter((j) => j.status === "failed").length,
      avgDurationMs: jobs.filter((j) => j.totalDurationMs !== null).length > 0
        ? Math.round(
            jobs.reduce((s, j) => s + (j.totalDurationMs ?? 0), 0) /
            jobs.filter((j) => j.totalDurationMs !== null).length,
          )
        : null,
      successfulDeployments: jobs.filter((j) => j.deploymentUrl !== null).length,
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
        key:            "orchestration/one-click-reconstruction-report.json",
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
