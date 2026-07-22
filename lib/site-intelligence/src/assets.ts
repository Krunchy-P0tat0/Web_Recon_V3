/**
 * assets.ts — Asset Intelligence Engine
 *
 * Generates the AssetGraph by scanning all media items across all nodes.
 *
 * Detects:
 *   - Orphan assets: referenced in manifest but not connected to any node
 *   - Duplicate assets: same source URL referenced by multiple nodes
 *   - Missing assets: status=failed or no storage path
 *
 * Output: AssetGraph with full asset inventory and binding report.
 */

import type {
  PortablePageNode,
  PortableMediaItem,
  AssetEntry,
  AssetType,
  AssetGraph,
} from "./types";

// ---------------------------------------------------------------------------
// Classify asset type from MIME type or URL
// ---------------------------------------------------------------------------

function classifyAssetType(item: PortableMediaItem): AssetType {
  const mime = item.mimeType?.toLowerCase() ?? "";
  const url = item.sourceUrl.toLowerCase();

  if (mime.startsWith("image/") || /\.(jpe?g|png|gif|webp|svg|ico|avif|heic)(\?|$)/i.test(url)) {
    return "image";
  }
  if (mime.startsWith("video/") || /\.(mp4|webm|ogg|mov|avi|mkv)(\?|$)/i.test(url)) {
    return "video";
  }
  if (mime.startsWith("audio/") || /\.(mp3|wav|ogg|flac|aac)(\?|$)/i.test(url)) {
    return "image"; // audio classified as unknown for layout purposes
  }
  if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|tar|gz)(\?|$)/i.test(url)) {
    return "document";
  }
  // Embed signals (iframe providers)
  if (
    item.provider ||
    item.canonicalUrl ||
    /(youtube|vimeo|soundcloud|spotify|twitter|tiktok|instagram)\.com/i.test(url)
  ) {
    return "embed";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Normalize URL for duplicate detection
// ---------------------------------------------------------------------------

function normalizeAssetUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove common cache-busting query params
    const keep = new URLSearchParams();
    for (const [k, v] of parsed.searchParams.entries()) {
      if (!["v", "ver", "cb", "t", "_", "bust", "cachebust"].includes(k.toLowerCase())) {
        keep.set(k, v);
      }
    }
    parsed.search = keep.toString();
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return url.toLowerCase().trim();
  }
}

// ---------------------------------------------------------------------------
// Public: build AssetGraph
// ---------------------------------------------------------------------------

export function buildAssetGraph(nodes: PortablePageNode[]): AssetGraph {
  const contentNodes = nodes.filter((n) => n.nodeType !== "root");

  // sourceUrl (normalized) → existing asset entry (for duplicate detection)
  const seenByNorm = new Map<string, AssetEntry>();

  // assetId → asset entry
  const assetById = new Map<string, AssetEntry>();

  // Track which nodes reference which asset IDs
  const assetNodeRefs = new Map<string, Set<string>>(); // assetId → nodeIds

  // First pass: build all asset entries
  for (const node of contentNodes) {
    const allMedia: PortableMediaItem[] = [
      ...node.media.images,
      ...node.media.videos,
    ];

    for (const item of allMedia) {
      const normUrl = normalizeAssetUrl(item.sourceUrl);
      const existing = seenByNorm.get(normUrl);

      if (existing) {
        // Duplicate: link this node to the existing canonical asset
        existing.referenceCount++;
        if (!existing.referencedByNodeIds.includes(node.id)) {
          existing.referencedByNodeIds.push(node.id);
        }
        existing.isDuplicate = false; // canonical is not a duplicate itself

        // Track as a duplicate asset (separate entry for the duplicate occurrence)
        const dupId = `${item.id}-dup-${existing.id}`;
        if (!assetById.has(dupId)) {
          const dupEntry: AssetEntry = {
            id: dupId,
            sourceUrl: item.sourceUrl,
            normalizedUrl: normUrl,
            assetType: classifyAssetType(item),
            mimeType: item.mimeType,
            byteSize: item.byteSize,
            status: item.status,
            referencedByNodeIds: [node.id],
            referenceCount: 1,
            cloudPath: item.storage.cloudPath,
            localPath: item.storage.localPath,
            checksum: item.checksum,
            altText: item.altText,
            dimensions: item.dimensions,
            isOrphan: false,
            isDuplicate: true,
            duplicateOf: existing.id,
            isMissing: item.status === "failed" || !item.storage.localPath,
          };
          assetById.set(dupId, dupEntry);
        }
      } else {
        // New canonical asset
        const entry: AssetEntry = {
          id: item.id,
          sourceUrl: item.sourceUrl,
          normalizedUrl: normUrl,
          assetType: classifyAssetType(item),
          mimeType: item.mimeType,
          byteSize: item.byteSize,
          status: item.status,
          referencedByNodeIds: [node.id],
          referenceCount: 1,
          cloudPath: item.storage.cloudPath,
          localPath: item.storage.localPath,
          checksum: item.checksum,
          altText: item.altText,
          dimensions: item.dimensions,
          isOrphan: false,
          isDuplicate: false,
          duplicateOf: null,
          isMissing: item.status === "failed" || !item.storage.localPath,
        };
        seenByNorm.set(normUrl, entry);
        assetById.set(item.id, entry);

        const refs = assetNodeRefs.get(item.id) ?? new Set<string>();
        refs.add(node.id);
        assetNodeRefs.set(item.id, refs);
      }
    }
  }

  const assets = Array.from(assetById.values());

  // Identify orphan assets (zero node references — shouldn't happen normally, defensive)
  const orphanAssets: string[] = [];
  for (const asset of assets) {
    if (asset.referencedByNodeIds.length === 0 && !asset.isDuplicate) {
      asset.isOrphan = true;
      orphanAssets.push(asset.id);
    }
  }

  // Missing assets
  const missingAssets = assets
    .filter((a) => a.isMissing && !a.isDuplicate)
    .map((a) => a.id);

  // Duplicate groups
  const duplicateGroups: Array<{ canonicalId: string; duplicateIds: string[] }> = [];
  const groupMap = new Map<string, string[]>(); // canonicalId → duplicateIds
  for (const asset of assets) {
    if (asset.isDuplicate && asset.duplicateOf) {
      const existing = groupMap.get(asset.duplicateOf) ?? [];
      existing.push(asset.id);
      groupMap.set(asset.duplicateOf, existing);
    }
  }
  for (const [canonicalId, duplicateIds] of groupMap.entries()) {
    duplicateGroups.push({ canonicalId, duplicateIds });
  }

  // Asset index: id → id (for O(1) lookup)
  const assetIndex: Record<string, string> = {};
  for (const asset of assets) {
    assetIndex[asset.id] = asset.id;
  }

  // Total bytes (only canonicals to avoid double-counting)
  const totalBytes = assets
    .filter((a) => !a.isDuplicate)
    .reduce((sum, a) => sum + (a.byteSize ?? 0), 0);

  // Assets by type
  const assetsByType: Record<AssetType, number> = {
    image: 0, video: 0, embed: 0, document: 0, unknown: 0,
  };
  for (const asset of assets) {
    if (!asset.isDuplicate) {
      assetsByType[asset.assetType]++;
    }
  }

  // Binding report
  const totalNodeCount = contentNodes.length;
  const nodesWithAssets = new Set(
    assets.flatMap((a) => a.referencedByNodeIds)
  );
  const unreferencedNodes = contentNodes
    .filter((n) => !nodesWithAssets.has(n.id))
    .map((n) => n.id);

  const totalBindings = assets.length;
  const resolvedBindings = assets.filter((a) => !a.isMissing).length;

  return {
    assets,
    assetIndex,
    orphanAssets,
    duplicateGroups,
    missingAssets,
    totalAssets: assets.filter((a) => !a.isDuplicate).length,
    totalBytes,
    assetsByType,
    bindingReport: {
      totalBindings,
      resolvedBindings,
      unresolvedBindings: totalBindings - resolvedBindings,
      unreferencedNodes,
    },
  };
}
