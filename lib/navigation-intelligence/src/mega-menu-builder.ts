/**
 * mega-menu-builder.ts
 *
 * Builds the mega-menu blueprint from the CategoryGraph.
 * Only active when "mega-menu" is in blueprint.supportedNavigationStructures.
 *
 * Rules:
 *   - One mega-menu section per top-level category (depth=0 categories).
 *   - Each section has columns: first column = sub-categories, second = pages.
 *   - Sub-category column: up to 6 child categories as links.
 *   - Page column: up to 5 most prominent pages from that category's pageIds.
 *   - Sections capped at blueprint.navigation.maxItems top-level categories.
 *   - If a category has no children and < 3 pages, it is skipped (too thin).
 */

import type { SiteGraph, CategoryNode } from "@workspace/site-intelligence";
import type { StencilBlueprint } from "@workspace/stencil-library";
import type { MegaMenuBlueprint, MegaMenuSection, MegaMenuColumn, MegaMenuLink } from "./types.js";

const MAX_SUBCATEGORY_LINKS = 6;
const MAX_PAGE_LINKS = 5;
const MIN_PAGES_TO_INCLUDE = 3;

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveRoute(nodeId: string, routeMap: SiteGraph["routeMap"]): string {
  return routeMap.routes.find((r) => r.nodeId === nodeId)?.route ?? "#";
}

function categoryPath(category: CategoryNode, routeMap: SiteGraph["routeMap"]): string {
  // Try routeMap first; fall back to /category/<slug>
  const fromRoute = routeMap.routes.find(
    (r) => r.slug === category.slug || r.route.endsWith(`/${category.slug}`),
  );
  return fromRoute?.route ?? `/category/${category.slug}`;
}

function buildPageLinks(
  pageIds: string[],
  routeMap: SiteGraph["routeMap"],
  siteGraph: SiteGraph,
): MegaMenuLink[] {
  return pageIds.slice(0, MAX_PAGE_LINKS).map((nodeId) => {
    const route = resolveRoute(nodeId, routeMap);
    const classification = siteGraph.classifications.find((c) => c.nodeId === nodeId);
    const label =
      routeMap.routes.find((r) => r.nodeId === nodeId)?.slug
        .split(/[-_]/)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(" ") ?? route.split("/").filter(Boolean).pop() ?? nodeId;
    return {
      label,
      path: route,
      nodeId,
      description: classification ? null : null,
    };
  });
}

function buildSection(
  category: CategoryNode,
  allCategories: CategoryNode[],
  routeMap: SiteGraph["routeMap"],
  siteGraph: SiteGraph,
): MegaMenuSection {
  const columns: MegaMenuColumn[] = [];

  // Sub-category column
  const childCategories = allCategories
    .filter((c) => c.parentId === category.id)
    .slice(0, MAX_SUBCATEGORY_LINKS);

  if (childCategories.length > 0) {
    const subLinks: MegaMenuLink[] = childCategories.map((child) => ({
      label: child.label,
      path: categoryPath(child, routeMap),
      nodeId: null,
      description: null,
    }));
    columns.push({
      heading: category.label,
      categoryId: category.id,
      links: subLinks,
    });
  }

  // Page column
  const pageLinks = buildPageLinks(category.pageIds, routeMap, siteGraph);
  if (pageLinks.length > 0) {
    columns.push({
      heading: childCategories.length > 0 ? "Featured" : category.label,
      categoryId: category.id,
      links: pageLinks,
    });
  }

  const totalLinks = columns.reduce((n, col) => n + col.links.length, 0);

  return {
    triggerLabel: category.label,
    triggerPath: categoryPath(category, routeMap),
    columns,
    totalLinks,
  };
}

// ── Main builder ──────────────────────────────────────────────────────────────

export function buildMegaMenu(
  siteGraph: SiteGraph,
  blueprint: StencilBlueprint,
): MegaMenuBlueprint {
  const isEnabled = blueprint.supportedNavigationStructures.includes("mega-menu");

  if (!isEnabled) {
    return { sections: [], isEnabled: false };
  }

  const { categories } = siteGraph.categoryGraph;
  const routeMap = siteGraph.routeMap;

  // Top-level categories (no parent) that are thick enough
  const topLevel = categories
    .filter(
      (c) =>
        c.parentId === null &&
        c.pageCount >= MIN_PAGES_TO_INCLUDE,
    )
    .slice(0, blueprint.navigation.maxItems);

  const sections: MegaMenuSection[] = topLevel.map((cat) =>
    buildSection(cat, categories, routeMap, siteGraph),
  );

  return { sections, isEnabled: true };
}
