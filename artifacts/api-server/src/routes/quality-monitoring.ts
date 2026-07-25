/**
 * quality-monitoring.ts — QA-3: Continuous Quality Monitoring Routes
 *
 *   POST /api/quality-monitoring/:jobId/record   — record a quality snapshot for a job
 *   GET  /api/quality-monitoring/:jobId/snapshots — all snapshots for a job
 *   GET  /api/quality-monitoring/:jobId/latest    — latest snapshot for a job
 *   GET  /api/quality-monitoring/:jobId/alerts    — alerts for a job
 *   GET  /api/quality-monitoring/dashboard        — aggregate quality dashboard
 *   GET  /api/quality-monitoring/trend            — trend report (?window=24)
 *   GET  /api/quality-monitoring/alerts           — all alerts (most recent first)
 *   GET  /api/quality-monitoring/snapshots        — all snapshots across all jobs
 */

import { Router, type IRouter } from "express";
import {
  recordSnapshot,
  getSnapshots,
  getLatestSnapshot,
  getAlerts,
  listAllSnapshots,
  getDashboard,
  getTrendReport,
} from "../lib/quality-monitoring-engine.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Global views
// ---------------------------------------------------------------------------

// GET /quality-monitoring/dashboard
router.get("/quality-monitoring/dashboard", (_req, res): void => {
  res.json(getDashboard());
});

// GET /quality-monitoring/trend?window=24
router.get("/quality-monitoring/trend", (req, res): void => {
  const window = parseInt(String(req.query["window"] ?? "24"), 10);
  const hours  = isNaN(window) || window < 1 ? 24 : Math.min(window, 720);
  res.json(getTrendReport(hours));
});

// GET /quality-monitoring/alerts
router.get("/quality-monitoring/alerts", (_req, res): void => {
  const alerts = getAlerts();
  res.json({ totalAlerts: alerts.length, alerts });
});

// GET /quality-monitoring/snapshots
router.get("/quality-monitoring/snapshots", (_req, res): void => {
  const snaps = listAllSnapshots();
  res.json({ totalSnapshots: snaps.length, snapshots: snaps });
});

// ---------------------------------------------------------------------------
// Per-job actions
// ---------------------------------------------------------------------------

// POST /quality-monitoring/:jobId/record
router.post("/quality-monitoring/:jobId/record", (req, res): void => {
  const { jobId } = req.params as { jobId: string };
  const trigger: "manual" | "pipeline" | "scheduled" =
    (req.body?.trigger as "manual" | "pipeline" | "scheduled") ?? "manual";

  try {
    const snap = recordSnapshot(jobId, trigger);
    res.status(201).json(snap);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /quality-monitoring/:jobId/snapshots
router.get("/quality-monitoring/:jobId/snapshots", (req, res): void => {
  const { jobId } = req.params as { jobId: string };
  const snaps = getSnapshots(jobId);
  res.json({ jobId, totalSnapshots: snaps.length, snapshots: snaps });
});

// GET /quality-monitoring/:jobId/latest
router.get("/quality-monitoring/:jobId/latest", (req, res): void => {
  const { jobId } = req.params as { jobId: string };
  const snap = getLatestSnapshot(jobId);
  if (!snap) {
    res.status(404).json({
      error: `No quality snapshot for jobId "${jobId}".`,
      hint:  `POST /api/quality-monitoring/${jobId}/record to record one.`,
    });
    return;
  }
  res.json(snap);
});

// GET /quality-monitoring/:jobId/alerts
router.get("/quality-monitoring/:jobId/alerts", (req, res): void => {
  const { jobId } = req.params as { jobId: string };
  const alerts = getAlerts(jobId);
  res.json({ jobId, totalAlerts: alerts.length, alerts });
});

export default router;
