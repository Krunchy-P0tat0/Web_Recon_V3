/**
 * visual-pipeline-orchestrator.ts — P0-2: Automatic Visual Reconstruction Pipeline
 *
 * Executes VR-1 through VR-8 in strict sequence after every Website Prime generation.
 * No manual triggers required.
 *
 * Pipeline:
 *   VR-1  Visual Reconstruction (apply DNA overlay to report)
 *   VR-2  Visual DNA Analysis   (extract color / typography / layout signals)
 *   VR-3  Layout Mapper         (map page layout regions)
 *   VR-4  Visual Fidelity       (compare source DNA vs generated DNA)
 *   VR-5  Visual Stencil Mapper (pick best stencil fit)
 *   VR-6  Consistency Engine    (audit cross-page consistency rules)
 *   VR-7  Fidelity Scoring      (score source vs generated, derive issues)
 *   VR-8  Reconstruction Loop   (iterative self-improvement loop — async)
 *
 * Features:
 *   - Per-stage retry with exponential back-off (configurable)
 *   - Partial reruns: pass startFromStage to resume from any VR stage
 *   - Generates pipeline-orchestration-report.json and execution-timeline.json
 *   - Uploads both to R2 (non-fatal)
 *   - Derives RuleAdjustment[] from VR-7 output via the P0-1 contract
 */

import { randomUUID }          from "crypto";
import { writeFile }           from "fs/promises";
import { join }                from "path";
import { logger }              from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import type { Manifest }       from "./manifest.js";
import { translateLegacyAdjustments } from "./rule-adjustment-contract.js";
import type { RuleAdjustment } from "./rule-adjustment-contract.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VRStageId =
  | "VR-1" | "VR-2" | "VR-3" | "VR-4"
  | "VR-5" | "VR-6" | "VR-7" | "VR-8";

export type VRStageStatus =
  | "pending" | "running" | "complete" | "failed" | "skipped" | "retrying";

export interface VRStageResult {
  stageId:     VRStageId;
  label:       string;
  status:      VRStageStatus;
  startedAt:   string | null;
  completedAt: string | null;
  durationMs:  number | null;
  retryCount:  number;
  error:       string | null;
  outputSummary: Record<string, unknown>;
}

export interface PipelineOrchestrationReport {
  id:              string;
  jobId:           string;
  status:          "running" | "complete" | "partial" | "failed";
  startedAt:       string;
  completedAt:     string | null;
  totalDurationMs: number | null;
  stages:          VRStageResult[];
  adjustments:     RuleAdjustment[];
  fidelityScore:   number | null;
  fidelityGrade:   string | null;
  generatedAt:     string;
}

export interface ExecutionTimelineEntry {
  stageId:     VRStageId;
  label:       string;
  startOffset: number;
  endOffset:   number | null;
  durationMs:  number | null;
  status:      VRStageStatus;
  retries:     number;
}

export interface ExecutionTimeline {
  jobId:       string;
  runId:       string;
  startedAt:   string;
  entries:     ExecutionTimelineEntry[];
  generatedAt: string;
}

export interface VisualPipelineOptions {
  /** Start from a specific VR stage (for partial reruns). Default: VR-1. */
  startFromStage?: VRStageId;
  /** Max retries per stage. Default: 2. */
  maxRetries?: number;
  /** Base delay in ms for exponential back-off. Default: 800. */
  retryBaseMs?: number;
  /** VR-8 target fidelity score. Default: 75. */
  targetFidelityScore?: number;
  /** VR-8 max iterations. Default: 5. */
  maxIterations?: number;
}

// ---------------------------------------------------------------------------
// Stage label map
// ---------------------------------------------------------------------------

const STAGE_LABELS: Record<VRStageId, string> = {
  "VR-1": "Visual Reconstruction — apply DNA overlay",
  "VR-2": "Visual DNA Analysis  — extract design signals",
  "VR-3": "Layout Mapper        — map page regions",
  "VR-4": "Visual Fidelity      — source vs generated DNA",
  "VR-5": "Visual Stencil Mapper— select best stencil fit",
  "VR-6": "Consistency Engine   — cross-page audit",
  "VR-7": "Fidelity Scoring     — score + derive issues",
  "VR-8": "Reconstruction Loop  — iterative self-improvement",
};

const ALL_STAGES: VRStageId[] = [
  "VR-1","VR-2","VR-3","VR-4","VR-5","VR-6","VR-7","VR-8",
];

// ---------------------------------------------------------------------------
// In-memory report store
// ---------------------------------------------------------------------------

const _reports = new Map<string, PipelineOrchestrationReport>();

export function getOrchestrationReport(jobId: string): PipelineOrchestrationReport | undefined {
  return _reports.get(jobId);
}

export function listOrchestrationReports(): PipelineOrchestrationReport[] {
  return Array.from(_reports.values()).sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxRetries: number,
  baseMs: number,
): Promise<{ result: T; retries: number }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      return { result, retries: attempt };
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const delay = baseMs * Math.pow(2, attempt);
        logger.warn({ label, attempt, delay }, "VISUAL-PIPELINE: stage attempt failed, retrying");
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// File paths
// ---------------------------------------------------------------------------

const REPORT_PATH   = join(process.cwd(), "pipeline-orchestration-report.json");
const TIMELINE_PATH = join(process.cwd(), "execution-timeline.json");

// ---------------------------------------------------------------------------
// Persist helpers
// ---------------------------------------------------------------------------

async function persistReport(report: PipelineOrchestrationReport): Promise<void> {
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2), "utf8").catch(() => {});
  const cloud = getDefaultCloudProvider();
  if (cloud.isConfigured()) {
    await cloud.upload({
      key: `system/pipeline-orchestration-report.json`,
      data: Buffer.from(JSON.stringify(report, null, 2), "utf8"),
      contentType: "application/json",
      checkDuplicate: false,
    }).catch(() => {});
  }
}

async function persistTimeline(timeline: ExecutionTimeline): Promise<void> {
  await writeFile(TIMELINE_PATH, JSON.stringify(timeline, null, 2), "utf8").catch(() => {});
  const cloud = getDefaultCloudProvider();
  if (cloud.isConfigured()) {
    await cloud.upload({
      key: `system/execution-timeline.json`,
      data: Buffer.from(JSON.stringify(timeline, null, 2), "utf8"),
      contentType: "application/json",
      checkDuplicate: false,
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function runVisualPipeline(
  jobId: string,
  manifest: Manifest,
  opts: VisualPipelineOptions = {},
): Promise<PipelineOrchestrationReport> {
  const {
    startFromStage  = "VR-1",
    maxRetries      = 2,
    retryBaseMs     = 800,
    targetFidelityScore = 75,
    maxIterations   = 5,
  } = opts;

  const runId    = randomUUID();
  const startedAt = new Date().toISOString();
  const t0       = Date.now();

  const startIdx = ALL_STAGES.indexOf(startFromStage);

  const stages: VRStageResult[] = ALL_STAGES.map((stageId) => ({
    stageId,
    label:       STAGE_LABELS[stageId],
    status:      ALL_STAGES.indexOf(stageId) < startIdx ? "skipped" : "pending",
    startedAt:   null,
    completedAt: null,
    durationMs:  null,
    retryCount:  0,
    error:       null,
    outputSummary: {},
  }));

  const report: PipelineOrchestrationReport = {
    id:              runId,
    jobId,
    status:          "running",
    startedAt,
    completedAt:     null,
    totalDurationMs: null,
    stages,
    adjustments:     [],
    fidelityScore:   null,
    fidelityGrade:   null,
    generatedAt:     new Date().toISOString(),
  };

  _reports.set(jobId, report);

  const timeline: ExecutionTimeline = {
    jobId,
    runId,
    startedAt,
    entries: [],
    generatedAt: new Date().toISOString(),
  };

  function patchStage(id: VRStageId, patch: Partial<VRStageResult>): void {
    const s = report.stages.find((r) => r.stageId === id);
    if (s) Object.assign(s, patch);
  }

  function timelineEntry(id: VRStageId, startOffset: number, result: VRStageResult): void {
    timeline.entries.push({
      stageId:     id,
      label:       STAGE_LABELS[id],
      startOffset,
      endOffset:   result.durationMs != null ? startOffset + result.durationMs : null,
      durationMs:  result.durationMs,
      status:      result.status,
      retries:     result.retryCount,
    });
  }

  logger.info({ jobId, runId, startFromStage }, "VISUAL-PIPELINE: starting VR-1…VR-8 orchestration");

  let fidelityScore: number | null = null;
  let fidelityGrade: string | null = null;

  const runStage = async (
    id: VRStageId,
    fn: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown> | null> => {
    if (ALL_STAGES.indexOf(id) < startIdx) return null;

    const stageT0     = Date.now();
    const stageOffset = stageT0 - t0;
    patchStage(id, { status: "running", startedAt: new Date().toISOString() });
    await persistReport(report);

    try {
      const { result, retries } = await withRetry(id, fn, maxRetries, retryBaseMs);
      const durationMs = Date.now() - stageT0;
      patchStage(id, {
        status:       "complete",
        completedAt:  new Date().toISOString(),
        durationMs,
        retryCount:   retries,
        outputSummary: result,
      });
      const s = report.stages.find((r) => r.stageId === id)!;
      timelineEntry(id, stageOffset, s);
      logger.info({ jobId, stageId: id, durationMs, retries }, "VISUAL-PIPELINE: stage complete");
      await persistReport(report);
      return result;
    } catch (err) {
      const durationMs = Date.now() - stageT0;
      const msg = err instanceof Error ? err.message : String(err);
      patchStage(id, {
        status:      "failed",
        completedAt: new Date().toISOString(),
        durationMs,
        error:       msg,
      });
      const s = report.stages.find((r) => r.stageId === id)!;
      timelineEntry(id, stageOffset, s);
      logger.warn({ jobId, stageId: id, err }, "VISUAL-PIPELINE: stage failed (non-fatal — continuing)");
      await persistReport(report);
      return null;
    }
  };

  // ── VR-1: Visual Reconstruction ──────────────────────────────────────────
  await runStage("VR-1", async () => {
    const { runVisualReconstruction } = await import("./visual-reconstruction-engine.js");
    const generationReport = { pipeline: { status: "success" }, stencilSelection: null, generation: null };
    const result = await runVisualReconstruction(jobId, generationReport as never);
    return {
      overlayApplied: result?.overlayApplied ?? false,
      fidelityScore:  result?.fidelityScore ?? null,
      grade:          result?.grade ?? null,
    };
  });

  // ── VR-2: Visual DNA Analysis ─────────────────────────────────────────────
  await runStage("VR-2", async () => {
    const { runVisualDna } = await import("./visual-dna-engine.js");
    const result = await runVisualDna(jobId, manifest);
    return {
      pagesAnalyzed:     result.pagesAnalyzed,
      pagesSkipped:      result.pagesSkipped,
      overallConfidence: result.overallConfidence,
    };
  });

  // ── VR-3: Layout Mapper ───────────────────────────────────────────────────
  await runStage("VR-3", async () => {
    const { runLayoutMapper } = await import("./visual-layout-mapper-engine.js");
    const result = await runLayoutMapper(jobId, manifest);
    return {
      pagesProcessed: result.mappedPages ?? 0,
      regionsTotal:   result.avgRegionsPerPage ?? 0,
    };
  });

  // ── VR-4: Visual Fidelity ────────────────────────────────────────────────
  await runStage("VR-4", async () => {
    const { runVisualFidelity } = await import("./visual-fidelity-engine.js");
    const result = await runVisualFidelity({ sourceJobId: jobId, generatedJobId: jobId });
    const allIssues = [
      ...(result.issues?.missingSections   ?? []),
      ...(result.issues?.layoutDrift       ?? []),
      ...(result.issues?.componentMismatches ?? []),
      ...(result.issues?.designMismatches  ?? []),
    ];
    return {
      overallScore: result.summary?.overallScore ?? null,
      grade:        result.summary?.grade        ?? null,
      totalIssues:  allIssues.length,
    };
  });

  // ── VR-5: Visual Stencil Mapper ──────────────────────────────────────────
  await runStage("VR-5", async () => {
    const { runVisualStencilMapperVR5 } = await import("./visual-stencil-mapper-vr5-engine.js");
    const result = await runVisualStencilMapperVR5({ jobId });
    return {
      stencilType: result.siteStencil?.type ?? null,
      confidence:  result.summary?.visualConfidence ?? null,
      pagesScored: result.summary?.pagesAnalyzed   ?? 0,
    };
  });

  // ── VR-6: Consistency Engine ─────────────────────────────────────────────
  await runStage("VR-6", async () => {
    const { runConsistencyEngineVR6 } = await import("./consistency-engine-vr6.js");
    const { report } = await runConsistencyEngineVR6({ jobId });
    return {
      issueCount:   report?.issues?.length           ?? 0,
      overallScore: report?.metrics?.overallConsistency ?? null,
    };
  });

  // ── VR-7: Fidelity Scoring ────────────────────────────────────────────────
  const vr7Out = await runStage("VR-7", async () => {
    const { runFidelityScoringVR7 } = await import("./visual-fidelity-scoring-engine-vr7.js");
    const result = await runFidelityScoringVR7({ sourceJobId: jobId, generatedJobId: jobId });
    fidelityScore = result.global?.totalScore ?? null;
    fidelityGrade = result.global?.grade      ?? null;
    return {
      overallScore: result.global?.totalScore ?? null,
      grade:        result.global?.grade      ?? null,
      issueCount:   result.issues?.length     ?? 0,
    };
  });

  // Translate VR-7 issues into P0-1 contract adjustments
  if (vr7Out) {
    try {
      const { deriveAdjustments } = await import("./reconstruction-loop-engine-vr8.js");
      const { runFidelityScoringVR7 } = await import("./visual-fidelity-scoring-engine-vr7.js");
      const vr7Report = await runFidelityScoringVR7({ sourceJobId: jobId, generatedJobId: jobId, force: false });
      const legacyAdj = deriveAdjustments(vr7Report, 1);
      report.adjustments = translateLegacyAdjustments(legacyAdj, "VR-7");
    } catch {
      /* non-fatal */
    }
  }

  report.fidelityScore = fidelityScore;
  report.fidelityGrade = fidelityGrade;

  // ── VR-8: Reconstruction Loop (async — fire & forget if below target) ────
  const belowTarget = fidelityScore == null || fidelityScore < targetFidelityScore;
  await runStage("VR-8", async () => {
    if (!belowTarget) {
      return { skippedReason: "fidelity target already met", fidelityScore };
    }
    const { startReconstructionLoop } = await import("./reconstruction-loop-engine-vr8.js");
    const loopState = startReconstructionLoop({
      sourceJobId:        jobId,
      generationEndpoint: `/api/generation/run`,
      targetScore:        targetFidelityScore,
      maxIterations,
      initialScore:       fidelityScore ?? 0,
    });
    return {
      loopId:    loopState.sourceJobId,
      status:    loopState.status,
      triggered: true,
    };
  });

  // ── Finalise ──────────────────────────────────────────────────────────────
  const totalDurationMs = Date.now() - t0;
  const anyFailed = report.stages.some((s) => s.status === "failed");

  report.status          = anyFailed ? "partial" : "complete";
  report.completedAt     = new Date().toISOString();
  report.totalDurationMs = totalDurationMs;
  report.generatedAt     = new Date().toISOString();
  timeline.generatedAt   = new Date().toISOString();

  _reports.set(jobId, report);

  await persistReport(report);
  await persistTimeline(timeline);

  logger.info(
    {
      jobId,
      runId,
      status:     report.status,
      durationMs: totalDurationMs,
      fidelityScore,
      fidelityGrade,
      adjustments: report.adjustments.length,
    },
    "VISUAL-PIPELINE: VR-1…VR-8 orchestration complete",
  );

  return report;
}
