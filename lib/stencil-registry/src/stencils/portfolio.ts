import type { StencilDefinition } from "../types.js";

/**
 * Portfolio — Creative professional or studio showcase.
 *
 * Work-first layout emphasising visual presentation. Case studies,
 * project galleries, and a minimal-chrome reading experience.
 * Contact and about pages complete the personal brand.
 */
export const portfolioStencil: StencilDefinition = {
  id: "portfolio",
  displayName: "Portfolio",
  description:
    "Creative professional or design studio portfolio. Work-first layout " +
    "with project case studies, photo/video galleries, and a clean personal " +
    "brand presence. Minimal chrome to let the work speak.",
  version: "1.0",

  supportedContent: [
    {
      contentType: "PORTFOLIO",
      support: "primary",
      notes: "Project case studies and work samples.",
    },
    {
      contentType: "GALLERY",
      support: "primary",
      notes: "Full-screen image and video galleries.",
    },
    {
      contentType: "LANDING_PAGE",
      support: "supported",
      notes: "About, contact, and services pages.",
    },
    {
      contentType: "ARTICLE",
      support: "partial",
      notes: "Optional writing/journal section.",
    },
  ],

  supportedLayouts: [
    {
      layout: "PortfolioLayout",
      usedForPageTypes: ["portfolio"],
      isPrimary: true,
    },
    {
      layout: "GalleryLayout",
      usedForPageTypes: ["gallery"],
      isPrimary: false,
    },
    {
      layout: "LandingLayout",
      usedForPageTypes: ["homepage", "landing"],
      isPrimary: false,
    },
    {
      layout: "MinimalLayout",
      usedForPageTypes: ["not_found"],
      isPrimary: false,
    },
    {
      layout: "ArticleLayout",
      usedForPageTypes: ["article"],
      isPrimary: false,
    },
  ],

  supportedNavigationStructures: [
    "primary-header",
    "breadcrumbs",
    "footer-grouped",
    "contextual-links",
    "pagination",
  ],

  supportedPageTypes: [
    { pageType: "homepage",     isRequired: true,  notes: "Hero with selected work highlights." },
    { pageType: "portfolio",    isRequired: true,  notes: "Individual project/case study." },
    { pageType: "gallery",      isRequired: true,  notes: "Image/video gallery for a project." },
    { pageType: "landing",      isRequired: false, notes: "About and contact pages." },
    { pageType: "article",      isRequired: false, notes: "Optional writing or journal." },
    { pageType: "not_found",    isRequired: true,  notes: "Branded 404 page." },
    { pageType: "sitemap_page", isRequired: false, notes: "HTML sitemap." },
  ],

  requiredComponents: [
    "NavigationBar",
    "PortfolioGrid",
    "PortfolioCard",
    "GalleryGrid",
    "Footer",
  ],

  optionalComponents: [
    "HeroSection",
    "GalleryLightbox",
    "FeaturedContent",
    "Breadcrumb",
    "RelatedContent",
    "ArticleList",
    "Pagination",
    "MetaTags",
    "OpenGraphTags",
    "StructuredData",
  ],

  primaryPageType: "portfolio",
  primaryLayout: "PortfolioLayout",
  tags: ["portfolio", "creative", "design", "photography", "studio", "freelance"],
};
