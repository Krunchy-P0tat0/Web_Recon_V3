import type { StencilDefinition } from "@workspace/stencil-registry";
import type { AssemblyPage, AssemblySearchStructure, PageType } from "./types.js";

/**
 * Build the search structure declaration.
 * Enabled only when the stencil's supportedPageTypes includes "search".
 */
export function buildSearchStructure(
  stencil: StencilDefinition,
  articlePages: AssemblyPage[],
  categoryPages: AssemblyPage[]
): AssemblySearchStructure {
  const stencilPageTypes = new Set(stencil.supportedPageTypes.map((p) => p.pageType));
  const searchEnabled = stencilPageTypes.has("search");

  if (!searchEnabled) {
    return {
      enabled: false,
      route: "/search",
      indexedPageTypes: [],
      totalIndexablePages: 0,
      suggestionsEnabled: false,
      searchableFields: [],
      apiRoute: null,
    };
  }

  // Determine which page types are indexed based on stencil capabilities
  const indexable: PageType[] = [];
  const articleTypes: PageType[] = ["article", "blog", "guide", "docs", "portfolio", "faq"];
  for (const t of articleTypes) {
    if (stencilPageTypes.has(t)) indexable.push(t);
  }
  if (stencilPageTypes.has("category")) indexable.push("category");
  if (stencilPageTypes.has("landing"))  indexable.push("landing");

  // Count only pages that are actually in the indexable types
  const indexableSet = new Set(indexable);
  const indexablePages = [
    ...articlePages.filter((p) => indexableSet.has(p.pageType)),
    ...categoryPages,
  ];

  const suggestionsEnabled = articlePages.length > 10;

  return {
    enabled: true,
    route: "/search",
    indexedPageTypes: indexable,
    totalIndexablePages: indexablePages.length,
    suggestionsEnabled,
    searchableFields: ["title", "description", "content", "tags", "category"],
    apiRoute: "/api/search",
  };
}

/**
 * Build the synthesised search AssemblyPage.
 * Returns null when search is disabled for the stencil.
 */
export function buildSearchPage(
  stencil: StencilDefinition,
  searchStructure: AssemblySearchStructure
): AssemblyPage | null {
  if (!searchStructure.enabled) return null;

  const all = new Set([
    ...stencil.requiredComponents,
    ...stencil.optionalComponents,
  ]);

  return {
    id: "page__search",
    route: "/search",
    slug: "search",
    title: "Search",
    pageType: "search",
    layout: "MinimalLayout",
    sourceNodeId: null,
    contentType: null,
    isGenerated: true,
    components: [
      ...(all.has("NavigationBar")  ? ["NavigationBar"  as const] : []),
      ...(all.has("SearchBox")      ? ["SearchBox"      as const] : []),
      ...(all.has("SearchResults")  ? ["SearchResults"  as const] : []),
      ...(all.has("SearchIndex")    ? ["SearchIndex"    as const] : []),
      ...(all.has("MetaTags")       ? ["MetaTags"       as const] : []),
      ...(all.has("Footer")         ? ["Footer"         as const] : []),
    ],
    meta: {
      title: "Search",
      description: `Search ${searchStructure.totalIndexablePages} pages.`,
      canonicalUrl: "/search",
      ogTitle: "Search",
      ogDescription: null,
      ogImageUrl: null,
      publishedAt: null,
      noIndex: true,
    },
    priority: 0.4,
    changeFreq: "never",
    estimatedWordCount: null,
    hasImages: false,
    imageCount: 0,
  };
}
