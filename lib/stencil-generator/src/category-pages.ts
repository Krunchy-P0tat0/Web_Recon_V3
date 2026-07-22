/**
 * category-pages.ts — Category Page Generator
 *
 * Produces one PageDefinition per category in the CategoryGraph.
 * Each category page is a paginated listing of pages in that category.
 *
 * Generates:
 *   - /category/{slug}            — main category listing
 *   - /category/{slug}/page/{n}   — paginated variations (if needed)
 *   - Filter bar when category has 10+ pages
 */

import type { SiteGraph } from "@workspace/site-intelligence";
import type {
  PageDefinition,
  ComponentRequirement,
  ContentSource,
  PageMeta,
  PageRelationshipLinks,
  CategoryConfig,
} from "./types";

const PAGE_SIZE = 12;

// ---------------------------------------------------------------------------
// Components for category pages
// ---------------------------------------------------------------------------

function buildCategoryComponents(
  categoryConfig: CategoryConfig
): ComponentRequirement[] {
  const components: ComponentRequirement[] = [];
  let order = 0;

  components.push({ component: "MetaTags",      required: true,  slot: "meta",   order: order++, props: [] });
  components.push({ component: "OpenGraphTags", required: true,  slot: "meta",   order: order++, props: [] });
  components.push({ component: "NavigationBar", required: true,  slot: "header", order: order++, props: [] });
  components.push({ component: "Breadcrumb",    required: true,  slot: "header", order: order++, props: [] });

  if (categoryConfig.hasFilterBar) {
    components.push({
      component: "FilterBar",
      required: false,
      slot: "main",
      order: order++,
      props: [
        { name: "sortOptions", value: categoryConfig.sortOptions, dynamic: false },
      ],
    });
  }

  components.push({
    component: "CategoryListing",
    required: true,
    slot: "main",
    order: order++,
    props: [
      { name: "categoryId", value: categoryConfig.categoryId, dynamic: false },
      { name: "pageSize",   value: categoryConfig.pageSize,   dynamic: false },
    ],
  });

  components.push({
    component: "ArticleGrid",
    required: true,
    slot: "main",
    order: order++,
    props: [{ name: "columns", value: 3, dynamic: false }],
  });

  if (categoryConfig.totalPages > categoryConfig.pageSize) {
    components.push({
      component: "Pagination",
      required: true,
      slot: "main",
      order: order++,
      props: [
        { name: "pageSize", value: categoryConfig.pageSize, dynamic: false },
        { name: "total",    value: categoryConfig.totalPages, dynamic: false },
      ],
    });
  }

  components.push({ component: "Footer", required: true, slot: "footer", order: order++, props: [] });

  return components;
}

// ---------------------------------------------------------------------------
// Public: generate category PageDefinitions
// ---------------------------------------------------------------------------

export function generateCategoryPages(graph: SiteGraph): PageDefinition[] {
  const pages: PageDefinition[] = [];

  for (const category of graph.categoryGraph.categories) {
    if (category.pageCount === 0) continue;

    const route = `/category/${category.slug}`;

    const categoryConfig: CategoryConfig = {
      categoryId: category.id,
      categoryLabel: category.label,
      totalPages: category.pageCount,
      pageSize: PAGE_SIZE,
      hasFilterBar: category.pageCount >= 10,
      sortOptions: ["newest", "oldest", "title_asc", "title_desc"],
    };

    const components = buildCategoryComponents(categoryConfig);

    const contentSource: ContentSource = {
      type: "site_graph_category",
      categoryId: category.id,
      limit: PAGE_SIZE,
      sortBy: "publishedAt",
    };

    const parentCategoryId = category.parentId;
    const parentCategory = parentCategoryId
      ? graph.categoryGraph.categories.find((c) => c.id === parentCategoryId)
      : null;
    const parentRoute = parentCategory ? `/category/${parentCategory.slug}` : null;

    const childCategoryRoutes = category.childIds
      .map((id) => {
        const child = graph.categoryGraph.categories.find((c) => c.id === id);
        return child ? `page__category__${child.slug}` : null;
      })
      .filter((id): id is string => id !== null);

    const meta: PageMeta = {
      title: `${category.label} — Category`,
      description: `Browse ${category.pageCount} articles in ${category.label}`,
      canonicalUrl: route,
      ogTitle: category.label,
      ogDescription: `${category.pageCount} articles in ${category.label}`,
      ogImage: null,
      publishedAt: null,
      modifiedAt: null,
      noIndex: false,
    };

    const relationships: PageRelationshipLinks = {
      parentPageId: parentCategory ? `page__category__${parentCategory.slug}` : null,
      childPageIds: childCategoryRoutes,
      relatedPageIds: [],
      breadcrumbPageIds: parentCategory
        ? [`page__category__${parentCategory.slug}`]
        : [],
      nextPageId: null,
      prevPageId: null,
    };

    pages.push({
      id: `page__category__${category.slug}`,
      pageType: "category",
      route,
      title: meta.title,
      layout: "IndexLayout",
      contentSource,
      components,
      meta,
      relationships,
      priority: category.depth === 0 ? 0.8 : 0.6,
      changeFreq: "weekly",
      categoryConfig,
      isGenerated: true,
    });

    // Generate paginated variants if category has more than PAGE_SIZE items
    const totalPagPages = Math.ceil(category.pageCount / PAGE_SIZE);
    for (let page = 2; page <= Math.min(totalPagPages, 10); page++) {
      const pagRoute = `${route}/page/${page}`;
      pages.push({
        id: `page__category__${category.slug}__p${page}`,
        pageType: "category",
        route: pagRoute,
        title: `${category.label} — Page ${page}`,
        layout: "IndexLayout",
        contentSource: {
          ...contentSource,
          query: `page=${page}`,
        },
        components: buildCategoryComponents({
          ...categoryConfig,
          totalPages: category.pageCount,
        }),
        meta: {
          ...meta,
          title: `${category.label} — Page ${page}`,
          canonicalUrl: pagRoute,
          noIndex: page > 5,
        },
        relationships: {
          parentPageId: `page__category__${category.slug}`,
          childPageIds: [],
          relatedPageIds: [],
          breadcrumbPageIds: [`page__category__${category.slug}`],
          nextPageId: page < totalPagPages ? `page__category__${category.slug}__p${page + 1}` : null,
          prevPageId: page === 2 ? `page__category__${category.slug}` : `page__category__${category.slug}__p${page - 1}`,
        },
        priority: 0.4,
        changeFreq: "weekly",
        categoryConfig,
        isGenerated: true,
      });
    }
  }

  return pages;
}
