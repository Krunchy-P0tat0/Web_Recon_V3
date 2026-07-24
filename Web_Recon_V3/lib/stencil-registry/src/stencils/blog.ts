import type { StencilDefinition } from "../types.js";

/**
 * Blog — Personal or editorial blog.
 *
 * Content-first reading experience. Long-form articles dominate.
 * Taxonomy (categories, tags) is central to discoverability.
 * Built for frequent publishing cadences.
 */
export const blogStencil: StencilDefinition = {
  id: "blog",
  displayName: "Blog",
  description:
    "Content-first personal or editorial blog. Long-form articles with full " +
    "taxonomy support (categories, tags), author profiles, related content, " +
    "and an RSS-friendly sitemap.",
  version: "1.0",

  supportedContent: [
    {
      contentType: "ARTICLE",
      support: "primary",
      notes: "Long-form posts are the primary content unit.",
    },
    {
      contentType: "BLOG",
      support: "primary",
      notes: "Short-form blog entries and news posts.",
    },
    {
      contentType: "GUIDE",
      support: "supported",
      notes: "How-to guides and tutorials.",
    },
    {
      contentType: "FAQ",
      support: "partial",
      notes: "Static FAQ pages when needed.",
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
      layout: "MinimalLayout",
      usedForPageTypes: ["not_found", "sitemap_page"],
      isPrimary: false,
    },
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
    { pageType: "homepage",     isRequired: true,  notes: "Latest posts + featured content." },
    { pageType: "article",      isRequired: true,  notes: "Individual article/post page." },
    { pageType: "blog",         isRequired: true,  notes: "Short-form blog posts." },
    { pageType: "guide",        isRequired: false, notes: "How-to and tutorial content." },
    { pageType: "category",     isRequired: true,  notes: "Posts grouped by category." },
    { pageType: "tag",          isRequired: true,  notes: "Posts grouped by tag." },
    { pageType: "search",       isRequired: true,  notes: "Full-text post search." },
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
  tags: ["blog", "editorial", "writing", "articles", "publishing"],
};
