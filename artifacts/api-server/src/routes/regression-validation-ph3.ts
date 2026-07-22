/**
 * regression-validation-ph3.ts — PH-3: Automatic Regression Validation Routes
 *
 *   GET  /api/regression/summary              — QA-3 regression summary
 *   GET  /api/regression/history              — full run history (?limit=N)
 *   GET  /api/regression/suite                — QA-2 fixture + suite status
 *   GET  /api/regression/fixtures             — all golden fixtures
 *   GET  /api/regression/:jobId/latest        — latest report for a job
 *   GET  /api/regression/:jobId/reports       — all reports for a job
 *   GET  /api/regression/:jobId/fixture       — golden fixture for a job
 *   POST /api/regression/:jobId/trigger       — manually trigger regression run
 *   POST /api/regression/:jobId/approve       — approve job outputs as new golden fixture
 */

import { Router, type IRouter } from "express";
import {
  getRegressionSummary,
  getRegressionHistory,
  getLatestReportForJob,
  listReportsForJob,
  triggerRegressionForJob,
  getFixture,
  listFixtures,
  getRegressionSuite,
} from "../lib/post-build-regression-runner.js";
import { approveGolden } from "../lib/visual-regression-engine.js";

const router: IRouter = Router();

// GET /regression/summary
router.get("/regression/summary", (_req, res): void => {
  res.json(getRegressionSummary());
});

// GET /regression/history?limit=N
router.get("/regression/history", (req, res): void => {
  const limit   = Math.min(500, parseInt(String(req.query["limit"] ?? "100"), 10) || 100);
  const history = getRegressionHistory(limit);
  res.json({
    version:     "PH-3",
    generatedAt: new Date().toISOString(),
    total:       history.length,
    history,
  });
});

// GET /regression/suite
router.get("/regression/suite", (_req, res): void => {
  res.json(getRegressionSuite());
});

// GET /regression/fixtures
router.get("/regression/fixtures", (_req, res): void => {
  const fixtures = listFixtures();
  res.json({
    version:     "PH-3",
    generatedAt: new Date().toISOString(),
    total:       fixtures.length,
    fixtures,
  });
});

// GET /regression/:jobId/latest
router.get("/regression/:jobId/latest", (req, res): void => {
  const { jobId } = req.params;
  const report = getLatestReportForJob(jobId);
  if (!report) {
    res.status(404).json({
      error: `No regression report found for jobId "${jobId}". Trigger a run first.`,
    });
    return;
  }
  res.json(report);
});

// GET /regression/:jobId/reports
router.get("/regression/:jobId/reports", (req, res): void => {
  const { jobId } = req.params;
  const reports = listReportsForJob(jobId);
  res.json({
    version:     "PH-3",
    generatedAt: new Date().toISOString(),
    jobId,
    total:       reports.length,
    reports,
  });
});

// GET /regression/:jobId/fixture
router.get("/regression/:jobId/fixture", (req, res): void => {
  const { jobId } = req.params;
  const fixture = getFixture(jobId);
  if (!fixture) {
    res.status(404).json({
      error: `No golden fixture found for jobId "${jobId}". Run POST /regression/${jobId}/approve first.`,
    });
    return;
  }
  res.json(fixture);
});

// POST /regression/:jobId/trigger — manually run regression
router.post("/regression/:jobId/trigger", (req, res): void => {
  const { jobId } = req.params;
  const seedUrl   = String((req.body as Record<string, unknown>)?.["seedUrl"] ?? "manual-trigger");
  const report = triggerRegressionForJob(jobId, seedUrl);
  res.status(200).json({
    message:          "Regression run complete",
    overallStatus:    report.overallStatus,
    blocksDeployment: report.blocksDeployment,
    report,
  });
});

// POST /regression/:jobId/approve — set current outputs as new golden fixture
router.post("/regression/:jobId/approve", (req, res): void => {
  const { jobId } = req.params;
  const body      = (req.body as Record<string, unknown>) ?? {};
  const seedUrl   = String(body["seedUrl"]   ?? "unknown");
  const approvedBy = String(body["approvedBy"] ?? "user");
  const tags       = Array.isArray(body["tags"]) ? (body["tags"] as string[]) : [];
  const notes      = String(body["notes"] ?? "");

  const fixture = approveGolden(jobId, seedUrl, approvedBy, tags, notes);
  res.status(201).json({
    message: "Golden fixture approved",
    fixture,
  });
});

export default router;
