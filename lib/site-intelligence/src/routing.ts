/**
 * routing.ts — Route Intelligence Engine
 *
 * Generates a deterministic, collision-safe RouteMap from manifest nodes.
 *
 * Route generation strategy (in priority order):
 *   1. Extract clean path segments from URL (most stable)
 *   2. Derive slug from page title (fallback)
 *   3. Use nodeId hex prefix (final fallback)
 *
 * Collision safety: when two nodes produce the same route, the second
 * gets a numeric suffix (-2, -3, ...) appended to its slug.
 *
 * Stability: routes are keyed by nodeId (SHA-256 of URL) so they are
 * stable across re-crawls even when content moves.
 */

import type {
  PortablePageNode,
  RouteEntry,
  RouteMap,
} from "./types";

// ---------------------------------------------------------------------------
// URL → path slug extraction
// ---------------------------------------------------------------------------

function extractPathSlug(url: string): string | null {
  try {
    const parsed = new URL(url);
    let pathname = parsed.pathname.replace(/\/$/, "").replace(/^\//, "");

    // Strip common index file names
    pathname = pathname.replace(/\/(index|default)\.(html?|php|aspx?)$/i, "");
    pathname = pathname.replace(/\.(html?|php|aspx?)$/i, "");

    if (!pathname) return null;

    // Convert to a clean route
    return (
      "/" +
      pathname
        .split("/")
        .map((segment) => slugify(segment))
        .filter(Boolean)
        .join("/")
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Title → slug
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function titleSlug(title: string): string {
  const slug = slugify(title);
  return slug || "untitled";
}

// ---------------------------------------------------------------------------
// Per-node route generation
// ---------------------------------------------------------------------------

function deriveRoute(
  node: PortablePageNode
): { route: string; slug: string; source: RouteEntry["routeSource"] } {
  // Strategy 1: URL path
  const urlRoute = extractPathSlug(node.metadata.url);
  if (urlRoute && urlRoute !== "/") {
    const slug = urlRoute.split("/").filter(Boolean).pop() ?? urlRoute;
    return { route: urlRoute, slug, source: "url_path" };
  }

  // Strategy 2: title slug
  const title = node.metadata.title;
  if (title && title.trim()) {
    const slug = titleSlug(title);
    return { route: `/${slug}`, slug, source: "title_slug" };
  }

  // Strategy 3: nodeId fallback
  const fallback = node.id.slice(0, 8);
  return { route: `/${fallback}`, slug: fallback, source: "node_id_fallback" };
}

// ---------------------------------------------------------------------------
// Public: build RouteMap
// ---------------------------------------------------------------------------

export function buildRouteMap(nodes: PortablePageNode[]): RouteMap {
  const contentNodes = nodes.filter(
    (n) => n.nodeType !== "root" && n.nodeType !== "asset"
  );

  // Track occupied routes for collision resolution
  const occupiedRoutes = new Map<string, string>(); // route → nodeId that claimed it
  const routes: RouteEntry[] = [];
  const routeIndex: Record<string, string> = {};
  let collisionCount = 0;

  for (const node of contentNodes) {
    const { route: baseRoute, slug: baseSlug, source } = deriveRoute(node);

    let finalRoute = baseRoute;
    let isCollisionResolved = false;
    let collisionSuffix: number | null = null;

    // Check for collision
    if (occupiedRoutes.has(finalRoute)) {
      isCollisionResolved = true;
      collisionCount++;
      let suffix = 2;
      while (occupiedRoutes.has(`${baseRoute}-${suffix}`)) {
        suffix++;
      }
      finalRoute = `${baseRoute}-${suffix}`;
      collisionSuffix = suffix;
    }

    occupiedRoutes.set(finalRoute, node.id);

    const entry: RouteEntry = {
      nodeId: node.id,
      url: node.metadata.url,
      route: finalRoute,
      slug: isCollisionResolved ? `${baseSlug}-${collisionSuffix!}` : baseSlug,
      isCollisionResolved,
      collisionSuffix,
      routeSource: source,
      movedFrom: null,
    };

    routes.push(entry);
    routeIndex[finalRoute] = node.id;
  }

  // Sort routes for determinism
  routes.sort((a, b) => a.route.localeCompare(b.route));

  return {
    routes,
    routeIndex,
    collisionCount,
    totalRoutes: routes.length,
    generatedAt: new Date().toISOString(),
  };
}
