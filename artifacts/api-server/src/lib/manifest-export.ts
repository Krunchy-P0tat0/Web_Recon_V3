/**
 * manifest-export.ts — Portable Manifest JSON Exporter
 *
 * Produces a stable, deterministic JSON representation of a Manifest
 * suitable for long-term storage, inspection, and full reconstruction
 * of node hierarchy, asset mappings, and storage mappings.
 *
 * Runtime-only state excluded:
 *   - Map / Set objects  → converted to sorted arrays
 *   - Buffer             → never stored on Manifest; confirmed safe
 *   - Live streams       → never stored on Manifest; confirmed safe
 *   - Open file handles  → storage paths are plain strings, no fd refs
 *
 * Determinism contract:
 *   - nodes    sorted by node.id  (SHA-256 prefix — stable for the same URL)
 *   - seenUrls sorted lexicographically
 *   - childIds sorted lexicographically within each node
 *   - images   sorted ascending by positionInPage within each node
 *   - object keys follow the fixed declaration order of the Portable* types
 */

import type {
  Manifest,
  ManifestStatus,
  ManifestConfig,
  ManifestOutput,
  ManifestStats,
  PageNode,
  StorageMap,
  MediaItem,
  NodeType,
  NodeStatus,
  MediaStatus,
} from "./manifest";

// ---------------------------------------------------------------------------
// Schema version — bump when PortableManifest shape changes
// ---------------------------------------------------------------------------

export const PORTABLE_SCHEMA_VERSION = "1.0" as const;
export type PortableSchemaVersion = typeof PORTABLE_SCHEMA_VERSION;

// ---------------------------------------------------------------------------
// Portable sub-types
// All fields are plain JSON scalars or nested plain objects.
// Isomorphic to the in-memory types but free of Map, Set, Buffer.
// ---------------------------------------------------------------------------

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
  // Embed-specific metadata (null for images and native media)
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

export interface PortableManifest {
  schemaVersion: PortableSchemaVersion;
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
  output?: ManifestOutput;
}

// ---------------------------------------------------------------------------
// Internal serialization helpers — pure, no side effects
// ---------------------------------------------------------------------------

function portableStorage(s: StorageMap): PortableStorageMap {
  return {
    localPath: s.localPath,
    cloudPath: s.cloudPath,
    publicPath: s.publicPath ?? "",
    filename: s.filename,
  };
}

function portableMediaItem(item: MediaItem): PortableMediaItem {
  return {
    id: item.id,
    sourceUrl: item.sourceUrl,
    normalizedUrl: item.normalizedUrl ?? null,
    altText: item.altText,
    mimeType: item.mimeType,
    byteSize: item.byteSize,
    dimensions: item.dimensions,
    status: item.status,
    failReason: item.failReason,
    storage: portableStorage(item.storage),
    positionInPage: item.positionInPage,
    checksum: item.checksum ?? null,
    sourceElement: item.sourceElement ?? null,
    extractionMethod: item.extractionMethod ?? null,
    htmlWidth: item.htmlWidth ?? null,
    htmlHeight: item.htmlHeight ?? null,
    provider: item.provider ?? null,
    canonicalUrl: item.canonicalUrl ?? null,
    thumbnailUrl: item.thumbnailUrl ?? null,
    durationSeconds: item.durationSeconds ?? null,
  };
}

function portableNode(node: PageNode): PortablePageNode {
  return {
    id: node.id,
    version: node.version,
    nodeType: node.nodeType,
    status: node.status,
    metadata: {
      url: node.metadata.url,
      title: node.metadata.title,
      description: node.metadata.description,
      publishedAt: node.metadata.publishedAt,
      fetchedAt: node.metadata.fetchedAt,
      siteType: node.metadata.siteType,
    },
    content: {
      cleanHtml: node.content.cleanHtml,
      textContent: node.content.textContent,
      wordCount: node.content.wordCount,
      bodySelector: node.content.bodySelector,
    },
    media: {
      images: node.media.images
        .slice()
        .sort((a, b) => a.positionInPage - b.positionInPage)
        .map(portableMediaItem),
      videos: node.media.videos
        .slice()
        .map(portableMediaItem),
    },
    storage: portableStorage(node.storage),
    relationships: {
      parentId: node.relationships.parentId,
      childIds: node.relationships.childIds.slice().sort(),
      paginationIndex: node.relationships.paginationIndex,
      depth: node.relationships.depth,
      discoverySource: node.relationships.discoverySource ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API — renderManifestJson
// ---------------------------------------------------------------------------

/**
 * Renders a portable, deterministic JSON export of a Manifest.
 *
 * Pure function — does not mutate the manifest, does not perform I/O.
 * Safe to call at any phase. All Map/Set instances are converted to
 * sorted plain arrays. All nested objects are shallow-copied so frozen
 * objects (post-sealForRendering) are correctly serialized.
 *
 * The returned string is valid JSON and can be used directly with
 * fs.writeFileSync or any stream without further transformation.
 */
export function renderManifestJson(manifest: Manifest): string {
  const nodes: PortablePageNode[] = Array.from(manifest.nodes.values())
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(portableNode);

  const seenUrls: string[] = Array.from(manifest.seenUrls).sort();

  const payload: PortableManifest = {
    schemaVersion: PORTABLE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    id: manifest.id,
    version: manifest.version,
    status: manifest.status,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    seedUrl: manifest.seedUrl,
    config: {
      crawlAllPages: manifest.config.crawlAllPages,
      includeImages: manifest.config.includeImages,
      seedUrl: manifest.config.seedUrl,
      extractionMode: manifest.config.extractionMode,
    },
    nodes,
    seenUrls,
    stats: {
      totalNodes: manifest.stats.totalNodes,
      byStatus: { ...manifest.stats.byStatus },
      byType: { ...manifest.stats.byType },
      totalImages: manifest.stats.totalImages,
      totalVideos: manifest.stats.totalVideos,
      pathConsistencyCheck: manifest.stats.pathConsistencyCheck,
      renderSource: manifest.stats.renderSource,
    },
    output: manifest.output
      ? {
          zipPath: manifest.output.zipPath,
          downloadUrl: manifest.output.downloadUrl,
          renderedAt: manifest.output.renderedAt,
          nodeCount: manifest.output.nodeCount,
          renderSource: manifest.output.renderSource,
          pathConsistencyCheck: manifest.output.pathConsistencyCheck,
          jsonPath: manifest.output.jsonPath,
        }
      : undefined,
  };

  return JSON.stringify(payload, null, 2);
}

// ---------------------------------------------------------------------------
// Public API — fromPortableManifest (full reconstruction)
// ---------------------------------------------------------------------------

/**
 * Reconstructs a live Manifest from a PortableManifest (parsed JSON).
 *
 * Restores:
 *   - nodes Map<string, PageNode>  from the sorted nodes array
 *   - seenUrls Set<string>         from the sorted seenUrls array
 *   - all node sub-objects (metadata, content, media, storage, relationships)
 *   - manifest.output including jsonPath
 *
 * The reconstructed Manifest is fully usable with all manifest helpers
 * (getOrderedNodes, isManifestReady, transitionManifest, etc.).
 *
 * Note: schemaVersion and exportedAt are not part of the live Manifest
 * type — they are export-only envelope fields and are dropped here.
 */
export function fromPortableManifest(portable: PortableManifest): Manifest {
  const nodes = new Map<string, ReturnType<typeof liveNode>>();
  for (const pn of portable.nodes) {
    const node = liveNode(pn);
    nodes.set(node.id, node);
  }

  return {
    id: portable.id,
    version: portable.version,
    status: portable.status,
    createdAt: portable.createdAt,
    updatedAt: portable.updatedAt,
    seedUrl: portable.seedUrl,
    config: {
      crawlAllPages: portable.config.crawlAllPages,
      includeImages: portable.config.includeImages,
      seedUrl: portable.config.seedUrl,
      extractionMode: portable.config.extractionMode ?? "article",
    },
    nodes,
    seenUrls: new Set(portable.seenUrls),
    stats: {
      totalNodes: portable.stats.totalNodes,
      byStatus: { ...portable.stats.byStatus },
      byType: { ...portable.stats.byType },
      totalImages: portable.stats.totalImages,
      totalVideos: portable.stats.totalVideos,
      pathConsistencyCheck: portable.stats.pathConsistencyCheck,
      renderSource: portable.stats.renderSource,
    },
    output: portable.output
      ? {
          zipPath: portable.output.zipPath,
          downloadUrl: portable.output.downloadUrl,
          renderedAt: portable.output.renderedAt,
          nodeCount: portable.output.nodeCount,
          renderSource: portable.output.renderSource,
          pathConsistencyCheck: portable.output.pathConsistencyCheck,
          jsonPath: portable.output.jsonPath,
        }
      : undefined,
  };
}

function liveNode(pn: PortablePageNode): PageNode {
  return {
    id: pn.id,
    version: pn.version,
    nodeType: pn.nodeType,
    status: pn.status,
    metadata: {
      url: pn.metadata.url,
      title: pn.metadata.title,
      description: pn.metadata.description,
      publishedAt: pn.metadata.publishedAt,
      fetchedAt: pn.metadata.fetchedAt,
      siteType: pn.metadata.siteType,
    },
    content: {
      cleanHtml: pn.content.cleanHtml,
      textContent: pn.content.textContent,
      wordCount: pn.content.wordCount,
      bodySelector: pn.content.bodySelector,
    },
    media: {
      images: pn.media.images.map(liveMediaItem),
      videos: pn.media.videos.map(liveMediaItem),
    },
    storage: {
      localPath: pn.storage.localPath,
      cloudPath: pn.storage.cloudPath,
      publicPath: pn.storage.publicPath ?? "",
      filename: pn.storage.filename,
    },
    relationships: {
      parentId: pn.relationships.parentId,
      childIds: [...pn.relationships.childIds],
      paginationIndex: pn.relationships.paginationIndex,
      depth: pn.relationships.depth,
      discoverySource: pn.relationships.discoverySource ?? null,
    },
  };
}

function liveMediaItem(item: PortableMediaItem): MediaItem {
  return {
    id: item.id,
    sourceUrl: item.sourceUrl,
    normalizedUrl: item.normalizedUrl ?? null,
    altText: item.altText,
    mimeType: item.mimeType,
    byteSize: item.byteSize,
    dimensions: item.dimensions ?? null,
    status: item.status,
    failReason: item.failReason,
    storage: {
      localPath: item.storage.localPath,
      cloudPath: item.storage.cloudPath,
      publicPath: "",
      filename: item.storage.filename,
    },
    positionInPage: item.positionInPage,
    checksum: item.checksum ?? null,
    mediaClassification: "image",
    sourceElement: item.sourceElement ?? null,
    extractionMethod: item.extractionMethod ?? null,
    htmlWidth: item.htmlWidth ?? null,
    htmlHeight: item.htmlHeight ?? null,
    provider: item.provider ?? null,
    canonicalUrl: item.canonicalUrl ?? null,
    thumbnailUrl: item.thumbnailUrl ?? null,
    durationSeconds: item.durationSeconds ?? null,
  };
}
