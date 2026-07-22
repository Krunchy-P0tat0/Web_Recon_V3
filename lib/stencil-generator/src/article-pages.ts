/**
 * article-pages.ts — Article / Blog / Guide / Docs / Portfolio / FAQ Page Generator
 *
 * Produces one PageDefinition per content node classified as a "content page"
 * (not a category index, tag page, or homepage).
 *
 * Determines per page:
 *   - Layout from SiteGraph layoutAssignments
 *   - Template components matching the layout
 *   - Article config (read time, ToC, featured image, image strategy)
 *   - Author block presence
 *   - Related content selection
 *   - Full breadcrumb chain from NavigationTree
 */

import type { SiteGraph, ClassificationResult, LayoutType } from "@workspace/site-intelligence";
import type {
  PageDefinition,
  PageType,
  ComponentRequirement,
  ContentSource,
  PageMeta,
  PageRelationshipLinks,
  ArticleConfig,
  GalleryConfig,
} from "./types";

// ---------------------------------------------------------------------------
// Page type from content type
// ---------------------------------------------------------------------------

function contentTypeToPageType(ct: ClassificationResult["contentType"]): PageType {
  const map: Record<ClassificationResult["contentType"], PageType> = {
    ARTICLE:      "article",
    BLOG:         "blog",
    GUIDE:        "guide",
    LANDING_PAGE: "landing",
    PORTFOLIO:    "portfolio",
    GALLERY:      "gallery",
    FAQ:          "faq",
    DOCS:         "docs",
  };
  return map[ct];
}

// ---------------------------------------------------------------------------
// Estimated read time (words per minute = 250)
// ---------------------------------------------------------------------------

function estimateReadTime(wordCount: number): number {
  return Math.max(1, Math.ceil(wordCount / 250));
}

// ---------------------------------------------------------------------------
// Image strategy selection
// ---------------------------------------------------------------------------

function selectImageStrategy(
  imageCount: number,
  wordCount: number
): ArticleConfig["imageStrategy"] {
  if (imageCount === 0) return "inline";
  const ratio = imageCount / Math.max(wordCount, 1);
  if (ratio > 0.05 || imageCount >= 8) return "gallery";
  if (imageCount >= 3) return "sidebar";
  return "inline";
}

// ---------------------------------------------------------------------------
// Article config builder
// ---------------------------------------------------------------------------

function buildArticleConfig(
  graph: SiteGraph,
  nodeId: string,
  wordCount: number,
  imageCount: number
): ArticleConfig {
  const firstImageAsset = graph.assetGraph.assets.find(
    (a) =>
      !a.isDuplicate &&
      !a.isMissing &&
      a.assetType === "image" &&
      a.referencedByNodeIds.includes(nodeId)
  );

  return {
    estimatedReadTime: estimateReadTime(wordCount),
    hasAuthorBlock: graph.stats.byContentType.BLOG > 0,
    hasTableOfContents: wordCount >= 800,
    hasFeaturedImage: !!firstImageAsset,
    featuredImageAssetId: firstImageAsset?.id ?? null,
    relatedContentLimit: 3,
    imageStrategy: selectImageStrategy(imageCount, wordCount),
  };
}

// ---------------------------------------------------------------------------
// Gallery config builder
// ---------------------------------------------------------------------------

function buildGalleryConfig(imageCount: number): GalleryConfig {
  let columns: GalleryConfig["columns"] = 3;
  if (imageCount >= 12) columns = 4;
  else if (imageCount <= 4) columns = 2;

  return {
    columns,
    hasLightbox: imageCount >= 3,
    totalImages: imageCount,
    previewCount: Math.min(imageCount, 12),
    aspectRatio: "mixed",
  };
}

// ---------------------------------------------------------------------------
// Components for content pages
// ---------------------------------------------------------------------------

function buildArticleComponents(
  layout: LayoutType,
  pageType: PageType,
  articleConfig: ArticleConfig,
  hasTags: boolean,
  hasRelated: boolean
): ComponentRequirement[] {
  const components: ComponentRequirement[] = [];
  let order = 0;

  // Meta (always)
  components.push({ component: "MetaTags",       required: true,  slot: "meta",    order: order++, props: [] });
  components.push({ component: "OpenGraphTags",  required: true,  slot: "meta",    order: order++, props: [] });
  components.push({ component: "StructuredData", required: false, slot: "meta",    order: order++,
    props: [{ name: "type", value: "Article", dynamic: false }] });

  // Nav + breadcrumb (always)
  components.push({ component: "NavigationBar", required: true, slot: "header", order: order++, props: [] });
  components.push({ component: "Breadcrumb",    required: true, slot: "header", order: order++, props: [] });

  // Featured image
  if (articleConfig.hasFeaturedImage) {
    components.push({
      component: "ImagePlacement",
      required: false,
      slot: "main",
      order: order++,
      props: [
        { name: "assetId", value: articleConfig.featuredImageAssetId, dynamic: true, sourceField: "featuredImageAssetId" },
        { name: "variant", value: "hero", dynamic: false },
      ],
    });
  }

  // Table of contents for long pages
  if (articleConfig.hasTableOfContents) {
    components.push({
      component: "TableOfContents",
      required: false,
      slot: "sidebar",
      order: order++,
      props: [{ name: "minHeadings", value: 3, dynamic: false }],
    });
  }

  // Gallery grid for gallery/portfolio
  if (layout === "GalleryLayout" || pageType === "gallery") {
    components.push({
      component: "GalleryGrid",
      required: true,
      slot: "main",
      order: order++,
      props: [{ name: "hasLightbox", value: true, dynamic: false }],
    });
    components.push({
      component: "GalleryLightbox",
      required: false,
      slot: "overlay",
      order: order++,
      props: [],
    });
  }

  // FAQ accordion
  if (pageType === "faq") {
    components.push({
      component: "FAQAccordion",
      required: true,
      slot: "main",
      order: order++,
      props: [],
    });
  }

  // Portfolio card for portfolio pages
  if (pageType === "portfolio") {
    components.push({
      component: "PortfolioCard",
      required: true,
      slot: "main",
      order: order++,
      props: [],
    });
  }

  // Code block for docs/guides
  if (pageType === "docs" || pageType === "guide") {
    components.push({
      component: "CodeBlock",
      required: false,
      slot: "main",
      order: order++,
      props: [],
    });
  }

  // Author block
  if (articleConfig.hasAuthorBlock) {
    components.push({
      component: "AuthorBlock",
      required: false,
      slot: "main",
      order: order++,
      props: [],
    });
  }

  // Tags
  if (hasTags) {
    components.push({
      component: "TagCloud",
      required: false,
      slot: "main",
      order: order++,
      props: [{ name: "variant", value: "inline", dynamic: false }],
    });
  }

  // Related content
  if (hasRelated) {
    components.push({
      component: "RelatedContent",
      required: false,
      slot: "main",
      order: order++,
      props: [{ name: "limit", value: 3, dynamic: false }],
    });
  }

  // Footer
  components.push({ component: "Footer", required: true, slot: "footer", order: order++, props: [] });

  return components;
}

// ---------------------------------------------------------------------------
// Route lookup helper
// ---------------------------------------------------------------------------

function routeForNode(graph: SiteGraph, nodeId: string): string {
  const entry = graph.routeMap.routes.find((r) => r.nodeId === nodeId);
  return entry?.route ?? `/${nodeId}`;
}

// ---------------------------------------------------------------------------
// Breadcrumb chain from SiteGraph
// ---------------------------------------------------------------------------

function buildBreadcrumbIds(graph: SiteGraph, nodeId: string): string[] {
  const trail = graph.navigation.breadcrumbs[nodeId];
  if (!trail) return [];
  return trail.map((b) => b.nodeId).filter((id) => id !== nodeId);
}

// ---------------------------------------------------------------------------
// Public: generate PageDefinitions for all content nodes
// ---------------------------------------------------------------------------

export function generateArticlePages(graph: SiteGraph): PageDefinition[] {
  const pages: PageDefinition[] = [];

  // Index nodeId → word/image counts from graph nodes via classification list
  const layoutByNodeId = new Map(
    graph.layoutAssignments.map((a) => [a.nodeId, a])
  );
  const classificationByNodeId = new Map(
    graph.classifications.map((c) => [c.nodeId, c])
  );

  for (const classification of graph.classifications) {
    const { nodeId } = classification;
    const layout = layoutByNodeId.get(nodeId);
    if (!layout) continue;

    const route = routeForNode(graph, nodeId);
    const pageType = contentTypeToPageType(classification.contentType);

    // Gather per-node asset counts from the asset graph
    const nodeAssets = graph.assetGraph.assets.filter(
      (a) => a.referencedByNodeIds.includes(nodeId) && !a.isDuplicate
    );
    const imageCount = nodeAssets.filter((a) => a.assetType === "image").length;

    // Word count from layout signals
    const wordCount = layout.signals.wordCount;

    const articleConfig = buildArticleConfig(graph, nodeId, wordCount, imageCount);
    const galleryConfig =
      layout.layout === "GalleryLayout" ? buildGalleryConfig(imageCount) : undefined;

    // Tags for this node
    const nodeTags = graph.categoryGraph.tags.filter((t) =>
      t.nodeIds.includes(nodeId)
    );
    const hasTags = nodeTags.length > 0;

    // Related: sibling pages with same content type (up to 3)
    const relatedIds = graph.classifications
      .filter(
        (c) =>
          c.contentType === classification.contentType &&
          c.nodeId !== nodeId
      )
      .slice(0, 3)
      .map((c) => c.nodeId);

    const components = buildArticleComponents(
      layout.layout,
      pageType,
      articleConfig,
      hasTags,
      relatedIds.length > 0
    );

    // Breadcrumb chain
    const breadcrumbIds = buildBreadcrumbIds(graph, nodeId);

    // Find child nodes from graph navigation
    const navEntry = graph.navigation.primary
      .concat(graph.navigation.secondary)
      .find((n) => n.nodeId === nodeId);
    const childPageIds = (navEntry?.children ?? []).map((c) => c.nodeId);

    // Parent page
    const breadcrumb = graph.navigation.breadcrumbs[nodeId] ?? [];
    const parentEntry = breadcrumb.length >= 2 ? breadcrumb[breadcrumb.length - 2] : null;

    const contentSource: ContentSource = {
      type: "site_graph_node",
      nodeId,
    };

    const meta: PageMeta = {
      title: classification.url,
      description: null,
      canonicalUrl: route,
      ogTitle: classification.url,
      ogDescription: null,
      ogImage: articleConfig.featuredImageAssetId
        ? (graph.assetGraph.assets.find((a) => a.id === articleConfig.featuredImageAssetId)?.cloudPath ?? null)
        : null,
      publishedAt: null,
      modifiedAt: null,
      noIndex: false,
    };

    const relationships: PageRelationshipLinks = {
      parentPageId: parentEntry?.nodeId ?? null,
      childPageIds,
      relatedPageIds: relatedIds,
      breadcrumbPageIds: breadcrumbIds,
      nextPageId: null,
      prevPageId: null,
    };

    pages.push({
      id: `page__${nodeId}`,
      pageType,
      route,
      title: classification.url,
      layout: layout.layout,
      contentSource,
      components,
      meta,
      relationships,
      priority: pageType === "landing" ? 0.9 : pageType === "homepage" ? 1.0 : 0.7,
      changeFreq: pageType === "blog" || pageType === "article" ? "weekly" : "monthly",
      nodeId,
      classifiedAs: classification.contentType,
      articleConfig,
      galleryConfig,
      isGenerated: false,
    });
  }

  return pages;
}
