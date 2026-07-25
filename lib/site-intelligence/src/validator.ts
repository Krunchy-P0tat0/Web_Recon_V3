/**
 * validator.ts — Site Graph Validation Layer
 *
 * Validates a compiled SiteGraph for internal consistency and
 * renderer-readiness, then produces a SiteValidationReport.
 *
 * Validation sections:
 *   routes        — no collisions, all nodes have routes, slugs are URL-safe
 *   navigation    — no broken parent refs, acceptable orphan ratio
 *   assets        — missing asset ratio, duplicate detection
 *   layouts       — every content node has a layout assignment
 *   categories    — connected category graph, min coverage
 *   classifications — all content nodes classified, confidence distribution
 *
 * Grades: PASS | PARTIAL_PASS | FAIL
 */

import type {
  SiteGraph,
  ValidationIssue,
  ValidationSection,
  ValidationGrade,
  SiteValidationReport,
} from "./types";

// ---------------------------------------------------------------------------
// Grading helpers
// ---------------------------------------------------------------------------

function gradeSection(issues: ValidationIssue[]): ValidationGrade {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  if (errors === 0 && warnings === 0) return "PASS";
  if (errors === 0) return "PARTIAL_PASS";
  return "FAIL";
}

function buildSection(issues: ValidationIssue[], summary: string): ValidationSection {
  return {
    grade: gradeSection(issues),
    issues,
    passCount: issues.filter((i) => i.severity === "info").length,
    warnCount: issues.filter((i) => i.severity === "warning").length,
    errorCount: issues.filter((i) => i.severity === "error").length,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Route validation
// ---------------------------------------------------------------------------

function validateRoutes(graph: SiteGraph): ValidationSection {
  const issues: ValidationIssue[] = [];
  const { routeMap, totalNodes } = graph;

  // Collision check
  if (routeMap.collisionCount > 0) {
    issues.push({
      severity: "warning",
      category: "routes",
      code: "ROUTE_COLLISIONS",
      message: `${routeMap.collisionCount} route collision(s) were automatically resolved with numeric suffixes.`,
    });
  }

  // Coverage check
  const routedNodeCount = routeMap.routes.length;
  const expectedNodeCount = graph.contentNodes;
  if (routedNodeCount < expectedNodeCount) {
    const missing = expectedNodeCount - routedNodeCount;
    issues.push({
      severity: "error",
      category: "routes",
      code: "MISSING_ROUTES",
      message: `${missing} content node(s) have no route assignment.`,
    });
  }

  // Validate slug safety
  const unsafeRoutes = routeMap.routes.filter((r) =>
    /[^a-z0-9\-_/]/.test(r.route)
  );
  if (unsafeRoutes.length > 0) {
    issues.push({
      severity: "warning",
      category: "routes",
      code: "UNSAFE_ROUTE_CHARS",
      message: `${unsafeRoutes.length} route(s) contain characters that may not be URL-safe.`,
    });
  }

  // Fallback route count
  const fallbackRoutes = routeMap.routes.filter((r) => r.routeSource === "node_id_fallback");
  if (fallbackRoutes.length > 0) {
    issues.push({
      severity: "warning",
      category: "routes",
      code: "FALLBACK_ROUTES",
      message: `${fallbackRoutes.length} route(s) used node_id as fallback — title/URL extraction may have failed.`,
    });
  }

  const summary =
    issues.length === 0
      ? `All ${routeMap.totalRoutes} routes are valid, collision-free, and URL-safe.`
      : `${routeMap.totalRoutes} routes generated. Issues: ${issues.length}.`;

  return buildSection(issues, summary);
}

// ---------------------------------------------------------------------------
// Navigation validation
// ---------------------------------------------------------------------------

function validateNavigation(graph: SiteGraph): ValidationSection {
  const issues: ValidationIssue[] = [];
  const { navigation } = graph;

  // Orphan ratio
  const orphanCount = navigation.orphanPages.length;
  const total = navigation.totalNavigableNodes;
  if (total > 0) {
    const orphanRatio = orphanCount / total;
    if (orphanRatio > 0.5) {
      issues.push({
        severity: "error",
        category: "navigation",
        code: "HIGH_ORPHAN_RATIO",
        message: `${orphanCount} of ${total} navigable pages are orphans (${Math.round(orphanRatio * 100)}%). Site structure may be broken.`,
      });
    } else if (orphanRatio > 0.2) {
      issues.push({
        severity: "warning",
        category: "navigation",
        code: "ELEVATED_ORPHAN_COUNT",
        message: `${orphanCount} orphan page(s) detected (${Math.round(orphanRatio * 100)}% of navigable nodes).`,
      });
    }
  }

  // Broken parent refs
  const brokenRefs = navigation.orphanPages.filter((o) => o.reason === "broken_parent_ref");
  if (brokenRefs.length > 0) {
    issues.push({
      severity: "error",
      category: "navigation",
      code: "BROKEN_PARENT_REFS",
      message: `${brokenRefs.length} node(s) reference a parent ID that does not exist in the manifest.`,
    });
  }

  // Duplicate paths
  if (navigation.duplicatePaths.length > 0) {
    issues.push({
      severity: "warning",
      category: "navigation",
      code: "DUPLICATE_PATHS",
      message: `${navigation.duplicatePaths.length} duplicate URL path(s) detected.`,
    });
  }

  // Primary nav coverage
  if (navigation.primary.length === 0 && total > 5) {
    issues.push({
      severity: "warning",
      category: "navigation",
      code: "EMPTY_PRIMARY_NAV",
      message: "No primary navigation items detected despite having content nodes.",
    });
  }

  const summary =
    issues.length === 0
      ? `Navigation tree valid. ${navigation.primary.length} primary, ${navigation.secondary.length} secondary items. No orphans.`
      : `Navigation: ${orphanCount} orphan(s), ${navigation.duplicatePaths.length} duplicate(s). Issues: ${issues.length}.`;

  return buildSection(issues, summary);
}

// ---------------------------------------------------------------------------
// Asset validation
// ---------------------------------------------------------------------------

function validateAssets(graph: SiteGraph): ValidationSection {
  const issues: ValidationIssue[] = [];
  const { assetGraph } = graph;

  // Missing assets
  if (assetGraph.missingAssets.length > 0) {
    const ratio = assetGraph.totalAssets > 0
      ? assetGraph.missingAssets.length / assetGraph.totalAssets
      : 0;

    if (ratio > 0.3) {
      issues.push({
        severity: "error",
        category: "assets",
        code: "HIGH_MISSING_ASSET_RATIO",
        message: `${assetGraph.missingAssets.length} of ${assetGraph.totalAssets} assets are missing (${Math.round(ratio * 100)}%). Renderer will have significant broken media.`,
      });
    } else if (assetGraph.missingAssets.length > 0) {
      issues.push({
        severity: "warning",
        category: "assets",
        code: "MISSING_ASSETS",
        message: `${assetGraph.missingAssets.length} asset(s) failed to download and will appear broken in the rendered site.`,
      });
    }
  }

  // Duplicate assets
  if (assetGraph.duplicateGroups.length > 0) {
    issues.push({
      severity: "warning",
      category: "assets",
      code: "DUPLICATE_ASSETS",
      message: `${assetGraph.duplicateGroups.length} duplicate asset group(s) detected. Renderer may include redundant files.`,
    });
  }

  // Orphan assets
  if (assetGraph.orphanAssets.length > 0) {
    issues.push({
      severity: "warning",
      category: "assets",
      code: "ORPHAN_ASSETS",
      message: `${assetGraph.orphanAssets.length} asset(s) are not referenced by any content node.`,
    });
  }

  // Unresolved bindings
  const { bindingReport } = assetGraph;
  if (bindingReport.unresolvedBindings > 0) {
    issues.push({
      severity: "warning",
      category: "assets",
      code: "UNRESOLVED_BINDINGS",
      message: `${bindingReport.unresolvedBindings} of ${bindingReport.totalBindings} asset binding(s) are unresolved.`,
    });
  }

  const summary =
    issues.length === 0
      ? `Asset graph valid. ${assetGraph.totalAssets} assets, ${Math.round(assetGraph.totalBytes / 1024)} KB total. No missing assets.`
      : `Assets: ${assetGraph.missingAssets.length} missing, ${assetGraph.duplicateGroups.length} duplicate groups. Issues: ${issues.length}.`;

  return buildSection(issues, summary);
}

// ---------------------------------------------------------------------------
// Layout validation
// ---------------------------------------------------------------------------

function validateLayouts(graph: SiteGraph): ValidationSection {
  const issues: ValidationIssue[] = [];

  const assignedNodeIds = new Set(graph.layoutAssignments.map((a) => a.nodeId));

  // Coverage: every content node should have a layout
  const contentNodeCount = graph.contentNodes;
  const assignedCount = assignedNodeIds.size;

  if (assignedCount < contentNodeCount) {
    issues.push({
      severity: "error",
      category: "layouts",
      code: "MISSING_LAYOUT_ASSIGNMENTS",
      message: `${contentNodeCount - assignedCount} content node(s) have no layout assignment.`,
    });
  }

  // Low confidence assignments
  const lowConfidence = graph.layoutAssignments.filter((a) => a.confidence < 0.5);
  if (lowConfidence.length > 0) {
    issues.push({
      severity: "warning",
      category: "layouts",
      code: "LOW_CONFIDENCE_LAYOUTS",
      message: `${lowConfidence.length} layout assignment(s) have confidence below 50%.`,
    });
  }

  // Minimal layout overuse
  const minimalLayouts = graph.layoutAssignments.filter((a) => a.layout === "MinimalLayout");
  if (minimalLayouts.length > contentNodeCount * 0.3) {
    issues.push({
      severity: "warning",
      category: "layouts",
      code: "EXCESSIVE_MINIMAL_LAYOUTS",
      message: `${minimalLayouts.length} pages assigned MinimalLayout (${Math.round((minimalLayouts.length / contentNodeCount) * 100)}%) — many pages may be stubs or errors.`,
    });
  }

  const summary =
    issues.length === 0
      ? `All ${assignedCount} content nodes have layout assignments.`
      : `Layouts: ${assignedCount}/${contentNodeCount} assigned. Issues: ${issues.length}.`;

  return buildSection(issues, summary);
}

// ---------------------------------------------------------------------------
// Category validation
// ---------------------------------------------------------------------------

function validateCategories(graph: SiteGraph): ValidationSection {
  const issues: ValidationIssue[] = [];
  const { categoryGraph } = graph;

  // Uncategorized ratio
  const uncatCount = categoryGraph.uncategorizedPageIds.length;
  const totalContent = graph.contentNodes;
  if (totalContent > 0) {
    const uncatRatio = uncatCount / totalContent;
    if (uncatRatio > 0.5) {
      issues.push({
        severity: "warning",
        category: "categories",
        code: "HIGH_UNCATEGORIZED_RATIO",
        message: `${uncatCount} of ${totalContent} content pages (${Math.round(uncatRatio * 100)}%) have no category assignment.`,
      });
    }
  }

  // Empty categories (categories with no pages)
  const emptyCats = categoryGraph.categories.filter((c) => c.pageCount === 0);
  if (emptyCats.length > 0) {
    issues.push({
      severity: "warning",
      category: "categories",
      code: "EMPTY_CATEGORIES",
      message: `${emptyCats.length} category node(s) have zero page assignments.`,
    });
  }

  const summary =
    issues.length === 0
      ? `Category graph valid. ${categoryGraph.totalCategories} categories, ${categoryGraph.tags.length} tags.`
      : `Categories: ${categoryGraph.totalCategories} total, ${uncatCount} uncategorized pages. Issues: ${issues.length}.`;

  return buildSection(issues, summary);
}

// ---------------------------------------------------------------------------
// Classification validation
// ---------------------------------------------------------------------------

function validateClassifications(graph: SiteGraph): ValidationSection {
  const issues: ValidationIssue[] = [];

  const classifiedCount = graph.classifications.length;
  const contentCount = graph.contentNodes;

  if (classifiedCount < contentCount) {
    issues.push({
      severity: "error",
      category: "classification",
      code: "UNCLASSIFIED_NODES",
      message: `${contentCount - classifiedCount} content node(s) were not classified.`,
    });
  }

  // Low confidence distribution
  const lowConf = graph.classifications.filter((c) => c.confidence < 0.3);
  if (lowConf.length > classifiedCount * 0.4) {
    issues.push({
      severity: "warning",
      category: "classification",
      code: "LOW_CLASSIFICATION_CONFIDENCE",
      message: `${lowConf.length} page(s) have classification confidence below 30%.`,
    });
  }

  const summary =
    issues.length === 0
      ? `All ${classifiedCount} content nodes classified successfully.`
      : `Classifications: ${classifiedCount}/${contentCount} complete. Issues: ${issues.length}.`;

  return buildSection(issues, summary);
}

// ---------------------------------------------------------------------------
// Overall grade computation
// ---------------------------------------------------------------------------

function computeOverallGrade(sections: SiteValidationReport["sections"]): ValidationGrade {
  const grades = Object.values(sections).map((s) => s.grade);
  if (grades.includes("FAIL")) return "FAIL";
  if (grades.includes("PARTIAL_PASS")) return "PARTIAL_PASS";
  return "PASS";
}

function computeRenderabilityBlockers(
  sections: SiteValidationReport["sections"],
  graph: SiteGraph
): string[] {
  const blockers: string[] = [];

  if (sections.routes.grade === "FAIL") {
    blockers.push("Route generation has critical errors — renderer cannot build page URLs.");
  }
  if (sections.layouts.grade === "FAIL") {
    blockers.push("Layout assignments incomplete — renderer cannot determine page templates.");
  }
  if (sections.classifications.grade === "FAIL") {
    blockers.push("Classification failures — renderer cannot determine content structure.");
  }
  if (graph.contentNodes === 0) {
    blockers.push("No content nodes — nothing to render.");
  }

  return blockers;
}

// ---------------------------------------------------------------------------
// Public: validate a SiteGraph
// ---------------------------------------------------------------------------

export function validateSiteGraph(graph: SiteGraph): SiteValidationReport {
  const sections = {
    routes: validateRoutes(graph),
    navigation: validateNavigation(graph),
    assets: validateAssets(graph),
    layouts: validateLayouts(graph),
    categories: validateCategories(graph),
    classifications: validateClassifications(graph),
  };

  const overallGrade = computeOverallGrade(sections);
  const renderabilityBlockers = computeRenderabilityBlockers(sections, graph);
  const isRenderable = renderabilityBlockers.length === 0;

  const allIssues = Object.values(sections).flatMap((s) => s.issues);
  const totalErrors = allIssues.filter((i) => i.severity === "error").length;
  const totalWarnings = allIssues.filter((i) => i.severity === "warning").length;

  const summary =
    overallGrade === "PASS"
      ? `SiteGraph validation PASS. ${graph.contentNodes} content pages, ${graph.routeMap.totalRoutes} routes, ${graph.assetGraph.totalAssets} assets. Renderer-ready.`
      : overallGrade === "PARTIAL_PASS"
      ? `SiteGraph validation PARTIAL_PASS. ${totalErrors} error(s), ${totalWarnings} warning(s). Renderer may produce incomplete output.`
      : `SiteGraph validation FAIL. ${totalErrors} critical error(s) block rendering.`;

  return {
    siteGraphId: graph.id,
    seedUrl: graph.seedUrl,
    generatedAt: new Date().toISOString(),
    overallGrade,
    sections,
    totalIssues: allIssues.length,
    totalErrors,
    totalWarnings,
    isRenderable,
    renderabilityBlockers,
    summary,
  };
}
