import type { DiscoveredRoute } from "@workspace/site-discovery";
import type { RouteEntry } from "@workspace/site-intelligence";
import type { EntityRef, MergeConflict, MergeDecision } from "./types.js";

let seq = 0;
const nextDecId = () => `dec-route-${(++seq).toString().padStart(4, "0")}`;
const nextConId = () => `con-route-${seq.toString().padStart(4, "0")}-${Date.now()}`;

// ─── Path utilities ───────────────────────────────────────────────────────────

function extractPathFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.startsWith("/") ? url : `/${url}`;
  }
}

function pathMatchesPattern(path: string, pattern: string): boolean {
  const pParts = pattern.split("/").filter(Boolean);
  const uParts = path.split("/").filter(Boolean);

  if (pattern.includes("[...") || pattern.includes("[[...")) {
    const staticPrefix = pattern.replace(/\/\[\.{1,3}.*$/, "");
    return path.startsWith(staticPrefix);
  }

  if (pParts.length !== uParts.length) return false;

  return pParts.every((seg, i) =>
    seg.startsWith("[") && seg.endsWith("]") ? true : seg === uParts[i]
  );
}

function normalizePattern(route: string): string {
  return route.replace(/:(\w+)/g, "[$1]");
}

type MatchResult = { route: DiscoveredRoute; exact: boolean } | null;

function findMatchingDiscoveryRoute(
  scrapedPath: string,
  discoveryRoutes: DiscoveredRoute[]
): MatchResult {
  const pageRoutes = discoveryRoutes.filter((r) => r.routeType === "page");

  const exact = pageRoutes.find((r) => normalizePattern(r.path) === scrapedPath);
  if (exact) return { route: exact, exact: true };

  const dynamic = pageRoutes.find((r) =>
    r.isDynamic && pathMatchesPattern(scrapedPath, normalizePattern(r.path))
  );
  if (dynamic) return { route: dynamic, exact: false };

  return null;
}

// ─── Decision builders ────────────────────────────────────────────────────────

function scrapedRef(entry: RouteEntry): EntityRef {
  return { id: entry.nodeId, path: entry.route, graph: "manifest" };
}

function discoveryRef(route: DiscoveredRoute): EntityRef {
  return { id: route.id, path: route.path, graph: "discovery" };
}

// ─── Main matcher ─────────────────────────────────────────────────────────────

export interface RouteMatchResult {
  decisions: MergeDecision[];
  conflicts: MergeConflict[];
  matchedDiscoveryRouteIds: Set<string>;
}

export function matchRoutes(
  discoveryGraph: { routes: DiscoveredRoute[] },
  routeEntries: RouteEntry[]
): RouteMatchResult {
  seq = 0;
  const decisions: MergeDecision[] = [];
  const conflicts: MergeConflict[] = [];
  const matchedDiscoveryRouteIds = new Set<string>();

  // Track how many scraped routes map to each dynamic discovery route
  const dynamicRouteUsage = new Map<string, RouteEntry[]>();

  for (const entry of routeEntries) {
    const scrapedPath = extractPathFromUrl(entry.url);
    const match = findMatchingDiscoveryRoute(scrapedPath, discoveryGraph.routes);

    if (!match) {
      // No discovery route handles this scraped page → CREATE
      decisions.push({
        id: nextDecId(),
        action: "CREATE",
        entityKind: "route",
        reason: `Scraped page '${scrapedPath}' has no matching route in the codebase. A new route must be created.`,
        confidence: 0.9,
        source: scrapedRef(entry),
        target: null,
        conflicts: [],
        metadata: { scrapedPath, scrapedUrl: entry.url, routeSource: entry.routeSource },
      });
      continue;
    }

    matchedDiscoveryRouteIds.add(match.route.id);

    if (match.exact) {
      // Exact static match → UPDATE (static page needs content refresh)
      decisions.push({
        id: nextDecId(),
        action: "UPDATE",
        entityKind: "route",
        reason: `Scraped page '${scrapedPath}' exactly matches existing static route '${match.route.path}'. Route exists; content needs to be updated.`,
        confidence: 0.95,
        source: scrapedRef(entry),
        target: discoveryRef(match.route),
        conflicts: [],
        metadata: { scrapedPath, isCollisionResolved: entry.isCollisionResolved },
      });
    } else {
      // Dynamic pattern match → EXTEND
      const existing = dynamicRouteUsage.get(match.route.id) ?? [];
      existing.push(entry);
      dynamicRouteUsage.set(match.route.id, existing);

      decisions.push({
        id: nextDecId(),
        action: "EXTEND",
        entityKind: "route",
        reason: `Scraped page '${scrapedPath}' fits existing dynamic route '${match.route.path}'. The route pattern already handles this content; no structural change needed.`,
        confidence: 0.88,
        source: scrapedRef(entry),
        target: discoveryRef(match.route),
        conflicts: [],
        metadata: {
          scrapedPath,
          matchedPattern: match.route.path,
          params: match.route.params,
          isCollisionResolved: entry.isCollisionResolved,
        },
      });
    }
  }

  // Detect duplicate-route-match conflicts: many scraped pages sharing one dynamic route is fine,
  // but if they'd produce the same slug, that's a collision
  for (const [routeId, entries] of dynamicRouteUsage) {
    const slugs = entries.map((e) => e.slug);
    const dupes = slugs.filter((s, i) => slugs.indexOf(s) !== i);
    if (dupes.length > 0) {
      const route = discoveryGraph.routes.find((r) => r.id === routeId)!;
      const conflict: MergeConflict = {
        id: nextConId(),
        kind: "duplicate-route-match",
        severity: "error",
        description: `Multiple scraped pages resolve to the same slug(s) [${dupes.join(", ")}] under dynamic route '${route.path}'. This would cause a route collision at runtime.`,
        sourceRef: null,
        targetRef: discoveryRef(route),
        resolution: "De-duplicate scraped pages or add a collision suffix to each slug before merging.",
        isBlocker: true,
      };
      conflicts.push(conflict);
      // Attach the conflict to all EXTEND decisions for this route
      for (const dec of decisions) {
        if (dec.target?.id === routeId && dec.action === "EXTEND") {
          dec.conflicts.push(conflict);
        }
      }
    }
  }

  // Archive or ignore unmatched discovery page routes
  const unmatchedDiscoveryRoutes = discoveryGraph.routes.filter(
    (r) => !matchedDiscoveryRouteIds.has(r.id)
  );

  for (const route of unmatchedDiscoveryRoutes) {
    if (route.routeType === "api") {
      decisions.push({
        id: nextDecId(),
        action: "IGNORE",
        entityKind: "route",
        reason: `API route '${route.path}' has no scraped content counterpart. API infrastructure routes are not affected by content merges.`,
        confidence: 0.99,
        source: null,
        target: discoveryRef(route),
        conflicts: [],
        metadata: { isApiRoute: true },
      });
      continue;
    }

    if (route.isOrphan) {
      const conflict: MergeConflict = {
        id: nextConId(),
        kind: "orphan-route",
        severity: "warning",
        description: `Discovery route '${route.path}' is an orphan (no inbound links) and has no scraped content. It may be safe to archive.`,
        sourceRef: null,
        targetRef: discoveryRef(route),
        resolution: "Verify this route is intentional. If not, archive or remove it.",
        isBlocker: false,
      };
      conflicts.push(conflict);

      decisions.push({
        id: nextDecId(),
        action: "ARCHIVE",
        entityKind: "route",
        reason: `Orphan route '${route.path}' exists in the codebase but no scraped content maps to it. Candidate for removal.`,
        confidence: 0.7,
        source: null,
        target: discoveryRef(route),
        conflicts: [conflict],
        metadata: { isOrphan: true },
      });
    } else {
      decisions.push({
        id: nextDecId(),
        action: "ARCHIVE",
        entityKind: "route",
        reason: `Codebase route '${route.path}' has no scraped content equivalent. This route may serve content not captured by the crawl, or may be obsolete.`,
        confidence: 0.6,
        source: null,
        target: discoveryRef(route),
        conflicts: [],
        metadata: { hasChildren: route.childRouteIds.length > 0 },
      });
    }
  }

  // Detect route-collision: a scraped page's path matches a discovery API route
  for (const entry of routeEntries) {
    const scrapedPath = extractPathFromUrl(entry.url);
    const apiMatch = discoveryGraph.routes.find(
      (r) => r.routeType === "api" && pathMatchesPattern(scrapedPath, normalizePattern(r.path))
    );
    if (apiMatch) {
      const conflict: MergeConflict = {
        id: nextConId(),
        kind: "route-collision",
        severity: "error",
        description: `Scraped page '${scrapedPath}' collides with API route '${apiMatch.path}'. A page and an API cannot share the same URL path.`,
        sourceRef: scrapedRef(entry),
        targetRef: discoveryRef(apiMatch),
        resolution: "Rename one of the conflicting routes before merging.",
        isBlocker: true,
      };
      conflicts.push(conflict);
    }
  }

  return { decisions, conflicts, matchedDiscoveryRouteIds };
}
