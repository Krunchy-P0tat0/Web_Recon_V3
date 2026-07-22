/**
 * types.ts — All shared types for the manifest-binding layer.
 *
 * This module defines:
 *  - Input types (manifest shape, R2 inventory)
 *  - Binding record types (per-page, per-asset)
 *  - Event/audit log types
 *  - Validation types
 *  - Export result type
 *
 * The lib is self-contained: it does NOT import from artifacts/* or api-server.
 * Consumers pass in data that matches these shapes.
 */

// ---------------------------------------------------------------------------
// Binding source & confidence
// ---------------------------------------------------------------------------

/**
 * BindingSource — how a link between a manifest reference and an R2 key
 * was established. Every link carries a source tag; nothing is silent.
 *
 *   manifest-ref   Source of truth: the manifest's own cloudPath field.
 *                  Highest fidelity — the scraper stamped this key.
 *   url-pattern    Derived deterministically from the nodeId (sha256 prefix)
 *                  and the canonical R2 path layout.
 *   html-dom       Found by parsing the rendered HTML stored in R2.
 *   fallback       Heuristic scan — lowest confidence; always logged.
 */
export type BindingSource = "manifest-ref" | "url-pattern" | "html-dom" | "fallback";

export type MediaClassification =
  | "image"
  | "video"
  | "audio"
  | "embed"
  | "document"
  | "unknown";

// ---------------------------------------------------------------------------
// Input types — R2 inventory
// ---------------------------------------------------------------------------

export interface R2ObjectRecord {
  /** Full R2 object key, e.g. "jobs/<jobId>/images/<nodeId>/img_1.jpg" */
  key: string;
  /** Byte size of the object */
  size: number;
  /** Last-modified timestamp if available */
  lastModified?: Date;
}

// ---------------------------------------------------------------------------
// Input types — Manifest shape
// (Mirrors PortableManifest / PortablePageNode from api-server; defined
//  locally so this lib has zero artifact-layer dependencies.)
// ---------------------------------------------------------------------------

export interface ManifestStorageInput {
  localPath: string;
  cloudPath: string;
  publicPath: string;
  filename: string;
}

export interface ManifestMediaItemInput {
  id: string;
  sourceUrl: string;
  storage: ManifestStorageInput;
  mediaClassification?: string;
  byteSize: number | null;
}

export interface ManifestPageMediaInput {
  images: ManifestMediaItemInput[];
  videos: ManifestMediaItemInput[];
}

export interface ManifestPageContentInput {
  wordCount: number;
}

export interface ManifestPageMetadataInput {
  url: string;
  title: string;
  publishedAt: string | null;
  fetchedAt: string;
}

export interface ManifestPageRelationshipsInput {
  parentId: string | null;
  childIds: string[];
  paginationIndex: number | null;
  depth: number;
  discoverySource: string | null;
}

export interface ManifestNodeInput {
  id: string;
  nodeType: string;
  status: string;
  metadata: ManifestPageMetadataInput;
  content: ManifestPageContentInput;
  media: ManifestPageMediaInput;
  storage: ManifestStorageInput;
  relationships: ManifestPageRelationshipsInput;
}

export interface ManifestInput {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  seedUrl: string;
  nodes: ManifestNodeInput[];
}

// ---------------------------------------------------------------------------
// Binding input
// ---------------------------------------------------------------------------

export interface BindingInput {
  jobId: string;
  manifest: ManifestInput;
  r2Objects: R2ObjectRecord[];
}

// ---------------------------------------------------------------------------
// Binding record types
// ---------------------------------------------------------------------------

export interface AssetBinding {
  /** Full R2 object key */
  r2Key: string;
  /** Whether this key actually exists in the R2 listing */
  r2KeyPresent: boolean;
  /** How the link was established */
  source: BindingSource;
  /** 0–1 confidence in the link */
  confidence: number;
  /** Asset semantic type */
  mediaClassification: MediaClassification;
  /** Byte size from R2 listing (null if key not in R2) */
  byteSize: number | null;
}

export interface HtmlBinding {
  r2Key: string;
  r2KeyPresent: boolean;
  source: BindingSource;
  confidence: number;
}

export interface PageBinding {
  /** node.id = sha256(canonicalUrl).slice(0,16) */
  pageId: string;
  pageUrl: string;
  nodeType: string;
  nodeStatus: string;
  /** R2 key for the rendered HTML, or null if unresolvable */
  htmlR2Path: string | null;
  /** Whether the HTML key was found in the R2 listing */
  htmlR2Present: boolean;
  /** How the HTML key was determined */
  htmlBindingSource: BindingSource | null;
  /** Confidence of the HTML binding (0–1) */
  htmlConfidence: number;
  imageAssets: AssetBinding[];
  videoAssets: AssetBinding[];
  embedAssets: AssetBinding[];
  /** word count from manifest node content */
  wordCount: number;
  depth: number;
  parentPage: string | null;
  crawlSource: string | null;
}

export interface OrphanAsset {
  r2Key: string;
  size: number;
  category: string;
  possibleReason: string;
}

export interface OrphanPage {
  pageId: string;
  pageUrl: string;
  nodeType: string;
  nodeStatus: string;
  expectedHtmlR2Path: string | null;
  depth: number;
}

// ---------------------------------------------------------------------------
// Binding graph — primary output of buildBindingGraph
// ---------------------------------------------------------------------------

export interface BindingGraph {
  jobId: string;
  builtAt: string;
  manifestId: string;
  manifestStatus: string;
  manifestCreatedAt: string;
  seedUrl: string;
  pages: PageBinding[];
  totalR2Objects: number;
  /** R2 objects that were matched to at least one manifest entry */
  claimedR2Objects: number;
  /** R2 objects not matched to any manifest entry (excluding skip list) */
  unclaimedR2Objects: number;
}

// ---------------------------------------------------------------------------
// Binding events — NDJSON audit log, one entry per binding operation
// ---------------------------------------------------------------------------

export interface BindingEvent {
  timestamp: string;
  pageId: string;
  pageUrl: string;
  assetType: "html" | "image" | "video" | "audio" | "embed" | "document";
  r2Key: string;
  source: BindingSource;
  confidence: number;
  matchMethod: string;
  r2KeyPresent: boolean;
  byteSize?: number;
}

// ---------------------------------------------------------------------------
// Build result
// ---------------------------------------------------------------------------

export interface BuildBindingGraphResult {
  graph: BindingGraph;
  events: BindingEvent[];
  orphanAssets: OrphanAsset[];
}

// ---------------------------------------------------------------------------
// Validation types
// ---------------------------------------------------------------------------

export type ValidationIssueKind =
  | "html_missing_from_r2"
  | "html_unresolvable"
  | "asset_orphaned_in_r2"
  | "asset_coverage_below_threshold"
  | "page_coverage_below_threshold";

export interface ValidationIssue {
  kind: ValidationIssueKind;
  severity: "error" | "warning" | "info";
  pageId?: string;
  r2Key?: string;
  detail: string;
}

export interface ValidationMetrics {
  totalPages: number;
  pagesWithHtml: number;
  pagesWithHtmlPresent: number;
  pageCoverage: number;
  totalR2Assets: number;
  claimedR2Assets: number;
  unclaimedR2Assets: number;
  assetCoverage: number;
  orphanPages: number;
  orphanAssets: number;
}

export interface ValidationResult {
  passed: boolean;
  grade: "A" | "B" | "C" | "D" | "F";
  metrics: ValidationMetrics;
  issues: ValidationIssue[];
  orphanPages: OrphanPage[];
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// Export result
// ---------------------------------------------------------------------------

export interface ExportPaths {
  bindingManifest: string;
  bindingReport: string;
  orphanAssets: string;
  orphanPages: string;
  bindingEvents: string;
}

export interface ExportResult {
  exportedAt: string;
  outputDir: string;
  paths: ExportPaths;
  totalEvents: number;
  totalPages: number;
  totalOrphanAssets: number;
  totalOrphanPages: number;
}
