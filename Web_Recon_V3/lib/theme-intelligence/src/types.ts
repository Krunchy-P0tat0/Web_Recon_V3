/**
 * types.ts — Complete type definitions for the Theme Intelligence Engine
 *
 * The DesignSystem is the sole output of this library.
 * It is derived deterministically from SiteGraph + WebsiteBlueprint.
 * All types are plain-JSON-serializable.
 */

// ---------------------------------------------------------------------------
// Site Classification
// ---------------------------------------------------------------------------

export type SiteType =
  | "editorial"
  | "news"
  | "corporate"
  | "portfolio"
  | "wedding"
  | "luxury"
  | "lifestyle"
  | "travel"
  | "photography"
  | "blog"
  | "marketplace"
  | "documentation"
  | "unknown";

export type DesignStrategy =
  | "elegant"
  | "readable"
  | "minimal"
  | "bold"
  | "professional"
  | "friendly"
  | "modern"
  | "dense"
  | "immersive";

export type LayoutStrategy =
  | "editorial_flow"
  | "card_grid"
  | "masonry"
  | "magazine"
  | "sidebar_content"
  | "full_bleed"
  | "documentation"
  | "portfolio_showcase";

export interface SiteClassificationSignal {
  signal: string;
  weight: number;
  matched: boolean;
  evidence: string;
}

export interface SiteTypeScore {
  siteType: SiteType;
  score: number;
  confidence: number;
  signals: SiteClassificationSignal[];
}

export interface SiteClassification {
  primary: SiteType;
  confidence: number;
  alternatives: SiteTypeScore[];
  designStrategy: DesignStrategy;
  layoutStrategy: LayoutStrategy;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Color System
// ---------------------------------------------------------------------------

export interface ColorStop {
  hex: string;
  hsl: { h: number; s: number; l: number };
  label: string;
  usage: "background" | "surface" | "text" | "accent" | "border";
}

export interface ColorScale {
  50: string;
  100: string;
  200: string;
  300: string;
  400: string;
  500: string;
  600: string;
  700: string;
  800: string;
  900: string;
  950: string;
}

export interface SemanticColors {
  background: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textInverse: string;
  link: string;
  linkHover: string;
  success: string;
  warning: string;
  error: string;
  info: string;
}

export interface ColorPalette {
  primary: ColorScale;
  secondary: ColorScale;
  accent: ColorScale;
  neutral: ColorScale;
  semantic: SemanticColors;
  darkMode: SemanticColors;
  derivationMethod: "site-type-profile" | "image-analysis" | "brand-extraction";
  derivationReasoning: string;
}

// ---------------------------------------------------------------------------
// Typography System
// ---------------------------------------------------------------------------

export type FontClass =
  | "elegant-serif"
  | "editorial-serif"
  | "readable-serif"
  | "modern-sans"
  | "humanist-sans"
  | "geometric-sans"
  | "mono"
  | "display-script"
  | "condensed-sans";

export type TypeScale =
  | "compact"
  | "default"
  | "generous"
  | "editorial";

export interface FontDefinition {
  family: string;
  fallback: string;
  googleFontUrl: string | null;
  fontClass: FontClass;
  weights: number[];
  styles: Array<"normal" | "italic">;
}

export interface TypeScaleStep {
  name: string;
  size: string;
  lineHeight: string;
  letterSpacing: string;
  fontWeight: number;
  useCase: string;
}

export interface TypographySystem {
  headingFont: FontDefinition;
  bodyFont: FontDefinition;
  displayFont: FontDefinition;
  monoFont: FontDefinition;
  scale: TypeScale;
  scaleSteps: TypeScaleStep[];
  baseFontSize: string;
  baseLineHeight: string;
  paragraphSpacing: string;
  headingTracking: string;
  derivationReasoning: string;
}

// ---------------------------------------------------------------------------
// Spacing System
// ---------------------------------------------------------------------------

export type SpacingDensity = "compact" | "default" | "comfortable" | "spacious";

export interface SpacingScale {
  px: string;
  0.5: string;
  1: string;
  2: string;
  3: string;
  4: string;
  5: string;
  6: string;
  8: string;
  10: string;
  12: string;
  16: string;
  20: string;
  24: string;
  32: string;
  40: string;
  48: string;
  64: string;
}

export interface SpacingSystem {
  density: SpacingDensity;
  scale: SpacingScale;
  containerMaxWidth: string;
  contentMaxWidth: string;
  sectionVerticalPadding: string;
  cardPadding: string;
  gridGap: string;
  derivationReasoning: string;
}

// ---------------------------------------------------------------------------
// Content Density
// ---------------------------------------------------------------------------

export type ContentDensity = "dense" | "balanced" | "visual";

export interface DensityProfile {
  density: ContentDensity;
  cardsPerRow: { mobile: number; tablet: number; desktop: number };
  showExcerpts: boolean;
  showThumbnails: boolean;
  excerptLength: number;
  listingLayout: "grid" | "list" | "masonry" | "magazine";
  imageRatio: "16:9" | "4:3" | "1:1" | "3:2" | "portrait" | "mixed";
  derivationReasoning: string;
}

// ---------------------------------------------------------------------------
// Layout System
// ---------------------------------------------------------------------------

export interface GridSystem {
  columns: 12 | 16;
  gutterWidth: string;
  marginWidth: string;
  breakpoints: {
    sm: string;
    md: string;
    lg: string;
    xl: string;
    "2xl": string;
  };
}

export interface SectionRhythm {
  heroHeight: "full-viewport" | "three-quarter" | "half" | "auto";
  sectionSpacing: "tight" | "normal" | "loose";
  contentBlockSpacing: string;
  dividerStyle: "none" | "line" | "space" | "gradient";
}

export interface LayoutSystem {
  grid: GridSystem;
  rhythm: SectionRhythm;
  cardBorderRadius: string;
  imageBorderRadius: string;
  buttonBorderRadius: string;
  cardShadow: "none" | "subtle" | "medium" | "strong";
  cardBorder: boolean;
  sidebarWidth: string;
  derivationReasoning: string;
}

// ---------------------------------------------------------------------------
// Component Styling
// ---------------------------------------------------------------------------

export interface ComponentStyleRule {
  component: string;
  variant: "default" | "featured" | "minimal" | "prominent";
  backgroundToken: string;
  textToken: string;
  borderToken: string;
  paddingToken: string;
  borderRadiusToken: string;
  shadowToken: string;
  fontToken: string;
  notes: string;
}

export interface HeroStyle {
  layout: "full-bleed-image" | "split-content-image" | "text-centered" | "text-left";
  overlayOpacity: number;
  overlayColor: string;
  textColor: string;
  minHeight: string;
  headlineSize: string;
  ctaStyle: "filled" | "outlined" | "ghost" | "text-link";
  ctaBorderRadius: string;
}

export interface CardStyle {
  layout: "vertical" | "horizontal" | "overlay";
  imagePosition: "top" | "left" | "right" | "background";
  showCategory: boolean;
  showDate: boolean;
  showReadTime: boolean;
  showAuthor: boolean;
  hoverEffect: "none" | "lift" | "scale" | "border-accent";
}

export interface NavigationStyle {
  position: "sticky" | "fixed" | "static";
  background: "transparent" | "solid" | "blur";
  height: string;
  logoPosition: "left" | "center";
  mobileStyle: "hamburger" | "bottom-bar" | "drawer";
}

export interface ComponentStyling {
  rules: ComponentStyleRule[];
  hero: HeroStyle;
  card: CardStyle;
  navigation: NavigationStyle;
  derivationReasoning: string;
}

// ---------------------------------------------------------------------------
// Design Tokens (design-tokens.json shape)
// ---------------------------------------------------------------------------

export interface AnimationTokens {
  durationFast: string;
  durationBase: string;
  durationSlow: string;
  easingDefault: string;
  easingEmphasized: string;
  easingDecelerate: string;
  easingAccelerate: string;
}

export interface ShadowTokens {
  sm: string;
  md: string;
  lg: string;
  xl: string;
  inner: string;
  none: string;
}

export interface RadiusTokens {
  none: string;
  sm: string;
  md: string;
  lg: string;
  xl: string;
  "2xl": string;
  full: string;
}

export interface DesignTokens {
  meta: {
    version: "1.0";
    generatedAt: string;
    siteType: SiteType;
    designStrategy: DesignStrategy;
  };
  colors: {
    primary: ColorScale;
    secondary: ColorScale;
    accent: ColorScale;
    neutral: ColorScale;
    semantic: SemanticColors;
    darkMode: SemanticColors;
  };
  typography: {
    fontFamilies: {
      heading: string;
      body: string;
      display: string;
      mono: string;
    };
    fontSizes: Record<string, string>;
    fontWeights: Record<string, number>;
    lineHeights: Record<string, string>;
    letterSpacing: Record<string, string>;
  };
  spacing: SpacingScale;
  radius: RadiusTokens;
  shadows: ShadowTokens;
  animation: AnimationTokens;
  layout: {
    containerMaxWidth: string;
    contentMaxWidth: string;
    sidebarWidth: string;
    gridColumns: number;
    gridGap: string;
  };
}

// ---------------------------------------------------------------------------
// Theme Profile (theme-profile.json shape)
// ---------------------------------------------------------------------------

export interface ThemeProfile {
  version: "1.0";
  generatedAt: string;
  seedUrl: string;
  siteGraphId: string;
  blueprintId: string;
  siteType: SiteType;
  confidence: number;
  designStrategy: DesignStrategy;
  layoutStrategy: LayoutStrategy;
  contentDensity: ContentDensity;
  classification: SiteClassification;
  summary: string;
  recommendations: string[];
}

// ---------------------------------------------------------------------------
// DesignSystem — the unified output
// ---------------------------------------------------------------------------

export interface DesignSystemStats {
  siteType: SiteType;
  confidence: number;
  totalColorTokens: number;
  totalTypographyTokens: number;
  totalSpacingTokens: number;
  totalComponentRules: number;
  generationTimeMs: number;
}

export interface DesignSystem {
  id: string;
  version: "1.0";
  generatedAt: string;
  seedUrl: string;
  siteGraphId: string;
  blueprintId: string;

  classification: SiteClassification;
  colorPalette: ColorPalette;
  typography: TypographySystem;
  spacing: SpacingSystem;
  density: DensityProfile;
  layout: LayoutSystem;
  componentStyling: ComponentStyling;

  tokens: DesignTokens;
  themeProfile: ThemeProfile;

  stats: DesignSystemStats;
}
