/**
 * one-click-reconstruction.ts — Phase 7.8 HTTP Routes
 *
 * POST /api/reconstruct              — launch full pipeline from a URL
 * GET  /api/reconstruct              — list all one-click jobs
 * GET  /api/reconstruct/report       — one-click-reconstruction-report.json
 * POST /api/reconstruct/report/generate — force regenerate report
 * GET  /api/reconstruct/:id          — poll a specific one-click job
 * GET  /api/reconstruct/:id/stages   — live stage breakdown
 */

import { Router, type IRouter } from "express";
import {
  launchReconstruction,
  listOneClickJobs,
  getOneClickJob,
  persistReport,
  loadReport,
} from "../lib/one-click-reconstruction.js";

const router: IRouter = Router();

// GET /reconstruct/report — static routes must come before /:id
router.get("/reconstruct/report", async (_req, res): Promise<void> => {
  try {
    const cached = await loadReport();
    if (cached) { res.json(cached); return; }
    await persistReport();
    const fresh = await loadReport();
    res.json(fresh ?? { jobs: [], summary: {} });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /reconstruct/report/generate
router.post("/reconstruct/report/generate", async (_req, res): Promise<void> => {
  try {
    await persistReport();
    const report = await loadReport();
    res.json({ generated: true, report });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /reconstruct — list all one-click jobs
router.get("/reconstruct", (_req, res): void => {
  const jobs = listOneClickJobs();
  res.json({
    total:    jobs.length,
    complete: jobs.filter((j) => j.status === "complete").length,
    running:  jobs.filter((j) => j.status === "running").length,
    failed:   jobs.filter((j) => j.status === "failed").length,
    jobs:     jobs.map((j) => ({
      id:              j.id,
      url:             j.url,
      pipelineJobId:   j.pipelineJobId,
      status:          j.status,
      deploymentUrl:   j.deploymentUrl,
      startedAt:       j.startedAt,
      completedAt:     j.completedAt,
      totalDurationMs: j.totalDurationMs,
      error:           j.error,
    })),
  });
});

// POST /reconstruct — launch one-click reconstruction
router.post("/reconstruct", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as {
    url?:               string;
    baseJobId?:         string | null;
    wait?:              boolean;
    timeoutMs?:         number;
  };

  const { url, baseJobId, wait = false, timeoutMs } = body;

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url is required" });
    return;
  }

  try { new URL(url); } catch {
    res.status(400).json({ error: "url must be a valid URL" });
    return;
  }

  try {
    const result = await launchReconstruction({
      url,
      baseJobId,
      waitForCompletion: wait,
      timeoutMs: timeoutMs ?? (wait ? 20 * 60 * 1_000 : undefined),
    });

    const status = result.status === "complete" ? 200 : 202;
    res.status(status).json({
      oneClickJobId: result.oneClickJobId,
      pipelineJobId: result.pipelineJobId,
      url:           result.url,
      status:        result.status,
      deploymentUrl: result.deploymentUrl,
      startedAt:     result.startedAt,
      pollUrl:       result.pollUrl,
      message:       result.message,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /reconstruct/:id
router.get("/reconstruct/:id", (req, res): void => {
  const job = getOneClickJob(req.params["id"] ?? "");
  if (!job) {
    res.status(404).json({ error: "One-click job not found" });
    return;
  }
  res.json(job);
});

// GET /reconstruct/:id/stages
router.get("/reconstruct/:id/stages", (req, res): void => {
  const job = getOneClickJob(req.params["id"] ?? "");
  if (!job) {
    res.status(404).json({ error: "One-click job not found" });
    return;
  }
  res.json({
    oneClickJobId: job.id,
    pipelineJobId: job.pipelineJobId,
    status:        job.status,
    currentStage:  job.stages.find((s) => s.status === "running")?.id ?? null,
    complete:      job.stages.filter((s) => s.status === "complete").length,
    failed:        job.stages.filter((s) => s.status === "failed").length,
    total:         job.stages.length,
    stages:        job.stages,
  });
});

export default router;
