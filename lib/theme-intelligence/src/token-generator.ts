/**
 * token-generator.ts — Assembles the DesignTokens output from all system components
 *
 * Produces the design-tokens.json shape consumed by renderers and CSS generators.
 * All values are self-contained strings — no references to design system internals.
 */

import type {
  ColorPalette,
  TypographySystem,
  SpacingSystem,
  LayoutSystem,
  SiteClassification,
  DesignTokens,
  RadiusTokens,
  ShadowTokens,
  AnimationTokens,
} from "./types";

// ---------------------------------------------------------------------------
// Shadow token builder
// ---------------------------------------------------------------------------

function buildShadowTokens(layout: LayoutSystem): ShadowTokens {
  const level = layout.cardShadow;
  if (level === "none") {
    return {
      sm:    "none",
      md:    "none",
      lg:    "none",
      xl:    "none",
      inner: "none",
      none:  "none",
    };
  }
  if (level === "subtle") {
    return {
      sm:    "0 1px 2px 0 rgba(0,0,0,0.05)",
      md:    "0 2px 4px -1px rgba(0,0,0,0.08)",
      lg:    "0 4px 8px -2px rgba(0,0,0,0.10)",
      xl:    "0 8px 16px -4px rgba(0,0,0,0.12)",
      inner: "inset 0 2px 4px 0 rgba(0,0,0,0.06)",
      none:  "none",
    };
  }
  if (level === "medium") {
    return {
      sm:    "0 1px 3px 0 rgba(0,0,0,0.10)",
      md:    "0 4px 8px -2px rgba(0,0,0,0.14)",
      lg:    "0 8px 16px -4px rgba(0,0,0,0.18)",
      xl:    "0 16px 32px -6px rgba(0,0,0,0.22)",
      inner: "inset 0 2px 4px 0 rgba(0,0,0,0.10)",
      none:  "none",
    };
  }
  return {
    sm:    "0 2px 4px 0 rgba(0,0,0,0.15)",
    md:    "0 6px 12px -2px rgba(0,0,0,0.22)",
    lg:    "0 12px 24px -4px rgba(0,0,0,0.28)",
    xl:    "0 24px 48px -8px rgba(0,0,0,0.35)",
    inner: "inset 0 2px 4px 0 rgba(0,0,0,0.14)",
    none:  "none",
  };
}

// ---------------------------------------------------------------------------
// Radius token builder
// ---------------------------------------------------------------------------

function buildRadiusTokens(layout: LayoutSystem): RadiusTokens {
  const base = parseFloat(layout.cardBorderRadius) || 0;
  if (base === 0) {
    return { none: "0px", sm: "0px", md: "0px", lg: "0px", xl: "0px", "2xl": "0px", full: "9999px" };
  }
  return {
    none: "0px",
    sm:   `${Math.max(base - 4, 2)}px`,
    md:   `${base}px`,
    lg:   `${base + 4}px`,
    xl:   `${base + 8}px`,
    "2xl": `${base + 16}px`,
    full: "9999px",
  };
}

// ---------------------------------------------------------------------------
// Animation token builder
// ---------------------------------------------------------------------------

function buildAnimationTokens(classification: SiteClassification): AnimationTokens {
  const isLux  = ["luxury", "wedding", "elegant"].includes(classification.primary as string)
               || classification.designStrategy === "elegant"
               || classification.designStrategy === "immersive";

  return {
    durationFast:       isLux ? "200ms"  : "150ms",
    durationBase:       isLux ? "350ms"  : "250ms",
    durationSlow:       isLux ? "600ms"  : "400ms",
    easingDefault:      "cubic-bezier(0.4, 0, 0.2, 1)",
    easingEmphasized:   isLux ? "cubic-bezier(0.2, 0, 0, 1)" : "cubic-bezier(0.4, 0, 0.2, 1)",
    easingDecelerate:   "cubic-bezier(0, 0, 0.2, 1)",
    easingAccelerate:   "cubic-bezier(0.4, 0, 1, 1)",
  };
}

// ---------------------------------------------------------------------------
// Typography token extraction
// ---------------------------------------------------------------------------

function buildFontSizeTokens(typography: TypographySystem): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const step of typography.scaleSteps) {
    tokens[step.name] = step.size;
  }
  return tokens;
}

function buildLineHeightTokens(typography: TypographySystem): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const step of typography.scaleSteps) {
    tokens[step.name] = step.lineHeight;
  }
  return tokens;
}

function buildLetterSpacingTokens(typography: TypographySystem): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const step of typography.scaleSteps) {
    tokens[step.name] = step.letterSpacing;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function generateDesignTokens(
  classification: SiteClassification,
  palette: ColorPalette,
  typography: TypographySystem,
  spacing: SpacingSystem,
  layout: LayoutSystem,
): DesignTokens {
  return {
    meta: {
      version:        "1.0",
      generatedAt:    new Date().toISOString(),
      siteType:       classification.primary,
      designStrategy: classification.designStrategy,
    },
    colors: {
      primary:   palette.primary,
      secondary: palette.secondary,
      accent:    palette.accent,
      neutral:   palette.neutral,
      semantic:  palette.semantic,
      darkMode:  palette.darkMode,
    },
    typography: {
      fontFamilies: {
        heading: `${typography.headingFont.family}, ${typography.headingFont.fallback}`,
        body:    `${typography.bodyFont.family}, ${typography.bodyFont.fallback}`,
        display: `${typography.displayFont.family}, ${typography.displayFont.fallback}`,
        mono:    `${typography.monoFont.family}, ${typography.monoFont.fallback}`,
      },
      fontSizes:      buildFontSizeTokens(typography),
      fontWeights: {
        thin:       100,
        light:      300,
        regular:    400,
        medium:     500,
        semibold:   600,
        bold:       700,
        extrabold:  800,
        black:      900,
      },
      lineHeights:    buildLineHeightTokens(typography),
      letterSpacing:  buildLetterSpacingTokens(typography),
    },
    spacing:  spacing.scale,
    radius:   buildRadiusTokens(layout),
    shadows:  buildShadowTokens(layout),
    animation: buildAnimationTokens(classification),
    layout: {
      containerMaxWidth: spacing.containerMaxWidth,
      contentMaxWidth:   spacing.contentMaxWidth,
      sidebarWidth:      layout.sidebarWidth,
      gridColumns:       layout.grid.columns,
      gridGap:           layout.grid.gutterWidth,
    },
  };
}
