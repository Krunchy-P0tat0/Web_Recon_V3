/**
 * pipeline-monitoring-ph2.ts — PH-2: QA-3 Pipeline Monitoring Routes
 *
 *   GET  /api/pipeline-monitoring/report       — full PH-2 monitoring report
 *   GET  /api/pipeline-monitoring/health       — health history (all jobs)
 *   GET  /api/pipeline-monitoring/timeline     — quality timeline (?jobId=...)
 *   GET  /api/pipeline-monitoring/snapshots    — all stage snapshots (?limit=N)
 *   GET  /api/pipeline-monitoring/:jobId/trace — execution trace for one job
 *   GET  /api/pipeline-monitoring/:jobId/snapshots — snapshots for one job
 *   POST /api/pipeline-monitoring/seed/:jobId  — manually seed a stage snapshot (testing)
 */

import { Router, type IRouter } from "express";
import {
  getMonitoringReport,
  getHealthHistory,
  getQualityTimeline,
  getAllStageSnapshots,
  getTrace,
  getSnapshotsForJob,
  listTraces,
} from "../lib/pipeline-monitoring-interceptor.js";

const router: IRouter = Router();

// GET /pipeline-monitoring/report
router.get("/pipeline-monitoring/report", (_req, res): void => {
  res.json(getMonitoringReport());
});

// GET /pipeline-monitoring/health?limit=N
router.get("/pipeline-monitoring/health", (req, res): void => {
  const limit  = Math.min(500, parseInt(String(req.query["limit"] ?? "100"), 10) || 100);
  const history = getHealthHistory(limit);
  res.json({
    version:     "PH-2",
    generatedAt: new Date().toISOString(),
    total:       history.length,
    history,
  });
});

// GET /pipeline-monitoring/timeline?jobId=...&limit=N
router.get("/pipeline-monitoring/timeline", (req, res): void => {
  const jobId = req.query["jobId"] ? String(req.query["jobId"]) : undefined;
  const limit = Math.min(500, parseInt(String(req.query["limit"] ?? "200"), 10) || 200);
  const timeline = getQualityTimeline(jobId).slice(0, limit);
  res.json({
    version:     "PH-2",
    generatedAt: new Date().toISOString(),
    jobId:       jobId ?? "all",
    total:       timeline.length,
    timeline,
  });
});

// GET /pipeline-monitoring/snapshots?limit=N
router.get("/pipeline-monitoring/snapshots", (req, res): void => {
  const limit = Math.min(500, parseInt(String(req.query["limit"] ?? "100"), 10) || 100);
  const snaps = getAllStageSnapshots(limit);
  res.json({
    version:     "PH-2",
    generatedAt: new Date().toISOString(),
    total:       snaps.length,
    snapshots:   snaps,
  });
});

// GET /pipeline-monitoring/traces
router.get("/pipeline-monitoring/traces", (_req, res): void => {
  const traces = listTraces();
  res.json({
    version:     "PH-2",
    generatedAt: new Date().toISOString(),
    total:       traces.length,
    traces,
  });
});

// GET /pipeline-monitoring/:jobId/trace
router.get("/pipeline-monitoring/:jobId/trace", (req, res): void => {
  const { jobId } = req.params;
  const trace = getTrace(jobId);
  if (!trace) {
    res.status(404).json({ error: `No execution trace found for jobId "${jobId}"` });
    return;
  }
  res.json(trace);
});

// GET /pipeline-monitoring/:jobId/snapshots
router.get("/pipeline-monitoring/:jobId/snapshots", (req, res): void => {
  const { jobId } = req.params;
  const snaps = getSnapshotsForJob(jobId);
  res.json({
    version:     "PH-2",
    generatedAt: new Date().toISOString(),
    jobId,
    total:       snaps.length,
    snapshots:   snaps,
  });
});

export default router;
