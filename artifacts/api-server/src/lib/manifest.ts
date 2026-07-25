import crypto from "crypto";
import { logger } from "./logger";
import type { ArticleLink } from "./scraper";

// ---------------------------------------------------------------------------
// Enums
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

// ---------------------------------------------------------------------------
// Extraction architecture types
// ---------------------------------------------------------------------------

/**
 * ExtractionMode — determines how the scraper approaches a given page.
 *   article   — extract article body, clean cruft, collect images (default)
 *   page      — capture the full page DOM with minimal filtering
 *   media     — focus on enumerating all media assets (images, video, audio)
 *   full_site — article + media: extract content AND enumerate all assets
 */
export type ExtractionMode = "article" | "page" | "media" | "full_site";

/**
 * MediaClassification — semantic category for a media item.
 * Determines which top-level storage directory the asset routes to.
 *   embed — iframe-based embeds (YouTube, Vimeo, TikTok, etc.)
 *           routed to /embeds/; never downloaded
 */
export type MediaClassification =
  | "image"
  | "video"
  | "audio"
  | "embed"
  | "document"
  | "unknown";

/**
 * SemanticCategory — top-level output directory in the archive.
 * Every extracted asset must be assigned to exactly one category.
 */
export type SemanticCategory =
  | "content"
  | "images"
  | "videos"
  | "audio"
  | "embeds"
  | "documents"
  | "metadata"
  | "dom";

export const SEMANTIC_CATEGORIES: readonly SemanticCategory[] = [
  "content",
  "images",
  "videos",
  "audio",
  "embeds",
  "documents",
  "metadata",
  "dom",
] as const;

// ---------------------------------------------------------------------------
// Sub-types
// ---------------------------------------------------------------------------

export interface StorageMap {
  localPath: string;
  cloudPath: string;
  publicPath: string;
  filename: string;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface MediaItem {
  id: string;
  sourceUrl: string;
  normalizedUrl: string | null;
  altText: string | null;
  mimeType: string | null;
  mediaClassification: MediaClassification;
  byteSize: number | null;
  dimensions: ImageDimensions | null;
  status: MediaStatus;
  failReason: string | null;
  storage: StorageMap;
  positionInPage: number;
  checksum: string | null;
  sourceElement: string | null;
  extractionMethod: string | null;
  htmlWidth: number | null;
  htmlHeight: number | null;
  // Embed-specific metadata (null for images and native downloadable media)
  provider: string | null;
  canonicalUrl: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
}

export interface PageMedia {
  images: MediaItem[];
  videos: MediaItem[];
}

export interface PageContent {
  cleanHtml: string;
  textContent: string;
  wordCount: number;
  bodySelector: string;
}

export interface PageMetadata {
  url: string;
  title: string;
  description: string | null;
  publishedAt: string | null;
  fetchedAt: string;
  siteType: "wordpress" | "cheerio" | "unknown";
}

export interface PageRelationships {
  parentId: string | null;
  childIds: string[];
  paginationIndex: number | null;
  depth: number;
  discoverySource: string | null;
}

/**
 * ChangeReason — why a node was classified as CHANGED in a differential crawl.
 * Multiple reasons can apply simultaneously.
 */
export type ChangeReason =
  | "contentHashChanged"
  | "titleChanged"
  | "imageSetChanged"
  | "metadataChanged"
  | "structureChanged";

/**
 * DiffClassification — classification of a node relative to a baseline manifest.
 *   new       — URL not present in baseline
 *   changed   — URL present in baseline but content differs
 *   unchanged — URL present in baseline and content is identical
 *   deleted   — URL present in baseline but absent from new crawl (baseline-only)
 */
export type DiffClassification = "new" | "changed" | "unchanged" | "deleted";

export interface PageNode {
  id: string;
  version: "1.0";
  nodeType: NodeType;
  status: NodeStatus;
  metadata: PageMetadata;
  content: PageContent;
  media: PageMedia;
  storage: StorageMap;
  relationships: PageRelationships;
  /** SHA-256 hash of content.cleanHtml — used by the differential engine to detect changes. */
  contentHash?: string;
  /** ETag header value from the last HTTP fetch — used for cheap change detection. */
  httpEtag?: string | null;
  /** Last-Modified header value from the last HTTP fetch — ISO string. */
  httpLastModified?: string | null;
  /** Set by the differential engine when this job was run in diff mode. */
  diffClassification?: DiffClassification;
  /** Reasons the node was classified as CHANGED (only set when diffClassification === "changed"). */
  changeReasons?: ChangeReason[];
  /**
   * Visual artifacts captured by Phase 2.5A Visual Capture Engine.
   * R2 paths (or public URLs) for each artifact type.
   */
  visualAssets?: {
    /** Full-page desktop screenshot (1920×1080). R2 path or public URL. */
    desktopScreenshot?: string;
    /** Full-page tablet screenshot (768×1024). R2 path or public URL. */
    tabletScreenshot?: string;
    /** Full-page mobile screenshot (390×844). R2 path or public URL. */
    mobileScreenshot?: string;
    /** Fully-rendered DOM HTML after JS hydration. R2 path or public URL. */
    domSnapshot?: string;
    /** All active stylesheets concatenated. R2 path or public URL. */
    cssSnapshot?: string;
    /** Structured layout metadata extracted from the live page. */
    layoutMetadata?: {
      pageHeight: number;
      pageWidth: number;
      sectionCount: number;
      imageCount: number;
      videoCount: number;
      headingStructure: Record<string, number>;
      hasNavigation: boolean;
      hasFooter: boolean;
    };
  };
}

export interface ManifestStats {
  totalNodes: number;
  byStatus: Record<NodeStatus, number>;
  byType: Record<NodeType, number>;
  totalImages: number;
  totalVideos: number;
  pathConsistencyCheck?: boolean;
  renderSource?: "manifest" | "legacy" | "fallback";
}

// ---------------------------------------------------------------------------
// CloudExecutionReport
// ---------------------------------------------------------------------------

export interface CloudDuplicateConflict {
  cloudPath: string;
  count: number;
  sources: Array<{
    nodeId: string;
    kind: "node" | "image" | "video";
    mediaId?: string;
  }>;
}

export interface CloudMissingMapping {
  nodeId: string;
  nodeType: NodeType;
  kind: "node" | "image" | "video";
  mediaId?: string;
  issue: "empty_localPath" | "empty_cloudPath" | "both_empty";
}

export interface CloudInvalidFilename {
  cloudPath: string;
  filename: string;
  reason: string;
}

export interface CloudConsistencyError {
  nodeId: string;
  kind: "node" | "image" | "video";
  localPath: string;
  cloudPath: string;
  expectedCloudPath: string;
}

export interface CloudProviderMappingError {
  cloudPath: string;
  issue: string;
}

export type CloudInvariantRule =
  | "no_renderer_generated_paths"
  | "no_duplicate_cloud_keys"
  | "no_missing_media_references";

export interface CloudInvariantViolation {
  rule: CloudInvariantRule;
  detail: string;
  nodeId?: string;
  mediaId?: string;
}

export interface CloudExecutionReport {
  totalFiles: number;
  totalBytes: number;
  skippedMediaCount: number;
  failedMediaCount: number;
  duplicateCloudPathConflicts: CloudDuplicateConflict[];
  missingStorageMappings: CloudMissingMapping[];
  invalidFilenames: CloudInvalidFilename[];
  localCloudConsistencyErrors: CloudConsistencyError[];
  providerMappingErrors: CloudProviderMappingError[];
  invariantViolations: CloudInvariantViolation[];
  valid: boolean;
  generatedAt: string;
}

export interface ManifestOutput {
  zipPath: string;
  downloadUrl: string;
  renderedAt: string;
  nodeCount: number;
  renderSource: "manifest" | "legacy" | "fallback";
  pathConsistencyCheck: boolean;
  jsonPath: string;
  cloud?: CloudExecutionReport;
  r2Upload?: import("./r2-executor").R2UploadReport;
  regeneration?: import("./zip-regenerator").RegenerationReport;
}

export interface ManifestConfig {
  crawlAllPages: boolean;
  includeImages: boolean;
  seedUrl: string;
  extractionMode: ExtractionMode;
}

export interface Manifest {
  id: string;
  version: "1.0";
  status: ManifestStatus;
  createdAt: string;
  updatedAt: string;
  seedUrl: string;
  config: ManifestConfig;
  nodes: Map<string, PageNode>;
  seenUrls: Set<string>;
  stats: ManifestStats;
  output?: ManifestOutput;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function deriveNodeId(url: string): string {
  const canonical = url.trim().toLowerCase().replace(/\/$/, "").replace(/#.*$/, "");
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Derives the deterministic cloud storage path for a ZIP entry.
 * Convention: jobs/{jobId}/{localPath}
 */
export function deriveCloudPath(jobId: string, localPath: string): string {
  return `jobs/${jobId}/${localPath}`;
}

// ---------------------------------------------------------------------------
// Extraction routing — manifest-driven path assignment
// ---------------------------------------------------------------------------

/**
 * ExtractionRoute — the fully computed storage addresses for one extracted asset.
 * Every node and media item must have a route assigned before entering the manifest.
 */
export interface ExtractionRoute {
  localPath: string;
  publicPath: string;
  cloudPath: string;
  filename: string;
  category: SemanticCategory;
}

/**
 * routeToSemanticCategory — maps a node type + optional media classification
 * to the correct top-level storage category.
 *
 * This is the SINGLE source of truth for where extracted content lives.
 * No hardcoded paths anywhere else in the system.
 */
export function routeToSemanticCategory(
  nodeType: NodeType,
  mediaClassification?: MediaClassification
): SemanticCategory {
  if (mediaClassification !== undefined) {
    switch (mediaClassification) {
      case "image":    return "images";
      case "video":    return "videos";
      case "audio":    return "audio";
      case "embed":    return "embeds";
      case "document": return "documents";
      case "unknown":  return "dom";
    }
  }
  switch (nodeType) {
    case "article":
    case "pagination": return "content";
    case "root":
    case "index":      return "metadata";
    case "asset":      return "dom";
    default:           return "content";
  }
}

/**
 * routeExtractionByType — manifest-controlled path routing.
 *
 * Replaces ALL hardcoded path construction in the scraper runtime.
 * The manifest's node type and media classification determine:
 *   - which top-level semantic category the asset belongs to
 *   - the exact localPath inside the archive
 *   - the publicPath (web-accessible root-relative URL)
 *
 * cloudPath is left empty ("") — populated later by stampCloudPaths().
 *
 * Storage layout produced:
 *   content/{pageKey}/{slug}/index.html   ← article/pagination nodes
 *   images/{nodeId}/{filename}            ← image assets
 *   videos/{nodeId}/{filename}            ← video assets
 *   audio/{nodeId}/{filename}             ← audio assets
 *   documents/{nodeId}/{filename}         ← document assets
 *   metadata/{filename}                   ← index / root nodes
 *   dom/{nodeId}/{filename}               ← raw DOM captures / unknown assets
 *   index.html                            ← root index (special case)
 */
export function routeExtractionByType(params: {
  nodeType: NodeType;
  mediaClassification?: MediaClassification;
  nodeId: string;
  filename: string;
  pageKey?: string;
  slug?: string;
}): ExtractionRoute {
  const { nodeType, mediaClassification, nodeId, filename, pageKey, slug } = params;
  const category = routeToSemanticCategory(nodeType, mediaClassification);

  let localPath: string;

  if (mediaClassification !== undefined) {
    localPath = `${category}/${nodeId}/${filename}`;
  } else {
    switch (nodeType) {
      case "root":
        localPath = "index.html";
        break;
      case "article":
      case "pagination":
        localPath =
          pageKey && slug
            ? `${category}/${pageKey}/${slug}/index.html`
            : `${category}/${nodeId}/index.html`;
        break;
      default:
        localPath = `${category}/${nodeId}/${filename}`;
    }
  }

  logger.debug(
    {
      nodeType,
      mediaClassification: mediaClassification ?? "none",
      category,
      localPath,
    },
    "ROUTING: asset routed to semantic category"
  );

  return {
    localPath,
    publicPath: `/${localPath}`,
    cloudPath: "",
    filename,
    category,
  };
}

function makeEmptyStats(): ManifestStats {
  return {
    totalNodes: 0,
    byStatus: {
      discovered: 0,
      fetched: 0,
      parsed: 0,
      media_pending: 0,
      complete: 0,
      error: 0,
      skipped: 0,
    },
    byType: {
      article: 0,
      index: 0,
      pagination: 0,
      root: 0,
      asset: 0,
    },
    totalImages: 0,
    totalVideos: 0,
  };
}

// ---------------------------------------------------------------------------
// Factory: Manifest
// ---------------------------------------------------------------------------

export function createManifest(seedUrl: string, config: ManifestConfig): Manifest {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    version: "1.0",
    status: "initializing",
    createdAt: now,
    updatedAt: now,
    seedUrl,
    config,
    nodes: new Map(),
    seenUrls: new Set(),
    stats: makeEmptyStats(),
  };
}

// ---------------------------------------------------------------------------
// Factory: PageNode from successfully scraped page
// ---------------------------------------------------------------------------

/**
 * createPageNodeFromArticle — assembles a PageNode from pre-computed routes.
 *
 * INVARIANT: nodeRoute and all mediaItems must already have localPath, publicPath
 * set by routeExtractionByType() before this function is called.
 * No path generation happens here — this function is purely assembly.
 */
export function createPageNodeFromArticle(
  article: ArticleLink,
  extracted: {
    title: string;
    cleanHtml: string;
    bodySelector: string;
  },
  nodeRoute: ExtractionRoute,
  mediaImages: MediaItem[],
  mediaVideos: MediaItem[]
): PageNode {
  const id = deriveNodeId(article.url);
  const now = new Date().toISOString();

  const plainText = extracted.cleanHtml
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const wordCount = plainText.length > 0 ? plainText.split(" ").length : 0;

  return {
    id,
    version: "1.0",
    nodeType: "article",
    status: "complete",
    metadata: {
      url: article.url,
      title: extracted.title,
      description: article.description ?? null,
      publishedAt: article.publishedAt ?? null,
      fetchedAt: now,
      siteType: "unknown",
    },
    content: {
      cleanHtml: extracted.cleanHtml,
      textContent: plainText,
      wordCount,
      bodySelector: extracted.bodySelector,
    },
    media: {
      images: mediaImages,
      videos: mediaVideos,
    },
    storage: {
      localPath: nodeRoute.localPath,
      cloudPath: nodeRoute.cloudPath,
      publicPath: nodeRoute.publicPath,
      filename: nodeRoute.filename,
    },
    relationships: {
      parentId: null,
      childIds: [],
      paginationIndex: article.pageNumber ?? null,
      depth: article.depth ?? 1,
      discoverySource: article.discoverySource ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Structured error types for illegal transitions
// ---------------------------------------------------------------------------

export class ManifestTransitionError extends Error {
  constructor(
    public readonly from: ManifestStatus,
    public readonly to: ManifestStatus,
    public readonly manifestId: string
  ) {
    super(`Illegal manifest transition [${from} → ${to}] on manifest ${manifestId}`);
    this.name = "ManifestTransitionError";
  }
}

export class NodeTransitionError extends Error {
  constructor(
    public readonly from: NodeStatus,
    public readonly to: NodeStatus,
    public readonly nodeId: string
  ) {
    super(`Illegal node transition [${from} → ${to}] on node ${nodeId}`);
    this.name = "NodeTransitionError";
  }
}

// ---------------------------------------------------------------------------
// Transition log entry
// ---------------------------------------------------------------------------

export interface TransitionLog {
  kind: "manifest" | "node";
  id: string;
  from: string;
  to: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Allowed transitions
// ---------------------------------------------------------------------------

const MANIFEST_TRANSITIONS: Record<ManifestStatus, readonly ManifestStatus[]> = {
  initializing: ["crawling",  "error"],
  crawling:     ["scraping",  "error"],
  scraping:     ["media",     "error"],
  media:        ["rendering", "error"],
  rendering:    ["complete",  "partial", "error"],
  complete:     [],
  partial:      [],
  error:        [],
};

const NODE_ORDER: Record<NodeStatus, number> = {
  discovered:    0,
  fetched:       1,
  parsed:        2,
  media_pending: 3,
  complete:      4,
  error:         4,
  skipped:       4,
};

const NODE_TERMINAL: ReadonlySet<NodeStatus> = new Set<NodeStatus>([
  "complete",
  "error",
  "skipped",
]);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function validateManifestTransition(
  from: ManifestStatus,
  to: ManifestStatus,
  manifestId: string
): void {
  const allowed = MANIFEST_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new ManifestTransitionError(from, to, manifestId);
  }
}

export function validateNodeTransition(
  from: NodeStatus,
  to: NodeStatus,
  nodeId: string
): void {
  if (NODE_TERMINAL.has(from)) {
    throw new NodeTransitionError(from, to, nodeId);
  }
  if (NODE_ORDER[to] < NODE_ORDER[from]) {
    throw new NodeTransitionError(from, to, nodeId);
  }
}

// ---------------------------------------------------------------------------
// Transition helpers
// ---------------------------------------------------------------------------

export function transitionManifest(
  manifest: Manifest,
  to: ManifestStatus
): void {
  validateManifestTransition(manifest.status, to, manifest.id);
  const entry: TransitionLog = {
    kind: "manifest",
    id: manifest.id,
    from: manifest.status,
    to,
    timestamp: new Date().toISOString(),
  };
  logger.debug(entry, "MANIFEST_TRANSITION");
  manifest.status = to;
  manifest.updatedAt = entry.timestamp;
}

export function transitionNode(
  node: PageNode,
  to: NodeStatus,
  manifestId = "unknown"
): void {
  validateNodeTransition(node.status, to, node.id);
  const entry: TransitionLog = {
    kind: "node",
    id: node.id,
    from: node.status,
    to,
    timestamp: new Date().toISOString(),
  };
  logger.debug({ ...entry, manifestId }, "NODE_TRANSITION");
  node.status = to;
}

// ---------------------------------------------------------------------------
// Rendering seal
// ---------------------------------------------------------------------------

export function sealForRendering(manifest: Manifest): void {
  for (const node of manifest.nodes.values()) {
    Object.freeze(node.content);
    Object.freeze(node.relationships);
    Object.freeze(node.storage);
    Object.freeze(node.media.images);
    Object.freeze(node.media.videos);
    Object.freeze(node.media);
    Object.freeze(node);
  }
}

// ---------------------------------------------------------------------------
// Manifest readiness check
// ---------------------------------------------------------------------------

export function isManifestReady(
  manifest: Manifest,
  expectedCount: number
): boolean {
  const articleNodes = Array.from(manifest.nodes.values()).filter(
    (n) => n.nodeType !== "root"
  );
  if (articleNodes.length === 0) return false;
  const readyCount = articleNodes.filter(
    (n) => n.status === "complete" || n.status === "parsed"
  ).length;
  return readyCount >= Math.ceil(expectedCount * 0.5);
}

export function getOrderedNodes(
  manifest: Manifest,
  filter?: NodeStatus[]
): PageNode[] {
  const all = Array.from(manifest.nodes.values());
  const filtered = filter ? all.filter((n) => filter.includes(n.status)) : all;
  return filtered.sort((a, b) => {
    const pa = a.relationships.paginationIndex ?? 0;
    const pb = b.relationships.paginationIndex ?? 0;
    if (pa !== pb) return pa - pb;
    const ta = a.metadata.publishedAt ?? "";
    const tb = b.metadata.publishedAt ?? "";
    if (ta !== tb) return tb.localeCompare(ta);
    return a.metadata.title.localeCompare(b.metadata.title);
  });
}

// ---------------------------------------------------------------------------
// Factory: Root PageNode for seed URL
// ---------------------------------------------------------------------------

export function createRootNode(seedUrl: string): PageNode {
  const id = deriveNodeId(seedUrl);
  const now = new Date().toISOString();
  return {
    id,
    version: "1.0",
    nodeType: "root",
    status: "complete",
    metadata: {
      url: seedUrl,
      title: seedUrl,
      description: null,
      publishedAt: null,
      fetchedAt: now,
      siteType: "unknown",
    },
    content: {
      cleanHtml: "",
      textContent: "",
      wordCount: 0,
      bodySelector: "none",
    },
    media: { images: [], videos: [] },
    storage: {
      localPath: "index.html",
      cloudPath: "",
      publicPath: "/index.html",
      filename: "index.html",
    },
    relationships: {
      parentId: null,
      childIds: [],
      paginationIndex: null,
      depth: 0,
      discoverySource: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Factory: PageNode for a failed article scrape
// ---------------------------------------------------------------------------

export function createErrorPageNode(
  article: ArticleLink,
  err: unknown,
  nodeRoute: ExtractionRoute
): PageNode {
  const id = deriveNodeId(article.url);
  const now = new Date().toISOString();
  const message = err instanceof Error ? err.message : String(err);

  return {
    id,
    version: "1.0",
    nodeType: "article",
    status: "error",
    metadata: {
      url: article.url,
      title: article.title,
      description: null,
      publishedAt: article.publishedAt ?? null,
      fetchedAt: now,
      siteType: "unknown",
    },
    content: {
      cleanHtml: `<p>Failed to scrape: ${message}</p>`,
      textContent: `Failed to scrape: ${message}`,
      wordCount: 0,
      bodySelector: "none",
    },
    media: { images: [], videos: [] },
    storage: {
      localPath: nodeRoute.localPath.replace("index.html", "error.html"),
      cloudPath: "",
      publicPath: nodeRoute.publicPath.replace("index.html", "error.html"),
      filename: "error.html",
    },
    relationships: {
      parentId: null,
      childIds: [],
      paginationIndex: article.pageNumber ?? null,
      depth: article.depth ?? 1,
      discoverySource: article.discoverySource ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Invariant validation
// ---------------------------------------------------------------------------

/**
 * assertNoArticlePaths — guards against hardcoded legacy article paths.
 * Throws if any node uses the old `articles/` prefix.
 */
export function assertNoArticlePaths(manifest: Manifest): void {
  for (const node of manifest.nodes.values()) {
    if (node.storage.localPath.startsWith("articles/")) {
      throw new Error(
        `INVARIANT VIOLATION: node ${node.id} uses legacy articles/ path: ${node.storage.localPath}`
      );
    }
    for (const img of node.media.images) {
      if (img.storage.localPath.startsWith("articles/")) {
        throw new Error(
          `INVARIANT VIOLATION: image ${img.id} on node ${node.id} uses legacy articles/ path`
        );
      }
    }
  }
}

/**
 * assertMediaClassified — every MediaItem must have a non-"unknown" classification
 * when it has been successfully downloaded.
 */
export function assertMediaClassified(manifest: Manifest): void {
  for (const node of manifest.nodes.values()) {
    for (const item of [...node.media.images, ...node.media.videos]) {
      if (item.status === "downloaded" || item.status === "rendered") {
        if (!item.mediaClassification) {
          throw new Error(
            `INVARIANT VIOLATION: media item ${item.id} on node ${node.id} has no classification`
          );
        }
      }
    }
  }
}
