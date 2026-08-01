/**
 * agency.ts — Agency Stencil Blueprint
 *
 * Creative or professional-services agency. Strong brand presence,
 * portfolio case studies, services showcase, team profiles, and
 * a lead-capture contact flow. Visually bold, content-light.
 *
 * Ideal for: digital agencies, design studios, consulting firms,
 *            marketing agencies, creative production houses.
 */

import type { StencilBlueprint } from "../types.js";

export const agencyBlueprint: StencilBlueprint = {
  id: "agency",
  displayName: "Agency",
  description:
    "Creative or professional-services agency site. Strong brand identity, " +
    "services showcase, portfolio of work, team profiles, and lead-capture forms.",
  version: "1.0",

  // ── Capability declarations ─────────────────────────────────────────────────

  supportedContent: [
    { contentType: "LANDING_PAGE", support: "primary",   notes: "Core offering pages — services, about, contact." },
    { contentType: "PORTFOLIO",    support: "primary",   notes: "Case studies and project showcases." },
    { contentType: "GALLERY",      support: "supported", notes: "Work samples and process shots." },
    { contentType: "ARTICLE",      support: "partial",   notes: "Thought-leadership blog; secondary to portfolio." },
    { contentType: "FAQ",          support: "supported", notes: "Services FAQ and process questions." },
  ],

  supportedLayouts: [
    { layout: "LandingLayout",   usedForPageTypes: ["homepage", "landing"], isPrimary: true },
    { layout: "PortfolioLayout", usedForPageTypes: ["portfolio"],           isPrimary: false },
    { layout: "GalleryLayout",   usedForPageTypes: ["gallery"],             isPrimary: false },
    { layout: "ArticleLayout",   usedForPageTypes: ["article", "faq"],     isPrimary: false },
    { layout: "MinimalLayout",   usedForPageTypes: ["not_found"],           isPrimary: false },
  ],

  supportedNavigationStructures: [
    "primary-header",
    "footer-grouped",
    "breadcrumbs",
    "contextual-links",
  ],

  supportedPageTypes: [
    { pageType: "homepage",     isRequired: true,  notes: "Brand hero, services overview, featured work, CTA." },
    { pageType: "landing",      isRequired: true,  notes: "Individual service or campaign pages." },
    { pageType: "portfolio",    isRequired: true,  notes: "Case study detail pages." },
    { pageType: "gallery",      isRequired: false, notes: "Visual work samples." },
    { pageType: "article",      isRequired: false, notes: "Thought-leadership blog." },
    { pageType: "faq",          isRequired: false, notes: "Services and process FAQ." },
    { pageType: "not_found",    isRequired: true,  notes: "Standard 404 page." },
    { pageType: "sitemap_page", isRequired: false, notes: "HTML sitemap for SEO." },
  ],

  requiredComponents: [
    "HeroSection",
    "NavigationBar",
    "PortfolioGrid",
    "Footer",
  ],

  optionalComponents: [
    "PortfolioCard",
    "GalleryGrid",
    "GalleryLightbox",
    "FeaturedContent",
    "FAQAccordion",
    "ArticleList",
    "ArticleCard",
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
      dataRequirements: ["heroContent", "featuredWork", "services", "testimonials"],
      cacheStrategy: "isr",
      purpose: "Agency homepage: brand hero, services summary, selected work, CTA.",
    },
    {
      id: "work-index",
      pattern: "/work",
      pageType: "portfolio",
      isDynamic: false,
      isIndex: true,
      dataRequirements: ["caseStudies", "filters"],
      cacheStrategy: "isr",
      purpose: "Portfolio index — all case studies with service-type filter.",
    },
    {
      id: "work-detail",
      pattern: "/work/:slug",
      pageType: "portfolio",
      isDynamic: true,
      isIndex: false,
      dataRequirements: ["caseStudy", "relatedWork"],
      cacheStrategy: "isr",
      purpose: "Individual case study with challenge, process, and results.",
    },
    {
      id: "services-index",
      pattern: "/services",
      pageType: "landing",
      isDynamic: false,
      isIndex: true,
      dataRequirements: ["services"],
      cacheStrategy: "static",
      purpose: "Services overview page — cards linking to individual service pages.",
    },
    {
      id: "service-detail",
      pattern: "/services/:slug",
      pageType: "landing",
      isDynamic: true,
      isIndex: false,
      dataRequirements: ["service", "relatedWork"],
      cacheStrategy: "static",
      purpose: "Individual service detail page with process and relevant case studies.",
    },
    {
      id: "about",
      pattern: "/about",
      pageType: "landing",
      isDynamic: false,
      isIndex: false,
      dataRequirements: ["teamMembers", "agencyStory"],
      cacheStrategy: "static",
      purpose: "Agency story, values, and team overview.",
    },
    {
      id: "team-index",
      pattern: "/team",
      pageType: "landing",
      isDynamic: false,
      isIndex: true,
      dataRequirements: ["teamMembers"],
      cacheStrategy: "static",
      purpose: "Full team roster grid.",
    },
    {
      id: "team-member",
      pattern: "/team/:slug",
      pageType: "landing",
      isDynamic: true,
      isIndex: false,
      dataRequirements: ["teamMember", "theirWork"],
      cacheStrategy: "static",
      purpose: "Individual team member profile.",
    },
    {
      id: "blog-index",
      pattern: "/blog",
      pageType: "article",
      isDynamic: false,
      isIndex: true,
      dataRequirements: ["posts", "pagination"],
      cacheStrategy: "isr",
      purpose: "Thought-leadership blog index.",
    },
    {
      id: "blog-post",
      pattern: "/blog/:slug",
      pageType: "article",
      isDynamic: true,
      isIndex: false,
      dataRequirements: ["post", "relatedPosts"],
      cacheStrategy: "isr",
      purpose: "Individual blog post / article.",
    },
    {
      id: "contact",
      pattern: "/contact",
      pageType: "landing",
      isDynamic: false,
      isIndex: false,
      dataRequirements: ["contactInfo"],
      cacheStrategy: "static",
      purpose: "Lead-capture contact form with office details.",
    },
    {
      id: "not-found",
      pattern: "/404",
      pageType: "not_found",
      isDynamic: false,
      isIndex: false,
      dataRequirements: [],
      cacheStrategy: "static",
      purpose: "404 page maintaining brand voice.",
    },
  ],

  // ── Hero spec ────────────────────────────────────────────────────────────────

  hero: {
    variant: "split",
    height: "80vh",
    hasBackgroundMedia: true,
    hasOverlay: false,
    overlayOpacity: 0,
    textPosition: "left",
    ctaButtons: 2,
    ctaLabels: ["View Our Work", "Get in Touch"],
    hasKicker: true,
    hasSubheadline: true,
    animationStyle: "slide",
    components: ["HeroSection"],
  },

  // ── Card spec ────────────────────────────────────────────────────────────────

  cards: {
    layout: "grid",
    columns: { desktop: 3, tablet: 2, mobile: 1 },
    cardType: "feature",
    hasImage: true,
    hasAuthor: false,
    hasDate: false,
    hasCategory: true,
    hasExcerpt: false,
    hasReadTime: false,
    aspectRatio: "16:9",
    hoverEffect: "border-accent",
    excerptLines: 0,
  },

  // ── Navigation spec ──────────────────────────────────────────────────────────

  navigation: {
    style: "horizontal",
    position: "fixed",
    background: "transparent-to-solid",
    mobileStyle: "hamburger",
    hasLogo: true,
    logoPosition: "left",
    hasSearch: false,
    hasCta: true,
    ctaLabel: "Get in Touch",
    maxItems: 5,
    hasDropdowns: false,
    isTransparentOnHero: true,
    height: "68px",
    hasPersistentSidebar: false,
  },

  // ── Footer spec ──────────────────────────────────────────────────────────────

  footer: {
    layout: "multi-column",
    columns: 3,
    hasNewsletter: false,
    hasSocialLinks: true,
    socialPlatforms: ["LinkedIn", "Twitter", "Instagram", "Dribbble"],
    hasLegalLinks: true,
    hasLogo: true,
    logoPosition: "left",
    linkGroups: [
      {
        title: "Services",
        links: ["Brand Strategy", "Web Design", "Development", "SEO & Growth"],
      },
      {
        title: "Work",
        links: ["Portfolio", "Case Studies", "Client Stories", "Awards"],
      },
      {
        title: "Contact",
        links: ["Get in Touch", "New Project", "Careers", "Press"],
      },
    ],
  },

  // ── Metadata ─────────────────────────────────────────────────────────────────

  metadata: {
    id: "agency",
    displayName: "Agency",
    shortDescription: "Creative agency with portfolio, services, and team pages.",
    fullDescription:
      "A strong, brand-forward stencil for creative and professional-services agencies. " +
      "Features a split hero with dual CTAs, a portfolio grid for case studies, " +
      "individual service pages, team profiles, a blog for thought leadership, " +
      "and a lead-capture contact page. Visually bold with a fixed transparent nav.",
    useCases: [
      "Digital design agencies",
      "Branding and strategy studios",
      "Development agencies",
      "Marketing and growth firms",
      "Creative production houses",
      "Consulting firms",
    ],
    exampleSiteCategories: [
      "Design studios",
      "Dev agencies",
      "Creative consultancies",
      "Marketing agencies",
    ],
    complexity: "moderate",
    bestFor: [
      "Service-based businesses needing strong case study showcases",
      "Agencies with a distinct brand identity",
      "Sites that need clear service differentiation pages",
      "Lead-generation oriented sites",
    ],
    avoidFor: [
      "Content-heavy editorial sites",
      "E-commerce or product-driven sites",
      "Sites with thousands of articles or listings",
    ],
    colorStrategy:
      "Bold, high-contrast brand colour used consistently for CTAs and accents. " +
      "Dark-on-light or light-on-dark hero. Strong typographic branding. " +
      "Service type differentiation through colour tagging is optional.",
    typographyStrategy:
      "Contemporary sans-serif for headings — conveys professionalism and modernity. " +
      "Clean sans for body. Strong headline weight contrast to create visual impact.",
    contentDensity: "sparse",
    estimatedPageCount: { min: 10, max: 100 },
    tags: ["agency", "services", "portfolio", "creative", "b2b", "branding", "studio"],
    visualKeywords: ["bold", "professional", "structured", "modern", "impactful"],
  },
};
