/**
 * routes/jobs.ts — Job Control Center HTTP endpoints
 *
 * Wires the pre-existing Phase F5 Job Dashboard engine (lib/job-dashboard.ts)
 * and related engines (scrape-bridge, manifest-store/export, website-prime
 * indexer, event-bus) to HTTP so the Jobs page can read + control every job.
 *
 * GET  /jobs                              — all job sets (running/queued/etc. derive from these)
 * GET  /jobs/summary                      — aggregate dashboard report
 * GET  /jobs/:jobId                       — single job detail
 * GET  /jobs/:jobId/logs                  — buffered pipeline events for a job
 * GET  /jobs/:jobId/manifest              — download the job's manifest as JSON
 * GET  /jobs/:jobId/manifest/summary       — manifest progress/validation snapshot (Manifest Center)
 * POST /jobs/:jobId/pause                 — pause a running/queued/failed job
 * POST /jobs/:jobId/resume                — resume a paused job
 * POST /jobs/:jobId/retry                 — retry a job (resets retry counter)
 * POST /jobs/:jobId/cancel                — cancel a job
 * POST /jobs/:jobId/clone                 — start a fresh job with the same seed URL/options
 * POST /jobs/:jobId/run-diff              — start a differential crawl against this job as baseline
 * POST /jobs/:jobId/generate-website-prime — run the Website Prime generator pipeline for this job
 */

import os from "os";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  getAllJobSets,
  getJobDetails,
  buildDashboardReport,
  pauseJob,
  resumeJob,
  retryJob,
  cancelJob,
} from "../lib/job-dashboard.js";
import { getJobRecord } from "../lib/db-queue.js";
import { submitScrapeJob } from "../lib/scrape-bridge.js";
import { loadManifest, loadManifestSnapshotMeta } from "../lib/manifest-store.js";
import { renderManifestJson } from "../lib/manifest-export.js";
import { runAndStoreGenerationPipeline } from "../lib/generation-runner.js";
import { runAndStoreConstruction } from "../lib/construction-runner.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import { db, generationReportsTable, constructionReportsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { eventBus } from "../lib/event-bus.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Express types `req.params[k]` as `string | string[]` in some route configs; jobIds are always singular. */
function jobIdParam(req: Request): string {
  const v = req.params.jobId;
  return Array.isArray(v) ? v[0] : v;
}

// ---------------------------------------------------------------------------
// GET /jobs — all job sets (Running / Queued / Completed / Failed / Paused / …)
// ---------------------------------------------------------------------------

router.get("/jobs", async (_req: Request, res: Response) => {
  try {
    const jobSets = await getAllJobSets();
    res.json({ ok: true, data: jobSets });
  } catch (err) {
    logger.error({ err }, "ROUTE: /jobs failed");
    res.status(500).json({ ok: false, error: "Failed to load job sets" });
  }
});

router.get("/jobs/summary", async (_req: Request, res: Response) => {
  try {
    const report = await buildDashboardReport();
    res.json({ ok: true, data: report });
  } catch (err) {
    logger.error({ err }, "ROUTE: /jobs/summary failed");
    res.status(500).json({ ok: false, error: "Failed to build dashboard summary" });
  }
});

// ---------------------------------------------------------------------------
// GET /jobs/system/resources — real server-wide Memory/CPU snapshot
//
// NOTE: jobs run as tasks inside this shared Node process/worker pool, not as
// isolated OS processes, so there is no true per-job memory/CPU figure to
// report. This exposes the real process-wide numbers instead of fabricating
// a per-job value.
// ---------------------------------------------------------------------------

router.get("/jobs/system/resources", (_req: Request, res: Response) => {
  const mem = process.memoryUsage();
  const [load1, load5, load15] = os.loadavg();
  res.json({
    ok: true,
    data: {
      memory: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        systemFreeBytes: os.freemem(),
        systemTotalBytes: os.totalmem(),
      },
      cpu: {
        loadAvg1m: load1,
        loadAvg5m: load5,
        loadAvg15m: load15,
        cpuCount: os.cpus().length,
      },
      scope: "process-wide (jobs share this worker pool; no per-job isolation exists)",
      sampledAt: new Date().toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /jobs/:jobId — single job detail
// ---------------------------------------------------------------------------

router.get("/jobs/:jobId", async (req: Request, res: Response) => {
  const jobId = jobIdParam(req);
  try {
    const detail = await getJobDetails(jobId);
    if (!detail) {
      res.status(404).json({ ok: false, error: `Job not found: ${jobId}` });
      return;
    }
    res.json({ ok: true, data: detail });
  } catch (err) {
    logger.error({ err, jobId }, "ROUTE: /jobs/:jobId failed");
    res.status(500).json({ ok: false, error: "Failed to load job detail" });
  }
});

// ---------------------------------------------------------------------------
// GET /jobs/:jobId/logs — buffered pipeline events (View Logs)
// ---------------------------------------------------------------------------

router.get("/jobs/:jobId/logs", (req: Request, res: Response) => {
  const events = eventBus.getBuffer(jobIdParam(req));
  res.json({ ok: true, data: events });
});

// ---------------------------------------------------------------------------
// GET /jobs/:jobId/manifest — download manifest JSON (Export Manifest)
// ---------------------------------------------------------------------------

router.get("/jobs/:jobId/manifest", async (req: Request, res: Response) => {
  const jobId = jobIdParam(req);
  try {
    const manifest = await loadManifest(jobId);
    if (!manifest) {
      res.status(404).json({ ok: false, error: `No manifest found for job ${jobId}` });
      return;
    }
    const json = renderManifestJson(manifest);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${jobId}-manifest.json"`);
    res.send(json);
  } catch (err) {
    logger.error({ err, jobId }, "ROUTE: /jobs/:jobId/manifest failed");
    res.status(500).json({ ok: false, error: "Failed to export manifest" });
  }
});

// ---------------------------------------------------------------------------
// GET /jobs/:jobId/manifest/summary — progress/validation snapshot (Manifest Center)
//
// Reads the persisted manifest (manifest-store.ts) that the pipeline already
// writes on every phase transition — no new computation, just a compact
// projection of fields that already exist on the Manifest/ManifestStats.
// ---------------------------------------------------------------------------

router.get("/jobs/:jobId/manifest/summary", async (req: Request, res: Response) => {
  const jobId = jobIdParam(req);
  try {
    const [manifest, meta] = await Promise.all([
      loadManifest(jobId),
      loadManifestSnapshotMeta(jobId),
    ]);
    if (!manifest) {
      res.status(404).json({ ok: false, error: `No manifest found for job ${jobId}` });
      return;
    }
    const totalNodes = manifest.stats.totalNodes;
    const completedNodes = manifest.stats.byStatus["complete"] ?? 0;
    const progressPercent = totalNodes > 0 ? Math.round((completedNodes / totalNodes) * 100) : 0;

    res.json({
      ok: true,
      data: {
        jobId,
        manifestStatus: manifest.status,
        schemaVersion: meta?.schemaVersion ?? "1.0",
        renderSource: meta?.renderSource ?? manifest.stats.renderSource ?? null,
        updatedAt: meta?.updatedAt ?? manifest.updatedAt,
        totalNodes,
        completedNodes,
        progressPercent,
        byStatus: manifest.stats.byStatus,
        byType: manifest.stats.byType,
        totalImages: manifest.stats.totalImages,
        totalVideos: manifest.stats.totalVideos,
        pathConsistencyCheck: manifest.stats.pathConsistencyCheck ?? null,
        seedUrl: manifest.seedUrl,
        createdAt: manifest.createdAt,
      },
    });
  } catch (err) {
    logger.error({ err, jobId }, "ROUTE: /jobs/:jobId/manifest/summary failed");
    res.status(500).json({ ok: false, error: "Failed to load manifest summary" });
  }
});

// ---------------------------------------------------------------------------
// Control operations — Pause / Resume / Retry / Cancel
// ---------------------------------------------------------------------------

router.post("/jobs/:jobId/pause", async (req: Request, res: Response) => {
  const result = await pauseJob(jobIdParam(req));
  res.status(result.success ? 200 : 400).json({ ok: result.success, data: result });
});

router.post("/jobs/:jobId/resume", async (req: Request, res: Response) => {
  const result = await resumeJob(jobIdParam(req));
  res.status(result.success ? 200 : 400).json({ ok: result.success, data: result });
});

router.post("/jobs/:jobId/retry", async (req: Request, res: Response) => {
  const result = await retryJob(jobIdParam(req));
  res.status(result.success ? 200 : 400).json({ ok: result.success, data: result });
});

router.post("/jobs/:jobId/cancel", async (req: Request, res: Response) => {
  const result = await cancelJob(jobIdParam(req));
  res.status(result.success ? 200 : 400).json({ ok: result.success, data: result });
});

// ---------------------------------------------------------------------------
// POST /jobs/:jobId/clone — start a fresh job with the same seed URL/options
// ---------------------------------------------------------------------------

router.post("/jobs/:jobId/clone", async (req: Request, res: Response) => {
  const jobId = jobIdParam(req);
  try {
    const record = await getJobRecord(jobId);
    if (!record) {
      res.status(404).json({ ok: false, error: `Job not found: ${jobId}` });
      return;
    }
    const newJobId = await submitScrapeJob({
      url: record.seedUrl,
      includeImages: record.includeImages,
      crawlAllPages: record.crawlAllPages,
      coverageThreshold: record.coverageThreshold,
    });
    logger.info({ jobId, newJobId }, "ROUTE: job cloned");
    res.json({ ok: true, data: { jobId: newJobId, clonedFrom: jobId, seedUrl: record.seedUrl } });
  } catch (err) {
    logger.error({ err, jobId }, "ROUTE: /jobs/:jobId/clone failed");
    res.status(500).json({ ok: false, error: `Clone failed: ${errMsg(err)}` });
  }
});

// ---------------------------------------------------------------------------
// POST /jobs/:jobId/run-diff — differential crawl against this job as baseline
// ---------------------------------------------------------------------------

router.post("/jobs/:jobId/run-diff", async (req: Request, res: Response) => {
  const jobId = jobIdParam(req);
  try {
    const record = await getJobRecord(jobId);
    if (!record) {
      res.status(404).json({ ok: false, error: `Job not found: ${jobId}` });
      return;
    }
    const newJobId = await submitScrapeJob({
      url: record.seedUrl,
      includeImages: record.includeImages,
      crawlAllPages: record.crawlAllPages,
      coverageThreshold: record.coverageThreshold,
      diffMode: true,
      baseJobId: jobId,
    });
    logger.info({ jobId, newJobId }, "ROUTE: diff job started");
    res.json({ ok: true, data: { jobId: newJobId, baseJobId: jobId, seedUrl: record.seedUrl } });
  } catch (err) {
    logger.error({ err, jobId }, "ROUTE: /jobs/:jobId/run-diff failed");
    res.status(500).json({ ok: false, error: `Run diff failed: ${errMsg(err)}` });
  }
});

// ---------------------------------------------------------------------------
// POST /jobs/:jobId/generate-website-prime
//
// Fires the REAL generation + construction pipeline in the background and
// returns immediately. The previous implementation called the Phase 5.6
// Indexer instead of the generator — this is the corrected version.
// Monitor progress via GET /jobs/:jobId/generation-status.
// ---------------------------------------------------------------------------

router.post("/jobs/:jobId/generate-website-prime", async (req: Request, res: Response) => {
  const jobId = jobIdParam(req);
  try {
    const record = await getJobRecord(jobId);
    if (!record) {
      res.status(404).json({ ok: false, error: `Job ${jobId} not found` });
      return;
    }
    // Fire-and-forget: real generation pipeline then construction runner.
    // Both are long-running — we return immediately and let the client poll
    // GET /jobs/:jobId/generation-status for progress.
    const cloudProvider = getDefaultCloudProvider();
    setImmediate(() => {
      runAndStoreGenerationPipeline(jobId, cloudProvider)
        .then(() => runAndStoreConstruction(jobId))
        .catch((err) =>
          logger.error({ err, jobId }, "ROUTE: generate-website-prime background pipeline failed"),
        );
    });
    logger.info({ jobId }, "ROUTE: website prime generation pipeline started in background");
    res.json({
      ok: true,
      data: {
        success: true,
        detail: "Website Prime generation started — monitor progress in the Job Mission Control.",
      },
    });
  } catch (err) {
    logger.error({ err, jobId }, "ROUTE: /jobs/:jobId/generate-website-prime failed");
    res.status(500).json({ ok: false, error: `Website Prime generation failed: ${errMsg(err)}` });
  }
});

// ---------------------------------------------------------------------------
// GET /jobs/:jobId/generation-status — check generation + construction DB status
// ---------------------------------------------------------------------------

router.get("/jobs/:jobId/generation-status", async (req: Request, res: Response) => {
  const jobId = jobIdParam(req);
  try {
    const [genReport, conReport] = await Promise.all([
      db.query.generationReportsTable.findFirst({
        where: eq(generationReportsTable.jobId, jobId),
      }),
      db.query.constructionReportsTable.findFirst({
        where: eq(constructionReportsTable.jobId, jobId),
      }),
    ]);
    res.json({
      ok: true,
      data: {
        generationStatus: genReport?.status ?? null,
        constructionStatus: conReport?.status ?? null,
        generationError: genReport?.errorMessage ?? null,
        constructionError: conReport?.status === "failed" ? "Construction failed" : null,
        hasOutput: conReport?.status === "success",
      },
    });
  } catch (err) {
    logger.error({ err, jobId }, "ROUTE: /jobs/:jobId/generation-status failed");
    res.status(500).json({ ok: false, error: `Failed to get generation status: ${errMsg(err)}` });
  }
});

export default router;
