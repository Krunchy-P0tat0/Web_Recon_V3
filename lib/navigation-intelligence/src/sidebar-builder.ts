/**
 * sidebar-builder.ts
 *
 * Builds the persistent sidebar navigation for documentation/technical stencils.
 * Only active when "sidebar" is in blueprint.supportedNavigationStructures.
 *
 * Rules:
 *   - Source: SiteGraph.navigation.primary (hierarchical NavItem tree)
 *   - Top-level items become sidebar sections (grouped under a heading when
 *     the item has a title and children; ungrouped when it's a single root).
 *   - Sections are ordered by the NavItem order in primary.
 *   - Nodes are capped at 3 levels deep (sidebar gets unwieldy beyond that).
 *   - Flat item list is generated for step-nav (prev/next) functionality.
 *   - The sidebar is always expanded at depth 0 and 1; depth 2+ starts collapsed.
 */

import type { SiteGraph, NavItem } from "@workspace/site-intelligence";
import type { StencilBlueprint } from "@workspace/stencil-library";
import type { SidebarBlueprint, SidebarSection, SidebarNode } from "./types.js";

const MAX_SIDEBAR_DEPTH = 3;

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

function navItemToSidebarNode(
  item: NavItem,
  routeMap: SiteGraph["routeMap"],
  depth: number,
): SidebarNode {
  const path = resolveRoute(item.nodeId, item.url, routeMap);
  const label = item.title.trim() || path.split("/").filter(Boolean).pop() || "Page";

  const children: SidebarNode[] =
    depth < MAX_SIDEBAR_DEPTH - 1
      ? item.children.map((child) =>
          navItemToSidebarNode(child, routeMap, depth + 1),
        )
      : [];

  return {
    label,
    path,
    nodeId: item.nodeId,
    depth,
    children,
    isExpanded: depth < 2,
    isLeaf: children.length === 0,
  };
}

function flattenNodes(
  nodes: SidebarNode[],
): Array<{ label: string; path: string; nodeId: string | null; depth: number }> {
  const result: Array<{ label: string; path: string; nodeId: string | null; depth: number }> = [];
  for (const node of nodes) {
    result.push({ label: node.label, path: node.path, nodeId: node.nodeId, depth: node.depth });
    if (node.children.length > 0) {
      result.push(...flattenNodes(node.children));
    }
  }
  return result;
}

// ── Main builder ──────────────────────────────────────────────────────────────

export function buildSidebar(
  siteGraph: SiteGraph,
  blueprint: StencilBlueprint,
): SidebarBlueprint {
  const isEnabled =
    blueprint.navigation.hasPersistentSidebar ||
    blueprint.supportedNavigationStructures.includes("sidebar");

  if (!isEnabled) {
    return { sections: [], flatItems: [], totalItems: 0, isEnabled: false };
  }

  const primaryItems = siteGraph.navigation.primary;
  const routeMap = siteGraph.routeMap;

  // If there's a clear root + top-level sections, group into sections.
  // Otherwise treat every primary item as its own section.
  const sections: SidebarSection[] = [];

  for (const item of primaryItems) {
    if (item.children.length > 0) {
      // Item becomes a section heading; its children become nodes
      const nodes: SidebarNode[] = item.children.map((child) =>
        navItemToSidebarNode(child, routeMap, 0),
      );
      const headingPath = resolveRoute(item.nodeId, item.url, routeMap);
      const headingLabel = item.title.trim() || headingPath.split("/").filter(Boolean).pop() || "Section";
      // Include the parent itself as first node so it's navigable
      nodes.unshift({
        label: headingLabel,
        path: headingPath,
        nodeId: item.nodeId,
        depth: 0,
        children: [],
        isExpanded: true,
        isLeaf: true,
      });
      sections.push({ heading: headingLabel, nodes });
    } else {
      // Leaf item at top level — standalone section with no heading
      const node = navItemToSidebarNode(item, routeMap, 0);
      sections.push({ heading: null, nodes: [node] });
    }
  }

  const flatItems = sections.flatMap((s) => flattenNodes(s.nodes));

  return {
    sections,
    flatItems,
    totalItems: flatItems.length,
    isEnabled: true,
  };
}
