/**
 * supervisor.ts — HTTP routes for Phase F1 (Job Supervisor) and Phase F2 (Failure Classifier)
 *
 * GET /api/supervisor/report         — full supervisor report
 * GET /api/supervisor/health         — job health report
 * GET /api/supervisor/workers        — worker status report
 * POST /api/supervisor/cycle         — force an immediate supervision cycle
 * GET /api/supervisor/failures       — failure classification report
 * GET /api/supervisor/failures/roots — root cause report
 * GET /api/supervisor/failures/retry — retry recommendation report
 * POST /api/supervisor/failures/flush — force flush failure reports to disk
 */

import { Router } from "express";
import {
  getSupervisorReport,
  getHealthReport,
  getWorkerReport,
  forceCycle,
} from "../lib/job-supervisor.js";
import {
  allClassifications,
  flushReports,
  type FailureClassificationReport,
  type FailureRootCauseReport,
  type RetryRecommendationReport,
} from "../lib/failure-classifier.js";

const router = Router();

// ---------------------------------------------------------------------------
// F1 — Job Supervisor
// ---------------------------------------------------------------------------

router.get("/supervisor/report", async (req, res) => {
  const report = getSupervisorReport();
  if (!report) {
    res.status(503).json({ error: "Supervisor not yet initialized — try again in a few seconds" });
    return;
  }
  res.json(report);
});

router.get("/supervisor/health", async (req, res) => {
  const report = getHealthReport();
  if (!report) {
    res.status(503).json({ error: "Supervisor not yet initialized" });
    return;
  }
  res.json(report);
});

router.get("/supervisor/workers", async (req, res) => {
  const report = getWorkerReport();
  if (!report) {
    res.status(503).json({ error: "Supervisor not yet initialized" });
    return;
  }
  res.json(report);
});

router.post("/supervisor/cycle", async (req, res) => {
  try {
    const reports = await forceCycle();
    res.json({
      message: "Supervision cycle completed",
      systemHealth: reports.supervisorReport.systemHealth,
      unhealthyJobs: reports.healthReport.unhealthyJobs.length,
      totalTracked: reports.supervisorReport.totalTrackedJobs,
    });
  } catch (err) {
    res.status(500).json({
      error: "Supervision cycle failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// ---------------------------------------------------------------------------
// F2 — Failure Classifier
// ---------------------------------------------------------------------------

router.get("/supervisor/failures", async (req, res) => {
  const list = allClassifications();
  const byClass: Record<string, number> = {};
  const byRisk: Record<string, number> = {};

  for (const c of list) {
    byClass[c.failureClass] = (byClass[c.failureClass] ?? 0) + 1;
    byRisk[c.riskLevel] = (byRisk[c.riskLevel] ?? 0) + 1;
  }

  const report: FailureClassificationReport = {
    generatedAt: new Date().toISOString(),
    totalClassified: list.length,
    byClass: byClass as FailureClassificationReport["byClass"],
    byRisk: byRisk as FailureClassificationReport["byRisk"],
    classifications: list,
  };
  res.json(report);
});

router.get("/supervisor/failures/roots", async (req, res) => {
  const list = allClassifications();
  const report: FailureRootCauseReport = {
    generatedAt: new Date().toISOString(),
    totalFailures: list.length,
    rootCauses: list.map((c) => ({
      jobId: c.jobId,
      failureClass: c.failureClass,
      rootCause: c.rootCause,
      confidence: c.confidence,
      riskLevel: c.riskLevel,
      classifiedAt: c.classifiedAt,
    })),
  };
  res.json(report);
});

router.get("/supervisor/failures/retry", async (req, res) => {
  const list = allClassifications();
  const counts = {
    retry_immediately: 0,
    retry_with_backoff: 0,
    retry_after_fix: 0,
    do_not_retry: 0,
  };
  for (const c of list) counts[c.retryRecommendation]++;

  const report: RetryRecommendationReport = {
    generatedAt: new Date().toISOString(),
    totalJobs: list.length,
    retryImmediately: counts.retry_immediately,
    retryWithBackoff: counts.retry_with_backoff,
    retryAfterFix: counts.retry_after_fix,
    doNotRetry: counts.do_not_retry,
    recommendations: list.map((c) => ({
      jobId: c.jobId,
      failureClass: c.failureClass,
      retryRecommendation: c.retryRecommendation,
      recoveryRecommendation: c.recoveryRecommendation,
      retryCount: c.retryCount,
      maxRetries: c.maxRetries,
    })),
  };
  res.json(report);
});

router.post("/supervisor/failures/flush", async (req, res) => {
  try {
    const reports = await flushReports();
    res.json({
      message: "Failure reports flushed to disk",
      totalClassified: reports.classificationReport.totalClassified,
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to flush reports",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
