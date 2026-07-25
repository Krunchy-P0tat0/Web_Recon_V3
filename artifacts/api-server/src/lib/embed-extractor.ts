/**
 * embed-extractor.ts — Generalized video, audio, and embed extraction.
 *
 * Detects and classifies all media embeds from static HTML:
 *   - Native HTML5 <video> and <audio> elements with <source> fallbacks
 *   - YouTube, Vimeo, TikTok, Dailymotion, Wistia, Loom iframes
 *   - Audio embeds: SoundCloud, Spotify, podcast players, bare mp3 links
 *   - Generic/unknown iframes (logged, non-fatal)
 *
 * Guarantees:
 *   - No network calls — pure HTML parsing + URL pattern matching only
 *   - Non-fatal: all extraction paths are try/caught; failures are logged
 *   - Embeds are catalogued regardless of whether download is enabled
 *   - Unsupported providers are logged for diagnostics
 *   - Deduplication by normalised embedUrl
 *
 * Storage routing produced:
 *   /videos/   — native video files + downloadable video assets
 *   /audio/    — native audio files + downloadable audio assets
 *   /embeds/   — iframe-based embeds (YouTube, Vimeo, TikTok, etc.)
 *
 * IMPORTANT: This module never downloads YouTube, Vimeo, or any hosted
 * video. It is a discovery + manifest integration layer only.
 */

import type { CheerioAPI, Cheerio } from "cheerio";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Element = any;
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EmbedProvider =
  | "youtube"
  | "vimeo"
  | "tiktok"
  | "dailymotion"
  | "wistia"
  | "loom"
  | "soundcloud"
  | "spotify"
  | "native_video"
  | "native_audio"
  | "unknown_iframe"
  | "unknown_audio";

export type EmbedMediaType = "video" | "audio" | "embed";

export interface RawEmbed {
  /** The src URL found in the HTML (iframe src, video src, audio src, etc.) */
  embedUrl: string;
  /** Normalised public URL for the content (e.g. youtube.com/watch?v=xxx) */
  canonicalUrl: string | null;
  provider: EmbedProvider;
  mediaType: EmbedMediaType;
  /** Thumbnail image URL if deterministically derivable from embed URL */
  thumbnailUrl: string | null;
  /** Duration in seconds if extractable from URL parameters */
  durationSeconds: number | null;
  /** Text from title attr, aria-label, or adjacent heading */
  title: string | null;
  width: number | null;
  height: number | null;
  sourceElement: "iframe" | "video" | "audio" | "source" | "a";
}

export interface EmbedExtractionDiagnostics {
  totalFound: number;
  byProvider: Record<string, number>;
  unsupportedEmbeds: number;
  thumbnailsExtracted: number;
  missingCanonicalUrl: number;
  missingThumbnail: number;
  nativeVideoCount: number;
  nativeAudioCount: number;
  iframeEmbedCount: number;
  audioEmbedCount: number;
  duplicatesEliminated: number;
  extractionErrors: number;
}

// ---------------------------------------------------------------------------
// Provider detection patterns
// ---------------------------------------------------------------------------

interface ProviderRule {
  provider: EmbedProvider;
  mediaType: EmbedMediaType;
  test: (url: URL) => boolean;
  canonicalUrl: (url: URL) => string | null;
  thumbnailUrl: (url: URL) => string | null;
  durationSeconds?: (url: URL) => number | null;
}

const PROVIDER_RULES: ProviderRule[] = [
  // ── YouTube ──────────────────────────────────────────────────────────────
  {
    provider: "youtube",
    mediaType: "embed",
    test: (u) =>
      u.hostname.includes("youtube.com") ||
      u.hostname.includes("youtube-nocookie.com") ||
      u.hostname === "youtu.be",
    canonicalUrl: (u) => {
      // /embed/{videoId}
      const embedMatch = u.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
      if (embedMatch) return `https://www.youtube.com/watch?v=${embedMatch[1]}`;
      // youtu.be/{videoId}
      if (u.hostname === "youtu.be") {
        const id = u.pathname.replace(/^\//, "").split("/")[0];
        if (id && id.length === 11) return `https://www.youtube.com/watch?v=${id}`;
      }
      // ?v=... on watch page (unlikely in iframe src but handle it)
      const v = u.searchParams.get("v");
      if (v) return `https://www.youtube.com/watch?v=${v}`;
      return null;
    },
    thumbnailUrl: (u) => {
      const embedMatch = u.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
      if (embedMatch) return `https://img.youtube.com/vi/${embedMatch[1]}/maxresdefault.jpg`;
      if (u.hostname === "youtu.be") {
        const id = u.pathname.replace(/^\//, "").split("/")[0];
        if (id && id.length === 11)
          return `https://img.youtube.com/vi/${id}/maxresdefault.jpg`;
      }
      const v = u.searchParams.get("v");
      if (v) return `https://img.youtube.com/vi/${v}/maxresdefault.jpg`;
      return null;
    },
    durationSeconds: (u) => {
      // YouTube embed URLs can have start= param but not duration — not detectable
      return null;
    },
  },

  // ── Vimeo ─────────────────────────────────────────────────────────────────
  {
    provider: "vimeo",
    mediaType: "embed",
    test: (u) =>
      u.hostname === "player.vimeo.com" || u.hostname.includes("vimeo.com"),
    canonicalUrl: (u) => {
      const match = u.pathname.match(/\/video\/(\d+)/);
      if (match) return `https://vimeo.com/${match[1]}`;
      const idMatch = u.pathname.match(/^\/(\d+)/);
      if (idMatch) return `https://vimeo.com/${idMatch[1]}`;
      return null;
    },
    thumbnailUrl: () => null, // Requires Vimeo oEmbed API — no static URL pattern
    durationSeconds: () => null,
  },

  // ── TikTok ───────────────────────────────────────────────────────────────
  {
    provider: "tiktok",
    mediaType: "embed",
    test: (u) => u.hostname.includes("tiktok.com"),
    canonicalUrl: (u) => {
      // /embed/v2/{videoId} or /embed/{videoId}
      const match = u.pathname.match(/\/embed(?:\/v2)?\/(\d+)/);
      if (match) return `https://www.tiktok.com/video/${match[1]}`;
      return null;
    },
    thumbnailUrl: () => null,
    durationSeconds: () => null,
  },

  // ── Dailymotion ───────────────────────────────────────────────────────────
  {
    provider: "dailymotion",
    mediaType: "embed",
    test: (u) => u.hostname.includes("dailymotion.com"),
    canonicalUrl: (u) => {
      const match = u.pathname.match(/\/embed\/video\/([a-zA-Z0-9]+)/);
      if (match) return `https://www.dailymotion.com/video/${match[1]}`;
      return null;
    },
    thumbnailUrl: (u) => {
      const match = u.pathname.match(/\/embed\/video\/([a-zA-Z0-9]+)/);
      if (match) return `https://www.dailymotion.com/thumbnail/video/${match[1]}`;
      return null;
    },
    durationSeconds: () => null,
  },

  // ── Wistia ────────────────────────────────────────────────────────────────
  {
    provider: "wistia",
    mediaType: "embed",
    test: (u) =>
      u.hostname.includes("wistia.com") || u.hostname.includes("wistia.net"),
    canonicalUrl: (u) => {
      const match = u.pathname.match(/\/embed\/iframe\/([a-zA-Z0-9]+)/);
      if (match) return `https://fast.wistia.com/embed/iframe/${match[1]}`;
      return u.href;
    },
    thumbnailUrl: (u) => {
      // Wistia has a thumbnail URL pattern for some plans
      const match = u.pathname.match(/\/embed\/iframe\/([a-zA-Z0-9]+)/);
      if (match) return `https://embed-ssl.wistia.com/deliveries/${match[1]}/image.jpg`;
      return null;
    },
    durationSeconds: () => null,
  },

  // ── Loom ─────────────────────────────────────────────────────────────────
  {
    provider: "loom",
    mediaType: "embed",
    test: (u) => u.hostname.includes("loom.com"),
    canonicalUrl: (u) => {
      const match = u.pathname.match(/\/embed\/([a-f0-9]+)/);
      if (match) return `https://www.loom.com/share/${match[1]}`;
      return null;
    },
    thumbnailUrl: () => null,
    durationSeconds: () => null,
  },

  // ── SoundCloud ────────────────────────────────────────────────────────────
  {
    provider: "soundcloud",
    mediaType: "audio",
    test: (u) => u.hostname.includes("soundcloud.com"),
    canonicalUrl: (u) => {
      // w.soundcloud.com/player/?url=https%3A//soundcloud.com/...
      const trackUrl = u.searchParams.get("url");
      if (trackUrl) {
        try {
          return decodeURIComponent(trackUrl);
        } catch {
          return trackUrl;
        }
      }
      return u.href;
    },
    thumbnailUrl: () => null,
    durationSeconds: () => null,
  },

  // ── Spotify ───────────────────────────────────────────────────────────────
  {
    provider: "spotify",
    mediaType: "audio",
    test: (u) => u.hostname.includes("spotify.com"),
    canonicalUrl: (u) => {
      // open.spotify.com/embed/track|album|playlist/{id}
      const match = u.pathname.match(/\/embed\/(track|album|playlist|episode|show)\/([a-zA-Z0-9]+)/);
      if (match) return `https://open.spotify.com/${match[1]}/${match[2]}`;
      return null;
    },
    thumbnailUrl: () => null,
    durationSeconds: () => null,
  },
];

// ---------------------------------------------------------------------------
// Audio URL detection (bare links and native elements)
// ---------------------------------------------------------------------------

const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".ogg", ".wav", ".aac", ".flac", ".m4a", ".opus", ".weba",
]);

function isAudioUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const dot = pathname.lastIndexOf(".");
    return dot !== -1 && AUDIO_EXTENSIONS.has(pathname.slice(dot));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Provider classification engine
// ---------------------------------------------------------------------------

function classifyEmbedUrl(
  rawSrc: string,
  pageUrl: string
): { provider: EmbedProvider; mediaType: EmbedMediaType; canonical: string | null; thumbnail: string | null; duration: number | null } | null {
  let parsed: URL;
  try {
    parsed = new URL(rawSrc, pageUrl);
  } catch {
    return null;
  }

  for (const rule of PROVIDER_RULES) {
    if (rule.test(parsed)) {
      return {
        provider: rule.provider,
        mediaType: rule.mediaType,
        canonical: (() => { try { return rule.canonicalUrl(parsed); } catch { return null; } })(),
        thumbnail: (() => { try { return rule.thumbnailUrl(parsed); } catch { return null; } })(),
        duration: (() => { try { return rule.durationSeconds?.(parsed) ?? null; } catch { return null; } })(),
      };
    }
  }

  // Unknown iframe — log and return
  return {
    provider: "unknown_iframe",
    mediaType: "embed",
    canonical: null,
    thumbnail: null,
    duration: null,
  };
}

// ---------------------------------------------------------------------------
// Dimension helpers
// ---------------------------------------------------------------------------

function parseDimAttr(val: string | undefined): number | null {
  if (!val) return null;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Title helpers
// ---------------------------------------------------------------------------

function extractIframeTitle(
  $: CheerioAPI,
  el: Element
): string | null {
  const title = $(el).attr("title");
  if (title?.trim()) return title.trim();
  const aria = $(el).attr("aria-label");
  if (aria?.trim()) return aria.trim();
  // Try adjacent heading
  const parent = $(el).parent();
  const heading = parent.find("h1,h2,h3,h4").first().text().trim();
  if (heading) return heading.slice(0, 200);
  return null;
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

/**
 * extractEmbeds — discovers all video, audio, and media embeds in a page.
 *
 * @param pageUrl  Absolute URL of the page (for relative URL resolution)
 * @param $        CheerioAPI loaded with full page HTML
 * @param $body    Scoped body/article element
 *
 * Returns deduplicated RawEmbed array + diagnostics.
 */
export function extractEmbeds(
  pageUrl: string,
  $: CheerioAPI,
  $body: Cheerio<Element>
): { embeds: RawEmbed[]; diagnostics: EmbedExtractionDiagnostics } {
  const embeds: RawEmbed[] = [];
  const seenUrls = new Set<string>();

  const diag: EmbedExtractionDiagnostics = {
    totalFound: 0,
    byProvider: {},
    unsupportedEmbeds: 0,
    thumbnailsExtracted: 0,
    missingCanonicalUrl: 0,
    missingThumbnail: 0,
    nativeVideoCount: 0,
    nativeAudioCount: 0,
    iframeEmbedCount: 0,
    audioEmbedCount: 0,
    duplicatesEliminated: 0,
    extractionErrors: 0,
  };

  function tryAdd(embed: RawEmbed): boolean {
    const key = embed.embedUrl.trim().toLowerCase().replace(/#.*$/, "");
    if (seenUrls.has(key)) {
      diag.duplicatesEliminated++;
      return false;
    }
    seenUrls.add(key);
    embeds.push(embed);
    diag.totalFound++;
    diag.byProvider[embed.provider] = (diag.byProvider[embed.provider] ?? 0) + 1;
    if (embed.thumbnailUrl) diag.thumbnailsExtracted++;
    if (!embed.canonicalUrl) diag.missingCanonicalUrl++;
    if (!embed.thumbnailUrl) diag.missingThumbnail++;
    return true;
  }

  // ── 1. Native <video> elements ────────────────────────────────────────────

  $body.find("video").each((_i, el) => {
    try {
      const $el = $(el);
      const width = parseDimAttr($el.attr("width"));
      const height = parseDimAttr($el.attr("height"));
      const poster = $el.attr("poster") || null;

      // Direct src on <video>
      const directSrc = $el.attr("src");
      if (directSrc && !directSrc.startsWith("data:")) {
        try {
          const resolved = new URL(directSrc, pageUrl).href;
          tryAdd({
            embedUrl: resolved,
            canonicalUrl: resolved,
            provider: "native_video",
            mediaType: "video",
            thumbnailUrl: poster ? new URL(poster, pageUrl).href : null,
            durationSeconds: null,
            title: extractIframeTitle($, el),
            width,
            height,
            sourceElement: "video",
          });
          diag.nativeVideoCount++;
        } catch {
          diag.extractionErrors++;
        }
      }

      // <source> children
      $el.find("source").each((_j, srcEl) => {
        try {
          const srcAttr = $(srcEl).attr("src");
          if (!srcAttr || srcAttr.startsWith("data:")) return;
          const resolved = new URL(srcAttr, pageUrl).href;
          tryAdd({
            embedUrl: resolved,
            canonicalUrl: resolved,
            provider: "native_video",
            mediaType: "video",
            thumbnailUrl: poster ? (() => { try { return new URL(poster, pageUrl).href; } catch { return null; } })() : null,
            durationSeconds: null,
            title: extractIframeTitle($, el),
            width,
            height,
            sourceElement: "source",
          });
          diag.nativeVideoCount++;
        } catch {
          diag.extractionErrors++;
        }
      });
    } catch (err) {
      diag.extractionErrors++;
      logger.debug({ err }, "EMBED_EXTRACTOR: error processing <video> element");
    }
  });

  // ── 2. Native <audio> elements ────────────────────────────────────────────

  $body.find("audio").each((_i, el) => {
    try {
      const $el = $(el);
      const width = parseDimAttr($el.attr("width"));
      const height = parseDimAttr($el.attr("height"));

      const directSrc = $el.attr("src");
      if (directSrc && !directSrc.startsWith("data:")) {
        try {
          const resolved = new URL(directSrc, pageUrl).href;
          tryAdd({
            embedUrl: resolved,
            canonicalUrl: resolved,
            provider: "native_audio",
            mediaType: "audio",
            thumbnailUrl: null,
            durationSeconds: null,
            title: extractIframeTitle($, el),
            width,
            height,
            sourceElement: "audio",
          });
          diag.nativeAudioCount++;
        } catch {
          diag.extractionErrors++;
        }
      }

      $el.find("source").each((_j, srcEl) => {
        try {
          const srcAttr = $(srcEl).attr("src");
          if (!srcAttr || srcAttr.startsWith("data:")) return;
          const resolved = new URL(srcAttr, pageUrl).href;
          tryAdd({
            embedUrl: resolved,
            canonicalUrl: resolved,
            provider: "native_audio",
            mediaType: "audio",
            thumbnailUrl: null,
            durationSeconds: null,
            title: extractIframeTitle($, el),
            width,
            height,
            sourceElement: "source",
          });
          diag.nativeAudioCount++;
        } catch {
          diag.extractionErrors++;
        }
      });
    } catch (err) {
      diag.extractionErrors++;
      logger.debug({ err }, "EMBED_EXTRACTOR: error processing <audio> element");
    }
  });

  // ── 3. iframe embeds ──────────────────────────────────────────────────────

  $body.find("iframe").each((_i, el) => {
    try {
      const $el = $(el);
      const rawSrc = $el.attr("src") || $el.attr("data-src");
      if (!rawSrc || rawSrc.startsWith("data:") || rawSrc === "about:blank") return;

      let resolved: string;
      try {
        resolved = new URL(rawSrc, pageUrl).href;
      } catch {
        diag.extractionErrors++;
        return;
      }

      const classification = classifyEmbedUrl(resolved, pageUrl);
      if (!classification) {
        diag.extractionErrors++;
        return;
      }

      const width = parseDimAttr($el.attr("width"));
      const height = parseDimAttr($el.attr("height"));
      const title = extractIframeTitle($, el);

      if (classification.provider === "unknown_iframe") {
        diag.unsupportedEmbeds++;
        logger.debug(
          { embedUrl: resolved, pageUrl },
          "EMBED_EXTRACTOR: unknown iframe provider — logged, non-fatal"
        );
      }

      if (
        classification.mediaType === "audio" ||
        classification.provider === "soundcloud" ||
        classification.provider === "spotify"
      ) {
        diag.audioEmbedCount++;
      } else {
        diag.iframeEmbedCount++;
      }

      tryAdd({
        embedUrl: resolved,
        canonicalUrl: classification.canonical,
        provider: classification.provider,
        mediaType: classification.mediaType,
        thumbnailUrl: classification.thumbnail,
        durationSeconds: classification.duration,
        title,
        width,
        height,
        sourceElement: "iframe",
      });
    } catch (err) {
      diag.extractionErrors++;
      logger.debug({ err }, "EMBED_EXTRACTOR: error processing <iframe> element");
    }
  });

  // ── 4. Bare audio links (<a href="...mp3">) ───────────────────────────────

  $body.find("a[href]").each((_i, el) => {
    try {
      const href = $(el).attr("href");
      if (!href || href.startsWith("data:")) return;
      if (!isAudioUrl(href)) return;

      let resolved: string;
      try {
        resolved = new URL(href, pageUrl).href;
      } catch {
        return;
      }

      const title = $(el).text().trim() || null;
      tryAdd({
        embedUrl: resolved,
        canonicalUrl: resolved,
        provider: "unknown_audio",
        mediaType: "audio",
        thumbnailUrl: null,
        durationSeconds: null,
        title,
        width: null,
        height: null,
        sourceElement: "a",
      });
      diag.audioEmbedCount++;
    } catch (err) {
      diag.extractionErrors++;
      logger.debug({ err }, "EMBED_EXTRACTOR: error processing audio <a> element");
    }
  });

  // ── Finalise ─────────────────────────────────────────────────────────────

  logger.debug(
    {
      pageUrl,
      totalFound: diag.totalFound,
      byProvider: diag.byProvider,
      unsupportedEmbeds: diag.unsupportedEmbeds,
      thumbnailsExtracted: diag.thumbnailsExtracted,
      nativeVideoCount: diag.nativeVideoCount,
      nativeAudioCount: diag.nativeAudioCount,
      iframeEmbedCount: diag.iframeEmbedCount,
      audioEmbedCount: diag.audioEmbedCount,
      duplicatesEliminated: diag.duplicatesEliminated,
      extractionErrors: diag.extractionErrors,
    },
    "EMBED_EXTRACTOR: extraction complete"
  );

  return { embeds, diagnostics: diag };
}

// ---------------------------------------------------------------------------
// Embed JSON schema for ZIP archive entries
// ---------------------------------------------------------------------------

export interface EmbedManifestEntry {
  schemaVersion: "1.0";
  provider: EmbedProvider;
  mediaType: EmbedMediaType;
  embedUrl: string;
  canonicalUrl: string | null;
  thumbnailUrl: string | null;
  title: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  sourceElement: string;
  /** localPath of the article HTML that contains this embed */
  sourceNodePath: string;
  extractedAt: string;
}

/**
 * buildEmbedManifestEntry — creates the JSON payload written to the ZIP
 * for each embed. Preserves embed metadata even when download is disabled.
 */
export function buildEmbedManifestEntry(
  embed: RawEmbed,
  sourceNodePath: string
): EmbedManifestEntry {
  return {
    schemaVersion: "1.0",
    provider: embed.provider,
    mediaType: embed.mediaType,
    embedUrl: embed.embedUrl,
    canonicalUrl: embed.canonicalUrl,
    thumbnailUrl: embed.thumbnailUrl,
    title: embed.title,
    durationSeconds: embed.durationSeconds,
    width: embed.width,
    height: embed.height,
    sourceElement: embed.sourceElement,
    sourceNodePath,
    extractedAt: new Date().toISOString(),
  };
}
