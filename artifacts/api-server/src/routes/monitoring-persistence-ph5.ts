/**
 * monitoring-persistence-ph5.ts — PH-5: Quality Snapshot Persistence Routes
 *
 *   GET  /api/monitoring-persistence/report    — R2 monitoring report
 *   GET  /api/monitoring-persistence/snapshots — snapshot persistence report
 *   GET  /api/monitoring-persistence/index     — storage index (keys + URLs)
 *   GET  /api/monitoring-persistence/status    — service status
 *   POST /api/monitoring-persistence/flush     — manually trigger R2 flush
 */

import { Router, type IRouter } from "express";
import {
  getR2MonitoringReport,
  getSnapshotPersistenceReport,
  getStorageIndex,
  getPersistenceStatus,
  triggerFlush,
} from "../lib/monitoring-persistence-service.js";

const router: IRouter = Router();

// GET /monitoring-persistence/report
router.get("/monitoring-persistence/report", (_req, res): void => {
  res.json(getR2MonitoringReport());
});

// GET /monitoring-persistence/snapshots
router.get("/monitoring-persistence/snapshots", (_req, res): void => {
  res.json(getSnapshotPersistenceReport());
});

// GET /monitoring-persistence/index
router.get("/monitoring-persistence/index", (_req, res): void => {
  res.json(getStorageIndex());
});

// GET /monitoring-persistence/status
router.get("/monitoring-persistence/status", (_req, res): void => {
  res.json(getPersistenceStatus());
});

// POST /monitoring-persistence/flush — manual flush to R2
router.post("/monitoring-persistence/flush", async (_req, res): Promise<void> => {
  const result = await triggerFlush();
  if (result.success) {
    res.json({ message: "Flush to R2 complete", report: getR2MonitoringReport() });
  } else {
    res.status(500).json({ error: result.error, report: getR2MonitoringReport() });
  }
});

export default router;
