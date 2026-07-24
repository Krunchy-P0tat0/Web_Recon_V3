import type { StencilDefinition } from "../types.js";

/**
 * Documentation — Technical docs and knowledge base.
 *
 * Task-oriented reading experience with persistent sidebar navigation,
 * sequential step navigation, full-text search, and version-aware
 * breadcrumbs. Optimised for skimmability and deep-linking.
 */
export const documentationStencil: StencilDefinition = {
  id: "documentation",
  displayName: "Documentation",
  description:
    "Technical documentation or knowledge base. Persistent sidebar navigation, " +
    "step-by-step guides, full-text search, table of contents, code blocks, " +
    "and version-aware breadcrumbs. Built for developer or user references.",
  version: "1.0",

  supportedContent: [
    {
      contentType: "DOCS",
      support: "primary",
      notes: "API references, SDK guides, and conceptual docs.",
    },
    {
      contentType: "GUIDE",
      support: "primary",
      notes: "Step-by-step tutorials and how-to guides.",
    },
    {
      contentType: "FAQ",
      support: "supported",
      notes: "Troubleshooting and common questions.",
    },
    {
      contentType: "ARTICLE",
      support: "supported",
      notes: "Blog posts, release notes, and announcements.",
    },
  ],

  supportedLayouts: [
    {
      layout: "DocumentationLayout",
      usedForPageTypes: ["docs", "guide"],
      isPrimary: true,
    },
    {
      layout: "ArticleLayout",
      usedForPageTypes: ["article", "faq"],
      isPrimary: false,
    },
    {
      layout: "IndexLayout",
      usedForPageTypes: ["homepage", "category", "search"],
      isPrimary: false,
    },
    {
      layout: "MinimalLayout",
      usedForPageTypes: ["not_found", "sitemap_page"],
      isPrimary: false,
    },
  ],

  supportedNavigationStructures: [
    "sidebar",
    "step-nav",
    "breadcrumbs",
    "primary-header",
    "pagination",
    "contextual-links",
    "tabs",
  ],

  supportedPageTypes: [
    { pageType: "homepage",     isRequired: true,  notes: "Docs landing with section index." },
    { pageType: "docs",         isRequired: true,  notes: "API references and conceptual docs." },
    { pageType: "guide",        isRequired: true,  notes: "Step-by-step tutorials." },
    { pageType: "faq",          isRequired: true,  notes: "Troubleshooting and FAQ." },
    { pageType: "article",      isRequired: false, notes: "Blog / release notes." },
    { pageType: "category",     isRequired: false, notes: "Doc section index pages." },
    { pageType: "search",       isRequired: true,  notes: "Full-text docs search." },
    { pageType: "not_found",    isRequired: true,  notes: "Standard 404 page." },
    { pageType: "sitemap_page", isRequired: true,  notes: "HTML sitemap for crawlers." },
  ],

  requiredComponents: [
    "NavigationBar",
    "TableOfContents",
    "CodeBlock",
    "Breadcrumb",
    "SearchBox",
    "SearchResults",
    "Footer",
  ],

  optionalComponents: [
    "HeroSection",
    "FAQAccordion",
    "RelatedContent",
    "ArticleList",
    "Pagination",
    "CategoryListing",
    "MetaTags",
    "OpenGraphTags",
    "StructuredData",
  ],

  primaryPageType: "docs",
  primaryLayout: "DocumentationLayout",
  tags: ["documentation", "docs", "knowledge-base", "developer", "technical", "reference"],
};
