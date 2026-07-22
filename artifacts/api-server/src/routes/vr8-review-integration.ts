/**
 * vr8-review-integration.ts — PH-1: Integrated VR-8 ↔ PS-2 Routes
 *
 * POST /api/vr8-integrated/:sourceJobId/start
 *   Start the integrated reconstruction loop (VR-8 + PS-2 gate after each iteration).
 *   Body: { generationEndpoint, targetScore?, maxIterations?, initialScore? }
 *
 * POST /api/vr8-integrated/:sourceJobId/stop
 *   Request a graceful stop.
 *
 * GET  /api/vr8-integrated/:sourceJobId/status
 *   Full loop state: status, currentIteration, score, currentGateId, gateDecisions.
 *
 * GET  /api/vr8-integrated/:sourceJobId/iterations
 *   All iteration records with gate action per iteration.
 *
 * GET  /api/vr8-integrated/:sourceJobId/gate-decisions
 *   Decision log scoped to this job.
 *
 * GET  /api/vr8-integrated/report
 *   review-gate-integration-report.json — overall integration status.
 *
 * GET  /api/vr8-integrated/list
 *   All integrated loop states.
 */

import { Router, type IRouter } from "express";
import {
  startIntegratedLoop,
  requestIntegratedStop,
  getIntegratedLoopState,
  listIntegratedLoops,
  buildIntegrationReport,
}                               from "../lib/vr8-review-integration.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /vr8-integrated/:sourceJobId/start
// ---------------------------------------------------------------------------

router.post("/vr8-integrated/:sourceJobId/start", (req, res): void => {
  const sourceJobId = (req.params as Record<string, string>)["sourceJobId"] ?? "";
  if (!sourceJobId) {
    res.status(400).json({ error: "sourceJobId is required" });
    return;
  }

  const body               = (req.body ?? {}) as Record<string, unknown>;
  const generationEndpoint = typeof body["generationEndpoint"] === "string"
    ? body["generationEndpoint"].trim() : "";

  if (!generationEndpoint) {
    res.status(400).json({
      error:   "generationEndpoint is required",
      hint:    "The URL VR-8 will POST to each iteration to trigger site generation.",
      example: {
        generationEndpoint: "http://localhost:8080/api/orchestrate",
        targetScore:        80,
        maxIterations:      5,
      },
    });
    return;
  }

  try { new URL(generationEndpoint); } catch {
    res.status(400).json({ error: "generationEndpoint must be a valid URL" });
    return;
  }

  const existing = getIntegratedLoopState(sourceJobId);
  if (existing?.status === "running" || existing?.status === "awaiting_review") {
    res.status(409).json({
      error:        "An integrated loop is already active for this sourceJobId.",
      hint:         `POST /api/vr8-integrated/${sourceJobId}/stop to stop it first.`,
      currentState: {
        status:           existing.status,
        currentIteration: existing.currentIteration,
        currentGateId:    existing.currentGateId,
        currentScore:     existing.currentScore,
      },
    });
    return;
  }

  const targetScore   = typeof body["targetScore"]   === "number" ? body["targetScore"]   : 75;
  const maxIterations = typeof body["maxIterations"] === "number" ? body["maxIterations"] : 5;
  const initialScore  = typeof body["initialScore"]  === "number" ? body["initialScore"]  : 0;

  req.log.info({ sourceJobId, targetScore, maxIterations, generationEndpoint }, "PH-1: integrated loop start requested");

  const state = startIntegratedLoop({ sourceJobId, generationEndpoint, targetScore, maxIterations, initialScore });

  res.status(202).json({
    message:           "PH-1 integrated loop started — VR-8 will pause at each iteration for PS-2 Human Review Gate",
    sourceJobId,
    status:            state.status,
    targetScore:       state.targetScore,
    maxIterations:     state.maxIterations,
    startedAt:         state.startedAt,
    statusUrl:         `/api/vr8-integrated/${sourceJobId}/status`,
    iterationsUrl:     `/api/vr8-integrated/${sourceJobId}/iterations`,
    gateDecisionsUrl:  `/api/vr8-integrated/${sourceJobId}/gate-decisions`,
    pendingGatesUrl:   `/api/review-gate/pending`,
    actOnGateUrl:      `/api/review-gate/:gateId/approve  (or /reject, /edit, /skip)`,
    integrationFlow: [
      "1. VR-8 runs an iteration → produces RuleAdjustment[]",
      "2. PS-2 gate opens (status: PENDING) — check /api/review-gate/pending",
      "3. Human acts on the gate (approve / edit / reject / skip)",
      "4. Loop resumes based on decision",
      "5. Repeat until target score, max iterations, or rejection",
    ],
  });
});

// ---------------------------------------------------------------------------
// POST /vr8-integrated/:sourceJobId/stop
// ---------------------------------------------------------------------------

router.post("/vr8-integrated/:sourceJobId/stop", (req, res): void => {
  const sourceJobId = (req.params as Record<string, string>)["sourceJobId"] ?? "";
  const state       = getIntegratedLoopState(sourceJobId);

  if (!state) {
    res.status(404).json({
      error: "No integrated loop found for this sourceJobId.",
      hint:  `POST /api/vr8-integrated/${sourceJobId}/start to begin.`,
    });
    return;
  }

  if (state.status === "completed" || state.status === "failed") {
    res.status(200).json({
      message:           "Loop is already finished.",
      sourceJobId,
      status:            state.status,
      stoppingCondition: state.stoppingCondition,
    });
    return;
  }

  requestIntegratedStop(sourceJobId);
  req.log.info({ sourceJobId }, "PH-1: integrated loop stop requested");

  res.status(200).json({
    message:          "Stop signal sent — loop will complete the current iteration / gate then halt.",
    sourceJobId,
    stopping:         true,
    currentIteration: state.currentIteration,
    currentGateId:    state.currentGateId,
    note:             state.status === "awaiting_review"
      ? "Loop is currently paused at a PS-2 gate. Act on the gate or wait for TTL expiry to fully stop."
      : "Loop will stop after the current iteration finishes.",
  });
});

// ---------------------------------------------------------------------------
// GET /vr8-integrated/:sourceJobId/status
// ---------------------------------------------------------------------------

router.get("/vr8-integrated/:sourceJobId/status", (req, res): void => {
  const sourceJobId = (req.params as Record<string, string>)["sourceJobId"] ?? "";
  const state       = getIntegratedLoopState(sourceJobId);

  if (!state) {
    res.status(404).json({
      error: "No integrated loop found for this sourceJobId.",
      hint:  `POST /api/vr8-integrated/${sourceJobId}/start to begin.`,
    });
    return;
  }

  res.status(200).json({
    sourceJobId,
    status:              state.status,
    stoppingCondition:   state.stoppingCondition,
    currentIteration:    state.currentIteration,
    maxIterations:       state.maxIterations,
    targetScore:         state.targetScore,
    currentScore:        state.currentScore,
    bestScore:           state.bestScore,
    bestIteration:       state.bestIteration,
    iterationsCompleted: state.iterations.length,
    currentGateId:       state.currentGateId,
    awaitingReview:      state.status === "awaiting_review",
    pendingGateUrl:      state.currentGateId
      ? `/api/review-gate/${state.currentGateId}`
      : null,
    actOnGateUrls: state.currentGateId ? {
      approve: `/api/review-gate/${state.currentGateId}/approve`,
      edit:    `/api/review-gate/${state.currentGateId}/edit`,
      reject:  `/api/review-gate/${state.currentGateId}/reject`,
      skip:    `/api/review-gate/${state.currentGateId}/skip`,
    } : null,
    startedAt:           state.startedAt,
    completedAt:         state.completedAt,
    lastError:           state.lastError,
    nextPollMs:          (state.status === "running" || state.status === "awaiting_review") ? 2000 : null,
  });
});

// ---------------------------------------------------------------------------
// GET /vr8-integrated/:sourceJobId/iterations
// ---------------------------------------------------------------------------

router.get("/vr8-integrated/:sourceJobId/iterations", (req, res): void => {
  const sourceJobId = (req.params as Record<string, string>)["sourceJobId"] ?? "";
  const state       = getIntegratedLoopState(sourceJobId);

  if (!state) {
    res.status(404).json({ error: "No integrated loop found for this sourceJobId." });
    return;
  }

  res.status(200).json({
    sourceJobId,
    status:           state.status,
    iterationCount:   state.iterations.length,
    currentScore:     state.currentScore,
    bestScore:        state.bestScore,
    iterations:       state.iterations,
  });
});

// ---------------------------------------------------------------------------
// GET /vr8-integrated/:sourceJobId/gate-decisions
// ---------------------------------------------------------------------------

router.get("/vr8-integrated/:sourceJobId/gate-decisions", (req, res): void => {
  const sourceJobId = (req.params as Record<string, string>)["sourceJobId"] ?? "";
  const state       = getIntegratedLoopState(sourceJobId);

  if (!state) {
    res.status(404).json({ error: "No integrated loop found for this sourceJobId." });
    return;
  }

  const approvalCount  = state.gateDecisions.filter(d => d.action === "approve" || d.action === "edit").length;
  const rejectionCount = state.gateDecisions.filter(d => d.action === "reject").length;
  const skipCount      = state.gateDecisions.filter(d => d.action === "skip").length;

  res.status(200).json({
    sourceJobId,
    totalDecisions: state.gateDecisions.length,
    approvalCount,
    rejectionCount,
    skipCount,
    approvalRate:   state.gateDecisions.length > 0
      ? parseFloat((approvalCount / state.gateDecisions.length * 100).toFixed(1))
      : null,
    gateDecisions: state.gateDecisions,
  });
});

// ---------------------------------------------------------------------------
// GET /vr8-integrated/report  (review-gate-integration-report.json)
// ---------------------------------------------------------------------------

router.get("/vr8-integrated/report", (_req, res): void => {
  res.status(200).json(buildIntegrationReport());
});

// ---------------------------------------------------------------------------
// GET /vr8-integrated/list
// ---------------------------------------------------------------------------

router.get("/vr8-integrated/list", (_req, res): void => {
  const loops = listIntegratedLoops();
  res.status(200).json({
    totalLoops:  loops.length,
    activeLoops: loops.filter(l => l.status === "running" || l.status === "awaiting_review").length,
    loops:       loops.map(l => ({
      sourceJobId:      l.sourceJobId,
      status:           l.status,
      currentIteration: l.currentIteration,
      maxIterations:    l.maxIterations,
      currentScore:     l.currentScore,
      bestScore:        l.bestScore,
      currentGateId:    l.currentGateId,
      startedAt:        l.startedAt,
      completedAt:      l.completedAt,
    })),
  });
});

export default router;
