/**
 * @workspace/stencil-generator
 *
 * Stencil Generator Engine — converts a SiteGraph into a WebsiteBlueprint.
 *
 * Main entry point:
 *   compileBlueprint(siteGraph)  → WebsiteBlueprint
 *
 * Individual generators (for testing or partial use):
 *   generateHomepage             → PageDefinition
 *   generateArticlePages         → PageDefinition[]
 *   generateCategoryPages        → PageDefinition[]
 *   generateTagPages             → PageDefinition[]
 *   generateGalleryPages         → PageDefinition[]
 *   generateSearchPages          → { page, config }
 *   generateSitemapPage          → PageDefinition
 *   generateSitemap              → SitemapStructure
 *
 * Supporting engines:
 *   buildNavigationBlueprint     → NavigationBlueprint
 *   buildRoutePatterns           → BlueprintRoutePattern[]
 *   buildComponentRegistry       → ComponentRegistry
 *
 * All operations are:
 *   - Deterministic (same input → same output)
 *   - Pure (no I/O, no external services)
 *   - Synchronous (no async)
 *   - SiteGraph-only (no raw crawl data access)
 */

export { compileBlueprint } from "./compiler";

export { generateHomepage }      from "./homepage";
export { generateArticlePages }  from "./article-pages";
export { generateCategoryPages } from "./category-pages";
export { generateTagPages }      from "./tag-pages";
export { generateGalleryPages }  from "./gallery-pages";
export { generateSearchPages }   from "./search-pages";
export { generateSitemap, generateSitemapPage } from "./sitemap";

export { buildNavigationBlueprint } from "./navigation-engine";
export { buildRoutePatterns }       from "./route-engine";
export { buildComponentRegistry }   from "./component-registry";

export type {
  // Blueprint
  WebsiteBlueprint,
  BlueprintStats,

  // Pages
  PageDefinition,
  PageType,
  PageMeta,
  PageRelationshipLinks,

  // Components
  ComponentType,
  ComponentRequirement,
  ComponentProp,
  ComponentDefinition,
  ComponentRegistry,

  // Content source
  ContentSource,
  ContentSourceType,

  // Routes
  BlueprintRoutePattern,
  RouteParam,

  // Navigation
  NavigationBlueprint,
  NavBlueprintItem,
  FooterBlueprint,
  FooterNavGroup,
  BreadcrumbBlueprint,
  ContextualNavEntry,

  // Sitemap
  SitemapStructure,
  SitemapEntry,
  ChangeFreq,

  // Config shapes
  SearchConfig,
  HeroConfig,
  ArticleConfig,
  GalleryConfig,
  CategoryConfig,
  TagConfig,
} from "./types";
