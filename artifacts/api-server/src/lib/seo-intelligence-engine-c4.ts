/**
 * seo-intelligence-engine-c4.ts — Phase C4: SEO & Search Intelligence Engine
 *
 * Prepares Website Prime for production search visibility by analyzing every
 * page node in the manifest via cheerio HTML parsing.
 *
 * Generates:
 *   XML Sitemap, Robots.txt, Canonical URLs, OpenGraph metadata,
 *   Twitter Cards, Structured Data (JSON-LD), Breadcrumb schema,
 *   Meta descriptions, Page titles
 *
 * Detects:
 *   Missing/duplicate metadata, broken canonical links, missing alt text,
 *   heading hierarchy issues
 *
 * Produces (stored in R2):
 *   seo-report.json
 *   structured-data-report.json
 *   metadata-report.json
 *   search-readiness-report.json
 *   sitemap.xml
 *   robots.txt
 */

import * as cheerio from "cheerio";
import { logger } from "./logger.js";
import { loadManifest } from "./manifest-store.js";
import { createCloudProvider } from "../cloud/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeR2Key(jobId: string, filename: string): string {
  return `c4/${jobId}/${filename}`;
}

async function storeToR2(
  jobId: string,
  filename: string,
  data: unknown,
  contentType = "application/json",
): Promise<string> {
  const key = makeR2Key(jobId, filename);
  const provider = createCloudProvider("r2");
  if (!provider.isConfigured()) {
    logger.warn({ jobId, filename }, "C4: R2 not configured — skipping upload");
    return key;
  }
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const buf = Buffer.from(body, "utf-8");
  await provider.upload({ key, data: buf, contentType, checkDuplicate: false });
  logger.info({ jobId, key }, "C4: artifact stored to R2");
  return key;
}

function normalizeUrl(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

// ── Per-page extraction ───────────────────────────────────────────────────────

export interface HeadingNode {
  level: number;
  text: string;
}

export interface StructuredDataItem {
  type: string;       // e.g. "Article", "BreadcrumbList", "Product"
  raw: unknown;
  valid: boolean;
  issues: string[];
}

export interface ImageAltAudit {
  src: string;
  alt: string | null;
  hasAlt: boolean;
  isDecorative: boolean; // alt="" is intentionally decorative
}

export interface PageSeoData {
  url: string;
  title: string | null;
  titleLength: number | null;
  description: string | null;
  descriptionLength: number | null;
  canonical: string | null;
  robotsMeta: string | null;
  isIndexable: boolean;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  ogUrl: string | null;
  ogType: string | null;
  ogSiteName: string | null;
  twitterCard: string | null;
  twitterTitle: string | null;
  twitterDescription: string | null;
  twitterImage: string | null;
  twitterSite: string | null;
  headings: HeadingNode[];
  h1Count: number;
  hasProperHeadingHierarchy: boolean;
  headingHierarchyIssues: string[];
  images: ImageAltAudit[];
  imagesWithoutAlt: number;
  imagesWithEmptyAlt: number;
  internalLinks: string[];
  externalLinks: string[];
  structuredData: StructuredDataItem[];
  wordCount: number;
  lang: string | null;
  viewport: string | null;
  charset: string | null;
  issues: SeoIssue[];
}

export interface SeoIssue {
  code: string;
  severity: "critical" | "warning" | "info";
  message: string;
}

// ── HTML parser ───────────────────────────────────────────────────────────────

function parseStructuredData($: cheerio.CheerioAPI): StructuredDataItem[] {
  const items: StructuredDataItem[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const text = $(el).text();
      if (!text.trim()) return;
      const raw = JSON.parse(text) as unknown;
      const entries: unknown[] = Array.isArray(raw) ? raw : [raw];
      for (const entry of entries) {
        const e = entry as Record<string, unknown>;
        const type = e["@type"] ?? "Unknown";
        const issues: string[] = [];
        if (!e["@context"]) issues.push('Missing @context (expected "https://schema.org")');
        if (!e["@type"])    issues.push("Missing @type");
        items.push({ type: String(type), raw: e, valid: issues.length === 0, issues });
      }
    } catch {
      items.push({ type: "ParseError", raw: null, valid: false, issues: ["Invalid JSON in <script type=application/ld+json>"] });
    }
  });
  return items;
}

function checkHeadingHierarchy(headings: HeadingNode[]): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (headings.length === 0) return { ok: true, issues: [] };

  const h1s = headings.filter(h => h.level === 1);
  if (h1s.length === 0) issues.push("No H1 found — every page should have exactly one H1");
  if (h1s.length > 1)   issues.push(`${h1s.length} H1 tags found — only one H1 is recommended`);

  // Check for skipped heading levels
  let prev = 0;
  for (const h of headings) {
    if (prev > 0 && h.level > prev + 1) {
      issues.push(`Heading level skip: H${prev} → H${h.level} ("${h.text.slice(0, 40)}")`);
    }
    prev = h.level;
  }

  return { ok: issues.length === 0, issues };
}

function extractPageSeo(node: { id: string; content: { cleanHtml: string; wordCount: number }; metadata: { url: string; title: string; description: string | null }; media: { images: Array<{ normalizedUrl: string | null; sourceUrl: string; altText: string | null }> } }, seedDomain: string): PageSeoData {
  const url = node.metadata.url || node.id;
  const html = node.content.cleanHtml ?? "";

  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html, { xml: false });
  } catch {
    // Return minimal data if parsing fails
    return {
      url, title: node.metadata.title, titleLength: node.metadata.title?.length ?? null,
      description: node.metadata.description, descriptionLength: node.metadata.description?.length ?? null,
      canonical: null, robotsMeta: null, isIndexable: true,
      ogTitle: null, ogDescription: null, ogImage: null, ogUrl: null, ogType: null, ogSiteName: null,
      twitterCard: null, twitterTitle: null, twitterDescription: null, twitterImage: null, twitterSite: null,
      headings: [], h1Count: 0, hasProperHeadingHierarchy: false, headingHierarchyIssues: ["HTML parse failed"],
      images: [], imagesWithoutAlt: 0, imagesWithEmptyAlt: 0,
      internalLinks: [], externalLinks: [], structuredData: [], wordCount: node.content.wordCount ?? 0,
      lang: null, viewport: null, charset: null, issues: [],
    };
  }

  // Basic meta
  const title        = $("title").first().text().trim() || node.metadata.title || null;
  const description  = $('meta[name="description"]').attr("content")?.trim() ?? node.metadata.description ?? null;
  const canonical    = $('link[rel="canonical"]').attr("href")?.trim() ?? null;
  const robotsMeta   = $('meta[name="robots"]').attr("content")?.trim() ?? null;
  const isIndexable  = !robotsMeta || (!robotsMeta.includes("noindex") && !robotsMeta.includes("none"));
  const lang         = $("html").attr("lang")?.trim() ?? null;
  const viewport     = $('meta[name="viewport"]').attr("content")?.trim() ?? null;
  const charset      = $("meta[charset]").attr("charset")?.trim() ?? $('meta[http-equiv="Content-Type"]').attr("content")?.match(/charset=([^\s;]+)/i)?.[1] ?? null;

  // OG
  const ogTitle       = $('meta[property="og:title"]').attr("content")?.trim() ?? null;
  const ogDescription = $('meta[property="og:description"]').attr("content")?.trim() ?? null;
  const ogImage       = $('meta[property="og:image"]').attr("content")?.trim() ?? null;
  const ogUrl         = $('meta[property="og:url"]').attr("content")?.trim() ?? null;
  const ogType        = $('meta[property="og:type"]').attr("content")?.trim() ?? null;
  const ogSiteName    = $('meta[property="og:site_name"]').attr("content")?.trim() ?? null;

  // Twitter
  const twitterCard        = $('meta[name="twitter:card"]').attr("content")?.trim() ?? null;
  const twitterTitle       = $('meta[name="twitter:title"]').attr("content")?.trim() ?? null;
  const twitterDescription = $('meta[name="twitter:description"]').attr("content")?.trim() ?? null;
  const twitterImage       = $('meta[name="twitter:image"]').attr("content")?.trim() ?? null;
  const twitterSite        = $('meta[name="twitter:site"]').attr("content")?.trim() ?? null;

  // Headings
  const headings: HeadingNode[] = [];
  $("h1,h2,h3,h4,h5,h6").each((_, el) => {
    const level = parseInt(el.tagName.slice(1), 10);
    const text  = $(el).text().trim().replace(/\s+/g, " ").slice(0, 120);
    headings.push({ level, text });
  });
  const h1Count = headings.filter(h => h.level === 1).length;
  const { ok: hasProperHeadingHierarchy, issues: headingHierarchyIssues } = checkHeadingHierarchy(headings);

  // Images — combine cheerio-parsed + manifest media items
  const imageMap = new Map<string, ImageAltAudit>();
  $("img").each((_, el) => {
    const src = $(el).attr("src") ?? $(el).attr("data-src") ?? "";
    if (!src) return;
    const resolvedSrc = normalizeUrl(src, url);
    const alt = $(el).attr("alt") ?? null;
    imageMap.set(resolvedSrc, {
      src: resolvedSrc,
      alt,
      hasAlt: alt !== null,
      isDecorative: alt === "",
    });
  });
  // Also include manifest media images (may have richer data)
  for (const img of node.media.images) {
    const src = img.normalizedUrl ?? img.sourceUrl;
    if (src && !imageMap.has(src)) {
      imageMap.set(src, {
        src,
        alt: img.altText ?? null,
        hasAlt: img.altText !== null,
        isDecorative: img.altText === "",
      });
    }
  }
  const images = [...imageMap.values()];
  const imagesWithoutAlt  = images.filter(i => !i.hasAlt && !i.isDecorative).length;
  const imagesWithEmptyAlt = images.filter(i => i.isDecorative).length;

  // Links
  const internalLinks: string[] = [];
  const externalLinks: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
    try {
      const resolved = new URL(href, url).href;
      const domain   = new URL(resolved).hostname;
      if (domain === seedDomain) internalLinks.push(resolved);
      else externalLinks.push(resolved);
    } catch { /* relative or invalid */ }
  });

  // Structured data
  const structuredData = parseStructuredData($);

  // Issue detection
  const issues: SeoIssue[] = [];

  if (!title) issues.push({ code: "MISSING_TITLE", severity: "critical", message: "Page has no <title> tag" });
  else if (title.length < 10) issues.push({ code: "TITLE_TOO_SHORT", severity: "warning", message: `Title is only ${title.length} chars (recommended: 30-60)` });
  else if (title.length > 60) issues.push({ code: "TITLE_TOO_LONG", severity: "warning", message: `Title is ${title.length} chars (recommended: 30-60)` });

  if (!description) issues.push({ code: "MISSING_META_DESCRIPTION", severity: "critical", message: "Missing meta description" });
  else if (description.length < 50) issues.push({ code: "DESCRIPTION_TOO_SHORT", severity: "warning", message: `Meta description is only ${description.length} chars (recommended: 120-160)` });
  else if (description.length > 160) issues.push({ code: "DESCRIPTION_TOO_LONG", severity: "warning", message: `Meta description is ${description.length} chars (recommended: 120-160)` });

  if (!canonical) issues.push({ code: "MISSING_CANONICAL", severity: "warning", message: "No canonical URL specified — set <link rel=canonical> to prevent duplicate content issues" });
  else if (canonical !== url) issues.push({ code: "CANONICAL_MISMATCH", severity: "warning", message: `Canonical (${canonical}) does not match page URL (${url})` });

  if (!ogTitle)       issues.push({ code: "MISSING_OG_TITLE",       severity: "warning", message: "Missing og:title — social sharing will use page title fallback" });
  if (!ogDescription) issues.push({ code: "MISSING_OG_DESCRIPTION", severity: "warning", message: "Missing og:description" });
  if (!ogImage)       issues.push({ code: "MISSING_OG_IMAGE",       severity: "warning", message: "Missing og:image — social previews will show no image" });
  if (!twitterCard)   issues.push({ code: "MISSING_TWITTER_CARD",   severity: "info",    message: "Missing twitter:card — Twitter will infer card type" });

  if (!viewport) issues.push({ code: "MISSING_VIEWPORT", severity: "warning", message: "Missing viewport meta tag — page may not render correctly on mobile" });
  if (!lang)     issues.push({ code: "MISSING_LANG",     severity: "warning", message: "Missing lang attribute on <html> — required for accessibility and SEO" });

  if (h1Count === 0) issues.push({ code: "MISSING_H1",      severity: "critical", message: "No H1 heading found" });
  if (h1Count > 1)   issues.push({ code: "MULTIPLE_H1",     severity: "warning",  message: `${h1Count} H1 tags found — should be exactly one` });
  for (const hi of headingHierarchyIssues) {
    if (!hi.includes("H1")) issues.push({ code: "HEADING_HIERARCHY", severity: "warning", message: hi });
  }

  if (imagesWithoutAlt > 0) issues.push({ code: "IMAGES_MISSING_ALT", severity: "warning", message: `${imagesWithoutAlt} image(s) missing alt text` });

  if (structuredData.length === 0) issues.push({ code: "NO_STRUCTURED_DATA", severity: "info", message: "No JSON-LD structured data found — consider adding Article, BreadcrumbList, or WebPage schema" });

  return {
    url, title, titleLength: title?.length ?? null,
    description, descriptionLength: description?.length ?? null,
    canonical, robotsMeta, isIndexable,
    ogTitle, ogDescription, ogImage, ogUrl, ogType, ogSiteName,
    twitterCard, twitterTitle, twitterDescription, twitterImage, twitterSite,
    headings, h1Count, hasProperHeadingHierarchy, headingHierarchyIssues,
    images, imagesWithoutAlt, imagesWithEmptyAlt,
    internalLinks: [...new Set(internalLinks)],
    externalLinks: [...new Set(externalLinks)],
    structuredData,
    wordCount: node.content.wordCount ?? 0,
    lang, viewport, charset, issues,
  };
}

// ── Report shapes ─────────────────────────────────────────────────────────────

export interface SeoReport {
  jobId: string;
  generatedAt: string;
  pagesAnalyzed: number;
  indexablePages: number;
  pages: PageSeoData[];
  issues: {
    critical: number;
    warning: number;
    info: number;
    total: number;
    byCodes: Record<string, number>;
  };
  duplicateTitles: Array<{ title: string; urls: string[] }>;
  duplicateDescriptions: Array<{ description: string; urls: string[] }>;
  duplicateCanonicals: Array<{ canonical: string; urls: string[] }>;
  missingAltCount: number;
  overallScore: number; // 0–100
}

export interface StructuredDataReport {
  jobId: string;
  generatedAt: string;
  pagesWithStructuredData: number;
  pagesWithoutStructuredData: number;
  allItems: Array<{ url: string; type: string; valid: boolean; issues: string[] }>;
  typeBreakdown: Record<string, number>;
  validItems: number;
  invalidItems: number;
  recommendations: string[];
}

export interface MetadataReport {
  jobId: string;
  generatedAt: string;
  pages: Array<{
    url: string;
    title: string | null;
    description: string | null;
    canonical: string | null;
    isIndexable: boolean;
    ogTitle: string | null;
    ogDescription: string | null;
    ogImage: string | null;
    twitterCard: string | null;
    lang: string | null;
    viewport: string | null;
    hasStructuredData: boolean;
  }>;
  coverage: {
    title: number;
    description: number;
    canonical: number;
    ogTitle: number;
    ogDescription: number;
    ogImage: number;
    twitterCard: number;
    lang: number;
    viewport: number;
    structuredData: number;
  };
}

export interface SearchReadinessReport {
  jobId: string;
  generatedAt: string;
  overallScore: number;    // 0–100
  overallRating: "excellent" | "good" | "needs-improvement" | "poor";
  sitemapR2Key: string;
  robotsTxtR2Key: string;
  sitemap: {
    urlCount: number;
    xml: string;
  };
  robotsTxt: {
    content: string;
  };
  canonicalCoverage: number;    // %
  metaDescriptionCoverage: number;
  ogCoverage: number;
  structuredDataCoverage: number;
  indexablePageCount: number;
  totalPageCount: number;
  criticalIssueCount: number;
  recommendations: Array<{ priority: "critical" | "high" | "medium" | "low"; message: string }>;
}

export interface C4Bundle {
  jobId: string;
  generatedAt: string;
  seoReport: SeoReport;
  structuredDataReport: StructuredDataReport;
  metadataReport: MetadataReport;
  searchReadinessReport: SearchReadinessReport;
  r2Keys: {
    seoReport: string;
    structuredDataReport: string;
    metadataReport: string;
    searchReadinessReport: string;
    sitemap: string;
    robotsTxt: string;
  };
}

// ── In-memory store ───────────────────────────────────────────────────────────

const _store = new Map<string, C4Bundle>();

export function getC4Bundle(jobId: string): C4Bundle | undefined { return _store.get(jobId); }
export function listC4Bundles(): Array<{ jobId: string; generatedAt: string }> {
  return [..._store.values()].map(b => ({ jobId: b.jobId, generatedAt: b.generatedAt }));
}

// ── Report builders ───────────────────────────────────────────────────────────

function buildSeoReport(jobId: string, pages: PageSeoData[], now: string): SeoReport {
  const allIssues = pages.flatMap(p => p.issues);
  const byCodes: Record<string, number> = {};
  for (const i of allIssues) byCodes[i.code] = (byCodes[i.code] ?? 0) + 1;

  // Duplicate detection
  const titleMap = new Map<string, string[]>();
  const descMap  = new Map<string, string[]>();
  const canonMap = new Map<string, string[]>();
  for (const p of pages) {
    if (p.title) { const arr = titleMap.get(p.title) ?? []; arr.push(p.url); titleMap.set(p.title, arr); }
    if (p.description) { const arr = descMap.get(p.description) ?? []; arr.push(p.url); descMap.set(p.description, arr); }
    if (p.canonical) { const arr = canonMap.get(p.canonical) ?? []; arr.push(p.url); canonMap.set(p.canonical, arr); }
  }
  const duplicateTitles       = [...titleMap.entries()].filter(([,v]) => v.length > 1).map(([t,u]) => ({ title: t, urls: u }));
  const duplicateDescriptions = [...descMap.entries()].filter(([,v])  => v.length > 1).map(([d,u]) => ({ description: d, urls: u }));
  const duplicateCanonicals   = [...canonMap.entries()].filter(([,v]) => v.length > 1).map(([c,u]) => ({ canonical: c, urls: u }));

  const criticalCount = allIssues.filter(i => i.severity === "critical").length;
  const warningCount  = allIssues.filter(i => i.severity === "warning").length;
  const infoCount     = allIssues.filter(i => i.severity === "info").length;
  const missingAltCount = pages.reduce((s, p) => s + p.imagesWithoutAlt, 0);
  const indexablePages  = pages.filter(p => p.isIndexable).length;

  // Score: start at 100, deduct per issue severity
  const deductions = criticalCount * 15 + warningCount * 5 + duplicateTitles.length * 8 + duplicateDescriptions.length * 5 + (missingAltCount > 0 ? Math.min(missingAltCount * 2, 20) : 0);
  const overallScore = Math.max(0, Math.min(100, 100 - deductions));

  return {
    jobId, generatedAt: now, pagesAnalyzed: pages.length, indexablePages,
    pages,
    issues: { critical: criticalCount, warning: warningCount, info: infoCount, total: allIssues.length, byCodes },
    duplicateTitles, duplicateDescriptions, duplicateCanonicals,
    missingAltCount, overallScore,
  };
}

function buildStructuredDataReport(jobId: string, pages: PageSeoData[], now: string): StructuredDataReport {
  const pagesWithSD    = pages.filter(p => p.structuredData.length > 0).length;
  const pagesWithoutSD = pages.length - pagesWithSD;
  const typeBreakdown: Record<string, number> = {};
  const allItems: Array<{ url: string; type: string; valid: boolean; issues: string[] }> = [];
  let valid = 0, invalid = 0;

  for (const p of pages) {
    for (const sd of p.structuredData) {
      typeBreakdown[sd.type] = (typeBreakdown[sd.type] ?? 0) + 1;
      allItems.push({ url: p.url, type: sd.type, valid: sd.valid, issues: sd.issues });
      if (sd.valid) valid++; else invalid++;
    }
  }

  const recommendations: string[] = [];
  if (!typeBreakdown["BreadcrumbList"]) recommendations.push("Add BreadcrumbList schema to all interior pages to enable breadcrumb rich results in Google Search.");
  if (!typeBreakdown["Organization"] && !typeBreakdown["LocalBusiness"]) recommendations.push("Add Organization or LocalBusiness schema to the homepage.");
  if (!typeBreakdown["WebSite"]) recommendations.push("Add WebSite schema with a SearchAction to enable Sitelinks Search Box in Google.");
  if (!typeBreakdown["Article"] && !typeBreakdown["BlogPosting"] && !typeBreakdown["NewsArticle"]) recommendations.push("Add Article/BlogPosting schema to blog/editorial pages for enhanced snippets.");
  if (!typeBreakdown["FAQPage"] && pages.length > 3) recommendations.push("Consider adding FAQPage schema to high-value landing pages to earn rich FAQ snippets.");
  if (invalid > 0) recommendations.push(`Fix ${invalid} invalid structured data item(s) — validation errors prevent rich result eligibility.`);

  return { jobId, generatedAt: now, pagesWithStructuredData: pagesWithSD, pagesWithoutStructuredData: pagesWithoutSD, allItems, typeBreakdown, validItems: valid, invalidItems: invalid, recommendations };
}

function buildMetadataReport(jobId: string, pages: PageSeoData[], now: string): MetadataReport {
  const n = pages.length || 1;
  const pct = (count: number) => Math.round((count / n) * 100);

  return {
    jobId, generatedAt: now,
    pages: pages.map(p => ({
      url: p.url,
      title: p.title, description: p.description, canonical: p.canonical,
      isIndexable: p.isIndexable,
      ogTitle: p.ogTitle, ogDescription: p.ogDescription, ogImage: p.ogImage,
      twitterCard: p.twitterCard, lang: p.lang, viewport: p.viewport,
      hasStructuredData: p.structuredData.length > 0,
    })),
    coverage: {
      title:          pct(pages.filter(p => !!p.title).length),
      description:    pct(pages.filter(p => !!p.description).length),
      canonical:      pct(pages.filter(p => !!p.canonical).length),
      ogTitle:        pct(pages.filter(p => !!p.ogTitle).length),
      ogDescription:  pct(pages.filter(p => !!p.ogDescription).length),
      ogImage:        pct(pages.filter(p => !!p.ogImage).length),
      twitterCard:    pct(pages.filter(p => !!p.twitterCard).length),
      lang:           pct(pages.filter(p => !!p.lang).length),
      viewport:       pct(pages.filter(p => !!p.viewport).length),
      structuredData: pct(pages.filter(p => p.structuredData.length > 0).length),
    },
  };
}

function buildSitemap(pages: PageSeoData[], seedUrl: string, now: string): string {
  const indexable = pages.filter(p => p.isIndexable);
  const lastmod   = now.slice(0, 10);

  // Assign priority: root gets 1.0, depth-1 gets 0.8, deeper gets 0.6
  function priority(url: string): string {
    try {
      const path = new URL(url).pathname.replace(/\/$/, "");
      const depth = path.split("/").filter(Boolean).length;
      if (depth === 0) return "1.0";
      if (depth === 1) return "0.8";
      return "0.6";
    } catch { return "0.6"; }
  }

  const urlEntries = indexable.map(p => `  <url>
    <loc>${escapeXml(p.canonical ?? p.url)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${priority(p.canonical ?? p.url)}</priority>
  </url>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9
        http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">
${urlEntries}
</urlset>`;
}

function escapeXml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function buildRobotsTxt(seedUrl: string, jobId: string, sitemapR2Url: string): string {
  const domain = extractDomain(seedUrl);
  return `# robots.txt — generated by Website Prime (Phase C4)
# Domain: ${domain}

User-agent: *
Allow: /

# Disallow common non-content paths
Disallow: /admin/
Disallow: /wp-admin/
Disallow: /login/
Disallow: /logout/
Disallow: /api/
Disallow: /*.json$
Disallow: /search?*

# Crawl-delay for aggressive crawlers
User-agent: AhrefsBot
Crawl-delay: 10

User-agent: SemrushBot
Crawl-delay: 10

# Sitemap
Sitemap: ${sitemapR2Url}
`;
}

function buildBreadcrumbSchema(pages: PageSeoData[], seedUrl: string): string | null {
  // Only generate for pages with path depth > 0
  const breadcrumbPages = pages.filter(p => {
    try { return new URL(p.url).pathname.split("/").filter(Boolean).length > 0; } catch { return false; }
  });
  if (breadcrumbPages.length === 0) return null;

  const items = breadcrumbPages.map((p, idx) => {
    const pathParts = (() => { try { return new URL(p.url).pathname.split("/").filter(Boolean); } catch { return []; } })();
    const listItems = [{ "@type": "ListItem", "position": 1, "name": "Home", "item": seedUrl }];
    let built = seedUrl.replace(/\/$/, "");
    for (let i = 0; i < pathParts.length; i++) {
      built += "/" + pathParts[i];
      listItems.push({
        "@type": "ListItem",
        "position": i + 2,
        "name": pathParts[i]!.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
        "item": built,
      });
    }
    return { "@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": listItems };
  });

  return JSON.stringify(items, null, 2);
}

function buildSearchReadinessReport(
  jobId: string,
  pages: PageSeoData[],
  seo: SeoReport,
  sitemap: string,
  robotsTxt: string,
  sitemapR2Key: string,
  robotsTxtR2Key: string,
  now: string,
): SearchReadinessReport {
  const n = pages.length || 1;
  const pct = (count: number) => Math.round((count / n) * 100);

  const canonicalCoverage     = pct(pages.filter(p => !!p.canonical).length);
  const metaDescCoverage      = pct(pages.filter(p => !!p.description).length);
  const ogCoverage            = pct(pages.filter(p => !!p.ogTitle && !!p.ogDescription && !!p.ogImage).length);
  const structuredDataCoverage = pct(pages.filter(p => p.structuredData.length > 0).length);
  const indexablePageCount    = pages.filter(p => p.isIndexable).length;

  const recommendations: SearchReadinessReport["recommendations"] = [];

  if (seo.issues.critical > 0) {
    recommendations.push({ priority: "critical", message: `Fix ${seo.issues.critical} critical SEO issue(s) before production launch` });
  }
  if (seo.duplicateTitles.length > 0) {
    recommendations.push({ priority: "high", message: `Resolve ${seo.duplicateTitles.length} duplicate page title(s) — Google may choose arbitrary title for search results` });
  }
  if (seo.duplicateDescriptions.length > 0) {
    recommendations.push({ priority: "high", message: `Resolve ${seo.duplicateDescriptions.length} duplicate meta description(s)` });
  }
  if (canonicalCoverage < 100) {
    recommendations.push({ priority: "high", message: `Add canonical URLs to ${pages.length - pages.filter(p => !!p.canonical).length} page(s) — prevents duplicate content penalties` });
  }
  if (metaDescCoverage < 100) {
    recommendations.push({ priority: "high", message: `Add meta descriptions to ${pages.length - pages.filter(p => !!p.description).length} page(s) — impacts click-through rate from search` });
  }
  if (ogCoverage < 80) {
    recommendations.push({ priority: "medium", message: `Complete OpenGraph metadata on ${pages.length - pages.filter(p => !!p.ogTitle && !!p.ogDescription && !!p.ogImage).length} page(s) for social sharing` });
  }
  if (structuredDataCoverage < 50) {
    recommendations.push({ priority: "medium", message: `Add structured data to ${pages.filter(p => p.structuredData.length === 0).length} page(s) to enable rich results` });
  }
  if (seo.missingAltCount > 0) {
    recommendations.push({ priority: "medium", message: `Add alt text to ${seo.missingAltCount} image(s) — required for image SEO and accessibility` });
  }
  if (indexablePageCount < pages.length) {
    const blocked = pages.length - indexablePageCount;
    recommendations.push({ priority: "high", message: `${blocked} page(s) are noindexed — verify this is intentional` });
  }
  if (pages.filter(p => !p.lang).length > 0) {
    recommendations.push({ priority: "medium", message: `Add lang attribute to HTML element on ${pages.filter(p => !p.lang).length} page(s)` });
  }

  // Scoring
  const baseScore = seo.overallScore;
  const sitemapBonus  = 5;
  const robotsBonus   = 3;
  const canonBonus    = canonicalCoverage >= 100 ? 5 : 0;
  const sdBonus       = structuredDataCoverage >= 50 ? 3 : 0;
  const overallScore  = Math.min(100, baseScore + sitemapBonus + robotsBonus + canonBonus + sdBonus);

  let overallRating: SearchReadinessReport["overallRating"] = "poor";
  if (overallScore >= 90) overallRating = "excellent";
  else if (overallScore >= 70) overallRating = "good";
  else if (overallScore >= 50) overallRating = "needs-improvement";

  return {
    jobId, generatedAt: now, overallScore, overallRating,
    sitemapR2Key, robotsTxtR2Key,
    sitemap: { urlCount: pages.filter(p => p.isIndexable).length, xml: sitemap },
    robotsTxt: { content: robotsTxt },
    canonicalCoverage, metaDescriptionCoverage: metaDescCoverage,
    ogCoverage, structuredDataCoverage, indexablePageCount, totalPageCount: pages.length,
    criticalIssueCount: seo.issues.critical, recommendations,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface C4Options {
  jobId: string;
}

export async function runSeoIntelligence(options: C4Options): Promise<C4Bundle> {
  const { jobId } = options;
  const now = new Date().toISOString();

  logger.info({ jobId }, "C4: starting SEO intelligence analysis");

  const manifest = await loadManifest(jobId);
  if (!manifest) throw new Error(`C4: manifest not found for jobId "${jobId}"`);

  const nodes = [...manifest.nodes.values()];
  if (nodes.length === 0) throw new Error(`C4: manifest for "${jobId}" has no page nodes`);

  const seedUrl  = manifest.seedUrl;
  const seedDomain = extractDomain(seedUrl);

  logger.info({ jobId, pageCount: nodes.length, seedDomain }, "C4: parsing page SEO data");

  // Extract SEO data from every page
  const pages: PageSeoData[] = nodes.map(n => extractPageSeo(n as Parameters<typeof extractPageSeo>[0], seedDomain));

  logger.info({ jobId }, "C4: building reports");

  // Build all reports
  const seoReport          = buildSeoReport(jobId, pages, now);
  const structuredDataReport = buildStructuredDataReport(jobId, pages, now);
  const metadataReport     = buildMetadataReport(jobId, pages, now);

  // Generate sitemap.xml and robots.txt
  const sitemapXml  = buildSitemap(pages, seedUrl, now);
  const breadcrumbs = buildBreadcrumbSchema(pages, seedUrl);

  // Store sitemap + robots.txt first to get their R2 keys for the readiness report
  const [sitemapKey, robotsTxtKey] = await Promise.all([
    storeToR2(jobId, "sitemap.xml", sitemapXml, "application/xml"),
    storeToR2(jobId, "robots.txt", buildRobotsTxt(seedUrl, jobId, `${process.env["R2_PUBLIC_BASE_URL"] ?? ""}/c4/${jobId}/sitemap.xml`), "text/plain"),
    ...(breadcrumbs ? [storeToR2(jobId, "breadcrumb-schema.json", breadcrumbs, "application/json")] : []),
  ]);

  const searchReadinessReport = buildSearchReadinessReport(
    jobId, pages, seoReport, sitemapXml,
    buildRobotsTxt(seedUrl, jobId, `${process.env["R2_PUBLIC_BASE_URL"] ?? ""}/c4/${jobId}/sitemap.xml`),
    sitemapKey!, robotsTxtKey!, now,
  );

  logger.info({ jobId }, "C4: storing JSON reports to R2");

  const [r2Seo, r2Sd, r2Meta, r2Readiness] = await Promise.all([
    storeToR2(jobId, "seo-report.json",            seoReport),
    storeToR2(jobId, "structured-data-report.json", structuredDataReport),
    storeToR2(jobId, "metadata-report.json",        metadataReport),
    storeToR2(jobId, "search-readiness-report.json", searchReadinessReport),
  ]);

  const bundle: C4Bundle = {
    jobId, generatedAt: now,
    seoReport, structuredDataReport, metadataReport, searchReadinessReport,
    r2Keys: {
      seoReport: r2Seo!,
      structuredDataReport: r2Sd!,
      metadataReport: r2Meta!,
      searchReadinessReport: r2Readiness!,
      sitemap: sitemapKey!,
      robotsTxt: robotsTxtKey!,
    },
  };

  _store.set(jobId, bundle);
  logger.info({ jobId, score: searchReadinessReport.overallScore, rating: searchReadinessReport.overallRating }, "C4: SEO intelligence complete");
  return bundle;
}
