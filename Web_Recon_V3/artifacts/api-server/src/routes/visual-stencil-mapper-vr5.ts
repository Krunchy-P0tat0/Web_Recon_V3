/**
 * visual-stencil-mapper-vr5.ts — Phase VR-5: Visual Stencil Mapper Routes
 *
 * POST /api/visual-stencil/:jobId/generate
 *   Runs the full VR-5 visually-guided stencil generation pipeline.
 *   Body (all optional):
 *     { force?: boolean }
 *   Returns: visual-stencil-report.json
 *
 * GET  /api/visual-stencil/:jobId/report
 *   Returns the cached visual-stencil-report.json for a job.
 *
 * GET  /api/visual-stencil/:jobId/site-stencil
 *   Returns only the site-level stencil decision (type, confidence, signals).
 *
 * GET  /api/visual-stencil/:jobId/pages
 *   Returns per-page stencil types and section orders.
 *
 * GET  /api/visual-stencil/:jobId/page/:pageId
 *   Returns the stencil entry for a single page.
 *
 * GET  /api/visual-stencil/:jobId/components
 *   Returns the global component slots (nav, footer, repeated).
 *
 * GET  /api/visual-stencil/report
 *   Returns the latest visual-stencil-report across all jobs (most recently cached).
 */

import { Router, type IRouter } from "express";
import { mkdir }                from "fs/promises";
import { join }                 from "path";
import {
  runVisualStencilMapperVR5,
  getCachedReport,
  type VisualStencilReport,
} from "../lib/visual-stencil-mapper-vr5-engine.js";

const router: IRouter = Router();

// ── Ensure temp directory exists ──────────────────────────────────────────────

let dirReady = false;
async function ensureDir(jobId: string): Promise<void> {
  if (!dirReady) {
    try { await mkdir(join("/tmp/vr5"), { recursive: true }); dirReady = true; } catch { /* ok */ }
  }
  try { await mkdir(join("/tmp/vr5", jobId), { recursive: true }); } catch { /* ok */ }
}

// ── In-process last-report cache (for the global /report endpoint) ────────────

let _lastReport: VisualStencilReport | null = null;

// ── POST /api/visual-stencil/:jobId/generate ──────────────────────────────────

router.post("/visual-stencil/:jobId/generate", async (req, res): Promise<void> => {
  const jobId = (req.params as Record<string, string>)["jobId"] ?? "";
  if (!jobId) {
    res.status(400).json({ error: "jobId path parameter is required" });
    return;
  }

  const body  = (req.body ?? {}) as Record<string, unknown>;
  const force = body["force"] === true;

  // Return cached result unless forced
  if (!force) {
    const cached = getCachedReport(jobId);
    if (cached) {
      res.status(200).json({ ...cached, cached: true });
      return;
    }
  }

  await ensureDir(jobId);
  req.log.info({ jobId, force }, "VR5: generate requested");

  try {
    const report = await runVisualStencilMapperVR5({ jobId });
    _lastReport = report;
    res.status(200).json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err, jobId }, "VR5: generate failed");

    if (message.includes("manifest not found")) {
      res.status(404).json({
        error: "Manifest not found for this job.",
        hint:  `Run a crawl first so _manifest.json exists for jobId="${jobId}".`,
        detail: message,
      });
      return;
    }

    res.status(500).json({ error: "VR-5 stencil generation failed", detail: message });
  }
});

// ── GET /api/visual-stencil/:jobId/report ─────────────────────────────────────

router.get("/visual-stencil/:jobId/report", async (req, res): Promise<void> => {
  const jobId = (req.params as Record<string, string>)["jobId"] ?? "";
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  const cached = getCachedReport(jobId);
  if (cached) { res.status(200).json(cached); return; }

  res.status(404).json({
    error: "No visual-stencil-report found for this job.",
    hint:  `POST /api/visual-stencil/${jobId}/generate to run Phase VR-5.`,
  });
});

// ── GET /api/visual-stencil/:jobId/site-stencil ───────────────────────────────

router.get("/visual-stencil/:jobId/site-stencil", async (req, res): Promise<void> => {
  const jobId = (req.params as Record<string, string>)["jobId"] ?? "";
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  const cached = getCachedReport(jobId);
  if (!cached) {
    res.status(404).json({
      error: "No VR-5 report found.",
      hint:  `POST /api/visual-stencil/${jobId}/generate first.`,
    });
    return;
  }

  res.status(200).json({
    jobId,
    seedUrl:      cached.seedUrl,
    generatedAt:  cached.generatedAt,
    siteStencil:  cached.siteStencil,
    inputsUsed:   cached.inputsUsed,
  });
});

// ── GET /api/visual-stencil/:jobId/pages ──────────────────────────────────────

router.get("/visual-stencil/:jobId/pages", async (req, res): Promise<void> => {
  const jobId = (req.params as Record<string, string>)["jobId"] ?? "";
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  const cached = getCachedReport(jobId);
  if (!cached) {
    res.status(404).json({
      error: "No VR-5 report found.",
      hint:  `POST /api/visual-stencil/${jobId}/generate first.`,
    });
    return;
  }

  // Lightweight per-page summary (exclude full sectionOrder for brevity)
  const pages = cached.pages.map(p => ({
    pageId:              p.pageId,
    url:                 p.url,
    stencilType:         p.stencilType,
    confidence:          p.confidence,
    regionCount:         p.regionCount,
    navigationPlacement: p.navigationPlacement,
    footerPlacement:     p.footerPlacement,
    heroPresent:         p.heroConfig.present,
    sectionCount:        p.sectionOrder.length,
    visualSignals:       p.visualSignals,
  }));

  res.status(200).json({ jobId, pageCount: pages.length, pages });
});

// ── GET /api/visual-stencil/:jobId/page/:pageId ───────────────────────────────

router.get("/visual-stencil/:jobId/page/:pageId", async (req, res): Promise<void> => {
  const params = req.params as Record<string, string>;
  const jobId  = params["jobId"]  ?? "";
  const pageId = params["pageId"] ?? "";

  if (!jobId || !pageId) {
    res.status(400).json({ error: "jobId and pageId are required" });
    return;
  }

  const cached = getCachedReport(jobId);
  if (!cached) {
    res.status(404).json({
      error: "No VR-5 report found.",
      hint:  `POST /api/visual-stencil/${jobId}/generate first.`,
    });
    return;
  }

  const page = cached.pages.find(p => p.pageId === pageId || p.url === pageId);
  if (!page) {
    res.status(404).json({
      error: `Page "${pageId}" not found in VR-5 report.`,
      availablePages: cached.pages.length,
      hint: "Use GET /api/visual-stencil/:jobId/pages to list all page IDs.",
    });
    return;
  }

  res.status(200).json(page);
});

// ── GET /api/visual-stencil/:jobId/components ────────────────────────────────

router.get("/visual-stencil/:jobId/components", async (req, res): Promise<void> => {
  const jobId = (req.params as Record<string, string>)["jobId"] ?? "";
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  const cached = getCachedReport(jobId);
  if (!cached) {
    res.status(404).json({
      error: "No VR-5 report found.",
      hint:  `POST /api/visual-stencil/${jobId}/generate first.`,
    });
    return;
  }

  res.status(200).json({
    jobId,
    generatedAt:      cached.generatedAt,
    globalComponents: cached.globalComponents,
  });
});

// ── GET /api/visual-stencil/report ────────────────────────────────────────────

router.get("/visual-stencil/report", (_req, res): void => {
  if (!_lastReport) {
    res.status(404).json({
      error: "No visual-stencil-report generated yet.",
      hint:  "POST /api/visual-stencil/:jobId/generate to run Phase VR-5.",
    });
    return;
  }
  res.status(200).json(_lastReport);
});

export default router;
