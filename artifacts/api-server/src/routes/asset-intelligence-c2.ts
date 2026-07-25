/**
 * asset-intelligence-c2.ts — Phase C2 Routes
 *
 * POST /asset-intelligence/analyze                        — run C2 analysis for a jobId
 * GET  /asset-intelligence                                — list all C2 analyses
 * GET  /asset-intelligence/:jobId                         — full C2 bundle
 * GET  /asset-intelligence/:jobId/asset-intelligence-report   — asset-intelligence-report.json
 * GET  /asset-intelligence/:jobId/asset-optimization-report   — asset-optimization-report.json
 * GET  /asset-intelligence/:jobId/duplicate-asset-report      — duplicate-asset-report.json
 * GET  /asset-intelligence/:jobId/lazy-loading-report         — lazy-loading-report.json
 * GET  /asset-intelligence/:jobId/asset-cache-manifest        — asset-cache-manifest.json
 */

import { Router, type IRouter } from "express";
import {
  runAssetIntelligence,
  getC2Bundle,
  listC2Bundles,
} from "../lib/asset-intelligence-engine-c2.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /asset-intelligence/analyze
// ---------------------------------------------------------------------------
router.post("/asset-intelligence/analyze", async (req, res): Promise<void> => {
  const { jobId } = req.body ?? {};

  if (!jobId || typeof jobId !== "string") {
    res.status(400).json({ error: "jobId (string) is required in the request body" });
    return;
  }

  try {
    const bundle = await runAssetIntelligence({ jobId });
    res.status(200).json({
      jobId: bundle.jobId,
      generatedAt: bundle.generatedAt,
      r2Keys: bundle.r2Keys,
      summary: bundle.assetIntelligenceReport.summary,
      optimizationOpportunities: bundle.assetOptimizationReport.summary.total,
      duplicateGroups: bundle.duplicateAssetReport.summary.totalDuplicateGroups,
      lazyLoadCandidates: bundle.lazyLoadingReport.summary.totalCandidates,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("manifest not found") || msg.includes("no page nodes")) {
      res.status(404).json({ error: msg });
      return;
    }
    req.log.error({ err, jobId }, "C2: analysis failed");
    res.status(500).json({ error: "Asset intelligence analysis failed", detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /asset-intelligence
// ---------------------------------------------------------------------------
router.get("/asset-intelligence", (_req, res): void => {
  res.status(200).json(listC2Bundles());
});

// ---------------------------------------------------------------------------
// GET /asset-intelligence/:jobId  — full bundle
// ---------------------------------------------------------------------------
router.get("/asset-intelligence/:jobId", (req, res): void => {
  const bundle = getC2Bundle(req.params.jobId!);
  if (!bundle) {
    res.status(404).json({ error: `No C2 analysis found for jobId "${req.params.jobId}"` });
    return;
  }
  res.status(200).json(bundle);
});

// ---------------------------------------------------------------------------
// GET /asset-intelligence/:jobId/asset-intelligence-report
// ---------------------------------------------------------------------------
router.get("/asset-intelligence/:jobId/asset-intelligence-report", (req, res): void => {
  const bundle = getC2Bundle(req.params.jobId!);
  if (!bundle) {
    res.status(404).json({ error: `No C2 analysis found for jobId "${req.params.jobId}"` });
    return;
  }
  res.status(200).json(bundle.assetIntelligenceReport);
});

// ---------------------------------------------------------------------------
// GET /asset-intelligence/:jobId/asset-optimization-report
// ---------------------------------------------------------------------------
router.get("/asset-intelligence/:jobId/asset-optimization-report", (req, res): void => {
  const bundle = getC2Bundle(req.params.jobId!);
  if (!bundle) {
    res.status(404).json({ error: `No C2 analysis found for jobId "${req.params.jobId}"` });
    return;
  }
  res.status(200).json(bundle.assetOptimizationReport);
});

// ---------------------------------------------------------------------------
// GET /asset-intelligence/:jobId/duplicate-asset-report
// ---------------------------------------------------------------------------
router.get("/asset-intelligence/:jobId/duplicate-asset-report", (req, res): void => {
  const bundle = getC2Bundle(req.params.jobId!);
  if (!bundle) {
    res.status(404).json({ error: `No C2 analysis found for jobId "${req.params.jobId}"` });
    return;
  }
  res.status(200).json(bundle.duplicateAssetReport);
});

// ---------------------------------------------------------------------------
// GET /asset-intelligence/:jobId/lazy-loading-report
// ---------------------------------------------------------------------------
router.get("/asset-intelligence/:jobId/lazy-loading-report", (req, res): void => {
  const bundle = getC2Bundle(req.params.jobId!);
  if (!bundle) {
    res.status(404).json({ error: `No C2 analysis found for jobId "${req.params.jobId}"` });
    return;
  }
  res.status(200).json(bundle.lazyLoadingReport);
});

// ---------------------------------------------------------------------------
// GET /asset-intelligence/:jobId/asset-cache-manifest
// ---------------------------------------------------------------------------
router.get("/asset-intelligence/:jobId/asset-cache-manifest", (req, res): void => {
  const bundle = getC2Bundle(req.params.jobId!);
  if (!bundle) {
    res.status(404).json({ error: `No C2 analysis found for jobId "${req.params.jobId}"` });
    return;
  }
  res.status(200).json(bundle.assetCacheManifest);
});

export default router;
