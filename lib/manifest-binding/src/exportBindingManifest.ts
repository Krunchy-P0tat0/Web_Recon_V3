/**
 * exportBindingManifest.ts — Writes the 5 required output files.
 *
 * Outputs (all written to outputDir):
 *   1. binding-manifest.json    — full BindingGraph (every page + asset mapping)
 *   2. binding-report.json      — summary stats + ValidationResult
 *   3. orphan-assets.json       — R2 objects with no manifest owner
 *   4. orphan-pages.json        — manifest pages with no HTML in R2
 *   5. binding-events.ndjson    — one JSON line per binding operation (audit log)
 *
 * All JSON outputs are sorted and deterministic.
 * NDJSON events are in the same deterministic order as the binding run.
 * This function performs I/O and is therefore async.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  BuildBindingGraphResult,
  ValidationResult,
  ExportResult,
  ExportPaths,
} from "./types.js";

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

/** Stable JSON serialiser — 2-space indent, no trailing newline issues. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// Main export function
// ---------------------------------------------------------------------------

export async function exportBindingManifest(
  buildResult: BuildBindingGraphResult,
  validation:  ValidationResult,
  outputDir:   string
): Promise<ExportResult> {
  const exportedAt = new Date().toISOString();

  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true });

  const paths: ExportPaths = {
    bindingManifest: join(outputDir, "binding-manifest.json"),
    bindingReport:   join(outputDir, "binding-report.json"),
    orphanAssets:    join(outputDir, "orphan-assets.json"),
    orphanPages:     join(outputDir, "orphan-pages.json"),
    bindingEvents:   join(outputDir, "binding-events.ndjson"),
  };

  // ── 1. binding-manifest.json ─────────────────────────────────────────────

  const bindingManifestPayload = {
    schemaVersion:  "1.0",
    exportedAt,
    jobId:          buildResult.graph.jobId,
    manifestId:     buildResult.graph.manifestId,
    manifestStatus: buildResult.graph.manifestStatus,
    seedUrl:        buildResult.graph.seedUrl,
    builtAt:        buildResult.graph.builtAt,
    stats: {
      totalPages:        buildResult.graph.pages.length,
      totalR2Objects:    buildResult.graph.totalR2Objects,
      claimedR2Objects:  buildResult.graph.claimedR2Objects,
      unclaimedR2Objects: buildResult.graph.unclaimedR2Objects,
    },
    pages: buildResult.graph.pages,
  };

  await writeFile(paths.bindingManifest, stableJson(bindingManifestPayload) + "\n", "utf-8");

  // ── 2. binding-report.json ───────────────────────────────────────────────

  const bindingReportPayload = {
    schemaVersion: "1.0",
    exportedAt,
    jobId:         buildResult.graph.jobId,
    passed:        validation.passed,
    grade:         validation.grade,
    metrics:       validation.metrics,
    issues:        validation.issues,
    checkedAt:     validation.checkedAt,
    graph: {
      jobId:              buildResult.graph.jobId,
      manifestId:         buildResult.graph.manifestId,
      manifestStatus:     buildResult.graph.manifestStatus,
      manifestCreatedAt:  buildResult.graph.manifestCreatedAt,
      seedUrl:            buildResult.graph.seedUrl,
      builtAt:            buildResult.graph.builtAt,
      totalR2Objects:     buildResult.graph.totalR2Objects,
      claimedR2Objects:   buildResult.graph.claimedR2Objects,
      unclaimedR2Objects: buildResult.graph.unclaimedR2Objects,
    },
    pageSummary: buildResult.graph.pages.map((p) => ({
      pageId:           p.pageId,
      pageUrl:          p.pageUrl,
      nodeType:         p.nodeType,
      nodeStatus:       p.nodeStatus,
      htmlR2Path:       p.htmlR2Path,
      htmlR2Present:    p.htmlR2Present,
      htmlSource:       p.htmlBindingSource,
      htmlConfidence:   p.htmlConfidence,
      imageCount:       p.imageAssets.length,
      embedCount:       p.embedAssets.length,
      videoCount:       p.videoAssets.length,
      totalAssets:      p.imageAssets.length + p.embedAssets.length + p.videoAssets.length,
      wordCount:        p.wordCount,
      depth:            p.depth,
    })),
  };

  await writeFile(paths.bindingReport, stableJson(bindingReportPayload) + "\n", "utf-8");

  // ── 3. orphan-assets.json ────────────────────────────────────────────────

  const orphanAssetsPayload = {
    schemaVersion:  "1.0",
    exportedAt,
    jobId:          buildResult.graph.jobId,
    count:          buildResult.orphanAssets.length,
    orphans:        buildResult.orphanAssets,
  };

  await writeFile(paths.orphanAssets, stableJson(orphanAssetsPayload) + "\n", "utf-8");

  // ── 4. orphan-pages.json ─────────────────────────────────────────────────

  const orphanPagesPayload = {
    schemaVersion:  "1.0",
    exportedAt,
    jobId:          buildResult.graph.jobId,
    count:          validation.orphanPages.length,
    orphans:        validation.orphanPages,
  };

  await writeFile(paths.orphanPages, stableJson(orphanPagesPayload) + "\n", "utf-8");

  // ── 5. binding-events.ndjson ─────────────────────────────────────────────

  const lines = buildResult.events.map((e) => JSON.stringify(e));
  await writeFile(paths.bindingEvents, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf-8");

  return {
    exportedAt,
    outputDir,
    paths,
    totalEvents:       buildResult.events.length,
    totalPages:        buildResult.graph.pages.length,
    totalOrphanAssets: buildResult.orphanAssets.length,
    totalOrphanPages:  validation.orphanPages.length,
  };
}
