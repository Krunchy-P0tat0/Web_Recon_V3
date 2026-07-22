/**
 * master-orchestration.ts — Phase 7.1 Master Orchestration routes
 *
 * One endpoint launches the entire 12-stage reconstruction pipeline:
 *
 *   POST /api/pipeline              — launch full pipeline from a URL
 *   GET  /api/pipeline              — list all pipeline jobs
 *   GET  /api/pipeline/engine       — orchestration-engine.json (latest job)
 *   GET  /api/pipeline/audit        — orchestration-audit.json (all jobs)
 *   GET  /api/pipeline/:id          — get specific job status + stage breakdown
 *   GET  /api/pipeline/:id/stages   — get all stage results for a job
 *   GET  /api/pipeline/:id/stage/:stageId — get one stage result
 */

import { Router, type IRouter } from "express";
import {
  createJob,
  runPipeline,
  getJob,
  listJobs,
  readEngineFile,
  readAuditFile,
} from "../lib/master-orchestrator.js";
import type { MasterStageId } from "../lib/master-orchestrator.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /pipeline — launch the full pipeline
// ---------------------------------------------------------------------------

router.post("/pipeline", async (req, res): Promise<void> => {
  const { url, baseJobId } = (req.body ?? {}) as {
    url?:       string;
    baseJobId?: string | null;
  };

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url is required" });
    return;
  }

  try { new URL(url); } catch {
    res.status(400).json({ error: "url must be a valid URL" });
    return;
  }

  const job = createJob({ url, baseJobId });

  req.log.info(
    { pipelineJobId: job.id, url, includeDiff: job.includeDiff },
    "PIPELINE: job created — launching"
  );

  // Fire-and-forget — caller polls GET /pipeline/:id
  runPipeline(job).catch((err) => {
    req.log.error({ pipelineJobId: job.id, err }, "PIPELINE: unhandled pipeline error");
  });

  res.status(202).json({
    pipelineJobId:   job.id,
    url:             job.url,
    status:          job.status,
    stages:          job.stages.map((s) => ({ id: s.id, label: s.label, status: s.status })),
    startedAt:       job.startedAt,
    pollUrl:         `/api/pipeline/${job.id}`,
    message:         "Pipeline launched. Poll pollUrl for progress.",
  });
});

// ---------------------------------------------------------------------------
// GET /pipeline — list all jobs
// ---------------------------------------------------------------------------

router.get("/pipeline", (_req, res): void => {
  const jobs = listJobs();
  res.json({
    total: jobs.length,
    jobs:  jobs.map((j) => ({
      id:              j.id,
      url:             j.url,
      status:          j.status,
      currentStage:    j.currentStage,
      completedStages: j.completedStages,
      failedStages:    j.failedStages,
      startedAt:       j.startedAt,
      completedAt:     j.completedAt,
      totalDurationMs: j.totalDurationMs,
      error:           j.error,
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /pipeline/engine — orchestration-engine.json
// ---------------------------------------------------------------------------

router.get("/pipeline/engine", async (_req, res): Promise<void> => {
  // Try in-memory latest first
  const jobs   = listJobs();
  const latest = jobs[0];
  if (latest) {
    res.json(latest);
    return;
  }

  const fromDisk = await readEngineFile();
  if (fromDisk) {
    res.json(fromDisk);
    return;
  }

  res.status(404).json({
    error: "No orchestration-engine.json yet. POST /api/pipeline to start the pipeline.",
  });
});

// ---------------------------------------------------------------------------
// GET /pipeline/audit — orchestration-audit.json
// ---------------------------------------------------------------------------

router.get("/pipeline/audit", async (_req, res): Promise<void> => {
  const jobs  = listJobs();
  if (jobs.length > 0) {
    res.json({
      version:     "1.0",
      generatedAt: new Date().toISOString(),
      total:       jobs.length,
      summary: {
        complete: jobs.filter((j) => j.status === "complete").length,
        failed:   jobs.filter((j) => j.status === "failed").length,
        running:  jobs.filter((j) => j.status === "running").length,
        pending:  jobs.filter((j) => j.status === "pending").length,
      },
      jobs,
    });
    return;
  }

  const fromDisk = await readAuditFile();
  if (fromDisk) {
    res.json(fromDisk);
    return;
  }

  res.status(404).json({
    error: "No orchestration-audit.json yet. POST /api/pipeline to start the pipeline.",
  });
});

// ---------------------------------------------------------------------------
// GET /pipeline/:id — full job detail
// ---------------------------------------------------------------------------

router.get("/pipeline/:id", (req, res): void => {
  const job = getJob(req.params["id"] ?? "");
  if (!job) {
    res.status(404).json({ error: "Pipeline job not found" });
    return;
  }
  res.json(job);
});

// ---------------------------------------------------------------------------
// GET /pipeline/:id/stages — all stages for a job
// ---------------------------------------------------------------------------

router.get("/pipeline/:id/stages", (req, res): void => {
  const job = getJob(req.params["id"] ?? "");
  if (!job) {
    res.status(404).json({ error: "Pipeline job not found" });
    return;
  }
  res.json({
    pipelineJobId:   job.id,
    status:          job.status,
    currentStage:    job.currentStage,
    completedStages: job.completedStages,
    failedStages:    job.failedStages,
    skippedStages:   job.skippedStages,
    stages:          job.stages,
  });
});

// ---------------------------------------------------------------------------
// GET /pipeline/:id/stage/:stageId — single stage detail
// ---------------------------------------------------------------------------

router.get("/pipeline/:id/stage/:stageId", (req, res): void => {
  const job     = getJob(req.params["id"] ?? "");
  const stageId = req.params["stageId"] as MasterStageId;

  if (!job) {
    res.status(404).json({ error: "Pipeline job not found" });
    return;
  }

  const stage = job.stages.find((s) => s.id === stageId);
  if (!stage) {
    res.status(404).json({ error: `Stage '${stageId}' not found` });
    return;
  }

  res.json({ pipelineJobId: job.id, stage });
});

export default router;
