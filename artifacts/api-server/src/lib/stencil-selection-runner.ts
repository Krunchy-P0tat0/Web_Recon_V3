/**
 * stencil-selection-runner.ts — Phase 4.4 Stencil Selection runner
 *
 * Orchestrates:
 *   Manifest → ExtractionInput → DesignDNA → DesignProfile (Phase 4.3)
 *   Manifest → PortableManifest → SiteGraph (Phase 3)
 *   SiteGraph + DesignDNA + DesignProfile → StencilSelectionReport (Phase 4.4)
 *     → R2 upload (jobs/{jobId}/stencil-selection-report.json)
 *     → local stencil-selection-report.json (last-run sample)
 *
 * Non-fatal — errors are logged so the orchestrator continues.
 */

import { writeFile } from "fs/promises";
import { join } from "path";
import { compileSiteGraph } from "@workspace/site-intelligence";
import {
  extractDesignDNA,
  classifyDesign,
} from "@workspace/design-dna";
import type { ExtractionInput } from "@workspace/design-dna";
import type {
  PortableManifest,
  PortablePageNode,
  PortableMediaItem,
  PortableStorageMap,
} from "@workspace/site-intelligence";
import { generateSelectionReport } from "./stencil-selection-engine";
import { loadManifest } from "./manifest-store";
import type { Manifest, PageNode } from "./manifest";
import { logger } from "./logger";
import type { CloudProvider } from "../cloud/provider";

const LOCAL_REPORT_PATH = join(process.cwd(), "stencil-selection-report.json");

// ─── Manifest adapter ─────────────────────────────────────────────────────────

function adaptToPortable(manifest: Manifest): PortableManifest {
  const nodes: PortablePageNode[] = Array.from(manifest.nodes.values()).map(
    (node: PageNode): PortablePageNode => ({
      id:       node.id,
      version:  node.version,
      nodeType: node.nodeType,
      status:   node.status,
      metadata: {
        url:         node.metadata.url,
        title:       node.metadata.title,
        description: node.metadata.description,
        publishedAt: node.metadata.publishedAt,
        fetchedAt:   node.metadata.fetchedAt,
        siteType:    node.metadata.siteType,
      },
      content: {
        cleanHtml:    node.content.cleanHtml,
        textContent:  node.content.textContent,
        wordCount:    node.content.wordCount,
        bodySelector: node.content.bodySelector,
      },
      media: {
        images: node.media.images as unknown as PortableMediaItem[],
        videos: node.media.videos as unknown as PortableMediaItem[],
      },
      storage:       node.storage as unknown as PortableStorageMap,
      relationships: {
        parentId:        node.relationships.parentId,
        childIds:        node.relationships.childIds,
        paginationIndex: node.relationships.paginationIndex,
        depth:           node.relationships.depth,
        discoverySource: node.relationships.discoverySource,
      },
    }),
  );
  return {
    schemaVersion: "1.0",
    exportedAt:    new Date().toISOString(),
    id:            manifest.id,
    version:       manifest.version,
    status:        manifest.status,
    createdAt:     manifest.createdAt,
    updatedAt:     manifest.updatedAt,
    seedUrl:       manifest.seedUrl,
    config:        manifest.config as PortableManifest["config"],
    nodes,
    seenUrls:      Array.from(manifest.seenUrls),
    stats:         manifest.stats as PortableManifest["stats"],
  };
}

function buildExtractionInput(manifest: Manifest, jobId: string): ExtractionInput | null {
  const pages = Array.from(manifest.nodes.values())
    .filter((n) => n.content?.cleanHtml)
    .map((n) => ({
      url:      n.metadata.url,
      html:     n.content.cleanHtml ?? "",
      nodeType: n.nodeType ?? "article",
    }));
  if (pages.length === 0) return null;
  return { url: manifest.seedUrl, jobId, pages };
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export async function runAndStoreStencilSelection(
  jobId: string,
  cloudProvider: CloudProvider,
): Promise<void> {
  logger.info({ jobId }, "STENCIL-SELECT: starting Phase 4.4 stencil selection");
  const startMs = Date.now();

  const manifest = await loadManifest(jobId);
  if (!manifest) {
    logger.warn({ jobId }, "STENCIL-SELECT: manifest not found — skipping");
    return;
  }

  // Build SiteGraph (Phase 3)
  const portable  = adaptToPortable(manifest);
  const siteGraph = compileSiteGraph(portable);

  // Build DesignDNA (Phase 4.2) and DesignProfile (Phase 4.3)
  const input = buildExtractionInput(manifest, jobId);
  const dna   = input ? extractDesignDNA(input) : null;
  const profile = dna ? classifyDesign(dna) : null;

  if (!dna) {
    logger.warn({ jobId }, "STENCIL-SELECT: no HTML pages — skipping");
    return;
  }

  const pageCount  = manifest.nodes.size;
  const durationMs = Date.now() - startMs;

  const report = generateSelectionReport(siteGraph, dna, profile, {
    url: manifest.seedUrl,
    jobId,
    pageCount,
    durationMs,
  });

  const reportJson = JSON.stringify(report, null, 2);

  logger.info(
    {
      jobId,
      stencilType:    report.result.selectedStencilType,
      confidence:     report.result.confidence,
      confidenceLabel: report.result.confidenceLabel,
      durationMs,
    },
    "STENCIL-SELECT: selection complete",
  );

  // Upload to R2
  if (cloudProvider.isConfigured()) {
    await cloudProvider
      .upload({
        key:            `jobs/${jobId}/stencil-selection-report.json`,
        data:           Buffer.from(reportJson, "utf8"),
        contentType:    "application/json",
        checkDuplicate: false,
      })
      .catch((err) =>
        logger.warn({ err, jobId }, "STENCIL-SELECT: R2 upload failed (non-fatal)"),
      );
  }

  await writeFile(LOCAL_REPORT_PATH, reportJson, "utf8").catch((err) =>
    logger.warn({ err }, "STENCIL-SELECT: local write failed (non-fatal)"),
  );
}
