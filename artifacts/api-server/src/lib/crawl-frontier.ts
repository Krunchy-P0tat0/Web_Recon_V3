/**
 * crawl-frontier.ts — Frontier-driven URL queue system
 *
 * Implements BFS crawl with:
 *  - URL normalization (canonical, tracking-param stripping)
 *  - Deduplication via visited Set<normalizedUrl>
 *  - External domain filtering (same-host by default)
 *  - Protocol / extension / path blocking
 *  - Hard limits: maxPages, maxDepth, maxRuntimeMs
 *  - Per-entry parent tracking and BFS depth measurement
 *  - Crawl statistics (queueSize, processedPages, per-skip-reason counts)
 */

// ---------------------------------------------------------------------------
// Noise query parameters stripped during normalization
// ---------------------------------------------------------------------------

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "utm_reader", "fbclid", "gclid", "gclsrc", "dclid", "msclkid",
  "mc_eid", "mc_cid", "_ga", "_gl", "ref", "referral", "source", "campaign",
  "medium", "yclid", "twclid", "igshid", "_hsenc", "_hsmi", "mkt_tok",
  "vero_id", "icid", "oly_enc_id", "oly_anon_id", "rb_clickid", "s_cid",
]);

// ---------------------------------------------------------------------------
// Blocked protocols — never crawl these
// ---------------------------------------------------------------------------

const BLOCKED_PROTOCOLS = new Set([
  "mailto:", "javascript:", "tel:", "sms:", "data:", "ftp:", "file:",
  "callto:", "skype:", "viber:", "whatsapp:", "tg:",
]);

// ---------------------------------------------------------------------------
// Non-HTML extensions — skip during link discovery
// ---------------------------------------------------------------------------

const BLOCKED_EXTENSIONS =
  /\.(jpg|jpeg|png|gif|webp|svg|avif|bmp|tiff|ico|pdf|zip|gz|tar|bz2|7z|rar|mp3|mp4|webm|ogg|wav|flac|aac|m4a|woff|woff2|ttf|eot|otf|css|js|jsx|ts|tsx|json|xml|yaml|yml|csv|xls|xlsx|xlsm|doc|docx|ppt|pptx|exe|dmg|apk|pkg|deb|rpm|iso|img)$/i;

// ---------------------------------------------------------------------------
// Infrastructure paths — skip during link discovery
// ---------------------------------------------------------------------------

const BLOCKED_PATH_RE =
  /\/(wp-admin|wp-json|wp-cron|wp-login|xmlrpc\.php|feed|rss|atom|login|logout|signup|register|cart|checkout|account|my-account|\.well-known|cdn-cgi|__cf_chl|apple-app-site-association)\b/i;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FrontierEntry {
  url: string;
  normalizedUrl: string;
  depth: number;
  parentId: string | null;
  discoverySource: string | null;
}

export interface FrontierStats {
  queueSize: number;
  processedPages: number;
  skippedDuplicates: number;
  skippedExternal: number;
  skippedProtocol: number;
  skippedExtension: number;
  skippedPath: number;
  skippedDepthLimit: number;
  skippedPageLimit: number;
  crawlDepthReached: number;
  elapsedMs: number;
}

export interface CrawlFrontierConfig {
  seedUrl: string;
  maxPages?: number;
  maxDepth?: number;
  maxRuntimeMs?: number;
  sameDomainOnly?: boolean;
}

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

export function normalizeUrlFrontier(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";
    for (const param of TRACKING_PARAMS) {
      parsed.searchParams.delete(param);
    }
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.href;
  } catch {
    return url.trim().toLowerCase().replace(/#.*$/, "").replace(/\/$/, "");
  }
}

// ---------------------------------------------------------------------------
// Internal filter result type
// ---------------------------------------------------------------------------

type SkipReason =
  | "skippedDuplicates"
  | "skippedExternal"
  | "skippedProtocol"
  | "skippedExtension"
  | "skippedPath"
  | "skippedDepthLimit"
  | "skippedPageLimit";

type FilterResult = { allowed: true } | { allowed: false; reason: SkipReason };

function filterUrl(
  rawUrl: string,
  seedHost: string,
  sameDomainOnly: boolean
): FilterResult {
  const lower = rawUrl.trim().toLowerCase();

  for (const proto of BLOCKED_PROTOCOLS) {
    if (lower.startsWith(proto)) return { allowed: false, reason: "skippedProtocol" };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "skippedProtocol" };
  }

  if (sameDomainOnly && parsed.hostname !== seedHost) {
    return { allowed: false, reason: "skippedExternal" };
  }

  if (BLOCKED_EXTENSIONS.test(parsed.pathname)) {
    return { allowed: false, reason: "skippedExtension" };
  }

  if (BLOCKED_PATH_RE.test(parsed.pathname)) {
    return { allowed: false, reason: "skippedPath" };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// CrawlFrontier class
// ---------------------------------------------------------------------------

export class CrawlFrontier {
  private readonly queue: FrontierEntry[] = [];
  private readonly visited = new Set<string>();
  private readonly seedHost: string;
  private readonly maxPages: number;
  private readonly maxDepth: number;
  private readonly maxRuntimeMs: number;
  private readonly sameDomainOnly: boolean;
  private readonly startedAt: number;

  private _processedPages = 0;
  private _skippedDuplicates = 0;
  private _skippedExternal = 0;
  private _skippedProtocol = 0;
  private _skippedExtension = 0;
  private _skippedPath = 0;
  private _skippedDepthLimit = 0;
  private _skippedPageLimit = 0;
  private _crawlDepthReached = 0;

  constructor(config: CrawlFrontierConfig) {
    this.seedHost = new URL(config.seedUrl).hostname;
    this.maxPages = config.maxPages ?? 200;
    this.maxDepth = config.maxDepth ?? 5;
    this.maxRuntimeMs = config.maxRuntimeMs ?? 4 * 60 * 1000;
    this.sameDomainOnly = config.sameDomainOnly ?? true;
    this.startedAt = Date.now();
  }

  /**
   * Resolve and normalize a raw href relative to a base URL.
   * Returns null if the URL cannot be resolved or parsed.
   */
  static resolveAndNormalize(rawHref: string, base: string): string | null {
    try {
      const resolved = new URL(rawHref, base).href;
      return normalizeUrlFrontier(resolved);
    } catch {
      return null;
    }
  }

  /**
   * Enqueue a URL for crawling.
   * The normalizedUrl field is computed here if not provided.
   * Returns true if the URL was accepted and added to the queue.
   */
  enqueue(
    entry: Omit<FrontierEntry, "normalizedUrl"> & { normalizedUrl?: string }
  ): boolean {
    const normalizedUrl =
      entry.normalizedUrl ?? normalizeUrlFrontier(entry.url);

    if (entry.depth > this.maxDepth) {
      this._skippedDepthLimit++;
      return false;
    }

    if (this.visited.has(normalizedUrl)) {
      this._skippedDuplicates++;
      return false;
    }

    if (this._processedPages + this.queue.length >= this.maxPages) {
      this._skippedPageLimit++;
      return false;
    }

    const filterResult = filterUrl(
      entry.url,
      this.seedHost,
      this.sameDomainOnly
    );
    if (!filterResult.allowed) {
      switch (filterResult.reason) {
        case "skippedExternal":   this._skippedExternal++;   break;
        case "skippedProtocol":   this._skippedProtocol++;   break;
        case "skippedExtension":  this._skippedExtension++;  break;
        case "skippedPath":       this._skippedPath++;       break;
      }
      return false;
    }

    this.queue.push({ ...entry, normalizedUrl });
    return true;
  }

  hasVisited(normalizedUrl: string): boolean {
    return this.visited.has(normalizedUrl);
  }

  /**
   * Dequeue the next entry for processing.
   * Returns null if the frontier is exhausted or any hard limit is reached.
   * Marks the URL visited atomically on dequeue to prevent races.
   */
  dequeue(): FrontierEntry | null {
    if (this.isExhausted()) return null;

    const entry = this.queue.shift()!;
    this.visited.add(entry.normalizedUrl);
    this._processedPages++;
    if (entry.depth > this._crawlDepthReached) {
      this._crawlDepthReached = entry.depth;
    }
    return entry;
  }

  isExhausted(): boolean {
    if (this.queue.length === 0) return true;
    if (this._processedPages >= this.maxPages) return true;
    if (Date.now() - this.startedAt >= this.maxRuntimeMs) return true;
    return false;
  }

  get stats(): FrontierStats {
    return {
      queueSize: this.queue.length,
      processedPages: this._processedPages,
      skippedDuplicates: this._skippedDuplicates,
      skippedExternal: this._skippedExternal,
      skippedProtocol: this._skippedProtocol,
      skippedExtension: this._skippedExtension,
      skippedPath: this._skippedPath,
      skippedDepthLimit: this._skippedDepthLimit,
      skippedPageLimit: this._skippedPageLimit,
      crawlDepthReached: this._crawlDepthReached,
      elapsedMs: Date.now() - this.startedAt,
    };
  }
}
