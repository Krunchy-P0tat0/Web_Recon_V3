/**
 * types.ts — Complete type definitions for the Stencil Generator Engine
 *
 * The WebsiteBlueprint is the sole output of this library.
 * It is a complete construction plan for generating a website from a SiteGraph.
 * No raw crawl data is accessed — only SiteGraph, which is the sole truth source.
 *
 * All types are plain-JSON-serializable.
 */

import type { ContentType, LayoutType, SiteGraph } from "@workspace/site-intelligence";

// Re-export for convenience
export type { ContentType, LayoutType, SiteGraph };

// ---------------------------------------------------------------------------
// Page Types
// ---------------------------------------------------------------------------

export type PageType =
  | "homepage"
  | "article"
  | "blog"
  | "guide"
  | "docs"
  | "portfolio"
  | "faq"
  | "landing"
  | "category"
  | "tag"
  | "gallery"
  | "search"
  | "not_found"
  | "sitemap_page";

// ---------------------------------------------------------------------------
// Component System
// ---------------------------------------------------------------------------

export type ComponentType =
  | "HeroSection"
  | "FeaturedContent"
  | "LatestContent"
  | "CategoryHighlights"
  | "NavigationBar"
  | "Footer"
  | "Breadcrumb"
  | "ArticleCard"
  | "ArticleGrid"
  | "ArticleList"
  | "AuthorBlock"
  | "RelatedContent"
  | "TagCloud"
  | "GalleryGrid"
  | "GalleryLightbox"
  | "CategoryListing"
  | "FilterBar"
  | "Pagination"
  | "TagArchive"
  | "SearchBox"
  | "SearchResults"
  | "SearchIndex"
  | "SitemapTree"
  | "ImagePlacement"
  | "VideoEmbed"
  | "TableOfContents"
  | "CodeBlock"
  | "FAQAccordion"
  | "PortfolioCard"
  | "PortfolioGrid"
  | "MetaTags"
  | "OpenGraphTags"
  | "StructuredData";

export interface ComponentProp {
  name: string;
  value: unknown;
  dynamic: boolean;
  sourceField?: string;
}

export interface ComponentRequirement {
  component: ComponentType;
  required: boolean;
  slot: "header" | "main" | "sidebar" | "footer" | "overlay" | "meta";
  order: number;
  props: ComponentProp[];
  conditionalOn?: string;
}

export interface ComponentDefinition {
  type: ComponentType;
  description: string;
  usedInPageTypes: PageType[];
  usedInLayouts: LayoutType[];
  totalUsages: number;
  isRequired: boolean;
}

export interface ComponentRegistry {
  components: ComponentDefinition[];
  componentIndex: Record<ComponentType, ComponentDefinition>;
  totalComponents: number;
  byPageType: Record<PageType, ComponentType[]>;
  byLayout: Record<LayoutType, ComponentType[]>;
}

// ---------------------------------------------------------------------------
// Content Sources
// ---------------------------------------------------------------------------

export type ContentSourceType =
  | "site_graph_node"
  | "site_graph_classification"
  | "site_graph_category"
  | "site_graph_tag"
  | "site_graph_asset"
  | "generated_index"
  | "generated_search"
  | "generated_sitemap";

export interface ContentSource {
  type: ContentSourceType;
  nodeId?: string;
  categoryId?: string;
  tag?: string;
  query?: string;
  limit?: number;
  sortBy?: "publishedAt" | "title" | "wordCount" | "imageCount";
  filterBy?: {
    contentType?: ContentType;
    minWordCount?: number;
    hasImages?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Route Engine
// ---------------------------------------------------------------------------

export type ChangeFreq =
  | "always"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "never";

export interface RouteParam {
  name: string;
  source: "slug" | "id" | "category_slug" | "tag_slug" | "page_number";
  example: string;
}

export interface BlueprintRoutePattern {
  id: string;
  pattern: string;
  pageType: PageType;
  layout: LayoutType;
  isDynamic: boolean;
  params: RouteParam[];
  contentSource: ContentSourceType;
  priority: number;
  changeFreq: ChangeFreq;
  requiredComponents: ComponentType[];
  description: string;
}

// ---------------------------------------------------------------------------
// Page Definitions
// ---------------------------------------------------------------------------

export interface PageMeta {
  title: string;
  description: string | null;
  canonicalUrl: string;
  ogTitle: string;
  ogDescription: string | null;
  ogImage: string | null;
  publishedAt: string | null;
  modifiedAt: string | null;
  noIndex: boolean;
}

export interface PageRelationshipLinks {
  parentPageId: string | null;
  childPageIds: string[];
  relatedPageIds: string[];
  breadcrumbPageIds: string[];
  nextPageId: string | null;
  prevPageId: string | null;
}

export interface HeroConfig {
  style: "full_bleed" | "split" | "minimal" | "text_only";
  hasImage: boolean;
  imageAssetId: string | null;
  headline: string;
  subheadline: string | null;
  ctaLabel: string | null;
  ctaRoute: string | null;
}

export interface ArticleConfig {
  estimatedReadTime: number;
  hasAuthorBlock: boolean;
  hasTableOfContents: boolean;
  hasFeaturedImage: boolean;
  featuredImageAssetId: string | null;
  relatedContentLimit: number;
  imageStrategy: "inline" | "gallery" | "sidebar";
}

export interface GalleryConfig {
  columns: 2 | 3 | 4;
  hasLightbox: boolean;
  totalImages: number;
  previewCount: number;
  aspectRatio: "square" | "portrait" | "landscape" | "mixed";
}

export interface CategoryConfig {
  categoryId: string;
  categoryLabel: string;
  totalPages: number;
  pageSize: number;
  hasFilterBar: boolean;
  sortOptions: string[];
}

export interface TagConfig {
  tag: string;
  totalPages: number;
  pageSize: number;
}

export interface SearchConfig {
  indexedFields: string[];
  searchablePageTypes: PageType[];
  totalIndexedPages: number;
  route: string;
  suggestionsEnabled: boolean;
}

export interface PageDefinition {
  id: string;
  pageType: PageType;
  route: string;
  title: string;
  layout: LayoutType;
  contentSource: ContentSource;
  components: ComponentRequirement[];
  meta: PageMeta;
  relationships: PageRelationshipLinks;
  priority: number;
  changeFreq: ChangeFreq;
  nodeId?: string;
  classifiedAs?: ContentType;
  heroConfig?: HeroConfig;
  articleConfig?: ArticleConfig;
  galleryConfig?: GalleryConfig;
  categoryConfig?: CategoryConfig;
  tagConfig?: TagConfig;
  isGenerated: boolean;
}

// ---------------------------------------------------------------------------
// Navigation Blueprint
// ---------------------------------------------------------------------------

export interface NavBlueprintItem {
  pageId: string;
  route: string;
  label: string;
  depth: number;
  children: NavBlueprintItem[];
  isActive: boolean;
  order: number;
  icon?: string;
}

export interface FooterNavGroup {
  label: string;
  items: Array<{ label: string; route: string }>;
}

export interface FooterBlueprint {
  groups: FooterNavGroup[];
  copyrightText: string;
  showSitemapLink: boolean;
  showSearchLink: boolean;
}

export interface BreadcrumbBlueprint {
  pageId: string;
  route: string;
  label: string;
  depth: number;
}

export interface ContextualNavEntry {
  pageId: string;
  siblingPageIds: string[];
  parentPageId: string | null;
  childPageIds: string[];
}

export interface NavigationBlueprint {
  primary: NavBlueprintItem[];
  secondary: NavBlueprintItem[];
  footer: FooterBlueprint;
  breadcrumbs: Record<string, BreadcrumbBlueprint[]>;
  contextual: ContextualNavEntry[];
  totalPrimaryItems: number;
  totalSecondaryItems: number;
}

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

export interface SitemapEntry {
  route: string;
  pageId: string;
  pageType: PageType;
  title: string;
  priority: number;
  changeFreq: ChangeFreq;
  lastModified: string | null;
  parentRoute: string | null;
  depth: number;
}

export interface SitemapStructure {
  entries: SitemapEntry[];
  totalEntries: number;
  totalIndexable: number;
  totalNoIndex: number;
  generatedAt: string;
  sitemapRoute: "/sitemap.json";
  xmlSitemapRoute: "/sitemap.xml";
}

// ---------------------------------------------------------------------------
// Blueprint Stats
// ---------------------------------------------------------------------------

export interface BlueprintStats {
  totalPages: number;
  byPageType: Record<PageType, number>;
  byLayout: Record<LayoutType, number>;
  totalRoutes: number;
  totalDynamicRoutes: number;
  totalStaticRoutes: number;
  totalComponents: number;
  totalNavItems: number;
  totalSitemapEntries: number;
  totalSearchablePages: number;
  generationTimeMs: number;
}

// ---------------------------------------------------------------------------
// WebsiteBlueprint — the unified output
// ---------------------------------------------------------------------------

export interface WebsiteBlueprint {
  id: string;
  version: "1.0";
  generatedAt: string;
  seedUrl: string;
  siteGraphId: string;

  pages: PageDefinition[];
  pageIndex: Record<string, string>;

  navigation: NavigationBlueprint;
  routePatterns: BlueprintRoutePattern[];
  componentRegistry: ComponentRegistry;
  sitemap: SitemapStructure;
  searchConfig: SearchConfig;

  stats: BlueprintStats;
}
