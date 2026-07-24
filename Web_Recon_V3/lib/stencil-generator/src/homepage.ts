/**
 * homepage.ts — Homepage Blueprint Generator
 *
 * Analyzes the SiteGraph to produce a single Homepage PageDefinition.
 * Determines: hero config, featured content, latest content,
 * category highlights, and full component requirements.
 */

import type { SiteGraph, ClassificationResult } from "@workspace/site-intelligence";
import type {
  PageDefinition,
  ComponentRequirement,
  ContentSource,
  HeroConfig,
  PageMeta,
  PageRelationshipLinks,
} from "./types";

// ---------------------------------------------------------------------------
// Hero determination
// ---------------------------------------------------------------------------

function buildHeroConfig(graph: SiteGraph): HeroConfig {
  const firstImage = graph.assetGraph.assets.find(
    (a) => a.assetType === "image" && !a.isMissing && !a.isDuplicate
  );

  const rootNode = graph.classifications.find(
    (c) => c.contentType === "LANDING_PAGE"
  );

  // Hero style based on asset availability and content profile
  let style: HeroConfig["style"] = "text_only";
  if (firstImage) {
    style = graph.stats.totalImages > 10 ? "full_bleed" : "split";
  } else if (graph.stats.averageWordCount > 500) {
    style = "minimal";
  }

  return {
    style,
    hasImage: !!firstImage,
    imageAssetId: firstImage?.id ?? null,
    headline: rootNode
      ? graph.routeMap.routes.find((r) => r.nodeId === rootNode.nodeId)
          ?.url ?? graph.seedUrl
      : graph.seedUrl,
    subheadline:
      graph.stats.contentNodes > 0
        ? `${graph.stats.contentNodes} articles and resources`
        : null,
    ctaLabel: graph.stats.contentNodes > 0 ? "Browse content" : null,
    ctaRoute:
      graph.categoryGraph.categories.length > 0
        ? `/category/${graph.categoryGraph.categories[0]!.slug}`
        : null,
  };
}

// ---------------------------------------------------------------------------
// Featured content selection
// ---------------------------------------------------------------------------

function selectFeaturedContent(classifications: ClassificationResult[]): string[] {
  // Pick top 6 by confidence, prefer ARTICLE/BLOG/GUIDE
  return classifications
    .filter((c) =>
      ["ARTICLE", "BLOG", "GUIDE", "PORTFOLIO"].includes(c.contentType)
    )
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 6)
    .map((c) => c.nodeId);
}

// ---------------------------------------------------------------------------
// Latest content (by position in nodes array — preserve crawl order)
// ---------------------------------------------------------------------------

function selectLatestContent(classifications: ClassificationResult[]): string[] {
  return classifications
    .filter((c) =>
      ["ARTICLE", "BLOG", "GUIDE"].includes(c.contentType)
    )
    .slice(0, 8)
    .map((c) => c.nodeId);
}

// ---------------------------------------------------------------------------
// Component requirements for homepage
// ---------------------------------------------------------------------------

function buildHomepageComponents(
  graph: SiteGraph,
  heroConfig: HeroConfig
): ComponentRequirement[] {
  const components: ComponentRequirement[] = [];
  let order = 0;

  // Meta tags (always)
  components.push({
    component: "MetaTags",
    required: true,
    slot: "meta",
    order: order++,
    props: [],
  });
  components.push({
    component: "OpenGraphTags",
    required: true,
    slot: "meta",
    order: order++,
    props: [],
  });
  components.push({
    component: "StructuredData",
    required: false,
    slot: "meta",
    order: order++,
    props: [{ name: "type", value: "WebSite", dynamic: false }],
  });

  // Navigation
  components.push({
    component: "NavigationBar",
    required: true,
    slot: "header",
    order: order++,
    props: [{ name: "variant", value: "primary", dynamic: false }],
  });

  // Hero
  components.push({
    component: "HeroSection",
    required: true,
    slot: "main",
    order: order++,
    props: [
      { name: "style", value: heroConfig.style, dynamic: false },
      { name: "hasImage", value: heroConfig.hasImage, dynamic: false },
      { name: "ctaRoute", value: heroConfig.ctaRoute, dynamic: false },
    ],
  });

  // Search box if content is substantial
  if (graph.stats.contentNodes >= 5) {
    components.push({
      component: "SearchBox",
      required: false,
      slot: "main",
      order: order++,
      props: [{ name: "variant", value: "hero", dynamic: false }],
    });
  }

  // Featured content
  if (graph.stats.contentNodes >= 3) {
    components.push({
      component: "FeaturedContent",
      required: true,
      slot: "main",
      order: order++,
      props: [
        { name: "limit", value: 6, dynamic: false },
        { name: "layout", value: "grid", dynamic: false },
      ],
    });
  }

  // Latest content
  if (graph.stats.contentNodes >= 6) {
    components.push({
      component: "LatestContent",
      required: false,
      slot: "main",
      order: order++,
      props: [{ name: "limit", value: 8, dynamic: false }],
    });
  }

  // Category highlights
  if (graph.categoryGraph.totalCategories >= 2) {
    components.push({
      component: "CategoryHighlights",
      required: false,
      slot: "main",
      order: order++,
      props: [
        {
          name: "categories",
          value: graph.categoryGraph.categories.slice(0, 4).map((c) => c.id),
          dynamic: true,
          sourceField: "categoryGraph.categories",
        },
      ],
    });
  }

  // Tag cloud if tags exist
  if (graph.categoryGraph.tags.length >= 5) {
    components.push({
      component: "TagCloud",
      required: false,
      slot: "main",
      order: order++,
      props: [{ name: "limit", value: 20, dynamic: false }],
    });
  }

  // Gallery preview if image-heavy
  if (graph.stats.totalImages >= 10) {
    components.push({
      component: "GalleryGrid",
      required: false,
      slot: "main",
      order: order++,
      props: [
        { name: "preview", value: true, dynamic: false },
        { name: "limit", value: 8, dynamic: false },
      ],
    });
  }

  // Footer
  components.push({
    component: "Footer",
    required: true,
    slot: "footer",
    order: order++,
    props: [],
  });

  return components;
}

// ---------------------------------------------------------------------------
// Public: generate homepage PageDefinition
// ---------------------------------------------------------------------------

export function generateHomepage(graph: SiteGraph): PageDefinition {
  const heroConfig = buildHeroConfig(graph);
  const featured = selectFeaturedContent(graph.classifications);
  const latest = selectLatestContent(graph.classifications);
  const components = buildHomepageComponents(graph, heroConfig);

  const contentSource: ContentSource = {
    type: "generated_index",
    limit: 10,
    sortBy: "publishedAt",
    filterBy: {
      contentType: "ARTICLE",
      hasImages: false,
    },
  };

  const meta: PageMeta = {
    title: new URL(graph.seedUrl).hostname,
    description: `${graph.stats.contentNodes} pages of content`,
    canonicalUrl: "/",
    ogTitle: new URL(graph.seedUrl).hostname,
    ogDescription: `Browse ${graph.stats.contentNodes} articles and resources`,
    ogImage:
      graph.assetGraph.assets.find(
        (a) => a.assetType === "image" && !a.isMissing
      )?.cloudPath ?? null,
    publishedAt: null,
    modifiedAt: new Date().toISOString(),
    noIndex: false,
  };

  const relationships: PageRelationshipLinks = {
    parentPageId: null,
    childPageIds: featured,
    relatedPageIds: latest,
    breadcrumbPageIds: [],
    nextPageId: null,
    prevPageId: null,
  };

  return {
    id: "page__homepage",
    pageType: "homepage",
    route: "/",
    title: meta.title,
    layout: "LandingLayout",
    contentSource,
    components,
    meta,
    relationships,
    priority: 1.0,
    changeFreq: "daily",
    isGenerated: true,
    heroConfig,
  };
}
