import type { StencilDefinition } from "../types.js";

/**
 * Directory — Business or resource directory.
 *
 * Browse-by-category listing experience for businesses, tools, venues,
 * or any annotated resource set. Filter bar, category tree, and
 * deep-linked listing detail pages.
 */
export const directoryStencil: StencilDefinition = {
  id: "directory",
  displayName: "Directory",
  description:
    "Business, venue, or resource directory. Category-tree browsing, " +
    "filter-bar facets, listing detail pages, and SEO-friendly category " +
    "archives. Suitable for local business guides, tool directories, " +
    "vendor lists, and resource hubs.",
  version: "1.0",

  supportedContent: [
    {
      contentType: "ARTICLE",
      support: "primary",
      notes: "Individual directory listing detail pages.",
    },
    {
      contentType: "LANDING_PAGE",
      support: "supported",
      notes: "Homepage, city or region landing pages.",
    },
    {
      contentType: "GUIDE",
      support: "supported",
      notes: "How-to and curated guides.",
    },
    {
      contentType: "FAQ",
      support: "supported",
      notes: "Submission, listing, and general FAQs.",
    },
  ],

  supportedLayouts: [
    {
      layout: "IndexLayout",
      usedForPageTypes: ["homepage", "category", "tag", "search"],
      isPrimary: true,
    },
    {
      layout: "ArticleLayout",
      usedForPageTypes: ["article", "guide", "faq"],
      isPrimary: false,
    },
    {
      layout: "LandingLayout",
      usedForPageTypes: ["landing"],
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
    "filter-bar",
    "category-tree",
    "breadcrumbs",
    "pagination",
    "footer-grouped",
    "contextual-links",
  ],

  supportedPageTypes: [
    { pageType: "homepage",     isRequired: true,  notes: "Directory home with category highlights." },
    { pageType: "landing",      isRequired: false, notes: "City, region, or sub-directory pages." },
    { pageType: "category",     isRequired: true,  notes: "Listing grid for a category." },
    { pageType: "article",      isRequired: true,  notes: "Individual listing detail page." },
    { pageType: "tag",          isRequired: true,  notes: "Tag-filtered listing archives." },
    { pageType: "guide",        isRequired: false, notes: "Curated guide content." },
    { pageType: "faq",          isRequired: false, notes: "Directory FAQ." },
    { pageType: "search",       isRequired: true,  notes: "Full-text directory search." },
    { pageType: "not_found",    isRequired: true,  notes: "Standard 404 page." },
    { pageType: "sitemap_page", isRequired: true,  notes: "HTML sitemap for SEO." },
  ],

  requiredComponents: [
    "NavigationBar",
    "FilterBar",
    "CategoryListing",
    "ArticleList",
    "ArticleCard",
    "Pagination",
    "Breadcrumb",
    "Footer",
  ],

  optionalComponents: [
    "HeroSection",
    "CategoryHighlights",
    "TagCloud",
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
  tags: ["directory", "listings", "local", "business", "resources", "catalogue"],
};
