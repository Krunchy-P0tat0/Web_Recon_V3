/**
 * job-storage-manifest.ts — Per-job R2 storage manifest (Phase D3.4)
 *
 * Generates, loads, and updates the canonical manifest.json stored at
 *   job-set-{jobId}/manifest/manifest.json
 *
 * The manifest is the authoritative index of every artifact produced by a job:
 *   - Pipeline completion status per stage
 *   - All stored artifacts with R2 keys + public URLs
 *   - SHA-256 checksums
 *   - Schema versions and timestamps
 *
 * Design rules:
 *   - Always update the manifest after a stage writes artifacts — never batch.
 *   - Reads hit the in-memory cache first; R2 is the fallback source of truth.
 *   - Manifest upload is always non-duplicate (force-overwrite).
 */

import { createHash } from "crypto";
import { logger } from "./logger.js";
import type { CloudProvider } from "../cloud/provider.js";
import { R2Keys } from "../cloud/r2-key-registry.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MANIFEST_SCHEMA_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ArtifactStatus = "present" | "missing" | "unknown";
export type PipelineStatus = "pending" | "running" | "complete" | "failed";

export interface ArtifactEntry {
  key:         string;
  url:         string;
  status:      ArtifactStatus;
  sizeBytes?:  number;
  checksum?:   string;
  generatedAt: string;
}

export interface StageRecord {
  stageId:     string;
  label:       string;
  status:      "pending" | "running" | "complete" | "failed" | "skipped";
  startedAt:   string | null;
  completedAt: string | null;
  durationMs:  number | null;
  artifacts:   ArtifactEntry[];
  metadata:    Record<string, unknown>;
}

export interface JobStorageManifest {
  schemaVersion:    string;
  jobId:            string;
  scrapeJobId:      string | null;
  seedUrl:          string;
  generatedAt:      string;
  updatedAt:        string;
  pipelineComplete: boolean;
  pipelineStatus:   PipelineStatus;
  stages:           Record<string, StageRecord>;
  artifacts: {
    manifest:      ArtifactStatus;
    websitePrime:  ArtifactStatus;
    siteZip:       ArtifactStatus;
    certification: ArtifactStatus;
    differential:  ArtifactStatus;
    visualDna:     ArtifactStatus;
    brandDna:      ArtifactStatus;
    checkpoints:   number;
  };
  storageStats: {
    estimatedFileCount: number;
    estimatedBytes:     number;
  };
  checksums: Record<string, string>;
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

const manifestCache = new Map<string, JobStorageManifest>();

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function makeEmptyManifest(opts: {
  jobId:       string;
  scrapeJobId: string | null;
  seedUrl:     string;
}): JobStorageManifest {
  const now = new Date().toISOString();
  return {
    schemaVersion:    MANIFEST_SCHEMA_VERSION,
    jobId:            opts.jobId,
    scrapeJobId:      opts.scrapeJobId,
    seedUrl:          opts.seedUrl,
    generatedAt:      now,
    updatedAt:        now,
    pipelineComplete: false,
    pipelineStatus:   "pending",
    stages:           {},
    artifacts: {
      manifest:      "missing",
      websitePrime:  "missing",
      siteZip:       "missing",
      certification: "missing",
      differential:  "missing",
      visualDna:     "missing",
      brandDna:      "missing",
      checkpoints:   0,
    },
    storageStats: { estimatedFileCount: 0, estimatedBytes: 0 },
    checksums:    {},
  };
}

// ---------------------------------------------------------------------------
// Checksum helpers
// ---------------------------------------------------------------------------

function checksumJson(data: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(data))
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Persist to R2
// ---------------------------------------------------------------------------

export async function saveManifest(
  manifest: JobStorageManifest,
  cloud:    CloudProvider
): Promise<void> {
  manifest.updatedAt          = new Date().toISOString();
  manifest.checksums.manifest = checksumJson(manifest);
  manifestCache.set(manifest.jobId, manifest);

  if (!cloud.isConfigured()) return;

  const key  = R2Keys.manifest.index(manifest.jobId);
  const json = JSON.stringify(manifest, null, 2);

  try {
    await cloud.upload({
      key,
      data:         Buffer.from(json, "utf8"),
      contentType:  "application/json",
      checkDuplicate: false,                     // always force-overwrite
    });
    logger.debug({ jobId: manifest.jobId, key }, "D3.4: manifest saved to R2");
  } catch (err) {
    logger.warn({ err, jobId: manifest.jobId }, "D3.4: manifest upload failed (non-fatal)");
  }
}

// ---------------------------------------------------------------------------
// Load from R2
// ---------------------------------------------------------------------------

export async function loadManifestFromR2(
  jobId: string,
  cloud: CloudProvider
): Promise<JobStorageManifest | null> {
  const cached = manifestCache.get(jobId);
  if (cached) return cached;

  if (!cloud.isConfigured()) return null;

  try {
    const buf = await cloud.download(R2Keys.manifest.index(jobId));
    if (!buf) return null;
    const manifest = JSON.parse(buf.toString("utf8")) as JobStorageManifest;
    manifestCache.set(jobId, manifest);
    logger.debug({ jobId }, "D3.4: manifest loaded from R2");
    return manifest;
  } catch (err) {
    logger.warn({ err, jobId }, "D3.4: manifest load failed");
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-memory accessors
// ---------------------------------------------------------------------------

export function getCachedManifest(jobId: string): JobStorageManifest | null {
  return manifestCache.get(jobId) ?? null;
}

export function getAllCachedManifests(): JobStorageManifest[] {
  return Array.from(manifestCache.values());
}

export function updateManifestStage(
  manifest: JobStorageManifest,
  stage:    StageRecord
): void {
  manifest.stages[stage.stageId] = stage;
}
