/**
 * route-engine.ts — Blueprint Route Pattern Engine
 *
 * Generates deterministic BlueprintRoutePattern definitions describing
 * the URL structure of the entire site.
 *
 * Each route pattern captures:
 *   - Pattern string (e.g. /articles/{slug})
 *   - Page type
 *   - Layout
 *   - Dynamic/static flag
 *   - Parameter descriptors
 *   - Sitemap priority + change frequency
 *   - Required components
 */

import type { SiteGraph } from "@workspace/site-intelligence";
import type {
  BlueprintRoutePattern,
  PageType,
  LayoutType,
  ChangeFreq,
  ComponentType,
  ContentSourceType,
  RouteParam,
  PageDefinition,
} from "./types";

// ---------------------------------------------------------------------------
// Route pattern builder helpers
// ---------------------------------------------------------------------------

function makePattern(
  id: string,
  pattern: string,
  pageType: PageType,
  layout: LayoutType,
  contentSource: ContentSourceType,
  priority: number,
  changeFreq: ChangeFreq,
  params: RouteParam[],
  requiredComponents: ComponentType[],
  description: string
): BlueprintRoutePattern {
  return {
    id,
    pattern,
    pageType,
    layout,
    isDynamic: params.length > 0,
    params,
    contentSource,
    priority,
    changeFreq,
    requiredComponents,
    description,
  };
}

// ---------------------------------------------------------------------------
// Detect predominant content layout from layout assignments
// ---------------------------------------------------------------------------

function getPredominantLayout(
  graph: SiteGraph,
  contentTypes: Array<string>
): LayoutType {
  const relevant = graph.layoutAssignments.filter((a) =>
    contentTypes.includes(a.contentType)
  );
  if (relevant.length === 0) return "ArticleLayout";

  const counts = new Map<LayoutType, number>();
  for (const a of relevant) {
    counts.set(a.layout, (counts.get(a.layout) ?? 0) + 1);
  }

  let best: LayoutType = "ArticleLayout";
  let bestCount = 0;
  for (const [layout, count] of counts.entries()) {
    if (count > bestCount) {
      bestCount = count;
      best = layout;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Public: generate all route patterns
// ---------------------------------------------------------------------------

export function buildRoutePatterns(
  graph: SiteGraph,
  pages: PageDefinition[]
): BlueprintRoutePattern[] {
  const patterns: BlueprintRoutePattern[] = [];

  // Homepage — static
  patterns.push(
    makePattern(
      "route__homepage",
      "/",
      "homepage",
      "LandingLayout",
      "generated_index",
      1.0,
      "daily",
      [],
      ["NavigationBar", "HeroSection", "FeaturedContent", "Footer"],
      "Homepage — entry point of the site"
    )
  );

  // Articles pattern
  if (graph.stats.byContentType.ARTICLE > 0 || graph.stats.byContentType.BLOG > 0) {
    const layout = getPredominantLayout(graph, ["ARTICLE", "BLOG"]);
    patterns.push(
      makePattern(
        "route__article",
        "/articles/{slug}",
        "article",
        layout,
        "site_graph_node",
        0.7,
        "weekly",
        [{ name: "slug", source: "slug", example: "my-article-title" }],
        ["NavigationBar", "Breadcrumb", "AuthorBlock", "RelatedContent", "Footer"],
        "Individual article pages"
      )
    );
  }

  // Blog pattern (if distinct from article)
  if (graph.stats.byContentType.BLOG > 3) {
    patterns.push(
      makePattern(
        "route__blog",
        "/blog/{slug}",
        "blog",
        "ArticleLayout",
        "site_graph_node",
        0.7,
        "weekly",
        [{ name: "slug", source: "slug", example: "my-blog-post" }],
        ["NavigationBar", "Breadcrumb", "AuthorBlock", "TagCloud", "Footer"],
        "Blog post pages"
      )
    );
  }

  // Guide pattern
  if (graph.stats.byContentType.GUIDE > 0) {
    patterns.push(
      makePattern(
        "route__guide",
        "/guides/{slug}",
        "guide",
        "DocumentationLayout",
        "site_graph_node",
        0.8,
        "monthly",
        [{ name: "slug", source: "slug", example: "getting-started" }],
        ["NavigationBar", "Breadcrumb", "TableOfContents", "CodeBlock", "Footer"],
        "Guide and tutorial pages"
      )
    );
  }

  // Docs pattern
  if (graph.stats.byContentType.DOCS > 0) {
    patterns.push(
      makePattern(
        "route__docs",
        "/docs/{slug}",
        "docs",
        "DocumentationLayout",
        "site_graph_node",
        0.8,
        "weekly",
        [{ name: "slug", source: "slug", example: "api-reference" }],
        ["NavigationBar", "Breadcrumb", "TableOfContents", "CodeBlock", "Footer"],
        "Documentation pages"
      )
    );
  }

  // Portfolio pattern
  if (graph.stats.byContentType.PORTFOLIO > 0) {
    patterns.push(
      makePattern(
        "route__portfolio",
        "/work/{slug}",
        "portfolio",
        "PortfolioLayout",
        "site_graph_node",
        0.7,
        "monthly",
        [{ name: "slug", source: "slug", example: "project-name" }],
        ["NavigationBar", "Breadcrumb", "PortfolioCard", "GalleryGrid", "Footer"],
        "Portfolio / case study pages"
      )
    );
  }

  // FAQ pattern
  if (graph.stats.byContentType.FAQ > 0) {
    patterns.push(
      makePattern(
        "route__faq",
        "/faq/{slug}",
        "faq",
        "DocumentationLayout",
        "site_graph_node",
        0.6,
        "monthly",
        [{ name: "slug", source: "slug", example: "frequently-asked-questions" }],
        ["NavigationBar", "Breadcrumb", "FAQAccordion", "Footer"],
        "FAQ pages"
      )
    );
  }

  // Gallery pattern
  if (graph.stats.byContentType.GALLERY > 0 || graph.stats.totalImages >= 20) {
    patterns.push(
      makePattern(
        "route__gallery",
        "/gallery/{slug}",
        "gallery",
        "GalleryLayout",
        "site_graph_node",
        0.6,
        "monthly",
        [{ name: "slug", source: "slug", example: "photo-gallery" }],
        ["NavigationBar", "GalleryGrid", "GalleryLightbox", "Footer"],
        "Image gallery pages"
      )
    );
    patterns.push(
      makePattern(
        "route__gallery_index",
        "/gallery",
        "gallery",
        "GalleryLayout",
        "site_graph_asset",
        0.7,
        "weekly",
        [],
        ["NavigationBar", "GalleryGrid", "GalleryLightbox", "Footer"],
        "Site-wide gallery index"
      )
    );
  }

  // Category pattern
  if (graph.categoryGraph.totalCategories > 0) {
    patterns.push(
      makePattern(
        "route__category",
        "/category/{slug}",
        "category",
        "IndexLayout",
        "site_graph_category",
        0.8,
        "weekly",
        [{ name: "slug", source: "category_slug", example: "technology" }],
        ["NavigationBar", "Breadcrumb", "CategoryListing", "ArticleGrid", "Pagination", "Footer"],
        "Category listing pages"
      )
    );

    patterns.push(
      makePattern(
        "route__category_page",
        "/category/{slug}/page/{n}",
        "category",
        "IndexLayout",
        "site_graph_category",
        0.4,
        "weekly",
        [
          { name: "slug", source: "category_slug", example: "technology" },
          { name: "n",    source: "page_number",   example: "2" },
        ],
        ["NavigationBar", "Breadcrumb", "CategoryListing", "ArticleGrid", "Pagination", "Footer"],
        "Paginated category listing pages"
      )
    );
  }

  // Tag pattern
  if (graph.categoryGraph.tags.length > 0) {
    patterns.push(
      makePattern(
        "route__tag",
        "/tag/{slug}",
        "tag",
        "IndexLayout",
        "site_graph_tag",
        0.5,
        "weekly",
        [{ name: "slug", source: "tag_slug", example: "javascript" }],
        ["NavigationBar", "TagArchive", "ArticleList", "Pagination", "Footer"],
        "Tag archive pages"
      )
    );
  }

  // Search
  patterns.push(
    makePattern(
      "route__search",
      "/search",
      "search",
      "MinimalLayout",
      "generated_search",
      0.3,
      "never",
      [],
      ["NavigationBar", "SearchBox", "SearchResults", "SearchIndex", "Footer"],
      "Interactive search page"
    )
  );

  // 404
  patterns.push(
    makePattern(
      "route__not_found",
      "/*",
      "not_found",
      "MinimalLayout",
      "generated_index",
      0.0,
      "never",
      [],
      ["NavigationBar", "Footer"],
      "404 Not Found catch-all"
    )
  );

  return patterns;
}
