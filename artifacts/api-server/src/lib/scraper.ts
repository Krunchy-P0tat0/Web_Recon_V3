import { createRequire } from "module";
import axios from "axios";
import * as cheerio from "cheerio";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import { logger } from "./logger";
import { CrawlFrontier, type FrontierStats } from "./crawl-frontier";
import { defaultLocalProvider } from "./storage-provider";
import { enqueueJob, getJobRecord } from "./db-queue";
import type { ScrapeJobRecord } from "./db-queue";
import {
  createManifest,
  createPageNodeFromArticle,
  createErrorPageNode,
  createRootNode,
  deriveCloudPath,
  deriveNodeId,
  routeExtractionByType,
  transitionManifest,
  sealForRendering,
  type ExtractionRoute,
  type Manifest,
  type MediaItem,
  type MediaClassification,
  type PageNode,
} from "./manifest";
import {
  buildArticleHtml,
  renderIndexHtml,
  writeManifestOutput,
} from "./renderer";
import { renderManifestJson } from "./manifest-export";
import { renderCloud } from "./cloud-renderer";
import {
  extractImages,
  bestSrcsetEntry,
  extractCssBgUrls,
  resolveImageUrl,
  type RawImage,
  type ImageExtractionDiagnostics,
} from "./image-extractor";
import {
  extractEmbeds,
  buildEmbedManifestEntry,
  type RawEmbed,
  type EmbedExtractionDiagnostics,
} from "./embed-extractor";
import {
  fetchMediaWithRetry,
  validateMediaFetch,
  type MediaBufferStore,
} from "./media-pipeline";
import type { PipelineOrchestrator } from "./pipeline-orchestrator";
import { generateScrapeReport } from "./report-generator";
import { initAuditLogger, getAuditLogger } from "./audit-logger";
import { fetchWithHeadless, isHeadlessAvailable, shutdownHeadlessBrowser } from "./headless-fetcher";
import { computeContentHash } from "./diff-engine";
import {
  triggerResourceIntelligenceAsync,
} from "./resource-intelligence-engine-ri1.js";
import { triggerReconstructionValueAsync } from "./reconstruction-value-engine-ri2.js";
import {
  evaluateSingleDecision,
  triggerResourceDecisionAsync,
} from "./resource-decision-engine-ri3.js";

/** Thin wrapper so the scraper never imports the full diff-engine namespace. */
function computeNodeContentHash(cleanHtml: string): string {
  return computeContentHash(cleanHtml);
}

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { ZipArchive } = require("archiver") as { ZipArchive: new (opts?: Record<string, unknown>) => import("stream").Transform & { append: (source: unknown, data: { name: string }) => void; finalize: () => Promise<void>; abort: () => void; } };

export interface ArticleLink {
  url: string;
  title: string;
  description?: string | null;
  imageUrl?: string | null;
  pageNumber?: number | null;
  pageLabel?: string | null;
  publishedAt?: string | null;
  depth?: number;
  discoverySource?: string | null;
}

export interface ScrapeLinksResult {
  sourceUrl: string;
  links: ArticleLink[];
  totalPages?: number | null;
  frontierStats?: FrontierStats;
}

export type JobStatus = "pending" | "running" | "done" | "error";

export interface ScrapeJob {
  jobId: string;
  seedUrl: string;
  status: JobStatus;
  total: number;
  completed: number;
  errorMessage: string | null;
  downloadUrl: string | null;
  currentArticle?: string | null;
  zipPath?: string;
  manifest?: Manifest;
}

// ---------------------------------------------------------------------------
// In-memory hot-path job map (status reads, active-job tracking).
// This is NOT the source of truth for durability — DB is. Correctness does
// not depend on this Map being populated; it is an optimisation only.
// ---------------------------------------------------------------------------

const jobs = new Map<string, ScrapeJob>();

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MAX_PAGES = 200;
const MAX_ARTICLES_PER_PAGE = 100;
const WP_PER_PAGE = 100;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function resolveUrl(base: string, href: string): string | null {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.href;
  } catch {
    return url.trim().toLowerCase().replace(/#.*$/, "").replace(/\/$/, "");
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

// ---------------------------------------------------------------------------
// WordPress REST API detection + scraping
// ---------------------------------------------------------------------------

interface WpPost {
  id: number;
  link: string;
  title: { rendered: string };
  excerpt: { rendered: string };
  date: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _embedded?: Record<string, any>;
}

function detectWordPressApiBase(html: string, pageUrl: string): string | null {
  const m = html.match(/<link[^>]+rel=["']https:\/\/api\.w\.org\/["'][^>]+href=["']([^"']+)["']/i);
  if (m) return m[1].replace(/\/$/, "");

  if (html.includes("/wp-content/") || html.includes("/wp-includes/")) {
    const base = new URL(pageUrl);
    return `${base.protocol}//${base.host}/wp-json`;
  }

  return null;
}

function resolvePostLink(link: string, apiBase: string): string {
  if (link.startsWith("http")) return link;
  const base = new URL(apiBase);
  return new URL(link, `${base.protocol}//${base.host}`).href;
}

async function scrapeWordPress(
  apiBase: string,
  crawlAllPages: boolean
): Promise<{ links: ArticleLink[]; totalPages: number }> {
  // Only return links that belong to this site — some WP sites store external
  // URLs in the post `link` field for press-mention / link-format posts.
  const siteHost = new URL(apiBase).host;
  const seenUrls = new Set<string>();
  const allLinks: ArticleLink[] = [];
  let page = 1;
  let totalApiPages = 1;

  do {
    const url = `${apiBase}/wp/v2/posts?per_page=${WP_PER_PAGE}&page=${page}&_fields=id,link,title,excerpt,date,_embedded&_embed=1`;
    let response;
    try {
      response = await axios.get<WpPost[]>(url, {
        headers: { "User-Agent": USER_AGENT },
        timeout: 15000,
      });
    } catch (err) {
      logger.warn({ url, err }, "WordPress API request failed");
      break;
    }

    if (page === 1) {
      const total = parseInt(response.headers["x-wp-totalpages"] ?? "1", 10);
      totalApiPages = isNaN(total) ? 1 : total;
    }

    const posts = response.data;
    if (!Array.isArray(posts) || posts.length === 0) break;

    for (const post of posts) {
      const resolvedLink = resolvePostLink(post.link, apiBase);

      // Skip press-mention / link-format posts that point to external sites
      // and skip non-HTML assets (PDFs, MP3s, etc.)
      if (!isValidPageLink(resolvedLink, siteHost)) continue;
      if (seenUrls.has(resolvedLink)) continue;
      seenUrls.add(resolvedLink);

      let imageUrl: string | null = null;
      const media = post._embedded?.["wp:featuredmedia"];
      if (Array.isArray(media) && media[0]?.source_url) {
        imageUrl = media[0].source_url as string;
      }

      const description = stripHtml(post.excerpt?.rendered ?? "").slice(0, 200) || null;

      allLinks.push({
        url: resolvedLink,
        title: stripHtml(post.title?.rendered ?? "Untitled"),
        description,
        imageUrl,
        pageNumber: page,
        pageLabel: `Page ${page}`,
        publishedAt: post.date ?? null,
      });
    }

    page++;
  } while (crawlAllPages && page <= totalApiPages && page <= MAX_PAGES);

  // Also pull WP static pages (About, Services, Galleries etc.) — these are
  // separate from posts and often contain the real site content.
  try {
    const pagesUrl = `${apiBase}/wp/v2/pages?per_page=100&_fields=id,link,title,excerpt,date&status=publish`;
    const pagesResp = await axios.get<WpPost[]>(pagesUrl, {
      headers: { "User-Agent": USER_AGENT },
      timeout: 15000,
    });
    if (Array.isArray(pagesResp.data)) {
      for (const pg of pagesResp.data) {
        const resolvedLink = resolvePostLink(pg.link, apiBase);
        if (!isValidPageLink(resolvedLink, siteHost)) continue;
        if (seenUrls.has(resolvedLink)) continue;
        seenUrls.add(resolvedLink);
        const description = stripHtml(pg.excerpt?.rendered ?? "").slice(0, 200) || null;
        allLinks.push({
          url: resolvedLink,
          title: stripHtml(pg.title?.rendered ?? "Untitled"),
          description,
          imageUrl: null,
          pageNumber: 1,
          pageLabel: "Page 1",
          publishedAt: pg.date ?? null,
        });
      }
    }
  } catch (err) {
    logger.warn({ err }, "WordPress pages API failed — skipping pages");
  }

  return { links: allLinks, totalPages: crawlAllPages ? totalApiPages : 1 };
}

// ---------------------------------------------------------------------------
// Cheerio (static HTML) scraping
// ---------------------------------------------------------------------------

function isValidPageLink(url: string, baseHost: string): boolean {
  try {
    const parsed = new URL(url);
    // Must be same host
    if (parsed.host !== baseHost) return false;
    // Block non-HTML infrastructure paths
    const blockPath =
      /\/(wp-admin|wp-json|wp-cron|xmlrpc\.php|feed|rss|atom|login|logout|signup|register|\.well-known)/i;
    if (blockPath.test(parsed.pathname)) return false;
    // Block non-HTML file extensions
    const nonHtmlExt =
      /\.(jpg|jpeg|png|gif|webp|svg|avif|bmp|tiff|ico|pdf|zip|gz|tar|mp3|mp4|webm|ogg|wav|flac|woff|woff2|ttf|eot|css|js|json|xml|txt|csv|xls|xlsx|doc|docx|exe|dmg|apk)$/i;
    if (nonHtmlExt.test(parsed.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

function detectNextPageUrl(
  $: ReturnType<typeof cheerio.load>,
  currentUrl: string,
  visitedPages: Set<string>
): string | null {
  const baseHost = new URL(currentUrl).host;

  const relNext = $('a[rel="next"], link[rel="next"]').first().attr("href");
  if (relNext) {
    const resolved = resolveUrl(currentUrl, relNext);
    if (resolved && !visitedPages.has(resolved)) return resolved;
  }

  const nextPatterns = [/^next$/i, /^next\s*page$/i, /^›$/, /^»$/, /^→$/, /^>$/];
  let found: string | null = null;

  $("a").each((_i, el) => {
    if (found) return;
    const text = $(el).text().trim();
    const aria = $(el).attr("aria-label") || "";
    const isNext =
      nextPatterns.some((p) => p.test(text)) ||
      nextPatterns.some((p) => p.test(aria));
    if (!isNext) return;
    const href = $(el).attr("href");
    if (!href) return;
    const resolved = resolveUrl(currentUrl, href);
    if (!resolved || visitedPages.has(resolved)) return;
    try {
      if (new URL(resolved).host !== baseHost) return;
    } catch {
      return;
    }
    found = resolved;
  });
  if (found) return found;

  const paginationSelectors = [
    ".pagination a",
    ".pager a",
    ".page-numbers a",
    '[class*="pagination"] a',
    '[class*="pager"] a',
    '[class*="page-nav"] a',
    "nav.navigation a",
    ".wp-pagenavi a",
  ];

  const currentPageNum = detectCurrentPageNumber(currentUrl);
  const nextPageNum = currentPageNum + 1;

  for (const sel of paginationSelectors) {
    $(sel).each((_i, el) => {
      if (found) return;
      const href = $(el).attr("href");
      if (!href) return;
      const resolved = resolveUrl(currentUrl, href);
      if (!resolved || visitedPages.has(resolved)) return;
      try {
        if (new URL(resolved).host !== baseHost) return;
      } catch {
        return;
      }
      if (looksLikePageUrl(resolved, nextPageNum)) found = resolved;
    });
    if (found) return found;
  }

  return null;
}

function detectCurrentPageNumber(url: string): number {
  try {
    const parsed = new URL(url);
    for (const key of ["page", "p", "pg", "paged", "pagenum"]) {
      const v = parsed.searchParams.get(key);
      if (v && /^\d+$/.test(v)) return parseInt(v, 10);
    }
    const m = parsed.pathname.match(/\/page\/(\d+)/i);
    if (m) return parseInt(m[1], 10);
    const m2 = parsed.pathname.match(/\/(\d+)\/?$/);
    if (m2) return parseInt(m2[1], 10);
  } catch {
    //
  }
  return 1;
}

function looksLikePageUrl(url: string, pageNum: number): boolean {
  try {
    const parsed = new URL(url);
    for (const key of ["page", "p", "pg", "paged", "pagenum"]) {
      if (parsed.searchParams.get(key) === String(pageNum)) return true;
    }
    if (parsed.pathname.includes(`/page/${pageNum}`)) return true;
    if (
      parsed.pathname.endsWith(`/${pageNum}`) ||
      parsed.pathname.endsWith(`/${pageNum}/`)
    )
      return true;
  } catch {
    //
  }
  return false;
}

function extractPageLinks(
  $: ReturnType<typeof cheerio.load>,
  pageUrl: string,
  globalSeen: Set<string>,
  pageNumber: number
): ArticleLink[] {
  const baseHost = new URL(pageUrl).host;
  const links: ArticleLink[] = [];

  $("a[href]").each((_i, el) => {
    if (links.length >= MAX_ARTICLES_PER_PAGE) return;
    const href = $(el).attr("href");
    if (!href) return;
    const text = $(el).text().trim();
    const resolved = resolveUrl(pageUrl, href);
    if (!resolved) return;
    if (globalSeen.has(resolved)) return;
    if (!isValidPageLink(resolved, baseHost)) return;
    globalSeen.add(resolved);

    let imageUrl: string | null = null;
    const parent = $(el).closest(
      "article, .post, .entry, .card, .item, li, div"
    ) as ReturnType<typeof $>;
    const img = parent.find("img").first();
    const imgSrc =
      img.attr("src") || img.attr("data-src") || img.attr("data-lazy-src");
    if (imgSrc) imageUrl = resolveUrl(pageUrl, imgSrc) ?? null;

    let description: string | null = null;
    const descEl = parent
      .find("p, .excerpt, .description, .summary")
      .first();
    if (descEl.length) {
      const desc = descEl.text().trim();
      if (desc.length > 20) description = desc.slice(0, 200);
    }

    links.push({
      url: resolved,
      title: text.slice(0, 200) || resolved,
      description,
      imageUrl,
      pageNumber,
      pageLabel: `Page ${pageNumber}`,
    });
  });

  return links;
}

async function scrapeWithFrontier(
  seedUrl: string,
  crawlAllPages: boolean
): Promise<ScrapeLinksResult> {
  const frontier = new CrawlFrontier({
    seedUrl,
    maxPages: crawlAllPages ? MAX_PAGES : 1,
    maxDepth: crawlAllPages ? 5 : 0,
    maxRuntimeMs: crawlAllPages ? 10 * 60 * 1000 : 20 * 1000,
    sameDomainOnly: true,
  });

  // Seed URL at depth 0 — the root of the BFS tree
  frontier.enqueue({ url: seedUrl, depth: 0, parentId: null, discoverySource: null });

  const allLinks: ArticleLink[] = [];
  // Tracks URLs already added to allLinks to avoid emitting duplicates
  const addedUrls = new Set<string>();
  let pageIndex = 1;

  while (!frontier.isExhausted()) {
    const entry = frontier.dequeue();
    if (!entry) break;

    let html: string;
    try {
      const response = await axios.get(entry.url, {
        headers: { "User-Agent": USER_AGENT },
        timeout: 15000,
        maxRedirects: 5,
      });
      html = response.data as string;
    } catch (err) {
      logger.warn({ url: entry.url, depth: entry.depth, err }, "FRONTIER: failed to fetch page");
      continue;
    }

    const $ = cheerio.load(html);

    $("a[href]").each((_i, el) => {
      if (allLinks.length >= MAX_PAGES * MAX_ARTICLES_PER_PAGE) return;
      const href = $(el).attr("href");
      if (!href) return;

      let rawResolved: string;
      try {
        rawResolved = new URL(href, entry.url).href;
      } catch {
        return;
      }

      const normalizedLink =
        CrawlFrontier.resolveAndNormalize(href, entry.url) ?? rawResolved;

      if (addedUrls.has(normalizedLink)) return;

      const text = $(el).text().trim();
      const linkText = text.slice(0, 200) || rawResolved;

      // Extract thumbnail/description from surrounding DOM context
      let imageUrl: string | null = null;
      let description: string | null = null;
      const parent = $(el).closest(
        "article, .post, .entry, .card, .item, li, div"
      ) as ReturnType<typeof $>;
      const img = parent.find("img").first();
      const imgSrc =
        img.attr("src") || img.attr("data-src") || img.attr("data-lazy-src");
      if (imgSrc) imageUrl = resolveUrl(entry.url, imgSrc) ?? null;
      const descEl = parent
        .find("p, .excerpt, .description, .summary")
        .first();
      if (descEl.length) {
        const desc = descEl.text().trim();
        if (desc.length > 20) description = desc.slice(0, 200);
      }

      // Try to enqueue this link for BFS — frontier filters external/blocked/dup
      const linkDepth = entry.depth + 1;
      const accepted = frontier.enqueue({
        url: rawResolved,
        normalizedUrl: normalizedLink,
        depth: linkDepth,
        parentId: entry.normalizedUrl,
        discoverySource: entry.url,
      });

      // Add to article candidates only if the URL passes same-host validity checks
      // and hasn't been seen before. Enqueue result doesn't gate collection here —
      // we want depth-1 links even when crawlAllPages=false (maxDepth=0).
      if (
        !addedUrls.has(normalizedLink) &&
        isValidPageLink(rawResolved, new URL(seedUrl).hostname)
      ) {
        addedUrls.add(normalizedLink);
        allLinks.push({
          url: rawResolved,
          title: linkText,
          description,
          imageUrl,
          pageNumber: pageIndex,
          pageLabel: `Page ${pageIndex}`,
          depth: linkDepth,
          discoverySource: entry.url,
        });
      }

      void accepted;
    });

    logger.debug(
      {
        url: entry.url,
        depth: entry.depth,
        linksFound: allLinks.length,
        ...frontier.stats,
      },
      "FRONTIER: page processed"
    );

    pageIndex++;
  }

  const stats = frontier.stats;
  logger.info(
    {
      seedUrl,
      crawlAllPages,
      ...stats,
      totalLinks: allLinks.length,
    },
    "FRONTIER: crawl complete"
  );

  return {
    sourceUrl: seedUrl,
    links: allLinks,
    totalPages: stats.processedPages > 1 ? stats.processedPages : null,
    frontierStats: stats,
  };
}

// ---------------------------------------------------------------------------
// Main links entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sitemap-based URL discovery
// Runs in parallel with CMS discovery and merges additively — CMS metadata
// always wins for URLs already known; sitemap-only pages are appended.
// Any failure is fully isolated (logged + ignored) so CMS result is unchanged.
// ---------------------------------------------------------------------------

/** Sitemap filenames that only contain image/attachment URLs — not content pages. */
const SITEMAP_ATTACHMENT_RE = /attachment-sitemap|image-sitemap|video-sitemap|media-sitemap/i;

async function discoverSitemapUrls(siteOrigin: string): Promise<ArticleLink[]> {
  const siteHost = new URL(siteOrigin).host;

  // Step 1: Resolve the list of per-type sitemap URLs from the sitemap index.
  //         Fall back to /sitemap.xml if no index exists.
  let sitemapUrls: string[] = [];
  try {
    const indexRes = await axios.get<string>(`${siteOrigin}/sitemap_index.xml`, {
      headers: { "User-Agent": USER_AGENT },
      timeout: 12000,
      maxRedirects: 5,
      responseType: "text",
    });
    const locs = [...(indexRes.data as string).matchAll(/<loc>([^<]+)<\/loc>/g)].map(
      (m) => m[1].trim()
    );
    // Keep only content sitemaps; skip attachment / image-only sitemaps
    sitemapUrls = locs.filter(
      (u) => u.toLowerCase().includes("sitemap") && !SITEMAP_ATTACHMENT_RE.test(u)
    );
  } catch {
    sitemapUrls = [`${siteOrigin}/sitemap.xml`];
  }

  // Step 2: Fetch all content sitemaps in parallel (cap at 30)
  const xmlResults = await Promise.allSettled(
    sitemapUrls.slice(0, 30).map((u) =>
      axios.get<string>(u, {
        headers: { "User-Agent": USER_AGENT },
        timeout: 10000,
        maxRedirects: 3,
        responseType: "text",
      })
    )
  );

  // Step 3: Extract <loc> values, validate, deduplicate
  const collected: ArticleLink[] = [];
  const seen = new Set<string>();

  for (const result of xmlResults) {
    if (result.status !== "fulfilled") continue;
    const xml = result.value.data as string;
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) =>
      m[1].trim().split("#")[0]
    );

    for (const rawUrl of locs) {
      if (!isValidPageLink(rawUrl, siteHost)) continue;
      const norm = normalizeUrl(rawUrl);
      if (seen.has(norm)) continue;
      seen.add(norm);

      // Derive a human-readable title from the last non-empty path segment
      let title = rawUrl;
      try {
        const segments = new URL(rawUrl).pathname
          .replace(/\/$/, "")
          .split("/")
          .filter(Boolean);
        const slug = segments[segments.length - 1] ?? "";
        title = slug
          ? slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
          : rawUrl;
      } catch { /* keep rawUrl as title */ }

      collected.push({
        url: rawUrl,
        title,
        description: null,
        imageUrl: null,
        pageNumber: null,
        pageLabel: null,
        publishedAt: null,
        discoverySource: "sitemap",
      });
    }
  }

  return collected;
}

export async function scrapeLinks(
  url: string,
  crawlAllPages = false
): Promise<ScrapeLinksResult> {
  // Kick off sitemap discovery in parallel — isolated so any failure is non-fatal
  const siteOrigin = (() => {
    try { return `${new URL(url).protocol}//${new URL(url).host}`; } catch { return url; }
  })();
  const sitemapPromise = discoverSitemapUrls(siteOrigin).catch((err: unknown) => {
    logger.warn({ err }, "SITEMAP: discovery failed — skipping");
    return [] as ArticleLink[];
  });

  // ── Existing CMS / frontier discovery (unchanged) ────────────────────────
  let html: string;
  try {
    const response = await axios.get(url, {
      headers: { "User-Agent": USER_AGENT },
      timeout: 15000,
      maxRedirects: 5,
    });
    html = response.data as string;
  } catch (err) {
    throw new Error(
      `Could not fetch URL: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let cmsResult: ScrapeLinksResult;

  const wpApiBase = detectWordPressApiBase(html, url);
  if (wpApiBase) {
    logger.info({ url, wpApiBase }, "WordPress site detected — using REST API");
    try {
      const { links, totalPages } = await scrapeWordPress(wpApiBase, crawlAllPages);
      if (links.length > 0) {
        cmsResult = { sourceUrl: url, links, totalPages: crawlAllPages ? totalPages : null };
      } else {
        logger.warn({ url }, "WordPress API returned 0 posts, falling back to HTML scraper");
        cmsResult = await scrapeWithFrontier(url, crawlAllPages);
      }
    } catch (err) {
      logger.warn({ url, err }, "WordPress API failed, falling back to HTML scraper");
      cmsResult = await scrapeWithFrontier(url, crawlAllPages);
    }
  } else {
    cmsResult = await scrapeWithFrontier(url, crawlAllPages);
  }

  // ── Additive sitemap merge ────────────────────────────────────────────────
  // CMS metadata (title, publishedAt, imageUrl, description) always wins for
  // URLs already discovered. Only genuinely new URLs are appended.
  const sitemapLinks = await sitemapPromise;
  if (sitemapLinks.length > 0) {
    const knownNorm = new Set(cmsResult.links.map((l) => normalizeUrl(l.url)));
    const newFromSitemap = sitemapLinks.filter(
      (l) => !knownNorm.has(normalizeUrl(l.url))
    );
    if (newFromSitemap.length > 0) {
      logger.info(
        {
          cmsCount: cmsResult.links.length,
          sitemapTotal: sitemapLinks.length,
          added: newFromSitemap.length,
        },
        "SITEMAP: merged additional URLs from sitemap discovery"
      );
      cmsResult = { ...cmsResult, links: [...cmsResult.links, ...newFromSitemap] };
    } else {
      logger.info(
        { cmsCount: cmsResult.links.length, sitemapTotal: sitemapLinks.length },
        "SITEMAP: discovery complete — no new URLs beyond CMS results"
      );
    }
  }

  return cmsResult;
}

// ---------------------------------------------------------------------------
// Article content fetching
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// fetchPageContent — generalized page extraction (replaces fetchArticleContent)
//
// Returns raw extracted content WITHOUT rewriting img srcs. The caller
// (runScrapeJob Phase 1) computes routes for each asset and rewrites paths
// using computeRelativePath() before archiving.
//
// Extracts:
//   - Article body HTML (article/main/entry-content or body fallback)
//   - Images: src from img[src|data-src|srcset] and picture > source
//   - Videos: native <video>, <source>, YouTube/Vimeo iframes
// ---------------------------------------------------------------------------

// RawImage is imported from ./image-extractor (comprehensive extraction type)
// RawEmbed is imported from ./embed-extractor (comprehensive embed/video/audio extraction)

interface PageContentResult {
  title: string;
  rawBodyHtml: string;
  rawImages: RawImage[];
  rawEmbeds: RawEmbed[];
  bodySelector: string;
  imageExtractionDiagnostics: ImageExtractionDiagnostics;
  embedExtractionDiagnostics: EmbedExtractionDiagnostics;
  /** HTTP ETag header value from the last successful fetch (for differential change detection). */
  etag?: string | null;
  /** HTTP Last-Modified header value from the last successful fetch (ISO string). */
  lastModified?: string | null;
}

/** Delay helper used in retry backoff */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetchPageContent — fetches a URL and extracts structured content.
 *
 * Resilience strategy (three-tier):
 *   1. axios with full browser headers (up to 3 attempts, exponential backoff).
 *   2. On persistent failure: Puppeteer headless fallback (if Chromium available).
 *   3. If headless unavailable: rethrow so the page is marked "failed" in audit.
 */
async function fetchPageContent(pageUrl: string): Promise<PageContentResult> {
  const BROWSER_HEADERS = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };

  let rawHtml: string | null = null;
  let axiosErr: unknown = null;

  // ── Tier 1: axios with retry ─────────────────────────────────────────────
  // Retry strategy:
  //   • Generic errors  → 2 s, 4 s backoff (transient network / timeout)
  //   • HTTP 429        → 15 s, 30 s backoff (rate-limit window reset)
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      // Default backoff; overridden below for 429
      await delay(attempt * 2000);
    }
    try {
      const response = await axios.get(pageUrl, {
        headers: BROWSER_HEADERS,
        timeout: 30000,           // raised from 15 s → 30 s
        maxRedirects: 10,         // raised from 5 → 10 (some sites chain redirects)
        maxContentLength: 50 * 1024 * 1024,  // 50 MB cap — raised from 10 MB to handle large section pages (e.g. /ccl-corporate/ is ~19 MB)
        maxBodyLength: 50 * 1024 * 1024,
      });
      rawHtml = typeof response.data === "string"
        ? response.data
        : JSON.stringify(response.data);
      break;
    } catch (err) {
      axiosErr = err;

      // For HTTP 429 (rate-limited), honour Retry-After if present or use
      // a much longer backoff before the next attempt so the site window resets.
      const status =
        axios.isAxiosError(err) ? (err.response?.status ?? 0) : 0;
      if (status === 429 && attempt < 2) {
        const retryAfterHeader = axios.isAxiosError(err)
          ? Number(err.response?.headers?.["retry-after"] ?? 0)
          : 0;
        const waitMs = retryAfterHeader > 0
          ? retryAfterHeader * 1000
          : (attempt + 1) * 15000; // 15 s, 30 s
        logger.warn(
          { url: pageUrl, attempt: attempt + 1, waitMs },
          "fetchPageContent: 429 rate-limited — waiting before retry"
        );
        await delay(waitMs);
        continue; // skip the generic delay at top of next iteration
      }

      logger.warn(
        { url: pageUrl, attempt: attempt + 1, status, err },
        "fetchPageContent: axios attempt failed"
      );
    }
  }

  // ── Tier 2: Puppeteer headless fallback ──────────────────────────────────
  if (rawHtml === null) {
    const available = await isHeadlessAvailable();
    if (available) {
      logger.info({ url: pageUrl }, "fetchPageContent: falling back to headless browser");
      rawHtml = await fetchWithHeadless(pageUrl, 45000);
    } else {
      // headless not available — propagate the original axios error
      throw axiosErr;
    }
  }

  const $ = cheerio.load(rawHtml);

  const title =
    $("h1").first().text().trim() ||
    $("title").text().trim() ||
    "Untitled";

  // Full DOM snapshot — capture the entire <body> regardless of page type.
  // This ensures homepages, category pages, product pages, and static pages
  // are all captured completely, not filtered down to article-only regions.
  let $body: ReturnType<typeof $> = $("body");
  const bodySelector = "body";

  // Remove non-content noise but keep iframes for embed detection before stripping
  $body.find("script, style, noscript, [class*='cookie-banner'], [class*='cookie-notice']").remove();

  // ── Image extraction ─────────────────────────────────────────────────────
  // Delegated to image-extractor.ts which handles: img[src|srcset|data-*],
  // <picture><source>, <noscript> fallbacks, inline CSS backgrounds,
  // og:image / twitter:image meta, video[poster], link[preload].
  const { images: rawImages, diagnostics: imageExtractionDiagnostics } =
    extractImages(pageUrl, $, $body);

  // ── Embed extraction ──────────────────────────────────────────────────────
  // Delegated to embed-extractor.ts which handles: native <video>/<audio>,
  // YouTube, Vimeo, TikTok, Dailymotion, Wistia, Loom, SoundCloud, Spotify,
  // generic iframes, and bare audio links (.mp3, .ogg, etc.).
  const { embeds: rawEmbeds, diagnostics: embedExtractionDiagnostics } =
    extractEmbeds(pageUrl, $, $body);

  // Remove iframes from body HTML — they don't render offline; embed metadata
  // is captured in rawEmbeds and written as JSON entries in the ZIP archive.
  $body.find("iframe").remove();

  return {
    title,
    rawBodyHtml: $.html($body),
    rawImages,
    rawEmbeds,
    bodySelector,
    imageExtractionDiagnostics,
    embedExtractionDiagnostics,
  };
}

// ---------------------------------------------------------------------------
// Path routing utilities
// ---------------------------------------------------------------------------

/**
 * computeRelativePath — relative path from one archive entry to another.
 *
 * fromFile: localPath of the file that contains the link (e.g. an article HTML)
 * toFile:   localPath of the target asset (e.g. an image)
 *
 * Example:
 *   from = "content/page-001/slug/index.html"
 *   to   = "images/abc123/img_1.jpg"
 *   →     "../../../images/abc123/img_1.jpg"
 */
function computeRelativePath(fromFile: string, toFile: string): string {
  const fromParts = fromFile.split("/").slice(0, -1);
  const toParts = toFile.split("/");
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }
  const up = "../".repeat(fromParts.length - common);
  return up + toParts.slice(common).join("/");
}

/**
 * deriveRelativeRoot — computes the "../"-chain needed to navigate from a
 * node's localPath back to the archive root (index.html).
 *
 * Example: "content/page-001/slug/index.html" → "../../../"
 */
function deriveRelativeRoot(localPath: string): string {
  const depth = localPath.split("/").length - 1;
  return "../".repeat(depth);
}

// ---------------------------------------------------------------------------
// Media acquisition is fully delegated to media-pipeline.ts.
// scraper.ts only orchestrates the pipeline phases; it never fetches
// images directly or calls fs/network APIs for media.

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------

async function pooled<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// H.1 — Resume helper (Producer-only: not a rendering concern)
// ---------------------------------------------------------------------------

/**
 * Looks up a PageNode by its normalized URL.
 * Used during resume to check if a node was completed in a prior run.
 */
function findNodeByUrl(
  manifest: Manifest,
  normalizedUrl: string
): PageNode | null {
  for (const node of manifest.nodes.values()) {
    if (normalizeUrl(node.metadata.url) === normalizedUrl) return node;
  }
  return null;
}

/**
 * Stamps deterministic cloudPath values on a PageNode and all its MediaItems.
 *
 * Called ONCE, immediately after node creation, so cloudPath is:
 *   - Precomputed  — set before the node enters the manifest
 *   - Immutable    — never rewritten after this call for a given node
 *   - Deterministic — same (jobId, localPath) always yields the same value
 *
 * cloudPath MUST NOT be read during ZIP generation.  It is purely preparatory
 * metadata for the future Phase G cloud worker integration.  ZIP output is
 * driven exclusively by node.storage.localPath (unchanged by this function).
 *
 * Also safe to call on checkpoint nodes loaded from a prior run: it overwrites
 * any stale "" values that existed before H.3 without affecting content.
 */
function stampCloudPaths(jobId: string, node: PageNode): void {
  node.storage.cloudPath = deriveCloudPath(jobId, node.storage.localPath);
  for (const img of node.media.images) {
    img.storage.cloudPath = deriveCloudPath(jobId, img.storage.localPath);
  }
  for (const vid of node.media.videos) {
    vid.storage.cloudPath = deriveCloudPath(jobId, vid.storage.localPath);
  }
}

// ---------------------------------------------------------------------------
// DB status → in-memory JobStatus mapping
// ---------------------------------------------------------------------------

const DB_STATUS_MAP: Record<string, JobStatus> = {
  queued: "pending",
  running: "running",
  done: "done",
  failed: "error",
  dead_letter: "error",
};

// ---------------------------------------------------------------------------
// Public job management API
// ---------------------------------------------------------------------------

export async function createJob(
  total: number,
  seedUrl: string,
  articles: ArticleLink[],
  includeImages: boolean
): Promise<ScrapeJob> {
  const jobId = randomUUID();
  const job: ScrapeJob = {
    jobId,
    seedUrl,
    status: "pending",
    total,
    completed: 0,
    errorMessage: null,
    downloadUrl: null,
    currentArticle: null,
  };
  jobs.set(jobId, job);
  try {
    await enqueueJob(jobId, seedUrl, total, includeImages, articles);

  } catch (err) {
    logger.error({ err, jobId }, "QUEUE: DB enqueue failed — job will run in-memory only");
  }
  return job;
}

/**
 * createJobWithDiff — enqueues a new job flagged as a differential crawl.
 * The job worker will detect diffMode=true and run the diff engine post-pipeline.
 */
export async function createJobWithDiff(
  total: number,
  seedUrl: string,
  articles: ArticleLink[],
  includeImages: boolean,
  baseJobId: string | null
): Promise<ScrapeJob> {
  const jobId = randomUUID();
  const job: ScrapeJob = {
    jobId,
    seedUrl,
    status: "pending",
    total,
    completed: 0,
    errorMessage: null,
    downloadUrl: null,
    currentArticle: null,
  };
  jobs.set(jobId, job);
  try {
    await enqueueJob(jobId, seedUrl, total, includeImages, articles, true, baseJobId);
  } catch (err) {
    logger.error({ err, jobId }, "QUEUE: diff job DB enqueue failed — job will run in-memory only");
  }
  return job;
}

// Build an in-memory ScrapeJob from a DB record and register it in the jobs
// Map so that the hot-path status endpoint can find it without a DB round-trip.
export function createJobFromRecord(record: ScrapeJobRecord): ScrapeJob {
  const job: ScrapeJob = {
    jobId: record.jobId,
    seedUrl: record.seedUrl,
    status: (DB_STATUS_MAP[record.status] ?? "pending") as JobStatus,
    total: record.totalArticles,
    completed: record.completedArticles,
    errorMessage: record.errorMessage ?? null,
    downloadUrl: record.downloadUrl ?? null,
    currentArticle: record.currentArticle ?? null,
    zipPath: record.zipPath ?? undefined,
  };
  jobs.set(job.jobId, job);
  return job;
}

// Sync in-memory-only lookup — used by the worker after runScrapeJob completes.
export function getJobRaw(jobId: string): ScrapeJob | undefined {
  return jobs.get(jobId);
}

// Async lookup: hot path checks memory, cold path falls back to DB.
export async function getJob(jobId: string): Promise<ScrapeJob | undefined> {
  const cached = jobs.get(jobId);
  if (cached) return cached;

  const record = await getJobRecord(jobId);
  if (!record) return undefined;

  return {
    jobId: record.jobId,
    seedUrl: record.seedUrl,
    status: (DB_STATUS_MAP[record.status] ?? "pending") as JobStatus,
    total: record.totalArticles,
    completed: record.completedArticles,
    errorMessage: record.errorMessage ?? null,
    downloadUrl: record.downloadUrl ?? null,
    currentArticle: record.currentArticle ?? null,
    zipPath: record.zipPath ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// runScrapeJob — Phase G three-phase pipeline
//
// Phase 1 — Crawl: fetch article HTML, build PageNodes, write HTML to archive.
//            Media URLs are recorded but NOT downloaded yet.
//
// Phase 2 — Media: download all pending images concurrently with per-asset
//            retry. Failures mark MediaItem.failed; they never block Phase 3.
//            manifest.status → "media_complete". onManifestSave called.
//
// Phase 3 — ZIP render: write deterministic index.html, finalize archive.
//            manifest.status → "complete". onManifestSave called.
//
// ZIP idempotency: if a non-empty ZIP already exists for this jobId the
// entire pipeline is skipped — safe to call multiple times.
//
// Parameters:
//   seedUrl        — passed directly from the DB record; no Map dependency.
//   onManifestSave — incremental persistence hook; called after Phase 1 and
//                    Phase 3. Caller is responsible for Phase 2 checkpoint.
// ---------------------------------------------------------------------------

// How often (in completed-article increments) to flush a manifest checkpoint
// during Phase 1. Limits data loss to at most this many articles on crash.
const MANIFEST_CHECKPOINT_INTERVAL = 5;

export async function runScrapeJob(
  jobId: string,
  seedUrl: string,
  articles: ArticleLink[],
  includeImages: boolean,
  onManifestSave?: (manifest: Manifest) => Promise<void>,
  /**
   * Previously persisted manifest snapshot (from loadManifest). When
   * provided, Phase 1 skips HTTP fetches for nodes already in this snapshot
   * and writes their content to the fresh archive from cache instead.
   * This makes crash-recovery restarts much cheaper.
   */
  checkpoint?: Manifest,
  /** Pipeline orchestrator — the sole runtime authority for stage lifecycle. */
  orchestrator?: PipelineOrchestrator,
  /**
   * Pre-finalize hook invoked between Phase 2 (media download) and ZIP finalization.
   * Designed to run Stages 7 (cloud_upload) and 8 (verification) while media
   * buffers are still live in memory. Failures are non-fatal: cloud errors
   * never prevent ZIP generation.
   */
  onPreFinalize?: (manifest: Manifest, mediaBuffers: MediaBufferStore) => Promise<void>
): Promise<void> {
  const jobStartedAt = new Date();

  // Ensure a hot-path entry exists even if createJobFromRecord was not called
  if (!jobs.has(jobId)) {
    jobs.set(jobId, {
      jobId,
      seedUrl,
      status: "running",
      total: articles.length,
      completed: 0,
      errorMessage: null,
      downloadUrl: null,
      currentArticle: null,
    });
  }
  const job = jobs.get(jobId)!;
  job.status = "running";

  // ── Audit logger ──────────────────────────────────────────────────────────
  // initAuditLogger registers a per-job logger in the global registry so all
  // nested closures can access it via getAuditLogger(jobId). It also queues
  // all article URLs as URL_QUEUED events for the crawl-report.
  const audit = initAuditLogger(jobId, seedUrl, articles);

  // ── ZIP idempotency ──────────────────────────────────────────────────────
  // If a non-empty ZIP already exists the job completed before (or after) the
  // previous DB update. Skip re-generation and return immediately so the
  // worker can mark it done.
  // All paths come from the storage provider — never from os.tmpdir() directly.
  const zipKey = `${jobId}.zip`;
  const zipPath = defaultLocalProvider.resolvePath(zipKey);
  try {
    if (await defaultLocalProvider.exists(zipKey)) {
      logger.info(
        { jobId, zipPath },
        "ZIP: idempotency hit — reusing existing archive"
      );
      // Fast-forward any pending orchestrator stages so job-worker can
      // begin persistence_commit without a dependency constraint violation.
      if (orchestrator) {
        const idempotencySkip = [
          "media_classification",
          "local_rendering",
          "cloud_upload",
          "verification",
          "zip_generation",
        ] as const;
        for (const s of idempotencySkip) {
          await orchestrator.skipStage(s, "zip idempotency hit").catch(() => {});
        }
      }
      job.zipPath = zipPath;
      job.downloadUrl = `/api/scrape/download/${jobId}`;
      job.status = "done";
      return;
    }
  } catch {
    // exists check failed — proceed with fresh generation
  }

  // ── Manifest init ────────────────────────────────────────────────────────
  const manifest = createManifest(seedUrl, {
    crawlAllPages: false,
    includeImages,
    seedUrl,
    extractionMode: "page",
  });
  transitionManifest(manifest, "crawling");
  job.manifest = manifest;

  const rootNode = createRootNode(seedUrl);
  stampCloudPaths(jobId, rootNode);
  manifest.nodes.set(rootNode.id, rootNode);
  manifest.seenUrls.add(normalizeUrl(seedUrl));
  manifest.stats.totalNodes++;
  manifest.stats.byStatus["complete"]++;
  manifest.stats.byType["root"]++;

  // pending media collected during Phase 1 for Phase 2 processing
  const pendingMedia: Array<{
    mediaItem: MediaItem;
    imageUrl: string;
  }> = [];

  // ── H.1 Checkpoint setup (FIX 2 + FIX 3) ──────────────────────────────────
  // If a manifest was persisted for a prior run of this job, its seenUrls
  // identify articles already completed. Phase 1 reuses cached node content
  // from the checkpoint for those articles — no HTTP fetch needed.
  // This guarantees: completed PageNodes survive crashes, MediaItem statuses
  // are preserved, and the job resumes from the last incomplete node.
  const checkpointUrls: Set<string> = checkpoint
    ? new Set(checkpoint.seenUrls)
    : new Set();

  if (checkpoint && checkpoint.nodes.size > 1) {
    const completedPrior = Array.from(checkpoint.nodes.values()).filter(
      (n) => n.nodeType !== "root"
    ).length;
    job.completed = completedPrior;
    manifest.stats = { ...checkpoint.stats };
    logger.info(
      {
        jobId,
        checkpointNodes: checkpoint.nodes.size,
        checkpointStatus: checkpoint.status,
        resumingFrom: completedPrior,
      },
      "JOB: resuming from manifest checkpoint — reusing cached article HTML"
    );
  }

  try {
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const output = fs.createWriteStream(zipPath);

    const byPage = new Map<string, ArticleLink[]>();
    for (const article of articles) {
      const pageKey =
        article.pageNumber != null
          ? `page-${String(article.pageNumber).padStart(3, "0")}`
          : "articles";
      if (!byPage.has(pageKey)) byPage.set(pageKey, []);
      byPage.get(pageKey)!.push(article);
    }

    const sortedPages = Array.from(byPage.entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    );

    // ── Stage 1: discovery (synchronous setup; begin + complete immediately) ──
    if (orchestrator) {
      await orchestrator.beginStage("discovery");
      await orchestrator.completeStage("discovery");
    }

    await new Promise<void>((resolve, reject) => {
      const safetyTimer = setTimeout(() => {
        archive.abort();
        reject(new Error("Archive finalization timed out after 8 minutes"));
      }, 8 * 60 * 1000);

      output.on("close", () => {
        clearTimeout(safetyTimer);
        resolve();
      });
      archive.on("error", (err: Error) => {
        clearTimeout(safetyTimer);
        reject(err);
      });
      archive.pipe(output);

      (async () => {
        // ── Phase 1: Article crawl ──────────────────────────────────────────
        // Fetch HTML, build PageNodes, write article files to archive.
        // Image downloads are DEFERRED to Phase 2 — image URLs are captured
        // in pendingMedia[] so they can be retried independently.
        const allWork: Array<{ pageKey: string; article: ArticleLink; index: number }> = [];
        let idx = 0;
        for (const [pageKey, pageArticles] of sortedPages) {
          for (const article of pageArticles) {
            allWork.push({ pageKey, article, index: idx++ });
          }
        }

        // ── Stage 2: extraction begins — covers all HTTP fetches in the loop ──
        if (orchestrator) {
          await orchestrator.beginStage("extraction");
        }
        transitionManifest(manifest, "scraping");

        await pooled(
          allWork.map(({ pageKey, article, index }) => async () => {
            const normalizedUrl = normalizeUrl(article.url);
            // Deduplication: skip articles already processed in this run
            if (manifest.seenUrls.has(normalizedUrl)) {
              job.completed++;
              return;
            }
            manifest.seenUrls.add(normalizedUrl);

            job.currentArticle = article.title;
            let shadowNode: PageNode | null = null;

            // ── H.1 FIX 3: Resume path — reuse cached HTML from checkpoint ──────
            // Articles in checkpointUrls were completed in a previous worker run.
            // Write their cached content to the fresh archive without an HTTP fetch.
            if (checkpointUrls.has(normalizedUrl) && checkpoint) {
              const cached = findNodeByUrl(checkpoint, normalizedUrl);
              if (cached && cached.content.cleanHtml && cached.nodeType !== "root") {
                stampCloudPaths(jobId, cached);
                const cachedRelRoot = deriveRelativeRoot(cached.storage.localPath);
                archive.append(
                  buildArticleHtml(cached.metadata.title, cached.content.cleanHtml, article, pageKey, cachedRelRoot),
                  { name: cached.storage.localPath }
                );
                if (!manifest.nodes.has(cached.id)) {
                  manifest.nodes.set(cached.id, cached);
                  if (!rootNode.relationships.childIds.includes(cached.id)) {
                    rootNode.relationships.childIds.push(cached.id);
                  }
                }
                if (includeImages) {
                  for (const mi of cached.media.images) {
                    if (mi.sourceUrl && mi.status !== "skipped") {
                      mi.status = "pending";
                      pendingMedia.push({ mediaItem: mi, imageUrl: mi.sourceUrl });
                    }
                  }
                }
                job.completed++;
                if (job.completed % MANIFEST_CHECKPOINT_INTERVAL === 0) {
                  manifest.updatedAt = new Date().toISOString();
                  onManifestSave?.(manifest).catch(() => {});
                }
                return;
              }
            }

            // ── Normal fetch path ────────────────────────────────────────────────
            audit.recordPageFetchStart(article.url);
            const __fetchStartMs = Date.now();
            try {
              const extracted = await fetchPageContent(article.url);
              audit.recordPageFetchComplete(article.url, {
                title: extracted.title,
                htmlSizeBytes: extracted.rawBodyHtml.length,
                imagesFound: extracted.rawImages.length,
                embedsFound: extracted.rawEmbeds.length,
                durationMs: Date.now() - __fetchStartMs,
              });
              const baseSlug =
                slugify(extracted.title) ||
                slugify(article.title) ||
                `article-${index + 1}`;
              const datePfx = article.publishedAt
                ? new Date(article.publishedAt).toISOString().slice(0, 10) + "-"
                : "";
              const articleSlug = datePfx + baseSlug;
              const nodeId = deriveNodeId(article.url);

              // Compute the article node route — manifest-driven, no hardcoded paths
              const nodeRoute = routeExtractionByType({
                nodeType: "article",
                nodeId,
                filename: "index.html",
                pageKey,
                slug: articleSlug,
              });

              // Build image MediaItems with routed storage paths
              const MIME_TO_EXT: Record<string, string> = {
                "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
                "image/webp": ".webp", "image/svg+xml": ".svg", "image/avif": ".avif",
                "image/bmp": ".bmp", "image/tiff": ".tiff", "image/x-icon": ".ico",
              };
              const mediaImages: MediaItem[] = extracted.rawImages.map((img, imgIdx) => {
                let ext = ".jpg";
                if (img.mimeHint && MIME_TO_EXT[img.mimeHint]) {
                  ext = MIME_TO_EXT[img.mimeHint];
                } else {
                  try { ext = path.extname(new URL(img.normalizedUrl).pathname) || ".jpg"; } catch {}
                }
                const filename = `img_${imgIdx + 1}${ext}`;
                const imgRoute = routeExtractionByType({
                  nodeType: "article",
                  mediaClassification: "image" as MediaClassification,
                  nodeId,
                  filename,
                });
                return {
                  id: randomUUID(),
                  sourceUrl: img.normalizedUrl,
                  normalizedUrl: img.normalizedUrl,
                  altText: img.altText,
                  mimeType: img.mimeHint,
                  mediaClassification: "image" as MediaClassification,
                  byteSize: null,
                  dimensions:
                    img.width && img.height
                      ? { width: img.width, height: img.height }
                      : null,
                  status: includeImages ? ("pending" as const) : ("skipped" as const),
                  failReason: null,
                  storage: {
                    localPath: imgRoute.localPath,
                    cloudPath: "",
                    publicPath: imgRoute.publicPath,
                    filename: imgRoute.filename,
                  },
                  positionInPage: imgIdx,
                  checksum: null,
                  sourceElement: img.sourceElement,
                  extractionMethod: img.extractionMethod,
                  htmlWidth: img.width,
                  htmlHeight: img.height,
                  provider: null,
                  canonicalUrl: null,
                  thumbnailUrl: null,
                  durationSeconds: null,
                };
              });

              // Build embed/video/audio MediaItems — catalogued, not downloaded.
              // mediaClassification drives storage routing:
              //   "video"  → videos/{nodeId}/video_N.embed
              //   "audio"  → audio/{nodeId}/audio_N.embed
              //   "embed"  → embeds/{nodeId}/embed_N.json  (iframe-based)
              const mediaVideos: MediaItem[] = extracted.rawEmbeds.map((embed, embedIdx) => {
                // Determine classification and filename prefix from mediaType
                let mediaClassification: MediaClassification;
                let filePrefix: string;
                if (embed.mediaType === "video" && embed.provider === "native_video") {
                  mediaClassification = "video";
                  filePrefix = "video";
                } else if (
                  embed.mediaType === "audio" ||
                  embed.provider === "native_audio" ||
                  embed.provider === "soundcloud" ||
                  embed.provider === "spotify" ||
                  embed.provider === "unknown_audio"
                ) {
                  mediaClassification = "audio";
                  filePrefix = "audio";
                } else {
                  // iframe embed (YouTube, Vimeo, TikTok, Dailymotion, Wistia, Loom, unknown_iframe)
                  mediaClassification = "embed";
                  filePrefix = "embed";
                }

                const filename = `${filePrefix}_${embedIdx + 1}.json`;
                const embedRoute = routeExtractionByType({
                  nodeType: "article",
                  mediaClassification,
                  nodeId,
                  filename,
                });

                return {
                  id: randomUUID(),
                  sourceUrl: embed.embedUrl,
                  normalizedUrl: embed.canonicalUrl ?? embed.embedUrl,
                  altText: embed.title,
                  mimeType: null,
                  mediaClassification,
                  byteSize: null,
                  dimensions:
                    embed.width && embed.height
                      ? { width: embed.width, height: embed.height }
                      : null,
                  status: "skipped" as const,
                  failReason: null,
                  storage: {
                    localPath: embedRoute.localPath,
                    cloudPath: "",
                    publicPath: embedRoute.publicPath,
                    filename: embedRoute.filename,
                  },
                  positionInPage: embedIdx,
                  checksum: null,
                  sourceElement: embed.sourceElement,
                  extractionMethod: embed.provider,
                  htmlWidth: embed.width,
                  htmlHeight: embed.height,
                  // Embed-specific metadata
                  provider: embed.provider,
                  canonicalUrl: embed.canonicalUrl,
                  thumbnailUrl: embed.thumbnailUrl,
                  durationSeconds: embed.durationSeconds,
                };
              });

              // ── DOM rewrite: replace source URLs with local relative paths ────
              // Uses a normalizedUrl→relPath lookup so every extraction method
              // (src, srcset, data-src, CSS background, picture) is handled
              // uniformly without relying on element order.

              // Build lookup: normalizedUrl → computed relative path
              const urlToRelPath = new Map<string, string>();
              for (const mi of mediaImages) {
                if (mi.status !== "skipped" && mi.normalizedUrl) {
                  urlToRelPath.set(
                    mi.normalizedUrl,
                    computeRelativePath(nodeRoute.localPath, mi.storage.localPath)
                  );
                }
              }

              // Helper: resolve a raw DOM attr value and look it up
              const lookupRelPath = (rawUrl: string | undefined): string | null => {
                if (!rawUrl) return null;
                const resolved = resolveImageUrl(article.url, rawUrl);
                return resolved ? (urlToRelPath.get(resolved) ?? null) : null;
              };

              const $doc = cheerio.load(
                `<div id="_scraper_root">${extracted.rawBodyHtml}</div>`
              );

              // Rewrite standalone <img> elements
              $doc("img").each((_, el) => {
                const $el = $doc(el);
                const LAZY_ATTRS = [
                  "data-src", "data-original", "data-lazy-src", "data-lazy",
                  "data-defer-src", "data-echo", "data-cfsrc", "data-img-src",
                  "data-delayed-src", "src",
                ];
                for (const attr of LAZY_ATTRS) {
                  const relPath = lookupRelPath($el.attr(attr));
                  if (relPath) { $el.attr("src", relPath); break; }
                }
                // Strip all lazy-load / multi-res attrs — offline HTML needs a plain src
                $el
                  .removeAttr("srcset")
                  .removeAttr("data-src").removeAttr("data-srcset")
                  .removeAttr("data-lazy-src").removeAttr("data-lazy-srcset")
                  .removeAttr("data-original").removeAttr("data-lazy")
                  .removeAttr("data-defer-src").removeAttr("data-echo")
                  .removeAttr("data-cfsrc").removeAttr("data-img-src")
                  .removeAttr("data-delayed-src");
              });

              // Rewrite <picture><source srcset> — point to best local variant
              $doc("picture source").each((_, el) => {
                const $el = $doc(el);
                const srcset = $el.attr("srcset");
                if (!srcset) return;
                const best = bestSrcsetEntry(srcset);
                if (!best) return;
                const relPath = lookupRelPath(best.url);
                if (relPath) $el.attr("srcset", relPath).removeAttr("sizes");
              });

              // Rewrite inline CSS background-image URLs
              $doc("[style]").each((_, el) => {
                const $el = $doc(el);
                const style = $el.attr("style") ?? "";
                if (!style.toLowerCase().includes("url(")) return;
                let newStyle = style;
                for (const bgUrl of extractCssBgUrls(style)) {
                  const relPath = lookupRelPath(bgUrl);
                  if (relPath) newStyle = newStyle.replaceAll(bgUrl, relPath);
                }
                if (newStyle !== style) $el.attr("style", newStyle);
              });

              const cleanHtml = $doc("#_scraper_root").html() ?? extracted.rawBodyHtml;
              const relRoot = deriveRelativeRoot(nodeRoute.localPath);

              shadowNode = createPageNodeFromArticle(
                article,
                { title: extracted.title, cleanHtml, bodySelector: extracted.bodySelector },
                nodeRoute,
                mediaImages,
                mediaVideos
              );
              stampCloudPaths(jobId, shadowNode);
              shadowNode.relationships.parentId = rootNode.id;

              // Stamp content hash for differential engine (Tier 2 change detection)
              shadowNode.contentHash = computeNodeContentHash(cleanHtml);
              // Stamp HTTP cache headers for Tier 1 change detection (when available)
              if (extracted.etag !== undefined) shadowNode.httpEtag = extracted.etag ?? null;
              if (extracted.lastModified !== undefined) shadowNode.httpLastModified = extracted.lastModified ?? null;

              archive.append(
                buildArticleHtml(extracted.title, cleanHtml, article, pageKey, relRoot),
                { name: shadowNode.storage.localPath }
              );

              // Write embed JSON metadata files to the archive.
              // This preserves embed information (provider, canonical URL, thumbnail)
              // even when download is disabled. iframe-based embeds (YouTube, Vimeo,
              // TikTok, etc.) are always written; native video/audio are skipped since
              // they are handled by the media download pipeline.
              for (const mediaItem of mediaVideos) {
                if (
                  mediaItem.mediaClassification === "embed" ||
                  mediaItem.mediaClassification === "audio"
                ) {
                  const matchingEmbed = extracted.rawEmbeds.find(
                    (e) => e.embedUrl === mediaItem.sourceUrl
                  );
                  if (matchingEmbed) {
                    const entry = buildEmbedManifestEntry(
                      matchingEmbed,
                      shadowNode.storage.localPath
                    );
                    archive.append(JSON.stringify(entry, null, 2), {
                      name: mediaItem.storage.localPath,
                    });
                  }
                }
              }

              logger.debug(
                {
                  url: article.url,
                  path: shadowNode.storage.localPath,
                  category: nodeRoute.category,
                  images: mediaImages.length,
                  embeds: mediaVideos.length,
                },
                "PHASE1: article appended to archive"
              );

              logger.info(
                {
                  url: article.url,
                  ...extracted.imageExtractionDiagnostics,
                },
                "PHASE1: image extraction diagnostics"
              );

              logger.info(
                {
                  url: article.url,
                  ...extracted.embedExtractionDiagnostics,
                },
                "PHASE1: embed extraction diagnostics"
              );

              // Enqueue images for Phase 2 — no download yet
              if (includeImages) {
                for (const mediaItem of mediaImages) {
                  if (mediaItem.status === "pending") {
                    pendingMedia.push({ mediaItem, imageUrl: mediaItem.sourceUrl });
                  }
                }
              }
            } catch (err) {
              logger.warn({ url: article.url, err }, "PHASE1: article scrape failed");
              audit.recordPageFetchFailed(
                article.url,
                err instanceof Error ? err.message : String(err),
                Date.now() - __fetchStartMs
              );
              const errNodeId = deriveNodeId(article.url);
              const errRoute = routeExtractionByType({
                nodeType: "article",
                nodeId: errNodeId,
                filename: "index.html",
                pageKey,
                slug: `error-${errNodeId.slice(0, 8)}`,
              });
              shadowNode = createErrorPageNode(article, err, errRoute);
              stampCloudPaths(jobId, shadowNode);
              shadowNode.relationships.parentId = rootNode.id;
              archive.append(
                `<!DOCTYPE html><html><body><p>Failed to scrape: <a href="${article.url}">${article.url}</a></p></body></html>`,
                { name: shadowNode.storage.localPath }
              );
            }

            job.completed++;
            // H.1 FIX 2 — periodic checkpoint every N articles (fire-and-forget).
            // Limits data loss on crash to ≤MANIFEST_CHECKPOINT_INTERVAL articles.
            if (job.completed % MANIFEST_CHECKPOINT_INTERVAL === 0) {
              manifest.updatedAt = new Date().toISOString();
              onManifestSave?.(manifest).catch(() => {});
            }

            if (shadowNode) {
              if (manifest.nodes.has(shadowNode.id)) {
                const existing = manifest.nodes.get(shadowNode.id)!;
                for (const childId of shadowNode.relationships.childIds) {
                  if (!existing.relationships.childIds.includes(childId)) {
                    existing.relationships.childIds.push(childId);
                  }
                }
              } else {
                manifest.nodes.set(shadowNode.id, shadowNode);
                manifest.stats.totalNodes++;
                manifest.stats.byStatus[shadowNode.status]++;
                manifest.stats.byType[shadowNode.nodeType]++;
                manifest.stats.totalImages += shadowNode.media.images.length;
                manifest.stats.totalVideos += shadowNode.media.videos.length;
                manifest.updatedAt = new Date().toISOString();
                if (!rootNode.relationships.childIds.includes(shadowNode.id)) {
                  rootNode.relationships.childIds.push(shadowNode.id);
                }
              }
            }
          }),
          1  // article crawl concurrency (reduced to 1 to prevent OOM crashes)
        );

        logger.info(
          {
            jobId,
            nodeCount: manifest.nodes.size,
            pendingMedia: pendingMedia.length,
            completed: job.completed,
          },
          "PHASE1: article crawl complete"
        );

        // ── Stages 2–6: complete sequentially ────────────────────────────────
        // extraction was begun before the loop. normalization, manifest_generation,
        // and local_rendering are completed here as logical phase-completion
        // markers. Each must be begun before it can be completed so the
        // orchestrator's dependency constraints are respected.
        if (orchestrator) {
          await orchestrator.completeStage("extraction");
          await orchestrator.beginStage("normalization");
          await orchestrator.completeStage("normalization");

          // ── Phase 2.5A: Visual Capture ──────────────────────────────────
          // Non-fatal: failures are logged but never abort the pipeline.
          if (!orchestrator.shouldSkip("visual_capture")) {
            await orchestrator.beginStage("visual_capture");
            try {
              const { runVisualCapture } = await import("./visual-capture-engine");
              const visualAudit = await runVisualCapture(jobId, manifest, { concurrency: 1 });
              logger.info({ jobId, ...visualAudit }, "PHASE2.5A: visual capture complete");
            } catch (vcErr) {
              logger.warn({ jobId, err: vcErr }, "PHASE2.5A: visual capture failed — continuing");
            }
            await orchestrator.completeStage("visual_capture");
          }

          // ── Phase 2.5B: Visual DNA ───────────────────────────────────────
          // Non-fatal: converts screenshots/DOM/CSS into design intelligence.
          if (!orchestrator.shouldSkip("visual_dna")) {
            await orchestrator.beginStage("visual_dna");
            try {
              const { runVisualDna } = await import("./visual-dna-engine");
              const dnaAudit = await runVisualDna(jobId, manifest);
              logger.info({ jobId, ...dnaAudit }, "PHASE2.5B: visual DNA complete");
            } catch (dnaErr) {
              logger.warn({ jobId, err: dnaErr }, "PHASE2.5B: visual DNA failed — continuing");
            }
            await orchestrator.completeStage("visual_dna");
          }

          await orchestrator.beginStage("manifest_generation");
          await orchestrator.completeStage("manifest_generation");
          // local_rendering depends on media_classification per the dependency graph;
          // it is begun+completed AFTER media_classification below.
        }

        manifest.updatedAt = new Date().toISOString();
        // Incremental manifest save after Phase 1
        await onManifestSave?.(manifest);

        // ── Phase RI-1: Resource Intelligence (fire-and-forget) ───────────────
        // Runs immediately after HTML discovery and before any asset download.
        // Populates in-memory RI-1 cache so the Phase 2 gate can use cached
        // per-job scores. Failures are non-fatal — Phase 2 falls back to the
        // per-resource evaluateSingleResource path.
        triggerResourceIntelligenceAsync(jobId);
        // RI-2 scores reconstruction value for every resource discovered by RI-1
        triggerReconstructionValueAsync(jobId);
        // RI-3 makes the final acquisition decision for every resource
        triggerResourceDecisionAsync(jobId);

        // ── Phase 2: Media acquisition / Stage 5: media_classification ──────
        // Fetch → validate → populate metadata → attach to buffer store.
        // Renderers NEVER fetch; they only consume the prepared store.
        // Failures record a structured failReason and mark status "failed";
        // they never block Phase 2.5 or Phase 3.
        if (orchestrator) await orchestrator.beginStage("media_classification");
        transitionManifest(manifest, "media");

        // Runtime buffer store: mediaItem.id → MediaFetchResult
        // Populated here (Phase 2), consumed and cleared in Phase 2.5.
        const mediaBufferStore: MediaBufferStore = new Map();

        let mediaDownloaded = 0;
        let mediaFailed = 0;
        let mediaInvalid = 0;
        let mediaSkipped = 0; // RI-1 policy skips (intentional, not failures)

        if (pendingMedia.length > 0) {
          await pooled(
            pendingMedia.map(({ mediaItem, imageUrl }) => async () => {
              // ── RI-1 pre-download gate ──────────────────────────────────────
              // Every resource is evaluated by the Resource Intelligence Engine
              // before any network call is made. This is the single choke-point
              // for download decisions — no resource-specific heuristics may
              // bypass this gate.
              //
              // RI-3 is the single authoritative decision gate for every resource.
              // No subsystem may decide to download, reference, defer, stream,
              // cache, or skip a resource without routing through RI-3.
              //
              // Gate rule: only block on SKIP. DEFER and REFERENCE both proceed
              // to download here because Phase 1 already rewrote the HTML to
              // local `media/...` paths — skipping the download would produce
              // broken asset references in the rendered output.
              const ri3Gate = evaluateSingleDecision(
                imageUrl,
                seedUrl,
                mediaItem.mimeType ?? null,
                null, // byteSize not yet known pre-download
              );
              if (ri3Gate.decision === "SKIP") {
                mediaItem.status = "skipped";
                mediaItem.failReason = `ri3:${ri3Gate.reason.slice(0, 80)}`;
                mediaSkipped++; // intentional policy skip — not a failure
                logger.debug(
                  {
                    imageUrl,
                    decision:    ri3Gate.decision,
                    confidence:  ri3Gate.confidence,
                    ri1Score:    ri3Gate.ri1Score,
                    ri2Overall:  ri3Gate.ri2Overall,
                    reason:      ri3Gate.reason,
                  },
                  "PHASE2: RI-3 gate — policy skip",
                );
                return;
              }

              const result = await fetchMediaWithRetry(imageUrl, 3);

              if (!result) {
                mediaItem.status = "failed";
                mediaItem.failReason = "max_retries_exceeded";
                mediaFailed++;
                audit.recordMediaDownload(imageUrl, false, null, "max_retries_exceeded");
                return;
              }

              const validation = validateMediaFetch(result, imageUrl);
              if (!validation.valid) {
                mediaItem.status = "failed";
                mediaItem.failReason = validation.reason ?? "validation_failed";
                mediaInvalid++;
                audit.recordMediaDownload(imageUrl, false, null, validation.reason ?? "validation_failed");
                logger.debug(
                  { imageUrl, reason: mediaItem.failReason },
                  "PHASE2: media item rejected by validation"
                );
                return;
              }

              // Attach metadata to manifest node — renderers read this, never re-fetch
              mediaItem.mimeType = result.mimeType;
              mediaItem.mediaClassification = result.mediaClassification;
              mediaItem.byteSize = result.byteSize;
              mediaItem.dimensions = result.dimensions;
              mediaItem.checksum = result.checksum;
              mediaItem.status = "downloaded";
              audit.recordMediaDownload(imageUrl, true, result.byteSize);

              logger.debug(
                {
                  sourceUrl: imageUrl,
                  classification: result.mediaClassification,
                  mimeType: result.mimeType,
                  byteSize: result.byteSize,
                  localPath: mediaItem.storage.localPath,
                  checksum: result.checksum.slice(0, 12) + "…",
                },
                "PHASE2: media item classified and downloaded"
              );

              // Attach buffer to runtime store for Phase 2.5 consumption
              mediaBufferStore.set(mediaItem.id, result);
              mediaDownloaded++;
            }),
            2  // media download concurrency (reduced to prevent OOM crashes)
          );
        }

        logger.info(
          {
            jobId,
            mediaDownloaded,
            mediaFailed,
            mediaInvalid,
            mediaSkipped,
            mediaTotal: pendingMedia.length,
            successRate:
              pendingMedia.length > 0
                ? Math.round((mediaDownloaded / pendingMedia.length) * 100)
                : 100,
          },
          "PHASE2: media acquisition complete"
        );

        // ── Stage 5: media_classification complete ────────────────────────────
        if (orchestrator) await orchestrator.completeStage("media_classification");

        // ── Stage 6: local_rendering ──────────────────────────────────────────
        // Depends on media_classification per the orchestrator dependency graph.
        // The actual HTML rendering to the archive happened during Phase 1, but
        // the stage marker is placed here to satisfy the constraint chain.
        if (orchestrator) {
          await orchestrator.beginStage("local_rendering");
          await orchestrator.completeStage("local_rendering");
        }

        manifest.updatedAt = new Date().toISOString();
        // Incremental manifest save after Phase 2
        await onManifestSave?.(manifest);

        // ── Stages 7+8: cloud_upload + verification (onPreFinalize callback) ──
        // The callback is provided by job-worker.ts. Failures are NON-FATAL:
        // cloud errors are caught by the callback and never abort ZIP generation.
        // Media buffers are still live here so R2 receives raw files from memory.
        if (onPreFinalize) {
          try {
            await onPreFinalize(manifest, mediaBufferStore);
          } catch (prefinalizeErr) {
            logger.warn(
              { jobId, err: prefinalizeErr },
              "PIPELINE: pre-finalize callback failed (non-fatal) — continuing to zip_generation"
            );
          }
        }

        // ── Stage 9: zip_generation begins ────────────────────────────────────
        // Dependency: verification (Stage 8) must be completed/skipped first.
        if (orchestrator) await orchestrator.beginStage("zip_generation");

        // ── Phase 2.5 (deferred): Media rendering ─────────────────────────────
        // Buffers were held since Phase 2 so cloud upload could source raw files
        // from memory. Now append each buffer to the archive stream and delete
        // immediately to release memory before ZIP finalization.
        let mediaRendered = 0;

        for (const { mediaItem } of pendingMedia) {
          if (mediaItem.status !== "downloaded") continue;

          const fetchResult = mediaBufferStore.get(mediaItem.id);
          if (!fetchResult) {
            // Guard: buffer missing despite "downloaded" status — should not happen
            mediaItem.status = "failed";
            mediaItem.failReason = "buffer_missing_at_render";
            logger.warn(
              { mediaItemId: mediaItem.id, sourceUrl: mediaItem.sourceUrl },
              "PHASE2.5: buffer missing for downloaded media item"
            );
            continue;
          }

          archive.append(fetchResult.buffer, { name: mediaItem.storage.localPath });
          mediaItem.status = "rendered";
          mediaBufferStore.delete(mediaItem.id);
          mediaRendered++;
        }

        logger.info(
          {
            jobId,
            mediaRendered,
            bufferStoreResidual: mediaBufferStore.size,
          },
          "PHASE2.5: media rendering complete (deferred — buffers released)"
        );

        // ── Phase 3: ZIP render ──────────────────────────────────────────────
        // Freeze node internals before entering the rendering phase.
        // This enforces the renderer's read-only contract at runtime: any
        // attempt to mutate node.content, .media, .relationships, or .storage
        // will throw a TypeError in strict mode.
        sealForRendering(manifest);
        transitionManifest(manifest, "rendering");

        // Delegates ALL HTML content decisions to the Renderer (renderer.ts).
        // The Producer (scraper.ts) owns the archive stream lifecycle — it
        // appends the rendered content and finalizes. It must NOT generate
        // HTML or make layout decisions; those belong to the Renderer.
        const renderResult = renderIndexHtml(manifest, allWork.length, articles);

        // Mirror render metadata into stats for backwards-compatibility with
        // manifest-store.ts which persists manifest.stats.renderSource.
        manifest.stats.renderSource = renderResult.renderSource;
        manifest.stats.pathConsistencyCheck = renderResult.pathConsistencyCheck;

        if (renderResult.renderSource === "fallback") {
          logger.warn(
            { jobId, expected: allWork.length, ready: renderResult.nodeCount },
            "PHASE3: manifest validation failed — using legacy fallback index"
          );
        }

        archive.append(renderResult.html, { name: "index.html" });

        // Append the human-readable scrape report
        const reportText = generateScrapeReport(manifest, {
          jobId,
          seedUrl,
          totalQueued: allWork.length,
          completedCount: manifest.stats.byStatus["complete"] ?? 0,
          startedAt: jobStartedAt,
          finishedAt: new Date(),
        });
        archive.append(reportText, { name: "scrape-report.txt" });

        const zipMode =
          renderResult.nodeCount === 0
            ? "LEGACY"
            : renderResult.renderSource === "manifest"
              ? "MANIFEST"
              : "HYBRID";

        logger.info(
          {
            jobId,
            articleCount: allWork.length,
            nodeCount: renderResult.nodeCount,
            renderSource: renderResult.renderSource,
            zipMode,
          },
          "PHASE3: finalizing ZIP archive"
        );

        archive.finalize();
      })().catch(reject);
    });

    // ── Stage 9: zip_generation complete (archive closed by writeStream) ──────
    if (orchestrator) await orchestrator.completeStage("zip_generation");

    // ── Audit: record ZIP stats and seal manifest event ───────────────────────
    try {
      const zipStat = fs.statSync(zipPath);
      audit.setZipInfo({ path: zipPath, sizeBytes: zipStat.size });
    } catch { /* non-fatal — file may be missing on idempotency path */ }
    audit.emitEvent({
      stage: "manifest_generation",
      event: "MANIFEST_GENERATED",
      status: "completed",
      details: { nodeCount: manifest.nodes.size, seedUrl },
    });

    // ── Post-ZIP ─────────────────────────────────────────────────────────────
    // Producer updates the ScrapeJob hot-path struct (memory only — not manifest).
    job.zipPath = zipPath;
    job.currentArticle = null;
    job.status = "done";
    job.downloadUrl = `/api/scrape/download/${jobId}`;

    // Derive terminal status: "partial" when at least one article node errored,
    // "complete" when all scraped successfully.
    const hasErrorNodes = Array.from(manifest.nodes.values()).some(
      (n) => n.nodeType !== "root" && n.status === "error"
    );
    transitionManifest(manifest, hasErrorNodes ? "partial" : "complete");

    // jsonKey / jsonPath come from the storage provider — never os.tmpdir() directly.
    const jsonKey = `${jobId}.manifest.json`;
    const jsonPath = defaultLocalProvider.resolvePath(jsonKey);

    // Renderer writes manifest.output — the ONLY place this field is assigned.
    // All other code must treat manifest.output as read-only.
    writeManifestOutput(manifest, {
      zipPath,
      downloadUrl: `/api/scrape/download/${jobId}`,
      renderedAt: new Date().toISOString(),
      nodeCount: manifest.stats.totalNodes - 1,  // -1 to exclude root node
      renderSource: manifest.stats.renderSource ?? "fallback",
      pathConsistencyCheck: manifest.stats.pathConsistencyCheck ?? false,
      jsonPath,
    });

    // Dry-run cloud execution validator.
    // Runs immediately after manifest.output is sealed so it can attach the
    // CloudExecutionReport to manifest.output.cloud before renderManifestJson
    // serialises the manifest — making the report part of the JSON export.
    //
    // This is purely structural validation:
    //   • No uploads, no SDKs, no network calls
    //   • Checks cloudPath uniqueness, localPath↔cloudPath consistency,
    //     missing mappings, filename validity, provider URL generation,
    //     and all three hard invariants
    //
    // A failed cloud report does NOT fail the job — the ZIP is the primary
    // artefact. Issues are surfaced via structured logs for observability.
    try {
      renderCloud(manifest, defaultLocalProvider);
    } catch (cloudErr) {
      logger.warn(
        { jobId, err: cloudErr },
        "JOB: cloud dry-run validator threw unexpectedly (non-fatal)"
      );
    }

    // Write portable JSON export alongside the ZIP.
    // renderManifestJson is called AFTER writeManifestOutput so manifest.output
    // (including jsonPath) is present in the exported document.
    try {
      const jsonContent = renderManifestJson(manifest);
      await defaultLocalProvider.write(jsonKey, jsonContent);
      logger.info(
        { jobId, jsonPath, bytes: Buffer.byteLength(jsonContent, "utf8") },
        "JOB: portable manifest JSON written"
      );
    } catch (jsonErr) {
      // JSON export failure must not fail the job — ZIP is the primary artifact.
      logger.warn({ jobId, jsonPath, err: jsonErr }, "JOB: manifest JSON export failed (non-fatal)");
    }

    logger.info(
      {
        jobId,
        zipPath,
        jsonPath,
        nodeCount: manifest.output!.nodeCount,
        renderSource: manifest.output!.renderSource,
      },
      "JOB: complete — ZIP and manifest JSON ready"
    );

    // Final manifest persist (status = complete, output = set)
    await onManifestSave?.(manifest);
  } catch (err) {
    // Propagate pipeline failure to the orchestrator before re-throwing.
    // Swallowed: orchestrator I/O must never mask the original error.
    if (orchestrator) {
      await orchestrator
        .failPipeline(err instanceof Error ? err : new Error(String(err)))
        .catch(() => {});
    }
    logger.error({ jobId, err }, "JOB: failed");
    job.status = "error";
    job.currentArticle = null;
    job.errorMessage =
      err instanceof Error ? err.message : "Unknown error";
    if (job.manifest) {
      // Only transition to error if not already in a terminal state.
      // (The manifest may already be "complete"/"partial" if the error
      // occurred after the terminal transition but before the DB write.)
      const terminalStates: string[] = ["complete", "partial", "error"];
      if (!terminalStates.includes(job.manifest.status)) {
        transitionManifest(job.manifest, "error");
      }
    }
    throw err;
  }
}
