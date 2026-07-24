/**
 * job-restorer.ts — Full R2 Restoration Engine (Phase 1.5.2)
 *
 * Proves the architectural guarantee:
 *   manifest → restore → site reconstruction
 * using ONLY Cloudflare R2 artifacts — no local cache, no database, no
 * original website access required.
 *
 * Restoration flow:
 *   1. Download jobs/{jobId}/_manifest.json  — parse into PortableManifest
 *   2. Verify jobs/{jobId}/_manifest.zip     — confirm existence in R2
 *   3. Verify jobs/{jobId}/index.html        — confirm existence in R2
 *   4. fromPortableManifest()                — reconstruct live Manifest (Map/Set)
 *   5. regenerateZipFromManifest()           — rebuild all HTML + images + index
 *   6. AdmZip integrity validation           — confirm ZIP is readable
 *   7. Coverage + classification             — PASS | PARTIAL_PASS | FAIL
 *   8. Write restoration-report.json         — permanent audit artifact
 *
 * Invariants:
 *   - Never reads from DB, local manifest cache, local image cache, or original site
 *   - Never modifies existing job records or manifests
 *   - Output ZIP is written to os.tmpdir() — never clobbers live job ZIPs
 *   - All cloud access goes through the CloudProvider interface
 */

import { createRequire } from "module";
import fs from "fs";
import path from "path";
import os from "os";
import { logger } from "./logger";
import type { CloudProvider } from "../cloud/provider";
import { fromPortableManifest } from "./manifest-export";
import type { PortableManifest } from "./manifest-export";
import {
  regenerateZipFromManifest,
  type RegenerationReport,
} from "./zip-regenerator";
import { getOrderedNodes } from "./manifest";

const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip") as new (filePath?: string) => {
  getEntries: () => unknown[];
};

// ---------------------------------------------------------------------------
// Public report types
// ---------------------------------------------------------------------------

export type RestorationClassification = "PASS" | "PARTIAL_PASS" | "FAIL";

/**
 * Top-level restoration proof report — written to restoration-report.json
 * and returned from the API endpoint.
 */
export interface RestorationReport {
  jobId: string;
  startedAt: string;
  completedAt: string;
  restorationDurationMs: number;

  /** R2 key paths checked */
  manifestJsonKey: string;
  manifestZipKey: string;
  rootIndexKey: string;

  /** Whether each required artifact was found in R2 */
  manifestJsonPresent: boolean;
  manifestZipPresent: boolean;
  rootIndexPresent: boolean;

  /** Manifest integrity */
  manifestNodeCount: number;
  manifestPageCount: number;
  manifestImageCount: number;
  manifestValid: boolean;

  /** Reconstruction results */
  nodesRestored: number;
  pagesRestored: number;
  imagesRestored: number;
  htmlReconstructed: number;
  imagesFromCloud: number;
  assetsFailed: number;

  /** Missing assets (cloud keys that could not be recovered) */
  missingAssets: string[];
  /** Missing references (manifest entries that point to missing R2 keys) */
  missingReferences: string[];

  /** Output ZIP */
  zipGenerated: boolean;
  zipPath: string | null;
  zipSizeBytes: number;
  zipValid: boolean;
  zipEntryCount: number;

  /** Coverage */
  restorationCoveragePercent: number;
  pageCoveragePercent: number;
  imageCoveragePercent: number;

  /** Classification */
  classification: RestorationClassification;
  classificationReason: string;

  /** Full regeneration detail (asset-level records) */
  regenReport: RegenerationReport | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function failReport(
  jobId: string,
  startedAt: string,
  reason: string,
  keys: { manifestJsonKey: string; manifestZipKey: string; rootIndexKey: string },
  partial: Partial<RestorationReport> = {},
): RestorationReport {
  const completedAt = new Date().toISOString();
  return {
    jobId,
    startedAt,
    completedAt,
    restorationDurationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    ...keys,
    manifestJsonPresent: false,
    manifestZipPresent: false,
    rootIndexPresent: false,
    manifestNodeCount: 0,
    manifestPageCount: 0,
    manifestImageCount: 0,
    manifestValid: false,
    nodesRestored: 0,
    pagesRestored: 0,
    imagesRestored: 0,
    htmlReconstructed: 0,
    imagesFromCloud: 0,
    assetsFailed: 0,
    missingAssets: [],
    missingReferences: [],
    zipGenerated: false,
    zipPath: null,
    zipSizeBytes: 0,
    zipValid: false,
    zipEntryCount: 0,
    restorationCoveragePercent: 0,
    pageCoveragePercent: 0,
    imageCoveragePercent: 0,
    classification: "FAIL",
    classificationReason: reason,
    regenReport: null,
    ...partial,
  };
}

function classifyRestoration(
  pageCoveragePercent: number,
  imageCoveragePercent: number,
  zipValid: boolean,
  zipGenerated: boolean,
  manifestValid: boolean,
  missingArtifacts: string[],
  nodesRestored: number,
): { classification: RestorationClassification; classificationReason: string } {
  if (!manifestValid) {
    return {
      classification: "FAIL",
      classificationReason: "Manifest is invalid — schema check failed or nodeCount=0",
    };
  }
  if (!zipGenerated || !zipValid) {
    return {
      classification: "FAIL",
      classificationReason: "ZIP could not be generated or is unreadable",
    };
  }
  if (nodesRestored === 0) {
    return {
      classification: "FAIL",
      classificationReason: "No assets could be restored from R2",
    };
  }

  const effectivePagePct = pageCoveragePercent;
  const effectiveImgPct  = imageCoveragePercent;

  if (effectivePagePct >= 95 && effectiveImgPct >= 95) {
    const artifactNote =
      missingArtifacts.length > 0
        ? ` (R2 artifact gap: ${missingArtifacts.join(", ")})`
        : "";
    return {
      classification: "PASS",
      classificationReason:
        `Full restoration: ${effectivePagePct}% pages, ` +
        `${effectiveImgPct}% images recovered from R2${artifactNote}`,
    };
  }

  return {
    classification: "PARTIAL_PASS",
    classificationReason:
      `Partial restoration: ${effectivePagePct}% pages (≥95 required), ` +
      `${effectiveImgPct}% images (≥95 required). ` +
      (missingArtifacts.length > 0 ? `R2 artifacts missing: ${missingArtifacts.join(", ")}` : ""),
  };
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Performs a full disaster recovery simulation for the given job using
 * ONLY Cloudflare R2 artifacts as source of truth.
 *
 * Writes restoration-report.json to os.tmpdir()/restore-{jobId}/.
 * Returns the same report object for API callers.
 */
export async function restoreJobFromR2(
  provider: CloudProvider,
  jobId: string,
): Promise<RestorationReport> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const manifestJsonKey = `jobs/${jobId}/_manifest.json`;
  const manifestZipKey  = `jobs/${jobId}/_manifest.zip`;
  const rootIndexKey    = `jobs/${jobId}/index.html`;
  const keys = { manifestJsonKey, manifestZipKey, rootIndexKey };

  logger.info(
    {
      jobId,
      manifestJsonKey,
      provider: provider.providerName,
      configured: provider.isConfigured(),
    },
    "RESTORE: starting full R2 restoration proof — local machine assumed destroyed",
  );

  if (!provider.isConfigured()) {
    return failReport(jobId, startedAt, "Cloud provider not configured — R2 unavailable", keys);
  }

  // ── Phase D1: Download and parse _manifest.json ──────────────────────────
  logger.info({ jobId, key: manifestJsonKey }, "RESTORE: Phase D1 — downloading _manifest.json");

  const manifestBuf = await provider.download(manifestJsonKey).catch(() => null);
  if (!manifestBuf || manifestBuf.length === 0) {
    const r = failReport(
      jobId,
      startedAt,
      "_manifest.json not found in R2 — restoration impossible without source of truth",
      keys,
    );
    await _writeReport(jobId, r);
    return r;
  }

  let portable: PortableManifest | null = null;
  try {
    const parsed: unknown = JSON.parse(manifestBuf.toString("utf8"));
    if (
      typeof parsed === "object" && parsed !== null &&
      "schemaVersion" in parsed && "nodes" in parsed &&
      "id" in parsed && "seedUrl" in parsed
    ) {
      portable = parsed as PortableManifest;
    }
  } catch {
    const r = failReport(
      jobId,
      startedAt,
      "_manifest.json contains invalid JSON — cannot parse",
      keys,
      { manifestJsonPresent: true },
    );
    await _writeReport(jobId, r);
    return r;
  }

  if (!portable || !Array.isArray(portable.nodes) || portable.nodes.length === 0) {
    const r = failReport(
      jobId,
      startedAt,
      "_manifest.json schema invalid or contains 0 nodes — manifest is unusable",
      keys,
      { manifestJsonPresent: true },
    );
    await _writeReport(jobId, r);
    return r;
  }

  // ── Phase D2: Verify _manifest.zip and index.html ────────────────────────
  logger.info(
    { jobId, manifestZipKey, rootIndexKey },
    "RESTORE: Phase D2 — verifying _manifest.zip and index.html in R2",
  );

  const [manifestZipPresent, rootIndexPresent] = await Promise.all([
    provider.verify(manifestZipKey).catch(() => false),
    provider.verify(rootIndexKey).catch(() => false),
  ]);

  const missingArtifacts: string[] = [];
  if (!manifestZipPresent) missingArtifacts.push("_manifest.zip");
  if (!rootIndexPresent) missingArtifacts.push("index.html");

  if (missingArtifacts.length > 0) {
    logger.warn(
      { jobId, missingArtifacts },
      "RESTORE: required R2 artifacts missing — will attempt reconstruction from _manifest.json",
    );
  }

  // ── Phase D3/D4: Reconstruct live Manifest + enumerate nodes ────────────
  logger.info({ jobId, nodeCount: portable.nodes.length }, "RESTORE: Phase D3 — reconstructing Manifest from PortableManifest");

  const manifest = fromPortableManifest(portable);
  const orderedNodes = getOrderedNodes(manifest);
  const pageNodes = orderedNodes.filter((n) => n.nodeType !== "root");

  const manifestNodeCount = manifest.nodes.size;
  const manifestPageCount = pageNodes.length;
  const manifestImageCount = pageNodes.reduce(
    (sum, n) =>
      sum +
      n.media.images.filter(
        (i) => i.status === "rendered" || i.status === "downloaded",
      ).length,
    0,
  );

  logger.info(
    {
      jobId,
      manifestNodeCount,
      manifestPageCount,
      manifestImageCount,
      seedUrl: manifest.seedUrl,
      manifestStatus: manifest.status,
    },
    "RESTORE: Phase D4 — manifest reconstructed; node graph ready",
  );

  // ── Phase D5: Regenerate ZIP from R2 assets ──────────────────────────────
  logger.info(
    { jobId, outputDir: os.tmpdir() },
    "RESTORE: Phase D5 — rebuilding ZIP using only R2 artifacts (allowReFetch=false)",
  );

  const restoreDir = path.join(os.tmpdir(), `restore-${jobId}`);
  await fs.promises.mkdir(restoreDir, { recursive: true });
  const outputZipPath = path.join(restoreDir, `${jobId}-restored.zip`);

  let regenReport: RegenerationReport | null = null;
  let zipGenerated = false;

  try {
    regenReport = await regenerateZipFromManifest(jobId, manifest, outputZipPath, {
      allowReFetch: false,       // R2 only — no original website
      skipCloudFallback: false,  // use R2 public URLs
      concurrency: 6,
    });
    zipGenerated = true;
  } catch (err) {
    logger.error({ err, jobId }, "RESTORE: ZIP regeneration threw — producing FAIL report");
  }

  // ── Phase D6: ZIP integrity validation ───────────────────────────────────
  logger.info({ jobId, zipGenerated }, "RESTORE: Phase D6 — validating ZIP integrity");

  let zipSizeBytes = 0;
  let zipValid = false;
  let zipEntryCount = 0;

  if (zipGenerated) {
    try {
      const stat = fs.statSync(outputZipPath);
      zipSizeBytes = stat.size;

      if (zipSizeBytes > 0) {
        const zip = new AdmZip(outputZipPath);
        const entries = zip.getEntries();
        zipEntryCount = entries.length;
        zipValid = zipEntryCount > 0;
      }
    } catch (err) {
      logger.error({ err, jobId }, "RESTORE: ZIP validation threw — marking invalid");
      zipValid = false;
    }
  }

  // ── Phase E: Compute restoration metrics ─────────────────────────────────
  const htmlReconstructed =
    regenReport?.assets.filter(
      (a) =>
        a.source === "reconstructed" &&
        a.localPath.endsWith(".html") &&
        !a.localPath.startsWith("_"),
    ).length ?? 0;

  const imagesFromCloud =
    regenReport?.assets.filter((a) => a.source === "cloud").length ?? 0;

  const assetsFailed =
    regenReport?.assets.filter(
      (a) => a.source === "failed" || a.source === "missing",
    ).length ?? 0;

  const pagesRestored = htmlReconstructed;
  const imagesRestored = imagesFromCloud;
  const nodesRestored =
    (regenReport?.reconstructed ?? 0) + (regenReport?.restoredFromCloud ?? 0);

  const missingAssets: string[] = (
    regenReport?.assets
      .filter((a) => a.source === "missing" || a.source === "failed")
      .map((a) => a.cloudPath || a.localPath)
      .filter(Boolean) ?? []
  ).slice(0, 500);

  // Missing references: manifest cloudPaths not found in R2
  const missingReferences: string[] = [];
  for (const node of pageNodes) {
    for (const img of node.media.images) {
      if (
        (img.status === "rendered" || img.status === "downloaded") &&
        img.storage.cloudPath
      ) {
        const found = regenReport?.assets.find(
          (a) => a.cloudPath === img.storage.cloudPath,
        );
        if (!found || found.source === "missing" || found.source === "failed") {
          missingReferences.push(img.storage.cloudPath);
        }
      }
    }
  }

  // ── Phase F: Coverage percentages ─────────────────────────────────────────
  const pageCoveragePercent =
    manifestPageCount > 0
      ? Math.round((pagesRestored / manifestPageCount) * 100)
      : 100;

  const imageCoveragePercent =
    manifestImageCount > 0
      ? Math.round((imagesRestored / manifestImageCount) * 100)
      : 100;

  const restorationCoveragePercent =
    manifestPageCount + manifestImageCount > 0
      ? Math.round(
          ((pagesRestored + imagesRestored) /
            (manifestPageCount + manifestImageCount)) *
            100,
        )
      : 0;

  // ── Phase G: Classification ───────────────────────────────────────────────
  const { classification, classificationReason } = classifyRestoration(
    pageCoveragePercent,
    imageCoveragePercent,
    zipValid,
    zipGenerated,
    true, // manifest is valid (we parsed it above)
    missingArtifacts,
    nodesRestored,
  );

  const completedAt = new Date().toISOString();
  const restorationDurationMs = Date.now() - startMs;

  const report: RestorationReport = {
    jobId,
    startedAt,
    completedAt,
    restorationDurationMs,

    manifestJsonKey,
    manifestZipKey,
    rootIndexKey,
    manifestJsonPresent: true,
    manifestZipPresent,
    rootIndexPresent,

    manifestNodeCount,
    manifestPageCount,
    manifestImageCount,
    manifestValid: true,

    nodesRestored,
    pagesRestored,
    imagesRestored,
    htmlReconstructed,
    imagesFromCloud,
    assetsFailed,

    missingAssets,
    missingReferences: missingReferences.slice(0, 200),

    zipGenerated,
    zipPath: zipGenerated ? outputZipPath : null,
    zipSizeBytes,
    zipValid,
    zipEntryCount,

    restorationCoveragePercent,
    pageCoveragePercent,
    imageCoveragePercent,

    classification,
    classificationReason,

    regenReport,
  };

  await _writeReport(jobId, report);

  // ── Console audit summary ─────────────────────────────────────────────────
  const logFn = classification === "FAIL" ? logger.error.bind(logger) : logger.info.bind(logger);
  logFn(
    {
      jobId,
      classification,
      classificationReason,
      manifestNodeCount,
      manifestPageCount,
      manifestImageCount,
      nodesRestored,
      pagesRestored,
      imagesRestored,
      pageCoveragePercent: `${pageCoveragePercent}%`,
      imageCoveragePercent: `${imageCoveragePercent}%`,
      restorationCoveragePercent: `${restorationCoveragePercent}%`,
      missingCount: missingAssets.length,
      missingReferencesCount: missingReferences.length,
      zipValid,
      zipSizeBytes,
      zipEntryCount,
      manifestZipPresent,
      rootIndexPresent,
      restorationDurationMs,
    },
    `RESTORE: ▶ PROOF COMPLETE — classification: ${classification}`,
  );

  return report;
}

// ---------------------------------------------------------------------------
// Report path utilities
// ---------------------------------------------------------------------------

/** Returns the canonical path for a restoration report. */
export function restorationReportPath(jobId: string): string {
  return path.join(os.tmpdir(), `restore-${jobId}`, "restoration-report.json");
}

/** Returns true if a restoration report currently exists on disk. */
export function restorationReportExists(jobId: string): boolean {
  try {
    return fs.existsSync(restorationReportPath(jobId));
  } catch {
    return false;
  }
}

/** Reads and returns the cached RestorationReport if it exists. */
export function readRestorationReport(jobId: string): RestorationReport | null {
  try {
    const raw = fs.readFileSync(restorationReportPath(jobId), "utf8");
    return JSON.parse(raw) as RestorationReport;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal writer
// ---------------------------------------------------------------------------

async function _writeReport(jobId: string, report: RestorationReport): Promise<void> {
  try {
    const dir = path.join(os.tmpdir(), `restore-${jobId}`);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, "restoration-report.json"),
      JSON.stringify(report, null, 2),
      "utf8",
    );
    logger.info(
      { jobId, path: path.join(dir, "restoration-report.json") },
      "RESTORE: restoration-report.json written",
    );
  } catch (writeErr) {
    logger.warn({ writeErr, jobId }, "RESTORE: could not write restoration-report.json");
  }
}
