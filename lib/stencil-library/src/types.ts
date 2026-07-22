/**
 * types.ts — Phase 4.5 Stencil Library type definitions
 *
 * Extends the sparse @workspace/stencil-registry capability model with
 * concrete structural blueprints: routes, hero spec, card config,
 * navigation config, footer spec, and per-stencil metadata.
 *
 * All types are plain-JSON-serializable and zero-runtime-dep.
 */

import type {
  ContentCapability,
  LayoutCapability,
  PageTypeCapability,
  NavigationStructure,
  ContentType,
  LayoutType,
  PageType,
  ComponentType,
} from "@workspace/stencil-registry";

export type {
  ContentCapability,
  LayoutCapability,
  PageTypeCapability,
  NavigationStructure,
  ContentType,
  LayoutType,
  PageType,
  ComponentType,
};

// ── Stencil identity ───────────────────────────────────────────────────────────

/**
 * The six canonical stencil identifiers exposed by the Stencil Library.
 * "luxury" is new — it is not present in @workspace/stencil-registry.
 */
export type StencilLibraryId =
  | "blog"
  | "magazine"
  | "documentation"
  | "luxury"
  | "agency"
  | "portfolio";

// ── Route definition ───────────────────────────────────────────────────────────

export type CacheStrategy = "static" | "isr" | "dynamic";

export interface StencilRoute {
  /** Short machine-readable identifier */
  id: string;
  /** URL pattern; colon-prefixed segments are dynamic, e.g. "/posts/:slug" */
  pattern: string;
  /** Equivalent page type in the generation pipeline */
  pageType: PageType;
  /** True when the pattern contains dynamic segments */
  isDynamic: boolean;
  /** True for listing/index pages (no slug) */
  isIndex: boolean;
  /** Data sources this route needs resolved before render */
  dataRequirements: string[];
  /** Recommended caching strategy for deployment */
  cacheStrategy: CacheStrategy;
  /** Human-readable purpose of this route */
  purpose: string;
}

// ── Hero spec ─────────────────────────────────────────────────────────────────

export type HeroVariant =
  | "full-bleed"        // Image/video fills viewport edge-to-edge
  | "split"             // Text left, visual right (or reverse)
  | "centered"          // Text and CTA centred, clean background
  | "editorial"         // Feature image above or alongside short headline
  | "magazine-cover"    // Large image dominates, text overlaid at bottom
  | "minimal";          // Text-only, no background media

export type HeroHeight =
  | "full-screen"  // 100vh
  | "80vh"
  | "60vh"
  | "50vh"
  | "auto";        // Content-driven height

export type AnimationStyle = "none" | "fade" | "slide" | "scale" | "parallax";

export interface HeroSpec {
  /** Visual layout variant */
  variant: HeroVariant;
  /** Minimum height of the hero section */
  height: HeroHeight;
  /** Whether the hero uses a full-bleed image or video background */
  hasBackgroundMedia: boolean;
  /** Whether a semi-transparent overlay sits between media and text */
  hasOverlay: boolean;
  /** Fraction opacity of the overlay, 0–1 (0 when no overlay) */
  overlayOpacity: number;
  /** Primary text alignment within the hero */
  textPosition: "left" | "center" | "right";
  /** Number of CTA buttons rendered in the hero */
  ctaButtons: number;
  /** Labels for primary and secondary CTA */
  ctaLabels: string[];
  /** Small eyebrow label above the headline (section name, role, tagline) */
  hasKicker: boolean;
  /** Subtitle or supporting paragraph below headline */
  hasSubheadline: boolean;
  /** Entrance animation applied to hero text/media */
  animationStyle: AnimationStyle;
  /** Components that compose the hero section */
  components: ComponentType[];
}

// ── Card spec ─────────────────────────────────────────────────────────────────

export type CardLayout =
  | "grid"            // Equal-width columns
  | "featured-grid"   // First card is hero-size, remaining smaller
  | "list"            // Full-width vertical list
  | "masonry"         // Pinterest-style variable height
  | "horizontal-list" // Horizontal scroll or horizontal card rows
  | "single-column";  // Centered, narrow column (docs/blog detail)

export type CardType =
  | "standard"    // Image top, text below
  | "editorial"   // Large image, editorial typography
  | "feature"     // Large card — hero within a grid
  | "overlay"     // Text overlaid on image (opacity layer)
  | "horizontal"  // Image left, text right
  | "minimal";    // Text only (no image)

export type AspectRatio = "16:9" | "4:3" | "3:2" | "1:1" | "4:5" | "auto";
export type HoverEffect = "none" | "lift" | "scale" | "border-accent" | "overlay";

export interface CardColumns {
  desktop: number;
  tablet: number;
  mobile: number;
}

export interface CardSpec {
  /** Grid arrangement of cards on index/listing pages */
  layout: CardLayout;
  /** Column count per breakpoint */
  columns: CardColumns;
  /** Visual style of individual card components */
  cardType: CardType;
  /** Whether the card renders a thumbnail/cover image */
  hasImage: boolean;
  /** Whether an author avatar + name is shown */
  hasAuthor: boolean;
  /** Whether the publication date is shown */
  hasDate: boolean;
  /** Whether the content category is shown */
  hasCategory: boolean;
  /** Whether a text excerpt is shown */
  hasExcerpt: boolean;
  /** Whether estimated reading time is shown */
  hasReadTime: boolean;
  /** Aspect ratio of the card's cover image */
  aspectRatio: AspectRatio;
  /** Hover interaction applied to the card */
  hoverEffect: HoverEffect;
  /** Max number of lines for excerpt before truncation */
  excerptLines: number;
}

// ── Navigation spec ────────────────────────────────────────────────────────────

export type NavStyle = "horizontal" | "sidebar" | "minimal";
export type NavPosition = "fixed" | "sticky" | "static";
export type NavBackground = "solid" | "transparent" | "blur" | "transparent-to-solid";
export type MobileNavStyle = "hamburger" | "bottom-bar" | "drawer";

export interface NavSpec {
  /** Structural nav style (horizontal top bar vs sidebar) */
  style: NavStyle;
  /** CSS position behaviour */
  position: NavPosition;
  /** Background treatment of the nav bar */
  background: NavBackground;
  /** Mobile nav pattern */
  mobileStyle: MobileNavStyle;
  /** Whether the logo is rendered in the nav bar */
  hasLogo: boolean;
  /** Logo position within nav */
  logoPosition: "left" | "center";
  /** Whether a search icon/field is included */
  hasSearch: boolean;
  /** Whether a prominent CTA button sits in the nav */
  hasCta: boolean;
  /** Label of the nav CTA button (empty when hasCta is false) */
  ctaLabel: string;
  /** Max primary nav items before overflow menu */
  maxItems: number;
  /** Whether items have dropdown sub-menus */
  hasDropdowns: boolean;
  /** True when the nav starts transparent over the hero and becomes opaque on scroll */
  isTransparentOnHero: boolean;
  /** Approximate pixel height of the nav bar */
  height: string;
  /** True when the sidebar is always-visible (docs pattern) */
  hasPersistentSidebar: boolean;
}

// ── Footer spec ───────────────────────────────────────────────────────────────

export type FooterLayout = "multi-column" | "centered" | "minimal" | "split";

export interface FooterLinkGroup {
  /** Column heading */
  title: string;
  /** Representative links in this group */
  links: string[];
}

export interface FooterSpec {
  /** Overall footer layout style */
  layout: FooterLayout;
  /** Number of link-group columns */
  columns: number;
  /** Whether a newsletter sign-up form is included */
  hasNewsletter: boolean;
  /** Whether social media icon links are included */
  hasSocialLinks: boolean;
  /** Primary social platforms represented */
  socialPlatforms: string[];
  /** Whether legal/copyright links are present */
  hasLegalLinks: boolean;
  /** Whether the brand logo appears in the footer */
  hasLogo: boolean;
  /** Position of logo within footer */
  logoPosition: "left" | "center";
  /** Descriptive link groups (one per column) */
  linkGroups: FooterLinkGroup[];
}

// ── Stencil metadata ──────────────────────────────────────────────────────────

export type ComplexityLevel = "simple" | "moderate" | "complex";
export type ContentDensity = "sparse" | "moderate" | "dense";

export interface StencilMetadata {
  id: StencilLibraryId;
  displayName: string;
  /** One-line description suitable for UI cards */
  shortDescription: string;
  /** Longer prose description */
  fullDescription: string;
  /** Primary use-case scenarios */
  useCases: string[];
  /** Real-world site categories that match this stencil */
  exampleSiteCategories: string[];
  /** Implementation complexity */
  complexity: ComplexityLevel;
  /** Content types / site goals this stencil excels at */
  bestFor: string[];
  /** Situations where a different stencil would be a better fit */
  avoidFor: string[];
  /** Colour palette strategy note */
  colorStrategy: string;
  /** Typography strategy note */
  typographyStrategy: string;
  /** Content density on listing pages */
  contentDensity: ContentDensity;
  /** Typical total page count range */
  estimatedPageCount: { min: number; max: number };
  /** Searchable tags for registry filtering */
  tags: string[];
  /** Visual keywords to guide design-system overlay selection */
  visualKeywords: string[];
}

// ── Stencil blueprint ─────────────────────────────────────────────────────────

/**
 * StencilBlueprint — the richly-specified stencil definition produced by
 * Phase 4.5.  Extends the sparse registry StencilDefinition with concrete
 * structural data consumed by the generator, assembler, and design system.
 */
export interface StencilBlueprint {
  id: StencilLibraryId;
  displayName: string;
  description: string;
  version: "1.0";

  // ── Content & layout capabilities ─────────────────────────────────────────
  supportedContent: ContentCapability[];
  supportedLayouts: LayoutCapability[];
  supportedPageTypes: PageTypeCapability[];
  supportedNavigationStructures: NavigationStructure[];
  requiredComponents: ComponentType[];
  optionalComponents: ComponentType[];
  primaryPageType: PageType;
  primaryLayout: LayoutType;

  // ── Structural specs (Phase 4.5 additions) ────────────────────────────────
  /** Full set of URL route patterns this stencil defines */
  routes: StencilRoute[];
  /** Hero section structural specification */
  hero: HeroSpec;
  /** Card grid / listing specification for index pages */
  cards: CardSpec;
  /** Navigation bar structural specification */
  navigation: NavSpec;
  /** Footer structural specification */
  footer: FooterSpec;
  /** Stencil metadata for display, filtering, and resolver scoring */
  metadata: StencilMetadata;
}

// ── Enriched registry ─────────────────────────────────────────────────────────

export interface EnrichedRegistryStats {
  totalStencils: number;
  totalRoutes: number;
  totalRequiredComponents: number;
  stencilsWithSidebar: number;
  stencilsWithMegaMenu: number;
  stencilsWithNewsletter: number;
  byComplexity: Record<ComplexityLevel, number>;
  byContentDensity: Record<ContentDensity, number>;
}

export interface EnrichedStencilRegistry {
  version: "1.0";
  generatedAt: string;
  stats: EnrichedRegistryStats;
  blueprints: StencilBlueprint[];
  /** Fast O(1) lookup by StencilLibraryId */
  index: Record<StencilLibraryId, StencilBlueprint>;
}

// ── Resolver types ────────────────────────────────────────────────────────────

export interface ResolverSignals {
  /** Dominant layout type from Visual DNA (e.g. "editorial", "magazine", "luxury") */
  dominantLayoutType?: string;
  /** Detected content types in the crawl */
  contentTypes?: ContentType[];
  /** Detected navigation patterns (e.g. "sidebar", "sticky", "hamburger") */
  navigationPatterns?: string[];
  /** Detected components (e.g. "hero", "cards", "gallery") */
  detectedComponents?: string[];
  /** Number of pages crawled */
  pageCount?: number;
  /** Whether a prominent hero was found */
  hasHero?: boolean;
  /** Whether a sidebar nav was found */
  hasSidebar?: boolean;
}

export interface ResolverScore {
  stencilId: StencilLibraryId;
  score: number;
  confidence: number;
  reason: string;
  signals: Record<string, string | number | boolean>;
}

export interface ResolverResult {
  recommended: StencilLibraryId;
  confidence: number;
  reason: string;
  scores: ResolverScore[];
  blueprint: StencilBlueprint;
}
