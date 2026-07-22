/**
 * tag-pages.ts — Tag Archive Page Generator
 *
 * Produces one PageDefinition per tag in the CategoryGraph.
 * Only generates pages for tags appearing in 2+ nodes.
 *
 * Generates:
 *   - /tag/{slug}   — grouped content listing for the tag
 */

import type { SiteGraph } from "@workspace/site-intelligence";
import type {
  PageDefinition,
  ComponentRequirement,
  ContentSource,
  PageMeta,
  PageRelationshipLinks,
  TagConfig,
} from "./types";

// ---------------------------------------------------------------------------
// Tag slug from tag label
// ---------------------------------------------------------------------------

function tagSlug(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Components for tag archive pages
// ---------------------------------------------------------------------------

function buildTagComponents(tagConfig: TagConfig): ComponentRequirement[] {
  const components: ComponentRequirement[] = [];
  let order = 0;

  components.push({ component: "MetaTags",      required: true,  slot: "meta",   order: order++, props: [] });
  components.push({ component: "OpenGraphTags", required: true,  slot: "meta",   order: order++, props: [] });
  components.push({ component: "NavigationBar", required: true,  slot: "header", order: order++, props: [] });
  components.push({ component: "Breadcrumb",    required: false, slot: "header", order: order++, props: [] });

  components.push({
    component: "TagArchive",
    required: true,
    slot: "main",
    order: order++,
    props: [
      { name: "tag",      value: tagConfig.tag,      dynamic: false },
      { name: "pageSize", value: tagConfig.pageSize, dynamic: false },
    ],
  });

  components.push({
    component: "ArticleList",
    required: true,
    slot: "main",
    order: order++,
    props: [{ name: "variant", value: "compact", dynamic: false }],
  });

  if (tagConfig.totalPages > tagConfig.pageSize) {
    components.push({
      component: "Pagination",
      required: true,
      slot: "main",
      order: order++,
      props: [{ name: "total", value: tagConfig.totalPages, dynamic: false }],
    });
  }

  components.push({ component: "Footer", required: true, slot: "footer", order: order++, props: [] });

  return components;
}

// ---------------------------------------------------------------------------
// Public: generate tag PageDefinitions
// ---------------------------------------------------------------------------

export function generateTagPages(graph: SiteGraph): PageDefinition[] {
  const pages: PageDefinition[] = [];

  for (const tagRelationship of graph.categoryGraph.tags) {
    if (tagRelationship.frequency < 2) continue;

    const slug = tagSlug(tagRelationship.tag);
    if (!slug) continue;

    const route = `/tag/${slug}`;
    const totalCount = tagRelationship.nodeIds.length;
    const PAGE_SIZE = 12;

    const tagConfig: TagConfig = {
      tag: tagRelationship.tag,
      totalPages: totalCount,
      pageSize: PAGE_SIZE,
    };

    const components = buildTagComponents(tagConfig);

    const contentSource: ContentSource = {
      type: "site_graph_tag",
      tag: tagRelationship.tag,
      limit: PAGE_SIZE,
      sortBy: "publishedAt",
    };

    const meta: PageMeta = {
      title: `Tagged: ${tagRelationship.tag}`,
      description: `${totalCount} articles tagged with "${tagRelationship.tag}"`,
      canonicalUrl: route,
      ogTitle: `${tagRelationship.tag} — Tag Archive`,
      ogDescription: `${totalCount} articles tagged "${tagRelationship.tag}"`,
      ogImage: null,
      publishedAt: null,
      modifiedAt: null,
      noIndex: false,
    };

    const relationships: PageRelationshipLinks = {
      parentPageId: "page__homepage",
      childPageIds: tagRelationship.nodeIds.map((id) => `page__${id}`),
      relatedPageIds: [],
      breadcrumbPageIds: [],
      nextPageId: null,
      prevPageId: null,
    };

    pages.push({
      id: `page__tag__${slug}`,
      pageType: "tag",
      route,
      title: meta.title,
      layout: "IndexLayout",
      contentSource,
      components,
      meta,
      relationships,
      priority: 0.5,
      changeFreq: "weekly",
      tagConfig,
      isGenerated: true,
    });
  }

  return pages;
}
