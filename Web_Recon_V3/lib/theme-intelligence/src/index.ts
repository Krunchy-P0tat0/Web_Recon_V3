/**
 * @workspace/theme-intelligence
 *
 * Theme Intelligence Engine — derives a complete DesignSystem from a SiteGraph + WebsiteBlueprint.
 *
 * Main entry point:
 *   compileDesignSystem(siteGraph, blueprint)  → DesignSystem
 *
 * Individual engines (for testing or partial use):
 *   classifySite           → SiteClassification
 *   deriveColorPalette     → ColorPalette
 *   deriveTypographySystem → TypographySystem
 *   deriveDensityProfile   → DensityProfile
 *   deriveLayoutSystem     → LayoutSystem
 *   deriveSpacingSystem    → SpacingSystem
 *   deriveComponentStyling → ComponentStyling
 *   generateDesignTokens   → DesignTokens
 *
 * All operations are:
 *   - Deterministic (same input → same output)
 *   - Pure (no I/O, no external services)
 *   - Synchronous (no async)
 *   - SiteGraph + Blueprint only (no raw crawl data)
 */

export { compileDesignSystem }    from "./compiler";

export { classifySite }           from "./site-classifier";
export { deriveColorPalette }     from "./color-engine";
export { deriveTypographySystem } from "./typography-engine";
export { deriveDensityProfile }   from "./density-engine";
export { deriveLayoutSystem }     from "./layout-engine";
export { deriveSpacingSystem }    from "./spacing-engine";
export { deriveComponentStyling } from "./component-styling";
export { generateDesignTokens }   from "./token-generator";

export type {
  // Design System — unified output
  DesignSystem,
  DesignSystemStats,

  // Site Classification
  SiteClassification,
  SiteType,
  SiteTypeScore,
  SiteClassificationSignal,
  DesignStrategy,
  LayoutStrategy,

  // Color System
  ColorPalette,
  ColorScale,
  ColorStop,
  SemanticColors,

  // Typography
  TypographySystem,
  FontDefinition,
  FontClass,
  TypeScale,
  TypeScaleStep,

  // Spacing
  SpacingSystem,
  SpacingScale,
  SpacingDensity,

  // Density
  DensityProfile,
  ContentDensity,

  // Layout
  LayoutSystem,
  GridSystem,
  SectionRhythm,

  // Component Styling
  ComponentStyling,
  ComponentStyleRule,
  HeroStyle,
  CardStyle,
  NavigationStyle,

  // Tokens
  DesignTokens,
  RadiusTokens,
  ShadowTokens,
  AnimationTokens,

  // Theme Profile
  ThemeProfile,
} from "./types";
