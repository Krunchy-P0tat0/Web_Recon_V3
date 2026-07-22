/**
 * component-registry.ts — ComponentRegistry Builder
 *
 * Scans all PageDefinitions and builds a complete ComponentRegistry
 * describing every component used across the site, which page types
 * need it, which layouts require it, and total usage counts.
 */

import type {
  ComponentRegistry,
  ComponentDefinition,
  ComponentType,
  PageDefinition,
  PageType,
  LayoutType,
} from "./types";

// ---------------------------------------------------------------------------
// Component metadata (descriptions and natural associations)
// ---------------------------------------------------------------------------

const COMPONENT_DESCRIPTIONS: Record<ComponentType, string> = {
  HeroSection:        "Full-width hero banner with headline, subheadline, and optional CTA",
  FeaturedContent:    "Grid of featured/highlighted articles or pages",
  LatestContent:      "List of most recently published content",
  CategoryHighlights: "Visual highlights of top site categories",
  NavigationBar:      "Primary site navigation with links and mobile menu",
  Footer:             "Site footer with nav groups and copyright",
  Breadcrumb:         "Hierarchical breadcrumb trail for the current page",
  ArticleCard:        "Card component displaying article preview (title, image, excerpt)",
  ArticleGrid:        "Responsive grid of ArticleCard components",
  ArticleList:        "Compact list of ArticleCard components",
  AuthorBlock:        "Author bio, avatar, and publication date block",
  RelatedContent:     "Curated list of related articles for the current page",
  TagCloud:           "Visual tag cloud with weighted font sizes by frequency",
  GalleryGrid:        "Masonry/grid layout for displaying image collections",
  GalleryLightbox:    "Full-screen image lightbox overlay",
  CategoryListing:    "Category header with description and child category links",
  FilterBar:          "Sort and filter controls for listing pages",
  Pagination:         "Page number navigation for multi-page listings",
  TagArchive:         "Tag archive header and grouped content listing",
  SearchBox:          "Search input with optional autocomplete",
  SearchResults:      "Rendered results list for a search query",
  SearchIndex:        "Invisible pre-built search index injected into the page",
  SitemapTree:        "Visual sitemap tree for the sitemap page",
  ImagePlacement:     "Contextual image placement within article content",
  VideoEmbed:         "Embedded video player (YouTube, Vimeo, native)",
  TableOfContents:    "Auto-generated table of contents from page headings",
  CodeBlock:          "Syntax-highlighted code block",
  FAQAccordion:       "Collapsible FAQ question/answer accordion",
  PortfolioCard:      "Portfolio project card with image, title, and tags",
  PortfolioGrid:      "Grid layout for portfolio project cards",
  MetaTags:           "HTML <meta> tags (title, description, robots)",
  OpenGraphTags:      "Open Graph / Twitter Card meta tags for social sharing",
  StructuredData:     "JSON-LD structured data injection for SEO",
};

// ---------------------------------------------------------------------------
// Public: build ComponentRegistry from all page definitions
// ---------------------------------------------------------------------------

export function buildComponentRegistry(pages: PageDefinition[]): ComponentRegistry {
  const usageByComponent = new Map<
    ComponentType,
    { pageTypes: Set<PageType>; layouts: Set<LayoutType>; count: number; isRequired: boolean }
  >();

  // Scan all component requirements across all pages
  for (const page of pages) {
    for (const req of page.components) {
      const existing = usageByComponent.get(req.component) ?? {
        pageTypes: new Set<PageType>(),
        layouts: new Set<LayoutType>(),
        count: 0,
        isRequired: false,
      };
      existing.pageTypes.add(page.pageType);
      existing.layouts.add(page.layout);
      existing.count++;
      if (req.required) existing.isRequired = true;
      usageByComponent.set(req.component, existing);
    }
  }

  // Build ComponentDefinition list
  const components: ComponentDefinition[] = Array.from(usageByComponent.entries())
    .map(([type, data]) => ({
      type,
      description: COMPONENT_DESCRIPTIONS[type] ?? `${type} component`,
      usedInPageTypes: Array.from(data.pageTypes),
      usedInLayouts: Array.from(data.layouts),
      totalUsages: data.count,
      isRequired: data.isRequired,
    }))
    .sort((a, b) => b.totalUsages - a.totalUsages);

  // Build index
  const componentIndex = Object.fromEntries(
    components.map((c) => [c.type, c])
  ) as Record<ComponentType, ComponentDefinition>;

  // By page type
  const byPageType: Record<PageType, ComponentType[]> = {} as Record<PageType, ComponentType[]>;
  for (const page of pages) {
    if (!byPageType[page.pageType]) byPageType[page.pageType] = [];
    for (const req of page.components) {
      if (!byPageType[page.pageType]!.includes(req.component)) {
        byPageType[page.pageType]!.push(req.component);
      }
    }
  }

  // By layout
  const byLayout: Record<LayoutType, ComponentType[]> = {} as Record<LayoutType, ComponentType[]>;
  for (const page of pages) {
    if (!byLayout[page.layout]) byLayout[page.layout] = [];
    for (const req of page.components) {
      if (!byLayout[page.layout]!.includes(req.component)) {
        byLayout[page.layout]!.push(req.component);
      }
    }
  }

  return {
    components,
    componentIndex,
    totalComponents: components.length,
    byPageType,
    byLayout,
  };
}
