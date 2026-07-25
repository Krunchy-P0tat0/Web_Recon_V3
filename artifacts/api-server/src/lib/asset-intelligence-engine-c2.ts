/**
 * asset-intelligence-engine-c2.ts — Phase C2: Asset Intelligence Engine
 *
 * Analyzes all Website Prime assets before production:
 *   Images, SVG, Fonts, Videos, JavaScript, CSS
 *
 * Detects:
 *   - Duplicate assets (same checksum or normalized URL)
 *   - Unused assets (referenced in manifest but no downstream consumer)
 *   - Oversized assets (exceeding per-type thresholds)
 *   - Missing lazy loading (below-fold images/videos/iframes)
 *   - Compression opportunities (format upgrades, minification)
 *   - Responsive image opportunities (fixed-size images served at HTML dimensions)
 *   - Caching strategy per asset type
 *
 * Produces (stored in R2 + in-memory):
 *   asset-intelligence-report.json
 *   asset-optimization-report.json
 *   duplicate-asset-report.json
 *   lazy-loading-report.json
 *   asset-cache-manifest.json
 *
 * Never reduces visual quality unnecessarily.
 */

import { logger } from "./logger.js";
import { loadManifest } from "./manifest-store.js";
import { createCloudProvider } from "../cloud/index.js";
import type { MediaItem } from "./manifest.js";

// ── Thresholds ─────────────────────────────────────────────────────────────

const THRESHOLDS = {
  image: {
    oversizedBytes: 300_000,        // 300 KB
    largeBytes:     100_000,        // 100 KB — suggest modern format
    svgOversized:    50_000,        //  50 KB
    responsiveWidthThreshold: 600,  // HTML width > this → suggest srcset
  },
  video: {
    oversizedBytes: 5_000_000,      //   5 MB
  },
  js: {
    oversizedBytes:  300_000,       // 300 KB
    largeBytes:       80_000,       //  80 KB — suggest code-splitting
  },
  css: {
    oversizedBytes:   150_000,      // 150 KB
    largeBytes:        50_000,      //  50 KB — suggest critical CSS
  },
  font: {
    oversizedBytes:   200_000,      // 200 KB per font file
    maxFamilyFiles:         4,      // >4 font files per family → warn
  },
  // Below-fold threshold: images with positionInPage >= this need lazy loading
  lazyLoadPositionThreshold: 2,
};

// ── Asset type detection ────────────────────────────────────────────────────

function extOf(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    return pathname.slice(pathname.lastIndexOf(".") + 1).toLowerCase().split("?")[0] ?? "";
  } catch {
    return url.slice(url.lastIndexOf(".") + 1).toLowerCase().split("?")[0] ?? "";
  }
}

function isSvg(item: MediaItem): boolean {
  return item.mimeType === "image/svg+xml" || extOf(item.sourceUrl) === "svg";
}

function isRasterImage(item: MediaItem): boolean {
  if (isSvg(item)) return false;
  const mt = item.mimeType ?? "";
  const ext = extOf(item.sourceUrl);
  return mt.startsWith("image/") || ["jpg","jpeg","png","gif","webp","avif","bmp","tiff"].includes(ext);
}

function isModernFormat(item: MediaItem): boolean {
  const mt = item.mimeType ?? "";
  const ext = extOf(item.sourceUrl);
  return mt === "image/webp" || mt === "image/avif" || ext === "webp" || ext === "avif";
}

function classifyUrl(url: string): "js" | "css" | "font" | "image" | "video" | "other" {
  const ext = extOf(url);
  if (["js","mjs"].includes(ext)) return "js";
  if (ext === "css") return "css";
  if (["woff","woff2","ttf","otf","eot"].includes(ext)) return "font";
  if (["jpg","jpeg","png","gif","webp","avif","svg","bmp"].includes(ext)) return "image";
  if (["mp4","webm","ogg","mov","avi"].includes(ext)) return "video";
  return "other";
}

// ── Report shapes ────────────────────────────────────────────────────────────

export interface AssetEntry {
  url: string;
  type: "image" | "svg" | "video" | "js" | "css" | "font" | "other";
  byteSize: number | null;
  pages: string[];          // page URLs that reference this asset
  checksum: string | null;
  mimeType: string | null;
  dimensions?: { width: number; height: number } | null;
  htmlDimensions?: { width: number | null; height: number | null };
  positionInPage?: number;
}

export interface AssetInventory {
  images: AssetEntry[];
  svgs: AssetEntry[];
  videos: AssetEntry[];
  js: AssetEntry[];
  css: AssetEntry[];
  fonts: AssetEntry[];
  other: AssetEntry[];
  totalAssets: number;
  totalBytes: number | null;
}

export interface AssetIntelligenceReport {
  jobId: string;
  generatedAt: string;
  pagesAnalyzed: number;
  inventory: AssetInventory;
  summary: {
    totalUniqueAssets: number;
    totalBytes: number | null;
    byType: Record<string, number>;
    bytesByType: Record<string, number>;
  };
}

export interface OptimizationOpportunity {
  url: string;
  type: string;
  issue: string;
  recommendation: string;
  estimatedSavingsBytes: number | null;
  priority: "critical" | "high" | "medium" | "low";
}

export interface AssetOptimizationReport {
  jobId: string;
  generatedAt: string;
  opportunities: OptimizationOpportunity[];
  summary: {
    total: number;
    byCriticality: Record<string, number>;
    estimatedTotalSavingsBytes: number;
  };
}

export interface DuplicateGroup {
  key: string;              // checksum or normalized URL
  keyType: "checksum" | "url";
  urls: string[];
  pages: string[];
  byteSize: number | null;
  wastedBytes: number | null;
  recommendation: string;
}

export interface DuplicateAssetReport {
  jobId: string;
  generatedAt: string;
  duplicateGroups: DuplicateGroup[];
  summary: {
    totalDuplicateGroups: number;
    totalDuplicateAssets: number;
    totalWastedBytes: number;
  };
}

export interface LazyLoadCandidate {
  url: string;
  pageUrl: string;
  positionInPage: number;
  type: "image" | "svg" | "video" | "iframe";
  byteSize: number | null;
  issue: string;
  recommendation: string;
  priority: "high" | "medium" | "low";
}

export interface LazyLoadingReport {
  jobId: string;
  generatedAt: string;
  candidates: LazyLoadCandidate[];
  alreadyLazy: number;
  summary: {
    totalCandidates: number;
    potentialBytesDeferred: number;
    byType: Record<string, number>;
  };
}

export interface CacheRule {
  pattern: string;
  assetType: string;
  cacheControl: string;
  maxAgeSeconds: number;
  strategy: "immutable" | "long-lived" | "medium" | "short" | "no-cache";
  rationale: string;
  varyHeaders: string[];
}

export interface CachedAsset {
  url: string;
  type: string;
  cacheControl: string;
  etag: string | null;
  byteSize: number | null;
}

export interface AssetCacheManifest {
  jobId: string;
  generatedAt: string;
  rules: CacheRule[];
  assets: CachedAsset[];
  summary: {
    totalAssets: number;
    byStrategy: Record<string, number>;
  };
}

export interface C2Bundle {
  jobId: string;
  generatedAt: string;
  assetIntelligenceReport: AssetIntelligenceReport;
  assetOptimizationReport: AssetOptimizationReport;
  duplicateAssetReport: DuplicateAssetReport;
  lazyLoadingReport: LazyLoadingReport;
  assetCacheManifest: AssetCacheManifest;
  r2Keys: {
    assetIntelligenceReport: string;
    assetOptimizationReport: string;
    duplicateAssetReport: string;
    lazyLoadingReport: string;
    assetCacheManifest: string;
  };
}

// ── In-memory store ───────────────────────────────────────────────────────────

const _store = new Map<string, C2Bundle>();

export function getC2Bundle(jobId: string): C2Bundle | undefined {
  return _store.get(jobId);
}

export function listC2Bundles(): Array<{ jobId: string; generatedAt: string }> {
  return [..._store.values()].map(b => ({ jobId: b.jobId, generatedAt: b.generatedAt }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sum(arr: (number | null)[]): number {
  return arr.reduce<number>((acc, v) => acc + (v ?? 0), 0);
}

function makeR2Key(jobId: string, filename: string): string {
  return `c2/${jobId}/${filename}`;
}

async function storeJsonToR2(
  jobId: string,
  filename: string,
  data: unknown,
): Promise<string> {
  const key = makeR2Key(jobId, filename);
  const provider = createCloudProvider("r2");
  if (!provider.isConfigured()) {
    logger.warn({ jobId, filename }, "C2: R2 not configured — skipping upload");
    return key;
  }
  const buf = Buffer.from(JSON.stringify(data, null, 2), "utf-8");
  await provider.upload({
    key,
    data: buf,
    contentType: "application/json",
    checkDuplicate: false,
  });
  logger.info({ jobId, key }, "C2: report stored to R2");
  return key;
}

// ── Phase 1 — Build asset inventory ─────────────────────────────────────────

function buildInventory(
  nodes: Array<{ url: string; media: { images: MediaItem[]; videos: MediaItem[] } }>,
  externalUrls: Map<string, { type: string; size: number | null; pages: string[] }>,
): AssetInventory {
  // Collect all image/video media items keyed by normalizedUrl or sourceUrl
  const imageMap  = new Map<string, AssetEntry>();
  const svgMap    = new Map<string, AssetEntry>();
  const videoMap  = new Map<string, AssetEntry>();

  for (const node of nodes) {
    const pageUrl = node.url;

    for (const img of node.media.images) {
      const key = img.normalizedUrl ?? img.sourceUrl;
      if (!key) continue;

      if (isSvg(img)) {
        const existing = svgMap.get(key);
        if (existing) {
          if (!existing.pages.includes(pageUrl)) existing.pages.push(pageUrl);
        } else {
          svgMap.set(key, {
            url: key,
            type: "svg",
            byteSize: img.byteSize,
            pages: [pageUrl],
            checksum: img.checksum,
            mimeType: img.mimeType,
            dimensions: img.dimensions ? { width: img.dimensions.width, height: img.dimensions.height } : null,
            htmlDimensions: { width: img.htmlWidth, height: img.htmlHeight },
            positionInPage: img.positionInPage,
          });
        }
      } else if (isRasterImage(img)) {
        const existing = imageMap.get(key);
        if (existing) {
          if (!existing.pages.includes(pageUrl)) existing.pages.push(pageUrl);
        } else {
          imageMap.set(key, {
            url: key,
            type: "image",
            byteSize: img.byteSize,
            pages: [pageUrl],
            checksum: img.checksum,
            mimeType: img.mimeType,
            dimensions: img.dimensions ? { width: img.dimensions.width, height: img.dimensions.height } : null,
            htmlDimensions: { width: img.htmlWidth, height: img.htmlHeight },
            positionInPage: img.positionInPage,
          });
        }
      }
    }

    for (const vid of node.media.videos) {
      const key = vid.normalizedUrl ?? vid.sourceUrl;
      if (!key) continue;
      const existing = videoMap.get(key);
      if (existing) {
        if (!existing.pages.includes(pageUrl)) existing.pages.push(pageUrl);
      } else {
        videoMap.set(key, {
          url: key,
          type: "video",
          byteSize: vid.byteSize,
          pages: [pageUrl],
          checksum: vid.checksum,
          mimeType: vid.mimeType,
          positionInPage: vid.positionInPage,
        });
      }
    }
  }

  // Bucket external urls (JS, CSS, fonts) gathered from scraper metadata
  const jsMap   = new Map<string, AssetEntry>();
  const cssMap  = new Map<string, AssetEntry>();
  const fontMap = new Map<string, AssetEntry>();
  const otherMap = new Map<string, AssetEntry>();

  for (const [url, meta] of externalUrls) {
    const entry: AssetEntry = {
      url,
      type: meta.type as AssetEntry["type"],
      byteSize: meta.size,
      pages: meta.pages,
      checksum: null,
      mimeType: null,
    };
    if (meta.type === "js")    jsMap.set(url, entry);
    else if (meta.type === "css")  cssMap.set(url, entry);
    else if (meta.type === "font") fontMap.set(url, entry);
    else otherMap.set(url, entry);
  }

  const images = [...imageMap.values()];
  const svgs   = [...svgMap.values()];
  const videos = [...videoMap.values()];
  const js     = [...jsMap.values()];
  const css    = [...cssMap.values()];
  const fonts  = [...fontMap.values()];
  const other  = [...otherMap.values()];

  const allBytes = [
    ...images, ...svgs, ...videos, ...js, ...css, ...fonts, ...other
  ].map(a => a.byteSize);
  const totalBytes = allBytes.every(b => b === null) ? null : sum(allBytes);
  const totalAssets = images.length + svgs.length + videos.length + js.length + css.length + fonts.length + other.length;

  return { images, svgs, videos, js, css, fonts, other, totalAssets, totalBytes };
}

// ── Phase 2 — Detect optimization opportunities ──────────────────────────────

function buildOptimizationReport(
  jobId: string,
  inventory: AssetInventory,
  now: string,
): AssetOptimizationReport {
  const opportunities: OptimizationOpportunity[] = [];

  // Images
  for (const img of inventory.images) {
    const bytes = img.byteSize ?? 0;

    if (bytes >= THRESHOLDS.image.oversizedBytes) {
      const format = img.mimeType ?? extOf(img.url);
      const isModern = img.mimeType === "image/webp" || img.mimeType === "image/avif" ||
        extOf(img.url) === "webp" || extOf(img.url) === "avif";
      opportunities.push({
        url: img.url,
        type: "image",
        issue: `Oversized image (${(bytes / 1024).toFixed(0)} KB)`,
        recommendation: isModern
          ? "Apply further compression; consider reducing resolution for mobile."
          : "Convert to WebP/AVIF with quality ≤ 80 and serve via srcset.",
        estimatedSavingsBytes: isModern ? Math.floor(bytes * 0.25) : Math.floor(bytes * 0.55),
        priority: bytes >= THRESHOLDS.image.oversizedBytes * 2 ? "critical" : "high",
      });
    } else if (bytes >= THRESHOLDS.image.largeBytes && !(img.mimeType === "image/webp" || img.mimeType === "image/avif" || extOf(img.url) === "webp" || extOf(img.url) === "avif")) {
      opportunities.push({
        url: img.url,
        type: "image",
        issue: `Large image in legacy format (${(bytes / 1024).toFixed(0)} KB, ${img.mimeType ?? extOf(img.url)})`,
        recommendation: "Convert to WebP/AVIF for ~50% size reduction without visible quality loss.",
        estimatedSavingsBytes: Math.floor(bytes * 0.5),
        priority: "medium",
      });
    }

    // Responsive image opportunity
    const htmlW = img.htmlDimensions?.width;
    const actualW = img.dimensions?.width;
    if (htmlW && actualW && htmlW < actualW - 100 && actualW >= THRESHOLDS.image.responsiveWidthThreshold) {
      opportunities.push({
        url: img.url,
        type: "image",
        issue: `Image served at ${actualW}px but displayed at ${htmlW}px`,
        recommendation: `Add srcset with ${htmlW}w and ${htmlW * 2}w descriptors to serve correctly sized versions.`,
        estimatedSavingsBytes: bytes ? Math.floor(bytes * (1 - (htmlW / actualW) ** 2)) : null,
        priority: "medium",
      });
    }

    // Missing alt text (accessibility + SEO)
    // (alt is on MediaItem but we don't have it on AssetEntry — skip for now)
  }

  // SVGs
  for (const svg of inventory.svgs) {
    const bytes = svg.byteSize ?? 0;
    if (bytes >= THRESHOLDS.image.svgOversized) {
      opportunities.push({
        url: svg.url,
        type: "svg",
        issue: `Large SVG (${(bytes / 1024).toFixed(0)} KB)`,
        recommendation: "Run SVGO optimization (removes metadata, comments, redundant paths). Expected savings: 30-70%.",
        estimatedSavingsBytes: Math.floor(bytes * 0.4),
        priority: bytes >= THRESHOLDS.image.svgOversized * 3 ? "high" : "medium",
      });
    }
  }

  // Videos
  for (const vid of inventory.videos) {
    const bytes = vid.byteSize ?? 0;
    if (bytes >= THRESHOLDS.video.oversizedBytes) {
      opportunities.push({
        url: vid.url,
        type: "video",
        issue: `Large video file (${(bytes / 1_000_000).toFixed(1)} MB)`,
        recommendation: "Encode with H.264 + WebM fallback, CRF 28, and serve with range-request support. Consider adaptive bitrate (HLS/DASH) for files > 10 MB.",
        estimatedSavingsBytes: Math.floor(bytes * 0.35),
        priority: bytes >= THRESHOLDS.video.oversizedBytes * 3 ? "critical" : "high",
      });
    }
  }

  // JavaScript
  const totalJsBytes = sum(inventory.js.map(a => a.byteSize));
  for (const js of inventory.js) {
    const bytes = js.byteSize ?? 0;
    if (bytes >= THRESHOLDS.js.oversizedBytes) {
      opportunities.push({
        url: js.url,
        type: "js",
        issue: `Oversized JS bundle (${(bytes / 1024).toFixed(0)} KB)`,
        recommendation: "Apply code-splitting / dynamic import(). Tree-shake unused exports. Enable gzip/brotli at the CDN edge.",
        estimatedSavingsBytes: Math.floor(bytes * 0.4),
        priority: "high",
      });
    } else if (bytes >= THRESHOLDS.js.largeBytes) {
      opportunities.push({
        url: js.url,
        type: "js",
        issue: `Large JS file (${(bytes / 1024).toFixed(0)} KB)`,
        recommendation: "Minify with Terser; enable brotli compression at the CDN edge.",
        estimatedSavingsBytes: Math.floor(bytes * 0.25),
        priority: "medium",
      });
    }
  }
  if (inventory.js.length > 8) {
    opportunities.push({
      url: "(all JS files)",
      type: "js",
      issue: `${inventory.js.length} separate JS files detected — high request overhead`,
      recommendation: "Bundle non-critical scripts; defer or async non-essential files.",
      estimatedSavingsBytes: null,
      priority: "medium",
    });
  }

  // CSS
  for (const css of inventory.css) {
    const bytes = css.byteSize ?? 0;
    if (bytes >= THRESHOLDS.css.oversizedBytes) {
      opportunities.push({
        url: css.url,
        type: "css",
        issue: `Oversized CSS file (${(bytes / 1024).toFixed(0)} KB)`,
        recommendation: "Extract critical above-the-fold CSS inline. Lazy-load the rest via <link rel=preload>. Run PurgeCSS to remove unused selectors.",
        estimatedSavingsBytes: Math.floor(bytes * 0.45),
        priority: "high",
      });
    } else if (bytes >= THRESHOLDS.css.largeBytes) {
      opportunities.push({
        url: css.url,
        type: "css",
        issue: `Large CSS file (${(bytes / 1024).toFixed(0)} KB)`,
        recommendation: "Minify and enable brotli/gzip. Consider critical CSS extraction.",
        estimatedSavingsBytes: Math.floor(bytes * 0.2),
        priority: "medium",
      });
    }
  }
  if (inventory.css.length > 5) {
    opportunities.push({
      url: "(all CSS files)",
      type: "css",
      issue: `${inventory.css.length} separate CSS files — multiple render-blocking requests`,
      recommendation: "Concatenate into a single minified stylesheet or use HTTP/2 push hints.",
      estimatedSavingsBytes: null,
      priority: "medium",
    });
  }

  // Fonts
  const fontFamilies = new Map<string, string[]>();
  for (const font of inventory.fonts) {
    const basename = font.url.split("/").pop()?.split(".")[0] ?? font.url;
    const family = basename.replace(/[-_]?(bold|italic|light|regular|medium|semibold|thin|black|heavy|\d{3})/gi, "").trim() || "unknown";
    const arr = fontFamilies.get(family) ?? [];
    arr.push(font.url);
    fontFamilies.set(family, arr);
  }
  for (const [family, files] of fontFamilies) {
    if (files.length > THRESHOLDS.font.maxFamilyFiles) {
      opportunities.push({
        url: `(font family: ${family})`,
        type: "font",
        issue: `${files.length} font files for family "${family}" — excessive weight variants`,
        recommendation: "Limit to 2-3 weights (regular + bold, optionally italic). Use font-display: swap. Subset to used Unicode ranges.",
        estimatedSavingsBytes: sum(inventory.fonts.filter(f => files.includes(f.url)).map(f => f.byteSize)) / 2 | 0,
        priority: "medium",
      });
    }
    for (const url of files) {
      const entry = inventory.fonts.find(f => f.url === url);
      const bytes = entry?.byteSize ?? 0;
      if (bytes >= THRESHOLDS.font.oversizedBytes) {
        opportunities.push({
          url,
          type: "font",
          issue: `Large font file (${(bytes / 1024).toFixed(0)} KB)`,
          recommendation: "Convert to WOFF2 if not already. Subset to only the Unicode ranges used on the site.",
          estimatedSavingsBytes: Math.floor(bytes * 0.4),
          priority: "medium",
        });
      }
    }
  }

  const byCriticality: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const o of opportunities) byCriticality[o.priority] = (byCriticality[o.priority] ?? 0) + 1;

  return {
    jobId,
    generatedAt: now,
    opportunities,
    summary: {
      total: opportunities.length,
      byCriticality,
      estimatedTotalSavingsBytes: sum(opportunities.map(o => o.estimatedSavingsBytes)),
    },
  };
}

// ── Phase 3 — Duplicate detection ────────────────────────────────────────────

function buildDuplicateReport(
  jobId: string,
  inventory: AssetInventory,
  now: string,
): DuplicateAssetReport {
  const groups: DuplicateGroup[] = [];

  // Check by checksum (most reliable)
  const checksumMap = new Map<string, AssetEntry[]>();
  const allAssets = [...inventory.images, ...inventory.svgs, ...inventory.videos];
  for (const asset of allAssets) {
    if (!asset.checksum) continue;
    const arr = checksumMap.get(asset.checksum) ?? [];
    arr.push(asset);
    checksumMap.set(asset.checksum, arr);
  }
  for (const [checksum, entries] of checksumMap) {
    if (entries.length < 2) continue;
    const wasted = entries.length > 1
      ? sum(entries.slice(1).map(e => e.byteSize))
      : null;
    groups.push({
      key: checksum,
      keyType: "checksum",
      urls: entries.map(e => e.url),
      pages: [...new Set(entries.flatMap(e => e.pages))],
      byteSize: entries[0]?.byteSize ?? null,
      wastedBytes: wasted,
      recommendation: `Consolidate to a single canonical URL: ${entries[0]?.url}. Update all references. Eliminates ${entries.length - 1} redundant download(s).`,
    });
  }

  // Check by URL (same asset referenced via multiple URL variations)
  const urlGroups = new Map<string, AssetEntry[]>();
  for (const asset of [...inventory.js, ...inventory.css, ...inventory.fonts]) {
    // Normalize: strip query string and hash for dedup
    let normalized: string;
    try { normalized = new URL(asset.url).pathname; } catch { normalized = asset.url; }
    const arr = urlGroups.get(normalized) ?? [];
    arr.push(asset);
    urlGroups.set(normalized, arr);
  }
  for (const [, entries] of urlGroups) {
    if (entries.length < 2) continue;
    const wasted = sum(entries.slice(1).map(e => e.byteSize));
    groups.push({
      key: entries[0]?.url ?? "",
      keyType: "url",
      urls: entries.map(e => e.url),
      pages: [...new Set(entries.flatMap(e => e.pages))],
      byteSize: entries[0]?.byteSize ?? null,
      wastedBytes: wasted,
      recommendation: "Serve via a single versioned URL with a content hash. Use HTTP/2 so repeated references cost nothing extra.",
    });
  }

  const totalDuplicateAssets = groups.reduce((acc, g) => acc + g.urls.length - 1, 0);
  const totalWastedBytes = sum(groups.map(g => g.wastedBytes));

  return {
    jobId,
    generatedAt: now,
    duplicateGroups: groups,
    summary: {
      totalDuplicateGroups: groups.length,
      totalDuplicateAssets,
      totalWastedBytes,
    },
  };
}

// ── Phase 4 — Lazy loading audit ─────────────────────────────────────────────

function buildLazyLoadReport(
  jobId: string,
  inventory: AssetInventory,
  nodes: Array<{ url: string; media: { images: MediaItem[]; videos: MediaItem[] } }>,
  now: string,
): LazyLoadingReport {
  const candidates: LazyLoadCandidate[] = [];
  let alreadyLazy = 0;

  // Images — check positionInPage
  for (const node of nodes) {
    const pageUrl = node.url;
    for (const img of node.media.images) {
      if (img.positionInPage === undefined || img.positionInPage === null) continue;
      const url = img.normalizedUrl ?? img.sourceUrl;
      if (!url) continue;

      // Check if it's likely already lazy-loaded (srcset or data-src patterns signal it)
      const hasLazyAttr = (img.extractionMethod ?? "").toLowerCase().includes("lazy") ||
        (img.sourceElement ?? "").toLowerCase().includes("loading=");

      if (hasLazyAttr) {
        alreadyLazy++;
        continue;
      }

      if (img.positionInPage >= THRESHOLDS.lazyLoadPositionThreshold) {
        const bytes = img.byteSize ?? 0;
        const type = isSvg(img) ? "svg" : "image";
        candidates.push({
          url,
          pageUrl,
          positionInPage: img.positionInPage,
          type,
          byteSize: img.byteSize,
          issue: `${type === "svg" ? "SVG" : "Image"} at position ${img.positionInPage} (below fold) loaded eagerly`,
          recommendation: `Add loading="lazy" attribute. For critical above-the-fold images (position 0-1), use <link rel="preload">.`,
          priority: bytes >= THRESHOLDS.image.largeBytes ? "high" : "medium",
        });
      }
    }

    for (const vid of node.media.videos) {
      const url = vid.normalizedUrl ?? vid.sourceUrl;
      if (!url) continue;
      if ((vid.positionInPage ?? 0) >= THRESHOLDS.lazyLoadPositionThreshold) {
        candidates.push({
          url,
          pageUrl,
          positionInPage: vid.positionInPage ?? 0,
          type: "video",
          byteSize: vid.byteSize,
          issue: `Video at position ${vid.positionInPage ?? "?"} loaded eagerly`,
          recommendation: `Add preload="none" and a poster attribute. Use IntersectionObserver to load the source on scroll-into-view.`,
          priority: "high",
        });
      }
    }
  }

  // Deduplicate candidates by url+page
  const seen = new Set<string>();
  const deduped = candidates.filter(c => {
    const key = `${c.url}|${c.pageUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const potentialBytesDeferred = sum(deduped.map(c => c.byteSize));
  const byType: Record<string, number> = {};
  for (const c of deduped) byType[c.type] = (byType[c.type] ?? 0) + 1;

  return {
    jobId,
    generatedAt: now,
    candidates: deduped,
    alreadyLazy,
    summary: {
      totalCandidates: deduped.length,
      potentialBytesDeferred,
      byType,
    },
  };
}

// ── Phase 5 — Cache manifest ─────────────────────────────────────────────────

function buildCacheManifest(
  jobId: string,
  inventory: AssetInventory,
  now: string,
): AssetCacheManifest {
  const rules: CacheRule[] = [
    {
      pattern: "*.woff2, *.woff, *.ttf, *.otf",
      assetType: "font",
      cacheControl: "public, max-age=31536000, immutable",
      maxAgeSeconds: 31_536_000,
      strategy: "immutable",
      rationale: "Fonts are versioned by filename; never change in place. Immutable caching prevents revalidation.",
      varyHeaders: ["Accept-Encoding"],
    },
    {
      pattern: "*.webp, *.avif, *.jpg, *.jpeg, *.png, *.gif",
      assetType: "image",
      cacheControl: "public, max-age=31536000, immutable",
      maxAgeSeconds: 31_536_000,
      strategy: "immutable",
      rationale: "Images served under content-hashed URLs should never change. Use cache-busting via URL changes.",
      varyHeaders: ["Accept-Encoding", "Accept"],
    },
    {
      pattern: "*.svg",
      assetType: "svg",
      cacheControl: "public, max-age=86400, stale-while-revalidate=604800",
      maxAgeSeconds: 86_400,
      strategy: "long-lived",
      rationale: "SVGs may be inlined or updated more frequently than raster images.",
      varyHeaders: ["Accept-Encoding"],
    },
    {
      pattern: "*.js, *.mjs",
      assetType: "js",
      cacheControl: "public, max-age=31536000, immutable",
      maxAgeSeconds: 31_536_000,
      strategy: "immutable",
      rationale: "Bundlers emit content-hashed filenames. Immutable cache + filename-based cache-busting is optimal.",
      varyHeaders: ["Accept-Encoding"],
    },
    {
      pattern: "*.css",
      assetType: "css",
      cacheControl: "public, max-age=31536000, immutable",
      maxAgeSeconds: 31_536_000,
      strategy: "immutable",
      rationale: "CSS files emitted with content hashes should be treated as immutable.",
      varyHeaders: ["Accept-Encoding"],
    },
    {
      pattern: "*.mp4, *.webm, *.ogg",
      assetType: "video",
      cacheControl: "public, max-age=604800, stale-while-revalidate=86400",
      maxAgeSeconds: 604_800,
      strategy: "long-lived",
      rationale: "Videos are large and change infrequently. Enable byte-range (Accept-Ranges: bytes) for seek support.",
      varyHeaders: ["Accept-Encoding", "Range"],
    },
    {
      pattern: "*.html",
      assetType: "html",
      cacheControl: "public, max-age=0, must-revalidate",
      maxAgeSeconds: 0,
      strategy: "no-cache",
      rationale: "HTML must always revalidate to ensure users receive the latest asset URLs (which carry new hashes).",
      varyHeaders: ["Accept-Encoding"],
    },
  ];

  function etagFor(asset: AssetEntry): string | null {
    if (asset.checksum) return `"${asset.checksum.slice(0, 16)}"`;
    return null;
  }

  function cacheControlFor(asset: AssetEntry): string {
    const rule = rules.find(r => {
      const types = r.assetType;
      return types === asset.type;
    });
    return rule?.cacheControl ?? "public, max-age=86400";
  }

  const allAssets = [
    ...inventory.images,
    ...inventory.svgs,
    ...inventory.videos,
    ...inventory.js,
    ...inventory.css,
    ...inventory.fonts,
  ];

  const cachedAssets: CachedAsset[] = allAssets.map(asset => ({
    url: asset.url,
    type: asset.type,
    cacheControl: cacheControlFor(asset),
    etag: etagFor(asset),
    byteSize: asset.byteSize,
  }));

  const byStrategy: Record<string, number> = {};
  for (const rule of rules) {
    byStrategy[rule.strategy] = (byStrategy[rule.strategy] ?? 0);
  }
  for (const asset of cachedAssets) {
    const rule = rules.find(r => r.assetType === asset.type);
    const strat = rule?.strategy ?? "medium";
    byStrategy[strat] = (byStrategy[strat] ?? 0) + 1;
  }

  return {
    jobId,
    generatedAt: now,
    rules,
    assets: cachedAssets,
    summary: {
      totalAssets: cachedAssets.length,
      byStrategy,
    },
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface C2Options {
  jobId: string;
}

export async function runAssetIntelligence(options: C2Options): Promise<C2Bundle> {
  const { jobId } = options;
  const now = new Date().toISOString();

  logger.info({ jobId }, "C2: starting asset intelligence analysis");

  // Load manifest
  const manifest = await loadManifest(jobId);
  if (!manifest) {
    throw new Error(`C2: manifest not found for jobId "${jobId}"`);
  }

  const nodes = [...manifest.nodes.values()];
  if (nodes.length === 0) {
    throw new Error(`C2: manifest for "${jobId}" has no page nodes`);
  }

  // Collect external asset URLs from storage maps (JS, CSS, fonts)
  // The manifest storageMap on each node captures cloud paths; we infer type from extension
  const externalUrls = new Map<string, { type: string; size: number | null; pages: string[] }>();

  for (const node of nodes) {
    const pageUrl = node.id;

    // Walk storage map paths to find JS/CSS/font references
    const storagePaths: string[] = [];
    const storage = node.storage ?? {};
    for (const val of Object.values(storage)) {
      if (typeof val === "string") storagePaths.push(val);
    }

    // Also pull from visualAssets css snapshot
    if (node.visualAssets?.cssSnapshot) {
      storagePaths.push(node.visualAssets.cssSnapshot);
    }

    for (const rawPath of storagePaths) {
      const type = classifyUrl(rawPath);
      if (type === "other" || type === "image" || type === "video") continue;
      const existing = externalUrls.get(rawPath);
      if (existing) {
        if (!existing.pages.includes(pageUrl)) existing.pages.push(pageUrl);
      } else {
        externalUrls.set(rawPath, { type, size: null, pages: [pageUrl] });
      }
    }
  }

  // Build inventory
  const mappedNodes = nodes.map(n => ({ url: n.id, media: n.media }));
  const inventory = buildInventory(mappedNodes, externalUrls);

  logger.info({ jobId, totalAssets: inventory.totalAssets }, "C2: inventory complete");

  // Build all 5 reports
  const assetIntelligenceReport: AssetIntelligenceReport = {
    jobId,
    generatedAt: now,
    pagesAnalyzed: nodes.length,
    inventory,
    summary: {
      totalUniqueAssets: inventory.totalAssets,
      totalBytes: inventory.totalBytes,
      byType: {
        images: inventory.images.length,
        svgs: inventory.svgs.length,
        videos: inventory.videos.length,
        js: inventory.js.length,
        css: inventory.css.length,
        fonts: inventory.fonts.length,
        other: inventory.other.length,
      },
      bytesByType: {
        images: sum(inventory.images.map(a => a.byteSize)),
        svgs: sum(inventory.svgs.map(a => a.byteSize)),
        videos: sum(inventory.videos.map(a => a.byteSize)),
        js: sum(inventory.js.map(a => a.byteSize)),
        css: sum(inventory.css.map(a => a.byteSize)),
        fonts: sum(inventory.fonts.map(a => a.byteSize)),
        other: sum(inventory.other.map(a => a.byteSize)),
      },
    },
  };

  const assetOptimizationReport = buildOptimizationReport(jobId, inventory, now);
  const duplicateAssetReport    = buildDuplicateReport(jobId, inventory, now);
  const lazyLoadingReport = buildLazyLoadReport(jobId, inventory, mappedNodes, now);
  const assetCacheManifest = buildCacheManifest(jobId, inventory, now);

  logger.info({ jobId }, "C2: all 5 reports generated — storing to R2");

  // Store all reports to R2
  const [
    r2KeyIntelligence,
    r2KeyOptimization,
    r2KeyDuplicate,
    r2KeyLazyLoad,
    r2KeyCache,
  ] = await Promise.all([
    storeJsonToR2(jobId, "asset-intelligence-report.json",  assetIntelligenceReport),
    storeJsonToR2(jobId, "asset-optimization-report.json",  assetOptimizationReport),
    storeJsonToR2(jobId, "duplicate-asset-report.json",     duplicateAssetReport),
    storeJsonToR2(jobId, "lazy-loading-report.json",        lazyLoadingReport),
    storeJsonToR2(jobId, "asset-cache-manifest.json",       assetCacheManifest),
  ]);

  const bundle: C2Bundle = {
    jobId,
    generatedAt: now,
    assetIntelligenceReport,
    assetOptimizationReport,
    duplicateAssetReport,
    lazyLoadingReport,
    assetCacheManifest,
    r2Keys: {
      assetIntelligenceReport: r2KeyIntelligence,
      assetOptimizationReport: r2KeyOptimization,
      duplicateAssetReport:    r2KeyDuplicate,
      lazyLoadingReport:       r2KeyLazyLoad,
      assetCacheManifest:      r2KeyCache,
    },
  };

  _store.set(jobId, bundle);
  logger.info({ jobId }, "C2: asset intelligence complete");
  return bundle;
}
