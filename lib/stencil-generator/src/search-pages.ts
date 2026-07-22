/**
 * search-pages.ts — Search Page Generator
 *
 * Generates the search page definition and search configuration.
 *
 * Produces:
 *   - /search          — interactive search page
 *   - SearchConfig     — index targets, searchable fields, route map
 *
 * Searchable page types: article, blog, guide, docs, faq, portfolio, gallery
 * Indexed fields: title, description, textContent, tags, categories
 */

import type { SiteGraph } from "@workspace/site-intelligence";
import type {
  PageDefinition,
  ComponentRequirement,
  ContentSource,
  PageMeta,
  PageRelationshipLinks,
  SearchConfig,
  PageType,
} from "./types";

const SEARCHABLE_PAGE_TYPES: PageType[] = [
  "article", "blog", "guide", "docs", "faq", "portfolio", "gallery",
];

// ---------------------------------------------------------------------------
// Search components
// ---------------------------------------------------------------------------

function buildSearchComponents(): ComponentRequirement[] {
  const components: ComponentRequirement[] = [];
  let order = 0;

  components.push({ component: "MetaTags",       required: true,  slot: "meta",   order: order++, props: [] });
  components.push({ component: "OpenGraphTags",  required: false, slot: "meta",   order: order++, props: [] });
  components.push({ component: "NavigationBar",  required: true,  slot: "header", order: order++, props: [] });

  components.push({
    component: "SearchBox",
    required: true,
    slot: "main",
    order: order++,
    props: [
      { name: "variant",    value: "full",  dynamic: false },
      { name: "autofocus",  value: true,   dynamic: false },
      { name: "placeholder", value: "Search articles, guides, and more…", dynamic: false },
    ],
  });

  components.push({
    component: "SearchResults",
    required: true,
    slot: "main",
    order: order++,
    props: [
      { name: "emptyMessage", value: "No results found. Try a different search term.", dynamic: false },
    ],
  });

  components.push({
    component: "SearchIndex",
    required: true,
    slot: "meta",
    order: order++,
    props: [
      { name: "fields", value: ["title", "description", "textContent", "tags", "categories"], dynamic: false },
    ],
  });

  components.push({ component: "Footer", required: true, slot: "footer", order: order++, props: [] });

  return components;
}

// ---------------------------------------------------------------------------
// Public: generate search PageDefinition + SearchConfig
// ---------------------------------------------------------------------------

export function generateSearchPages(
  graph: SiteGraph,
  articlePageCount: number
): { page: PageDefinition; config: SearchConfig } {
  const indexedFields = [
    "title",
    "description",
    "textContent",
    "tags",
    "categories",
    "contentType",
  ];

  const searchConfig: SearchConfig = {
    indexedFields,
    searchablePageTypes: SEARCHABLE_PAGE_TYPES,
    totalIndexedPages: articlePageCount,
    route: "/search",
    suggestionsEnabled: articlePageCount >= 10,
  };

  const components = buildSearchComponents();

  const contentSource: ContentSource = {
    type: "generated_search",
    query: "{searchQuery}",
    limit: 20,
  };

  const meta: PageMeta = {
    title: "Search",
    description: `Search ${articlePageCount} articles and resources`,
    canonicalUrl: "/search",
    ogTitle: "Search",
    ogDescription: null,
    ogImage: null,
    publishedAt: null,
    modifiedAt: null,
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

  const page: PageDefinition = {
    id: "page__search",
    pageType: "search",
    route: "/search",
    title: "Search",
    layout: "MinimalLayout",
    contentSource,
    components,
    meta,
    relationships,
    priority: 0.3,
    changeFreq: "never",
    isGenerated: true,
  };

  return { page, config: searchConfig };
}
