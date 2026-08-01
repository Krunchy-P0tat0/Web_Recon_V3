import { compileSiteGraph } from "@workspace/site-intelligence";
import { getStencil } from "@workspace/stencil-registry";
import type { PortableManifest, PortablePageNode } from "@workspace/site-intelligence";
import type { StencilId } from "@workspace/stencil-registry";
import type {
  AssemblyOptions,
  AssemblyPage,
  AssemblyWarning,
  SiteAssembly,
  SiteAssemblyStats,
} from "./types.js";
import { buildNavigation } from "./navigation-builder.js";
import { buildRoutes } from "./route-builder.js";
import { buildArticlePages } from "./article-builder.js";
import { buildCategoryPages, buildTagPages } from "./category-builder.js";
import { buildLandingPages } from "./landing-builder.js";
import { buildSearchStructure, buildSearchPage } from "./search-builder.js";

const DEFAULTS: Required<AssemblyOptions> = {
  maxArticlePages:     500,
  maxCategoryPages:    100,
  tagMinFrequency:     2,
  includeOrphanPages:  false,
  primaryNavMaxItems:  8,
  footerNavMaxGroups:  4,
  pageSize:            12,
};

/**
 * Assemble a complete site skeleton from a manifest and a stencil selection.
 *
 * Pipeline:
 *   PortableManifest
 *     → compileSiteGraph()             (site-intelligence)
 *     → buildNavigation()              navigation structures per stencil
 *     → buildRoutes()                  static + dynamic URL patterns
 *     → buildLandingPages()            homepage + LANDING_PAGE + GALLERY nodes
 *     → buildArticlePages()            ARTICLE / BLOG / GUIDE / DOCS nodes
 *     → buildCategoryPages()           one page per category node
 *     → buildTagPages()                one page per qualifying tag
 *     → buildSearchStructure()         search index declaration
 *     → SiteAssembly
 *
 * All operations are pure and synchronous. Pass the result to
 * exportSiteAssembly() to write site-assembly.json to disk.
 */
export function assembleStencil(
  manifest: PortableManifest,
  stencilId: StencilId,
  options?: AssemblyOptions
): SiteAssembly {
  const startMs = Date.now();
  const opts = { ...DEFAULTS, ...options };
  const warnings: AssemblyWarning[] = [];

  // ── Step 1: Build SiteGraph ───────────────────────────────────────────────
  const graph = compileSiteGraph(manifest);

  // ── Step 2: Resolve stencil ───────────────────────────────────────────────
  const stencil = getStencil(stencilId);
  if (!stencil) {
    throw new Error(
      `assembleStencil: unknown stencilId "${stencilId}". ` +
      `Available stencils: agency, blog, magazine, portfolio, documentation, ` +
      `marketplace, directory, wedding`
    );
  }

  // ── Step 3: Build manifest node lookup (needed by page builders) ──────────
  const nodeMap = new Map<string, PortablePageNode>(
    manifest.nodes.map((n) => [n.id, n])
  );

  // ── Step 4: Navigation ────────────────────────────────────────────────────
  const navigation = buildNavigation(
    graph,
    stencil,
    opts.pageSize,
    opts.primaryNavMaxItems,
    opts.footerNavMaxGroups
  );

  // ── Step 5: Routes ────────────────────────────────────────────────────────
  const routes = buildRoutes(graph, stencil);

  // ── Step 6: Pages — landing (homepage + LANDING_PAGE + GALLERY) ──────────
  const landingPages = buildLandingPages(graph, stencil, nodeMap);

  // ── Step 7: Pages — articles (ARTICLE / BLOG / GUIDE / DOCS / PORTFOLIO) ─
  const articlePages = buildArticlePages(
    graph,
    stencil,
    nodeMap,
    opts.maxArticlePages,
    opts.includeOrphanPages
  );

  // ── Step 8: Pages — categories + tags ────────────────────────────────────
  const categoryPages = buildCategoryPages(
    graph,
    stencil,
    opts.maxCategoryPages,
    opts.pageSize
  );

  const tagPages = buildTagPages(graph, stencil, opts.tagMinFrequency);

  // ── Step 9: Search ────────────────────────────────────────────────────────
  const searchStructure = buildSearchStructure(stencil, articlePages, categoryPages);
  const searchPage = buildSearchPage(stencil, searchStructure);

  // ── Step 10: Assemble all pages ───────────────────────────────────────────
  const allPages: AssemblyPage[] = [
    ...landingPages,
    ...articlePages,
    ...categoryPages,
    ...tagPages,
    ...(searchPage ? [searchPage] : []),
  ];

  // ── Step 11: Collect warnings ─────────────────────────────────────────────
  collectWarnings(graph, stencil, allPages, opts, warnings);

  // ── Step 12: Stats ────────────────────────────────────────────────────────
  const durationMs = Date.now() - startMs;
  const orphanPagesIncluded = allPages.filter(
    (p) => p.sourceNodeId !== null &&
    graph.navigation.orphanPages.some((o) => o.nodeId === p.sourceNodeId)
  ).length;

  const stats: SiteAssemblyStats = {
    totalPages:            allPages.length,
    articlePages:          articlePages.length,
    categoryPages:         categoryPages.length + tagPages.length,
    landingPages:          landingPages.length,
    generatedPages:        allPages.filter((p) => p.isGenerated).length,
    orphanPagesIncluded,
    totalRoutes:           routes.total,
    dynamicRoutes:         routes.dynamic.length,
    staticRoutes:          routes.static.length,
    navItems:              countNavItems(navigation.primaryNav) + navigation.sidebarNav.length,
    categoryCount:         graph.categoryGraph.totalCategories,
    tagCount:              graph.categoryGraph.tags.filter((t) => t.frequency >= opts.tagMinFrequency).length,
    assemblyTimeMs:        durationMs,
  };

  return {
    version: "1.0",
    assembledAt: new Date().toISOString(),
    stencilId,
    stencilDisplayName: stencil.displayName,
    seedUrl: manifest.seedUrl,
    siteGraphId: graph.id,
    navigation,
    routes,
    pages: allPages,
    landingPages,
    articlePages,
    categoryPages: [...categoryPages, ...tagPages],
    searchStructure,
    stats,
    warnings,
  };
}

// ─── Warnings ─────────────────────────────────────────────────────────────────

function collectWarnings(
  graph: ReturnType<typeof compileSiteGraph>,
  stencil: ReturnType<typeof getStencil> & object,
  pages: AssemblyPage[],
  opts: Required<AssemblyOptions>,
  warnings: AssemblyWarning[]
): void {
  // No content classified for the stencil's primary content type
  const primaryContentTypes = stencil.supportedContent
    .filter((c) => c.support === "primary")
    .map((c) => c.contentType);

  const hasMatchingContent = graph.classifications.some((c) =>
    primaryContentTypes.includes(c.contentType)
  );

  if (!hasMatchingContent && primaryContentTypes.length > 0) {
    warnings.push({
      code: "NO_PRIMARY_CONTENT",
      message:
        `The manifest contains no content classified as ${primaryContentTypes.join(" or ")}. ` +
        `The "${stencil.displayName}" stencil may not be the best fit.`,
      severity: "warning",
      affectedFeature: "article pages",
    });
  }

  // Truncated article pages
  if (graph.classifications.length > opts.maxArticlePages) {
    warnings.push({
      code: "ARTICLE_PAGES_TRUNCATED",
      message:
        `${graph.classifications.length} classified nodes found; only ` +
        `${opts.maxArticlePages} article pages were emitted (maxArticlePages limit).`,
      severity: "info",
      affectedFeature: "article pages",
    });
  }

  // No categories found when stencil expects them
  const expectsCategories = stencil.supportedPageTypes.some((p) => p.pageType === "category" && p.isRequired);
  if (expectsCategories && graph.categoryGraph.totalCategories === 0) {
    warnings.push({
      code: "NO_CATEGORIES",
      message:
        `The "${stencil.displayName}" stencil requires category pages but the manifest ` +
        `contains no discoverable categories.`,
      severity: "warning",
      affectedFeature: "category pages",
    });
  }

  // Asset quality
  if (graph.assetGraph.missingAssets.length > 0) {
    warnings.push({
      code: "MISSING_ASSETS",
      message: `${graph.assetGraph.missingAssets.length} assets referenced in the manifest could not be resolved.`,
      severity: "info",
      affectedFeature: "media",
    });
  }

  // Zero pages generated
  if (pages.length === 0) {
    warnings.push({
      code: "NO_PAGES_GENERATED",
      message: "The assembly produced zero pages. Check that the manifest contains crawled content.",
      severity: "error",
    });
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function countNavItems(items: AssemblyPage["components"] | SiteAssembly["navigation"]["primaryNav"]): number {
  let count = 0;
  const queue = [...(items as SiteAssembly["navigation"]["primaryNav"])];
  while (queue.length > 0) {
    const item = queue.shift()!;
    count++;
    if ("children" in item && Array.isArray(item.children)) {
      queue.push(...(item.children as typeof queue));
    }
  }
  return count;
}
