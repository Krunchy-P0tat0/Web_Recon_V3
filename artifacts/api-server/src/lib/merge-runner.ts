/**
 * merge-runner.ts — Phase A2/A3 Merge runner (merging stage)
 *
 * Orchestrates the full merge pipeline for merge_into_backend / update_existing goals:
 *
 *   Manifest (scraped site) → SiteGraph (site-intelligence)
 *   Target codebase VFS (empty = no base yet) → DiscoverySiteGraph (site-discovery)
 *   SiteGraph + DiscoverySiteGraph → MergePlan (merge-planner)
 *   MergePlan + VFS → ExecuteMergePlanResult (merge-execution-engine, dry-run)
 *   → merge-audit.json uploaded to R2
 *
 * Runs dry-run by default — no files are actually written to disk.
 * When a real target VFS is provided in the future, set dryRun: false.
 *
 * Non-fatal — errors are caught and logged so the orchestrator continues.
 */

import { writeFile } from "fs/promises";
import { join } from "path";
import { compileSiteGraph } from "@workspace/site-intelligence";
import { compileDiscoverySiteGraph } from "@workspace/site-discovery";
import { compileMergePlan } from "@workspace/merge-planner";
import { executeMergePlan } from "@workspace/merge-execution-engine";
import type {
  PortableManifest,
  PortablePageNode,
  PortableMediaItem,
  PortableStorageMap,
} from "@workspace/site-intelligence";
import type { VirtualFileSystem } from "@workspace/merge-execution-engine";
import { loadManifest } from "./manifest-store";
import type { Manifest, PageNode } from "./manifest";
import { logger } from "./logger";
import type { CloudProvider } from "../cloud/provider";

const LOCAL_REPORT_PATH = join(process.cwd(), "merge-audit.json");

// ---------------------------------------------------------------------------
// Manifest adapter (mirrors generation-runner — local copy to avoid coupling)
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

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run the full merge pipeline for a scrape job.
 *
 * @param jobId         - Scrape job whose manifest will be used as the "incoming" site
 * @param cloudProvider - Cloud storage provider for R2 upload
 * @param targetVfs     - Optional: VFS of the target codebase. Defaults to {} (empty).
 *                        Pass the real codebase VFS when integrating a live backend.
 * @param dryRun        - If true (default), no files are written to disk by the engine.
 */
export async function runAndStoreMerge(
  jobId:         string,
  cloudProvider: CloudProvider,
  targetVfs:     VirtualFileSystem = {},
  dryRun         = true,
): Promise<void> {
  logger.info({ jobId, dryRun, targetFileCount: Object.keys(targetVfs).length },
    "MERGE: starting merge pipeline");
  const startMs = Date.now();

  // 1. Load manifest (scraped "incoming" site)
  const manifest = await loadManifest(jobId);
  if (!manifest) {
    logger.warn({ jobId }, "MERGE: manifest not found — skipping merge stage");
    return;
  }

  // 2. Build SiteGraph from the incoming manifest (Phase 3)
  const portable  = adaptToPortable(manifest);
  const siteGraph = compileSiteGraph(portable);

  // 3. Discover the target codebase structure (Phase A1)
  //    With an empty VFS this produces an empty DiscoverySiteGraph —
  //    the merge plan will therefore mark everything as CREATE actions.
  const discoveryGraph = compileDiscoverySiteGraph(targetVfs);

  // 4. Plan the merge (Phase A2)
  const mergePlan = compileMergePlan(discoveryGraph, siteGraph);

  logger.info(
    {
      jobId,
      decisions:  mergePlan.decisions.length,
      conflicts:  mergePlan.conflicts.length,
    },
    "MERGE: merge plan compiled",
  );

  // 5. Execute the plan (Phase A3 — dry-run by default)
  const result = executeMergePlan(mergePlan, targetVfs, { dryRun, captureRollback: false });
  const durationMs = Date.now() - startMs;

  const reportJson = JSON.stringify(
    {
      meta: {
        jobId,
        url:            manifest.seedUrl,
        generatedAt:    new Date().toISOString(),
        phase:          "A2+A3",
        dryRun,
        durationMs,
        stats: {
          decisions:     mergePlan.decisions.length,
          conflicts:     mergePlan.conflicts.length,
          fileChanges:   result.audit.fileChanges.length,
          targetFiles:   Object.keys(targetVfs).length,
        },
      },
      mergePlan: {
        decisions: mergePlan.decisions,
        conflicts: mergePlan.conflicts,
        stats:     mergePlan.stats,
      },
      executionAudit: result.audit,
    },
    null,
    2,
  );

  logger.info(
    {
      jobId,
      dryRun,
      fileChanges: result.audit.fileChanges.length,
      durationMs,
    },
    "MERGE: merge execution complete",
  );

  // 6. Upload to R2
  if (cloudProvider.isConfigured()) {
    await cloudProvider
      .upload({
        key:            `jobs/${jobId}/merge-audit.json`,
        data:           Buffer.from(reportJson, "utf8"),
        contentType:    "application/json",
        checkDuplicate: false,
      })
      .catch((err) =>
        logger.warn({ err, jobId }, "MERGE: R2 upload failed (non-fatal)"),
      );
  }

  // 7. Write local last-run sample
  await writeFile(LOCAL_REPORT_PATH, reportJson, "utf8").catch((err) =>
    logger.warn({ err }, "MERGE: local write failed (non-fatal)"),
  );
}
