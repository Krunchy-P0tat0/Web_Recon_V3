import type { PortableManifest } from "@workspace/site-intelligence";
import type { ContentType, LayoutType } from "@workspace/site-intelligence";
import type { PageType, ComponentType } from "@workspace/stencil-generator";
import type { StencilId, NavigationStructure } from "@workspace/stencil-registry";

export type {
  PortableManifest,
  ContentType,
  LayoutType,
  PageType,
  ComponentType,
  StencilId,
  NavigationStructure,
};

// ─── Assembly options ─────────────────────────────────────────────────────────

export interface AssemblyOptions {
  /** Cap on the number of article pages emitted. Default: 500. */
  maxArticlePages?: number;
  /** Cap on the number of category pages emitted. Default: 100. */
  maxCategoryPages?: number;
  /** Minimum tag frequency to include in tag cloud / tag pages. Default: 2. */
  tagMinFrequency?: number;
  /** Whether to include orphaned pages (no parent in nav tree). Default: false. */
  includeOrphanPages?: boolean;
  /** Max items in the primary nav bar. Default: 8. */
  primaryNavMaxItems?: number;
  /** Max footer column groups. Default: 4. */
  footerNavMaxGroups?: number;
  /** Items per paginated category/tag page. Default: 12. */
  pageSize?: number;
}

// ─── Navigation ───────────────────────────────────────────────────────────────

export interface AssemblyNavItem {
  id: string;
  route: string;
  label: string;
  depth: number;
  children: AssemblyNavItem[];
}

export interface AssemblyMegaMenuSection {
  label: string;
  route: string;
  columns: Array<{
    heading: string;
    items: Array<{ label: string; route: string }>;
  }>;
}

export interface AssemblyFooterGroup {
  label: string;
  items: Array<{ label: string; route: string }>;
}

export interface AssemblyBreadcrumbSchema {
  /** Whether breadcrumbs should be rendered at all. */
  enabled: boolean;
  /** Example breadcrumb chain for documentation purposes. */
  example: Array<{ label: string; route: string }>;
}

export interface AssemblyTagCloudItem {
  tag: string;
  route: string;
  frequency: number;
  /** Relative weight 1–5 for visual sizing. */
  weight: number;
}

export interface AssemblyCategoryNode {
  id: string;
  label: string;
  slug: string;
  route: string;
  pageCount: number;
  depth: number;
  children: AssemblyCategoryNode[];
}

export interface AssemblyFilterConfig {
  categories: Array<{ id: string; label: string; slug: string; count: number }>;
  tags: Array<{ tag: string; count: number }>;
  sortOptions: string[];
}

export interface AssemblyPaginationConfig {
  enabled: boolean;
  pageSize: number;
  /** URL pattern, e.g. "/categories/:slug/page/:page" */
  routePattern: string;
}

export interface AssemblyNavigation {
  /** Which NavigationStructures are active for this stencil. */
  activeStructures: NavigationStructure[];
  primaryNav: AssemblyNavItem[];
  sidebarNav: AssemblyNavItem[];
  megaMenuSections: AssemblyMegaMenuSection[];
  breadcrumbs: AssemblyBreadcrumbSchema;
  footerGroups: AssemblyFooterGroup[];
  tagCloud: AssemblyTagCloudItem[];
  categoryTree: AssemblyCategoryNode[];
  filterBar: AssemblyFilterConfig | null;
  pagination: AssemblyPaginationConfig;
  stepNavEnabled: boolean;
}

// ─── Pages ────────────────────────────────────────────────────────────────────

export interface AssemblyPageMeta {
  title: string;
  description: string | null;
  canonicalUrl: string;
  ogTitle: string;
  ogDescription: string | null;
  ogImageUrl: string | null;
  publishedAt: string | null;
  noIndex: boolean;
}

export interface AssemblyPage {
  id: string;
  route: string;
  slug: string;
  title: string;
  pageType: PageType;
  layout: LayoutType;
  /** Original manifest node ID; null for synthetically generated pages. */
  sourceNodeId: string | null;
  contentType: ContentType | null;
  isGenerated: boolean;
  /** Ordered list of component names to include on this page. */
  components: ComponentType[];
  meta: AssemblyPageMeta;
  /** Sitemap priority 0.0–1.0 */
  priority: number;
  changeFreq: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  estimatedWordCount: number | null;
  hasImages: boolean;
  imageCount: number;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export interface AssemblyRouteParam {
  name: string;
  description: string;
  example: string;
}

export interface AssemblyRoute {
  id: string;
  /** URL pattern, e.g. "/articles/:slug" */
  pattern: string;
  pageType: PageType;
  isDynamic: boolean;
  params: AssemblyRouteParam[];
  layout: LayoutType;
  description: string;
  /** Whether this route requires server-side rendering. */
  requiresSSR: boolean;
}

export interface AssemblyRouteMap {
  static: AssemblyRoute[];
  dynamic: AssemblyRoute[];
  total: number;
  generatedAt: string;
}

// ─── Search ───────────────────────────────────────────────────────────────────

export interface AssemblySearchStructure {
  enabled: boolean;
  route: string;
  indexedPageTypes: PageType[];
  totalIndexablePages: number;
  suggestionsEnabled: boolean;
  searchableFields: string[];
  /** Route pattern for the search API endpoint. */
  apiRoute: string | null;
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export interface SiteAssemblyStats {
  totalPages: number;
  articlePages: number;
  categoryPages: number;
  landingPages: number;
  generatedPages: number;
  orphanPagesIncluded: number;
  totalRoutes: number;
  dynamicRoutes: number;
  staticRoutes: number;
  navItems: number;
  categoryCount: number;
  tagCount: number;
  assemblyTimeMs: number;
}

// ─── Warnings ─────────────────────────────────────────────────────────────────

export interface AssemblyWarning {
  code: string;
  message: string;
  severity: "error" | "warning" | "info";
  /** Which stencil feature the warning relates to. */
  affectedFeature?: string;
}

// ─── Root output ──────────────────────────────────────────────────────────────

export interface SiteAssembly {
  version: "1.0";
  assembledAt: string;
  stencilId: StencilId;
  stencilDisplayName: string;
  seedUrl: string;
  siteGraphId: string;

  navigation: AssemblyNavigation;
  routes: AssemblyRouteMap;

  /** All pages in priority order. */
  pages: AssemblyPage[];
  landingPages: AssemblyPage[];
  articlePages: AssemblyPage[];
  categoryPages: AssemblyPage[];

  searchStructure: AssemblySearchStructure;

  stats: SiteAssemblyStats;
  warnings: AssemblyWarning[];
}

// ─── Export ───────────────────────────────────────────────────────────────────

export interface ExportAssemblyResult {
  success: boolean;
  outputPath: string;
  bytesWritten: number;
  errors: string[];
}
