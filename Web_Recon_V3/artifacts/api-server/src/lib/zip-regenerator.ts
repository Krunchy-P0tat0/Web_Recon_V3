/**
 * zip-regenerator.ts — Manifest-driven ZIP regeneration for completed scrape jobs.
 *
 * Rebuilds a fully-structured ZIP archive from a persisted manifest, sourcing
 * each file from:
 *
 *   1. Reconstruction   — HTML nodes (always via buildArticleHtml + cleanHtml),
 *                         embed/audio JSON (always from MediaItem fields),
 *                         root index.html (via renderIndexHtml)
 *   2. Cloud (R2)       — images/videos uploaded by r2-executor
 *   3. Re-fetch         — re-download from original sourceUrl (optional, configurable)
 *   4. Missing          — recorded in report, absent from output archive
 *
 * Resumable support:
 *   A previous RegenerationReport is optionally passed in. Assets that were
 *   already successfully recovered ("reconstructed" | "cloud" | "refetched") are
 *   skipped and counted toward the new report without re-processing.
 *
 * Contract:
 *   - NEVER modifies manifest node/media status fields
 *   - NEVER mutates manifest.output (caller responsibility)
 *   - All regeneration state lives in RegenerationReport only
 *   - Failures are non-fatal: ZIP contains whatever assets are available
 *   - Deterministic: same manifest + same assets → same ZIP structure
 */

import { createRequire } from "module";
import axios from "axios";
import fs from "fs";
import path from "path";
import { logger } from "./logger";
import { defaultLocalProvider } from "./storage-provider";
import { getR2Config } from "../cloud/r2.provider";
import { buildArticleHtml } from "./renderer";
import { renderIndexHtml } from "./renderer";
import { getOrderedNodes } from "./manifest";
import type { Manifest, PageNode, MediaItem } from "./manifest";
import type { ArticleLink } from "./scraper";

const require = createRequire(import.meta.url);
const { ZipArchive } = require("archiver") as {
  ZipArchive: new (opts?: Record<string, unknown>) => import("stream").Transform & {
    append: (source: unknown, data: { name: string }) => void;
    finalize: () => Promise<void>;
    abort: () => void;
  };
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Where a recovered asset came from. */
export type AssetSource =
  | "reconstructed"   // HTML from cleanHtml or embed JSON from MediaItem fields
  | "cloud"           // fetched from R2 public URL
  | "refetched"       // re-downloaded from original sourceUrl
  | "missing"         // asset could not be recovered
  | "failed";         // attempted but threw

export interface AssetRecoveryRecord {
  localPath: string;
  cloudPath: string;
  sourceUrl: string;
  source: AssetSource;
  bytes: number;
  durationMs: number;
  error: string | null;
}

export interface RegenerationReport {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  outputZipPath: string;
  totalAssets: number;
  reconstructed: number;
  restoredFromCloud: number;
  reFetched: number;
  missing: number;
  failed: number;
  cloudFallbacksUsed: number;
  assets: AssetRecoveryRecord[];
  valid: boolean;
  /** true if a previous partial report was reused to skip already-recovered assets */
  resumed: boolean;
}

export interface RegenerationOptions {
  /** Allow re-downloading assets from their original sourceUrl as last resort. Default: false */
  allowReFetch?: boolean;
  /** Skip cloud fetch and only use local sources. Default: false */
  skipCloudFallback?: boolean;
  /** Concurrent asset fetch limit for cloud/refetch. Default: 4 */
  concurrency?: number;
  /** Pass previous report to resume from. Already-recovered assets are skipped. */
  previousReport?: RegenerationReport;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derives the "../"-chain needed to navigate from a node's localPath
 * back to the archive root. Mirrors the private function in scraper.ts.
 *
 * Example: "content/page-001/slug/index.html" → "../../../"
 */
function deriveRelativeRoot(localPath: string): string {
  const depth = localPath.split("/").length - 1;
  return "../".repeat(depth);
}

/**
 * Extracts the pageKey segment from a content node's localPath.
 * "content/page-001/slug/index.html" → "page-001"
 * Falls back to "articles" for non-content nodes.
 */
function extractPageKey(localPath: string): string {
  const parts = localPath.split("/");
  if (parts.length >= 3 && parts[0] === "content") return parts[1];
  return "articles";
}

/**
 * Reconstructs an ArticleLink from a PageNode for use with buildArticleHtml.
 */
function articleLinkFromNode(node: PageNode): ArticleLink {
  return {
    url: node.metadata.url,
    title: node.metadata.title,
    description: null,
    publishedAt: node.metadata.publishedAt,
    pageNumber: node.relationships.paginationIndex ?? null,
    pageLabel: node.relationships.paginationIndex
      ? `Page ${node.relationships.paginationIndex}`
      : null,
  };
}

/**
 * Reconstructs the embed/audio JSON payload from a MediaItem.
 * Mirrors the structure produced by buildEmbedManifestEntry in embed-extractor.ts.
 */
function reconstructEmbedJson(vid: MediaItem, sourceNodePath: string): string {
  const entry = {
    schemaVersion: "1.0",
    provider: vid.provider ?? "unknown",
    mediaType: vid.mediaClassification,
    embedUrl: vid.sourceUrl,
    canonicalUrl: vid.canonicalUrl,
    thumbnailUrl: vid.thumbnailUrl,
    title: vid.altText,
    durationSeconds: vid.durationSeconds,
    width: vid.dimensions?.width ?? vid.htmlWidth ?? null,
    height: vid.dimensions?.height ?? vid.htmlHeight ?? null,
    sourceElement: vid.sourceElement ?? "unknown",
    sourceNodePath,
    extractedAt: new Date().toISOString(),
    _regenerated: true,
    _regeneratedAt: new Date().toISOString(),
  };
  return JSON.stringify(entry, null, 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Asset resolution — cloud fetch
// ---------------------------------------------------------------------------

async function fetchFromCloud(
  publicUrl: string,
  maxAttempts = 3
): Promise<Buffer | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await axios.get<ArrayBuffer>(publicUrl, {
        responseType: "arraybuffer",
        timeout: 20000,
        headers: { "User-Agent": "ArticleScraper/RegenBot" },
        validateStatus: (s) => s === 200,
      });
      return Buffer.from(resp.data);
    } catch (err) {
      const status = axios.isAxiosError(err) ? (err.response?.status ?? 0) : 0;
      const permanent = status === 404 || status === 403;
      if (permanent || attempt === maxAttempts) return null;
      await sleep(500 * attempt);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Asset resolution — re-fetch from sourceUrl
// ---------------------------------------------------------------------------

async function fetchFromSource(url: string): Promise<Buffer | null> {
  try {
    const resp = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 20000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    return Buffer.from(resp.data);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-asset resolution pipeline
// ---------------------------------------------------------------------------

interface AssetResolutionTask {
  localPath: string;
  cloudPath: string;
  sourceUrl: string;
  kind: "image" | "video" | "audio" | "embed";
}

interface AssetResolutionResult {
  buffer: Buffer | null;
  source: AssetSource;
  error: string | null;
}

async function resolveAsset(
  task: AssetResolutionTask,
  options: RegenerationOptions,
  r2PublicBaseUrl: string | null
): Promise<AssetResolutionResult> {
  const { cloudPath, sourceUrl } = task;

  // Try cloud (R2) first — fastest and most reliable for completed jobs
  if (!options.skipCloudFallback && r2PublicBaseUrl && cloudPath) {
    const publicUrl = `${r2PublicBaseUrl.replace(/\/$/, "")}/${cloudPath}`;
    try {
      const buf = await fetchFromCloud(publicUrl);
      if (buf && buf.length > 0) {
        return { buffer: buf, source: "cloud", error: null };
      }
    } catch (err) {
      logger.debug({ cloudPath, err }, "REGEN: cloud fetch threw");
    }
  }

  // Re-fetch from original sourceUrl (optional)
  if (options.allowReFetch && sourceUrl) {
    try {
      const buf = await fetchFromSource(sourceUrl);
      if (buf && buf.length > 0) {
        return { buffer: buf, source: "refetched", error: null };
      }
    } catch (err) {
      logger.debug({ sourceUrl, err }, "REGEN: source re-fetch threw");
    }
  }

  return {
    buffer: null,
    source: "missing",
    error: `Asset not recoverable (cloudPath="${cloudPath}", sourceUrl="${sourceUrl}")`,
  };
}

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------

async function pooled<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, worker)
  );
  return results;
}

// ---------------------------------------------------------------------------
// Main regeneration function
// ---------------------------------------------------------------------------

/**
 * Rebuilds a ZIP archive from a persisted manifest.
 *
 * All assets are sourced from the manifest's persistent record — no database
 * calls, no original scrape pipeline involvement. The output ZIP preserves
 * the original semantic directory structure exactly:
 *   content/           — article HTML
 *   images/            — downloaded images (from cloud or re-fetch)
 *   embeds/            — embed JSON metadata (reconstructed)
 *   audio/             — audio JSON metadata (reconstructed)
 *   videos/            — video assets
 *   index.html         — root article index (re-rendered)
 *   _manifest.json     — portable manifest export
 *
 * @param jobId         Job ID (used for logging and report identity)
 * @param manifest      Fully loaded manifest (must have status complete/partial)
 * @param outputZipPath Absolute path where the regenerated ZIP will be written
 * @param options       Resolution strategy options
 */
export async function regenerateZipFromManifest(
  jobId: string,
  manifest: Manifest,
  outputZipPath: string,
  options: RegenerationOptions = {}
): Promise<RegenerationReport> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const concurrency = options.concurrency ?? 4;

  const r2Config = getR2Config();
  const r2PublicBaseUrl = r2Config?.publicBaseUrl ?? null;

  // Build set of already-recovered localPaths from previous report (resume support)
  const previouslyRecovered = new Set<string>();
  if (options.previousReport?.assets) {
    for (const a of options.previousReport.assets) {
      if (a.source !== "missing" && a.source !== "failed") {
        previouslyRecovered.add(a.localPath);
      }
    }
  }
  const resumed = previouslyRecovered.size > 0;

  logger.info(
    {
      jobId,
      manifestStatus: manifest.status,
      nodeCount: manifest.nodes.size,
      outputZipPath,
      r2Configured: r2PublicBaseUrl !== null,
      allowReFetch: options.allowReFetch ?? false,
      skipCloudFallback: options.skipCloudFallback ?? false,
      resumed,
      previouslyRecovered: previouslyRecovered.size,
    },
    "REGEN: starting ZIP regeneration from manifest"
  );

  // ── Ensure output directory exists ────────────────────────────────────────
  await fs.promises.mkdir(path.dirname(outputZipPath), { recursive: true });

  // ── Set up archive ────────────────────────────────────────────────────────
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const writeStream = fs.createWriteStream(outputZipPath);

  const archiveReady = new Promise<void>((resolve, reject) => {
    writeStream.on("close", resolve);
    writeStream.on("error", reject);
    archive.on("error", reject);
  });

  archive.pipe(writeStream);

  // ── Per-asset tracking ────────────────────────────────────────────────────
  const assetRecords: AssetRecoveryRecord[] = [];

  function recordAsset(
    localPath: string,
    cloudPath: string,
    sourceUrl: string,
    source: AssetSource,
    bytes: number,
    durationMs: number,
    error: string | null
  ): void {
    assetRecords.push({ localPath, cloudPath, sourceUrl, source, bytes, durationMs, error });
  }

  // ── Phase R1: Reconstruct HTML nodes ─────────────────────────────────────
  // HTML is always reconstructible from node.content.cleanHtml + metadata.
  // This phase is synchronous — no I/O, just string rendering + archive append.

  const orderedNodes = getOrderedNodes(manifest).filter(
    (n) => n.nodeType !== "root"
  );

  for (const node of orderedNodes) {
    const t0 = Date.now();
    const localPath = node.storage.localPath;
    if (!localPath) continue;

    if (previouslyRecovered.has(localPath)) {
      recordAsset(localPath, node.storage.cloudPath, node.metadata.url, "reconstructed", 0, 0, null);
      continue;
    }

    try {
      const article = articleLinkFromNode(node);
      const pageKey = extractPageKey(localPath);
      const relRoot = deriveRelativeRoot(localPath);
      const html = buildArticleHtml(
        node.metadata.title,
        node.content.cleanHtml,
        article,
        pageKey,
        relRoot
      );
      const buf = Buffer.from(html, "utf8");
      archive.append(buf, { name: localPath });
      recordAsset(localPath, node.storage.cloudPath, node.metadata.url, "reconstructed", buf.length, Date.now() - t0, null);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      recordAsset(localPath, node.storage.cloudPath, node.metadata.url, "failed", 0, Date.now() - t0, errMsg);
      logger.warn({ jobId, localPath, err }, "REGEN: HTML reconstruction failed");
    }
  }

  // ── Phase R2: Reconstruct embed/audio JSON ────────────────────────────────
  // Embed metadata JSON is reconstructible from MediaItem fields at any time.

  for (const node of orderedNodes) {
    for (const vid of node.media.videos) {
      const t0 = Date.now();
      const localPath = vid.storage.localPath;
      const isEmbedOrAudio =
        vid.mediaClassification === "embed" || vid.mediaClassification === "audio";

      if (!isEmbedOrAudio || !localPath) continue;
      if (previouslyRecovered.has(localPath)) {
        recordAsset(localPath, vid.storage.cloudPath, vid.sourceUrl, "reconstructed", 0, 0, null);
        continue;
      }

      try {
        const json = reconstructEmbedJson(vid, node.storage.localPath);
        const buf = Buffer.from(json, "utf8");
        archive.append(buf, { name: localPath });
        recordAsset(localPath, vid.storage.cloudPath, vid.sourceUrl, "reconstructed", buf.length, Date.now() - t0, null);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        recordAsset(localPath, vid.storage.cloudPath, vid.sourceUrl, "failed", 0, Date.now() - t0, errMsg);
        logger.warn({ jobId, localPath, err }, "REGEN: embed JSON reconstruction failed");
      }
    }
  }

  // ── Phase R3: Resolve image and downloadable video assets ─────────────────
  // These were downloaded during Phase 2 of the original scrape and must be
  // sourced from cloud storage or re-fetched.

  interface ResolvableAsset {
    node: PageNode;
    media: MediaItem;
    task: AssetResolutionTask;
  }

  const resolvableAssets: ResolvableAsset[] = [];

  for (const node of orderedNodes) {
    for (const img of node.media.images) {
      if (img.status !== "rendered" && img.status !== "downloaded") continue;
      const localPath = img.storage.localPath;
      if (!localPath) continue;
      if (previouslyRecovered.has(localPath)) {
        recordAsset(localPath, img.storage.cloudPath, img.sourceUrl, "cloud", 0, 0, null);
        continue;
      }
      resolvableAssets.push({
        node,
        media: img,
        task: {
          localPath,
          cloudPath: img.storage.cloudPath,
          sourceUrl: img.sourceUrl,
          kind: "image",
        },
      });
    }

    for (const vid of node.media.videos) {
      if (vid.mediaClassification === "embed" || vid.mediaClassification === "audio") continue;
      if (vid.status !== "rendered" && vid.status !== "downloaded") continue;
      const localPath = vid.storage.localPath;
      if (!localPath) continue;
      if (previouslyRecovered.has(localPath)) {
        recordAsset(localPath, vid.storage.cloudPath, vid.sourceUrl, "cloud", 0, 0, null);
        continue;
      }
      resolvableAssets.push({
        node,
        media: vid,
        task: {
          localPath,
          cloudPath: vid.storage.cloudPath,
          sourceUrl: vid.sourceUrl,
          kind: vid.mediaClassification === "video" ? "video" : "audio",
        },
      });
    }
  }

  logger.info(
    { jobId, resolvableCount: resolvableAssets.length, concurrency },
    "REGEN: resolving cloud/refetch assets"
  );

  await pooled(
    resolvableAssets.map(({ task, media }) => async () => {
      const t0 = Date.now();
      const result = await resolveAsset(task, options, r2PublicBaseUrl);

      if (result.buffer) {
        archive.append(result.buffer, { name: task.localPath });
        recordAsset(
          task.localPath,
          task.cloudPath,
          task.sourceUrl,
          result.source,
          result.buffer.length,
          Date.now() - t0,
          null
        );
        logger.debug(
          { localPath: task.localPath, source: result.source, bytes: result.buffer.length },
          "REGEN: asset resolved"
        );
      } else {
        recordAsset(
          task.localPath,
          task.cloudPath,
          task.sourceUrl,
          result.source,
          0,
          Date.now() - t0,
          result.error
        );
        logger.debug(
          { localPath: task.localPath, mediaId: media.id, error: result.error },
          "REGEN: asset missing — excluded from archive"
        );
      }
    }),
    concurrency
  );

  // ── Phase R4: Render root index.html ──────────────────────────────────────
  {
    const t0 = Date.now();
    const indexLocalPath = "index.html";
    try {
      const renderResult = renderIndexHtml(manifest, orderedNodes.length, []);
      const buf = Buffer.from(renderResult.html, "utf8");
      archive.append(buf, { name: indexLocalPath });
      recordAsset(indexLocalPath, `jobs/${jobId}/index.html`, "", "reconstructed", buf.length, Date.now() - t0, null);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      recordAsset(indexLocalPath, `jobs/${jobId}/index.html`, "", "failed", 0, Date.now() - t0, errMsg);
      logger.warn({ jobId, err }, "REGEN: index.html render failed");
    }
  }

  // ── Phase R5: Write portable manifest JSON ────────────────────────────────
  {
    const t0 = Date.now();
    const manifestLocalPath = "_manifest.json";
    try {
      const { renderManifestJson } = await import("./manifest-export");
      const json = renderManifestJson(manifest);
      const buf = Buffer.from(json, "utf8");
      archive.append(buf, { name: manifestLocalPath });
      recordAsset(manifestLocalPath, `jobs/${jobId}/_manifest.json`, "", "reconstructed", buf.length, Date.now() - t0, null);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      recordAsset(manifestLocalPath, `jobs/${jobId}/_manifest.json`, "", "failed", 0, Date.now() - t0, errMsg);
      logger.warn({ jobId, err }, "REGEN: manifest JSON write failed");
    }
  }

  // ── Finalize archive ──────────────────────────────────────────────────────
  archive.finalize();
  await archiveReady;

  // ── Build report ──────────────────────────────────────────────────────────
  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;

  let reconstructed = 0;
  let restoredFromCloud = 0;
  let reFetched = 0;
  let missing = 0;
  let failed = 0;
  let cloudFallbacksUsed = 0;

  for (const a of assetRecords) {
    switch (a.source) {
      case "reconstructed": reconstructed++; break;
      case "cloud":         restoredFromCloud++; cloudFallbacksUsed++; break;
      case "refetched":     reFetched++; break;
      case "missing":       missing++; break;
      case "failed":        failed++; break;
    }
  }

  const valid = failed === 0;

  const report: RegenerationReport = {
    jobId,
    startedAt,
    completedAt,
    durationMs,
    outputZipPath,
    totalAssets: assetRecords.length,
    reconstructed,
    restoredFromCloud,
    reFetched,
    missing,
    failed,
    cloudFallbacksUsed,
    assets: assetRecords,
    valid,
    resumed,
  };

  const logFn = valid ? logger.info.bind(logger) : logger.warn.bind(logger);
  logFn(
    {
      jobId,
      totalAssets: assetRecords.length,
      reconstructed,
      restoredFromCloud,
      reFetched,
      missing,
      failed,
      cloudFallbacksUsed,
      durationMs,
      valid,
      outputZipPath,
    },
    valid
      ? "REGEN: ZIP regeneration complete — all assets recovered"
      : "REGEN: ZIP regeneration complete — some assets missing (see report)"
  );

  return report;
}

// ---------------------------------------------------------------------------
// ZIP path utilities
// ---------------------------------------------------------------------------

/** Returns the canonical path for a regenerated ZIP. */
export function regeneratedZipPath(jobId: string): string {
  return defaultLocalProvider.resolvePath(`${jobId}-regen.zip`);
}

/** Returns true if a regenerated ZIP currently exists on disk. */
export function regeneratedZipExists(jobId: string): boolean {
  try {
    const p = regeneratedZipPath(jobId);
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}
