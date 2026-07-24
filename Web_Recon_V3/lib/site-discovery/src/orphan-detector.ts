import type {
  DiscoveredRelationship,
  DiscoveredRoute,
  DuplicateRoute,
} from "./types.js";

// ─── Orphan detection ─────────────────────────────────────────────────────────
//
// A page route is an orphan when:
//  1. It has no parent (not the root), AND
//  2. No other route links to it (no route-links-route relationship pointing at it), AND
//  3. It is not a dynamic child of a catch-all, AND
//  4. It has no children of its own (it's a leaf nobody reaches)

export function detectOrphans(
  routes: DiscoveredRoute[],
  relationships: DiscoveredRelationship[]
): string[] {
  const linkedTargets = new Set(
    relationships
      .filter((r) => r.kind === "route-links-route" || r.kind === "route-redirects-route")
      .map((r) => r.toId)
  );

  const catchAllPaths = routes
    .filter((r) => r.pageType === "catch-all" || r.pageType === "optional-catch-all")
    .map((r) => r.path.replace(/\/\[\.{1,3}\w+\].*$/, ""));

  const orphanIds: string[] = [];

  for (const route of routes) {
    if (route.routeType === "api") continue;
    if (route.path === "/" || route.path === "/index") continue;
    if (route.duplicateOf !== null) continue;
    if (linkedTargets.has(route.id)) continue;
    if (route.parentRouteId !== null) continue;
    if (route.childRouteIds.length > 0) continue;

    const coveredByCatchAll = catchAllPaths.some(
      (prefix) => route.path.startsWith(prefix) && route.path !== prefix
    );
    if (coveredByCatchAll) continue;

    orphanIds.push(route.id);
  }

  for (const id of orphanIds) {
    const route = routes.find((r) => r.id === id);
    if (route) route.isOrphan = true;
  }

  return orphanIds;
}

// ─── Duplicate detection ──────────────────────────────────────────────────────
//
// Duplicates are routes where:
//  1. Exact same path (already detected during route analysis)
//  2. Param collision: /blog/[slug] and /blog/[id] are the same structural shape
//  3. Wildcard overlap: /blog/[slug] is covered by /blog/[...path]

function normalizeForComparison(path: string): string {
  return path.replace(/\[\[?\.{0,3}\w+\]?\]/g, "[*]");
}

export function detectDuplicates(routes: DiscoveredRoute[]): DuplicateRoute[] {
  const pageRoutes = routes.filter((r) => r.routeType === "page");
  const apiRoutes = routes.filter((r) => r.routeType === "api");
  const results: DuplicateRoute[] = [];

  function findDuplicatesIn(subset: DiscoveredRoute[]): void {
    const normalized = new Map<string, DiscoveredRoute[]>();

    for (const route of subset) {
      const key = normalizeForComparison(route.path);
      if (!normalized.has(key)) normalized.set(key, []);
      normalized.get(key)!.push(route);
    }

    for (const [normalizedPath, group] of normalized) {
      if (group.length < 2) continue;

      const uniquePaths = [...new Set(group.map((r) => r.path))];

      if (uniquePaths.length === 1) {
        results.push({
          path: uniquePaths[0]!,
          routeIds: group.map((r) => r.id),
          reason: "exact-path",
        });
        for (const route of group.slice(1)) {
          route.duplicateOf = group[0]!.id;
        }
      } else {
        results.push({
          path: normalizedPath,
          routeIds: group.map((r) => r.id),
          reason: "param-collision",
        });
        for (const route of group.slice(1)) {
          route.duplicateOf = group[0]!.id;
        }
      }
    }

    const catchAlls = subset.filter(
      (r) => r.pageType === "catch-all" || r.pageType === "optional-catch-all"
    );
    for (const catchAll of catchAlls) {
      const prefix = catchAll.path.replace(/\/\[\.{1,3}\w+\].*$/, "");
      const covered = subset.filter(
        (r) =>
          r.id !== catchAll.id &&
          r.path.startsWith(prefix + "/") &&
          !r.isDynamic &&
          !results.find((d) => d.routeIds.includes(r.id))
      );
      if (covered.length > 0) {
        results.push({
          path: catchAll.path,
          routeIds: [catchAll.id, ...covered.map((r) => r.id)],
          reason: "wildcard-overlap",
        });
      }
    }
  }

  findDuplicatesIn(pageRoutes);
  findDuplicatesIn(apiRoutes);

  return results;
}
