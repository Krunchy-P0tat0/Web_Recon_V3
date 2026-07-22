/**
 * orchestration-dashboard.ts — Phase 7.5 + 7.6 routes
 *
 * ── Phase 7.5: Execution Dashboard ─────────────────────────────────────────
 * GET  /api/orchestration/jobs                  — list all jobs (all sources)
 * GET  /api/orchestration/jobs/:id              — full job detail
 * GET  /api/orchestration/jobs/:id/logs         — events + SM history + approvals
 * GET  /api/orchestration/jobs/:id/stages       — stage breakdown + metrics
 * GET  /api/orchestration/jobs/:id/metrics      — performance metrics only
 * GET  /api/orchestration/dashboard             — latest dashboard-report.json
 * POST /api/orchestration/dashboard/generate    — regenerate dashboard-report.json
 *
 * ── Phase 7.6: Live Event Stream ───────────────────────────────────────────
 * GET  /api/orchestration/events                — SSE: all pipeline events
 * GET  /api/orchestration/events/:jobId         — SSE: events for one job
 * GET  /api/orchestration/events/history        — buffered events (JSON, no SSE)
 * GET  /api/orchestration/events/report         — event-stream-report.json
 */

import { Router, type Request, type Response, type IRouter } from "express";
import {
  listDashboardJobs,
  getDashboardJob,
  getJobLogs,
  generateDashboardReport,
  loadDashboardReport,
} from "../lib/orchestration-dashboard.js";
import { eventBus, persistEventReport } from "../lib/event-bus.js";
import type { PipelineEvent } from "../lib/event-bus.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Phase 7.5 — Execution Dashboard
// ---------------------------------------------------------------------------

// GET /orchestration/jobs
router.get("/orchestration/jobs", async (_req, res): Promise<void> => {
  try {
    const jobs = await listDashboardJobs();
    res.json({
      total:   jobs.length,
      running: jobs.filter((j) => j.status === "running").length,
      jobs:    jobs.map((j) => ({
        pipelineJobId:   j.pipelineJobId,
        url:             j.url,
        source:          j.source,
        status:          j.status,
        smState:         j.smState,
        paused:          j.paused,
        currentStage:    j.currentStage,
        startedAt:       j.startedAt,
        completedAt:     j.completedAt,
        totalDurationMs: j.totalDurationMs,
        error:           j.error,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /orchestration/jobs/:id
router.get("/orchestration/jobs/:id", async (req, res): Promise<void> => {
  try {
    const job = await getDashboardJob(req.params["id"] ?? "");
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /orchestration/jobs/:id/logs
router.get("/orchestration/jobs/:id/logs", (req, res): void => {
  const logs = getJobLogs(req.params["id"] ?? "");
  res.json({
    pipelineJobId:  logs.pipelineJobId,
    totalEvents:    logs.events.length,
    totalTransitions: logs.stageHistory.length,
    totalApprovals: logs.approvals.length,
    events:         logs.events,
    stageHistory:   logs.stageHistory,
    approvals:      logs.approvals,
  });
});

// GET /orchestration/jobs/:id/stages
router.get("/orchestration/jobs/:id/stages", async (req, res): Promise<void> => {
  try {
    const job = await getDashboardJob(req.params["id"] ?? "");
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    res.json({
      pipelineJobId:   job.pipelineJobId,
      status:          job.status,
      currentStage:    job.currentStage,
      completedCount:  job.metrics.stagesComplete,
      failedCount:     job.metrics.stagesFailed,
      skippedCount:    job.metrics.stagesSkipped,
      totalCount:      job.metrics.stagesTotal,
      stages:          job.stages,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /orchestration/jobs/:id/metrics
router.get("/orchestration/jobs/:id/metrics", async (req, res): Promise<void> => {
  try {
    const job = await getDashboardJob(req.params["id"] ?? "");
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    res.json({
      pipelineJobId: job.pipelineJobId,
      url:           job.url,
      status:        job.status,
      metrics:       job.metrics,
      stageSummary:  job.stages.map((s) => ({
        id:         s.id,
        status:     s.status,
        durationMs: s.durationMs,
        retries:    s.retryCount,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /orchestration/dashboard — latest snapshot
router.get("/orchestration/dashboard", async (_req, res): Promise<void> => {
  const report = await loadDashboardReport();
  if (report) { res.json(report); return; }

  // Generate on-demand if not cached
  try {
    const fresh = await generateDashboardReport();
    res.json(fresh);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /orchestration/dashboard/generate — force regenerate
router.post("/orchestration/dashboard/generate", async (_req, res): Promise<void> => {
  try {
    const report = await generateDashboardReport();
    res.json({ generated: true, report });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// Phase 7.6 — Live Event Stream (SSE)
// ---------------------------------------------------------------------------

function sseHeaders(res: Response): void {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");   // disable nginx buffering
  res.flushHeaders();
}

function sendSseEvent(res: Response, event: PipelineEvent): void {
  res.write(`id: ${event.id}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function sendSseComment(res: Response): void {
  res.write(": heartbeat\n\n");
}

// GET /orchestration/events/history — buffered events as JSON (non-SSE)
// NOTE: must be registered BEFORE the :jobId SSE route to avoid "history" being captured as a param
router.get("/orchestration/events/history", (req, res): void => {
  const rawQuery = req.query as Record<string, string | string[] | undefined>;
  const jobId  = Array.isArray(rawQuery["jobId"])  ? rawQuery["jobId"][0]  : rawQuery["jobId"];
  const type   = Array.isArray(rawQuery["type"])   ? rawQuery["type"][0]   : rawQuery["type"];
  const limit  = Array.isArray(rawQuery["limit"])  ? rawQuery["limit"][0]  : rawQuery["limit"];
  let events = eventBus.getBuffer(jobId);
  if (type) events = events.filter((e) => e.type === type);
  const n = Math.min(parseInt(limit ?? "100", 10) || 100, 500);
  res.json({
    total:   events.length,
    showing: Math.min(n, events.length),
    events:  events.slice(-n),
  });
});

// GET /orchestration/events/report — event-stream-report.json
// NOTE: must be registered BEFORE the :jobId SSE route
router.get("/orchestration/events/report", async (_req, res): Promise<void> => {
  await persistEventReport().catch(() => {});
  const events = eventBus.getBuffer();
  res.json({
    version:     "1.0",
    phase:       "7.6",
    generatedAt: new Date().toISOString(),
    totalEvents: events.length,
    summary:     eventBus.getSummary(),
    events:      events.slice(-200),
  });
});

// GET /orchestration/events — SSE: all events
router.get("/orchestration/events", (req: Request, res: Response): void => {
  sseHeaders(res);

  // Replay last 20 buffered events for the new client
  const history = eventBus.getBuffer().slice(-20);
  for (const e of history) sendSseEvent(res, e);

  const listener = (e: PipelineEvent) => sendSseEvent(res, e);
  eventBus.on("event", listener);

  // Heartbeat every 15s so the connection stays alive through proxies
  const heartbeat = setInterval(() => sendSseComment(res), 15_000);

  req.on("close", () => {
    eventBus.off("event", listener);
    clearInterval(heartbeat);
  });
});

// GET /orchestration/events/:jobId — SSE: events for one job
// NOTE: parameterized route last so static paths above are matched first
router.get("/orchestration/events/:jobId", (req: Request, res: Response): void => {
  const jobId = (req.params["jobId"] as string) ?? "";
  sseHeaders(res);

  // Replay job-specific history
  const history = eventBus.getBuffer(jobId).slice(-20);
  for (const e of history) sendSseEvent(res, e);

  const listener = (e: PipelineEvent) => sendSseEvent(res, e);
  eventBus.on(`job:${jobId}`, listener);

  const heartbeat = setInterval(() => sendSseComment(res), 15_000);
  req.on("close", () => {
    eventBus.off(`job:${jobId}`, listener);
    clearInterval(heartbeat);
  });
});

export default router;
