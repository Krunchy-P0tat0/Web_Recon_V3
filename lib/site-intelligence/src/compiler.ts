/**
 * compiler.ts — Site Graph Compiler
 *
 * Merges all intelligence sub-graphs into the unified SiteGraph.
 * This is the sole entry point for transforming a PortableManifest
 * into a fully-understood SiteGraph ready for a StencilRenderer.
 *
 * Pipeline:
 *   PortableManifest
 *     → Classification Engine   → ClassificationResult[]
 *     → Navigation Intelligence → NavigationTree
 *     → Route Intelligence      → RouteMap
 *     → Layout Intelligence     → LayoutAssignment[]
 *     → Category Intelligence   → CategoryGraph
 *     → Asset Intelligence      → AssetGraph
 *     → Site Graph Compiler     → SiteGraph
 *
 * No I/O. No external services. Purely deterministic.
 */

import { classifyAllNodes } from "./classification";
import { buildNavigationTree } from "./navigation";
import { buildRouteMap } from "./routing";
import { assignAllLayouts } from "./layout";
import { buildCategoryGraph } from "./categories";
import { buildAssetGraph } from "./assets";

import type {
  PortableManifest,
  PortablePageNode,
  SiteGraph,
  SiteGraphStats,
  ContentType,
  LayoutType,
  ClassificationResult,
} from "./types";

// ---------------------------------------------------------------------------
// ID generation — deterministic from seedUrl
// ---------------------------------------------------------------------------

function makeSiteGraphId(seedUrl: string): string {
  // Simple but stable: hash-like prefix from URL
  let hash = 0;
  for (let i = 0; i < seedUrl.length; i++) {
    const chr = seedUrl.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, "0");
  return `sg-${hex}`;
}

// ---------------------------------------------------------------------------
// Stats computation
// ---------------------------------------------------------------------------

function computeStats(
  nodes: PortablePageNode[],
  classifications: ClassificationResult[],
  layoutAssignments: ReturnType<typeof assignAllLayouts>,
  assetGraph: ReturnType<typeof buildAssetGraph>,
  navigationTree: ReturnType<typeof buildNavigationTree>,
  routeMap: ReturnType<typeof buildRouteMap>
): SiteGraphStats {
  const contentNodes = nodes.filter(
    (n) => n.nodeType !== "root" && n.nodeType !== "asset"
  );

  // By content type
  const byContentType: Record<ContentType, number> = {
    ARTICLE: 0, BLOG: 0, GUIDE: 0, LANDING_PAGE: 0,
    PORTFOLIO: 0, GALLERY: 0, FAQ: 0, DOCS: 0,
  };
  for (const c of classifications) {
    byContentType[c.contentType]++;
  }

  // By layout
  const byLayout: Record<LayoutType, number> = {
    ArticleLayout: 0, GalleryLayout: 0, LandingLayout: 0,
    DocumentationLayout: 0, PortfolioLayout: 0, IndexLayout: 0, MinimalLayout: 0,
  };
  for (const a of layoutAssignments) {
    byLayout[a.layout]++;
  }

  // Node type counts
  const errorNodes = nodes.filter((n) => n.status === "error").length;
  const skippedNodes = nodes.filter((n) => n.status === "skipped").length;
  const indexNodes = nodes.filter((n) => n.nodeType === "index").length;
  const rootNodes = nodes.filter((n) => n.nodeType === "root").length;

  // Word count average
  const totalWords = contentNodes.reduce((s, n) => s + n.content.wordCount, 0);
  const avgWordCount = contentNodes.length > 0
    ? Math.round(totalWords / contentNodes.length)
    : 0;

  // Average images per page
  const totalImages = contentNodes.reduce((s, n) => s + n.media.images.length, 0);
  const avgImagesPerPage = contentNodes.length > 0
    ? Math.round((totalImages / contentNodes.length) * 10) / 10
    : 0;

  return {
    totalNodes: nodes.length,
    contentNodes: contentNodes.length,
    indexNodes,
    rootNodes,
    errorNodes,
    skippedNodes,
    byContentType,
    byLayout,
    totalAssets: assetGraph.totalAssets,
    totalImages,
    totalVideos: contentNodes.reduce((s, n) => s + n.media.videos.length, 0),
    totalCategories: 0, // filled in after category graph
    totalRoutes: routeMap.totalRoutes,
    orphanCount: navigationTree.orphanPages.length,
    collisionCount: routeMap.collisionCount,
    missingAssetCount: assetGraph.missingAssets.length,
    averageWordCount: avgWordCount,
    averageImagesPerPage: avgImagesPerPage,
  };
}

// ---------------------------------------------------------------------------
// Public: compile a PortableManifest into a SiteGraph
// ---------------------------------------------------------------------------

export function compileSiteGraph(manifest: PortableManifest): SiteGraph {
  const nodes = manifest.nodes;

  // Run all intelligence engines in order
  const classifications = classifyAllNodes(nodes);
  const navigation = buildNavigationTree(nodes);
  const routeMap = buildRouteMap(nodes);
  const layoutAssignments = assignAllLayouts(nodes, classifications);
  const categoryGraph = buildCategoryGraph(nodes);
  const assetGraph = buildAssetGraph(nodes);

  // Compute stats
  const stats = computeStats(
    nodes,
    classifications,
    layoutAssignments,
    assetGraph,
    navigation,
    routeMap
  );
  stats.totalCategories = categoryGraph.totalCategories;

  // Content node count (excludes root and asset nodes)
  const contentNodes = nodes.filter(
    (n) => n.nodeType !== "root" && n.nodeType !== "asset"
  );

  return {
    id: makeSiteGraphId(manifest.seedUrl),
    version: "1.0",
    generatedAt: new Date().toISOString(),
    seedUrl: manifest.seedUrl,
    manifestId: manifest.id,
    totalNodes: nodes.length,
    contentNodes: contentNodes.length,
    classifications,
    navigation,
    routeMap,
    layoutAssignments,
    categoryGraph,
    assetGraph,
    stats,
  };
}
