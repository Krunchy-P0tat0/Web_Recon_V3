/**
 * navigation.ts — Navigation Intelligence Engine
 *
 * Generates the full NavigationTree from a manifest's node graph:
 *   - Primary Navigation: depth=1 nodes with their subtrees
 *   - Secondary Navigation: depth=2 nodes grouped under their parent
 *   - Breadcrumbs: per-node ancestry chain
 *   - Orphan detection: nodes with no parent reference (excl. root/index)
 *   - Duplicate path detection: multiple nodes mapping to same route
 */

import type {
  PortablePageNode,
  NavItem,
  BreadcrumbEntry,
  OrphanPage,
  DuplicatePath,
  NavigationTree,
} from "./types";

// ---------------------------------------------------------------------------
// Build node lookup map
// ---------------------------------------------------------------------------

function buildNodeMap(nodes: PortablePageNode[]): Map<string, PortablePageNode> {
  const map = new Map<string, PortablePageNode>();
  for (const node of nodes) {
    map.set(node.id, node);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Build NavItem tree recursively (depth-limited to avoid cycles)
// ---------------------------------------------------------------------------

function buildNavItem(
  node: PortablePageNode,
  nodeMap: Map<string, PortablePageNode>,
  orphanIds: Set<string>,
  depth = 0,
  maxDepth = 6
): NavItem {
  const children: NavItem[] = [];

  if (depth < maxDepth) {
    for (const childId of node.relationships.childIds) {
      const child = nodeMap.get(childId);
      if (child && child.nodeType !== "root" && child.nodeType !== "asset") {
        children.push(buildNavItem(child, nodeMap, orphanIds, depth + 1, maxDepth));
      }
    }
  }

  // Sort children by pagination index, then title
  children.sort((a, b) => {
    const aNode = nodeMap.get(a.nodeId);
    const bNode = nodeMap.get(b.nodeId);
    const aIdx = aNode?.relationships.paginationIndex ?? 999;
    const bIdx = bNode?.relationships.paginationIndex ?? 999;
    if (aIdx !== bIdx) return aIdx - bIdx;
    return a.title.localeCompare(b.title);
  });

  return {
    nodeId: node.id,
    url: node.metadata.url,
    title: node.metadata.title || node.metadata.url,
    depth: node.relationships.depth,
    children,
    isOrphan: orphanIds.has(node.id),
  };
}

// ---------------------------------------------------------------------------
// Detect orphan pages
// ---------------------------------------------------------------------------

function detectOrphans(
  nodes: PortablePageNode[],
  nodeMap: Map<string, PortablePageNode>
): OrphanPage[] {
  const orphans: OrphanPage[] = [];

  for (const node of nodes) {
    if (node.nodeType === "root" || node.nodeType === "asset") continue;
    if (node.relationships.depth === 0) continue; // root level is expected to have no parent

    const parentId = node.relationships.parentId;

    if (!parentId) {
      // No parent reference — orphan
      orphans.push({
        nodeId: node.id,
        url: node.metadata.url,
        title: node.metadata.title,
        reason: "no_parent",
      });
      continue;
    }

    const parent = nodeMap.get(parentId);
    if (!parent) {
      // Parent referenced but not in manifest
      orphans.push({
        nodeId: node.id,
        url: node.metadata.url,
        title: node.metadata.title,
        reason: "broken_parent_ref",
      });
      continue;
    }

    // Check depth consistency
    if (node.relationships.depth !== parent.relationships.depth + 1) {
      orphans.push({
        nodeId: node.id,
        url: node.metadata.url,
        title: node.metadata.title,
        reason: "depth_mismatch",
      });
    }
  }

  return orphans;
}

// ---------------------------------------------------------------------------
// Build breadcrumb trails
// ---------------------------------------------------------------------------

function buildBreadcrumbs(
  nodes: PortablePageNode[],
  nodeMap: Map<string, PortablePageNode>
): Record<string, BreadcrumbEntry[]> {
  const result: Record<string, BreadcrumbEntry[]> = {};

  for (const node of nodes) {
    if (node.nodeType === "asset") continue;

    const trail: BreadcrumbEntry[] = [];
    let current: PortablePageNode | undefined = node;
    const visited = new Set<string>();

    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      trail.unshift({
        nodeId: current.id,
        url: current.metadata.url,
        title: current.metadata.title || current.metadata.url,
        depth: current.relationships.depth,
      });

      if (!current.relationships.parentId) break;
      current = nodeMap.get(current.relationships.parentId);
    }

    result[node.id] = trail;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Detect duplicate paths (same URL or same derived slug)
// ---------------------------------------------------------------------------

function detectDuplicatePaths(nodes: PortablePageNode[]): DuplicatePath[] {
  const urlMap = new Map<string, string[]>();

  for (const node of nodes) {
    if (node.nodeType === "root" || node.nodeType === "asset") continue;
    const url = node.metadata.url.toLowerCase().replace(/\/$/, "");
    const existing = urlMap.get(url) ?? [];
    existing.push(node.id);
    urlMap.set(url, existing);
  }

  const duplicates: DuplicatePath[] = [];
  for (const [url, nodeIds] of urlMap.entries()) {
    if (nodeIds.length > 1) {
      duplicates.push({ route: url, nodeIds });
    }
  }

  return duplicates;
}

// ---------------------------------------------------------------------------
// Public: build full NavigationTree
// ---------------------------------------------------------------------------

export function buildNavigationTree(nodes: PortablePageNode[]): NavigationTree {
  const nodeMap = buildNodeMap(nodes);

  // Identify orphans first (needed for NavItem construction)
  const orphans = detectOrphans(nodes, nodeMap);
  const orphanIds = new Set(orphans.map((o) => o.nodeId));

  // Find root/index nodes (depth=0 or nodeType root/index)
  const primaryRoots = nodes.filter(
    (n) =>
      n.nodeType !== "asset" &&
      n.nodeType !== "root" &&
      (n.relationships.depth === 1 || (n.relationships.depth === 0 && n.nodeType === "index"))
  );

  // Sort primary nav by pagination index then title
  primaryRoots.sort((a, b) => {
    const aIdx = a.relationships.paginationIndex ?? 999;
    const bIdx = b.relationships.paginationIndex ?? 999;
    if (aIdx !== bIdx) return aIdx - bIdx;
    return a.metadata.title.localeCompare(b.metadata.title);
  });

  const primary: NavItem[] = primaryRoots.map((n) =>
    buildNavItem(n, nodeMap, orphanIds, 0, 2)
  );

  // Secondary nav: depth=2 nodes not already in primary subtrees
  const secondaryNodes = nodes.filter(
    (n) =>
      n.nodeType !== "asset" &&
      n.nodeType !== "root" &&
      n.relationships.depth === 2
  );

  const secondary: NavItem[] = secondaryNodes
    .slice(0, 50) // cap secondary nav
    .map((n) => buildNavItem(n, nodeMap, orphanIds, 0, 1));

  // Breadcrumbs
  const breadcrumbs = buildBreadcrumbs(nodes, nodeMap);

  // Duplicates
  const duplicatePaths = detectDuplicatePaths(nodes);

  // Max depth
  const maxDepth = nodes.reduce((m, n) => Math.max(m, n.relationships.depth), 0);

  const navigableNodes = nodes.filter(
    (n) => n.nodeType !== "asset" && n.nodeType !== "root"
  );

  return {
    primary,
    secondary,
    breadcrumbs,
    orphanPages: orphans,
    duplicatePaths,
    totalNavigableNodes: navigableNodes.length,
    maxDepth,
  };
}
