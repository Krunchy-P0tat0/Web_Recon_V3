/**
 * layout.ts — Layout Intelligence Engine
 *
 * Assigns a layout type to every content node based on its classification,
 * media profile, and content characteristics.
 *
 * Layout types:
 *   ArticleLayout       — long-form prose, minimal images
 *   GalleryLayout       — image-heavy, low word count
 *   LandingLayout       — short copy, mixed media, root/index nodes
 *   DocumentationLayout — structured content, code-like, deep hierarchy
 *   PortfolioLayout     — project showcase, case studies
 *   IndexLayout         — category/listing pages
 *   MinimalLayout       — fallback for very short or errorred pages
 */

import type {
  PortablePageNode,
  ClassificationResult,
  ContentType,
  LayoutType,
  LayoutAssignment,
} from "./types";

// ---------------------------------------------------------------------------
// Primary layout assignment from content type
// ---------------------------------------------------------------------------

const CONTENT_TYPE_TO_LAYOUT: Record<ContentType, LayoutType> = {
  ARTICLE:      "ArticleLayout",
  BLOG:         "ArticleLayout",
  GUIDE:        "DocumentationLayout",
  LANDING_PAGE: "LandingLayout",
  PORTFOLIO:    "PortfolioLayout",
  GALLERY:      "GalleryLayout",
  FAQ:          "DocumentationLayout",
  DOCS:         "DocumentationLayout",
};

// ---------------------------------------------------------------------------
// Layout override rules (checked after primary assignment)
// ---------------------------------------------------------------------------

interface LayoutSignals {
  wordCount: number;
  imageCount: number;
  videoCount: number;
  hasStructuredContent: boolean;
  hasGallerySignals: boolean;
  isLandingPage: boolean;
}

function extractSignals(node: PortablePageNode): LayoutSignals {
  const wordCount = node.content.wordCount;
  const imageCount = node.media.images.length;
  const videoCount = node.media.videos.length;

  // Structured content: HTML with lists, tables, code blocks
  const html = node.content.cleanHtml;
  const hasStructuredContent =
    /<(table|ul|ol|dl|pre|code|blockquote|details)/i.test(html);

  // Gallery signals: very high image count relative to word count
  const hasGallerySignals =
    imageCount >= 6 || (imageCount >= 3 && wordCount < 200);

  // Landing page: root/index node or depth=0
  const isLandingPage =
    node.nodeType === "root" ||
    node.nodeType === "index" ||
    node.relationships.depth === 0;

  return {
    wordCount,
    imageCount,
    videoCount,
    hasStructuredContent,
    hasGallerySignals,
    isLandingPage,
  };
}

function applyOverrides(
  baseLayout: LayoutType,
  signals: LayoutSignals,
  node: PortablePageNode
): { layout: LayoutType; confidence: number; reasoning: string } {
  const { wordCount, imageCount, hasGallerySignals, isLandingPage, hasStructuredContent } = signals;

  // Extreme gallery signals override anything
  if (hasGallerySignals && imageCount >= 8) {
    return {
      layout: "GalleryLayout",
      confidence: 0.92,
      reasoning: `Overridden to GalleryLayout: ${imageCount} images detected with low word count (${wordCount}).`,
    };
  }

  // Very short pages → minimal
  if (wordCount < 50 && imageCount === 0 && node.nodeType === "article") {
    return {
      layout: "MinimalLayout",
      confidence: 0.80,
      reasoning: `MinimalLayout: page has only ${wordCount} words and no images — likely stub or error page.`,
    };
  }

  // Index/root pages
  if (isLandingPage && baseLayout !== "LandingLayout") {
    return {
      layout: "LandingLayout",
      confidence: 0.85,
      reasoning: `Overridden to LandingLayout: node is ${node.nodeType} at depth ${node.relationships.depth}.`,
    };
  }

  // Structured content with many sections → documentation
  if (hasStructuredContent && wordCount > 1000 && baseLayout === "ArticleLayout") {
    return {
      layout: "DocumentationLayout",
      confidence: 0.78,
      reasoning: `Overridden to DocumentationLayout: structured HTML (tables/lists/code) with ${wordCount} words.`,
    };
  }

  // Paginated index pages
  if (node.nodeType === "pagination") {
    return {
      layout: "IndexLayout",
      confidence: 0.90,
      reasoning: `IndexLayout: node is a pagination node (page ${node.relationships.paginationIndex ?? "??"}).`,
    };
  }

  // No override — use base
  const confidence = baseLayout === "MinimalLayout" ? 0.60 : 0.75;
  return {
    layout: baseLayout,
    confidence,
    reasoning: `Assigned ${baseLayout} based on content type classification.`,
  };
}

// ---------------------------------------------------------------------------
// Public: assign layout to a single node
// ---------------------------------------------------------------------------

export function assignLayout(
  node: PortablePageNode,
  classification: ClassificationResult | undefined
): LayoutAssignment {
  const contentType = classification?.contentType ?? "ARTICLE";
  const baseLayout = CONTENT_TYPE_TO_LAYOUT[contentType];
  const signals = extractSignals(node);
  const { layout, confidence, reasoning } = applyOverrides(baseLayout, signals, node);

  return {
    nodeId: node.id,
    url: node.metadata.url,
    layout,
    confidence,
    reasoning,
    contentType,
    signals,
  };
}

// ---------------------------------------------------------------------------
// Public: assign layouts to all content nodes
// ---------------------------------------------------------------------------

export function assignAllLayouts(
  nodes: PortablePageNode[],
  classifications: ClassificationResult[]
): LayoutAssignment[] {
  const classMap = new Map<string, ClassificationResult>();
  for (const c of classifications) {
    classMap.set(c.nodeId, c);
  }

  const contentNodes = nodes.filter((n) => n.nodeType !== "asset");

  return contentNodes.map((node) => assignLayout(node, classMap.get(node.id)));
}
