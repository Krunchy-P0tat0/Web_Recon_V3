/**
 * types.ts — DesignDNA type definitions
 *
 * DesignDNA is the canonical design-dna.json shape: a deterministic fingerprint
 * of a website's visual identity, derived from its scraped manifest.
 *
 * Rules:
 *   - All fields are plain-JSON-serializable (no Maps, Sets, Dates)
 *   - Same input website always produces the same DesignDNA (deterministic)
 *   - This lib has zero runtime dependencies — it only describes shapes
 */

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

export interface DesignDNAMeta {
  version: "1.0";
  generatedAt: string;
  jobId: string;
  url: string;
  contentHash: string;
}

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export type FontRole = "heading" | "body" | "display" | "mono" | "accent";

export type FontClass =
  | "elegant-serif"
  | "editorial-serif"
  | "readable-serif"
  | "modern-sans"
  | "humanist-sans"
  | "geometric-sans"
  | "mono"
  | "display-script"
  | "condensed-sans"
  | "unknown";

export interface FontEntry {
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

export type TypeScale = "compact" | "default" | "generous" | "editorial";

export interface TypographyDNA {
  heading: FontEntry;
  body: FontEntry;
  display: FontEntry;
  mono: FontEntry;
  scale: TypeScale;
  scaleSteps: TypeScaleStep[];
  baseFontSize: string;
  baseLineHeight: string;
  paragraphSpacing: string;
  headingTracking: string;
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

export interface ColorSwatch {
  hex: string;
  hsl: { h: number; s: number; l: number };
  label: string;
  role: "background" | "surface" | "text" | "accent" | "border";
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

export interface SemanticColorMap {
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

export interface ColorDNA {
  primary: ColorScale;
  secondary: ColorScale;
  accent: ColorScale;
  neutral: ColorScale;
  semantic: SemanticColorMap;
  darkMode: SemanticColorMap;
  swatches: ColorSwatch[];
  derivationMethod: "site-type-profile" | "image-analysis" | "brand-extraction";
}

// ---------------------------------------------------------------------------
// Spacing
// ---------------------------------------------------------------------------

export type SpacingDensity = "compact" | "default" | "comfortable" | "spacious";

export interface SpacingScale {
  px: string;
  "0.5": string;
  "1": string;
  "2": string;
  "3": string;
  "4": string;
  "5": string;
  "6": string;
  "8": string;
  "10": string;
  "12": string;
  "16": string;
  "20": string;
  "24": string;
  "32": string;
  "40": string;
  "48": string;
  "64": string;
}

export interface SpacingDNA {
  density: SpacingDensity;
  scale: SpacingScale;
  containerMaxWidth: string;
  contentMaxWidth: string;
  sectionVerticalPadding: string;
  cardPadding: string;
  gridGap: string;
}

// ---------------------------------------------------------------------------
// Borders & Shadows
// ---------------------------------------------------------------------------

export interface RadiusTokens {
  none: string;
  sm: string;
  md: string;
  lg: string;
  xl: string;
  "2xl": string;
  full: string;
}

export interface ShadowTokens {
  none: string;
  sm: string;
  md: string;
  lg: string;
  xl: string;
  inner: string;
}

export interface BorderDNA {
  radius: RadiusTokens;
  shadows: ShadowTokens;
  cardBorderRadius: string;
  imageBorderRadius: string;
  buttonBorderRadius: string;
  cardShadow: "none" | "subtle" | "medium" | "strong";
  cardBorder: boolean;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export type NavPosition = "sticky" | "fixed" | "static";
export type NavBackground = "transparent" | "solid" | "blur";
export type NavMobileStyle = "hamburger" | "bottom-bar" | "drawer";

export interface NavigationDNA {
  position: NavPosition;
  background: NavBackground;
  height: string;
  logoPosition: "left" | "center";
  mobileStyle: NavMobileStyle;
  hasSearch: boolean;
  hasCta: boolean;
  isTransparentOnHero: boolean;
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

export type HeroLayout =
  | "full-bleed-image"
  | "split-content-image"
  | "text-centered"
  | "text-left"
  | "carousel"
  | "video-background";

export type CtaStyle = "filled" | "outlined" | "ghost" | "text-link";

export interface HeroDNA {
  layout: HeroLayout;
  overlayOpacity: number;
  overlayColor: string;
  textColor: string;
  minHeight: string;
  headlineSize: string;
  ctaStyle: CtaStyle;
  ctaBorderRadius: string;
  hasSubheadline: boolean;
  hasBackgroundMedia: boolean;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export type CardLayout = "vertical" | "horizontal" | "overlay";
export type CardImagePosition = "top" | "left" | "right" | "background";
export type CardHoverEffect = "none" | "lift" | "scale" | "border-accent";

export interface CardDNA {
  layout: CardLayout;
  imagePosition: CardImagePosition;
  showCategory: boolean;
  showDate: boolean;
  showReadTime: boolean;
  showAuthor: boolean;
  hoverEffect: CardHoverEffect;
  imageAspectRatio: "16:9" | "4:3" | "1:1" | "3:2" | "portrait" | "mixed";
  hasOverlay: boolean;
}

// ---------------------------------------------------------------------------
// Gallery  — NEW: not present in theme-intelligence types
// ---------------------------------------------------------------------------

export type GalleryLayout =
  | "grid"
  | "masonry"
  | "carousel"
  | "filmstrip"
  | "full-bleed-slider"
  | "mosaic";

export type GalleryAspectRatio =
  | "1:1"
  | "4:3"
  | "16:9"
  | "3:2"
  | "portrait"
  | "mixed";

export interface GalleryDNA {
  layout: GalleryLayout;
  columnsDesktop: number;
  columnsTablet: number;
  columnsMobile: number;
  aspectRatio: GalleryAspectRatio;
  hasLightbox: boolean;
  hasCaption: boolean;
  gapSize: "none" | "tight" | "normal" | "loose";
  animationStyle: "none" | "fade" | "slide" | "zoom";
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export type LayoutStrategy =
  | "editorial_flow"
  | "card_grid"
  | "masonry"
  | "magazine"
  | "sidebar_content"
  | "full_bleed"
  | "documentation"
  | "portfolio_showcase";

export type SectionDivider = "none" | "line" | "space" | "gradient";
export type HeroHeight = "full-viewport" | "three-quarter" | "half" | "auto";
export type SectionSpacing = "tight" | "normal" | "loose";

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

export interface LayoutDNA {
  strategy: LayoutStrategy;
  grid: GridSystem;
  heroHeight: HeroHeight;
  sectionSpacing: SectionSpacing;
  dividerStyle: SectionDivider;
  sidebarWidth: string;
  contentBlockSpacing: string;
}

// ---------------------------------------------------------------------------
// Design Classification — Phase 4.3
// ---------------------------------------------------------------------------

export type DesignArchetype =
  | "documentation"
  | "blog"
  | "magazine"
  | "luxury"
  | "agency"
  | "portfolio"
  | "ecommerce";

export interface ArchetypeScore {
  archetype: DesignArchetype;
  /** Raw additive score — sum of all fired signal weights. */
  score: number;
  /** 0–1 normalised against the winner's raw score. */
  confidence: number;
  /** Human-readable labels of every signal that fired. */
  signals: string[];
  /** One-sentence explanation of why this archetype scored as it did. */
  reasoning: string;
}

export interface DesignProfile {
  archetype: DesignArchetype;
  /** 0–1 winner confidence. */
  confidence: number;
  confidenceLabel: "high" | "medium" | "low";
  /** Narrative explanation of the winning classification. */
  reasoning: string;
  /** Signals that pushed the winner to the top. */
  signals: string[];
  /** Full ranked list — all archetypes, best-first. */
  scores: ArchetypeScore[];
  generatedAt: string;
  url: string;
  jobId: string;
}

// ---------------------------------------------------------------------------
// Unified DesignDNA — the design-dna.json root shape
// ---------------------------------------------------------------------------

export interface DesignDNA {
  meta: DesignDNAMeta;
  typography: TypographyDNA;
  colors: ColorDNA;
  spacing: SpacingDNA;
  borders: BorderDNA;
  navigation: NavigationDNA;
  hero: HeroDNA;
  cards: CardDNA;
  gallery: GalleryDNA;
  layout: LayoutDNA;
}
