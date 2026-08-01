/**
 * r2-executor.ts — Cloud upload orchestration (provider-agnostic)
 *
 * Orchestrates cloud upload stages for the scrape pipeline. All actual
 * storage operations route through the CloudProvider interface — no direct
 * AWS / R2 SDK calls live here. Swap the provider at the call site to target
 * any backend (R2, S3, local, mock) without touching this file.
 *
 * Storage layout (cloud paths):
 *   jobs/{jobId}/content/{pageKey}/{slug}/index.html
 *   jobs/{jobId}/images/{nodeId}/img_N.jpg
 *   jobs/{jobId}/embeds/{nodeId}/embed_N.json
 *   jobs/{jobId}/audio/{nodeId}/audio_N.json
 *   jobs/{jobId}/videos/{nodeId}/video_N.embed
 *   jobs/{jobId}/index.html
 *   jobs/{jobId}/_manifest.json
 *   jobs/{jobId}/_manifest.zip
 *
 * Pipeline stages:
 *   Stage 7  — uploadPreZip        (pre-ZIP: article HTML + media from memory)
 *   Stage 8  — verifyR2Uploads     (HEAD checks on critical keys)
 *   Stage 10 — uploadZipToR2       (finalized ZIP)
 *
 * IMPORTANT: This module only reads manifest-stamped cloudPaths.
 * It never re-derives or mutates localPath ↔ cloudPath relationships.
 */

import AdmZip from "adm-zip";
import { logger } from "./logger";
import type { Manifest } from "./manifest";
import type { MediaBufferStore } from "./media-pipeline";
import type { ArticleLink } from "./scraper";
import { buildArticleHtml, renderIndexHtml } from "./renderer";
import { renderManifestJson } from "./manifest-export";
import type { CloudProvider } from "../cloud/provider";
import { CloudUploadError } from "../cloud/provider";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Upload state discriminant — kept for backward-compatible report fields. */
export type UploadState = "pending" | "uploading" | "uploaded" | "skipped" | "failed" | "retried";

export interface R2UploadFailure {
  cloudPath: string;
  localPath: string;
  error: string;
  attempts: number;
  permanent: boolean;
}

export interface R2UploadReport {
  enabled: boolean;
  /** Provider name (e.g. "r2") or bucket identifier for logging. */
  bucket: string;
  /** Provider endpoint string for logging. */
  endpoint: string;
  totalFiles: number;
  uploadedFiles: number;
  uploadedBytes: number;
  failedUploads: R2UploadFailure[];
  skippedFiles: number;
  duplicatesPrevented: number;
  publicUrls: string[];
  uploadDurationMs: number;
  startedAt: string;
  completedAt: string;
  valid: boolean;
}

export interface R2VerificationReport {
  jobId: string;
  checkedAt: string;
  /** Total keys checked via HEAD / verify() */
  checked: number;
  /** Keys that exist in the provider */
  verified: number;
  /** Keys that are missing or could not be verified */
  missing: number;
  /** true when all checked keys exist */
  valid: boolean;
  missingKeys: string[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Internal helpers — shared across orchestration functions
// ---------------------------------------------------------------------------

/**
 * Derives the page key from a manifest-stamped localPath.
 * e.g. "content/articles/slug/index.html" → "articles"
 */
function derivePageKey(localPath: string): string {
  const parts = localPath.split("/");
  return parts.length >= 2 && parts[0] === "content" ? parts[1] : "articles";
}

/**
 * Computes the relative root prefix from localPath depth.
 * e.g. "content/articles/slug/index.html" (4 parts) → "../../../"
 */
function deriveRelRoot(localPath: string): string {
  const depth = localPath.split("/").length - 1;
  return "../".repeat(depth);
}

/**
 * Builds an empty (disabled) R2UploadReport for when the provider is not
 * configured. Attached to manifest.output.r2Upload so downstream code
 * always finds a report object.
 */
function emptyReport(startedAt: string): R2UploadReport {
  return {
    enabled: false,
    bucket: "",
    endpoint: "",
    totalFiles: 0,
    uploadedFiles: 0,
    uploadedBytes: 0,
    failedUploads: [],
    skippedFiles: 0,
    duplicatesPrevented: 0,
    publicUrls: [],
    uploadDurationMs: 0,
    startedAt,
    completedAt: new Date().toISOString(),
    valid: true,
  };
}

// ---------------------------------------------------------------------------
// executeCloudUpload — upload all manifest files from the ZIP
// ---------------------------------------------------------------------------

/**
 * Uploads all manifest-derived files from the completed ZIP archive to cloud
 * storage using the provided CloudProvider.
 *
 * @param provider  CloudProvider instance (e.g. R2Provider).
 * @param zipPath   Absolute path to the completed ZIP archive on disk.
 * @param manifest  Sealed manifest after ZIP finalization.
 * @param jobId     Job ID prefix for all cloud keys (jobs/{jobId}/...).
 *
 * Returns an R2UploadReport (also attached to manifest.output.r2Upload).
 * Upload failures are recorded but never rethrown — the function always returns.
 */
export async function executeCloudUpload(
  provider: CloudProvider,
  zipPath: string,
  manifest: Manifest,
  jobId: string
): Promise<R2UploadReport> {
  const startedAt = new Date().toISOString();
  const startMs   = Date.now();

  if (!provider.isConfigured()) {
    logger.info({ jobId, provider: provider.providerName }, "CLOUD: provider not configured — skipping upload");
    const report = emptyReport(startedAt);
    if (manifest.output) manifest.output.r2Upload = report;
    return report;
  }

  logger.info({ jobId, provider: provider.providerName, zipPath }, "CLOUD: starting upload execution");

  // ── Load ZIP archive ───────────────────────────────────────────────────────
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipPath);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ jobId, zipPath, error: errMsg }, "CLOUD: failed to open ZIP archive");
    const failReport: R2UploadReport = {
      enabled: true,
      bucket: provider.providerName,
      endpoint: "",
      totalFiles: 0,
      uploadedFiles: 0,
      uploadedBytes: 0,
      failedUploads: [{ cloudPath: "_zip", localPath: zipPath, error: errMsg, attempts: 1, permanent: true }],
      skippedFiles: 0,
      duplicatesPrevented: 0,
      publicUrls: [],
      uploadDurationMs: Date.now() - startMs,
      startedAt,
      completedAt: new Date().toISOString(),
      valid: false,
    };
    if (manifest.output) manifest.output.r2Upload = failReport;
    return failReport;
  }

  // Map of ZIP entry name → Buffer
  const zipEntries = new Map<string, Buffer>();
  for (const entry of zip.getEntries()) {
    if (!entry.isDirectory) zipEntries.set(entry.entryName, entry.getData());
  }

  logger.info({ jobId, zipEntryCount: zipEntries.size }, "CLOUD: ZIP loaded — beginning per-file upload");

  // ── Build upload task list ─────────────────────────────────────────────────
  interface UploadTask { localPath: string; cloudPath: string; description: string; }

  const tasks: UploadTask[] = [];
  const seenCloudPaths = new Set<string>();

  function addTask(localPath: string, cloudPath: string, description: string): void {
    if (!localPath || !cloudPath) return;
    if (seenCloudPaths.has(cloudPath)) return;
    if (!zipEntries.has(localPath)) return;
    seenCloudPaths.add(cloudPath);
    tasks.push({ localPath, cloudPath, description });
  }

  for (const node of manifest.nodes.values()) {
    addTask(node.storage.localPath, node.storage.cloudPath, `node:${node.nodeType}`);
    for (const img of node.media.images) {
      if (img.status === "rendered" || img.status === "downloaded")
        addTask(img.storage.localPath, img.storage.cloudPath, "image");
    }
    for (const vid of node.media.videos) {
      if (vid.status === "rendered" || vid.status === "downloaded")
        addTask(vid.storage.localPath, vid.storage.cloudPath, `media:${vid.mediaClassification}`);
      if (vid.status === "skipped" && (vid.mediaClassification === "embed" || vid.mediaClassification === "audio"))
        addTask(vid.storage.localPath, vid.storage.cloudPath, `embed-json:${vid.provider ?? "unknown"}`);
    }
  }

  if (zipEntries.has("index.html")) {
    const indexCloudPath = `jobs/${jobId}/index.html`;
    if (!seenCloudPaths.has(indexCloudPath)) {
      seenCloudPaths.add(indexCloudPath);
      tasks.push({ localPath: "index.html", cloudPath: indexCloudPath, description: "root-index" });
    }
  }

  const zipCloudPath = `jobs/${jobId}/_manifest.zip`;
  tasks.push({ localPath: "_ZIPFILE_", cloudPath: zipCloudPath, description: "zip-archive" });

  logger.info({ jobId, taskCount: tasks.length, provider: provider.providerName }, "CLOUD: upload task list built");

  // ── Execute uploads ────────────────────────────────────────────────────────
  let uploadedFiles = 0;
  let uploadedBytes = 0;
  let skippedFiles  = 0;
  let duplicatesPrevented = 0;
  const failedUploads: R2UploadFailure[] = [];
  const publicUrls: string[] = [];

  for (const task of tasks) {
    let buffer: Buffer;

    if (task.localPath === "_ZIPFILE_") {
      try {
        const { readFile } = await import("fs/promises");
        buffer = await readFile(zipPath);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        failedUploads.push({ cloudPath: task.cloudPath, localPath: zipPath, error: `Failed to read ZIP: ${errMsg}`, attempts: 1, permanent: true });
        continue;
      }
    } else {
      const zipBuffer = zipEntries.get(task.localPath);
      if (!zipBuffer) continue;
      buffer = zipBuffer;
    }

    try {
      const result = await provider.upload({ key: task.cloudPath, data: buffer, checkDuplicate: true });
      publicUrls.push(result.url);
      if (result.skippedAsDuplicate) {
        skippedFiles++;
        duplicatesPrevented++;
      } else {
        uploadedFiles++;
        uploadedBytes += result.bytesUploaded;
      }
    } catch (err) {
      const isCloudErr = err instanceof CloudUploadError;
      failedUploads.push({
        cloudPath: task.cloudPath,
        localPath: task.localPath,
        error: err instanceof Error ? err.message : String(err),
        attempts: isCloudErr ? err.attempts : 1,
        permanent: isCloudErr ? err.permanent : true,
      });
    }
  }

  const completedAt      = new Date().toISOString();
  const uploadDurationMs = Date.now() - startMs;
  const valid            = failedUploads.length === 0;

  const report: R2UploadReport = {
    enabled: true,
    bucket:  provider.providerName,
    endpoint: "",
    totalFiles: tasks.length,
    uploadedFiles,
    uploadedBytes,
    failedUploads,
    skippedFiles,
    duplicatesPrevented,
    publicUrls,
    uploadDurationMs,
    startedAt,
    completedAt,
    valid,
  };

  if (manifest.output) manifest.output.r2Upload = report;

  (valid ? logger.info : logger.warn).call(logger, {
    jobId,
    provider: provider.providerName,
    totalFiles: tasks.length,
    uploadedFiles,
    uploadedBytes,
    skippedFiles,
    duplicatesPrevented,
    failedCount: failedUploads.length,
    uploadDurationMs,
    valid,
  }, valid
    ? "CLOUD: upload execution complete — all files uploaded successfully"
    : "CLOUD: upload execution complete — some files failed (see report)");

  return report;
}

/** @deprecated Use executeCloudUpload instead. Kept for backward compatibility. */
export const executeR2Upload = executeCloudUpload;

// ---------------------------------------------------------------------------
// uploadPreZip — Stage 7: upload manifest content BEFORE ZIP finalization
// ---------------------------------------------------------------------------

/**
 * Uploads all manifest-derived content to cloud storage before the ZIP is sealed.
 *
 * This is Stage 7 of the pipeline. Called from job-worker's onPreFinalize
 * callback while media buffers are still live in memory.
 *
 * Content sourced from:
 *   - Article HTML: reconstructed from node.content.cleanHtml via buildArticleHtml
 *   - Images:       raw buffers from mediaBufferStore (by mediaItem.id)
 *   - Embed/audio JSON: reconstructed from MediaItem fields
 *   - Root index.html: rendered from manifest via renderIndexHtml
 *   - Manifest JSON:   serialized via renderManifestJson
 *
 * The ZIP itself is NOT uploaded here — that happens in uploadZipToR2 (Stage 10).
 */
export async function uploadPreZip(
  provider: CloudProvider,
  manifest: Manifest,
  mediaBufferStore: MediaBufferStore,
  jobId: string
): Promise<R2UploadReport> {
  const startedAt = new Date().toISOString();
  const startMs   = Date.now();

  if (!provider.isConfigured()) {
    logger.info({ jobId, provider: provider.providerName }, "CLOUD: uploadPreZip — provider not configured, skipping");
    const report = emptyReport(startedAt);
    if (manifest.output) manifest.output.r2Upload = report;
    return report;
  }

  logger.info({ jobId, provider: provider.providerName }, "CLOUD: pre-ZIP upload starting");

  let uploadedFiles = 0;
  let uploadedBytes = 0;
  let skippedFiles  = 0;
  let duplicatesPrevented = 0;
  const failedUploads: R2UploadFailure[] = [];
  const publicUrls: string[]             = [];
  const seenCloudPaths = new Set<string>();

  async function uploadAsset(cloudPath: string, buffer: Buffer): Promise<void> {
    if (!cloudPath || seenCloudPaths.has(cloudPath)) return;
    seenCloudPaths.add(cloudPath);

    try {
      const result = await provider.upload({ key: cloudPath, data: buffer, checkDuplicate: true });
      publicUrls.push(result.url);
      if (result.skippedAsDuplicate) {
        skippedFiles++;
        duplicatesPrevented++;
      } else {
        uploadedFiles++;
        uploadedBytes += result.bytesUploaded;
      }
    } catch (err) {
      const isCloudErr = err instanceof CloudUploadError;
      failedUploads.push({
        cloudPath,
        localPath: "(memory-buffer)",
        error: err instanceof Error ? err.message : String(err),
        attempts: isCloudErr ? err.attempts : 1,
        permanent: isCloudErr ? err.permanent : true,
      });
    }
  }

  // ── 1. Per-node: article HTML + media ────────────────────────────────────
  let nodesProcessed = 0;
  const articleCount = Array.from(manifest.nodes.values()).filter(
    (n) => n.nodeType !== "root"
  ).length;

  for (const node of manifest.nodes.values()) {
    if (node.nodeType === "root") continue;

    const localPath = node.storage.localPath;
    const cloudPath = node.storage.cloudPath;
    if (!localPath || !cloudPath) continue;

    const pageKey = derivePageKey(localPath);
    const relRoot  = deriveRelRoot(localPath);

    const article: ArticleLink = {
      url:         node.metadata.url,
      title:       node.metadata.title,
      publishedAt: node.metadata.publishedAt,
      pageLabel:   null,
      description: null,
    };
    const html = buildArticleHtml(node.metadata.title, node.content.cleanHtml, article, pageKey, relRoot);
    await uploadAsset(cloudPath, Buffer.from(html, "utf8"));

    for (const img of node.media.images) {
      if (!img.storage.cloudPath) continue;
      const fetchResult = mediaBufferStore.get(img.id);
      if (fetchResult) await uploadAsset(img.storage.cloudPath, fetchResult.buffer);
    }

    for (const vid of node.media.videos) {
      if (!vid.storage.cloudPath || (vid.mediaClassification !== "embed" && vid.mediaClassification !== "audio")) continue;
      const embedJson = JSON.stringify({
        schemaVersion: "1.0",
        provider: vid.provider ?? "unknown",
        mediaType: vid.mediaClassification,
        embedUrl: vid.sourceUrl,
        canonicalUrl: vid.canonicalUrl ?? null,
        thumbnailUrl: vid.thumbnailUrl ?? null,
        title: vid.altText ?? null,
        durationSeconds: vid.durationSeconds ?? null,
        width:  vid.dimensions?.width  ?? null,
        height: vid.dimensions?.height ?? null,
        sourceNodePath: node.storage.localPath,
        extractedAt: new Date().toISOString(),
      }, null, 2);
      await uploadAsset(vid.storage.cloudPath, Buffer.from(embedJson, "utf8"));
    }

    nodesProcessed++;
  }

  // ── 2. Root index.html ────────────────────────────────────────────────────
  try {
    const renderResult = renderIndexHtml(manifest, articleCount, []);
    await uploadAsset(`jobs/${jobId}/index.html`, Buffer.from(renderResult.html, "utf8"));
  } catch (renderErr) {
    logger.warn({ jobId, renderErr }, "CLOUD: pre-ZIP index.html render failed (non-fatal)");
  }

  // ── 3. Manifest JSON ──────────────────────────────────────────────────────
  try {
    const manifestJson = renderManifestJson(manifest);
    await uploadAsset(`jobs/${jobId}/_manifest.json`, Buffer.from(manifestJson, "utf8"));
  } catch (manifestErr) {
    logger.warn({ jobId, manifestErr }, "CLOUD: pre-ZIP manifest JSON render failed (non-fatal)");
    // renderManifestJson threw before uploadAsset could add this to failedUploads —
    // add it manually so valid=false is set and the caller knows the manifest is missing.
    failedUploads.push({
      cloudPath: `jobs/${jobId}/_manifest.json`,
      localPath: "(rendered)",
      error: manifestErr instanceof Error ? manifestErr.message : String(manifestErr),
      attempts: 1,
      permanent: true,
    });
  }

  const completedAt      = new Date().toISOString();
  const uploadDurationMs = Date.now() - startMs;
  const valid            = failedUploads.length === 0;

  const report: R2UploadReport = {
    enabled: true,
    bucket:  provider.providerName,
    endpoint: "",
    totalFiles: seenCloudPaths.size,
    uploadedFiles,
    uploadedBytes,
    failedUploads,
    skippedFiles,
    duplicatesPrevented,
    publicUrls,
    uploadDurationMs,
    startedAt,
    completedAt,
    valid,
  };

  if (manifest.output) manifest.output.r2Upload = report;

  (valid ? logger.info : logger.warn).call(logger, {
    jobId,
    provider: provider.providerName,
    nodesProcessed,
    uploadedFiles,
    uploadedBytes,
    skippedFiles,
    duplicatesPrevented,
    failedCount: failedUploads.length,
    uploadDurationMs,
    valid,
  }, valid
    ? "CLOUD: pre-ZIP upload complete — all files uploaded successfully"
    : "CLOUD: pre-ZIP upload complete — some files failed (see report)");

  return report;
}

// ---------------------------------------------------------------------------
// verifyR2Uploads — Stage 8: verify critical keys exist in cloud storage
// ---------------------------------------------------------------------------

/**
 * Verifies that critical keys exist using CloudProvider.verify() (HEAD checks).
 *
 * This is Stage 8 of the pipeline. Enforces constraint 10:
 * "ZIP generation never executes before cloud verification completes."
 *
 * Samples: manifest JSON, root index.html, up to 5 article HTML nodes.
 * Partial failures are non-fatal — the pipeline continues regardless.
 */
export async function verifyR2Uploads(
  provider: CloudProvider,
  manifest: Manifest,
  jobId: string
): Promise<R2VerificationReport> {
  const checkedAt = new Date().toISOString();
  const startMs   = Date.now();

  if (!provider.isConfigured()) {
    return { jobId, checkedAt, checked: 0, verified: 0, missing: 0, valid: true, missingKeys: [], durationMs: 0 };
  }

  const keysToCheck: string[] = [
    `jobs/${jobId}/_manifest.json`,
    `jobs/${jobId}/index.html`,
  ];

  let sampleCount = 0;
  for (const node of manifest.nodes.values()) {
    if (node.nodeType !== "root" && node.storage.cloudPath) {
      keysToCheck.push(node.storage.cloudPath);
      if (++sampleCount >= 5) break;
    }
  }

  logger.debug(
    { jobId, provider: provider.providerName, checkCount: keysToCheck.length },
    "CLOUD: verification starting"
  );

  let verified = 0;
  const missingKeys: string[] = [];

  for (const key of keysToCheck) {
    const exists = await provider.verify(key);
    if (exists) {
      verified++;
    } else {
      missingKeys.push(key);
    }
  }

  const durationMs = Date.now() - startMs;
  const valid      = missingKeys.length === 0;

  logger.info(
    {
      jobId,
      provider: provider.providerName,
      checked: keysToCheck.length,
      verified,
      missing: missingKeys.length,
      valid,
      durationMs,
    },
    valid
      ? "CLOUD: verification passed — all checked keys exist"
      : "CLOUD: verification — some keys missing (non-fatal)"
  );

  return {
    jobId,
    checkedAt,
    checked: keysToCheck.length,
    verified,
    missing: missingKeys.length,
    valid,
    missingKeys,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// uploadZipToR2 — Stage 10: upload the sealed ZIP after finalization
// ---------------------------------------------------------------------------

/**
 * Uploads the finalized ZIP archive to cloud storage as Stage 10
 * (persistence_commit). Called AFTER zip_generation (Stage 9) completes.
 *
 * The ZIP cloud key is always: jobs/{jobId}/_manifest.zip
 * Uses duplicate prevention so re-runs are safe.
 *
 * Failures are logged and best-effort attached to manifest.output.r2Upload
 * but are never rethrown — ZIP availability via direct download is unaffected.
 */
export async function uploadZipToR2(
  provider: CloudProvider,
  zipPath: string,
  manifest: Manifest,
  jobId: string
): Promise<void> {
  if (!provider.isConfigured()) return;

  const cloudPath = `jobs/${jobId}/_manifest.zip`;

  try {
    const { readFile } = await import("fs/promises");
    const buffer = await readFile(zipPath);

    const result = await provider.upload({ key: cloudPath, data: buffer, checkDuplicate: true });

    logger.info(
      { jobId, provider: provider.providerName, cloudPath, skipped: result.skippedAsDuplicate, bytes: result.bytesUploaded, url: result.url },
      `CLOUD: ZIP upload — ${result.skippedAsDuplicate ? "skipped (duplicate)" : "uploaded"}`
    );

    if (manifest.output?.r2Upload) {
      if (!result.skippedAsDuplicate) {
        manifest.output.r2Upload.uploadedFiles++;
        manifest.output.r2Upload.uploadedBytes += result.bytesUploaded;
        manifest.output.r2Upload.publicUrls.push(result.url);
      } else {
        manifest.output.r2Upload.duplicatesPrevented++;
        manifest.output.r2Upload.skippedFiles++;
      }
    }
  } catch (err) {
    const isCloudErr = err instanceof CloudUploadError;
    logger.warn({ err, jobId, zipPath, cloudPath }, "CLOUD: ZIP upload failed (non-fatal — ZIP available via direct download)");

    if (manifest.output?.r2Upload) {
      manifest.output.r2Upload.valid = false;
      manifest.output.r2Upload.failedUploads.push({
        cloudPath,
        localPath: zipPath,
        error: err instanceof Error ? err.message : String(err),
        attempts: isCloudErr ? err.attempts : 1,
        permanent: isCloudErr ? err.permanent : true,
      });
    }
  }
}
