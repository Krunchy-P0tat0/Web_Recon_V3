/**
 * types.ts — Phase 4.6 Content Placement Intelligence
 *
 * All types are plain-JSON-serializable.
 */

import type { ContentType, LayoutType } from "@workspace/site-intelligence";
import type { PageType } from "@workspace/stencil-registry";

export type { ContentType, LayoutType, PageType };

// ── Slot classification ────────────────────────────────────────────────────────

/**
 * Broad bucket a page assignment falls into:
 *   content  — detail/leaf pages (articles, guides, portfolios, galleries)
 *   index    — listing/archive pages (category, tag, search, homepage)
 *   featured — promoted to a hero or editorial-spotlight slot
 *   utility  — structural pages (404, sitemap, search)
 */
export type SlotCategory = "content" | "index" | "featured" | "utility";

// ── Page assignment ────────────────────────────────────────────────────────────

/**
 * A single node-to-slot assignment.
 * Deterministic: identical inputs always produce identical outputs.
 */
export interface PageAssignment {
  nodeId: string;
  url: string;
  title: string;

  contentType: ContentType;
  layoutType: LayoutType;
  pageType: PageType;

  /** Stencil route id (e.g. "post-detail", "section-index") */
  routeId: string;
  /** URL pattern from the stencil blueprint (e.g. "/posts/:slug") */
  routePattern: string;
  /** Fully resolved path with dynamic segments filled in (e.g. "/posts/my-slug") */
  resolvedPath: string;

  /** Human-readable slot label — includes category name when relevant */
  slotLabel: string;
  /** Broad bucket */
  slotCategory: SlotCategory;

  /** Category ids (from CategoryGraph) this page belongs to */
  categoryIds: string[];
  /** Category display labels, parallel to categoryIds */
  categoryLabels: string[];

  /** Placement confidence 0–1 (derived from classification confidence × route match quality) */
  confidence: number;
  /** Deterministic reasoning chain */
  reasoning: string;

  /** Promoted into the stencil's hero/featured editorial slot */
  isFeatured: boolean;
  /** This assignment represents a category or tag index listing */
  isIndex: boolean;
}

// ── Category assignment ────────────────────────────────────────────────────────

/**
 * A synthetic index-page assignment for each discovered category.
 * These pages are inferred from the CategoryGraph — not from manifest nodes.
 */
export interface CategoryAssignment {
  categoryId: string;
  label: string;
  slug: string;
  depth: number;
  pageCount: number;
  nodeIds: string[];
  routeId: string;
  routePattern: string;
  resolvedPath: string;
  slotLabel: string;
  pageType: PageType;
  isFeaturedCategory: boolean;
}

// ── Tag assignment ─────────────────────────────────────────────────────────────

export interface TagAssignment {
  tag: string;
  nodeIds: string[];
  frequency: number;
  routeId: string;
  routePattern: string;
  resolvedPath: string;
  slotLabel: string;
  pageType: PageType;
}

// ── Placement stats ────────────────────────────────────────────────────────────

export interface PlacementStats {
  totalAssignments: number;
  bySlotCategory: Record<SlotCategory, number>;
  byContentType: Record<string, number>;
  byPageType: Record<string, number>;
  byRouteId: Record<string, number>;
  featuredCount: number;
  categoryAssignmentCount: number;
  tagAssignmentCount: number;
  unresolvableCount: number;
  averageConfidence: number;
}

// ── Placement report ───────────────────────────────────────────────────────────

/**
 * The full output of the Content Placement Intelligence engine.
 * Written to R2 as placement-report.json.
 */
export interface PlacementReport {
  version: "1.0";
  jobId: string;
  seedUrl: string;
  stencilId: string;
  generatedAt: string;
  durationMs: number;

  /** Page-level assignments (one per content node) */
  assignments: PageAssignment[];

  /** Synthetic index pages for discovered categories */
  categoryAssignments: CategoryAssignment[];

  /** Synthetic index pages for high-frequency tags */
  tagAssignments: TagAssignment[];

  /** nodeIds promoted to the featured/hero editorial slot */
  featuredNodeIds: string[];

  stats: PlacementStats;
}

// ── Engine input ───────────────────────────────────────────────────────────────

export interface PlacementInput {
  jobId: string;
  seedUrl: string;
  stencilId: string;
  manifest: import("@workspace/site-intelligence").PortableManifest;
  siteGraph: import("@workspace/site-intelligence").SiteGraph;
  blueprint: import("@workspace/stencil-library").StencilBlueprint;
}
