/**
 * consistency-engine-vr6.ts — Phase VR-6: Multi-Page Consistency Engine
 *
 * Consumes the full VR pipeline and produces two outputs:
 *
 *   consistency-rules.json   — extracted, globally-applicable design rules
 *   consistency-report.json  — per-page scores + four headline metrics
 *
 * Four scored metrics (0–100 each):
 *   componentConsistency — how uniformly global components appear across pages
 *   spacingConsistency   — how uniform section spacing / region heights are
 *   layoutConsistency    — how uniform section ordering is across pages
 *   themeConsistency     — how uniform colors / typography are across pages
 *
 * Inputs (all optional — engine degrades gracefully):
 *   VR-2  VisualDNA          → theme tokens (colors, typography, spacing scale)
 *   VR-3  LayoutMapBundle    → per-page region coordinates and types
 *   VR-4  ComponentLibrary   → shared/global component registry
 *   VR-5  VisualStencilReport→ section ordering, nav/footer placements
 *
 * Rules:
 *   - Does NOT rewrite content
 *   - Derives canonical values from majority-vote / median statistics
 *   - Every rule carries a confidence score so downstream generators can
 *     decide how strictly to enforce it
 */

import { writeFile, readFile } from "fs/promises";
import { join }               from "path";
import { logger }             from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import type { VisualDNA }             from "./screenshot-visual-dna-engine.js";
import type { LayoutMapBundle, RegionType, PageLayoutMap } from "./visual-layout-mapper-engine.js";
import type { ComponentLibrary, ComponentEntry, ComponentType } from "./component-extraction-engine.js";
import type { VisualStencilReport, NavigationPlacement, FooterPlacement, VisualStencilType } from "./visual-stencil-mapper-vr5-engine.js";

// ---------------------------------------------------------------------------
// Types — consistency-rules.json
// ---------------------------------------------------------------------------

export interface ComponentRule {
  componentId:    string | null;
  type:           ComponentType;
  isGlobal:       boolean;
  appearsOnPages: number;
  totalPages:     number;
  coverageRatio:  number;   // appearsOnPages / totalPages
  confidence:     number;
}

export interface NavigationRule {
  isShared:       boolean;
  component:      ComponentRule | null;
  placement:      NavigationPlacement;
  confidence:     number;
}

export interface FooterRule {
  isShared:   boolean;
  component:  ComponentRule | null;
  placement:  FooterPlacement;
  confidence: number;
}

export interface SpacingRules {
  canonicalScale:    string[];   // from VR-2
  sectionGap:        string;     // most common inter-section gap
  containerGap:      string;     // most common intra-container gap
  density:           "compact" | "normal" | "spacious";
  confidence:        number;
}

export interface TypographyRules {
  families:    string[];
  sizeScale:   string[];
  weightScale: string[];
  lineHeights: string[];
  confidence:  number;
}

export interface LayoutRules {
  canonicalSectionOrder: RegionType[];   // mode section-type sequence
  gridColumns:           number;
  maxWidth:              string | null;
  navigationPlacement:   NavigationPlacement;
  footerPlacement:       FooterPlacement;
  confidence:            number;
}

export interface ThemeRules {
  primaryColors:    string[];
  backgroundColors: string[];
  textColors:       string[];
  accentColors:     string[];
  confidence:       number;
}

export interface ConsistencyRules {
  schemaVersion:     "VR-6";
  jobId:             string;
  generatedAt:       string;
  navigation:        NavigationRule;
  footer:            FooterRule;
  sharedComponents:  ComponentRule[];
  spacing:           SpacingRules;
  typography:        TypographyRules;
  layout:            LayoutRules;
  theme:             ThemeRules;
  r2Key?:            string;
}

// ---------------------------------------------------------------------------
// Types — consistency-report.json
// ---------------------------------------------------------------------------

export interface ConsistencyMetrics {
  componentConsistency: number;   // 0–100
  spacingConsistency:   number;
  layoutConsistency:    number;
  themeConsistency:     number;
  overallConsistency:   number;   // weighted average
}

export type IssueKind =
  | "missing_global_nav"
  | "missing_global_footer"
  | "nav_placement_mismatch"
  | "footer_placement_mismatch"
  | "section_order_deviation"
  | "missing_expected_region"
  | "spacing_outlier"
  | "component_coverage_gap";

export interface ConsistencyIssueVR6 {
  pageId:          string;
  url:             string;
  kind:            IssueKind;
  severity:        "info" | "warning" | "error";
  description:     string;
  canonicalValue:  string;
  actualValue:     string;
  fix:             string;
}

export interface PageConsistencyScore {
  pageId:             string;
  url:                string;
  stencilType:        VisualStencilType | null;
  componentScore:     number;
  spacingScore:       number;
  layoutScore:        number;
  themeScore:         number;
  overallScore:       number;
  issues:             ConsistencyIssueVR6[];
}

export interface ConsistencyReport {
  schemaVersion:  "VR-6";
  jobId:          string;
  seedUrl:        string;
  generatedAt:    string;
  durationMs:     number;
  inputsUsed: {
    hasVisualDNA:        boolean;
    hasLayoutMap:        boolean;
    hasComponentLibrary: boolean;
    hasStencilReport:    boolean;
  };
  metrics:        ConsistencyMetrics;
  pages:          PageConsistencyScore[];
  issues:         ConsistencyIssueVR6[];
  rulesApplied:   ConsistencyRules;
  summary: {
    totalPages:        number;
    consistentPages:   number;   // overall >= 75
    inconsistentPages: number;
    topIssues:         string[];
    issueBySeverity:   Record<"info" | "warning" | "error", number>;
  };
  rulesR2Key?:   string;
  reportR2Key?:  string;
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

const _rulesCache  = new Map<string, ConsistencyRules>();
const _reportCache = new Map<string, ConsistencyReport>();

export function getCachedRules(jobId: string): ConsistencyRules | undefined {
  return _rulesCache.get(jobId);
}
export function getCachedConsistencyReport(jobId: string): ConsistencyReport | undefined {
  return _reportCache.get(jobId);
}

// ---------------------------------------------------------------------------
// Temp-dir loaders (same pattern as VR-5)
// ---------------------------------------------------------------------------

async function loadBundle<T>(jobId: string, filename: string): Promise<T | null> {
  const dirs = [
    join("/tmp/vr6", jobId),
    join("/tmp/vr5", jobId),
    join("/tmp/vr4", jobId),
    join("/tmp/vr3", jobId),
  ];
  for (const dir of dirs) {
    try {
      const raw = await readFile(join(dir, filename), "utf8");
      return JSON.parse(raw) as T;
    } catch { /* next */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

function median(vals: number[]): number {
  if (!vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function stdDev(vals: number[]): number {
  if (vals.length < 2) return 0;
  const m = vals.reduce((s, v) => s + v, 0) / vals.length;
  return Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length);
}

/** Returns the most frequent element (first on tie). */
function mode<T extends {}>(vals: T[]): T | null {
  if (!vals.length) return null;
  const freq = new Map<string, number>();
  for (const v of vals) {
    const k = JSON.stringify(v);
    freq.set(k, (freq.get(k) ?? 0) + 1);
  }
  let best = vals[0]!;
  let bestN = 0;
  for (const [k, n] of freq) {
    if (n > bestN) { bestN = n; best = JSON.parse(k) as T; }
  }
  return best;
}

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.round(Math.max(lo, Math.min(hi, v)));
}

// ---------------------------------------------------------------------------
// Rule derivation — Navigation
// ---------------------------------------------------------------------------

function deriveNavRule(
  components: ComponentLibrary | null,
  stencilReport: VisualStencilReport | null,
  totalPages: number,
): NavigationRule {
  if (!components && !stencilReport) {
    return { isShared: false, component: null, placement: "none", confidence: 0.30 };
  }

  // Find global nav component
  const globalNav = components?.components.find(c => c.type === "navigation_bar" && c.isGlobal) ?? null;
  const anyNav    = components?.components.find(c => c.type === "navigation_bar") ?? null;
  const navComp   = globalNav ?? anyNav;

  const appearsOn = navComp?.occurrences ?? 0;
  const coverage  = totalPages > 0 ? appearsOn / totalPages : 0;

  // Placement from VR-5 pages (mode)
  const placements = stencilReport?.pages.map(p => p.navigationPlacement) ?? [];
  const placement: NavigationPlacement = mode(placements) ?? "top-static";

  const rule: ComponentRule | null = navComp ? {
    componentId: navComp.componentId,
    type: "navigation_bar",
    isGlobal: navComp.isGlobal,
    appearsOnPages: appearsOn,
    totalPages,
    coverageRatio: Math.round(coverage * 100) / 100,
    confidence: Math.min(0.98, 0.50 + coverage * 0.48),
  } : null;

  return {
    isShared:   coverage >= 0.70,
    component:  rule,
    placement,
    confidence: rule ? rule.confidence : 0.40,
  };
}

// ---------------------------------------------------------------------------
// Rule derivation — Footer
// ---------------------------------------------------------------------------

function deriveFooterRule(
  components: ComponentLibrary | null,
  stencilReport: VisualStencilReport | null,
  totalPages: number,
): FooterRule {
  const globalFoot = components?.components.find(c => c.type === "footer" && c.isGlobal) ?? null;
  const anyFoot    = components?.components.find(c => c.type === "footer") ?? null;
  const footComp   = globalFoot ?? anyFoot;

  const appearsOn = footComp?.occurrences ?? 0;
  const coverage  = totalPages > 0 ? appearsOn / totalPages : 0;

  const placements = stencilReport?.pages.map(p => p.footerPlacement) ?? [];
  const placement: FooterPlacement = mode(placements) ?? "bottom-static";

  const rule: ComponentRule | null = footComp ? {
    componentId: footComp.componentId,
    type: "footer",
    isGlobal: footComp.isGlobal,
    appearsOnPages: appearsOn,
    totalPages,
    coverageRatio: Math.round(coverage * 100) / 100,
    confidence: Math.min(0.98, 0.50 + coverage * 0.48),
  } : null;

  return {
    isShared:   coverage >= 0.70,
    component:  rule,
    placement,
    confidence: rule ? rule.confidence : 0.40,
  };
}

// ---------------------------------------------------------------------------
// Rule derivation — Shared components (non-nav, non-footer)
// ---------------------------------------------------------------------------

function deriveSharedComponents(
  components: ComponentLibrary | null,
  totalPages: number,
): ComponentRule[] {
  if (!components) return [];
  return components.components
    .filter(c => c.type !== "navigation_bar" && c.type !== "footer" && c.occurrences >= 2)
    .map(c => ({
      componentId:    c.componentId,
      type:           c.type,
      isGlobal:       c.isGlobal,
      appearsOnPages: c.occurrences,
      totalPages,
      coverageRatio:  Math.round((c.occurrences / Math.max(totalPages, 1)) * 100) / 100,
      confidence:     Math.min(0.98, 0.45 + (c.occurrences / Math.max(totalPages, 1)) * 0.53),
    }))
    .sort((a, b) => b.coverageRatio - a.coverageRatio);
}

// ---------------------------------------------------------------------------
// Rule derivation — Spacing
// ---------------------------------------------------------------------------

function deriveSpacingRules(dna: VisualDNA | null, layoutMap: LayoutMapBundle | null): SpacingRules {
  const canonicalScale = dna?.spacing.scale ?? [];
  const containerGaps  = dna?.spacing.containerGaps ?? [];
  const sectionGaps    = dna?.spacing.sectionSpacing ?? [];

  // Derive section gap from VR-3: measure vertical gaps between consecutive regions per page
  const measuredGaps: number[] = [];
  if (layoutMap) {
    for (const page of layoutMap.pages) {
      const sorted = [...page.regions].sort((a, b) => a.y - b.y);
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i]!.y - (sorted[i - 1]!.y + sorted[i - 1]!.height);
        if (gap > 0 && gap < 300) measuredGaps.push(gap);
      }
    }
  }

  const medianGapPx = measuredGaps.length ? median(measuredGaps) : 0;
  const density: "compact" | "normal" | "spacious" =
    medianGapPx >= 80 ? "spacious" :
    medianGapPx >= 32 ? "normal"   : "compact";

  // Use first CSS section gap value if available, else derive from measurement
  const cssGap     = sectionGaps[0] ?? (medianGapPx > 0 ? `${Math.round(medianGapPx)}px` : "32px");
  const cssContGap = containerGaps[0] ?? "16px";

  const confidence = dna ? 0.85 : (layoutMap ? 0.65 : 0.40);

  return {
    canonicalScale,
    sectionGap:   cssGap,
    containerGap: cssContGap,
    density,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Rule derivation — Typography
// ---------------------------------------------------------------------------

function deriveTypographyRules(dna: VisualDNA | null): TypographyRules {
  if (!dna) {
    return {
      families: [], sizeScale: [], weightScale: [], lineHeights: [], confidence: 0.30,
    };
  }
  return {
    families:    dna.typography.families,
    sizeScale:   dna.typography.sizeScale,
    weightScale: dna.typography.weightScale,
    lineHeights: dna.typography.lineHeights,
    confidence:  dna.typography.confidence,
  };
}

// ---------------------------------------------------------------------------
// Rule derivation — Layout
// ---------------------------------------------------------------------------

function deriveLayoutRules(
  layoutMap:     LayoutMapBundle | null,
  stencilReport: VisualStencilReport | null,
  dna:           VisualDNA | null,
): LayoutRules {
  // Canonical section order — mode of top-to-bottom region sequences across pages
  const allOrders: RegionType[][] = [];
  if (layoutMap) {
    for (const page of layoutMap.pages) {
      const sorted = [...page.regions].sort((a, b) => a.y - b.y).map(r => r.type);
      if (sorted.length) allOrders.push(sorted);
    }
  } else if (stencilReport) {
    for (const page of stencilReport.pages) {
      const order = page.sectionOrder.map(s => s.type as RegionType);
      if (order.length) allOrders.push(order);
    }
  }

  // Canonical order = most common starting sequence (first 5 elements, padded)
  const normalised = allOrders.map(o => o.slice(0, 6));
  const canonicalSectionOrder: RegionType[] = deriveCanonicalOrder(normalised);

  // Grid columns from VR-2
  const cols    = dna?.layout.gridColumns ?? [];
  const maxCols = cols.length ? Math.max(...cols) : 3;
  const gridCols = maxCols >= 4 ? 4 : maxCols >= 3 ? 3 : 2;

  // Nav/footer placement from VR-5 (mode)
  const navPlacements  = stencilReport?.pages.map(p => p.navigationPlacement) ?? [];
  const footPlacements = stencilReport?.pages.map(p => p.footerPlacement) ?? [];
  const navPlacement: NavigationPlacement = mode(navPlacements) ?? "top-static";
  const footPlacement: FooterPlacement    = mode(footPlacements) ?? "bottom-static";

  const confidence = layoutMap ? 0.88 : (stencilReport ? 0.72 : 0.40);

  return {
    canonicalSectionOrder,
    gridColumns:         gridCols,
    maxWidth:            dna?.layout.maxWidth ?? null,
    navigationPlacement: navPlacement,
    footerPlacement:     footPlacement,
    confidence,
  };
}

/** Given a list of region-type sequences, derive the canonical ordering. */
function deriveCanonicalOrder(sequences: RegionType[][]): RegionType[] {
  if (!sequences.length) return ["navigation", "hero", "content", "cta", "footer"];

  // Collect position stats per region type
  const positions: Record<string, number[]> = {};
  const seen = new Set<RegionType>();

  for (const seq of sequences) {
    for (let i = 0; i < seq.length; i++) {
      const rt = seq[i]!;
      seen.add(rt);
      if (!positions[rt]) positions[rt] = [];
      positions[rt]!.push(i);
    }
  }

  // Sort region types by their median position
  return [...seen].sort((a, b) => {
    const ma = median(positions[a] ?? [999]);
    const mb = median(positions[b] ?? [999]);
    return ma - mb;
  });
}

// ---------------------------------------------------------------------------
// Rule derivation — Theme
// ---------------------------------------------------------------------------

function deriveThemeRules(dna: VisualDNA | null): ThemeRules {
  if (!dna) {
    return { primaryColors: [], backgroundColors: [], textColors: [], accentColors: [], confidence: 0.30 };
  }
  return {
    primaryColors:    dna.colors.primary,
    backgroundColors: dna.colors.background,
    textColors:       dna.colors.text,
    accentColors:     dna.colors.accent,
    confidence:       dna.colors.confidence,
  };
}

// ---------------------------------------------------------------------------
// Metric 1 — componentConsistency (0–100)
// ---------------------------------------------------------------------------
// Measures how reliably global components (nav, footer, shared components)
// appear across all pages.

function scoreComponentConsistency(
  navRule:    NavigationRule,
  footerRule: FooterRule,
  shared:     ComponentRule[],
  totalPages: number,
): number {
  if (totalPages === 0) return 50;

  // Nav: 40% weight
  const navScore = navRule.component
    ? navRule.component.coverageRatio * 100
    : (navRule.isShared ? 70 : 30);

  // Footer: 40% weight
  const footScore = footerRule.component
    ? footerRule.component.coverageRatio * 100
    : (footerRule.isShared ? 70 : 30);

  // Other shared: 20% weight
  const sharedScore = shared.length
    ? shared.reduce((s, c) => s + c.coverageRatio * 100, 0) / shared.length
    : 60; // no repeated components detected — neutral

  return clamp(navScore * 0.40 + footScore * 0.40 + sharedScore * 0.20);
}

// ---------------------------------------------------------------------------
// Metric 2 — spacingConsistency (0–100)
// ---------------------------------------------------------------------------
// Measures how uniform inter-section vertical gaps are across pages.

function scoreSpacingConsistency(
  layoutMap: LayoutMapBundle | null,
  dna: VisualDNA | null,
): number {
  // If VR-2 ran successfully, spacing tokens are site-wide → high base
  const dnaBonus = dna ? dna.spacing.confidence * 30 : 0;

  if (!layoutMap || !layoutMap.pages.length) return clamp(50 + dnaBonus);

  // Collect all inter-region vertical gaps
  const gaps: number[] = [];
  for (const page of layoutMap.pages) {
    const sorted = [...page.regions].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      const g = sorted[i]!.y - (sorted[i - 1]!.y + sorted[i - 1]!.height);
      if (g >= 0 && g < 400) gaps.push(g);
    }
  }

  if (!gaps.length) return clamp(50 + dnaBonus);

  const m  = median(gaps);
  const sd = stdDev(gaps);

  // Coefficient of variation — lower is more consistent
  const cv = m > 0 ? sd / m : 1;

  // cv=0 → 100, cv=1 → 0 (linear in 0–1 range)
  const rawScore = Math.max(0, (1 - Math.min(cv, 1)) * 100);
  return clamp(rawScore * 0.70 + dnaBonus);
}

// ---------------------------------------------------------------------------
// Metric 3 — layoutConsistency (0–100)
// ---------------------------------------------------------------------------
// Measures how closely each page's section order matches the canonical order.

function scoreLayoutConsistency(
  layoutMap: LayoutMapBundle | null,
  stencilReport: VisualStencilReport | null,
  canonicalOrder: RegionType[],
): number {
  const pages: PageLayoutMap[] = layoutMap?.pages ?? [];
  if (!pages.length && !stencilReport?.pages.length) return 60;

  const sequences: RegionType[][] = pages.length
    ? pages.map(p => [...p.regions].sort((a, b) => a.y - b.y).map(r => r.type))
    : (stencilReport?.pages.map(p => p.sectionOrder.map(s => s.type as RegionType)) ?? []);

  if (!sequences.length) return 60;

  const canonical = new Map(canonicalOrder.map((t, i) => [t, i]));

  // Per-page: score = fraction of region types that appear in canonical relative order
  const pageScores = sequences.map(seq => {
    if (!seq.length) return 70;
    let correct = 0;
    for (let i = 1; i < seq.length; i++) {
      const prev = canonical.get(seq[i - 1]!);
      const cur  = canonical.get(seq[i]!);
      if (prev !== undefined && cur !== undefined && cur >= prev) correct++;
    }
    const pairs = Math.max(seq.length - 1, 1);
    return (correct / pairs) * 100;
  });

  return clamp(median(pageScores));
}

// ---------------------------------------------------------------------------
// Metric 4 — themeConsistency (0–100)
// ---------------------------------------------------------------------------
// Measures how uniform the visual theme (colors, typography) is across pages.

function scoreThemeConsistency(dna: VisualDNA | null): number {
  if (!dna) return 55; // no VR-2 data — unknown

  // VR-2 extracts site-wide tokens — the extraction confidence is the best signal
  const colorConf = dna.colors.confidence;
  const typoConf  = dna.typography.confidence;
  const baseConf  = (colorConf * 0.5 + typoConf * 0.5);

  // Penalise if there are too many primary colors (inconsistent branding)
  const colorPenalty = Math.max(0, (dna.colors.primary.length - 4) * 3);

  // Penalise if too many font families (>3 usually indicates inconsistency)
  const fontPenalty = Math.max(0, (dna.typography.families.length - 3) * 5);

  return clamp(baseConf * 100 - colorPenalty - fontPenalty);
}

// ---------------------------------------------------------------------------
// Per-page scoring
// ---------------------------------------------------------------------------

function scorePages(
  layoutMap:      LayoutMapBundle | null,
  stencilReport:  VisualStencilReport | null,
  navRule:        NavigationRule,
  footerRule:     FooterRule,
  canonicalOrder: RegionType[],
  themeScore:     number,
): { pages: PageConsistencyScore[]; issues: ConsistencyIssueVR6[] } {
  const allIssues: ConsistencyIssueVR6[] = [];
  const pageScores: PageConsistencyScore[] = [];

  const layoutPages = layoutMap?.pages ?? [];
  const stencilPages = stencilReport?.pages ?? [];

  // Use layout map pages as primary, fall back to stencil report pages
  const pageIds: string[] = layoutPages.length
    ? layoutPages.map(p => p.pageId)
    : stencilPages.map(p => p.pageId);

  const canonical = new Map(canonicalOrder.map((t, i) => [t, i]));

  for (const pageId of pageIds) {
    const layoutPage  = layoutPages.find(p => p.pageId === pageId);
    const stencilPage = stencilPages.find(p => p.pageId === pageId);
    const url         = layoutPage?.url ?? stencilPage?.url ?? pageId;
    const stencilType = stencilPage?.stencilType ?? null;
    const pageIssues: ConsistencyIssueVR6[] = [];

    // ── Component score ──────────────────────────────────────────────────────
    let compScore = 100;

    // Check nav presence
    const hasNav = layoutPage?.regions.some(r => r.type === "navigation")
      ?? stencilPage?.sectionOrder.some(s => s.type === "navigation")
      ?? false;
    if (navRule.isShared && !hasNav) {
      compScore -= 25;
      pageIssues.push({
        pageId, url, kind: "missing_global_nav", severity: "warning",
        description: "Page is missing the shared navigation component.",
        canonicalValue: "navigation present",
        actualValue:    "navigation absent",
        fix: "Add the global navigation_bar component as the first section.",
      });
    }

    // Check footer presence
    const hasFoot = layoutPage?.regions.some(r => r.type === "footer")
      ?? stencilPage?.sectionOrder.some(s => s.type === "footer")
      ?? false;
    if (footerRule.isShared && !hasFoot) {
      compScore -= 20;
      pageIssues.push({
        pageId, url, kind: "missing_global_footer", severity: "warning",
        description: "Page is missing the shared footer component.",
        canonicalValue: "footer present",
        actualValue:    "footer absent",
        fix: "Add the global footer component as the last section.",
      });
    }

    // Check nav placement
    if (navRule.isShared && stencilPage) {
      const pagePlacement = stencilPage.navigationPlacement;
      if (pagePlacement !== "none" && pagePlacement !== navRule.placement) {
        compScore -= 10;
        pageIssues.push({
          pageId, url, kind: "nav_placement_mismatch", severity: "info",
          description: `Navigation placement "${pagePlacement}" differs from canonical "${navRule.placement}".`,
          canonicalValue: navRule.placement,
          actualValue:    pagePlacement,
          fix: `Standardise navigation placement to "${navRule.placement}".`,
        });
      }
    }

    // ── Spacing score ────────────────────────────────────────────────────────
    let spacingScore = 85; // base — per-page spacing data is limited without VR-2
    if (layoutPage) {
      const sorted = [...layoutPage.regions].sort((a, b) => a.y - b.y);
      const gaps = sorted.slice(1).map((r, i) => r.y - (sorted[i]!.y + sorted[i]!.height));
      const validGaps = gaps.filter(g => g >= 0 && g < 400);
      if (validGaps.length >= 2) {
        const sd = stdDev(validGaps);
        const m  = median(validGaps);
        const cv = m > 0 ? sd / m : 0;
        spacingScore = clamp((1 - Math.min(cv, 1)) * 100);
        if (cv > 0.5) {
          pageIssues.push({
            pageId, url, kind: "spacing_outlier", severity: "info",
            description: `Section spacing variance is high (CV=${cv.toFixed(2)}) — gaps are inconsistent.`,
            canonicalValue: `${Math.round(m)}px`,
            actualValue:    `CV ${cv.toFixed(2)}`,
            fix: "Apply a consistent section gap from the spacing scale.",
          });
        }
      }
    }

    // ── Layout score ─────────────────────────────────────────────────────────
    let layoutScore = 75;
    const seq: RegionType[] = layoutPage
      ? [...layoutPage.regions].sort((a, b) => a.y - b.y).map(r => r.type)
      : (stencilPage?.sectionOrder.map(s => s.type as RegionType) ?? []);

    if (seq.length >= 2) {
      let correct = 0;
      for (let i = 1; i < seq.length; i++) {
        const p = canonical.get(seq[i - 1]!);
        const c = canonical.get(seq[i]!);
        if (p !== undefined && c !== undefined && c >= p) correct++;
      }
      const pairs = seq.length - 1;
      layoutScore = clamp((correct / pairs) * 100);

      if (layoutScore < 60) {
        pageIssues.push({
          pageId, url, kind: "section_order_deviation", severity: "info",
          description: `Section order deviates from canonical (score ${layoutScore}).`,
          canonicalValue: canonicalOrder.join(" → "),
          actualValue:    seq.join(" → "),
          fix: "Reorder sections to follow the canonical layout: " + canonicalOrder.join(" → "),
        });
      }
    }

    const overallScore = clamp(
      compScore   * 0.35 +
      spacingScore * 0.25 +
      layoutScore * 0.25 +
      themeScore  * 0.15
    );

    allIssues.push(...pageIssues);
    pageScores.push({
      pageId, url, stencilType,
      componentScore: clamp(compScore),
      spacingScore:   clamp(spacingScore),
      layoutScore:    clamp(layoutScore),
      themeScore:     clamp(themeScore),
      overallScore,
      issues: pageIssues,
    });
  }

  return { pages: pageScores, issues: allIssues };
}

// ---------------------------------------------------------------------------
// R2 persistence
// ---------------------------------------------------------------------------

async function persistJSON(
  jobId: string,
  filename: string,
  data: unknown,
): Promise<string | null> {
  const key  = `jobs/${jobId}/${filename}`;
  const body = Buffer.from(JSON.stringify(data, null, 2), "utf8");

  // Write to temp disk
  try {
    await writeFile(join("/tmp/vr6", jobId, filename), body);
  } catch { /* best-effort */ }

  const cloud = getDefaultCloudProvider();
  if (!cloud.isConfigured()) return null;
  try {
    await cloud.upload({ key, data: body, contentType: "application/json", checkDuplicate: false });
    return key;
  } catch (err) {
    logger.warn({ jobId, err, key }, "VR6: R2 upload failed");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface VR6Input {
  jobId:          string;
  seedUrl?:       string;
  dna?:           VisualDNA;
  layoutMap?:     LayoutMapBundle;
  components?:    ComponentLibrary;
  stencilReport?: VisualStencilReport;
}

export async function runConsistencyEngineVR6(
  input: VR6Input,
): Promise<{ rules: ConsistencyRules; report: ConsistencyReport }> {
  const { jobId } = input;
  const startMs   = Date.now();
  logger.info({ jobId }, "VR6: starting consistency engine");

  // ── Load inputs (prefer passed-in, fall back to disk cache) ───────────────
  const dna     = input.dna
    ?? await loadBundle<VisualDNA>(jobId, "visual-dna.json");
  const layoutMap = input.layoutMap
    ?? await loadBundle<LayoutMapBundle>(jobId, "layout-map.json");
  const components = input.components
    ?? await loadBundle<ComponentLibrary>(jobId, "component-library.json");
  const stencilReport = input.stencilReport
    ?? await loadBundle<VisualStencilReport>(jobId, "visual-stencil-report.json");

  const inputsUsed = {
    hasVisualDNA:        !!dna,
    hasLayoutMap:        !!layoutMap,
    hasComponentLibrary: !!components,
    hasStencilReport:    !!stencilReport,
  };
  logger.info({ jobId, ...inputsUsed }, "VR6: inputs loaded");

  // Resolve total pages across available inputs
  const totalPages =
    layoutMap?.pages.length ??
    stencilReport?.pages.length ??
    components?.components[0]?.pages.length ??
    0;

  const seedUrl = input.seedUrl ?? stencilReport?.seedUrl ?? "";

  // ── Derive rules ──────────────────────────────────────────────────────────
  const navRule    = deriveNavRule(components, stencilReport, totalPages);
  const footerRule = deriveFooterRule(components, stencilReport, totalPages);
  const shared     = deriveSharedComponents(components, totalPages);
  const spacing    = deriveSpacingRules(dna, layoutMap);
  const typography = deriveTypographyRules(dna);
  const layout     = deriveLayoutRules(layoutMap, stencilReport, dna);
  const theme      = deriveThemeRules(dna);

  const rules: ConsistencyRules = {
    schemaVersion: "VR-6",
    jobId,
    generatedAt:   new Date().toISOString(),
    navigation:    navRule,
    footer:        footerRule,
    sharedComponents: shared,
    spacing,
    typography,
    layout,
    theme,
  };

  // ── Score four metrics ────────────────────────────────────────────────────
  const componentConsistency = scoreComponentConsistency(navRule, footerRule, shared, totalPages);
  const spacingConsistency   = scoreSpacingConsistency(layoutMap, dna);
  const layoutConsistency    = scoreLayoutConsistency(layoutMap, stencilReport, layout.canonicalSectionOrder);
  const themeConsistency     = scoreThemeConsistency(dna);
  const overallConsistency   = clamp(
    componentConsistency * 0.30 +
    spacingConsistency   * 0.25 +
    layoutConsistency    * 0.25 +
    themeConsistency     * 0.20
  );

  const metrics: ConsistencyMetrics = {
    componentConsistency,
    spacingConsistency,
    layoutConsistency,
    themeConsistency,
    overallConsistency,
  };

  // ── Per-page scores ───────────────────────────────────────────────────────
  const { pages, issues } = scorePages(
    layoutMap, stencilReport, navRule, footerRule,
    layout.canonicalSectionOrder, themeConsistency,
  );

  // ── Build summary ─────────────────────────────────────────────────────────
  const consistentPages   = pages.filter(p => p.overallScore >= 75).length;
  const issueBySeverity   = { info: 0, warning: 0, error: 0 };
  for (const i of issues) issueBySeverity[i.severity]++;

  // Top issues: most frequent issue kinds
  const kindFreq = new Map<string, number>();
  for (const i of issues) kindFreq.set(i.kind, (kindFreq.get(i.kind) ?? 0) + 1);
  const topIssues = [...kindFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, n]) => `${k} (×${n})`);

  const report: ConsistencyReport = {
    schemaVersion: "VR-6",
    jobId,
    seedUrl,
    generatedAt:  new Date().toISOString(),
    durationMs:   Date.now() - startMs,
    inputsUsed,
    metrics,
    pages,
    issues,
    rulesApplied: rules,
    summary: {
      totalPages,
      consistentPages,
      inconsistentPages: totalPages - consistentPages,
      topIssues,
      issueBySeverity,
    },
  };

  // ── Persist ───────────────────────────────────────────────────────────────
  try {
    const { mkdir } = await import("fs/promises");
    await mkdir(join("/tmp/vr6", jobId), { recursive: true });
  } catch { /* ok */ }

  const [rulesKey, reportKey] = await Promise.all([
    persistJSON(jobId, "consistency-rules.json", rules),
    persistJSON(jobId, "consistency-report.json", report),
  ]);
  if (rulesKey)  { rules.r2Key  = rulesKey;  report.rulesR2Key  = rulesKey; }
  if (reportKey) { report.reportR2Key = reportKey; }

  // Cache
  _rulesCache.set(jobId, rules);
  _reportCache.set(jobId, report);

  logger.info({
    jobId,
    durationMs: report.durationMs,
    componentConsistency,
    spacingConsistency,
    layoutConsistency,
    themeConsistency,
    overallConsistency,
    pages: pages.length,
    issues: issues.length,
  }, "VR6: complete");

  return { rules, report };
}
