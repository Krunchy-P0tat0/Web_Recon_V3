/**
 * visual-optimization-loop-b7.ts — Phase B7 Routes
 *
 * POST /visual-optimization-loop/start               — start a new loop
 * POST /visual-optimization-loop/:loopId/iterate     — submit iteration result
 * POST /visual-optimization-loop/:loopId/stop        — stop loop early
 * GET  /visual-optimization-loop                     — list all loops
 * GET  /visual-optimization-loop/:loopId             — loop state
 * GET  /visual-optimization-loop/:loopId/history     — visual-optimization-history.json
 * GET  /visual-optimization-loop/:loopId/iteration   — iteration-report.json
 * GET  /visual-optimization-loop/:loopId/curve       — improvement-curve.json
 * GET  /visual-optimization-loop/:loopId/adjustments — final-rule-adjustments.json
 */

import { Router, type IRouter } from "express";
import {
  startLoop,
  stopLoop,
  iterateLoop,
  getLoopState,
  listLoops,
  getOptimizationHistory,
  getImprovementCurve,
  getIterationReport,
  getFinalAdjustments,
  type StartLoopOptions,
} from "../lib/visual-optimization-loop-engine.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /visual-optimization-loop/start
// ---------------------------------------------------------------------------

router.post("/visual-optimization-loop/start", (req, res): void => {
  const {
    sourceJobId,
    generatedJobId,
    initialSsim,
    maxIterations,
    improvementThreshold,
    initialAdjustments,
  } = req.body ?? {};

  if (!sourceJobId || !generatedJobId) {
    res.status(400).json({ error: "sourceJobId and generatedJobId are required" });
    return;
  }
  if (typeof initialSsim !== "number" || !isFinite(initialSsim) || initialSsim < 0 || initialSsim > 1) {
    res.status(400).json({ error: "initialSsim must be a finite number in [0, 1]" });
    return;
  }

  const resolvedMaxIterations  = maxIterations        ?? 8;
  const resolvedThreshold      = improvementThreshold ?? 0.02;

  if (
    typeof resolvedMaxIterations !== "number" ||
    !isFinite(resolvedMaxIterations) ||
    !Number.isInteger(resolvedMaxIterations) ||
    resolvedMaxIterations < 1 ||
    resolvedMaxIterations > 50
  ) {
    res.status(400).json({ error: "maxIterations must be a finite integer in [1, 50]" });
    return;
  }
  if (
    typeof resolvedThreshold !== "number" ||
    !isFinite(resolvedThreshold) ||
    resolvedThreshold <= 0 ||
    resolvedThreshold >= 1
  ) {
    res.status(400).json({ error: "improvementThreshold must be a finite number in (0, 1)" });
    return;
  }

  const opts: StartLoopOptions = {
    sourceJobId,
    generatedJobId,
    initialSsim,
    maxIterations:        resolvedMaxIterations,
    improvementThreshold: resolvedThreshold,
    initialAdjustments:   Array.isArray(initialAdjustments) ? initialAdjustments : [],
  };

  const state = startLoop(opts);

  res.status(201).json({
    ok:            true,
    loopId:        state.loopId,
    sourceJobId:   state.sourceJobId,
    generatedJobId: state.generatedJobId,
    status:        state.status,
    initialSsim:   state.initialSsim,
    maxIterations: state.maxIterations,
    improvementThreshold: state.improvementThreshold,
    startedAt:     state.startedAt,
  });
});

// ---------------------------------------------------------------------------
// POST /visual-optimization-loop/:loopId/iterate
// ---------------------------------------------------------------------------

router.post("/visual-optimization-loop/:loopId/iterate", async (req, res): Promise<void> => {
  const { loopId } = req.params as { loopId: string };
  const { newSsim, componentErrors } = req.body ?? {};

  if (typeof newSsim !== "number" || newSsim < 0 || newSsim > 1) {
    res.status(400).json({ error: "newSsim must be a number in [0, 1]" });
    return;
  }
  if (!componentErrors) {
    res.status(400).json({ error: "componentErrors (ComponentErrorReport) is required" });
    return;
  }

  const state = getLoopState(loopId);
  if (!state) {
    res.status(404).json({ error: `Loop ${loopId} not found — start it first` });
    return;
  }
  if (state.status !== "running") {
    res.status(409).json({ error: `Loop is not running (status: ${state.status})` });
    return;
  }

  try {
    const { state: updated, plan, shouldContinue, stopReason } = await iterateLoop({
      loopId,
      newSsim,
      componentErrors,
    });

    const iter = updated.iterations[updated.iterations.length - 1]!;

    res.status(200).json({
      ok:                true,
      loopId,
      iterationNumber:   iter.iterationNumber,
      ssimBefore:        iter.ssimBefore,
      ssimAfter:         iter.ssimAfter,
      ssimGain:          iter.ssimGain,
      percentImprovement: iter.percentImprovement,
      shouldContinue,
      stopReason,
      status:            updated.status,
      adjustmentsApplied: iter.adjustmentsApplied,
      adjustmentTypes:   iter.adjustmentTypes,
      optimizationPlanSummary: plan
        ? { totalItems: plan.totalItems, estimatedGain: plan.estimatedOverallGain }
        : null,
    });
  } catch (err) {
    req.log.error({ err, loopId }, "B7: iterate failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /visual-optimization-loop/:loopId/stop
// ---------------------------------------------------------------------------

router.post("/visual-optimization-loop/:loopId/stop", (req, res): void => {
  const { loopId } = req.params as { loopId: string };
  const { reason } = req.body ?? {};

  const state = stopLoop(loopId, reason ?? "manual_stop");
  if (!state) {
    res.status(404).json({ error: `Loop ${loopId} not found` });
    return;
  }

  res.status(200).json({
    ok:           true,
    loopId,
    status:       state.status,
    stopReason:   state.stopReason,
    completedAt:  state.completedAt,
    finalSsim:    state.currentSsim,
    totalGain:    state.totalGain,
    iterations:   state.currentIteration,
  });
});

// ---------------------------------------------------------------------------
// GET /visual-optimization-loop
// ---------------------------------------------------------------------------

router.get("/visual-optimization-loop", (_req, res): void => {
  res.json({ loops: listLoops() });
});

// ---------------------------------------------------------------------------
// GET /visual-optimization-loop/:loopId
// ---------------------------------------------------------------------------

router.get("/visual-optimization-loop/:loopId", (req, res): void => {
  const { loopId } = req.params as { loopId: string };
  const state = getLoopState(loopId);
  if (!state) {
    res.status(404).json({ error: `Loop ${loopId} not found` });
    return;
  }
  res.json(state);
});

// ---------------------------------------------------------------------------
// GET /visual-optimization-loop/:loopId/history
// ---------------------------------------------------------------------------

router.get("/visual-optimization-loop/:loopId/history", (req, res): void => {
  const { loopId } = req.params as { loopId: string };
  const history = getOptimizationHistory(loopId);
  if (!history) {
    res.status(404).json({ error: "No completed history for this loop yet — loop may still be running" });
    return;
  }
  res.json(history);
});

// ---------------------------------------------------------------------------
// GET /visual-optimization-loop/:loopId/iteration
// ---------------------------------------------------------------------------

router.get("/visual-optimization-loop/:loopId/iteration", (req, res): void => {
  const { loopId } = req.params as { loopId: string };
  const report = getIterationReport(loopId);
  if (!report) {
    res.status(404).json({ error: `Loop ${loopId} not found` });
    return;
  }
  res.json(report);
});

// ---------------------------------------------------------------------------
// GET /visual-optimization-loop/:loopId/curve
// ---------------------------------------------------------------------------

router.get("/visual-optimization-loop/:loopId/curve", (req, res): void => {
  const { loopId } = req.params as { loopId: string };
  const curve = getImprovementCurve(loopId);
  if (!curve) {
    res.status(404).json({ error: `Loop ${loopId} not found` });
    return;
  }
  res.json(curve);
});

// ---------------------------------------------------------------------------
// GET /visual-optimization-loop/:loopId/adjustments
// ---------------------------------------------------------------------------

router.get("/visual-optimization-loop/:loopId/adjustments", (req, res): void => {
  const { loopId } = req.params as { loopId: string };
  const adjustments = getFinalAdjustments(loopId);
  if (!adjustments) {
    res.status(404).json({ error: `Loop ${loopId} not found` });
    return;
  }
  res.json(adjustments);
});

export default router;
