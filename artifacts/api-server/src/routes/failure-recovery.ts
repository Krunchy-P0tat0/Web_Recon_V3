/**
 * failure-recovery.ts — Phase 7.7 HTTP Routes
 *
 * GET  /api/recovery/orchestration                         — list all recovery records
 * GET  /api/recovery/orchestration/:id                     — single recovery record
 * POST /api/recovery/orchestration/:jobId/recover          — trigger recovery for a failed job
 * POST /api/recovery/orchestration/simulate                — simulate a failure + recovery (test)
 * GET  /api/recovery/orchestration/report                  — failure-recovery-report.json
 * POST /api/recovery/orchestration/report/generate         — force regenerate report
 * GET  /api/recovery/orchestration/policies                — view retry/rollback/resume policies
 */

import { Router, type IRouter } from "express";
import {
  listRecoveryRecords,
  getRecoveryRecord,
  recoverJob,
  simulateFailure,
  persistReport,
  loadReport,
  RETRY_POLICIES,
  ROLLBACK_POLICIES,
  RESUME_POLICIES,
  type FailureClass,
} from "../lib/failure-recovery-orchestrator.js";

const router: IRouter = Router();

// GET /recovery/orchestration/policies
router.get("/recovery/orchestration/policies", (_req, res): void => {
  res.json({
    description: "Phase 7.7 — failure recovery policies applied per failure class",
    failureClasses: [
      "crawl_failure",
      "manifest_failure",
      "merge_failure",
      "deployment_failure",
      "storage_failure",
      "unknown_failure",
    ],
    retryPolicies:    RETRY_POLICIES,
    rollbackPolicies: ROLLBACK_POLICIES,
    resumePolicies:   RESUME_POLICIES,
  });
});

// GET /recovery/orchestration/report
router.get("/recovery/orchestration/report", async (_req, res): Promise<void> => {
  try {
    const cached = await loadReport();
    if (cached) { res.json(cached); return; }
    await persistReport();
    const fresh = await loadReport();
    res.json(fresh ?? { records: [], summary: {} });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /recovery/orchestration/report/generate
router.post("/recovery/orchestration/report/generate", async (_req, res): Promise<void> => {
  try {
    await persistReport();
    const report = await loadReport();
    res.json({ generated: true, report });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /recovery/orchestration
router.get("/recovery/orchestration", (_req, res): void => {
  const records = listRecoveryRecords();
  res.json({
    total:        records.length,
    recovered:    records.filter((r) => r.finalOutcome === "recovered").length,
    unrecoverable:records.filter((r) => r.finalOutcome === "unrecoverable").length,
    inProgress:   records.filter((r) => r.finalOutcome === "in_progress").length,
    records:      records.map((r) => ({
      id:              r.id,
      originalJobId:   r.originalJobId,
      url:             r.url,
      failureClass:    r.failure.class,
      failedStage:     r.failure.failedStage,
      finalOutcome:    r.finalOutcome,
      recoveredJobId:  r.recoveredJobId,
      attempts:        r.attempts.length,
      startedAt:       r.startedAt,
      completedAt:     r.completedAt,
      totalDurationMs: r.totalDurationMs,
    })),
  });
});

// GET /recovery/orchestration/:id
router.get("/recovery/orchestration/:id", (req, res): void => {
  const record = getRecoveryRecord(req.params["id"] ?? "");
  if (!record) {
    res.status(404).json({ error: "Recovery record not found" });
    return;
  }
  res.json(record);
});

// POST /recovery/orchestration/:jobId/recover
router.post("/recovery/orchestration/:jobId/recover", async (req, res): Promise<void> => {
  const jobId = req.params["jobId"] ?? "";
  try {
    const record = await recoverJob(jobId);
    if (!record) {
      res.status(404).json({
        error: "Job not found or is not in a failed state",
        hint:  "Only jobs with status 'failed' or 'cancelled' can be recovered",
      });
      return;
    }
    res.status(202).json({
      recoveryId:    record.id,
      originalJobId: record.originalJobId,
      url:           record.url,
      failureClass:  record.failure.class,
      failedStage:   record.failure.failedStage,
      resumeFromStage: record.failure.resumePolicy.fromStage,
      retryPolicy:   record.failure.retryPolicy,
      rationale:     record.failure.rationale,
      finalOutcome:  record.finalOutcome,
      startedAt:     record.startedAt,
      pollUrl:       `/api/recovery/orchestration/${record.id}`,
      message:       "Recovery launched. Poll pollUrl for progress.",
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /recovery/orchestration/simulate
router.post("/recovery/orchestration/simulate", async (req, res): Promise<void> => {
  const { url, failureClass } = (req.body ?? {}) as {
    url?:          string;
    failureClass?: string;
  };

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url is required" });
    return;
  }

  const validClasses: FailureClass[] = [
    "crawl_failure", "manifest_failure", "merge_failure",
    "deployment_failure", "storage_failure", "unknown_failure",
  ];
  const cls = (validClasses.includes(failureClass as FailureClass)
    ? failureClass
    : "crawl_failure") as FailureClass;

  try {
    const { job, recovery } = await simulateFailure(url, cls);
    res.status(202).json({
      simulatedJobId: job.id,
      simulatedFailureClass: cls,
      failedStage:    job.stages.find((s) => s.status === "failed")?.id ?? null,
      recovery: recovery ? {
        recoveryId:      recovery.id,
        failureClass:    recovery.failure.class,
        resumeFromStage: recovery.failure.resumePolicy.fromStage,
        retryPolicy:     recovery.failure.retryPolicy,
        pollUrl:         `/api/recovery/orchestration/${recovery.id}`,
      } : null,
      message: "Failure simulated and recovery launched. Poll recovery.pollUrl for status.",
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
