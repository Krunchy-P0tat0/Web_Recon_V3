/**
 * runtime-performance-c3.ts — Phase C3 Routes
 *
 * POST /runtime-performance/analyze                          — run C3 analysis for a jobId
 * GET  /runtime-performance                                  — list all C3 analyses
 * GET  /runtime-performance/:jobId                           — full C3 bundle
 * GET  /runtime-performance/:jobId/runtime-performance-report    — runtime-performance-report.json
 * GET  /runtime-performance/:jobId/core-web-vitals-report        — core-web-vitals-report.json
 * GET  /runtime-performance/:jobId/bundle-analysis               — bundle-analysis.json
 * GET  /runtime-performance/:jobId/performance-recommendations   — performance-recommendations.json
 */

import { Router, type IRouter } from "express";
import {
  runRuntimePerformance,
  getC3Bundle,
  listC3Bundles,
} from "../lib/runtime-performance-engine-c3.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /runtime-performance/analyze
// ---------------------------------------------------------------------------
router.post("/runtime-performance/analyze", async (req, res): Promise<void> => {
  const { jobId, urls, maxPages } = req.body ?? {};

  if (!jobId || typeof jobId !== "string") {
    res.status(400).json({ error: "jobId (string) is required in the request body" });
    return;
  }

  if (urls !== undefined && (!Array.isArray(urls) || urls.some(u => typeof u !== "string"))) {
    res.status(400).json({ error: "urls must be an array of strings when provided" });
    return;
  }

  if (maxPages !== undefined && (typeof maxPages !== "number" || maxPages < 1 || maxPages > 20)) {
    res.status(400).json({ error: "maxPages must be a number between 1 and 20" });
    return;
  }

  try {
    const bundle = await runRuntimePerformance({
      jobId,
      urls: urls as string[] | undefined,
      maxPages: maxPages as number | undefined,
    });

    res.status(200).json({
      jobId:             bundle.jobId,
      generatedAt:       bundle.generatedAt,
      r2Keys:            bundle.r2Keys,
      pagesAnalyzed:     bundle.runtimePerformanceReport.pagesAnalyzed,
      overallCwvRating:  bundle.coreWebVitalsReport.summary.overallRating,
      cwvSummary:        bundle.coreWebVitalsReport.summary,
      recommendations:   bundle.performanceRecommendations.summary.total,
      aggregates:        bundle.runtimePerformanceReport.aggregates,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("manifest not found") || msg.includes("no page nodes") || msg.includes("no URLs")) {
      res.status(404).json({ error: msg });
      return;
    }
    req.log.error({ err, jobId }, "C3: analysis failed");
    res.status(500).json({ error: "Runtime performance analysis failed", detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /runtime-performance
// ---------------------------------------------------------------------------
router.get("/runtime-performance", (_req, res): void => {
  res.status(200).json(listC3Bundles());
});

// ---------------------------------------------------------------------------
// GET /runtime-performance/:jobId — full bundle
// ---------------------------------------------------------------------------
router.get("/runtime-performance/:jobId", (req, res): void => {
  const bundle = getC3Bundle(req.params.jobId!);
  if (!bundle) {
    res.status(404).json({ error: `No C3 analysis found for jobId "${req.params.jobId}"` });
    return;
  }
  res.status(200).json(bundle);
});

// ---------------------------------------------------------------------------
// GET /runtime-performance/:jobId/runtime-performance-report
// ---------------------------------------------------------------------------
router.get("/runtime-performance/:jobId/runtime-performance-report", (req, res): void => {
  const bundle = getC3Bundle(req.params.jobId!);
  if (!bundle) {
    res.status(404).json({ error: `No C3 analysis found for jobId "${req.params.jobId}"` });
    return;
  }
  res.status(200).json(bundle.runtimePerformanceReport);
});

// ---------------------------------------------------------------------------
// GET /runtime-performance/:jobId/core-web-vitals-report
// ---------------------------------------------------------------------------
router.get("/runtime-performance/:jobId/core-web-vitals-report", (req, res): void => {
  const bundle = getC3Bundle(req.params.jobId!);
  if (!bundle) {
    res.status(404).json({ error: `No C3 analysis found for jobId "${req.params.jobId}"` });
    return;
  }
  res.status(200).json(bundle.coreWebVitalsReport);
});

// ---------------------------------------------------------------------------
// GET /runtime-performance/:jobId/bundle-analysis
// ---------------------------------------------------------------------------
router.get("/runtime-performance/:jobId/bundle-analysis", (req, res): void => {
  const bundle = getC3Bundle(req.params.jobId!);
  if (!bundle) {
    res.status(404).json({ error: `No C3 analysis found for jobId "${req.params.jobId}"` });
    return;
  }
  res.status(200).json(bundle.bundleAnalysis);
});

// ---------------------------------------------------------------------------
// GET /runtime-performance/:jobId/performance-recommendations
// ---------------------------------------------------------------------------
router.get("/runtime-performance/:jobId/performance-recommendations", (req, res): void => {
  const bundle = getC3Bundle(req.params.jobId!);
  if (!bundle) {
    res.status(404).json({ error: `No C3 analysis found for jobId "${req.params.jobId}"` });
    return;
  }
  res.status(200).json(bundle.performanceRecommendations);
});

export default router;
