/**
 * platform-validation.ts — Phase 7.9 HTTP Routes
 *
 * POST /api/platform/validate            — run full validation (blocking, ~10s)
 * GET  /api/platform/validate            — return last cached report
 * GET  /api/platform/validate/status     — quick classification + score only
 * GET  /api/platform/validate/dimension/:name — single dimension detail
 * GET  /api/platform/validate/site/:type — single site type detail
 */

import { Router, type IRouter } from "express";
import {
  runPlatformValidation,
  loadReport,
  type SiteType,
} from "../lib/platform-validation-engine.js";

const router: IRouter = Router();

// Static sub-routes before /:param routes

// GET /platform/validate/status — lightweight summary
router.get("/platform/validate/status", async (_req, res): Promise<void> => {
  try {
    const report = await loadReport();
    if (!report) {
      res.json({ ready: false, message: "No validation report yet. POST /api/platform/validate to generate one." });
      return;
    }
    res.json({
      ready:          true,
      overallScore:   report.overallScore,
      classification: report.classification,
      rationale:      report.classificationRationale,
      generatedAt:    report.generatedAt,
      durationMs:     report.durationMs,
      summary: {
        totalChecks: report.summary.totalChecks,
        passed:      report.summary.passed,
        warned:      report.summary.warned,
        failed:      report.summary.failed,
      },
      dimensions: report.dimensions.map((d) => ({
        dimension: d.dimension,
        label:     d.label,
        score:     d.score,
        status:    d.status,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /platform/validate/dimension/:name
router.get("/platform/validate/dimension/:name", async (req, res): Promise<void> => {
  try {
    const report = await loadReport();
    if (!report) {
      res.status(404).json({ error: "No validation report. Run POST /api/platform/validate first." });
      return;
    }
    const dim = report.dimensions.find((d) => d.dimension === req.params["name"]);
    if (!dim) {
      res.status(404).json({
        error:      `Dimension "${req.params["name"]}" not found`,
        available:  report.dimensions.map((d) => d.dimension),
      });
      return;
    }
    res.json(dim);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /platform/validate/site/:type
router.get("/platform/validate/site/:type", async (req, res): Promise<void> => {
  try {
    const report = await loadReport();
    if (!report) {
      res.status(404).json({ error: "No validation report. Run POST /api/platform/validate first." });
      return;
    }
    const site = report.siteTypes.find((s) => s.siteType === req.params["type"]);
    if (!site) {
      res.status(404).json({
        error:     `Site type "${req.params["type"]}" not found`,
        available: report.siteTypes.map((s) => s.siteType),
      });
      return;
    }
    res.json(site);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /platform/validate — return last report
router.get("/platform/validate", async (_req, res): Promise<void> => {
  try {
    const report = await loadReport();
    if (!report) {
      res.status(404).json({
        error:   "No validation report exists yet.",
        hint:    "POST /api/platform/validate to run the full validation suite.",
      });
      return;
    }
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /platform/validate — run full validation
router.post("/platform/validate", async (_req, res): Promise<void> => {
  try {
    const report = await runPlatformValidation();
    res.status(200).json(report);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
