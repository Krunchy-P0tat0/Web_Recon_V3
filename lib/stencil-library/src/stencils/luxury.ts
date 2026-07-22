/**
 * luxury.ts — Luxury Stencil Blueprint
 *
 * High-end brand and fashion sites. Full-screen media hero, generous
 * whitespace, minimal navigation, portrait-format imagery, and an
 * atmosphere of exclusivity. Content is sparse but visually immersive.
 *
 * Ideal for: luxury fashion houses, jewellery brands, premium lifestyle
 *            brands, high-end hospitality, fine dining, and art galleries.
 *
 * Note: This stencil is new in Phase 4.5 and does not exist in the
 * base @workspace/stencil-registry.
 */

import type { StencilBlueprint } from "../types.js";

export const luxuryBlueprint: StencilBlueprint = {
  id: "luxury",
  displayName: "Luxury",
  description:
    "Immersive, brand-led luxury site. Full-screen video/image hero, " +
    "minimal navigation, portrait photography, generous whitespace, " +
    "and a curated collection or editorial experience.",
  version: "1.0",

  // ── Capability declarations ─────────────────────────────────────────────────

  supportedContent: [
    { contentType: "LANDING_PAGE", support: "primary",   notes: "Brand landing pages and collection launches." },
    { contentType: "GALLERY",      support: "primary",   notes: "Lookbooks, collection imagery, and photo essays." },
    { contentType: "PORTFOLIO",    support: "supported", notes: "Product showcases and heritage storytelling." },
    { contentType: "ARTICLE",      support: "partial",   notes: "Brand editorials and craftsmanship stories." },
    { contentType: "FAQ",          support: "partial",   notes: "Care instructions and brand FAQ." },
  ],

  supportedLayouts: [
    { layout: "LandingLayout",   usedForPageTypes: ["homepage", "landing"], isPrimary: true },
    { layout: "GalleryLayout",   usedForPageTypes: ["gallery", "portfolio"], isPrimary: false },
    { layout: "ArticleLayout",   usedForPageTypes: ["article", "faq"], isPrimary: false },
    { layout: "PortfolioLayout", usedForPageTypes: ["portfolio"], isPrimary: false },
    { layout: "MinimalLayout",   usedForPageTypes: ["not_found"], isPrimary: false },
  ],

  supportedNavigationStructures: [
    "primary-header",
    "footer-grouped",
    "breadcrumbs",
    "contextual-links",
  ],

  supportedPageTypes: [
    { pageType: "homepage",     isRequired: true,  notes: "Full-screen brand hero with single CTA." },
    { pageType: "landing",      isRequired: true,  notes: "Collection or campaign landing pages." },
    { pageType: "gallery",      isRequired: true,  notes: "Collection grid and lookbook galleries." },
    { pageType: "portfolio",    isRequired: false, notes: "Heritage and craftsmanship detail pages." },
    { pageType: "article",      isRequired: false, notes: "Brand editorial stories." },
    { pageType: "faq",          isRequired: false, notes: "Product care and brand questions." },
    { pageType: "not_found",    isRequired: true,  notes: "Minimal 404 page." },
    { pageType: "sitemap_page", isRequired: false, notes: "HTML sitemap for SEO." },
  ],

  requiredComponents: [
    "HeroSection",
    "NavigationBar",
    "GalleryGrid",
    "Footer",
  ],

  optionalComponents: [
    "GalleryLightbox",
    "FeaturedContent",
    "PortfolioCard",
    "PortfolioGrid",
    "FAQAccordion",
    "MetaTags",
    "OpenGraphTags",
    "StructuredData",
  ],

  primaryPageType: "landing",
  primaryLayout: "LandingLayout",

  // ── Routes ──────────────────────────────────────────────────────────────────

  routes: [
    {
      id: "homepage",
      pattern: "/",
      pageType: "homepage",
      isDynamic: false,
      isIndex: true,
      dataRequirements: ["heroContent", "featuredCollection"],
      cacheStrategy: "isr",
      purpose: "Full-screen brand hero with a single 'Explore' CTA.",
    },
    {
      id: "collection-index",
      pattern: "/collection",
      pageType: "gallery",
      isDynamic: false,
      isIndex: true,
      dataRequirements: ["collections"],
      cacheStrategy: "isr",
      purpose: "All collections grid with season and category filters.",
    },
    {
      id: "collection-season",
      pattern: "/collection/:season",
      pageType: "gallery",
      isDynamic: true,
      isIndex: true,
      dataRequirements: ["collection", "products"],
      cacheStrategy: "isr",
      purpose: "Season or category collection grid.",
    },
    {
      id: "product-detail",
      pattern: "/collection/:season/:slug",
      pageType: "landing",
      isDynamic: true,
      isIndex: false,
      dataRequirements: ["product", "relatedProducts"],
      cacheStrategy: "isr",
      purpose: "Product detail page with full-screen imagery.",
    },
    {
      id: "editorial-index",
      pattern: "/editorial",
      pageType: "article",
      isDynamic: false,
      isIndex: true,
      dataRequirements: ["editorials"],
      cacheStrategy: "isr",
      purpose: "Brand editorial stories index.",
    },
    {
      id: "editorial-detail",
      pattern: "/editorial/:slug",
      pageType: "article",
      isDynamic: true,
      isIndex: false,
      dataRequirements: ["editorial", "relatedEditorials"],
      cacheStrategy: "isr",
      purpose: "Individual editorial story — immersive full-width layout.",
    },
    {
      id: "lookbook",
      pattern: "/lookbook",
      pageType: "gallery",
      isDynamic: false,
      isIndex: true,
      dataRequirements: ["lookbooks"],
      cacheStrategy: "isr",
      purpose: "Lookbook gallery index.",
    },
    {
      id: "lookbook-detail",
      pattern: "/lookbook/:slug",
      pageType: "gallery",
      isDynamic: true,
      isIndex: false,
      dataRequirements: ["lookbook"],
      cacheStrategy: "isr",
      purpose: "Individual lookbook gallery with lightbox.",
    },
    {
      id: "about",
      pattern: "/about",
      pageType: "landing",
      isDynamic: false,
      isIndex: false,
      dataRequirements: ["brandStory"],
      cacheStrategy: "static",
      purpose: "Brand heritage and values page.",
    },
    {
      id: "craftmanship",
      pattern: "/craftmanship",
      pageType: "landing",
      isDynamic: false,
      isIndex: false,
      dataRequirements: ["craftStory"],
      cacheStrategy: "static",
      purpose: "Craftsmanship and materials story — brand trust page.",
    },
    {
      id: "stores",
      pattern: "/stores",
      pageType: "landing",
      isDynamic: false,
      isIndex: false,
      dataRequirements: ["storeLocations"],
      cacheStrategy: "static",
      purpose: "Flagship store locator page.",
    },
    {
      id: "contact",
      pattern: "/contact",
      pageType: "landing",
      isDynamic: false,
      isIndex: false,
      dataRequirements: [],
      cacheStrategy: "static",
      purpose: "Contact and concierge service page.",
    },
    {
      id: "not-found",
      pattern: "/404",
      pageType: "not_found",
      isDynamic: false,
      isIndex: false,
      dataRequirements: [],
      cacheStrategy: "static",
      purpose: "Minimal 404 page maintaining brand atmosphere.",
    },
  ],

  // ── Hero spec ────────────────────────────────────────────────────────────────

  hero: {
    variant: "full-bleed",
    height: "full-screen",
    hasBackgroundMedia: true,
    hasOverlay: true,
    overlayOpacity: 0.25,
    textPosition: "center",
    ctaButtons: 1,
    ctaLabels: ["Explore"],
    hasKicker: true,
    hasSubheadline: false,
    animationStyle: "fade",
    components: ["HeroSection"],
  },

  // ── Card spec ────────────────────────────────────────────────────────────────

  cards: {
    layout: "masonry",
    columns: { desktop: 3, tablet: 2, mobile: 1 },
    cardType: "overlay",
    hasImage: true,
    hasAuthor: false,
    hasDate: false,
    hasCategory: true,
    hasExcerpt: false,
    hasReadTime: false,
    aspectRatio: "4:5",
    hoverEffect: "scale",
    excerptLines: 0,
  },

  // ── Navigation spec ──────────────────────────────────────────────────────────

  navigation: {
    style: "horizontal",
    position: "fixed",
    background: "transparent-to-solid",
    mobileStyle: "drawer",
    hasLogo: true,
    logoPosition: "center",
    hasSearch: false,
    hasCta: false,
    ctaLabel: "",
    maxItems: 4,
    hasDropdowns: false,
    isTransparentOnHero: true,
    height: "72px",
    hasPersistentSidebar: false,
  },

  // ── Footer spec ──────────────────────────────────────────────────────────────

  footer: {
    layout: "centered",
    columns: 2,
    hasNewsletter: false,
    hasSocialLinks: true,
    socialPlatforms: ["Instagram", "Pinterest"],
    hasLegalLinks: true,
    hasLogo: true,
    logoPosition: "center",
    linkGroups: [
      {
        title: "Collections",
        links: ["New Arrivals", "Women", "Men", "Accessories"],
      },
      {
        title: "House",
        links: ["About", "Heritage", "Craftmanship", "Stores", "Contact"],
      },
    ],
  },

  // ── Metadata ─────────────────────────────────────────────────────────────────

  metadata: {
    id: "luxury",
    displayName: "Luxury",
    shortDescription: "Immersive luxury brand site with full-screen hero and collections.",
    fullDescription:
      "A visually immersive stencil for high-end brands where atmosphere and identity " +
      "take precedence over content density. Full-screen video/image hero, minimal " +
      "navigation with centred logo, portrait-format collection grid, brand editorial " +
      "section, and a clean centred footer. Designed for fashion, jewellery, hospitality, " +
      "and luxury lifestyle brands.",
    useCases: [
      "Luxury fashion houses",
      "Jewellery and accessories brands",
      "High-end hospitality and hotels",
      "Premium lifestyle brands",
      "Fine dining and gastronomy",
      "Art galleries and auction houses",
    ],
    exampleSiteCategories: [
      "Fashion brands",
      "Luxury goods",
      "Premium hospitality",
      "Art & culture",
    ],
    complexity: "moderate",
    bestFor: [
      "Sites where visual identity and brand atmosphere are paramount",
      "Collections or product lines as primary content",
      "Infrequent publishing — seasonal launches rather than daily content",
      "Sites targeting a high-end or aspirational audience",
    ],
    avoidFor: [
      "High-frequency news or editorial sites",
      "Content-dense technical documentation",
      "Sites needing strong search and taxonomy",
      "Developer tools or SaaS products",
    ],
    colorStrategy:
      "Monochromatic or near-monochromatic palette: black, white, cream, and one " +
      "restrained metallic or jewel accent. Never use bright, high-saturation colours. " +
      "Dark mode is natural for this stencil.",
    typographyStrategy:
      "Elegant serif or refined display typeface for headlines — conveys heritage. " +
      "Light-weight sans for body copy and navigation to provide contrast. " +
      "Wide letter spacing on headings for luxury feel.",
    contentDensity: "sparse",
    estimatedPageCount: { min: 8, max: 80 },
    tags: ["luxury", "fashion", "brand", "immersive", "editorial", "premium", "elegant"],
    visualKeywords: ["immersive", "elegant", "minimal", "dark", "full-bleed", "serif"],
  },
};
