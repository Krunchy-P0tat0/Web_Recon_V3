/**
 * slot-matcher.ts — Deterministic ContentType → StencilRoute mapping
 *
 * Rules (in priority order):
 *   1. Depth-0 / root-type nodes → homepage route
 *   2. ContentType primary affinity → matching pageType route
 *   3. ContentType fallback affinities → secondary pageType routes
 *   4. Index (listing) nodes → index-type route for that content type
 *   5. Ultimate fallback → first dynamic route with pageType "article"
 *
 * No AI. No manual mappings. Every rule is expressed as a function of
 * the node's attributes versus the stencil's route declarations.
 */

import type { ContentType } from "@workspace/site-intelligence";
import type { PageType } from "@workspace/stencil-registry";
import type { StencilRoute } from "@workspace/stencil-library";

// ── ContentType → ordered list of preferred pageTypes ─────────────────────────

const CONTENT_TYPE_PAGE_TYPE_AFFINITY: Record<ContentType, PageType[]> = {
  ARTICLE:      ["article", "blog", "guide"],
  BLOG:         ["blog",    "article"],
  GUIDE:        ["guide",   "docs",  "article"],
  LANDING_PAGE: ["landing", "faq"],
  PORTFOLIO:    ["portfolio", "gallery"],
  GALLERY:      ["gallery",  "portfolio"],
  FAQ:          ["faq",     "docs"],
  DOCS:         ["docs",    "guide",  "article"],
};

// Separately, index nodes of these content types map to index-style page types
const INDEX_PAGE_TYPE_AFFINITY: Record<ContentType, PageType[]> = {
  ARTICLE:      ["category", "blog", "search"],
  BLOG:         ["blog",     "category"],
  GUIDE:        ["docs",     "category"],
  LANDING_PAGE: ["homepage", "landing"],
  PORTFOLIO:    ["portfolio", "gallery"],
  GALLERY:      ["gallery",  "portfolio"],
  FAQ:          ["faq",      "docs"],
  DOCS:         ["docs",     "search"],
};

// ── Route selection helpers ───────────────────────────────────────────────────

function findRouteForPageTypes(
  routes: StencilRoute[],
  pageTypes: PageType[],
  preferDynamic: boolean
): StencilRoute | undefined {
  for (const pt of pageTypes) {
    const matches = routes.filter((r) => r.pageType === pt);
    if (matches.length === 0) continue;

    // Prefer dynamic detail routes for content, static for utility
    const sorted = [...matches].sort((a, b) => {
      if (preferDynamic) {
        // dynamic first, then by pattern length (more specific first)
        if (a.isDynamic !== b.isDynamic) return a.isDynamic ? -1 : 1;
      } else {
        if (a.isDynamic !== b.isDynamic) return a.isDynamic ? 1 : -1;
      }
      return b.pattern.length - a.pattern.length;
    });

    return sorted[0];
  }
  return undefined;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface SlotMatch {
  route: StencilRoute;
  matchQuality: number; // 0–1, 1 = perfect primary match
  reasoning: string;
}

/**
 * matchSlot — deterministically picks the best StencilRoute for a content node.
 *
 * @param contentType  Classification result from site-intelligence
 * @param nodeType     Manifest nodeType ("root", "index", "article", etc.)
 * @param depth        Node depth in site hierarchy
 * @param routes       All routes from the selected StencilBlueprint
 */
export function matchSlot(
  contentType: ContentType,
  nodeType: string,
  depth: number,
  routes: StencilRoute[]
): SlotMatch {
  // Rule 1: Root node → homepage
  if (nodeType === "root" || (depth === 0 && contentType === "LANDING_PAGE")) {
    const homepage = routes.find((r) => r.pageType === "homepage");
    if (homepage) {
      return {
        route: homepage,
        matchQuality: 1.0,
        reasoning: `Root/depth-0 landing page → homepage route (pattern: ${homepage.pattern})`,
      };
    }
  }

  // Rule 2: Index / listing nodes → index-type routes
  const isIndexNode = nodeType === "index" || nodeType === "pagination";
  if (isIndexNode) {
    const indexAffinities = INDEX_PAGE_TYPE_AFFINITY[contentType];
    const indexRoute = findRouteForPageTypes(routes, indexAffinities, false);
    if (indexRoute) {
      return {
        route: indexRoute,
        matchQuality: 0.85,
        reasoning: `Index node (${nodeType}) of type ${contentType} → ${indexRoute.pageType} route (pattern: ${indexRoute.pattern})`,
      };
    }
  }

  // Rule 3: Primary content affinity
  const primaryAffinities = CONTENT_TYPE_PAGE_TYPE_AFFINITY[contentType];
  const primaryRoute = findRouteForPageTypes(routes, primaryAffinities, true);
  if (primaryRoute) {
    const isPrimary = primaryRoute.pageType === primaryAffinities[0];
    return {
      route: primaryRoute,
      matchQuality: isPrimary ? 0.95 : 0.75,
      reasoning: `${contentType} → ${primaryRoute.pageType} via ${isPrimary ? "primary" : "fallback"} affinity (pattern: ${primaryRoute.pattern})`,
    };
  }

  // Rule 4: Ultimate fallback — any dynamic route, then any route
  const anyDynamic = routes.find((r) => r.isDynamic && r.pageType !== "homepage");
  if (anyDynamic) {
    return {
      route: anyDynamic,
      matchQuality: 0.3,
      reasoning: `No affinity match for ${contentType}; falling back to first dynamic route (pattern: ${anyDynamic.pattern})`,
    };
  }

  const fallback = routes[0]!;
  return {
    route: fallback,
    matchQuality: 0.1,
    reasoning: `No suitable route found for ${contentType}; using first available route (pattern: ${fallback.pattern})`,
  };
}
