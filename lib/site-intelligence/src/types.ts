/**
 * types.ts — Complete type definitions for the Site Intelligence Layer
 *
 * All types are plain-JSON-serializable (no Map, Set, Buffer).
 * The SiteGraph is the sole output of the intelligence pipeline and
 * the sole input required by a StencilRenderer.
 */

// ---------------------------------------------------------------------------
// Re-export PortableManifest shape (input to the intelligence pipeline)
// These are inlined here so the lib has zero deps on api-server internals.
// ---------------------------------------------------------------------------

export type NodeType = "article" | "index" | "pagination" | "root" | "asset";
export type NodeStatus =
  | "discovered"
  | "fetched"
  | "parsed"
  | "media_pending"
  | "complete"
  | "error"
  | "skipped";
export type MediaStatus = "pending" | "downloaded" | "rendered" | "failed" | "skipped";
export type ManifestStatus =
  | "initializing"
  | "crawling"
  | "scraping"
  | "media"
  | "rendering"
  | "complete"
  | "partial"
  | "error";

export interface PortableStorageMap {
  localPath: string;
  cloudPath: string;
  publicPath: string;
  filename: string;
}

export interface PortableMediaItem {
  id: string;
  sourceUrl: string;
  normalizedUrl: string | null;
  altText: string | null;
  mimeType: string | null;
  byteSize: number | null;
  dimensions: { width: number; height: number } | null;
  status: MediaStatus;
  failReason: string | null;
  storage: PortableStorageMap;
  positionInPage: number;
  checksum: string | null;
  sourceElement: string | null;
  extractionMethod: string | null;
  htmlWidth: number | null;
  htmlHeight: number | null;
  provider: string | null;
  canonicalUrl: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
}

export interface PortablePageMedia {
  images: PortableMediaItem[];
  videos: PortableMediaItem[];
}

export interface PortablePageContent {
  cleanHtml: string;
  textContent: string;
  wordCount: number;
  bodySelector: string;
}

export interface PortablePageMetadata {
  url: string;
  title: string;
  description: string | null;
  publishedAt: string | null;
  fetchedAt: string;
  siteType: "wordpress" | "cheerio" | "unknown";
}

export interface PortablePageRelationships {
  parentId: string | null;
  childIds: string[];
  paginationIndex: number | null;
  depth: number;
  discoverySource: string | null;
}

export interface PortablePageNode {
  id: string;
  version: "1.0";
  nodeType: NodeType;
  status: NodeStatus;
  metadata: PortablePageMetadata;
  content: PortablePageContent;
  media: PortablePageMedia;
  storage: PortableStorageMap;
  relationships: PortablePageRelationships;
}

export interface ManifestConfig {
  crawlAllPages: boolean;
  includeImages: boolean;
  seedUrl: string;
  extractionMode: string;
}

export interface ManifestStats {
  totalNodes: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  totalImages: number;
  totalVideos: number;
}

export interface PortableManifest {
  schemaVersion: string;
  exportedAt: string;
  id: string;
  version: "1.0";
  status: ManifestStatus;
  createdAt: string;
  updatedAt: string;
  seedUrl: string;
  config: ManifestConfig;
  nodes: PortablePageNode[];
  seenUrls: string[];
  stats: ManifestStats;
}

// ---------------------------------------------------------------------------
// Classification Engine
// ---------------------------------------------------------------------------

export type ContentType =
  | "ARTICLE"
  | "BLOG"
  | "GUIDE"
  | "LANDING_PAGE"
  | "PORTFOLIO"
  | "GALLERY"
  | "FAQ"
  | "DOCS";

export interface ClassificationSignal {
  signal: string;
  weight: number;
  matched: boolean;
  evidence: string;
}

export interface ClassificationResult {
  nodeId: string;
  url: string;
  contentType: ContentType;
  confidence: number;
  signals: ClassificationSignal[];
  reasoning: string;
  alternativeCandidates: Array<{ contentType: ContentType; confidence: number }>;
}

// ---------------------------------------------------------------------------
// Navigation Intelligence
// ---------------------------------------------------------------------------

export interface NavItem {
  nodeId: string;
  url: string;
  title: string;
  depth: number;
  children: NavItem[];
  isOrphan: boolean;
}

export interface BreadcrumbEntry {
  nodeId: string;
  url: string;
  title: string;
  depth: number;
}

export interface OrphanPage {
  nodeId: string;
  url: string;
  title: string;
  reason: "no_parent" | "broken_parent_ref" | "depth_mismatch";
}

export interface DuplicatePath {
  route: string;
  nodeIds: string[];
}

export interface NavigationTree {
  primary: NavItem[];
  secondary: NavItem[];
  breadcrumbs: Record<string, BreadcrumbEntry[]>;
  orphanPages: OrphanPage[];
  duplicatePaths: DuplicatePath[];
  totalNavigableNodes: number;
  maxDepth: number;
}

// ---------------------------------------------------------------------------
// Route Intelligence
// ---------------------------------------------------------------------------

export interface RouteEntry {
  nodeId: string;
  url: string;
  route: string;
  slug: string;
  isCollisionResolved: boolean;
  collisionSuffix: number | null;
  routeSource: "url_path" | "title_slug" | "node_id_fallback";
  movedFrom: string | null;
}

export interface RouteMap {
  routes: RouteEntry[];
  routeIndex: Record<string, string>;
  collisionCount: number;
  totalRoutes: number;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Layout Intelligence
// ---------------------------------------------------------------------------

export type LayoutType =
  | "ArticleLayout"
  | "GalleryLayout"
  | "LandingLayout"
  | "DocumentationLayout"
  | "PortfolioLayout"
  | "IndexLayout"
  | "MinimalLayout";

export interface LayoutAssignment {
  nodeId: string;
  url: string;
  layout: LayoutType;
  confidence: number;
  reasoning: string;
  contentType: ContentType;
  signals: {
    wordCount: number;
    imageCount: number;
    videoCount: number;
    hasStructuredContent: boolean;
    hasGallerySignals: boolean;
    isLandingPage: boolean;
  };
}

// ---------------------------------------------------------------------------
// Category Intelligence
// ---------------------------------------------------------------------------

export interface CategoryNode {
  id: string;
  label: string;
  slug: string;
  parentId: string | null;
  childIds: string[];
  pageIds: string[];
  pageCount: number;
  depth: number;
  source: "url_segment" | "title_keyword" | "inferred";
}

export interface TagRelationship {
  tag: string;
  nodeIds: string[];
  frequency: number;
}

export interface CategoryGraph {
  categories: CategoryNode[];
  categoryIndex: Record<string, string>;
  tags: TagRelationship[];
  uncategorizedPageIds: string[];
  totalCategories: number;
  maxDepth: number;
}

// ---------------------------------------------------------------------------
// Asset Intelligence
// ---------------------------------------------------------------------------

export type AssetType = "image" | "video" | "embed" | "document" | "unknown";

export interface AssetEntry {
  id: string;
  sourceUrl: string;
  normalizedUrl: string | null;
  assetType: AssetType;
  mimeType: string | null;
  byteSize: number | null;
  status: MediaStatus;
  referencedByNodeIds: string[];
  referenceCount: number;
  cloudPath: string;
  localPath: string;
  checksum: string | null;
  altText: string | null;
  dimensions: { width: number; height: number } | null;
  isOrphan: boolean;
  isDuplicate: boolean;
  duplicateOf: string | null;
  isMissing: boolean;
}

export interface AssetGraph {
  assets: AssetEntry[];
  assetIndex: Record<string, string>;
  orphanAssets: string[];
  duplicateGroups: Array<{ canonicalId: string; duplicateIds: string[] }>;
  missingAssets: string[];
  totalAssets: number;
  totalBytes: number;
  assetsByType: Record<AssetType, number>;
  bindingReport: {
    totalBindings: number;
    resolvedBindings: number;
    unresolvedBindings: number;
    unreferencedNodes: string[];
  };
}

// ---------------------------------------------------------------------------
// Site Graph Stats
// ---------------------------------------------------------------------------

export interface SiteGraphStats {
  totalNodes: number;
  contentNodes: number;
  indexNodes: number;
  rootNodes: number;
  errorNodes: number;
  skippedNodes: number;
  byContentType: Record<ContentType, number>;
  byLayout: Record<LayoutType, number>;
  totalAssets: number;
  totalImages: number;
  totalVideos: number;
  totalCategories: number;
  totalRoutes: number;
  orphanCount: number;
  collisionCount: number;
  missingAssetCount: number;
  averageWordCount: number;
  averageImagesPerPage: number;
}

// ---------------------------------------------------------------------------
// SiteGraph — the unified intelligence output
// ---------------------------------------------------------------------------

export interface SiteGraph {
  id: string;
  version: "1.0";
  generatedAt: string;
  seedUrl: string;
  manifestId: string;
  totalNodes: number;
  contentNodes: number;

  classifications: ClassificationResult[];
  navigation: NavigationTree;
  routeMap: RouteMap;
  layoutAssignments: LayoutAssignment[];
  categoryGraph: CategoryGraph;
  assetGraph: AssetGraph;

  stats: SiteGraphStats;
}

// ---------------------------------------------------------------------------
// Stencil Compatibility Layer
// ---------------------------------------------------------------------------

export type StencilCapability =
  | "render_article"
  | "render_gallery"
  | "render_landing"
  | "render_documentation"
  | "render_portfolio"
  | "render_index"
  | "render_navigation"
  | "render_breadcrumbs"
  | "render_category_pages"
  | "embed_assets"
  | "generate_sitemap"
  | "generate_search_index";

export interface StencilRendererRequirement {
  input: "SiteGraph";
  version: "1.0";
  requiredFields: Array<keyof SiteGraph>;
  optionalFields: Array<keyof SiteGraph>;
}

export interface StencilOutputSpec {
  htmlFiles: boolean;
  cssFiles: boolean;
  assetFiles: boolean;
  rootIndex: boolean;
  sitemap: boolean;
  searchIndex: boolean;
}

export interface StencilContract {
  version: "1.0";
  name: string;
  description: string;
  rendererRequirements: StencilRendererRequirement;
  capabilities: StencilCapability[];
  outputSpec: StencilOutputSpec;
  constraints: {
    noCrawlerDependency: true;
    noDatabaseDependency: true;
    noExternalNetworkRequired: true;
    noOriginalSiteDependency: true;
    deterministicOutput: true;
  };
  siteGraphVersion: "1.0";
}

// ---------------------------------------------------------------------------
// Validation Layer
// ---------------------------------------------------------------------------

export type ValidationGrade = "PASS" | "PARTIAL_PASS" | "FAIL";

export interface ValidationIssue {
  severity: "error" | "warning" | "info";
  category: "routes" | "navigation" | "assets" | "layouts" | "categories" | "classification";
  code: string;
  message: string;
  nodeId?: string;
  assetId?: string;
  route?: string;
}

export interface ValidationSection {
  grade: ValidationGrade;
  issues: ValidationIssue[];
  passCount: number;
  warnCount: number;
  errorCount: number;
  summary: string;
}

export interface SiteValidationReport {
  siteGraphId: string;
  seedUrl: string;
  generatedAt: string;
  overallGrade: ValidationGrade;
  sections: {
    routes: ValidationSection;
    navigation: ValidationSection;
    assets: ValidationSection;
    layouts: ValidationSection;
    categories: ValidationSection;
    classifications: ValidationSection;
  };
  totalIssues: number;
  totalErrors: number;
  totalWarnings: number;
  isRenderable: boolean;
  renderabilityBlockers: string[];
  summary: string;
}
