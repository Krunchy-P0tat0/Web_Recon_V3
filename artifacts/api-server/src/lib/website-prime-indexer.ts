/**
 * website-prime-indexer.ts — Website Prime Indexing Engine
 *
 * Inputs (loaded from R2):
 *   - normalized-stencil-map.json  (Phase 6.7 output)
 *   - manifest.json                (crawl manifest)
 *
 * Outputs (fully static JSON, uploaded to R2):
 *   - prime-index/routeIndex.json    — route → page metadata map
 *   - prime-index/searchIndex.json   — flat array of searchable documents
 *   - prime-index/contentIndex.json  — content grouped by category/section
 *   - prime-index/websitePrimeIndex.json — master index (all three unified)
 *
 * Rules:
 *   - No backend calls in output — all indexes are static JSON
 *   - React/Vite compatible (no server-side rendering required)
 *   - Resilient: falls back gracefully when metadata is sparse
 */

import { logger } from "./logger";
import type { VisualStencilMap, StencilNodeEntry, VisualStencilType } from "./visual-stencil-mapper";

// ── Page category derived from stencil type ───────────────────────────────────

export type PageCategory =
  | "homepage"
  | "article"
  | "listing"
  | "feature"
  | "navigation"
  | "unknown";

// ── Navigation placement ──────────────────────────────────────────────────────

export type NavigationPlacement =
  | "primary"     // top-level nav (depth 0-1)
  | "secondary"   // depth 2, important sections
  | "breadcrumb"  // deep pages shown as breadcrumb trail
  | "footer"      // footer links (deep + article)
  | "unlisted";   // not in nav

// ── Individual indexed page ───────────────────────────────────────────────────

export interface IndexedPage {
  /** Unique identifier (nodeId from stencil map) */
  id:                  string;
  /** Canonical URL of the page */
  url:                 string;
  /** URL path (without domain) */
  route:               string;
  /** URL slug (last path segment) */
  slug:                string;
  /** Full slug hierarchy: ["", "blog", "my-post"] */
  hierarchy:           string[];
  /** Parent route (or null for root) */
  parentRoute:         string | null;
  /** Inferred page title */
  title:               string;
  /** Page category */
  category:            PageCategory;
  /** Stencil type this page maps to */
  stencilType:         VisualStencilType;
  /** Where this page appears in navigation */
  navigationPlacement: NavigationPlacement;
  /** Crawl depth */
  depth:               number;
  /** Word count estimate */
  wordCount:           number;
  /** Whether this page has navigation */
  hasNavigation:       boolean;
  /** Whether this page has a footer */
  hasFooter:           boolean;
  /** Whether this page is the root/hero */
  isRoot:              boolean;
  /** Child page routes */
  children:            string[];
  /** Tags derived from content signals */
  tags:                string[];
  /** Normalized layout tokens (from consistency engine) */
  normalizedLayout?:   Record<string, unknown>;
}

// ── Route index ───────────────────────────────────────────────────────────────

export interface RouteIndex {
  schemaVersion: "prime-1";
  jobId:         string;
  seedUrl:       string;
  generatedAt:   string;
  totalRoutes:   number;
  rootRoute:     string;
  routes:        Record<string, IndexedPage>;
}

// ── Search document ───────────────────────────────────────────────────────────

export interface SearchDocument {
  id:       string;
  route:    string;
  title:    string;
  slug:     string;
  category: PageCategory;
  tags:     string[];
  /** Searchable text blob (title + tags + category + slug) */
  text:     string;
}

export interface SearchIndex {
  schemaVersion: "prime-1";
  jobId:         string;
  generatedAt:   string;
  totalDocs:     number;
  documents:     SearchDocument[];
}

// ── Content index ─────────────────────────────────────────────────────────────

export interface ContentGroup {
  category:    PageCategory;
  label:       string;
  totalPages:  number;
  routes:      string[];
  /** Representative page (first root-level or most-linked page) */
  representative?: string;
}

export interface ContentSection {
  sectionRoute: string;
  title:        string;
  children:     string[];
}

export interface ContentIndex {
  schemaVersion:   "prime-1";
  jobId:           string;
  generatedAt:     string;
  byCategory:      Record<PageCategory, ContentGroup>;
  sections:        ContentSection[];
  navigationTree:  NavigationTreeNode[];
}

// ── Navigation tree node ──────────────────────────────────────────────────────

export interface NavigationTreeNode {
  route:    string;
  title:    string;
  slug:     string;
  depth:    number;
  children: NavigationTreeNode[];
}

// ── Master index ──────────────────────────────────────────────────────────────

export interface WebsitePrimeIndex {
  schemaVersion: "prime-1";
  jobId:         string;
  seedUrl:       string;
  generatedAt:   string;
  stats: {
    totalPages:       number;
    totalRoutes:      number;
    maxDepth:         number;
    categories:       Record<PageCategory, number>;
    navigationLevels: number;
  };
  routeIndex:   RouteIndex;
  searchIndex:  SearchIndex;
  contentIndex: ContentIndex;
}

// ── Crawl manifest shape (subset) ─────────────────────────────────────────────

interface CrawlManifest {
  seedUrl?:  string;
  baseUrl?:  string;
  url?:      string;
  pages?:    Array<{
    url?:       string;
    title?:     string;
    nodeId?:    string;
    wordCount?: number;
  }>;
  crawledUrls?: string[];
  results?: Array<{ url?: string; title?: string }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractRoute(url: string, seedUrl: string): string {
  try {
    const base  = new URL(seedUrl).origin;
    const full  = new URL(url, base);
    return full.pathname || "/";
  } catch {
    // If URL parsing fails, treat as path
    if (url.startsWith("http")) {
      try { return new URL(url).pathname; } catch { return "/"; }
    }
    return url.startsWith("/") ? url : `/${url}`;
  }
}

function extractSlug(route: string): string {
  if (route === "/") return "home";
  const parts = route.replace(/\/$/, "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "home";
}

function extractHierarchy(route: string): string[] {
  if (route === "/") return [""];
  return ["", ...route.replace(/\/$/, "").split("/").filter(Boolean)];
}

function extractParentRoute(route: string): string | null {
  if (route === "/") return null;
  const parts = route.replace(/\/$/, "").split("/").filter(Boolean);
  if (parts.length === 1) return "/";
  return "/" + parts.slice(0, -1).join("/");
}

function humanizeSlug(slug: string): string {
  return slug
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

function inferTitle(
  slug: string,
  stencilType: VisualStencilType,
  depth: number,
  manifestTitle?: string
): string {
  if (manifestTitle && manifestTitle.trim().length > 1) return manifestTitle.trim();
  if (slug === "home" || depth === 0) {
    const stencilLabels: Record<VisualStencilType, string> = {
      HeroSection:       "Home",
      ArticleLayout:     "Article",
      GridLayout:        "Index",
      FeatureBlock:      "Features",
      NavigationLayout:  "Site Map",
    };
    return stencilLabels[stencilType] ?? "Home";
  }
  return humanizeSlug(slug);
}

function inferCategory(stencilType: VisualStencilType, depth: number, route: string): PageCategory {
  if (depth === 0 || route === "/") return "homepage";
  switch (stencilType) {
    case "HeroSection":      return "homepage";
    case "ArticleLayout":    return "article";
    case "GridLayout":       return "listing";
    case "FeatureBlock":     return "feature";
    case "NavigationLayout": return "navigation";
    default:                 return "unknown";
  }
}

function inferNavigationPlacement(
  depth: number,
  category: PageCategory,
  hasNavigation: boolean,
  stencilType: VisualStencilType
): NavigationPlacement {
  if (stencilType === "NavigationLayout") return "primary";
  if (depth === 0) return "primary";
  if (depth === 1 && (category === "listing" || category === "feature")) return "primary";
  if (depth === 1) return "secondary";
  if (depth === 2) return "secondary";
  if (category === "article" && depth >= 2) return "footer";
  if (!hasNavigation && depth >= 3) return "unlisted";
  if (depth >= 3) return "breadcrumb";
  return "secondary";
}

function deriveTags(node: StencilNodeEntry, category: PageCategory): string[] {
  const tags: string[] = [category, node.stencilType];
  if (node.visualHierarchy.hasNavigation) tags.push("navigation");
  if (node.visualHierarchy.hasFooter)     tags.push("footer");
  if (node.visualHierarchy.hasHero)       tags.push("hero");
  if (node.visualHierarchy.imageCount > 3) tags.push("media-rich");
  if (node.visualHierarchy.wordCount > 500) tags.push("long-form");
  if (node.depth === 0)                   tags.push("root");
  return [...new Set(tags)];
}

const CATEGORY_LABELS: Record<PageCategory, string> = {
  homepage:   "Homepage & Landing",
  article:    "Articles & Posts",
  listing:    "Listing & Index Pages",
  feature:    "Feature Pages",
  navigation: "Navigation & Sitemaps",
  unknown:    "Uncategorized",
};

// ── R2 helpers ────────────────────────────────────────────────────────────────

function r2Ready(): boolean {
  return !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_ENDPOINT && process.env.R2_BUCKET_NAME);
}

async function r2Client() {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({
    region: "auto", endpoint: process.env.R2_ENDPOINT ?? "",
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID     ?? "",
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    },
  });
}

async function fetchR2Json<T>(key: string): Promise<T | null> {
  if (!r2Ready()) return null;
  try {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await r2Client();
    const resp   = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: key }));
    const chunks: Buffer[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const ch of (resp.Body as any)) chunks.push(Buffer.from(ch));
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch { return null; }
}

async function uploadR2Json(data: unknown, key: string): Promise<boolean> {
  if (!r2Ready()) return false;
  try {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await r2Client();
    await client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!, Key: key,
      Body: Buffer.from(JSON.stringify(data, null, 2), "utf8"),
      ContentType: "application/json",
    }));
    return true;
  } catch (err) {
    logger.warn({ err, key }, "PRIME-INDEXER: upload failed");
    return false;
  }
}

// ── Navigation tree builder ───────────────────────────────────────────────────

function buildNavigationTree(
  pages: IndexedPage[],
  routeMap: Record<string, IndexedPage>,
  maxDepth = 2
): NavigationTreeNode[] {
  const navPages = pages
    .filter(p => p.depth <= maxDepth && p.navigationPlacement !== "unlisted" && p.navigationPlacement !== "footer")
    .sort((a, b) => a.depth - b.depth || a.route.localeCompare(b.route));

  function buildChildren(parentRoute: string | null, currentDepth: number): NavigationTreeNode[] {
    if (currentDepth > maxDepth) return [];
    return navPages
      .filter(p => p.parentRoute === parentRoute && p.depth === currentDepth)
      .map(p => ({
        route:    p.route,
        title:    p.title,
        slug:     p.slug,
        depth:    p.depth,
        children: buildChildren(p.route, currentDepth + 1),
      }));
  }

  const rootPage = routeMap["/"];
  if (!rootPage) return buildChildren(null, 0);

  return [{
    route:    "/",
    title:    rootPage.title,
    slug:     "home",
    depth:    0,
    children: buildChildren("/", 1),
  }];
}

// ── Main indexer ──────────────────────────────────────────────────────────────

export interface IndexerInput {
  jobId:    string;
  seedUrl?: string;
  /** Pre-loaded data — skips R2 fetches */
  preloaded?: {
    stencilMap?: VisualStencilMap;
    manifest?:   CrawlManifest;
  };
}

export interface IndexerOutput {
  websitePrimeIndex: WebsitePrimeIndex;
  routeIndex:        RouteIndex;
  searchIndex:       SearchIndex;
  contentIndex:      ContentIndex;
  r2Keys: {
    routeIndex:   string;
    searchIndex:  string;
    contentIndex: string;
    primeIndex:   string;
  };
  uploadedAll: boolean;
}

export async function runWebsitePrimeIndexer(input: IndexerInput): Promise<IndexerOutput> {
  const { jobId } = input;
  const start = Date.now();
  logger.info({ jobId }, "PRIME-INDEXER: starting");

  // ── Load inputs in parallel ─────────────────────────────────────────────
  const [stencilMap, manifest] = await Promise.all([
    input.preloaded?.stencilMap
      ?? fetchR2Json<VisualStencilMap>(`jobs/${jobId}/normalized-stencil-map.json`)
      ?? fetchR2Json<VisualStencilMap>(`jobs/${jobId}/visual-stencil-map.json`),

    input.preloaded?.manifest
      ?? fetchR2Json<CrawlManifest>(`jobs/${jobId}/_manifest.json`)
      ?? fetchR2Json<CrawlManifest>(`jobs/${jobId}/manifest.json`),
  ]);

  // Resolve seed URL
  const seedUrl =
    input.seedUrl ??
    stencilMap?.seedUrl ??
    manifest?.seedUrl ??
    manifest?.baseUrl ??
    manifest?.url ??
    "";

  // Build manifest title lookup (url → title)
  const titleLookup: Record<string, string> = {};
  if (manifest?.pages) {
    for (const p of manifest.pages) {
      if (p.url && p.title) titleLookup[p.url] = p.title;
    }
  }
  if (manifest?.results) {
    for (const r of manifest.results) {
      if (r.url && r.title) titleLookup[r.url] = r.title;
    }
  }

  // ── Process nodes ────────────────────────────────────────────────────────
  const nodes: StencilNodeEntry[] = stencilMap?.nodes ?? [];

  const pages: IndexedPage[] = nodes.map(node => {
    const route    = extractRoute(node.url, seedUrl);
    const slug     = extractSlug(route);
    const hier     = extractHierarchy(route);
    const parent   = extractParentRoute(route);
    const category = inferCategory(node.stencilType, node.depth, route);
    const title    = inferTitle(slug, node.stencilType, node.depth, titleLookup[node.url]);
    const navPlace = inferNavigationPlacement(node.depth, category, node.visualHierarchy.hasNavigation, node.stencilType);
    const tags     = deriveTags(node, category);

    return {
      id:                  node.nodeId,
      url:                 node.url,
      route,
      slug,
      hierarchy:           hier,
      parentRoute:         parent,
      title,
      category,
      stencilType:         node.stencilType,
      navigationPlacement: navPlace,
      depth:               node.depth,
      wordCount:           node.visualHierarchy.wordCount,
      hasNavigation:       node.visualHierarchy.hasNavigation,
      hasFooter:           node.visualHierarchy.hasFooter,
      isRoot:              node.depth === 0 || route === "/",
      children:            [],   // filled below
      tags,
      normalizedLayout:    (node as unknown as Record<string, unknown>)["normalizedLayout"] as Record<string, unknown> | undefined,
    };
  });

  // ── Wire up children ─────────────────────────────────────────────────────
  const routeMap: Record<string, IndexedPage> = {};
  for (const p of pages) routeMap[p.route] = p;

  for (const p of pages) {
    if (p.parentRoute && routeMap[p.parentRoute]) {
      routeMap[p.parentRoute]!.children.push(p.route);
    }
  }

  // ── Build routeIndex ─────────────────────────────────────────────────────
  const routeIndex: RouteIndex = {
    schemaVersion: "prime-1",
    jobId,
    seedUrl,
    generatedAt: new Date().toISOString(),
    totalRoutes: pages.length,
    rootRoute:   "/",
    routes:      routeMap,
  };

  // ── Build searchIndex ────────────────────────────────────────────────────
  const searchDocs: SearchDocument[] = pages.map(p => ({
    id:       p.id,
    route:    p.route,
    title:    p.title,
    slug:     p.slug,
    category: p.category,
    tags:     p.tags,
    text:     [p.title, p.slug, p.category, ...p.tags, ...p.hierarchy.filter(Boolean)].join(" "),
  }));

  const searchIndex: SearchIndex = {
    schemaVersion: "prime-1",
    jobId,
    generatedAt: new Date().toISOString(),
    totalDocs: searchDocs.length,
    documents: searchDocs,
  };

  // ── Build contentIndex ───────────────────────────────────────────────────
  const allCategories: PageCategory[] = ["homepage", "article", "listing", "feature", "navigation", "unknown"];
  const byCategory: Record<PageCategory, ContentGroup> = {} as Record<PageCategory, ContentGroup>;

  for (const cat of allCategories) {
    const catPages = pages.filter(p => p.category === cat);
    byCategory[cat] = {
      category:        cat,
      label:           CATEGORY_LABELS[cat],
      totalPages:      catPages.length,
      routes:          catPages.map(p => p.route),
      representative:  catPages.find(p => p.isRoot)?.route ?? catPages[0]?.route,
    };
  }

  // Sections = pages at depth 1 that have children
  const sections: ContentSection[] = pages
    .filter(p => p.depth === 1 && p.children.length > 0)
    .map(p => ({
      sectionRoute: p.route,
      title:        p.title,
      children:     p.children,
    }));

  const navigationTree = buildNavigationTree(pages, routeMap);

  const contentIndex: ContentIndex = {
    schemaVersion: "prime-1",
    jobId,
    generatedAt: new Date().toISOString(),
    byCategory,
    sections,
    navigationTree,
  };

  // ── Build websitePrimeIndex ──────────────────────────────────────────────
  const maxDepth = pages.reduce((m, p) => Math.max(m, p.depth), 0);
  const catCounts: Record<PageCategory, number> = {} as Record<PageCategory, number>;
  for (const cat of allCategories) catCounts[cat] = byCategory[cat].totalPages;

  const websitePrimeIndex: WebsitePrimeIndex = {
    schemaVersion: "prime-1",
    jobId,
    seedUrl,
    generatedAt: new Date().toISOString(),
    stats: {
      totalPages:       pages.length,
      totalRoutes:      Object.keys(routeMap).length,
      maxDepth,
      categories:       catCounts,
      navigationLevels: Math.min(maxDepth, 2) + 1,
    },
    routeIndex,
    searchIndex,
    contentIndex,
  };

  // ── Upload all artifacts to R2 ───────────────────────────────────────────
  const keys = {
    routeIndex:   `jobs/${jobId}/prime-index/routeIndex.json`,
    searchIndex:  `jobs/${jobId}/prime-index/searchIndex.json`,
    contentIndex: `jobs/${jobId}/prime-index/contentIndex.json`,
    primeIndex:   `jobs/${jobId}/prime-index/websitePrimeIndex.json`,
  };

  const uploads = await Promise.all([
    uploadR2Json(routeIndex,        keys.routeIndex),
    uploadR2Json(searchIndex,       keys.searchIndex),
    uploadR2Json(contentIndex,      keys.contentIndex),
    uploadR2Json(websitePrimeIndex, keys.primeIndex),
  ]);

  const uploadedAll = uploads.every(Boolean);

  logger.info(
    { jobId, pages: pages.length, maxDepth, uploadedAll, durationMs: Date.now() - start },
    "PRIME-INDEXER: complete"
  );

  return { websitePrimeIndex, routeIndex, searchIndex, contentIndex, r2Keys: keys, uploadedAll };
}
