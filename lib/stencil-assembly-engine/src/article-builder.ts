import type { SiteGraph, PortablePageNode } from "@workspace/site-intelligence";
import type { StencilDefinition } from "@workspace/stencil-registry";
import type {
  AssemblyPage,
  ContentType,
  PageType,
  LayoutType,
  ComponentType,
} from "./types.js";

/** Content types that produce article-style pages. */
const ARTICLE_CONTENT_TYPES: ContentType[] = [
  "ARTICLE", "BLOG", "GUIDE", "DOCS", "PORTFOLIO",
];

/**
 * Build AssemblyPage[] for all article-type pages.
 * Pages are ordered: homepage first, then by word count descending.
 */
export function buildArticlePages(
  graph: SiteGraph,
  stencil: StencilDefinition,
  nodeMap: Map<string, PortablePageNode>,
  maxArticlePages: number,
  includeOrphanPages: boolean
): AssemblyPage[] {
  const supportedPageTypes = new Set(stencil.supportedPageTypes.map((p) => p.pageType));

  // Map contentType → pageType
  const contentToPageType: Partial<Record<ContentType, PageType>> = {
    ARTICLE:   "article",
    BLOG:      "blog",
    GUIDE:     "guide",
    DOCS:      "docs",
    PORTFOLIO: "portfolio",
    FAQ:       "faq",
    GALLERY:   "gallery",
  };

  // Map nodeId → route
  const routeByNodeId = new Map(graph.routeMap.routes.map((r) => [r.nodeId, r]));

  // Map nodeId → layout
  const layoutByNodeId = new Map(
    graph.layoutAssignments.map((l) => [l.nodeId, l])
  );

  const orphanIds = new Set(graph.navigation.orphanPages.map((o) => o.nodeId));

  const pages: AssemblyPage[] = [];

  for (const cls of graph.classifications) {
    if (!ARTICLE_CONTENT_TYPES.includes(cls.contentType)) continue;

    const pageType = contentToPageType[cls.contentType];
    if (!pageType || !supportedPageTypes.has(pageType)) continue;

    if (!includeOrphanPages && orphanIds.has(cls.nodeId)) continue;

    const routeEntry = routeByNodeId.get(cls.nodeId);
    if (!routeEntry) continue;

    const layoutAssignment = layoutByNodeId.get(cls.nodeId);
    const layout = selectLayout(layoutAssignment?.layout, stencil, pageType);

    const node = nodeMap.get(cls.nodeId);
    const wordCount = node?.content.wordCount ?? null;
    const images = node?.media.images ?? [];
    const publishedAt = node?.metadata.publishedAt ?? null;
    const description = node?.metadata.description ?? null;

    const components = selectArticleComponents(
      stencil,
      cls.contentType,
      wordCount,
      images.length > 0,
      graph.navigation.breadcrumbs[cls.nodeId] !== undefined
    );

    pages.push({
      id: `page__${cls.nodeId}`,
      route: routeEntry.route,
      slug: routeEntry.slug,
      title: node?.metadata.title || routeEntry.slug,
      pageType,
      layout,
      sourceNodeId: cls.nodeId,
      contentType: cls.contentType,
      isGenerated: false,
      components,
      meta: {
        title: node?.metadata.title || routeEntry.slug,
        description,
        canonicalUrl: routeEntry.route,
        ogTitle: node?.metadata.title || routeEntry.slug,
        ogDescription: description,
        ogImageUrl: images[0]?.storage.publicPath ?? null,
        publishedAt,
        noIndex: false,
      },
      priority: pageType === "article" ? 0.8 : 0.6,
      changeFreq: "weekly",
      estimatedWordCount: wordCount,
      hasImages: images.length > 0,
      imageCount: images.length,
    });

    if (pages.length >= maxArticlePages) break;
  }

  return pages.sort((a, b) => (b.estimatedWordCount ?? 0) - (a.estimatedWordCount ?? 0));
}

// ─── Component selection ──────────────────────────────────────────────────────

function selectArticleComponents(
  stencil: StencilDefinition,
  contentType: ContentType,
  wordCount: number | null,
  hasImages: boolean,
  hasBreadcrumbs: boolean
): ComponentType[] {
  const all = new Set([
    ...stencil.requiredComponents,
    ...stencil.optionalComponents,
  ]);

  const components: ComponentType[] = [];

  // Always: NavigationBar, Footer, MetaTags, OpenGraphTags
  if (all.has("NavigationBar"))  components.push("NavigationBar");
  if (hasBreadcrumbs && all.has("Breadcrumb")) components.push("Breadcrumb");

  // Content-type specific
  if (contentType === "DOCS" && all.has("TableOfContents")) components.push("TableOfContents");
  if (contentType === "DOCS" && all.has("CodeBlock"))       components.push("CodeBlock");
  if (contentType === "FAQ"  && all.has("FAQAccordion"))    components.push("FAQAccordion");

  if (wordCount && wordCount > 500 && all.has("TableOfContents") && contentType !== "DOCS") {
    components.push("TableOfContents");
  }

  if (all.has("AuthorBlock"))    components.push("AuthorBlock");
  if (all.has("RelatedContent")) components.push("RelatedContent");

  if (hasImages && all.has("GalleryGrid"))     components.push("GalleryGrid");
  if (contentType === "PORTFOLIO" && all.has("PortfolioCard")) components.push("PortfolioCard");

  if (all.has("MetaTags"))       components.push("MetaTags");
  if (all.has("OpenGraphTags"))  components.push("OpenGraphTags");
  if (all.has("StructuredData")) components.push("StructuredData");
  if (all.has("Footer"))         components.push("Footer");

  return components;
}

// ─── Layout selection ─────────────────────────────────────────────────────────

function selectLayout(
  inferred: LayoutType | undefined,
  stencil: StencilDefinition,
  pageType: PageType
): LayoutType {
  if (inferred) {
    const stencilLayouts = stencil.supportedLayouts.map((l) => l.layout);
    if (stencilLayouts.includes(inferred)) return inferred;
  }
  for (const lc of stencil.supportedLayouts) {
    if (lc.usedForPageTypes.includes(pageType)) return lc.layout;
  }
  return stencil.primaryLayout;
}
