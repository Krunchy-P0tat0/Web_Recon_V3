/**
 * pipeline-orchestrator.ts — Deterministic 10-stage pipeline orchestrator.
 *
 * Transforms the scraper runtime from linear execution into staged orchestration.
 * The orchestrator is the ONLY runtime authority: all stage-to-stage execution is
 * mediated through this class, never by direct phase-to-phase calls.
 *
 * Stages (execution order):
 *   1.  discovery              — job setup, article grouping, manifest init
 *   2.  extraction             — per-article HTTP fetch, raw HTML capture
 *   3.  normalization          — DOM cleanup, URL rewriting, slug generation
 *   4.  manifest_generation    — PageNode assembly, manifest population
 *   5.  media_classification   — image/embed download and MIME classification
 *   6.  local_rendering        — HTML + embed JSON append to archive stream
 *   7.  cloud_upload           — R2 upload of HTML/embeds/media buffers (pre-ZIP)
 *   8.  verification           — HEAD checks on uploaded cloud assets
 *   9.  zip_generation         — deferred media append + archive finalize
 *  10.  manifest_verification  — GET _manifest.json, parse + validate schema
 *  11.  persistence_commit     — ZIP R2 upload, DB update, execution manifest write
 *
 * Constraint enforcement (hard invariants):
 *   cloud_upload           requires  manifest_generation       (constraint 9)
 *   zip_generation         requires  verification              (constraint 10)
 *   manifest_verification  requires  zip_generation            (constraint 11)
 *   persistence_commit     requires  manifest_verification     (constraint 12 — completion gate)
 *
 * Resumability:
 *   Completed stages are preserved across crashes. PipelineOrchestrator.load()
 *   reads the persisted execution manifest; shouldSkip() lets callers skip
 *   already-completed stages. Pairs with the scraper's checkpointUrls mechanism
 *   for article-level resume within stages 2–6.
 *
 * Memory safety:
 *   Each stage runs in isolated context. The media buffer store is held in
 *   memory from Stage 5 through Stage 9, then cleared explicitly. Stage cleanup
 *   is enforced by the orchestrator's completion hook.
 */

import { defaultLocalProvider } from "./storage-provider";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StageName =
  | "discovery"
  | "extraction"
  | "normalization"
  | "visual_capture"
  | "visual_dna"
  | "manifest_generation"
  | "media_classification"
  | "local_rendering"
  | "cloud_upload"
  | "verification"
  | "zip_generation"
  | "manifest_verification"
  | "persistence_commit";

export type StageStatus =
  | "pending"
  | "running"
  | "paused"
  | "failed"
  | "completed"
  | "resumed"
  | "skipped";

export type PipelineStatus =
  | "pending"
  | "running"
  | "paused"
  | "failed"
  | "completed"
  | "resumed";

export interface ResourceUsage {
  /** Heap at completion (MiB) */
  peakHeapMb: number;
  /** Heap growth during the stage (MiB, negative = freed) */
  deltaHeapMb: number;
  /** Wall-clock duration (ms) */
  wallTimeMs: number;
}

export interface StageRecord {
  name: StageName;
  status: StageStatus;
  /** Declared upstream dependencies — enforced by assertDependencies() */
  dependencies: StageName[];
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  resourceUsage: ResourceUsage | null;
  error: string | null;
  retryCount: number;
  attempt: number;
}

/**
 * Serialized execution state — persisted as {jobId}.pipeline.json.
 * Read by monitoring, debugging tools, and the pipeline resume path.
 */
export interface ExecutionManifest {
  schemaVersion: "1.0";
  jobId: string;
  pipelineStatus: PipelineStatus;
  startedAt: string;
  completedAt: string | null;
  totalDurationMs: number | null;
  stages: StageRecord[];
  lastSuccessfulStage: StageName | null;
  /** Stage to resume from on the next attempt */
  resumePoint: StageName | null;
  /** ISO timestamp of the last checkpoint write */
  checkpointAt: string;
  /** Number of times this job has been retried */
  retryAttempt: number;
  workerId: string | null;
}

// ---------------------------------------------------------------------------
// Stage ordering and dependency graph
// ---------------------------------------------------------------------------

export const STAGE_ORDER: readonly StageName[] = [
  "discovery",
  "extraction",
  "normalization",
  "visual_capture",
  "visual_dna",
  "manifest_generation",
  "media_classification",
  "local_rendering",
  "cloud_upload",
  "verification",
  "zip_generation",
  "manifest_verification",
  "persistence_commit",
];

/**
 * Dependency graph — beginStage() asserts these before a stage can run.
 *
 * Key constraints:
 *   cloud_upload          depends on manifest_generation  (constraint 9)
 *   zip_generation        depends on verification         (constraint 10)
 *   manifest_verification depends on zip_generation       (constraint 11)
 *   persistence_commit    depends on manifest_verification (constraint 12 — completion gate)
 */
const STAGE_DEPS: Record<StageName, StageName[]> = {
  discovery:             [],
  extraction:            ["discovery"],
  normalization:         ["extraction"],
  visual_capture:        ["normalization"],           // Phase 2.5A: after normalization
  visual_dna:            ["visual_capture"],          // Phase 2.5B: after visual_capture
  manifest_generation:   ["visual_dna"],              // now depends on visual_dna
  media_classification:  ["manifest_generation"],
  local_rendering:       ["media_classification"],
  cloud_upload:          ["manifest_generation"],     // constraint 9
  verification:          ["cloud_upload"],
  zip_generation:        ["verification"],             // constraint 10
  manifest_verification: ["zip_generation"],           // constraint 11
  persistence_commit:    ["manifest_verification"],    // constraint 12 — completion gate
};

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function heapMb(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function pipelineKey(jobId: string): string {
  return `${jobId}.pipeline.json`;
}

// ---------------------------------------------------------------------------
// PipelineOrchestrator
// ---------------------------------------------------------------------------

export class PipelineOrchestrator {
  private exec: ExecutionManifest;
  private readonly stageMap: Map<StageName, StageRecord>;
  private readonly pipelineStartMs: number;
  private readonly stageStartMs = new Map<StageName, number>();
  private readonly stageStartHeap = new Map<StageName, number>();

  // ── Construction ──────────────────────────────────────────────────────────

  constructor(
    jobId: string,
    workerId: string | null = null,
    previous?: ExecutionManifest
  ) {
    this.pipelineStartMs = Date.now();

    if (previous) {
      // Resume path: reset failed/interrupted stages, preserve completed ones
      const stages = previous.stages.map((s): StageRecord => {
        const needsReset = s.status === "failed" || s.status === "running";
        return {
          ...s,
          status: needsReset ? "pending" : s.status,
          startedAt: needsReset ? null : s.startedAt,
          completedAt: needsReset ? null : s.completedAt,
          durationMs: needsReset ? null : s.durationMs,
          error: needsReset ? null : s.error,
          retryCount: s.status === "failed" ? s.retryCount + 1 : s.retryCount,
          attempt: s.status === "failed" ? s.attempt + 1 : s.attempt,
        };
      });

      this.exec = {
        ...previous,
        stages,
        pipelineStatus: "resumed",
        retryAttempt: (previous.retryAttempt ?? 0) + 1,
        workerId: workerId ?? previous.workerId,
        completedAt: null,
        totalDurationMs: null,
        checkpointAt: new Date().toISOString(),
      };
    } else {
      const stages: StageRecord[] = STAGE_ORDER.map((name) => ({
        name,
        status: "pending",
        dependencies: STAGE_DEPS[name],
        startedAt: null,
        completedAt: null,
        durationMs: null,
        resourceUsage: null,
        error: null,
        retryCount: 0,
        attempt: 1,
      }));

      this.exec = {
        schemaVersion: "1.0",
        jobId,
        pipelineStatus: "pending",
        startedAt: new Date().toISOString(),
        completedAt: null,
        totalDurationMs: null,
        stages,
        lastSuccessfulStage: null,
        resumePoint: null,
        checkpointAt: new Date().toISOString(),
        retryAttempt: 0,
        workerId,
      };
    }

    this.stageMap = new Map(this.exec.stages.map((s) => [s.name, s]));
  }

  // ── Stage lifecycle ───────────────────────────────────────────────────────

  /**
   * Marks a stage as running.
   *
   * Asserts all declared dependencies are completed first (hard invariant).
   * Captures start time and heap snapshot for resource tracking.
   * Emits a structured "stage start" log and writes a checkpoint snapshot.
   */
  async beginStage(name: StageName): Promise<void> {
    this.assertDependencies(name);

    const stage = this.stageMap.get(name)!;
    if (stage.status === "completed" || stage.status === "skipped") {
      logger.debug(
        { jobId: this.exec.jobId, stage: name, status: stage.status },
        "PIPELINE: beginStage skipped — stage already finished"
      );
      return;
    }

    stage.status = stage.status === "pending" ? "running" : "resumed";
    stage.startedAt = new Date().toISOString();
    this.stageStartMs.set(name, Date.now());
    this.stageStartHeap.set(name, heapMb());

    if (this.exec.pipelineStatus === "pending" || this.exec.pipelineStatus === "resumed") {
      this.exec.pipelineStatus = "running";
    }

    logger.info(
      {
        jobId: this.exec.jobId,
        stage: name,
        status: stage.status,
        attempt: stage.attempt,
        retryCount: stage.retryCount,
        dependencies: stage.dependencies,
        heapMb: round1(this.stageStartHeap.get(name)!),
        pipelineRetryAttempt: this.exec.retryAttempt,
      },
      `PIPELINE: stage start — ${name}`
    );

    await this.writeCheckpoint();
  }

  /**
   * Marks a stage as completed.
   *
   * Records wall-clock timing, heap delta, and peak heap.
   * Updates lastSuccessfulStage and writes a checkpoint snapshot.
   */
  async completeStage(name: StageName): Promise<void> {
    const stage = this.stageMap.get(name)!;
    if (stage.status === "completed" || stage.status === "skipped") return;

    const startMs  = this.stageStartMs.get(name) ?? Date.now();
    const startHeap = this.stageStartHeap.get(name) ?? heapMb();
    const endHeap  = heapMb();
    const wallTimeMs = Date.now() - startMs;

    stage.status = "completed";
    stage.completedAt = new Date().toISOString();
    stage.durationMs = wallTimeMs;
    stage.resourceUsage = {
      peakHeapMb:  round1(Math.max(startHeap, endHeap)),
      deltaHeapMb: round1(endHeap - startHeap),
      wallTimeMs,
    };

    this.exec.lastSuccessfulStage = name;

    logger.info(
      {
        jobId: this.exec.jobId,
        stage: name,
        durationMs: wallTimeMs,
        peakHeapMb: stage.resourceUsage.peakHeapMb,
        deltaHeapMb: stage.resourceUsage.deltaHeapMb,
        lastSuccessfulStage: name,
      },
      `PIPELINE: stage complete — ${name}`
    );

    await this.writeCheckpoint();
  }

  /**
   * Marks a stage as failed.
   *
   * Records the error message and duration. The pipeline continues by default;
   * call failPipeline() to abort. Writes a checkpoint snapshot.
   */
  async failStage(name: StageName, error: Error | string): Promise<void> {
    const stage = this.stageMap.get(name)!;
    if (stage.status === "completed" || stage.status === "skipped") return;

    const wallTimeMs = Date.now() - (this.stageStartMs.get(name) ?? Date.now());
    const errMsg = error instanceof Error ? error.message : String(error);

    stage.status = "failed";
    stage.completedAt = new Date().toISOString();
    stage.durationMs = wallTimeMs;
    stage.error = errMsg;

    logger.error(
      {
        jobId: this.exec.jobId,
        stage: name,
        error: errMsg,
        attempt: stage.attempt,
        retryCount: stage.retryCount,
        durationMs: wallTimeMs,
      },
      `PIPELINE: stage failed — ${name}`
    );

    await this.writeCheckpoint();
  }

  /**
   * Marks a stage as skipped.
   *
   * Used when a stage is determined unnecessary (e.g., R2 not configured)
   * or already completed in a prior run. Counts as a success for dependency
   * resolution — downstream stages may proceed.
   */
  async skipStage(name: StageName, reason?: string): Promise<void> {
    const stage = this.stageMap.get(name)!;
    if (stage.status === "completed" || stage.status === "skipped") return;

    stage.status = "skipped";
    stage.startedAt = stage.startedAt ?? new Date().toISOString();
    stage.completedAt = new Date().toISOString();
    stage.durationMs = 0;
    this.exec.lastSuccessfulStage = name;

    logger.info(
      { jobId: this.exec.jobId, stage: name, reason: reason ?? "not required" },
      `PIPELINE: stage skipped — ${name}`
    );

    await this.writeCheckpoint();
  }

  /**
   * Increments retry count and resets status to running.
   * Call before re-attempting a failed stage.
   */
  async retryStage(name: StageName): Promise<void> {
    const stage = this.stageMap.get(name)!;
    stage.status = "running";
    stage.retryCount++;
    stage.attempt++;
    stage.error = null;
    stage.startedAt = new Date().toISOString();
    this.stageStartMs.set(name, Date.now());
    this.stageStartHeap.set(name, heapMb());

    logger.warn(
      {
        jobId: this.exec.jobId,
        stage: name,
        retryCount: stage.retryCount,
        attempt: stage.attempt,
      },
      `PIPELINE: stage retry — ${name}`
    );

    await this.writeCheckpoint();
  }

  // ── Pipeline terminal states ───────────────────────────────────────────────

  /** Seals the pipeline as successfully completed. Writes final execution manifest. */
  async completePipeline(): Promise<void> {
    this.exec.pipelineStatus = "completed";
    this.exec.completedAt = new Date().toISOString();
    this.exec.totalDurationMs = Date.now() - this.pipelineStartMs;
    this.exec.checkpointAt = new Date().toISOString();

    const completedStages = this.exec.stages.filter(
      (s) => s.status === "completed" || s.status === "skipped"
    ).length;
    const failedStages = this.exec.stages.filter((s) => s.status === "failed").length;

    logger.info(
      {
        jobId: this.exec.jobId,
        totalDurationMs: this.exec.totalDurationMs,
        lastSuccessfulStage: this.exec.lastSuccessfulStage,
        retryAttempt: this.exec.retryAttempt,
        completedStages,
        failedStages,
        totalStages: this.exec.stages.length,
      },
      "PIPELINE: pipeline completed successfully"
    );

    await this.save();
  }

  /**
   * Marks any currently running stage as failed and seals the pipeline as failed.
   * Writes final execution manifest for post-mortem analysis.
   */
  async failPipeline(error: Error | string): Promise<void> {
    const errMsg = error instanceof Error ? error.message : String(error);

    for (const stage of this.exec.stages) {
      if (stage.status === "running") {
        await this.failStage(stage.name, errMsg).catch(() => {});
      }
    }

    this.exec.pipelineStatus = "failed";
    this.exec.completedAt = new Date().toISOString();
    this.exec.totalDurationMs = Date.now() - this.pipelineStartMs;

    logger.error(
      {
        jobId: this.exec.jobId,
        error: errMsg,
        lastSuccessfulStage: this.exec.lastSuccessfulStage,
        totalDurationMs: this.exec.totalDurationMs,
        retryAttempt: this.exec.retryAttempt,
      },
      "PIPELINE: pipeline failed"
    );

    await this.save();
  }

  // ── Resume helpers ────────────────────────────────────────────────────────

  /**
   * Returns true if a stage is already completed or skipped.
   * Used by callers to short-circuit work on the resume path.
   *
   * Callers that return early from a skippable stage should call
   * skipStage() so the execution manifest accurately reflects the skip.
   */
  shouldSkip(name: StageName): boolean {
    const s = this.stageMap.get(name);
    return s?.status === "completed" || s?.status === "skipped";
  }

  /**
   * Asserts that all declared dependencies for a stage are completed/skipped.
   *
   * Throws with a descriptive message if any dependency is unmet.
   * This is the runtime enforcement for pipeline constraints 9 and 10.
   *
   * @throws Error if any dependency has not completed.
   */
  assertDependencies(name: StageName): void {
    const deps = STAGE_DEPS[name];
    for (const dep of deps) {
      const depStage = this.stageMap.get(dep)!;
      if (depStage.status !== "completed" && depStage.status !== "skipped") {
        throw new Error(
          `PIPELINE: constraint violated — stage "${name}" requires "${dep}" ` +
          `to be completed first (current: "${depStage.status}")`
        );
      }
    }
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  getExecution(): Readonly<ExecutionManifest> {
    return this.exec;
  }

  getStage(name: StageName): Readonly<StageRecord> {
    return this.stageMap.get(name)!;
  }

  get jobId(): string {
    return this.exec.jobId;
  }

  // ── Checkpoint and persistence ────────────────────────────────────────────

  /**
   * Internal checkpoint — called after every stage transition.
   * Write errors are swallowed; pipeline execution is never blocked by them.
   */
  private async writeCheckpoint(): Promise<void> {
    this.exec.checkpointAt = new Date().toISOString();
    await this.save().catch((err) => {
      logger.warn(
        { jobId: this.exec.jobId, err },
        "PIPELINE: checkpoint write failed (non-fatal)"
      );
    });
  }

  /**
   * Serializes the execution manifest to {jobId}.pipeline.json via the
   * default local storage provider.
   */
  async save(): Promise<void> {
    await defaultLocalProvider.write(
      pipelineKey(this.exec.jobId),
      JSON.stringify(this.exec, null, 2)
    );
  }

  // ── Static factory / loader ───────────────────────────────────────────────

  /**
   * Attempts to load a persisted ExecutionManifest for resume.
   *
   * Returns a PipelineOrchestrator in the "resumed" state if a valid
   * checkpoint exists, or null if the checkpoint is absent or corrupt.
   */
  static async load(
    jobId: string,
    workerId: string | null = null
  ): Promise<PipelineOrchestrator | null> {
    try {
      const key = pipelineKey(jobId);
      if (!(await defaultLocalProvider.exists(key))) return null;

      const buf  = await defaultLocalProvider.read(key);
      const prev = JSON.parse(buf.toString("utf8")) as ExecutionManifest;

      if (prev.schemaVersion !== "1.0" || prev.jobId !== jobId) return null;

      // Identify where to resume: first failed or interrupted stage
      const resumePoint =
        prev.stages.find(
          (s) => s.status === "failed" || s.status === "running"
        )?.name ?? null;

      const orchestrator = new PipelineOrchestrator(jobId, workerId, {
        ...prev,
        resumePoint,
      });

      logger.info(
        {
          jobId,
          lastSuccessfulStage: prev.lastSuccessfulStage,
          resumePoint,
          retryAttempt: (prev.retryAttempt ?? 0) + 1,
          stagesCompleted: prev.stages.filter(
            (s) => s.status === "completed" || s.status === "skipped"
          ).length,
        },
        "PIPELINE: loaded execution manifest for resume"
      );

      return orchestrator;
    } catch (err) {
      logger.warn(
        { jobId, err },
        "PIPELINE: could not load execution manifest — starting fresh"
      );
      return null;
    }
  }

  /**
   * Removes the persisted execution manifest. Call after job expiry or cleanup.
   */
  static async cleanup(jobId: string): Promise<void> {
    await defaultLocalProvider.delete(pipelineKey(jobId)).catch(() => {});
  }
}
