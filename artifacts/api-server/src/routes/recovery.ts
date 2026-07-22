/**
 * routes/recovery.ts — Phase F3 + F4 HTTP endpoints
 *
 * F3 Autonomous Recovery Engine:
 *   GET  /recovery/report              — full RecoveryReport
 *   GET  /recovery/retry-history       — all RetryHistoryEntry records
 *   GET  /recovery/automatic-report    — AutomaticRecoveryReport with chains
 *   POST /recovery/trigger/:jobId      — manually trigger recovery for a job
 *   POST /recovery/cancel-retry/:jobId — cancel a pending delayed retry
 *   POST /recovery/flush               — flush all 3 F3 reports to disk
 *
 * F4 Checkpoint Resume Engine:
 *   GET  /checkpoint/report            — CheckpointResumeReport
 *   GET  /checkpoint/validation        — ResumeValidationReport
 *   GET  /checkpoint/integrity         — CheckpointIntegrityReport
 *   GET  /checkpoint/:jobId            — single job checkpoint snapshot
 *   GET  /checkpoint                   — all active checkpoints
 *   POST /checkpoint/:jobId/reset      — reset a job's checkpoint (restart from zero)
 *   POST /checkpoint/flush             — flush all 3 F4 reports to disk
 */

import { Router } from "express";
import { logger } from "../lib/logger.js";
import {
  executeRecovery,
  getRecoveryReport,
  getRetryHistory,
  getAutomaticRecoveryReport,
  cancelPendingRetry,
  flushReports as flushRecoveryReports,
} from "../lib/autonomous-recovery-engine.js";
import {
  getCheckpointResumeReport,
  getResumeValidationReport,
  getCheckpointIntegrityReport,
  getJobCheckpoint,
  getAllActiveCheckpoints,
  resetCheckpoint,
  flushReports as flushCheckpointReports,
} from "../lib/checkpoint-engine.js";
import {
  allClassifications,
  getFailureClassificationReport,
  getFailureRootCauseReport,
  getRetryRecommendationReport,
  getClassifierPatternCatalog,
} from "../lib/failure-classifier.js";
import { getLatestRecoveryReport, getLatestRepairPlan } from "../lib/e2-recovery-runner.js";
import { getQueueDepth } from "../lib/db-queue.js";

const router = Router();

// ============================================================================
// F3 — Recovery Engine
// ============================================================================

/**
 * GET /recovery/report
 * Full RecoveryReport: all actions, counts by type/class, outcomes.
 */
router.get("/recovery/report", (_req, res) => {
  try {
    const report = getRecoveryReport();
    res.json({ ok: true, data: report });
  } catch (err) {
    logger.error({ err }, "ROUTE: /recovery/report failed");
    res.status(500).json({ ok: false, error: "Failed to build recovery report" });
  }
});

/**
 * GET /recovery/retry-history
 * All retry history entries: per-job, per-class, per-action.
 */
router.get("/recovery/retry-history", (_req, res) => {
  try {
    const history = getRetryHistory();
    res.json({ ok: true, data: history });
  } catch (err) {
    logger.error({ err }, "ROUTE: /recovery/retry-history failed");
    res.status(500).json({ ok: false, error: "Failed to build retry history" });
  }
});

/**
 * GET /recovery/automatic-report
 * AutomaticRecoveryReport: recovery chains, summary stats.
 */
router.get("/recovery/automatic-report", (_req, res) => {
  try {
    const report = getAutomaticRecoveryReport();
    res.json({ ok: true, data: report });
  } catch (err) {
    logger.error({ err }, "ROUTE: /recovery/automatic-report failed");
    res.status(500).json({ ok: false, error: "Failed to build automatic recovery report" });
  }
});

/**
 * POST /recovery/trigger/:jobId
 * Manually trigger F3 recovery for a job by its latest classification.
 * Body: optional { failureClassOverride?: string }
 */
router.post("/recovery/trigger/:jobId", async (req, res) => {
  const { jobId } = req.params;
  try {
    const classifications = allClassifications();
    const classification = [...classifications]
      .reverse()
      .find((c) => c.jobId === jobId);

    if (!classification) {
      res.status(404).json({
        ok: false,
        error: `No failure classification found for job ${jobId}. The job must have failed and been classified by F2 before F3 can recover it.`,
      });
      return;
    }

    logger.info({ jobId, failureClass: classification.failureClass }, "ROUTE: manual recovery trigger");
    const action = await executeRecovery(classification);
    res.json({ ok: true, data: action });
  } catch (err) {
    logger.error({ err, jobId }, "ROUTE: /recovery/trigger failed");
    res.status(500).json({ ok: false, error: `Recovery trigger failed: ${err instanceof Error ? err.message : String(err)}` });
  }
});

/**
 * POST /recovery/cancel-retry/:jobId
 * Cancel a pending delayed retry that hasn't fired yet.
 */
router.post("/recovery/cancel-retry/:jobId", (req, res) => {
  const { jobId } = req.params;
  try {
    const cancelled = cancelPendingRetry(jobId);
    res.json({ ok: true, data: { jobId, cancelled } });
  } catch (err) {
    logger.error({ err, jobId }, "ROUTE: /recovery/cancel-retry failed");
    res.status(500).json({ ok: false, error: "Failed to cancel retry" });
  }
});

/**
 * POST /recovery/flush
 * Flush all three F3 reports to disk.
 */
router.post("/recovery/flush", async (_req, res) => {
  try {
    const result = await flushRecoveryReports();
    res.json({
      ok: true,
      data: {
        flushedAt: new Date().toISOString(),
        recoveryReport: {
          totalActions: result.recoveryReport.totalActionsTriggered,
          totalSucceeded: result.recoveryReport.totalSucceeded,
          totalAborted: result.recoveryReport.totalAborted,
        },
        retryHistory: {
          totalEntries: result.retryHistoryReport.entries.length,
        },
        automaticRecoveryReport: {
          jobsAutoRecovered: result.automaticRecoveryReport.summary.jobsAutoRecovered,
          jobsAborted: result.automaticRecoveryReport.summary.jobsAborted,
        },
      },
    });
  } catch (err) {
    logger.error({ err }, "ROUTE: /recovery/flush failed");
    res.status(500).json({ ok: false, error: "Failed to flush recovery reports" });
  }
});

// ============================================================================
// F2 — Failure Classification Engine (reference data for Recovery Center)
// ============================================================================

/**
 * GET /recovery/classifications
 * Every FailureClassification currently in memory, unfiltered.
 */
router.get("/recovery/classifications", (_req, res) => {
  try {
    res.json({ ok: true, data: allClassifications() });
  } catch (err) {
    logger.error({ err }, "ROUTE: /recovery/classifications failed");
    res.status(500).json({ ok: false, error: "Failed to list classifications" });
  }
});

/**
 * GET /recovery/classifications/report
 * FailureClassificationReport: totals by class/risk + full records.
 */
router.get("/recovery/classifications/report", (_req, res) => {
  try {
    res.json({ ok: true, data: getFailureClassificationReport() });
  } catch (err) {
    logger.error({ err }, "ROUTE: /recovery/classifications/report failed");
    res.status(500).json({ ok: false, error: "Failed to build classification report" });
  }
});

/**
 * GET /recovery/classifications/root-causes
 * FailureRootCauseReport: per-job root cause + confidence + risk.
 */
router.get("/recovery/classifications/root-causes", (_req, res) => {
  try {
    res.json({ ok: true, data: getFailureRootCauseReport() });
  } catch (err) {
    logger.error({ err }, "ROUTE: /recovery/classifications/root-causes failed");
    res.status(500).json({ ok: false, error: "Failed to build root cause report" });
  }
});

/**
 * GET /recovery/classifications/retry-recommendations
 * RetryRecommendationReport: per-job retry guidance breakdown.
 */
router.get("/recovery/classifications/retry-recommendations", (_req, res) => {
  try {
    res.json({ ok: true, data: getRetryRecommendationReport() });
  } catch (err) {
    logger.error({ err }, "ROUTE: /recovery/classifications/retry-recommendations failed");
    res.status(500).json({ ok: false, error: "Failed to build retry recommendation report" });
  }
});

/**
 * GET /recovery/classifications/patterns
 * Reference catalogue of every classifier pattern (sanitized — no raw regex).
 */
router.get("/recovery/classifications/patterns", (_req, res) => {
  try {
    res.json({ ok: true, data: getClassifierPatternCatalog() });
  } catch (err) {
    logger.error({ err }, "ROUTE: /recovery/classifications/patterns failed");
    res.status(500).json({ ok: false, error: "Failed to build pattern catalogue" });
  }
});

// ============================================================================
// E2/E3 — System Recovery Engine + Repair Plan (infra-level, not job-level)
// ============================================================================

/**
 * GET /recovery/system-report
 * Latest SystemRecoveryReport (E2): routes/assets/manifests/deployments repair findings.
 * Null until the first monitoring cycle has run.
 */
router.get("/recovery/system-report", (_req, res) => {
  try {
    res.json({ ok: true, data: getLatestRecoveryReport() });
  } catch (err) {
    logger.error({ err }, "ROUTE: /recovery/system-report failed");
    res.status(500).json({ ok: false, error: "Failed to get system recovery report" });
  }
});

/**
 * GET /recovery/repair-plan
 * Latest RepairPlan (E3): root causes + prioritized planned repairs.
 * Null until the first monitoring cycle has run.
 */
router.get("/recovery/repair-plan", (_req, res) => {
  try {
    res.json({ ok: true, data: getLatestRepairPlan() });
  } catch (err) {
    logger.error({ err }, "ROUTE: /recovery/repair-plan failed");
    res.status(500).json({ ok: false, error: "Failed to get repair plan" });
  }
});

// ============================================================================
// Derived views — Queue State, Batch State, Storage Upload Status, Timeline
// ============================================================================

/**
 * GET /recovery/queue-state
 * Live scrape_jobs queue depth by status.
 */
router.get("/recovery/queue-state", async (_req, res) => {
  try {
    const depth = await getQueueDepth();
    res.json({ ok: true, data: { generatedAt: new Date().toISOString(), ...depth } });
  } catch (err) {
    logger.error({ err }, "ROUTE: /recovery/queue-state failed");
    res.status(500).json({ ok: false, error: "Failed to get queue state" });
  }
});

/**
 * GET /recovery/batch-state
 * Derived view of every batch_split recovery action (no standalone batch
 * object exists — this reconstructs it from RecoveryAction fields).
 */
router.get("/recovery/batch-state", (_req, res) => {
  try {
    const report = getRecoveryReport();
    const splits = report.actions.filter(
      (a) => a.actionType === "batch_split" || a.childJobIds.length > 0
    );
    res.json({
      ok: true,
      data: {
        generatedAt: new Date().toISOString(),
        totalBatchSplits: splits.length,
        totalChildJobsSpawned: splits.reduce((n, a) => n + a.childJobIds.length, 0),
        splits: splits.map((a) => ({
          jobId: a.jobId,
          seedUrl: a.seedUrl,
          triggeredAt: a.triggeredAt,
          completedAt: a.completedAt,
          failureClass: a.failureClass,
          originalBatchSize: a.originalBatchSize,
          newBatchSize: a.newBatchSize,
          childJobIds: a.childJobIds,
          outcome: a.outcome,
          outcomeDetail: a.outcomeDetail,
        })),
      },
    });
  } catch (err) {
    logger.error({ err }, "ROUTE: /recovery/batch-state failed");
    res.status(500).json({ ok: false, error: "Failed to build batch state view" });
  }
});

/**
 * GET /recovery/storage-status
 * Rollup of StorageState across every active checkpoint (F4).
 */
router.get("/recovery/storage-status", (_req, res) => {
  try {
    const all = getAllActiveCheckpoints();
    const jobs = all.map((cp) => ({
      jobId: cp.jobId,
      seedUrl: cp.seedUrl,
      uploadedCount: cp.storageState.uploadedKeys.length,
      totalBytesUploaded: cp.storageState.totalBytesUploaded,
      lastUploadedAt: cp.storageState.lastUploadedAt,
      pendingCount: cp.storageState.pendingKeys.length,
      uploadedKeys: cp.storageState.uploadedKeys,
      pendingKeys: cp.storageState.pendingKeys,
    }));
    res.json({
      ok: true,
      data: {
        generatedAt: new Date().toISOString(),
        totalJobs: jobs.length,
        totalBytesUploaded: jobs.reduce((n, j) => n + j.totalBytesUploaded, 0),
        totalPendingUploads: jobs.reduce((n, j) => n + j.pendingCount, 0),
        jobs,
      },
    });
  } catch (err) {
    logger.error({ err }, "ROUTE: /recovery/storage-status failed");
    res.status(500).json({ ok: false, error: "Failed to build storage status view" });
  }
});

/**
 * GET /recovery/timeline
 * Per-job chronological merge of F2 classification + F3 recovery actions —
 * the closest thing to a single "what happened to this job" view.
 * GET /recovery/timeline/:jobId narrows to one job.
 */
function recoveryTimelineHandler(req: import("express").Request, res: import("express").Response) {
  try {
    const filterJobId = req.params.jobId as string | undefined;
    const classifications = allClassifications();
    const recoveryReport = getRecoveryReport();

    const jobIds = new Set<string>();
    for (const c of classifications) jobIds.add(c.jobId);
    for (const a of recoveryReport.actions) jobIds.add(a.jobId);

    const timelines = Array.from(jobIds)
      .filter((jobId) => !filterJobId || jobId === filterJobId)
      .map((jobId) => {
        const classification = classifications.find((c) => c.jobId === jobId) ?? null;
        const actions = recoveryReport.actions.filter((a) => a.jobId === jobId);

        const events: Array<{ type: string; at: string; detail: Record<string, unknown> }> = [];

        if (classification) {
          events.push({
            type: "classified",
            at: classification.classifiedAt,
            detail: {
              failureClass: classification.failureClass,
              confidence: classification.confidence,
              riskLevel: classification.riskLevel,
              retryRecommendation: classification.retryRecommendation,
              rootCause: classification.rootCause,
              recoveryRecommendation: classification.recoveryRecommendation,
            },
          });
        }

        for (const a of actions) {
          events.push({
            type: "recovery_triggered",
            at: a.triggeredAt,
            detail: { actionId: a.actionId, actionType: a.actionType, actionReason: a.actionReason, delayMs: a.delayMs },
          });
          if (a.completedAt) {
            events.push({
              type: "recovery_completed",
              at: a.completedAt,
              detail: {
                actionId: a.actionId,
                actionType: a.actionType,
                outcome: a.outcome,
                outcomeDetail: a.outcomeDetail,
                childJobIds: a.childJobIds,
              },
            });
          }
        }

        events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
        const lastAction = actions[actions.length - 1];

        return {
          jobId,
          seedUrl: classification?.seedUrl ?? actions[0]?.seedUrl ?? "unknown",
          failureClass: classification?.failureClass ?? actions[0]?.failureClass ?? null,
          currentStatus: lastAction ? lastAction.outcome : classification ? "classified_only" : "unknown",
          events,
        };
      });

    timelines.sort((a, b) => {
      const aLast = a.events[a.events.length - 1]?.at ?? "";
      const bLast = b.events[b.events.length - 1]?.at ?? "";
      return bLast.localeCompare(aLast);
    });

    if (filterJobId && timelines.length === 0) {
      res.status(404).json({ ok: false, error: `No classification or recovery activity found for job ${filterJobId}` });
      return;
    }

    res.json({
      ok: true,
      data: { generatedAt: new Date().toISOString(), totalJobs: timelines.length, timelines },
    });
  } catch (err) {
    logger.error({ err }, "ROUTE: /recovery/timeline failed");
    res.status(500).json({ ok: false, error: "Failed to build recovery timeline" });
  }
}

router.get("/recovery/timeline", recoveryTimelineHandler);
router.get("/recovery/timeline/:jobId", recoveryTimelineHandler);

// ============================================================================
// F4 — Checkpoint Resume Engine
// ============================================================================

/**
 * GET /checkpoint/report
 * CheckpointResumeReport: total active checkpoints, resume events.
 */
router.get("/checkpoint/report", (_req, res) => {
  try {
    const report = getCheckpointResumeReport();
    res.json({ ok: true, data: report });
  } catch (err) {
    logger.error({ err }, "ROUTE: /checkpoint/report failed");
    res.status(500).json({ ok: false, error: "Failed to build checkpoint resume report" });
  }
});

/**
 * GET /checkpoint/validation
 * ResumeValidationReport: checksum validity for all active checkpoints.
 */
router.get("/checkpoint/validation", (_req, res) => {
  try {
    const report = getResumeValidationReport();
    res.json({ ok: true, data: report });
  } catch (err) {
    logger.error({ err }, "ROUTE: /checkpoint/validation failed");
    res.status(500).json({ ok: false, error: "Failed to build validation report" });
  }
});

/**
 * GET /checkpoint/integrity
 * CheckpointIntegrityReport: healthy/corrupted/missing breakdown.
 */
router.get("/checkpoint/integrity", (_req, res) => {
  try {
    const report = getCheckpointIntegrityReport();
    res.json({ ok: true, data: report });
  } catch (err) {
    logger.error({ err }, "ROUTE: /checkpoint/integrity failed");
    res.status(500).json({ ok: false, error: "Failed to build integrity report" });
  }
});

/**
 * GET /checkpoint
 * All active in-memory checkpoints (array).
 * ?full=true returns the complete JobCheckpoint object per job (queue arrays,
 * coverage/manifest/differential/storage sub-states, checksum) instead of the
 * trimmed summary — used by the Recovery & Checkpoints Center so nothing is hidden.
 */
router.get("/checkpoint", (req, res) => {
  try {
    const all = getAllActiveCheckpoints();

    if (req.query.full === "true") {
      res.json({ ok: true, data: { count: all.length, checkpoints: all } });
      return;
    }

    res.json({
      ok: true,
      data: {
        count: all.length,
        checkpoints: all.map((cp) => ({
          jobId: cp.jobId,
          seedUrl: cp.seedUrl,
          checkpointVersion: cp.checkpointVersion,
          checkpointedAt: cp.checkpointedAt,
          completedUrls: cp.completedUrls.length,
          pendingUrls: cp.pendingUrls.length,
          failedUrls: cp.failedUrls.length,
          coverage: cp.coverageState.coveragePercent,
          isValid: cp.isValid,
        })),
      },
    });
  } catch (err) {
    logger.error({ err }, "ROUTE: GET /checkpoint failed");
    res.status(500).json({ ok: false, error: "Failed to list checkpoints" });
  }
});

/**
 * GET /checkpoint/:jobId
 * Full checkpoint snapshot for a specific job.
 */
router.get("/checkpoint/:jobId", (req, res) => {
  const { jobId } = req.params;
  try {
    const cp = getJobCheckpoint(jobId);
    if (!cp) {
      res.status(404).json({ ok: false, error: `No active checkpoint found for job ${jobId}` });
      return;
    }
    res.json({ ok: true, data: cp });
  } catch (err) {
    logger.error({ err, jobId }, "ROUTE: GET /checkpoint/:jobId failed");
    res.status(500).json({ ok: false, error: "Failed to get checkpoint" });
  }
});

/**
 * POST /checkpoint/:jobId/reset
 * Reset a job's checkpoint so it restarts from zero on next run.
 */
router.post("/checkpoint/:jobId/reset", async (req, res) => {
  const { jobId } = req.params;
  try {
    await resetCheckpoint(jobId);
    logger.info({ jobId }, "ROUTE: checkpoint reset via API");
    res.json({ ok: true, data: { jobId, reset: true, resetAt: new Date().toISOString() } });
  } catch (err) {
    logger.error({ err, jobId }, "ROUTE: /checkpoint/:jobId/reset failed");
    res.status(500).json({ ok: false, error: "Failed to reset checkpoint" });
  }
});

/**
 * POST /checkpoint/flush
 * Flush all three F4 reports to disk.
 */
router.post("/checkpoint/flush", async (_req, res) => {
  try {
    const result = await flushCheckpointReports();
    res.json({
      ok: true,
      data: {
        flushedAt: new Date().toISOString(),
        checkpointResumeReport: {
          totalCheckpoints: result.resumeReport.totalCheckpoints,
          totalResumed: result.resumeReport.totalResumed,
        },
        validationReport: {
          totalValid: result.validationReport.totalValid,
          totalInvalid: result.validationReport.totalInvalid,
        },
        integrityReport: {
          totalHealthy: result.integrityReport.totalHealthy,
          totalCorrupted: result.integrityReport.totalCorrupted,
        },
      },
    });
  } catch (err) {
    logger.error({ err }, "ROUTE: /checkpoint/flush failed");
    res.status(500).json({ ok: false, error: "Failed to flush checkpoint reports" });
  }
});

export default router;
