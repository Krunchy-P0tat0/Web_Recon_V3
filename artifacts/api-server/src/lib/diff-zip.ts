/**
 * diff-zip.ts — Delta and merged ZIP generation for differential crawls
 *
 * Produces two output archives:
 *
 *   delta.zip   — contains ONLY new and changed pages (+ their media).
 *                 Use for quick inspection of what changed between runs.
 *
 *   merged.zip  — contains the complete current site state:
 *                 new + changed pages (fresh content) +
 *                 unchanged pages (copied from baseline R2 artifacts) +
 *                 a fresh index.html and _manifest.json.
 *                 DELETED pages are excluded.
 *
 * The delta ZIP is uploaded to R2 at:
 *   jobs/{newJobId}/_delta.zip
 *
 * The merged ZIP is uploaded to R2 at:
 *   jobs/{newJobId}/_manifest.zip   (replaces the standard ZIP path)
 */

import AdmZip from "adm-zip";
import { logger } from "./logger";
import type { CloudProvider } from "../cloud/provider";
import type { Manifest, PageNode } from "./manifest";
import type { DiffReport } from "./diff-engine";
import { buildArticleHtml, renderIndexHtml } from "./renderer";
import { renderManifestJson } from "./manifest-export";
import type { ArticleLink } from "./scraper";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DiffZipReport {
  newJobId: string;
  baseJobId: string;
  generatedAt: string;

  deltaZip: {
    generated: boolean;
    sizeBytes: number;
    sizeMb: number;
    pagesIncluded: number;
    cloudPath: string | null;
    publicUrl: string | null;
  };

  mergedZip: {
    generated: boolean;
    sizeBytes: number;
    sizeMb: number;
    totalPages: number;
    newPages: number;
    changedPages: number;
    unchangedPages: number;
    deletedPages: number;
    cloudPath: string | null;
    publicUrl: string | null;
  };
}

// ---------------------------------------------------------------------------
// Delta ZIP — new + changed pages only
// ---------------------------------------------------------------------------

/**
 * Builds the delta ZIP: only pages that are NEW or CHANGED in the new crawl.
 * Returns a Buffer containing the ZIP file.
 */
export async function buildDeltaZip(
  newManifest: Manifest,
  diffReport: DiffReport
): Promise<Buffer> {
  const zip = new AdmZip();
  const activeIds = new Set<string>([
    ...diffReport.newNodes.map(n => n.nodeId),
    ...diffReport.changedNodes.map(n => n.nodeId),
  ]);

  let pagesAdded = 0;

  for (const node of newManifest.nodes.values()) {
    if (node.nodeType === "root") continue;
    if (!activeIds.has(node.id)) continue;

    const pageKey = node.storage.localPath.split("/")[1] ?? "articles";
    const relRoot = deriveRelRoot(node.storage.localPath);
    const article: ArticleLink = {
      url: node.metadata.url,
      title: node.metadata.title,
      publishedAt: node.metadata.publishedAt,
      pageLabel: null,
      description: node.metadata.description,
    };

    const html = buildArticleHtml(
      node.metadata.title,
      node.content.cleanHtml,
      article,
      pageKey,
      relRoot
    );

    zip.addFile(node.storage.localPath, Buffer.from(html, "utf8"));
    pagesAdded++;
  }

  logger.info(
    {
      newJobId: diffReport.newJobId,
      pagesAdded,
      new: diffReport.newNodes.length,
      changed: diffReport.changedNodes.length,
    },
    "DIFF_ZIP: delta ZIP built"
  );

  return zip.toBuffer();
}

// ---------------------------------------------------------------------------
// Merged ZIP — complete current site state
// ---------------------------------------------------------------------------

/**
 * Builds the merged ZIP: complete current site state.
 *
 * For UNCHANGED nodes: fetches content from the baseline R2 manifest (already
 * in the new manifest via node copy in the scraper skip path).
 * For NEW + CHANGED nodes: uses fresh content from the new manifest.
 * DELETED nodes: excluded.
 *
 * Also includes a fresh index.html and _manifest.json.
 */
export async function buildMergedZip(
  newManifest: Manifest,
  diffReport: DiffReport,
  articles: ArticleLink[]
): Promise<Buffer> {
  const zip = new AdmZip();

  let newCount = 0;
  let changedCount = 0;
  let unchangedCount = 0;

  const allNodeIds = new Set([
    ...diffReport.newNodes.map(n => n.nodeId),
    ...diffReport.changedNodes.map(n => n.nodeId),
    ...diffReport.unchangedNodes.map(n => n.nodeId),
  ]);

  for (const node of newManifest.nodes.values()) {
    if (node.nodeType === "root") continue;
    if (!allNodeIds.has(node.id)) continue;

    const pageKey = node.storage.localPath.split("/")[1] ?? "articles";
    const relRoot = deriveRelRoot(node.storage.localPath);
    const article: ArticleLink = {
      url: node.metadata.url,
      title: node.metadata.title,
      publishedAt: node.metadata.publishedAt,
      pageLabel: null,
      description: node.metadata.description,
    };

    const html = buildArticleHtml(
      node.metadata.title,
      node.content.cleanHtml,
      article,
      pageKey,
      relRoot
    );

    zip.addFile(node.storage.localPath, Buffer.from(html, "utf8"));

    const cls = node.diffClassification;
    if (cls === "new") newCount++;
    else if (cls === "changed") changedCount++;
    else unchangedCount++;
  }

  // Add fresh index.html
  try {
    const articleCount = allNodeIds.size;
    const renderResult = renderIndexHtml(newManifest, articleCount, articles);
    zip.addFile("index.html", Buffer.from(renderResult.html, "utf8"));
  } catch (err) {
    logger.warn({ err, jobId: diffReport.newJobId }, "DIFF_ZIP: index.html render failed (non-fatal)");
  }

  // Add _manifest.json
  try {
    const manifestJson = renderManifestJson(newManifest);
    zip.addFile("_manifest.json", Buffer.from(manifestJson, "utf8"));
  } catch (err) {
    logger.warn({ err, jobId: diffReport.newJobId }, "DIFF_ZIP: _manifest.json render failed (non-fatal)");
  }

  logger.info(
    {
      newJobId: diffReport.newJobId,
      new: newCount,
      changed: changedCount,
      unchanged: unchangedCount,
      deleted: diffReport.deletedNodes.length,
    },
    "DIFF_ZIP: merged ZIP built"
  );

  return zip.toBuffer();
}

// ---------------------------------------------------------------------------
// Upload both ZIPs to R2
// ---------------------------------------------------------------------------

/**
 * Uploads both delta.zip and merged.zip to R2 and returns the DiffZipReport.
 */
export async function uploadDiffZips(
  provider: CloudProvider,
  newJobId: string,
  baseJobId: string,
  deltaBuffer: Buffer,
  mergedBuffer: Buffer,
  diffReport: DiffReport
): Promise<DiffZipReport> {
  const generatedAt = new Date().toISOString();

  const deltaKey  = `jobs/${newJobId}/_delta.zip`;
  const mergedKey = `jobs/${newJobId}/_manifest.zip`;

  let deltaUrl: string | null = null;
  let mergedUrl: string | null = null;

  try {
    const result = await provider.upload({ key: deltaKey, data: deltaBuffer, checkDuplicate: false });
    deltaUrl = result.url;
    logger.info({ newJobId, deltaKey, bytes: deltaBuffer.length }, "DIFF_ZIP: delta.zip uploaded");
  } catch (err) {
    logger.warn({ err, newJobId, deltaKey }, "DIFF_ZIP: delta.zip upload failed (non-fatal)");
  }

  try {
    const result = await provider.upload({ key: mergedKey, data: mergedBuffer, checkDuplicate: false });
    mergedUrl = result.url;
    logger.info({ newJobId, mergedKey, bytes: mergedBuffer.length }, "DIFF_ZIP: merged ZIP uploaded");
  } catch (err) {
    logger.warn({ err, newJobId, mergedKey }, "DIFF_ZIP: merged ZIP upload failed (non-fatal)");
  }

  return {
    newJobId,
    baseJobId,
    generatedAt,
    deltaZip: {
      generated: deltaUrl !== null,
      sizeBytes: deltaBuffer.length,
      sizeMb: Math.round((deltaBuffer.length / (1024 * 1024)) * 100) / 100,
      pagesIncluded: diffReport.newNodes.length + diffReport.changedNodes.length,
      cloudPath: deltaKey,
      publicUrl: deltaUrl,
    },
    mergedZip: {
      generated: mergedUrl !== null,
      sizeBytes: mergedBuffer.length,
      sizeMb: Math.round((mergedBuffer.length / (1024 * 1024)) * 100) / 100,
      totalPages: diffReport.summary.new + diffReport.summary.changed + diffReport.summary.unchanged,
      newPages: diffReport.summary.new,
      changedPages: diffReport.summary.changed,
      unchangedPages: diffReport.summary.unchanged,
      deletedPages: diffReport.summary.deleted,
      cloudPath: mergedKey,
      publicUrl: mergedUrl,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveRelRoot(localPath: string): string {
  const depth = localPath.split("/").length - 1;
  return "../".repeat(depth);
}
