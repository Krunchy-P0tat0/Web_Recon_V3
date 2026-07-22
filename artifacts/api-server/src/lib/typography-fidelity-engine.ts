/**
 * typography-fidelity-engine.ts — Phase B6: Typography Fidelity Engine
 *
 * Measures typographic and spatial fidelity between a source website and a
 * generated Website Prime.
 *
 * Dimensions measured:
 *   font family · font weight · letter spacing · line height ·
 *   paragraph rhythm · heading hierarchy · padding · margins ·
 *   vertical rhythm · white space
 *
 * Outputs (disk + R2 under jobs/{sourceJobId}/b6/):
 *   typography-fidelity-report.json
 *   spacing-map.json
 *   layout-rhythm.json
 *   design-rhythm-score.json
 *
 * Pipeline placement: visual_dna (source + generated) → typography_fidelity
 */

import { writeFile } from "fs/promises";
import { join }      from "path";
import { logger }    from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import type {
  VisualDnaOutput,
  TypographySystem,
} from "./visual-dna-engine.js";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type TypoGrade = "A" | "B" | "C" | "D" | "F";

export interface TypographyMetricScore {
  score:          number;         // 0–100
  confidence:     number;         // 0–1
  sourceValues:   string[];
  generatedValues: string[];
  notes:          string[];
}

export interface TypographyPageAnalysis {
  pageIndex:       number;
  url:             string;
  metrics: {
    fontFamily:      TypographyMetricScore;
    fontWeight:      TypographyMetricScore;
    letterSpacing:   TypographyMetricScore;
    lineHeight:      TypographyMetricScore;
    paragraphRhythm: TypographyMetricScore;
    headingHierarchy: TypographyMetricScore;
    padding:         TypographyMetricScore;
    margins:         TypographyMetricScore;
    verticalRhythm:  TypographyMetricScore;
    whitespace:      TypographyMetricScore;
  };
  overallScore:    number;
}

export interface TypographyIssue {
  dimension:    string;
  severity:     "high" | "medium" | "low";
  description:  string;
  sourceValue:  string;
  generatedValue: string;
}

export interface TypographyFidelityReport {
  schemaVersion:  "B6-1";
  sourceJobId:    string;
  generatedJobId: string;
  generatedAt:    string;
  durationMs:     number;
  summary: {
    overallScore:   number;
    grade:          TypoGrade;
    pagesAnalyzed:  number;
    metrics: {
      fontFamily:      number;
      fontWeight:      number;
      letterSpacing:   number;
      lineHeight:      number;
      paragraphRhythm: number;
      headingHierarchy: number;
      padding:         number;
      margins:         number;
      verticalRhythm:  number;
      whitespace:      number;
    };
  };
  perPage:  TypographyPageAnalysis[];
  issues:   TypographyIssue[];
  r2Keys: {
    report:       string | null;
    spacingMap:   string | null;
    layoutRhythm: string | null;
    rhythmScore:  string | null;
  };
}

// ---------------------------------------------------------------------------
// Spacing Map types
// ---------------------------------------------------------------------------

export interface SpacingValues {
  marginScale:    string[];
  paddingScale:   string[];
  gapScale:       string[];
  rhythmUnit:     string | null;
  sectionSpacing: string[];
}

export interface SpacingDelta {
  marginOverlap:   number;        // 0–1 proportion of shared values
  paddingOverlap:  number;
  rhythmUnitMatch: boolean;
  scaleDistance:   number;        // 0 = identical, 1 = completely different
}

export interface SpacingMap {
  schemaVersion:  "B6-1";
  sourceJobId:    string;
  generatedJobId: string;
  generatedAt:    string;
  source:         SpacingValues;
  generated:      SpacingValues;
  delta:          SpacingDelta;
}

// ---------------------------------------------------------------------------
// Layout Rhythm types
// ---------------------------------------------------------------------------

export interface HeadingScaleEntry {
  tag:            string;
  sourceFontSize: string | null;
  genFontSize:    string | null;
  match:          boolean;
  sizeDeltaPx:    number | null;
}

export interface LineHeightRhythm {
  sourceValues:   string[];
  generatedValues: string[];
  overlapScore:   number;         // 0–1
  baseUnitConsistent: boolean;
}

export interface LayoutRhythm {
  schemaVersion:  "B6-1";
  sourceJobId:    string;
  generatedJobId: string;
  generatedAt:    string;
  verticalRhythm: {
    sourceBaseUnit:    string | null;
    generatedBaseUnit: string | null;
    unitMatch:         boolean;
    ratios:            number[];
    consistent:        boolean;
  };
  headingScale:        HeadingScaleEntry[];
  lineHeightRhythm:    LineHeightRhythm;
  whitespaceRatio: {
    source:    number;
    generated: number;
    delta:     number;
  };
}

// ---------------------------------------------------------------------------
// Design Rhythm Score types
// ---------------------------------------------------------------------------

export interface DesignRhythmScore {
  schemaVersion:      "B6-1";
  sourceJobId:        string;
  generatedJobId:     string;
  generatedAt:        string;
  overallRhythmScore: number;    // 0–100
  grade:              TypoGrade;
  breakdown: {
    verticalRhythm:      number;
    typographicScale:    number;
    spacingConsistency:  number;
    whitespaceBalance:   number;
  };
  confidence:         number;
  recommendation:     string;
}

// ---------------------------------------------------------------------------
// Input options
// ---------------------------------------------------------------------------

export interface TypographyFidelityOptions {
  sourceJobId:    string;
  generatedJobId: string;
  sourceData:     VisualDnaOutput;
  generatedData:  VisualDnaOutput;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

interface StoredResults {
  report:       TypographyFidelityReport;
  spacingMap:   SpacingMap;
  layoutRhythm: LayoutRhythm;
  rhythmScore:  DesignRhythmScore;
}

const _store = new Map<string, StoredResults>();

function storeKey(sourceJobId: string, generatedJobId: string): string {
  return `${sourceJobId}::${generatedJobId}`;
}

export function getTypographyReport(
  sourceJobId: string, generatedJobId: string,
): StoredResults | undefined {
  return _store.get(storeKey(sourceJobId, generatedJobId));
}

export function listTypographyReports(): Array<{ sourceJobId: string; generatedJobId: string; grade: TypoGrade; overallScore: number; generatedAt: string }> {
  return [..._store.values()].map(r => ({
    sourceJobId:    r.report.sourceJobId,
    generatedJobId: r.report.generatedJobId,
    grade:          r.report.summary.grade,
    overallScore:   r.report.summary.overallScore,
    generatedAt:    r.report.generatedAt,
  }));
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function parsePx(val: string): number | null {
  const m = /^([\d.]+)(px|rem|em)?$/.exec(val.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (m[2] === "rem" || m[2] === "em") return n * 16;
  return n;
}

function overlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0)  return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const v of setA) if (setB.has(v)) shared++;
  return shared / Math.max(setA.size, setB.size);
}

function scaleDistance(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  return 1 - overlap(a, b);
}

function gradeFromScore(score: number): TypoGrade {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

function clamp(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, n));
}

/** Find the most common GCD-like base unit from a list of px strings */
function detectBaseUnit(values: string[]): string | null {
  const pxVals = values.map(parsePx).filter((v): v is number => v !== null && v > 0 && v <= 64);
  if (pxVals.length < 2) return pxVals.length === 1 ? `${pxVals[0]}px` : null;
  // find smallest non-trivial value (likely base unit)
  const sorted = [...new Set(pxVals)].sort((a, b) => a - b);
  const candidate = sorted[0];
  // validate: most other values should be near multiples
  const nearMultiple = sorted.filter(v => (v / candidate) % 1 < 0.2 || v % candidate < 3);
  return nearMultiple.length >= sorted.length * 0.6 ? `${candidate}px` : null;
}

/** Score font family overlap (case-insensitive) */
function scoreFontFamily(src: string[], gen: string[]): TypographyMetricScore {
  const norm = (arr: string[]) => arr.map(f => f.toLowerCase().replace(/['"]/g, "").trim());
  const srcN = norm(src);
  const genN = norm(gen);
  const ol   = overlap(srcN, genN);
  const score = clamp(Math.round(ol * 100));
  const notes: string[] = [];
  if (ol === 0) notes.push("No font families match between source and generated");
  else if (ol < 0.5) notes.push("Only partial font family match");
  return { score, confidence: Math.min(0.9, 0.3 + src.length * 0.2), sourceValues: src, generatedValues: gen, notes };
}

/** Score numeric weight arrays */
function scoreFontWeight(src: string[], gen: string[]): TypographyMetricScore {
  const ol    = overlap(src, gen);
  const score = clamp(Math.round(50 + ol * 50));
  const notes: string[] = [];
  if (ol < 0.3) notes.push("Font weight palettes are significantly different");
  return { score, confidence: 0.8, sourceValues: src, generatedValues: gen, notes };
}

/** Score letter spacing arrays */
function scoreLetterSpacing(src: string[], gen: string[]): TypographyMetricScore {
  const ol    = overlap(src, gen);
  const score = clamp(Math.round(60 + ol * 40));
  const notes: string[] = [];
  if (src.length === 0 && gen.length === 0) {
    return { score: 90, confidence: 0.5, sourceValues: [], generatedValues: [], notes: ["Neither side defines custom letter spacing"] };
  }
  if (ol < 0.2) notes.push("Letter spacing values are significantly different");
  return { score, confidence: 0.7, sourceValues: src, generatedValues: gen, notes };
}

/** Score line height arrays */
function scoreLineHeight(src: string[], gen: string[]): TypographyMetricScore {
  const ol    = overlap(src, gen);
  const score = clamp(Math.round(55 + ol * 45));
  const notes: string[] = [];
  if (ol < 0.3) notes.push("Line height rhythm differs notably");
  return { score, confidence: 0.75, sourceValues: src, generatedValues: gen, notes };
}

/** Score paragraph rhythm from spacingRhythm */
function scoreParagraphRhythm(src: string[], gen: string[]): TypographyMetricScore {
  const ol    = overlap(src, gen);
  const baseS = detectBaseUnit(src);
  const baseG = detectBaseUnit(gen);
  const baseMatch = baseS !== null && baseG !== null && baseS === baseG;
  const score = clamp(Math.round(ol * 60 + (baseMatch ? 40 : 0)));
  const notes: string[] = [];
  if (!baseMatch) notes.push(`Spacing base units differ: source=${baseS ?? "unknown"}, generated=${baseG ?? "unknown"}`);
  return { score, confidence: 0.7, sourceValues: src, generatedValues: gen, notes };
}

/** Score heading hierarchy from h1–h6 size ratios */
function scoreHeadingHierarchy(
  src: Record<string, { fontSize: string; fontWeight: string }>,
  gen: Record<string, { fontSize: string; fontWeight: string }>,
): TypographyMetricScore {
  const tags   = ["h1", "h2", "h3", "h4", "h5", "h6"];
  const srcTags = tags.filter(t => t in src);
  const genTags = tags.filter(t => t in gen);
  const srcVals = srcTags.map(t => src[t]!.fontSize);
  const genVals = genTags.map(t => (gen[t] ?? src[t])!.fontSize);

  let matchCount = 0;
  let total = 0;
  for (const tag of tags) {
    if (!(tag in src)) continue;
    total++;
    const sp = parsePx(src[tag]!.fontSize);
    const gp = gen[tag] ? parsePx(gen[tag]!.fontSize) : null;
    if (sp !== null && gp !== null && Math.abs(sp - gp) <= 3) matchCount++;
    else if (sp !== null && gp !== null && Math.abs(sp - gp) <= 8) matchCount += 0.5;
  }

  const hierarchyDepth  = Math.min(srcTags.length, genTags.length);
  const hierarchyBonus  = hierarchyDepth >= 3 ? 20 : hierarchyDepth >= 2 ? 10 : 0;
  const score = total > 0
    ? clamp(Math.round((matchCount / total) * 80 + hierarchyBonus))
    : 75;

  const notes: string[] = [];
  if (srcTags.length > genTags.length) notes.push(`Generated is missing heading levels: ${tags.filter(t => t in src && !(t in gen)).join(", ")}`);
  return { score, confidence: 0.8, sourceValues: srcVals, generatedValues: genVals, notes };
}

/** Score padding from spacingRhythm (proxy) */
function scorePadding(src: string[], gen: string[]): TypographyMetricScore {
  const filtered = (arr: string[]) => arr.filter(v => {
    const n = parsePx(v);
    return n !== null && n >= 4 && n <= 80;
  });
  const srcF = filtered(src);
  const genF = filtered(gen);
  const ol   = overlap(srcF, genF);
  const score = clamp(Math.round(50 + ol * 50));
  const notes: string[] = [];
  if (ol < 0.25) notes.push("Padding scale substantially different from source");
  return { score, confidence: 0.65, sourceValues: srcF, generatedValues: genF, notes };
}

/** Score margin from spacingRhythm (proxy) */
function scoreMargins(src: string[], gen: string[]): TypographyMetricScore {
  const filtered = (arr: string[]) => arr.filter(v => {
    const n = parsePx(v);
    return n !== null && n >= 8 && n <= 200;
  });
  const srcF = filtered(src);
  const genF = filtered(gen);
  const ol   = overlap(srcF, genF);
  const score = clamp(Math.round(50 + ol * 50));
  const notes: string[] = [];
  if (ol < 0.25) notes.push("Margin rhythm differs from source");
  return { score, confidence: 0.6, sourceValues: srcF, generatedValues: genF, notes };
}

/** Score vertical rhythm consistency from line heights + spacing */
function scoreVerticalRhythm(
  srcTypo: TypographySystem,
  genTypo: TypographySystem,
): TypographyMetricScore {
  const srcBase = detectBaseUnit([...srcTypo.lineHeights, ...srcTypo.spacingRhythm]);
  const genBase = detectBaseUnit([...genTypo.lineHeights, ...genTypo.spacingRhythm]);
  const unitMatch = srcBase !== null && genBase !== null && srcBase === genBase;
  const rhythmOl  = overlap(srcTypo.spacingRhythm, genTypo.spacingRhythm);
  const lhOl      = overlap(srcTypo.lineHeights, genTypo.lineHeights);
  const score = clamp(Math.round((unitMatch ? 40 : 20) + rhythmOl * 30 + lhOl * 30));
  const notes: string[] = [];
  if (!unitMatch) notes.push(`Vertical rhythm base units differ: source=${srcBase ?? "none"}, generated=${genBase ?? "none"}`);
  return {
    score, confidence: 0.7,
    sourceValues:    [...srcTypo.lineHeights, ...srcTypo.spacingRhythm].slice(0, 8),
    generatedValues: [...genTypo.lineHeights, ...genTypo.spacingRhythm].slice(0, 8),
    notes,
  };
}

/** Score whitespace balance from font sizes (proxy for density) */
function scoreWhitespace(
  srcTypo: TypographySystem,
  genTypo: TypographySystem,
): TypographyMetricScore {
  // Whitespace proxy: overlap of large spacing values (> 24px)
  const large = (arr: string[]) => arr.filter(v => { const n = parsePx(v); return n !== null && n > 24; });
  const srcL = large([...srcTypo.spacingRhythm, ...srcTypo.lineHeights]);
  const genL = large([...genTypo.spacingRhythm, ...genTypo.lineHeights]);
  const ol   = overlap(srcL, genL);
  const score = clamp(Math.round(55 + ol * 45));
  const notes: string[] = [];
  if (srcL.length > 0 && genL.length === 0) notes.push("Generated appears to have insufficient whitespace");
  else if (genL.length > srcL.length * 2)   notes.push("Generated may have excessive whitespace relative to source");
  return { score, confidence: 0.6, sourceValues: srcL, generatedValues: genL, notes };
}

// ---------------------------------------------------------------------------
// Per-page analysis
// ---------------------------------------------------------------------------

function analyzePagePair(
  idx:   number,
  srcUrl: string,
  srcTypo: TypographySystem,
  genTypo: TypographySystem,
): TypographyPageAnalysis {
  const metrics = {
    fontFamily:       scoreFontFamily(srcTypo.fontFamilies, genTypo.fontFamilies),
    fontWeight:       scoreFontWeight(srcTypo.fontWeights, genTypo.fontWeights),
    letterSpacing:    scoreLetterSpacing(srcTypo.letterSpacings, genTypo.letterSpacings),
    lineHeight:       scoreLineHeight(srcTypo.lineHeights, genTypo.lineHeights),
    paragraphRhythm:  scoreParagraphRhythm(srcTypo.spacingRhythm, genTypo.spacingRhythm),
    headingHierarchy: scoreHeadingHierarchy(srcTypo.headingHierarchy, genTypo.headingHierarchy),
    padding:          scorePadding(srcTypo.spacingRhythm, genTypo.spacingRhythm),
    margins:          scoreMargins(srcTypo.spacingRhythm, genTypo.spacingRhythm),
    verticalRhythm:   scoreVerticalRhythm(srcTypo, genTypo),
    whitespace:       scoreWhitespace(srcTypo, genTypo),
  };

  const scores      = Object.values(metrics).map(m => m.score);
  const overallScore = clamp(Math.round(scores.reduce((a, b) => a + b, 0) / scores.length));

  return { pageIndex: idx, url: srcUrl, metrics, overallScore };
}

// ---------------------------------------------------------------------------
// Aggregate helpers
// ---------------------------------------------------------------------------

function aggregateTypo(pages: TypographySystem[]): TypographySystem {
  const merge = <T>(arrs: T[][]): T[] => [...new Set(arrs.flat())];
  const mergeRec = (recs: Record<string, { fontSize: string; fontWeight: string }>[]) => {
    const out: Record<string, { fontSize: string; fontWeight: string }> = {};
    for (const rec of recs) {
      for (const [tag, val] of Object.entries(rec)) {
        if (!(tag in out)) out[tag] = val;
      }
    }
    return out;
  };
  return {
    fontFamilies:     merge(pages.map(p => p.fontFamilies)),
    fontSizes:        merge(pages.map(p => p.fontSizes)),
    fontWeights:      merge(pages.map(p => p.fontWeights)),
    lineHeights:      merge(pages.map(p => p.lineHeights)),
    letterSpacings:   merge(pages.map(p => p.letterSpacings)),
    headingHierarchy: mergeRec(pages.map(p => p.headingHierarchy)),
    spacingRhythm:    merge(pages.map(p => p.spacingRhythm)),
    confidence:       pages.reduce((s, p) => s + p.confidence, 0) / Math.max(1, pages.length),
  };
}

function buildSpacingMap(
  sourceJobId: string,
  generatedJobId: string,
  srcTypo: TypographySystem,
  genTypo: TypographySystem,
): SpacingMap {
  const extractScale = (vals: string[], min: number, max: number) =>
    [...new Set(vals.filter(v => { const n = parsePx(v); return n !== null && n >= min && n <= max; }))].sort();

  const srcSpacing: SpacingValues = {
    marginScale:    extractScale(srcTypo.spacingRhythm, 8, 200),
    paddingScale:   extractScale(srcTypo.spacingRhythm, 4, 80),
    gapScale:       extractScale(srcTypo.spacingRhythm, 4, 64),
    rhythmUnit:     detectBaseUnit(srcTypo.spacingRhythm),
    sectionSpacing: extractScale(srcTypo.spacingRhythm, 40, 200),
  };
  const genSpacing: SpacingValues = {
    marginScale:    extractScale(genTypo.spacingRhythm, 8, 200),
    paddingScale:   extractScale(genTypo.spacingRhythm, 4, 80),
    gapScale:       extractScale(genTypo.spacingRhythm, 4, 64),
    rhythmUnit:     detectBaseUnit(genTypo.spacingRhythm),
    sectionSpacing: extractScale(genTypo.spacingRhythm, 40, 200),
  };
  const delta: SpacingDelta = {
    marginOverlap:   overlap(srcSpacing.marginScale, genSpacing.marginScale),
    paddingOverlap:  overlap(srcSpacing.paddingScale, genSpacing.paddingScale),
    rhythmUnitMatch: srcSpacing.rhythmUnit === genSpacing.rhythmUnit && srcSpacing.rhythmUnit !== null,
    scaleDistance:   scaleDistance(srcTypo.spacingRhythm, genTypo.spacingRhythm),
  };
  return {
    schemaVersion: "B6-1",
    sourceJobId, generatedJobId,
    generatedAt:   new Date().toISOString(),
    source:        srcSpacing,
    generated:     genSpacing,
    delta,
  };
}

function buildLayoutRhythm(
  sourceJobId: string,
  generatedJobId: string,
  srcTypo: TypographySystem,
  genTypo: TypographySystem,
): LayoutRhythm {
  const srcBase = detectBaseUnit([...srcTypo.lineHeights, ...srcTypo.spacingRhythm]);
  const genBase = detectBaseUnit([...genTypo.lineHeights, ...genTypo.spacingRhythm]);

  // heading scale comparison
  const tags      = ["h1", "h2", "h3", "h4", "h5", "h6"];
  const headingScale: HeadingScaleEntry[] = tags.map(tag => {
    const srcEntry = srcTypo.headingHierarchy[tag] ?? null;
    const genEntry = genTypo.headingHierarchy[tag] ?? null;
    if (!srcEntry) return { tag, sourceFontSize: null, genFontSize: null, match: false, sizeDeltaPx: null };
    const srcPx = srcEntry ? parsePx(srcEntry.fontSize) : null;
    const genPx = genEntry ? parsePx(genEntry.fontSize) : null;
    const delta = srcPx !== null && genPx !== null ? Math.abs(srcPx - genPx) : null;
    return {
      tag,
      sourceFontSize: srcEntry?.fontSize ?? null,
      genFontSize:    genEntry?.fontSize ?? null,
      match:          delta !== null && delta <= 4,
      sizeDeltaPx:    delta,
    };
  }).filter(e => e.sourceFontSize !== null);

  // line height rhythm
  const lhOl = overlap(srcTypo.lineHeights, genTypo.lineHeights);
  const lineHeightRhythm: LineHeightRhythm = {
    sourceValues:       srcTypo.lineHeights,
    generatedValues:    genTypo.lineHeights,
    overlapScore:       Math.round(lhOl * 100) / 100,
    baseUnitConsistent: srcBase !== null && srcBase === genBase,
  };

  // whitespace ratio proxy: large spacing / total spacing count
  const wsRatio = (typo: TypographySystem): number => {
    const all   = typo.spacingRhythm.map(parsePx).filter((n): n is number => n !== null);
    if (all.length === 0) return 0.5;
    const large = all.filter(n => n > 32);
    return large.length / all.length;
  };
  const srcWs = wsRatio(srcTypo);
  const genWs = wsRatio(genTypo);

  // ratio series: consecutive heading size ratios
  const srcSizes = tags.map(t => srcTypo.headingHierarchy[t] ? parsePx(srcTypo.headingHierarchy[t]!.fontSize) : null).filter((n): n is number => n !== null);
  const ratios   = srcSizes.slice(1).map((v, i) => Math.round((srcSizes[i]! / v) * 100) / 100);

  return {
    schemaVersion: "B6-1",
    sourceJobId, generatedJobId,
    generatedAt:   new Date().toISOString(),
    verticalRhythm: {
      sourceBaseUnit:    srcBase,
      generatedBaseUnit: genBase,
      unitMatch:         srcBase !== null && srcBase === genBase,
      ratios,
      consistent:        ratios.every(r => r >= 1.1 && r <= 1.8),
    },
    headingScale,
    lineHeightRhythm,
    whitespaceRatio: {
      source:    Math.round(srcWs * 100) / 100,
      generated: Math.round(genWs * 100) / 100,
      delta:     Math.round(Math.abs(srcWs - genWs) * 100) / 100,
    },
  };
}

function buildRhythmScore(
  sourceJobId: string,
  generatedJobId: string,
  srcTypo: TypographySystem,
  genTypo: TypographySystem,
  rhythm: LayoutRhythm,
): DesignRhythmScore {
  const verticalRhythm = rhythm.verticalRhythm.unitMatch ? 90
    : rhythm.lineHeightRhythm.baseUnitConsistent ? 70 : 45;

  const headingMatches = rhythm.headingScale.filter(e => e.match).length;
  const typographicScale = rhythm.headingScale.length > 0
    ? clamp(Math.round((headingMatches / rhythm.headingScale.length) * 100))
    : 70;

  const spacingOl       = overlap(srcTypo.spacingRhythm, genTypo.spacingRhythm);
  const spacingConsistency = clamp(Math.round(spacingOl * 100));

  const wsDelta          = rhythm.whitespaceRatio.delta;
  const whitespaceBalance = clamp(Math.round((1 - Math.min(1, wsDelta * 3)) * 100));

  const overall = Math.round(
    verticalRhythm * 0.30 +
    typographicScale * 0.30 +
    spacingConsistency * 0.25 +
    whitespaceBalance * 0.15,
  );

  const recommendations: string[] = [];
  if (verticalRhythm < 60)       recommendations.push("Align vertical rhythm base units between source and generated");
  if (typographicScale < 60)     recommendations.push("Tighten heading size ratios to match source scale");
  if (spacingConsistency < 50)   recommendations.push("Adopt source spacing scale (8px/4px grid) in generated output");
  if (whitespaceBalance < 60)    recommendations.push("Adjust whitespace density to match source layout breathing room");

  return {
    schemaVersion:      "B6-1",
    sourceJobId, generatedJobId,
    generatedAt:        new Date().toISOString(),
    overallRhythmScore: clamp(overall),
    grade:              gradeFromScore(overall),
    breakdown: { verticalRhythm, typographicScale, spacingConsistency, whitespaceBalance },
    confidence:         Math.round((srcTypo.confidence + genTypo.confidence) / 2 * 100) / 100,
    recommendation:     recommendations.length > 0
      ? recommendations.join("; ")
      : "Typography rhythm is well-aligned — no major adjustments needed.",
  };
}

// ---------------------------------------------------------------------------
// R2 / disk helpers
// ---------------------------------------------------------------------------

const OUT_DIR = process.cwd();

async function writeDisk(filename: string, data: unknown): Promise<void> {
  await writeFile(join(OUT_DIR, filename), JSON.stringify(data, null, 2), "utf8");
}

async function uploadR2(key: string, data: Buffer): Promise<boolean> {
  const cloud = getDefaultCloudProvider();
  if (!cloud.isConfigured()) return false;
  try {
    await cloud.upload({ key, data, contentType: "application/json" });
    return true;
  } catch (err) {
    logger.warn({ err, key }, "B6: R2 upload failed (non-fatal)");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main engine entry point
// ---------------------------------------------------------------------------

export async function runTypographyFidelity(
  opts: TypographyFidelityOptions,
): Promise<{
  report:       TypographyFidelityReport;
  spacingMap:   SpacingMap;
  layoutRhythm: LayoutRhythm;
  rhythmScore:  DesignRhythmScore;
}> {
  const { sourceJobId, generatedJobId, sourceData, generatedData } = opts;
  const t0 = Date.now();

  logger.info({ sourceJobId, generatedJobId }, "B6: starting typography fidelity analysis");

  // ── Extract per-page typography ──────────────────────────────────────────
  // pages is Record<string, PageDna> (keyed by URL/slug) — match by shared key
  type PageEntry = { url?: string; typographySystem: TypographySystem };
  const toPageMap = (data: VisualDnaOutput): Map<string, PageEntry> => {
    const raw = data.pages ?? {};
    const map = new Map<string, PageEntry>();
    for (const [key, val] of Object.entries(raw)) {
      const page = val as unknown as PageEntry;
      if (page && page.typographySystem) map.set(key, page);
    }
    return map;
  };

  const srcMap = toPageMap(sourceData);
  const genMap = toPageMap(generatedData);

  // Match on shared keys; fall back to index-order pairing for unkeyed data
  const matchedKeys = [...srcMap.keys()].filter(k => genMap.has(k));
  const srcOnly     = [...srcMap.keys()].filter(k => !genMap.has(k));

  const perPage: TypographyPageAnalysis[] = [];

  logger.debug(
    { sourceJobId, generatedJobId, matched: matchedKeys.length, srcOnly: srcOnly.length },
    "B6: page matching stats",
  );

  // Matched pairs (deterministic by shared URL key)
  for (const key of matchedKeys) {
    const sp = srcMap.get(key)!;
    const gp = genMap.get(key)!;
    perPage.push(analyzePagePair(perPage.length, sp.url ?? key, sp.typographySystem, gp.typographySystem));
  }

  // Unmatched source pages paired positionally against remaining generated pages (best-effort)
  const unmatchedGen = [...genMap.entries()].filter(([k]) => !srcMap.has(k)).map(([, v]) => v);
  srcOnly.forEach((key, idx) => {
    const sp = srcMap.get(key)!;
    const gp = unmatchedGen[idx];
    if (!gp) return;
    perPage.push(analyzePagePair(perPage.length, sp.url ?? key, sp.typographySystem, gp.typographySystem));
  });

  // ── Aggregate typography across all pages ────────────────────────────────
  const srcTypoAgg = aggregateTypo(
    [...srcMap.values()].map(p => p.typographySystem).filter((t): t is TypographySystem => Boolean(t)),
  );
  const genTypoAgg = aggregateTypo(
    [...genMap.values()].map(p => p.typographySystem).filter((t): t is TypographySystem => Boolean(t)),
  );

  // ── Aggregate metrics across all pages ──────────────────────────────────
  const avg = (dim: keyof TypographyPageAnalysis["metrics"]) =>
    perPage.length > 0
      ? Math.round(perPage.reduce((s, p) => s + p.metrics[dim].score, 0) / perPage.length)
      : 70;

  const metricAvgs = {
    fontFamily:       avg("fontFamily"),
    fontWeight:       avg("fontWeight"),
    letterSpacing:    avg("letterSpacing"),
    lineHeight:       avg("lineHeight"),
    paragraphRhythm:  avg("paragraphRhythm"),
    headingHierarchy: avg("headingHierarchy"),
    padding:          avg("padding"),
    margins:          avg("margins"),
    verticalRhythm:   avg("verticalRhythm"),
    whitespace:       avg("whitespace"),
  };

  const overallScore = clamp(Math.round(
    Object.values(metricAvgs).reduce((a, b) => a + b, 0) / Object.values(metricAvgs).length,
  ));

  // ── Collect issues ───────────────────────────────────────────────────────
  const issues: TypographyIssue[] = [];
  for (const page of perPage) {
    for (const [dim, metric] of Object.entries(page.metrics)) {
      if (metric.score < 60) {
        issues.push({
          dimension:      dim,
          severity:       metric.score < 45 ? "high" : "medium",
          description:    metric.notes[0] ?? `${dim} score below threshold`,
          sourceValue:    metric.sourceValues.slice(0, 3).join(", "),
          generatedValue: metric.generatedValues.slice(0, 3).join(", "),
        });
      }
    }
  }

  // ── Build sub-reports ────────────────────────────────────────────────────
  const spacingMap   = buildSpacingMap(sourceJobId, generatedJobId, srcTypoAgg, genTypoAgg);
  const layoutRhythm = buildLayoutRhythm(sourceJobId, generatedJobId, srcTypoAgg, genTypoAgg);
  const rhythmScore  = buildRhythmScore(sourceJobId, generatedJobId, srcTypoAgg, genTypoAgg, layoutRhythm);

  // ── Assemble main report ─────────────────────────────────────────────────
  const report: TypographyFidelityReport = {
    schemaVersion: "B6-1",
    sourceJobId, generatedJobId,
    generatedAt:   new Date().toISOString(),
    durationMs:    Date.now() - t0,
    summary: {
      overallScore,
      grade:        gradeFromScore(overallScore),
      pagesAnalyzed: perPage.length,
      metrics:      metricAvgs,
    },
    perPage,
    issues: issues.slice(0, 50),
    r2Keys: { report: null, spacingMap: null, layoutRhythm: null, rhythmScore: null },
  };

  // ── Persist ──────────────────────────────────────────────────────────────
  const prefix = `jobs/${sourceJobId}/b6`;
  const filenames = {
    report:       `${prefix}/typography-fidelity-report.json`,
    spacingMap:   `${prefix}/spacing-map.json`,
    layoutRhythm: `${prefix}/layout-rhythm.json`,
    rhythmScore:  `${prefix}/design-rhythm-score.json`,
  };

  await Promise.all([
    writeDisk("typography-fidelity-report.json", report),
    writeDisk("spacing-map.json", spacingMap),
    writeDisk("layout-rhythm.json", layoutRhythm),
    writeDisk("design-rhythm-score.json", rhythmScore),
    uploadR2(filenames.report,       Buffer.from(JSON.stringify(report,       null, 2))).then(ok => { if (ok) report.r2Keys.report       = filenames.report;       }),
    uploadR2(filenames.spacingMap,   Buffer.from(JSON.stringify(spacingMap,   null, 2))).then(ok => { if (ok) report.r2Keys.spacingMap   = filenames.spacingMap;   }),
    uploadR2(filenames.layoutRhythm, Buffer.from(JSON.stringify(layoutRhythm, null, 2))).then(ok => { if (ok) report.r2Keys.layoutRhythm = filenames.layoutRhythm; }),
    uploadR2(filenames.rhythmScore,  Buffer.from(JSON.stringify(rhythmScore,  null, 2))).then(ok => { if (ok) report.r2Keys.rhythmScore  = filenames.rhythmScore;  }),
  ]);

  _store.set(storeKey(sourceJobId, generatedJobId), { report, spacingMap, layoutRhythm, rhythmScore });

  logger.info(
    { sourceJobId, generatedJobId, overallScore, grade: report.summary.grade, durationMs: report.durationMs },
    "B6: typography fidelity complete",
  );

  return { report, spacingMap, layoutRhythm, rhythmScore };
}
