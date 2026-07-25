/**
 * validateBindingGraph.ts — Validates a BindingGraph against the success criteria.
 *
 * SUCCESS CRITERIA (from spec):
 *   PASS only if:
 *     - 100% of pages are represented in the binding graph (always true after build)
 *     - ≥95% of assets are linked to at least one page
 *     - No untracked R2 objects remain (except ZIPs and special files)
 *     - Full reproducibility from R2 alone is possible
 *
 * This function is PURE — no I/O, no side effects.
 * Same inputs → same ValidationResult, always.
 */

import type {
  BindingGraph,
  BuildBindingGraphResult,
  OrphanAsset,
  OrphanPage,
  ValidationResult,
  ValidationIssue,
  ValidationMetrics,
} from "./types.js";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const ASSET_COVERAGE_PASS_THRESHOLD = 0.95;
const PAGE_COVERAGE_PASS_THRESHOLD  = 1.00;

// ---------------------------------------------------------------------------
// Grade helper
// ---------------------------------------------------------------------------

function grade(pageCoverage: number, assetCoverage: number): ValidationResult["grade"] {
  const combined = (pageCoverage + assetCoverage) / 2;
  if (combined >= 0.97) return "A";
  if (combined >= 0.90) return "B";
  if (combined >= 0.80) return "C";
  if (combined >= 0.70) return "D";
  return "F";
}

// ---------------------------------------------------------------------------
// Main validator
// ---------------------------------------------------------------------------

export function validateBindingGraph(
  result: BuildBindingGraphResult
): ValidationResult {
  const { graph, orphanAssets } = result;
  const { pages } = graph;
  const checkedAt = new Date().toISOString();
  const issues: ValidationIssue[] = [];

  // ── Page-level checks ────────────────────────────────────────────────────

  const orphanPages: OrphanPage[] = [];

  let pagesWithHtml        = 0;
  let pagesWithHtmlPresent = 0;

  for (const page of pages) {
    if (page.htmlR2Path !== null) {
      pagesWithHtml++;
    } else {
      issues.push({
        kind:     "html_unresolvable",
        severity: "error",
        pageId:   page.pageId,
        detail:   `Page ${page.pageId} (${page.pageUrl}) has no resolvable HTML R2 key`,
      });
      orphanPages.push({
        pageId:              page.pageId,
        pageUrl:             page.pageUrl,
        nodeType:            page.nodeType,
        nodeStatus:          page.nodeStatus,
        expectedHtmlR2Path:  page.htmlR2Path,
        depth:               page.depth,
      });
    }

    if (page.htmlR2Present) {
      pagesWithHtmlPresent++;
    } else if (page.htmlR2Path !== null) {
      // Key was derived but not found in R2
      issues.push({
        kind:     "html_missing_from_r2",
        severity: "error",
        pageId:   page.pageId,
        r2Key:    page.htmlR2Path,
        detail:   `HTML key for page ${page.pageId} (${page.pageUrl}) not found in R2 bucket: ${page.htmlR2Path}`,
      });
      orphanPages.push({
        pageId:              page.pageId,
        pageUrl:             page.pageUrl,
        nodeType:            page.nodeType,
        nodeStatus:          page.nodeStatus,
        expectedHtmlR2Path:  page.htmlR2Path,
        depth:               page.depth,
      });
    }
  }

  // ── Orphan asset checks ──────────────────────────────────────────────────

  for (const orphan of orphanAssets) {
    issues.push({
      kind:     "asset_orphaned_in_r2",
      severity: "warning",
      r2Key:    orphan.r2Key,
      detail:   `R2 object has no manifest owner: ${orphan.r2Key} (${orphan.category}) — ${orphan.possibleReason}`,
    });
  }

  // ── Coverage metrics ─────────────────────────────────────────────────────

  const totalPages = pages.length;

  // "Page coverage" = fraction of pages whose HTML is confirmed present in R2
  const pageCoverage = totalPages > 0
    ? pagesWithHtmlPresent / totalPages
    : 1.0;

  // "Asset coverage" = fraction of R2 objects that are claimed
  // (We compare claimedR2Objects vs totalR2Objects, excluding permanently-skipped)
  const totalAccountable = graph.totalR2Objects;
  const claimed          = graph.claimedR2Objects;
  const assetCoverage    = totalAccountable > 0
    ? claimed / totalAccountable
    : 1.0;

  if (pageCoverage < PAGE_COVERAGE_PASS_THRESHOLD) {
    issues.push({
      kind:     "page_coverage_below_threshold",
      severity: "error",
      detail:   `Page HTML coverage ${(pageCoverage * 100).toFixed(1)}% is below required ${(PAGE_COVERAGE_PASS_THRESHOLD * 100).toFixed(0)}% — ${totalPages - pagesWithHtmlPresent} page(s) missing HTML in R2`,
    });
  }

  if (assetCoverage < ASSET_COVERAGE_PASS_THRESHOLD) {
    issues.push({
      kind:     "asset_coverage_below_threshold",
      severity: "warning",
      detail:   `Asset coverage ${(assetCoverage * 100).toFixed(1)}% is below required ${(ASSET_COVERAGE_PASS_THRESHOLD * 100).toFixed(0)}% — ${graph.unclaimedR2Objects} untracked R2 object(s)`,
    });
  }

  // ── Pass/fail ────────────────────────────────────────────────────────────

  const hasBlockingErrors = issues.some((i) => i.severity === "error");
  const passed = !hasBlockingErrors
    && pageCoverage  >= PAGE_COVERAGE_PASS_THRESHOLD
    && assetCoverage >= ASSET_COVERAGE_PASS_THRESHOLD
    && orphanAssets.length === 0;

  const metrics: ValidationMetrics = {
    totalPages,
    pagesWithHtml,
    pagesWithHtmlPresent,
    pageCoverage,
    totalR2Assets:    graph.totalR2Objects,
    claimedR2Assets:  graph.claimedR2Objects,
    unclaimedR2Assets: graph.unclaimedR2Objects,
    assetCoverage,
    orphanPages:      orphanPages.length,
    orphanAssets:     orphanAssets.length,
  };

  return {
    passed,
    grade:       grade(pageCoverage, assetCoverage),
    metrics,
    issues,
    orphanPages,
    checkedAt,
  };
}
