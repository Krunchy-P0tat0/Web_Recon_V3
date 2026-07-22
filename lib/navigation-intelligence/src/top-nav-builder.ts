/**
 * top-nav-builder.ts
 *
 * Builds the primary top navigation bar from:
 *   - SiteGraph.navigation.primary (NavItem tree)
 *   - SiteGraph.categoryGraph (category labels + slugs)
 *   - SiteGraph.routeMap (resolved paths)
 *   - StencilBlueprint.navigation (NavSpec — maxItems, hasDropdowns, hasCta, etc.)
 *
 * Deterministic rules (no AI):
 *   1. Homepage (depth=0, root) is always the first item — rendered as logo link only.
 *   2. Top-level primary NavItems → primary nav items (up to maxItems).
 *   3. If hasDropdowns=true, children become dropdown entries.
 *   4. Surplus items beyond maxItems → collected into a "More" overflow dropdown.
 *   5. Search trigger added when hasSearch=true.
 *   6. CTA button added when hasCta=true.
 */

import type { SiteGraph } from "@workspace/site-intelligence";
import type { NavItem } from "@workspace/site-intelligence";
import type { StencilBlueprint } from "@workspace/stencil-library";
import type { TopNavItem } from "./types.js";

const MAX_DROPDOWN_CHILDREN = 8;

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveRoute(nodeId: string, url: string, routeMap: SiteGraph["routeMap"]): string {
  const entry = routeMap.routes.find((r) => r.nodeId === nodeId);
  if (entry) return entry.route;
  try {
    return new URL(url).pathname || "/";
  } catch {
    return "/";
  }
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function labelFromPath(route: string): string {
  const segments = route.split("/").filter(Boolean);
  if (!segments.length) return "Home";
  const last = segments[segments.length - 1];
  return last
    .split(/[-_]/)
    .map(capitalise)
    .join(" ");
}

function navItemToTopNav(
  item: NavItem,
  routeMap: SiteGraph["routeMap"],
  hasDropdowns: boolean,
): TopNavItem {
  const path = resolveRoute(item.nodeId, item.url, routeMap);
  const label = item.title.trim() || labelFromPath(path);

  const children: TopNavItem[] = hasDropdowns
    ? item.children.slice(0, MAX_DROPDOWN_CHILDREN).map((child) =>
        navItemToTopNav(child, routeMap, false),
      )
    : [];

  return {
    label,
    path,
    nodeId: item.nodeId,
    children,
    hasDropdown: children.length > 0,
    isCta: false,
    isSearch: false,
    isOverflow: false,
  };
}

// ── Main builder ──────────────────────────────────────────────────────────────

export function buildTopNav(
  siteGraph: SiteGraph,
  blueprint: StencilBlueprint,
): TopNavItem[] {
  const spec = blueprint.navigation;
  const routeMap = siteGraph.routeMap;

  // Primary nav items come from SiteGraph.navigation.primary (already depth-sorted)
  const primaryItems = siteGraph.navigation.primary;

  // Separate root/home from content items
  const homeItem = primaryItems.find((n) => n.depth === 0) ?? primaryItems[0];
  const contentItems = primaryItems.filter((n) => n !== homeItem);

  // Budget: maxItems covers only content items (home is implicit via logo)
  const maxContent = Math.max(1, spec.maxItems);
  const visibleItems = contentItems.slice(0, maxContent);
  const overflowItems = contentItems.slice(maxContent);

  const items: TopNavItem[] = [];

  // 1. Content items
  for (const item of visibleItems) {
    items.push(navItemToTopNav(item, routeMap, spec.hasDropdowns));
  }

  // 2. Overflow → "More" dropdown
  if (overflowItems.length > 0) {
    const children: TopNavItem[] = overflowItems.map((item) =>
      navItemToTopNav(item, routeMap, false),
    );
    items.push({
      label: "More",
      path: "#",
      nodeId: null,
      children,
      hasDropdown: true,
      isCta: false,
      isSearch: false,
      isOverflow: true,
    });
  }

  // 3. Search trigger
  if (spec.hasSearch) {
    items.push({
      label: "Search",
      path: "#search",
      nodeId: null,
      children: [],
      hasDropdown: false,
      isCta: false,
      isSearch: true,
      isOverflow: false,
    });
  }

  // 4. CTA button
  if (spec.hasCta && spec.ctaLabel) {
    // Try to find a real page for the CTA (subscribe, contact, get-started patterns)
    const ctaPatterns = [/subscri/i, /contact/i, /get.started/i, /sign.up/i, /register/i];
    let ctaPath = "#cta";
    let ctaNodeId: string | null = null;
    for (const pattern of ctaPatterns) {
      const match = routeMap.routes.find(
        (r) => pattern.test(r.route) || pattern.test(r.slug),
      );
      if (match) {
        ctaPath = match.route;
        ctaNodeId = match.nodeId;
        break;
      }
    }
    items.push({
      label: spec.ctaLabel,
      path: ctaPath,
      nodeId: ctaNodeId,
      children: [],
      hasDropdown: false,
      isCta: true,
      isSearch: false,
      isOverflow: false,
    });
  }

  return items;
}
