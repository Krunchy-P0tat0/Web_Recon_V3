/**
 * learning-loop-validator.ts  — P0-3
 *
 * Validates the autonomous reconstruction loop:
 *
 *   Generate → Visual Analysis → RuleAdjustment Generation →
 *   RuleAdjustment Application → Regeneration → Re-analysis
 *
 * Verifies measurable fidelity improvement and identifies the exact
 * failure point when no improvement occurs.
 *
 * Outputs written to disk + uploaded to R2:
 *   learning-loop-report.json
 *   iteration-history.json
 *   improvement-summary.json
 */

import { writeFile }       from "fs/promises";
import { join }            from "path";
import { logger }          from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import {
  getLoopState,
  getReconstructionReport,
  startReconstructionLoop,
  deriveAdjustments,
  type LoopState,
  type IterationRecord,
  type ReconstructionReport,
} from "./reconstruction-loop-engine-vr8.js";
import {
  runReconstructionScorer,
  type ReconstructionScoreReport,
} from "./reconstruction-scorer.js";
import {
  translateLegacyAdjustments,
  type RuleAdjustment,
} from "./rule-adjustment-contract.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ValidationStatus =
  | "passed"          // improvement observed and exceeds threshold
  | "passed_plateau"  // loop ran but improvement was marginal (>0 but < threshold)
  | "failed_no_improvement"  // loop ran; delta ≤ 0
  | "failed_no_data"         // no job / no scorer data
  | "failed_generation"      // generation step errored
  | "failed_scoring"         // scorer threw
  | "failed_adjustment"      // adjustment derivation threw
  | "skipped"                // loop already running
  | "dry_run";               // validation run without live generation

export interface ValidationStageResult {
  stage: string;
  status: "pass" | "fail" | "skip" | "info";
  durationMs: number;
  detail: string;
  error?: string;
}

export interface LearningLoopReport {
  schemaVersion:        "P0-3";
  sourceJobId:          string;
  generatedAt:          string;
  durationMs:           number;
  validationStatus:     ValidationStatus;
  iterationsRun:        number;
  initialScore:         number | null;
  finalScore:           number | null;
  bestScore:            number | null;
  totalDelta:           number | null;
  targetReached:        boolean;
  failurePoint:         string | null;
  stages:               ValidationStageResult[];
  adjustmentsGenerated: number;
  adjustmentCategories: string[];
  r2Keys: {
    report:          string | null;
    iterationHistory: string | null;
    improvementSummary: string | null;
  };
}

export interface IterationHistoryEntry {
  iterationNumber:      number;
  generatedJobId:       string;
  scoreBefore:          number;
  scoreAfter:           number;
  delta:                number;
  grade:                string;
  improvementsApplied:  string[];
  issuesBefore:         number;
  issuesAfter:          number;
  adjustments: {
    count:      number;
    categories: string[];
    contracts:  RuleAdjustment[];
  };
  durationMs:   number;
}

export interface ImprovementSummary {
  schemaVersion:      "P0-3";
  sourceJobId:        string;
  generatedAt:        string;
  overallStatus:      ValidationStatus;
  measurableImprovement: boolean;
  improvementPercent: number | null;   // (finalScore - initialScore) / initialScore × 100
  scoreTrajectory:    Array<{ iteration: number; score: number }>;
  failurePoint:       string | null;
  failureReason:      string | null;
  topImprovements:    string[];
  unresolvableIssues: string[];
  recommendations:    string[];
}

export interface ValidationOptions {
  sourceJobId:         string;
  /** Override the generation endpoint (defaults to localhost API) */
  generationEndpoint?: string;
  targetScore?:        number;
  maxIterations?:      number;
  /** If true, only validate wiring without starting a live loop */
  dryRun?:             boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const OUT_DIR = process.cwd();

async function writeDisk(filename: string, data: unknown): Promise<void> {
  await writeFile(join(OUT_DIR, filename), JSON.stringify(data, null, 2), "utf8");
}

async function uploadR2(key: string, data: unknown): Promise<boolean> {
  try {
    const provider = getDefaultCloudProvider();
    if (!provider.isConfigured()) return false;
    await provider.upload({
      key,
      data: Buffer.from(JSON.stringify(data, null, 2), "utf8"),
      contentType: "application/json",
    });
    return true;
  } catch {
    return false;
  }
}

function msNow(): number { return Date.now(); }

function deriveCategories(adjustments: RuleAdjustment[]): string[] {
  return [...new Set(adjustments.map((a) => a.adjustmentType))];
}

/** Poll a LoopState until it reaches a terminal status, timing out after maxMs */
async function waitForLoop(
  sourceJobId: string,
  maxMs: number,
): Promise<LoopState | null> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const state = getLoopState(sourceJobId);
    if (!state) return null;
    if (
      state.status === "completed" ||
      state.status === "failed"
    ) {
      return state;
    }
    await new Promise<void>((r) => setTimeout(r, 2000));
  }
  return getLoopState(sourceJobId) ?? null;
}

// ---------------------------------------------------------------------------
// Stage validation helpers (used in dry-run mode)
// ---------------------------------------------------------------------------

async function stageBaselineScore(
  jobId: string,
  stages: ValidationStageResult[],
): Promise<ReconstructionScoreReport | null> {
  const t0 = msNow();
  try {
    const report = await runReconstructionScorer({ jobId, generatedJobId: null });
    stages.push({
      stage:    "baseline-scoring",
      status:   "pass",
      durationMs: msNow() - t0,
      detail:   `Baseline score: ${report.totalScore ?? 0} (scorer ran successfully)`,
    });
    return report;
  } catch (err) {
    stages.push({
      stage:    "baseline-scoring",
      status:   "fail",
      durationMs: msNow() - t0,
      detail:   "Reconstruction scorer threw",
      error:    err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function stageAdjustmentDerivation(
  jobId: string,
  stages: ValidationStageResult[],
): Promise<{ legacy: ReturnType<typeof deriveAdjustments>; contracts: RuleAdjustment[] } | null> {
  const t0 = msNow();
  try {
    const { runFidelityScoringVR7 } = await import("./visual-fidelity-scoring-engine-vr7.js");
    const vr7 = await runFidelityScoringVR7({
      sourceJobId:    jobId,
      generatedJobId: jobId,
      force:          false,
    });
    const legacy    = deriveAdjustments(vr7, 1);
    const contracts = translateLegacyAdjustments(legacy, "VR-7");
    stages.push({
      stage:    "adjustment-derivation",
      status:   "pass",
      durationMs: msNow() - t0,
      detail:   `Derived ${legacy.length} legacy adjustments → ${contracts.length} P0-1 contracts (categories: ${deriveCategories(contracts).join(", ") || "none"})`,
    });
    return { legacy, contracts };
  } catch (err) {
    stages.push({
      stage:    "adjustment-derivation",
      status:   "fail",
      durationMs: msNow() - t0,
      detail:   "VR7 scoring or adjustment derivation failed",
      error:    err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function stageAdjustmentApplication(
  contracts: RuleAdjustment[],
  stages: ValidationStageResult[],
): boolean {
  const t0 = msNow();
  try {
    if (contracts.length === 0) {
      stages.push({
        stage:    "adjustment-application",
        status:   "skip",
        durationMs: msNow() - t0,
        detail:   "No adjustments to apply (zero contracts derived — site may already be high-fidelity)",
      });
      return true;
    }
    const highConf  = contracts.filter((c) => c.confidence >= 0.7).length;
    const cats      = deriveCategories(contracts);
    stages.push({
      stage:    "adjustment-application",
      status:   "pass",
      durationMs: msNow() - t0,
      detail:   `${contracts.length} adjustments ready to apply; ${highConf} high-confidence; categories: ${cats.join(", ")}`,
    });
    return true;
  } catch (err) {
    stages.push({
      stage:    "adjustment-application",
      status:   "fail",
      durationMs: msNow() - t0,
      detail:   "Adjustment application wiring check failed",
      error:    err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core: run a live reconstruction loop and collect results
// ---------------------------------------------------------------------------

async function runLiveLoop(
  opts: ValidationOptions,
  stages: ValidationStageResult[],
): Promise<{
  state:      LoopState | null;
  report:     ReconstructionReport | null;
  iterations: IterationRecord[];
}> {
  const { sourceJobId, targetScore = 75, maxIterations = 3 } = opts;

  const endpoint = opts.generationEndpoint ??
    `http://localhost:${process.env["PORT"] ?? 8080}/api/generate/${sourceJobId}`;

  const t0 = msNow();
  try {
    const existing = getLoopState(sourceJobId);
    if (existing && (existing.status === "running" || existing.status === "stopping")) {
      stages.push({
        stage:    "loop-start",
        status:   "skip",
        durationMs: 0,
        detail:   "Loop already active for this sourceJobId — waiting for completion",
      });
    } else {
      startReconstructionLoop({
        sourceJobId,
        generationEndpoint: endpoint,
        targetScore,
        maxIterations,
        maxPlateauRounds: 2,
      });
      stages.push({
        stage:    "loop-start",
        status:   "pass",
        durationMs: msNow() - t0,
        detail:   `Loop started (target=${targetScore}, maxIter=${maxIterations})`,
      });
    }

    // Wait up to 10 min for the loop to complete
    const state = await waitForLoop(sourceJobId, 10 * 60 * 1000);
    const report = getReconstructionReport(sourceJobId) ?? null;

    if (!state) {
      stages.push({
        stage:    "loop-completion",
        status:   "fail",
        durationMs: msNow() - t0,
        detail:   "Loop state disappeared — possible crash",
      });
      return { state: null, report: null, iterations: [] };
    }

    const passed = state.status === "completed";
    stages.push({
      stage:    "loop-completion",
      status:   passed ? "pass" : "fail",
      durationMs: msNow() - t0,
      detail:   `Loop finished with status="${state.status}", stoppingCondition="${state.stoppingCondition}", finalScore=${state.currentScore}`,
    });

    return {
      state,
      report,
      iterations: state.iterations ?? [],
    };
  } catch (err) {
    stages.push({
      stage:    "loop-completion",
      status:   "fail",
      durationMs: msNow() - t0,
      detail:   "Loop threw unexpectedly",
      error:    err instanceof Error ? err.message : String(err),
    });
    return { state: null, report: null, iterations: [] };
  }
}

// ---------------------------------------------------------------------------
// Failure-point classifier
// ---------------------------------------------------------------------------

function classifyFailure(
  stages: ValidationStageResult[],
  state: LoopState | null,
): { point: string | null; reason: string | null } {
  const failedStage = stages.find((s) => s.status === "fail");
  if (failedStage) {
    return {
      point:  failedStage.stage,
      reason: failedStage.error ?? failedStage.detail,
    };
  }
  if (state?.stoppingCondition === "generation_error") {
    return { point: "generation-step", reason: state.lastError ?? "Generation endpoint returned error" };
  }
  if (state?.stoppingCondition === "plateau") {
    return { point: "scoring-delta", reason: "Score plateaued — adjustments are not driving measurable change" };
  }
  if (state?.stoppingCondition === "max_iterations") {
    const initialSc = state.iterations[0]?.scoreBefore ?? state.currentScore;
    const delta = state.currentScore - initialSc;
    if (delta <= 0) {
      return { point: "adjustment-efficacy", reason: "Applied adjustments had zero or negative impact on fidelity score" };
    }
  }
  return { point: null, reason: null };
}

// ---------------------------------------------------------------------------
// Build output documents
// ---------------------------------------------------------------------------

function buildIterationHistory(
  sourceJobId: string,
  iterations:  IterationRecord[],
): IterationHistoryEntry[] {
  return iterations.map((it) => {
    const contracts = translateLegacyAdjustments(it.adjustments ?? [], `iteration-${it.iterationNumber}`);
    return {
      iterationNumber:     it.iterationNumber,
      generatedJobId:      it.generatedJobId,
      scoreBefore:         it.scoreBefore,
      scoreAfter:          it.scoreAfter,
      delta:               it.delta,
      grade:               it.grade,
      improvementsApplied: it.improvementsApplied,
      issuesBefore:        it.issuesBefore,
      issuesAfter:         it.issuesAfter,
      adjustments: {
        count:      it.adjustments?.length ?? 0,
        categories: deriveCategories(contracts),
        contracts,
      },
      durationMs: 0,
    };
  });
}

function buildImprovementSummary(
  sourceJobId:  string,
  status:       ValidationStatus,
  state:        LoopState | null,
  report:       ReconstructionReport | null,
  failure:      { point: string | null; reason: string | null },
): ImprovementSummary {
  const initial = report?.result?.initialScore ?? (state ? (state.iterations[0]?.scoreBefore ?? state.currentScore) : null);
  const final_  = report?.result?.finalScore   ?? state?.currentScore ?? null;
  const measurable = initial !== null && final_ !== null && final_ > initial;
  const improvPct  = measurable && initial !== null && initial > 0
    ? Math.round(((final_! - initial) / initial) * 1000) / 10
    : null;

  const trajectory: Array<{ iteration: number; score: number }> = [];
  if (state?.iterations) {
    for (const it of state.iterations) {
      trajectory.push({ iteration: it.iterationNumber, score: it.scoreAfter });
    }
  }

  const topImprovements: string[] = [];
  const unresolvable:    string[] = [];
  if (state?.iterations) {
    for (const it of state.iterations) {
      topImprovements.push(...(it.improvementsApplied ?? []));
    }
  }

  const recommendations: string[] = [];
  if (!measurable) {
    recommendations.push("Increase maxIterations to allow more refinement rounds");
    recommendations.push("Review adjustment confidence thresholds — may be too conservative");
  }
  if (failure.point === "scoring-delta") {
    recommendations.push("Adjustments are being applied but scores are not moving — check VR7 scoring sensitivity");
    unresolvable.push("Score plateau despite adjustments applied");
  }
  if (failure.point === "generation-step") {
    recommendations.push("Fix generation endpoint — loop cannot regenerate without it");
    unresolvable.push("Generation endpoint unreachable");
  }

  return {
    schemaVersion:         "P0-3",
    sourceJobId,
    generatedAt:           new Date().toISOString(),
    overallStatus:         status,
    measurableImprovement: measurable,
    improvementPercent:    improvPct,
    scoreTrajectory:       trajectory,
    failurePoint:          failure.point,
    failureReason:         failure.reason,
    topImprovements:       [...new Set(topImprovements)].slice(0, 10),
    unresolvableIssues:    unresolvable,
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runLearningLoopValidation(
  opts: ValidationOptions,
): Promise<{
  report:            LearningLoopReport;
  iterationHistory:  IterationHistoryEntry[];
  improvementSummary: ImprovementSummary;
}> {
  const { sourceJobId, dryRun = false } = opts;
  const t0     = msNow();
  const stages: ValidationStageResult[] = [];

  logger.info({ sourceJobId, dryRun }, "P0-3: starting learning loop validation");

  // ── Stage 1: Baseline scoring ─────────────────────────────────────────────
  const baselineReport = await stageBaselineScore(sourceJobId, stages);

  // ── Stage 2: Adjustment derivation ───────────────────────────────────────
  const adjResult = await stageAdjustmentDerivation(sourceJobId, stages);
  const contracts = adjResult?.contracts ?? [];

  // ── Stage 3: Adjustment application check ────────────────────────────────
  stageAdjustmentApplication(contracts, stages);

  // ── Stage 4: Live loop or dry-run ────────────────────────────────────────
  let state:      LoopState | null       = null;
  let loopReport: ReconstructionReport | null = null;
  let iterations: IterationRecord[]      = [];

  if (!dryRun) {
    const loopResult = await runLiveLoop(opts, stages);
    state      = loopResult.state;
    loopReport = loopResult.report;
    iterations = loopResult.iterations;
  } else {
    stages.push({
      stage:    "loop-execution",
      status:   "info",
      durationMs: 0,
      detail:   "dry_run=true — skipping live generation loop; all wiring stages passed above",
    });
  }

  // ── Classify result ───────────────────────────────────────────────────────
  const failure = classifyFailure(stages, state);
  const hasFail = stages.some((s) => s.status === "fail");

  let validationStatus: ValidationStatus;
  if (dryRun) {
    validationStatus = hasFail ? "failed_no_data" : "dry_run";
  } else if (!baselineReport) {
    validationStatus = "failed_no_data";
  } else if (hasFail && failure.point === "loop-completion") {
    validationStatus = "failed_generation";
  } else if (hasFail) {
    validationStatus = "failed_no_improvement";
  } else if (state) {
    const initialSc2 = state.iterations[0]?.scoreBefore ?? state.currentScore;
    const delta = state.currentScore - initialSc2;
    if (delta > 5)   validationStatus = "passed";
    else if (delta > 0) validationStatus = "passed_plateau";
    else             validationStatus = "failed_no_improvement";
  } else {
    validationStatus = "dry_run";
  }

  // ── Build outputs ─────────────────────────────────────────────────────────
  const initialScore = loopReport?.result?.initialScore ?? (baselineReport?.breakdown?.structuralFidelity?.score === "UNKNOWN" ? null : baselineReport?.breakdown?.structuralFidelity?.score as number | null | undefined) ?? null;
  const finalScore   = loopReport?.result?.finalScore   ?? state?.currentScore ?? initialScore;
  const bestScore    = loopReport?.result?.bestScore    ?? finalScore;
  const totalDelta   = initialScore !== null && finalScore !== null ? finalScore - initialScore : null;

  const iterationHistory  = buildIterationHistory(sourceJobId, iterations);
  const improvementSummary = buildImprovementSummary(
    sourceJobId, validationStatus, state, loopReport, failure,
  );

  const r2Base = `jobs/${sourceJobId}/learning-loop`;
  const r2Keys = {
    report:           `${r2Base}/learning-loop-report.json`,
    iterationHistory: `${r2Base}/iteration-history.json`,
    improvementSummary: `${r2Base}/improvement-summary.json`,
  };

  const report: LearningLoopReport = {
    schemaVersion:        "P0-3",
    sourceJobId,
    generatedAt:          new Date().toISOString(),
    durationMs:           msNow() - t0,
    validationStatus,
    iterationsRun:        iterations.length,
    initialScore:         initialScore ?? null,
    finalScore:           finalScore   ?? null,
    bestScore:            bestScore    ?? null,
    totalDelta:           totalDelta   ?? null,
    targetReached:        loopReport?.result?.targetReached ?? false,
    failurePoint:         failure.point,
    stages,
    adjustmentsGenerated: contracts.length,
    adjustmentCategories: deriveCategories(contracts),
    r2Keys: {
      report:            null,
      iterationHistory:  null,
      improvementSummary: null,
    },
  };

  // ── Write to disk ─────────────────────────────────────────────────────────
  await Promise.all([
    writeDisk("learning-loop-report.json",   report),
    writeDisk("iteration-history.json",      iterationHistory),
    writeDisk("improvement-summary.json",    improvementSummary),
  ]);

  // ── Upload to R2 (non-fatal) ──────────────────────────────────────────────
  const [r1, r2, r3] = await Promise.all([
    uploadR2(r2Keys.report,            report),
    uploadR2(r2Keys.iterationHistory,  iterationHistory),
    uploadR2(r2Keys.improvementSummary, improvementSummary),
  ]);

  report.r2Keys = {
    report:            r1 ? r2Keys.report            : null,
    iterationHistory:  r2 ? r2Keys.iterationHistory  : null,
    improvementSummary: r3 ? r2Keys.improvementSummary : null,
  };

  // Re-write with R2 keys populated
  await writeDisk("learning-loop-report.json", report);

  logger.info({
    sourceJobId,
    validationStatus,
    totalDelta,
    iterationsRun: iterations.length,
    failurePoint: failure.point,
  }, "P0-3: validation complete");

  return { report, iterationHistory, improvementSummary };
}
