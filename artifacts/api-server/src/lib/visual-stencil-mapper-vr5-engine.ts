/**
 * visual-stencil-mapper-vr5-engine.ts — Phase VR-5: Visual Stencil Mapper
 *
 * Upgrades stencil generation from content-guided (Phase 4.4) to visually-guided
 * by consuming all four upstream visual analysis outputs:
 *
 *   VR-1  Screenshot Capture     → page dimensions, layout metadata
 *   VR-2  Visual DNA             → colors, typography, spacing, layout grid, hierarchy
 *   VR-3  Visual Layout Mapper   → per-page region blueprints (nav/hero/content/cta/gallery/form/footer)
 *   VR-4  Component Extraction   → reusable component library, global component slots
 *
 * For each page, the engine:
 *   1. Sorts VR-3 regions top-to-bottom to determine section ordering
 *   2. Matches VR-4 global components into nav and footer slots
 *   3. Infers hero configuration from region dimensions + manifest media signals
 *   4. Derives navigation / footer placement from region geometry
 *
 * At the site level, the engine computes a visually-guided StencilType by
 * combining four scoring dimensions:
 *   visual_dna   (0.35) — grid columns, spacing, typography, color palette
 *   layout_map   (0.35) — region frequencies, hero/footer presence, cta ratio
 *   components   (0.20) — global/repeated component patterns
 *   content      (0.10) — manifest signals (word count, depth, page count)
 *
 * Output: visual-stencil-report.json
 *   Uploaded to R2 at jobs/{jobId}/visual-stencil-report.json
 *   Also cached in-memory for same-process retrieval.
 */

import { writeFile, readFile } from "fs/promises";
import { join }               from "path";
import { logger }             from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import type { Manifest, PageNode } from "./manifest.js";
import type { VisualDNA, VisualDNAReport } from "./screenshot-visual-dna-engine.js";
import type { LayoutMapBundle, LayoutRegion, PageLayoutMap, RegionType } from "./visual-layout-mapper-engine.js";
import type { ComponentLibrary, ComponentEntry, ComponentType } from "./component-extraction-engine.js";

// ---------------------------------------------------------------------------
// StencilType vocabulary (site-level — matches Phase 4.4)
// ---------------------------------------------------------------------------

export type StencilType =
  | "documentation"
  | "blog"
  | "magazine"
  | "luxury"
  | "agency"
  | "portfolio";

export const ALL_STENCIL_TYPES: StencilType[] = [
  "documentation", "blog", "magazine", "luxury", "agency", "portfolio",
];

// ---------------------------------------------------------------------------
// Per-page visual stencil types (matches Phase 6.6)
// ---------------------------------------------------------------------------

export type VisualStencilType =
  | "HeroSection"
  | "ArticleLayout"
  | "GridLayout"
  | "FeatureBlock"
  | "NavigationLayout";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface SectionSlot {
  order:       number;
  type:        RegionType;
  componentId: string | null;   // matched VR-4 component, if any
  widthPct:    number;          // fraction of page width (0–1)
  heightPx:    number;          // detected height in pixels
  confidence:  number;
}

export type NavigationPlacement = "top-fixed" | "top-sticky" | "top-static" | "none";
export type FooterPlacement     = "bottom-static" | "none";

export interface HeroConfig {
  present:        boolean;
  isFullViewport: boolean;
  heightPx:       number;
  heightPct:      number;
  hasMedia:       boolean;
  hasCTA:         boolean;
  mediaRichness:  "none" | "low" | "medium" | "high";
}

export interface VisualPageStencil {
  pageId:              string;
  url:                 string;
  stencilType:         VisualStencilType;
  confidence:          number;
  sectionOrder:        SectionSlot[];
  navigationPlacement: NavigationPlacement;
  footerPlacement:     FooterPlacement;
  heroConfig:          HeroConfig;
  visualSignals:       string[];
  regionCount:         number;
}

export interface GlobalComponentSlots {
  navigationSlot:     ComponentEntry | null;
  footerSlot:         ComponentEntry | null;
  repeatedComponents: ComponentEntry[];
}

export interface SiteStencilDecision {
  type:           StencilType;
  confidence:     number;
  confidenceLabel:"high" | "medium" | "low";
  visualSignals:  string[];   // what visual evidence drove the selection
  contentSignals: string[];   // manifest / content evidence that confirmed it
  visualOverride: boolean;    // true when visual signals disagree with content-only
  previousType:   StencilType | null; // content-only pick (for comparison)
}

export interface VisualStencilReport {
  schemaVersion:    "VR-5";
  jobId:            string;
  seedUrl:          string;
  generatedAt:      string;
  durationMs:       number;
  inputsUsed: {
    hasVisualDNA:        boolean;
    hasLayoutMap:        boolean;
    hasComponentLibrary: boolean;
    hasManifest:         boolean;
    pageCount:           number;
  };
  siteStencil:      SiteStencilDecision;
  globalComponents: GlobalComponentSlots;
  pages:            VisualPageStencil[];
  summary: {
    pagesAnalyzed:               number;
    visualConfidence:            number;
    totalSections:               number;
    navigationPlacementBreakdown: Record<NavigationPlacement, number>;
    footerPlacementBreakdown:     Record<FooterPlacement, number>;
    stencilTypeBreakdown:         Record<VisualStencilType, number>;
    layoutInsights:               string[];
    improvementsOverContentOnly:  string[];
  };
  r2Key?: string;
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

const _reportCache = new Map<string, VisualStencilReport>();
export function cacheReport(r: VisualStencilReport): void { _reportCache.set(r.jobId, r); }
export function getCachedReport(jobId: string): VisualStencilReport | undefined {
  return _reportCache.get(jobId);
}

// ---------------------------------------------------------------------------
// R2 / disk loader helpers
// ---------------------------------------------------------------------------

const TMP = "/tmp/vr5";

async function loadFromDisk<T>(jobId: string, file: string): Promise<T | null> {
  try {
    const raw = await readFile(join(TMP, jobId, file), "utf8");
    return JSON.parse(raw) as T;
  } catch { return null; }
}

async function loadBundle<T>(jobId: string, filename: string): Promise<T | null> {
  const disk = await loadFromDisk<T>(jobId, filename);
  if (disk) return disk;

  // Also check the VR-3/VR-4 temp directories
  try {
    const p1 = join("/tmp/vr3", jobId, filename);
    const raw = await readFile(p1, "utf8");
    return JSON.parse(raw) as T;
  } catch { /* fall through */ }

  try {
    const p2 = join("/tmp/vr4", jobId, filename);
    const raw = await readFile(p2, "utf8");
    return JSON.parse(raw) as T;
  } catch { /* fall through */ }

  return null;
}

// ---------------------------------------------------------------------------
// Scoring helpers — site-level stencil selection
// ---------------------------------------------------------------------------

interface DimScore { type: StencilType; raw: number; signals: string[] }

function normalise(scores: DimScore[]): Array<{ type: StencilType; norm: number; signals: string[] }> {
  const max = Math.max(...scores.map(s => s.raw), 0.001);
  return scores.map(s => ({ type: s.type, norm: s.raw / max, signals: s.signals }));
}

// Dimension 1 — Visual DNA (weight 0.35)
// Uses: grid columns, max-width, spacing scale, typography families, color count, shadow scale
function scoreVisualDNA(dna: VisualDNA): { scores: DimScore[]; topType: StencilType; signals: string[] } {
  const make = (type: StencilType): DimScore => ({ type, raw: 0, signals: [] });
  const S: Record<StencilType, DimScore> = {
    documentation: make("documentation"),
    blog:          make("blog"),
    magazine:      make("magazine"),
    luxury:        make("luxury"),
    agency:        make("agency"),
    portfolio:     make("portfolio"),
  };

  const add = (t: StencilType, pts: number, sig: string) => {
    S[t].raw += pts;
    if (pts > 0) S[t].signals.push(sig);
  };

  // Grid columns
  const cols = dna.layout.gridColumns;
  const maxCols = Math.max(...cols, 0);
  if (maxCols <= 1)       { add("documentation", 4, "single-column layout"); add("blog", 3, "single-column layout"); }
  else if (maxCols === 2) { add("blog", 2, "2-column grid"); add("luxury", 2, "2-column grid"); add("agency", 2, "2-column grid"); }
  else if (maxCols === 3) { add("magazine", 3, "3-column grid"); add("portfolio", 2, "3-column grid"); add("agency", 1, "3-column grid"); }
  else                    { add("magazine", 4, `${maxCols}-column grid`); add("portfolio", 3, `${maxCols}-column grid`); }

  // Max-width
  const mw = dna.layout.maxWidth ?? "";
  const mwPx = parseInt(mw, 10);
  if (!isNaN(mwPx)) {
    if (mwPx < 800)        { add("documentation", 3, `narrow max-width ${mw}`); add("blog", 2, `narrow max-width ${mw}`); }
    else if (mwPx < 1100)  { add("blog", 2, `standard max-width ${mw}`); }
    else if (mwPx > 1400)  { add("luxury", 2, `wide max-width ${mw}`); add("magazine", 2, `wide max-width ${mw}`); }
  }

  // Spacing scale — many large gaps → luxury; tight → documentation
  const sectionGaps = dna.spacing.sectionSpacing.map(v => parseInt(v, 10)).filter(n => !isNaN(n));
  const maxGap = Math.max(...sectionGaps, 0);
  if (maxGap >= 120)       { add("luxury", 4, `large section gaps (${maxGap}px)`); add("agency", 2, `large section gaps`); }
  else if (maxGap >= 64)   { add("blog", 2, "comfortable section spacing"); add("magazine", 1, "comfortable section spacing"); }
  else if (maxGap > 0 && maxGap < 32) { add("documentation", 3, "compact section spacing"); }

  // Typography families
  const fonts = dna.typography.families.join(" ").toLowerCase();
  if (/georgia|times|garamond|palatino|serif/.test(fonts) && !/mono/.test(fonts)) {
    add("luxury", 4, "serif typeface"); add("blog", 2, "serif typeface");
  }
  if (/mono|courier|consolas|fira|source code/.test(fonts)) {
    add("documentation", 5, "monospace typeface"); 
  }
  const fontCount = dna.typography.families.length;
  if (fontCount >= 3)      { add("magazine", 2, `rich font stack (${fontCount} families)`); add("luxury", 1, `rich font stack`); }
  else if (fontCount === 1) { add("documentation", 1, "single font family"); }

  // Color count — complex palette → magazine/agency; minimal → luxury/documentation
  const colorCount = dna.colors.all.length;
  if (colorCount >= 12)    { add("magazine", 3, `large color palette (${colorCount})`); add("agency", 2, `large color palette`); }
  else if (colorCount <= 4) { add("luxury", 3, `minimal palette (${colorCount} colors)`); add("documentation", 2, `minimal palette`); }
  else                      { add("blog", 1, `moderate palette (${colorCount} colors)`); }

  // Shadow scale — layered shadows → luxury/agency; none → documentation/blog
  const shadows = dna.hierarchy.shadowScale.filter(s => s !== "none" && s !== "0");
  if (shadows.length >= 3)  { add("luxury", 2, "rich shadow scale"); add("agency", 2, "rich shadow scale"); }
  else if (shadows.length === 0) { add("documentation", 1, "flat (no shadows)"); }

  // Overall confidence of dna itself
  if (dna.overallConfidence < 0.5) {
    // low confidence dna — reduce all scores
    for (const k of ALL_STENCIL_TYPES) S[k].raw *= 0.6;
  }

  const arr = Object.values(S);
  const top = arr.reduce((a, b) => (b.raw > a.raw ? b : a));
  const allSigs = arr.flatMap(s => s.signals);
  return { scores: arr, topType: top.type, signals: allSigs };
}

// Dimension 2 — Layout Map (weight 0.35)
// Uses: region type frequencies, hero presence, footer coverage, cta density, gallery pages
function scoreLayoutMap(bundle: LayoutMapBundle): { scores: DimScore[]; topType: StencilType; signals: string[] } {
  const make = (type: StencilType): DimScore => ({ type, raw: 0, signals: [] });
  const S: Record<StencilType, DimScore> = {
    documentation: make("documentation"),
    blog:          make("blog"),
    magazine:      make("magazine"),
    luxury:        make("luxury"),
    agency:        make("agency"),
    portfolio:     make("portfolio"),
  };
  const add = (t: StencilType, pts: number, sig: string) => {
    S[t].raw += pts;
    if (pts > 0) S[t].signals.push(sig);
  };

  const pages = bundle.pages;
  const total = pages.length;
  if (total === 0) return { scores: Object.values(S), topType: "blog", signals: ["no-pages"] };

  // Aggregate region type counts
  const regionCounts: Partial<Record<RegionType, number>> = {};
  let heroPages = 0, footerPages = 0, ctaPages = 0, galleryPages = 0, formPages = 0;

  for (const page of pages) {
    const types = new Set(page.regions.map(r => r.type));
    if (types.has("hero"))    heroPages++;
    if (types.has("footer"))  footerPages++;
    if (types.has("cta"))     ctaPages++;
    if (types.has("gallery")) galleryPages++;
    if (types.has("form"))    formPages++;
    for (const r of page.regions) {
      regionCounts[r.type] = (regionCounts[r.type] ?? 0) + 1;
    }
  }

  const heroRatio    = heroPages    / total;
  const footerRatio  = footerPages  / total;
  const ctaRatio     = ctaPages     / total;
  const galleryRatio = galleryPages / total;
  const formRatio    = formPages    / total;

  // Hero density
  if (heroRatio >= 0.8)      { add("luxury", 4, `hero on ${Math.round(heroRatio*100)}% of pages`); add("agency", 3, "pervasive hero sections"); }
  else if (heroRatio >= 0.4) { add("blog", 2, "moderate hero presence"); add("agency", 1, "moderate hero presence"); }
  else if (heroRatio < 0.1)  { add("documentation", 4, "minimal hero sections"); }

  // CTA density
  if (ctaRatio >= 0.7)       { add("agency", 5, `CTA on ${Math.round(ctaRatio*100)}% of pages`); add("luxury", 3, "high CTA density"); }
  else if (ctaRatio >= 0.4)  { add("agency", 2, "moderate CTA sections"); }
  else if (ctaRatio < 0.1)   { add("documentation", 2, "minimal CTA regions"); add("blog", 1, "minimal CTA regions"); }

  // Gallery density
  if (galleryRatio >= 0.5)   { add("portfolio", 6, `gallery on ${Math.round(galleryRatio*100)}% of pages`); add("magazine", 3, "pervasive galleries"); }
  else if (galleryRatio >= 0.2) { add("magazine", 3, "moderate gallery presence"); add("portfolio", 2, "moderate gallery presence"); }

  // Footer coverage — global footer → structured site
  if (footerRatio >= 0.9)    { add("documentation", 2, "global footer coverage"); add("blog", 2, "global footer coverage"); add("magazine", 1, "global footer coverage"); }
  else if (footerRatio < 0.3) { add("luxury", 2, "sparse footer (curated)"); add("portfolio", 1, "sparse footer"); }

  // Form presence
  if (formRatio >= 0.3)      { add("agency", 2, "forms across pages"); }

  // Content region density (many content regions → docs/blog)
  const contentCount = regionCounts["content"] ?? 0;
  const avgContent = contentCount / total;
  if (avgContent >= 3)       { add("documentation", 3, `${avgContent.toFixed(1)} avg content regions/page`); add("blog", 2, "content-rich pages"); }
  else if (avgContent <= 1)  { add("luxury", 2, "sparse content regions"); add("agency", 1, "spare content layout"); }

  // Page count (from bundle)
  if (total <= 8)            { add("luxury", 3, `small site (${total} pages)`); add("portfolio", 2, `small site`); add("agency", 2, `compact site`); }
  else if (total >= 30)      { add("magazine", 3, `large site (${total} pages)`); add("documentation", 2, `large site`); }
  else if (total >= 12)      { add("blog", 3, `mid-size site (${total} pages)`); add("magazine", 1, `mid-size site`); }

  const arr = Object.values(S);
  const top = arr.reduce((a, b) => (b.raw > a.raw ? b : a));
  return { scores: arr, topType: top.type, signals: arr.flatMap(s => s.signals) };
}

// Dimension 3 — Component Library (weight 0.20)
// Uses: global nav/footer presence, card/gallery/testimonial/cta_block densities
function scoreComponents(lib: ComponentLibrary): { scores: DimScore[]; topType: StencilType; signals: string[] } {
  const make = (type: StencilType): DimScore => ({ type, raw: 0, signals: [] });
  const S: Record<StencilType, DimScore> = {
    documentation: make("documentation"),
    blog:          make("blog"),
    magazine:      make("magazine"),
    luxury:        make("luxury"),
    agency:        make("agency"),
    portfolio:     make("portfolio"),
  };
  const add = (t: StencilType, pts: number, sig: string) => {
    S[t].raw += pts;
    if (pts > 0) S[t].signals.push(sig);
  };

  const byType = (ct: ComponentType) => lib.components.filter(c => c.type === ct);
  const globalOf = (ct: ComponentType) => byType(ct).filter(c => c.isGlobal);

  const hasGlobalNav  = globalOf("navigation_bar").length > 0;
  const hasGlobalFoot = globalOf("footer").length > 0;
  const cardCount     = byType("card").reduce((s, c) => s + c.occurrences, 0);
  const galleryCount  = byType("gallery").length;
  const testimCount   = byType("testimonial").length;
  const ctaBlockCount = byType("cta_block").length;
  const hasGlobalCTA  = globalOf("cta_block").length > 0;
  const formCount     = byType("form").length;

  if (hasGlobalNav && hasGlobalFoot) {
    add("documentation", 2, "global nav + footer"); add("blog", 2, "global nav + footer");
    add("agency", 1, "global nav + footer");
  }
  if (!hasGlobalFoot) { add("luxury", 2, "no global footer"); add("portfolio", 1, "no global footer"); }

  if (cardCount >= 10)   { add("magazine", 4, `${cardCount} card occurrences`); add("blog", 2, `many cards`); }
  else if (cardCount >= 4) { add("blog", 2, "moderate cards"); add("agency", 1, "moderate cards"); }

  if (galleryCount >= 2) { add("portfolio", 5, `${galleryCount} gallery components`); add("magazine", 3, `gallery components`); }
  else if (galleryCount === 1) { add("portfolio", 2, "gallery component"); add("magazine", 1, "gallery component"); }

  if (testimCount >= 2)  { add("agency", 4, `${testimCount} testimonial components`); add("luxury", 2, "testimonials"); }
  else if (testimCount === 1) { add("agency", 2, "testimonial component"); }

  if (ctaBlockCount >= 3) { add("agency", 4, `${ctaBlockCount} CTA blocks`); add("luxury", 2, "CTA blocks"); }
  else if (hasGlobalCTA)   { add("agency", 3, "global CTA block"); add("luxury", 2, "global CTA block"); }

  if (formCount >= 2)    { add("agency", 3, `${formCount} form components`); }

  const arr = Object.values(S);
  const top = arr.reduce((a, b) => (b.raw > a.raw ? b : a));
  return { scores: arr, topType: top.type, signals: arr.flatMap(s => s.signals) };
}

// Dimension 4 — Content / manifest (weight 0.10)
function scoreContent(manifest: Manifest): { scores: DimScore[]; topType: StencilType } {
  const make = (type: StencilType): DimScore => ({ type, raw: 0, signals: [] });
  const S: Record<StencilType, DimScore> = {
    documentation: make("documentation"),
    blog:          make("blog"),
    magazine:      make("magazine"),
    luxury:        make("luxury"),
    agency:        make("agency"),
    portfolio:     make("portfolio"),
  };
  const add = (t: StencilType, pts: number, sig: string) => {
    S[t].raw += pts; if (pts > 0) S[t].signals.push(sig);
  };

  const nodes = Array.from(manifest.nodes.values()).filter(n => n.nodeType !== "asset");
  const total = nodes.length;
  const avgWC = total > 0 ? nodes.reduce((s, n) => s + n.content.wordCount, 0) / total : 0;
  const maxDepth = Math.max(...nodes.map(n => n.relationships.depth), 0);

  if (total >= 30)  { add("documentation", 3, `${total} pages`); add("magazine", 2, `${total} pages`); }
  else if (total >= 10) { add("blog", 2, `${total} pages`); }
  else              { add("luxury", 2, `${total} pages`); add("agency", 2, `${total} pages`); }

  if (avgWC >= 800) { add("documentation", 3, `avg ${Math.round(avgWC)} words`); add("blog", 2, `avg ${Math.round(avgWC)} words`); }
  else if (avgWC >= 300) { add("blog", 1, `avg ${Math.round(avgWC)} words`); }
  else if (avgWC < 100) { add("luxury", 2, `low avg word count ${Math.round(avgWC)}`); add("portfolio", 2, `low avg word count`); }

  if (maxDepth >= 4) { add("documentation", 3, `depth ${maxDepth}`); }
  else if (maxDepth <= 1) { add("luxury", 2, "shallow site"); add("portfolio", 2, "shallow site"); }

  const arr = Object.values(S);
  const top = arr.reduce((a, b) => (b.raw > a.raw ? b : a));
  return { scores: arr, topType: top.type };
}

// Composite scorer (weighted average of normalised dimension scores)
function compositeSiteStencil(
  dnaScores:     DimScore[],
  layoutScores:  DimScore[],
  compScores:    DimScore[],
  contentScores: DimScore[],
  contentOnlyTop: StencilType,
): SiteStencilDecision {
  const WEIGHTS = { dna: 0.35, layout: 0.35, comp: 0.20, content: 0.10 };

  const normDNA     = normalise(dnaScores);
  const normLayout  = normalise(layoutScores);
  const normComp    = normalise(compScores);
  const normContent = normalise(contentScores);

  const finals: Array<{ type: StencilType; score: number }> = ALL_STENCIL_TYPES.map(t => {
    const d  = normDNA.find(s => s.type === t)?.norm     ?? 0;
    const l  = normLayout.find(s => s.type === t)?.norm  ?? 0;
    const c  = normComp.find(s => s.type === t)?.norm    ?? 0;
    const co = normContent.find(s => s.type === t)?.norm ?? 0;
    return { type: t, score: WEIGHTS.dna * d + WEIGHTS.layout * l + WEIGHTS.comp * c + WEIGHTS.content * co };
  }).sort((a, b) => b.score - a.score);

  const winner   = finals[0]!;
  const runnerUp = finals[1]!;
  const gap      = winner.score - runnerUp.score;

  const confLabel: "high" | "medium" | "low" =
    (winner.score >= 0.7 && gap >= 0.2) ? "high" :
    (winner.score >= 0.4 && gap >= 0.08) ? "medium" : "low";

  const visualSignals  = [...normDNA.find(s => s.type === winner.type)?.signals ?? [],
                          ...normLayout.find(s => s.type === winner.type)?.signals ?? [],
                          ...normComp.find(s => s.type === winner.type)?.signals ?? []];
  const contentSignals = normContent.find(s => s.type === winner.type)?.signals ?? [];
  const visualOverride = winner.type !== contentOnlyTop;

  return {
    type:           winner.type,
    confidence:     Math.round(winner.score * 100) / 100,
    confidenceLabel: confLabel,
    visualSignals:  [...new Set(visualSignals)].slice(0, 8),
    contentSignals: [...new Set(contentSignals)].slice(0, 4),
    visualOverride,
    previousType:   visualOverride ? contentOnlyTop : null,
  };
}

// ---------------------------------------------------------------------------
// Per-page stencil builder
// ---------------------------------------------------------------------------

// Map VR-3 RegionType to VisualStencilType
function regionDominantToStencilType(page: PageLayoutMap, manifest: Manifest): VisualStencilType {
  const types = page.regions.map(r => r.type);
  const has = (t: RegionType) => types.includes(t);

  const heroRegion    = page.regions.find(r => r.type === "hero");
  const galleryRegion = page.regions.find(r => r.type === "gallery");
  const contentCount  = types.filter(t => t === "content").length;
  const ctaRegion     = page.regions.find(r => r.type === "cta");

  // Gallery-dominant → GridLayout
  if (has("gallery") && galleryRegion) {
    const galleryFraction = galleryRegion.height / Math.max(page.pageHeight, 1);
    if (galleryFraction >= 0.25) return "GridLayout";
  }

  // Hero that fills most of above-fold → HeroSection
  if (heroRegion) {
    const heroFraction = heroRegion.height / Math.max(page.pageHeight, 1);
    if (heroFraction >= 0.35) return "HeroSection";
  }

  // Many content regions + no hero → ArticleLayout
  if (contentCount >= 3 && !has("hero")) return "ArticleLayout";

  // CTA-heavy + hero → FeatureBlock
  if (ctaRegion && has("hero")) return "FeatureBlock";

  // Mostly navigation + few content → NavigationLayout
  if (has("navigation") && !has("hero") && contentCount <= 1) return "NavigationLayout";

  // Default by page characteristics from manifest
  // Try matching node from manifest
  const node = findManifestNode(manifest, page.url);
  if (node) {
    if (node.nodeType === "pagination" || node.nodeType === "index") return "GridLayout";
    if (node.nodeType === "article" && node.content.wordCount >= 500) return "ArticleLayout";
  }

  return "FeatureBlock";
}

function findManifestNode(manifest: Manifest, url: string): PageNode | null {
  for (const node of manifest.nodes.values()) {
    if (node.metadata.url === url) return node;
  }
  return null;
}

function computePageConfidence(page: PageLayoutMap, stencilType: VisualStencilType): number {
  const regionCount = page.regions.length;
  if (regionCount === 0) return 0.50;

  const avgConf = page.regions.reduce((s, r) => s + r.confidence, 0) / regionCount;
  const typeBonus: Record<VisualStencilType, number> = {
    HeroSection:      page.regions.some(r => r.type === "hero") ? 0.10 : 0,
    ArticleLayout:    page.regions.filter(r => r.type === "content").length >= 2 ? 0.08 : 0,
    GridLayout:       page.regions.some(r => r.type === "gallery") ? 0.10 : 0,
    FeatureBlock:     page.regions.some(r => r.type === "cta") ? 0.08 : 0,
    NavigationLayout: page.regions.some(r => r.type === "navigation") ? 0.06 : 0,
  };
  return Math.min(0.98, parseFloat((avgConf + typeBonus[stencilType]).toFixed(2)));
}

function buildSectionSlots(
  page: PageLayoutMap,
  components: ComponentLibrary,
): SectionSlot[] {
  // Sort regions top-to-bottom
  const sorted = [...page.regions].sort((a, b) => a.y - b.y);

  return sorted.map((region, i) => {
    // Find a matching component by type mapping
    const compType = regionTypeToComponentType(region.type);
    const matchedComp = compType
      ? components.components.find(c => c.type === compType)
      : undefined;

    return {
      order:       i + 1,
      type:        region.type,
      componentId: matchedComp?.componentId ?? null,
      widthPct:    page.pageWidth > 0 ? Math.min(1, region.width / page.pageWidth) : 1,
      heightPx:    region.height,
      confidence:  region.confidence,
    };
  });
}

function regionTypeToComponentType(rt: RegionType): ComponentType | null {
  const map: Partial<Record<RegionType, ComponentType>> = {
    navigation: "navigation_bar",
    footer:     "footer",
    gallery:    "gallery",
    form:       "form",
    cta:        "cta_block",
  };
  return map[rt] ?? null;
}

function deriveNavPlacement(page: PageLayoutMap): NavigationPlacement {
  const navRegion = page.regions.find(r => r.type === "navigation");
  if (!navRegion) return "none";
  if (navRegion.y <= 4)    return "top-fixed";
  if (navRegion.y <= 20)   return "top-sticky";
  return "top-static";
}

function deriveFooterPlacement(page: PageLayoutMap): FooterPlacement {
  const footerRegion = page.regions.find(r => r.type === "footer");
  if (!footerRegion) return "none";
  const bottomEdge = footerRegion.y + footerRegion.height;
  const pageBound  = page.pageHeight;
  if (pageBound > 0 && bottomEdge / pageBound >= 0.8) return "bottom-static";
  return "bottom-static";
}

function buildHeroConfig(page: PageLayoutMap, manifest: Manifest): HeroConfig {
  const heroRegion = page.regions.find(r => r.type === "hero");
  if (!heroRegion) {
    return { present: false, isFullViewport: false, heightPx: 0, heightPct: 0,
             hasMedia: false, hasCTA: false, mediaRichness: "none" };
  }

  const heightPct    = page.pageHeight > 0 ? heroRegion.height / page.pageHeight : 0;
  const isFullView   = heightPct >= 0.40;
  const ctaRegion    = page.regions.find(r => r.type === "cta");

  // Look up manifest node for media signals
  const node         = findManifestNode(manifest, page.url);
  const imgCount     = node?.media.images.length ?? 0;
  const vidCount     = node?.media.videos.length ?? 0;
  const mediaTotal   = imgCount + vidCount;
  const hasMedia     = mediaTotal > 0;
  const mediaRich: "none" | "low" | "medium" | "high" =
    mediaTotal >= 6 ? "high" : mediaTotal >= 3 ? "medium" : mediaTotal >= 1 ? "low" : "none";

  return {
    present:       true,
    isFullViewport: isFullView,
    heightPx:      heroRegion.height,
    heightPct:     Math.round(heightPct * 100) / 100,
    hasMedia,
    hasCTA:        !!ctaRegion,
    mediaRichness: mediaRich,
  };
}

function buildPageVisualSignals(
  page: PageLayoutMap,
  stencilType: VisualStencilType,
  navPlacement: NavigationPlacement,
  heroConfig: HeroConfig,
  manifest: Manifest,
): string[] {
  const sigs: string[] = [];
  const types = page.regions.map(r => r.type);

  if (heroConfig.isFullViewport) sigs.push("full-viewport hero");
  if (heroConfig.hasMedia)       sigs.push(`media-rich hero (${heroConfig.mediaRichness})`);
  if (heroConfig.hasCTA)         sigs.push("CTA below hero");
  if (types.includes("gallery")) sigs.push("gallery region detected");
  if (types.includes("form"))    sigs.push("form region detected");
  if (navPlacement === "top-fixed") sigs.push("fixed navigation");
  if (types.filter(t => t === "content").length >= 3) sigs.push("content-rich page");

  const node = findManifestNode(manifest, page.url);
  if (node && node.relationships.depth === 0) sigs.push("root page");
  if (stencilType === "ArticleLayout" && node && node.content.wordCount >= 600)
    sigs.push(`long-form (${node.content.wordCount} words)`);

  return sigs;
}

function buildPageStencil(
  page: PageLayoutMap,
  components: ComponentLibrary,
  manifest: Manifest,
): VisualPageStencil {
  const stencilType    = regionDominantToStencilType(page, manifest);
  const confidence     = computePageConfidence(page, stencilType);
  const sectionOrder   = buildSectionSlots(page, components);
  const navPlacement   = deriveNavPlacement(page);
  const footerPlacement = deriveFooterPlacement(page);
  const heroConfig     = buildHeroConfig(page, manifest);
  const visualSignals  = buildPageVisualSignals(page, stencilType, navPlacement, heroConfig, manifest);

  return {
    pageId:              page.pageId,
    url:                 page.url,
    stencilType,
    confidence,
    sectionOrder,
    navigationPlacement: navPlacement,
    footerPlacement,
    heroConfig,
    visualSignals,
    regionCount:         page.regions.length,
  };
}

// ---------------------------------------------------------------------------
// Global component slots
// ---------------------------------------------------------------------------

function buildGlobalSlots(lib: ComponentLibrary): GlobalComponentSlots {
  const navSlot  = lib.components.find(c => c.type === "navigation_bar" && c.isGlobal) ?? null;
  const footSlot = lib.components.find(c => c.type === "footer" && c.isGlobal) ?? null;
  const repeated = lib.components.filter(c => c.occurrences >= 2 && c.type !== "navigation_bar" && c.type !== "footer");
  return { navigationSlot: navSlot, footerSlot: footSlot, repeatedComponents: repeated };
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(
  pages: VisualPageStencil[],
  decision: SiteStencilDecision,
  inputs: VisualStencilReport["inputsUsed"],
): VisualStencilReport["summary"] {
  const navBreakdown: Record<NavigationPlacement, number> = {
    "top-fixed": 0, "top-sticky": 0, "top-static": 0, "none": 0,
  };
  const footBreakdown: Record<FooterPlacement, number> = { "bottom-static": 0, "none": 0 };
  const typeBreakdown: Record<VisualStencilType, number> = {
    HeroSection: 0, ArticleLayout: 0, GridLayout: 0, FeatureBlock: 0, NavigationLayout: 0,
  };
  let totalSections = 0;
  let totalConf = 0;

  for (const p of pages) {
    navBreakdown[p.navigationPlacement]++;
    footBreakdown[p.footerPlacement]++;
    typeBreakdown[p.stencilType]++;
    totalSections += p.sectionOrder.length;
    totalConf += p.confidence;
  }

  const avgConf = pages.length > 0 ? totalConf / pages.length : 0;

  const insights: string[] = [];
  if (typeBreakdown.HeroSection >= pages.length * 0.4)
    insights.push("Hero sections dominate — visual-first layout strategy");
  if (typeBreakdown.ArticleLayout >= pages.length * 0.4)
    insights.push("Content-driven pages — editorial or documentation pattern");
  if (typeBreakdown.GridLayout >= pages.length * 0.3)
    insights.push("Grid layouts prevalent — magazine or portfolio pattern");
  if (navBreakdown["top-fixed"] >= pages.length * 0.6)
    insights.push("Fixed navigation detected across majority of pages");

  const improvements: string[] = [];
  if (inputs.hasVisualDNA)
    improvements.push("Typography and color palette inform stencil tone");
  if (inputs.hasLayoutMap)
    improvements.push("Region coordinates determine precise section ordering");
  if (inputs.hasComponentLibrary)
    improvements.push("Reusable components mapped into global nav/footer slots");
  if (decision.visualOverride)
    improvements.push(`Visual signals overrode content-only pick (${decision.previousType} → ${decision.type})`);

  return {
    pagesAnalyzed:               pages.length,
    visualConfidence:            Math.round(avgConf * 100) / 100,
    totalSections,
    navigationPlacementBreakdown: navBreakdown,
    footerPlacementBreakdown:     footBreakdown,
    stencilTypeBreakdown:         typeBreakdown,
    layoutInsights:               insights,
    improvementsOverContentOnly:  improvements,
  };
}

// ---------------------------------------------------------------------------
// R2 persistence
// ---------------------------------------------------------------------------

async function persistReport(
  jobId: string,
  report: VisualStencilReport,
): Promise<string | null> {
  const key  = `jobs/${jobId}/visual-stencil-report.json`;
  const body = Buffer.from(JSON.stringify(report, null, 2), "utf8");

  try {
    await writeFile(join("/tmp/vr5", jobId, "visual-stencil-report.json"), body);
  } catch { /* disk write best-effort */ }

  const cloud = getDefaultCloudProvider();
  if (!cloud.isConfigured()) return null;

  try {
    await cloud.upload({ key, data: body, contentType: "application/json", checkDuplicate: false });
    return key;
  } catch (err) {
    logger.warn({ jobId, err }, "VR5: R2 upload failed — continuing without remote persistence");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fallback: run with minimal inputs (only manifest available)
// ---------------------------------------------------------------------------

function fallbackPageStencils(manifest: Manifest): VisualPageStencil[] {
  const nodes = Array.from(manifest.nodes.values()).filter(n => n.nodeType !== "asset");
  return nodes.map((node, i) => {
    const type: VisualStencilType = node.nodeType === "root" ? "HeroSection"
      : node.nodeType === "article" ? "ArticleLayout"
      : node.nodeType === "index"   ? "GridLayout"
      : "FeatureBlock";
    return {
      pageId:              node.id,
      url:                 node.metadata.url,
      stencilType:         type,
      confidence:          0.55,
      sectionOrder:        [],
      navigationPlacement: "top-static" as NavigationPlacement,
      footerPlacement:     "bottom-static" as FooterPlacement,
      heroConfig: {
        present: type === "HeroSection", isFullViewport: false,
        heightPx: 0, heightPct: 0, hasMedia: false, hasCTA: false, mediaRichness: "none",
      },
      visualSignals:  ["manifest-only-fallback"],
      regionCount:    0,
    };
  });
}

// ---------------------------------------------------------------------------
// Public API — runVisualStencilMapperVR5
// ---------------------------------------------------------------------------

export interface VR5Input {
  jobId:     string;
  manifest?: Manifest;
  dna?:      VisualDNA | VisualDNAReport;
  layoutMap?: LayoutMapBundle;
  components?: ComponentLibrary;
}

export async function runVisualStencilMapperVR5(
  input: VR5Input,
): Promise<VisualStencilReport> {
  const { jobId } = input;
  const startMs = Date.now();
  logger.info({ jobId }, "VR5: starting visual stencil mapper");

  // ── Load manifest ─────────────────────────────────────────────────────────
  let manifest = input.manifest;
  if (!manifest) {
    // Try loading from in-memory manifest store (other routes cache it)
    const raw = await loadBundle<{ id: string; seedUrl: string; status: string; nodes: [string, PageNode][] }>(
      jobId, "_manifest.json"
    );
    if (raw) {
      manifest = {
        id: raw.id, version: "1.0", status: raw.status as "complete",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        seedUrl: raw.seedUrl, config: {} as never,
        nodes: new Map(raw.nodes ?? []),
        seenUrls: new Set(), stats: {} as never,
      };
    }
  }
  if (!manifest) {
    throw new Error(`VR5: manifest not found for jobId="${jobId}". Run a crawl first.`);
  }

  // ── Load VR-2 (Visual DNA) ────────────────────────────────────────────────
  let dna: VisualDNA | null = null;
  if (input.dna) {
    dna = "dna" in input.dna ? (input.dna as VisualDNAReport).dna : (input.dna as VisualDNA);
  } else {
    const raw = await loadBundle<VisualDNA | VisualDNAReport>(jobId, "visual-dna.json");
    if (raw) {
      dna = "dna" in (raw as VisualDNAReport) ? (raw as VisualDNAReport).dna : (raw as VisualDNA);
    }
  }

  // ── Load VR-3 (Layout Map) ────────────────────────────────────────────────
  let layoutMap: LayoutMapBundle | null = input.layoutMap ?? null;
  if (!layoutMap) {
    layoutMap = await loadBundle<LayoutMapBundle>(jobId, "layout-map.json");
  }

  // ── Load VR-4 (Component Library) ────────────────────────────────────────
  let components: ComponentLibrary | null = input.components ?? null;
  if (!components) {
    components = await loadBundle<ComponentLibrary>(jobId, "component-library.json");
  }

  const inputsUsed = {
    hasManifest:         true,
    hasVisualDNA:        !!dna,
    hasLayoutMap:        !!layoutMap,
    hasComponentLibrary: !!components,
    pageCount:           manifest.nodes.size,
  };

  logger.info({ jobId, ...inputsUsed }, "VR5: inputs loaded");

  // ── Score site-level stencil ──────────────────────────────────────────────
  const emptyDimScores = (): DimScore[] =>
    ALL_STENCIL_TYPES.map(t => ({ type: t, raw: 0.1, signals: [] }));

  const contentResult  = scoreContent(manifest);
  const dnaResult      = dna       ? scoreVisualDNA(dna)          : { scores: emptyDimScores(), topType: "blog" as StencilType, signals: [] };
  const layoutResult   = layoutMap ? scoreLayoutMap(layoutMap)     : { scores: emptyDimScores(), topType: "blog" as StencilType, signals: [] };
  const compResult     = components? scoreComponents(components)   : { scores: emptyDimScores(), topType: "blog" as StencilType, signals: [] };

  const siteStencil = compositeSiteStencil(
    dnaResult.scores, layoutResult.scores, compResult.scores, contentResult.scores,
    contentResult.topType,
  );

  // ── Build per-page stencils ───────────────────────────────────────────────
  const emptyLib: ComponentLibrary = {
    jobId, version: "0", totalComponents: 0, components: [], createdAt: new Date().toISOString(),
  };
  const lib = components ?? emptyLib;

  let pages: VisualPageStencil[];
  if (layoutMap && layoutMap.pages.length > 0) {
    pages = layoutMap.pages.map(page => buildPageStencil(page, lib, manifest!));
  } else {
    logger.warn({ jobId }, "VR5: no layout map — using manifest fallback for page stencils");
    pages = fallbackPageStencils(manifest);
  }

  // ── Build global component slots ──────────────────────────────────────────
  const globalComponents = buildGlobalSlots(lib);

  // ── Summary ───────────────────────────────────────────────────────────────
  const summary = buildSummary(pages, siteStencil, inputsUsed);

  // ── Assemble report ───────────────────────────────────────────────────────
  const report: VisualStencilReport = {
    schemaVersion: "VR-5",
    jobId,
    seedUrl:       manifest.seedUrl,
    generatedAt:   new Date().toISOString(),
    durationMs:    Date.now() - startMs,
    inputsUsed,
    siteStencil,
    globalComponents,
    pages,
    summary,
  };

  // ── Persist ───────────────────────────────────────────────────────────────
  const r2Key = await persistReport(jobId, report);
  if (r2Key) report.r2Key = r2Key;

  cacheReport(report);

  logger.info({ jobId, durationMs: report.durationMs, stencilType: siteStencil.type,
    confidence: siteStencil.confidence, pages: pages.length }, "VR5: complete");

  return report;
}
