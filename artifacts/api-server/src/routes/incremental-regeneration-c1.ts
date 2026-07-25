/**
 * incremental-regeneration-c1.ts — Phase C1 Routes
 *
 * POST /incremental-regeneration/analyze               — run C1 analysis given a DiffReport
 * GET  /incremental-regeneration                       — list all analyses
 * GET  /incremental-regeneration/:baseId/:newId        — full C1 bundle
 * GET  /incremental-regeneration/:baseId/:newId/report          — incremental-regeneration-report.json
 * GET  /incremental-regeneration/:baseId/:newId/affected-pages  — affected-pages.json
 * GET  /incremental-regeneration/:baseId/:newId/dependency-impact — dependency-impact-report.json
 * GET  /incremental-regeneration/:baseId/:newId/summary          — regeneration-summary.json
 */

import { Router, type IRouter } from "express";
import {
  runIncrementalRegeneration,
  getIncrementalReport,
  listIncrementalReports,
  type IncrementalRegenerationOptions,
} from "../lib/incremental-regeneration-engine-c1.js";
import type { DiffReport } from "../lib/diff-engine.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /incremental-regeneration/analyze
// ---------------------------------------------------------------------------

router.post("/incremental-regeneration/analyze", async (req, res): Promise<void> => {
  const {
    diffReport,
    avgPageCostMs,
    avgAssetCostMs,
    componentMap,
    navigationUrls,
  } = req.body ?? {};

  if (!diffReport) {
    res.status(400).json({
      error: "diffReport (DiffReport from diff-engine) is required",
    });
    return;
  }

  const dr = diffReport as DiffReport;
  if (!dr.baseJobId || typeof dr.baseJobId !== "string" ||
      !dr.newJobId  || typeof dr.newJobId  !== "string") {
    res.status(400).json({ error: "diffReport.baseJobId and diffReport.newJobId must be non-empty strings" });
    return;
  }
  if (!Array.isArray(dr.newNodes) || !Array.isArray(dr.changedNodes) ||
      !Array.isArray(dr.unchangedNodes) || !Array.isArray(dr.deletedNodes)) {
    res.status(400).json({ error: "diffReport must include newNodes, changedNodes, unchangedNodes, deletedNodes arrays" });
    return;
  }
  if (!dr.summary || typeof dr.summary.total !== "number" ||
      typeof dr.summary.new !== "number" || typeof dr.summary.changed !== "number" ||
      typeof dr.summary.unchanged !== "number" || typeof dr.summary.deleted !== "number") {
    res.status(400).json({ error: "diffReport.summary must contain numeric total, new, changed, unchanged, deleted fields" });
    return;
  }
  if (avgPageCostMs !== undefined && (typeof avgPageCostMs !== "number" || !isFinite(avgPageCostMs) || avgPageCostMs <= 0)) {
    res.status(400).json({ error: "avgPageCostMs must be a positive finite number" });
    return;
  }
  if (avgAssetCostMs !== undefined && (typeof avgAssetCostMs !== "number" || !isFinite(avgAssetCostMs) || avgAssetCostMs <= 0)) {
    res.status(400).json({ error: "avgAssetCostMs must be a positive finite number" });
    return;
  }
  if (componentMap !== undefined && (typeof componentMap !== "object" || Array.isArray(componentMap))) {
    res.status(400).json({ error: "componentMap must be an object mapping componentId to string[]" });
    return;
  }
  if (navigationUrls !== undefined && !Array.isArray(navigationUrls)) {
    res.status(400).json({ error: "navigationUrls must be a string array" });
    return;
  }

  try {
    const opts: IncrementalRegenerationOptions = {
      diffReport: dr,
      avgPageCostMs,
      avgAssetCostMs,
      componentMap,
      navigationUrls,
    };

    const { report, affectedPages, dependencyImpact, summary } =
      await runIncrementalRegeneration(opts);

    res.status(200).json({
      ok:                true,
      baseJobId:         report.baseJobId,
      newJobId:          report.newJobId,
      scope:             report.scope,
      pagesAffected:     report.metrics.pagesAffected,
      pagesSkipped:      report.metrics.pagesSkipped,
      timeSavedMs:       report.metrics.timeSavedMs,
      timeSavedPercent:  report.metrics.timeSavedPercent,
      assetReusePercent: report.metrics.assetReusePercent,
      componentsReused:  report.metrics.componentsReused,
      nearInstant:       summary.nearInstant,
      headline:          summary.headline,
      warnings:          report.warnings,
      durationMs:        report.durationMs,
      r2Keys:            report.r2Keys,
    });
  } catch (err) {
    req.log.error({ err }, "C1: incremental regeneration analysis failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /incremental-regeneration
// ---------------------------------------------------------------------------

router.get("/incremental-regeneration", (_req, res): void => {
  res.json({ analyses: listIncrementalReports() });
});

// ---------------------------------------------------------------------------
// GET /incremental-regeneration/:baseId/:newId
// ---------------------------------------------------------------------------

router.get("/incremental-regeneration/:baseId/:newId", (req, res): void => {
  const { baseId, newId } = req.params as { baseId: string; newId: string };
  const stored = getIncrementalReport(baseId, newId);
  if (!stored) {
    res.status(404).json({
      error: "No C1 analysis found — run POST /incremental-regeneration/analyze first",
    });
    return;
  }
  res.json({
    report:           stored.report,
    affectedPages:    stored.affectedPages,
    dependencyImpact: stored.dependencyImpact,
    summary:          stored.summary,
  });
});

// ---------------------------------------------------------------------------
// GET /incremental-regeneration/:baseId/:newId/report
// ---------------------------------------------------------------------------

router.get("/incremental-regeneration/:baseId/:newId/report", (req, res): void => {
  const { baseId, newId } = req.params as { baseId: string; newId: string };
  const stored = getIncrementalReport(baseId, newId);
  if (!stored) { res.status(404).json({ error: "C1 report not found" }); return; }
  res.json(stored.report);
});

// ---------------------------------------------------------------------------
// GET /incremental-regeneration/:baseId/:newId/affected-pages
// ---------------------------------------------------------------------------

router.get("/incremental-regeneration/:baseId/:newId/affected-pages", (req, res): void => {
  const { baseId, newId } = req.params as { baseId: string; newId: string };
  const stored = getIncrementalReport(baseId, newId);
  if (!stored) { res.status(404).json({ error: "C1 affected-pages not found" }); return; }
  res.json(stored.affectedPages);
});

// ---------------------------------------------------------------------------
// GET /incremental-regeneration/:baseId/:newId/dependency-impact
// ---------------------------------------------------------------------------

router.get("/incremental-regeneration/:baseId/:newId/dependency-impact", (req, res): void => {
  const { baseId, newId } = req.params as { baseId: string; newId: string };
  const stored = getIncrementalReport(baseId, newId);
  if (!stored) { res.status(404).json({ error: "C1 dependency-impact not found" }); return; }
  res.json(stored.dependencyImpact);
});

// ---------------------------------------------------------------------------
// GET /incremental-regeneration/:baseId/:newId/summary
// ---------------------------------------------------------------------------

router.get("/incremental-regeneration/:baseId/:newId/summary", (req, res): void => {
  const { baseId, newId } = req.params as { baseId: string; newId: string };
  const stored = getIncrementalReport(baseId, newId);
  if (!stored) { res.status(404).json({ error: "C1 summary not found" }); return; }
  res.json(stored.summary);
});

export default router;
