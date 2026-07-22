/**
 * phase6-runner.ts — Phase 6 post-crawl enrichment pipeline
 *
 * Runs automatically after every successful crawl (after persistence_commit).
 * Executes four enrichment stages in sequence:
 *
 *   1. visual_capture   — screenshots (desktop + mobile per page)
 *   2. component_map    — visual-DNA extraction (layout, color, typography, components)
 *   3. stencil_map      — stencil type assignment per node
 *   4. consistency_check — multi-page design normalization
 *
 * All stages are non-fatal: a failure in any stage is recorded and the
 * pipeline continues. The overall crawl job is never blocked.
 *
 * Status is persisted as `jobs/{jobId}/_phase6-status.json` in R2 so it
 * can be fetched at any time via GET /api/jobs/:jobId/phase6-status.
 */

import { logger } from "./logger";
import type { Manifest } from "./manifest";

// ── Stage types ───────────────────────────────────────────────────────────────

export type Phase6StageName =
  | "visual_capture"
  | "component_map"
  | "stencil_map"
  | "consistency_check";

export type Phase6StageStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface Phase6StageRecord {
  stage: Phase6StageName;
  status: Phase6StageStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
  /** Primary R2 artifact produced by this stage (null if skipped/failed) */
  outputKey: string | null;
}

export interface Phase6Status {
  schemaVersion: "6.0";
  jobId: string;
  startedAt: string;
  completedAt: string | null;
  totalDurationMs: number | null;
  overallStatus: "running" | "completed" | "partial" | "failed";
  stages: Phase6StageRecord[];
}

// ── R2 helpers ────────────────────────────────────────────────────────────────

function r2Configured(): boolean {
  return !!(
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_ENDPOINT &&
    process.env.R2_BUCKET_NAME
  );
}

async function r2Client() {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({
    region:      "auto",
    endpoint:    process.env.R2_ENDPOINT ?? "",
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID     ?? "",
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    },
  });
}

async function uploadPhase6Status(status: Phase6Status): Promise<void> {
  if (!r2Configured()) return;
  try {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await r2Client();
    await client.send(new PutObjectCommand({
      Bucket:      process.env.R2_BUCKET_NAME!,
      Key:         `jobs/${status.jobId}/_phase6-status.json`,
      Body:        Buffer.from(JSON.stringify(status, null, 2), "utf8"),
      ContentType: "application/json",
    }));
  } catch (err) {
    logger.warn({ err, jobId: status.jobId }, "PHASE6: failed to persist status to R2");
  }
}

export async function fetchPhase6Status(jobId: string): Promise<Phase6Status | null> {
  if (!r2Configured()) return null;
  try {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await r2Client();
    const resp = await client.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key:    `jobs/${jobId}/_phase6-status.json`,
    }));
    const chunks: Buffer[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const chunk of (resp.Body as any)) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Phase6Status;
  } catch {
    return null;
  }
}

// ── Stage helpers ─────────────────────────────────────────────────────────────

function makeStatus(jobId: string): Phase6Status {
  const stages: Phase6StageName[] = ["visual_capture", "component_map", "stencil_map", "consistency_check"];
  return {
    schemaVersion:   "6.0",
    jobId,
    startedAt:       new Date().toISOString(),
    completedAt:     null,
    totalDurationMs: null,
    overallStatus:   "running",
    stages:          stages.map(stage => ({
      stage,
      status:      "pending",
      startedAt:   null,
      completedAt: null,
      durationMs:  null,
      error:       null,
      outputKey:   null,
    })),
  };
}

function getStage(status: Phase6Status, name: Phase6StageName): Phase6StageRecord {
  return status.stages.find(s => s.stage === name)!;
}

function beginStage(status: Phase6Status, name: Phase6StageName): number {
  const stage = getStage(status, name);
  stage.status    = "running";
  stage.startedAt = new Date().toISOString();
  return Date.now();
}

function completeStage(
  status:   Phase6Status,
  name:     Phase6StageName,
  startMs:  number,
  outputKey: string | null = null
): void {
  const stage       = getStage(status, name);
  stage.status      = "completed";
  stage.completedAt = new Date().toISOString();
  stage.durationMs  = Date.now() - startMs;
  stage.outputKey   = outputKey;
}

function failStage(
  status:  Phase6Status,
  name:    Phase6StageName,
  startMs: number,
  err:     unknown
): void {
  const stage       = getStage(status, name);
  stage.status      = "failed";
  stage.completedAt = new Date().toISOString();
  stage.durationMs  = Date.now() - startMs;
  stage.error       = err instanceof Error ? err.message : String(err);
}

function skipStage(status: Phase6Status, name: Phase6StageName, reason: string): void {
  const stage       = getStage(status, name);
  stage.status      = "skipped";
  stage.startedAt   = new Date().toISOString();
  stage.completedAt = new Date().toISOString();
  stage.durationMs  = 0;
  stage.error       = reason;
}

function sealStatus(status: Phase6Status, pipelineStartMs: number): void {
  status.completedAt     = new Date().toISOString();
  status.totalDurationMs = Date.now() - pipelineStartMs;

  const statuses = status.stages.map(s => s.status);
  const allDone  = statuses.every(s => s === "completed" || s === "skipped");
  const anyFail  = statuses.some(s => s === "failed");
  const allFail  = statuses.every(s => s === "failed" || s === "skipped");

  status.overallStatus =
    allDone && !anyFail ? "completed" :
    allFail             ? "failed"    :
    anyFail             ? "partial"   : "completed";
}

// ── Stage runners ─────────────────────────────────────────────────────────────

/**
 * Load the manifest for a job from R2.
 * Centralised here so all stages share the same loading logic.
 */
async function loadManifest(jobId: string): Promise<Manifest> {
  const { loadManifestFromR2 } = await import("./visual-stencil-mapper");
  const manifest = await loadManifestFromR2(jobId);
  if (!manifest) {
    throw new Error(`PHASE6: manifest not found in R2 for jobId="${jobId}"`);
  }
  return manifest;
}

/**
 * Stage 1: Visual Capture — screenshots per node.
 * Skips gracefully when puppeteer is unavailable (not installed in live server).
 */
async function runVisualCaptureStage(jobId: string): Promise<string | null> {
  // Attempt dynamic import — the capture engine requires puppeteer which may
  // only be present in the repo's api-server, not the live server.
  const mod = await import("./visual-capture-engine").catch(() => null);
  if (!mod) {
    throw new Error("visual-capture-engine not available in this build");
  }
  const manifest = await loadManifest(jobId);
  // runVisualCapture requires (jobId, manifest, options)
  const result = await (mod as { runVisualCapture: (jobId: string, manifest: Manifest, opts?: object) => Promise<unknown> })
    .runVisualCapture(jobId, manifest);
  return typeof (result as Record<string, unknown>)?.reportKey === "string"
    ? (result as Record<string, unknown>).reportKey as string
    : null;
}

/**
 * Stage 2: Component Map (Visual DNA) — per-page layout/color/component analysis.
 */
async function runComponentMapStage(jobId: string): Promise<string | null> {
  const mod = await import("./visual-dna-engine").catch(() => null);
  if (!mod) throw new Error("visual-dna-engine not available");
  const manifest = await loadManifest(jobId);
  // runVisualDna requires (jobId, manifest)
  await (mod as { runVisualDna: (jobId: string, manifest: Manifest) => Promise<unknown> })
    .runVisualDna(jobId, manifest);
  return `jobs/${jobId}/_visual-dna.json`;
}

/**
 * Stage 3: Stencil Map — stencil type assignment per node.
 */
async function runStencilMapStage(jobId: string): Promise<string | null> {
  const { runVisualStencilMapper } = await import("./visual-stencil-mapper");
  const result = await runVisualStencilMapper({ jobId });
  return result.r2Key ?? null;
}

/**
 * Stage 4: Consistency Check — multi-page design normalization.
 * Depends on stencil_map output — skips if stencil_map failed.
 */
async function runConsistencyStage(jobId: string): Promise<string | null> {
  const { runAndStoreConsistencyEngine } = await import("./multi-page-consistency-engine");
  const result = await runAndStoreConsistencyEngine(jobId);
  return result.reportR2Key ?? null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * runPhase6Pipeline — Phase 6 public entry point.
 *
 * Called by job-worker after persistence_commit.
 * Never throws — all errors are captured in the status object.
 */
export async function runPhase6Pipeline(jobId: string): Promise<Phase6Status> {
  const pipelineStartMs = Date.now();
  const status = makeStatus(jobId);

  logger.info({ jobId }, "PHASE6: pipeline started");

  // Persist initial status immediately so the endpoint shows "running"
  await uploadPhase6Status(status);

  // ── Stage 1: visual_capture ────────────────────────────────────────────────
  let startMs = beginStage(status, "visual_capture");
  await uploadPhase6Status(status);
  try {
    const key = await runVisualCaptureStage(jobId);
    completeStage(status, "visual_capture", startMs, key);
    logger.info({ jobId, key }, "PHASE6: visual_capture complete");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Puppeteer not available is expected in the lite server — treat as skip
    if (msg.includes("not available")) {
      skipStage(status, "visual_capture", msg);
      logger.info({ jobId, reason: msg }, "PHASE6: visual_capture skipped");
    } else {
      failStage(status, "visual_capture", startMs, err);
      logger.warn({ err, jobId }, "PHASE6: visual_capture failed (non-fatal)");
    }
  }
  await uploadPhase6Status(status);

  // ── Stage 2: component_map ─────────────────────────────────────────────────
  startMs = beginStage(status, "component_map");
  await uploadPhase6Status(status);
  try {
    const key = await runComponentMapStage(jobId);
    completeStage(status, "component_map", startMs, key);
    logger.info({ jobId, key }, "PHASE6: component_map complete");
  } catch (err) {
    failStage(status, "component_map", startMs, err);
    logger.warn({ err, jobId }, "PHASE6: component_map failed (non-fatal)");
  }
  await uploadPhase6Status(status);

  // ── Stage 3: stencil_map ───────────────────────────────────────────────────
  startMs = beginStage(status, "stencil_map");
  await uploadPhase6Status(status);
  try {
    const key = await runStencilMapStage(jobId);
    completeStage(status, "stencil_map", startMs, key);
    logger.info({ jobId, key }, "PHASE6: stencil_map complete");
  } catch (err) {
    failStage(status, "stencil_map", startMs, err);
    logger.warn({ err, jobId }, "PHASE6: stencil_map failed (non-fatal)");
  }
  await uploadPhase6Status(status);

  // ── Stage 4: consistency_check ─────────────────────────────────────────────
  // Only runs if stencil_map completed — needs the stencil map as input
  const stencilStage = getStage(status, "stencil_map");
  if (stencilStage.status !== "completed") {
    skipStage(status, "consistency_check", "stencil_map did not complete — skipping consistency check");
    logger.info({ jobId }, "PHASE6: consistency_check skipped — stencil_map not ready");
  } else {
    startMs = beginStage(status, "consistency_check");
    await uploadPhase6Status(status);
    try {
      const key = await runConsistencyStage(jobId);
      completeStage(status, "consistency_check", startMs, key);
      logger.info({ jobId, key }, "PHASE6: consistency_check complete");
    } catch (err) {
      failStage(status, "consistency_check", startMs, err);
      logger.warn({ err, jobId }, "PHASE6: consistency_check failed (non-fatal)");
    }
  }

  // ── Seal and persist ───────────────────────────────────────────────────────
  sealStatus(status, pipelineStartMs);
  await uploadPhase6Status(status);

  logger.info(
    {
      jobId,
      overallStatus:   status.overallStatus,
      totalDurationMs: status.totalDurationMs,
      stages:          status.stages.map(s => ({ stage: s.stage, status: s.status, durationMs: s.durationMs })),
    },
    "PHASE6: pipeline complete"
  );

  return status;
}
