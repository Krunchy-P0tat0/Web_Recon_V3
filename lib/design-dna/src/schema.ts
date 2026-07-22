/**
 * schema.ts — Zod validators for DesignDNA
 *
 * Each sub-schema mirrors its types.ts counterpart exactly.
 * Use validateDesignDNA() to validate an unknown value before trusting it.
 * All schemas are exported so callers can validate sub-sections independently.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

export const DesignDNAMetaSchema = z.object({
  version: z.literal("1.0"),
  generatedAt: z.string(),
  jobId: z.string(),
  url: z.string(),
  contentHash: z.string(),
});

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

const FontClassSchema = z.enum([
  "elegant-serif",
  "editorial-serif",
  "readable-serif",
  "modern-sans",
  "humanist-sans",
  "geometric-sans",
  "mono",
  "display-script",
  "condensed-sans",
  "unknown",
]);

const FontEntrySchema = z.object({
  family: z.string(),
  fallback: z.string(),
  googleFontUrl: z.string().nullable(),
  fontClass: FontClassSchema,
  weights: z.array(z.number()),
  styles: z.array(z.enum(["normal", "italic"])),
});

const TypeScaleStepSchema = z.object({
  name: z.string(),
  size: z.string(),
  lineHeight: z.string(),
  letterSpacing: z.string(),
  fontWeight: z.number(),
  useCase: z.string(),
});

const TypeScaleSchema = z.enum(["compact", "default", "generous", "editorial"]);

export const TypographyDNASchema = z.object({
  heading: FontEntrySchema,
  body: FontEntrySchema,
  display: FontEntrySchema,
  mono: FontEntrySchema,
  scale: TypeScaleSchema,
  scaleSteps: z.array(TypeScaleStepSchema),
  baseFontSize: z.string(),
  baseLineHeight: z.string(),
  paragraphSpacing: z.string(),
  headingTracking: z.string(),
});

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const ColorSwatchSchema = z.object({
  hex: z.string(),
  hsl: z.object({ h: z.number(), s: z.number(), l: z.number() }),
  label: z.string(),
  role: z.enum(["background", "surface", "text", "accent", "border"]),
});

const ColorScaleSchema = z.object({
  50: z.string(),
  100: z.string(),
  200: z.string(),
  300: z.string(),
  400: z.string(),
  500: z.string(),
  600: z.string(),
  700: z.string(),
  800: z.string(),
  900: z.string(),
  950: z.string(),
});

const SemanticColorMapSchema = z.object({
  background: z.string(),
  surface: z.string(),
  surfaceAlt: z.string(),
  border: z.string(),
  borderStrong: z.string(),
  textPrimary: z.string(),
  textSecondary: z.string(),
  textMuted: z.string(),
  textInverse: z.string(),
  link: z.string(),
  linkHover: z.string(),
  success: z.string(),
  warning: z.string(),
  error: z.string(),
  info: z.string(),
});

export const ColorDNASchema = z.object({
  primary: ColorScaleSchema,
  secondary: ColorScaleSchema,
  accent: ColorScaleSchema,
  neutral: ColorScaleSchema,
  semantic: SemanticColorMapSchema,
  darkMode: SemanticColorMapSchema,
  swatches: z.array(ColorSwatchSchema),
  derivationMethod: z.enum(["site-type-profile", "image-analysis", "brand-extraction"]),
});

// ---------------------------------------------------------------------------
// Spacing
// ---------------------------------------------------------------------------

const SpacingDensitySchema = z.enum(["compact", "default", "comfortable", "spacious"]);

const SpacingScaleSchema = z.object({
  px: z.string(),
  "0.5": z.string(),
  "1": z.string(),
  "2": z.string(),
  "3": z.string(),
  "4": z.string(),
  "5": z.string(),
  "6": z.string(),
  "8": z.string(),
  "10": z.string(),
  "12": z.string(),
  "16": z.string(),
  "20": z.string(),
  "24": z.string(),
  "32": z.string(),
  "40": z.string(),
  "48": z.string(),
  "64": z.string(),
});

export const SpacingDNASchema = z.object({
  density: SpacingDensitySchema,
  scale: SpacingScaleSchema,
  containerMaxWidth: z.string(),
  contentMaxWidth: z.string(),
  sectionVerticalPadding: z.string(),
  cardPadding: z.string(),
  gridGap: z.string(),
});

// ---------------------------------------------------------------------------
// Borders & Shadows
// ---------------------------------------------------------------------------

const RadiusTokensSchema = z.object({
  none: z.string(),
  sm: z.string(),
  md: z.string(),
  lg: z.string(),
  xl: z.string(),
  "2xl": z.string(),
  full: z.string(),
});

const ShadowTokensSchema = z.object({
  none: z.string(),
  sm: z.string(),
  md: z.string(),
  lg: z.string(),
  xl: z.string(),
  inner: z.string(),
});

export const BorderDNASchema = z.object({
  radius: RadiusTokensSchema,
  shadows: ShadowTokensSchema,
  cardBorderRadius: z.string(),
  imageBorderRadius: z.string(),
  buttonBorderRadius: z.string(),
  cardShadow: z.enum(["none", "subtle", "medium", "strong"]),
  cardBorder: z.boolean(),
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export const NavigationDNASchema = z.object({
  position: z.enum(["sticky", "fixed", "static"]),
  background: z.enum(["transparent", "solid", "blur"]),
  height: z.string(),
  logoPosition: z.enum(["left", "center"]),
  mobileStyle: z.enum(["hamburger", "bottom-bar", "drawer"]),
  hasSearch: z.boolean(),
  hasCta: z.boolean(),
  isTransparentOnHero: z.boolean(),
});

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

export const HeroDNASchema = z.object({
  layout: z.enum([
    "full-bleed-image",
    "split-content-image",
    "text-centered",
    "text-left",
    "carousel",
    "video-background",
  ]),
  overlayOpacity: z.number().min(0).max(1),
  overlayColor: z.string(),
  textColor: z.string(),
  minHeight: z.string(),
  headlineSize: z.string(),
  ctaStyle: z.enum(["filled", "outlined", "ghost", "text-link"]),
  ctaBorderRadius: z.string(),
  hasSubheadline: z.boolean(),
  hasBackgroundMedia: z.boolean(),
});

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export const CardDNASchema = z.object({
  layout: z.enum(["vertical", "horizontal", "overlay"]),
  imagePosition: z.enum(["top", "left", "right", "background"]),
  showCategory: z.boolean(),
  showDate: z.boolean(),
  showReadTime: z.boolean(),
  showAuthor: z.boolean(),
  hoverEffect: z.enum(["none", "lift", "scale", "border-accent"]),
  imageAspectRatio: z.enum(["16:9", "4:3", "1:1", "3:2", "portrait", "mixed"]),
  hasOverlay: z.boolean(),
});

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

export const GalleryDNASchema = z.object({
  layout: z.enum([
    "grid",
    "masonry",
    "carousel",
    "filmstrip",
    "full-bleed-slider",
    "mosaic",
  ]),
  columnsDesktop: z.number().int().min(1).max(8),
  columnsTablet: z.number().int().min(1).max(4),
  columnsMobile: z.number().int().min(1).max(2),
  aspectRatio: z.enum(["1:1", "4:3", "16:9", "3:2", "portrait", "mixed"]),
  hasLightbox: z.boolean(),
  hasCaption: z.boolean(),
  gapSize: z.enum(["none", "tight", "normal", "loose"]),
  animationStyle: z.enum(["none", "fade", "slide", "zoom"]),
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const GridSystemSchema = z.object({
  columns: z.union([z.literal(12), z.literal(16)]),
  gutterWidth: z.string(),
  marginWidth: z.string(),
  breakpoints: z.object({
    sm: z.string(),
    md: z.string(),
    lg: z.string(),
    xl: z.string(),
    "2xl": z.string(),
  }),
});

export const LayoutDNASchema = z.object({
  strategy: z.enum([
    "editorial_flow",
    "card_grid",
    "masonry",
    "magazine",
    "sidebar_content",
    "full_bleed",
    "documentation",
    "portfolio_showcase",
  ]),
  grid: GridSystemSchema,
  heroHeight: z.enum(["full-viewport", "three-quarter", "half", "auto"]),
  sectionSpacing: z.enum(["tight", "normal", "loose"]),
  dividerStyle: z.enum(["none", "line", "space", "gradient"]),
  sidebarWidth: z.string(),
  contentBlockSpacing: z.string(),
});

// ---------------------------------------------------------------------------
// Root DesignDNA schema
// ---------------------------------------------------------------------------

export const DesignDNASchema = z.object({
  meta: DesignDNAMetaSchema,
  typography: TypographyDNASchema,
  colors: ColorDNASchema,
  spacing: SpacingDNASchema,
  borders: BorderDNASchema,
  navigation: NavigationDNASchema,
  hero: HeroDNASchema,
  cards: CardDNASchema,
  gallery: GalleryDNASchema,
  layout: LayoutDNASchema,
});

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

export function validateDesignDNA(value: unknown): ValidationResult {
  const result = DesignDNASchema.safeParse(value);
  if (result.success) return { ok: true };
  return {
    ok: false,
    errors: result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`
    ),
  };
}
