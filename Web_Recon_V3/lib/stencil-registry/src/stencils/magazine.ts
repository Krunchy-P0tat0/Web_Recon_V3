import type { StencilDefinition } from "../types.js";

/**
 * Magazine — High-volume editorial content site.
 *
 * Multi-section publication with heavy category structure, editorial curation,
 * mega-menu navigation, and mixed media content. Built for scale and discovery.
 */
export const magazineStencil: StencilDefinition = {
  id: "magazine",
  displayName: "Magazine",
  description:
    "High-volume editorial or news magazine. Multiple content sections, " +
    "editorial curation, mega-menu navigation, gallery support, and " +
    "category-driven discovery. Scales to thousands of articles.",
  version: "1.0",

  supportedContent: [
    {
      contentType: "ARTICLE",
      support: "primary",
      notes: "News stories, features, and opinion pieces.",
    },
    {
      contentType: "BLOG",
      support: "supported",
      notes: "Commentary and editor blogs.",
    },
    {
      contentType: "GUIDE",
      support: "supported",
      notes: "Long-form guides and special reports.",
    },
    {
      contentType: "GALLERY",
      support: "supported",
      notes: "Photo stories and editorial galleries.",
    },
    {
      contentType: "FAQ",
      support: "partial",
      notes: "Section-specific FAQ pages.",
    },
  ],

  supportedLayouts: [
    {
      layout: "ArticleLayout",
      usedForPageTypes: ["article", "blog", "guide"],
      isPrimary: true,
    },
    {
      layout: "IndexLayout",
      usedForPageTypes: ["homepage", "category", "tag", "search"],
      isPrimary: false,
    },
    {
      layout: "LandingLayout",
      usedForPageTypes: ["landing"],
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
  tags: ["magazine", "news", "editorial", "publishing", "media", "journalism"],
};
