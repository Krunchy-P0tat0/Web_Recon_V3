/**
 * component-styling.ts — Generates per-component style rules from design strategy
 *
 * Produces styling rules for Hero, Cards, Navigation, Gallery, Search, Footer,
 * plus detailed HeroStyle, CardStyle, and NavigationStyle structs.
 */

import type {
  SiteClassification,
  ColorPalette,
  LayoutSystem,
  DensityProfile,
  ComponentStyling,
  ComponentStyleRule,
  HeroStyle,
  CardStyle,
  NavigationStyle,
} from "./types";

// ---------------------------------------------------------------------------
// Hero style profiles per design strategy
// ---------------------------------------------------------------------------

const HERO_STYLES: Record<string, HeroStyle> = {
  elegant: {
    layout:         "split-content-image",
    overlayOpacity: 0.35,
    overlayColor:   "rgba(0,0,0,0.35)",
    textColor:      "#ffffff",
    minHeight:      "75vh",
    headlineSize:   "4xl",
    ctaStyle:       "outlined",
    ctaBorderRadius: "2px",
  },
  readable: {
    layout:         "text-centered",
    overlayOpacity: 0,
    overlayColor:   "transparent",
    textColor:      "var(--color-text-primary)",
    minHeight:      "40vh",
    headlineSize:   "3xl",
    ctaStyle:       "filled",
    ctaBorderRadius: "6px",
  },
  minimal: {
    layout:         "full-bleed-image",
    overlayOpacity: 0.2,
    overlayColor:   "rgba(0,0,0,0.2)",
    textColor:      "#ffffff",
    minHeight:      "100vh",
    headlineSize:   "5xl",
    ctaStyle:       "ghost",
    ctaBorderRadius: "0px",
  },
  bold: {
    layout:         "full-bleed-image",
    overlayOpacity: 0.5,
    overlayColor:   "rgba(0,0,0,0.5)",
    textColor:      "#ffffff",
    minHeight:      "80vh",
    headlineSize:   "4xl",
    ctaStyle:       "filled",
    ctaBorderRadius: "8px",
  },
  professional: {
    layout:         "split-content-image",
    overlayOpacity: 0,
    overlayColor:   "transparent",
    textColor:      "var(--color-text-primary)",
    minHeight:      "60vh",
    headlineSize:   "3xl",
    ctaStyle:       "filled",
    ctaBorderRadius: "6px",
  },
  friendly: {
    layout:         "text-centered",
    overlayOpacity: 0.1,
    overlayColor:   "rgba(0,0,0,0.1)",
    textColor:      "var(--color-text-primary)",
    minHeight:      "50vh",
    headlineSize:   "3xl",
    ctaStyle:       "filled",
    ctaBorderRadius: "999px",
  },
  modern: {
    layout:         "split-content-image",
    overlayOpacity: 0,
    overlayColor:   "transparent",
    textColor:      "var(--color-text-primary)",
    minHeight:      "70vh",
    headlineSize:   "4xl",
    ctaStyle:       "filled",
    ctaBorderRadius: "10px",
  },
  dense: {
    layout:         "text-left",
    overlayOpacity: 0,
    overlayColor:   "transparent",
    textColor:      "var(--color-text-primary)",
    minHeight:      "auto",
    headlineSize:   "2xl",
    ctaStyle:       "text-link",
    ctaBorderRadius: "4px",
  },
  immersive: {
    layout:         "full-bleed-image",
    overlayOpacity: 0.45,
    overlayColor:   "rgba(0,0,0,0.45)",
    textColor:      "#ffffff",
    minHeight:      "100vh",
    headlineSize:   "5xl",
    ctaStyle:       "outlined",
    ctaBorderRadius: "4px",
  },
};

// ---------------------------------------------------------------------------
// Card style profiles per density
// ---------------------------------------------------------------------------

const CARD_STYLES: Record<string, CardStyle> = {
  dense: {
    layout:        "horizontal",
    imagePosition: "left",
    showCategory:  true,
    showDate:      true,
    showReadTime:  false,
    showAuthor:    false,
    hoverEffect:   "border-accent",
  },
  balanced: {
    layout:        "vertical",
    imagePosition: "top",
    showCategory:  true,
    showDate:      true,
    showReadTime:  true,
    showAuthor:    false,
    hoverEffect:   "lift",
  },
  visual: {
    layout:        "overlay",
    imagePosition: "background",
    showCategory:  true,
    showDate:      false,
    showReadTime:  false,
    showAuthor:    false,
    hoverEffect:   "scale",
  },
};

// ---------------------------------------------------------------------------
// Navigation style profiles per design strategy
// ---------------------------------------------------------------------------

const NAV_STYLES: Record<string, NavigationStyle> = {
  elegant:      { position: "sticky", background: "solid",       height: "72px", logoPosition: "center", mobileStyle: "drawer" },
  readable:     { position: "sticky", background: "solid",       height: "60px", logoPosition: "left",   mobileStyle: "hamburger" },
  minimal:      { position: "fixed",  background: "transparent", height: "80px", logoPosition: "left",   mobileStyle: "drawer" },
  bold:         { position: "sticky", background: "solid",       height: "68px", logoPosition: "left",   mobileStyle: "hamburger" },
  professional: { position: "sticky", background: "solid",       height: "64px", logoPosition: "left",   mobileStyle: "hamburger" },
  friendly:     { position: "sticky", background: "blur",        height: "64px", logoPosition: "left",   mobileStyle: "hamburger" },
  modern:       { position: "sticky", background: "blur",        height: "72px", logoPosition: "left",   mobileStyle: "drawer" },
  dense:        { position: "sticky", background: "solid",       height: "56px", logoPosition: "left",   mobileStyle: "hamburger" },
  immersive:    { position: "fixed",  background: "transparent", height: "80px", logoPosition: "center", mobileStyle: "drawer" },
};

// ---------------------------------------------------------------------------
// Component style rule builder
// ---------------------------------------------------------------------------

function buildRules(
  classification: SiteClassification,
  _palette: ColorPalette,
  layout: LayoutSystem,
): ComponentStyleRule[] {
  const r = layout.cardBorderRadius;
  const shadow = layout.cardShadow;
  const shadowToken = shadow === "none" ? "shadow-none" : shadow === "subtle" ? "shadow-sm" : shadow === "medium" ? "shadow-md" : "shadow-lg";

  const components = [
    "HeroSection",
    "ArticleCard",
    "CategoryCard",
    "GalleryCard",
    "NavigationBar",
    "Footer",
    "SearchBox",
    "SearchResults",
    "Breadcrumb",
    "ArticleGrid",
    "GalleryGrid",
    "FilterBar",
    "Pagination",
    "AuthorBlock",
    "RelatedContent",
    "TableOfContents",
    "TagCloud",
    "SitemapTree",
  ] as const;

  return components.map((component): ComponentStyleRule => ({
    component,
    variant:          "default",
    backgroundToken:  component === "HeroSection" ? "color.neutral.900" : "color.semantic.surface",
    textToken:        "color.semantic.textPrimary",
    borderToken:      layout.cardBorder ? "color.semantic.border" : "none",
    paddingToken:     component === "HeroSection" ? "spacing.16" : "spacing.6",
    borderRadiusToken: `radius.${r}`,
    shadowToken,
    fontToken:        component.includes("Card") ? "typography.heading" : "typography.body",
    notes:            `${classification.designStrategy} strategy — ${component}`,
  }));
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function deriveComponentStyling(
  classification: SiteClassification,
  palette: ColorPalette,
  layout: LayoutSystem,
  density: DensityProfile,
): ComponentStyling {
  const heroStyle = HERO_STYLES[classification.designStrategy] ?? HERO_STYLES["professional"];
  const cardStyle = CARD_STYLES[density.density] ?? CARD_STYLES["balanced"];
  const navStyle  = NAV_STYLES[classification.designStrategy]  ?? NAV_STYLES["professional"];
  const rules     = buildRules(classification, palette, layout);

  return {
    rules,
    hero:    heroStyle,
    card:    cardStyle,
    navigation: navStyle,
    derivationReasoning: `Component styling derived from design strategy "${classification.designStrategy}" and content density "${density.density}". Hero: ${heroStyle.layout}, Cards: ${cardStyle.layout}, Navigation: ${navStyle.background} ${navStyle.position}.`,
  };
}
