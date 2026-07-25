/**
 * navigation-engine.ts — Full Navigation Blueprint Generator
 *
 * Converts the SiteGraph's NavigationTree into a complete NavigationBlueprint
 * with primary nav, secondary nav, footer nav groups, breadcrumb chains,
 * and contextual navigation entries.
 *
 * The NavigationBlueprint references page IDs (not nodeIds) so the renderer
 * can resolve routes without consulting the SiteGraph directly.
 */

import type { SiteGraph } from "@workspace/site-intelligence";
import type {
  NavigationBlueprint,
  NavBlueprintItem,
  FooterBlueprint,
  FooterNavGroup,
  BreadcrumbBlueprint,
  ContextualNavEntry,
  PageDefinition,
} from "./types";

// ---------------------------------------------------------------------------
// Convert SiteGraph NavItem → NavBlueprintItem (using page route map)
// ---------------------------------------------------------------------------

function navItemToBlueprint(
  navItem: SiteGraph["navigation"]["primary"][number],
  pageMap: Map<string, PageDefinition>,
  order: number
): NavBlueprintItem | null {
  const page = pageMap.get(`page__${navItem.nodeId}`);
  const route = page?.route ?? navItem.url;

  return {
    pageId: `page__${navItem.nodeId}`,
    route,
    label: navItem.title || route,
    depth: navItem.depth,
    children: navItem.children
      .map((child, idx) => navItemToBlueprint(child, pageMap, idx))
      .filter((item): item is NavBlueprintItem => item !== null),
    isActive: false,
    order,
  };
}

// ---------------------------------------------------------------------------
// Build footer navigation groups from categories + common pages
// ---------------------------------------------------------------------------

function buildFooter(
  graph: SiteGraph,
  pageMap: Map<string, PageDefinition>
): FooterBlueprint {
  const groups: FooterNavGroup[] = [];

  // Category group
  const topCategories = graph.categoryGraph.categories
    .filter((c) => c.depth === 0 && c.pageCount > 0)
    .slice(0, 6);

  if (topCategories.length > 0) {
    groups.push({
      label: "Categories",
      items: topCategories.map((c) => ({
        label: c.label,
        route: `/category/${c.slug}`,
      })),
    });
  }

  // Content type group
  const contentGroups: FooterNavGroup["items"] = [];
  if (graph.stats.byContentType.ARTICLE > 0)
    contentGroups.push({ label: "Articles", route: "/category/articles" });
  if (graph.stats.byContentType.GUIDE > 0)
    contentGroups.push({ label: "Guides", route: "/category/guides" });
  if (graph.stats.byContentType.DOCS > 0)
    contentGroups.push({ label: "Documentation", route: "/category/docs" });
  if (graph.stats.byContentType.PORTFOLIO > 0)
    contentGroups.push({ label: "Portfolio", route: "/category/portfolio" });

  if (contentGroups.length > 0) {
    groups.push({ label: "Content", items: contentGroups });
  }

  // Site group
  const siteGroup: FooterNavGroup["items"] = [
    { label: "Home", route: "/" },
  ];
  if (graph.stats.totalImages >= 20) {
    siteGroup.push({ label: "Gallery", route: "/gallery" });
  }
  siteGroup.push({ label: "Search", route: "/search" });

  groups.push({ label: "Site", items: siteGroup });

  const hostname = (() => {
    try { return new URL(graph.seedUrl).hostname; }
    catch { return graph.seedUrl; }
  })();

  return {
    groups,
    copyrightText: `© ${new Date().getFullYear()} ${hostname}`,
    showSitemapLink: true,
    showSearchLink: true,
  };
}

// ---------------------------------------------------------------------------
// Build breadcrumb blueprints from SiteGraph breadcrumb chains
// ---------------------------------------------------------------------------

function buildBreadcrumbs(
  graph: SiteGraph
): Record<string, BreadcrumbBlueprint[]> {
  const result: Record<string, BreadcrumbBlueprint[]> = {};

  for (const [nodeId, trail] of Object.entries(graph.navigation.breadcrumbs)) {
    const pageId = `page__${nodeId}`;
    result[pageId] = trail.map((entry) => ({
      pageId: `page__${entry.nodeId}`,
      route: graph.routeMap.routes.find((r) => r.nodeId === entry.nodeId)?.route ?? entry.url,
      label: entry.title || entry.url,
      depth: entry.depth,
    }));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Build contextual navigation
// ---------------------------------------------------------------------------

function buildContextualNav(
  graph: SiteGraph
): ContextualNavEntry[] {
  const entries: ContextualNavEntry[] = [];

  for (const navItem of graph.navigation.primary) {
    const entry: ContextualNavEntry = {
      pageId: `page__${navItem.nodeId}`,
      siblingPageIds: graph.navigation.primary
        .filter((n) => n.nodeId !== navItem.nodeId)
        .map((n) => `page__${n.nodeId}`),
      parentPageId: null,
      childPageIds: navItem.children.map((c) => `page__${c.nodeId}`),
    };
    entries.push(entry);

    // Secondary level
    for (const child of navItem.children) {
      entries.push({
        pageId: `page__${child.nodeId}`,
        siblingPageIds: navItem.children
          .filter((c) => c.nodeId !== child.nodeId)
          .map((c) => `page__${c.nodeId}`),
        parentPageId: `page__${navItem.nodeId}`,
        childPageIds: child.children.map((gc) => `page__${gc.nodeId}`),
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Public: build NavigationBlueprint
// ---------------------------------------------------------------------------

export function buildNavigationBlueprint(
  graph: SiteGraph,
  pages: PageDefinition[]
): NavigationBlueprint {
  const pageMap = new Map<string, PageDefinition>(
    pages.map((p) => [p.id, p])
  );

  const primary: NavBlueprintItem[] = graph.navigation.primary
    .map((item, idx) => navItemToBlueprint(item, pageMap, idx))
    .filter((item): item is NavBlueprintItem => item !== null)
    .slice(0, 8); // cap primary nav

  const secondary: NavBlueprintItem[] = graph.navigation.secondary
    .map((item, idx) => navItemToBlueprint(item, pageMap, idx))
    .filter((item): item is NavBlueprintItem => item !== null)
    .slice(0, 20);

  const footer = buildFooter(graph, pageMap);
  const breadcrumbs = buildBreadcrumbs(graph);
  const contextual = buildContextualNav(graph);

  return {
    primary,
    secondary,
    footer,
    breadcrumbs,
    contextual,
    totalPrimaryItems: primary.length,
    totalSecondaryItems: secondary.length,
  };
}
