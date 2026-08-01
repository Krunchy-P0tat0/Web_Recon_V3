/**
 * merge-orchestrator-bm12.ts — Phase BM-12: Autonomous Merge Orchestrator Routes
 *
 * POST /api/merge-orchestrator-bm12/:jobId/run
 *   Start a full autonomous 7-stage merge pipeline.
 *   Body: { dryRun?: boolean, autonomyThreshold?: number, force?: boolean }
 *   Returns: MergeOrchestrationReport
 *
 * GET  /api/merge-orchestrator-bm12/:jobId/report
 *   Return cached merge-orchestration-report.json
 *
 * GET  /api/merge-orchestrator-bm12/:jobId/status
 *   Live stage-by-stage status (for polling during execution).
 *
 * POST /api/merge-orchestrator-bm12/:jobId/approve
 *   Approve a paused-for-review orchestration and re-run with force.
 */

import { Router, type IRouter }          from "express";
import { getDefaultCloudProvider }        from "../cloud/index.js";
import {
  runMergeOrchestrator,
  getCachedOrchestrationReport,
  isOrchestrationRunning,
  runningSet,
} from "../lib/merge-orchestrator-bm12.js";

const router: IRouter = Router();

// ── POST /api/merge-orchestrator-bm12/:jobId/run ─────────────────────────────

router.post("/merge-orchestrator-bm12/:jobId/run", async (req, res): Promise<void> => {
  const jobId = (req.params as Record<string, string>)["jobId"] ?? "";
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  if (isOrchestrationRunning(jobId)) {
    res.status(409).json({
      error: "Orchestration already running for this job.",
      hint:  `GET /api/merge-orchestrator-bm12/${jobId}/status`,
    });
    return;
  }

  const body  = (req.body ?? {}) as Record<string, unknown>;
  const dryRun             = body["dryRun"] !== false;
  const force              = body["force"] === true;
  const autonomyThreshold  = typeof body["autonomyThreshold"] === "number" ? body["autonomyThreshold"] : 70;

  const cached = getCachedOrchestrationReport(jobId);
  if (cached && !force) {
    res.status(200).json({ cached: true, ...cached });
    return;
  }

  req.log.info({ jobId, dryRun, autonomyThreshold }, "BM12: orchestration run requested");
  runningSet.add(jobId);

  const cloud = getDefaultCloudProvider();

  try {
    const report = await runMergeOrchestrator(jobId, cloud, { dryRun, autonomyThreshold, force });
    res.status(200).json(report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err, jobId }, "BM12: orchestration failed");
    res.status(500).json({ error: "BM-12 orchestration failed", detail: msg });
  } finally {
    runningSet.delete(jobId);
  }
});

// ── GET /api/merge-orchestrator-bm12/:jobId/report ───────────────────────────

router.get("/merge-orchestrator-bm12/:jobId/report", (req, res): void => {
  const jobId  = (req.params as Record<string, string>)["jobId"] ?? "";
  const report = getCachedOrchestrationReport(jobId);

  if (!report) {
    res.status(404).json({
      error: "No BM-12 report for this job.",
      hint:  `POST /api/merge-orchestrator-bm12/${jobId}/run to start orchestration.`,
    });
    return;
  }

  res.status(200).json(report);
});

// ── GET /api/merge-orchestrator-bm12/:jobId/status ───────────────────────────

router.get("/merge-orchestrator-bm12/:jobId/status", (req, res): void => {
  const jobId   = (req.params as Record<string, string>)["jobId"] ?? "";
  const running = isOrchestrationRunning(jobId);
  const report  = getCachedOrchestrationReport(jobId);

  if (!report && !running) {
    res.status(404).json({ jobId, status: "not_started", hint: `POST /api/merge-orchestrator-bm12/${jobId}/run` });
    return;
  }

  res.status(200).json({
    jobId,
    orchestrationId: report?.orchestrationId ?? null,
    status:          running ? "running" : report?.result ?? "unknown",
    decision:        report?.decision    ?? null,
    decisionReason:  report?.decisionReason ?? null,
    riskScore:       report?.riskScore   ?? null,
    riskGrade:       report?.riskGrade   ?? null,
    stages:          report?.stages      ?? [],
    durationMs:      report?.durationMs  ?? null,
    fileChanges:     report?.fileChanges ?? null,
    conflicts:       report?.conflicts   ?? null,
    monitorSummary:  report?.monitorSummary ?? null,
  });
});

// ── POST /api/merge-orchestrator-bm12/:jobId/approve ─────────────────────────
// Approve a paused-for-review run with lower autonomy threshold to force through.

router.post("/merge-orchestrator-bm12/:jobId/approve", async (req, res): Promise<void> => {
  const jobId = (req.params as Record<string, string>)["jobId"] ?? "";
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  const existing = getCachedOrchestrationReport(jobId);
  if (!existing || existing.result !== "pending_review") {
    res.status(400).json({
      error: "No pending-review orchestration found for this job.",
      hint:  existing ? `Current result: ${existing.result}` : "Run orchestration first.",
    });
    return;
  }

  if (isOrchestrationRunning(jobId)) {
    res.status(409).json({ error: "Orchestration already running" });
    return;
  }

  req.log.info({ jobId }, "BM12: human approval received — re-running with override");
  runningSet.add(jobId);
  const cloud = getDefaultCloudProvider();

  try {
    const body   = (req.body ?? {}) as Record<string, unknown>;
    const dryRun = body["dryRun"] !== false;
    const report = await runMergeOrchestrator(jobId, cloud, { dryRun, autonomyThreshold: 101, force: true });
    res.status(200).json({ approved: true, ...report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err, jobId }, "BM12: approved run failed");
    res.status(500).json({ error: "BM-12 approved run failed", detail: msg });
  } finally {
    runningSet.delete(jobId);
  }
});

export default router;
