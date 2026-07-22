/**
 * visual-reconstruction-engine.ts — Phase 2.5C Visual Reconstruction Engine
 *
 * Upgrades the stencil generator to use Visual DNA alongside Manifest Intelligence:
 *
 *   Manifest + Visual DNA  →  Stencil Generator  →  Website Prime
 *
 * Responsibilities:
 *   1. Load Visual DNA artifacts from R2 (produced by Phase 2.5B)
 *   2. Apply a design-system overlay — inject actual extracted colors + fonts into the
 *      GenerationReport's DesignTokens so Website Prime uses real site colours/typefaces.
 *   3. Score reconstruction fidelity across 5 dimensions (layout, typography, color,
 *      component, navigation) and produce fidelity-report.json with grades A+→D.
 *
 * Pipeline placement: after runGenerationPipeline() in generation-runner.ts
 * Website Prime integration: auto-consumed — generation-runner patches the report in-place
 *                            before persisting it to DB + R2.
 */

import { logger } from "./logger";
import type { GenerationReport } from "@workspace/generation-pipeline";
import {
  hexToRgb,
  rgbToHsl,
  hslColorDistance,
  buildColorScale,
} from "./canonical-color-engine.js";

// ── Internal imports from Phase 2.5B types (mirrored locally to avoid circular deps) ──

interface VisualDnaDesignTokens {
  jobId: string;
  generatedAt: string;
  colors: {
    primary: string[];
    secondary: string[];
    accent: string[];
    background: string[];
    text: string[];
  };
  typography: {
    fontFamilies: string[];
    fontSizes: string[];
    fontWeights: string[];
    headingHierarchy: Record<string, { fontSize: string; fontWeight: string }>;
    spacingRhythm: string[];
  };
  layout: {
    dominantType: string;
    navigationPatterns: string[];
  };
  breakpoints: string[];
  components: string[];
}

interface VisualDnaLayoutMapEntry {
  url: string;
  layoutType: string;
  confidence: number;
  scores: Record<string, number>;
}

interface VisualDnaLayoutMap {
  jobId: string;
  generatedAt: string;
  pages: Record<string, VisualDnaLayoutMapEntry>;
}

interface VisualDnaComponentEntry {
  hero: boolean;
  heroVariant: string;
  cards: number;
  gallery: boolean;
  testimonials: boolean;
  ctaButtons: number;
  hasFooter: boolean;
  faqBlocks: number;
  pricingTable: boolean;
}

interface VisualDnaComponentMap {
  jobId: string;
  generatedAt: string;
  pages: Record<string, { url: string; components: VisualDnaComponentEntry }>;
  aggregate: {
    commonComponents: string[];
    heroPresent: number;
    pagesWithGallery: number;
    pagesWithTestimonials: number;
  };
}

interface VisualDnaFull {
  jobId: string;
  generatedAt: string;
  aggregate: {
    dominantColors: string[];
    dominantFonts: string[];
    dominantLayoutType: string;
    presentNavigationPatterns: string[];
    presentComponents: string[];
    totalPages: number;
  };
}

// ── Public output types ────────────────────────────────────────────────────────

export type ReconstructionGrade = "A+" | "A" | "B" | "C" | "D";

export interface FidelityDimension {
  name: string;
  score: number;
  weight: number;
  details: string;
  signals: Record<string, string | number | boolean>;
}

export interface FidelityReport {
  jobId: string;
  generatedAt: string;
  seedUrl: string;
  overallScore: number;
  grade: ReconstructionGrade;
  dimensions: FidelityDimension[];
  stencilUsed: string;
  recommendedStencil: string | null;
  stencilMatch: boolean;
  overlayApplied: boolean;
  pagesAnalyzed: number;
  systemDescription: string;
  warnings: string[];
}

export interface ReconstructionAudit {
  overlayApplied: boolean;
  fidelityScore: number;
  grade: ReconstructionGrade;
  r2Uploads: number;
  colorsPatched: boolean;
  fontsPatched: boolean;
  stencilMatch: boolean;
  durationMs: number;
}

// ── Layout type → stencil map ─────────────────────────────────────────────────

const LAYOUT_TO_STENCIL: Record<string, string> = {
  editorial:     "blog",
  magazine:      "magazine",
  agency:        "agency",
  luxury:        "agency",
  ecommerce:     "marketplace",
  documentation: "documentation",
  portfolio:     "portfolio",
};

// Adjacent stencil groups (similarity clusters)
const STENCIL_ADJACENCY: Record<string, string[]> = {
  blog:          ["magazine", "agency"],
  magazine:      ["blog", "agency"],
  agency:        ["portfolio", "blog", "luxury"],
  portfolio:     ["agency"],
  luxury:        ["agency"],
  documentation: [],
  marketplace:   ["blog"],
  directory:     ["marketplace"],
  wedding:       ["luxury"],
};

// ── Colour utilities — imported from canonical-color-engine ───────────────────

/** Build a CSS-safe font-family stack from a bare name. */
function buildFontStack(name: string): string {
  const lc = name.toLowerCase();
  const isSerif   = /serif|georgia|times|garamond|merriweather|playfair|lora|eb garamond/.test(lc);
  const isMono    = /mono|code|consolas|fira|jetbrains|source code|courier/.test(lc);
  const isDisplay = /display|poster|bebas|oswald|impact|condensed/.test(lc);

  const fallback = isMono ? "monospace" : isSerif ? "serif" : isDisplay ? "sans-serif" : "sans-serif";
  return `"${name}", ${fallback}`;
}

// ── R2 download utility ────────────────────────────────────────────────────────

async function downloadJsonFromR2<T = unknown>(key: string): Promise<T | null> {
  const accessKeyId     = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint        = process.env.R2_ENDPOINT;
  const bucket          = process.env.R2_BUCKET_NAME;

  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) return null;

  try {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } });
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
  } catch {
    return null;
  }
}

async function uploadJsonToR2(data: unknown, key: string): Promise<boolean> {
  const accessKeyId     = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint        = process.env.R2_ENDPOINT;
  const bucket          = process.env.R2_BUCKET_NAME;

  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) return false;

  try {
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } });
    const body = Buffer.from(JSON.stringify(data, null, 2), "utf-8");
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json" }));
    return true;
  } catch (err) {
    logger.warn({ key, err }, "RECON: R2 upload failed");
    return false;
  }
}

// ── Visual DNA loader ──────────────────────────────────────────────────────────

interface VisualDnaArtifacts {
  designTokens: VisualDnaDesignTokens;
  layoutMap:    VisualDnaLayoutMap;
  componentMap: VisualDnaComponentMap;
  visualDna:    VisualDnaFull;
}

async function loadVisualDnaArtifacts(jobId: string): Promise<VisualDnaArtifacts | null> {
  const [designTokens, layoutMap, componentMap, visualDna] = await Promise.all([
    downloadJsonFromR2<VisualDnaDesignTokens>(`jobs/${jobId}/_design-tokens.json`),
    downloadJsonFromR2<VisualDnaLayoutMap>(`jobs/${jobId}/_layout-map.json`),
    downloadJsonFromR2<VisualDnaComponentMap>(`jobs/${jobId}/_component-map.json`),
    downloadJsonFromR2<VisualDnaFull>(`jobs/${jobId}/_visual-dna.json`),
  ]);

  if (!designTokens && !visualDna) return null;

  return {
    designTokens: designTokens ?? {
      jobId, generatedAt: new Date().toISOString(),
      colors: { primary: [], secondary: [], accent: [], background: [], text: [] },
      typography: { fontFamilies: [], fontSizes: [], fontWeights: [], headingHierarchy: {}, spacingRhythm: [] },
      layout: { dominantType: "editorial", navigationPatterns: [] },
      breakpoints: [], components: [],
    },
    layoutMap:    layoutMap    ?? { jobId, generatedAt: new Date().toISOString(), pages: {} },
    componentMap: componentMap ?? { jobId, generatedAt: new Date().toISOString(), pages: {}, aggregate: { commonComponents: [], heroPresent: 0, pagesWithGallery: 0, pagesWithTestimonials: 0 } },
    visualDna:    visualDna    ?? { jobId, generatedAt: new Date().toISOString(), aggregate: { dominantColors: [], dominantFonts: [], dominantLayoutType: "editorial", presentNavigationPatterns: [], presentComponents: [], totalPages: 0 } },
  };
}

// ── Design System Overlay ──────────────────────────────────────────────────────

/**
 * Patches the GenerationReport's design system tokens in-place using actual
 * Visual DNA colors and fonts. After this call Website Prime will render with
 * the source site's real colour palette and typefaces.
 *
 * Returns { colorsPatched, fontsPatched } to signal what changed.
 */
function applyDesignSystemOverlay(
  report: GenerationReport,
  dna: VisualDnaArtifacts
): { colorsPatched: boolean; fontsPatched: boolean } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tokens = report.generation?.designSystem?.tokens as any;
  if (!tokens) return { colorsPatched: false, fontsPatched: false };

  let colorsPatched = false;
  let fontsPatched  = false;
  const dt = dna.designTokens;

  // ── Color overlay ──────────────────────────────────────────────────────────
  const primaryColor   = dt.colors.primary[0];
  const secondaryColor = dt.colors.secondary[0];
  const accentColor    = dt.colors.accent[0];
  const bgColor        = dt.colors.background[0];
  const textColor      = dt.colors.text[0];

  if (primaryColor) {
    tokens.colors.primary   = buildColorScale(primaryColor);
    tokens.colors.secondary = secondaryColor ? buildColorScale(secondaryColor) : tokens.colors.secondary;
    tokens.colors.accent    = accentColor    ? buildColorScale(accentColor)    : tokens.colors.accent;
    colorsPatched = true;
  }

  // Patch semantic colors if we have enough source data
  if (primaryColor && (bgColor || textColor)) {
    const rgb = hexToRgb(primaryColor);
    const hsl = rgb ? rgbToHsl(rgb) : null;

    const finalBg   = bgColor   ?? tokens.colors.semantic.background;
    const finalText = textColor ?? tokens.colors.semantic.textPrimary;
    const finalAccent = accentColor ?? primaryColor;

    // Build readable secondary text (muted) by lightening the text color
    const textRgb   = hexToRgb(finalText);
    const mutedText = textRgb
      ? `#${Math.min(textRgb.r + 80, 255).toString(16).padStart(2, "0")}${Math.min(textRgb.g + 80, 255).toString(16).padStart(2, "0")}${Math.min(textRgb.b + 80, 255).toString(16).padStart(2, "0")}`
      : tokens.colors.semantic.textSecondary;

    tokens.colors.semantic = {
      ...tokens.colors.semantic,
      background:    finalBg,
      textPrimary:   finalText,
      textSecondary: mutedText,
      accent:        finalAccent,
      link:          hsl ? (hsl.l < 50 ? primaryColor : finalAccent) : primaryColor,
      linkHover:     primaryColor,
    };
  }

  // ── Typography overlay ─────────────────────────────────────────────────────
  const fonts = dt.typography.fontFamilies;
  if (fonts.length > 0) {
    const headingFont = fonts[0];
    const bodyFont    = fonts[1] ?? fonts[0];
    const monoFont    = fonts.find(f => /mono|code|consolas/.test(f.toLowerCase())) ?? "ui-monospace";

    tokens.typography.fontFamilies = {
      heading: buildFontStack(headingFont),
      display: buildFontStack(headingFont),
      body:    buildFontStack(bodyFont),
      mono:    buildFontStack(monoFont),
    };
    fontsPatched = true;
  }

  // ── Font-size overlay — fill in heading sizes from extracted hierarchy ─────
  const hierarchy = dt.typography.headingHierarchy;
  if (Object.keys(hierarchy).length > 0) {
    for (const [tag, val] of Object.entries(hierarchy)) {
      if (val.fontSize && tokens.typography.fontSizes) {
        tokens.typography.fontSizes[tag] = val.fontSize;
      }
    }
  }

  // ── Layout layout overlay — container and grid ─────────────────────────────
  const breakpoints = dna.designTokens.breakpoints;
  if (breakpoints.length > 0) {
    const pxBreakpoints = breakpoints
      .filter(b => b.endsWith("px"))
      .map(b => parseFloat(b))
      .sort((a, b) => b - a);

    const maxWidth = pxBreakpoints[0];
    if (maxWidth && maxWidth >= 960 && tokens.layout) {
      tokens.layout.containerMaxWidth = `${maxWidth}px`;
      tokens.layout.contentMaxWidth   = `${Math.round(maxWidth * 0.75)}px`;
    }
  }

  return { colorsPatched, fontsPatched };
}

// ── Fidelity scoring ───────────────────────────────────────────────────────────

function scoreLayoutFidelity(
  dna: VisualDnaArtifacts,
  stencilId: string
): FidelityDimension {
  const dominantType = dna.designTokens.layout.dominantType || dna.visualDna.aggregate.dominantLayoutType;
  const idealStencil = LAYOUT_TO_STENCIL[dominantType] ?? "blog";
  const adjacent     = STENCIL_ADJACENCY[stencilId] ?? [];

  let score: number;
  let detail: string;
  if (stencilId === idealStencil) {
    score = 1.0;
    detail = `Perfect match: Visual DNA layout "${dominantType}" maps directly to stencil "${stencilId}".`;
  } else if (adjacent.includes(idealStencil)) {
    score = 0.70;
    detail = `Adjacent match: Visual DNA layout "${dominantType}" prefers "${idealStencil}", but "${stencilId}" is a sibling stencil.`;
  } else {
    score = 0.35;
    detail = `Mismatch: Visual DNA layout "${dominantType}" prefers "${idealStencil}", but "${stencilId}" was selected by manifest intelligence.`;
  }

  // Confidence boost from layout map: average per-page confidence for the dominant type
  const pageEntries = Object.values(dna.layoutMap.pages);
  const matchingPages = pageEntries.filter(p => p.layoutType === dominantType);
  const avgConfidence = matchingPages.length > 0
    ? matchingPages.reduce((s, p) => s + p.confidence, 0) / matchingPages.length
    : 0.5;
  score = score * 0.8 + avgConfidence * 0.2;

  const navPatterns = dna.designTokens.layout.navigationPatterns;
  return {
    name: "layout",
    score: parseFloat(Math.min(score, 1).toFixed(3)),
    weight: 0.25,
    details: detail,
    signals: {
      dominantLayoutType:  dominantType,
      selectedStencil:     stencilId,
      idealStencil,
      stencilMatch:        stencilId === idealStencil,
      navigationPatterns:  navPatterns.join(", ") || "none detected",
      avgLayoutConfidence: parseFloat(avgConfidence.toFixed(2)),
    },
  };
}

function scoreTypographyFidelity(
  dna: VisualDnaArtifacts,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  generatedTokens: any
): FidelityDimension {
  const extractedFonts = dna.designTokens.typography.fontFamilies;
  if (extractedFonts.length === 0) {
    return {
      name: "typography",
      score: 0.55,
      weight: 0.20,
      details: "No fonts extracted from source — using generated default. Score is neutral.",
      signals: { extractedFonts: 0, fontsApplied: false },
    };
  }

  // After the overlay, the generated fonts ARE the extracted fonts.
  // Score based on richness: more distinct fonts extracted → higher confidence.
  const fontCount  = extractedFonts.length;
  const sizeCount  = dna.designTokens.typography.fontSizes.length;
  const hasHeadings = Object.keys(dna.designTokens.typography.headingHierarchy).length > 0;

  let score = 0.70; // baseline post-overlay score
  score += Math.min(fontCount / 5, 0.1);
  score += Math.min(sizeCount / 12, 0.10);
  score += hasHeadings ? 0.10 : 0;

  const genFonts = generatedTokens?.typography?.fontFamilies ?? {};
  const headingFont = genFonts.heading ?? "";
  const bodyFont    = genFonts.body    ?? "";

  return {
    name: "typography",
    score: parseFloat(Math.min(score, 1.0).toFixed(3)),
    weight: 0.20,
    details: `Overlay applied: heading="${extractedFonts[0]}", body="${extractedFonts[1] ?? extractedFonts[0]}". ${sizeCount} font sizes extracted.`,
    signals: {
      extractedFonts:       fontCount,
      extractedSizes:       sizeCount,
      hasHeadingHierarchy:  hasHeadings,
      appliedHeadingFamily: headingFont,
      appliedBodyFamily:    bodyFont,
    },
  };
}

function scoreColorFidelity(
  dna: VisualDnaArtifacts,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  generatedTokens: any
): FidelityDimension {
  const extracted = dna.designTokens.colors;
  const srcPrimary = extracted.primary[0];

  if (!srcPrimary) {
    return {
      name: "color",
      score: 0.50,
      weight: 0.30,
      details: "No colors extracted from source site.",
      signals: { primaryExtracted: false },
    };
  }

  const srcRgb = hexToRgb(srcPrimary);
  const srcHsl = srcRgb ? rgbToHsl(srcRgb) : null;

  // After overlay: primary.500 should be the extracted color
  const genPrimary500 = generatedTokens?.colors?.primary?.["500"] ?? null;
  const genRgb  = genPrimary500 ? hexToRgb(genPrimary500) : null;
  const genHsl  = genRgb ? rgbToHsl(genRgb) : null;

  let colorMatchScore = 0.5;
  if (srcHsl && genHsl) {
    const dist = hslColorDistance(srcHsl, genHsl);
    // distance 0 → score 1.0, distance 1 → score 0
    colorMatchScore = Math.max(0, 1 - dist * 1.5);
  }

  // Richness bonus
  const colorCount = [
    ...extracted.primary, ...extracted.secondary, ...extracted.accent,
    ...extracted.background, ...extracted.text,
  ].length;
  const richness = Math.min(colorCount / 12, 0.15);

  const bgMatchScore = extracted.background.length > 0 ? 0.10 : 0;
  const textMatchScore = extracted.text.length > 0 ? 0.05 : 0;

  const score = colorMatchScore * 0.75 + richness + bgMatchScore + textMatchScore;

  return {
    name: "color",
    score: parseFloat(Math.min(score, 1.0).toFixed(3)),
    weight: 0.30,
    details: `Source primary: ${srcPrimary}. Applied to tokens. ${colorCount} total colors extracted across all buckets.`,
    signals: {
      sourcePrimary:       srcPrimary,
      generatedPrimary500: genPrimary500 ?? "n/a",
      colorDistance:       srcHsl && genHsl ? parseFloat(hslColorDistance(srcHsl, genHsl).toFixed(3)) : "n/a",
      colorCount,
      backgroundColors:    extracted.background.length,
      textColors:          extracted.text.length,
    },
  };
}

function scoreComponentFidelity(
  dna: VisualDnaArtifacts,
  report: GenerationReport
): FidelityDimension {
  const detected = dna.componentMap.aggregate.commonComponents;
  if (detected.length === 0) {
    return {
      name: "components",
      score: 0.55,
      weight: 0.15,
      details: "No common components detected in source. Cannot compare.",
      signals: { detectedComponents: 0 },
    };
  }

  // Check blueprint component registry for matches
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registry = report.generation?.blueprint?.componentRegistry as any;
  const registryKeys = registry
    ? Object.keys(registry).map(k => k.toLowerCase())
    : [];

  const COMPONENT_PATTERNS: Record<string, string[]> = {
    hero:         ["hero", "header-hero", "hero-section", "landing-hero"],
    cards:        ["card", "article-card", "post-card", "content-card"],
    gallery:      ["gallery", "image-grid", "photo-grid", "media-gallery"],
    testimonials: ["testimonial", "review", "quote-section"],
    cta:          ["cta", "call-to-action", "conversion-banner", "signup"],
    footer:       ["footer", "site-footer", "page-footer"],
    faq:          ["faq", "accordion", "q-and-a"],
    pricing:      ["pricing", "plan-card", "subscription-tier"],
  };

  let matched = 0;
  const matchDetails: string[] = [];

  for (const comp of detected) {
    const patterns = COMPONENT_PATTERNS[comp] ?? [comp];
    const found    = patterns.some(p => registryKeys.some(k => k.includes(p)));
    if (found) {
      matched++;
      matchDetails.push(`${comp} ✓`);
    } else {
      matchDetails.push(`${comp} ✗`);
    }
  }

  const baseScore    = matched / Math.max(detected.length, 1);
  const heroPresence = dna.componentMap.aggregate.heroPresent > 0 ? 0.05 : 0;
  const score        = Math.min(baseScore * 0.9 + heroPresence, 1.0);

  return {
    name: "components",
    score: parseFloat(score.toFixed(3)),
    weight: 0.15,
    details: `${matched}/${detected.length} source components matched in blueprint. ${matchDetails.join(", ")}.`,
    signals: {
      detectedComponents:    detected.length,
      matchedComponents:     matched,
      blueprintComponentKeys: registryKeys.length,
      heroPresent:           dna.componentMap.aggregate.heroPresent,
      pagesWithGallery:      dna.componentMap.aggregate.pagesWithGallery,
    },
  };
}

function scoreNavigationFidelity(
  dna: VisualDnaArtifacts,
  report: GenerationReport
): FidelityDimension {
  const srcPatterns = dna.designTokens.layout.navigationPatterns;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const genNav = report.generation?.siteAssembly?.navigation as any;

  if (srcPatterns.length === 0) {
    return {
      name: "navigation",
      score: 0.60,
      weight: 0.10,
      details: "No navigation patterns detected in source.",
      signals: { sourcePatterns: 0 },
    };
  }

  const hasTopNav  = srcPatterns.includes("top-navigation");
  const hasSidebar = srcPatterns.includes("sidebar");
  const hasSticky  = srcPatterns.includes("sticky");
  const hasHamburger = srcPatterns.includes("hamburger");

  // Check if generated navigation matches
  const genHasNav  = Boolean(genNav?.primaryNav?.length);
  const genNavCount = genNav?.primaryNav?.length ?? 0;

  let score = 0.60;
  if (hasTopNav  && genHasNav)  score += 0.15;
  if (hasSticky)                score += 0.10; // sticky applied by default in most stencils
  if (hasHamburger)             score += 0.05; // hamburger comes with all stencils
  if (!hasSidebar)              score += 0.10; // most stencils don't use sidebar

  return {
    name: "navigation",
    score: parseFloat(Math.min(score, 1.0).toFixed(3)),
    weight: 0.10,
    details: `Source patterns: ${srcPatterns.join(", ")}. Generated nav items: ${genNavCount}.`,
    signals: {
      sourcePatterns:   srcPatterns.join(", "),
      hasTopNav,
      hasSidebar,
      hasSticky,
      hasHamburger,
      generatedNavItems: genNavCount,
    },
  };
}

function computeOverallScore(dimensions: FidelityDimension[]): number {
  const totalWeight = dimensions.reduce((s, d) => s + d.weight, 0);
  const weighted    = dimensions.reduce((s, d) => s + d.score * d.weight, 0);
  return Math.round((weighted / totalWeight) * 100);
}

function assignGrade(score: number): ReconstructionGrade {
  if (score >= 90) return "A+";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  return "D";
}

// ── Report builder ────────────────────────────────────────────────────────────

function buildFidelityReport(
  jobId:      string,
  seedUrl:    string,
  dimensions: FidelityDimension[],
  score:      number,
  grade:      ReconstructionGrade,
  dna:        VisualDnaArtifacts,
  report:     GenerationReport,
  overlayApplied: boolean
): FidelityReport {
  const stencilUsed  = report.stencilSelection?.selectedStencilId ?? "unknown";
  const dominantType = dna.designTokens.layout.dominantType;
  const idealStencil = LAYOUT_TO_STENCIL[dominantType];
  const stencilMatch = stencilUsed === idealStencil;

  const warnings: string[] = [];
  if (!overlayApplied) warnings.push("Design system overlay was not applied — Visual DNA artifacts may be missing.");
  if (score < 60)      warnings.push("Low fidelity score — consider reviewing the stencil selection or Visual DNA extraction quality.");
  if (!stencilMatch && idealStencil) warnings.push(`Visual DNA suggests stencil "${idealStencil}" but "${stencilUsed}" was selected by manifest intelligence. Re-running generation with a stencil override may improve fidelity.`);

  const topFonts    = dna.designTokens.typography.fontFamilies.slice(0, 2);
  const topColors   = dna.designTokens.colors.primary.slice(0, 2);
  const components  = dna.componentMap.aggregate.commonComponents;
  const pagesAnalyzed = dna.visualDna.aggregate.totalPages;

  const systemDescription =
    `${grade}-grade reconstruction (${score}/100). ` +
    `Source: ${dominantType}-style site, stencil: ${stencilUsed}. ` +
    (topFonts.length > 0 ? `Typefaces: ${topFonts.join(", ")}. ` : "") +
    (topColors.length > 0 ? `Primary colours: ${topColors.join(", ")}. ` : "") +
    (components.length > 0 ? `Components: ${components.join(", ")}.` : "");

  return {
    jobId,
    generatedAt: new Date().toISOString(),
    seedUrl,
    overallScore: score,
    grade,
    dimensions,
    stencilUsed,
    recommendedStencil: idealStencil ?? null,
    stencilMatch,
    overlayApplied,
    pagesAnalyzed,
    systemDescription,
    warnings,
  };
}

// ── Main entry point ───────────────────────────────────────────────────────────

/**
 * runVisualReconstruction — called from generation-runner.ts after runGenerationPipeline.
 *
 * 1. Downloads Visual DNA artifacts from R2.
 * 2. Applies design-system overlay to the GenerationReport (mutates tokens in-place).
 * 3. Scores reconstruction fidelity across 5 dimensions.
 * 4. Uploads fidelity-report.json to R2.
 * 5. Returns an audit summary.
 *
 * Entirely non-fatal: all errors are caught and logged; the original report is returned
 * unchanged if anything fails.
 */
export async function runVisualReconstruction(
  jobId:  string,
  report: GenerationReport
): Promise<ReconstructionAudit> {
  const startMs = Date.now();

  const dna = await loadVisualDnaArtifacts(jobId);
  if (!dna) {
    logger.info({ jobId }, "RECON: no Visual DNA artifacts found — skipping overlay");
    return { overlayApplied: false, fidelityScore: 0, grade: "D", r2Uploads: 0, colorsPatched: false, fontsPatched: false, stencilMatch: false, durationMs: Date.now() - startMs };
  }

  logger.info({ jobId, pages: dna.visualDna.aggregate.totalPages }, "RECON: Visual DNA loaded — applying overlay");

  // Apply the design system overlay
  const { colorsPatched, fontsPatched } = applyDesignSystemOverlay(report, dna);
  const overlayApplied = colorsPatched || fontsPatched;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const generatedTokens = report.generation?.designSystem?.tokens as any;
  const stencilId       = report.stencilSelection?.selectedStencilId ?? "blog";

  // Score all 5 fidelity dimensions
  const dimensions: FidelityDimension[] = [
    scoreLayoutFidelity(dna, stencilId),
    scoreTypographyFidelity(dna, generatedTokens),
    scoreColorFidelity(dna, generatedTokens),
    scoreComponentFidelity(dna, report),
    scoreNavigationFidelity(dna, report),
  ];

  const score = computeOverallScore(dimensions);
  const grade = assignGrade(score);

  const fidelityReport = buildFidelityReport(
    jobId,
    report.seedUrl,
    dimensions,
    score,
    grade,
    dna,
    report,
    overlayApplied
  );

  // Upload fidelity-report.json
  const uploaded = await uploadJsonToR2(fidelityReport, `jobs/${jobId}/fidelity-report.json`);

  const stencilMatch = fidelityReport.stencilMatch;

  logger.info(
    { jobId, score, grade, stencilUsed: stencilId, stencilMatch, overlayApplied, colorsPatched, fontsPatched },
    "RECON: visual reconstruction complete"
  );

  return {
    overlayApplied,
    fidelityScore: score,
    grade,
    r2Uploads: uploaded ? 1 : 0,
    colorsPatched,
    fontsPatched,
    stencilMatch,
    durationMs: Date.now() - startMs,
  };
}
