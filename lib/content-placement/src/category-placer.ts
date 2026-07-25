/**
 * category-placer.ts — Maps CategoryGraph → synthetic index page assignments
 *
 * For each discovered category and high-frequency tag, creates a
 * CategoryAssignment or TagAssignment that describes the index listing
 * page for that slice of content.
 *
 * Deterministic rules:
 *   - Category route is chosen by finding a stencil route with pageType
 *     "category" or "tag" (in that priority)
 *   - The resolved path is built from the category slug and the route pattern
 *   - Categories at depth-0 with > 20% of total pages are marked "featured"
 *   - Tags appearing in ≥ 5 nodes get a tag index assignment (capped at 50)
 */

import type { CategoryGraph, CategoryNode, TagRelationship } from "@workspace/site-intelligence";
import type { StencilRoute } from "@workspace/stencil-library";
import type { CategoryAssignment, TagAssignment } from "./types.js";
import { resolveCategoryPath } from "./route-resolver.js";

// ── Route finders ──────────────────────────────────────────────────────────────

function findCategoryRoute(routes: StencilRoute[]): StencilRoute | undefined {
  return (
    routes.find((r) => r.pageType === "category" && r.isDynamic) ??
    routes.find((r) => r.pageType === "category") ??
    routes.find((r) => r.pageType === "tag" && r.isDynamic) ??
    routes.find((r) => r.isIndex && r.isDynamic)
  );
}

function findTagRoute(routes: StencilRoute[]): StencilRoute | undefined {
  return (
    routes.find((r) => r.pageType === "tag" && r.isDynamic) ??
    routes.find((r) => r.pageType === "category" && r.isDynamic) ??
    routes.find((r) => r.isIndex && r.isDynamic)
  );
}

// ── Category label → slot label ────────────────────────────────────────────────

function buildCategorySlotLabel(label: string, depth: number): string {
  if (depth === 0) return label; // "Weddings", "Travel", "Fashion"
  return `${label} (subcategory)`;
}

// ── Featured category heuristic ────────────────────────────────────────────────

function isFeaturedCategory(cat: CategoryNode, totalContentNodes: number): boolean {
  // Top-level categories that contain >15% of all pages are featured
  if (cat.depth !== 0) return false;
  if (totalContentNodes === 0) return false;
  return cat.pageCount / totalContentNodes >= 0.15;
}

// ── Public: place categories ───────────────────────────────────────────────────

export function placeCategoryNodes(
  categoryGraph: CategoryGraph,
  routes: StencilRoute[],
  totalContentNodes: number
): CategoryAssignment[] {
  const categoryRoute = findCategoryRoute(routes);
  if (!categoryRoute) return [];

  const assignments: CategoryAssignment[] = [];

  for (const cat of categoryGraph.categories) {
    // Skip micro-categories with fewer than 2 pages
    if (cat.pageCount < 2) continue;

    const resolvedPath = resolveCategoryPath(
      categoryRoute.pattern,
      cat.slug,
      cat.slug
    );

    assignments.push({
      categoryId:  cat.id,
      label:       cat.label,
      slug:        cat.slug,
      depth:       cat.depth,
      pageCount:   cat.pageCount,
      nodeIds:     cat.pageIds,
      routeId:     categoryRoute.id,
      routePattern: categoryRoute.pattern,
      resolvedPath,
      slotLabel:   buildCategorySlotLabel(cat.label, cat.depth),
      pageType:    categoryRoute.pageType,
      isFeaturedCategory: isFeaturedCategory(cat, totalContentNodes),
    });
  }

  // Sort: depth ascending, then pageCount descending
  assignments.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return b.pageCount - a.pageCount;
  });

  return assignments;
}

// ── Public: place tags ─────────────────────────────────────────────────────────

export function placeTagNodes(
  categoryGraph: CategoryGraph,
  routes: StencilRoute[],
  minFrequency = 5,
  maxTags = 50
): TagAssignment[] {
  const tagRoute = findTagRoute(routes);
  if (!tagRoute) return [];

  return categoryGraph.tags
    .filter((t) => t.frequency >= minFrequency)
    .slice(0, maxTags)
    .map((tag) => {
      const slug = tag.tag.toLowerCase().replace(/\s+/g, "-");
      const resolvedPath = resolveCategoryPath(tagRoute.pattern, slug, slug);

      return {
        tag:          tag.tag,
        nodeIds:      tag.nodeIds,
        frequency:    tag.frequency,
        routeId:      tagRoute.id,
        routePattern: tagRoute.pattern,
        resolvedPath,
        slotLabel:    `Tag: ${tag.tag}`,
        pageType:     tagRoute.pageType,
      };
    });
}
