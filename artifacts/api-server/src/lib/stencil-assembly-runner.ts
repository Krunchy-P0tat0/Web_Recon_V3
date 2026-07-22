/**
 * stencil-assembly-runner.ts — Phase B3 Stencil Assembly runner (generating stage)
 *
 * Takes the selected stencil from the generation report and assembles the full
 * SiteAssembly: navigation, routes, landing pages, article pages, category pages,
 * search structure.
 *
 * Uploads to R2 as jobs/{jobId}/site-assembly.json.
 * Pure/sync at core — I/O only in the upload step.
 */

import { writeFile } from "fs/promises";
import { join } from "path";
import { assembleStencil } from "@workspace/stencil-assembly-engine";
import type {
  PortableManifest,
  PortablePageNode,
  PortableMediaItem,
  PortableStorageMap,
} from "@workspace/site-intelligence";
import type { StencilId } from "@workspace/stencil-registry";
import { loadManifest } from "./manifest-store";
import type { Manifest, PageNode } from "./manifest";
import { loadGenerationReport } from "./generation-runner";
import { logger } from "./logger";
import type { CloudProvider } from "../cloud/provider";

const LOCAL_REPORT_PATH = join(process.cwd(), "site-assembly.json");

// ---------------------------------------------------------------------------
// StencilId fallback map (DesignArchetype → StencilId)
// ---------------------------------------------------------------------------

const ARCHETYPE_TO_STENCIL: Record<string, StencilId> = {
  blog:          "blog",
  magazine:      "magazine",
  portfolio:     "portfolio",
  documentation: "documentation",
  agency:        "agency",
  luxury:        "agency",       // closest stencil for luxury brand
  ecommerce:     "marketplace",  // closest stencil for ecommerce
};

function resolveStencilId(raw: string | null | undefined): StencilId {
  if (!raw) return "blog";
  const mapped = ARCHETYPE_TO_STENCIL[raw];
  if (mapped) return mapped;
  // Direct match if it's already a valid StencilId
  const validIds: StencilId[] = ["agency","blog","magazine","portfolio","documentation","marketplace","directory","wedding"];
  if (validIds.includes(raw as StencilId)) return raw as StencilId;
  return "blog";
}

// ---------------------------------------------------------------------------
// Manifest adapter (mirrors generation-runner — kept local to avoid coupling)
// ---------------------------------------------------------------------------

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
        cleanHtml:   node.content.cleanHtml,
        textContent: node.content.textContent,
        wordCount:   node.content.wordCount,
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

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runAndStoreStencilAssembly(
  jobId: string,
  cloudProvider: CloudProvider,
): Promise<void> {
  logger.info({ jobId }, "ASSEMBLE: starting Phase B3 stencil assembly");
  const startMs = Date.now();

  // Load manifest
  const manifest = await loadManifest(jobId);
  if (!manifest) {
    logger.warn({ jobId }, "ASSEMBLE: manifest not found — skipping");
    return;
  }

  // Load generation report to get stencilId chosen by the pipeline
  const genReport = await loadGenerationReport(jobId);
  const stencilId = resolveStencilId(genReport?.stencilId ?? null);

  logger.info({ jobId, stencilId }, "ASSEMBLE: resolved stencilId");

  // Run pure assembly
  const portable  = adaptToPortable(manifest);
  const assembly  = assembleStencil(portable, stencilId);
  const durationMs = Date.now() - startMs;

  const reportJson = JSON.stringify(
    {
      meta: {
        jobId,
        url:         manifest.seedUrl,
        stencilId,
        generatedAt: new Date().toISOString(),
        phase:       "B3",
        durationMs,
        stats: {
          routeCount:    assembly.routes.total,
          navItemCount:  assembly.navigation.primaryNav.length,
          pageCount:
            assembly.landingPages.length +
            assembly.articlePages.length +
            assembly.categoryPages.length,
        },
      },
      assembly,
    },
    null,
    2,
  );

  logger.info(
    {
      jobId,
      stencilId,
      routes:   assembly.routes.total,
      articles: assembly.articlePages.length,
      durationMs,
    },
    "ASSEMBLE: stencil assembly complete",
  );

  // Upload to R2
  if (cloudProvider.isConfigured()) {
    await cloudProvider
      .upload({
        key:            `jobs/${jobId}/site-assembly.json`,
        data:           Buffer.from(reportJson, "utf8"),
        contentType:    "application/json",
        checkDuplicate: false,
      })
      .catch((err) =>
        logger.warn({ err, jobId }, "ASSEMBLE: R2 upload failed (non-fatal)"),
      );
  }

  // Write local last-run sample
  await writeFile(LOCAL_REPORT_PATH, reportJson, "utf8").catch((err) =>
    logger.warn({ err }, "ASSEMBLE: local write failed (non-fatal)"),
  );
}
