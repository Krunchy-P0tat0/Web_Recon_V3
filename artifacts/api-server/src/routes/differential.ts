/**
 * routes/differential.ts — Differential Center HTTP endpoints
 *
 * Exposes the pre-existing Differential Engine (lib/diff-engine.ts) and
 * Differential Intelligence Layer (lib/diff-intelligence.ts) over HTTP.
 * No diff computation happens here — this route only reads persisted
 * results (differential_history table + R2 intelligence reports written
 * by job-worker.ts during a diff-mode job run).
 *
 * GET /differential/summary       — global savings summary across all diff runs
 * GET /differential/history       — most recent diff runs (all seed URLs)
 * GET /differential/:jobId        — one diff run's history record + changed URLs
 * GET /differential/:jobId/report — full DifferentialAuditReport from R2 (if written)
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  getDiffHistoryForJob,
  listAllDiffHistory,
  getDiffGlobalSummary,
} from "../lib/db-queue.js";
import { loadIntelligenceReport, type DifferentialAuditReport } from "../lib/diff-intelligence.js";
import type { ChangedUrlEntry } from "../lib/diff-intelligence.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();
const cloudProvider = getDefaultCloudProvider();

function jobIdParam(req: Request): string {
  const v = req.params.jobId;
  return Array.isArray(v) ? v[0] : v;
}

// ---------------------------------------------------------------------------
// GET /differential/summary — global savings summary
// ---------------------------------------------------------------------------

router.get("/differential/summary", async (_req: Request, res: Response) => {
  try {
    const summary = await getDiffGlobalSummary();
    res.json({ ok: true, data: summary });
  } catch (err) {
    logger.error({ err }, "ROUTE: /differential/summary failed");
    res.status(500).json({ ok: false, error: "Failed to load differential summary" });
  }
});

// ---------------------------------------------------------------------------
// GET /differential/history — most recent diff runs across all sites
// ---------------------------------------------------------------------------

router.get("/differential/history", async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await listAllDiffHistory(limit);
    res.json({ ok: true, data: rows });
  } catch (err) {
    logger.error({ err }, "ROUTE: /differential/history failed");
    res.status(500).json({ ok: false, error: "Failed to load differential history" });
  }
});

// ---------------------------------------------------------------------------
// GET /differential/:jobId — one diff run's history + parsed changed URLs
// ---------------------------------------------------------------------------

router.get("/differential/:jobId", async (req: Request, res: Response) => {
  const jobId = jobIdParam(req);
  try {
    const record = await getDiffHistoryForJob(jobId);
    if (!record) {
      res.status(404).json({ ok: false, error: `No differential run found for job ${jobId}` });
      return;
    }
    let changedUrls: ChangedUrlEntry[] = [];
    try {
      changedUrls = JSON.parse(record.changedUrlsJson) as ChangedUrlEntry[];
    } catch {
      changedUrls = [];
    }
    res.json({ ok: true, data: { ...record, changedUrls } });
  } catch (err) {
    logger.error({ err, jobId }, "ROUTE: /differential/:jobId failed");
    res.status(500).json({ ok: false, error: "Failed to load differential run" });
  }
});

// ---------------------------------------------------------------------------
// GET /differential/:jobId/report — full audit report from R2, if written
// ---------------------------------------------------------------------------

router.get("/differential/:jobId/report", async (req: Request, res: Response) => {
  const jobId = jobIdParam(req);
  try {
    const report = await loadIntelligenceReport<DifferentialAuditReport>(
      cloudProvider,
      jobId,
      "_differential-audit-report.json",
    );
    if (!report) {
      res.status(404).json({ ok: false, error: `No audit report found for job ${jobId}` });
      return;
    }
    res.json({ ok: true, data: report });
  } catch (err) {
    logger.error({ err, jobId }, "ROUTE: /differential/:jobId/report failed");
    res.status(500).json({ ok: false, error: "Failed to load differential audit report" });
  }
});

export default router;
