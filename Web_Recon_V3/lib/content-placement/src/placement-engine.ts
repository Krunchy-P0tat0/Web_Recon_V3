/**
 * placement-engine.ts — Phase 4.6 Content Placement Intelligence
 *
 * Orchestrates all placement sub-engines into a single PlacementReport.
 *
 * Execution order (all deterministic, all pure):
 *   1. Build lookup maps from SiteGraph
 *   2. Select featured nodes (featured-selector)
 *   3. For each content node: match slot (slot-matcher) + resolve path (route-resolver)
 *   4. Place category index pages (category-placer)
 *   5. Place tag index pages (category-placer)
 *   6. Compute stats
 *   7. Return PlacementReport
 */

import type {
  PortableManifest,
  SiteGraph,
  ClassificationResult,
  LayoutAssignment,
} from "@workspace/site-intelligence";
import type { StencilBlueprint } from "@workspace/stencil-library";
import type {
  PlacementInput,
  PlacementReport,
  PageAssignment,
  PlacementStats,
  SlotCategory,
  ContentType,
  LayoutType,
  PageType,
} from "./types.js";
import { matchSlot } from "./slot-matcher.js";
import { resolvePath } from "./route-resolver.js";
import { selectFeaturedNodes } from "./featured-selector.js";
import { placeCategoryNodes, placeTagNodes } from "./category-placer.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function inferSlotCategory(
  pageType: PageType,
  isFeatured: boolean,
  isIndex: boolean
): SlotCategory {
  if (isFeatured) return "featured";

  const utilityTypes: PageType[] = ["not_found", "sitemap_page", "search"];
  if (utilityTypes.includes(pageType)) return "utility";

  if (isIndex || ["homepage", "category", "tag", "blog"].includes(pageType)) {
    return "index";
  }

  return "content";
}

function buildSlotLabel(
  pageType: PageType,
  contentType: ContentType,
  isFeatured: boolean,
  categoryLabels: string[]
): string {
  if (isFeatured) {
    if (contentType === "GALLERY" || contentType === "PORTFOLIO") return "Featured";
    return "Featured";
  }

  if (categoryLabels.length > 0) {
    return categoryLabels[0]!;
  }

  const labels: Record<string, string> = {
    homepage:     "Home",
    article:      "Article",
    blog:         "Blog Post",
    guide:        "Guide",
    docs:         "Documentation",
    faq:          "FAQ",
    gallery:      "Gallery",
    portfolio:    "Portfolio",
    landing:      "Landing Page",
    category:     "Category",
    tag:          "Tag",
    search:       "Search",
    not_found:    "404",
    sitemap_page: "Sitemap",
  };

  return labels[pageType] ?? contentType;
}

function computeStats(
  assignments: PageAssignment[],
  categoryCount: number,
  tagCount: number,
  featuredCount: number
): PlacementStats {
  const bySlotCategory: Record<SlotCategory, number> = {
    content: 0, index: 0, featured: 0, utility: 0,
  };
  const byContentType: Record<string, number> = {};
  const byPageType: Record<string, number> = {};
  const byRouteId: Record<string, number> = {};
  let unresolvable = 0;
  let confidenceSum = 0;

  for (const a of assignments) {
    bySlotCategory[a.slotCategory] = (bySlotCategory[a.slotCategory] ?? 0) + 1;
    byContentType[a.contentType]   = (byContentType[a.contentType] ?? 0) + 1;
    byPageType[a.pageType]         = (byPageType[a.pageType] ?? 0) + 1;
    byRouteId[a.routeId]           = (byRouteId[a.routeId] ?? 0) + 1;
    if (a.confidence < 0.3) unresolvable++;
    confidenceSum += a.confidence;
  }

  return {
    totalAssignments: assignments.length,
    bySlotCategory,
    byContentType,
    byPageType,
    byRouteId,
    featuredCount,
    categoryAssignmentCount: categoryCount,
    tagAssignmentCount: tagCount,
    unresolvableCount: unresolvable,
    averageConfidence: assignments.length > 0
      ? parseFloat((confidenceSum / assignments.length).toFixed(3))
      : 0,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * placeContent — the main Phase 4.6 entry point.
 *
 * Pure and synchronous. Returns a complete PlacementReport.
 */
export function placeContent(input: PlacementInput): PlacementReport {
  const start = Date.now();
  const { jobId, seedUrl, stencilId, manifest, siteGraph, blueprint } = input;

  const routes = blueprint.routes;

  // Build fast lookup maps from SiteGraph
  const classMap = new Map<string, ClassificationResult>(
    siteGraph.classifications.map((c) => [c.nodeId, c])
  );
  const layoutMap = new Map<string, LayoutAssignment>(
    siteGraph.layoutAssignments.map((l) => [l.nodeId, l])
  );

  // Build category membership map: nodeId → CategoryNode[]
  const nodeCategoryMap = new Map<string, Array<{ id: string; label: string }>>();
  for (const cat of siteGraph.categoryGraph.categories) {
    for (const nodeId of cat.pageIds) {
      const existing = nodeCategoryMap.get(nodeId) ?? [];
      existing.push({ id: cat.id, label: cat.label });
      nodeCategoryMap.set(nodeId, existing);
    }
  }

  // Count total content nodes for category featured heuristic
  const contentNodes = manifest.nodes.filter(
    (n) => n.nodeType !== "root" && n.nodeType !== "asset"
  );
  const totalContentNodes = contentNodes.length;

  // Select featured nodes
  const featuredNodeIds = selectFeaturedNodes(
    manifest.nodes,
    siteGraph.classifications,
    siteGraph.layoutAssignments,
    stencilId,
    Math.min(3, routes.filter((r) => r.isIndex).length + 1)
  );

  // Build page assignments
  const assignments: PageAssignment[] = [];

  for (const node of manifest.nodes) {
    // Skip pure asset nodes
    if (node.nodeType === "asset") continue;

    const cls = classMap.get(node.id);
    const layout = layoutMap.get(node.id);

    const contentType: ContentType = cls?.contentType ?? "LANDING_PAGE";
    const layoutType: LayoutType   = layout?.layout ?? "MinimalLayout";
    const classConfidence          = cls?.confidence ?? 0.5;

    // Slot match
    const slotMatch = matchSlot(contentType, node.nodeType, node.relationships.depth, routes);

    // Resolve path
    const resolvedPath = resolvePath(slotMatch.route.pattern, {
      url:         node.metadata.url,
      title:       node.metadata.title,
      publishedAt: node.metadata.publishedAt,
      nodeId:      node.id,
    });

    // Categories for this node
    const cats = nodeCategoryMap.get(node.id) ?? [];
    const categoryIds    = cats.map((c) => c.id);
    const categoryLabels = cats.map((c) => c.label);

    const isFeatured = featuredNodeIds.has(node.id);
    const isIndex    = slotMatch.route.isIndex;

    const slotCategory = inferSlotCategory(slotMatch.route.pageType, isFeatured, isIndex);
    const slotLabel    = buildSlotLabel(
      slotMatch.route.pageType,
      contentType,
      isFeatured,
      categoryLabels
    );

    // Combined confidence: route match quality × classification confidence
    const confidence = parseFloat(
      (slotMatch.matchQuality * classConfidence).toFixed(3)
    );

    const reasoning =
      `${slotMatch.reasoning}. ` +
      `Classification confidence: ${(classConfidence * 100).toFixed(0)}%. ` +
      (isFeatured ? "Promoted to featured slot. " : "") +
      (cats.length > 0 ? `Categories: ${categoryLabels.join(", ")}.` : "");

    assignments.push({
      nodeId: node.id,
      url: node.metadata.url,
      title: node.metadata.title,
      contentType,
      layoutType,
      pageType: slotMatch.route.pageType,
      routeId: slotMatch.route.id,
      routePattern: slotMatch.route.pattern,
      resolvedPath,
      slotLabel,
      slotCategory,
      categoryIds,
      categoryLabels,
      confidence,
      reasoning,
      isFeatured,
      isIndex,
    });
  }

  // Category index assignments
  const categoryAssignments = placeCategoryNodes(
    siteGraph.categoryGraph,
    routes,
    totalContentNodes
  );

  // Tag index assignments
  const tagAssignments = placeTagNodes(siteGraph.categoryGraph, routes);

  const featuredList = Array.from(featuredNodeIds);

  const stats = computeStats(
    assignments,
    categoryAssignments.length,
    tagAssignments.length,
    featuredList.length
  );

  return {
    version:    "1.0",
    jobId,
    seedUrl,
    stencilId,
    generatedAt: new Date().toISOString(),
    durationMs:  Date.now() - start,
    assignments,
    categoryAssignments,
    tagAssignments,
    featuredNodeIds: featuredList,
    stats,
  };
}
