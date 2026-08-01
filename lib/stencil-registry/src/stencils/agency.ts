import type { StencilDefinition } from "../types.js";

/**
 * Agency — Creative and professional services agency.
 *
 * Primary purpose: showcase services, team, and portfolio work with a
 * strong brand presence. Lead-generation oriented. Content-light but
 * visually impactful. Landing pages and portfolio cases dominate.
 */
export const agencyStencil: StencilDefinition = {
  id: "agency",
  displayName: "Agency",
  description:
    "Creative or professional-services agency site. Strong brand identity, " +
    "services showcase, portfolio of work, team profiles, and lead-capture forms.",
  version: "1.0",

  supportedContent: [
    {
      contentType: "LANDING_PAGE",
      support: "primary",
      notes: "Core offering pages — services, about, contact.",
    },
    {
      contentType: "PORTFOLIO",
      support: "primary",
      notes: "Case studies and project showcases.",
    },
    {
      contentType: "GALLERY",
      support: "supported",
      notes: "Work samples, photo galleries, process shots.",
    },
    {
      contentType: "ARTICLE",
      support: "partial",
      notes: "Thought-leadership blog; secondary to portfolio.",
    },
    {
      contentType: "FAQ",
      support: "supported",
      notes: "Services FAQ and pricing questions.",
    },
  ],

  supportedLayouts: [
    {
      layout: "LandingLayout",
      usedForPageTypes: ["homepage", "landing"],
      isPrimary: true,
    },
    {
      layout: "PortfolioLayout",
      usedForPageTypes: ["portfolio"],
      isPrimary: false,
    },
    {
      layout: "GalleryLayout",
      usedForPageTypes: ["gallery"],
      isPrimary: false,
    },
    {
      layout: "MinimalLayout",
      usedForPageTypes: ["not_found"],
      isPrimary: false,
    },
    {
      layout: "ArticleLayout",
      usedForPageTypes: ["article", "faq"],
      isPrimary: false,
    },
  ],

  supportedNavigationStructures: [
    "primary-header",
    "footer-grouped",
    "breadcrumbs",
    "contextual-links",
  ],

  supportedPageTypes: [
    { pageType: "homepage",    isRequired: true,  notes: "Brand hero, services overview, CTA." },
    { pageType: "landing",     isRequired: true,  notes: "Individual service or campaign pages." },
    { pageType: "portfolio",   isRequired: true,  notes: "Case study detail pages." },
    { pageType: "gallery",     isRequired: false, notes: "Visual work samples." },
    { pageType: "article",     isRequired: false, notes: "Blog / thought-leadership." },
    { pageType: "faq",         isRequired: false, notes: "Services and process FAQ." },
    { pageType: "not_found",   isRequired: true,  notes: "Standard 404 page." },
    { pageType: "sitemap_page",isRequired: false, notes: "HTML sitemap for SEO." },
  ],

  requiredComponents: [
    "HeroSection",
    "NavigationBar",
    "Footer",
    "PortfolioGrid",
  ],

  optionalComponents: [
    "PortfolioCard",
    "GalleryGrid",
    "GalleryLightbox",
    "FeaturedContent",
    "FAQAccordion",
    "MetaTags",
    "OpenGraphTags",
    "StructuredData",
  ],

  primaryPageType: "landing",
  primaryLayout: "LandingLayout",
  tags: ["agency", "services", "portfolio", "creative", "b2b", "branding"],
};
