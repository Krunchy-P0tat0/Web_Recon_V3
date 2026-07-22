/**
 * gallery-pages.ts — Gallery Page Generator
 *
 * Generates dedicated gallery pages for nodes or asset groups where
 * image density exceeds the gallery threshold.
 *
 * Threshold: imageCount >= 6  OR  (imageCount >= 3 AND wordCount < 150)
 *
 * Also generates a site-wide gallery index if total images > 20.
 */

import type { SiteGraph } from "@workspace/site-intelligence";
import type {
  PageDefinition,
  ComponentRequirement,
  ContentSource,
  PageMeta,
  PageRelationshipLinks,
  GalleryConfig,
} from "./types";

const GALLERY_THRESHOLD_IMAGES = 6;
const GALLERY_THRESHOLD_SPARSE  = 3; // images needed when word count is very low
const GALLERY_SPARSE_WORD_LIMIT = 150;
const SITE_GALLERY_MIN_IMAGES   = 20;

// ---------------------------------------------------------------------------
// Gallery component requirements
// ---------------------------------------------------------------------------

function buildGalleryComponents(config: GalleryConfig): ComponentRequirement[] {
  const components: ComponentRequirement[] = [];
  let order = 0;

  components.push({ component: "MetaTags",      required: true,  slot: "meta",    order: order++, props: [] });
  components.push({ component: "OpenGraphTags", required: true,  slot: "meta",    order: order++, props: [] });
  components.push({ component: "NavigationBar", required: true,  slot: "header",  order: order++, props: [] });
  components.push({ component: "Breadcrumb",    required: false, slot: "header",  order: order++, props: [] });

  components.push({
    component: "GalleryGrid",
    required: true,
    slot: "main",
    order: order++,
    props: [
      { name: "columns",      value: config.columns,      dynamic: false },
      { name: "totalImages",  value: config.totalImages,  dynamic: false },
      { name: "previewCount", value: config.previewCount, dynamic: false },
      { name: "aspectRatio",  value: config.aspectRatio,  dynamic: false },
    ],
  });

  if (config.hasLightbox) {
    components.push({
      component: "GalleryLightbox",
      required: true,
      slot: "overlay",
      order: order++,
      props: [],
    });
  }

  components.push({ component: "Footer", required: true, slot: "footer", order: order++, props: [] });

  return components;
}

// ---------------------------------------------------------------------------
// Determine gallery config from image count
// ---------------------------------------------------------------------------

function buildGalleryConfig(imageCount: number): GalleryConfig {
  let columns: GalleryConfig["columns"] = 3;
  if (imageCount >= 16) columns = 4;
  else if (imageCount <= 4) columns = 2;

  return {
    columns,
    hasLightbox: imageCount >= 3,
    totalImages: imageCount,
    previewCount: Math.min(imageCount, 16),
    aspectRatio: "mixed",
  };
}

// ---------------------------------------------------------------------------
// Public: generate gallery PageDefinitions
// ---------------------------------------------------------------------------

export function generateGalleryPages(graph: SiteGraph): PageDefinition[] {
  const pages: PageDefinition[] = [];
  const galleryNodeIds = new Set<string>();

  // Identify nodes that qualify as gallery pages
  for (const assignment of graph.layoutAssignments) {
    if (assignment.layout !== "GalleryLayout") continue;

    const nodeId = assignment.nodeId;
    const imageCount = assignment.signals.imageCount;
    const wordCount  = assignment.signals.wordCount;

    const isGallery =
      imageCount >= GALLERY_THRESHOLD_IMAGES ||
      (imageCount >= GALLERY_SPARSE_WORD_LIMIT && wordCount < GALLERY_SPARSE_WORD_LIMIT);

    if (!isGallery) continue;

    galleryNodeIds.add(nodeId);

    const route = graph.routeMap.routes.find((r) => r.nodeId === nodeId)?.route
      ?? `/gallery/${nodeId.slice(0, 8)}`;

    const galleryRoute = route.startsWith("/gallery/") ? route : `/gallery${route}`;
    const config = buildGalleryConfig(imageCount);
    const components = buildGalleryComponents(config);

    const contentSource: ContentSource = {
      type: "site_graph_node",
      nodeId,
    };

    const meta: PageMeta = {
      title: `Gallery`,
      description: `${imageCount} images`,
      canonicalUrl: galleryRoute,
      ogTitle: "Gallery",
      ogDescription: `${imageCount} images`,
      ogImage:
        graph.assetGraph.assets.find(
          (a) =>
            a.assetType === "image" &&
            !a.isMissing &&
            a.referencedByNodeIds.includes(nodeId)
        )?.cloudPath ?? null,
      publishedAt: null,
      modifiedAt: null,
      noIndex: false,
    };

    const relationships: PageRelationshipLinks = {
      parentPageId: "page__homepage",
      childPageIds: [],
      relatedPageIds: [],
      breadcrumbPageIds: [],
      nextPageId: null,
      prevPageId: null,
    };

    pages.push({
      id: `page__gallery__${nodeId}`,
      pageType: "gallery",
      route: galleryRoute,
      title: meta.title,
      layout: "GalleryLayout",
      contentSource,
      components,
      meta,
      relationships,
      priority: 0.6,
      changeFreq: "monthly",
      nodeId,
      galleryConfig: config,
      isGenerated: false,
    });
  }

  // Site-wide gallery index page (if total images exceeds threshold)
  if (graph.stats.totalImages >= SITE_GALLERY_MIN_IMAGES) {
    const config = buildGalleryConfig(Math.min(graph.stats.totalImages, 48));
    const components = buildGalleryComponents(config);

    const contentSource: ContentSource = {
      type: "site_graph_asset",
      limit: 48,
    };

    const meta: PageMeta = {
      title: "Gallery — All Images",
      description: `Browse all ${graph.stats.totalImages} images`,
      canonicalUrl: "/gallery",
      ogTitle: "Gallery",
      ogDescription: `${graph.stats.totalImages} images`,
      ogImage:
        graph.assetGraph.assets.find(
          (a) => a.assetType === "image" && !a.isMissing
        )?.cloudPath ?? null,
      publishedAt: null,
      modifiedAt: null,
      noIndex: false,
    };

    pages.push({
      id: "page__gallery__index",
      pageType: "gallery",
      route: "/gallery",
      title: meta.title,
      layout: "GalleryLayout",
      contentSource,
      components,
      meta,
      relationships: {
        parentPageId: "page__homepage",
        childPageIds: Array.from(galleryNodeIds).map((id) => `page__gallery__${id}`),
        relatedPageIds: [],
        breadcrumbPageIds: [],
        nextPageId: null,
        prevPageId: null,
      },
      priority: 0.7,
      changeFreq: "weekly",
      galleryConfig: config,
      isGenerated: true,
    });
  }

  return pages;
}
