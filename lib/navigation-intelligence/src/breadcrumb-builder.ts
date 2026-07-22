/**
 * breadcrumb-builder.ts
 *
 * Builds per-page breadcrumb trails from SiteGraph.navigation.breadcrumbs.
 * Only generates trails for stencils that support "breadcrumbs".
 *
 * Rules:
 *   1. Each BreadcrumbEntry in SiteGraph.navigation.breadcrumbs[nodeId]
 *      is resolved to a route via routeMap.
 *   2. The current page (last entry in the trail) is marked isCurrentPage=true.
 *   3. The homepage is always the first breadcrumb item (label "Home").
 *   4. Trails with only one item (the current page) are kept — they represent
 *      the homepage itself and are still valid breadcrumbs.
 *   5. Pages not found in breadcrumbs (orphans) are given a single-item trail.
 */

import type { SiteGraph } from "@workspace/site-intelligence";
import type { StencilBlueprint } from "@workspace/stencil-library";
import type { BreadcrumbTrail, BreadcrumbItem } from "./types.js";

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

function labelForItem(title: string, route: string, isFirst: boolean): string {
  if (isFirst) return "Home";
  if (title.trim()) return title.trim();
  const last = route.split("/").filter(Boolean).pop();
  if (!last) return "Home";
  return last
    .split(/[-_]/)
    .map((s: string) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

// ── Main builder ──────────────────────────────────────────────────────────────

export function buildBreadcrumbs(
  siteGraph: SiteGraph,
  blueprint: StencilBlueprint,
): Record<string, BreadcrumbTrail> {
  const isEnabled = blueprint.supportedNavigationStructures.includes("breadcrumbs");

  if (!isEnabled) return {};

  const trails: Record<string, BreadcrumbTrail> = {};
  const routeMap = siteGraph.routeMap;
  const rawBreadcrumbs = siteGraph.navigation.breadcrumbs;

  for (const [pageNodeId, entries] of Object.entries(rawBreadcrumbs)) {
    const items: BreadcrumbItem[] = entries.map((entry, idx) => {
      const path = resolveRoute(entry.nodeId, entry.url, routeMap);
      const isCurrentPage = idx === entries.length - 1;
      const label = labelForItem(entry.title, path, idx === 0);
      return {
        label,
        path,
        nodeId: entry.nodeId,
        isCurrentPage,
      };
    });

    // Find the page's own URL for the trail record
    const ownEntry = routeMap.routes.find((r) => r.nodeId === pageNodeId);
    const pageUrl = ownEntry?.route ?? siteGraph.seedUrl;

    trails[pageNodeId] = { nodeId: pageNodeId, url: pageUrl, items };
  }

  return trails;
}
