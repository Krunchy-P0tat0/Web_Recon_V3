/**
 * recovery-engine.ts — Phase 1.5.3: Targeted Recovery Crawl
 *
 * Recovers failed pages from an existing completed job by:
 *   1. Loading the manifest from R2 for the target job
 *   2. Identifying all nodes with status === "error"
 *   3. Stream-fetching each failed URL with a raised 50 MB limit
 *      (bypasses the original 10 MB axios cap that caused /ccl-corporate/ to fail)
 *   4. Extracting clean HTML body content with cheerio
 *   5. Uploading recovered HTML artifacts to R2 at the node's cloudPath
 *   6. Updating node status to "complete" and re-uploading the manifest JSON
 *   7. Returning a full reconciliation report
 *
 * Runs completely independently of the main scrape pipeline.
 * Does NOT start a new job, modify the DB job record, or affect any
 * in-progress scrape workers.
 */

import axios from "axios";
import * as cheerio from "cheerio";
import { logger } from "./logger";
import { fromPortableManifest, renderManifestJson } from "./manifest-export";
import type { PortableManifest } from "./manifest-export";
import { buildArticleHtml } from "./renderer";
import type { CloudProvider } from "../cloud/provider";
import type { ArticleLink } from "./scraper";

// ---------------------------------------------------------------------------
// Public report types
// ---------------------------------------------------------------------------

export interface RecoveredNode {
  nodeId: string;
  url: string;
  cloudPath: string;
  bytesFetched: number;
  bytesUploaded: number;
  fetchDurationMs: number;
  uploadDurationMs: number;
}

export interface FailedRecovery {
  nodeId: string;
  url: string;
  error: string;
  phase: "fetch" | "extract" | "upload";
}

export interface RecoveryReport {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  failedNodeCount: number;
  recoveredCount: number;
  stillFailedCount: number;
  recovered: RecoveredNode[];
  failed: FailedRecovery[];
  manifestUpdated: boolean;
  coverageBefore: number;
  coverageAfter: number;
  totalNodes: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Raised byte limit for recovery — handles pages far larger than the standard 10 MB cap */
const RECOVERY_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

const BROWSER_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

// ---------------------------------------------------------------------------
// Streaming fetch — bypasses the 10 MB axios buffer cap
// ---------------------------------------------------------------------------

/**
 * Fetches a URL as a stream, collecting chunks until `maxBytes` is reached.
 * Never allocates the full response body as a single buffer before it is
 * needed — avoids the double-buffer OOM that hits the axios buffered mode.
 */
async function streamFetchPage(
  url: string,
  maxBytes = RECOVERY_MAX_BYTES
): Promise<{ html: string; bytesFetched: number }> {
  const response = await axios.get<import("stream").Readable>(url, {
    responseType: "stream",
    timeout: 90_000,
    maxRedirects: 10,
    headers: BROWSER_HEADERS,
    decompress: true,
  });

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    response.data.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        response.data.destroy();
        reject(
          new Error(
            `Page too large: ${(totalBytes / 1024 / 1024).toFixed(1)} MB exceeds ${maxBytes / 1024 / 1024} MB limit`
          )
        );
        return;
      }
      chunks.push(buf);
    });

    response.data.on("end", () => {
      const html = Buffer.concat(chunks).toString("utf-8");
      resolve({ html, bytesFetched: totalBytes });
    });

    response.data.on("error", (err: Error) => {
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

/**
 * Extracts clean body HTML from raw HTML using cheerio.
 * Matches the main scraper's approach: removes scripts, styles, cookie banners,
 * and iframes while preserving full body content.
 */
function extractBodyHtml(rawHtml: string): { title: string; bodyHtml: string } {
  const $ = cheerio.load(rawHtml);

  const title =
    $("h1").first().text().trim() ||
    $("title").text().trim() ||
    "Untitled";

  const $body = $("body");
  $body
    .find("script, style, noscript, iframe, [class*='cookie-banner'], [class*='cookie-notice']")
    .remove();

  return {
    title,
    bodyHtml: $.html($body),
  };
}

// ---------------------------------------------------------------------------
// Path utilities (mirrors helpers in r2-executor.ts)
// ---------------------------------------------------------------------------

function derivePageKey(localPath: string): string {
  const parts = localPath.split("/");
  return parts.length >= 2 && parts[0] === "content" ? parts[1] : "articles";
}

function deriveRelRoot(localPath: string): string {
  const depth = localPath.split("/").length - 1;
  return "../".repeat(depth);
}

// ---------------------------------------------------------------------------
// Main recovery entry point
// ---------------------------------------------------------------------------

/**
 * Runs a targeted recovery crawl for a completed job's failed pages.
 *
 * @param jobId    The job to recover — must have a manifest at jobs/{jobId}/_manifest.json
 * @param provider A configured CloudProvider instance (R2, local, etc.)
 *
 * @returns A RecoveryReport describing what was recovered, what still failed,
 *          and the updated coverage percentages.
 *
 * Throws only if the manifest cannot be loaded from R2.
 * All per-node failures are captured in `report.failed` — the function does not throw for them.
 */
export async function recoverFailedPages(
  jobId: string,
  provider: CloudProvider
): Promise<RecoveryReport> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  logger.info(
    { jobId, provider: provider.providerName },
    "RECOVERY: starting Phase 1.5.3 targeted recovery crawl"
  );

  // ── 1. Load manifest from R2 ─────────────────────────────────────────────
  const manifestKey = `jobs/${jobId}/_manifest.json`;

  const manifestBuffer = await provider.download(manifestKey);
  if (!manifestBuffer) {
    throw new Error(`Manifest not found in R2 at key: ${manifestKey}`);
  }

  let portable: PortableManifest;
  try {
    portable = JSON.parse(manifestBuffer.toString("utf-8")) as PortableManifest;
  } catch (parseErr) {
    throw new Error(
      `Failed to parse manifest JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
    );
  }

  const manifest = fromPortableManifest(portable);
  const allNodes = Array.from(manifest.nodes.values());
  const contentNodes = allNodes.filter((n) => n.nodeType !== "root");
  const totalNodes = contentNodes.length;

  // ── 2. Identify failed nodes ─────────────────────────────────────────────
  const failedNodes = contentNodes.filter((n) => n.status === "error");
  const failedNodeCount = failedNodes.length;

  const completeNodesBefore = contentNodes.filter((n) => n.status === "complete").length;
  const coverageBefore =
    totalNodes > 0 ? Math.round((completeNodesBefore / totalNodes) * 100) : 0;

  logger.info(
    { jobId, totalNodes, failedNodeCount, coverageBefore },
    `RECOVERY: found ${failedNodeCount} failed nodes — coverage before: ${coverageBefore}%`
  );

  if (failedNodeCount === 0) {
    return {
      jobId,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      failedNodeCount: 0,
      recoveredCount: 0,
      stillFailedCount: 0,
      recovered: [],
      failed: [],
      manifestUpdated: false,
      coverageBefore,
      coverageAfter: coverageBefore,
      totalNodes,
    };
  }

  // ── 3. Recover each failed node ──────────────────────────────────────────
  const recovered: RecoveredNode[] = [];
  const failed: FailedRecovery[] = [];

  for (const node of failedNodes) {
    const url = node.metadata.url;
    const cloudPath = node.storage.cloudPath;
    const localPath = node.storage.localPath;

    logger.info({ jobId, nodeId: node.id, url, cloudPath }, "RECOVERY: attempting node recovery");

    // Phase A: stream-fetch (raised 50 MB limit)
    let fetchResult: { html: string; bytesFetched: number };
    const fetchStart = Date.now();
    try {
      fetchResult = await streamFetchPage(url);
      logger.info(
        {
          jobId,
          nodeId: node.id,
          url,
          bytes: fetchResult.bytesFetched,
          mb: (fetchResult.bytesFetched / 1024 / 1024).toFixed(2),
        },
        "RECOVERY: fetch succeeded"
      );
    } catch (fetchErr) {
      const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      logger.warn({ jobId, nodeId: node.id, url, err: errMsg }, "RECOVERY: fetch failed");
      failed.push({ nodeId: node.id, url, error: errMsg, phase: "fetch" });
      continue;
    }
    const fetchDurationMs = Date.now() - fetchStart;

    // Phase B: extract body content
    let title: string;
    let bodyHtml: string;
    try {
      ({ title, bodyHtml } = extractBodyHtml(fetchResult.html));
    } catch (extractErr) {
      const errMsg = extractErr instanceof Error ? extractErr.message : String(extractErr);
      logger.warn({ jobId, nodeId: node.id, url, err: errMsg }, "RECOVERY: extraction failed");
      failed.push({ nodeId: node.id, url, error: errMsg, phase: "extract" });
      continue;
    }

    // Phase C: render article HTML and upload to R2
    const pageKey = derivePageKey(localPath);
    const relRoot = deriveRelRoot(localPath);
    const article: ArticleLink = {
      url,
      title: node.metadata.title || title,
      publishedAt: node.metadata.publishedAt,
      pageLabel: null,
      description: null,
    };

    const html = buildArticleHtml(node.metadata.title || title, bodyHtml, article, pageKey, relRoot);
    const htmlBuffer = Buffer.from(html, "utf-8");

    const uploadStart = Date.now();
    try {
      await provider.upload({ key: cloudPath, data: htmlBuffer, checkDuplicate: false });
    } catch (uploadErr) {
      const errMsg = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
      logger.warn(
        { jobId, nodeId: node.id, url, cloudPath, err: errMsg },
        "RECOVERY: upload failed"
      );
      failed.push({ nodeId: node.id, url, error: errMsg, phase: "upload" });
      continue;
    }
    const uploadDurationMs = Date.now() - uploadStart;

    // Update the live manifest node
    node.status = "complete";
    node.content.cleanHtml = bodyHtml;
    const text = bodyHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    node.content.textContent = text;
    node.content.wordCount = text.split(/\s+/).filter(Boolean).length;
    if (!node.metadata.title && title) node.metadata.title = title;
    node.metadata.fetchedAt = new Date().toISOString();

    recovered.push({
      nodeId: node.id,
      url,
      cloudPath,
      bytesFetched: fetchResult.bytesFetched,
      bytesUploaded: htmlBuffer.length,
      fetchDurationMs,
      uploadDurationMs,
    });

    logger.info(
      {
        jobId,
        nodeId: node.id,
        url,
        cloudPath,
        bytesFetched: fetchResult.bytesFetched,
        bytesUploaded: htmlBuffer.length,
        uploadDurationMs,
      },
      "RECOVERY: node successfully recovered"
    );
  }

  // ── 4. Re-upload updated manifest to R2 ─────────────────────────────────
  let manifestUpdated = false;
  if (recovered.length > 0) {
    manifest.updatedAt = new Date().toISOString();

    // Recompute byStatus / byType stats
    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    for (const n of manifest.nodes.values()) {
      byStatus[n.status] = (byStatus[n.status] ?? 0) + 1;
      byType[n.nodeType] = (byType[n.nodeType] ?? 0) + 1;
    }
    // Cast is safe — the keys are exhaustive NodeStatus / NodeType literals
    manifest.stats.byStatus = byStatus as typeof manifest.stats.byStatus;
    manifest.stats.byType = byType as typeof manifest.stats.byType;

    try {
      const updatedJson = renderManifestJson(manifest);
      await provider.upload({
        key: manifestKey,
        data: Buffer.from(updatedJson, "utf-8"),
        checkDuplicate: false,
      });
      manifestUpdated = true;
      logger.info({ jobId, manifestKey }, "RECOVERY: manifest updated and re-uploaded to R2");
    } catch (manifestErr) {
      logger.warn(
        { jobId, manifestKey, err: manifestErr },
        "RECOVERY: failed to re-upload manifest (non-fatal)"
      );
    }
  }

  // ── 5. Compute final coverage and return report ──────────────────────────
  const completeNodesAfter = Array.from(manifest.nodes.values()).filter(
    (n) => n.status === "complete" && n.nodeType !== "root"
  ).length;
  const coverageAfter =
    totalNodes > 0 ? Math.round((completeNodesAfter / totalNodes) * 100) : 0;

  const report: RecoveryReport = {
    jobId,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
    failedNodeCount,
    recoveredCount: recovered.length,
    stillFailedCount: failed.length,
    recovered,
    failed,
    manifestUpdated,
    coverageBefore,
    coverageAfter,
    totalNodes,
  };

  logger.info(
    {
      jobId,
      failedNodeCount,
      recoveredCount: recovered.length,
      stillFailedCount: failed.length,
      coverageBefore,
      coverageAfter,
      durationMs: report.durationMs,
    },
    "RECOVERY: Phase 1.5.3 targeted recovery crawl complete"
  );

  return report;
}
