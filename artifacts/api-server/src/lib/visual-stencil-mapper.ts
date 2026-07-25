/**
 * visual-stencil-mapper.ts — Phase 6.6 Visual Stencil Mapper Engine
 *
 * Maps every node in a manifest into a visual layout stencil representation.
 *
 * Inputs:
 *   - manifest.json (loaded from R2 by jobId, or passed directly)
 *   - HTML snapshots (from node.content.cleanHtml, if present)
 *   - SiteGraph layoutAssignments (optional, passed in or loaded from R2)
 *
 * For each node:
 *   1. Detect visual hierarchy (hero, section, card, article, CTA, footer)
 *   2. Infer layout structure from DOM + semantic hints + manifest signals
 *   3. Assign a stencil type from the canonical 5-type vocabulary
 *
 * Stencil types:
 *   HeroSection      — Root/landing pages, full-width visual hero
 *   ArticleLayout    — Single article / long-form reading content
 *   GridLayout       — Card grids, galleries, index listings, pagination
 *   FeatureBlock     — Feature / services / CTA-driven pages
 *   NavigationLayout — Navigation hubs, category/tag indexes
 *
 * Output: visualStencilMap.json (uploaded to R2)
 *
 * Rules:
 *   - Must not modify content
 *   - Describes structure only
 *   - Preserves manifest node ordering
 */

import { logger } from "./logger";
import type { Manifest, PageNode } from "./manifest";

// ── Output types ───────────────────────────────────────────────────────────────

export type VisualStencilType =
  | "HeroSection"
  | "ArticleLayout"
  | "GridLayout"
  | "FeatureBlock"
  | "NavigationLayout";

export type MediaRichness = "none" | "low" | "medium" | "high";

export interface VisualHierarchy {
  hasHero: boolean;
  sections: number;
  hasNavigation: boolean;
  hasFooter: boolean;
  hasCTA: boolean;
  headingDepth: number;
  imageCount: number;
  videoCount: number;
  mediaRichness: MediaRichness;
  wordCount: number;
  estimatedReadTimeMin: number;
}

export interface StencilNodeEntry {
  nodeId: string;
  url: string;
  title: string;
  nodeType: string;
  depth: number;
  stencilType: VisualStencilType;
  confidence: number;
  visualHierarchy: VisualHierarchy;
  layoutSignals: string[];
  /** 0-based position in manifest node ordering */
  ordering: number;
}

export interface VisualStencilMap {
  schemaVersion: "6.6";
  jobId: string;
  seedUrl: string;
  generatedAt: string;
  summary: {
    totalNodes: number;
    byStencilType: Record<VisualStencilType, number>;
    mappingConfidence: number;
    nodeTypes: Record<string, number>;
  };
  nodes: StencilNodeEntry[];
  r2Key?: string;
}

// ── URL semantic classifier ────────────────────────────────────────────────────

const HERO_URL_PATTERNS   = /^\/?(index\.html?)?$/;
const FEATURE_URL_PATTERNS = /\/(about|services?|features?|pricing|contact|team|solutions?|platform|product|why|mission|vision|how-it-works)(\/|$)/i;
const NAV_URL_PATTERNS    = /\/(sitemap|categories|category|tags?|archive|topics?|search)(\/|$)/i;
const GRID_URL_PATTERNS   = /\/(blog|news|articles?|posts?|page\/\d+|p\/\d+)(\/|$)/i;

function classifyUrl(url: string): Partial<Record<VisualStencilType, number>> {
  let path = url;
  try { path = new URL(url).pathname; } catch { /* use as-is */ }

  const bonus: Partial<Record<VisualStencilType, number>> = {};
  if (HERO_URL_PATTERNS.test(path))    bonus["HeroSection"]      = (bonus["HeroSection"]      ?? 0) + 2;
  if (FEATURE_URL_PATTERNS.test(path)) bonus["FeatureBlock"]     = (bonus["FeatureBlock"]     ?? 0) + 2;
  if (NAV_URL_PATTERNS.test(path))     bonus["NavigationLayout"] = (bonus["NavigationLayout"] ?? 0) + 2;
  if (GRID_URL_PATTERNS.test(path))    bonus["GridLayout"]       = (bonus["GridLayout"]       ?? 0) + 1;
  return bonus;
}

// ── Lightweight HTML signal extraction ────────────────────────────────────────
// Uses regex — no cheerio dependency so the file works in both api-servers.

interface HtmlSignals {
  hasCTA: boolean;
  ctaCount: number;
  linkCount: number;
  sectionCount: number;
  listCount: number;
  tableCount: number;
  figureCount: number;
  formCount: number;
  navCount: number;
  footerCount: number;
  h1Count: number;
  h2Count: number;
  h3Count: number;
}

const ZERO_SIGNALS: HtmlSignals = {
  hasCTA: false, ctaCount: 0, linkCount: 0, sectionCount: 0,
  listCount: 0, tableCount: 0, figureCount: 0, formCount: 0,
  navCount: 0, footerCount: 0, h1Count: 0, h2Count: 0, h3Count: 0,
};

function countTag(html: string, tag: string): number {
  return (html.match(new RegExp(`<${tag}[\\s>]`, "gi")) ?? []).length;
}

function extractHtmlSignals(cleanHtml: string): HtmlSignals {
  if (!cleanHtml || cleanHtml.length < 20) return ZERO_SIGNALS;

  const ctaRe = /\b(get started|sign up|start free|try now|buy now|learn more|contact us|request demo|book a call|schedule|subscribe|download|join now)\b/gi;
  const ctaMatches = cleanHtml.match(ctaRe) ?? [];

  return {
    hasCTA:       ctaMatches.length > 0,
    ctaCount:     ctaMatches.length,
    linkCount:    countTag(cleanHtml, "a"),
    sectionCount: countTag(cleanHtml, "section") + countTag(cleanHtml, "article") + countTag(cleanHtml, "main"),
    listCount:    countTag(cleanHtml, "ul") + countTag(cleanHtml, "ol"),
    tableCount:   countTag(cleanHtml, "table"),
    figureCount:  countTag(cleanHtml, "figure") + countTag(cleanHtml, "img"),
    formCount:    countTag(cleanHtml, "form"),
    navCount:     countTag(cleanHtml, "nav"),
    footerCount:  countTag(cleanHtml, "footer"),
    h1Count:      countTag(cleanHtml, "h1"),
    h2Count:      countTag(cleanHtml, "h2"),
    h3Count:      countTag(cleanHtml, "h3"),
  };
}

// ── Visual hierarchy builder ───────────────────────────────────────────────────

function buildVisualHierarchy(node: PageNode, html: HtmlSignals): VisualHierarchy {
  const lm    = node.visualAssets?.layoutMetadata;
  const imgCt = lm?.imageCount ?? node.media.images.length;
  const vidCt = lm?.videoCount ?? node.media.videos.length;
  const wc    = node.content.wordCount;

  const mediaRichness: MediaRichness =
    (imgCt + vidCt > 8) ? "high"   :
    (imgCt + vidCt > 3) ? "medium" :
    (imgCt + vidCt > 0) ? "low"    : "none";

  // Hero = root-level page OR page with very few words and big visuals
  const hasHero =
    node.nodeType === "root" ||
    node.relationships.depth === 0 ||
    (imgCt >= 2 && wc < 300 && node.relationships.depth <= 1);

  // CTA = explicit keyword match OR single-purpose landing pages
  const hasCTA = html.hasCTA || (html.ctaCount > 0);

  // Heading depth = deepest heading level present
  const hs = lm?.headingStructure ?? {};
  const headingDepth =
    (hs["h6"] ? 6 : hs["h5"] ? 5 : hs["h4"] ? 4 :
     hs["h3"] || html.h3Count ? 3 :
     hs["h2"] || html.h2Count ? 2 :
     hs["h1"] || html.h1Count ? 1 : 0);

  return {
    hasHero,
    sections:             lm?.sectionCount ?? Math.max(html.sectionCount, 1),
    hasNavigation:        lm?.hasNavigation ?? html.navCount > 0,
    hasFooter:            lm?.hasFooter    ?? html.footerCount > 0,
    hasCTA,
    headingDepth,
    imageCount:           imgCt,
    videoCount:           vidCt,
    mediaRichness,
    wordCount:            wc,
    estimatedReadTimeMin: Math.ceil(wc / 200),
  };
}

// ── Stencil scorer ────────────────────────────────────────────────────────────

interface RawScore { type: VisualStencilType; score: number; signals: string[] }

function scoreNode(
  node: PageNode,
  html: HtmlSignals,
  vh: VisualHierarchy,
  urlBonus: Partial<Record<VisualStencilType, number>>,
  childCount: number,
): RawScore[] {
  const scores: RawScore[] = [
    { type: "HeroSection",      score: 0, signals: [] },
    { type: "ArticleLayout",    score: 0, signals: [] },
    { type: "GridLayout",       score: 0, signals: [] },
    { type: "FeatureBlock",     score: 0, signals: [] },
    { type: "NavigationLayout", score: 0, signals: [] },
  ];

  const add = (type: VisualStencilType, pts: number, signal: string) => {
    const entry = scores.find(s => s.type === type)!;
    entry.score += pts;
    if (pts > 0) entry.signals.push(signal);
  };

  const wc    = node.content.wordCount;
  const depth = node.relationships.depth;

  // ── Node type: primary, high-weight signals ────────────────────────────────

  if (node.nodeType === "root") {
    add("HeroSection",      4, "root-node");
    add("NavigationLayout", 1, "root-node");
  }
  if (node.nodeType === "index") {
    add("GridLayout",       3, "index-node");
    add("NavigationLayout", 2, "index-node");
  }
  if (node.nodeType === "pagination") {
    add("GridLayout",       4, "pagination-node");
  }
  if (node.nodeType === "article") {
    add("ArticleLayout",    3, "article-node");
  }

  // ── Depth signals ─────────────────────────────────────────────────────────

  if (depth === 0) {
    add("HeroSection",      3, "depth-0");
    add("NavigationLayout", 1, "depth-0");
  } else if (depth === 1) {
    add("FeatureBlock",     2, "depth-1");
    add("NavigationLayout", 1, "depth-1");
    add("GridLayout",       1, "depth-1");
  } else if (depth >= 2) {
    add("ArticleLayout",    2, `depth-${depth}`);
  }

  // ── Word count signals ────────────────────────────────────────────────────

  if (wc < 100) {
    add("HeroSection",      2, "low-word-count");
    add("NavigationLayout", 1, "low-word-count");
  } else if (wc < 300) {
    add("HeroSection",      1, "low-word-count");
    add("FeatureBlock",     2, "medium-low-word-count");
  } else if (wc < 600) {
    add("FeatureBlock",     2, "medium-word-count");
    add("GridLayout",       1, "medium-word-count");
  } else {
    add("ArticleLayout",    3, "high-word-count");
  }

  // ── Image / media signals ─────────────────────────────────────────────────

  const imgCt = vh.imageCount;
  if (imgCt === 0) {
    add("ArticleLayout",    1, "no-images");
    add("NavigationLayout", 1, "no-images");
  } else if (imgCt <= 2) {
    add("FeatureBlock",     1, "few-images");
    add("ArticleLayout",    1, "few-images");
  } else if (imgCt <= 5) {
    add("HeroSection",      1, "medium-images");
    add("FeatureBlock",     1, "medium-images");
    add("GridLayout",       1, "medium-images");
  } else {
    add("GridLayout",       2, "high-image-count");
    add("HeroSection",      1, "high-image-count");
  }

  // ── Child count signals ───────────────────────────────────────────────────

  if (childCount >= 8) {
    add("GridLayout",       2, "many-children");
    add("NavigationLayout", 2, "many-children");
  } else if (childCount >= 3) {
    add("GridLayout",       1, "some-children");
    add("NavigationLayout", 1, "some-children");
  } else if (childCount === 0) {
    add("ArticleLayout",    1, "leaf-node");
  }

  // ── Visual hierarchy signals ──────────────────────────────────────────────

  if (vh.hasHero) {
    add("HeroSection",      2, "hero-detected");
  }
  if (vh.hasCTA) {
    add("FeatureBlock",     2, "cta-present");
    add("HeroSection",      1, "cta-present");
  }
  if (vh.hasNavigation && depth <= 1) {
    add("NavigationLayout", 2, "nav-at-low-depth");
  }
  if (vh.sections >= 4) {
    add("FeatureBlock",     2, "many-sections");
    add("HeroSection",      1, "many-sections");
  } else if (vh.sections >= 2) {
    add("FeatureBlock",     1, "multiple-sections");
  }
  if (vh.headingDepth >= 3) {
    add("ArticleLayout",    2, "deep-heading-hierarchy");
  }

  // ── HTML signals ──────────────────────────────────────────────────────────

  if (html.listCount >= 3) {
    add("GridLayout",       1, "list-heavy");
    add("NavigationLayout", 1, "list-heavy");
  }
  if (html.tableCount >= 1) {
    add("ArticleLayout",    1, "has-tables");
    add("FeatureBlock",     1, "has-tables");
  }
  if (html.figureCount >= 4) {
    add("GridLayout",       1, "figure-rich");
  }
  if (html.formCount >= 1) {
    add("FeatureBlock",     1, "has-form");
    add("HeroSection",      1, "has-form");
  }

  // ── URL bonus (from semantic URL classification) ──────────────────────────

  for (const [type, bonus] of Object.entries(urlBonus)) {
    add(type as VisualStencilType, bonus, `url-pattern-${type.toLowerCase()}`);
  }

  return scores;
}

// ── Confidence calculator ─────────────────────────────────────────────────────

function computeConfidence(scores: RawScore[]): number {
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const top    = sorted[0]?.score ?? 0;
  const second = sorted[1]?.score ?? 0;
  if (top === 0) return 0.5;
  const gap   = top - second;
  const ratio = gap / top;
  return Math.min(0.98, Math.max(0.50, parseFloat((0.5 + ratio * 0.6).toFixed(2))));
}

// ── R2 utilities ──────────────────────────────────────────────────────────────

function r2Config() {
  return {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID     ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    endpoint:        process.env.R2_ENDPOINT          ?? "",
    bucket:          process.env.R2_BUCKET_NAME       ?? "",
    publicBase:      process.env.R2_PUBLIC_BASE_URL   ?? "",
  };
}

async function fetchJsonFromR2<T>(key: string): Promise<T | null> {
  const { accessKeyId, secretAccessKey, endpoint, bucket } = r2Config();
  if (!accessKeyId || !endpoint || !bucket) return null;
  try {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } });
    const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunks: Buffer[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const chunk of (resp.Body as any)) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    return null;
  }
}

async function uploadJsonToR2(data: unknown, key: string): Promise<string | null> {
  const { accessKeyId, secretAccessKey, endpoint, bucket, publicBase } = r2Config();
  if (!accessKeyId || !endpoint || !bucket) return null;
  try {
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } });
    const body = Buffer.from(JSON.stringify(data, null, 2), "utf8");
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json" }));
    return publicBase ? `${publicBase}/${key}` : key;
  } catch (err) {
    logger.warn({ err, key }, "STENCIL-MAP: R2 upload failed");
    return null;
  }
}

// ── Manifest loader ───────────────────────────────────────────────────────────

interface SerializedManifest {
  id: string;
  seedUrl: string;
  status: string;
  /**
   * Nodes may be stored in two formats depending on when the job ran:
   *   - Legacy: Array of [nodeId, PageNode] tuples  (Map serialization)
   *   - Current: Array of plain PageNode objects     (direct array serialization)
   * Both are handled below.
   */
  nodes: ([string, PageNode] | PageNode)[];
  stats?: unknown;
}

export async function loadManifestFromR2(jobId: string): Promise<Manifest | null> {
  const data = await fetchJsonFromR2<SerializedManifest>(`jobs/${jobId}/_manifest.json`);
  if (!data) return null;

  const raw = data.nodes ?? [];

  // Detect format: tuple `[string, PageNode]` vs plain `PageNode` object.
  // A tuple entry is a JS array; a plain node entry is a plain object.
  let nodeEntries: [string, PageNode][];
  if (raw.length === 0) {
    nodeEntries = [];
  } else if (Array.isArray(raw[0])) {
    // Legacy tuple format: [[nodeId, PageNode], ...]
    nodeEntries = raw as [string, PageNode][];
  } else {
    // Current plain-object format: [PageNode, ...]
    // Use node.id as the key (every PageNode has an `id` field).
    nodeEntries = (raw as PageNode[])
      .filter((n): n is PageNode => n != null && typeof n === "object" && typeof (n as PageNode).id === "string")
      .map(n => [n.id, n]);
  }

  const nodes = new Map<string, PageNode>(nodeEntries);

  return {
    id:        data.id,
    version:   "1.0",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    status:    data.status as any,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    seedUrl:   data.seedUrl,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config:    {} as any,
    nodes,
    seenUrls:  new Set<string>(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stats:     (data.stats ?? {}) as any,
  };
}

// ── SiteGraph layout assignment enrichment ────────────────────────────────────

interface SiteGraphLayoutAssignment {
  nodeId?: string;
  url?: string;
  layoutType?: string;
}

const SITEGRAPH_STENCIL_MAP: Record<string, VisualStencilType> = {
  LandingLayout:      "HeroSection",
  HeroLayout:         "HeroSection",
  ArticleLayout:      "ArticleLayout",
  BlogPostLayout:     "ArticleLayout",
  DocumentationLayout:"ArticleLayout",
  GridLayout:         "GridLayout",
  GalleryLayout:      "GridLayout",
  ListingLayout:      "GridLayout",
  PortfolioLayout:    "GridLayout",
  FeatureLayout:      "FeatureBlock",
  ServicesLayout:     "FeatureBlock",
  PricingLayout:      "FeatureBlock",
  NavigationLayout:   "NavigationLayout",
  CategoryLayout:     "NavigationLayout",
  IndexLayout:        "NavigationLayout",
};

function mapSiteGraphLayout(layoutType: string): VisualStencilType | null {
  return SITEGRAPH_STENCIL_MAP[layoutType] ?? null;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface StencilMapperInput {
  jobId: string;
  /** Pre-loaded manifest; if absent, loaded from R2 */
  manifest?: Manifest;
  /** SiteGraph.layoutAssignments if available */
  siteGraphLayouts?: SiteGraphLayoutAssignment[];
}

/**
 * runVisualStencilMapper — Phase 6.6 entry point.
 *
 * Maps every manifest node into a stencil type, preserving manifest ordering.
 * Uploads visualStencilMap.json to R2 and returns the full map.
 */
export async function runVisualStencilMapper(
  input: StencilMapperInput
): Promise<VisualStencilMap> {
  const { jobId } = input;
  const start = Date.now();

  logger.info({ jobId }, "STENCIL-MAP: starting");

  // ── Load manifest ─────────────────────────────────────────────────────────
  const manifest = input.manifest ?? await loadManifestFromR2(jobId);
  if (!manifest) {
    throw new Error(`STENCIL-MAP: manifest not found for jobId="${jobId}". ` +
      `Ensure the job has completed and _manifest.json exists in R2.`);
  }

  // ── Build SiteGraph layout lookup ─────────────────────────────────────────
  // If not passed in, try fetching from R2
  let siteGraphLayouts = input.siteGraphLayouts;
  if (!siteGraphLayouts) {
    const sgData = await fetchJsonFromR2<{ layoutAssignments?: SiteGraphLayoutAssignment[] }>(
      `jobs/${jobId}/_site-graph.json`
    );
    siteGraphLayouts = sgData?.layoutAssignments ?? [];
  }

  const sgLookup = new Map<string, VisualStencilType>();
  for (const la of (siteGraphLayouts ?? [])) {
    const stencil = la.layoutType ? mapSiteGraphLayout(la.layoutType) : null;
    if (stencil) {
      if (la.nodeId)  sgLookup.set(la.nodeId, stencil);
      if (la.url)     sgLookup.set(la.url, stencil);
    }
  }

  // ── Map each node ─────────────────────────────────────────────────────────
  // Preserve manifest ordering (Map iteration is insertion-order in JS)
  const allNodes = Array.from(manifest.nodes.values()).filter(
    (n): n is PageNode => n != null && n.nodeType !== "asset" // assets have no layout representation
  );

  const entries: StencilNodeEntry[] = [];
  const byStencilType: Record<VisualStencilType, number> = {
    HeroSection: 0, ArticleLayout: 0, GridLayout: 0,
    FeatureBlock: 0, NavigationLayout: 0,
  };
  let totalConfidence = 0;

  for (let idx = 0; idx < allNodes.length; idx++) {
    const node = allNodes[idx]!;
    const childCount = node.relationships.childIds.length;

    // Extract signals
    const html       = extractHtmlSignals(node.content.cleanHtml);
    const urlBonus   = classifyUrl(node.metadata.url);
    const vh         = buildVisualHierarchy(node, html);

    // Score all stencil types
    const rawScores  = scoreNode(node, html, vh, urlBonus, childCount);
    const sorted     = [...rawScores].sort((a, b) => b.score - a.score);
    const winner     = sorted[0]!;
    const confidence = computeConfidence(rawScores);

    // SiteGraph override: bump confidence and stencil if available
    let stencilType = winner.type;
    let finalConfidence = confidence;
    const sgStencil  = sgLookup.get(node.id) ?? sgLookup.get(node.metadata.url);
    if (sgStencil) {
      // SiteGraph has strong authority — use its layout if confidence is low
      if (sgStencil !== stencilType && confidence < 0.75) {
        stencilType     = sgStencil;
        finalConfidence = Math.min(0.98, confidence + 0.15);
        winner.signals.push("sitegraph-override");
      } else if (sgStencil === stencilType) {
        finalConfidence = Math.min(0.98, confidence + 0.10);
        winner.signals.push("sitegraph-confirmed");
      }
    }

    byStencilType[stencilType]++;
    totalConfidence += finalConfidence;

    entries.push({
      nodeId:          node.id,
      url:             node.metadata.url,
      title:           node.metadata.title,
      nodeType:        node.nodeType,
      depth:           node.relationships.depth,
      stencilType,
      confidence:      finalConfidence,
      visualHierarchy: vh,
      layoutSignals:   winner.signals,
      ordering:        idx,
    });
  }

  const mappingConfidence = allNodes.length > 0
    ? parseFloat((totalConfidence / allNodes.length).toFixed(3))
    : 0;

  // ── Aggregate node-type counts ────────────────────────────────────────────
  const nodeTypes: Record<string, number> = {};
  for (const n of allNodes) {
    nodeTypes[n.nodeType] = (nodeTypes[n.nodeType] ?? 0) + 1;
  }

  // ── Assemble report ───────────────────────────────────────────────────────
  const map: VisualStencilMap = {
    schemaVersion: "6.6",
    jobId,
    seedUrl:       manifest.seedUrl,
    generatedAt:   new Date().toISOString(),
    summary: {
      totalNodes:        entries.length,
      byStencilType,
      mappingConfidence,
      nodeTypes,
    },
    nodes: entries,
  };

  // ── Upload to R2 ──────────────────────────────────────────────────────────
  const r2Key = `jobs/${jobId}/visual-stencil-map.json`;
  const r2Url = await uploadJsonToR2(map, r2Key);
  if (r2Url) map.r2Key = r2Key;

  const durationMs = Date.now() - start;
  logger.info(
    { jobId, totalNodes: entries.length, byStencilType, mappingConfidence, durationMs },
    "STENCIL-MAP: complete"
  );

  return map;
}
