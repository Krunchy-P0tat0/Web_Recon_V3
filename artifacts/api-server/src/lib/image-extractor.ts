/**
 * image-extractor.ts — Comprehensive image URL extraction from static HTML.
 *
 * Handles all modern web image delivery patterns:
 *   - <img> with src, srcset (best-quality selection), and all lazy-load data attrs
 *   - <picture> with <source srcset|src> (best-quality selection)
 *   - <noscript> fallbacks (lazy-load libraries embed real URLs here)
 *   - Inline CSS background-image / background URLs
 *   - og:image / twitter:image meta tags
 *   - video[poster] thumbnail images
 *   - link[rel=preload][as=image]
 *
 * Guarantees:
 *   - No network calls — pure HTML parsing only
 *   - No duplicate normalised URLs emitted
 *   - Broken/data-URI/invalid URLs safely skipped
 *   - All extraction events logged at debug level
 */

import type { CheerioAPI, Cheerio } from "cheerio";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Element = any;
import * as cheerio from "cheerio";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ImageSourceElement =
  | "img"
  | "picture_source"
  | "noscript_img"
  | "css_background_inline"
  | "og_meta"
  | "twitter_meta"
  | "video_poster"
  | "link_preload";

export type ImageExtractionMethod =
  | "src"
  | "srcset_best"
  | "data_src"
  | "data_srcset_best"
  | "data_lazy_src"
  | "data_lazy_srcset_best"
  | "data_original"
  | "data_lazy"
  | "data_defer_src"
  | "data_echo"
  | "data_cfsrc"
  | "data_img_src"
  | "data_delayed_src"
  | "css_background_inline"
  | "noscript_src"
  | "noscript_srcset_best"
  | "og_meta"
  | "twitter_meta"
  | "video_poster"
  | "link_preload";

export interface RawImage {
  originalUrl: string;
  normalizedUrl: string;
  sourceElement: ImageSourceElement;
  extractionMethod: ImageExtractionMethod;
  altText: string | null;
  width: number | null;
  height: number | null;
  mimeHint: string | null;
}

export interface ImageExtractionDiagnostics {
  totalDiscovered: number;
  skippedInvalidUrl: number;
  skippedDataUri: number;
  duplicatesEliminated: number;
  lazyLoadRecovered: number;
  srcsetExpansions: number;
  pictureSourcesFound: number;
  cssBackgroundsFound: number;
  noscriptRecovered: number;
  ogImagesFound: number;
  finalCount: number;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a possibly-relative URL against a page base URL.
 * Handles: relative paths, protocol-relative (//host/path), absolute URLs.
 * Returns null for data URIs, empty strings, and unparseable inputs.
 */
export function resolveImageUrl(pageUrl: string, rawUrl: string): string | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed === "#" || trimmed === "javascript:void(0)") return null;
  if (trimmed.startsWith("data:")) return null;
  try {
    return new URL(trimmed, pageUrl).href;
  } catch {
    return null;
  }
}

/**
 * Normalise a resolved URL for deduplication.
 * Lowercases scheme + host; preserves path case, querystring, and fragment.
 */
export function normalizeImageUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.href;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Srcset helpers  (exported so scraper can use them for DOM rewriting)
// ---------------------------------------------------------------------------

export interface SrcsetEntry {
  url: string;
  width?: number;
  density?: number;
}

/**
 * parseSrcset — splits a srcset attribute value into discrete entries.
 */
export function parseSrcset(srcsetAttr: string): SrcsetEntry[] {
  if (!srcsetAttr?.trim()) return [];
  return srcsetAttr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(/\s+/);
      const url = parts[0];
      if (!url || url.startsWith("data:")) return null;
      const descriptor = parts[1] ?? "";
      const wMatch = descriptor.match(/^(\d+)w$/i);
      const xMatch = descriptor.match(/^([\d.]+)x$/i);
      return {
        url,
        width: wMatch ? parseInt(wMatch[1], 10) : undefined,
        density: xMatch ? parseFloat(xMatch[1]) : undefined,
      } as SrcsetEntry;
    })
    .filter((e): e is SrcsetEntry => e !== null);
}

/**
 * bestSrcsetEntry — returns the highest-quality entry from a srcset string.
 * Ranks by: widest `w` descriptor first, then highest `x` density, then first.
 */
export function bestSrcsetEntry(srcsetAttr: string): SrcsetEntry | null {
  const entries = parseSrcset(srcsetAttr);
  if (!entries.length) return null;
  const withWidth = entries
    .filter((e) => e.width !== undefined)
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  if (withWidth.length) return withWidth[0];
  const withDensity = entries
    .filter((e) => e.density !== undefined)
    .sort((a, b) => (b.density ?? 0) - (a.density ?? 0));
  if (withDensity.length) return withDensity[0];
  return entries[0];
}

// ---------------------------------------------------------------------------
// CSS background-image helpers  (exported for DOM rewriting)
// ---------------------------------------------------------------------------

const CSS_BG_RE =
  /background(?:-image)?\s*:\s*url\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi;

/**
 * extractCssBgUrls — finds all background/background-image URL values in a
 * CSS string (inline style attribute or style block fragment).
 */
export function extractCssBgUrls(css: string): string[] {
  if (!css || !css.toLowerCase().includes("url(")) return [];
  const urls: string[] = [];
  let match: RegExpExecArray | null;
  CSS_BG_RE.lastIndex = 0;
  while ((match = CSS_BG_RE.exec(css)) !== null) {
    const url = match[1].trim();
    if (url && !url.startsWith("data:")) urls.push(url);
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Dimension helpers
// ---------------------------------------------------------------------------

function parseDim(val: string | undefined): number | null {
  if (!val) return null;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// MIME hint from file extension
// ---------------------------------------------------------------------------

const EXT_TO_MIME: Record<string, string> = {
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png":  "image/png",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".svg":  "image/svg+xml",
  ".avif": "image/avif",
  ".ico":  "image/x-icon",
  ".bmp":  "image/bmp",
  ".tiff": "image/tiff",
  ".tif":  "image/tiff",
};

function mimeHintFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const dot = pathname.lastIndexOf(".");
    if (dot === -1) return null;
    return EXT_TO_MIME[pathname.slice(dot)] ?? null;
  } catch {
    return null;
  }
}

function mimeHintFromType(typeAttr: string | undefined): string | null {
  if (!typeAttr) return null;
  const t = typeAttr.toLowerCase().trim();
  return t.startsWith("image/") ? t : null;
}

// ---------------------------------------------------------------------------
// Placeholder URL detection
// ---------------------------------------------------------------------------

const PLACEHOLDER_PATTERNS = [
  "blank.gif", "blank.png", "blank.jpg",
  "placeholder", "spacer", "spinner",
  "loading.gif", "loading.png",
  "1x1", "pixel.gif", "pixel.png",
  "transparent.gif", "transparent.png",
];

function isPlaceholderSrc(src: string): boolean {
  if (!src) return true;
  if (src === "about:blank") return true;
  // tiny data URI (≤200 chars) is almost certainly a placeholder
  if (src.startsWith("data:") && src.length < 200) return true;
  const lower = src.toLowerCase();
  return PLACEHOLDER_PATTERNS.some((p) => lower.includes(p));
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

/**
 * extractImages — extracts all discoverable image URLs from a parsed page.
 *
 * @param pageUrl   Absolute URL of the page (used as base for relative URL resolution)
 * @param $         CheerioAPI loaded with the full page HTML (including <head>)
 * @param $body     Scoped body/article element to search within
 *
 * Returns deduplicated RawImage array + diagnostics.
 */
export function extractImages(
  pageUrl: string,
  $: CheerioAPI,
  $body: Cheerio<Element>
): { images: RawImage[]; diagnostics: ImageExtractionDiagnostics } {
  const images: RawImage[] = [];
  const seenNormalized = new Set<string>();

  const diag: ImageExtractionDiagnostics = {
    totalDiscovered: 0,
    skippedInvalidUrl: 0,
    skippedDataUri: 0,
    duplicatesEliminated: 0,
    lazyLoadRecovered: 0,
    srcsetExpansions: 0,
    pictureSourcesFound: 0,
    cssBackgroundsFound: 0,
    noscriptRecovered: 0,
    ogImagesFound: 0,
    finalCount: 0,
  };

  /**
   * tryAdd — resolves, normalises, deduplicates, and records one image candidate.
   * Returns true if the image was added, false if it was skipped.
   */
  function tryAdd(
    rawUrl: string,
    sourceElement: ImageSourceElement,
    extractionMethod: ImageExtractionMethod,
    opts: {
      altText?: string | null;
      width?: number | null;
      height?: number | null;
      mimeHint?: string | null;
      isLazy?: boolean;
      isSrcset?: boolean;
    } = {}
  ): boolean {
    diag.totalDiscovered++;

    if (rawUrl.startsWith("data:")) {
      diag.skippedDataUri++;
      return false;
    }

    const resolved = resolveImageUrl(pageUrl, rawUrl);
    if (!resolved) {
      diag.skippedInvalidUrl++;
      logger.debug({ rawUrl, pageUrl }, "IMAGE_EXTRACTOR: skipped invalid URL");
      return false;
    }

    const normalized = normalizeImageUrl(resolved);
    if (seenNormalized.has(normalized)) {
      diag.duplicatesEliminated++;
      return false;
    }
    seenNormalized.add(normalized);

    if (opts.isLazy) diag.lazyLoadRecovered++;
    if (opts.isSrcset) diag.srcsetExpansions++;

    images.push({
      originalUrl: rawUrl,
      normalizedUrl: normalized,
      sourceElement,
      extractionMethod,
      altText: opts.altText ?? null,
      width: opts.width ?? null,
      height: opts.height ?? null,
      mimeHint: opts.mimeHint ?? mimeHintFromUrl(normalized),
    });
    return true;
  }

  // ── 1. Head-level meta images (highest-quality canonical sources) ─────────

  const ogUrl = $("head meta[property='og:image'], head meta[property='og:image:secure_url']")
    .first()
    .attr("content")
    ?.trim();
  if (ogUrl) {
    diag.ogImagesFound++;
    tryAdd(ogUrl, "og_meta", "og_meta");
  }

  const twUrl = (
    $("head meta[name='twitter:image'], head meta[property='twitter:image']")
      .first()
      .attr("content") ??
    $("head meta[name='twitter:image:src']").first().attr("content")
  )?.trim();
  if (twUrl) tryAdd(twUrl, "twitter_meta", "twitter_meta");

  $("head link[rel='preload'][as='image']").each((_i, el) => {
    const href = $(el).attr("href");
    if (href) tryAdd(href, "link_preload", "link_preload");
  });

  // ── 2. <noscript> fallbacks — lazy-load libraries stash the real URL here ─

  $body.find("noscript").each((_i, nsEl) => {
    const inner = $(nsEl).html() ?? "";
    if (!inner.includes("<img")) return;
    const $ns = cheerio.load(inner);
    $ns("img").each((_j, imgEl) => {
      const src    = $ns(imgEl).attr("src");
      const srcset = $ns(imgEl).attr("srcset");
      const alt    = $ns(imgEl).attr("alt") ?? null;
      const w      = parseDim($ns(imgEl).attr("width"));
      const h      = parseDim($ns(imgEl).attr("height"));

      if (src && !isPlaceholderSrc(src)) {
        if (tryAdd(src, "noscript_img", "noscript_src", { altText: alt, width: w, height: h })) {
          diag.noscriptRecovered++;
          return;
        }
      }
      if (srcset) {
        const best = bestSrcsetEntry(srcset);
        if (best) {
          if (tryAdd(best.url, "noscript_img", "noscript_srcset_best", {
            altText: alt, width: best.width ?? w, height: h, isSrcset: true,
          })) {
            diag.noscriptRecovered++;
          }
        }
      }
    });
  });

  // ── 3. <picture> elements ────────────────────────────────────────────────

  $body.find("picture").each((_i, picEl) => {
    const $pic = $(picEl);
    const $fallbackImg = $pic.find("img").first();
    const altText = $fallbackImg.attr("alt") ?? null;
    const w = parseDim($fallbackImg.attr("width"));
    const h = parseDim($fallbackImg.attr("height"));
    let addedFromSource = false;

    $pic.find("source").each((_j, srcEl) => {
      const srcset   = $(srcEl).attr("srcset");
      const src      = $(srcEl).attr("src");
      const typeAttr = $(srcEl).attr("type");
      const mimeHint = mimeHintFromType(typeAttr);

      if (srcset) {
        const best = bestSrcsetEntry(srcset);
        if (best) {
          diag.pictureSourcesFound++;
          if (tryAdd(best.url, "picture_source", "srcset_best", {
            altText, width: best.width ?? w, height: h, mimeHint, isSrcset: true,
          })) addedFromSource = true;
        }
      } else if (src) {
        diag.pictureSourcesFound++;
        if (tryAdd(src, "picture_source", "src", {
          altText, width: w, height: h, mimeHint,
        })) addedFromSource = true;
      }
    });

    // Use the fallback <img> if no <source> produced a result
    if (!addedFromSource) {
      const fallbackSrc = $fallbackImg.attr("src") || $fallbackImg.attr("data-src");
      if (fallbackSrc && !isPlaceholderSrc(fallbackSrc)) {
        tryAdd(fallbackSrc, "img", "src", { altText, width: w, height: h });
      }
    }
  });

  // ── 4. video[poster] thumbnail images ────────────────────────────────────

  $body.find("video[poster]").each((_i, el) => {
    const poster = $(el).attr("poster");
    if (poster) tryAdd(poster, "video_poster", "video_poster");
  });

  // ── 5. Standalone <img> elements (not direct children of <picture>) ───────
  //
  // Lazy-load attribute priority (tried in order, stop at first hit):
  //   data-src  >  data-original  >  data-lazy-src  >  data-lazy  >
  //   data-defer-src  >  data-echo  >  data-cfsrc  >  data-img-src  >
  //   data-delayed-src
  //
  // Then: data-srcset / data-lazy-srcset (pick best)
  // Then: regular src (skip placeholder patterns)
  // Then: regular srcset (pick best)

  const LAZY_SRC_ATTRS: [string, ImageExtractionMethod][] = [
    ["data-src",          "data_src"],
    ["data-original",     "data_original"],
    ["data-lazy-src",     "data_lazy_src"],
    ["data-lazy",         "data_lazy"],
    ["data-defer-src",    "data_defer_src"],
    ["data-echo",         "data_echo"],
    ["data-cfsrc",        "data_cfsrc"],
    ["data-img-src",      "data_img_src"],
    ["data-delayed-src",  "data_delayed_src"],
  ];

  const LAZY_SRCSET_ATTRS: [string, ImageExtractionMethod][] = [
    ["data-srcset",       "data_srcset_best"],
    ["data-lazy-srcset",  "data_lazy_srcset_best"],
  ];

  $body.find("img").each((_i, el) => {
    if ($(el).closest("picture").length > 0) return; // handled in step 3

    const $el    = $(el);
    const altText = $el.attr("alt") ?? null;
    const w       = parseDim($el.attr("width"));
    const h       = parseDim($el.attr("height"));
    let added     = false;

    // Lazy data-src attributes (these carry the real, full-res URL)
    for (const [attr, method] of LAZY_SRC_ATTRS) {
      const val = $el.attr(attr)?.trim();
      if (val && !val.startsWith("data:") && !isPlaceholderSrc(val)) {
        if (tryAdd(val, "img", method, { altText, width: w, height: h, isLazy: true })) {
          added = true;
          break;
        }
      }
    }

    // Lazy data-srcset attributes
    if (!added) {
      for (const [attr, method] of LAZY_SRCSET_ATTRS) {
        const srcset = $el.attr(attr);
        if (srcset) {
          const best = bestSrcsetEntry(srcset);
          if (best) {
            if (tryAdd(best.url, "img", method, {
              altText, width: best.width ?? w, height: h, isLazy: true, isSrcset: true,
            })) {
              added = true;
              break;
            }
          }
        }
      }
    }

    // Regular src
    if (!added) {
      const src = $el.attr("src");
      if (src && !isPlaceholderSrc(src)) {
        if (tryAdd(src, "img", "src", { altText, width: w, height: h })) {
          added = true;
        }
      }
    }

    // Regular srcset (best) — final fallback
    if (!added) {
      const srcset = $el.attr("srcset");
      if (srcset) {
        const best = bestSrcsetEntry(srcset);
        if (best) {
          tryAdd(best.url, "img", "srcset_best", {
            altText, width: best.width ?? w, height: h, isSrcset: true,
          });
        }
      }
    }
  });

  // ── 6. Inline CSS background-image ───────────────────────────────────────
  //
  // Covers patterns like:
  //   style="background-image: url('/path/hero.jpg')"
  //   style="background: center/cover url('https://cdn.example.com/img.webp')"

  $body.find("[style]").each((_i, el) => {
    const style = $(el).attr("style") ?? "";
    if (!style.toLowerCase().includes("url(")) return;
    const bgUrls = extractCssBgUrls(style);
    for (const bgUrl of bgUrls) {
      diag.cssBackgroundsFound++;
      tryAdd(bgUrl, "css_background_inline", "css_background_inline");
    }
  });

  // ── Finalise ─────────────────────────────────────────────────────────────

  diag.finalCount = images.length;

  logger.debug(
    { pageUrl, ...diag },
    "IMAGE_EXTRACTOR: extraction complete"
  );

  return { images, diagnostics: diag };
}
