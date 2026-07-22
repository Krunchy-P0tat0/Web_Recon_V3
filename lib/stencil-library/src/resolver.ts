/**
 * resolver.ts — Phase 4.5 Stencil Resolver
 *
 * Multi-signal scoring engine that recommends the best StencilBlueprint
 * given a set of visual and structural signals extracted from a crawled site.
 *
 * Scoring dimensions (total weight: 1.0):
 *   - Layout type match    (0.35) — Visual DNA dominant layout vs stencil id
 *   - Content type match   (0.30) — Detected content types vs supportedContent
 *   - Navigation signals   (0.15) — Detected nav patterns vs stencil nav spec
 *   - Component signals    (0.10) — Detected components vs requiredComponents
 *   - Page count fit       (0.10) — Page count vs stencil estimatedPageCount range
 *
 * Pure and synchronous.
 */

import type {
  StencilLibraryId,
  StencilBlueprint,
  ResolverSignals,
  ResolverScore,
  ResolverResult,
  ContentType,
} from "./types.js";

import { getAllBlueprints, getBlueprint } from "./registry.js";

// ── Layout type → stencil affinity map ───────────────────────────────────────

const LAYOUT_AFFINITY: Record<string, Record<StencilLibraryId, number>> = {
  editorial:     { blog: 1.0, magazine: 0.7, documentation: 0.2, luxury: 0.1, agency: 0.3, portfolio: 0.2 },
  magazine:      { blog: 0.6, magazine: 1.0, documentation: 0.1, luxury: 0.2, agency: 0.2, portfolio: 0.2 },
  agency:        { blog: 0.1, magazine: 0.1, documentation: 0.1, luxury: 0.4, agency: 1.0, portfolio: 0.5 },
  luxury:        { blog: 0.0, magazine: 0.2, documentation: 0.0, luxury: 1.0, agency: 0.4, portfolio: 0.3 },
  ecommerce:     { blog: 0.1, magazine: 0.2, documentation: 0.1, luxury: 0.6, agency: 0.3, portfolio: 0.2 },
  documentation: { blog: 0.2, magazine: 0.0, documentation: 1.0, luxury: 0.0, agency: 0.1, portfolio: 0.1 },
  portfolio:     { blog: 0.2, magazine: 0.1, documentation: 0.1, luxury: 0.3, agency: 0.5, portfolio: 1.0 },
  minimal:       { blog: 0.4, magazine: 0.2, documentation: 0.5, luxury: 0.3, agency: 0.3, portfolio: 0.7 },
  blog:          { blog: 1.0, magazine: 0.6, documentation: 0.2, luxury: 0.1, agency: 0.2, portfolio: 0.3 },
};

// ── Content type → stencil affinity map ──────────────────────────────────────

const CONTENT_AFFINITY: Record<string, Record<StencilLibraryId, number>> = {
  ARTICLE:      { blog: 1.0, magazine: 0.9, documentation: 0.4, luxury: 0.2, agency: 0.3, portfolio: 0.2 },
  BLOG:         { blog: 1.0, magazine: 0.8, documentation: 0.3, luxury: 0.1, agency: 0.2, portfolio: 0.2 },
  GUIDE:        { blog: 0.6, magazine: 0.4, documentation: 1.0, luxury: 0.1, agency: 0.3, portfolio: 0.2 },
  DOCS:         { blog: 0.1, magazine: 0.0, documentation: 1.0, luxury: 0.0, agency: 0.1, portfolio: 0.1 },
  FAQ:          { blog: 0.3, magazine: 0.2, documentation: 0.8, luxury: 0.2, agency: 0.5, portfolio: 0.3 },
  GALLERY:      { blog: 0.2, magazine: 0.6, documentation: 0.0, luxury: 0.9, agency: 0.5, portfolio: 0.8 },
  PORTFOLIO:    { blog: 0.1, magazine: 0.1, documentation: 0.0, luxury: 0.5, agency: 0.9, portfolio: 1.0 },
  LANDING_PAGE: { blog: 0.2, magazine: 0.3, documentation: 0.3, luxury: 0.8, agency: 1.0, portfolio: 0.7 },
};

// ── Navigation signal → stencil affinity ─────────────────────────────────────

const NAV_AFFINITY: Record<string, Record<StencilLibraryId, number>> = {
  sidebar:        { blog: 0.2, magazine: 0.1, documentation: 1.0, luxury: 0.0, agency: 0.1, portfolio: 0.1 },
  "sticky":       { blog: 0.6, magazine: 0.7, documentation: 0.4, luxury: 0.5, agency: 0.7, portfolio: 0.6 },
  "top-navigation": { blog: 0.7, magazine: 0.8, documentation: 0.7, luxury: 0.6, agency: 0.8, portfolio: 0.6 },
  hamburger:      { blog: 0.5, magazine: 0.5, documentation: 0.5, luxury: 0.5, agency: 0.5, portfolio: 0.5 },
  "mega-menu":    { blog: 0.2, magazine: 1.0, documentation: 0.1, luxury: 0.1, agency: 0.2, portfolio: 0.1 },
  transparent:    { blog: 0.2, magazine: 0.5, documentation: 0.0, luxury: 1.0, agency: 0.7, portfolio: 0.2 },
  centered:       { blog: 0.3, magazine: 0.7, documentation: 0.1, luxury: 1.0, agency: 0.2, portfolio: 0.5 },
};

// ── Component signal → stencil affinity ──────────────────────────────────────

const COMPONENT_AFFINITY: Record<string, Record<StencilLibraryId, number>> = {
  hero:         { blog: 0.5, magazine: 0.8, documentation: 0.2, luxury: 1.0, agency: 1.0, portfolio: 0.8 },
  cards:        { blog: 0.8, magazine: 1.0, documentation: 0.3, luxury: 0.4, agency: 0.5, portfolio: 0.5 },
  gallery:      { blog: 0.2, magazine: 0.6, documentation: 0.0, luxury: 1.0, agency: 0.5, portfolio: 0.9 },
  testimonials: { blog: 0.3, magazine: 0.3, documentation: 0.2, luxury: 0.5, agency: 1.0, portfolio: 0.5 },
  portfolio:    { blog: 0.1, magazine: 0.1, documentation: 0.0, luxury: 0.5, agency: 0.9, portfolio: 1.0 },
  cta:          { blog: 0.4, magazine: 0.5, documentation: 0.6, luxury: 0.3, agency: 0.9, portfolio: 0.7 },
  footer:       { blog: 0.6, magazine: 0.7, documentation: 0.5, luxury: 0.4, agency: 0.6, portfolio: 0.5 },
  faq:          { blog: 0.3, magazine: 0.2, documentation: 0.9, luxury: 0.2, agency: 0.6, portfolio: 0.3 },
  pricing:      { blog: 0.1, magazine: 0.1, documentation: 0.5, luxury: 0.1, agency: 0.6, portfolio: 0.2 },
};

// ── Scorer helpers ────────────────────────────────────────────────────────────

function scoreLayoutSignal(
  dominantLayoutType: string | undefined,
  bp: StencilBlueprint
): number {
  if (!dominantLayoutType) return 0.5;
  const affinity = LAYOUT_AFFINITY[dominantLayoutType.toLowerCase()];
  return affinity?.[bp.id] ?? 0.3;
}

function scoreContentSignal(
  contentTypes: ContentType[] | undefined,
  bp: StencilBlueprint
): number {
  if (!contentTypes || contentTypes.length === 0) return 0.5;
  const scores = contentTypes.map((ct) => {
    const affinity = CONTENT_AFFINITY[ct];
    return affinity?.[bp.id] ?? 0.2;
  });
  return scores.reduce((s, v) => s + v, 0) / scores.length;
}

function scoreNavigationSignal(
  patterns: string[] | undefined,
  bp: StencilBlueprint
): number {
  if (!patterns || patterns.length === 0) return 0.5;
  const scores = patterns.map((p) => {
    const affinity = NAV_AFFINITY[p.toLowerCase()];
    return affinity?.[bp.id] ?? 0.3;
  });
  return scores.reduce((s, v) => s + v, 0) / scores.length;
}

function scoreComponentSignal(
  components: string[] | undefined,
  bp: StencilBlueprint
): number {
  if (!components || components.length === 0) return 0.5;
  const scores = components.map((c) => {
    const affinity = COMPONENT_AFFINITY[c.toLowerCase()];
    return affinity?.[bp.id] ?? 0.3;
  });
  return scores.reduce((s, v) => s + v, 0) / scores.length;
}

function scorePageCountSignal(
  pageCount: number | undefined,
  bp: StencilBlueprint
): number {
  if (pageCount === undefined) return 0.5;
  const { min, max } = bp.metadata.estimatedPageCount;
  if (pageCount >= min && pageCount <= max) return 1.0;
  if (pageCount < min) {
    // Penalise by distance below min
    const ratio = pageCount / min;
    return Math.max(ratio, 0.1);
  }
  // Above max: stencil can still work, mild penalty
  const overRatio = max / pageCount;
  return Math.max(overRatio * 0.8, 0.1);
}

// ── Reason builder ────────────────────────────────────────────────────────────

function buildReason(
  bp: StencilBlueprint,
  signals: ResolverSignals,
  dimScores: {
    layout: number;
    content: number;
    navigation: number;
    component: number;
    pageCount: number;
  }
): string {
  const parts: string[] = [];

  if (dimScores.layout >= 0.8 && signals.dominantLayoutType) {
    parts.push(`visual layout "${signals.dominantLayoutType}" maps strongly to ${bp.displayName}`);
  }
  if (dimScores.content >= 0.8 && signals.contentTypes?.length) {
    parts.push(`content types (${signals.contentTypes.join(", ")}) align with ${bp.displayName}`);
  }
  if (dimScores.navigation >= 0.8 && signals.navigationPatterns?.length) {
    parts.push(`navigation patterns (${signals.navigationPatterns.join(", ")}) match ${bp.displayName}`);
  }
  if (dimScores.pageCount >= 0.9 && signals.pageCount !== undefined) {
    parts.push(`page count (${signals.pageCount}) falls within expected range ${bp.metadata.estimatedPageCount.min}–${bp.metadata.estimatedPageCount.max}`);
  }

  if (parts.length === 0) {
    parts.push(`${bp.displayName} is the closest match given available signals`);
  }

  return parts.join("; ") + ".";
}

// ── Main resolver ─────────────────────────────────────────────────────────────

/**
 * resolveStencil — scores all blueprints against the supplied signals and
 * returns a ranked ResolverResult with the top recommendation.
 *
 * Pure and synchronous.
 */
export function resolveStencil(signals: ResolverSignals): ResolverResult {
  const blueprints = getAllBlueprints();

  const WEIGHTS = {
    layout:     0.35,
    content:    0.30,
    navigation: 0.15,
    component:  0.10,
    pageCount:  0.10,
  };

  const scores: ResolverScore[] = blueprints.map((bp) => {
    const dimScores = {
      layout:     scoreLayoutSignal(signals.dominantLayoutType, bp),
      content:    scoreContentSignal(signals.contentTypes, bp),
      navigation: scoreNavigationSignal(signals.navigationPatterns, bp),
      component:  scoreComponentSignal(signals.detectedComponents, bp),
      pageCount:  scorePageCountSignal(signals.pageCount, bp),
    };

    // Hero bonus
    const heroBonus = signals.hasHero && bp.hero.hasBackgroundMedia ? 0.02 : 0;

    // Sidebar bonus
    const sidebarBonus =
      signals.hasSidebar && bp.navigation.hasPersistentSidebar ? 0.04 : 0;

    const raw =
      dimScores.layout     * WEIGHTS.layout +
      dimScores.content    * WEIGHTS.content +
      dimScores.navigation * WEIGHTS.navigation +
      dimScores.component  * WEIGHTS.component +
      dimScores.pageCount  * WEIGHTS.pageCount +
      heroBonus + sidebarBonus;

    const score = Math.min(raw, 1.0);

    return {
      stencilId: bp.id,
      score: parseFloat(score.toFixed(4)),
      confidence: parseFloat(Math.min(score * 1.1, 1.0).toFixed(4)),
      reason: buildReason(bp, signals, dimScores),
      signals: {
        layoutScore:     parseFloat(dimScores.layout.toFixed(3)),
        contentScore:    parseFloat(dimScores.content.toFixed(3)),
        navigationScore: parseFloat(dimScores.navigation.toFixed(3)),
        componentScore:  parseFloat(dimScores.component.toFixed(3)),
        pageCountScore:  parseFloat(dimScores.pageCount.toFixed(3)),
        heroBonus:       parseFloat(heroBonus.toFixed(3)),
        sidebarBonus:    parseFloat(sidebarBonus.toFixed(3)),
      },
    };
  });

  scores.sort((a, b) => b.score - a.score);

  const top    = scores[0]!;
  const winner = getBlueprint(top.stencilId)!;

  return {
    recommended: top.stencilId,
    confidence:  top.confidence,
    reason:      top.reason,
    scores,
    blueprint:   winner,
  };
}

/**
 * resolveStencilById — returns a blueprint by id without scoring.
 * Falls back to "blog" if the id is not found.
 */
export function resolveStencilById(id: StencilLibraryId): StencilBlueprint {
  return getBlueprint(id) ?? getBlueprint("blog")!;
}
