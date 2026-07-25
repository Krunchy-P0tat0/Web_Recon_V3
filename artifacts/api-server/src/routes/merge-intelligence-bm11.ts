/**
 * merge-intelligence-bm11.ts — Phase BM-11: Merge Intelligence Layer Routes
 *
 * POST /api/merge-intelligence-bm11/record
 *   Record a merge outcome.
 *   Body: { jobId, outcome, durationMs, decisions, conflicts, fileChanges, dryRun, conflictDetails?, notes? }
 *
 * GET  /api/merge-intelligence-bm11/report
 *   Full merge-intelligence.json with all metrics.
 *
 * GET  /api/merge-intelligence-bm11/summary
 *   Quick summary: { successRate, rollbackRate, riskLevel, safeToAutoMerge, totalMerges }
 *
 * GET  /api/merge-intelligence-bm11/patterns
 *   Conflict patterns ranked by occurrence.
 *
 * GET  /api/merge-intelligence-bm11/recommendations
 *   Actionable recommendations from the intelligence engine.
 *
 * GET  /api/merge-intelligence-bm11/records
 *   All recorded merge outcomes (most recent first).
 *
 * DELETE /api/merge-intelligence-bm11/records/:recordId
 *   Remove a specific record (admin use).
 */

import { Router, type IRouter }       from "express";
import { getDefaultCloudProvider }     from "../cloud/index.js";
import {
  recordMerge,
  getIntelligenceReport,
  computeReport,
  getAllRecords,
  type MergeOutcome,
  type ConflictRecord,
} from "../lib/merge-intelligence-bm11.js";

const router: IRouter = Router();

const VALID_OUTCOMES = new Set<MergeOutcome>(["success", "failure", "rollback", "partial"]);

// ── POST /api/merge-intelligence-bm11/record ──────────────────────────────────

router.post("/merge-intelligence-bm11/record", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { jobId, outcome, durationMs, decisions, conflicts, fileChanges, dryRun, conflictDetails, notes } = body;

  if (!jobId || typeof jobId !== "string") {
    res.status(400).json({ error: "jobId (string) is required" }); return;
  }
  if (!outcome || !VALID_OUTCOMES.has(outcome as MergeOutcome)) {
    res.status(400).json({ error: `outcome must be one of: ${[...VALID_OUTCOMES].join(", ")}` }); return;
  }

  const cloud = getDefaultCloudProvider();

  try {
    const record = await recordMerge({
      jobId:           jobId as string,
      outcome:         outcome as MergeOutcome,
      durationMs:      typeof durationMs === "number" ? durationMs : 0,
      decisions:       typeof decisions  === "number" ? decisions  : 0,
      conflicts:       typeof conflicts  === "number" ? conflicts  : 0,
      fileChanges:     typeof fileChanges === "number" ? fileChanges : 0,
      dryRun:          dryRun === true,
      conflictDetails: Array.isArray(conflictDetails) ? conflictDetails as ConflictRecord[] : [],
      notes:           typeof notes === "string" ? notes : undefined,
    }, cloud);

    req.log.info({ recordId: record.recordId, outcome: record.outcome }, "BM11: record saved");
    res.status(201).json({ ok: true, record });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "BM11: record failed");
    res.status(500).json({ error: "Failed to record merge outcome", detail: msg });
  }
});

// ── GET /api/merge-intelligence-bm11/report ───────────────────────────────────

router.get("/merge-intelligence-bm11/report", async (req, res): Promise<void> => {
  const cloud = getDefaultCloudProvider();
  try {
    const report = await getIntelligenceReport(cloud);
    res.status(200).json(report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Failed to generate intelligence report", detail: msg });
  }
});

// ── GET /api/merge-intelligence-bm11/summary ──────────────────────────────────

router.get("/merge-intelligence-bm11/summary", (_req, res): void => {
  const r = computeReport();
  res.status(200).json({
    generatedAt:     r.generatedAt,
    totalMerges:     r.totalMerges,
    successRate:     r.successRate,
    rollbackRate:    r.rollbackRate,
    failureRate:     r.failureRate,
    avgDurationMs:   r.avgDurationMs,
    avgConflicts:    r.avgConflicts,
    riskLevel:       r.riskLevel,
    safeToAutoMerge: r.safeToAutoMerge,
    successCount:    r.successCount,
    failureCount:    r.failureCount,
    rollbackCount:   r.rollbackCount,
  });
});

// ── GET /api/merge-intelligence-bm11/patterns ─────────────────────────────────

router.get("/merge-intelligence-bm11/patterns", (_req, res): void => {
  const r = computeReport();
  res.status(200).json({
    generatedAt:      r.generatedAt,
    totalPatterns:    r.conflictPatterns.length,
    conflictPatterns: r.conflictPatterns,
    dimensionStats:   r.dimensionStats,
  });
});

// ── GET /api/merge-intelligence-bm11/recommendations ─────────────────────────

router.get("/merge-intelligence-bm11/recommendations", (_req, res): void => {
  const r = computeReport();
  res.status(200).json({
    generatedAt:     r.generatedAt,
    riskLevel:       r.riskLevel,
    safeToAutoMerge: r.safeToAutoMerge,
    recommendations: r.recommendations,
  });
});

// ── GET /api/merge-intelligence-bm11/records ──────────────────────────────────

router.get("/merge-intelligence-bm11/records", async (_req, res): Promise<void> => {
  const all = await getAllRecords();
  res.status(200).json({ total: all.length, records: all.slice(0, 100) });
});

export default router;
