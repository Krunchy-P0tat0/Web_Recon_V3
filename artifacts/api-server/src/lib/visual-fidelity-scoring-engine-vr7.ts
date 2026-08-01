/**
 * visual-fidelity-scoring-engine-vr7.ts — Phase VR-7: Visual Fidelity Scoring Engine
 *
 * Measures reconstruction quality by comparing the ORIGINAL site's VR pipeline
 * analysis outputs against the GENERATED (reconstructed) site's analysis outputs.
 *
 * Inputs (two job IDs, one per side):
 *   Source:    the original site (VR-1 → VR-6 pipeline already run)
 *   Generated: the reconstructed site (VR-1 → VR-6 pipeline already run)
 *
 * VR data consumed per side:
 *   VR-2  VisualDNA          → color, typography, spacing, layout tokens
 *   VR-3  LayoutMapBundle    → per-page region coordinates and types
 *   VR-4  ComponentLibrary   → detected component type/coverage
 *   VR-5  VisualStencilReport→ section ordering, nav/footer placements
 *   VR-6  ConsistencyRules   → canonical rules (authoritative site-level signal)
 *
 * Five scored dimensions (0–100 each):
 *   layoutScore     — section order, region count, grid, nav/footer placement
 *   colorScore      — palette distance (primary, background, text, accent)
 *   spacingScore    — spacing scale overlap, section gap distribution, density
 *   typographyScore — font family, size scale, weight scale overlap
 *   componentScore  — component type set coverage and global component presence
 *
 * Outputs:
 *   fidelity-score.json  — lightweight per-page array: { pageId, layoutScore,
 *                           colorScore, spacingScore, typographyScore,
 *                           componentScore, totalScore }
 *   fidelity-report.json — full report: global metrics, per-page detail,
 *                           issues, grade, input provenance
 *
 * Persistence: both files written to /tmp/vr7/{sourceJobId}/{generatedJobId}/
 * and uploaded to R2 at jobs/{sourceJobId}/fidelity-vr7/{generatedJobId}/
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join }                        from "path";
import { logger }                      from "./logger.js";
import { getDefaultCloudProvider }     from "../cloud/index.js";
import { paletteSimilarity }           from "./canonical-color-engine.js";

import type { VisualDNA }            from "./screenshot-visual-dna-engine.js";
import type { LayoutMapBundle, RegionType, PageLayoutMap } from "./visual-layout-mapper-engine.js";
import type { ComponentLibrary }     from "./component-extraction-engine.js";
import type { VisualStencilReport }  from "./visual-stencil-mapper-vr5-engine.js";
import type { ConsistencyRules }     from "./consistency-engine-vr6.js";

// ---------------------------------------------------------------------------
// Output types — fidelity-score.json
// ---------------------------------------------------------------------------

export interface FidelityPageScore {
  pageId:          string;
  url:             string;
  layoutScore:     number;   // 0–100
  colorScore:      number;
  spacingScore:    number;
  typographyScore: number;
  componentScore:  number;
  totalScore:      number;
}

export type FidelityScoreFile = FidelityPageScore[];

// ---------------------------------------------------------------------------
// Output types — fidelity-report.json
// ---------------------------------------------------------------------------

export type FidelityGradeVR7 = "A" | "B" | "C" | "D" | "F";

export interface FidelityIssueVR7 {
  dimension:    "layout" | "color" | "spacing" | "typography" | "component";
  pageId:       string | "global";
  severity:     "high" | "medium" | "low";
  description:  string;
  sourceValue:  string;
  genValue:     string;
  fix:          string;
}

export interface FidelityPageDetail extends FidelityPageScore {
  matchedGenPageId: string | null;
  matchedGenUrl:    string | null;
  sourceRegions:    RegionType[];
  genRegions:       RegionType[];
  issues:           FidelityIssueVR7[];
}

export interface FidelityGlobalMetrics {
  layoutScore:     number;
  colorScore:      number;
  spacingScore:    number;
  typographyScore: number;
  componentScore:  number;
  totalScore:      number;
  grade:           FidelityGradeVR7;
}

export interface FidelityReport {
  schemaVersion:   "VR-7";
  sourceJobId:     string;
  generatedJobId:  string;
  seedUrl:         string;
  generatedAt:     string;
  durationMs:      number;
  inputsUsed: {
    source: {
      hasVR2: boolean; hasVR3: boolean; hasVR4: boolean;
      hasVR5: boolean; hasVR6: boolean;
    };
    generated: {
      hasVR2: boolean; hasVR3: boolean; hasVR4: boolean;
      hasVR5: boolean; hasVR6: boolean;
    };
  };
  global:  FidelityGlobalMetrics;
  pages:   FidelityPageDetail[];
  issues:  FidelityIssueVR7[];
  summary: {
    pagesCompared:   number;
    pagesAbove75:    number;
    pagesBelowPass:  number;   // below 60
    topDimension:    string;   // highest scoring
    weakDimension:   string;   // lowest scoring
    issueBySeverity: Record<"high" | "medium" | "low", number>;
  };
  scoreFile:  FidelityScoreFile;
  r2ScoreKey?:  string;
  r2ReportKey?: string;
}

// ---------------------------------------------------------------------------
// In-memory cache  { "sourceJobId::generatedJobId" → report }
// ---------------------------------------------------------------------------

const _cache = new Map<string, FidelityReport>();

export function getCachedFidelityReport(
  sourceJobId: string,
  generatedJobId: string,
): FidelityReport | undefined {
  return _cache.get(`${sourceJobId}::${generatedJobId}`);
}

// ---------------------------------------------------------------------------
// Disk loader — tries all VR temp dirs, returns null if not found
// ---------------------------------------------------------------------------

async function loadVR<T>(
  jobId: string,
  filename: string,
  dirs = ["vr6", "vr5", "vr4", "vr3", "vr2"],
): Promise<T | null> {
  for (const d of dirs) {
    try {
      const raw = await readFile(join(`/tmp/${d}`, jobId, filename), "utf8");
      return JSON.parse(raw) as T;
    } catch { /* next */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Color helpers — hexToRgb / paletteSimilarity imported from canonical-color-engine
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Set overlap helper
// ---------------------------------------------------------------------------

function setOverlap(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 100;
  if (!a.length || !b.length) return 0;
  const sa = new Set(a.map(x => x.toLowerCase().trim()));
  const sb = new Set(b.map(x => x.toLowerCase().trim()));
  let inter = 0;
  for (const v of sa) if (sb.has(v)) inter++;
  const union = new Set([...sa, ...sb]).size;
  return clamp(Math.round((inter / union) * 100));
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

function clamp(v: number): number { return Math.max(0, Math.min(100, Math.round(v))); }

function numProx(a: number, b: number, maxDelta: number): number {
  return clamp(Math.round((1 - Math.abs(a - b) / maxDelta) * 100));
}

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

// ---------------------------------------------------------------------------
// Longest Common Subsequence ratio  (for region-type sequences)
// ---------------------------------------------------------------------------

function lcsRatio(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1]
        ? dp[i - 1]![j - 1]! + 1
        : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  const lcs = dp[m]![n]!;
  const maxLen = Math.max(m, n);
  return clamp(Math.round((lcs / maxLen) * 100));
}

// ---------------------------------------------------------------------------
// Dimension scorers — GLOBAL (site-wide VR-2/4/6 data)
// ---------------------------------------------------------------------------

/** colorScore — compare VR-2 palettes (primary, background, text, accent) */
function scoreColorGlobal(
  srcDNA: VisualDNA | null,
  genDNA: VisualDNA | null,
): { score: number; issues: Omit<FidelityIssueVR7, "pageId">[] } {
  if (!srcDNA || !genDNA) return { score: 75, issues: [] }; // no data — calibrated neutral baseline

  const issues: Omit<FidelityIssueVR7, "pageId">[] = [];

  const primarySim = paletteSimilarity(srcDNA.colors.primary,    genDNA.colors.primary);
  const bgSim      = paletteSimilarity(srcDNA.colors.background, genDNA.colors.background);
  const textSim    = paletteSimilarity(srcDNA.colors.text,       genDNA.colors.text);
  const accentSim  = paletteSimilarity(srcDNA.colors.accent,     genDNA.colors.accent);

  if (primarySim < 60) issues.push({
    dimension: "color", severity: "high",
    description: `Primary color palettes diverge (similarity ${primarySim}/100)`,
    sourceValue: srcDNA.colors.primary.slice(0, 4).join(", "),
    genValue:    genDNA.colors.primary.slice(0, 4).join(", "),
    fix: "Match the primary palette in the reconstruction theme config.",
  });
  if (bgSim < 50) issues.push({
    dimension: "color", severity: "medium",
    description: `Background colors diverge (similarity ${bgSim}/100)`,
    sourceValue: srcDNA.colors.background.slice(0, 3).join(", "),
    genValue:    genDNA.colors.background.slice(0, 3).join(", "),
    fix: "Update the reconstructed site's background color tokens.",
  });
  if (textSim < 50) issues.push({
    dimension: "color", severity: "medium",
    description: `Text colors diverge (similarity ${textSim}/100)`,
    sourceValue: srcDNA.colors.text.slice(0, 3).join(", "),
    genValue:    genDNA.colors.text.slice(0, 3).join(", "),
    fix: "Align text color tokens with the source palette.",
  });

  // Weighted: primary ×2, bg ×1.5, text ×1, accent ×0.5
  const score = clamp(Math.round(
    (primarySim * 2 + bgSim * 1.5 + textSim * 1 + accentSim * 0.5) / 5
  ));
  return { score, issues };
}

/** typographyScore — compare VR-2 font families, size scale, weights */
function scoreTypographyGlobal(
  srcDNA: VisualDNA | null,
  genDNA: VisualDNA | null,
): { score: number; issues: Omit<FidelityIssueVR7, "pageId">[] } {
  if (!srcDNA || !genDNA) return { score: 75, issues: [] }; // calibrated neutral baseline

  const issues: Omit<FidelityIssueVR7, "pageId">[] = [];

  const familySim = setOverlap(srcDNA.typography.families,    genDNA.typography.families);
  const sizeSim   = setOverlap(srcDNA.typography.sizeScale,   genDNA.typography.sizeScale);
  const weightSim = setOverlap(srcDNA.typography.weightScale, genDNA.typography.weightScale);
  const lhSim     = setOverlap(srcDNA.typography.lineHeights, genDNA.typography.lineHeights);

  if (familySim < 50) issues.push({
    dimension: "typography", severity: "high",
    description: `Font families diverge (overlap ${familySim}%)`,
    sourceValue: srcDNA.typography.families.slice(0, 3).join(", "),
    genValue:    genDNA.typography.families.slice(0, 3).join(", "),
    fix: "Use the same font families (or CSSC-equivalent substitutes) in the reconstruction.",
  });
  if (sizeSim < 40) issues.push({
    dimension: "typography", severity: "medium",
    description: `Type size scale mismatch (overlap ${sizeSim}%)`,
    sourceValue: srcDNA.typography.sizeScale.slice(0, 5).join(", "),
    genValue:    genDNA.typography.sizeScale.slice(0, 5).join(", "),
    fix: "Align the type scale tokens.",
  });

  // Weighted: family ×3, size ×2, weight ×1.5, lineHeight ×0.5
  const score = clamp(Math.round(
    (familySim * 3 + sizeSim * 2 + weightSim * 1.5 + lhSim * 0.5) / 7
  ));
  return { score, issues };
}

/** spacingScore — compare VR-2 spacing scale and VR-3 gap distributions */
function scoreSpacingGlobal(
  srcDNA:    VisualDNA | null,
  genDNA:    VisualDNA | null,
  srcLayout: LayoutMapBundle | null,
  genLayout: LayoutMapBundle | null,
): { score: number; issues: Omit<FidelityIssueVR7, "pageId">[] } {
  const issues: Omit<FidelityIssueVR7, "pageId">[] = [];
  const parts: number[] = [];

  // VR-2 spacing scale overlap
  if (srcDNA && genDNA) {
    const scaleSim   = setOverlap(srcDNA.spacing.scale,          genDNA.spacing.scale);
    const sectionSim = setOverlap(srcDNA.spacing.sectionSpacing, genDNA.spacing.sectionSpacing);
    const gapSim     = setOverlap(srcDNA.spacing.containerGaps,  genDNA.spacing.containerGaps);
    parts.push(scaleSim * 1.5, sectionSim * 1.0, gapSim * 0.5);
    if (scaleSim < 40) issues.push({
      dimension: "spacing", severity: "medium",
      description: `Spacing scale mismatch (overlap ${scaleSim}%)`,
      sourceValue: srcDNA.spacing.scale.slice(0, 5).join(", "),
      genValue:    genDNA.spacing.scale.slice(0, 5).join(", "),
      fix: "Apply the canonical spacing scale from consistency-rules.json.",
    });
  }

  // VR-3 inter-region gap distribution comparison
  if (srcLayout && genLayout) {
    const srcGaps = extractGaps(srcLayout);
    const genGaps = extractGaps(genLayout);
    if (srcGaps.length && genGaps.length) {
      const srcMed = median(srcGaps);
      const genMed = median(genGaps);
      const gapProx = numProx(srcMed, genMed, 80);   // 80px tolerance
      parts.push(gapProx);

      // Gap distribution cv comparison
      const srcCV = srcMed > 0 ? stdDev(srcGaps) / srcMed : 0;
      const genCV = genMed > 0 ? stdDev(genGaps) / genMed : 0;
      const cvSim = clamp(Math.round((1 - Math.abs(srcCV - genCV)) * 100));
      parts.push(cvSim);

      if (gapProx < 50) issues.push({
        dimension: "spacing", severity: "medium",
        description: `Section gap size differs (source median ${Math.round(srcMed)}px vs generated ${Math.round(genMed)}px)`,
        sourceValue: `${Math.round(srcMed)}px`,
        genValue:    `${Math.round(genMed)}px`,
        fix: "Apply the sectionGap token from consistency-rules.json.",
      });
    }
  }

  if (!parts.length) return { score: 75, issues }; // calibrated neutral baseline

  const weights = [1.5, 1.0, 0.5, 1.0, 1.0]; // parallel to push order
  let wSum = 0, wTotal = 0;
  for (let i = 0; i < parts.length; i++) {
    const w = weights[i] ?? 1.0;
    wSum   += parts[i]! * w;
    wTotal += w;
  }
  return { score: clamp(Math.round(wSum / wTotal)), issues };
}

function extractGaps(bundle: LayoutMapBundle): number[] {
  const gaps: number[] = [];
  for (const page of bundle.pages) {
    const sorted = [...page.regions].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      const g = sorted[i]!.y - (sorted[i - 1]!.y + sorted[i - 1]!.height);
      if (g >= 0 && g < 400) gaps.push(g);
    }
  }
  return gaps;
}

/** componentScore — compare VR-4 component type sets + global component coverage */
function scoreComponentGlobal(
  srcComp: ComponentLibrary | null,
  genComp: ComponentLibrary | null,
  srcRules: ConsistencyRules | null,
  genRules: ConsistencyRules | null,
): { score: number; issues: Omit<FidelityIssueVR7, "pageId">[] } {
  if (!srcComp && !genComp) return { score: 65, issues: [] };

  const issues: Omit<FidelityIssueVR7, "pageId">[] = [];

  // Component type set overlap
  const srcTypes = new Set(srcComp?.components.map(c => c.type) ?? []);
  const genTypes = new Set(genComp?.components.map(c => c.type) ?? []);
  const srcArr   = [...srcTypes];
  const genArr   = [...genTypes];
  const typeSim  = setOverlap(srcArr, genArr);

  // Missing global components
  const srcGlobal = srcComp?.components.filter(c => c.isGlobal).map(c => c.type) ?? [];
  const genGlobal = genComp?.components.filter(c => c.isGlobal).map(c => c.type) ?? [];
  const missingGlobal = srcGlobal.filter(t => !genGlobal.includes(t));

  for (const t of missingGlobal) {
    issues.push({
      dimension: "component", severity: "high",
      description: `Global component "${t}" present in source but missing from reconstruction`,
      sourceValue: "present (global)",
      genValue:    "absent",
      fix: `Add the "${t}" component to the reconstructed site's global layout.`,
    });
  }

  // Nav/footer coverage (from VR-6 rules if available)
  let ruleSim = 100;
  if (srcRules && genRules) {
    const navMatch  = srcRules.navigation.isShared === genRules.navigation.isShared ? 100 : 30;
    const footMatch = srcRules.footer.isShared === genRules.footer.isShared ? 100 : 30;
    ruleSim = Math.round((navMatch + footMatch) / 2);
    if (navMatch < 60) issues.push({
      dimension: "component", severity: "medium",
      description: `Navigation sharing mismatch (source isShared=${srcRules.navigation.isShared})`,
      sourceValue: String(srcRules.navigation.isShared),
      genValue:    String(genRules.navigation.isShared),
      fix: "Ensure navigation is treated as a global shared component in the reconstruction.",
    });
  }

  const missingPenalty = missingGlobal.length * 8;
  const score = clamp(Math.round(
    typeSim * 0.60 + ruleSim * 0.30 - missingPenalty
  ));
  return { score, issues };
}

/** layoutScore — global: section order similarity via VR-3/VR-5/VR-6 */
function scoreLayoutGlobal(
  srcLayout:  LayoutMapBundle | null,
  genLayout:  LayoutMapBundle | null,
  srcStencil: VisualStencilReport | null,
  genStencil: VisualStencilReport | null,
  srcRules:   ConsistencyRules | null,
  genRules:   ConsistencyRules | null,
): { score: number; issues: Omit<FidelityIssueVR7, "pageId">[] } {
  const issues: Omit<FidelityIssueVR7, "pageId">[] = [];
  const parts: number[] = [];

  // Canonical section order similarity (VR-6 rules)
  if (srcRules && genRules) {
    const srcOrder = srcRules.layout.canonicalSectionOrder;
    const genOrder = genRules.layout.canonicalSectionOrder;
    const orderSim = lcsRatio(srcOrder, genOrder);
    parts.push(orderSim);
    if (orderSim < 60) issues.push({
      dimension: "layout", severity: "high",
      description: `Canonical section order diverges (LCS similarity ${orderSim}%)`,
      sourceValue: srcOrder.join(" → "),
      genValue:    genOrder.join(" → "),
      fix: "Align the reconstructed page section order to the source canonical.",
    });

    // Grid columns
    const colSim = numProx(srcRules.layout.gridColumns, genRules.layout.gridColumns, 4);
    parts.push(colSim);
    if (colSim < 50) issues.push({
      dimension: "layout", severity: "medium",
      description: `Grid column count differs (source ${srcRules.layout.gridColumns} vs gen ${genRules.layout.gridColumns})`,
      sourceValue: String(srcRules.layout.gridColumns),
      genValue:    String(genRules.layout.gridColumns),
      fix: "Match the grid column count in the reconstruction layout template.",
    });

    // Nav placement
    if (srcRules.layout.navigationPlacement !== genRules.layout.navigationPlacement) {
      parts.push(40);
      issues.push({
        dimension: "layout", severity: "medium",
        description: `Nav placement: source="${srcRules.layout.navigationPlacement}" vs generated="${genRules.layout.navigationPlacement}"`,
        sourceValue: srcRules.layout.navigationPlacement,
        genValue:    genRules.layout.navigationPlacement,
        fix: `Set navigation placement to "${srcRules.layout.navigationPlacement}".`,
      });
    } else { parts.push(100); }
  }

  // Page count proximity  (from VR-3 or VR-5)
  const srcPageCount = srcLayout?.pages.length ?? srcStencil?.pages.length ?? 0;
  const genPageCount = genLayout?.pages.length ?? genStencil?.pages.length ?? 0;
  if (srcPageCount > 0 && genPageCount > 0) {
    const countSim = numProx(srcPageCount, genPageCount, Math.max(srcPageCount, genPageCount));
    parts.push(countSim);
    if (countSim < 50) issues.push({
      dimension: "layout", severity: "medium",
      description: `Page count differs (source ${srcPageCount} vs generated ${genPageCount})`,
      sourceValue: String(srcPageCount),
      genValue:    String(genPageCount),
      fix: "Ensure reconstruction produces the same number of pages as the source.",
    });
  }

  if (!parts.length) return { score: 65, issues };
  const score = clamp(Math.round(parts.reduce((a, b) => a + b, 0) / parts.length));
  return { score, issues };
}

// ---------------------------------------------------------------------------
// Per-page scoring
// ---------------------------------------------------------------------------

/** Match source pages to generated pages by URL path; positional fallback. */
function matchPages(
  src: PageLayoutMap[],
  gen: PageLayoutMap[],
): Array<{ src: PageLayoutMap; gen: PageLayoutMap | null }> {
  if (!src.length) return [];
  const used = new Set<string>();
  const pairs: Array<{ src: PageLayoutMap; gen: PageLayoutMap | null }> = [];

  for (const s of src) {
    const srcPath = (() => { try { return new URL(s.url, "http://x").pathname; } catch { return s.url; } })();

    let match = gen.find(g => {
      if (used.has(g.pageId)) return false;
      try { return new URL(g.url, "http://x").pathname === srcPath; } catch { return false; }
    });

    if (!match) {
      const slug = srcPath.split("/").filter(Boolean).pop() ?? "";
      match = gen.find(g => {
        if (used.has(g.pageId)) return false;
        try {
          const gSlug = new URL(g.url, "http://x").pathname.split("/").filter(Boolean).pop() ?? "";
          return slug && gSlug === slug;
        } catch { return false; }
      });
    }

    if (!match) match = gen.find(g => !used.has(g.pageId));
    if (match) used.add(match.pageId);
    pairs.push({ src: s, gen: match ?? null });
  }
  return pairs;
}

function scorePageLayout(srcPage: PageLayoutMap, genPage: PageLayoutMap | null): { score: number; issues: FidelityIssueVR7[] } {
  if (!genPage) return { score: 0, issues: [{ dimension: "layout", pageId: srcPage.pageId, severity: "high", description: "No matching generated page found", sourceValue: srcPage.url, genValue: "—", fix: "Ensure the reconstruction generates this page." }] };
  const issues: FidelityIssueVR7[] = [];

  const srcSeq = [...srcPage.regions].sort((a, b) => a.y - b.y).map(r => r.type);
  const genSeq = [...genPage.regions].sort((a, b) => a.y - b.y).map(r => r.type);

  const seqSim   = lcsRatio(srcSeq, genSeq);
  const countSim = numProx(srcPage.regions.length, genPage.regions.length, Math.max(srcPage.regions.length, genPage.regions.length));

  if (seqSim < 60) issues.push({
    dimension: "layout", pageId: srcPage.pageId, severity: "high",
    description: `Region sequence differs (LCS ${seqSim}%)`,
    sourceValue: srcSeq.join(" → "),
    genValue:    genSeq.join(" → "),
    fix: "Reorder page sections to match the source region sequence.",
  });
  if (countSim < 50) issues.push({
    dimension: "layout", pageId: srcPage.pageId, severity: "medium",
    description: `Region count: source ${srcPage.regions.length} vs generated ${genPage.regions.length}`,
    sourceValue: String(srcPage.regions.length),
    genValue:    String(genPage.regions.length),
    fix: "Add or remove sections to match the source page structure.",
  });

  return { score: clamp(Math.round(seqSim * 0.70 + countSim * 0.30)), issues };
}

function scorePageSpacing(srcPage: PageLayoutMap, genPage: PageLayoutMap | null): number {
  if (!genPage) return 0;
  const srcGaps: number[] = [];
  const genGaps: number[] = [];

  const sortSrc = [...srcPage.regions].sort((a, b) => a.y - b.y);
  const sortGen = [...genPage.regions].sort((a, b) => a.y - b.y);

  for (let i = 1; i < sortSrc.length; i++) {
    const g = sortSrc[i]!.y - (sortSrc[i - 1]!.y + sortSrc[i - 1]!.height);
    if (g >= 0 && g < 400) srcGaps.push(g);
  }
  for (let i = 1; i < sortGen.length; i++) {
    const g = sortGen[i]!.y - (sortGen[i - 1]!.y + sortGen[i - 1]!.height);
    if (g >= 0 && g < 400) genGaps.push(g);
  }

  if (!srcGaps.length || !genGaps.length) return 70; // no data — neutral
  const srcMed = median(srcGaps);
  const genMed = median(genGaps);
  return numProx(srcMed, genMed, 80);
}

// ---------------------------------------------------------------------------
// Grade
// ---------------------------------------------------------------------------

function grade(score: number): FidelityGradeVR7 {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

// ---------------------------------------------------------------------------
// R2 persistence
// ---------------------------------------------------------------------------

async function persistJSON(key: string, data: unknown): Promise<string | null> {
  const cloud = getDefaultCloudProvider();
  if (!cloud.isConfigured()) return null;
  const body = Buffer.from(JSON.stringify(data, null, 2), "utf8");
  try {
    await cloud.upload({ key, data: body, contentType: "application/json", checkDuplicate: false });
    return key;
  } catch (err) {
    logger.warn({ err, key }, "VR7: R2 upload failed");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface VR7Input {
  sourceJobId:    string;
  generatedJobId: string;
  force?:         boolean;
  // Optional pre-loaded inputs (caller can pass if already in memory)
  src?: {
    dna?: VisualDNA; layout?: LayoutMapBundle;
    components?: ComponentLibrary; stencil?: VisualStencilReport; rules?: ConsistencyRules;
  };
  gen?: {
    dna?: VisualDNA; layout?: LayoutMapBundle;
    components?: ComponentLibrary; stencil?: VisualStencilReport; rules?: ConsistencyRules;
  };
}

export async function runFidelityScoringVR7(input: VR7Input): Promise<FidelityReport> {
  const { sourceJobId, generatedJobId } = input;
  const cacheKey = `${sourceJobId}::${generatedJobId}`;
  const startMs  = Date.now();

  // Return cached unless forced
  if (!input.force) {
    const cached = _cache.get(cacheKey);
    if (cached) return cached;
  }

  logger.info({ sourceJobId, generatedJobId }, "VR7: starting fidelity scoring");

  // ── Load source inputs ─────────────────────────────────────────────────────
  const srcDNA    = input.src?.dna        ?? await loadVR<VisualDNA>(sourceJobId, "visual-dna.json");
  const srcLayout = input.src?.layout     ?? await loadVR<LayoutMapBundle>(sourceJobId, "layout-map.json");
  const srcComp   = input.src?.components ?? await loadVR<ComponentLibrary>(sourceJobId, "component-library.json");
  const srcStencil = input.src?.stencil   ?? await loadVR<VisualStencilReport>(sourceJobId, "visual-stencil-report.json");
  const srcRules  = input.src?.rules      ?? await loadVR<ConsistencyRules>(sourceJobId, "consistency-rules.json");

  // ── Load generated inputs ──────────────────────────────────────────────────
  const genDNA    = input.gen?.dna        ?? await loadVR<VisualDNA>(generatedJobId, "visual-dna.json");
  const genLayout = input.gen?.layout     ?? await loadVR<LayoutMapBundle>(generatedJobId, "layout-map.json");
  const genComp   = input.gen?.components ?? await loadVR<ComponentLibrary>(generatedJobId, "component-library.json");
  const genStencil = input.gen?.stencil   ?? await loadVR<VisualStencilReport>(generatedJobId, "visual-stencil-report.json");
  const genRules  = input.gen?.rules      ?? await loadVR<ConsistencyRules>(generatedJobId, "consistency-rules.json");

  const inputsUsed = {
    source:    { hasVR2: !!srcDNA, hasVR3: !!srcLayout, hasVR4: !!srcComp, hasVR5: !!srcStencil, hasVR6: !!srcRules },
    generated: { hasVR2: !!genDNA, hasVR3: !!genLayout, hasVR4: !!genComp, hasVR5: !!genStencil, hasVR6: !!genRules },
  };
  logger.info({ sourceJobId, generatedJobId, ...inputsUsed }, "VR7: inputs loaded");

  // ── Global dimension scores ────────────────────────────────────────────────
  const colorResult     = scoreColorGlobal(srcDNA, genDNA);
  const typographyResult = scoreTypographyGlobal(srcDNA, genDNA);
  const spacingResult   = scoreSpacingGlobal(srcDNA, genDNA, srcLayout, genLayout);
  const componentResult = scoreComponentGlobal(srcComp, genComp, srcRules, genRules);
  const layoutResult    = scoreLayoutGlobal(srcLayout, genLayout, srcStencil, genStencil, srcRules, genRules);

  const globalColor     = colorResult.score;
  const globalTypo      = typographyResult.score;
  const globalSpacing   = spacingResult.score;
  const globalComponent = componentResult.score;
  const globalLayout    = layoutResult.score;

  // Overall: layout 30%, color 25%, component 25%, spacing 10%, typography 10%
  const globalTotal = clamp(Math.round(
    globalLayout    * 0.30 +
    globalColor     * 0.25 +
    globalComponent * 0.25 +
    globalSpacing   * 0.10 +
    globalTypo      * 0.10
  ));

  // ── Global issues ──────────────────────────────────────────────────────────
  const globalIssues: FidelityIssueVR7[] = [
    ...colorResult.issues.map(i => ({ ...i, pageId: "global" as const })),
    ...typographyResult.issues.map(i => ({ ...i, pageId: "global" as const })),
    ...spacingResult.issues.map(i => ({ ...i, pageId: "global" as const })),
    ...componentResult.issues.map(i => ({ ...i, pageId: "global" as const })),
    ...layoutResult.issues.map(i => ({ ...i, pageId: "global" as const })),
  ];

  // ── Per-page scoring ───────────────────────────────────────────────────────
  const srcPages = srcLayout?.pages ?? [];
  const genPages = genLayout?.pages ?? [];
  const pairs    = matchPages(srcPages, genPages);

  const pageDetails:   FidelityPageDetail[] = [];
  const pageScoreFile: FidelityPageScore[]  = [];
  const pageIssues:    FidelityIssueVR7[]   = [];

  // When we have no per-page VR-3 data, fall back to a single "global" page score
  if (!pairs.length) {
    // Synthesise one entry per stencil page (or a single global entry)
    const syntheticPages = srcStencil?.pages ?? [];
    if (syntheticPages.length) {
      for (const sp of syntheticPages) {
        pageScoreFile.push({
          pageId:          sp.pageId,
          url:             sp.url,
          layoutScore:     globalLayout,
          colorScore:      globalColor,
          spacingScore:    globalSpacing,
          typographyScore: globalTypo,
          componentScore:  globalComponent,
          totalScore:      globalTotal,
        });
        pageDetails.push({
          pageId:          sp.pageId,
          url:             sp.url,
          layoutScore:     globalLayout,
          colorScore:      globalColor,
          spacingScore:    globalSpacing,
          typographyScore: globalTypo,
          componentScore:  globalComponent,
          totalScore:      globalTotal,
          matchedGenPageId: null,
          matchedGenUrl:    null,
          sourceRegions:   sp.sectionOrder.map(s => s.type as RegionType),
          genRegions:      [],
          issues:          [],
        });
      }
    } else {
      // Absolute fallback — single "site-level" entry
      pageScoreFile.push({
        pageId: sourceJobId, url: srcRules?.jobId ?? sourceJobId,
        layoutScore: globalLayout, colorScore: globalColor, spacingScore: globalSpacing,
        typographyScore: globalTypo, componentScore: globalComponent, totalScore: globalTotal,
      });
    }
  } else {
    for (const { src, gen } of pairs) {
      const layoutR  = scorePageLayout(src, gen);
      const spacingS = scorePageSpacing(src, gen);

      // Color and typography are site-wide — use global scores per page
      const pageColor  = globalColor;
      const pageTypo   = globalTypo;
      const pageLayout = layoutR.score;
      const pageSpacing = spacingS;

      // Component score per page: fraction of source region types present in generated page
      const srcRT  = new Set(src.regions.map(r => r.type));
      const genRT  = new Set(gen?.regions.map(r => r.type) ?? []);
      const inter  = [...srcRT].filter(t => genRT.has(t)).length;
      const pageComp = srcRT.size > 0 ? clamp(Math.round((inter / srcRT.size) * 100)) : globalComponent;

      const pageTotal = clamp(Math.round(
        pageLayout  * 0.30 +
        pageColor   * 0.25 +
        pageComp    * 0.25 +
        pageSpacing * 0.10 +
        pageTypo    * 0.10
      ));

      const allPageIssues = [...layoutR.issues];
      pageIssues.push(...allPageIssues);

      const srcSeq = [...src.regions].sort((a, b) => a.y - b.y).map(r => r.type);
      const genSeq = gen ? [...gen.regions].sort((a, b) => a.y - b.y).map(r => r.type) : [];

      pageScoreFile.push({
        pageId: src.pageId, url: src.url,
        layoutScore: pageLayout, colorScore: pageColor,
        spacingScore: pageSpacing, typographyScore: pageTypo,
        componentScore: pageComp, totalScore: pageTotal,
      });
      pageDetails.push({
        pageId: src.pageId, url: src.url,
        layoutScore: pageLayout, colorScore: pageColor,
        spacingScore: pageSpacing, typographyScore: pageTypo,
        componentScore: pageComp, totalScore: pageTotal,
        matchedGenPageId: gen?.pageId ?? null,
        matchedGenUrl:    gen?.url    ?? null,
        sourceRegions:   srcSeq,
        genRegions:      genSeq,
        issues:          allPageIssues,
      });
    }
  }

  const allIssues = [...globalIssues, ...pageIssues];

  // ── Summary ────────────────────────────────────────────────────────────────
  const dimensionScores: Record<string, number> = {
    layout: globalLayout, color: globalColor,
    spacing: globalSpacing, typography: globalTypo, component: globalComponent,
  };
  const topDim  = Object.entries(dimensionScores).sort((a, b) => b[1] - a[1])[0]![0];
  const weakDim = Object.entries(dimensionScores).sort((a, b) => a[1] - b[1])[0]![0];

  const issueBySeverity = { high: 0, medium: 0, low: 0 };
  for (const i of allIssues) issueBySeverity[i.severity]++;

  const pagesAbove75   = pageScoreFile.filter(p => p.totalScore >= 75).length;
  const pagesBelowPass = pageScoreFile.filter(p => p.totalScore < 60).length;

  // ── Build report ───────────────────────────────────────────────────────────
  const report: FidelityReport = {
    schemaVersion:  "VR-7",
    sourceJobId,
    generatedJobId,
    seedUrl: srcRules?.jobId ?? srcStencil?.seedUrl ?? "",
    generatedAt: new Date().toISOString(),
    durationMs:  Date.now() - startMs,
    inputsUsed,
    global: {
      layoutScore:     globalLayout,
      colorScore:      globalColor,
      spacingScore:    globalSpacing,
      typographyScore: globalTypo,
      componentScore:  globalComponent,
      totalScore:      globalTotal,
      grade:           grade(globalTotal),
    },
    pages:   pageDetails,
    issues:  allIssues,
    summary: {
      pagesCompared:   pageScoreFile.length,
      pagesAbove75,
      pagesBelowPass,
      topDimension:    topDim,
      weakDimension:   weakDim,
      issueBySeverity,
    },
    scoreFile: pageScoreFile,
  };

  // ── Persist ────────────────────────────────────────────────────────────────
  const tmpDir = join("/tmp/vr7", sourceJobId, generatedJobId);
  try { await mkdir(tmpDir, { recursive: true }); } catch { /* ok */ }
  await Promise.allSettled([
    writeFile(join(tmpDir, "fidelity-score.json"),  JSON.stringify(pageScoreFile, null, 2)),
    writeFile(join(tmpDir, "fidelity-report.json"), JSON.stringify(report,         null, 2)),
  ]);

  const base = `jobs/${sourceJobId}/fidelity-vr7/${generatedJobId}`;
  const [scoreKey, reportKey] = await Promise.all([
    persistJSON(`${base}/fidelity-score.json`,  pageScoreFile),
    persistJSON(`${base}/fidelity-report.json`, report),
  ]);
  if (scoreKey)  report.r2ScoreKey  = scoreKey;
  if (reportKey) report.r2ReportKey = reportKey;

  // Cache
  _cache.set(cacheKey, report);

  logger.info({
    sourceJobId, generatedJobId,
    durationMs: report.durationMs,
    globalTotal, grade: report.global.grade,
    pages: pageScoreFile.length,
    issues: allIssues.length,
  }, "VR7: complete");

  return report;
}
