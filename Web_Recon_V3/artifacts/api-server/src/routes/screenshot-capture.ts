/**
 * screenshot-capture.ts — Phase VR-1 HTTP Routes
 *
 * POST /api/screenshots/:jobId/capture      — trigger capture for a job's manifest
 * GET  /api/screenshots/:jobId              — get capture status + asset list
 * GET  /api/screenshots/:jobId/report       — full screenshot-capture-report
 * GET  /api/screenshots/report              — latest cached report (any job)
 * POST /api/screenshots/report/generate    — force regenerate report from cache
 * GET  /api/screenshots/:jobId/assets       — list all captured R2 paths
 */

import { Router, type IRouter } from "express";
import {
  runScreenshotCapture,
  generateReport,
  loadReport,
  listReports,
  getReport,
  storeReport,
} from "../lib/screenshot-capture-engine.js";
import { loadManifest } from "../lib/manifest-store.js";

const router: IRouter = Router();

// Static routes before /:jobId

router.get("/screenshots/report", async (_req, res): Promise<void> => {
  try {
    const cached = await loadReport();
    if (cached) { res.json(cached); return; }
    const all = listReports();
    if (all.length > 0) { res.json(all[0]); return; }
    res.status(404).json({ error: "No screenshot-capture-report found. POST /api/screenshots/:jobId/capture to generate one." });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/screenshots/report/generate", async (_req, res): Promise<void> => {
  try {
    const all = listReports();
    if (all.length === 0) {
      res.status(404).json({ error: "No capture sessions in memory. Run a capture first." });
      return;
    }
    const latest = all[0]!;
    const r = await generateReport(latest.jobId, latest.audit);
    res.json({ generated: true, report: r });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /screenshots/:jobId/capture
router.post("/screenshots/:jobId/capture", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };
  const body = (req.body ?? {}) as { concurrency?: number; maxPages?: number };

  try {
    const manifest = await loadManifest(jobId);
    if (!manifest) {
      res.status(404).json({ error: `No manifest found for jobId "${jobId}". Run a crawl first.` });
      return;
    }

    const eligible = Array.from(manifest.nodes.values()).filter(
      (n) => n.status === "complete" && n.metadata.url,
    ).length;

    // Fire-and-forget for large jobs, but wait for small ones
    const shouldWait = eligible <= 5;
    if (shouldWait) {
      const audit  = await runScreenshotCapture(jobId, manifest, { concurrency: body.concurrency, maxPages: body.maxPages });
      const report = await generateReport(jobId, audit);
      storeReport(report);
      res.json({ launched: true, waited: true, jobId, audit, pollUrl: `/api/screenshots/${jobId}/report` });
    } else {
      res.json({ launched: true, waited: false, jobId, eligible, message: "Capture started. Poll pollUrl for progress.", pollUrl: `/api/screenshots/${jobId}/report` });
      // Run in background
      runScreenshotCapture(jobId, manifest, { concurrency: body.concurrency ?? 3, maxPages: body.maxPages ?? 200 })
        .then(async (audit) => {
          const report = await generateReport(jobId, audit);
          storeReport(report);
        })
        .catch((err) => { req.log?.warn({ jobId, err }, "SCREENSHOT: background capture failed"); });
    }
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /screenshots/:jobId/report
router.get("/screenshots/:jobId/report", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };
  try {
    const inMem = getReport(jobId);
    if (inMem) { res.json(inMem); return; }
    const cached = await loadReport();
    if (cached && cached.jobId === jobId) { res.json(cached); return; }
    res.status(404).json({ error: `No screenshot report for jobId "${jobId}". POST /api/screenshots/${jobId}/capture first.` });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /screenshots/:jobId/assets
router.get("/screenshots/:jobId/assets", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };
  try {
    const inMem = getReport(jobId);
    const audit = inMem?.audit;
    if (!audit) {
      res.status(404).json({ error: `No screenshot capture data for jobId "${jobId}".` });
      return;
    }
    const assets = audit.pageResults.map((p) => ({
      nodeId:    p.nodeId,
      url:       p.url,
      success:   p.success,
      desktop:   p.desktopOk ? `jobs/${jobId}/screenshots/desktop/${p.nodeId}.png` : null,
      tablet:    p.tabletOk  ? `jobs/${jobId}/screenshots/tablet/${p.nodeId}.png`  : null,
      mobile:    p.mobileOk  ? `jobs/${jobId}/screenshots/mobile/${p.nodeId}.png`  : null,
      dom:       p.domOk     ? `jobs/${jobId}/screenshots/dom/${p.nodeId}.html`    : null,
      css:       p.cssOk     ? `jobs/${jobId}/screenshots/css/${p.nodeId}.css`     : null,
      storageBytes: p.storageBytes,
    }));
    res.json({
      jobId,
      totalPages:    audit.pageResults.length,
      capturedPages: audit.pagesCaptured,
      storageUsed:   audit.storageUsed,
      coveragePercent: audit.coveragePercent,
      assets,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /screenshots/:jobId
router.get("/screenshots/:jobId", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };
  try {
    const inMem = getReport(jobId);
    if (inMem) {
      res.json({
        jobId,
        status:          "complete",
        pagesCaptured:   inMem.audit.pagesCaptured,
        captureFailures: inMem.audit.captureFailures,
        storageUsed:     inMem.audit.storageUsed,
        coveragePercent: inMem.audit.coveragePercent,
        captureDuration: inMem.audit.captureDuration,
        generatedAt:     inMem.generatedAt,
        viewports:       inMem.viewports,
        r2PathTemplate:  inMem.r2PathTemplate,
        links: {
          report: `/api/screenshots/${jobId}/report`,
          assets: `/api/screenshots/${jobId}/assets`,
        },
      });
      return;
    }
    res.status(404).json({
      jobId,
      status: "not_started",
      message: `No screenshot capture found for jobId "${jobId}".`,
      hint:   `POST /api/screenshots/${jobId}/capture to begin.`,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
