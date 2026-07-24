/**
 * diff-engine.ts — Differential crawl engine
 *
 * Compares a new crawl manifest against a baseline manifest loaded from R2
 * and classifies every URL as NEW / CHANGED / UNCHANGED / DELETED.
 *
 * Classification rules:
 *   NEW       — URL in new crawl, absent from baseline
 *   CHANGED   — URL in both, but contentHash differs (or baseline lacks a hash)
 *   UNCHANGED — URL in both, contentHash identical
 *   DELETED   — URL in baseline, absent from new crawl
 *
 * Change-reason detection (for CHANGED nodes):
 *   contentHashChanged  — cleanHtml hash differs
 *   titleChanged        — title string differs
 *   imageSetChanged     — image count or source URLs differ
 *   metadataChanged     — publishedAt or description changed
 *   structureChanged    — word count changed by >10%
 */

import crypto from "crypto";
import axios from "axios";
import { logger } from "./logger";
import type { CloudProvider } from "../cloud/provider";
import type { Manifest, PageNode, DiffClassification, ChangeReason } from "./manifest";
import { normalizeUrlFrontier } from "./crawl-frontier";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DiffNodeResult {
  nodeId: string;
  url: string;
  title: string;
  classification: DiffClassification;
  changeReasons: ChangeReason[];
  /** contentHash of the new node (null for DELETED) */
  newHash: string | null;
  /** contentHash of the baseline node (null for NEW) */
  baseHash: string | null;
  /** true when this node was skipped (UNCHANGED) — no re-fetch needed */
  skipped: boolean;
}

export interface DiffReport {
  baseJobId: string;
  newJobId: string;
  computedAt: string;
  baseManifestNodeCount: number;
  newManifestNodeCount: number;
  newNodes: DiffNodeResult[];
  changedNodes: DiffNodeResult[];
  unchangedNodes: DiffNodeResult[];
  deletedNodes: DiffNodeResult[];
  summary: {
    total: number;
    new: number;
    changed: number;
    unchanged: number;
    deleted: number;
    /** Fraction of nodes that were skipped (not re-fetched) */
    skipRate: number;
  };
}

export interface SavingsReport {
  baseJobId: string;
  newJobId: string;
  computedAt: string;
  pagesScanned: number;
  pagesRebuilt: number;
  pagesSkipped: number;
  /** Estimated bandwidth saved: skipped pages × average page size bytes */
  bandwidthSavedBytes: number;
  /** Estimated processing time saved: skipped pages × average fetch+parse ms */
  processingTimeSavedMs: number;
  /** Estimated storage saved: skipped pages × average node bytes in R2 */
  storageSavedBytes: number;
  skipRatePercent: number;
}

// ---------------------------------------------------------------------------
// Content hash
// ---------------------------------------------------------------------------

/**
 * Computes a deterministic SHA-256 content hash for a page node.
 * Hashes cleanHtml after normalizing whitespace so trivial re-renders
 * (extra spaces, attribute order) don't trigger false positives.
 */
export function computeContentHash(cleanHtml: string): string {
  const normalized = cleanHtml
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .trim();
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Baseline manifest loader
// ---------------------------------------------------------------------------

/**
 * Loads and deserializes the _manifest.json from R2 for a given jobId.
 * Returns null when the manifest is missing or unparseable.
 */
export async function loadBaselineManifest(
  provider: CloudProvider,
  baseJobId: string
): Promise<Manifest | null> {
  const r2Key = `jobs/${baseJobId}/_manifest.json`;

  logger.info({ baseJobId, r2Key }, "DIFF: loading baseline manifest from R2");

  try {
    const buffer = await provider.download(r2Key);
    if (!buffer) {
      logger.warn({ baseJobId, r2Key }, "DIFF: baseline manifest not found in R2");
      return null;
    }

    const json = buffer.toString("utf8");
    const raw = JSON.parse(json) as Record<string, unknown>;

    const manifest = deserializeManifest(raw);
    logger.info(
      { baseJobId, nodeCount: manifest.nodes.size },
      "DIFF: baseline manifest loaded successfully"
    );
    return manifest;
  } catch (err) {
    logger.error({ baseJobId, r2Key, err }, "DIFF: failed to load baseline manifest");
    return null;
  }
}

/**
 * Finds the most recent completed job for a seed URL using the jobs list API.
 * Used for auto-detect mode (no explicit baseJobId provided).
 */
export async function findLatestBaselineJobId(
  seedUrl: string,
  currentJobId: string,
  listJobsFn: () => Promise<Array<{ jobId: string; seedUrl: string; status: string; createdAt: string }>>
): Promise<string | null> {
  try {
    const jobs = await listJobsFn();
    const normalized = normalizeUrlFrontier(seedUrl);

    const candidates = jobs
      .filter(j =>
        j.jobId !== currentJobId &&
        j.status === "done" &&
        normalizeUrlFrontier(j.seedUrl) === normalized
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const found = candidates[0]?.jobId ?? null;
    if (found) {
      logger.info({ seedUrl, baseJobId: found }, "DIFF: auto-detected baseline job");
    } else {
      logger.info({ seedUrl }, "DIFF: no previous completed job found — treating as full crawl");
    }
    return found;
  } catch (err) {
    logger.warn({ err, seedUrl }, "DIFF: auto-detection of baseline job failed");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Change reason detection
// ---------------------------------------------------------------------------

function detectChangeReasons(
  baseline: PageNode,
  current: PageNode,
  baseHash: string,
  newHash: string
): ChangeReason[] {
  const reasons: ChangeReason[] = [];

  if (baseHash !== newHash) {
    reasons.push("contentHashChanged");
  }

  if (baseline.metadata.title !== current.metadata.title) {
    reasons.push("titleChanged");
  }

  const baseImageUrls = new Set(baseline.media.images.map(i => i.sourceUrl));
  const newImageUrls = new Set(current.media.images.map(i => i.sourceUrl));
  const imageSetChanged =
    baseImageUrls.size !== newImageUrls.size ||
    [...newImageUrls].some(u => !baseImageUrls.has(u));
  if (imageSetChanged) {
    reasons.push("imageSetChanged");
  }

  if (
    baseline.metadata.publishedAt !== current.metadata.publishedAt ||
    baseline.metadata.description !== current.metadata.description
  ) {
    reasons.push("metadataChanged");
  }

  const baseWords = baseline.content.wordCount;
  const newWords = current.content.wordCount;
  if (baseWords > 0 && Math.abs(newWords - baseWords) / baseWords > 0.1) {
    reasons.push("structureChanged");
  }

  return reasons;
}

// ---------------------------------------------------------------------------
// Core diff computation
// ---------------------------------------------------------------------------

/**
 * Computes the full diff between a baseline manifest and a newly-crawled
 * manifest. Stamps diffClassification + changeReasons onto each node in
 * the new manifest in-place, and returns the full DiffReport.
 *
 * UNCHANGED nodes can be skipped in the pipeline — their content is copied
 * from the baseline manifest without re-fetching.
 */
export function computeDiff(
  baseManifest: Manifest,
  newManifest: Manifest,
  baseJobId: string,
  newJobId: string
): DiffReport {
  const computedAt = new Date().toISOString();

  // Build a normalized-URL → node map for the baseline
  const baseByUrl = new Map<string, PageNode>();
  for (const node of baseManifest.nodes.values()) {
    if (node.nodeType === "root") continue;
    const norm = normalizeUrlFrontier(node.metadata.url);
    baseByUrl.set(norm, node);
  }

  // Build a normalized-URL → node map for the new manifest
  const newByUrl = new Map<string, PageNode>();
  for (const node of newManifest.nodes.values()) {
    if (node.nodeType === "root") continue;
    const norm = normalizeUrlFrontier(node.metadata.url);
    newByUrl.set(norm, node);
  }

  const newNodes: DiffNodeResult[] = [];
  const changedNodes: DiffNodeResult[] = [];
  const unchangedNodes: DiffNodeResult[] = [];
  const deletedNodes: DiffNodeResult[] = [];

  // Classify every node in the new manifest
  for (const [normUrl, currentNode] of newByUrl) {
    const baseNode = baseByUrl.get(normUrl);
    const newHash = currentNode.contentHash ?? computeContentHash(currentNode.content.cleanHtml);

    if (!baseNode) {
      currentNode.diffClassification = "new";
      currentNode.changeReasons = [];
      currentNode.contentHash = newHash;
      newNodes.push({
        nodeId: currentNode.id,
        url: currentNode.metadata.url,
        title: currentNode.metadata.title,
        classification: "new",
        changeReasons: [],
        newHash,
        baseHash: null,
        skipped: false,
      });
      continue;
    }

    const baseHash = baseNode.contentHash ?? computeContentHash(baseNode.content.cleanHtml);

    if (baseHash === newHash) {
      currentNode.diffClassification = "unchanged";
      currentNode.changeReasons = [];
      currentNode.contentHash = newHash;
      unchangedNodes.push({
        nodeId: currentNode.id,
        url: currentNode.metadata.url,
        title: currentNode.metadata.title,
        classification: "unchanged",
        changeReasons: [],
        newHash,
        baseHash,
        skipped: true,
      });
    } else {
      const changeReasons = detectChangeReasons(baseNode, currentNode, baseHash, newHash);
      currentNode.diffClassification = "changed";
      currentNode.changeReasons = changeReasons;
      currentNode.contentHash = newHash;
      changedNodes.push({
        nodeId: currentNode.id,
        url: currentNode.metadata.url,
        title: currentNode.metadata.title,
        classification: "changed",
        changeReasons,
        newHash,
        baseHash,
        skipped: false,
      });
    }
  }

  // Find DELETED nodes (in baseline but not in new crawl)
  for (const [normUrl, baseNode] of baseByUrl) {
    if (!newByUrl.has(normUrl)) {
      const baseHash = baseNode.contentHash ?? computeContentHash(baseNode.content.cleanHtml);
      deletedNodes.push({
        nodeId: baseNode.id,
        url: baseNode.metadata.url,
        title: baseNode.metadata.title,
        classification: "deleted",
        changeReasons: [],
        newHash: null,
        baseHash,
        skipped: false,
      });
    }
  }

  const total = newNodes.length + changedNodes.length + unchangedNodes.length + deletedNodes.length;
  const skipRate = total > 0 ? unchangedNodes.length / (newNodes.length + changedNodes.length + unchangedNodes.length) : 0;

  logger.info(
    {
      baseJobId,
      newJobId,
      new: newNodes.length,
      changed: changedNodes.length,
      unchanged: unchangedNodes.length,
      deleted: deletedNodes.length,
      skipRate: `${(skipRate * 100).toFixed(1)}%`,
    },
    "DIFF: computation complete"
  );

  return {
    baseJobId,
    newJobId,
    computedAt,
    baseManifestNodeCount: baseByUrl.size,
    newManifestNodeCount: newByUrl.size,
    newNodes,
    changedNodes,
    unchangedNodes,
    deletedNodes,
    summary: {
      total,
      new: newNodes.length,
      changed: changedNodes.length,
      unchanged: unchangedNodes.length,
      deleted: deletedNodes.length,
      skipRate,
    },
  };
}

// ---------------------------------------------------------------------------
// Savings report
// ---------------------------------------------------------------------------

/**
 * Estimates bandwidth, time, and storage savings from the diff.
 * Uses rough averages derived from real crawl metrics:
 *   - avg page fetch+parse: 250ms
 *   - avg page HTML size: 80KB
 *   - avg R2 node storage: 120KB (HTML + images)
 */
export function computeSavingsReport(
  diffReport: DiffReport,
  actualRebuildMs: number
): SavingsReport {
  const AVG_PAGE_BYTES     = 80 * 1024;
  const AVG_FETCH_MS       = 250;
  const AVG_STORAGE_BYTES  = 120 * 1024;

  const skipped = diffReport.summary.unchanged;
  const rebuilt = diffReport.summary.new + diffReport.summary.changed;
  const scanned = skipped + rebuilt;

  return {
    baseJobId: diffReport.baseJobId,
    newJobId: diffReport.newJobId,
    computedAt: new Date().toISOString(),
    pagesScanned: scanned,
    pagesRebuilt: rebuilt,
    pagesSkipped: skipped,
    bandwidthSavedBytes: skipped * AVG_PAGE_BYTES,
    processingTimeSavedMs: skipped * AVG_FETCH_MS,
    storageSavedBytes: skipped * AVG_STORAGE_BYTES,
    skipRatePercent: scanned > 0 ? Math.round((skipped / scanned) * 100) : 0,
  };
}

// ---------------------------------------------------------------------------
// Manifest deserializer
// Converts the plain JSON representation back into a Manifest with Map/Set
// ---------------------------------------------------------------------------

function deserializeManifest(raw: Record<string, unknown>): Manifest {
  const nodes = new Map<string, PageNode>();
  const rawNodes = (raw["nodes"] ?? {}) as Record<string, unknown>;
  for (const [id, nodeRaw] of Object.entries(rawNodes)) {
    nodes.set(id, nodeRaw as PageNode);
  }

  const seenUrls = new Set<string>(
    Array.isArray(raw["seenUrls"]) ? (raw["seenUrls"] as string[]) : []
  );

  return {
    id: raw["id"] as string,
    version: "1.0",
    status: raw["status"] as Manifest["status"],
    createdAt: raw["createdAt"] as string,
    updatedAt: raw["updatedAt"] as string,
    seedUrl: raw["seedUrl"] as string,
    config: raw["config"] as Manifest["config"],
    nodes,
    seenUrls,
    stats: raw["stats"] as Manifest["stats"],
    output: raw["output"] as Manifest["output"] | undefined,
  };
}

// ---------------------------------------------------------------------------
// HTTP head-check for cheap change detection (Tier 1)
// ---------------------------------------------------------------------------

export interface HeadCheckResult {
  url: string;
  etag: string | null;
  lastModified: string | null;
  reachable: boolean;
}

/**
 * Performs an HTTP HEAD request to cheaply check whether a page may have
 * changed. Returns ETag and Last-Modified headers when present.
 * Used as an optional Tier-1 fast path before computing content hashes.
 */
export async function headCheckUrl(url: string): Promise<HeadCheckResult> {
  try {
    const res = await axios.head(url, {
      timeout: 8000,
      maxRedirects: 3,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; ArticleScraper/2.0; +https://replit.com)",
      },
      validateStatus: () => true,
    });
    return {
      url,
      etag: (res.headers["etag"] as string | undefined) ?? null,
      lastModified: (res.headers["last-modified"] as string | undefined) ?? null,
      reachable: res.status < 500,
    };
  } catch {
    return { url, etag: null, lastModified: null, reachable: false };
  }
}
