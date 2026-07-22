/**
 * cloud-renderer.ts — Dry-run cloud execution validator
 *
 * renderCloud() performs a full structural validation of the manifest before
 * any real cloud upload phase. It never performs I/O, network calls, or SDK
 * operations of any kind.
 *
 * Validation pass covers:
 *   1. cloudPath uniqueness  — no two StorageMaps share the same cloud key
 *   2. Path consistency      — cloudPath === deriveCloudPath(jobId, localPath)
 *   3. Missing mappings      — every active node/media has both paths set
 *   4. Filename validity     — cloud-safe characters only
 *   5. Provider mapping      — getPublicUrl() returns a string without throwing
 *   6. Invariants            — no_renderer_generated_paths
 *                              no_duplicate_cloud_keys
 *                              no_missing_media_references
 *
 * The full report is attached to manifest.output.cloud and returned.
 *
 * Constraints:
 *   - NO fs, path, os imports
 *   - NO network or SDK calls
 *   - Pure structural validation — same manifest always produces same report
 */

import { logger } from "./logger";
import type {
  Manifest,
  NodeType,
  CloudExecutionReport,
  CloudDuplicateConflict,
  CloudMissingMapping,
  CloudInvalidFilename,
  CloudConsistencyError,
  CloudProviderMappingError,
  CloudInvariantViolation,
  CloudInvariantRule,
} from "./manifest";
import type { StorageProvider } from "./storage-provider";

// ---------------------------------------------------------------------------
// Internal state accumulated during a single renderCloud() call
// ---------------------------------------------------------------------------

interface ValidationState {
  /** All cloudPaths seen so far: cloudPath → list of sources */
  cloudKeyRegistry: Map<
    string,
    Array<{ nodeId: string; kind: "node" | "image" | "video"; mediaId?: string }>
  >;
  missingStorageMappings: CloudMissingMapping[];
  invalidFilenames: CloudInvalidFilename[];
  localCloudConsistencyErrors: CloudConsistencyError[];
  providerMappingErrors: CloudProviderMappingError[];
  invariantViolations: CloudInvariantViolation[];
  totalFiles: number;
  totalBytes: number;
  skippedMediaCount: number;
  failedMediaCount: number;
  /** jobId inferred from the first well-formed cloudPath found in the manifest. */
  inferredJobId: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(): ValidationState {
  return {
    cloudKeyRegistry: new Map(),
    missingStorageMappings: [],
    invalidFilenames: [],
    localCloudConsistencyErrors: [],
    providerMappingErrors: [],
    invariantViolations: [],
    totalFiles: 0,
    totalBytes: 0,
    skippedMediaCount: 0,
    failedMediaCount: 0,
    inferredJobId: null,
  };
}

function isEmpty(v: string | null | undefined): boolean {
  return !v || v.trim() === "";
}

/**
 * Extracts the jobId segment from a well-formed cloudPath.
 *   "jobs/<jobId>/<rest>" → "<jobId>"
 * Returns null when the cloudPath does not match the canonical pattern.
 */
function extractJobId(cloudPath: string): string | null {
  const m = cloudPath.match(/^jobs\/([^/]+)\/.+$/);
  return m ? m[1] : null;
}

/**
 * Infers the single jobId used throughout this manifest by scanning all nodes
 * for the first well-formed cloudPath. Returns null if none exists.
 */
function inferJobId(manifest: Manifest): string | null {
  for (const node of manifest.nodes.values()) {
    const id = extractJobId(node.storage.cloudPath);
    if (id) return id;
    for (const img of node.media.images) {
      const mid = extractJobId(img.storage.cloudPath);
      if (mid) return mid;
    }
  }
  return null;
}

/**
 * Validates that a cloudPath follows the canonical "jobs/<id>/<path>" pattern
 * produced by deriveCloudPath() in manifest.ts.
 */
function isCanonicalCloudPath(cloudPath: string): boolean {
  return /^jobs\/[^/]+\/.+$/.test(cloudPath.trim());
}

/**
 * Validates filename characters for cloud object-storage safety.
 * Returns a reason string on failure, or null when the filename is clean.
 */
function filenameViolation(filename: string): string | null {
  if (!filename || filename.trim() === "") return "empty_filename";
  // Control characters (includes null byte)
  if (/[\x00-\x1f\x7f]/.test(filename)) return "control_characters";
  // Double slashes (creates empty path segments)
  if (filename.includes("//")) return "double_slash";
  // Leading or trailing slash
  if (filename.startsWith("/") || filename.endsWith("/")) return "leading_or_trailing_slash";
  // Directory traversal
  if (filename.includes("..")) return "path_traversal_sequence";
  return null;
}

// ---------------------------------------------------------------------------
// Per-entry validation (shared for nodes and media items)
// ---------------------------------------------------------------------------

function addInvariant(
  state: ValidationState,
  rule: CloudInvariantRule,
  detail: string,
  nodeId?: string,
  mediaId?: string
): void {
  state.invariantViolations.push({ rule, detail, nodeId, mediaId });
}

function registerCloudKey(
  state: ValidationState,
  cloudPath: string,
  nodeId: string,
  kind: "node" | "image" | "video",
  mediaId?: string
): void {
  if (!state.cloudKeyRegistry.has(cloudPath)) {
    state.cloudKeyRegistry.set(cloudPath, []);
  }
  state.cloudKeyRegistry.get(cloudPath)!.push({ nodeId, kind, mediaId });
  state.totalFiles++;
}

function validateStorageEntry(
  state: ValidationState,
  nodeId: string,
  nodeType: NodeType,
  kind: "node" | "image" | "video",
  localPath: string,
  cloudPath: string,
  filename: string,
  provider: StorageProvider | undefined,
  mediaId?: string
): void {
  const localEmpty = isEmpty(localPath);
  const cloudEmpty = isEmpty(cloudPath);

  // ── Missing storage mappings ─────────────────────────────────────────────
  if (localEmpty || cloudEmpty) {
    const issue: CloudMissingMapping["issue"] =
      localEmpty && cloudEmpty
        ? "both_empty"
        : localEmpty
          ? "empty_localPath"
          : "empty_cloudPath";

    state.missingStorageMappings.push({ nodeId, nodeType, kind, mediaId, issue });

    // Missing fields on an active media item → invariant violation
    if (kind !== "node") {
      addInvariant(
        state,
        "no_missing_media_references",
        `${kind} ${mediaId ?? "?"} on node ${nodeId} has ${issue}`,
        nodeId,
        mediaId
      );
    }
  }

  // ── Register cloud key (skip empty — already flagged above) ─────────────
  if (!cloudEmpty) {
    registerCloudKey(state, cloudPath, nodeId, kind, mediaId);
  }

  // ── Invariant: no renderer-generated paths ───────────────────────────────
  if (!cloudEmpty && !isCanonicalCloudPath(cloudPath)) {
    addInvariant(
      state,
      "no_renderer_generated_paths",
      `cloudPath "${cloudPath}" does not match "jobs/<id>/<path>" — may have been generated outside stampCloudPaths()`,
      nodeId,
      mediaId
    );
  }

  // ── localPath ↔ cloudPath consistency ────────────────────────────────────
  if (!localEmpty && !cloudEmpty && state.inferredJobId !== null) {
    const expected = `jobs/${state.inferredJobId}/${localPath}`;
    if (cloudPath !== expected) {
      state.localCloudConsistencyErrors.push({
        nodeId,
        kind,
        localPath,
        cloudPath,
        expectedCloudPath: expected,
      });
    }
  }

  // ── Filename validity ────────────────────────────────────────────────────
  const fnReason = filenameViolation(filename);
  if (fnReason !== null) {
    state.invalidFilenames.push({ cloudPath, filename, reason: fnReason });
  }

  // ── Provider public URL generation ───────────────────────────────────────
  if (provider && !cloudEmpty) {
    try {
      const url = provider.getPublicUrl(cloudPath);
      if (typeof url !== "string") {
        state.providerMappingErrors.push({
          cloudPath,
          issue: `getPublicUrl() returned ${typeof url} instead of string`,
        });
      } else if (url.trim() === "") {
        state.providerMappingErrors.push({
          cloudPath,
          issue: "getPublicUrl() returned an empty string",
        });
      }
    } catch (err) {
      state.providerMappingErrors.push({
        cloudPath,
        issue: `getPublicUrl() threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Dry-run cloud execution validator.
 *
 * Traverses the entire manifest — all PageNodes and their MediaItems — and
 * runs six categories of validation without performing any I/O:
 *
 *   1. cloudPath uniqueness    (no_duplicate_cloud_keys invariant)
 *   2. localPath ↔ cloudPath consistency
 *   3. Missing storage mappings (no_missing_media_references invariant)
 *   4. Filename validity
 *   5. Provider public URL generation
 *   6. Renderer-generated path detection (no_renderer_generated_paths invariant)
 *
 * The resulting CloudExecutionReport is attached to manifest.output.cloud
 * (if manifest.output exists) and returned to the caller.
 *
 * @param manifest  Sealed manifest after ZIP finalization.
 * @param provider  Optional StorageProvider used to validate getPublicUrl().
 *                  When omitted, provider mapping checks are skipped.
 */
export function renderCloud(
  manifest: Manifest,
  provider?: StorageProvider
): CloudExecutionReport {
  const generatedAt = new Date().toISOString();
  const state = makeState();

  // Infer the single jobId used across this manifest so we can verify the
  // localPath ↔ cloudPath relationship without storing jobId in Manifest itself.
  state.inferredJobId = inferJobId(manifest);

  // ── Traverse all nodes ────────────────────────────────────────────────────
  for (const node of manifest.nodes.values()) {
    // Validate node StorageMap
    validateStorageEntry(
      state,
      node.id,
      node.nodeType,
      "node",
      node.storage.localPath,
      node.storage.cloudPath,
      node.storage.filename,
      provider
    );

    // ── Media images ────────────────────────────────────────────────────────
    for (const img of node.media.images) {
      if (img.status === "skipped") {
        state.skippedMediaCount++;
        continue;
      }
      if (img.status === "failed") {
        state.failedMediaCount++;
        continue;
      }

      // Accumulate bytes from downloaded/rendered media
      if (img.byteSize !== null && img.byteSize > 0) {
        state.totalBytes += img.byteSize;
      }

      validateStorageEntry(
        state,
        node.id,
        node.nodeType,
        "image",
        img.storage.localPath,
        img.storage.cloudPath,
        img.storage.filename,
        provider,
        img.id
      );
    }

    // ── Media videos ────────────────────────────────────────────────────────
    for (const vid of node.media.videos) {
      if (vid.status === "skipped") {
        state.skippedMediaCount++;
        continue;
      }
      if (vid.status === "failed") {
        state.failedMediaCount++;
        continue;
      }

      if (vid.byteSize !== null && vid.byteSize > 0) {
        state.totalBytes += vid.byteSize;
      }

      validateStorageEntry(
        state,
        node.id,
        node.nodeType,
        "video",
        vid.storage.localPath,
        vid.storage.cloudPath,
        vid.storage.filename,
        provider,
        vid.id
      );
    }
  }

  // ── Duplicate cloudPath detection ─────────────────────────────────────────
  // Must run after all nodes are traversed so the full registry is built.
  const duplicateCloudPathConflicts: CloudDuplicateConflict[] = [];

  for (const [cloudPath, sources] of state.cloudKeyRegistry.entries()) {
    if (sources.length > 1) {
      duplicateCloudPathConflicts.push({
        cloudPath,
        count: sources.length,
        sources,
      });
      addInvariant(
        state,
        "no_duplicate_cloud_keys",
        `cloudPath "${cloudPath}" is referenced by ${sources.length} distinct sources`,
        sources[0].nodeId
      );
    }
  }

  // ── Assemble report ───────────────────────────────────────────────────────
  const valid =
    duplicateCloudPathConflicts.length === 0 &&
    state.missingStorageMappings.length === 0 &&
    state.invalidFilenames.length === 0 &&
    state.localCloudConsistencyErrors.length === 0 &&
    state.providerMappingErrors.length === 0 &&
    state.invariantViolations.length === 0;

  const report: CloudExecutionReport = {
    totalFiles: state.totalFiles,
    totalBytes: state.totalBytes,
    skippedMediaCount: state.skippedMediaCount,
    failedMediaCount: state.failedMediaCount,
    duplicateCloudPathConflicts,
    missingStorageMappings: state.missingStorageMappings,
    invalidFilenames: state.invalidFilenames,
    localCloudConsistencyErrors: state.localCloudConsistencyErrors,
    providerMappingErrors: state.providerMappingErrors,
    invariantViolations: state.invariantViolations,
    valid,
    generatedAt,
  };

  // ── Attach to manifest.output.cloud ──────────────────────────────────────
  if (manifest.output) {
    manifest.output.cloud = report;
  }

  // ── Structured log summary ────────────────────────────────────────────────
  const logFn = valid ? logger.info.bind(logger) : logger.warn.bind(logger);
  logFn(
    {
      manifestId: manifest.id,
      manifestStatus: manifest.status,
      inferredJobId: state.inferredJobId,
      valid,
      totalFiles: report.totalFiles,
      totalBytes: report.totalBytes,
      skippedMedia: report.skippedMediaCount,
      failedMedia: report.failedMediaCount,
      duplicates: duplicateCloudPathConflicts.length,
      missingMappings: state.missingStorageMappings.length,
      invalidFilenames: state.invalidFilenames.length,
      consistencyErrors: state.localCloudConsistencyErrors.length,
      providerErrors: state.providerMappingErrors.length,
      invariantViolations: state.invariantViolations.length,
    },
    valid
      ? "CLOUD_RENDER: dry-run validation passed — all storage mappings are consistent"
      : "CLOUD_RENDER: dry-run validation found issues — see report for details"
  );

  return report;
}
