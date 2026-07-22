/**
 * resource-intelligence-engine-ri1.ts — Phase RI-1: Resource Intelligence Engine
 *
 * Universal pre-download decision framework for every discovered resource.
 * Operates immediately after HTML discovery and before any asset download.
 *
 * Evaluates:
 *   CSS · JavaScript · Images · Fonts · SVG · Videos · JSON
 *   API endpoints · WASM · PDFs · Other static assets
 *
 * Computes per resource:
 *   Resource type · Origin · MIME type · Estimated size/cost
 *   Reconstruction / Runtime / Visual / Backend importance
 *   Security risk · Crawl risk · Resource Intelligence Score (0-100)
 *   Download Recommendation · Reference Recommendation · Skip Recommendation
 *
 * Outputs (R2 + in-memory):
 *   resource-intelligence-report.json
 *   resource-classification-report.json
 *   resource-priority-report.json
 *   resource-risk-report.json
 */

import { logger }           from "./logger.js";
import { loadManifest }     from "./manifest-store.js";
import { createCloudProvider } from "../cloud/index.js";
import type { PageNode }    from "./manifest.js";

// ── Resource types ────────────────────────────────────────────────────────────

export type ResourceType =
  | "css"
  | "javascript"
  | "image"
  | "font"
  | "svg"
  | "video"
  | "audio"
  | "json"
  | "api-endpoint"
  | "wasm"
  | "pdf"
  | "document"
  | "xml"
  | "html"
  | "ico"
  | "other-static";

export type ResourceOrigin = "same-domain" | "subdomain" | "external" | "cdn" | "data-uri";

export type DownloadRecommendation = "DOWNLOAD" | "REFERENCE" | "DEFER" | "SKIP";
export type ReferenceRecommendation = "INLINE" | "EXTERNAL-LINK" | "CDN" | "SKIP";
export type ResourcePriority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "SKIP";

// ── Scoring dimensions ────────────────────────────────────────────────────────

export interface ResourceScores {
  reconstructionImportance: number;  // 0-100 how critical for page recreation
  runtimeImportance:        number;  // 0-100 how critical for page to function
  visualImportance:         number;  // 0-100 how critical for visual fidelity
  backendImportance:        number;  // 0-100 how critical for server function
  securityRisk:             number;  // 0-100 higher = more dangerous
  crawlRisk:                number;  // 0-100 higher = more likely to get blocked
  resourceIntelligenceScore: number; // 0-100 composite score
}

// ── Per-resource analysis ─────────────────────────────────────────────────────

export interface ResourceAnalysis {
  id:                       string;
  url:                      string;
  normalizedUrl:            string;
  resourceType:             ResourceType;
  origin:                   ResourceOrigin;
  sameDomain:               boolean;
  externalDomain:           string | null;
  mimeType:                 string | null;
  mimeSource:               "inferred" | "observed" | "unknown";
  estimatedBytes:           number | null;    // bytes
  estimatedDownloadCostMs:  number | null;    // ms at 10 Mbps
  estimatedStorageCostKb:   number | null;    // KB after compression estimate
  scores:                   ResourceScores;
  priority:                 ResourcePriority;
  downloadRecommendation:   DownloadRecommendation;
  referenceRecommendation:  ReferenceRecommendation;
  skipRecommendation:       boolean;
  skipReason:               string | null;
  discoveredOn:             string[];        // page URLs this resource appears on
  occurrences:              number;
  tags:                     string[];        // "render-blocking", "above-fold", "analytics", etc.
  remediations:             string[];
}

// ── Report shapes ─────────────────────────────────────────────────────────────

export interface ResourceIntelligenceReport {
  jobId:              string;
  seedUrl:            string;
  generatedAt:        string;
  phase:              "RI-1";
  totalResources:     number;
  totalBytes:         number;
  byType:             Record<ResourceType, number>;
  byOrigin:           Record<ResourceOrigin, number>;
  byPriority:         Record<ResourcePriority, number>;
  byRecommendation:   Record<DownloadRecommendation, number>;
  resources:          ResourceAnalysis[];
  summary:            string;
}

export interface ResourceClassificationReport {
  jobId:       string;
  generatedAt: string;
  byCssClass:      ResourceTypeGroup;
  byJsClass:       ResourceTypeGroup;
  byImageClass:    ResourceTypeGroup;
  byFontClass:     ResourceTypeGroup;
  byMediaClass:    ResourceTypeGroup;
  byDataClass:     ResourceTypeGroup;
  byOtherClass:    ResourceTypeGroup;
  originBreakdown: OriginGroup[];
  mimeBreakdown:   MimeGroup[];
}

export interface ResourceTypeGroup {
  type:      ResourceType | ResourceType[];
  count:     number;
  totalKb:   number;
  avgScore:  number;
  resources: Array<Pick<ResourceAnalysis, "url" | "estimatedBytes" | "priority" | "scores">>;
}

export interface OriginGroup {
  origin:  ResourceOrigin;
  count:   number;
  domains: string[];
  totalKb: number;
}

export interface MimeGroup {
  mimeType: string;
  count:    number;
  totalKb:  number;
}

export interface ResourcePriorityReport {
  jobId:        string;
  generatedAt:  string;
  critical:     PriorityBucket;
  high:         PriorityBucket;
  medium:       PriorityBucket;
  low:          PriorityBucket;
  skip:         PriorityBucket;
  downloadPlan: DownloadPlanEntry[];
}

export interface PriorityBucket {
  count:        number;
  totalKb:      number;
  resources:    Array<Pick<ResourceAnalysis, "url" | "resourceType" | "scores" | "downloadRecommendation" | "tags">>;
}

export interface DownloadPlanEntry {
  rank:                   number;
  url:                    string;
  resourceType:           ResourceType;
  priority:               ResourcePriority;
  downloadRecommendation: DownloadRecommendation;
  estimatedKb:            number | null;
  score:                  number;
  reason:                 string;
}

export interface ResourceRiskReport {
  jobId:           string;
  generatedAt:     string;
  overallRiskScore: number;
  securitySummary: RiskSummary;
  crawlSummary:    RiskSummary;
  highRiskResources:  Array<Pick<ResourceAnalysis, "url" | "resourceType" | "scores" | "tags" | "remediations">>;
  externalDomains: ExternalDomainRisk[];
  riskSignals:     string[];
  recommendations: string[];
}

export interface RiskSummary {
  avgScore: number;
  high:     number;  // count with score > 70
  medium:   number;  // count with score 40-70
  low:      number;  // count with score < 40
}

export interface ExternalDomainRisk {
  domain:       string;
  resourceCount: number;
  isCdn:        boolean;
  isAnalytics:  boolean;
  isAds:        boolean;
  avgSecurityRisk: number;
  avgCrawlRisk:    number;
}

// ── CDN and analytics detection ───────────────────────────────────────────────

const CDN_DOMAINS = new Set([
  "cdn.jsdelivr.net","unpkg.com","cdnjs.cloudflare.com","cdn.skypack.dev",
  "ajax.googleapis.com","fonts.googleapis.com","fonts.gstatic.com",
  "d3js.org","code.jquery.com","maxcdn.bootstrapcdn.com",
  "stackpath.bootstrapcdn.com","cdn.bootcss.com","cdn.staticfile.org",
  "res.cloudinary.com","img.cloudinary.com","imagekit.io",
  "fastly.net","akamaized.net","cloudfront.net","azureedge.net",
  "cdn.shopify.com","static.wixstatic.com","s3.amazonaws.com",
  "storage.googleapis.com","blob.core.windows.net",
]);

const ANALYTICS_PATTERNS = [
  /google-analytics\.com/,"googletagmanager\.com","facebook\.com\/tr",
  /hotjar\.com/,/mixpanel\.com/,/segment\.io/,/amplitude\.com/,
  /heap\.io/,/fullstory\.com/,/mouseflow\.com/,/clarity\.ms/,
  /sentry\.io/,/bugsnag\.com/,/rollbar\.com/,/datadog-browser-agent/,
].map(p => typeof p === "string" ? new RegExp(p) : p);

const ADS_PATTERNS = [
  /doubleclick\.net/,/googlesyndication\.com/,/adnxs\.com/,
  /adroll\.com/,/criteo\.com/,/outbrain\.com/,/taboola\.com/,
].map(p => typeof p === "string" ? new RegExp(p) : p);

// ── Type detection from URL/extension ────────────────────────────────────────

function extOf(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    return (pathname.slice(pathname.lastIndexOf(".") + 1).toLowerCase().split("?")[0] ?? "").split("#")[0] ?? "";
  } catch {
    return (url.slice(url.lastIndexOf(".") + 1).toLowerCase().split("?")[0] ?? "").split("#")[0] ?? "";
  }
}

function inferMimeType(url: string): string | null {
  const ext = extOf(url);
  const MAP: Record<string, string> = {
    css: "text/css",
    js: "application/javascript", mjs: "application/javascript",
    ts: "application/typescript",
    wasm: "application/wasm",
    json: "application/json",
    xml: "application/xml",
    pdf: "application/pdf",
    svg: "image/svg+xml",
    jpg: "image/jpeg", jpeg: "image/jpeg",
    png: "image/png", gif: "image/gif",
    webp: "image/webp", avif: "image/avif",
    bmp: "image/bmp", tiff: "image/tiff",
    ico: "image/x-icon",
    mp4: "video/mp4", webm: "video/webm",
    ogg: "video/ogg", mov: "video/quicktime",
    avi: "video/x-msvideo",
    mp3: "audio/mpeg", wav: "audio/wav",
    flac: "audio/flac", aac: "audio/aac",
    woff: "font/woff", woff2: "font/woff2",
    ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject",
    html: "text/html", htm: "text/html",
    txt: "text/plain",
    csv: "text/csv",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    zip: "application/zip", gz: "application/gzip",
  };
  return MAP[ext] ?? null;
}

function detectResourceType(url: string, mimeType?: string | null): ResourceType {
  const ext = extOf(url);
  const mime = mimeType ?? inferMimeType(url) ?? "";

  if (ext === "css" || mime === "text/css") return "css";
  if (["js","mjs"].includes(ext) || mime.includes("javascript")) return "javascript";
  if (["woff","woff2","ttf","otf","eot"].includes(ext) || mime.startsWith("font/")) return "font";
  if (ext === "svg" || mime === "image/svg+xml") return "svg";
  if (["jpg","jpeg","png","gif","webp","avif","bmp","tiff","ico"].includes(ext) || mime.startsWith("image/")) {
    return ext === "ico" ? "ico" : "image";
  }
  if (["mp4","webm","ogg","mov","avi"].includes(ext) || mime.startsWith("video/")) return "video";
  if (["mp3","wav","flac","aac"].includes(ext) || mime.startsWith("audio/")) return "audio";
  if (ext === "json" || mime === "application/json") return "json";
  if (ext === "wasm" || mime === "application/wasm") return "wasm";
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (["doc","docx","xls","xlsx","csv","txt"].includes(ext)) return "document";
  if (ext === "xml" || mime === "application/xml" || mime === "text/xml") return "xml";
  if (["html","htm"].includes(ext) || mime === "text/html") return "html";

  // API endpoint detection
  const u = url.toLowerCase();
  if (u.includes("/api/") || u.includes("/rest/") || u.includes("/graphql") ||
      u.includes("/v1/") || u.includes("/v2/") || u.includes("/v3/")) return "api-endpoint";

  return "other-static";
}

// ── Estimated sizes per type (KB) ─────────────────────────────────────────────

const EST_SIZE_KB: Record<ResourceType, number> = {
  css: 30, javascript: 80, image: 120, font: 50, svg: 15,
  video: 5000, audio: 3000, json: 10, "api-endpoint": 5, wasm: 200,
  pdf: 800, document: 500, xml: 20, html: 15, ico: 2, "other-static": 20,
};

// ── Origin classification ─────────────────────────────────────────────────────

function classifyOrigin(resourceUrl: string, seedUrl: string): ResourceOrigin {
  if (resourceUrl.startsWith("data:")) return "data-uri";
  try {
    const rHost = new URL(resourceUrl).hostname.toLowerCase();
    const sHost = new URL(seedUrl).hostname.toLowerCase();
    const sDomain = sHost.replace(/^www\./, "");

    if (rHost === sHost) return "same-domain";
    if (rHost.endsWith("." + sDomain) || rHost === sDomain) return "subdomain";
    for (const cdn of CDN_DOMAINS) {
      if (rHost === cdn || rHost.endsWith("." + cdn)) return "cdn";
    }
    return "external";
  } catch {
    return "external";
  }
}

function getExternalDomain(resourceUrl: string, seedUrl: string): string | null {
  try {
    const rHost = new URL(resourceUrl).hostname.toLowerCase();
    const sHost = new URL(seedUrl).hostname.toLowerCase();
    return rHost === sHost ? null : rHost;
  } catch {
    return null;
  }
}

// ── Tagging ───────────────────────────────────────────────────────────────────

function computeTags(
  url: string,
  resourceType: ResourceType,
  origin: ResourceOrigin,
  positionInPage: number,
): string[] {
  const tags: string[] = [];
  const lUrl = url.toLowerCase();

  if (resourceType === "css") tags.push("render-blocking");
  if (resourceType === "javascript") {
    if (!lUrl.includes("defer") && !lUrl.includes("async")) tags.push("potentially-blocking");
  }
  if (positionInPage <= 1) tags.push("above-fold");
  if (origin === "cdn") tags.push("cdn");
  if (origin === "external") tags.push("third-party");
  if (resourceType === "font") tags.push("typography");
  if (ANALYTICS_PATTERNS.some(p => p.test(url))) tags.push("analytics");
  if (ADS_PATTERNS.some(p => p.test(url))) tags.push("advertising");
  if (lUrl.includes("gtm") || lUrl.includes("google-tag")) tags.push("tag-manager");
  if (lUrl.includes("recaptcha") || lUrl.includes("hcaptcha")) tags.push("captcha");
  if (lUrl.includes("stripe") || lUrl.includes("paypal") || lUrl.includes("braintree")) tags.push("payment");
  if (resourceType === "wasm") tags.push("compute-intensive");
  if (resourceType === "video") tags.push("large-asset");
  if (resourceType === "api-endpoint") tags.push("dynamic");

  return [...new Set(tags)];
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function computeScores(
  resourceType: ResourceType,
  origin: ResourceOrigin,
  estimatedKb: number,
  tags: string[],
  occurrences: number,
): ResourceScores {
  let reconstruction = 0;
  let runtime = 0;
  let visual = 0;
  let backend = 0;
  let securityRisk = 0;
  let crawlRisk = 0;

  // Type-based base scores
  switch (resourceType) {
    case "css":
      reconstruction = 90; runtime = 85; visual = 95; backend = 5;
      securityRisk = 15; crawlRisk = 10;
      break;
    case "javascript":
      reconstruction = 75; runtime = 90; visual = 40; backend = 30;
      securityRisk = 35; crawlRisk = 15;
      break;
    case "image":
      reconstruction = 70; runtime = 30; visual = 85; backend = 5;
      securityRisk = 10; crawlRisk = 20;
      break;
    case "font":
      reconstruction = 80; runtime = 50; visual = 90; backend = 5;
      securityRisk = 10; crawlRisk = 15;
      break;
    case "svg":
      reconstruction = 80; runtime = 40; visual = 88; backend = 5;
      securityRisk = 20; crawlRisk = 10;
      break;
    case "video":
      reconstruction = 50; runtime = 25; visual = 75; backend = 5;
      securityRisk = 10; crawlRisk = 40;
      break;
    case "audio":
      reconstruction = 40; runtime = 20; visual = 20; backend = 5;
      securityRisk = 10; crawlRisk = 35;
      break;
    case "json":
      reconstruction = 60; runtime = 70; visual = 10; backend = 60;
      securityRisk = 15; crawlRisk = 25;
      break;
    case "api-endpoint":
      reconstruction = 30; runtime = 75; visual = 5; backend = 80;
      securityRisk = 20; crawlRisk = 50;
      break;
    case "wasm":
      reconstruction = 60; runtime = 85; visual = 20; backend = 40;
      securityRisk = 40; crawlRisk = 20;
      break;
    case "pdf":
      reconstruction = 55; runtime = 20; visual = 35; backend = 10;
      securityRisk = 20; crawlRisk = 30;
      break;
    case "document":
      reconstruction = 45; runtime = 10; visual = 20; backend = 10;
      securityRisk = 15; crawlRisk = 25;
      break;
    case "xml":
      reconstruction = 40; runtime = 30; visual = 5; backend = 50;
      securityRisk = 10; crawlRisk = 20;
      break;
    case "ico":
      reconstruction = 30; runtime = 20; visual = 30; backend = 5;
      securityRisk = 5; crawlRisk = 5;
      break;
    case "html":
      reconstruction = 85; runtime = 80; visual = 60; backend = 40;
      securityRisk = 25; crawlRisk = 20;
      break;
    default:
      reconstruction = 20; runtime = 15; visual = 10; backend = 10;
      securityRisk = 15; crawlRisk = 15;
  }

  // Origin modifiers
  if (origin === "same-domain" || origin === "subdomain") {
    crawlRisk = Math.max(0, crawlRisk - 15);
    reconstruction = Math.min(100, reconstruction + 5);
  }
  if (origin === "cdn") {
    securityRisk = Math.max(0, securityRisk - 10);
    crawlRisk = Math.max(0, crawlRisk + 5);
  }
  if (origin === "external") {
    securityRisk = Math.min(100, securityRisk + 15);
    crawlRisk = Math.min(100, crawlRisk + 20);
  }
  if (origin === "data-uri") {
    crawlRisk = 0;
    reconstruction = Math.min(100, reconstruction + 10);
  }

  // Tag modifiers
  if (tags.includes("analytics") || tags.includes("advertising") || tags.includes("tag-manager")) {
    securityRisk = Math.min(100, securityRisk + 20);
    crawlRisk = Math.min(100, crawlRisk + 25);
    reconstruction = Math.max(0, reconstruction - 30);
    runtime = Math.max(0, runtime - 20);
  }
  if (tags.includes("payment")) {
    securityRisk = Math.min(100, securityRisk + 10);
    backend = Math.min(100, backend + 20);
  }
  if (tags.includes("captcha")) {
    securityRisk = Math.min(100, securityRisk + 5);
    runtime = Math.min(100, runtime + 10);
  }
  if (tags.includes("render-blocking")) {
    runtime = Math.min(100, runtime + 10);
    reconstruction = Math.min(100, reconstruction + 5);
  }
  if (tags.includes("large-asset")) {
    crawlRisk = Math.min(100, crawlRisk + 15);
  }

  // Size modifiers for crawl risk
  if (estimatedKb > 5000) crawlRisk = Math.min(100, crawlRisk + 20);
  else if (estimatedKb > 1000) crawlRisk = Math.min(100, crawlRisk + 10);

  // Occurrence boost (widely used = more important)
  if (occurrences > 5) {
    reconstruction = Math.min(100, reconstruction + 5);
    visual = Math.min(100, visual + 5);
  }

  // Composite Resource Intelligence Score
  // Importance dimensions minus risk penalty
  const importanceScore =
    reconstruction * 0.28 +
    runtime        * 0.22 +
    visual         * 0.28 +
    backend        * 0.12 +
    (100 - securityRisk) * 0.05 +
    (100 - crawlRisk)    * 0.05;

  const resourceIntelligenceScore = Math.round(Math.min(100, Math.max(0, importanceScore)));

  return {
    reconstructionImportance: Math.round(reconstruction),
    runtimeImportance:        Math.round(runtime),
    visualImportance:         Math.round(visual),
    backendImportance:        Math.round(backend),
    securityRisk:             Math.round(securityRisk),
    crawlRisk:                Math.round(crawlRisk),
    resourceIntelligenceScore,
  };
}

// ── Priority from score ───────────────────────────────────────────────────────

function scoreToPriority(score: number, securityRisk: number, crawlRisk: number): ResourcePriority {
  if (securityRisk >= 85 || crawlRisk >= 90) return "SKIP";
  if (score >= 80) return "CRITICAL";
  if (score >= 60) return "HIGH";
  if (score >= 40) return "MEDIUM";
  if (score >= 20) return "LOW";
  return "SKIP";
}

// ── Recommendation derivation ─────────────────────────────────────────────────

function deriveDownloadRecommendation(
  resourceType: ResourceType,
  origin: ResourceOrigin,
  priority: ResourcePriority,
  tags: string[],
): DownloadRecommendation {
  if (priority === "SKIP") return "SKIP";
  if (tags.includes("analytics") || tags.includes("advertising")) return "SKIP";
  if (resourceType === "api-endpoint") return "SKIP";
  if (origin === "data-uri") return "DOWNLOAD";
  if (priority === "CRITICAL" || priority === "HIGH") {
    if (origin === "same-domain" || origin === "subdomain") return "DOWNLOAD";
    if (origin === "cdn" && (resourceType === "css" || resourceType === "font")) return "DOWNLOAD";
    return "REFERENCE";
  }
  if (priority === "MEDIUM") {
    if (origin === "same-domain" || origin === "subdomain") return "DOWNLOAD";
    return "REFERENCE";
  }
  return "DEFER";
}

function deriveReferenceRecommendation(
  resourceType: ResourceType,
  origin: ResourceOrigin,
  priority: ResourcePriority,
  estimatedKb: number,
): ReferenceRecommendation {
  if (priority === "SKIP") return "SKIP";
  if (resourceType === "api-endpoint") return "SKIP";
  if (origin === "cdn") return "CDN";
  if (origin === "external") return "EXTERNAL-LINK";
  if (estimatedKb < 10 && (resourceType === "css" || resourceType === "svg")) return "INLINE";
  if (origin === "same-domain" || origin === "subdomain") return "EXTERNAL-LINK";
  return "EXTERNAL-LINK";
}

function deriveRemediations(
  resourceType: ResourceType,
  scores: ResourceScores,
  tags: string[],
  estimatedKb: number,
): string[] {
  const rem: string[] = [];
  if (scores.securityRisk >= 60) rem.push("Review external resource for XSS/supply-chain risk; add Subresource Integrity (SRI) hash");
  if (tags.includes("analytics")) rem.push("Analytics script excluded from reconstruction — reference original endpoint");
  if (tags.includes("advertising")) rem.push("Ad script excluded from reconstruction — skip download");
  if (tags.includes("render-blocking")) rem.push("Move CSS to <head> with preload; consider critical CSS extraction");
  if (resourceType === "javascript" && tags.includes("potentially-blocking")) rem.push("Add defer or async attribute to script tag");
  if (resourceType === "image" && estimatedKb > 300) rem.push("Consider WebP/AVIF conversion and responsive srcset");
  if (resourceType === "video" && estimatedKb > 5000) rem.push("Stream video from CDN rather than downloading to archive");
  if (resourceType === "font" && !tags.includes("cdn")) rem.push("Self-host fonts or use font-display:swap to prevent FOIT");
  if (scores.crawlRisk >= 60) rem.push("High crawl risk — rate-limit or proxy downloads; check robots.txt");
  return rem;
}

// ── Resource extraction from manifest + HTML ──────────────────────────────────

export interface RawResource {
  url:            string;
  mimeType?:      string | null;
  byteSize?:      number | null;
  discoveredOn:   string;
  positionInPage?: number;
  sourceElement?: string | null;
}

function extractResourcesFromHtml(html: string, pageUrl: string): RawResource[] {
  const resources: RawResource[] = [];
  const seen = new Set<string>();

  function add(url: string, mime?: string, pos = 99) {
    if (!url || url.startsWith("#") || seen.has(url)) return;
    try {
      const abs = url.startsWith("http") ? url : new URL(url, pageUrl).href;
      if (!seen.has(abs)) {
        seen.add(abs);
        resources.push({ url: abs, mimeType: mime ?? null, discoveredOn: pageUrl, positionInPage: pos });
      }
    } catch { /* skip malformed URLs */ }
  }

  // <link rel="stylesheet" href="...">
  const cssLinks = html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi);
  for (const m of cssLinks) if (m[1]) add(m[1], "text/css", 0);

  // <link rel="preload" href="..." as="...">
  const preloads = html.matchAll(/<link[^>]+rel=["']preload["'][^>]*href=["']([^"']+)["'][^>]*as=["']([^"']+)["']/gi);
  for (const m of preloads) {
    if (!m[1] || !m[2]) continue;
    const mimeMap: Record<string, string> = { style: "text/css", script: "application/javascript", font: "font/woff2", image: "image/*" };
    add(m[1], mimeMap[m[2]], 0);
  }

  // <script src="...">
  const scripts = html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi);
  for (const m of scripts) if (m[1]) add(m[1], "application/javascript", 50);

  // <img src="...">
  let imgPos = 0;
  const imgs = html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi);
  for (const m of imgs) if (m[1]) add(m[1], undefined, imgPos++);

  // <img srcset="...">
  const srcsets = html.matchAll(/srcset=["']([^"']+)["']/gi);
  for (const m of srcsets) {
    if (!m[1]) continue;
    for (const part of m[1].split(",")) {
      const url = part.trim().split(/\s+/)[0];
      if (url) add(url, undefined, 50);
    }
  }

  // <source src="..."> (video/audio/picture)
  const sources = html.matchAll(/<source[^>]+src=["']([^"']+)["']/gi);
  for (const m of sources) if (m[1]) add(m[1], undefined, 60);

  // CSS url() references: background-image, @font-face, etc.
  const cssUrls = html.matchAll(/url\(["']?([^"')]+)["']?\)/gi);
  for (const m of cssUrls) if (m[1] && !m[1].startsWith("data:")) add(m[1], undefined, 70);

  // @import in <style> blocks
  const styleBlocks = html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi);
  for (const block of styleBlocks) {
    if (!block[1]) continue;
    const imports = block[1].matchAll(/@import\s+(?:url\()?["']?([^"');]+)["']?\)?/gi);
    for (const m of imports) if (m[1]) add(m[1], "text/css", 0);
  }

  // <link rel="icon" / apple-touch-icon
  const icons = html.matchAll(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)["']/gi);
  for (const m of icons) if (m[1]) add(m[1], "image/x-icon", 0);

  // <video src="..."> / <audio src="...">
  const av = html.matchAll(/<(?:video|audio)[^>]+src=["']([^"']+)["']/gi);
  for (const m of av) if (m[1]) add(m[1], undefined, 70);

  return resources;
}

// ── Deduplication & URL normalization ────────────────────────────────────────

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    const params = [...u.searchParams.entries()].filter(([k]) =>
      !["utm_source","utm_medium","utm_campaign","utm_term","utm_content","fbclid","gclid"].includes(k)
    );
    u.search = "";
    params.forEach(([k, v]) => u.searchParams.set(k, v));
    return u.toString();
  } catch {
    return url;
  }
}

// ── Core analysis function ────────────────────────────────────────────────────

export function analyzeResources(
  rawResources: RawResource[],
  seedUrl: string,
): ResourceAnalysis[] {
  // Deduplicate by normalized URL, merging discoveredOn arrays
  // Omit the singular `discoveredOn: string` so the merged value can carry `string[]`
  const byNorm = new Map<string, Omit<RawResource, "discoveredOn"> & { discoveredOn: string[]; positions: number[] }>();

  for (const r of rawResources) {
    const norm = normalizeUrl(r.url);
    const existing = byNorm.get(norm);
    if (existing) {
      if (!existing.discoveredOn.includes(r.discoveredOn)) existing.discoveredOn.push(r.discoveredOn);
      existing.positions.push(r.positionInPage ?? 99);
      if (r.byteSize && !existing.byteSize) existing.byteSize = r.byteSize;
      if (r.mimeType && !existing.mimeType) existing.mimeType = r.mimeType;
    } else {
      byNorm.set(norm, {
        ...r,
        discoveredOn: [r.discoveredOn],
        positions: [r.positionInPage ?? 99],
      });
    }
  }

  const results: ResourceAnalysis[] = [];

  for (const [norm, r] of byNorm) {
    const url = r.url;
    const resourceType = detectResourceType(url, r.mimeType);
    const mimeType = r.mimeType ?? inferMimeType(url);
    const origin = classifyOrigin(url, seedUrl);
    const sameDomain = origin === "same-domain" || origin === "subdomain" || origin === "data-uri";
    const externalDomain = sameDomain ? null : getExternalDomain(url, seedUrl);
    const occurrences = r.discoveredOn.length;
    const minPos = Math.min(...r.positions);

    const estimatedKb = r.byteSize
      ? Math.round(r.byteSize / 1024)
      : EST_SIZE_KB[resourceType] ?? 20;
    const estimatedBytes = r.byteSize ?? estimatedKb * 1024;
    const estimatedDownloadCostMs = Math.round((estimatedKb / (10 * 1024)) * 1000 * 8); // at 10 Mbps
    const estimatedStorageCostKb = resourceType === "image" || resourceType === "video"
      ? Math.round(estimatedKb * 0.85)
      : Math.round(estimatedKb * 0.4);

    const tags = computeTags(url, resourceType, origin, minPos);
    const scores = computeScores(resourceType, origin, estimatedKb, tags, occurrences);
    const priority = scoreToPriority(scores.resourceIntelligenceScore, scores.securityRisk, scores.crawlRisk);
    const downloadRec = deriveDownloadRecommendation(resourceType, origin, priority, tags);
    const referenceRec = deriveReferenceRecommendation(resourceType, origin, priority, estimatedKb);
    const skipRec = downloadRec === "SKIP" || priority === "SKIP";
    const skipReason = skipRec
      ? tags.includes("analytics") ? "Analytics/tracking script — not required for reconstruction"
        : tags.includes("advertising") ? "Advertising script — excluded from reconstruction"
        : scores.securityRisk >= 85 ? "High security risk — review before including"
        : scores.crawlRisk >= 90 ? "Extremely high crawl risk"
        : resourceType === "api-endpoint" ? "Dynamic API endpoint — not downloadable"
        : "Low importance score"
      : null;

    const remediations = deriveRemediations(resourceType, scores, tags, estimatedKb);

    results.push({
      id: Buffer.from(norm).toString("base64url").slice(0, 16),
      url,
      normalizedUrl: norm,
      resourceType,
      origin,
      sameDomain,
      externalDomain,
      mimeType,
      mimeSource: r.mimeType ? "observed" : mimeType ? "inferred" : "unknown",
      estimatedBytes,
      estimatedDownloadCostMs,
      estimatedStorageCostKb,
      scores,
      priority,
      downloadRecommendation: downloadRec,
      referenceRecommendation: referenceRec,
      skipRecommendation: skipRec,
      skipReason,
      discoveredOn: r.discoveredOn,
      occurrences,
      tags,
      remediations,
    });
  }

  // Sort by Resource Intelligence Score desc
  return results.sort((a, b) => b.scores.resourceIntelligenceScore - a.scores.resourceIntelligenceScore);
}

// ── Report builders ───────────────────────────────────────────────────────────

function buildIntelligenceReport(
  jobId: string,
  seedUrl: string,
  resources: ResourceAnalysis[],
): ResourceIntelligenceReport {
  const byType: Partial<Record<ResourceType, number>> = {};
  const byOrigin: Partial<Record<ResourceOrigin, number>> = {};
  const byPriority: Partial<Record<ResourcePriority, number>> = {};
  const byRec: Partial<Record<DownloadRecommendation, number>> = {};
  let totalBytes = 0;

  for (const r of resources) {
    byType[r.resourceType] = (byType[r.resourceType] ?? 0) + 1;
    byOrigin[r.origin] = (byOrigin[r.origin] ?? 0) + 1;
    byPriority[r.priority] = (byPriority[r.priority] ?? 0) + 1;
    byRec[r.downloadRecommendation] = (byRec[r.downloadRecommendation] ?? 0) + 1;
    totalBytes += r.estimatedBytes ?? 0;
  }

  const downloads = resources.filter(r => r.downloadRecommendation === "DOWNLOAD").length;
  const skips     = resources.filter(r => r.skipRecommendation).length;
  const avgScore  = resources.length
    ? Math.round(resources.reduce((s, r) => s + r.scores.resourceIntelligenceScore, 0) / resources.length)
    : 0;

  return {
    jobId,
    seedUrl,
    generatedAt: new Date().toISOString(),
    phase: "RI-1",
    totalResources: resources.length,
    totalBytes,
    byType:          byType as Record<ResourceType, number>,
    byOrigin:        byOrigin as Record<ResourceOrigin, number>,
    byPriority:      byPriority as Record<ResourcePriority, number>,
    byRecommendation: byRec as Record<DownloadRecommendation, number>,
    resources,
    summary: `${resources.length} resources analyzed. ${downloads} to download, ${skips} to skip. Average RIS: ${avgScore}/100. Total estimated size: ${(totalBytes / 1024 / 1024).toFixed(1)} MB.`,
  };
}

function buildClassificationReport(
  jobId: string,
  resources: ResourceAnalysis[],
): ResourceClassificationReport {
  const group = (types: ResourceType[]): ResourceTypeGroup => {
    const filtered = resources.filter(r => types.includes(r.resourceType));
    const totalKb = filtered.reduce((s, r) => s + (r.estimatedStorageCostKb ?? 0), 0);
    const avgScore = filtered.length
      ? Math.round(filtered.reduce((s, r) => s + r.scores.resourceIntelligenceScore, 0) / filtered.length)
      : 0;
    return {
      type: types.length === 1 ? types[0]! : types,
      count: filtered.length,
      totalKb,
      avgScore,
      resources: filtered.map(r => ({
        url: r.url,
        estimatedBytes: r.estimatedBytes,
        priority: r.priority,
        scores: r.scores,
      })),
    };
  };

  const originGroups: OriginGroup[] = (["same-domain","subdomain","cdn","external","data-uri"] as ResourceOrigin[]).map(o => {
    const filtered = resources.filter(r => r.origin === o);
    const domains = [...new Set(filtered.map(r => r.externalDomain).filter(Boolean))] as string[];
    return {
      origin: o,
      count: filtered.length,
      domains,
      totalKb: filtered.reduce((s, r) => s + (r.estimatedStorageCostKb ?? 0), 0),
    };
  }).filter(g => g.count > 0);

  const mimeMap = new Map<string, { count: number; totalKb: number }>();
  for (const r of resources) {
    const mime = r.mimeType ?? "unknown";
    const existing = mimeMap.get(mime) ?? { count: 0, totalKb: 0 };
    mimeMap.set(mime, { count: existing.count + 1, totalKb: existing.totalKb + (r.estimatedStorageCostKb ?? 0) });
  }

  return {
    jobId,
    generatedAt: new Date().toISOString(),
    byCssClass:    group(["css"]),
    byJsClass:     group(["javascript"]),
    byImageClass:  group(["image","svg","ico"]),
    byFontClass:   group(["font"]),
    byMediaClass:  group(["video","audio"]),
    byDataClass:   group(["json","xml","api-endpoint","wasm"]),
    byOtherClass:  group(["pdf","document","html","other-static"]),
    originBreakdown: originGroups,
    mimeBreakdown: [...mimeMap.entries()]
      .map(([mimeType, d]) => ({ mimeType, ...d }))
      .sort((a, b) => b.count - a.count),
  };
}

function buildPriorityReport(
  jobId: string,
  resources: ResourceAnalysis[],
): ResourcePriorityReport {
  const bucket = (priority: ResourcePriority): PriorityBucket => {
    const filtered = resources.filter(r => r.priority === priority);
    return {
      count: filtered.length,
      totalKb: filtered.reduce((s, r) => s + (r.estimatedStorageCostKb ?? 0), 0),
      resources: filtered.map(r => ({
        url: r.url,
        resourceType: r.resourceType,
        scores: r.scores,
        downloadRecommendation: r.downloadRecommendation,
        tags: r.tags,
      })),
    };
  };

  const downloadPlan: DownloadPlanEntry[] = resources
    .filter(r => r.downloadRecommendation !== "SKIP")
    .slice(0, 100)
    .map((r, i) => ({
      rank: i + 1,
      url: r.url,
      resourceType: r.resourceType,
      priority: r.priority,
      downloadRecommendation: r.downloadRecommendation,
      estimatedKb: r.estimatedStorageCostKb,
      score: r.scores.resourceIntelligenceScore,
      reason: r.tags.length > 0
        ? r.tags.slice(0, 2).join(", ")
        : `${r.resourceType} from ${r.origin}`,
    }));

  return {
    jobId,
    generatedAt: new Date().toISOString(),
    critical: bucket("CRITICAL"),
    high:     bucket("HIGH"),
    medium:   bucket("MEDIUM"),
    low:      bucket("LOW"),
    skip:     bucket("SKIP"),
    downloadPlan,
  };
}

function buildRiskReport(
  jobId: string,
  resources: ResourceAnalysis[],
): ResourceRiskReport {
  const secScores = resources.map(r => r.scores.securityRisk);
  const crawlScores = resources.map(r => r.scores.crawlRisk);

  const riskSummary = (scores: number[]): RiskSummary => ({
    avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
    high:   scores.filter(s => s > 70).length,
    medium: scores.filter(s => s >= 40 && s <= 70).length,
    low:    scores.filter(s => s < 40).length,
  });

  const highRisk = resources
    .filter(r => r.scores.securityRisk > 50 || r.scores.crawlRisk > 60)
    .slice(0, 50)
    .map(r => ({
      url: r.url,
      resourceType: r.resourceType,
      scores: r.scores,
      tags: r.tags,
      remediations: r.remediations,
    }));

  const domainMap = new Map<string, {
    count: number; isCdn: boolean; isAnalytics: boolean; isAds: boolean;
    secRisks: number[]; crawlRisks: number[];
  }>();
  for (const r of resources) {
    const d = r.externalDomain;
    if (!d) continue;
    const ex = domainMap.get(d) ?? {
      count: 0, isCdn: r.origin === "cdn",
      isAnalytics: r.tags.includes("analytics"),
      isAds: r.tags.includes("advertising"),
      secRisks: [], crawlRisks: [],
    };
    ex.count++;
    ex.secRisks.push(r.scores.securityRisk);
    ex.crawlRisks.push(r.scores.crawlRisk);
    domainMap.set(d, ex);
  }

  const externalDomains: ExternalDomainRisk[] = [...domainMap.entries()].map(([domain, d]) => ({
    domain,
    resourceCount: d.count,
    isCdn: d.isCdn,
    isAnalytics: d.isAnalytics,
    isAds: d.isAds,
    avgSecurityRisk: d.secRisks.length ? Math.round(d.secRisks.reduce((a, b) => a + b, 0) / d.secRisks.length) : 0,
    avgCrawlRisk: d.crawlRisks.length ? Math.round(d.crawlRisks.reduce((a, b) => a + b, 0) / d.crawlRisks.length) : 0,
  })).sort((a, b) => b.resourceCount - a.resourceCount);

  const riskSignals: string[] = [];
  if (resources.some(r => r.tags.includes("analytics"))) riskSignals.push("Analytics/tracking scripts detected — include for risk profiling, exclude from reconstruction");
  if (resources.some(r => r.tags.includes("advertising"))) riskSignals.push("Ad scripts detected — high crawl risk; skip downloads");
  if (resources.some(r => r.scores.securityRisk > 70)) riskSignals.push("High-risk external scripts detected — add SRI hashes before referencing");
  if (resources.some(r => r.resourceType === "wasm")) riskSignals.push("WASM modules present — verify origin before execution");
  if (resources.some(r => r.resourceType === "json" && r.origin === "external")) riskSignals.push("External JSON sources — validate schema before consuming");

  const avgSec = secScores.length ? Math.round(secScores.reduce((a, b) => a + b, 0) / secScores.length) : 0;
  const avgCrawl = crawlScores.length ? Math.round(crawlScores.reduce((a, b) => a + b, 0) / crawlScores.length) : 0;
  const overallRisk = Math.round((avgSec + avgCrawl) / 2);

  const recommendations: string[] = [];
  if (avgSec > 40) recommendations.push("Add Content-Security-Policy header restricting external script origins");
  if (externalDomains.some(d => d.isAnalytics)) recommendations.push("Exclude analytics/tracking from reconstruction pipeline — reference original scripts");
  if (resources.filter(r => r.origin === "external").length > resources.length * 0.4)
    recommendations.push("High proportion of external resources (>40%) — consolidate or self-host critical assets");
  recommendations.push("Run SRI (Subresource Integrity) check on all external scripts before production deployment");

  return {
    jobId,
    generatedAt: new Date().toISOString(),
    overallRiskScore: overallRisk,
    securitySummary: riskSummary(secScores),
    crawlSummary: riskSummary(crawlScores),
    highRiskResources: highRisk,
    externalDomains,
    riskSignals,
    recommendations,
  };
}

// ── R2 storage ────────────────────────────────────────────────────────────────

async function storeReport(jobId: string, filename: string, data: unknown): Promise<string | null> {
  const provider = createCloudProvider("r2");
  if (!provider.isConfigured()) return null;
  const key = `ri1/${jobId}/${filename}`;
  try {
    await provider.upload({
      key,
      data: Buffer.from(JSON.stringify(data, null, 2), "utf-8"),
      contentType: "application/json",
      checkDuplicate: false,
    });
    return key;
  } catch (err) {
    logger.warn({ jobId, key, err }, "RI-1: failed to store report to R2");
    return null;
  }
}

// ── In-memory cache ───────────────────────────────────────────────────────────

interface RiCache {
  intelligence:    ResourceIntelligenceReport;
  classification:  ResourceClassificationReport;
  priority:        ResourcePriorityReport;
  risk:            ResourceRiskReport;
  r2Keys:          string[];
}

const cache = new Map<string, RiCache>();

export function getCachedRiReports(jobId: string): RiCache | null {
  return cache.get(jobId) ?? null;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runResourceIntelligence(jobId: string): Promise<RiCache> {
  const startMs = Date.now();
  logger.info({ jobId }, "RI-1: starting resource intelligence analysis");

  const manifest = await loadManifest(jobId);
  if (!manifest) throw new Error(`Manifest not found for job ${jobId}`);

  const nodesArray: PageNode[] = manifest.nodes instanceof Map
    ? [...manifest.nodes.values()]
    : (Object.values(manifest.nodes ?? {}) as PageNode[]);
  const seedUrl = manifest.seedUrl ?? nodesArray[0]?.metadata?.url ?? "";
  const nodes = nodesArray;

  const allRaw: RawResource[] = [];

  for (const node of nodes) {
    const pageUrl = node.metadata?.url ?? "";

    // MediaItems from manifest (already discovered by scraper)
    for (const img of node.media?.images ?? []) {
      allRaw.push({
        url: img.sourceUrl,
        mimeType: img.mimeType,
        byteSize: img.byteSize ?? null,
        discoveredOn: pageUrl,
        positionInPage: img.positionInPage ?? 99,
        sourceElement: img.sourceElement,
      });
    }
    for (const vid of node.media?.videos ?? []) {
      allRaw.push({
        url: vid.sourceUrl,
        mimeType: vid.mimeType ?? "video/mp4",
        byteSize: vid.byteSize ?? null,
        discoveredOn: pageUrl,
        positionInPage: 60,
      });
    }

    // CSS/JS/fonts from cleanHtml
    const html = node.content?.cleanHtml ?? "";
    if (html) {
      const htmlResources = extractResourcesFromHtml(html, pageUrl);
      allRaw.push(...htmlResources);
    }
  }

  logger.info({ jobId, rawCount: allRaw.length }, "RI-1: raw resources collected");

  const resources = analyzeResources(allRaw, seedUrl);
  const intelligenceReport = buildIntelligenceReport(jobId, seedUrl, resources);
  const classificationReport = buildClassificationReport(jobId, resources);
  const priorityReport = buildPriorityReport(jobId, resources);
  const riskReport = buildRiskReport(jobId, resources);

  const r2Keys: string[] = [];
  const [k1, k2, k3, k4] = await Promise.all([
    storeReport(jobId, "resource-intelligence-report.json", intelligenceReport),
    storeReport(jobId, "resource-classification-report.json", classificationReport),
    storeReport(jobId, "resource-priority-report.json", priorityReport),
    storeReport(jobId, "resource-risk-report.json", riskReport),
  ]);
  if (k1) r2Keys.push(k1);
  if (k2) r2Keys.push(k2);
  if (k3) r2Keys.push(k3);
  if (k4) r2Keys.push(k4);

  const result: RiCache = { intelligence: intelligenceReport, classification: classificationReport, priority: priorityReport, risk: riskReport, r2Keys };
  cache.set(jobId, result);

  logger.info({
    jobId,
    totalResources: resources.length,
    durationMs: Date.now() - startMs,
    r2Keys: r2Keys.length,
  }, "RI-1: resource intelligence complete");

  return result;
}

// ── Single-resource evaluation (pre-download gate) ────────────────────────────

export function evaluateSingleResource(
  url: string,
  seedUrl: string,
  mimeType?: string | null,
  byteSize?: number | null,
): ResourceAnalysis {
  const raw: RawResource = { url, mimeType, byteSize, discoveredOn: seedUrl };
  const [result] = analyzeResources([raw], seedUrl);
  return result!;
}

// ── Batch evaluation (pre-download gate for URL lists) ────────────────────────

export function evaluateResourceBatch(
  urls: Array<{ url: string; mimeType?: string | null; byteSize?: number | null }>,
  seedUrl: string,
): ResourceAnalysis[] {
  const raw: RawResource[] = urls.map(u => ({ ...u, discoveredOn: seedUrl }));
  return analyzeResources(raw, seedUrl);
}

// ── Pre-download gate convenience function ───────────────────────────────────
// Called by the scraper before every fetchMediaWithRetry to make the
// download/reference/skip decision via the unified RI-1 decision framework.

export interface DownloadGateResult {
  download:       boolean;
  recommendation: DownloadRecommendation;
  priority:       ResourcePriority;
  score:          number;
  skipReason:     string | null;
  tags:           string[];
}

export function shouldDownloadResource(
  url: string,
  seedUrl: string,
  mimeType?: string | null,
  byteSize?: number | null,
): DownloadGateResult {
  const analysis = evaluateSingleResource(url, seedUrl, mimeType, byteSize);
  return {
    download:       analysis.downloadRecommendation === "DOWNLOAD",
    recommendation: analysis.downloadRecommendation,
    priority:       analysis.priority,
    score:          analysis.scores.resourceIntelligenceScore,
    skipReason:     analysis.skipReason,
    tags:           analysis.tags,
  };
}

// ── Post-Phase-1 fire-and-forget analysis trigger ────────────────────────────
// Called immediately after Phase 1 HTML discovery completes (before Phase 2
// media downloads begin). Runs RI-1 against the fully-populated manifest and
// caches results in memory; never throws so it cannot block the scrape pipeline.

export function triggerResourceIntelligenceAsync(jobId: string): void {
  runResourceIntelligence(jobId).catch((err: unknown) => {
    logger.warn({ jobId, err }, "RI-1: background analysis failed (non-fatal)");
  });
}

// Re-export extractor for external callers that need per-page HTML scanning
export { extractResourcesFromHtml };
