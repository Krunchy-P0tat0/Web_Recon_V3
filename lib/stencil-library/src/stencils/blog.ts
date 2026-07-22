/**
 * blog.ts — Blog Stencil Blueprint
 *
 * Personal or editorial blog. Content-first reading experience.
 * Long-form articles, taxonomy navigation (categories + tags),
 * author profiles, and an RSS-ready sitemap.
 *
 * Ideal for: personal blogs, newsletter sites, indie publications,
 *            thought-leadership platforms, tutorial blogs.
 */

import type { StencilBlueprint } from "../types.js";

export const blogBlueprint: StencilBlueprint = {
  id: "blog",
  displayName: "Blog",
  description:
    "Content-first personal or editorial blog with long-form articles, " +
    "full taxonomy (categories, tags), author profiles, related-content " +
    "sidebar, and an RSS-friendly sitemap.",
  version: "1.0",

  // ── Capability declarations ─────────────────────────────────────────────────

  supportedContent: [
    { contentType: "ARTICLE",   support: "primary",   notes: "Long-form posts are the primary content unit." },
    { contentType: "BLOG",      support: "primary",   notes: "Short-form blog entries and news posts." },
    { contentType: "GUIDE",     support: "supported", notes: "How-to guides and tutorials." },
    { contentType: "FAQ",       support: "partial",   notes: "Static FAQ pages when needed." },
    { contentType: "GALLERY",   support: "partial",   notes: "Photo sets embedded inside articles." },
  ],

  supportedLayouts: [
    { layout: "ArticleLayout", usedForPageTypes: ["article", "blog", "guide"], isPrimary: true },
    { layout: "IndexLayout",   usedForPageTypes: ["homepage", "category", "tag", "search"], isPrimary: false },
    { layout: "MinimalLayout", usedForPageTypes: ["not_found", "sitemap_page"], isPrimary: false },
  ],

  supportedNavigationStructures: [
    "primary-header",
    "breadcrumbs",
    "footer-grouped",
    "tag-cloud",
    "pagination",
    "contextual-links",
  ],

  supportedPageTypes: [
    { pageType: "homepage",     isRequired: true,  notes: "Latest posts grid + featured article hero." },
    { pageType: "article",      isRequired: true,  notes: "Individual article with related content sidebar." },
    { pageType: "blog",         isRequired: true,  notes: "Short-form blog posts." },
    { pageType: "guide",        isRequired: false, notes: "How-to and tutorial long-form content." },
    { pageType: "category",     isRequired: true,  notes: "Posts filtered by category." },
    { pageType: "tag",          isRequired: true,  notes: "Posts filtered by tag." },
    { pageType: "search",       isRequired: true,  notes: "Full-text post search results." },
    { pageType: "not_found",    isRequired: true,  notes: "Standard 404 page." },
    { pageType: "sitemap_page", isRequired: true,  notes: "HTML sitemap for discoverability." },
  ],

  requiredComponents: [
    "NavigationBar",
    "ArticleList",
    "ArticleCard",
    "Pagination",
    "Footer",
  ],

  optionalComponents: [
    "HeroSection",
    "FeaturedContent",
    "LatestContent",
    "AuthorBlock",
    "RelatedContent",
    "TagCloud",
    "Breadcrumb",
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
      dataRequirements: ["latestPosts", "featuredPost", "categories"],
      cacheStrategy: "isr",
      purpose: "Homepage — featured article hero + latest posts grid.",
    },
    {
      id: "post-archive",
      pattern: "/posts",
      pageType: "blog",
      isDynamic: false,
      isIndex: true,
      dataRequirements: ["allPosts", "pagination"],
      cacheStrategy: "isr",
      purpose: "Full post archive with pagination.",
    },
    {
      id: "post-detail",
      pattern: "/posts/:slug",
      pageType: "article",
      isDynamic: true,
      isIndex: false,
      dataRequirements: ["post", "relatedPosts", "author"],
      cacheStrategy: "isr",
      purpose: "Individual article page with reading progress and related content.",
    },
    {
      id: "post-dated",
      pattern: "/:year/:month/:slug",
      pageType: "article",
      isDynamic: true,
      isIndex: false,
      dataRequirements: ["post", "relatedPosts", "author"],
      cacheStrategy: "isr",
      purpose: "Date-structured permalink (WordPress-style).",
    },
    {
      id: "category-index",
      pattern: "/category/:slug",
      pageType: "category",
      isDynamic: true,
      isIndex: true,
      dataRequirements: ["categoryPosts", "category", "pagination"],
      cacheStrategy: "isr",
      purpose: "Posts filtered by category, paginated.",
    },
    {
      id: "tag-index",
      pattern: "/tag/:slug",
      pageType: "tag",
      isDynamic: true,
      isIndex: true,
      dataRequirements: ["tagPosts", "tag", "pagination"],
      cacheStrategy: "isr",
      purpose: "Posts filtered by tag, paginated.",
    },
    {
      id: "author-page",
      pattern: "/author/:slug",
      pageType: "article",
      isDynamic: true,
      isIndex: true,
      dataRequirements: ["authorPosts", "author"],
      cacheStrategy: "isr",
      purpose: "Author profile with their published articles.",
    },
    {
      id: "search",
      pattern: "/search",
      pageType: "search",
      isDynamic: false,
      isIndex: false,
      dataRequirements: ["searchIndex"],
      cacheStrategy: "dynamic",
      purpose: "Client-side full-text search over all posts.",
    },
    {
      id: "about",
      pattern: "/about",
      pageType: "article",
      isDynamic: false,
      isIndex: false,
      dataRequirements: ["page"],
      cacheStrategy: "static",
      purpose: "Static about page.",
    },
    {
      id: "sitemap",
      pattern: "/sitemap",
      pageType: "sitemap_page",
      isDynamic: false,
      isIndex: true,
      dataRequirements: ["allPosts", "allCategories", "allTags"],
      cacheStrategy: "isr",
      purpose: "HTML sitemap for search engine discovery.",
    },
    {
      id: "not-found",
      pattern: "/404",
      pageType: "not_found",
      isDynamic: false,
      isIndex: false,
      dataRequirements: ["latestPosts"],
      cacheStrategy: "static",
      purpose: "404 error page with suggested posts.",
    },
  ],

  // ── Hero spec ────────────────────────────────────────────────────────────────

  hero: {
    variant: "editorial",
    height: "60vh",
    hasBackgroundMedia: false,
    hasOverlay: false,
    overlayOpacity: 0,
    textPosition: "left",
    ctaButtons: 1,
    ctaLabels: ["Read Article"],
    hasKicker: true,
    hasSubheadline: true,
    animationStyle: "fade",
    components: ["HeroSection", "FeaturedContent"],
  },

  // ── Card spec ────────────────────────────────────────────────────────────────

  cards: {
    layout: "grid",
    columns: { desktop: 3, tablet: 2, mobile: 1 },
    cardType: "standard",
    hasImage: true,
    hasAuthor: true,
    hasDate: true,
    hasCategory: true,
    hasExcerpt: true,
    hasReadTime: true,
    aspectRatio: "16:9",
    hoverEffect: "lift",
    excerptLines: 3,
  },

  // ── Navigation spec ──────────────────────────────────────────────────────────

  navigation: {
    style: "horizontal",
    position: "sticky",
    background: "blur",
    mobileStyle: "hamburger",
    hasLogo: true,
    logoPosition: "left",
    hasSearch: true,
    hasCta: false,
    ctaLabel: "",
    maxItems: 5,
    hasDropdowns: false,
    isTransparentOnHero: false,
    height: "64px",
    hasPersistentSidebar: false,
  },

  // ── Footer spec ──────────────────────────────────────────────────────────────

  footer: {
    layout: "multi-column",
    columns: 3,
    hasNewsletter: true,
    hasSocialLinks: true,
    socialPlatforms: ["Twitter", "RSS", "Newsletter"],
    hasLegalLinks: true,
    hasLogo: true,
    logoPosition: "left",
    linkGroups: [
      {
        title: "Explore",
        links: ["Latest Posts", "Featured", "Archive", "Topics"],
      },
      {
        title: "Categories",
        links: ["Tech", "Design", "Business", "Life"],
      },
      {
        title: "About",
        links: ["About", "Contact", "Subscribe", "Privacy Policy"],
      },
    ],
  },

  // ── Metadata ─────────────────────────────────────────────────────────────────

  metadata: {
    id: "blog",
    displayName: "Blog",
    shortDescription: "Content-first blog with articles, categories, and tags.",
    fullDescription:
      "A clean, typography-focused blog stencil built for regular publishing cadences. " +
      "Features a featured-article hero on the homepage, a 3-column article grid, " +
      "full taxonomy support (categories + tags), author profiles, related-content " +
      "suggestions, and a newsletter sign-up footer.",
    useCases: [
      "Personal writing blog",
      "Developer or designer portfolio journal",
      "Newsletter-backed publication",
      "Tutorial and how-to site",
      "Thought-leadership platform",
    ],
    exampleSiteCategories: [
      "Personal blogs",
      "Substack-style newsletters",
      "Dev blogs",
      "Design blogs",
    ],
    complexity: "simple",
    bestFor: [
      "Sites where long-form articles are the primary content",
      "Regular publishing cadences (weekly or more)",
      "Author-driven brands",
      "Sites with a strong category or tag taxonomy",
    ],
    avoidFor: [
      "Portfolios with minimal writing",
      "Documentation-heavy sites",
      "Sites requiring complex navigation hierarchies",
    ],
    colorStrategy:
      "Neutral backgrounds (off-white or light grey) with a single accent colour for links and CTAs. " +
      "Readability-first: high contrast body text, generous line height.",
    typographyStrategy:
      "Readable serif or humanist sans for body copy. Strong heading hierarchy (h1–h4). " +
      "Generous line height (1.7–1.8) for long-form comfort.",
    contentDensity: "moderate",
    estimatedPageCount: { min: 10, max: 500 },
    tags: ["blog", "editorial", "writing", "articles", "publishing", "newsletter"],
    visualKeywords: ["clean", "readable", "typographic", "minimal", "light"],
  },
};
