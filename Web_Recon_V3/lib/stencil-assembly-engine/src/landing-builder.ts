import type { SiteGraph, PortablePageNode } from "@workspace/site-intelligence";
import type { StencilDefinition } from "@workspace/stencil-registry";
import type { AssemblyPage, ComponentType, LayoutType } from "./types.js";

/**
 * Build landing pages (homepage + LANDING_PAGE content nodes).
 *
 * The homepage is always synthesised as the first page.
 * Additional landing pages come from manifest nodes classified as
 * LANDING_PAGE. Gallery / portfolio pages are also built here.
 */
export function buildLandingPages(
  graph: SiteGraph,
  stencil: StencilDefinition,
  nodeMap: Map<string, PortablePageNode>
): AssemblyPage[] {
  const pages: AssemblyPage[] = [];

  // ── Homepage ─────────────────────────────────────────────────────────────
  pages.push(buildHomepage(graph, stencil));

  // ── LANDING_PAGE content nodes ───────────────────────────────────────────
  if (stencil.supportedPageTypes.some((p) => p.pageType === "landing")) {
    const landingClassifications = graph.classifications.filter(
      (c) => c.contentType === "LANDING_PAGE"
    );

    for (const cls of landingClassifications) {
      const routeEntry = graph.routeMap.routes.find((r) => r.nodeId === cls.nodeId);
      if (!routeEntry) continue;

      // Skip the root page — it becomes the homepage
      if (routeEntry.route === "/" || routeEntry.route === "") continue;

      const node = nodeMap.get(cls.nodeId);
      const images = node?.media.images ?? [];
      const description = node?.metadata.description ?? null;
      const layout = pickLandingLayout(stencil, "landing");
      const components = selectLandingComponents(stencil, false, images.length > 0);

      pages.push({
        id: `page__landing__${cls.nodeId}`,
        route: routeEntry.route,
        slug: routeEntry.slug,
        title: node?.metadata.title || routeEntry.slug,
        pageType: "landing",
        layout,
        sourceNodeId: cls.nodeId,
        contentType: "LANDING_PAGE",
        isGenerated: false,
        components,
        meta: {
          title: node?.metadata.title || routeEntry.slug,
          description,
          canonicalUrl: routeEntry.route,
          ogTitle: node?.metadata.title || routeEntry.slug,
          ogDescription: description,
          ogImageUrl: images[0]?.storage.publicPath ?? null,
          publishedAt: node?.metadata.publishedAt ?? null,
          noIndex: false,
        },
        priority: 0.9,
        changeFreq: "monthly",
        estimatedWordCount: node?.content.wordCount ?? null,
        hasImages: images.length > 0,
        imageCount: images.length,
      });
    }
  }

  // ── Gallery nodes ────────────────────────────────────────────────────────
  if (stencil.supportedPageTypes.some((p) => p.pageType === "gallery")) {
    const galleryClassifications = graph.classifications.filter(
      (c) => c.contentType === "GALLERY"
    );

    for (const cls of galleryClassifications) {
      const routeEntry = graph.routeMap.routes.find((r) => r.nodeId === cls.nodeId);
      if (!routeEntry) continue;

      const node = nodeMap.get(cls.nodeId);
      const images = node?.media.images ?? [];
      const description = node?.metadata.description ?? null;
      const galleryComponents = selectGalleryComponents(stencil);

      pages.push({
        id: `page__gallery__${cls.nodeId}`,
        route: routeEntry.route,
        slug: routeEntry.slug,
        title: node?.metadata.title || routeEntry.slug,
        pageType: "gallery",
        layout: "GalleryLayout",
        sourceNodeId: cls.nodeId,
        contentType: "GALLERY",
        isGenerated: false,
        components: galleryComponents,
        meta: {
          title: node?.metadata.title || routeEntry.slug,
          description,
          canonicalUrl: routeEntry.route,
          ogTitle: node?.metadata.title || routeEntry.slug,
          ogDescription: description,
          ogImageUrl: images[0]?.storage.publicPath ?? null,
          publishedAt: node?.metadata.publishedAt ?? null,
          noIndex: false,
        },
        priority: 0.7,
        changeFreq: "monthly",
        estimatedWordCount: null,
        hasImages: true,
        imageCount: images.length,
      });
    }
  }

  return pages;
}

// ─── Homepage ─────────────────────────────────────────────────────────────────

function buildHomepage(graph: SiteGraph, stencil: StencilDefinition): AssemblyPage {
  const layout = pickLandingLayout(stencil, "homepage");
  const hasCategorySupport = stencil.supportedPageTypes.some((p) => p.pageType === "category");
  const hasImages = graph.assetGraph.totalAssets > 0;
  const components = selectLandingComponents(stencil, hasCategorySupport, hasImages);

  const featuredAsset = graph.assetGraph.assets.find(
    (a) => a.assetType === "image" && !a.isOrphan
  );

  return {
    id: "page__homepage",
    route: "/",
    slug: "",
    title: "Home",
    pageType: "homepage",
    layout,
    sourceNodeId: null,
    contentType: null,
    isGenerated: true,
    components,
    meta: {
      title: extractSiteName(graph.seedUrl),
      description: `Welcome to ${extractSiteName(graph.seedUrl)}`,
      canonicalUrl: "/",
      ogTitle: extractSiteName(graph.seedUrl),
      ogDescription: `Welcome to ${extractSiteName(graph.seedUrl)}`,
      ogImageUrl: featuredAsset?.cloudPath ?? null,
      publishedAt: null,
      noIndex: false,
    },
    priority: 1.0,
    changeFreq: "daily",
    estimatedWordCount: null,
    hasImages,
    imageCount: graph.assetGraph.assetsByType["image"] ?? 0,
  };
}

// ─── Component selection ──────────────────────────────────────────────────────

function selectLandingComponents(
  stencil: StencilDefinition,
  hasCategorySupport: boolean,
  hasImages: boolean
): ComponentType[] {
  const all = new Set([
    ...stencil.requiredComponents,
    ...stencil.optionalComponents,
  ]);

  const components: ComponentType[] = [];

  if (all.has("NavigationBar"))       components.push("NavigationBar");
  if (all.has("HeroSection"))         components.push("HeroSection");
  if (all.has("FeaturedContent"))     components.push("FeaturedContent");
  if (all.has("LatestContent"))       components.push("LatestContent");
  if (hasCategorySupport && all.has("CategoryHighlights")) {
    components.push("CategoryHighlights");
  }
  if (hasImages && all.has("ImagePlacement")) components.push("ImagePlacement");
  if (all.has("MetaTags"))            components.push("MetaTags");
  if (all.has("OpenGraphTags"))       components.push("OpenGraphTags");
  if (all.has("StructuredData"))      components.push("StructuredData");
  if (all.has("Footer"))              components.push("Footer");

  return components;
}

function selectGalleryComponents(stencil: StencilDefinition): ComponentType[] {
  const all = new Set([
    ...stencil.requiredComponents,
    ...stencil.optionalComponents,
  ]);
  const components: ComponentType[] = [];
  if (all.has("NavigationBar"))   components.push("NavigationBar");
  if (all.has("Breadcrumb"))      components.push("Breadcrumb");
  if (all.has("GalleryGrid"))     components.push("GalleryGrid");
  if (all.has("GalleryLightbox")) components.push("GalleryLightbox");
  if (all.has("MetaTags"))        components.push("MetaTags");
  if (all.has("OpenGraphTags"))   components.push("OpenGraphTags");
  if (all.has("Footer"))          components.push("Footer");
  return components;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pickLandingLayout(
  stencil: StencilDefinition,
  pageType: "homepage" | "landing" | "gallery"
): LayoutType {
  for (const lc of stencil.supportedLayouts) {
    if (lc.usedForPageTypes.includes(pageType)) return lc.layout;
  }
  return stencil.primaryLayout;
}

function extractSiteName(seedUrl: string): string {
  try {
    return new URL(seedUrl).hostname.replace(/^www\./, "");
  } catch {
    return seedUrl;
  }
}
