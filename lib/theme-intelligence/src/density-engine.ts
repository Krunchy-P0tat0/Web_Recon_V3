/**
 * density-engine.ts — Determines content density profile from site classification + graph
 *
 * Density drives listing layouts, card styles, image ratios, and excerpt visibility.
 * Three modes: dense (news/marketplace), balanced (editorial/corporate), visual (photo/luxury).
 */

import type { SiteGraph } from "@workspace/site-intelligence";
import type { WebsiteBlueprint } from "@workspace/stencil-generator";
import type { SiteClassification, ContentDensity, DensityProfile } from "./types";

// ---------------------------------------------------------------------------
// Per-type density defaults
// ---------------------------------------------------------------------------

interface DensityDefaults {
  density: ContentDensity;
  cardsPerRow: { mobile: number; tablet: number; desktop: number };
  showExcerpts: boolean;
  showThumbnails: boolean;
  excerptLength: number;
  listingLayout: DensityProfile["listingLayout"];
  imageRatio: DensityProfile["imageRatio"];
  reasoning: string;
}

const DENSITY_DEFAULTS: Record<string, DensityDefaults> = {
  news: {
    density: "dense",
    cardsPerRow: { mobile: 1, tablet: 2, desktop: 3 },
    showExcerpts: true,
    showThumbnails: true,
    excerptLength: 100,
    listingLayout: "list",
    imageRatio: "16:9",
    reasoning: "News: dense list layout with short excerpts for maximum information throughput.",
  },
  marketplace: {
    density: "dense",
    cardsPerRow: { mobile: 2, tablet: 3, desktop: 4 },
    showExcerpts: false,
    showThumbnails: true,
    excerptLength: 60,
    listingLayout: "grid",
    imageRatio: "1:1",
    reasoning: "Marketplace: dense grid of product cards optimized for browsing and comparison.",
  },
  documentation: {
    density: "dense",
    cardsPerRow: { mobile: 1, tablet: 1, desktop: 2 },
    showExcerpts: true,
    showThumbnails: false,
    excerptLength: 150,
    listingLayout: "list",
    imageRatio: "16:9",
    reasoning: "Documentation: dense list with excerpts prioritises scannability over visual appeal.",
  },
  editorial: {
    density: "balanced",
    cardsPerRow: { mobile: 1, tablet: 2, desktop: 3 },
    showExcerpts: true,
    showThumbnails: true,
    excerptLength: 160,
    listingLayout: "magazine",
    imageRatio: "16:9",
    reasoning: "Editorial: magazine layout balances text density with featured imagery.",
  },
  blog: {
    density: "balanced",
    cardsPerRow: { mobile: 1, tablet: 2, desktop: 3 },
    showExcerpts: true,
    showThumbnails: true,
    excerptLength: 140,
    listingLayout: "grid",
    imageRatio: "3:2",
    reasoning: "Blog: balanced grid with readable excerpts for personal content discovery.",
  },
  corporate: {
    density: "balanced",
    cardsPerRow: { mobile: 1, tablet: 2, desktop: 3 },
    showExcerpts: true,
    showThumbnails: true,
    excerptLength: 120,
    listingLayout: "grid",
    imageRatio: "16:9",
    reasoning: "Corporate: balanced grid suitable for service and feature listings.",
  },
  lifestyle: {
    density: "balanced",
    cardsPerRow: { mobile: 1, tablet: 2, desktop: 3 },
    showExcerpts: true,
    showThumbnails: true,
    excerptLength: 120,
    listingLayout: "grid",
    imageRatio: "3:2",
    reasoning: "Lifestyle: visually warm card grid balancing image appeal with text engagement.",
  },
  travel: {
    density: "visual",
    cardsPerRow: { mobile: 1, tablet: 2, desktop: 3 },
    showExcerpts: true,
    showThumbnails: true,
    excerptLength: 100,
    listingLayout: "masonry",
    imageRatio: "portrait",
    reasoning: "Travel: masonry layout celebrates diverse photography formats and destination imagery.",
  },
  photography: {
    density: "visual",
    cardsPerRow: { mobile: 1, tablet: 2, desktop: 3 },
    showExcerpts: false,
    showThumbnails: true,
    excerptLength: 0,
    listingLayout: "masonry",
    imageRatio: "mixed",
    reasoning: "Photography: pure visual masonry — no excerpts, images fill all available space.",
  },
  portfolio: {
    density: "visual",
    cardsPerRow: { mobile: 1, tablet: 2, desktop: 3 },
    showExcerpts: false,
    showThumbnails: true,
    excerptLength: 60,
    listingLayout: "masonry",
    imageRatio: "portrait",
    reasoning: "Portfolio: visual showcase with minimal text to keep focus on work samples.",
  },
  luxury: {
    density: "visual",
    cardsPerRow: { mobile: 1, tablet: 2, desktop: 2 },
    showExcerpts: true,
    showThumbnails: true,
    excerptLength: 80,
    listingLayout: "grid",
    imageRatio: "portrait",
    reasoning: "Luxury: sparse two-column grid with generous whitespace for premium feel.",
  },
  wedding: {
    density: "visual",
    cardsPerRow: { mobile: 1, tablet: 2, desktop: 2 },
    showExcerpts: true,
    showThumbnails: true,
    excerptLength: 100,
    listingLayout: "masonry",
    imageRatio: "portrait",
    reasoning: "Wedding: romantic masonry layout that celebrates photography and story-driven content.",
  },
  unknown: {
    density: "balanced",
    cardsPerRow: { mobile: 1, tablet: 2, desktop: 3 },
    showExcerpts: true,
    showThumbnails: true,
    excerptLength: 130,
    listingLayout: "grid",
    imageRatio: "16:9",
    reasoning: "Default: balanced grid applied when site type is undetermined.",
  },
};

// ---------------------------------------------------------------------------
// Override logic based on actual graph signals
// ---------------------------------------------------------------------------

function applyGraphOverrides(
  defaults: DensityDefaults,
  graph: SiteGraph,
  _blueprint: WebsiteBlueprint,
): DensityDefaults {
  const result = { ...defaults };

  // Very high image density → push toward visual
  if (graph.stats.averageImagesPerPage > 6 && result.density === "balanced") {
    result.density = "visual";
    result.listingLayout = "masonry";
    result.reasoning += " (image density override → visual)";
  }

  // Very low image count → push toward dense text
  if (graph.stats.totalImages === 0) {
    result.showThumbnails = false;
    result.density = "dense";
    result.listingLayout = "list";
    result.reasoning += " (no images → dense text override)";
  }

  // Very large site → increase desktop cards per row
  if (graph.stats.contentNodes > 100 && result.cardsPerRow.desktop < 4) {
    result.cardsPerRow = { mobile: result.cardsPerRow.mobile, tablet: result.cardsPerRow.tablet, desktop: 4 };
    result.reasoning += " (large site → 4 cols desktop)";
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function deriveDensityProfile(
  classification: SiteClassification,
  graph: SiteGraph,
  blueprint: WebsiteBlueprint,
): DensityProfile {
  const defaults = DENSITY_DEFAULTS[classification.primary] ?? DENSITY_DEFAULTS["unknown"];
  const overridden = applyGraphOverrides(defaults, graph, blueprint);

  return {
    density:         overridden.density,
    cardsPerRow:     overridden.cardsPerRow,
    showExcerpts:    overridden.showExcerpts,
    showThumbnails:  overridden.showThumbnails,
    excerptLength:   overridden.excerptLength,
    listingLayout:   overridden.listingLayout,
    imageRatio:      overridden.imageRatio,
    derivationReasoning: overridden.reasoning,
  };
}
