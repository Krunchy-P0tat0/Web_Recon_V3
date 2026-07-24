/**
 * classification.ts — Deterministic Content Classification Engine
 *
 * Analyzes every PortablePageNode and assigns one of 8 content types
 * with a confidence score (0–1) and full reasoning metadata.
 *
 * Classification is purely rule-based (no AI). Signals are drawn from:
 *   - URL path patterns
 *   - Page title tokens
 *   - Word count ranges
 *   - Image-to-word ratio
 *   - Depth in site hierarchy
 *   - Node type from manifest
 *   - Description content
 */

import type {
  PortablePageNode,
  ContentType,
  ClassificationResult,
  ClassificationSignal,
} from "./types";

// ---------------------------------------------------------------------------
// Signal weights
// ---------------------------------------------------------------------------

const SIGNAL_WEIGHT = {
  URL_PATTERN: 0.35,
  TITLE_TOKEN: 0.25,
  WORD_COUNT: 0.15,
  IMAGE_RATIO: 0.10,
  DEPTH: 0.08,
  NODE_TYPE: 0.05,
  DESCRIPTION: 0.02,
} as const;

// ---------------------------------------------------------------------------
// URL pattern matching per content type
// ---------------------------------------------------------------------------

const URL_PATTERNS: Record<ContentType, RegExp[]> = {
  ARTICLE: [
    /\/(article|articles|post|posts|news|story|stories)\//i,
    /\/\d{4}\/\d{2}\/\d{2}\//,
    /\/(press|releases|announcements)\//i,
  ],
  BLOG: [
    /\/(blog|blogs|journal|diary|updates|thoughts)\//i,
    /\/(author|authors|by-)\w+/i,
  ],
  GUIDE: [
    /\/(guide|guides|how-to|howto|tutorial|tutorials|learn|learning)\//i,
    /\/(getting-started|quickstart|walkthrough|walkthrough)\//i,
  ],
  LANDING_PAGE: [
    /^\/?$/, // root
    /\/(home|index|welcome|start|solutions|features|pricing|about|contact)\/?$/i,
    /\/(product|products|service|services)\/?$/i,
  ],
  PORTFOLIO: [
    /\/(portfolio|work|projects|case-studies|case-study|showcase|gallery)\//i,
    /\/(clients|testimonials)\//i,
  ],
  GALLERY: [
    /\/(gallery|galleries|photos|images|pictures|albums|album|media)\//i,
    /\/(looks|collections|collection|lightbox)\//i,
  ],
  FAQ: [
    /\/(faq|faqs|frequently-asked|questions|q-and-a|qa)\/?/i,
    /\/(help|support|knowledge-?base)\//i,
  ],
  DOCS: [
    /\/(docs|documentation|api|reference|spec|specs|manual|manuals|handbook)\//i,
    /\/(developer|developers|sdk|api-reference|getting-started)\//i,
  ],
};

// ---------------------------------------------------------------------------
// Title keyword matching
// ---------------------------------------------------------------------------

const TITLE_TOKENS: Record<ContentType, RegExp[]> = {
  ARTICLE: [
    /\b(report|analysis|interview|exclusive|breaking|review|recap|recap)\b/i,
    /\b\d{4}\b/, // years often appear in news titles
  ],
  BLOG: [
    /\b(thoughts|musings|weekly|monthly|update|updates|reflections)\b/i,
    /\b(my |our |week in|day in)\b/i,
  ],
  GUIDE: [
    /\b(how to|guide|tutorial|step-by-step|beginner|advanced|complete|ultimate|introduction|intro)\b/i,
    /\b(learn|master|getting started)\b/i,
  ],
  LANDING_PAGE: [
    /\b(welcome|home|solutions|features|pricing|get started|sign up|free trial|demo)\b/i,
    /\b(about us|contact us|our mission|our team)\b/i,
  ],
  PORTFOLIO: [
    /\b(project|case study|client|work|built for|designed for)\b/i,
    /\b(showcase|featured|our work)\b/i,
  ],
  GALLERY: [
    /\b(photos?|pictures?|images?|gallery|album|collection|look\s?book)\b/i,
    /\b(behind the scenes|photo essay)\b/i,
  ],
  FAQ: [
    /\b(faq|frequently asked|questions|q&a|q and a|help center)\b/i,
    /\?$/, // ends with question mark
  ],
  DOCS: [
    /\b(api|sdk|reference|documentation|specification|endpoint|parameter|method|class|function|module)\b/i,
    /\b(v\d+\.\d+|release notes|changelog|migration)\b/i,
  ],
};

// ---------------------------------------------------------------------------
// Word count ranges that favor each type
// ---------------------------------------------------------------------------

function scoreByWordCount(wordCount: number, contentType: ContentType): number {
  const ranges: Record<ContentType, [number, number]> = {
    ARTICLE:      [300, 2000],
    BLOG:         [200, 1500],
    GUIDE:        [500, 5000],
    LANDING_PAGE: [50, 600],
    PORTFOLIO:    [50, 800],
    GALLERY:      [0, 300],
    FAQ:          [100, 3000],
    DOCS:         [200, 10000],
  };
  const [min, max] = ranges[contentType];
  if (wordCount >= min && wordCount <= max) return 1.0;
  if (wordCount < min) return Math.max(0, wordCount / min);
  return Math.max(0, 1 - (wordCount - max) / max);
}

// ---------------------------------------------------------------------------
// Image ratio signals
// ---------------------------------------------------------------------------

function scoreByImageRatio(imageCount: number, wordCount: number, contentType: ContentType): number {
  const wc = Math.max(wordCount, 1);
  const ratio = imageCount / wc;

  switch (contentType) {
    case "GALLERY":      return ratio > 0.05 ? 1.0 : ratio * 20;
    case "PORTFOLIO":    return ratio > 0.02 ? 1.0 : ratio * 50;
    case "LANDING_PAGE": return imageCount >= 1 ? 0.8 : 0.3;
    case "DOCS":         return imageCount <= 5 ? 0.9 : 0.5;
    case "FAQ":          return imageCount <= 3 ? 0.9 : 0.5;
    case "ARTICLE":      return imageCount >= 1 ? 0.7 : 0.5;
    case "BLOG":         return imageCount >= 1 ? 0.7 : 0.5;
    case "GUIDE":        return imageCount >= 1 ? 0.8 : 0.6;
  }
}

// ---------------------------------------------------------------------------
// Depth signals
// ---------------------------------------------------------------------------

function scoreByDepth(depth: number, contentType: ContentType): number {
  switch (contentType) {
    case "LANDING_PAGE": return depth === 0 ? 1.0 : depth === 1 ? 0.6 : 0.2;
    case "ARTICLE":      return depth >= 2 ? 0.9 : depth === 1 ? 0.6 : 0.2;
    case "BLOG":         return depth >= 2 ? 0.9 : depth === 1 ? 0.6 : 0.2;
    case "DOCS":         return depth >= 2 ? 0.9 : 0.5;
    case "GUIDE":        return depth >= 1 ? 0.8 : 0.4;
    case "GALLERY":      return depth >= 1 ? 0.8 : 0.4;
    case "PORTFOLIO":    return depth >= 1 ? 0.8 : 0.4;
    case "FAQ":          return depth >= 1 ? 0.9 : 0.5;
  }
}

// ---------------------------------------------------------------------------
// Node type compatibility
// ---------------------------------------------------------------------------

function scoreByNodeType(nodeType: string, contentType: ContentType): number {
  if (nodeType === "root") return contentType === "LANDING_PAGE" ? 1.0 : 0.1;
  if (nodeType === "index") return contentType === "LANDING_PAGE" ? 0.8 : contentType === "DOCS" ? 0.7 : 0.4;
  if (nodeType === "pagination") return 0.3; // pagination doesn't strongly indicate any type
  if (nodeType === "asset") return 0.1;
  // article node type is the default — neutral
  return 0.6;
}

// ---------------------------------------------------------------------------
// Core scoring function
// ---------------------------------------------------------------------------

function scoreContentType(
  node: PortablePageNode,
  contentType: ContentType
): { score: number; signals: ClassificationSignal[] } {
  const signals: ClassificationSignal[] = [];
  const url = node.metadata.url;
  const title = node.metadata.title ?? "";
  const description = node.metadata.description ?? "";
  const wordCount = node.content.wordCount;
  const imageCount = node.media.images.length;

  // URL pattern signal
  const urlPatterns = URL_PATTERNS[contentType];
  const urlMatched = urlPatterns.some((p) => p.test(url));
  const urlSignal: ClassificationSignal = {
    signal: "url_pattern",
    weight: SIGNAL_WEIGHT.URL_PATTERN,
    matched: urlMatched,
    evidence: urlMatched ? `URL matches ${contentType} pattern` : `URL does not match ${contentType}`,
  };
  signals.push(urlSignal);

  // Title token signal
  const titleTokens = TITLE_TOKENS[contentType];
  const titleMatched = titleTokens.some((p) => p.test(title + " " + description));
  const titleSignal: ClassificationSignal = {
    signal: "title_token",
    weight: SIGNAL_WEIGHT.TITLE_TOKEN,
    matched: titleMatched,
    evidence: titleMatched ? `Title/description matches ${contentType} keyword` : "No title match",
  };
  signals.push(titleSignal);

  // Word count signal
  const wcScore = scoreByWordCount(wordCount, contentType);
  signals.push({
    signal: "word_count",
    weight: SIGNAL_WEIGHT.WORD_COUNT,
    matched: wcScore > 0.6,
    evidence: `Word count ${wordCount} — ${contentType} score: ${wcScore.toFixed(2)}`,
  });

  // Image ratio signal
  const imgScore = scoreByImageRatio(imageCount, wordCount, contentType);
  signals.push({
    signal: "image_ratio",
    weight: SIGNAL_WEIGHT.IMAGE_RATIO,
    matched: imgScore > 0.5,
    evidence: `${imageCount} images, ${wordCount} words — image ratio score: ${imgScore.toFixed(2)}`,
  });

  // Depth signal
  const depthScore = scoreByDepth(node.relationships.depth, contentType);
  signals.push({
    signal: "depth",
    weight: SIGNAL_WEIGHT.DEPTH,
    matched: depthScore > 0.6,
    evidence: `Depth ${node.relationships.depth} — ${contentType} depth score: ${depthScore.toFixed(2)}`,
  });

  // Node type signal
  const ntScore = scoreByNodeType(node.nodeType, contentType);
  signals.push({
    signal: "node_type",
    weight: SIGNAL_WEIGHT.NODE_TYPE,
    matched: ntScore > 0.5,
    evidence: `Node type "${node.nodeType}" — ${contentType} compatibility: ${ntScore.toFixed(2)}`,
  });

  // Description signal
  const descSignal = description.length > 20;
  signals.push({
    signal: "description",
    weight: SIGNAL_WEIGHT.DESCRIPTION,
    matched: descSignal,
    evidence: descSignal ? "Has description metadata" : "No description",
  });

  // Weighted score
  const score =
    (urlMatched ? SIGNAL_WEIGHT.URL_PATTERN : 0) +
    (titleMatched ? SIGNAL_WEIGHT.TITLE_TOKEN : 0) +
    wcScore * SIGNAL_WEIGHT.WORD_COUNT +
    imgScore * SIGNAL_WEIGHT.IMAGE_RATIO +
    depthScore * SIGNAL_WEIGHT.DEPTH +
    ntScore * SIGNAL_WEIGHT.NODE_TYPE +
    (descSignal ? SIGNAL_WEIGHT.DESCRIPTION : 0);

  return { score: Math.min(1, score), signals };
}

// ---------------------------------------------------------------------------
// Generate reasoning text
// ---------------------------------------------------------------------------

function buildReasoning(
  node: PortablePageNode,
  contentType: ContentType,
  confidence: number,
  signals: ClassificationSignal[]
): string {
  const matched = signals.filter((s) => s.matched).map((s) => s.signal);
  return (
    `Classified as ${contentType} (confidence: ${(confidence * 100).toFixed(0)}%). ` +
    `Matched signals: ${matched.length > 0 ? matched.join(", ") : "none"}. ` +
    `URL: ${node.metadata.url}. ` +
    `Words: ${node.content.wordCount}, Images: ${node.media.images.length}, Depth: ${node.relationships.depth}.`
  );
}

// ---------------------------------------------------------------------------
// Public: classify a single node
// ---------------------------------------------------------------------------

export function classifyNode(node: PortablePageNode): ClassificationResult {
  const ALL_TYPES: ContentType[] = [
    "ARTICLE", "BLOG", "GUIDE", "LANDING_PAGE",
    "PORTFOLIO", "GALLERY", "FAQ", "DOCS",
  ];

  const scores = ALL_TYPES.map((ct) => {
    const { score, signals } = scoreContentType(node, ct);
    return { contentType: ct, score, signals };
  });

  scores.sort((a, b) => b.score - a.score);

  const best = scores[0]!;
  const { contentType, score, signals } = best;

  const alternatives = scores
    .slice(1, 4)
    .filter((s) => s.score > 0.1)
    .map((s) => ({ contentType: s.contentType, confidence: Math.round(s.score * 100) / 100 }));

  const confidence = Math.round(score * 100) / 100;

  return {
    nodeId: node.id,
    url: node.metadata.url,
    contentType,
    confidence,
    signals,
    reasoning: buildReasoning(node, contentType, confidence, signals),
    alternativeCandidates: alternatives,
  };
}

// ---------------------------------------------------------------------------
// Public: classify all nodes in a manifest
// ---------------------------------------------------------------------------

export function classifyAllNodes(
  nodes: PortablePageNode[]
): ClassificationResult[] {
  const contentNodes = nodes.filter(
    (n) => n.nodeType !== "root" && n.nodeType !== "asset"
  );
  return contentNodes.map(classifyNode);
}
