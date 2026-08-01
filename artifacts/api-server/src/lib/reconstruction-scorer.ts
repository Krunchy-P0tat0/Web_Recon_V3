/**
 * reconstruction-scorer.ts — Phase 6.8 Reconstruction Scoring System
 *
 * Scores how accurately a reconstruction matches the original site.
 *
 * Inputs (loaded from R2 by jobId):
 *   - manifest.json          — original crawl manifest
 *   - visual-stencil-map.json — stencil assignments per node
 *   - _visual-dna.json       — component / layout / design DNA
 *   - consistency-report.json — multi-page consistency baseline
 *   - fidelity report        — Phase 6.5 output (if generatedJobId given)
 *   - generated stencil map  — reconstruction's stencil map (if generatedJobId given)
 *
 * Outputs:
 *   - reconstructionScore.json (uploaded to R2)
 *
 * Four scored dimensions (0–100 each):
 *   1. Layout Similarity        — structural layout type fidelity
 *   2. Structural Fidelity      — DOM structure, headings, sections
 *   3. Content Placement        — page count, word count, depth distribution
 *   4. Navigation Parity        — nav structure, depth hierarchy, routing
 *
 * Rules:
 *   - Strict scoring — no generous rounding
 *   - UNKNOWN when source data is unavailable (contributes 0 to total)
 *   - All scores clamped to [0, 100]
 */

import { logger } from "./logger";
import type { VisualStencilMap, StencilNodeEntry, VisualStencilType } from "./visual-stencil-mapper";
import type { ConsistencyReport } from "./multi-page-consistency-engine";

// ── Score value: number or UNKNOWN ────────────────────────────────────────────

export type ScoreValue = number | "UNKNOWN";

// ── Failure point ─────────────────────────────────────────────────────────────

export type FailureCategory =
  | "missing_pages"
  | "layout_drift"
  | "navigation_hole"
  | "content_truncation"
  | "structure_deviation"
  | "stencil_mismatch"
  | "depth_imbalance"
  | "heading_regression"
  | "missing_hero"
  | "missing_navigation_layout";

export type FailureSeverity = "critical" | "major" | "minor";

export interface FailurePoint {
  category:    FailureCategory;
  severity:    FailureSeverity;
  description: string;
  impact:      number;   // score points lost (0–100)
  affectedPages?: string[];
}

// ── Improvement suggestion ────────────────────────────────────────────────────

export interface ImprovementSuggestion {
  priority:    "high" | "medium" | "low";
  dimension:   "layout" | "structural" | "content" | "navigation" | "global";
  action:      string;
  expectedGain: number;  // estimated score point gain
}

// ── Dimension score ───────────────────────────────────────────────────────────

export interface DimensionScore {
  score:       ScoreValue;
  /** "scored" | "partial" | "unknown" */
  confidence:  "scored" | "partial" | "unknown";
  signals:     string[];
  failurePoints: FailurePoint[];
}

// ── Full report ───────────────────────────────────────────────────────────────

export type ReconstructionGrade = "A" | "B" | "C" | "D" | "F";

export interface ReconstructionScoreReport {
  schemaVersion:   "6.8";
  jobId:           string;
  generatedJobId:  string | null;
  seedUrl:         string;
  generatedAt:     string;

  totalScore:      ScoreValue;
  grade:           ReconstructionGrade | "UNKNOWN";

  breakdown: {
    layoutSimilarity:       DimensionScore;
    structuralFidelity:     DimensionScore;
    contentPlacement:       DimensionScore;
    navigationParity:       DimensionScore;
  };

  failurePoints:   FailurePoint[];
  suggestions:     ImprovementSuggestion[];

  meta: {
    sourceNodeCount:       number;
    generatedNodeCount:    number | null;
    availableDataSources:  string[];
    missingDataSources:    string[];
    scoredDimensions:      number;
    unknownDimensions:     number;
  };

  r2Key?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function numericScore(v: ScoreValue): number {
  return v === "UNKNOWN" ? 0 : v;
}

function grade(score: ScoreValue): ReconstructionGrade | "UNKNOWN" {
  if (score === "UNKNOWN") return "UNKNOWN";
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

function ratio(a: number, b: number): number {
  if (b === 0) return a === 0 ? 1 : 0;
  return Math.min(1, a / b);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// Count occurrences of each stencil type in a node array
function stencilCounts(nodes: StencilNodeEntry[]): Record<VisualStencilType, number> {
  const counts: Record<VisualStencilType, number> = {
    HeroSection: 0, ArticleLayout: 0, GridLayout: 0,
    FeatureBlock: 0, NavigationLayout: 0,
  };
  for (const n of nodes) counts[n.stencilType]++;
  return counts;
}

// Jensen-Shannon-inspired distribution similarity (symmetric, 0–1)
function distributionSimilarity(
  a: Record<string, number>,
  b: Record<string, number>
): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const totalA = Object.values(a).reduce((s, v) => s + v, 0) || 1;
  const totalB = Object.values(b).reduce((s, v) => s + v, 0) || 1;
  let sim = 0;
  for (const k of keys) {
    const pa = (a[k] ?? 0) / totalA;
    const pb = (b[k] ?? 0) / totalB;
    sim += 1 - Math.abs(pa - pb);
  }
  return sim / keys.size;
}

// ── R2 helpers ────────────────────────────────────────────────────────────────

function r2Configured(): boolean {
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
  if (!r2Configured()) return null;
  try {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await r2Client();
    const resp = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: key }));
    const chunks: Buffer[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const ch of (resp.Body as any)) chunks.push(Buffer.from(ch));
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    return null;
  }
}

async function uploadR2Json(data: unknown, key: string): Promise<boolean> {
  if (!r2Configured()) return false;
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
    logger.warn({ err, key }, "RECON-SCORER: R2 upload failed");
    return false;
  }
}

// ── Fidelity report shape (subset we consume) ──────────────────────────────

interface FidelityMetric {
  score: number;
  weight: number;
  signals: string[];
  issues: Array<{ description: string; severity: string }>;
}

interface FidelityReport {
  overallScore?: number;
  grade?: string;
  metrics?: {
    layout?:     FidelityMetric;
    component?:  FidelityMetric;
    navigation?: FidelityMetric;
    color?:      FidelityMetric;
    spacing?:    FidelityMetric;
    responsive?: FidelityMetric;
  };
}

// ── Visual DNA shape (subset) ──────────────────────────────────────────────

interface VisualDnaOutput {
  aggregate?: {
    mostCommonLayout?:      string;
    averageWordCount?:      number;
    navigationPatterns?:   string[];
    componentFrequency?:   Record<string, number>;
  };
  pages?: Array<{
    nodeId?:     string;
    wordCount?:  number;
    layout?:     string;
    components?: Record<string, boolean>;
  }>;
}

// ── Dimension scorers ─────────────────────────────────────────────────────────

function scoreLayoutSimilarity(
  srcMap: VisualStencilMap | null,
  genMap: VisualStencilMap | null,
  fidelity: FidelityReport | null
): DimensionScore {
  const failurePoints: FailurePoint[] = [];
  const signals: string[] = [];

  // If fidelity report exists, its layout metric is authoritative
  if (fidelity?.metrics?.layout) {
    const metric = fidelity.metrics.layout;
    const score = clamp(metric.score);
    signals.push(`fidelity-layout-metric:${score}`);

    for (const issue of metric.issues ?? []) {
      if (issue.severity === "high" || issue.severity === "medium") {
        failurePoints.push({
          category:    "layout_drift",
          severity:    issue.severity === "high" ? "critical" : "major",
          description: issue.description,
          impact:      issue.severity === "high" ? 15 : 8,
        });
      }
    }

    return { score, confidence: "scored", signals, failurePoints };
  }

  // No fidelity report — compare stencil distributions
  if (!srcMap) return { score: "UNKNOWN", confidence: "unknown", signals: ["no-source-stencil-map"], failurePoints: [] };
  if (!genMap) {
    signals.push("no-generated-stencil-map");
    // Self-score: evaluate layout coherence of the source itself
    const hasHero = (srcMap.summary.byStencilType["HeroSection"] ?? 0) >= 1;
    const hasGrid = (srcMap.summary.byStencilType["GridLayout"]  ?? 0) >= 1;
    if (!hasHero) {
      failurePoints.push({ category: "missing_hero", severity: "major", description: "No HeroSection page detected in reconstruction.", impact: 20 });
    }
    const baseScore = clamp(60 + (hasHero ? 15 : 0) + (hasGrid ? 10 : 0) - failurePoints.length * 5);
    return { score: baseScore, confidence: "partial", signals, failurePoints };
  }

  const srcCounts = stencilCounts(srcMap.nodes);
  const genCounts = stencilCounts(genMap.nodes);
  const distSim   = distributionSimilarity(srcCounts, genCounts);
  signals.push(`stencil-distribution-similarity:${distSim.toFixed(3)}`);

  // Hero presence
  const hasHeroSrc = srcCounts["HeroSection"] >= 1;
  const hasHeroGen = genCounts["HeroSection"] >= 1;
  if (hasHeroSrc && !hasHeroGen) {
    failurePoints.push({ category: "missing_hero", severity: "critical", description: "Source has HeroSection but reconstruction is missing it.", impact: 25 });
  }

  // Stencil type count mismatch
  const typeDrifts: string[] = [];
  for (const [type, count] of Object.entries(srcCounts) as [VisualStencilType, number][]) {
    const genCount = genCounts[type] ?? 0;
    const r = ratio(genCount, count);
    if (r < 0.5 && count > 1) {
      typeDrifts.push(type);
      failurePoints.push({
        category:    "stencil_mismatch",
        severity:    r < 0.25 ? "major" : "minor",
        description: `${type}: source has ${count} pages, reconstruction has ${genCount} (${Math.round(r * 100)}% coverage).`,
        impact:      r < 0.25 ? 12 : 5,
      });
    }
  }
  if (typeDrifts.length > 0) signals.push(`stencil-drift:${typeDrifts.join(",")}`);

  const penalty = failurePoints.reduce((s, f) => s + f.impact, 0);
  const score   = clamp(distSim * 100 - penalty);
  return { score, confidence: "scored", signals, failurePoints };
}

// ─────────────────────────────────────────────────────────────────────────────

function scoreStructuralFidelity(
  srcMap: VisualStencilMap | null,
  genMap: VisualStencilMap | null,
  fidelity: FidelityReport | null,
  consistency: ConsistencyReport | null
): DimensionScore {
  const failurePoints: FailurePoint[] = [];
  const signals: string[] = [];

  // Fidelity component metric → structural proxy
  if (fidelity?.metrics?.component) {
    const metric = fidelity.metrics.component;
    const score  = clamp(metric.score);
    signals.push(`fidelity-component-metric:${score}`);

    for (const issue of metric.issues ?? []) {
      failurePoints.push({
        category:    "structure_deviation",
        severity:    issue.severity === "high" ? "critical" : issue.severity === "medium" ? "major" : "minor",
        description: issue.description,
        impact:      issue.severity === "high" ? 12 : 6,
      });
    }
    return { score, confidence: "scored", signals, failurePoints };
  }

  if (!srcMap) return { score: "UNKNOWN", confidence: "unknown", signals: ["no-source-stencil-map"], failurePoints: [] };

  // Compare heading depth distributions
  const srcDepths = srcMap.nodes.map(n => n.visualHierarchy.headingDepth);
  const genDepths = genMap ? genMap.nodes.map(n => n.visualHierarchy.headingDepth) : [];

  const srcMedianDepth = median(srcDepths);
  const genMedianDepth = genDepths.length ? median(genDepths) : -1;

  let score = 80; // structural baseline

  if (genMedianDepth >= 0) {
    const depthRatio = ratio(genMedianDepth, srcMedianDepth);
    score = clamp(score * (0.4 + 0.6 * depthRatio));
    signals.push(`heading-depth:src=${srcMedianDepth.toFixed(1)},gen=${genMedianDepth.toFixed(1)}`);

    if (depthRatio < 0.6) {
      failurePoints.push({
        category:    "heading_regression",
        severity:    depthRatio < 0.3 ? "critical" : "major",
        description: `Generated heading depth (${genMedianDepth.toFixed(1)}) is significantly shallower than source (${srcMedianDepth.toFixed(1)}).`,
        impact:      depthRatio < 0.3 ? 20 : 10,
      });
    }
  } else {
    signals.push(`heading-depth:src=${srcMedianDepth.toFixed(1)},gen=N/A`);
  }

  // Section count similarity
  const srcSections = srcMap.nodes.map(n => n.visualHierarchy.sections);
  const genSections = genMap ? genMap.nodes.map(n => n.visualHierarchy.sections) : [];
  const srcMedSec   = median(srcSections);
  const genMedSec   = genSections.length ? median(genSections) : -1;

  if (genMedSec >= 0) {
    const secRatio = ratio(Math.min(genMedSec, srcMedSec), Math.max(genMedSec, srcMedSec));
    score = clamp(score * (0.5 + 0.5 * secRatio));
    signals.push(`sections:src=${srcMedSec.toFixed(1)},gen=${genMedSec.toFixed(1)}`);

    if (secRatio < 0.5) {
      failurePoints.push({
        category:    "structure_deviation",
        severity:    "major",
        description: `Section count divergence: source median=${srcMedSec.toFixed(1)}, generated=${genMedSec.toFixed(1)}.`,
        impact:      15,
      });
    }
  }

  // Consistency score as proxy for structural quality
  if (consistency) {
    const consScore = consistency.summary.overallConsistencyScore;
    score = clamp(score * 0.7 + consScore * 0.3);
    signals.push(`consistency-score:${consScore}`);
  }

  const penalty = failurePoints.reduce((s, f) => s + f.impact, 0);
  return { score: clamp(score - penalty), confidence: genMap ? "scored" : "partial", signals, failurePoints };
}

// ─────────────────────────────────────────────────────────────────────────────

function scoreContentPlacement(
  srcMap:  VisualStencilMap | null,
  genMap:  VisualStencilMap | null,
  dna:     VisualDnaOutput | null
): DimensionScore {
  const failurePoints: FailurePoint[] = [];
  const signals: string[] = [];

  if (!srcMap) return { score: "UNKNOWN", confidence: "unknown", signals: ["no-source-stencil-map"], failurePoints: [] };

  const srcNodes = srcMap.nodes;
  const genNodes = genMap?.nodes ?? [];

  // Page count ratio
  const pageCountRatio = genNodes.length > 0
    ? ratio(genNodes.length, srcNodes.length)
    : 0;
  signals.push(`page-count:src=${srcNodes.length},gen=${genNodes.length}`);

  let score = 100;

  if (pageCountRatio < 1 && genNodes.length > 0) {
    const missingCount = srcNodes.length - genNodes.length;
    const missingRatio = 1 - pageCountRatio;
    if (missingRatio > 0.1) {
      failurePoints.push({
        category:    "missing_pages",
        severity:    missingRatio > 0.3 ? "critical" : missingRatio > 0.15 ? "major" : "minor",
        description: `${missingCount} pages missing from reconstruction (${Math.round(missingRatio * 100)}% of original).`,
        impact:      clamp(missingRatio * 60),
      });
    }
    score -= missingRatio * 40;
  } else if (genNodes.length === 0) {
    // No generated output at all
    return { score: "UNKNOWN", confidence: "unknown", signals: [...signals, "no-generated-pages"], failurePoints: [] };
  }

  // Word count ratio (content volume preserved)
  const srcTotalWords = srcNodes.reduce((s, n) => s + n.visualHierarchy.wordCount, 0);
  const genTotalWords = genNodes.reduce((s, n) => s + n.visualHierarchy.wordCount, 0);
  const wordRatio = srcTotalWords > 0 ? ratio(genTotalWords, srcTotalWords) : 1;
  signals.push(`word-count:src=${srcTotalWords},gen=${genTotalWords},ratio=${wordRatio.toFixed(3)}`);

  if (wordRatio < 0.7 && srcTotalWords > 100) {
    failurePoints.push({
      category:    "content_truncation",
      severity:    wordRatio < 0.4 ? "critical" : wordRatio < 0.6 ? "major" : "minor",
      description: `Content volume: reconstruction has ${Math.round(wordRatio * 100)}% of original word count (${genTotalWords} vs ${srcTotalWords}).`,
      impact:      clamp((1 - wordRatio) * 35),
    });
    score -= (1 - wordRatio) * 30;
  }

  // Depth distribution similarity
  const srcDepthDist: Record<string, number> = {};
  const genDepthDist: Record<string, number> = {};
  for (const n of srcNodes) srcDepthDist[String(n.depth)] = (srcDepthDist[String(n.depth)] ?? 0) + 1;
  for (const n of genNodes) genDepthDist[String(n.depth)] = (genDepthDist[String(n.depth)] ?? 0) + 1;
  const depthSim = distributionSimilarity(srcDepthDist, genDepthDist);
  signals.push(`depth-distribution-similarity:${depthSim.toFixed(3)}`);

  if (depthSim < 0.6) {
    failurePoints.push({
      category:    "depth_imbalance",
      severity:    depthSim < 0.4 ? "major" : "minor",
      description: `Page depth distribution diverges significantly from original (similarity: ${Math.round(depthSim * 100)}%).`,
      impact:      clamp((1 - depthSim) * 20),
    });
    score -= (1 - depthSim) * 15;
  }

  // Visual DNA component frequency similarity
  if (dna?.aggregate?.componentFrequency) {
    const srcFreq = dna.aggregate.componentFrequency;
    // We don't have gen DNA separately, so this is a quality signal on source richness
    const componentCount = Object.values(srcFreq).filter(v => v > 0).length;
    signals.push(`component-richness:${componentCount}`);
    if (componentCount < 3) score -= 5;
  }

  const penalty = failurePoints.reduce((s, f) => s + f.impact, 0);
  return {
    score:       clamp(score - penalty * 0.5),   // half penalty already baked into score
    confidence:  genNodes.length > 0 ? "scored" : "partial",
    signals,
    failurePoints,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function scoreNavigationParity(
  srcMap:  VisualStencilMap | null,
  genMap:  VisualStencilMap | null,
  fidelity: FidelityReport | null,
  dna:     VisualDnaOutput | null
): DimensionScore {
  const failurePoints: FailurePoint[] = [];
  const signals: string[] = [];

  // Fidelity navigation metric is authoritative
  if (fidelity?.metrics?.navigation) {
    const metric = fidelity.metrics.navigation;
    const score  = clamp(metric.score);
    signals.push(`fidelity-navigation-metric:${score}`);

    for (const issue of metric.issues ?? []) {
      failurePoints.push({
        category:    "navigation_hole",
        severity:    issue.severity === "high" ? "critical" : "major",
        description: issue.description,
        impact:      issue.severity === "high" ? 15 : 7,
      });
    }
    return { score, confidence: "scored", signals, failurePoints };
  }

  if (!srcMap) return { score: "UNKNOWN", confidence: "unknown", signals: ["no-source-stencil-map"], failurePoints: [] };

  const srcNodes = srcMap.nodes;
  const genNodes = genMap?.nodes ?? [];

  let score = 85;

  // Navigation node presence
  const srcNavCount = srcNodes.filter(n => n.visualHierarchy.hasNavigation).length;
  const genNavCount = genNodes.filter(n => n.visualHierarchy.hasNavigation).length;
  const navRatio    = srcNavCount > 0 ? ratio(genNavCount, srcNavCount) : 1;
  signals.push(`nav-nodes:src=${srcNavCount},gen=${genNavCount}`);

  if (genNodes.length > 0 && navRatio < 0.7 && srcNavCount > 0) {
    failurePoints.push({
      category:    "navigation_hole",
      severity:    navRatio < 0.4 ? "critical" : "major",
      description: `Only ${Math.round(navRatio * 100)}% of navigation-bearing pages have navigation in reconstruction.`,
      impact:      clamp((1 - navRatio) * 30),
    });
    score -= (1 - navRatio) * 25;
  }

  // NavigationLayout stencil parity
  const srcNavLayouts = (srcMap.summary.byStencilType["NavigationLayout"] ?? 0);
  const genNavLayouts = genMap ? (genMap.summary.byStencilType["NavigationLayout"] ?? 0) : -1;
  signals.push(`nav-layout-pages:src=${srcNavLayouts},gen=${genNavLayouts >= 0 ? genNavLayouts : "N/A"}`);

  if (srcNavLayouts > 0 && genNavLayouts === 0) {
    failurePoints.push({
      category:    "missing_navigation_layout",
      severity:    srcNavLayouts >= 2 ? "critical" : "major",
      description: `Source has ${srcNavLayouts} NavigationLayout pages but reconstruction has none.`,
      impact:      srcNavLayouts >= 2 ? 20 : 12,
    });
    score -= srcNavLayouts >= 2 ? 18 : 10;
  }

  // Footer parity
  const srcFooterCount = srcNodes.filter(n => n.visualHierarchy.hasFooter).length;
  const genFooterCount = genNodes.filter(n => n.visualHierarchy.hasFooter).length;
  const footerRatio    = srcFooterCount > 0 ? ratio(genFooterCount, srcFooterCount) : 1;
  signals.push(`footer-pages:src=${srcFooterCount},gen=${genFooterCount}`);

  if (genNodes.length > 0 && footerRatio < 0.5 && srcFooterCount > 2) {
    failurePoints.push({
      category:    "navigation_hole",
      severity:    "minor",
      description: `Footer presence dropped from ${srcFooterCount} to ${genFooterCount} pages (${Math.round(footerRatio * 100)}% retention).`,
      impact:      8,
    });
    score -= 5;
  }

  // DNA navigation pattern signal
  if (dna?.aggregate?.navigationPatterns) {
    const patterns = dna.aggregate.navigationPatterns;
    signals.push(`nav-patterns:${patterns.slice(0, 3).join(",")}`);
    if (patterns.length >= 2) score = Math.min(score + 5, 100);  // rich nav bonus
  }

  const penalty = failurePoints.reduce((s, f) => s + f.impact, 0);
  return {
    score:      clamp(genNodes.length > 0 ? score - penalty * 0.5 : score),
    confidence: genNodes.length > 0 ? "scored" : "partial",
    signals,
    failurePoints,
  };
}

// ── Improvement suggestions ───────────────────────────────────────────────────

function generateSuggestions(
  layout:     DimensionScore,
  structural: DimensionScore,
  content:    DimensionScore,
  nav:        DimensionScore
): ImprovementSuggestion[] {
  const suggestions: ImprovementSuggestion[] = [];

  const layoutScore  = numericScore(layout.score);
  const structScore  = numericScore(structural.score);
  const contentScore = numericScore(content.score);
  const navScore     = numericScore(nav.score);

  if (layoutScore < 70) {
    suggestions.push({
      priority: "high", dimension: "layout",
      action: "Re-run the stencil mapper on the generated output and compare type distribution against source. Ensure HeroSection appears on the root page.",
      expectedGain: Math.min(25, 75 - layoutScore),
    });
  }

  if (structScore < 70) {
    suggestions.push({
      priority: "high", dimension: "structural",
      action: "Verify heading hierarchy (H1→H2→H3) is preserved in generated HTML. Target heading depth ≥ source median.",
      expectedGain: Math.min(20, 75 - structScore),
    });
    suggestions.push({
      priority: "medium", dimension: "structural",
      action: "Run the Multi-Page Consistency Engine (POST /api/consistency/:jobId) and apply the normalized tokens to the generated output.",
      expectedGain: 10,
    });
  }

  if (contentScore < 70) {
    suggestions.push({
      priority: "high", dimension: "content",
      action: `Increase page coverage — aim for ≥90% of source page count. Check for pages skipped during generation.`,
      expectedGain: Math.min(30, 80 - contentScore),
    });
    // Check for specific content failure points
    const hasWordCountIssue = content.failurePoints.some(f => f.category === "content_truncation");
    if (hasWordCountIssue) {
      suggestions.push({
        priority: "high", dimension: "content",
        action: "Content truncation detected — ensure full article bodies are included in generated HTML, not just excerpts.",
        expectedGain: 15,
      });
    }
  }

  if (navScore < 70) {
    suggestions.push({
      priority: "high", dimension: "navigation",
      action: "Restore <nav> elements and navigation links on pages that had navigation in the source. Preserve footer on all pages that had one.",
      expectedGain: Math.min(25, 80 - navScore),
    });
  }

  // Global suggestions based on missing data
  if (layout.confidence === "unknown" || structural.confidence === "unknown") {
    suggestions.push({
      priority: "medium", dimension: "global",
      action: "Run the Visual Stencil Mapper (POST /api/stencil-map/:jobId) for the generated job to enable comparison scoring.",
      expectedGain: 15,
    });
  }

  // Sort: high priority first, then by expectedGain
  return suggestions.sort((a, b) =>
    (a.priority === "high" ? 0 : a.priority === "medium" ? 1 : 2) -
    (b.priority === "high" ? 0 : b.priority === "medium" ? 1 : 2) ||
    b.expectedGain - a.expectedGain
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ScorerInput {
  jobId:          string;
  generatedJobId: string | null;
  /** Pre-loaded data — skips R2 fetches for already-loaded artifacts */
  preloaded?: {
    sourceStencilMap?:    VisualStencilMap;
    generatedStencilMap?: VisualStencilMap;
    fidelityReport?:      FidelityReport;
    consistencyReport?:   ConsistencyReport;
    visualDna?:           VisualDnaOutput;
  };
}

/**
 * runReconstructionScorer — Phase 6.8 entry point.
 *
 * Loads all available data from R2, scores across 4 dimensions,
 * uploads reconstructionScore.json, returns the full report.
 */
export async function runReconstructionScorer(
  input: ScorerInput
): Promise<ReconstructionScoreReport> {
  const { jobId, generatedJobId } = input;
  const start = Date.now();

  logger.info({ jobId, generatedJobId }, "RECON-SCORER: starting");

  // ── Load all data sources in parallel ────────────────────────────────────
  const [
    sourceStencilMap,
    generatedStencilMap,
    fidelityReport,
    consistencyReport,
    visualDna,
  ] = await Promise.all([
    input.preloaded?.sourceStencilMap
      ?? fetchR2Json<VisualStencilMap>(`jobs/${jobId}/visual-stencil-map.json`),

    (input.preloaded?.generatedStencilMap ?? (generatedJobId
      ? fetchR2Json<VisualStencilMap>(`jobs/${generatedJobId}/visual-stencil-map.json`)
      : null)),

    (input.preloaded?.fidelityReport ?? (generatedJobId
      ? fetchR2Json<FidelityReport>(`jobs/${jobId}/fidelity/${generatedJobId}/visual-fidelity-report.json`)
      : null)),

    input.preloaded?.consistencyReport
      ?? fetchR2Json<ConsistencyReport>(`jobs/${jobId}/consistency-report.json`),

    input.preloaded?.visualDna
      ?? fetchR2Json<VisualDnaOutput>(`jobs/${jobId}/_visual-dna.json`),
  ]);

  // Track which data sources are available
  const availableDataSources: string[] = [];
  const missingDataSources: string[] = [];

  if (sourceStencilMap)    availableDataSources.push("source-stencil-map");
  else                     missingDataSources.push("source-stencil-map");
  if (generatedStencilMap) availableDataSources.push("generated-stencil-map");
  else if (generatedJobId) missingDataSources.push("generated-stencil-map");
  if (fidelityReport)      availableDataSources.push("fidelity-report");
  else if (generatedJobId) missingDataSources.push("fidelity-report");
  if (consistencyReport)   availableDataSources.push("consistency-report");
  else                     missingDataSources.push("consistency-report");
  if (visualDna)           availableDataSources.push("visual-dna");
  else                     missingDataSources.push("visual-dna");

  // ── Score each dimension ──────────────────────────────────────────────────
  const layoutDim     = scoreLayoutSimilarity(sourceStencilMap, generatedStencilMap, fidelityReport);
  const structuralDim = scoreStructuralFidelity(sourceStencilMap, generatedStencilMap, fidelityReport, consistencyReport);
  const contentDim    = scoreContentPlacement(sourceStencilMap, generatedStencilMap, visualDna);
  const navDim        = scoreNavigationParity(sourceStencilMap, generatedStencilMap, fidelityReport, visualDna);

  // ── Compute total score ───────────────────────────────────────────────────
  // Weights: layout=30%, structural=30%, content=25%, navigation=15%
  const WEIGHTS = { layout: 0.30, structural: 0.30, content: 0.25, navigation: 0.15 };

  const dimensions = [
    { dim: layoutDim,     weight: WEIGHTS.layout },
    { dim: structuralDim, weight: WEIGHTS.structural },
    { dim: contentDim,    weight: WEIGHTS.content },
    { dim: navDim,        weight: WEIGHTS.navigation },
  ];

  const scoredDimensions  = dimensions.filter(d => d.dim.score !== "UNKNOWN").length;
  const unknownDimensions = dimensions.filter(d => d.dim.score === "UNKNOWN").length;

  let totalScore: ScoreValue;
  if (scoredDimensions === 0) {
    totalScore = "UNKNOWN";
  } else {
    // Renormalize weights to scored dimensions only
    const scoredWeight = dimensions
      .filter(d => d.dim.score !== "UNKNOWN")
      .reduce((s, d) => s + d.weight, 0);

    const weighted = dimensions
      .filter(d => d.dim.score !== "UNKNOWN")
      .reduce((s, d) => s + numericScore(d.dim.score) * (d.weight / scoredWeight), 0);

    // Penalize for unknown dimensions (strict)
    const unknownPenalty = unknownDimensions * 8;
    totalScore = clamp(weighted - unknownPenalty);
  }

  // ── Aggregate failure points ──────────────────────────────────────────────
  const allFailures: FailurePoint[] = [
    ...layoutDim.failurePoints,
    ...structuralDim.failurePoints,
    ...contentDim.failurePoints,
    ...navDim.failurePoints,
  ].sort((a, b) => {
    const sevOrder = { critical: 0, major: 1, minor: 2 };
    return sevOrder[a.severity] - sevOrder[b.severity] || b.impact - a.impact;
  });

  // ── Generate improvement suggestions ─────────────────────────────────────
  const suggestions = generateSuggestions(layoutDim, structuralDim, contentDim, navDim);

  // ── Assemble report ───────────────────────────────────────────────────────
  const seedUrl = sourceStencilMap?.seedUrl ?? "";

  const report: ReconstructionScoreReport = {
    schemaVersion:   "6.8",
    jobId,
    generatedJobId:  generatedJobId ?? null,
    seedUrl,
    generatedAt:     new Date().toISOString(),
    totalScore,
    grade:           grade(totalScore),
    breakdown: {
      layoutSimilarity:   layoutDim,
      structuralFidelity: structuralDim,
      contentPlacement:   contentDim,
      navigationParity:   navDim,
    },
    failurePoints:   allFailures,
    suggestions,
    meta: {
      sourceNodeCount:       sourceStencilMap?.nodes.length ?? 0,
      generatedNodeCount:    generatedStencilMap?.nodes.length ?? null,
      availableDataSources,
      missingDataSources,
      scoredDimensions,
      unknownDimensions,
    },
  };

  // ── Upload to R2 ──────────────────────────────────────────────────────────
  const r2Key = generatedJobId
    ? `jobs/${jobId}/reconstruction-score/${generatedJobId}/reconstructionScore.json`
    : `jobs/${jobId}/reconstructionScore.json`;

  const uploaded = await uploadR2Json(report, r2Key);
  if (uploaded) report.r2Key = r2Key;

  const durationMs = Date.now() - start;
  logger.info(
    { jobId, generatedJobId, totalScore, grade: report.grade, scoredDimensions, durationMs },
    "RECON-SCORER: complete"
  );

  return report;
}
