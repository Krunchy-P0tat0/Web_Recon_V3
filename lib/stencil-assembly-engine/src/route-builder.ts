import type { SiteGraph } from "@workspace/site-intelligence";
import type { StencilDefinition } from "@workspace/stencil-registry";
import type { AssemblyRoute, AssemblyRouteMap, PageType, LayoutType } from "./types.js";

/**
 * Build the full AssemblyRouteMap — static and dynamic URL patterns —
 * shaped by what the chosen stencil supports.
 */
export function buildRoutes(
  graph: SiteGraph,
  stencil: StencilDefinition
): AssemblyRouteMap {
  const now = new Date().toISOString();
  const supportedPageTypes = new Set(stencil.supportedPageTypes.map((p) => p.pageType));

  const staticRoutes: AssemblyRoute[] = [];
  const dynamicRoutes: AssemblyRoute[] = [];

  // ── Homepage ──────────────────────────────────────────────────────────────
  staticRoutes.push({
    id: "route__homepage",
    pattern: "/",
    pageType: "homepage",
    isDynamic: false,
    params: [],
    layout: stencil.primaryLayout,
    description: "Site homepage.",
    requiresSSR: false,
  });

  // ── Article pages ─────────────────────────────────────────────────────────
  const articlePageTypes: PageType[] = ["article", "blog", "guide", "docs", "portfolio"];
  const activeArticleTypes = articlePageTypes.filter((t) => supportedPageTypes.has(t));

  if (activeArticleTypes.length > 0) {
    const primaryArticleType = activeArticleTypes[0]!;
    const articleLayout = pickLayoutForPageType(primaryArticleType, stencil);

    dynamicRoutes.push({
      id: `route__${primaryArticleType}_dynamic`,
      pattern: `/${primaryArticleType === "docs" ? "docs" : "articles"}/:slug`,
      pageType: primaryArticleType,
      isDynamic: true,
      params: [
        { name: "slug", description: "URL-safe article slug", example: "my-article" },
      ],
      layout: articleLayout,
      description: `Dynamic ${primaryArticleType} page — one per content node.`,
      requiresSSR: false,
    });
  }

  // ── Docs sub-paths (documentation stencil) ────────────────────────────────
  if (supportedPageTypes.has("docs")) {
    dynamicRoutes.push({
      id: "route__docs_section",
      pattern: "/docs/:section/:slug",
      pageType: "docs",
      isDynamic: true,
      params: [
        { name: "section", description: "Documentation section slug", example: "getting-started" },
        { name: "slug",    description: "Page slug within the section", example: "installation" },
      ],
      layout: "DocumentationLayout",
      description: "Nested docs page within a section.",
      requiresSSR: false,
    });
  }

  // ── Category pages ────────────────────────────────────────────────────────
  if (supportedPageTypes.has("category") && graph.categoryGraph.totalCategories > 0) {
    dynamicRoutes.push({
      id: "route__category",
      pattern: "/categories/:slug",
      pageType: "category",
      isDynamic: true,
      params: [
        { name: "slug", description: "Category URL slug", example: "technology" },
      ],
      layout: "IndexLayout",
      description: "Category index page with paginated article listings.",
      requiresSSR: false,
    });

    if (stencil.supportedNavigationStructures.includes("pagination")) {
      dynamicRoutes.push({
        id: "route__category_paginated",
        pattern: "/categories/:slug/page/:page",
        pageType: "category",
        isDynamic: true,
        params: [
          { name: "slug", description: "Category URL slug", example: "technology" },
          { name: "page", description: "1-indexed page number",  example: "2" },
        ],
        layout: "IndexLayout",
        description: "Paginated category listing (page 2+).",
        requiresSSR: false,
      });
    }
  }

  // ── Tag pages ─────────────────────────────────────────────────────────────
  if (supportedPageTypes.has("tag") && graph.categoryGraph.tags.length > 0) {
    dynamicRoutes.push({
      id: "route__tag",
      pattern: "/tags/:tag",
      pageType: "tag",
      isDynamic: true,
      params: [
        { name: "tag", description: "URL-encoded tag slug", example: "javascript" },
      ],
      layout: "IndexLayout",
      description: "Tag archive page listing all articles with the tag.",
      requiresSSR: false,
    });
  }

  // ── Portfolio pages ───────────────────────────────────────────────────────
  if (supportedPageTypes.has("portfolio")) {
    dynamicRoutes.push({
      id: "route__portfolio",
      pattern: "/work/:slug",
      pageType: "portfolio",
      isDynamic: true,
      params: [
        { name: "slug", description: "Project slug", example: "brand-redesign-2026" },
      ],
      layout: "PortfolioLayout",
      description: "Individual portfolio / case study page.",
      requiresSSR: false,
    });
  }

  // ── Gallery pages ─────────────────────────────────────────────────────────
  if (supportedPageTypes.has("gallery")) {
    dynamicRoutes.push({
      id: "route__gallery",
      pattern: "/gallery/:slug",
      pageType: "gallery",
      isDynamic: true,
      params: [
        { name: "slug", description: "Gallery slug", example: "summer-2026" },
      ],
      layout: "GalleryLayout",
      description: "Photo or video gallery page.",
      requiresSSR: false,
    });
  }

  // ── Landing pages ─────────────────────────────────────────────────────────
  if (supportedPageTypes.has("landing")) {
    dynamicRoutes.push({
      id: "route__landing",
      pattern: "/:slug",
      pageType: "landing",
      isDynamic: true,
      params: [
        { name: "slug", description: "Landing page slug", example: "about" },
      ],
      layout: stencil.primaryLayout,
      description: "Generic landing / about / service page.",
      requiresSSR: false,
    });
  }

  // ── FAQ pages ─────────────────────────────────────────────────────────────
  if (supportedPageTypes.has("faq")) {
    staticRoutes.push({
      id: "route__faq",
      pattern: "/faq",
      pageType: "faq",
      isDynamic: false,
      params: [],
      layout: "ArticleLayout",
      description: "Frequently asked questions page.",
      requiresSSR: false,
    });
  }

  // ── Search page ───────────────────────────────────────────────────────────
  if (supportedPageTypes.has("search")) {
    staticRoutes.push({
      id: "route__search",
      pattern: "/search",
      pageType: "search",
      isDynamic: false,
      params: [],
      layout: "MinimalLayout",
      description: "Full-text site search.",
      requiresSSR: true,
    });
  }

  // ── Sitemap page ──────────────────────────────────────────────────────────
  staticRoutes.push({
    id: "route__sitemap",
    pattern: "/sitemap",
    pageType: "sitemap_page",
    isDynamic: false,
    params: [],
    layout: "MinimalLayout",
    description: "HTML sitemap for SEO and discoverability.",
    requiresSSR: false,
  });

  // ── Not found ─────────────────────────────────────────────────────────────
  staticRoutes.push({
    id: "route__not_found",
    pattern: "/*",
    pageType: "not_found",
    isDynamic: false,
    params: [],
    layout: "MinimalLayout",
    description: "404 catch-all page.",
    requiresSSR: false,
  });

  return {
    static: staticRoutes,
    dynamic: dynamicRoutes,
    total: staticRoutes.length + dynamicRoutes.length,
    generatedAt: now,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pickLayoutForPageType(pageType: PageType, stencil: StencilDefinition): LayoutType {
  for (const lc of stencil.supportedLayouts) {
    if (lc.usedForPageTypes.includes(pageType)) return lc.layout;
  }
  return stencil.primaryLayout;
}
