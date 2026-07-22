/**
 * classifier.ts — Design Classification Engine (Phase 4.3)
 *
 * Classifies a DesignDNA into one of seven design archetypes:
 *   Documentation · Blog · Magazine · Luxury · Agency · Portfolio · Ecommerce
 *
 * Design rules:
 *   - Pure and synchronous — no I/O, no external calls
 *   - Deterministic — same DesignDNA always produces the same DesignProfile
 *   - Signal-based scoring — each archetype accumulates weight from DNA fields
 *   - Confidence is normalised 0–1 against the winner's raw score
 *
 * Pipeline:
 *   DesignDNA
 *     → scoreArchetype() × 7 (independent, parallel in logic)
 *       → rank + normalise
 *         → DesignProfile
 */

import type { DesignDNA } from "./types";
import type {
  DesignArchetype,
  ArchetypeScore,
  DesignProfile,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Classification report shape (the .json output)
// ─────────────────────────────────────────────────────────────────────────────

export interface ClassificationReport {
  meta: {
    url: string;
    jobId: string;
    generatedAt: string;
    phase: "4.3";
  };
  profile: DesignProfile;
  /** Brief rationale for each archetype — useful for UIs and debugging. */
  archetypeRationale: Record<DesignArchetype, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal signal type
// ─────────────────────────────────────────────────────────────────────────────

interface Signal {
  label: string;
  weight: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-archetype scorers
// ─────────────────────────────────────────────────────────────────────────────

function scoreDocumentation(dna: DesignDNA): Signal[] {
  const s: Signal[] = [];
  const { typography, spacing, layout, navigation, hero, cards } = dna;

  if (layout.strategy === "documentation")
    s.push({ label: "documentation layout strategy", weight: 40 });
  if (typography.body.fontClass === "mono")
    s.push({ label: "monospace body font", weight: 15 });
  if (typography.mono.family !== "monospace" && typography.mono.family !== "")
    s.push({ label: "explicit mono font family", weight: 8 });
  if (spacing.density === "compact")
    s.push({ label: "compact spacing density", weight: 10 });
  if (layout.dividerStyle === "line")
    s.push({ label: "line section dividers", weight: 8 });
  if (navigation.position === "static")
    s.push({ label: "static navigation", weight: 8 });
  if (!cards.showDate && !cards.showReadTime)
    s.push({ label: "cards omit date and read-time", weight: 6 });
  if (hero.layout === "text-left" || hero.layout === "text-centered")
    s.push({ label: "text-only hero (no background media)", weight: 5 });
  if (!hero.hasBackgroundMedia)
    s.push({ label: "no hero background media", weight: 8 });
  if (layout.sidebarWidth && parseInt(layout.sidebarWidth) > 0)
    s.push({ label: "sidebar layout present", weight: 10 });
  if (navigation.background === "solid")
    s.push({ label: "solid navigation background", weight: 5 });

  return s;
}

function scoreBlog(dna: DesignDNA): Signal[] {
  const s: Signal[] = [];
  const { typography, layout, cards } = dna;

  if (layout.strategy === "editorial_flow")
    s.push({ label: "editorial flow layout", weight: 25 });
  if (cards.showDate)
    s.push({ label: "cards show publication date", weight: 18 });
  if (cards.showReadTime)
    s.push({ label: "cards show read time", weight: 18 });
  if (cards.showAuthor)
    s.push({ label: "cards show author", weight: 14 });
  if (typography.body.fontClass.includes("serif"))
    s.push({ label: "serif body font (editorial signal)", weight: 12 });
  if (typography.heading.fontClass.includes("serif"))
    s.push({ label: "serif heading font", weight: 8 });
  if (cards.layout === "vertical")
    s.push({ label: "vertical card layout", weight: 8 });
  if (cards.imageAspectRatio === "16:9" || cards.imageAspectRatio === "4:3")
    s.push({ label: "widescreen card image ratio", weight: 6 });
  if (cards.hoverEffect === "none")
    s.push({ label: "no hover effect on cards (editorial calm)", weight: 5 });

  return s;
}

function scoreMagazine(dna: DesignDNA): Signal[] {
  const s: Signal[] = [];
  const { layout, navigation, cards, spacing } = dna;

  if (layout.strategy === "magazine")
    s.push({ label: "magazine layout strategy", weight: 40 });
  if (cards.showCategory)
    s.push({ label: "cards show category labels", weight: 14 });
  if (navigation.hasSearch)
    s.push({ label: "navigation has search", weight: 12 });
  if (cards.showDate && cards.showCategory)
    s.push({ label: "cards show both date and category", weight: 10 });
  if (spacing.density === "compact" || spacing.density === "default")
    s.push({ label: "dense/default spacing (content-heavy)", weight: 8 });
  if (cards.imageAspectRatio === "mixed")
    s.push({ label: "mixed card aspect ratios (magazine variety)", weight: 10 });
  if (layout.grid.columns === 12)
    s.push({ label: "12-column grid system", weight: 6 });
  if (cards.hoverEffect !== "none")
    s.push({ label: "interactive card hover effects", weight: 5 });

  return s;
}

function scoreLuxury(dna: DesignDNA): Signal[] {
  const s: Signal[] = [];
  const { typography, spacing, hero, gallery, cards, borders, navigation } = dna;

  if (
    typography.heading.fontClass === "elegant-serif" ||
    typography.heading.fontClass === "editorial-serif"
  )
    s.push({ label: "elegant/editorial serif heading font", weight: 28 });
  if (typography.scale === "editorial")
    s.push({ label: "editorial type scale", weight: 12 });
  if (spacing.density === "spacious" || spacing.density === "comfortable")
    s.push({ label: "spacious/comfortable spacing density", weight: 18 });
  if (hero.layout === "full-bleed-image")
    s.push({ label: "full-bleed hero image", weight: 14 });
  if (navigation.isTransparentOnHero)
    s.push({ label: "transparent navigation on hero", weight: 10 });
  if (gallery.layout === "masonry" || gallery.layout === "mosaic")
    s.push({ label: "masonry/mosaic gallery layout", weight: 10 });
  if (!cards.showDate && !cards.showReadTime && !cards.showAuthor)
    s.push({ label: "cards show no metadata (clean luxury style)", weight: 10 });
  if (borders.cardShadow === "none" || borders.cardShadow === "subtle")
    s.push({ label: "minimal/no card shadow", weight: 6 });
  if (!cards.hasOverlay)
    s.push({ label: "no card overlay (clean presentation)", weight: 5 });

  return s;
}

function scoreAgency(dna: DesignDNA): Signal[] {
  const s: Signal[] = [];
  const { typography, layout, hero, navigation, spacing, cards, borders } = dna;

  if (layout.strategy === "portfolio_showcase")
    s.push({ label: "portfolio/showcase layout strategy", weight: 20 });
  if (navigation.hasCta)
    s.push({ label: "navigation has CTA button", weight: 22 });
  if (
    typography.heading.fontClass === "geometric-sans" ||
    typography.heading.fontClass === "condensed-sans"
  )
    s.push({ label: "geometric/condensed sans heading font", weight: 16 });
  if (
    hero.layout === "full-bleed-image" ||
    hero.layout === "split-content-image"
  )
    s.push({ label: "bold full-bleed or split hero", weight: 14 });
  if (hero.ctaStyle === "filled")
    s.push({ label: "filled CTA button style", weight: 10 });
  if (spacing.density === "comfortable" || spacing.density === "spacious")
    s.push({ label: "open spacing (premium agency feel)", weight: 8 });
  if (borders.cardShadow === "medium" || borders.cardShadow === "strong")
    s.push({ label: "prominent card shadows", weight: 7 });
  if (cards.layout === "horizontal")
    s.push({ label: "horizontal card layout (case study style)", weight: 8 });

  return s;
}

function scorePortfolio(dna: DesignDNA): Signal[] {
  const s: Signal[] = [];
  const { layout, gallery, hero, cards, navigation } = dna;

  if (layout.strategy === "portfolio_showcase")
    s.push({ label: "portfolio showcase layout strategy", weight: 22 });
  if (
    gallery.layout === "masonry" ||
    gallery.layout === "mosaic" ||
    gallery.layout === "grid"
  )
    s.push({ label: "masonry/mosaic/grid gallery layout", weight: 24 });
  if (gallery.hasLightbox)
    s.push({ label: "gallery has lightbox", weight: 20 });
  if (hero.layout === "full-bleed-image")
    s.push({ label: "full-bleed hero image", weight: 14 });
  if (cards.layout === "overlay")
    s.push({ label: "overlay card layout (work thumbnails)", weight: 14 });
  if (navigation.isTransparentOnHero)
    s.push({ label: "transparent navigation on hero", weight: 10 });
  if (!cards.showDate && !cards.showReadTime)
    s.push({ label: "cards omit editorial metadata", weight: 6 });
  if (gallery.animationStyle !== "none")
    s.push({ label: "animated gallery transitions", weight: 5 });

  return s;
}

function scoreEcommerce(dna: DesignDNA): Signal[] {
  const s: Signal[] = [];
  const { layout, cards, navigation, borders, gallery } = dna;

  if (layout.strategy === "card_grid")
    s.push({ label: "card grid layout strategy (product grid)", weight: 30 });
  if (cards.hoverEffect === "lift" || cards.hoverEffect === "scale")
    s.push({ label: "lift/scale hover effect on cards", weight: 22 });
  if (navigation.hasSearch)
    s.push({ label: "navigation has search (product search)", weight: 16 });
  if (cards.showCategory)
    s.push({ label: "cards show category (product category)", weight: 14 });
  if (cards.imagePosition === "top")
    s.push({ label: "top image position on cards (product card pattern)", weight: 10 });
  if (borders.cardShadow === "medium" || borders.cardShadow === "strong")
    s.push({ label: "prominent card shadows (product card depth)", weight: 8 });
  if (cards.imageAspectRatio === "1:1" || cards.imageAspectRatio === "4:3")
    s.push({ label: "square/standard product image ratio", weight: 8 });
  if (gallery.layout === "grid" || gallery.layout === "filmstrip")
    s.push({ label: "grid/filmstrip gallery (product images)", weight: 7 });

  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring dispatch table
// ─────────────────────────────────────────────────────────────────────────────

const SCORERS: Record<DesignArchetype, (dna: DesignDNA) => Signal[]> = {
  documentation: scoreDocumentation,
  blog:          scoreBlog,
  magazine:      scoreMagazine,
  luxury:        scoreLuxury,
  agency:        scoreAgency,
  portfolio:     scorePortfolio,
  ecommerce:     scoreEcommerce,
};

// ─────────────────────────────────────────────────────────────────────────────
// Reasoning templates
// ─────────────────────────────────────────────────────────────────────────────

function buildReasoning(archetype: DesignArchetype, signals: Signal[], score: number): string {
  const top = signals
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((s) => s.label);

  const templates: Record<DesignArchetype, (top: string[], score: number) => string> = {
    documentation: (t) =>
      `Classified as Documentation based on ${t.join(", ")}. The layout and typography patterns are characteristic of developer-facing reference sites.`,
    blog: (t) =>
      `Classified as Blog based on ${t.join(", ")}. The editorial card metadata and flow suggest a content publication focused on articles and posts.`,
    magazine: (t) =>
      `Classified as Magazine based on ${t.join(", ")}. High content density, mixed layouts, and category labelling indicate a multi-section publication.`,
    luxury: (t) =>
      `Classified as Luxury based on ${t.join(", ")}. Generous whitespace, refined typography, and minimal metadata point to a premium/luxury brand presence.`,
    agency: (t) =>
      `Classified as Agency based on ${t.join(", ")}. Strong CTA placement, bold hero, and showcase layout are hallmarks of a creative agency or services site.`,
    portfolio: (t) =>
      `Classified as Portfolio based on ${t.join(", ")}. Gallery-centric layout with lightbox and overlay cards are the defining signals of a creative portfolio.`,
    ecommerce: (t) =>
      `Classified as Ecommerce based on ${t.join(", ")}. Product grid layout, hover effects, search, and category labelling are the canonical e-commerce signals.`,
  };

  return templates[archetype](top, score);
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation & confidence label
// ─────────────────────────────────────────────────────────────────────────────

function normalise(scores: { archetype: DesignArchetype; score: number; signals: Signal[] }[]): ArchetypeScore[] {
  const max = Math.max(...scores.map((s) => s.score), 1);
  return scores.map(({ archetype, score, signals }) => {
    const confidence = Math.round((score / max) * 100) / 100;
    return {
      archetype,
      score,
      confidence,
      signals: signals.map((s) => s.label),
      reasoning: buildReasoning(archetype, signals, score),
    };
  });
}

function confidenceLabel(confidence: number): "high" | "medium" | "low" {
  return confidence >= 0.72 ? "high" : confidence >= 0.45 ? "medium" : "low";
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify a DesignDNA into a design archetype.
 *
 * @param dna    - Fully extracted DesignDNA (from extractDesignDNA or generateAuditReport)
 * @param meta   - Optional URL and jobId to embed in the profile
 * @returns      DesignProfile — archetype, confidence, reasoning, and full ranked scores
 */
export function classifyDesign(
  dna: DesignDNA,
  meta: { url?: string; jobId?: string } = {},
): DesignProfile {
  const url   = meta.url   ?? dna.meta?.url   ?? "";
  const jobId = meta.jobId ?? dna.meta?.jobId ?? "";

  // Score all archetypes
  const raw = (Object.entries(SCORERS) as [DesignArchetype, (d: DesignDNA) => Signal[]][]).map(
    ([archetype, scorer]) => {
      const signals = scorer(dna);
      const score   = signals.reduce((acc, s) => acc + s.weight, 0);
      return { archetype, score, signals };
    },
  );

  // Normalise + sort best-first
  const ranked = normalise(raw).sort((a, b) => b.score - a.score);
  const winner = ranked[0];

  return {
    archetype:       winner.archetype,
    confidence:      winner.confidence,
    confidenceLabel: confidenceLabel(winner.confidence),
    reasoning:       winner.reasoning,
    signals:         winner.signals,
    scores:          ranked,
    generatedAt:     new Date().toISOString(),
    url,
    jobId,
  };
}

/**
 * Classify a DesignDNA and produce a full design-classification-report.json.
 *
 * @param dna  - Fully extracted DesignDNA
 * @param meta - Optional URL and jobId
 * @returns    ClassificationReport — suitable for writing to disk or returning via API
 */
export function generateClassificationReport(
  dna: DesignDNA,
  meta: { url?: string; jobId?: string } = {},
): ClassificationReport {
  const profile = classifyDesign(dna, meta);

  const archetypeRationale: Record<DesignArchetype, string> = {
    documentation: profile.scores.find((s) => s.archetype === "documentation")?.reasoning ?? "",
    blog:          profile.scores.find((s) => s.archetype === "blog")?.reasoning          ?? "",
    magazine:      profile.scores.find((s) => s.archetype === "magazine")?.reasoning      ?? "",
    luxury:        profile.scores.find((s) => s.archetype === "luxury")?.reasoning        ?? "",
    agency:        profile.scores.find((s) => s.archetype === "agency")?.reasoning        ?? "",
    portfolio:     profile.scores.find((s) => s.archetype === "portfolio")?.reasoning     ?? "",
    ecommerce:     profile.scores.find((s) => s.archetype === "ecommerce")?.reasoning     ?? "",
  };

  return {
    meta: {
      url:         profile.url,
      jobId:       profile.jobId,
      generatedAt: profile.generatedAt,
      phase:       "4.3",
    },
    profile,
    archetypeRationale,
  };
}
