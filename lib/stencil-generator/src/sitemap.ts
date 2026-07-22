/**
 * sitemap.ts — Sitemap Structure Generator
 *
 * Produces a SitemapStructure from all PageDefinitions.
 * Includes all pages with priorities, change frequencies, and relationships.
 *
 * Also generates the sitemap page definition itself (/sitemap).
 *
 * Output:
 *   SitemapStructure — complete sitemap.json
 *   PageDefinition   — /sitemap page
 */

import type {
  SitemapStructure,
  SitemapEntry,
  PageDefinition,
  PageType,
  ChangeFreq,
  ComponentRequirement,
  ContentSource,
  PageMeta,
  PageRelationshipLinks,
} from "./types";

// ---------------------------------------------------------------------------
// Determine parent route from route string
// ---------------------------------------------------------------------------

function parentRoute(route: string): string | null {
  if (route === "/") return null;
  const parts = route.split("/").filter(Boolean);
  if (parts.length <= 1) return "/";
  return "/" + parts.slice(0, -1).join("/");
}

// ---------------------------------------------------------------------------
// Route depth
// ---------------------------------------------------------------------------

function routeDepth(route: string): number {
  return route === "/" ? 0 : route.split("/").filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Sitemap page components
// ---------------------------------------------------------------------------

function buildSitemapPageComponents(): ComponentRequirement[] {
  let order = 0;
  return [
    { component: "MetaTags",      required: true, slot: "meta",   order: order++, props: [] },
    { component: "NavigationBar", required: true, slot: "header", order: order++, props: [] },
    {
      component: "SitemapTree",
      required: true,
      slot: "main",
      order: order++,
      props: [{ name: "groupByType", value: true, dynamic: false }],
    },
    { component: "Footer", required: true, slot: "footer", order: order++, props: [] },
  ];
}

// ---------------------------------------------------------------------------
// Public: generate SitemapStructure
// ---------------------------------------------------------------------------

export function generateSitemap(pages: PageDefinition[]): SitemapStructure {
  const entries: SitemapEntry[] = pages
    .filter((p) => p.pageType !== "not_found" && p.pageType !== "sitemap_page")
    .map((p) => ({
      route: p.route,
      pageId: p.id,
      pageType: p.pageType,
      title: p.title,
      priority: p.priority,
      changeFreq: p.changeFreq,
      lastModified: p.meta.modifiedAt ?? p.meta.publishedAt,
      parentRoute: parentRoute(p.route),
      depth: routeDepth(p.route),
    }))
    .sort((a, b) => {
      // Sort by depth first, then priority desc, then route alpha
      if (a.depth !== b.depth) return a.depth - b.depth;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.route.localeCompare(b.route);
    });

  const totalNoIndex = pages.filter((p) => p.meta.noIndex).length;
  const totalIndexable = entries.length - totalNoIndex;

  return {
    entries,
    totalEntries: entries.length,
    totalIndexable,
    totalNoIndex,
    generatedAt: new Date().toISOString(),
    sitemapRoute: "/sitemap.json",
    xmlSitemapRoute: "/sitemap.xml",
  };
}

// ---------------------------------------------------------------------------
// Public: generate /sitemap page definition
// ---------------------------------------------------------------------------

export function generateSitemapPage(pages: PageDefinition[]): PageDefinition {
  const components = buildSitemapPageComponents();

  const contentSource: ContentSource = {
    type: "generated_sitemap",
    limit: pages.length,
  };

  const meta: PageMeta = {
    title: "Site Map",
    description: `Complete site map — ${pages.length} pages`,
    canonicalUrl: "/sitemap",
    ogTitle: "Site Map",
    ogDescription: null,
    ogImage: null,
    publishedAt: null,
    modifiedAt: new Date().toISOString(),
    noIndex: true,
  };

  const relationships: PageRelationshipLinks = {
    parentPageId: "page__homepage",
    childPageIds: [],
    relatedPageIds: [],
    breadcrumbPageIds: [],
    nextPageId: null,
    prevPageId: null,
  };

  return {
    id: "page__sitemap",
    pageType: "sitemap_page",
    route: "/sitemap",
    title: "Site Map",
    layout: "MinimalLayout",
    contentSource,
    components,
    meta,
    relationships,
    priority: 0.2,
    changeFreq: "monthly",
    isGenerated: true,
  };
}
