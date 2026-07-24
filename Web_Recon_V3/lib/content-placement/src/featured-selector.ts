/**
 * featured-selector.ts — Promotes high-signal pages into featured/hero slots
 *
 * Deterministic scoring rules (no AI):
 *
 *   Visual richness  (0.30) — high image count relative to word count
 *   Content depth    (0.25) — word count in the sweet spot for editorial features
 *   Classification   (0.20) — GALLERY/PORTFOLIO score higher for visual stencils
 *   Hierarchy        (0.15) — shallow depth (1–2) preferred over deep buried pages
 *   Confidence       (0.10) — classification confidence propagates
 *
 * The number of featured slots is bounded by the stencil's index route count.
 *
 * Examples that emerge naturally from these rules:
 *   Luxury stencil  + GALLERY content   → Featured (visual richness is high)
 *   Magazine stencil + ARTICLE, depth=1 → Featured (editorial prominence)
 *   Agency stencil  + PORTFOLIO, depth=1 → Featured (showcase slot)
 *   Blog stencil    + ARTICLE, 800+ words → Featured (long-form highlight)
 */

import type { ContentType } from "@workspace/site-intelligence";
import type { ClassificationResult, LayoutAssignment } from "@workspace/site-intelligence";
import type { PortablePageNode } from "@workspace/site-intelligence";
import type { StencilLibraryId } from "@workspace/stencil-library";

// ── Stencil-specific featured content type preferences ─────────────────────────

const STENCIL_FEATURED_PREFERENCE: Record<string, ContentType[]> = {
  blog:          ["ARTICLE", "GUIDE"],
  magazine:      ["ARTICLE", "GALLERY"],
  documentation: ["DOCS", "GUIDE"],
  luxury:        ["GALLERY", "PORTFOLIO", "LANDING_PAGE"],
  agency:        ["PORTFOLIO", "GALLERY", "LANDING_PAGE"],
  portfolio:     ["PORTFOLIO", "GALLERY"],
};

// ── Scoring ────────────────────────────────────────────────────────────────────

interface FeatureScore {
  nodeId: string;
  score: number;
  reasons: string[];
}

function scoreVisualRichness(node: PortablePageNode): number {
  const images = node.media.images.length;
  const words = Math.max(node.content.wordCount, 1);
  const ratio = images / words;

  // High image density relative to text = strong feature candidate
  if (images >= 10) return 1.0;
  if (images >= 5)  return 0.85;
  if (ratio > 0.02) return 0.7;
  if (images >= 1)  return 0.5;
  return 0.2;
}

function scoreContentDepth(wordCount: number): number {
  // 400–2000 words: ideal for editorial features
  if (wordCount >= 400 && wordCount <= 2000) return 1.0;
  if (wordCount >= 200 && wordCount < 400)   return 0.7;
  if (wordCount > 2000 && wordCount <= 4000) return 0.8;
  if (wordCount > 4000) return 0.5; // very long → less scannable as hero
  return 0.3; // very short
}

function scoreContentType(
  contentType: ContentType,
  stencilId: string
): number {
  const preferred = STENCIL_FEATURED_PREFERENCE[stencilId] ??
    ["ARTICLE", "GALLERY", "PORTFOLIO", "LANDING_PAGE"];

  const idx = preferred.indexOf(contentType);
  if (idx === 0) return 1.0;
  if (idx === 1) return 0.85;
  if (idx === 2) return 0.7;
  if (idx > 2)   return 0.5;

  // Not in preferred list but still a rich content type
  if (["GALLERY", "PORTFOLIO"].includes(contentType)) return 0.6;
  if (["ARTICLE", "BLOG", "GUIDE"].includes(contentType)) return 0.5;
  return 0.3;
}

function scoreHierarchy(depth: number): number {
  // Depth 1 = top-level section pages — prime feature candidates
  if (depth === 1) return 1.0;
  if (depth === 0) return 0.9; // root (landing)
  if (depth === 2) return 0.75;
  if (depth === 3) return 0.5;
  return 0.2; // buried deep
}

// ── Public API ─────────────────────────────────────────────────────────────────

const WEIGHTS = {
  visualRichness: 0.30,
  contentDepth:   0.25,
  contentType:    0.20,
  hierarchy:      0.15,
  confidence:     0.10,
};

/**
 * selectFeaturedNodes — returns nodeIds that qualify for the featured/hero slot.
 *
 * @param nodes           Content nodes (from manifest)
 * @param classifications Classification results from SiteGraph
 * @param layoutAssignments Layout assignments from SiteGraph
 * @param stencilId       The selected stencil
 * @param maxFeatured     Maximum number of featured nodes (default: 3)
 */
export function selectFeaturedNodes(
  nodes: PortablePageNode[],
  classifications: ClassificationResult[],
  layoutAssignments: LayoutAssignment[],
  stencilId: string,
  maxFeatured = 3
): Set<string> {
  const classMap = new Map(classifications.map((c) => [c.nodeId, c]));

  const scores: FeatureScore[] = [];

  for (const node of nodes) {
    // Skip root, asset, and pagination nodes
    if (node.nodeType === "root" || node.nodeType === "asset" || node.nodeType === "pagination") {
      continue;
    }

    const cls = classMap.get(node.id);
    if (!cls) continue;

    const reasons: string[] = [];

    const visualScore   = scoreVisualRichness(node);
    const depthScore    = scoreContentDepth(node.content.wordCount);
    const typeScore     = scoreContentType(cls.contentType, stencilId);
    const hierarchyScore = scoreHierarchy(node.relationships.depth);
    const confidenceScore = cls.confidence;

    if (visualScore >= 0.7)   reasons.push(`high visual richness (${node.media.images.length} images)`);
    if (depthScore >= 0.8)    reasons.push(`ideal word count (${node.content.wordCount})`);
    if (typeScore >= 0.85)    reasons.push(`preferred content type for ${stencilId} (${cls.contentType})`);
    if (hierarchyScore >= 0.9) reasons.push(`shallow depth (${node.relationships.depth})`);

    const total =
      visualScore    * WEIGHTS.visualRichness +
      depthScore     * WEIGHTS.contentDepth +
      typeScore      * WEIGHTS.contentType +
      hierarchyScore * WEIGHTS.hierarchy +
      confidenceScore * WEIGHTS.confidence;

    scores.push({ nodeId: node.id, score: total, reasons });
  }

  // Sort descending and take top N
  scores.sort((a, b) => b.score - a.score);

  return new Set(
    scores.slice(0, maxFeatured).map((s) => s.nodeId)
  );
}
