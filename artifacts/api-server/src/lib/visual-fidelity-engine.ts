/**
 * visual-fidelity-engine.ts — Phase 6.5 Visual Fidelity Engine
 *
 * Measures similarity between a source website and a generated Website Prime
 * using the VisualDnaOutput produced by Phase 2.5B (visual-dna-engine.ts).
 *
 * Produces: visual-fidelity-report.json
 *
 * Metrics (each 0–100):
 *   1. layout      — overall structure, section count, page dimensions
 *   2. color       — palette distance between primary/secondary/accent systems
 *   3. spacing     — rhythm alignment (margins/padding/font-size scales)
 *   4. component   — hero, cards, gallery, testimonials, CTAs, footer, forms …
 *   5. navigation  — patterns, item count, search, breadcrumbs
 *   6. responsive  — strategy, stacking behaviour, breakpoints, ratio
 *
 * Overall grade: A (90+) | B (75–89) | C (60–74) | D (45–59) | F (<45)
 *
 * Pipeline placement: visual_dna (source) + visual_dna (generated) → fidelity
 */

import { logger } from "./logger";
import type { VisualDnaOutput, PageDna, ColorSystem, LayoutClassification, ComponentDetection, NavigationAnalysis, ResponsiveAnalysis, TypographySystem } from "./visual-dna-engine";
import { paletteSimilarity } from "./canonical-color-engine.js";

// ── Output types ───────────────────────────────────────────────────────────────

export type FidelityGrade = "A" | "B" | "C" | "D" | "F";

export interface MetricScore {
  score: number;
  confidence: number;
  notes: string[];
}

export interface MetricScores {
  layout: MetricScore;
  color: MetricScore;
  spacing: MetricScore;
  component: MetricScore;
  navigation: MetricScore;
  responsive: MetricScore;
}

export interface FidelityIssue {
  category: "missing_section" | "layout_drift" | "component_mismatch" | "design_mismatch";
  severity: "high" | "medium" | "low";
  description: string;
  sourceValue?: string;
  generatedValue?: string;
}

export interface PageFidelity {
  sourceUrl: string;
  generatedUrl: string;
  overallScore: number;
  metrics: MetricScores;
  issues: FidelityIssue[];
}

export interface VisualFidelityReport {
  schemaVersion: "6.5";
  sourceJobId: string;
  generatedJobId: string;
  generatedAt: string;
  summary: {
    pagesCompared: number;
    overallScore: number;
    grade: FidelityGrade;
    metrics: {
      layout: number;
      color: number;
      spacing: number;
      component: number;
      navigation: number;
      responsive: number;
    };
  };
  issues: {
    missingSections: FidelityIssue[];
    layoutDrift: FidelityIssue[];
    componentMismatches: FidelityIssue[];
    designMismatches: FidelityIssue[];
  };
  perPage: PageFidelity[];
  r2Key?: string;
}

// ── Colour distance — paletteSimilarity imported from canonical-color-engine ───

// ── Set overlap ────────────────────────────────────────────────────────────────

function setOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 100;
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a.map(s => s.toLowerCase()));
  const setB = new Set(b.map(s => s.toLowerCase()));
  let intersection = 0;
  for (const v of setA) if (setB.has(v)) intersection++;
  const union = new Set([...setA, ...setB]).size;
  return Math.round((intersection / union) * 100);
}

/** Numeric proximity score: 100 if equal, decays proportionally */
function numericProximity(a: number, b: number, maxDelta: number): number {
  if (a === 0 && b === 0) return 100;
  const delta = Math.abs(a - b);
  return Math.max(0, Math.round((1 - delta / maxDelta) * 100));
}

/** Safely clamp 0–100 */
function clamp(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

// ── Individual metric scorers ──────────────────────────────────────────────────

function scoreLayout(src: PageDna, gen: PageDna): MetricScore {
  const notes: string[] = [];
  const scores: number[] = [];

  // Layout type match
  const typeMatch = src.layoutClassification.type === gen.layoutClassification.type;
  scores.push(typeMatch ? 100 : 30);
  if (!typeMatch) {
    notes.push(`Layout type drift: source=${src.layoutClassification.type}, generated=${gen.layoutClassification.type}`);
  }

  // Section count proximity (max delta = 10)
  if (src.layoutClassification.signals["sectionsCount"] !== undefined &&
      gen.layoutClassification.signals["sectionsCount"] !== undefined) {
    const srcSec = src.layoutClassification.signals["sectionsCount"] as number;
    const genSec = gen.layoutClassification.signals["sectionsCount"] as number;
    const secScore = numericProximity(srcSec, genSec, 10);
    scores.push(secScore);
    if (secScore < 70) {
      notes.push(`Section count: source=${srcSec}, generated=${genSec}`);
    }
  }

  // Navigation presence
  const srcHasNav = src.layoutClassification.signals["hasNavigation"] as boolean;
  const genHasNav = gen.layoutClassification.signals["hasNavigation"] as boolean;
  if (srcHasNav !== undefined && genHasNav !== undefined) {
    scores.push(srcHasNav === genHasNav ? 100 : 0);
    if (srcHasNav && !genHasNav) notes.push("Navigation missing in generated site");
    if (!srcHasNav && genHasNav) notes.push("Unexpected navigation in generated site");
  }

  // Footer presence
  const srcHasFooter = src.layoutClassification.signals["hasFooter"] as boolean;
  const genHasFooter = gen.layoutClassification.signals["hasFooter"] as boolean;
  if (srcHasFooter !== undefined && genHasFooter !== undefined) {
    scores.push(srcHasFooter === genHasFooter ? 100 : 0);
    if (srcHasFooter && !genHasFooter) notes.push("Footer missing in generated site");
  }

  // DOM element count proximity (max delta = 2000)
  scores.push(numericProximity(src.domElementCount, gen.domElementCount, 2000));

  const score = clamp(scores.reduce((a, b) => a + b, 0) / scores.length);
  const confidence = Math.min(src.layoutClassification.confidence, gen.layoutClassification.confidence);
  return { score, confidence, notes };
}

function scoreColor(src: PageDna, gen: PageDna): MetricScore {
  const notes: string[] = [];
  const scores: number[] = [];

  const srcCS = src.colorSystem;
  const genCS = gen.colorSystem;

  // Primary palette similarity (weight ×2)
  const primaryScore = paletteSimilarity(srcCS.primary, genCS.primary);
  scores.push(primaryScore, primaryScore); // weighted
  if (primaryScore < 60) notes.push(`Primary color mismatch (score ${primaryScore}/100)`);

  // Secondary palette
  const secondaryScore = paletteSimilarity(srcCS.secondary, genCS.secondary);
  scores.push(secondaryScore);
  if (secondaryScore < 50) notes.push(`Secondary color mismatch (score ${secondaryScore}/100)`);

  // Accent palette
  const accentScore = paletteSimilarity(srcCS.accent, genCS.accent);
  scores.push(accentScore);

  // Background palette
  const bgScore = paletteSimilarity(srcCS.background, genCS.background);
  scores.push(bgScore);
  if (bgScore < 50) notes.push(`Background color mismatch (score ${bgScore}/100)`);

  // Text palette
  const textScore = paletteSimilarity(srcCS.text, genCS.text);
  scores.push(textScore);

  const score = clamp(scores.reduce((a, b) => a + b, 0) / scores.length);
  const confidence = Math.min(srcCS.confidence, genCS.confidence);
  return { score, confidence, notes };
}

function scoreSpacing(src: PageDna, gen: PageDna): MetricScore {
  const notes: string[] = [];
  const scores: number[] = [];

  const srcT = src.typographySystem;
  const genT = gen.typographySystem;

  // Font family overlap
  const fontScore = setOverlap(srcT.fontFamilies, genT.fontFamilies);
  scores.push(fontScore);
  if (fontScore < 50) {
    notes.push(`Font families diverge: source=[${srcT.fontFamilies.slice(0, 3).join(", ")}], generated=[${genT.fontFamilies.slice(0, 3).join(", ")}]`);
  }

  // Font size scale overlap
  const sizeScore = setOverlap(srcT.fontSizes, genT.fontSizes);
  scores.push(sizeScore);
  if (sizeScore < 50) notes.push(`Font size scale mismatch (overlap ${sizeScore}%)`);

  // Spacing rhythm overlap
  const rhythmScore = setOverlap(srcT.spacingRhythm, genT.spacingRhythm);
  scores.push(rhythmScore);
  if (rhythmScore < 40) notes.push(`Spacing rhythm mismatch (overlap ${rhythmScore}%)`);

  // Font weight set overlap
  const weightScore = setOverlap(srcT.fontWeights, genT.fontWeights);
  scores.push(weightScore);

  // Heading hierarchy depth match
  const srcHeadings = Object.keys(srcT.headingHierarchy).length;
  const genHeadings = Object.keys(genT.headingHierarchy).length;
  scores.push(numericProximity(srcHeadings, genHeadings, 6));
  if (Math.abs(srcHeadings - genHeadings) > 2) {
    notes.push(`Heading hierarchy depth: source=${srcHeadings} levels, generated=${genHeadings} levels`);
  }

  const score = clamp(scores.reduce((a, b) => a + b, 0) / scores.length);
  const confidence = Math.min(srcT.confidence, genT.confidence);
  return { score, confidence, notes };
}

function scoreComponent(src: PageDna, gen: PageDna): MetricScore {
  const notes: string[] = [];
  const scores: number[] = [];

  const srcC = src.componentDetection;
  const genC = gen.componentDetection;

  // Hero presence + variant match
  if (srcC.hero !== genC.hero) {
    scores.push(0);
    notes.push(srcC.hero ? "Hero section missing in generated site" : "Unexpected hero in generated site");
  } else {
    scores.push(srcC.heroVariant === genC.heroVariant ? 100 : 60);
    if (srcC.hero && srcC.heroVariant !== genC.heroVariant) {
      notes.push(`Hero variant: source=${srcC.heroVariant}, generated=${genC.heroVariant}`);
    }
  }

  // Cards (proximity, max delta = 20)
  scores.push(numericProximity(srcC.cards, genC.cards, 20));
  if (Math.abs(srcC.cards - genC.cards) > 5) {
    notes.push(`Card count: source=${srcC.cards}, generated=${genC.cards}`);
  }

  // Gallery
  scores.push(srcC.gallery === genC.gallery ? 100 : 0);
  if (srcC.gallery && !genC.gallery) notes.push("Gallery section missing in generated site");

  // Testimonials
  scores.push(srcC.testimonials === genC.testimonials ? 100 : 0);
  if (srcC.testimonials && !genC.testimonials) notes.push("Testimonials section missing in generated site");

  // CTA buttons (proximity, max delta = 10)
  scores.push(numericProximity(srcC.ctaButtons, genC.ctaButtons, 10));
  if (Math.abs(srcC.ctaButtons - genC.ctaButtons) > 3) {
    notes.push(`CTA buttons: source=${srcC.ctaButtons}, generated=${genC.ctaButtons}`);
  }

  // Footer
  scores.push(srcC.hasFooter === genC.hasFooter ? 100 : 0);
  if (srcC.hasFooter && !genC.hasFooter) notes.push("Footer component missing");

  // FAQ blocks
  scores.push(numericProximity(srcC.faqBlocks, genC.faqBlocks, 5));
  if (srcC.faqBlocks > 0 && genC.faqBlocks === 0) notes.push("FAQ blocks missing in generated site");

  // Forms
  scores.push(numericProximity(srcC.forms, genC.forms, 5));
  if (srcC.forms > 0 && genC.forms === 0) notes.push("Form(s) missing in generated site");

  // Pricing table
  scores.push(srcC.pricingTable === genC.pricingTable ? 100 : 0);
  if (srcC.pricingTable && !genC.pricingTable) notes.push("Pricing table missing in generated site");

  const score = clamp(scores.reduce((a, b) => a + b, 0) / scores.length);
  const confidence = Math.min(srcC.confidence, genC.confidence);
  return { score, confidence, notes };
}

function scoreNavigation(src: PageDna, gen: PageDna): MetricScore {
  const notes: string[] = [];
  const scores: number[] = [];

  const srcN = src.navigationAnalysis;
  const genN = gen.navigationAnalysis;

  // Navigation pattern overlap
  const patternScore = setOverlap(srcN.patterns, genN.patterns);
  scores.push(patternScore);
  if (patternScore < 60) {
    notes.push(`Nav patterns: source=[${srcN.patterns.join(", ")}], generated=[${genN.patterns.join(", ")}]`);
  }

  // Item count proximity (max delta = 15)
  const itemScore = numericProximity(srcN.navItemCount, genN.navItemCount, 15);
  scores.push(itemScore);
  if (itemScore < 60) {
    notes.push(`Nav item count: source=${srcN.navItemCount}, generated=${genN.navItemCount}`);
  }

  // Search presence
  scores.push(srcN.hasSearch === genN.hasSearch ? 100 : 0);
  if (srcN.hasSearch && !genN.hasSearch) notes.push("Search missing from navigation");

  // Breadcrumbs
  scores.push(srcN.hasBreadcrumbs === genN.hasBreadcrumbs ? 100 : 0);
  if (srcN.hasBreadcrumbs && !genN.hasBreadcrumbs) notes.push("Breadcrumbs missing from generated site");

  const score = clamp(scores.reduce((a, b) => a + b, 0) / scores.length);
  const confidence = Math.min(srcN.confidence, genN.confidence);
  return { score, confidence, notes };
}

function scoreResponsive(src: PageDna, gen: PageDna): MetricScore {
  const notes: string[] = [];
  const scores: number[] = [];

  const srcR = src.responsiveAnalysis;
  const genR = gen.responsiveAnalysis;

  // Strategy match
  scores.push(srcR.strategy === genR.strategy ? 100 : 40);
  if (srcR.strategy !== genR.strategy) {
    notes.push(`Responsive strategy: source=${srcR.strategy}, generated=${genR.strategy}`);
  }

  // Stacking behaviour match
  scores.push(srcR.stackingBehavior === genR.stackingBehavior ? 100 : 40);
  if (srcR.stackingBehavior !== genR.stackingBehavior) {
    notes.push(`Stacking: source=${srcR.stackingBehavior}, generated=${genR.stackingBehavior}`);
  }

  // Breakpoints overlap
  const bpScore = setOverlap(srcR.breakpoints, genR.breakpoints);
  scores.push(bpScore);

  // Desktop width proximity (max delta = 400px)
  scores.push(numericProximity(srcR.desktopWidth, genR.desktopWidth, 400));

  // Height ratio proximity (max delta = 1)
  const ratioScore = numericProximity(
    Math.round(srcR.heightRatioMobileToDesktop * 100),
    Math.round(genR.heightRatioMobileToDesktop * 100),
    100
  );
  scores.push(ratioScore);
  if (ratioScore < 50) {
    notes.push(`Height ratio mobile/desktop: source=${srcR.heightRatioMobileToDesktop.toFixed(2)}, generated=${genR.heightRatioMobileToDesktop.toFixed(2)}`);
  }

  const score = clamp(scores.reduce((a, b) => a + b, 0) / scores.length);
  const confidence = Math.min(srcR.confidence, genR.confidence);
  return { score, confidence, notes };
}

// ── Issue builder ──────────────────────────────────────────────────────────────

function buildIssues(
  pageFidelities: PageFidelity[],
  srcDna: VisualDnaOutput,
  genDna: VisualDnaOutput
): VisualFidelityReport["issues"] {
  const missingSections: FidelityIssue[] = [];
  const layoutDrift: FidelityIssue[] = [];
  const componentMismatches: FidelityIssue[] = [];
  const designMismatches: FidelityIssue[] = [];

  for (const pf of pageFidelities) {
    const url = pf.sourceUrl;
    const shortUrl = url.split("/").slice(-2).join("/") || url;

    // Missing sections — pulled from component notes
    for (const note of pf.metrics.component.notes) {
      if (note.includes("missing")) {
        missingSections.push({
          category: "missing_section",
          severity: note.toLowerCase().includes("hero") || note.toLowerCase().includes("footer") ? "high" : "medium",
          description: note,
          sourceValue: shortUrl,
        });
      }
    }

    // Layout drift — pulled from layout notes
    for (const note of pf.metrics.layout.notes) {
      layoutDrift.push({
        category: "layout_drift",
        severity: pf.metrics.layout.score < 50 ? "high" : "medium",
        description: note,
        sourceValue: shortUrl,
      });
    }

    // Component mismatches — component + nav notes that aren't "missing"
    for (const note of [...pf.metrics.component.notes, ...pf.metrics.navigation.notes]) {
      if (!note.includes("missing")) {
        componentMismatches.push({
          category: "component_mismatch",
          severity: "low",
          description: note,
          sourceValue: shortUrl,
        });
      }
    }

    // Design mismatches — color + spacing + responsive notes
    for (const note of [
      ...pf.metrics.color.notes,
      ...pf.metrics.spacing.notes,
      ...pf.metrics.responsive.notes,
    ]) {
      designMismatches.push({
        category: "design_mismatch",
        severity: pf.metrics.color.score < 40 || pf.metrics.spacing.score < 40 ? "high" : "medium",
        description: note,
        sourceValue: shortUrl,
      });
    }
  }

  // Deduplicate by description
  const dedupe = (arr: FidelityIssue[]): FidelityIssue[] => {
    const seen = new Set<string>();
    return arr.filter(i => {
      if (seen.has(i.description)) return false;
      seen.add(i.description);
      return true;
    });
  };

  return {
    missingSections: dedupe(missingSections),
    layoutDrift: dedupe(layoutDrift),
    componentMismatches: dedupe(componentMismatches),
    designMismatches: dedupe(designMismatches),
  };
}

// ── Grade calculation ──────────────────────────────────────────────────────────

function gradeFromScore(score: number): FidelityGrade {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

// ── Page pair matching ─────────────────────────────────────────────────────────

/**
 * Match source pages to generated pages by URL path (best-effort).
 * Falls back to positional matching when URLs differ structurally.
 */
function matchPages(
  srcPages: Record<string, PageDna>,
  genPages: Record<string, PageDna>
): Array<{ src: PageDna; gen: PageDna }> {
  const srcList = Object.values(srcPages);
  const genList = Object.values(genPages);

  if (srcList.length === 0 || genList.length === 0) return [];

  const pairs: Array<{ src: PageDna; gen: PageDna }> = [];
  const usedGen = new Set<string>();

  for (const src of srcList) {
    const srcPath = new URL(src.url, "http://x").pathname;

    // Exact path match
    let match = genList.find(g => {
      if (usedGen.has(g.nodeId)) return false;
      return new URL(g.url, "http://x").pathname === srcPath;
    });

    // Slug match (last path segment)
    if (!match) {
      const srcSlug = srcPath.split("/").filter(Boolean).pop() ?? "";
      match = genList.find(g => {
        if (usedGen.has(g.nodeId)) return false;
        const genSlug = new URL(g.url, "http://x").pathname.split("/").filter(Boolean).pop() ?? "";
        return srcSlug && genSlug && srcSlug === genSlug;
      });
    }

    // Positional fallback
    if (!match) {
      match = genList.find(g => !usedGen.has(g.nodeId));
    }

    if (match) {
      usedGen.add(match.nodeId);
      pairs.push({ src, gen: match });
    }
  }

  return pairs;
}

// ── R2 upload ──────────────────────────────────────────────────────────────────

async function uploadReportToR2(
  report: VisualFidelityReport,
  key: string
): Promise<string | null> {
  const accessKeyId     = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint        = process.env.R2_ENDPOINT;
  const bucket          = process.env.R2_BUCKET_NAME;

  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) return null;

  try {
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
    const body = Buffer.from(JSON.stringify(report, null, 2), "utf8");
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/json",
    }));
    const publicBase = process.env.R2_PUBLIC_BASE_URL;
    return publicBase ? `${publicBase}/${key}` : key;
  } catch (err) {
    logger.warn({ err, key }, "FIDELITY: R2 upload failed");
    return null;
  }
}

async function fetchDnaFromR2(jobId: string): Promise<VisualDnaOutput | null> {
  const accessKeyId     = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint        = process.env.R2_ENDPOINT;
  const bucket          = process.env.R2_BUCKET_NAME;

  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) return null;

  try {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
    const key = `jobs/${jobId}/_visual-dna.json`;
    const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = resp.Body as any;
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as VisualDnaOutput;
  } catch (err) {
    logger.warn({ err, jobId }, "FIDELITY: failed to fetch _visual-dna.json from R2");
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface FidelityInput {
  sourceJobId: string;
  generatedJobId: string;
  /** Optionally pass pre-loaded DNA objects instead of fetching from R2 */
  sourceDna?: VisualDnaOutput;
  generatedDna?: VisualDnaOutput;
}

/**
 * runVisualFidelity — Phase 6.5 entry point.
 *
 * Compares the Visual DNA of a source job against a generated job and returns
 * a complete VisualFidelityReport, also uploading it to R2.
 */
export async function runVisualFidelity(input: FidelityInput): Promise<VisualFidelityReport> {
  const { sourceJobId, generatedJobId } = input;
  const start = Date.now();

  logger.info({ sourceJobId, generatedJobId }, "FIDELITY: starting comparison");

  // ── Load DNA ──────────────────────────────────────────────────────────────
  const [srcDna, genDna] = await Promise.all([
    input.sourceDna    ?? fetchDnaFromR2(sourceJobId),
    input.generatedDna ?? fetchDnaFromR2(generatedJobId),
  ]);

  if (!srcDna || !genDna) {
    throw new Error(
      `FIDELITY: visual DNA not available — ` +
      `source=${srcDna ? "ok" : "missing"}, generated=${genDna ? "ok" : "missing"}. ` +
      `Run visual_dna phase for both jobs first.`
    );
  }

  // ── Match pages ───────────────────────────────────────────────────────────
  const pairs = matchPages(srcDna.pages, genDna.pages);

  if (pairs.length === 0) {
    throw new Error("FIDELITY: no page pairs could be matched between source and generated DNA");
  }

  // ── Score each page pair ──────────────────────────────────────────────────
  const pageFidelities: PageFidelity[] = pairs.map(({ src, gen }) => {
    const metrics: MetricScores = {
      layout:     scoreLayout(src, gen),
      color:      scoreColor(src, gen),
      spacing:    scoreSpacing(src, gen),
      component:  scoreComponent(src, gen),
      navigation: scoreNavigation(src, gen),
      responsive: scoreResponsive(src, gen),
    };

    const metricValues = Object.values(metrics).map(m => m.score);
    const overallScore = clamp(metricValues.reduce((a, b) => a + b, 0) / metricValues.length);

    const issues: FidelityIssue[] = [
      ...metrics.layout.notes.map((n): FidelityIssue => ({
        category: n.includes("missing") ? "missing_section" : "layout_drift",
        severity: metrics.layout.score < 50 ? "high" : "medium",
        description: n,
      })),
      ...metrics.component.notes.map((n): FidelityIssue => ({
        category: n.includes("missing") ? "missing_section" : "component_mismatch",
        severity: n.toLowerCase().includes("hero") || n.toLowerCase().includes("footer") ? "high" : "medium",
        description: n,
      })),
      ...metrics.color.notes.map((n): FidelityIssue => ({
        category: "design_mismatch",
        severity: metrics.color.score < 40 ? "high" : "medium",
        description: n,
      })),
      ...metrics.spacing.notes.map((n): FidelityIssue => ({
        category: "design_mismatch",
        severity: "medium",
        description: n,
      })),
      ...metrics.navigation.notes.map((n): FidelityIssue => ({
        category: n.includes("missing") ? "missing_section" : "component_mismatch",
        severity: "low",
        description: n,
      })),
      ...metrics.responsive.notes.map((n): FidelityIssue => ({
        category: "design_mismatch",
        severity: "low",
        description: n,
      })),
    ];

    return {
      sourceUrl: src.url,
      generatedUrl: gen.url,
      overallScore,
      metrics,
      issues,
    };
  });

  // ── Aggregate ─────────────────────────────────────────────────────────────
  const aggMetric = (key: keyof MetricScores): number =>
    clamp(pageFidelities.reduce((sum, p) => sum + p.metrics[key].score, 0) / pageFidelities.length);

  const aggregateMetrics = {
    layout:     aggMetric("layout"),
    color:      aggMetric("color"),
    spacing:    aggMetric("spacing"),
    component:  aggMetric("component"),
    navigation: aggMetric("navigation"),
    responsive: aggMetric("responsive"),
  };

  // Weighted overall: layout × 1.5, component × 1.5, others × 1
  const weightedSum =
    aggregateMetrics.layout     * 1.5 +
    aggregateMetrics.component  * 1.5 +
    aggregateMetrics.color      * 1.0 +
    aggregateMetrics.spacing    * 1.0 +
    aggregateMetrics.navigation * 1.0 +
    aggregateMetrics.responsive * 1.0;
  const totalWeight = 1.5 + 1.5 + 1.0 + 1.0 + 1.0 + 1.0;
  const overallScore = clamp(weightedSum / totalWeight);
  const grade = gradeFromScore(overallScore);

  // ── Build issue categories ────────────────────────────────────────────────
  const issues = buildIssues(pageFidelities, srcDna, genDna);

  // ── Assemble report ───────────────────────────────────────────────────────
  const report: VisualFidelityReport = {
    schemaVersion: "6.5",
    sourceJobId,
    generatedJobId,
    generatedAt: new Date().toISOString(),
    summary: {
      pagesCompared: pageFidelities.length,
      overallScore,
      grade,
      metrics: aggregateMetrics,
    },
    issues,
    perPage: pageFidelities,
  };

  // ── Upload to R2 ──────────────────────────────────────────────────────────
  const r2Key = `jobs/${sourceJobId}/fidelity/${generatedJobId}/visual-fidelity-report.json`;
  const r2Url = await uploadReportToR2(report, r2Key);
  if (r2Url) report.r2Key = r2Key;

  const durationMs = Date.now() - start;
  logger.info(
    { sourceJobId, generatedJobId, grade, overallScore, pagesCompared: pageFidelities.length, durationMs },
    "FIDELITY: comparison complete"
  );

  return report;
}
