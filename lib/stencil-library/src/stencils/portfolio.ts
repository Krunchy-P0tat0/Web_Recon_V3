/**
 * portfolio.ts — Portfolio Stencil Blueprint
 *
 * Personal creative portfolio. Showcases individual work, skills, and
 * bio. Minimal navigation, focused content, and a strong call to hire.
 * Optional blog section for writing.
 *
 * Ideal for: freelance designers, developers, photographers, illustrators,
 *            UX/UI professionals, and creative generalists.
 */

import type { StencilBlueprint } from "../types.js";

export const portfolioBlueprint: StencilBlueprint = {
  id: "portfolio",
  displayName: "Portfolio",
  description:
    "Personal creative portfolio with work showcase, bio, skills, " +
    "and a hire-me CTA. Clean and focused with optional writing section.",
  version: "1.0",

  // ── Capability declarations ─────────────────────────────────────────────────

  supportedContent: [
    { contentType: "PORTFOLIO",    support: "primary",   notes: "Work samples, case studies, and project pages." },
    { contentType: "LANDING_PAGE", support: "primary",   notes: "Bio, skills, and resume pages." },
    { contentType: "GALLERY",      support: "supported", notes: "Visual work galleries and process shots." },
    { contentType: "ARTICLE",      support: "partial",   notes: "Writing and case-study prose." },
    { contentType: "FAQ",          support: "partial",   notes: "FAQs for hiring or working together." },
  ],

  supportedLayouts: [
    { layout: "PortfolioLayout", usedForPageTypes: ["portfolio", "gallery"], isPrimary: true },
    { layout: "LandingLayout",   usedForPageTypes: ["homepage", "landing"],  isPrimary: false },
    { layout: "ArticleLayout",   usedForPageTypes: ["article", "faq"],      isPrimary: false },
    { layout: "MinimalLayout",   usedForPageTypes: ["not_found"],            isPrimary: false },
  ],

  supportedNavigationStructures: [
    "primary-header",
    "footer-grouped",
    "breadcrumbs",
    "pagination",
    "contextual-links",
  ],

  supportedPageTypes: [
    { pageType: "homepage",     isRequired: true,  notes: "Centred hero with role, name, and dual CTA." },
    { pageType: "portfolio",    isRequired: true,  notes: "Work grid and individual project pages." },
    { pageType: "landing",      isRequired: true,  notes: "About, skills, and resume pages." },
    { pageType: "gallery",      isRequired: false, notes: "Visual gallery / photography showcase." },
    { pageType: "article",      isRequired: false, notes: "Writing, case studies, reflections." },
    { pageType: "faq",          isRequired: false, notes: "Hiring and collaboration FAQ." },
    { pageType: "not_found",    isRequired: true,  notes: "Standard 404 page." },
    { pageType: "sitemap_page", isRequired: false, notes: "HTML sitemap." },
  ],

  requiredComponents: [
    "HeroSection",
    "NavigationBar",
    "PortfolioGrid",
    "PortfolioCard",
    "Footer",
  ],

  optionalComponents: [
    "GalleryGrid",
    "GalleryLightbox",
    "AuthorBlock",
    "ArticleList",
    "ArticleCard",
    "FeaturedContent",
    "FAQAccordion",
    "MetaTags",
    "OpenGraphTags",
    "StructuredData",
  ],

  primaryPageType: "portfolio",
  primaryLayout: "PortfolioLayout",

  // ── Routes ──────────────────────────────────────────────────────────────────

  routes: [
    {
      id: "homepage",
      pattern: "/",
      pageType: "homepage",
      isDynamic: false,
      isIndex: true,
      dataRequirements: ["bioInfo", "featuredWork", "skills"],
      cacheStrategy: "static",
      purpose: "Personal landing page: name, role, centred hero, featured projects.",
    },
    {
      id: "work-index",
      pattern: "/work",
      pageType: "portfolio",
      isDynamic: false,
      isIndex: true,
      dataRequirements: ["projects", "categories"],
      cacheStrategy: "static",
      purpose: "Full portfolio grid — all projects.",
    },
    {
      id: "work-detail",
      pattern: "/work/:slug",
      pageType: "portfolio",
      isDynamic: true,
      isIndex: false,
      dataRequirements: ["project", "relatedProjects"],
      cacheStrategy: "static",
      purpose: "Individual project case study page.",
    },
    {
      id: "about",
      pattern: "/about",
      pageType: "landing",
      isDynamic: false,
      isIndex: false,
      dataRequirements: ["bio", "timeline", "skills"],
      cacheStrategy: "static",
      purpose: "Detailed bio and personal story page.",
    },
    {
      id: "skills",
      pattern: "/skills",
      pageType: "landing",
      isDynamic: false,
      isIndex: false,
      dataRequirements: ["skills", "tools", "expertise"],
      cacheStrategy: "static",
      purpose: "Skills, tools, and technical expertise overview.",
    },
    {
      id: "resume",
      pattern: "/resume",
      pageType: "landing",
      isDynamic: false,
      isIndex: false,
      dataRequirements: ["cvData"],
      cacheStrategy: "static",
      purpose: "Online CV / résumé with PDF download link.",
    },
    {
      id: "contact",
      pattern: "/contact",
      pageType: "landing",
      isDynamic: false,
      isIndex: false,
      dataRequirements: ["contactInfo"],
      cacheStrategy: "static",
      purpose: "Contact and hire-me page with form.",
    },
    {
      id: "blog-index",
      pattern: "/blog",
      pageType: "article",
      isDynamic: false,
      isIndex: true,
      dataRequirements: ["posts"],
      cacheStrategy: "isr",
      purpose: "Writing and reflection articles index (optional).",
    },
    {
      id: "blog-post",
      pattern: "/blog/:slug",
      pageType: "article",
      isDynamic: true,
      isIndex: false,
      dataRequirements: ["post", "relatedPosts"],
      cacheStrategy: "isr",
      purpose: "Individual blog or case-study post.",
    },
    {
      id: "not-found",
      pattern: "/404",
      pageType: "not_found",
      isDynamic: false,
      isIndex: false,
      dataRequirements: [],
      cacheStrategy: "static",
      purpose: "404 page with portfolio CTA.",
    },
  ],

  // ── Hero spec ────────────────────────────────────────────────────────────────

  hero: {
    variant: "centered",
    height: "80vh",
    hasBackgroundMedia: false,
    hasOverlay: false,
    overlayOpacity: 0,
    textPosition: "center",
    ctaButtons: 2,
    ctaLabels: ["View My Work", "Contact Me"],
    hasKicker: true,
    hasSubheadline: true,
    animationStyle: "scale",
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
    aspectRatio: "4:3",
    hoverEffect: "scale",
    excerptLines: 0,
  },

  // ── Navigation spec ──────────────────────────────────────────────────────────

  navigation: {
    style: "horizontal",
    position: "sticky",
    background: "solid",
    mobileStyle: "hamburger",
    hasLogo: true,
    logoPosition: "left",
    hasSearch: false,
    hasCta: true,
    ctaLabel: "Hire Me",
    maxItems: 4,
    hasDropdowns: false,
    isTransparentOnHero: false,
    height: "60px",
    hasPersistentSidebar: false,
  },

  // ── Footer spec ──────────────────────────────────────────────────────────────

  footer: {
    layout: "centered",
    columns: 1,
    hasNewsletter: false,
    hasSocialLinks: true,
    socialPlatforms: ["GitHub", "LinkedIn", "Twitter", "Dribbble"],
    hasLegalLinks: false,
    hasLogo: true,
    logoPosition: "center",
    linkGroups: [
      {
        title: "Quick Links",
        links: ["Work", "About", "Skills", "Resume", "Contact"],
      },
    ],
  },

  // ── Metadata ─────────────────────────────────────────────────────────────────

  metadata: {
    id: "portfolio",
    displayName: "Portfolio",
    shortDescription: "Personal creative portfolio with work showcase and bio.",
    fullDescription:
      "A focused personal portfolio stencil for designers, developers, and creatives. " +
      "Centred hero with role and dual CTA, a masonry project grid, individual project " +
      "case study pages, about and skills pages, an online résumé, and an optional blog. " +
      "Minimal navigation (4 items max) keeps focus on the work.",
    useCases: [
      "Freelance designer portfolio",
      "Developer showcase",
      "Photographer portfolio",
      "UX/UI professional site",
      "Creative generalist showcase",
      "Illustrator or motion designer portfolio",
    ],
    exampleSiteCategories: [
      "Design portfolios",
      "Dev profiles",
      "Photographer sites",
      "Creative freelancers",
    ],
    complexity: "simple",
    bestFor: [
      "Individual creatives showcasing a body of work",
      "Sites where the portfolio grid is the primary experience",
      "People who want a simple hire-me funnel",
      "Sites with fewer than 30 projects",
    ],
    avoidFor: [
      "Agencies or teams with multiple members",
      "High-content editorial sites",
      "Products or services requiring complex navigation",
    ],
    colorStrategy:
      "Neutral palette with a single strong accent colour for CTAs and hover states. " +
      "Let the project imagery carry the visual interest. " +
      "White or very light backgrounds for maximum image legibility.",
    typographyStrategy:
      "Modern, geometric sans-serif for name and headings — conveys craft and precision. " +
      "Clean, readable sans for body. Larger-than-average heading for name/role display.",
    contentDensity: "sparse",
    estimatedPageCount: { min: 5, max: 50 },
    tags: ["portfolio", "personal", "creative", "freelance", "showcase", "hire"],
    visualKeywords: ["clean", "personal", "minimal", "focused", "crafted"],
  },
};
