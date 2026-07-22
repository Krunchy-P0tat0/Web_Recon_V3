/**
 * compiler.ts — Website Blueprint Compiler
 *
 * Orchestrates all generators into a single WebsiteBlueprint.
 * This is the sole public entry point for Phase 4.
 *
 * Pipeline:
 *   SiteGraph
 *     → Homepage Generator          → PageDefinition (1)
 *     → Article Page Generator      → PageDefinition[]
 *     → Category Page Generator     → PageDefinition[]
 *     → Tag Page Generator          → PageDefinition[]
 *     → Gallery Page Generator      → PageDefinition[]
 *     → Search Page Generator       → PageDefinition + SearchConfig
 *     → Sitemap Page Generator      → PageDefinition
 *     → Navigation Engine           → NavigationBlueprint
 *     → Route Engine                → BlueprintRoutePattern[]
 *     → Component Registry Builder  → ComponentRegistry
 *     → Sitemap Generator           → SitemapStructure
 *     → Blueprint Compiler          → WebsiteBlueprint
 *
 * All operations are deterministic, pure, and synchronous.
 */

import type { SiteGraph } from "@workspace/site-intelligence";

import { generateHomepage }       from "./homepage";
import { generateArticlePages }   from "./article-pages";
import { generateCategoryPages }  from "./category-pages";
import { generateTagPages }       from "./tag-pages";
import { generateGalleryPages }   from "./gallery-pages";
import { generateSearchPages }    from "./search-pages";
import { buildNavigationBlueprint } from "./navigation-engine";
import { buildRoutePatterns }     from "./route-engine";
import { buildComponentRegistry } from "./component-registry";
import { generateSitemap, generateSitemapPage } from "./sitemap";

import type {
  WebsiteBlueprint,
  PageDefinition,
  BlueprintStats,
  PageType,
  LayoutType,
} from "./types";

// ---------------------------------------------------------------------------
// Blueprint ID generation
// ---------------------------------------------------------------------------

function makeBlueprintId(siteGraphId: string): string {
  let hash = 0;
  for (let i = 0; i < siteGraphId.length; i++) {
    const chr = siteGraphId.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return `bp-${Math.abs(hash).toString(16).padStart(8, "0")}`;
}

// ---------------------------------------------------------------------------
// Deduplicate pages by route (first writer wins)
// ---------------------------------------------------------------------------

function deduplicatePages(pages: PageDefinition[]): PageDefinition[] {
  const seen = new Map<string, PageDefinition>();
  for (const page of pages) {
    if (!seen.has(page.route)) {
      seen.set(page.route, page);
    }
  }
  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Stats computation
// ---------------------------------------------------------------------------

function computeStats(
  pages: PageDefinition[],
  navigation: WebsiteBlueprint["navigation"],
  routePatterns: WebsiteBlueprint["routePatterns"],
  componentRegistry: WebsiteBlueprint["componentRegistry"],
  startMs: number
): BlueprintStats {
  const byPageType: Record<PageType, number> = {
    homepage: 0, article: 0, blog: 0, guide: 0, docs: 0,
    portfolio: 0, faq: 0, landing: 0, category: 0, tag: 0,
    gallery: 0, search: 0, not_found: 0, sitemap_page: 0,
  };
  const byLayout: Record<LayoutType, number> = {
    ArticleLayout: 0, GalleryLayout: 0, LandingLayout: 0,
    DocumentationLayout: 0, PortfolioLayout: 0, IndexLayout: 0, MinimalLayout: 0,
  };

  for (const page of pages) {
    byPageType[page.pageType] = (byPageType[page.pageType] ?? 0) + 1;
    byLayout[page.layout] = (byLayout[page.layout] ?? 0) + 1;
  }

  const dynamicRoutes = routePatterns.filter((r) => r.isDynamic).length;
  const staticRoutes  = routePatterns.filter((r) => !r.isDynamic).length;

  const navItems =
    navigation.totalPrimaryItems + navigation.totalSecondaryItems;

  const searchableCounts = [
    byPageType.article, byPageType.blog, byPageType.guide,
    byPageType.docs, byPageType.faq, byPageType.portfolio, byPageType.gallery,
  ].reduce((s, n) => s + n, 0);

  return {
    totalPages: pages.length,
    byPageType,
    byLayout,
    totalRoutes: routePatterns.length,
    totalDynamicRoutes: dynamicRoutes,
    totalStaticRoutes: staticRoutes,
    totalComponents: componentRegistry.totalComponents,
    totalNavItems: navItems,
    totalSitemapEntries: pages.filter(
      (p) => p.pageType !== "not_found" && p.pageType !== "sitemap_page"
    ).length,
    totalSearchablePages: searchableCounts,
    generationTimeMs: Date.now() - startMs,
  };
}

// ---------------------------------------------------------------------------
// Public: compile WebsiteBlueprint from SiteGraph
// ---------------------------------------------------------------------------

export function compileBlueprint(graph: SiteGraph): WebsiteBlueprint {
  const startMs = Date.now();

  // Phase 1: generate all pages
  const homepage        = generateHomepage(graph);
  const articlePages    = generateArticlePages(graph);
  const categoryPages   = generateCategoryPages(graph);
  const tagPages        = generateTagPages(graph);
  const galleryPages    = generateGalleryPages(graph);
  const { page: searchPage, config: searchConfig } = generateSearchPages(
    graph,
    articlePages.length
  );

  // Assemble all pages (homepage first)
  const allPagesRaw: PageDefinition[] = [
    homepage,
    ...articlePages,
    ...categoryPages,
    ...tagPages,
    ...galleryPages,
    searchPage,
  ];

  // Deduplicate by route
  const allPages = deduplicatePages(allPagesRaw);

  // Generate sitemap page after we know all pages
  const sitemapPage = generateSitemapPage(allPages);
  allPages.push(sitemapPage);

  // Add 404 page
  const notFoundPage: PageDefinition = {
    id: "page__not_found",
    pageType: "not_found",
    route: "/*",
    title: "404 — Page Not Found",
    layout: "MinimalLayout",
    contentSource: { type: "generated_index" },
    components: [
      { component: "NavigationBar", required: true, slot: "header", order: 0, props: [] },
      { component: "Footer",        required: true, slot: "footer", order: 1, props: [] },
    ],
    meta: {
      title: "404 — Page Not Found",
      description: null,
      canonicalUrl: "/*",
      ogTitle: "404 — Not Found",
      ogDescription: null,
      ogImage: null,
      publishedAt: null,
      modifiedAt: null,
      noIndex: true,
    },
    relationships: {
      parentPageId: "page__homepage",
      childPageIds: [],
      relatedPageIds: [],
      breadcrumbPageIds: [],
      nextPageId: null,
      prevPageId: null,
    },
    priority: 0.0,
    changeFreq: "never",
    isGenerated: true,
  };
  allPages.push(notFoundPage);

  // Phase 2: build cross-cutting concerns
  const navigation        = buildNavigationBlueprint(graph, allPages);
  const routePatterns     = buildRoutePatterns(graph, allPages);
  const componentRegistry = buildComponentRegistry(allPages);
  const sitemap           = generateSitemap(allPages);

  // Phase 3: build page index (route → pageId)
  const pageIndex: Record<string, string> = {};
  for (const page of allPages) {
    pageIndex[page.route] = page.id;
  }

  // Phase 4: stats
  const stats = computeStats(allPages, navigation, routePatterns, componentRegistry, startMs);

  return {
    id: makeBlueprintId(graph.id),
    version: "1.0",
    generatedAt: new Date().toISOString(),
    seedUrl: graph.seedUrl,
    siteGraphId: graph.id,
    pages: allPages,
    pageIndex,
    navigation,
    routePatterns,
    componentRegistry,
    sitemap,
    searchConfig,
    stats,
  };
}
