/**
 * reconstruction-loop-vr8.ts — Phase VR-8: Autonomous Visual Reconstruction Loop Routes
 *
 * POST /api/reconstruction-loop-vr8/:sourceJobId/start
 *   Start the autonomous reconstruction loop.
 *   Body: {
 *     generationEndpoint: string,   // URL that accepts POST and returns { generatedJobId }
 *     targetScore?:       number,   // fidelity target 0–100 (default 75)
 *     maxIterations?:     number,   // iteration cap (default 5)
 *     maxPlateauRounds?:  number,   // stop after N rounds with no gain (default 2)
 *     initialScore?:      number,   // seed score from a prior VR-7 run (default 0)
 *   }
 *   Returns: LoopState (loop starts async in background)
 *
 * POST /api/reconstruction-loop-vr8/:sourceJobId/stop
 *   Request a graceful stop after the current iteration completes.
 *   Returns: { sourceJobId, stopping: true }
 *
 * GET  /api/reconstruction-loop-vr8/:sourceJobId/status
 *   Current loop state: status, currentIteration, currentScore, bestScore,
 *   stoppingCondition, startedAt, completedAt.
 *
 * GET  /api/reconstruction-loop-vr8/:sourceJobId/iterations
 *   reconstruction-iterations.json — array of IterationRecord.
 *   Each entry: { iterationNumber, scoreBefore, scoreAfter, improvementsApplied, … }
 *
 * GET  /api/reconstruction-loop-vr8/:sourceJobId/report
 *   reconstruction-report.json — final summary:
 *   config, result (initialScore/finalScore/bestScore/grade), adjustmentSummary.
 *
 * GET  /api/reconstruction-loop-vr8/:sourceJobId/adjustments
 *   Current rule adjustments queued for the next generation call.
 *   Empty array when loop is completed or not started.
 *
 * GET  /api/reconstruction-loop-vr8/:sourceJobId/iterations/:iterationNumber
 *   Single iteration record (with full adjustments + fidelity dimensions).
 */

import { Router, type IRouter }     from "express";
import {
  startReconstructionLoop,
  requestStop,
  getLoopState,
  getReconstructionReport,
  loadLoopStateFromDisk,
  type LoopState,
}                                   from "../lib/reconstruction-loop-engine-vr8.js";

const router: IRouter = Router();

// ── Helper — require state (try disk fallback) ────────────────────────────────

async function resolveState(
  sourceJobId: string,
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): Promise<LoopState | null> {
  let state = getLoopState(sourceJobId);
  if (!state) state = await loadLoopStateFromDisk(sourceJobId) ?? undefined;
  if (!state) {
    res.status(404).json({
      error: "No reconstruction loop found for this sourceJobId.",
      hint:  `POST /api/reconstruction-loop-vr8/${sourceJobId}/start to begin.`,
    });
    return null;
  }
  return state;
}

// ── POST /api/reconstruction-loop-vr8/:sourceJobId/start ─────────────────────

router.post("/reconstruction-loop-vr8/:sourceJobId/start", async (req, res): Promise<void> => {
  const sourceJobId = (req.params as Record<string, string>)["sourceJobId"] ?? "";
  if (!sourceJobId) { res.status(400).json({ error: "sourceJobId is required" }); return; }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const generationEndpoint = typeof body["generationEndpoint"] === "string"
    ? body["generationEndpoint"].trim() : "";

  if (!generationEndpoint) {
    res.status(400).json({
      error: "generationEndpoint is required",
      hint:  "Provide the URL that VR-8 will POST to each iteration to trigger site generation.",
      example: `{ "generationEndpoint": "http://localhost:8090/api/orchestrate", "targetScore": 80, "maxIterations": 5 }`,
    });
    return;
  }

  // Validate URL format
  try { new URL(generationEndpoint); } catch {
    res.status(400).json({ error: "generationEndpoint must be a valid URL" });
    return;
  }

  const existing = getLoopState(sourceJobId);
  if (existing?.status === "running") {
    res.status(409).json({
      error: "A reconstruction loop is already running for this sourceJobId.",
      hint:  `POST /api/reconstruction-loop-vr8/${sourceJobId}/stop to stop it first.`,
      currentState: {
        status:           existing.status,
        currentIteration: existing.currentIteration,
        currentScore:     existing.currentScore,
        startedAt:        existing.startedAt,
      },
    });
    return;
  }

  const targetScore      = typeof body["targetScore"]      === "number" ? body["targetScore"]      : 75;
  const maxIterations    = typeof body["maxIterations"]    === "number" ? body["maxIterations"]    : 5;
  const maxPlateauRounds = typeof body["maxPlateauRounds"] === "number" ? body["maxPlateauRounds"] : 2;
  const initialScore     = typeof body["initialScore"]     === "number" ? body["initialScore"]     : 0;

  req.log.info({ sourceJobId, targetScore, maxIterations, generationEndpoint }, "VR8: loop start requested");

  const state = startReconstructionLoop({
    sourceJobId,
    generationEndpoint,
    targetScore,
    maxIterations,
    maxPlateauRounds,
    initialScore,
  });

  res.status(202).json({
    message:          "Reconstruction loop started",
    sourceJobId,
    status:           state.status,
    targetScore:      state.targetScore,
    maxIterations:    state.maxIterations,
    maxPlateauRounds: state.maxPlateauRounds,
    startedAt:        state.startedAt,
    pollUrl:          `/api/reconstruction-loop-vr8/${sourceJobId}/status`,
    iterationsUrl:    `/api/reconstruction-loop-vr8/${sourceJobId}/iterations`,
    reportUrl:        `/api/reconstruction-loop-vr8/${sourceJobId}/report`,
  });
});

// ── POST /api/reconstruction-loop-vr8/:sourceJobId/stop ──────────────────────

router.post("/reconstruction-loop-vr8/:sourceJobId/stop", async (req, res): Promise<void> => {
  const sourceJobId = (req.params as Record<string, string>)["sourceJobId"] ?? "";
  const state       = await resolveState(sourceJobId, res);
  if (!state) return;

  if (state.status !== "running" && state.status !== "stopping") {
    res.status(200).json({
      message:      "Loop is not running (already stopped or completed)",
      sourceJobId,
      status:       state.status,
      stoppingCondition: state.stoppingCondition,
    });
    return;
  }

  requestStop(sourceJobId);
  req.log.info({ sourceJobId }, "VR8: stop requested");

  res.status(200).json({
    message:    "Stop signal sent — loop will complete the current iteration then halt.",
    sourceJobId,
    stopping:   true,
    currentIteration: state.currentIteration,
    currentScore:     state.currentScore,
  });
});

// ── GET /api/reconstruction-loop-vr8/:sourceJobId/status ─────────────────────

router.get("/reconstruction-loop-vr8/:sourceJobId/status", async (req, res): Promise<void> => {
  const sourceJobId = (req.params as Record<string, string>)["sourceJobId"] ?? "";
  const state       = await resolveState(sourceJobId, res);
  if (!state) return;

  res.status(200).json({
    sourceJobId,
    status:            state.status,
    stoppingCondition: state.stoppingCondition,
    currentIteration:  state.currentIteration,
    maxIterations:     state.maxIterations,
    targetScore:       state.targetScore,
    currentScore:      state.currentScore,
    bestScore:         state.bestScore,
    bestIteration:     state.bestIteration,
    iterationsCompleted: state.iterations.length,
    startedAt:         state.startedAt,
    completedAt:       state.completedAt,
    lastError:         state.lastError,
    isRunning:         state.status === "running" || state.status === "stopping",
    targetReached:     state.currentScore >= state.targetScore,
    nextPollMs:        state.status === "running" ? 5000 : null,
  });
});

// ── GET /api/reconstruction-loop-vr8/:sourceJobId/iterations ─────────────────

router.get("/reconstruction-loop-vr8/:sourceJobId/iterations", async (req, res): Promise<void> => {
  const sourceJobId = (req.params as Record<string, string>)["sourceJobId"] ?? "";
  const state       = await resolveState(sourceJobId, res);
  if (!state) return;

  // Lightweight summary version (strip large adjustment objects unless ?detail=true)
  const detail = req.query["detail"] === "true";

  const records = state.iterations.map(it => ({
    iterationNumber:     it.iterationNumber,
    generatedJobId:      it.generatedJobId,
    scoreBefore:         it.scoreBefore,
    scoreAfter:          it.scoreAfter,
    delta:               it.delta,
    grade:               it.grade,
    improvementsApplied: it.improvementsApplied,
    issuesBefore:        it.issuesBefore,
    issuesAfter:         it.issuesAfter,
    durationMs:          it.durationMs,
    timestamp:           it.timestamp,
    fidelityDimensions:  it.fidelityDimensions,
    ...(detail ? { adjustments: it.adjustments } : { adjustmentCount: it.adjustments.length }),
  }));

  res.status(200).json({
    sourceJobId,
    status:           state.status,
    currentScore:     state.currentScore,
    iterationCount:   records.length,
    iterations:       records,
  });
});

// ── GET /api/reconstruction-loop-vr8/:sourceJobId/iterations/:iterationNumber ──

router.get("/reconstruction-loop-vr8/:sourceJobId/iterations/:iterationNumber",
  async (req, res): Promise<void> => {
    const p             = req.params as Record<string, string>;
    const sourceJobId   = p["sourceJobId"] ?? "";
    const iterNumStr    = p["iterationNumber"] ?? "";
    const iterNum       = parseInt(iterNumStr, 10);

    if (isNaN(iterNum)) { res.status(400).json({ error: "iterationNumber must be a number" }); return; }

    const state = await resolveState(sourceJobId, res);
    if (!state) return;

    const record = state.iterations.find(it => it.iterationNumber === iterNum);
    if (!record) {
      res.status(404).json({
        error:           `Iteration ${iterNum} not found.`,
        availableRange:  state.iterations.length
          ? [state.iterations[0]!.iterationNumber, state.iterations[state.iterations.length - 1]!.iterationNumber]
          : [],
      });
      return;
    }

    res.status(200).json(record);
  });

// ── GET /api/reconstruction-loop-vr8/:sourceJobId/report ─────────────────────

router.get("/reconstruction-loop-vr8/:sourceJobId/report", async (req, res): Promise<void> => {
  const sourceJobId = (req.params as Record<string, string>)["sourceJobId"] ?? "";

  const report = getReconstructionReport(sourceJobId);
  if (report) { res.status(200).json(report); return; }

  // Try to resolve from disk / state
  const state = await resolveState(sourceJobId, res);
  if (!state) return;

  if (state.status === "running" || state.status === "stopping") {
    res.status(202).json({
      message:          "Loop is still running — report not yet available.",
      sourceJobId,
      status:           state.status,
      currentIteration: state.currentIteration,
      currentScore:     state.currentScore,
      pollUrl:          `/api/reconstruction-loop-vr8/${sourceJobId}/status`,
    });
    return;
  }

  res.status(404).json({
    error: "Reconstruction report not yet generated.",
    hint:  "The loop may have failed before completing. Check /status for details.",
    lastError: state.lastError,
  });
});

// ── GET /api/reconstruction-loop-vr8/:sourceJobId/adjustments ────────────────

router.get("/reconstruction-loop-vr8/:sourceJobId/adjustments", async (req, res): Promise<void> => {
  const sourceJobId = (req.params as Record<string, string>)["sourceJobId"] ?? "";
  const state       = await resolveState(sourceJobId, res);
  if (!state) return;

  res.status(200).json({
    sourceJobId,
    status:                  state.status,
    currentIteration:        state.currentIteration,
    adjustmentCount:         state.currentAdjustments.length,
    currentAdjustments:      state.currentAdjustments,
    note: state.status !== "running"
      ? "Loop is not running — these are the adjustments from the last completed iteration."
      : "These adjustments will be applied in the next generation call.",
  });
});

export default router;
