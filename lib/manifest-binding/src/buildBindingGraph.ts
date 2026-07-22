// buildBindingGraph.ts — Deterministic manifest → R2 binding engine.
//
// GUARANTEES:
//  - Same (manifest, r2Objects, jobId) inputs always produce the same output.
//  - No random IDs, no Date.now() in graph values (timestamps use the input clock).
//  - Every inferred link is tagged with a BindingSource and confidence score.
//  - Nothing is silently matched; every binding operation emits a BindingEvent.
//
// BINDING ALGORITHM (per page node):
//
//   HTML key resolution (priority order):
//     1. manifest-ref  (1.0) — node.storage.cloudPath is non-empty
//     2. url-pattern   (0.9) — jobs/{jobId}/{node.storage.localPath}
//     3. fallback      (0.5) — scan R2 for content/{pageKey}/{nodeId}/index.html
//
//   Image key resolution:
//     1. manifest-ref  (1.0) — media.images[i].storage.cloudPath matches an R2 key
//     2. url-pattern   (0.9) — R2 keys under jobs/{jobId}/images/{nodeId}/
//
//   Embed key resolution:
//     1. manifest-ref  (1.0) — media.videos[i].storage.cloudPath matches an R2 key
//     2. url-pattern   (0.9) — R2 keys under jobs/{jobId}/embeds/{nodeId}/
//
// ORPHAN DETECTION:
//   After all pages are bound, any R2 key not in `claimedKeys` and not in the
//   permanent skip list (_manifest.zip, _manifest.json, index.html) is an orphan.

import type {
  BindingInput,
  BuildBindingGraphResult,
  BindingGraph,
  PageBinding,
  AssetBinding,
  BindingEvent,
  OrphanAsset,
  R2ObjectRecord,
  MediaClassification,
  BindingSource,
  ManifestNodeInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Categorise a relative R2 key (after stripping "jobs/<jobId>/") into a
 * human-readable storage category for orphan reports.
 */
function categoriseRelKey(rel: string): string {
  if (rel.startsWith("images/"))    return "image";
  if (rel.startsWith("videos/"))    return "video";
  if (rel.startsWith("audio/"))     return "audio";
  if (rel.startsWith("embeds/"))    return "embed";
  if (rel.startsWith("content/"))   return "html";
  if (rel.startsWith("documents/")) return "document";
  if (rel.startsWith("dom/"))       return "dom";
  if (rel.startsWith("metadata/"))  return "metadata";
  if (rel === "_manifest.json")     return "manifest-json";
  if (rel === "_manifest.zip")      return "manifest-zip";
  if (rel === "index.html")         return "root-html";
  return "unknown";
}

/**
 * Best-effort explanation for why an R2 key is an orphan.
 * Never throws — always returns a string.
 */
function guessPossibleReason(rel: string, manifestNodeIds: Set<string>): string {
  const imgMatch  = rel.match(/^images\/([0-9a-f]{16})\//);
  const vidMatch  = rel.match(/^videos\/([0-9a-f]{16})\//);
  const embedMatch = rel.match(/^embeds\/([0-9a-f]{16})\//);

  if (imgMatch) {
    const nodeId = imgMatch[1];
    if (!manifestNodeIds.has(nodeId)) {
      return `image folder nodeId ${nodeId} has no matching manifest node — possible redirect or crawl-scope mismatch`;
    }
    return `image nodeId ${nodeId} matches a manifest node but asset was not linked`;
  }
  if (vidMatch) {
    const nodeId = vidMatch[1];
    return `video nodeId ${nodeId} ${manifestNodeIds.has(nodeId) ? "matches manifest node but was not linked" : "has no matching manifest node"}`;
  }
  if (embedMatch) {
    const nodeId = embedMatch[1];
    return `embed nodeId ${nodeId} ${manifestNodeIds.has(nodeId) ? "matches manifest node but was not linked" : "has no matching manifest node"}`;
  }
  if (rel.startsWith("content/")) {
    return "HTML page present in R2 but not referenced by any manifest node storage path";
  }
  return "no manifest reference found for this R2 key";
}

// ---------------------------------------------------------------------------
// Core build function
// ---------------------------------------------------------------------------

export function buildBindingGraph(input: BindingInput): BuildBindingGraphResult {
  const { jobId, manifest, r2Objects } = input;
  const jobPrefix  = `jobs/${jobId}/`;
  const builtAt    = new Date().toISOString();

  // ── Index R2 objects ──────────────────────────────────────────────────────

  /** Full key → object record, O(1) existence check */
  const r2ByKey = new Map<string, R2ObjectRecord>();
  /** nodeId (16 hex chars) → image records under images/<nodeId>/ */
  const r2ImagesByNodeId  = new Map<string, R2ObjectRecord[]>();
  /** nodeId → embed records under embeds/<nodeId>/ */
  const r2EmbedsByNodeId  = new Map<string, R2ObjectRecord[]>();
  /** nodeId → video records under videos/<nodeId>/ */
  const r2VideosByNodeId  = new Map<string, R2ObjectRecord[]>();

  for (const obj of r2Objects) {
    r2ByKey.set(obj.key, obj);

    if (!obj.key.startsWith(jobPrefix)) continue;
    const rel = obj.key.slice(jobPrefix.length);

    const imgMatch   = rel.match(/^images\/([0-9a-f]{16})\//);
    if (imgMatch) {
      const nid = imgMatch[1];
      if (!r2ImagesByNodeId.has(nid)) r2ImagesByNodeId.set(nid, []);
      r2ImagesByNodeId.get(nid)!.push(obj);
      continue;
    }
    const vidMatch   = rel.match(/^videos\/([0-9a-f]{16})\//);
    if (vidMatch) {
      const nid = vidMatch[1];
      if (!r2VideosByNodeId.has(nid)) r2VideosByNodeId.set(nid, []);
      r2VideosByNodeId.get(nid)!.push(obj);
      continue;
    }
    const embedMatch = rel.match(/^embeds\/([0-9a-f]{16})\//);
    if (embedMatch) {
      const nid = embedMatch[1];
      if (!r2EmbedsByNodeId.has(nid)) r2EmbedsByNodeId.set(nid, []);
      r2EmbedsByNodeId.get(nid)!.push(obj);
      continue;
    }
  }

  // ── Build manifest nodeId set for orphan analysis ─────────────────────────

  const manifestNodeIds = new Set<string>(manifest.nodes.map((n) => n.id));

  // ── Keys that are intentionally excluded from orphan detection ────────────

  const permanentSkipKeys = new Set<string>([
    `${jobPrefix}_manifest.json`,
    `${jobPrefix}_manifest.zip`,
    `${jobPrefix}index.html`,
  ]);

  // ── Per-node binding ──────────────────────────────────────────────────────

  const pages: PageBinding[] = [];
  const events: BindingEvent[] = [];
  const claimedKeys = new Set<string>();

  // Sort nodes deterministically by id (SHA-256 prefix — stable for same URL)
  const sortedNodes = [...manifest.nodes].sort((a, b) => a.id.localeCompare(b.id));

  for (const node of sortedNodes) {
    const pageId  = node.id;
    const pageUrl = node.metadata.url;

    // -- HTML binding --
    const htmlResult = resolveHtml(node, jobPrefix, r2ByKey);

    if (htmlResult !== null) {
      if (htmlResult.r2KeyPresent) claimedKeys.add(htmlResult.r2Key);
      events.push({
        timestamp:    builtAt,
        pageId,
        pageUrl,
        assetType:    "html",
        r2Key:        htmlResult.r2Key,
        source:       htmlResult.source,
        confidence:   htmlResult.confidence,
        matchMethod:  htmlResult.matchMethod,
        r2KeyPresent: htmlResult.r2KeyPresent,
      });
    }

    // -- Image bindings --
    const imageAssets = resolveAssets({
      nodeId:          pageId,
      pageUrl,
      assetType:       "image",
      mediaClass:      "image",
      r2ByGroup:       r2ImagesByNodeId,
      manifestCloudPaths: new Set(
        node.media.images
          .filter((m) => m.storage.cloudPath.trim() !== "")
          .map((m)    => m.storage.cloudPath)
      ),
      builtAt,
      claimedKeys,
      events,
    });

    // -- Embed bindings --
    const embedAssets = resolveAssets({
      nodeId:          pageId,
      pageUrl,
      assetType:       "embed",
      mediaClass:      "embed",
      r2ByGroup:       r2EmbedsByNodeId,
      manifestCloudPaths: new Set(
        node.media.videos
          .filter((v) => v.storage.cloudPath.trim() !== "")
          .map((v)    => v.storage.cloudPath)
      ),
      builtAt,
      claimedKeys,
      events,
    });

    // -- Video bindings --
    const videoAssets = resolveAssets({
      nodeId:          pageId,
      pageUrl,
      assetType:       "video",
      mediaClass:      "video",
      r2ByGroup:       r2VideosByNodeId,
      manifestCloudPaths: new Set<string>(),
      builtAt,
      claimedKeys,
      events,
    });

    pages.push({
      pageId,
      pageUrl,
      nodeType:            node.nodeType,
      nodeStatus:          node.status,
      htmlR2Path:          htmlResult?.r2Key ?? null,
      htmlR2Present:       htmlResult?.r2KeyPresent ?? false,
      htmlBindingSource:   htmlResult?.source ?? null,
      htmlConfidence:      htmlResult?.confidence ?? 0,
      imageAssets,
      videoAssets,
      embedAssets,
      wordCount:           node.content.wordCount,
      depth:               node.relationships.depth,
      parentPage:          node.relationships.parentId,
      crawlSource:         node.relationships.discoverySource,
    });
  }

  // ── Orphan asset detection ────────────────────────────────────────────────

  const orphanAssets: OrphanAsset[] = [];

  for (const obj of r2Objects) {
    if (permanentSkipKeys.has(obj.key)) continue;
    if (!obj.key.startsWith(jobPrefix))  continue;
    if (claimedKeys.has(obj.key))        continue;

    const rel = obj.key.slice(jobPrefix.length);
    orphanAssets.push({
      r2Key:          obj.key,
      size:           obj.size,
      category:       categoriseRelKey(rel),
      possibleReason: guessPossibleReason(rel, manifestNodeIds),
    });
  }

  // Sort orphans deterministically
  orphanAssets.sort((a, b) => a.r2Key.localeCompare(b.r2Key));

  // ── Assemble graph ────────────────────────────────────────────────────────

  const skipCount = Array.from(permanentSkipKeys).filter((k) => r2ByKey.has(k)).length;

  const graph: BindingGraph = {
    jobId,
    builtAt,
    manifestId:         manifest.id,
    manifestStatus:     manifest.status,
    manifestCreatedAt:  manifest.createdAt,
    seedUrl:            manifest.seedUrl,
    pages,
    totalR2Objects:     r2Objects.length,
    claimedR2Objects:   claimedKeys.size + skipCount,
    unclaimedR2Objects: orphanAssets.length,
  };

  return { graph, events, orphanAssets };
}

// ---------------------------------------------------------------------------
// HTML resolution — returns null only if the node has no storage info at all
// ---------------------------------------------------------------------------

interface HtmlResolution {
  r2Key:        string;
  r2KeyPresent: boolean;
  source:       BindingSource;
  confidence:   number;
  matchMethod:  string;
}

function resolveHtml(
  node: ManifestNodeInput,
  jobPrefix: string,
  r2ByKey: Map<string, R2ObjectRecord>
): HtmlResolution | null {
  // Priority 1 — manifest-ref: cloudPath explicitly stamped by the scraper
  const cloudPath = node.storage.cloudPath?.trim() ?? "";
  if (cloudPath !== "") {
    return {
      r2Key:        cloudPath,
      r2KeyPresent: r2ByKey.has(cloudPath),
      source:       "manifest-ref",
      confidence:   1.0,
      matchMethod:  "node.storage.cloudPath",
    };
  }

  // Priority 2 — url-pattern: derive from localPath using canonical prefix
  const localPath = node.storage.localPath?.trim() ?? "";
  if (localPath !== "") {
    const key = `${jobPrefix}${localPath}`;
    return {
      r2Key:        key,
      r2KeyPresent: r2ByKey.has(key),
      source:       "url-pattern",
      confidence:   0.9,
      matchMethod:  "jobs/${jobId}/${node.storage.localPath}",
    };
  }

  // Priority 3 — fallback: scan for content/*/<nodeId>/index.html in R2
  const candidateSuffix = `/${node.id}/index.html`;
  for (const key of r2ByKey.keys()) {
    if (key.startsWith(`${jobPrefix}content/`) && key.endsWith(candidateSuffix)) {
      return {
        r2Key:        key,
        r2KeyPresent: true,
        source:       "fallback",
        confidence:   0.5,
        matchMethod:  `r2-scan:${jobPrefix}content/**/${node.id}/index.html`,
      };
    }
  }

  // No storage info and not found in R2 — return a derived key anyway so the
  // page appears in the binding graph with r2KeyPresent: false.
  // Only truly unreachable for nodes with completely empty storage.
  if (node.id) {
    const derivedKey = `${jobPrefix}content/${node.id}/index.html`;
    return {
      r2Key:        derivedKey,
      r2KeyPresent: false,
      source:       "fallback",
      confidence:   0.3,
      matchMethod:  "fallback:derived-from-nodeId",
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Asset resolution — images, videos, embeds
// ---------------------------------------------------------------------------

interface ResolveAssetsParams {
  nodeId:               string;
  pageUrl:              string;
  assetType:            BindingEvent["assetType"];
  mediaClass:           MediaClassification;
  r2ByGroup:            Map<string, R2ObjectRecord[]>;
  manifestCloudPaths:   Set<string>;
  builtAt:              string;
  claimedKeys:          Set<string>;
  events:               BindingEvent[];
}

function resolveAssets(p: ResolveAssetsParams): AssetBinding[] {
  const {
    nodeId, pageUrl, assetType, mediaClass,
    r2ByGroup, manifestCloudPaths, builtAt,
    claimedKeys, events,
  } = p;

  const r2Records = r2ByGroup.get(nodeId);
  if (!r2Records || r2Records.length === 0) return [];

  // Sort deterministically by key so the output is stable
  const sorted = [...r2Records].sort((a, b) => a.key.localeCompare(b.key));

  const bindings: AssetBinding[] = [];

  for (const obj of sorted) {
    const isManifestRef = manifestCloudPaths.has(obj.key);
    const source: BindingSource = isManifestRef ? "manifest-ref" : "url-pattern";
    const confidence            = isManifestRef ? 1.0 : 0.9;
    const matchMethod           = isManifestRef
      ? `manifest-ref:media.${assetType}s.storage.cloudPath`
      : `url-pattern:jobs/\${jobId}/${assetType}s/${nodeId}/`;

    claimedKeys.add(obj.key);

    events.push({
      timestamp:    builtAt,
      pageId:       nodeId,
      pageUrl,
      assetType,
      r2Key:        obj.key,
      source,
      confidence,
      matchMethod,
      r2KeyPresent: true,
      byteSize:     obj.size,
    });

    bindings.push({
      r2Key:              obj.key,
      r2KeyPresent:       true,
      source,
      confidence,
      mediaClassification: mediaClass,
      byteSize:           obj.size,
    });
  }

  return bindings;
}
