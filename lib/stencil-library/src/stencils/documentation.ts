/**
 * documentation.ts — Documentation Stencil Blueprint
 *
 * Developer documentation, API reference, and technical guides.
 * Sidebar navigation is the primary structure. Full-text search
 * is critical. Step-by-step navigation between pages.
 *
 * Ideal for: open-source project docs, API references, developer
 *            portals, SaaS help centres, SDK guides.
 */

import type { StencilBlueprint } from "../types.js";

export const documentationBlueprint: StencilBlueprint = {
  id: "documentation",
  displayName: "Documentation",
  description:
    "Developer documentation and API reference. Persistent sidebar navigation, " +
    "full-text search, step navigation between pages, and a clean " +
    "reading layout optimised for technical content.",
  version: "1.0",

  // ── Capability declarations ─────────────────────────────────────────────────

  supportedContent: [
    { contentType: "DOCS",     support: "primary",   notes: "API references, guides, and conceptual docs." },
    { contentType: "GUIDE",    support: "primary",   notes: "Step-by-step tutorials and how-to guides." },
    { contentType: "FAQ",      support: "primary",   notes: "Q&A pages for common developer questions." },
    { contentType: "ARTICLE",  support: "supported", notes: "Blog posts (changelog entries, release notes)." },
    { contentType: "BLOG",     support: "partial",   notes: "Developer blog secondary to main docs." },
  ],

  supportedLayouts: [
    { layout: "DocumentationLayout", usedForPageTypes: ["docs", "guide", "faq"], isPrimary: true },
    { layout: "LandingLayout",       usedForPageTypes: ["homepage", "landing"],   isPrimary: false },
    { layout: "ArticleLayout",       usedForPageTypes: ["article", "blog"],       isPrimary: false },
    { layout: "MinimalLayout",       usedForPageTypes: ["not_found"],             isPrimary: false },
  ],

  supportedNavigationStructures: [
    "primary-header",
    "sidebar",
    "breadcrumbs",
    "step-nav",
    "pagination",
    "contextual-links",
    "filter-bar",
  ],

  supportedPageTypes: [
    { pageType: "homepage",     isRequired: true,  notes: "Product landing page with hero and quick-start links." },
    { pageType: "docs",         isRequired: true,  notes: "Documentation page with sidebar and step nav." },
    { pageType: "guide",        isRequired: true,  notes: "Step-by-step tutorial page." },
    { pageType: "faq",          isRequired: true,  notes: "Frequently asked questions page." },
    { pageType: "landing",      isRequired: false, notes: "Feature or integration landing pages." },
    { pageType: "article",      isRequired: false, notes: "Blog/changelog articles." },
    { pageType: "search",       isRequired: true,  notes: "Critical full-text documentation search." },
    { pageType: "not_found",    isRequired: true,  notes: "404 page with search prompt." },
    { pageType: "sitemap_page", isRequired: false, notes: "HTML sitemap for SEO." },
  ],

  requiredComponents: [
    "NavigationBar",
    "Footer",
    "SearchBox",
  ],

  optionalComponents: [
    "HeroSection",
    "TableOfContents",
    "Breadcrumb",
    "SearchResults",
    "RelatedContent",
    "FAQAccordion",
    "MetaTags",
    "OpenGraphTags",
    "StructuredData",
    "ArticleList",
    "ArticleCard",
    "Pagination",
  ],

  primaryPageType: "docs",
  primaryLayout: "DocumentationLayout",

  // ── Routes ──────────────────────────────────────────────────────────────────

  routes: [
    {
      id: "homepage",
      pattern: "/",
      pageType: "homepage",
      isDynamic: false,
      isIndex: true,
      dataRequirements: ["productInfo", "quickstartLinks", "featureHighlights"],
      cacheStrategy: "static",
      purpose: "Product landing page with hero, feature highlights, and Get Started CTA.",
    },
    {
      id: "docs-index",
      pattern: "/docs",
      pageType: "docs",
      isDynamic: false,
      isIndex: true,
      dataRequirements: ["docCategories", "gettingStartedLinks"],
      cacheStrategy: "static",
      purpose: "Documentation home / overview page.",
    },
    {
      id: "docs-page",
      pattern: "/docs/:slug",
      pageType: "docs",
      isDynamic: true,
      isIndex: false,
      dataRequirements: ["docPage", "tableOfContents", "prevNext"],
      cacheStrategy: "static",
      purpose: "Individual documentation page with sidebar and step navigation.",
    },
    {
      id: "docs-category-page",
      pattern: "/docs/:category/:slug",
      pageType: "docs",
      isDynamic: true,
      isIndex: false,
      dataRequirements: ["docPage", "category", "tableOfContents", "prevNext"],
      cacheStrategy: "static",
      purpose: "Categorised documentation page (e.g. /docs/guides/getting-started).",
    },
    {
      id: "api-reference-index",
      pattern: "/api",
      pageType: "docs",
      isDynamic: false,
      isIndex: true,
      dataRequirements: ["apiCategories", "apiEndpoints"],
      cacheStrategy: "static",
      purpose: "API reference overview / index.",
    },
    {
      id: "api-reference-endpoint",
      pattern: "/api/:endpoint",
      pageType: "docs",
      isDynamic: true,
      isIndex: false,
      dataRequirements: ["apiEndpoint", "examples", "prevNext"],
      cacheStrategy: "static",
      purpose: "Individual API endpoint or method reference page.",
    },
    {
      id: "guides-index",
      pattern: "/guides",
      pageType: "guide",
      isDynamic: false,
      isIndex: true,
      dataRequirements: ["guides", "categories"],
      cacheStrategy: "static",
      purpose: "Guides & tutorials index.",
    },
    {
      id: "guide-page",
      pattern: "/guides/:slug",
      pageType: "guide",
      isDynamic: true,
      isIndex: false,
      dataRequirements: ["guide", "tableOfContents", "prevNext"],
      cacheStrategy: "static",
      purpose: "Individual step-by-step guide page.",
    },
    {
      id: "changelog",
      pattern: "/changelog",
      pageType: "article",
      isDynamic: false,
      isIndex: true,
      dataRequirements: ["releases"],
      cacheStrategy: "isr",
      purpose: "Product changelog and release notes.",
    },
    {
      id: "faq",
      pattern: "/faq",
      pageType: "faq",
      isDynamic: false,
      isIndex: false,
      dataRequirements: ["faqItems"],
      cacheStrategy: "static",
      purpose: "Frequently asked questions page.",
    },
    {
      id: "search",
      pattern: "/search",
      pageType: "search",
      isDynamic: false,
      isIndex: false,
      dataRequirements: ["searchIndex"],
      cacheStrategy: "dynamic",
      purpose: "Full-text search across all documentation pages.",
    },
    {
      id: "not-found",
      pattern: "/404",
      pageType: "not_found",
      isDynamic: false,
      isIndex: false,
      dataRequirements: ["popularPages"],
      cacheStrategy: "static",
      purpose: "404 page with search box and popular page suggestions.",
    },
  ],

  // ── Hero spec ────────────────────────────────────────────────────────────────

  hero: {
    variant: "minimal",
    height: "auto",
    hasBackgroundMedia: false,
    hasOverlay: false,
    overlayOpacity: 0,
    textPosition: "left",
    ctaButtons: 2,
    ctaLabels: ["Get Started", "View on GitHub"],
    hasKicker: false,
    hasSubheadline: true,
    animationStyle: "none",
    components: ["HeroSection"],
  },

  // ── Card spec ────────────────────────────────────────────────────────────────

  cards: {
    layout: "list",
    columns: { desktop: 1, tablet: 1, mobile: 1 },
    cardType: "minimal",
    hasImage: false,
    hasAuthor: false,
    hasDate: false,
    hasCategory: true,
    hasExcerpt: true,
    hasReadTime: false,
    aspectRatio: "auto",
    hoverEffect: "border-accent",
    excerptLines: 2,
  },

  // ── Navigation spec ──────────────────────────────────────────────────────────

  navigation: {
    style: "sidebar",
    position: "sticky",
    background: "solid",
    mobileStyle: "drawer",
    hasLogo: true,
    logoPosition: "left",
    hasSearch: true,
    hasCta: true,
    ctaLabel: "Get Started",
    maxItems: 6,
    hasDropdowns: false,
    isTransparentOnHero: false,
    height: "56px",
    hasPersistentSidebar: true,
  },

  // ── Footer spec ──────────────────────────────────────────────────────────────

  footer: {
    layout: "centered",
    columns: 1,
    hasNewsletter: false,
    hasSocialLinks: true,
    socialPlatforms: ["GitHub", "Discord", "Twitter"],
    hasLegalLinks: true,
    hasLogo: true,
    logoPosition: "center",
    linkGroups: [
      {
        title: "Resources",
        links: ["Documentation", "API Reference", "Guides", "Changelog", "Status"],
      },
    ],
  },

  // ── Metadata ─────────────────────────────────────────────────────────────────

  metadata: {
    id: "documentation",
    displayName: "Documentation",
    shortDescription: "Developer docs with sidebar nav, search, and API reference.",
    fullDescription:
      "A clean, information-dense documentation stencil with a persistent sidebar " +
      "navigation, full-text search, step navigation between pages, breadcrumbs, " +
      "table of contents, and a code-friendly reading layout. " +
      "Ideal for open-source projects, developer tools, and SaaS help centres.",
    useCases: [
      "Open-source project documentation",
      "API reference portal",
      "SaaS help centre",
      "Developer SDK guides",
      "Internal technical wiki",
    ],
    exampleSiteCategories: [
      "Dev tool docs",
      "API reference sites",
      "Open-source wikis",
      "Product help centres",
    ],
    complexity: "moderate",
    bestFor: [
      "Technical content that requires sidebar navigation",
      "Sites where search is a primary access pattern",
      "Reference content with many discrete pages",
      "Content organised into categories and subcategories",
    ],
    avoidFor: [
      "Primarily visual or brand-driven sites",
      "Sites without technical or reference content",
      "High-velocity news or editorial publishing",
    ],
    colorStrategy:
      "Neutral, low-saturation backgrounds (white or very light grey). " +
      "Single brand accent for interactive elements, code highlighting, and CTAs. " +
      "Dark mode support strongly recommended.",
    typographyStrategy:
      "Clean, highly readable sans-serif for all body text. " +
      "Monospace for code blocks. Compact type scale (h1–h4 only). " +
      "High contrast; WCAG AA minimum.",
    contentDensity: "dense",
    estimatedPageCount: { min: 20, max: 2000 },
    tags: ["documentation", "developer", "api", "technical", "reference", "guides"],
    visualKeywords: ["clean", "minimal", "technical", "structured", "neutral"],
  },
};
