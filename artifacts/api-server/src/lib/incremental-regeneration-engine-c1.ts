/**
 * incremental-regeneration-engine-c1.ts — Phase C1: Incremental Regeneration Engine
 *
 * Replaces full Website Prime regeneration with a targeted, diff-driven plan
 * that identifies exactly what changed and regenerates ONLY the affected resources.
 *
 * Inputs:
 *   • DiffReport (from diff-engine.ts) — what changed between crawl versions
 *   • Optional component/route metadata — for dependency propagation
 *
 * Dependency propagation tracks:
 *   Component Tree · Route Graph · Navigation Graph · Manifest Graph
 *
 * Outputs (disk + R2 under jobs/{newJobId}/c1/):
 *   incremental-regeneration-report.json
 *   affected-pages.json
 *   dependency-impact-report.json
 *   regeneration-summary.json
 *
 * Metrics produced:
 *   Time Saved · Pages Skipped · Components Reused · Asset Reuse %
 */

import { writeFile }  from "fs/promises";
import { join }       from "path";
import { logger }     from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import type { DiffReport, DiffNodeResult } from "./diff-engine.js";
import type { ChangeReason }               from "./manifest.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RegenerationScope = "full" | "partial" | "none";
export type ChangeImpact = "direct" | "propagated" | "asset_only" | "navigation" | "metadata";

export interface AffectedPage {
  nodeId:          string;
  url:             string;
  title:           string;
  classification:  "new" | "changed" | "deleted";
  changeReasons:   ChangeReason[];
  impactType:      ChangeImpact;
  propagatedFrom?: string[];      // URLs that caused this page to be pulled in
  estimatedCostMs: number;        // estimated regeneration time
  priority:        "critical" | "high" | "normal" | "low";
}

export interface UnchangedPage {
  nodeId: string;
  url:    string;
  title:  string;
  reason: string;       // why it was skipped
  savedMs: number;      // estimated time saved by skipping
}

export interface AffectedPagesReport {
  schemaVersion:  "C1-1";
  baseJobId:      string;
  newJobId:       string;
  generatedAt:    string;
  totalPages:     number;
  affectedCount:  number;
  skippedCount:   number;
  affectedPages:  AffectedPage[];
  skippedPages:   UnchangedPage[];
  r2Key:          string | null;
}

// ---------------------------------------------------------------------------
// Dependency Impact Report
// ---------------------------------------------------------------------------

export interface ComponentDependency {
  componentId:    string;           // hash / identifier
  type:           string;           // nav, footer, hero, card, etc.
  affectedByUrls: string[];
  requiresRebuild: boolean;
  reuseCandidate:  boolean;
}

export interface RouteImpact {
  route:          string;
  affectedPages:  string[];         // URLs
  structuralChange: boolean;
  newRoute:       boolean;
  deletedRoute:   boolean;
}

export interface NavigationImpact {
  navigationChanged:   boolean;
  addedItems:          string[];
  removedItems:        string[];
  reorderedItems:      boolean;
  rebuildRequired:     boolean;
}

export interface ManifestImpact {
  totalNodes:          number;
  changedNodes:        number;
  newNodes:            number;
  deletedNodes:        number;
  unchangedNodes:      number;
  integrityValid:      boolean;
}

export interface DependencyImpactReport {
  schemaVersion:     "C1-1";
  baseJobId:         string;
  newJobId:          string;
  generatedAt:       string;
  componentTree: {
    totalComponents:   number;
    affectedComponents: number;
    reuseableComponents: number;
    components:        ComponentDependency[];
  };
  routeGraph:        RouteImpact[];
  navigationImpact:  NavigationImpact;
  manifestImpact:    ManifestImpact;
  propagationDepth:  number;        // max hops of change propagation
  r2Key:             string | null;
}

// ---------------------------------------------------------------------------
// Main Regeneration Report
// ---------------------------------------------------------------------------

export interface RegenerationMetrics {
  totalPagesBase:       number;
  totalPagesNew:        number;
  pagesAffected:        number;
  pagesSkipped:         number;
  pagesNew:             number;
  pagesChanged:         number;
  pagesDeleted:         number;
  componentsTotal:      number;
  componentsReused:     number;
  componentsRebuilt:    number;
  assetsTotal:          number;
  assetsReused:         number;
  assetsRebuilt:        number;
  assetReusePercent:    number;
  estimatedFullTimeMs:  number;
  estimatedIncrementalMs: number;
  timeSavedMs:          number;
  timeSavedPercent:     number;
  skipRate:             number;     // 0–1
}

export interface IncrementalRegenerationReport {
  schemaVersion:      "C1-1";
  baseJobId:          string;
  newJobId:           string;
  generatedAt:        string;
  durationMs:         number;
  scope:              RegenerationScope;
  metrics:            RegenerationMetrics;
  affectedPageUrls:   string[];
  skippedPageUrls:    string[];
  changeReasonsMap:   Record<string, ChangeReason[]>;  // url → reasons
  warnings:           string[];
  r2Keys: {
    report:              string | null;
    affectedPages:       string | null;
    dependencyImpact:    string | null;
    summary:             string | null;
  };
}

// ---------------------------------------------------------------------------
// Regeneration Summary
// ---------------------------------------------------------------------------

export interface RegenerationSummary {
  schemaVersion:      "C1-1";
  baseJobId:          string;
  newJobId:           string;
  generatedAt:        string;
  scope:              RegenerationScope;
  headline:           string;
  pagesAffected:      number;
  pagesSkipped:       number;
  timeSavedMs:        number;
  timeSavedPercent:   number;
  assetReusePercent:  number;
  componentsReused:   number;
  topChangedUrls:     string[];
  topChangedReasons:  string[];
  nearInstant:        boolean;     // true when < 10% pages affected
}

// ---------------------------------------------------------------------------
// Input options
// ---------------------------------------------------------------------------

export interface IncrementalRegenerationOptions {
  diffReport:    DiffReport;
  /** Estimated average regeneration cost per page (ms) */
  avgPageCostMs?: number;          // default 3000
  /** Estimated average asset cost (ms) */
  avgAssetCostMs?: number;         // default 500
  /** Known component-to-URL mapping for propagation */
  componentMap?:  Record<string, string[]>;   // componentId → page urls
  /** Known navigation items (URLs) for detecting nav changes */
  navigationUrls?: string[];
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

interface StoredResult {
  report:           IncrementalRegenerationReport;
  affectedPages:    AffectedPagesReport;
  dependencyImpact: DependencyImpactReport;
  summary:          RegenerationSummary;
}

const _store = new Map<string, StoredResult>();

function storeKey(b: string, n: string) { return `${b}::${n}`; }

export function getIncrementalReport(base: string, newJob: string): StoredResult | undefined {
  return _store.get(storeKey(base, newJob));
}

export function listIncrementalReports(): Array<{
  baseJobId: string; newJobId: string;
  scope: RegenerationScope; pagesAffected: number; timeSavedMs: number; generatedAt: string;
}> {
  return [..._store.values()].map(r => ({
    baseJobId:     r.report.baseJobId,
    newJobId:      r.report.newJobId,
    scope:         r.report.scope,
    pagesAffected: r.report.metrics.pagesAffected,
    timeSavedMs:   r.report.metrics.timeSavedMs,
    generatedAt:   r.report.generatedAt,
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AVG_PAGE_COST_MS  = 3000;
const AVG_ASSET_COST_MS = 500;

function priorityFromNode(node: DiffNodeResult): AffectedPage["priority"] {
  const reasons = node.changeReasons;
  if (reasons.includes("structureChanged") || reasons.includes("contentHashChanged")) return "critical";
  if (reasons.includes("titleChanged") || reasons.includes("imageSetChanged"))         return "high";
  if (reasons.includes("metadataChanged")) return "normal";
  if (node.classification === "new")       return "high";
  if (node.classification === "deleted")   return "low";
  return "normal";
}

function impactTypeFromNode(node: DiffNodeResult, propagated: boolean): ChangeImpact {
  if (propagated) return "propagated";
  if (node.changeReasons.includes("imageSetChanged")) return "asset_only";
  if (node.changeReasons.includes("metadataChanged") && !node.changeReasons.includes("contentHashChanged")) return "metadata";
  return "direct";
}

/** Determine if a URL is likely part of the navigation */
function isNavigationUrl(url: string, navUrls: string[]): boolean {
  if (navUrls.length > 0) return navUrls.includes(url);
  // Heuristic: short path, no deep nesting
  try {
    const p = new URL(url).pathname.replace(/\/$/, "");
    const depth = p.split("/").filter(Boolean).length;
    return depth <= 1;
  } catch {
    return false;
  }
}

/** Extract path slug for route detection */
function pathSlug(url: string): string {
  try { return new URL(url).pathname; }
  catch { return url; }
}

// ---------------------------------------------------------------------------
// Core engine
// ---------------------------------------------------------------------------

const OUT_DIR = process.cwd();

export async function runIncrementalRegeneration(
  opts: IncrementalRegenerationOptions,
): Promise<{
  report:           IncrementalRegenerationReport;
  affectedPages:    AffectedPagesReport;
  dependencyImpact: DependencyImpactReport;
  summary:          RegenerationSummary;
}> {
  const {
    diffReport,
    avgPageCostMs  = AVG_PAGE_COST_MS,
    avgAssetCostMs = AVG_ASSET_COST_MS,
    componentMap   = {},
    navigationUrls = [],
  } = opts;

  const t0      = Date.now();
  const { baseJobId, newJobId } = diffReport;
  const now     = new Date().toISOString();

  logger.info(
    { baseJobId, newJobId, changed: diffReport.summary.changed, new: diffReport.summary.new },
    "C1: starting incremental regeneration analysis",
  );

  // ── Build affected page list ───────────────────────────────────────────
  const affectedNodes: AffectedPage[] = [];
  const skippedNodes: UnchangedPage[] = [];
  const changeReasonsMap: Record<string, ChangeReason[]> = {};

  // Changed pages
  for (const node of diffReport.changedNodes) {
    changeReasonsMap[node.url] = node.changeReasons;
    affectedNodes.push({
      nodeId:          node.nodeId,
      url:             node.url,
      title:           node.title,
      classification:  "changed",
      changeReasons:   node.changeReasons,
      impactType:      impactTypeFromNode(node, false),
      estimatedCostMs: avgPageCostMs,
      priority:        priorityFromNode(node),
    });
  }

  // New pages
  for (const node of diffReport.newNodes) {
    affectedNodes.push({
      nodeId:          node.nodeId,
      url:             node.url,
      title:           node.title,
      classification:  "new",
      changeReasons:   [],
      impactType:      "direct",
      estimatedCostMs: avgPageCostMs,
      priority:        "high",
    });
  }

  // Deleted pages (need to be removed from Website Prime)
  for (const node of diffReport.deletedNodes) {
    affectedNodes.push({
      nodeId:          node.nodeId,
      url:             node.url,
      title:           node.title,
      classification:  "deleted",
      changeReasons:   [],
      impactType:      "direct",
      estimatedCostMs: Math.round(avgPageCostMs * 0.1),   // deletion is cheap
      priority:        "normal",
    });
  }

  // Unchanged pages (skipped)
  for (const node of diffReport.unchangedNodes) {
    skippedNodes.push({
      nodeId:  node.nodeId,
      url:     node.url,
      title:   node.title,
      reason:  "Content hash unchanged — page content identical to baseline",
      savedMs: avgPageCostMs,
    });
  }

  // ── Dependency propagation ─────────────────────────────────────────────
  // Detect pages that share components with changed pages
  const affectedUrls = new Set(affectedNodes.map(n => n.url));
  const propagatedUrls = new Set<string>();
  let propagationDepth = 0;

  if (Object.keys(componentMap).length > 0) {
    // Build reverse map: url → component ids
    const urlToComponents = new Map<string, string[]>();
    for (const [compId, urls] of Object.entries(componentMap)) {
      for (const url of urls) {
        const existing = urlToComponents.get(url) ?? [];
        existing.push(compId);
        urlToComponents.set(url, existing);
      }
    }

    // Find components used by affected pages
    const affectedComponents = new Set<string>();
    for (const node of affectedNodes) {
      for (const compId of urlToComponents.get(node.url) ?? []) {
        affectedComponents.add(compId);
      }
    }

    // Find pages that use those components
    for (const [compId, urls] of Object.entries(componentMap)) {
      if (!affectedComponents.has(compId)) continue;
      for (const url of urls) {
        if (!affectedUrls.has(url)) {
          propagatedUrls.add(url);
        }
      }
    }

    propagationDepth = propagatedUrls.size > 0 ? 1 : 0;
  }

  // Navigation change detection
  const navChanged = affectedNodes.some(n =>
    isNavigationUrl(n.url, navigationUrls) &&
    (n.changeReasons.includes("structureChanged") || n.changeReasons.includes("titleChanged") ||
     n.classification === "new" || n.classification === "deleted"),
  );

  // If nav changed, all pages are potentially affected (but mark as propagated)
  if (navChanged) {
    for (const skipped of skippedNodes) {
      if (!affectedUrls.has(skipped.url)) {
        propagatedUrls.add(skipped.url);
      }
    }
    propagationDepth = Math.max(propagationDepth, 2);
  }

  // Add propagated pages to affected list
  const propagatedList = [...propagatedUrls];
  for (const url of propagatedList) {
    const skipped = skippedNodes.find(s => s.url === url);
    if (skipped) {
      affectedNodes.push({
        nodeId:          skipped.nodeId,
        url:             skipped.url,
        title:           skipped.title,
        classification:  "changed",
        changeReasons:   navChanged ? ["structureChanged"] : [],
        impactType:      navChanged ? "navigation" : "propagated",
        propagatedFrom:  affectedNodes.filter(n => isNavigationUrl(n.url, navigationUrls)).map(n => n.url),
        estimatedCostMs: Math.round(avgPageCostMs * 0.6),  // cheaper since content is same
        priority:        "normal",
      });
    }
  }

  // Recalculate skipped (exclude newly-propagated)
  const finalSkipped = skippedNodes.filter(s => !propagatedUrls.has(s.url));
  const finalAffected = affectedNodes;

  // Sort: critical/high priority first
  finalAffected.sort((a, b) => {
    const p = { critical: 0, high: 1, normal: 2, low: 3 };
    return p[a.priority] - p[b.priority];
  });

  // ── Component analysis ─────────────────────────────────────────────────
  const affectedUrlSet = new Set(finalAffected.map(n => n.url));
  const components: ComponentDependency[] = [];
  const totalComponents = Object.keys(componentMap).length;
  let componentsReused = 0;
  let componentsRebuilt = 0;

  for (const [compId, urls] of Object.entries(componentMap)) {
    const usedByAffected = urls.filter(u => affectedUrlSet.has(u));
    const requiresRebuild = usedByAffected.length > 0;
    if (requiresRebuild) componentsRebuilt++;
    else componentsReused++;

    components.push({
      componentId:     compId,
      type:            "unknown",
      affectedByUrls:  usedByAffected,
      requiresRebuild,
      reuseCandidate:  !requiresRebuild,
    });
  }

  // Heuristic when no componentMap provided
  if (totalComponents === 0) {
    // Estimate: ~3 shared components per page on average; unchanged pages reuse all
    componentsReused  = finalSkipped.length * 3;
    componentsRebuilt = finalAffected.filter(n => n.classification !== "deleted").length * 3;
  }

  // ── Route graph ────────────────────────────────────────────────────────
  const routeImpacts: RouteImpact[] = [];
  const routeGroups = new Map<string, AffectedPage[]>();
  for (const page of finalAffected) {
    const route = pathSlug(page.url).replace(/\/[^/]+$/, "") || "/";
    const existing = routeGroups.get(route) ?? [];
    existing.push(page);
    routeGroups.set(route, existing);
  }
  for (const [route, pages] of routeGroups.entries()) {
    routeImpacts.push({
      route,
      affectedPages:    pages.map(p => p.url),
      structuralChange: pages.some(p => p.changeReasons.includes("structureChanged")),
      newRoute:         pages.some(p => p.classification === "new"),
      deletedRoute:     pages.every(p => p.classification === "deleted"),
    });
  }

  // ── Navigation impact ──────────────────────────────────────────────────
  const addedNavItems  = diffReport.newNodes.filter(n => isNavigationUrl(n.url, navigationUrls)).map(n => n.url);
  const removedNavItems = diffReport.deletedNodes.filter(n => isNavigationUrl(n.url, navigationUrls)).map(n => n.url);
  const navigationImpact: NavigationImpact = {
    navigationChanged:  navChanged,
    addedItems:         addedNavItems,
    removedItems:       removedNavItems,
    reorderedItems:     false,   // cannot detect without explicit nav ordering data
    rebuildRequired:    navChanged,
  };

  // ── Manifest impact ────────────────────────────────────────────────────
  const manifestImpact: ManifestImpact = {
    totalNodes:      diffReport.summary.total,
    changedNodes:    diffReport.summary.changed,
    newNodes:        diffReport.summary.new,
    deletedNodes:    diffReport.summary.deleted,
    unchangedNodes:  diffReport.summary.unchanged,
    integrityValid:  true,
  };

  // ── Assets ────────────────────────────────────────────────────────────
  // Estimate assets based on affected page count (heuristic: ~5 assets/page)
  const assetsPerPage   = 5;
  const assetsTotal     = diffReport.summary.total * assetsPerPage;
  const assetsRebuilt   = finalAffected.filter(n => n.classification !== "deleted").length * assetsPerPage;
  const assetsReused    = Math.max(0, assetsTotal - assetsRebuilt);
  const assetReusePercent = assetsTotal > 0 ? Math.round((assetsReused / assetsTotal) * 100) : 100;

  // ── Time savings ──────────────────────────────────────────────────────
  const estimatedFullTimeMs = diffReport.summary.total * avgPageCostMs
    + assetsTotal * avgAssetCostMs;

  const estimatedIncrementalMs =
    finalAffected.reduce((sum, p) => sum + p.estimatedCostMs, 0)
    + assetsRebuilt * avgAssetCostMs;

  const timeSavedMs = Math.max(0, estimatedFullTimeMs - estimatedIncrementalMs);
  const timeSavedPercent = estimatedFullTimeMs > 0
    ? Math.round((timeSavedMs / estimatedFullTimeMs) * 100)
    : 0;

  const skipRate = diffReport.summary.total > 0
    ? Math.round((finalSkipped.length / diffReport.summary.total) * 100) / 100
    : 0;

  // ── Determine scope ────────────────────────────────────────────────────
  const scope: RegenerationScope =
    finalAffected.length === 0 ? "none"
    : finalAffected.length === diffReport.summary.total ? "full"
    : "partial";

  // ── Collect warnings ───────────────────────────────────────────────────
  const warnings: string[] = [];
  if (navChanged)             warnings.push("Navigation structure changed — all pages require nav rebuild");
  if (propagatedList.length)  warnings.push(`${propagatedList.length} additional page(s) affected via dependency propagation`);
  if (diffReport.summary.deleted > 0)
    warnings.push(`${diffReport.summary.deleted} page(s) deleted — remove from Website Prime output`);
  if (scope === "full")       warnings.push("All pages changed — consider whether full regeneration is faster than incremental");

  // ── Assemble outputs ───────────────────────────────────────────────────
  const metrics: RegenerationMetrics = {
    totalPagesBase:       diffReport.baseManifestNodeCount,
    totalPagesNew:        diffReport.newManifestNodeCount,
    pagesAffected:        finalAffected.length,
    pagesSkipped:         finalSkipped.length,
    pagesNew:             diffReport.summary.new,
    pagesChanged:         diffReport.summary.changed + propagatedList.length,
    pagesDeleted:         diffReport.summary.deleted,
    componentsTotal:      Math.max(totalComponents, componentsReused + componentsRebuilt),
    componentsReused,
    componentsRebuilt,
    assetsTotal,
    assetsReused,
    assetsRebuilt,
    assetReusePercent,
    estimatedFullTimeMs,
    estimatedIncrementalMs,
    timeSavedMs,
    timeSavedPercent,
    skipRate,
  };

  const report: IncrementalRegenerationReport = {
    schemaVersion:   "C1-1",
    baseJobId, newJobId,
    generatedAt:     now,
    durationMs:      Date.now() - t0,
    scope,
    metrics,
    affectedPageUrls: finalAffected.map(p => p.url),
    skippedPageUrls:  finalSkipped.map(p => p.url),
    changeReasonsMap,
    warnings,
    r2Keys: { report: null, affectedPages: null, dependencyImpact: null, summary: null },
  };

  const affectedPagesDoc: AffectedPagesReport = {
    schemaVersion:  "C1-1",
    baseJobId, newJobId,
    generatedAt:    now,
    totalPages:     diffReport.summary.total,
    affectedCount:  finalAffected.length,
    skippedCount:   finalSkipped.length,
    affectedPages:  finalAffected,
    skippedPages:   finalSkipped,
    r2Key:          null,
  };

  const dependencyImpact: DependencyImpactReport = {
    schemaVersion: "C1-1",
    baseJobId, newJobId,
    generatedAt:   now,
    componentTree: {
      totalComponents,
      affectedComponents: componentsRebuilt,
      reuseableComponents: componentsReused,
      components,
    },
    routeGraph:       routeImpacts,
    navigationImpact,
    manifestImpact,
    propagationDepth,
    r2Key:            null,
  };

  // Top changed reasons (aggregated)
  const reasonCounts: Record<string, number> = {};
  for (const reasons of Object.values(changeReasonsMap)) {
    for (const r of reasons) { reasonCounts[r] = (reasonCounts[r] ?? 0) + 1; }
  }
  const topChangedReasons = Object.entries(reasonCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([reason, count]) => `${reason} (${count} page(s))`);

  const summary: RegenerationSummary = {
    schemaVersion:     "C1-1",
    baseJobId, newJobId,
    generatedAt:       now,
    scope,
    headline: scope === "none"
      ? "No changes detected — regeneration not required"
      : scope === "full"
      ? "All pages changed — full regeneration required"
      : `${finalAffected.length} of ${diffReport.summary.total} page(s) require regeneration (${timeSavedPercent}% time saved)`,
    pagesAffected:     finalAffected.length,
    pagesSkipped:      finalSkipped.length,
    timeSavedMs,
    timeSavedPercent,
    assetReusePercent,
    componentsReused,
    topChangedUrls:    finalAffected.slice(0, 10).map(p => p.url),
    topChangedReasons,
    nearInstant:       finalAffected.length <= diffReport.summary.total * 0.1,
  };

  // ── Persist ───────────────────────────────────────────────────────────
  const prefix = `jobs/${newJobId}/c1`;
  const keys   = {
    report:           `${prefix}/incremental-regeneration-report.json`,
    affectedPages:    `${prefix}/affected-pages.json`,
    dependencyImpact: `${prefix}/dependency-impact-report.json`,
    summary:          `${prefix}/regeneration-summary.json`,
  };

  async function upload(key: string, data: unknown): Promise<boolean> {
    const cloud = getDefaultCloudProvider();
    if (!cloud.isConfigured()) return false;
    try {
      await cloud.upload({ key, data: Buffer.from(JSON.stringify(data, null, 2)), contentType: "application/json" });
      return true;
    } catch (err) {
      logger.warn({ err, key }, "C1: R2 upload failed (non-fatal)");
      return false;
    }
  }

  await Promise.all([
    writeFile(join(OUT_DIR, "incremental-regeneration-report.json"), JSON.stringify(report,           null, 2), "utf8"),
    writeFile(join(OUT_DIR, "affected-pages.json"),                  JSON.stringify(affectedPagesDoc, null, 2), "utf8"),
    writeFile(join(OUT_DIR, "dependency-impact-report.json"),        JSON.stringify(dependencyImpact, null, 2), "utf8"),
    writeFile(join(OUT_DIR, "regeneration-summary.json"),            JSON.stringify(summary,          null, 2), "utf8"),
    upload(keys.report,           report).then(ok => { if (ok) report.r2Keys.report           = keys.report;           }),
    upload(keys.affectedPages,    affectedPagesDoc).then(ok => { if (ok) { report.r2Keys.affectedPages    = keys.affectedPages;    affectedPagesDoc.r2Key = keys.affectedPages; } }),
    upload(keys.dependencyImpact, dependencyImpact).then(ok => { if (ok) { report.r2Keys.dependencyImpact = keys.dependencyImpact; dependencyImpact.r2Key = keys.dependencyImpact; } }),
    upload(keys.summary,          summary).then(ok => { if (ok) report.r2Keys.summary          = keys.summary;          }),
  ]);

  _store.set(storeKey(baseJobId, newJobId), { report, affectedPages: affectedPagesDoc, dependencyImpact, summary });

  logger.info(
    {
      baseJobId, newJobId, scope,
      pagesAffected: finalAffected.length,
      pagesSkipped:  finalSkipped.length,
      timeSavedMs,
      timeSavedPercent,
      assetReusePercent,
      nearInstant:   summary.nearInstant,
      durationMs:    report.durationMs,
    },
    "C1: incremental regeneration analysis complete",
  );

  return { report, affectedPages: affectedPagesDoc, dependencyImpact, summary };
}
