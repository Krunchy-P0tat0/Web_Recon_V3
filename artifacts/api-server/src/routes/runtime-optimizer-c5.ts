/**
 * runtime-optimizer-c5.ts — Phase C5 Routes
 *
 * POST /runtime-optimizer/analyze                            — run C5 for a jobId
 * GET  /runtime-optimizer                                    — list all C5 analyses
 * GET  /runtime-optimizer/:jobId                             — full C5 bundle
 * GET  /runtime-optimizer/:jobId/runtime-optimization-report — runtime-optimization-report.json
 * GET  /runtime-optimizer/:jobId/rendering-strategy          — rendering-strategy.json
 * GET  /runtime-optimizer/:jobId/prefetch-plan               — prefetch-plan.json
 * GET  /runtime-optimizer/:jobId/runtime-health              — runtime-health.json
 */

import { Router, type IRouter } from "express";
import {
  runRuntimeOptimizer,
  getC5Bundle,
  listC5Bundles,
} from "../lib/runtime-optimizer-engine-c5.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /runtime-optimizer/analyze
// ---------------------------------------------------------------------------
router.post("/runtime-optimizer/analyze", async (req, res): Promise<void> => {
  const { jobId } = req.body ?? {};

  if (!jobId || typeof jobId !== "string") {
    res.status(400).json({ error: "jobId (string) is required in the request body" });
    return;
  }

  try {
    const bundle = await runRuntimeOptimizer({ jobId });
    res.status(200).json({
      jobId:              bundle.jobId,
      generatedAt:        bundle.generatedAt,
      r2Keys:             bundle.r2Keys,
      framework:          bundle.renderingStrategy.framework,
      hydration:          bundle.renderingStrategy.detectedHydration,
      pagesAnalyzed:      bundle.runtimeOptimizationReport.pagesAnalyzed,
      routeSummary:       bundle.runtimeOptimizationReport.routeSummary,
      healthScore:        bundle.runtimeHealth.overallScore,
      healthRating:       bundle.runtimeHealth.overallRating,
      healthIssues:       bundle.runtimeHealth.issues.length,
      optimizations:      bundle.runtimeOptimizationReport.topOptimizations.length,
      prefetchEntries:    bundle.prefetchPlan.totalEntries,
      executiveSummary:   bundle.runtimeOptimizationReport.executiveSummary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("manifest not found") || msg.includes("no page nodes")) {
      res.status(404).json({ error: msg });
      return;
    }
    req.log.error({ err, jobId }, "C5: analysis failed");
    res.status(500).json({ error: "Runtime optimization analysis failed", detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /runtime-optimizer
// ---------------------------------------------------------------------------
router.get("/runtime-optimizer", (_req, res): void => {
  res.status(200).json(listC5Bundles());
});

// ---------------------------------------------------------------------------
// GET /runtime-optimizer/:jobId — full bundle
// ---------------------------------------------------------------------------
router.get("/runtime-optimizer/:jobId", (req, res): void => {
  const bundle = getC5Bundle(req.params.jobId!);
  if (!bundle) { res.status(404).json({ error: `No C5 analysis found for jobId "${req.params.jobId}"` }); return; }
  res.status(200).json(bundle);
});

// ---------------------------------------------------------------------------
// GET /runtime-optimizer/:jobId/runtime-optimization-report
// ---------------------------------------------------------------------------
router.get("/runtime-optimizer/:jobId/runtime-optimization-report", (req, res): void => {
  const bundle = getC5Bundle(req.params.jobId!);
  if (!bundle) { res.status(404).json({ error: `No C5 analysis found for jobId "${req.params.jobId}"` }); return; }
  res.status(200).json(bundle.runtimeOptimizationReport);
});

// ---------------------------------------------------------------------------
// GET /runtime-optimizer/:jobId/rendering-strategy
// ---------------------------------------------------------------------------
router.get("/runtime-optimizer/:jobId/rendering-strategy", (req, res): void => {
  const bundle = getC5Bundle(req.params.jobId!);
  if (!bundle) { res.status(404).json({ error: `No C5 analysis found for jobId "${req.params.jobId}"` }); return; }
  res.status(200).json(bundle.renderingStrategy);
});

// ---------------------------------------------------------------------------
// GET /runtime-optimizer/:jobId/prefetch-plan
// ---------------------------------------------------------------------------
router.get("/runtime-optimizer/:jobId/prefetch-plan", (req, res): void => {
  const bundle = getC5Bundle(req.params.jobId!);
  if (!bundle) { res.status(404).json({ error: `No C5 analysis found for jobId "${req.params.jobId}"` }); return; }
  res.status(200).json(bundle.prefetchPlan);
});

// ---------------------------------------------------------------------------
// GET /runtime-optimizer/:jobId/runtime-health
// ---------------------------------------------------------------------------
router.get("/runtime-optimizer/:jobId/runtime-health", (req, res): void => {
  const bundle = getC5Bundle(req.params.jobId!);
  if (!bundle) { res.status(404).json({ error: `No C5 analysis found for jobId "${req.params.jobId}"` }); return; }
  res.status(200).json(bundle.runtimeHealth);
});

export default router;
