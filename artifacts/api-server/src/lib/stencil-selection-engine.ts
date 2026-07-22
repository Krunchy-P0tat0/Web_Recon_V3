/**
 * stencil-selection-engine.ts — Phase 4.4 Stencil Selection Engine
 *
 * Selects the optimal StencilType for a site using three independent scoring
 * dimensions combined into a weighted composite score:
 *
 *   1. Content   (weight 0.40) — SiteGraph content-type frequencies + layouts
 *   2. Design    (weight 0.40) — DesignDNA visual signals
 *   3. Archetype (weight 0.20) — Phase 4.3 DesignProfile winner
 *
 * Supported StencilTypes:
 *   documentation | blog | magazine | luxury | agency | portfolio
 *
 * Pure and synchronous. No I/O.
 */

import type { SiteGraph } from "@workspace/site-intelligence";
import type { DesignDNA, DesignProfile } from "@workspace/design-dna";

// ─── Public types ─────────────────────────────────────────────────────────────

export type StencilType =
  | "documentation"
  | "blog"
  | "magazine"
  | "luxury"
  | "agency"
  | "portfolio";

export const ALL_STENCIL_TYPES: StencilType[] = [
  "documentation",
  "blog",
  "magazine",
  "luxury",
  "agency",
  "portfolio",
];

export interface StencilDimensionScore {
  stencilType: StencilType;
  /** 0–1, normalised against the dimension winner */
  normalisedScore: number;
  /** Human-readable labels of every signal that fired */
  firedSignals: string[];
}

export interface StencilDimension {
  name: "content" | "design" | "archetype";
  weight: number;
  topChoice: StencilType;
  reasoning: string;
  scores: StencilDimensionScore[];
}

export interface StencilTypeScore {
  stencilType: StencilType;
  /** Final weighted composite score 0–1 */
  finalScore: number;
  contentScore: number;
  designScore: number;
  archetypeScore: number;
  rank: number;
}

export interface StencilSelectionResult {
  selectedStencilType: StencilType;
  confidence: number;
  confidenceLabel: "high" | "medium" | "low";
  selectionReason: string;
  dimensions: StencilDimension[];
  scores: StencilTypeScore[];
  generatedAt: string;
  jobId: string;
  url: string;
}

export interface StencilSelectionReport {
  meta: {
    jobId: string;
    url: string;
    phase: "4.4";
    generatedAt: string;
    durationMs: number;
    pageCount: number;
    topContentType: string;
    designArchetype: string | null;
  };
  result: StencilSelectionResult;
}

// ─── Internal signal record ───────────────────────────────────────────────────

interface RawScore {
  type: StencilType;
  raw: number;
  fired: string[];
}

function normalise(raw: RawScore[]): StencilDimensionScore[] {
  const max = Math.max(...raw.map((r) => r.raw), 0.001);
  return raw.map((r) => ({
    stencilType:    r.type,
    normalisedScore: Math.round((r.raw / max) * 1000) / 1000,
    firedSignals:   r.fired,
  }));
}

// ─── Dimension 1: Content ─────────────────────────────────────────────────────
//
// Scores based on ContentType frequencies in SiteGraph.stats.byContentType,
// layout assignments, page count, and category breadth.

function scoreContent(graph: SiteGraph, pageCount: number): StencilDimension {
  const ct = graph.stats.byContentType as Record<string, number>;
  const total = Math.max(graph.contentNodes, 1);

  const docs  = (ct["DOCS"]         ?? 0) + (ct["FAQ"]  ?? 0) + (ct["GUIDE"] ?? 0);
  const art   = (ct["ARTICLE"]      ?? 0) + (ct["BLOG"] ?? 0);
  const land  = ct["LANDING_PAGE"]  ?? 0;
  const port  = ct["PORTFOLIO"]     ?? 0;
  const gal   = ct["GALLERY"]       ?? 0;

  const docsRatio  = docs  / total;
  const artRatio   = art   / total;
  const landRatio  = land  / total;
  const portRatio  = (port + gal) / total;

  // How many distinct content types appear at ≥3% of total
  const distinctTypes = Object.entries(ct).filter(([, c]) => (c as number) / total >= 0.03).length;

  // Layout assignments
  const layouts = graph.layoutAssignments.map((l) => l.layout);
  const hasDocLayout   = layouts.includes("DocumentationLayout");
  const hasPortLayout  = layouts.includes("PortfolioLayout");
  const hasGallery     = layouts.includes("GalleryLayout");
  const hasLanding     = layouts.includes("LandingLayout");

  const categoryCount  = graph.categoryGraph.categories.length;

  const scores: RawScore[] = [
    // documentation
    (() => {
      const fired: string[] = [];
      let r = 0;
      if (docsRatio > 0.4)  { r += 6; fired.push(`DOCS/FAQ/GUIDE ${Math.round(docsRatio * 100)}%`); }
      if (docsRatio > 0.2)  { r += 2; fired.push("docs-heavy content mix"); }
      if (hasDocLayout)     { r += 4; fired.push("DocumentationLayout assignments"); }
      if (pageCount > 20)   { r += 2; fired.push("large page count (docs sites tend to be deep)"); }
      if (categoryCount > 5){ r += 1; fired.push(`${categoryCount} categories`); }
      return { type: "documentation" as StencilType, raw: r, fired };
    })(),

    // blog
    (() => {
      const fired: string[] = [];
      let r = 0;
      if (artRatio > 0.5)   { r += 6; fired.push(`articles ${Math.round(artRatio * 100)}%`); }
      if (artRatio > 0.3)   { r += 2; fired.push("article-majority site"); }
      if (pageCount >= 10 && pageCount <= 200) { r += 2; fired.push(`mid-size archive (${pageCount} pages)`); }
      if (distinctTypes <= 2) { r += 1; fired.push("focused content type diversity"); }
      if (categoryCount >= 3 && categoryCount <= 15) { r += 1; fired.push("blog-sized category tree"); }
      return { type: "blog" as StencilType, raw: r, fired };
    })(),

    // magazine
    (() => {
      const fired: string[] = [];
      let r = 0;
      if (pageCount > 80)     { r += 5; fired.push(`high page count ${pageCount}`); }
      if (pageCount > 40)     { r += 2; fired.push("magazine-scale archive"); }
      if (distinctTypes >= 3) { r += 4; fired.push(`${distinctTypes} distinct content types`); }
      if (artRatio > 0.3 && distinctTypes >= 2) { r += 2; fired.push("article-heavy multi-topic mix"); }
      if (categoryCount > 10) { r += 2; fired.push(`${categoryCount} categories`); }
      if (hasGallery)         { r += 1; fired.push("gallery content present"); }
      return { type: "magazine" as StencilType, raw: r, fired };
    })(),

    // luxury
    (() => {
      const fired: string[] = [];
      let r = 0;
      if (pageCount < 15)   { r += 4; fired.push(`low page count (${pageCount}) — curated`); }
      if (landRatio > 0.3)  { r += 4; fired.push(`landing-page dominated ${Math.round(landRatio * 100)}%`); }
      if (distinctTypes <= 2) { r += 3; fired.push("tight content focus"); }
      if (hasLanding)       { r += 2; fired.push("LandingLayout present"); }
      if (categoryCount <= 3) { r += 1; fired.push("minimal category structure"); }
      return { type: "luxury" as StencilType, raw: r, fired };
    })(),

    // agency
    (() => {
      const fired: string[] = [];
      let r = 0;
      if (landRatio > 0.2)  { r += 4; fired.push(`landing-heavy ${Math.round(landRatio * 100)}%`); }
      if (portRatio > 0.15) { r += 2; fired.push("portfolio/gallery content present"); }
      if (pageCount < 30)   { r += 3; fired.push(`compact site (${pageCount} pages)`); }
      if (hasLanding)       { r += 2; fired.push("LandingLayout assignments"); }
      if (distinctTypes <= 3) { r += 1; fired.push("lean content diversity"); }
      return { type: "agency" as StencilType, raw: r, fired };
    })(),

    // portfolio
    (() => {
      const fired: string[] = [];
      let r = 0;
      if (portRatio > 0.4)  { r += 6; fired.push(`portfolio/gallery ${Math.round(portRatio * 100)}%`); }
      if (portRatio > 0.2)  { r += 2; fired.push("visual-content majority"); }
      if (hasPortLayout)    { r += 4; fired.push("PortfolioLayout assignments"); }
      if (hasGallery)       { r += 3; fired.push("GalleryLayout assignments"); }
      if (pageCount < 50)   { r += 1; fired.push("curated size"); }
      return { type: "portfolio" as StencilType, raw: r, fired };
    })(),
  ];

  const normalised = normalise(scores);
  const winner = normalised.reduce((a, b) => (b.normalisedScore > a.normalisedScore ? b : a));

  const topRaw = scores.find((s) => s.type === winner.stencilType)!;
  const reasoning =
    topRaw.fired.length > 0
      ? `Content dimension selects "${winner.stencilType}": ${topRaw.fired.slice(0, 3).join("; ")}.`
      : `Content dimension defaulted to "${winner.stencilType}" (no strong signals).`;

  return {
    name:      "content",
    weight:    0.4,
    topChoice: winner.stencilType,
    reasoning,
    scores:    normalised,
  };
}

// ─── Dimension 2: Design ──────────────────────────────────────────────────────
//
// Scores based on DesignDNA signals: layout strategy, hero configuration,
// typography, spacing, navigation, cards, gallery.

function scoreDesign(dna: DesignDNA): StencilDimension {
  const { layout, hero, typography, spacing, navigation, cards, gallery } = dna;

  const headingClass = typography.heading.fontClass;
  const bodyClass    = typography.body.fontClass;
  const SERIF_CLASSES = ["elegant-serif", "editorial-serif", "readable-serif"] as const;
  const hasSerif     = (SERIF_CLASSES as readonly string[]).includes(headingClass) ||
                       (SERIF_CLASSES as readonly string[]).includes(bodyClass);
  const hasMono      = bodyClass === "mono" || headingClass === "mono";
  const hasDisplay   = headingClass === "display-script";

  const scores: RawScore[] = [
    // documentation
    (() => {
      const fired: string[] = [];
      let r = 0;
      if (layout.strategy === "documentation")   { r += 6; fired.push("layout.strategy = documentation"); }
      if (layout.strategy === "sidebar_content") { r += 4; fired.push("layout.strategy = sidebar_content"); }
      if (hasMono)                               { r += 3; fired.push("monospace font in type stack"); }
      if (spacing.density === "compact")         { r += 2; fired.push("compact spacing density"); }
      if (typography.scale === "compact")        { r += 2; fired.push("compact type scale"); }
      if (navigation.hasSearch)                  { r += 2; fired.push("search in nav"); }
      if (!navigation.hasCta)                    { r += 1; fired.push("no nav CTA (docs pattern)"); }
      if (hero.layout === "text-centered" || hero.layout === "text-left") {
        r += 1; fired.push("minimal hero layout");
      }
      return { type: "documentation" as StencilType, raw: r, fired };
    })(),

    // blog
    (() => {
      const fired: string[] = [];
      let r = 0;
      if (layout.strategy === "editorial_flow")  { r += 6; fired.push("layout.strategy = editorial_flow"); }
      if (typography.scale === "generous" || typography.scale === "editorial") {
        r += 3; fired.push(`generous/editorial type scale`);
      }
      if (cards.layout === "vertical")           { r += 2; fired.push("vertical card layout"); }
      if (spacing.density === "comfortable")     { r += 2; fired.push("comfortable spacing"); }
      if (layout.sectionSpacing !== "tight")     { r += 1; fired.push("readable section spacing"); }
      if (!hasDisplay && !hasSerif)              { r += 1; fired.push("neutral typeface (blog-friendly)"); }
      if (hero.layout === "text-centered" || hero.layout === "text-left") {
        r += 1; fired.push("editorial hero layout");
      }
      return { type: "blog" as StencilType, raw: r, fired };
    })(),

    // magazine
    (() => {
      const fired: string[] = [];
      let r = 0;
      if (layout.strategy === "magazine")        { r += 6; fired.push("layout.strategy = magazine"); }
      if (layout.strategy === "card_grid")       { r += 4; fired.push("layout.strategy = card_grid"); }
      if (typography.scale === "editorial")      { r += 2; fired.push("editorial type scale"); }
      if (cards.layout === "overlay")            { r += 2; fired.push("overlay card layout"); }
      if (gallery.layout === "masonry" || gallery.layout === "grid") {
        r += 1; fired.push(`gallery layout = ${gallery.layout}`);
      }
      if (hero.layout === "split-content-image" || hero.layout === "carousel") {
        r += 2; fired.push("magazine hero layout");
      }
      if (hasDisplay)                            { r += 1; fired.push("display typeface"); }
      return { type: "magazine" as StencilType, raw: r, fired };
    })(),

    // luxury
    (() => {
      const fired: string[] = [];
      let r = 0;
      if (hasSerif)                              { r += 4; fired.push("serif typeface"); }
      if (spacing.density === "spacious")        { r += 3; fired.push("spacious density"); }
      if (spacing.density === "comfortable")     { r += 1; fired.push("comfortable density"); }
      if (layout.heroHeight === "full-viewport") { r += 3; fired.push("full-viewport hero height"); }
      if (layout.sectionSpacing === "loose")     { r += 2; fired.push("loose section spacing"); }
      if (navigation.isTransparentOnHero)        { r += 2; fired.push("transparent-on-hero nav"); }
      if (navigation.background === "transparent") { r += 2; fired.push("transparent nav background"); }
      if (hero.layout === "full-bleed-image" || hero.layout === "split-content-image") {
        r += 2; fired.push("cinematic hero layout");
      }
      if (layout.strategy === "full_bleed")      { r += 2; fired.push("full-bleed layout strategy"); }
      return { type: "luxury" as StencilType, raw: r, fired };
    })(),

    // agency
    (() => {
      const fired: string[] = [];
      let r = 0;
      if (layout.heroHeight === "full-viewport" || layout.heroHeight === "three-quarter") {
        r += 4; fired.push(`${layout.heroHeight} hero`);
      }
      if (hero.layout === "full-bleed-image" || hero.layout === "video-background") {
        r += 3; fired.push(`dramatic hero (${hero.layout})`);
      }
      if (navigation.isTransparentOnHero)        { r += 2; fired.push("transparent-on-hero nav"); }
      if (navigation.hasCta)                     { r += 2; fired.push("nav has CTA"); }
      if (hero.ctaStyle === "filled")            { r += 2; fired.push("filled CTA style"); }
      if (layout.strategy === "full_bleed")      { r += 2; fired.push("full-bleed layout"); }
      if (hasDisplay)                            { r += 1; fired.push("display typeface"); }
      if (cards.hoverEffect !== "none")          { r += 1; fired.push(`card hover: ${cards.hoverEffect}`); }
      return { type: "agency" as StencilType, raw: r, fired };
    })(),

    // portfolio
    (() => {
      const fired: string[] = [];
      let r = 0;
      if (layout.strategy === "portfolio_showcase") { r += 6; fired.push("layout.strategy = portfolio_showcase"); }
      if (layout.strategy === "masonry")            { r += 4; fired.push("layout.strategy = masonry"); }
      if (gallery.layout === "masonry" || gallery.layout === "mosaic") {
        r += 3; fired.push(`gallery layout = ${gallery.layout}`);
      }
      if (gallery.layout === "grid")              { r += 2; fired.push("grid gallery layout"); }
      if (cards.imagePosition === "background")   { r += 2; fired.push("background image cards"); }
      if (cards.hoverEffect === "scale" || cards.hoverEffect === "lift") {
        r += 2; fired.push(`hover effect: ${cards.hoverEffect}`);
      }
      if (hero.layout === "full-bleed-image")     { r += 1; fired.push("full-bleed hero"); }
      if (gallery.hasLightbox)                    { r += 1; fired.push("lightbox gallery"); }
      return { type: "portfolio" as StencilType, raw: r, fired };
    })(),
  ];

  const normalised = normalise(scores);
  const winner = normalised.reduce((a, b) => (b.normalisedScore > a.normalisedScore ? b : a));
  const topRaw = scores.find((s) => s.type === winner.stencilType)!;

  return {
    name:      "design",
    weight:    0.4,
    topChoice: winner.stencilType,
    reasoning: topRaw.fired.length > 0
      ? `Design signals select "${winner.stencilType}": ${topRaw.fired.slice(0, 3).join("; ")}.`
      : `Design signals weakly favour "${winner.stencilType}" (low signal coverage).`,
    scores: normalised,
  };
}

// ─── Dimension 3: Archetype ───────────────────────────────────────────────────
//
// Maps the Phase 4.3 DesignArchetype to StencilType weights.

const ARCHETYPE_WEIGHTS: Record<string, Partial<Record<StencilType, number>>> = {
  documentation: { documentation: 1.0, blog: 0.10 },
  blog:          { blog: 1.0, magazine: 0.30 },
  magazine:      { magazine: 1.0, blog: 0.35 },
  luxury:        { luxury: 1.0, agency: 0.15, portfolio: 0.20 },
  agency:        { agency: 1.0, luxury: 0.10, portfolio: 0.20 },
  portfolio:     { portfolio: 1.0, agency: 0.20 },
  ecommerce:     { agency: 0.45, magazine: 0.35, portfolio: 0.25, luxury: 0.20 },
};

function scoreArchetype(profile: DesignProfile | null): StencilDimension {
  if (!profile) {
    return {
      name:      "archetype",
      weight:    0.2,
      topChoice: "blog",
      reasoning: "No Phase 4.3 classification available — archetype dimension has no weight.",
      scores:    ALL_STENCIL_TYPES.map((t) => ({ stencilType: t, normalisedScore: 0, firedSignals: [] })),
    };
  }

  const weights = ARCHETYPE_WEIGHTS[profile.archetype] ?? { blog: 1.0 };

  const raw: RawScore[] = ALL_STENCIL_TYPES.map((t) => {
    const w = weights[t] ?? 0;
    return {
      type: t,
      raw:  w,
      fired: w > 0 ? [`archetype "${profile.archetype}" → ${t} (weight ${w})`] : [],
    };
  });

  const normalised = normalise(raw);
  const winner = normalised.reduce((a, b) => (b.normalisedScore > a.normalisedScore ? b : a));

  return {
    name:      "archetype",
    weight:    0.2,
    topChoice: winner.stencilType,
    reasoning: `Phase 4.3 archetype "${profile.archetype}" (${profile.confidenceLabel} confidence) maps to "${winner.stencilType}".`,
    scores:    normalised,
  };
}

// ─── Composite scorer ─────────────────────────────────────────────────────────

function compositeScores(
  content:   StencilDimension,
  design:    StencilDimension,
  archetype: StencilDimension,
): StencilTypeScore[] {
  return ALL_STENCIL_TYPES
    .map((t): StencilTypeScore => {
      const cs = content.scores.find((s)   => s.stencilType === t)?.normalisedScore ?? 0;
      const ds = design.scores.find((s)    => s.stencilType === t)?.normalisedScore ?? 0;
      const as_ = archetype.scores.find((s) => s.stencilType === t)?.normalisedScore ?? 0;
      const final = content.weight * cs + design.weight * ds + archetype.weight * as_;
      return {
        stencilType:    t,
        finalScore:     Math.round(final * 1000) / 1000,
        contentScore:   Math.round(cs * 1000) / 1000,
        designScore:    Math.round(ds * 1000) / 1000,
        archetypeScore: Math.round(as_ * 1000) / 1000,
        rank:           0,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore)
    .map((s, i) => ({ ...s, rank: i + 1 }));
}

// ─── Confidence ───────────────────────────────────────────────────────────────

function confidenceLabel(score: number, gap: number): "high" | "medium" | "low" {
  if (score >= 0.7 && gap >= 0.2) return "high";
  if (score >= 0.4 && gap >= 0.1) return "medium";
  return "low";
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Select the optimal stencil type for a site.
 *
 * @param siteGraph  - Phase 3 SiteGraph from @workspace/site-intelligence
 * @param dna        - Phase 4.2 DesignDNA from @workspace/design-dna
 * @param profile    - Phase 4.3 DesignProfile (optional — non-fatal if null)
 * @param meta       - { url, jobId, pageCount }
 */
export function selectStencilType(
  siteGraph: SiteGraph,
  dna:       DesignDNA,
  profile:   DesignProfile | null,
  meta:      { url: string; jobId: string; pageCount: number },
): StencilSelectionResult {
  const contentDim   = scoreContent(siteGraph, meta.pageCount);
  const designDim    = scoreDesign(dna);
  const archetypeDim = scoreArchetype(profile);

  const ranked = compositeScores(contentDim, designDim, archetypeDim);
  const winner = ranked[0]!;
  const runnerUp = ranked[1]!;

  const gap = winner.finalScore - runnerUp.finalScore;
  const label = confidenceLabel(winner.finalScore, gap);

  // Build human-readable reason from the dimension(s) that agreed
  const agreeingDimensions = [contentDim, designDim, archetypeDim]
    .filter((d) => d.topChoice === winner.stencilType)
    .map((d) => d.name);

  const selectionReason =
    agreeingDimensions.length >= 2
      ? `"${winner.stencilType}" selected by ${agreeingDimensions.join(" + ")} dimensions ` +
        `(score ${winner.finalScore.toFixed(3)}, gap +${gap.toFixed(3)} over "${runnerUp.stencilType}"). ` +
        `${contentDim.reasoning}`
      : `"${winner.stencilType}" selected with composite score ${winner.finalScore.toFixed(3)} ` +
        `(gap ${gap.toFixed(3)}). ` +
        `Content: "${contentDim.topChoice}", Design: "${designDim.topChoice}", Archetype: "${archetypeDim.topChoice}". ` +
        `${contentDim.reasoning}`;

  return {
    selectedStencilType: winner.stencilType,
    confidence:          winner.finalScore,
    confidenceLabel:     label,
    selectionReason,
    dimensions:          [contentDim, designDim, archetypeDim],
    scores:              ranked,
    generatedAt:         new Date().toISOString(),
    jobId:               meta.jobId,
    url:                 meta.url,
  };
}

/**
 * Generate the full stencil-selection-report.json output.
 */
export function generateSelectionReport(
  siteGraph: SiteGraph,
  dna:       DesignDNA,
  profile:   DesignProfile | null,
  meta:      { url: string; jobId: string; pageCount: number; durationMs: number },
): StencilSelectionReport {
  const result = selectStencilType(siteGraph, dna, profile, meta);

  const topCt = Object.entries(siteGraph.stats.byContentType as Record<string, number>)
    .sort(([, a], [, b]) => (b as number) - (a as number))[0]?.[0] ?? "unknown";

  return {
    meta: {
      jobId:           meta.jobId,
      url:             meta.url,
      phase:           "4.4",
      generatedAt:     result.generatedAt,
      durationMs:      meta.durationMs,
      pageCount:       meta.pageCount,
      topContentType:  topCt,
      designArchetype: profile?.archetype ?? null,
    },
    result,
  };
}
