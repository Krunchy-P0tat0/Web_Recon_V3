/**
 * index.ts — Public API for @workspace/content-placement
 *
 * Phase 4.6: Content Placement Intelligence
 *
 * Input:  PortableManifest + SiteGraph + StencilBlueprint
 * Output: PlacementReport (PageAssignments + CategoryAssignments + TagAssignments)
 *
 * Placement is fully deterministic: identical inputs always produce
 * identical outputs. No AI, no manual mappings, no external network.
 *
 * Usage:
 *   import { placeContent } from "@workspace/content-placement";
 *
 *   const report = placeContent({
 *     jobId, seedUrl, stencilId,
 *     manifest, siteGraph, blueprint
 *   });
 */

export { placeContent }    from "./placement-engine.js";
export { matchSlot }       from "./slot-matcher.js";
export { resolvePath, resolveCategoryPath } from "./route-resolver.js";
export { selectFeaturedNodes } from "./featured-selector.js";
export { placeCategoryNodes, placeTagNodes } from "./category-placer.js";

export type {
  PlacementInput,
  PlacementReport,
  PageAssignment,
  CategoryAssignment,
  TagAssignment,
  PlacementStats,
  SlotCategory,
  ContentType,
  LayoutType,
  PageType,
} from "./types.js";
