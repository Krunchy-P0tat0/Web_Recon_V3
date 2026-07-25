/**
 * r2-stage-persister.ts — Phase D3.4 Stage Persistence Engine
 *
 * Called immediately after every pipeline stage completes (or fails).
 * Persists to R2 without blocking the pipeline — all writes are
 * fire-and-forget from the caller's perspective.
 *
 * Per stage:
 *   job-set-{jobId}/stages/{stageId}.json   — stage result snapshot
 *   job-set-{jobId}/manifest/manifest.json  — updated artifact index
 *   job-set-{jobId}/logs/pipeline.log       — running log (appended)
 *
 * On job completion:
 *   job-set-{jobId}/reports/execution-summary.json
 */

import { logger } from "./logger.js";
import type { CloudProvider } from "../cloud/provider.js";
import { R2Keys } from "../cloud/r2-key-registry.js";
import {
  makeEmptyManifest,
  saveManifest,
  getCachedManifest,
  updateManifestStage,
  type JobStorageManifest,
  type StageRecord,
  type ArtifactStatus,
} from "./job-storage-manifest.js";
import type { MasterStageId, MasterStageResult, OrchestrationJob } from "./master-orchestrator.js";

// ---------------------------------------------------------------------------
// Stage → artifact key mapping
// Which R2 keys does each stage produce? Used to populate the manifest.
// ---------------------------------------------------------------------------

const STAGE_ARTIFACTS: Partial<Record<MasterStageId, (jobId: string) => string[]>> = {
  manifest:        (id) => [R2Keys.manifest.index(id)],
  diff:            (id) => [
    R2Keys.differential.changed(id),
    R2Keys.differential.unchanged(id),
    R2Keys.differential.deleted(id),
    R2Keys.differential.new(id),
  ],
  "design-dna":    (id) => [
    R2Keys.brandDna.typography(id),
    R2Keys.brandDna.spacing(id),
    R2Keys.brandDna.branding(id),
  ],
  "visual-dna":    (id) => [
    R2Keys.visualDna.layouts(id),
    R2Keys.visualDna.designTokens(id),
    R2Keys.visualDna.colorSystems(id),
  ],
  "website-prime": (id) => [
    R2Keys.websitePrime.zip(id),
    R2Keys.websitePrime.siteZip(id),
    R2Keys.websitePrime.index(id),
  ],
  certification:   (id) => [R2Keys.certification.report(id)],
};

// ---------------------------------------------------------------------------
// Per-job pipeline log buffer (in-memory, flushed on each stage persist)
// ---------------------------------------------------------------------------

const _pipelineLogs = new Map<string, string[]>();

function appendLog(jobId: string, line: string): void {
  if (!_pipelineLogs.has(jobId)) _pipelineLogs.set(jobId, []);
  const lines = _pipelineLogs.get(jobId)!;
  lines.push(line);
  // Keep rolling window of 500 lines
  if (lines.length > 500) _pipelineLogs.set(jobId, lines.slice(-500));
}

async function flushPipelineLog(jobId: string, cloud: CloudProvider): Promise<void> {
  const lines = _pipelineLogs.get(jobId);
  if (!lines?.length || !cloud.isConfigured()) return;
  const content = lines.join("\n") + "\n";
  await cloud.upload({
    key:           R2Keys.logs.pipeline(jobId),
    data:          Buffer.from(content, "utf8"),
    contentType:   "text/plain; charset=utf-8",
    checkDuplicate: false,
  });
}

// ---------------------------------------------------------------------------
// Main: persist a single stage output
// ---------------------------------------------------------------------------

export async function persistStageOutput(
  job:   OrchestrationJob,
  stage: MasterStageResult,
  cloud: CloudProvider
): Promise<void> {
  if (!cloud.isConfigured()) return;

  const jobId    = job.id;
  const stageId  = stage.id;
  const scrapeId = job.underlyingJobId ?? null;
  const seedUrl  = job.url;

  try {
    // ── 1. Write stage result snapshot ───────────────────────────────────
    const snapshot = {
      schemaVersion: "1.0.0",
      jobId,
      scrapeJobId:   scrapeId,
      stageId,
      label:         stage.label,
      status:        stage.status,
      startedAt:     stage.startedAt,
      completedAt:   stage.completedAt,
      durationMs:    stage.durationMs,
      retryCount:    stage.retryCount,
      error:         stage.error,
      metadata:      stage.metadata,
      persistedAt:   new Date().toISOString(),
    };

    await cloud.upload({
      key:           R2Keys.stages.result(jobId, stageId),
      data:          Buffer.from(JSON.stringify(snapshot, null, 2), "utf8"),
      contentType:   "application/json",
      checkDuplicate: false,
    });

    // ── 2. Append to pipeline log ─────────────────────────────────────────
    appendLog(
      jobId,
      `[${new Date().toISOString()}] [${stageId.toUpperCase().padEnd(16)}] ` +
      `status=${stage.status.padEnd(8)} duration=${stage.durationMs ?? "?"}ms` +
      (stage.error ? ` error="${stage.error}"` : "")
    );
    await flushPipelineLog(jobId, cloud).catch(() => {});

    // ── 3. Update job storage manifest ───────────────────────────────────
    const manifest: JobStorageManifest = getCachedManifest(jobId) ?? makeEmptyManifest({
      jobId,
      scrapeJobId: scrapeId,
      seedUrl,
    });

    const artifactKeys  = STAGE_ARTIFACTS[stageId]?.(jobId) ?? [];
    const isComplete    = stage.status === "complete";
    const artifactStatus: ArtifactStatus = isComplete ? "present" : "missing";

    const stageRecord: StageRecord = {
      stageId,
      label:       stage.label,
      status:      stage.status,
      startedAt:   stage.startedAt,
      completedAt: stage.completedAt,
      durationMs:  stage.durationMs,
      artifacts:   artifactKeys.map((key) => ({
        key,
        url:         cloud.getPublicUrl(key),
        status:      artifactStatus,
        generatedAt: stage.completedAt ?? new Date().toISOString(),
      })),
      metadata: stage.metadata ?? {},
    };
    updateManifestStage(manifest, stageRecord);

    // Flip the artifact presence flags
    if (isComplete) {
      if (stageId === "manifest")       manifest.artifacts.manifest      = "present";
      if (stageId === "diff")           manifest.artifacts.differential  = "present";
      if (stageId === "design-dna")     manifest.artifacts.brandDna      = "present";
      if (stageId === "visual-dna")     manifest.artifacts.visualDna     = "present";
      if (stageId === "website-prime")  {
        manifest.artifacts.websitePrime = "present";
        manifest.artifacts.siteZip      = "present";
      }
      if (stageId === "certification")  manifest.artifacts.certification = "present";
    }

    // Update high-level pipeline status
    const completedOrSkipped = job.completedStages.length + job.skippedStages.length;
    const totalStages = 12;
    manifest.pipelineStatus =
      job.failedStages.length > 0 ? "failed" :
      completedOrSkipped >= totalStages ? "complete" :
      "running";
    manifest.pipelineComplete = job.status === "complete";

    await saveManifest(manifest, cloud);

    logger.debug({ jobId, stageId, status: stage.status }, "D3.4: stage persisted to R2");
  } catch (err) {
    // Never propagate — a persister failure must not fail the pipeline stage
    logger.warn({ err, jobId, stageId }, "D3.4: stage persistence error (non-fatal)");
  }
}

// ---------------------------------------------------------------------------
// Called when a job reaches terminal state (complete or failed)
// ---------------------------------------------------------------------------

export async function persistJobSummary(
  job:   OrchestrationJob,
  cloud: CloudProvider
): Promise<void> {
  if (!cloud.isConfigured()) return;

  const jobId = job.id;

  try {
    const summary = {
      schemaVersion:    "1.0.0",
      jobId,
      scrapeJobId:      job.underlyingJobId,
      seedUrl:          job.url,
      status:           job.status,
      startedAt:        job.startedAt,
      completedAt:      job.completedAt,
      totalDurationMs:  job.totalDurationMs,
      completedStages:  job.completedStages,
      failedStages:     job.failedStages,
      skippedStages:    job.skippedStages,
      error:            job.error,
      generatedAt:      new Date().toISOString(),
    };

    await cloud.upload({
      key:           R2Keys.reports.executionSummary(jobId),
      data:          Buffer.from(JSON.stringify(summary, null, 2), "utf8"),
      contentType:   "application/json",
      checkDuplicate: false,
    });

    // Finalise the manifest
    const manifest = getCachedManifest(jobId);
    if (manifest) {
      manifest.pipelineComplete = job.status === "complete";
      manifest.pipelineStatus   = job.status === "complete" ? "complete" : "failed";
      await saveManifest(manifest, cloud);
    }

    // Flush the final log
    appendLog(
      jobId,
      `[${new Date().toISOString()}] [PIPELINE         ] ` +
      `status=${job.status} totalDuration=${job.totalDurationMs ?? "?"}ms`
    );
    await flushPipelineLog(jobId, cloud).catch(() => {});

    logger.info({ jobId, status: job.status }, "D3.4: job summary persisted to R2");
  } catch (err) {
    logger.warn({ err, jobId }, "D3.4: job summary persistence failed (non-fatal)");
  }
}
