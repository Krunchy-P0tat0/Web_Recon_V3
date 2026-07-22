/**
 * website-prime-phase57.ts — Phase 5.7: Website Prime Completion
 *
 * Generates 4 new static JSON artifacts for full site self-description:
 *
 *   starter-index.json       — page + route + category + navigation inventories
 *   related-content.json     — cross-link intelligence per page
 *   search-index.json        — enriched search index (title + keywords + snippets + route)
 *   website-prime-audit.json — route validation (orphans, broken, duplicates)
 *
 * Data sources (all optional — engine degrades gracefully):
 *   - prime-index/routeIndex.json   (Phase 5.6 output — primary source)
 *   - prime-index/contentIndex.json (Phase 5.6 output)
 *   - site-graph.json               (SiteGraph — enriches nav + categories)
 *   - blueprint.json                (WebsiteBlueprint — enriches nav)
 *   - _manifest.json                (PortableManifest — provides content snippets)
 */

import { writeFile, mkdir } from "fs/promises";
import { join }             from "path";
import { logger }           from "./logger.js";

// ── Lightweight local type aliases (avoid deep cross-package imports) ─────────

interface LocalRouteIndex {
  jobId:       string;
  seedUrl:     string;
  generatedAt: string;
  totalRoutes: number;
  rootRoute:   string;
  routes:      Record<string, LocalIndexedPage>;
}

interface LocalIndexedPage {
  id:                  string;
  url:                 string;
  route:               string;
  slug:                string;
  hierarchy:           string[];
  parentRoute:         string | null;
  title:               string;
  category:            string;
  stencilType:         string;
  navigationPlacement: string;
  depth:               number;
  wordCount:           number;
  hasNavigation:       boolean;
  hasFooter:           boolean;
  isRoot:              boolean;
  children:            string[];
  tags:                string[];
}

interface LocalContentIndex {
  jobId:          string;
  generatedAt:    string;
  byCategory:     Record<string, { category: string; label: string; totalPages: number; routes: string[]; representative?: string }>;
  sections:       Array<{ sectionRoute: string; title: string; children: string[] }>;
  navigationTree: LocalNavTreeNode[];
}

interface LocalNavTreeNode {
  route:    string;
  title:    string;
  slug:     string;
  depth:    number;
  children: LocalNavTreeNode[];
}

// Minimal SiteGraph subset used here
interface LocalSiteGraph {
  id?:       string;
  seedUrl?:  string;
  navigation?: {
    primary:       Array<{ nodeId: string; url: string; title: string; depth: number; children: unknown[]; isOrphan: boolean }>;
    secondary:     Array<{ nodeId: string; url: string; title: string; depth: number; children: unknown[]; isOrphan: boolean }>;
    orphanPages:   Array<{ nodeId: string; url: string; title: string; reason: string }>;
    duplicatePaths: Array<{ route: string; nodeIds: string[] }>;
    totalNavigableNodes: number;
    maxDepth: number;
  };
  routeMap?: {
    routes:       Array<{ nodeId: string; url: string; route: string; slug: string; isCollisionResolved: boolean; collisionSuffix: number | null; routeSource: string; movedFrom: string | null }>;
    routeIndex:   Record<string, string>;
    collisionCount: number;
    totalRoutes:  number;
    generatedAt:  string;
  };
  categoryGraph?: {
    categories: Array<{ id: string; label: string; slug: string; parentId: string | null; childIds: string[]; pageIds: string[]; pageCount: number; depth: number; source: string }>;
    tags:       Array<{ tag: string; nodeIds: string[]; frequency: number }>;
    uncategorizedPageIds: string[];
    totalCategories: number;
  };
}

// Minimal Blueprint subset
interface LocalBlueprint {
  navigation?: {
    primary:   Array<{ pageId: string; route: string; label: string; depth: number; children: unknown[]; order: number }>;
    secondary: Array<{ pageId: string; route: string; label: string; depth: number; children: unknown[]; order: number }>;
    footer: {
      groups: Array<{ label: string; items: Array<{ label: string; route: string }> }>;
      copyrightText: string;
      showSitemapLink: boolean;
      showSearchLink: boolean;
    };
    totalPrimaryItems:   number;
    totalSecondaryItems: number;
  };
  pages?: Array<{ id: string; route: string; title: string; pageType: string; layout: string; nodeId?: string }>;
}

// Minimal Manifest subset
interface LocalManifest {
  seedUrl?: string;
  baseUrl?:  string;
  url?:      string;
  pages?: Array<{
    url?:             string;
    title?:           string;
    nodeId?:          string;
    wordCount?:       number;
    description?:     string;
    bodySnippet?:     string;
    metaDescription?: string;
    keywords?:        string | string[];
  }>;
  results?: Array<{ url?: string; title?: string; description?: string; metaDescription?: string; keywords?: string | string[] }>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Output types
// ═══════════════════════════════════════════════════════════════════════════════

export interface PageInventoryEntry {
  id:                  string;
  url:                 string;
  route:               string;
  slug:                string;
  title:               string;
  category:            string;
  stencilType:         string;
  depth:               number;
  wordCount:           number;
  navigationPlacement: string;
  isRoot:              boolean;
  childCount:          number;
  tags:                string[];
  parentRoute:         string | null;
}

export interface RouteInventoryEntry {
  route:        string;
  nodeId:       string;
  title:        string;
  status:       "ok" | "orphan" | "duplicate" | "broken";
  depth:        number;
  collisionResolved?: boolean;
  collisionSuffix?:   number | null;
  routeSource?:       string;
  movedFrom?:         string | null;
}

export interface CategoryInventoryEntry {
  id:           string;
  label:        string;
  slug:         string;
  pageCount:    number;
  depth:        number;
  parentId:     string | null;
  childIds:     string[];
  source:       string;
  sampleRoutes: string[];
}

export interface NavigationInventoryEntry {
  level:    "primary" | "secondary" | "footer";
  route:    string;
  label:    string;
  depth:    number;
  order:    number;
  children: string[];   // child routes
}

export interface StarterIndex {
  schemaVersion:       "prime-5.7";
  phase:               "5.7";
  jobId:               string;
  seedUrl:             string;
  generatedAt:         string;
  sources:             string[];
  stats: {
    totalPages:         number;
    totalRoutes:        number;
    totalCategories:    number;
    totalNavItems:      number;
    maxDepth:           number;
  };
  pageInventory:       PageInventoryEntry[];
  routeInventory:      RouteInventoryEntry[];
  categoryInventory:   CategoryInventoryEntry[];
  navigationInventory: NavigationInventoryEntry[];
}

export interface RelatedContentEntry {
  pageRoute:      string;
  pageTitle:      string;
  relatedPages: Array<{
    route:        string;
    title:        string;
    score:        number;
    reasons:      string[];
  }>;
}

export interface RelatedContentIndex {
  schemaVersion:  "prime-5.7";
  phase:          "5.7";
  jobId:          string;
  generatedAt:    string;
  algorithm:      "shared-parent|shared-category|shared-tags|slug-similarity";
  totalPages:     number;
  entries:        RelatedContentEntry[];
}

export interface SearchIndexEntry {
  id:       string;
  route:    string;
  title:    string;
  keywords: string[];
  snippet:  string;
  category: string;
  tags:     string[];
  depth:    number;
  wordCount: number;
}

export interface EnhancedSearchIndex {
  schemaVersion: "prime-5.7";
  phase:         "5.7";
  jobId:         string;
  generatedAt:   string;
  totalDocs:     number;
  documents:     SearchIndexEntry[];
}

export type AuditGrade = "PASS" | "PARTIAL_PASS" | "FAIL";

export interface AuditIssue {
  severity: "critical" | "warning" | "info";
  type:     "orphan" | "broken_route" | "duplicate_route" | "missing_parent" | "collision";
  route:    string;
  detail:   string;
  affectedNodeIds?: string[];
}

export interface WebsitePrimeAudit {
  schemaVersion:  "prime-5.7";
  phase:          "5.7";
  jobId:          string;
  generatedAt:    string;
  grade:          AuditGrade;
  summary:        string;
  stats: {
    totalRoutes:     number;
    validRoutes:     number;
    orphanRoutes:    number;
    brokenRoutes:    number;
    duplicateRoutes: number;
    collisions:      number;
  };
  issues: AuditIssue[];
  orphanPages:     Array<{ route: string; nodeId: string; title: string; reason: string }>;
  brokenRoutes:    Array<{ referencedIn: string; missingRoute: string }>;
  duplicateRoutes: Array<{ route: string; nodeIds: string[] }>;
}

export interface Phase57Output {
  starterIndex:   StarterIndex;
  relatedContent: RelatedContentIndex;
  searchIndex:    EnhancedSearchIndex;
  audit:          WebsitePrimeAudit;
  r2Keys: {
    starterIndex:   string;
    relatedContent: string;
    searchIndex:    string;
    audit:          string;
  };
  uploadedAll: boolean;
  sources:     string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// R2 helpers (self-contained, no shared provider needed)
// ═══════════════════════════════════════════════════════════════════════════════

function r2Ready(): boolean {
  return !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_ENDPOINT && process.env.R2_BUCKET_NAME);
}

async function r2Client() {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT ?? "",
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
  } catch {
    return null;
  }
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
    logger.warn({ err, key }, "PHASE57: R2 upload failed");
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Local disk write helper
// ═══════════════════════════════════════════════════════════════════════════════

async function writeLocalJson(data: unknown, filename: string): Promise<void> {
  const root = join(process.cwd(), "..", "..", "prime-artifacts");
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, filename), JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    logger.warn({ err, filename }, "PHASE57: local write failed (non-fatal)");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper utilities
// ═══════════════════════════════════════════════════════════════════════════════

function extractRoute(url: string, seedUrl: string): string {
  try {
    const base = new URL(seedUrl).origin;
    const full = new URL(url, base);
    return full.pathname || "/";
  } catch {
    if (url.startsWith("http")) {
      try { return new URL(url).pathname; } catch { return "/"; }
    }
    return url.startsWith("/") ? url : `/${url}`;
  }
}

function slugSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const wordsA = a.split(/[-_/]/).filter(Boolean);
  const wordsB = b.split(/[-_/]/).filter(Boolean);
  if (!wordsA.length || !wordsB.length) return 0;
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  const intersection = [...setA].filter(w => setB.has(w)).length;
  return intersection / Math.max(setA.size, setB.size);
}

function normalizeKeywords(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const list = typeof raw === "string"
    ? raw.split(/[,;|]+/).map(s => s.trim()).filter(Boolean)
    : raw.map(s => String(s).trim()).filter(Boolean);
  return [...new Set(list.map(k => k.toLowerCase()))].slice(0, 20);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Starter Index Builder
// ═══════════════════════════════════════════════════════════════════════════════

function buildStarterIndex(
  jobId:        string,
  seedUrl:      string,
  routeIndex:   LocalRouteIndex | null,
  contentIndex: LocalContentIndex | null,
  siteGraph:    LocalSiteGraph | null,
  blueprint:    LocalBlueprint | null,
  sources:      string[],
): StarterIndex {
  const now = new Date().toISOString();
  const pages = Object.values(routeIndex?.routes ?? {});

  // ── Page Inventory ─────────────────────────────────────────────────────────
  const pageInventory: PageInventoryEntry[] = pages.map(p => ({
    id:                  p.id,
    url:                 p.url,
    route:               p.route,
    slug:                p.slug,
    title:               p.title,
    category:            p.category,
    stencilType:         p.stencilType,
    depth:               p.depth,
    wordCount:           p.wordCount,
    navigationPlacement: p.navigationPlacement,
    isRoot:              p.isRoot,
    childCount:          p.children.length,
    tags:                p.tags,
    parentRoute:         p.parentRoute,
  }));

  // ── Route Inventory ────────────────────────────────────────────────────────
  const orphanNodeIds = new Set(
    siteGraph?.navigation?.orphanPages?.map(o => o.nodeId) ?? []
  );
  const duplicateRoutes = new Set<string>();
  for (const dp of siteGraph?.navigation?.duplicatePaths ?? []) duplicateRoutes.add(dp.route);
  const collisionRoutes = new Set<string>();
  for (const re of siteGraph?.routeMap?.routes ?? []) {
    if (re.isCollisionResolved) collisionRoutes.add(re.route);
  }

  // Build a quick lookup of SiteGraph routeMap for extra metadata
  type SgRoute = NonNullable<NonNullable<typeof siteGraph>["routeMap"]>["routes"][number];
  const sgRouteInfo = new Map<string, SgRoute>();
  for (const re of siteGraph?.routeMap?.routes ?? []) sgRouteInfo.set(re.route, re);

  const routeInventory: RouteInventoryEntry[] = pages.map(p => {
    const sgInfo = sgRouteInfo.get(p.route);
    let status: RouteInventoryEntry["status"] = "ok";
    if (orphanNodeIds.has(p.id))     status = "orphan";
    else if (duplicateRoutes.has(p.route)) status = "duplicate";
    return {
      route:             p.route,
      nodeId:            p.id,
      title:             p.title,
      status,
      depth:             p.depth,
      collisionResolved: sgInfo?.isCollisionResolved,
      collisionSuffix:   sgInfo?.collisionSuffix ?? null,
      routeSource:       sgInfo?.routeSource,
      movedFrom:         sgInfo?.movedFrom ?? null,
    };
  });

  // ── Category Inventory ─────────────────────────────────────────────────────
  let categoryInventory: CategoryInventoryEntry[];

  if (siteGraph?.categoryGraph?.categories?.length) {
    // Rich: from SiteGraph CategoryGraph
    categoryInventory = siteGraph.categoryGraph.categories.map(cat => ({
      id:           cat.id,
      label:        cat.label,
      slug:         cat.slug,
      pageCount:    cat.pageCount,
      depth:        cat.depth,
      parentId:     cat.parentId,
      childIds:     cat.childIds,
      source:       cat.source,
      sampleRoutes: cat.pageIds
        .slice(0, 3)
        .map(nodeId => pages.find(p => p.id === nodeId)?.route ?? "")
        .filter(Boolean),
    }));
  } else if (contentIndex?.byCategory) {
    // Fallback: derive from contentIndex
    categoryInventory = Object.entries(contentIndex.byCategory)
      .filter(([, g]) => g.totalPages > 0)
      .map(([key, g]) => ({
        id:           key,
        label:        g.label,
        slug:         key,
        pageCount:    g.totalPages,
        depth:        0,
        parentId:     null,
        childIds:     [],
        source:       "content-index",
        sampleRoutes: g.routes.slice(0, 3),
      }));
  } else {
    // Minimal: infer from page categories
    const catMap = new Map<string, { routes: string[]; label: string }>();
    for (const p of pages) {
      if (!catMap.has(p.category)) catMap.set(p.category, { routes: [], label: p.category });
      catMap.get(p.category)!.routes.push(p.route);
    }
    categoryInventory = [...catMap.entries()].map(([key, val]) => ({
      id:           key,
      label:        val.label,
      slug:         key,
      pageCount:    val.routes.length,
      depth:        0,
      parentId:     null,
      childIds:     [],
      source:       "inferred",
      sampleRoutes: val.routes.slice(0, 3),
    }));
  }

  // ── Navigation Inventory ───────────────────────────────────────────────────
  const navInventory: NavigationInventoryEntry[] = [];

  function flattenBlueprintNav(
    items: Array<{ pageId: string; route: string; label: string; depth: number; children: unknown[]; order: number }>,
    level: "primary" | "secondary"
  ) {
    for (const item of items) {
      navInventory.push({
        level,
        route:    item.route,
        label:    item.label,
        depth:    item.depth,
        order:    item.order,
        children: (item.children as typeof items).map(c => c.route),
      });
      if (item.children?.length) {
        flattenBlueprintNav(item.children as typeof items, "secondary");
      }
    }
  }

  if (blueprint?.navigation) {
    // Rich: Blueprint nav
    flattenBlueprintNav(blueprint.navigation.primary, "primary");
    flattenBlueprintNav(blueprint.navigation.secondary, "secondary");
    for (const group of blueprint.navigation.footer.groups) {
      for (const [idx, item] of group.items.entries()) {
        navInventory.push({ level: "footer", route: item.route, label: item.label, depth: 0, order: idx, children: [] });
      }
    }
  } else if (siteGraph?.navigation) {
    // Medium: SiteGraph nav
    const sg = siteGraph.navigation;
    for (const [idx, item] of sg.primary.entries()) {
      navInventory.push({ level: "primary", route: extractRoute(item.url, seedUrl), label: item.title, depth: item.depth, order: idx, children: (item.children as typeof sg.primary).map(c => extractRoute(c.url, seedUrl)) });
    }
    for (const [idx, item] of sg.secondary.entries()) {
      navInventory.push({ level: "secondary", route: extractRoute(item.url, seedUrl), label: item.title, depth: item.depth, order: idx, children: [] });
    }
  } else if (contentIndex?.navigationTree) {
    // Fallback: tree from contentIndex
    function flattenNavTree(nodes: LocalNavTreeNode[], level: "primary" | "secondary") {
      for (const [idx, node] of nodes.entries()) {
        navInventory.push({ level, route: node.route, label: node.title, depth: node.depth, order: idx, children: node.children.map(c => c.route) });
        if (node.children?.length) flattenNavTree(node.children, "secondary");
      }
    }
    flattenNavTree(contentIndex.navigationTree, "primary");
  }

  const maxDepth = pages.reduce((m, p) => Math.max(m, p.depth), 0);

  return {
    schemaVersion:       "prime-5.7",
    phase:               "5.7",
    jobId,
    seedUrl,
    generatedAt:         now,
    sources,
    stats: {
      totalPages:      pageInventory.length,
      totalRoutes:     routeInventory.length,
      totalCategories: categoryInventory.length,
      totalNavItems:   navInventory.length,
      maxDepth,
    },
    pageInventory,
    routeInventory,
    categoryInventory,
    navigationInventory: navInventory,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Cross-Link Intelligence Builder
// ═══════════════════════════════════════════════════════════════════════════════

function buildRelatedContent(
  jobId:      string,
  routeIndex: LocalRouteIndex | null,
): RelatedContentIndex {
  const pages  = Object.values(routeIndex?.routes ?? {});
  const byRoute = new Map(pages.map(p => [p.route, p]));

  const entries: RelatedContentEntry[] = pages.map(page => {
    const candidates = pages.filter(p => p.route !== page.route);
    const scored = candidates.map(candidate => {
      let score = 0;
      const reasons: string[] = [];

      // 1. Shared parent
      if (page.parentRoute && candidate.parentRoute === page.parentRoute) {
        score += 40;
        reasons.push("sibling-page");
      }
      // 2. Is child/parent
      if (candidate.parentRoute === page.route) {
        score += 30;
        reasons.push("child-page");
      }
      if (page.parentRoute === candidate.route) {
        score += 25;
        reasons.push("parent-page");
      }
      // 3. Shared category
      if (page.category !== "unknown" && candidate.category === page.category) {
        score += 20;
        reasons.push(`shared-category:${page.category}`);
      }
      // 4. Shared tags
      const sharedTags = page.tags.filter(t =>
        !["navigation", "footer", "hero", "root"].includes(t) &&
        candidate.tags.includes(t)
      );
      if (sharedTags.length > 0) {
        score += sharedTags.length * 10;
        reasons.push(`shared-tags:${sharedTags.join(",")}`);
      }
      // 5. Slug similarity
      const simScore = slugSimilarity(page.slug, candidate.slug);
      if (simScore > 0.5) {
        score += Math.round(simScore * 15);
        reasons.push("slug-similarity");
      }
      // 6. Same section (route segment overlap)
      const pageSegments  = page.route.split("/").filter(Boolean);
      const candSegments  = candidate.route.split("/").filter(Boolean);
      const sharedSegs    = pageSegments.filter((s, i) => s === candSegments[i]).length;
      if (sharedSegs > 0 && pageSegments.length > 1) {
        score += sharedSegs * 5;
        if (!reasons.some(r => r.startsWith("sibling") || r.startsWith("child") || r.startsWith("parent"))) {
          reasons.push("shared-route-prefix");
        }
      }

      return { route: candidate.route, title: candidate.title, score, reasons };
    });

    const related = scored
      .filter(s => s.score >= 15)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    return {
      pageRoute:    page.route,
      pageTitle:    page.title,
      relatedPages: related,
    };
  });

  // Verify byRoute used (suppress unused warning)
  void byRoute;

  return {
    schemaVersion: "prime-5.7",
    phase:         "5.7",
    jobId,
    generatedAt:   new Date().toISOString(),
    algorithm:     "shared-parent|shared-category|shared-tags|slug-similarity",
    totalPages:    pages.length,
    entries,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Enhanced Search Index Builder
// ═══════════════════════════════════════════════════════════════════════════════

function buildEnhancedSearchIndex(
  jobId:      string,
  routeIndex: LocalRouteIndex | null,
  manifest:   LocalManifest | null,
): EnhancedSearchIndex {
  const pages = Object.values(routeIndex?.routes ?? {});

  // Build manifest lookup: route → manifest page data
  const manifestLookup = new Map<string, { snippet: string; keywords: string[] }>();
  const seedUrl = routeIndex?.seedUrl ?? "";

  const allManifestPages = [
    ...(manifest?.pages ?? []),
    ...(manifest?.results ?? []),
  ];

  for (const mp of allManifestPages) {
    if (!mp.url) continue;
    const route = extractRoute(mp.url, seedUrl);
    const snippet =
      mp.description?.trim() ||
      mp.metaDescription?.trim() ||
      (mp as { bodySnippet?: string }).bodySnippet?.trim() ||
      "";
    const keywords = normalizeKeywords(mp.keywords);
    manifestLookup.set(route, { snippet, keywords });
  }

  const documents: SearchIndexEntry[] = pages.map(page => {
    const mEntry  = manifestLookup.get(page.route);
    const keywords = [
      ...new Set([
        ...page.tags.filter(t => !["navigation", "footer", "hero", "root"].includes(t)),
        page.category !== "unknown" ? page.category : "",
        page.slug !== "home" ? page.slug : "",
        ...(mEntry?.keywords ?? []),
      ].filter(Boolean)),
    ].slice(0, 20);

    const snippet = mEntry?.snippet?.slice(0, 300) ||
      [page.title, ...keywords.slice(0, 5)].join(" — ");

    return {
      id:        page.id,
      route:     page.route,
      title:     page.title,
      keywords,
      snippet,
      category:  page.category,
      tags:      page.tags,
      depth:     page.depth,
      wordCount: page.wordCount,
    };
  });

  return {
    schemaVersion: "prime-5.7",
    phase:         "5.7",
    jobId,
    generatedAt:   new Date().toISOString(),
    totalDocs:     documents.length,
    documents,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Route Validation / Audit Builder
// ═══════════════════════════════════════════════════════════════════════════════

function buildAudit(
  jobId:      string,
  routeIndex: LocalRouteIndex | null,
  siteGraph:  LocalSiteGraph | null,
): WebsitePrimeAudit {
  const now   = new Date().toISOString();
  const pages = Object.values(routeIndex?.routes ?? {});
  const knownRoutes = new Set(pages.map(p => p.route));

  const issues: AuditIssue[] = [];

  // ── Orphan pages ───────────────────────────────────────────────────────────
  // From SiteGraph if available
  const sgOrphans = siteGraph?.navigation?.orphanPages ?? [];
  const orphanPages: WebsitePrimeAudit["orphanPages"] = [];

  for (const op of sgOrphans) {
    const route = extractRoute(op.url, routeIndex?.seedUrl ?? "");
    orphanPages.push({ route, nodeId: op.nodeId, title: op.title, reason: op.reason });
    issues.push({
      severity:        "warning",
      type:            "orphan",
      route,
      detail:          `Orphan page — reason: ${op.reason}`,
      affectedNodeIds: [op.nodeId],
    });
  }

  // Also detect orphans from routeIndex: pages whose parentRoute doesn't exist
  for (const page of pages) {
    if (page.parentRoute && !knownRoutes.has(page.parentRoute)) {
      if (!orphanPages.find(o => o.route === page.route)) {
        orphanPages.push({ route: page.route, nodeId: page.id, title: page.title, reason: "broken_parent_ref" });
        issues.push({
          severity:        "warning",
          type:            "missing_parent",
          route:           page.route,
          detail:          `Parent route '${page.parentRoute}' does not exist in routeIndex`,
          affectedNodeIds: [page.id],
        });
      }
    }
  }

  // ── Broken routes ──────────────────────────────────────────────────────────
  // Routes referenced in .children that don't exist in routeIndex
  const brokenRoutes: WebsitePrimeAudit["brokenRoutes"] = [];

  for (const page of pages) {
    for (const childRoute of page.children) {
      if (!knownRoutes.has(childRoute)) {
        brokenRoutes.push({ referencedIn: page.route, missingRoute: childRoute });
        issues.push({
          severity: "critical",
          type:     "broken_route",
          route:    childRoute,
          detail:   `Route '${childRoute}' is referenced as a child of '${page.route}' but does not exist`,
          affectedNodeIds: [page.id],
        });
      }
    }
  }

  // ── Duplicate routes ───────────────────────────────────────────────────────
  const sgDuplicates = siteGraph?.navigation?.duplicatePaths ?? [];
  const duplicateRoutes: WebsitePrimeAudit["duplicateRoutes"] = [];

  for (const dp of sgDuplicates) {
    duplicateRoutes.push({ route: dp.route, nodeIds: dp.nodeIds });
    issues.push({
      severity:        "critical",
      type:            "duplicate_route",
      route:           dp.route,
      detail:          `Route '${dp.route}' is mapped to ${dp.nodeIds.length} nodes: ${dp.nodeIds.join(", ")}`,
      affectedNodeIds: dp.nodeIds,
    });
  }

  // Also detect duplicates from routeIndex itself
  const routeSeen = new Map<string, string[]>();
  for (const page of pages) {
    if (!routeSeen.has(page.route)) routeSeen.set(page.route, []);
    routeSeen.get(page.route)!.push(page.id);
  }
  for (const [route, ids] of routeSeen.entries()) {
    if (ids.length > 1 && !duplicateRoutes.find(d => d.route === route)) {
      duplicateRoutes.push({ route, nodeIds: ids });
      issues.push({
        severity:        "critical",
        type:            "duplicate_route",
        route,
        detail:          `Route appears ${ids.length} times in route index`,
        affectedNodeIds: ids,
      });
    }
  }

  // ── Collisions (resolved) ──────────────────────────────────────────────────
  for (const re of siteGraph?.routeMap?.routes ?? []) {
    if (re.isCollisionResolved) {
      issues.push({
        severity: "info",
        type:     "collision",
        route:    re.route,
        detail:   `Route collision resolved with suffix ${re.collisionSuffix ?? "?"} (moved from '${re.movedFrom ?? "?"}')`,
      });
    }
  }

  // ── Grading ───────────────────────────────────────────────────────────────
  const criticalCount = issues.filter(i => i.severity === "critical").length;
  const warningCount  = issues.filter(i => i.severity === "warning").length;

  let grade: AuditGrade;
  let summary: string;

  if (criticalCount === 0 && warningCount === 0) {
    grade   = "PASS";
    summary = `Route validation passed — ${pages.length} routes, no issues detected.`;
  } else if (criticalCount === 0) {
    grade   = "PARTIAL_PASS";
    summary = `Route validation partial pass — ${warningCount} warning(s), 0 critical issues.`;
  } else {
    grade   = "FAIL";
    summary = `Route validation failed — ${criticalCount} critical issue(s), ${warningCount} warning(s).`;
  }

  return {
    schemaVersion:   "prime-5.7",
    phase:           "5.7",
    jobId,
    generatedAt:     now,
    grade,
    summary,
    stats: {
      totalRoutes:     pages.length,
      validRoutes:     pages.length - orphanPages.length - brokenRoutes.length,
      orphanRoutes:    orphanPages.length,
      brokenRoutes:    brokenRoutes.length,
      duplicateRoutes: duplicateRoutes.length,
      collisions:      siteGraph?.routeMap?.collisionCount ?? 0,
    },
    issues,
    orphanPages,
    brokenRoutes,
    duplicateRoutes,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Phase 5.7 runner
// ═══════════════════════════════════════════════════════════════════════════════

export interface Phase57Input {
  jobId:     string;
  seedUrl?:  string;
  /** Pass pre-loaded data to skip R2 fetches */
  preloaded?: {
    routeIndex?:   LocalRouteIndex;
    contentIndex?: LocalContentIndex;
    siteGraph?:    LocalSiteGraph;
    blueprint?:    LocalBlueprint;
    manifest?:     LocalManifest;
  };
}

export async function runPhase57(input: Phase57Input): Promise<Phase57Output> {
  const { jobId } = input;
  const start = Date.now();
  logger.info({ jobId }, "PHASE57: starting Website Prime completion");

  // ── Load all data sources in parallel ─────────────────────────────────────
  const [routeIndex, contentIndex, siteGraph, blueprint, manifest] = await Promise.all([
    input.preloaded?.routeIndex   ?? fetchR2Json<LocalRouteIndex>  (`jobs/${jobId}/prime-index/routeIndex.json`),
    input.preloaded?.contentIndex ?? fetchR2Json<LocalContentIndex>(`jobs/${jobId}/prime-index/contentIndex.json`),
    input.preloaded?.siteGraph    ?? fetchR2Json<LocalSiteGraph>   (`jobs/${jobId}/site-graph.json`)
                                   ?? fetchR2Json<LocalSiteGraph>  (`jobs/${jobId}/siteGraph.json`),
    input.preloaded?.blueprint    ?? fetchR2Json<LocalBlueprint>   (`jobs/${jobId}/blueprint.json`),
    input.preloaded?.manifest     ?? fetchR2Json<LocalManifest>    (`jobs/${jobId}/_manifest.json`)
                                   ?? fetchR2Json<LocalManifest>   (`jobs/${jobId}/manifest.json`),
  ]);

  // Determine actual seed URL
  const seedUrl =
    input.seedUrl ??
    routeIndex?.seedUrl ??
    siteGraph?.seedUrl ??
    manifest?.seedUrl ??
    manifest?.baseUrl ??
    manifest?.url ??
    "";

  // Record which sources were available
  const sources: string[] = [];
  if (routeIndex)   sources.push("routeIndex");
  if (contentIndex) sources.push("contentIndex");
  if (siteGraph)    sources.push("siteGraph");
  if (blueprint)    sources.push("blueprint");
  if (manifest)     sources.push("manifest");

  logger.info({ jobId, sources }, "PHASE57: data sources loaded");

  // ── Build all 4 artifacts ──────────────────────────────────────────────────
  const starterIndex   = buildStarterIndex(jobId, seedUrl, routeIndex, contentIndex, siteGraph, blueprint, sources);
  const relatedContent = buildRelatedContent(jobId, routeIndex);
  const searchIndex    = buildEnhancedSearchIndex(jobId, routeIndex, manifest);
  const audit          = buildAudit(jobId, routeIndex, siteGraph);

  // ── R2 keys ───────────────────────────────────────────────────────────────
  const r2Keys = {
    starterIndex:   `jobs/${jobId}/prime-index/starter-index.json`,
    relatedContent: `jobs/${jobId}/prime-index/related-content.json`,
    searchIndex:    `jobs/${jobId}/prime-index/search-index.json`,
    audit:          `jobs/${jobId}/prime-index/website-prime-audit.json`,
  };

  // ── Upload to R2 + write locally in parallel ───────────────────────────────
  const [up1, up2, up3, up4] = await Promise.all([
    uploadR2Json(starterIndex,   r2Keys.starterIndex),
    uploadR2Json(relatedContent, r2Keys.relatedContent),
    uploadR2Json(searchIndex,    r2Keys.searchIndex),
    uploadR2Json(audit,          r2Keys.audit),
    writeLocalJson(starterIndex,   "starter-index.json"),
    writeLocalJson(relatedContent, "related-content.json"),
    writeLocalJson(searchIndex,    "search-index.json"),
    writeLocalJson(audit,          "website-prime-audit.json"),
  ]);

  const uploadedAll = [up1, up2, up3, up4].every(Boolean);

  logger.info(
    {
      jobId,
      pages:         starterIndex.stats.totalPages,
      navItems:      starterIndex.stats.totalNavItems,
      categories:    starterIndex.stats.totalCategories,
      relatedLinks:  relatedContent.entries.filter(e => e.relatedPages.length > 0).length,
      searchDocs:    searchIndex.totalDocs,
      auditGrade:    audit.grade,
      auditIssues:   audit.issues.length,
      sources,
      uploadedAll,
      durationMs:    Date.now() - start,
    },
    "PHASE57: complete"
  );

  return { starterIndex, relatedContent, searchIndex, audit, r2Keys, uploadedAll, sources };
}
