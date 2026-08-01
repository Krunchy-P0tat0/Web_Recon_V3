/**
 * manifest-verifier.ts — Manifest R2 verification and job restorability checks.
 *
 * Provides:
 *   ManifestVerificationError    — thrown when Stage 10 verification fails
 *   RestorabilityEnforcementError — thrown when the completion gate is blocked
 *   VerificationGrade            — PASS | PARTIAL_PASS | FAIL
 *   runManifestVerification      — Stage 10: verify _manifest.json in R2 is valid
 *   validateRestorableJob        — completion gate: all 3 artifacts must exist + pass
 *
 * Design contract:
 *   runManifestVerification THROWS ManifestVerificationError when any check fails.
 *   validateRestorableJob NEVER throws — it returns a RestorabilityResult.
 *   The CALLER (job-worker) must throw RestorabilityEnforcementError when restorable=false.
 */

import { logger } from "./logger";
import type { CloudProvider } from "../cloud/provider";
import type { PortableManifest } from "./manifest-export";

// ---------------------------------------------------------------------------
// VerificationGrade
// ---------------------------------------------------------------------------

export type VerificationGrade = "PASS" | "PARTIAL_PASS" | "FAIL";

function computeGrade(
  missingCount: number,
  restorable: boolean,
): VerificationGrade {
  if (restorable && missingCount === 0) return "PASS";
  if (missingCount >= 3) return "FAIL";
  return "PARTIAL_PASS";
}

// ---------------------------------------------------------------------------
// ManifestVerificationError — thrown by runManifestVerification on failure
// ---------------------------------------------------------------------------

export class ManifestVerificationError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly reason: string,
    public readonly detail?: string,
  ) {
    super(
      `ManifestVerificationError [${jobId}]: ${reason}` +
        (detail ? ` — ${detail}` : ""),
    );
    this.name = "ManifestVerificationError";
  }
}

// ---------------------------------------------------------------------------
// RestorabilityEnforcementError — thrown by the job-worker completion gate
// ---------------------------------------------------------------------------

export class RestorabilityEnforcementError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly missingArtifacts: string[],
    public readonly verificationGrade: VerificationGrade,
  ) {
    const missing =
      missingArtifacts.length > 0 ? missingArtifacts.join(", ") : "nodeCount=0";
    super(
      `RestorabilityEnforcementError [${jobId}]: job cannot be completed because ` +
        `restoration requirements failed. Grade: ${verificationGrade}. Missing: ${missing}`,
    );
    this.name = "RestorabilityEnforcementError";
  }
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ManifestVerificationResult {
  jobId: string;
  checkedAt: string;
  /** true when all checks passed; false only when cloud is not configured */
  passed: boolean;
  /** Whether the cloud provider was configured (false = skipped) */
  cloudConfigured: boolean;
  r2Key: string;
  /** Byte length of the downloaded JSON, 0 when skipped */
  byteSize: number;
  nodeCount: number;
  schemaVersion: string | null;
  durationMs: number;
}

export interface ArtifactCheckDetail {
  /** Key exists in R2 */
  exists: boolean;
  /** Byte size of the artifact (0 when not downloaded) */
  byteSize: number;
  /** Whether the content passed validation (schema/nodeCount) — only for manifest.json */
  valid: boolean;
}

export interface RestorabilityResult {
  restorable: boolean;
  missingArtifacts: string[];
  nodeCount: number;
  verificationGrade: VerificationGrade;
  artifacts: {
    manifestJson: boolean;
    manifestZip: boolean;
    rootIndex: boolean;
  };
  artifactDetails: {
    manifestJson: ArtifactCheckDetail;
    manifestZip: ArtifactCheckDetail;
    rootIndex: ArtifactCheckDetail;
  };
}

// ---------------------------------------------------------------------------
// runManifestVerification — Stage 10
// ---------------------------------------------------------------------------

/**
 * Downloads `jobs/{jobId}/_manifest.json` from the cloud provider and runs
 * five sequential checks:
 *   1. Key exists in R2 (HEAD / verify)
 *   2. Download succeeds and byte size > 0
 *   3. Content is valid JSON
 *   4. JSON has required top-level fields (schemaVersion, id, nodes, seedUrl)
 *   5. nodes array contains at least one entry
 *
 * Returns ManifestVerificationResult on success.
 * Throws ManifestVerificationError on any failure — the caller must treat
 * this as a fatal pipeline error and mark the job FAILED.
 *
 * When cloud is not configured the function returns a vacuously-passing result
 * (cloudConfigured: false) so the pipeline can complete without R2.
 */
export async function runManifestVerification(
  provider: CloudProvider,
  jobId: string,
): Promise<ManifestVerificationResult> {
  const r2Key = `jobs/${jobId}/_manifest.json`;
  const checkedAt = new Date().toISOString();
  const startMs = Date.now();

  if (!provider.isConfigured()) {
    logger.debug(
      { jobId, r2Key },
      "MANIFEST_VERIFIER: cloud not configured — skipping verification",
    );
    return {
      jobId,
      checkedAt,
      passed: true,
      cloudConfigured: false,
      r2Key,
      byteSize: 0,
      nodeCount: 0,
      schemaVersion: null,
      durationMs: 0,
    };
  }

  logger.info(
    { jobId, r2Key, provider: provider.providerName },
    "MANIFEST_VERIFIER: starting manifest verification",
  );

  // ── Check 1: key exists ──────────────────────────────────────────────────
  const exists = await provider.verify(r2Key);
  if (!exists) {
    const durationMs = Date.now() - startMs;
    logger.error(
      { jobId, r2Key, durationMs },
      "MANIFEST_VERIFIER: _manifest.json not found in R2",
    );
    throw new ManifestVerificationError(
      jobId,
      "_manifest.json missing from R2",
      r2Key,
    );
  }

  // ── Check 2: download and confirm non-zero size ──────────────────────────
  const buf = await provider.download(r2Key);
  if (!buf || buf.length === 0) {
    const durationMs = Date.now() - startMs;
    logger.error(
      { jobId, r2Key, durationMs, byteSize: buf?.length ?? 0 },
      "MANIFEST_VERIFIER: _manifest.json empty or unreadable",
    );
    throw new ManifestVerificationError(
      jobId,
      buf === null
        ? "_manifest.json could not be downloaded"
        : "_manifest.json is empty (0 bytes)",
      r2Key,
    );
  }

  const byteSize = buf.length;

  // ── Check 3: valid JSON ──────────────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch (parseErr) {
    const durationMs = Date.now() - startMs;
    logger.error(
      { jobId, r2Key, byteSize, durationMs },
      "MANIFEST_VERIFIER: _manifest.json is not valid JSON",
    );
    throw new ManifestVerificationError(
      jobId,
      "_manifest.json contains invalid JSON",
      parseErr instanceof Error ? parseErr.message : String(parseErr),
    );
  }

  // ── Check 4: schema validation ───────────────────────────────────────────
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("schemaVersion" in parsed) ||
    !("id" in parsed) ||
    !("nodes" in parsed) ||
    !("seedUrl" in parsed)
  ) {
    const durationMs = Date.now() - startMs;
    logger.error(
      { jobId, r2Key, durationMs },
      "MANIFEST_VERIFIER: _manifest.json schema invalid — missing required fields",
    );
    throw new ManifestVerificationError(
      jobId,
      "_manifest.json schema invalid — missing required fields (schemaVersion, id, nodes, seedUrl)",
      r2Key,
    );
  }

  const manifest = parsed as PortableManifest;

  // ── Check 5: node count > 0 ──────────────────────────────────────────────
  const nodeCount = Array.isArray(manifest.nodes) ? manifest.nodes.length : 0;
  if (nodeCount === 0) {
    const durationMs = Date.now() - startMs;
    logger.error(
      { jobId, r2Key, durationMs },
      "MANIFEST_VERIFIER: _manifest.json contains 0 nodes",
    );
    throw new ManifestVerificationError(
      jobId,
      "_manifest.json has 0 nodes — manifest is empty",
      `nodes.length = ${nodeCount}`,
    );
  }

  const durationMs = Date.now() - startMs;

  logger.info(
    {
      jobId,
      r2Key,
      byteSize,
      nodeCount,
      schemaVersion: manifest.schemaVersion,
      durationMs,
    },
    "MANIFEST_VERIFIER: manifest verification passed — all 5 checks OK",
  );

  return {
    jobId,
    checkedAt,
    passed: true,
    cloudConfigured: true,
    r2Key,
    byteSize,
    nodeCount,
    schemaVersion: manifest.schemaVersion,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// validateRestorableJob — completion gate (never throws)
// ---------------------------------------------------------------------------

/**
 * Checks whether all three required R2 artifacts for full job restoration exist
 * and contain valid content:
 *
 *   1. jobs/{jobId}/_manifest.json  — downloaded + parsed + nodeCount > 0
 *   2. jobs/{jobId}/_manifest.zip   — verified to exist (size implicit in upload)
 *   3. jobs/{jobId}/index.html      — downloaded + size > 0
 *
 * Returns a RestorabilityResult with verificationGrade:
 *   PASS         — all artifacts present + restorable = true
 *   PARTIAL_PASS — some artifacts present, restorable = false (1–2 missing)
 *   FAIL         — all artifacts missing or restoration impossible
 *
 * Never throws. The CALLER must throw RestorabilityEnforcementError
 * when restorable = false and cloud is configured.
 */
export async function validateRestorableJob(
  provider: CloudProvider,
  jobId: string,
): Promise<RestorabilityResult> {
  if (!provider.isConfigured()) {
    return {
      restorable: false,
      missingArtifacts: ["cloud provider not configured — cannot verify R2 artifacts"],
      nodeCount: 0,
      verificationGrade: "FAIL",
      artifacts: { manifestJson: false, manifestZip: false, rootIndex: false },
      artifactDetails: {
        manifestJson: { exists: false, byteSize: 0, valid: false },
        manifestZip:  { exists: false, byteSize: 0, valid: false },
        rootIndex:    { exists: false, byteSize: 0, valid: false },
      },
    };
  }

  const keys = {
    manifestJson: `jobs/${jobId}/_manifest.json`,
    manifestZip:  `jobs/${jobId}/_manifest.zip`,
    rootIndex:    `jobs/${jobId}/index.html`,
  };

  // Run all three artifact checks in parallel.
  //
  // _manifest.json: download + parse + validate schema + nodeCount
  // _manifest.zip:  verify existence only (downloading a large ZIP is prohibitive)
  // index.html:     download + size > 0
  const [manifestJsonDetail, manifestZipDetail, rootIndexDetail] =
    await Promise.all([
      checkManifestJson(provider, keys.manifestJson),
      checkManifestZip(provider, keys.manifestZip),
      checkRootIndex(provider, keys.rootIndex),
    ]);

  const missingArtifacts: string[] = [];
  if (!manifestJsonDetail.exists || !manifestJsonDetail.valid) {
    missingArtifacts.push("_manifest.json");
  }
  if (!manifestZipDetail.exists) {
    missingArtifacts.push("_manifest.zip");
  }
  if (!rootIndexDetail.exists || rootIndexDetail.byteSize === 0) {
    missingArtifacts.push("index.html");
  }

  const nodeCount =
    manifestJsonDetail.valid && manifestJsonDetail.exists
      ? (manifestJsonDetail as { exists: boolean; byteSize: number; valid: boolean; nodeCount?: number }).nodeCount ?? 0
      : 0;

  const restorable = missingArtifacts.length === 0 && nodeCount > 0;
  const verificationGrade = computeGrade(missingArtifacts.length, restorable);

  const artifacts = {
    manifestJson: manifestJsonDetail.exists && manifestJsonDetail.valid,
    manifestZip:  manifestZipDetail.exists,
    rootIndex:    rootIndexDetail.exists && rootIndexDetail.byteSize > 0,
  };

  logger.info(
    {
      jobId,
      restorable,
      verificationGrade,
      missingArtifacts,
      nodeCount,
      artifactDetails: {
        manifestJson: manifestJsonDetail,
        manifestZip:  manifestZipDetail,
        rootIndex:    rootIndexDetail,
      },
    },
    restorable
      ? "MANIFEST_VERIFIER: job is fully restorable from R2 — grade: PASS"
      : `MANIFEST_VERIFIER: job is NOT fully restorable — grade: ${verificationGrade}`,
  );

  return {
    restorable,
    missingArtifacts,
    nodeCount,
    verificationGrade,
    artifacts,
    artifactDetails: {
      manifestJson: manifestJsonDetail,
      manifestZip:  manifestZipDetail,
      rootIndex:    rootIndexDetail,
    },
  };
}

// ---------------------------------------------------------------------------
// Internal per-artifact check helpers
// ---------------------------------------------------------------------------

interface ManifestJsonDetail extends ArtifactCheckDetail {
  nodeCount: number;
}

async function checkManifestJson(
  provider: CloudProvider,
  key: string,
): Promise<ManifestJsonDetail> {
  try {
    const buf = await provider.download(key);
    if (!buf || buf.length === 0) {
      return { exists: false, byteSize: 0, valid: false, nodeCount: 0 };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString("utf8"));
    } catch {
      return { exists: true, byteSize: buf.length, valid: false, nodeCount: 0 };
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("schemaVersion" in parsed) ||
      !("id" in parsed) ||
      !("nodes" in parsed) ||
      !("seedUrl" in parsed)
    ) {
      return { exists: true, byteSize: buf.length, valid: false, nodeCount: 0 };
    }
    const manifest = parsed as PortableManifest;
    const nodeCount = Array.isArray(manifest.nodes) ? manifest.nodes.length : 0;
    return {
      exists: true,
      byteSize: buf.length,
      valid: nodeCount > 0,
      nodeCount,
    };
  } catch {
    return { exists: false, byteSize: 0, valid: false, nodeCount: 0 };
  }
}

async function checkManifestZip(
  provider: CloudProvider,
  key: string,
): Promise<ArtifactCheckDetail> {
  try {
    // Use verify() only — downloading a large ZIP for a size check would be
    // prohibitively expensive in production. A successful R2 upload guarantees
    // non-zero size; existence is the meaningful gate here.
    const exists = await provider.verify(key);
    return { exists, byteSize: 0, valid: exists };
  } catch {
    return { exists: false, byteSize: 0, valid: false };
  }
}

async function checkRootIndex(
  provider: CloudProvider,
  key: string,
): Promise<ArtifactCheckDetail> {
  try {
    const buf = await provider.download(key);
    if (!buf || buf.length === 0) {
      return { exists: false, byteSize: 0, valid: false };
    }
    return { exists: true, byteSize: buf.length, valid: true };
  } catch {
    return { exists: false, byteSize: 0, valid: false };
  }
}
