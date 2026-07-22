import type { SiteGraph, NavItem } from "@workspace/site-intelligence";
import type { StencilDefinition } from "@workspace/stencil-registry";
import type {
  AssemblyNavigation,
  AssemblyNavItem,
  AssemblyMegaMenuSection,
  AssemblyFooterGroup,
  AssemblyBreadcrumbSchema,
  AssemblyTagCloudItem,
  AssemblyCategoryNode,
  AssemblyFilterConfig,
  AssemblyPaginationConfig,
} from "./types.js";

/**
 * Build the full AssemblyNavigation from a SiteGraph and the chosen stencil.
 * Only structures listed in the stencil's supportedNavigationStructures
 * are populated — others are returned empty.
 */
export function buildNavigation(
  graph: SiteGraph,
  stencil: StencilDefinition,
  pageSize: number,
  primaryNavMaxItems: number,
  footerNavMaxGroups: number
): AssemblyNavigation {
  const active = stencil.supportedNavigationStructures;

  const primaryNav   = active.includes("primary-header")
    ? buildPrimaryNav(graph, primaryNavMaxItems) : [];

  const sidebarNav   = active.includes("sidebar")
    ? buildSidebarNav(graph) : [];

  const megaMenuSections = active.includes("mega-menu")
    ? buildMegaMenu(graph) : [];

  const breadcrumbs: AssemblyBreadcrumbSchema = {
    enabled: active.includes("breadcrumbs"),
    example: active.includes("breadcrumbs")
      ? buildBreadcrumbExample(graph) : [],
  };

  const footerGroups = active.includes("footer-grouped")
    ? buildFooterGroups(graph, footerNavMaxGroups) : [];

  const tagCloud = active.includes("tag-cloud")
    ? buildTagCloud(graph) : [];

  const categoryTree = active.includes("category-tree")
    ? buildCategoryTree(graph) : [];

  const filterBar = active.includes("filter-bar")
    ? buildFilterBar(graph) : null;

  const pagination: AssemblyPaginationConfig = {
    enabled: active.includes("pagination"),
    pageSize,
    routePattern: "/categories/:slug/page/:page",
  };

  const stepNavEnabled = active.includes("step-nav");

  return {
    activeStructures: active,
    primaryNav,
    sidebarNav,
    megaMenuSections,
    breadcrumbs,
    footerGroups,
    tagCloud,
    categoryTree,
    filterBar,
    pagination,
    stepNavEnabled,
  };
}

// ─── Primary nav ──────────────────────────────────────────────────────────────

function buildPrimaryNav(graph: SiteGraph, maxItems: number): AssemblyNavItem[] {
  const items = graph.navigation.primary
    .slice(0, maxItems)
    .map((n, i) => navItemToAssembly(n, graph, i));
  return items;
}

function navItemToAssembly(
  node: NavItem,
  graph: SiteGraph,
  _order: number
): AssemblyNavItem {
  const routeEntry = graph.routeMap.routes.find((r) => r.nodeId === node.nodeId);
  const route = routeEntry?.route ?? deriveRouteFromUrl(node.url);

  return {
    id: `nav__${node.nodeId}`,
    route,
    label: node.title || route,
    depth: node.depth,
    children: node.children.map((child, i) => navItemToAssembly(child, graph, i)),
  };
}

// ─── Sidebar nav (documentation) ──────────────────────────────────────────────

function buildSidebarNav(graph: SiteGraph): AssemblyNavItem[] {
  const allNavItems = flattenNavItems(graph.navigation.primary);
  const sorted = allNavItems.sort((a, b) => a.depth - b.depth);
  return sorted.slice(0, 200).map((n, i) => navItemToAssembly(n, graph, i));
}

function flattenNavItems(items: NavItem[]): NavItem[] {
  const result: NavItem[] = [];
  const queue = [...items];
  while (queue.length > 0) {
    const item = queue.shift()!;
    result.push(item);
    queue.push(...item.children);
  }
  return result;
}

// ─── Mega menu (magazine / marketplace) ──────────────────────────────────────

function buildMegaMenu(graph: SiteGraph): AssemblyMegaMenuSection[] {
  const topCategories = graph.categoryGraph.categories
    .filter((c) => c.depth === 0 && c.pageCount > 0)
    .slice(0, 6);

  return topCategories.map((cat) => {
    const childCats = graph.categoryGraph.categories
      .filter((c) => cat.childIds.includes(c.id))
      .slice(0, 12);

    return {
      label: cat.label,
      route: `/categories/${cat.slug}`,
      columns: [
        {
          heading: cat.label,
          items: childCats.map((child) => ({
            label: child.label,
            route: `/categories/${child.slug}`,
          })),
        },
      ],
    };
  });
}

// ─── Breadcrumbs ──────────────────────────────────────────────────────────────

function buildBreadcrumbExample(graph: SiteGraph): Array<{ label: string; route: string }> {
  const firstCategory = graph.categoryGraph.categories.find((c) => c.pageCount > 0);
  const example: Array<{ label: string; route: string }> = [{ label: "Home", route: "/" }];

  if (firstCategory) {
    example.push({ label: firstCategory.label, route: `/categories/${firstCategory.slug}` });
    const firstPageId = firstCategory.pageIds[0];
    if (firstPageId) {
      const route = graph.routeMap.routes.find((r) => r.nodeId === firstPageId);
      if (route) {
        example.push({ label: "Article Title", route: route.route });
      }
    }
  }

  return example;
}

// ─── Footer groups ────────────────────────────────────────────────────────────

function buildFooterGroups(graph: SiteGraph, maxGroups: number): AssemblyFooterGroup[] {
  const groups: AssemblyFooterGroup[] = [];

  // Top-level categories
  const topCats = graph.categoryGraph.categories
    .filter((c) => c.depth === 0 && c.pageCount > 0)
    .slice(0, maxGroups - 1);

  for (const cat of topCats) {
    const childPages = graph.routeMap.routes
      .filter((r) => cat.pageIds.includes(r.nodeId))
      .slice(0, 6);

    groups.push({
      label: cat.label,
      items: childPages.map((r) => ({
        label: r.slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        route: r.route,
      })),
    });
  }

  // Utility group
  groups.push({
    label: "Site",
    items: [
      { label: "Home",    route: "/" },
      { label: "Search",  route: "/search" },
      { label: "Sitemap", route: "/sitemap" },
    ],
  });

  return groups;
}

// ─── Tag cloud ────────────────────────────────────────────────────────────────

function buildTagCloud(graph: SiteGraph): AssemblyTagCloudItem[] {
  const maxFreq = Math.max(...graph.categoryGraph.tags.map((t) => t.frequency), 1);

  return graph.categoryGraph.tags
    .filter((t) => t.frequency >= 2)
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 30)
    .map((t) => ({
      tag: t.tag,
      route: `/tags/${slugify(t.tag)}`,
      frequency: t.frequency,
      weight: Math.ceil((t.frequency / maxFreq) * 5),
    }));
}

// ─── Category tree ────────────────────────────────────────────────────────────

function buildCategoryTree(graph: SiteGraph): AssemblyCategoryNode[] {
  const roots = graph.categoryGraph.categories.filter((c) => c.parentId === null);
  return roots.map((c) => categoryToNode(c, graph));
}

function categoryToNode(
  cat: SiteGraph["categoryGraph"]["categories"][number],
  graph: SiteGraph
): AssemblyCategoryNode {
  const children = graph.categoryGraph.categories
    .filter((c) => cat.childIds.includes(c.id))
    .map((child) => categoryToNode(child, graph));

  return {
    id: cat.id,
    label: cat.label,
    slug: cat.slug,
    route: `/categories/${cat.slug}`,
    pageCount: cat.pageCount,
    depth: cat.depth,
    children,
  };
}

// ─── Filter bar (marketplace / directory) ────────────────────────────────────

function buildFilterBar(graph: SiteGraph): AssemblyFilterConfig {
  const categories = graph.categoryGraph.categories
    .filter((c) => c.pageCount > 0)
    .map((c) => ({ id: c.id, label: c.label, slug: c.slug, count: c.pageCount }))
    .slice(0, 50);

  const tags = graph.categoryGraph.tags
    .filter((t) => t.frequency >= 2)
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 20)
    .map((t) => ({ tag: t.tag, count: t.frequency }));

  return {
    categories,
    tags,
    sortOptions: ["relevance", "newest", "alphabetical", "popularity"],
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deriveRouteFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/$/, "") || "/";
  } catch {
    return "/";
  }
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}
