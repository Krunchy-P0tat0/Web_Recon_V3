import type { SiteGraph } from "@workspace/site-intelligence";
import type { StencilDefinition } from "@workspace/stencil-registry";
import type { AssemblyPage, ComponentType } from "./types.js";

/**
 * Build one AssemblyPage per category in the SiteGraph.
 * Only emitted when the stencil's supportedPageTypes includes "category".
 */
export function buildCategoryPages(
  graph: SiteGraph,
  stencil: StencilDefinition,
  maxCategoryPages: number,
  pageSize: number
): AssemblyPage[] {
  const stencilPageTypes = new Set(stencil.supportedPageTypes.map((p) => p.pageType));
  if (!stencilPageTypes.has("category")) return [];

  const components = selectCategoryComponents(stencil);
  const pages: AssemblyPage[] = [];

  for (const cat of graph.categoryGraph.categories) {
    if (cat.pageCount === 0) continue;
    if (pages.length >= maxCategoryPages) break;

    const route = `/categories/${cat.slug}`;
    const totalContentPages = Math.ceil(cat.pageCount / pageSize);
    const description = `Browse ${cat.pageCount} ${cat.pageCount === 1 ? "item" : "items"} in ${cat.label}.`;

    pages.push({
      id: `page__category__${cat.id}`,
      route,
      slug: cat.slug,
      title: cat.label,
      pageType: "category",
      layout: "IndexLayout",
      sourceNodeId: null,
      contentType: null,
      isGenerated: true,
      components,
      meta: {
        title: `${cat.label} — ${totalContentPages > 1 ? `${cat.pageCount} articles` : "Articles"}`,
        description,
        canonicalUrl: route,
        ogTitle: cat.label,
        ogDescription: description,
        ogImageUrl: null,
        publishedAt: null,
        noIndex: false,
      },
      priority: cat.depth === 0 ? 0.7 : 0.6,
      changeFreq: "daily",
      estimatedWordCount: null,
      hasImages: false,
      imageCount: 0,
    });
  }

  return pages.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Build tag pages — one per tag that meets the minimum frequency threshold.
 */
export function buildTagPages(
  graph: SiteGraph,
  stencil: StencilDefinition,
  tagMinFrequency: number
): AssemblyPage[] {
  const stencilPageTypes = new Set(stencil.supportedPageTypes.map((p) => p.pageType));
  if (!stencilPageTypes.has("tag")) return [];

  const components = selectCategoryComponents(stencil);

  return graph.categoryGraph.tags
    .filter((t) => t.frequency >= tagMinFrequency)
    .map((t) => {
      const slug = t.tag.toLowerCase().replace(/[^a-z0-9]/g, "-");
      const route = `/tags/${slug}`;
      const description = `Browse ${t.frequency} ${t.frequency === 1 ? "article" : "articles"} tagged with "${t.tag}".`;

      return {
        id: `page__tag__${slug}`,
        route,
        slug,
        title: t.tag,
        pageType: "tag" as const,
        layout: "IndexLayout" as const,
        sourceNodeId: null,
        contentType: null,
        isGenerated: true,
        components,
        meta: {
          title: `${t.tag} — Articles`,
          description,
          canonicalUrl: route,
          ogTitle: t.tag,
          ogDescription: description,
          ogImageUrl: null,
          publishedAt: null,
          noIndex: false,
        },
        priority: 0.5,
        changeFreq: "weekly" as const,
        estimatedWordCount: null,
        hasImages: false,
        imageCount: 0,
      };
    });
}

// ─── Component selection ──────────────────────────────────────────────────────

function selectCategoryComponents(stencil: StencilDefinition): ComponentType[] {
  const all = new Set([
    ...stencil.requiredComponents,
    ...stencil.optionalComponents,
  ]);

  const components: ComponentType[] = [];

  if (all.has("NavigationBar"))   components.push("NavigationBar");
  if (all.has("Breadcrumb"))      components.push("Breadcrumb");
  if (all.has("FilterBar"))       components.push("FilterBar");
  if (all.has("CategoryListing")) components.push("CategoryListing");
  if (all.has("ArticleGrid"))     components.push("ArticleGrid");
  if (all.has("ArticleCard"))     components.push("ArticleCard");
  if (all.has("ArticleList"))     components.push("ArticleList");
  if (all.has("Pagination"))      components.push("Pagination");
  if (all.has("TagCloud"))        components.push("TagCloud");
  if (all.has("MetaTags"))        components.push("MetaTags");
  if (all.has("OpenGraphTags"))   components.push("OpenGraphTags");
  if (all.has("StructuredData"))  components.push("StructuredData");
  if (all.has("Footer"))          components.push("Footer");

  return components;
}
