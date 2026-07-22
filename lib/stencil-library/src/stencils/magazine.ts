/**
 * magazine.ts — Magazine Stencil Blueprint
 *
 * High-volume editorial publication. Multiple content sections, editorial
 * curation, mega-menu navigation, and mixed media. Scales to thousands
 * of articles across many categories.
 *
 * Ideal for: online magazines, news sites, multi-section publications,
 *            industry trade media, lifestyle editorial brands.
 */

import type { StencilBlueprint } from "../types.js";

export const magazineBlueprint: StencilBlueprint = {
  id: "magazine",
  displayName: "Magazine",
  description:
    "High-volume editorial or news magazine. Multiple content sections, " +
    "editorial curation, mega-menu navigation, gallery support, and " +
    "category-driven discovery. Scales to thousands of articles.",
  version: "1.0",

  // ── Capability declarations ─────────────────────────────────────────────────

  supportedContent: [
    { contentType: "ARTICLE",   support: "primary",   notes: "News stories, features, and opinion pieces." },
    { contentType: "BLOG",      support: "supported", notes: "Commentary and editor blogs." },
    { contentType: "GUIDE",     support: "supported", notes: "Long-form guides and special reports." },
    { contentType: "GALLERY",   support: "supported", notes: "Photo stories and editorial galleries." },
    { contentType: "FAQ",       support: "partial",   notes: "Section-specific FAQ pages." },
  ],

  supportedLayouts: [
    { layout: "ArticleLayout", usedForPageTypes: ["article", "blog", "guide"], isPrimary: true },
    { layout: "IndexLayout",   usedForPageTypes: ["homepage", "category", "tag", "search"], isPrimary: false },
    { layout: "LandingLayout", usedForPageTypes: ["landing"], isPrimary: false },
    { layout: "GalleryLayout", usedForPageTypes: ["gallery"], isPrimary: false },
    { layout: "MinimalLayout", usedForPageTypes: ["not_found", "sitemap_page"], isPrimary: false },
  ],

  supportedNavigationStructures: [
    "primary-header",
    "mega-menu",
    "breadcrumbs",
    "category-tree",
    "footer-grouped",
    "pagination",
    "tag-cloud",
    "contextual-links",
  ],

  supportedPageTypes: [
    { pageType: "homepage",     isRequired: true,  notes: "Editorial front page with curated sections." },
    { pageType: "article",      isRequired: true,  notes: "Individual article with rich metadata." },
    { pageType: "blog",         isRequired: true,  notes: "Editor blog and commentary." },
    { pageType: "guide",        isRequired: false, notes: "Long-form special report pages." },
    { pageType: "category",     isRequired: true,  notes: "Section index with article grid." },
    { pageType: "tag",          isRequired: true,  notes: "Tag archive pages." },
    { pageType: "gallery",      isRequired: true,  notes: "Photo essays and editorial galleries." },
    { pageType: "landing",      isRequired: false, notes: "Campaign and sponsorship landing pages." },
    { pageType: "search",       isRequired: true,  notes: "Site-wide search." },
    { pageType: "not_found",    isRequired: true,  notes: "Standard 404 page." },
    { pageType: "sitemap_page", isRequired: true,  notes: "HTML sitemap for SEO." },
  ],

  requiredComponents: [
    "NavigationBar",
    "ArticleGrid",
    "ArticleCard",
    "ArticleList",
    "CategoryListing",
    "Pagination",
    "Footer",
  ],

  optionalComponents: [
    "HeroSection",
    "FeaturedContent",
    "LatestContent",
    "CategoryHighlights",
    "AuthorBlock",
    "RelatedContent",
    "TagCloud",
    "FilterBar",
    "Breadcrumb",
    "GalleryGrid",
    "GalleryLightbox",
    "SearchBox",
    "SearchResults",
    "TableOfContents",
    "MetaTags",
    "OpenGraphTags",
    "StructuredData",
  ],

  primaryPageType: "article",
  primaryLayout: "ArticleLayout",

  // ── Routes ──────────────────────────────────────────────────────────────────

  routes: [
    {
      id: "homepage",
      pattern: "/",
      pageType: "homepage",
      isDynamic: false,
      isIndex: true,
      dataRequirements: ["featuredArticles", "sectionHighlights", "sections"],
      cacheStrategy: "isr",
      purpose: "Editorial front page: cover story hero + section highlights.",
    },
    {
      id: "section-index",
      pattern: "/:section",
      pageType: "category",
      isDynamic: true,
      isIndex: true,
      dataRequirements: ["sectionArticles", "section", "pagination"],
      cacheStrategy: "isr",
      purpose: "Section index — articles filtered to a top-level section.",
    },
    {
      id: "article-in-section",
      pattern: "/:section/:slug",
      pageType: "article",
      isDynamic: true,
      isIndex: false,
      dataRequirements: ["article", "relatedArticles", "author", "section"],
      cacheStrategy: "isr",
      purpose: "Individual article scoped to a section.",
    },
    {
      id: "article-flat",
      pattern: "/article/:slug",
      pageType: "article",
      isDynamic: true,
      isIndex: false,
      dataRequirements: ["article", "relatedArticles", "author"],
      cacheStrategy: "isr",
      purpose: "Flat article URL for syndicated or cross-section content.",
    },
    {
      id: "tag-index",
      pattern: "/tag/:slug",
      pageType: "tag",
      isDynamic: true,
      isIndex: true,
      dataRequirements: ["tagArticles", "tag", "pagination"],
      cacheStrategy: "isr",
      purpose: "Articles tagged with a specific keyword.",
    },
    {
      id: "gallery",
      pattern: "/gallery/:slug",
      pageType: "gallery",
      isDynamic: true,
      isIndex: false,
      dataRequirements: ["gallery", "relatedGalleries"],
      cacheStrategy: "isr",
      purpose: "Photo essay or editorial gallery lightbox.",
    },
    {
      id: "search",
      pattern: "/search",
      pageType: "search",
      isDynamic: false,
      isIndex: false,
      dataRequirements: ["searchIndex"],
      cacheStrategy: "dynamic",
      purpose: "Site-wide full-text search results.",
    },
    {
      id: "subscribe",
      pattern: "/subscribe",
      pageType: "landing",
      isDynamic: false,
      isIndex: false,
      dataRequirements: [],
      cacheStrategy: "static",
      purpose: "Newsletter subscription landing page.",
    },
    {
      id: "about",
      pattern: "/about",
      pageType: "landing",
      isDynamic: false,
      isIndex: false,
      dataRequirements: ["teamMembers"],
      cacheStrategy: "static",
      purpose: "About the publication — editorial team and mission.",
    },
    {
      id: "sitemap",
      pattern: "/sitemap",
      pageType: "sitemap_page",
      isDynamic: false,
      isIndex: true,
      dataRequirements: ["allArticles", "allSections", "allTags"],
      cacheStrategy: "isr",
      purpose: "HTML sitemap for SEO and discoverability.",
    },
    {
      id: "not-found",
      pattern: "/404",
      pageType: "not_found",
      isDynamic: false,
      isIndex: false,
      dataRequirements: ["latestArticles"],
      cacheStrategy: "static",
      purpose: "404 error page with latest headlines.",
    },
  ],

  // ── Hero spec ────────────────────────────────────────────────────────────────

  hero: {
    variant: "magazine-cover",
    height: "80vh",
    hasBackgroundMedia: true,
    hasOverlay: true,
    overlayOpacity: 0.45,
    textPosition: "center",
    ctaButtons: 1,
    ctaLabels: ["Read Now"],
    hasKicker: true,
    hasSubheadline: true,
    animationStyle: "fade",
    components: ["HeroSection", "FeaturedContent"],
  },

  // ── Card spec ────────────────────────────────────────────────────────────────

  cards: {
    layout: "featured-grid",
    columns: { desktop: 3, tablet: 2, mobile: 1 },
    cardType: "editorial",
    hasImage: true,
    hasAuthor: true,
    hasDate: true,
    hasCategory: true,
    hasExcerpt: false,
    hasReadTime: false,
    aspectRatio: "3:2",
    hoverEffect: "overlay",
    excerptLines: 0,
  },

  // ── Navigation spec ──────────────────────────────────────────────────────────

  navigation: {
    style: "horizontal",
    position: "fixed",
    background: "transparent-to-solid",
    mobileStyle: "hamburger",
    hasLogo: true,
    logoPosition: "center",
    hasSearch: true,
    hasCta: true,
    ctaLabel: "Subscribe",
    maxItems: 6,
    hasDropdowns: true,
    isTransparentOnHero: true,
    height: "60px",
    hasPersistentSidebar: false,
  },

  // ── Footer spec ──────────────────────────────────────────────────────────────

  footer: {
    layout: "multi-column",
    columns: 4,
    hasNewsletter: true,
    hasSocialLinks: true,
    socialPlatforms: ["Twitter", "Instagram", "Facebook", "RSS"],
    hasLegalLinks: true,
    hasLogo: true,
    logoPosition: "left",
    linkGroups: [
      {
        title: "Sections",
        links: ["Culture", "Tech", "Business", "Politics"],
      },
      {
        title: "Editorial",
        links: ["About Us", "Masthead", "Contact", "Advertise"],
      },
      {
        title: "Subscribe",
        links: ["Newsletter", "Digital Edition", "Print Edition", "Gift Subscription"],
      },
      {
        title: "Legal",
        links: ["Privacy Policy", "Cookie Policy", "Terms of Use", "Accessibility"],
      },
    ],
  },

  // ── Metadata ─────────────────────────────────────────────────────────────────

  metadata: {
    id: "magazine",
    displayName: "Magazine",
    shortDescription: "High-volume editorial publication with sections and curation.",
    fullDescription:
      "A multi-section editorial stencil for publications that publish frequently " +
      "across distinct content verticals. Features a cover-story hero, a mega-menu " +
      "section navigator, editorial card grid on homepage, gallery support, and a " +
      "full subscription / newsletter funnel.",
    useCases: [
      "Online news magazines",
      "Multi-section lifestyle publications",
      "Industry trade media",
      "Cultural editorial sites",
      "Sponsored content platforms",
    ],
    exampleSiteCategories: [
      "News sites",
      "Lifestyle magazines",
      "Food & culture publications",
      "Technology media",
    ],
    complexity: "complex",
    bestFor: [
      "High-frequency publishing (daily or near-daily)",
      "Multi-section or vertical content organisation",
      "Sites with editorial curation and featured story logic",
      "Publications with subscription funnels",
    ],
    avoidFor: [
      "Sites with fewer than 50 articles",
      "Single-author personal blogs",
      "Portfolios or agency sites",
    ],
    colorStrategy:
      "Bold accent colour for section identifiers. Dark header with light text for editorial authority. " +
      "Section-specific accent colours optional for differentiation.",
    typographyStrategy:
      "Editorial serif for headlines to convey authority. Clean sans for body to aid scan-reading. " +
      "Strong typographic hierarchy across headline sizes.",
    contentDensity: "dense",
    estimatedPageCount: { min: 100, max: 50000 },
    tags: ["magazine", "news", "editorial", "publishing", "media", "journalism"],
    visualKeywords: ["editorial", "authoritative", "bold", "curated", "rich"],
  },
};
