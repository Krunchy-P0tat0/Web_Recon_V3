import type { StencilDefinition } from "../types.js";

/**
 * Marketplace — Product or service marketplace.
 *
 * Browse-first experience with filter-bar facets, category mega-menu,
 * listing grids, and detail pages. Designed for high item counts and
 * conversion-oriented CTAs.
 */
export const marketplaceStencil: StencilDefinition = {
  id: "marketplace",
  displayName: "Marketplace",
  description:
    "Product or service marketplace. Filter-bar faceted browsing, category " +
    "mega-menu, listing grids, detail pages, and conversion-oriented CTAs. " +
    "Supports digital goods, services, or physical products.",
  version: "1.0",

  supportedContent: [
    {
      contentType: "LANDING_PAGE",
      support: "primary",
      notes: "Homepage, campaign, and vendor landing pages.",
    },
    {
      contentType: "ARTICLE",
      support: "supported",
      notes: "Product guides, comparisons, and reviews.",
    },
    {
      contentType: "GALLERY",
      support: "supported",
      notes: "Product image galleries.",
    },
    {
      contentType: "FAQ",
      support: "supported",
      notes: "Purchasing, shipping, and policy FAQs.",
    },
    {
      contentType: "GUIDE",
      support: "partial",
      notes: "Buying guides and tutorials.",
    },
  ],

  supportedLayouts: [
    {
      layout: "IndexLayout",
      usedForPageTypes: ["homepage", "category", "tag", "search"],
      isPrimary: true,
    },
    {
      layout: "LandingLayout",
      usedForPageTypes: ["landing"],
      isPrimary: false,
    },
    {
      layout: "ArticleLayout",
      usedForPageTypes: ["article", "guide", "faq"],
      isPrimary: false,
    },
    {
      layout: "GalleryLayout",
      usedForPageTypes: ["gallery"],
      isPrimary: false,
    },
    {
      layout: "MinimalLayout",
      usedForPageTypes: ["not_found", "sitemap_page"],
      isPrimary: false,
    },
  ],

  supportedNavigationStructures: [
    "primary-header",
    "mega-menu",
    "filter-bar",
    "breadcrumbs",
    "category-tree",
    "footer-grouped",
    "pagination",
    "contextual-links",
  ],

  supportedPageTypes: [
    { pageType: "homepage",     isRequired: true,  notes: "Featured listings and category highlights." },
    { pageType: "landing",      isRequired: true,  notes: "Campaign and vendor landing pages." },
    { pageType: "category",     isRequired: true,  notes: "Browsable listing grid with filters." },
    { pageType: "tag",          isRequired: true,  notes: "Tag-filtered listing pages." },
    { pageType: "gallery",      isRequired: false, notes: "Product image gallery." },
    { pageType: "article",      isRequired: false, notes: "Guides and reviews." },
    { pageType: "guide",        isRequired: false, notes: "Buying guides." },
    { pageType: "faq",          isRequired: true,  notes: "Purchase and policy FAQ." },
    { pageType: "search",       isRequired: true,  notes: "Full-text listing search." },
    { pageType: "not_found",    isRequired: true,  notes: "Standard 404 page." },
    { pageType: "sitemap_page", isRequired: false, notes: "HTML sitemap." },
  ],

  requiredComponents: [
    "NavigationBar",
    "FilterBar",
    "CategoryListing",
    "ArticleGrid",
    "ArticleCard",
    "Pagination",
    "Footer",
  ],

  optionalComponents: [
    "HeroSection",
    "FeaturedContent",
    "LatestContent",
    "CategoryHighlights",
    "GalleryGrid",
    "GalleryLightbox",
    "Breadcrumb",
    "SearchBox",
    "SearchResults",
    "FAQAccordion",
    "RelatedContent",
    "MetaTags",
    "OpenGraphTags",
    "StructuredData",
  ],

  primaryPageType: "category",
  primaryLayout: "IndexLayout",
  tags: ["marketplace", "ecommerce", "listings", "products", "shop", "directory"],
};
