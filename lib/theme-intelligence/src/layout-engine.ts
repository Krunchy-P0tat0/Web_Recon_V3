/**
 * layout-engine.ts — Generates layout system from site classification + density
 *
 * Produces grid system, section rhythm, border radii, shadow levels, and
 * sidebar widths. All values are deterministic from the input.
 */

import type { SiteClassification, DensityProfile, LayoutSystem, GridSystem, SectionRhythm } from "./types";

// ---------------------------------------------------------------------------
// Layout profiles per design strategy
// ---------------------------------------------------------------------------

interface LayoutProfile {
  containerMaxWidth: string;
  sidebarWidth: string;
  cardBorderRadius: string;
  imageBorderRadius: string;
  buttonBorderRadius: string;
  cardShadow: LayoutSystem["cardShadow"];
  cardBorder: boolean;
  heroHeight: SectionRhythm["heroHeight"];
  sectionSpacing: SectionRhythm["sectionSpacing"];
  contentBlockSpacing: string;
  dividerStyle: SectionRhythm["dividerStyle"];
  reasoning: string;
}

const LAYOUT_PROFILES: Record<string, LayoutProfile> = {
  elegant: {
    containerMaxWidth:    "1200px",
    sidebarWidth:         "280px",
    cardBorderRadius:     "4px",
    imageBorderRadius:    "2px",
    buttonBorderRadius:   "2px",
    cardShadow:           "subtle",
    cardBorder:           false,
    heroHeight:           "three-quarter",
    sectionSpacing:       "loose",
    contentBlockSpacing:  "3rem",
    dividerStyle:         "space",
    reasoning:            "Elegant strategy: restrained radii, generous spacing, subtle shadows for a refined premium feel.",
  },
  readable: {
    containerMaxWidth:    "720px",
    sidebarWidth:         "260px",
    cardBorderRadius:     "8px",
    imageBorderRadius:    "6px",
    buttonBorderRadius:   "6px",
    cardShadow:           "subtle",
    cardBorder:           true,
    heroHeight:           "half",
    sectionSpacing:       "normal",
    contentBlockSpacing:  "2rem",
    dividerStyle:         "line",
    reasoning:            "Readable strategy: narrow content column, clear borders and lines to guide the reader through long-form content.",
  },
  minimal: {
    containerMaxWidth:    "1400px",
    sidebarWidth:         "240px",
    cardBorderRadius:     "0px",
    imageBorderRadius:    "0px",
    buttonBorderRadius:   "0px",
    cardShadow:           "none",
    cardBorder:           false,
    heroHeight:           "full-viewport",
    sectionSpacing:       "loose",
    contentBlockSpacing:  "4rem",
    dividerStyle:         "none",
    reasoning:            "Minimal strategy: zero radius, no borders, maximum whitespace — UI is invisible, content is everything.",
  },
  bold: {
    containerMaxWidth:    "1280px",
    sidebarWidth:         "280px",
    cardBorderRadius:     "12px",
    imageBorderRadius:    "8px",
    buttonBorderRadius:   "8px",
    cardShadow:           "medium",
    cardBorder:           false,
    heroHeight:           "three-quarter",
    sectionSpacing:       "normal",
    contentBlockSpacing:  "2.5rem",
    dividerStyle:         "gradient",
    reasoning:            "Bold strategy: strong shadows, rounded cards, gradient dividers for high-energy visual impact.",
  },
  professional: {
    containerMaxWidth:    "1200px",
    sidebarWidth:         "260px",
    cardBorderRadius:     "8px",
    imageBorderRadius:    "6px",
    buttonBorderRadius:   "6px",
    cardShadow:           "subtle",
    cardBorder:           true,
    heroHeight:           "half",
    sectionSpacing:       "normal",
    contentBlockSpacing:  "2rem",
    dividerStyle:         "line",
    reasoning:            "Professional strategy: structured grid, clear borders, consistent spacing for trust and clarity.",
  },
  friendly: {
    containerMaxWidth:    "1140px",
    sidebarWidth:         "260px",
    cardBorderRadius:     "16px",
    imageBorderRadius:    "12px",
    buttonBorderRadius:   "999px",
    cardShadow:           "medium",
    cardBorder:           false,
    heroHeight:           "half",
    sectionSpacing:       "normal",
    contentBlockSpacing:  "2.5rem",
    dividerStyle:         "space",
    reasoning:            "Friendly strategy: fully rounded buttons, generous card radii, warm shadows for approachable feel.",
  },
  modern: {
    containerMaxWidth:    "1280px",
    sidebarWidth:         "280px",
    cardBorderRadius:     "10px",
    imageBorderRadius:    "8px",
    buttonBorderRadius:   "8px",
    cardShadow:           "medium",
    cardBorder:           false,
    heroHeight:           "three-quarter",
    sectionSpacing:       "normal",
    contentBlockSpacing:  "3rem",
    dividerStyle:         "space",
    reasoning:            "Modern strategy: medium radii, floating card shadows, clean whitespace for contemporary creative feel.",
  },
  dense: {
    containerMaxWidth:    "1400px",
    sidebarWidth:         "240px",
    cardBorderRadius:     "4px",
    imageBorderRadius:    "4px",
    buttonBorderRadius:   "4px",
    cardShadow:           "none",
    cardBorder:           true,
    heroHeight:           "auto",
    sectionSpacing:       "tight",
    contentBlockSpacing:  "1rem",
    dividerStyle:         "line",
    reasoning:            "Dense strategy: minimal radii, tight spacing, hard borders — maximise information in viewport.",
  },
  immersive: {
    containerMaxWidth:    "1440px",
    sidebarWidth:         "300px",
    cardBorderRadius:     "6px",
    imageBorderRadius:    "4px",
    buttonBorderRadius:   "4px",
    cardShadow:           "strong",
    cardBorder:           false,
    heroHeight:           "full-viewport",
    sectionSpacing:       "loose",
    contentBlockSpacing:  "4rem",
    dividerStyle:         "none",
    reasoning:            "Immersive strategy: full-viewport hero, wide container, strong shadows for cinematic atmosphere.",
  },
};

// ---------------------------------------------------------------------------
// Grid system builder
// ---------------------------------------------------------------------------

function buildGridSystem(density: DensityProfile): GridSystem {
  const gutterWidth    = density.density === "dense" ? "16px" : density.density === "visual" ? "24px" : "20px";
  const marginWidth    = density.density === "dense" ? "16px" : density.density === "visual" ? "32px" : "24px";

  return {
    columns: 12,
    gutterWidth,
    marginWidth,
    breakpoints: {
      sm:   "640px",
      md:   "768px",
      lg:   "1024px",
      xl:   "1280px",
      "2xl": "1536px",
    },
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function deriveLayoutSystem(
  classification: SiteClassification,
  density: DensityProfile,
): LayoutSystem {
  const profile = LAYOUT_PROFILES[classification.designStrategy] ?? LAYOUT_PROFILES["professional"];
  const grid = buildGridSystem(density);

  const rhythm: SectionRhythm = {
    heroHeight:           profile.heroHeight,
    sectionSpacing:       profile.sectionSpacing,
    contentBlockSpacing:  profile.contentBlockSpacing,
    dividerStyle:         profile.dividerStyle,
  };

  return {
    grid,
    rhythm,
    cardBorderRadius:   profile.cardBorderRadius,
    imageBorderRadius:  profile.imageBorderRadius,
    buttonBorderRadius: profile.buttonBorderRadius,
    cardShadow:         profile.cardShadow,
    cardBorder:         profile.cardBorder,
    sidebarWidth:       profile.sidebarWidth,
    derivationReasoning: profile.reasoning,
  };
}
