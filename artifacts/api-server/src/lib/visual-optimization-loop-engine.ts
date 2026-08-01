/**
 * visual-optimization-loop-engine.ts — Phase B7: Visual Optimization Loop
 *
 * Continuously improves Website Prime visual fidelity through an iterative loop:
 *
 *   Generate → Screenshot → Pixel Comparison → Visual Repair Planning
 *     → Apply RuleAdjustments → Rebuild → Repeat
 *
 * Stop conditions:
 *   • Visual improvement < improvementThreshold per iteration
 *   • Maximum iteration count reached
 *
 * Outputs (disk + R2 under jobs/{sourceJobId}/b7/):
 *   visual-optimization-history.json
 *   iteration-report.json
 *   improvement-curve.json
 *   final-rule-adjustments.json
 *
 * Pipeline placement: pixel_comparison (PF-1) + visual_optimizer (PF-3) → b7_loop
 */

import { writeFile } from "fs/promises";
import { join }      from "path";
import { randomUUID } from "crypto";
import { logger }    from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import type { RuleAdjustment } from "./rule-adjustment-contract.js";
import type { OptimizationPlan } from "./visual-optimizer.js";
import { runVisualOptimizer } from "./visual-optimizer.js";
import type { ComponentErrorReport } from "./visual-diff-localizer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoopStatus =
  | "idle"
  | "running"
  | "completed"
  | "stopped"
  | "threshold_met"
  | "max_iterations_reached"
  | "error";

export interface IterationRecord {
  iterationNumber:    number;
  iterationId:        string;
  startedAt:          string;
  completedAt:        string;
  durationMs:         number;
  ssimBefore:         number;
  ssimAfter:          number;
  ssimGain:           number;
  percentImprovement: number;        // relative gain %
  adjustmentsApplied: number;
  adjustmentTypes:    string[];
  optimizationPlanR2: string | null;
  stopReason:         string | null; // non-null when this iteration triggered stop
}

export interface OptimizationLoopState {
  loopId:              string;
  sourceJobId:         string;
  generatedJobId:      string;
  status:              LoopStatus;
  currentIteration:    number;
  maxIterations:       number;
  improvementThreshold: number;      // minimum absolute SSIM gain per iteration to continue
  startedAt:           string;
  completedAt:         string | null;
  iterations:          IterationRecord[];
  initialSsim:         number;
  currentSsim:         number;
  bestSsim:            number;
  bestIterationNumber: number;
  totalGain:           number;       // cumulative SSIM gain
  currentAdjustments:  RuleAdjustment[];
  stopReason:          string | null;
}

export interface VisualOptimizationHistory {
  schemaVersion:  "B7-1";
  sourceJobId:    string;
  generatedJobId: string;
  generatedAt:    string;
  loopId:         string;
  status:         LoopStatus;
  totalIterations: number;
  initialSsim:    number;
  finalSsim:      number;
  totalGain:      number;
  stopReason:     string | null;
  iterations:     IterationRecord[];
  r2Keys: {
    history:          string | null;
    iterationReport:  string | null;
    improvementCurve: string | null;
    finalAdjustments: string | null;
  };
}

export interface IterationReport {
  schemaVersion:   "B7-1";
  sourceJobId:     string;
  generatedJobId:  string;
  loopId:          string;
  generatedAt:     string;
  latestIteration: IterationRecord | null;
  summary: {
    iterationsRun:   number;
    totalGain:       number;
    avgGainPerIter:  number;
    bestIteration:   number;
    bestSsim:        number;
    currentSsim:     number;
    status:          LoopStatus;
  };
}

export interface ImprovementPoint {
  iteration:   number;
  ssim:        number;
  gain:        number;
  cumulative:  number;
}

export interface ImprovementCurve {
  schemaVersion:    "B7-1";
  sourceJobId:      string;
  generatedJobId:   string;
  loopId:           string;
  generatedAt:      string;
  initialSsim:      number;
  points:           ImprovementPoint[];
  trend:            "improving" | "plateau" | "diminishing";
  projectedFinalSsim: number | null;
}

export interface FinalRuleAdjustments {
  schemaVersion:    "B7-1";
  sourceJobId:      string;
  generatedJobId:   string;
  loopId:           string;
  generatedAt:      string;
  totalIterations:  number;
  totalAdjustments: number;
  finalSsim:        number;
  totalGain:        number;
  adjustments:      RuleAdjustment[];
  byType:           Record<string, number>;
}

// ---------------------------------------------------------------------------
// Loop options
// ---------------------------------------------------------------------------

export interface StartLoopOptions {
  sourceJobId:          string;
  generatedJobId:       string;
  initialSsim:          number;
  maxIterations?:       number;  // default 8
  improvementThreshold?: number; // default 0.02 (2% SSIM gain)
  initialAdjustments?:  RuleAdjustment[];
}

export interface IterateOptions {
  loopId:          string;
  newSsim:         number;          // SSIM measured after applying last adjustments
  componentErrors: ComponentErrorReport;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const _loops   = new Map<string, OptimizationLoopState>();
const _results = new Map<string, VisualOptimizationHistory>();

export function getLoopState(loopId: string): OptimizationLoopState | undefined {
  return _loops.get(loopId);
}

export function listLoops(): Array<{
  loopId: string;
  sourceJobId: string;
  generatedJobId: string;
  status: LoopStatus;
  currentIteration: number;
  currentSsim: number;
  totalGain: number;
  startedAt: string;
}> {
  return [..._loops.values()].map(l => ({
    loopId:          l.loopId,
    sourceJobId:     l.sourceJobId,
    generatedJobId:  l.generatedJobId,
    status:          l.status,
    currentIteration: l.currentIteration,
    currentSsim:     l.currentSsim,
    totalGain:       l.totalGain,
    startedAt:       l.startedAt,
  }));
}

export function getOptimizationHistory(loopId: string): VisualOptimizationHistory | undefined {
  return _results.get(loopId);
}

export function getImprovementCurve(loopId: string): ImprovementCurve | undefined {
  const state = _loops.get(loopId);
  if (!state) return undefined;
  return buildImprovementCurve(state);
}

export function getIterationReport(loopId: string): IterationReport | undefined {
  const state = _loops.get(loopId);
  if (!state) return undefined;
  return buildIterationReport(state);
}

export function getFinalAdjustments(loopId: string): FinalRuleAdjustments | undefined {
  const state = _loops.get(loopId);
  if (!state) return undefined;
  return buildFinalAdjustments(state);
}

// ---------------------------------------------------------------------------
// Builders for derived output
// ---------------------------------------------------------------------------

function buildImprovementCurve(state: OptimizationLoopState): ImprovementCurve {
  const points: ImprovementPoint[] = [
    { iteration: 0, ssim: state.initialSsim, gain: 0, cumulative: 0 },
    ...state.iterations.map(it => ({
      iteration:  it.iterationNumber,
      ssim:       it.ssimAfter,
      gain:       Math.round(it.ssimGain * 1000) / 1000,
      cumulative: Math.round((it.ssimAfter - state.initialSsim) * 1000) / 1000,
    })),
  ];

  // trend detection
  let trend: ImprovementCurve["trend"] = "improving";
  if (state.iterations.length >= 3) {
    const recent = state.iterations.slice(-3).map(i => i.ssimGain);
    const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (avgRecent < state.improvementThreshold * 0.5) trend = "diminishing";
    else if (avgRecent < state.improvementThreshold) trend = "plateau";
  }

  // simple linear projection
  let projectedFinalSsim: number | null = null;
  if (state.iterations.length >= 2) {
    const recentGains = state.iterations.slice(-3).map(i => i.ssimGain);
    const avgGain = recentGains.reduce((a, b) => a + b, 0) / recentGains.length;
    const remaining = state.maxIterations - state.currentIteration;
    projectedFinalSsim = Math.min(1, Math.round((state.currentSsim + avgGain * remaining) * 1000) / 1000);
  }

  return {
    schemaVersion:  "B7-1",
    sourceJobId:    state.sourceJobId,
    generatedJobId: state.generatedJobId,
    loopId:         state.loopId,
    generatedAt:    new Date().toISOString(),
    initialSsim:    state.initialSsim,
    points,
    trend,
    projectedFinalSsim,
  };
}

function buildIterationReport(state: OptimizationLoopState): IterationReport {
  const total        = state.iterations.length;
  const totalGain    = state.totalGain;
  const avgGain      = total > 0 ? Math.round((totalGain / total) * 1000) / 1000 : 0;
  const latest       = state.iterations[state.iterations.length - 1] ?? null;

  return {
    schemaVersion:   "B7-1",
    sourceJobId:     state.sourceJobId,
    generatedJobId:  state.generatedJobId,
    loopId:          state.loopId,
    generatedAt:     new Date().toISOString(),
    latestIteration: latest,
    summary: {
      iterationsRun:  total,
      totalGain:      Math.round(totalGain * 1000) / 1000,
      avgGainPerIter: avgGain,
      bestIteration:  state.bestIterationNumber,
      bestSsim:       state.bestSsim,
      currentSsim:    state.currentSsim,
      status:         state.status,
    },
  };
}

function buildFinalAdjustments(state: OptimizationLoopState): FinalRuleAdjustments {
  const byType: Record<string, number> = {};
  for (const adj of state.currentAdjustments) {
    byType[adj.adjustmentType] = (byType[adj.adjustmentType] ?? 0) + 1;
  }
  return {
    schemaVersion:    "B7-1",
    sourceJobId:      state.sourceJobId,
    generatedJobId:   state.generatedJobId,
    loopId:           state.loopId,
    generatedAt:      new Date().toISOString(),
    totalIterations:  state.currentIteration,
    totalAdjustments: state.currentAdjustments.length,
    finalSsim:        state.currentSsim,
    totalGain:        Math.round(state.totalGain * 1000) / 1000,
    adjustments:      state.currentAdjustments,
    byType,
  };
}

// ---------------------------------------------------------------------------
// R2 / disk helpers
// ---------------------------------------------------------------------------

const OUT_DIR = process.cwd();

async function writeDisk(filename: string, data: unknown): Promise<void> {
  await writeFile(join(OUT_DIR, filename), JSON.stringify(data, null, 2), "utf8");
}

async function uploadR2(key: string, data: Buffer): Promise<boolean> {
  const cloud = getDefaultCloudProvider();
  if (!cloud.isConfigured()) return false;
  try {
    await cloud.upload({ key, data, contentType: "application/json" });
    return true;
  } catch (err) {
    logger.warn({ err, key }, "B7: R2 upload failed (non-fatal)");
    return false;
  }
}

async function persistLoopOutputs(state: OptimizationLoopState): Promise<VisualOptimizationHistory> {
  const prefix  = `jobs/${state.sourceJobId}/b7/${state.loopId}`;
  const history = buildHistory(state);
  const iterRep = buildIterationReport(state);
  const curve   = buildImprovementCurve(state);
  const finalAdj = buildFinalAdjustments(state);

  const keys = {
    history:          `${prefix}/visual-optimization-history.json`,
    iterationReport:  `${prefix}/iteration-report.json`,
    improvementCurve: `${prefix}/improvement-curve.json`,
    finalAdjustments: `${prefix}/final-rule-adjustments.json`,
  };

  await Promise.all([
    writeDisk("visual-optimization-history.json", history),
    writeDisk("iteration-report.json", iterRep),
    writeDisk("improvement-curve.json", curve),
    writeDisk("final-rule-adjustments.json", finalAdj),
    uploadR2(keys.history,          Buffer.from(JSON.stringify(history,   null, 2))).then(ok => { if (ok) history.r2Keys.history          = keys.history;          }),
    uploadR2(keys.iterationReport,  Buffer.from(JSON.stringify(iterRep,   null, 2))).then(ok => { if (ok) history.r2Keys.iterationReport  = keys.iterationReport;  }),
    uploadR2(keys.improvementCurve, Buffer.from(JSON.stringify(curve,     null, 2))).then(ok => { if (ok) history.r2Keys.improvementCurve = keys.improvementCurve; }),
    uploadR2(keys.finalAdjustments, Buffer.from(JSON.stringify(finalAdj,  null, 2))).then(ok => { if (ok) history.r2Keys.finalAdjustments = keys.finalAdjustments; }),
  ]);

  _results.set(state.loopId, history);
  return history;
}

function buildHistory(state: OptimizationLoopState): VisualOptimizationHistory {
  return {
    schemaVersion:   "B7-1",
    sourceJobId:     state.sourceJobId,
    generatedJobId:  state.generatedJobId,
    generatedAt:     new Date().toISOString(),
    loopId:          state.loopId,
    status:          state.status,
    totalIterations: state.currentIteration,
    initialSsim:     state.initialSsim,
    finalSsim:       state.currentSsim,
    totalGain:       Math.round(state.totalGain * 1000) / 1000,
    stopReason:      state.stopReason,
    iterations:      state.iterations,
    r2Keys:          { history: null, iterationReport: null, improvementCurve: null, finalAdjustments: null },
  };
}

// ---------------------------------------------------------------------------
// Loop lifecycle
// ---------------------------------------------------------------------------

export function startLoop(opts: StartLoopOptions): OptimizationLoopState {
  const {
    sourceJobId,
    generatedJobId,
    initialSsim,
    maxIterations = 8,
    improvementThreshold = 0.02,
    initialAdjustments = [],
  } = opts;

  const loopId = randomUUID();
  const state: OptimizationLoopState = {
    loopId,
    sourceJobId,
    generatedJobId,
    status:               "running",
    currentIteration:     0,
    maxIterations,
    improvementThreshold,
    startedAt:            new Date().toISOString(),
    completedAt:          null,
    iterations:           [],
    initialSsim,
    currentSsim:          initialSsim,
    bestSsim:             initialSsim,
    bestIterationNumber:  0,
    totalGain:            0,
    currentAdjustments:   initialAdjustments,
    stopReason:           null,
  };

  _loops.set(loopId, state);
  logger.info({ loopId, sourceJobId, generatedJobId, initialSsim, maxIterations }, "B7: loop started");
  return state;
}

export function stopLoop(loopId: string, reason = "manual_stop"): OptimizationLoopState | undefined {
  const state = _loops.get(loopId);
  if (!state) return undefined;
  if (state.status === "running") {
    state.status       = "stopped";
    state.completedAt  = new Date().toISOString();
    state.stopReason   = reason;
    persistLoopOutputs(state).catch(err =>
      logger.warn({ err, loopId }, "B7: failed to persist on stop"),
    );
    logger.info({ loopId, reason }, "B7: loop stopped");
  }
  return state;
}

/**
 * Submit a new iteration result.
 * Caller provides the new SSIM score (measured after applying the last
 * batch of adjustments) and component errors for the next optimizer run.
 */
export async function iterateLoop(opts: IterateOptions): Promise<{
  state:          OptimizationLoopState;
  plan:           OptimizationPlan | null;
  shouldContinue: boolean;
  stopReason:     string | null;
}> {
  const { loopId, newSsim, componentErrors } = opts;
  const state = _loops.get(loopId);
  if (!state) throw new Error(`Loop ${loopId} not found`);
  if (state.status !== "running") {
    return { state, plan: null, shouldContinue: false, stopReason: state.stopReason };
  }

  const iterStart = Date.now();
  const iterNum   = state.currentIteration + 1;
  const iterationId = randomUUID();

  const ssimBefore = state.currentSsim;
  const ssimGain   = Math.max(0, newSsim - ssimBefore);
  const pctImprovement = ssimBefore > 0
    ? Math.round((ssimGain / ssimBefore) * 10000) / 100
    : 0;

  // ── Run visual optimizer to produce next adjustments ────────────────────
  let plan: OptimizationPlan | null = null;
  let newAdjustments: RuleAdjustment[] = [];

  try {
    const result = await runVisualOptimizer({
      sourceJobId:         state.sourceJobId,
      generatedJobId:      state.generatedJobId,
      componentErrors,
      baselineSsim:        newSsim,
      maxAdjustments:      10,
      existingAdjustments: state.currentAdjustments,
    });
    plan             = result.plan;
    newAdjustments   = result.updatedAdjustments;
  } catch (err) {
    logger.warn({ err, loopId, iterNum }, "B7: optimizer failed — using previous adjustments");
    newAdjustments = state.currentAdjustments;
  }

  // ── Determine stop reason ────────────────────────────────────────────────
  let stopReason: string | null = null;
  if (ssimGain < state.improvementThreshold && iterNum > 1) {
    stopReason = `improvement_below_threshold (gain=${ssimGain.toFixed(4)} < threshold=${state.improvementThreshold})`;
  } else if (iterNum >= state.maxIterations) {
    stopReason = `max_iterations_reached (${state.maxIterations})`;
  }

  // ── Record iteration ─────────────────────────────────────────────────────
  const record: IterationRecord = {
    iterationNumber:    iterNum,
    iterationId,
    startedAt:          new Date(iterStart).toISOString(),
    completedAt:        new Date().toISOString(),
    durationMs:         Date.now() - iterStart,
    ssimBefore,
    ssimAfter:          newSsim,
    ssimGain:           Math.round(ssimGain * 1000) / 1000,
    percentImprovement: pctImprovement,
    adjustmentsApplied: newAdjustments.length,
    adjustmentTypes:    [...new Set(newAdjustments.map(a => a.adjustmentType))],
    optimizationPlanR2: plan?.r2Keys?.plan ?? null,
    stopReason,
  };

  state.iterations.push(record);
  state.currentIteration  = iterNum;
  state.currentSsim       = newSsim;
  state.totalGain         = Math.round((newSsim - state.initialSsim) * 1000) / 1000;
  state.currentAdjustments = newAdjustments;

  if (newSsim > state.bestSsim) {
    state.bestSsim            = newSsim;
    state.bestIterationNumber = iterNum;
  }

  // ── Finalize loop if stop condition met ──────────────────────────────────
  const shouldContinue = stopReason === null;
  if (!shouldContinue) {
    state.status       = ssimGain < state.improvementThreshold && iterNum > 1
      ? "threshold_met"
      : "max_iterations_reached";
    state.completedAt  = new Date().toISOString();
    state.stopReason   = stopReason;
    await persistLoopOutputs(state);
    logger.info(
      { loopId, iterNum, finalSsim: newSsim, totalGain: state.totalGain, stopReason },
      "B7: loop completed",
    );
  } else {
    // periodic persist every 2 iterations for durability
    if (iterNum % 2 === 0) {
      persistLoopOutputs(state).catch(() => { /* non-fatal */ });
    }
    logger.info(
      { loopId, iterNum, ssimBefore, ssimAfter: newSsim, ssimGain, adjustments: newAdjustments.length },
      "B7: iteration complete — continuing",
    );
  }

  return { state, plan, shouldContinue, stopReason };
}

/**
 * Run a fully autonomous loop when component errors are available each iteration.
 * This drives the loop from start to finish using provided per-iteration callbacks.
 */
export async function runAutonomousLoop(opts: {
  startOpts:   StartLoopOptions;
  /** Called each iteration to get fresh component errors and measure new SSIM */
  runIteration: (
    iteration:    number,
    adjustments:  RuleAdjustment[],
  ) => Promise<{ newSsim: number; componentErrors: ComponentErrorReport }>;
}): Promise<VisualOptimizationHistory> {
  const { startOpts, runIteration } = opts;
  const state = startLoop(startOpts);
  const { loopId } = state;

  logger.info({ loopId }, "B7: autonomous loop starting");

  while (state.status === "running") {
    let newSsim: number;
    let componentErrors: ComponentErrorReport;

    try {
      const result = await runIteration(state.currentIteration + 1, state.currentAdjustments);
      newSsim          = result.newSsim;
      componentErrors  = result.componentErrors;
    } catch (err) {
      logger.error({ err, loopId, iteration: state.currentIteration + 1 }, "B7: iteration callback failed — stopping loop");
      stopLoop(loopId, "iteration_callback_error");
      break;
    }

    const { shouldContinue } = await iterateLoop({ loopId, newSsim, componentErrors });
    if (!shouldContinue) break;
  }

  const history = _results.get(loopId) ?? buildHistory(state);
  logger.info(
    { loopId, status: state.status, totalGain: state.totalGain, finalSsim: state.currentSsim },
    "B7: autonomous loop finished",
  );
  return history;
}
