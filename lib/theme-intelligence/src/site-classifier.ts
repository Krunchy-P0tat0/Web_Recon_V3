/**
 * site-classifier.ts — Determines site type from SiteGraph + WebsiteBlueprint signals
 *
 * Uses a weighted multi-signal scoring system across content type distribution,
 * image density, word count profiles, category structure, and URL patterns.
 * Returns a SiteClassification with primary type, confidence, and alternatives.
 */

import type { SiteGraph } from "@workspace/site-intelligence";
import type { WebsiteBlueprint } from "@workspace/stencil-generator";
import type {
  SiteType,
  DesignStrategy,
  LayoutStrategy,
  SiteClassification,
  SiteClassificationSignal,
  SiteTypeScore,
} from "./types";

// ---------------------------------------------------------------------------
// Site type profiles — define expected characteristics per type
// ---------------------------------------------------------------------------

interface SiteTypeProfile {
  siteType: SiteType;
  designStrategy: DesignStrategy;
  layoutStrategy: LayoutStrategy;
  signals: Array<{
    name: string;
    weight: number;
    test: (graph: SiteGraph, blueprint: WebsiteBlueprint) => { matched: boolean; evidence: string };
  }>;
}

const PROFILES: SiteTypeProfile[] = [
  {
    siteType: "photography",
    designStrategy: "minimal",
    layoutStrategy: "masonry",
    signals: [
      {
        name: "very_high_image_density",
        weight: 3.0,
        test: (g) => {
          const ratio = g.stats.totalImages / Math.max(g.stats.totalNodes, 1);
          return { matched: ratio > 5, evidence: `${ratio.toFixed(1)} images/page` };
        },
      },
      {
        name: "gallery_content_dominant",
        weight: 2.5,
        test: (g) => {
          const gallery = g.stats.byContentType["GALLERY"] ?? 0;
          return { matched: gallery / Math.max(g.stats.contentNodes, 1) > 0.4, evidence: `${gallery} gallery nodes` };
        },
      },
      {
        name: "low_word_count",
        weight: 1.5,
        test: (g) => {
          return { matched: g.stats.averageWordCount < 150, evidence: `avg ${g.stats.averageWordCount} words` };
        },
      },
      {
        name: "gallery_layout_dominant",
        weight: 2.0,
        test: (g) => {
          const gl = g.stats.byLayout["GalleryLayout"] ?? 0;
          return { matched: gl / Math.max(g.stats.totalNodes, 1) > 0.3, evidence: `${gl} gallery layouts` };
        },
      },
    ],
  },
  {
    siteType: "news",
    designStrategy: "readable",
    layoutStrategy: "magazine",
    signals: [
      {
        name: "high_article_count",
        weight: 2.5,
        test: (g) => {
          return { matched: g.stats.contentNodes > 30, evidence: `${g.stats.contentNodes} content nodes` };
        },
      },
      {
        name: "article_dominant",
        weight: 2.0,
        test: (g) => {
          const articles = (g.stats.byContentType["ARTICLE"] ?? 0) + (g.stats.byContentType["BLOG"] ?? 0);
          return { matched: articles / Math.max(g.stats.contentNodes, 1) > 0.6, evidence: `${articles} article nodes` };
        },
      },
      {
        name: "short_word_count",
        weight: 1.5,
        test: (g) => {
          return { matched: g.stats.averageWordCount > 200 && g.stats.averageWordCount < 800, evidence: `avg ${g.stats.averageWordCount} words` };
        },
      },
      {
        name: "many_categories",
        weight: 1.5,
        test: (g) => {
          return { matched: g.stats.totalCategories > 5, evidence: `${g.stats.totalCategories} categories` };
        },
      },
      {
        name: "news_url_keywords",
        weight: 1.0,
        test: (g) => {
          const url = g.seedUrl.toLowerCase();
          const matched = ["news", "times", "post", "daily", "herald", "gazette", "tribune", "journal", "press"].some(k => url.includes(k));
          return { matched, evidence: `seed URL: ${g.seedUrl}` };
        },
      },
    ],
  },
  {
    siteType: "editorial",
    designStrategy: "elegant",
    layoutStrategy: "editorial_flow",
    signals: [
      {
        name: "high_word_count",
        weight: 2.5,
        test: (g) => {
          return { matched: g.stats.averageWordCount > 800, evidence: `avg ${g.stats.averageWordCount} words` };
        },
      },
      {
        name: "article_or_guide_dominant",
        weight: 2.0,
        test: (g) => {
          const content = (g.stats.byContentType["ARTICLE"] ?? 0) + (g.stats.byContentType["GUIDE"] ?? 0);
          return { matched: content / Math.max(g.stats.contentNodes, 1) > 0.5, evidence: `${content} editorial nodes` };
        },
      },
      {
        name: "moderate_image_ratio",
        weight: 1.0,
        test: (g) => {
          const ratio = g.stats.averageImagesPerPage;
          return { matched: ratio >= 1 && ratio <= 4, evidence: `${ratio.toFixed(1)} images/page` };
        },
      },
      {
        name: "article_layout_dominant",
        weight: 1.5,
        test: (g) => {
          const al = g.stats.byLayout["ArticleLayout"] ?? 0;
          return { matched: al / Math.max(g.stats.totalNodes, 1) > 0.4, evidence: `${al} article layouts` };
        },
      },
    ],
  },
  {
    siteType: "blog",
    designStrategy: "friendly",
    layoutStrategy: "card_grid",
    signals: [
      {
        name: "blog_content_type",
        weight: 3.0,
        test: (g) => {
          const blog = g.stats.byContentType["BLOG"] ?? 0;
          return { matched: blog / Math.max(g.stats.contentNodes, 1) > 0.3, evidence: `${blog} blog nodes` };
        },
      },
      {
        name: "moderate_article_count",
        weight: 1.5,
        test: (g) => {
          return { matched: g.stats.contentNodes >= 5 && g.stats.contentNodes <= 50, evidence: `${g.stats.contentNodes} content nodes` };
        },
      },
      {
        name: "medium_word_count",
        weight: 1.5,
        test: (g) => {
          return { matched: g.stats.averageWordCount >= 400 && g.stats.averageWordCount <= 1200, evidence: `avg ${g.stats.averageWordCount} words` };
        },
      },
      {
        name: "blog_url_keywords",
        weight: 1.0,
        test: (g) => {
          const url = g.seedUrl.toLowerCase();
          const matched = ["blog", "medium", "substack", "write", "thoughts", "notes", "diary"].some(k => url.includes(k));
          return { matched, evidence: `seed URL: ${g.seedUrl}` };
        },
      },
    ],
  },
  {
    siteType: "portfolio",
    designStrategy: "modern",
    layoutStrategy: "portfolio_showcase",
    signals: [
      {
        name: "portfolio_content_type",
        weight: 3.0,
        test: (g) => {
          const portfolio = g.stats.byContentType["PORTFOLIO"] ?? 0;
          return { matched: portfolio / Math.max(g.stats.contentNodes, 1) > 0.3, evidence: `${portfolio} portfolio nodes` };
        },
      },
      {
        name: "portfolio_layout",
        weight: 2.5,
        test: (g) => {
          const pl = g.stats.byLayout["PortfolioLayout"] ?? 0;
          return { matched: pl > 0, evidence: `${pl} portfolio layouts` };
        },
      },
      {
        name: "high_image_density",
        weight: 1.5,
        test: (g) => {
          return { matched: g.stats.averageImagesPerPage > 3, evidence: `${g.stats.averageImagesPerPage.toFixed(1)} images/page` };
        },
      },
      {
        name: "small_page_count",
        weight: 1.0,
        test: (g) => {
          return { matched: g.stats.contentNodes <= 20, evidence: `${g.stats.contentNodes} content nodes` };
        },
      },
    ],
  },
  {
    siteType: "corporate",
    designStrategy: "professional",
    layoutStrategy: "sidebar_content",
    signals: [
      {
        name: "landing_page_dominant",
        weight: 2.5,
        test: (g) => {
          const lp = g.stats.byContentType["LANDING_PAGE"] ?? 0;
          return { matched: lp / Math.max(g.stats.contentNodes, 1) > 0.3, evidence: `${lp} landing pages` };
        },
      },
      {
        name: "landing_layout_present",
        weight: 2.0,
        test: (g) => {
          const ll = g.stats.byLayout["LandingLayout"] ?? 0;
          return { matched: ll > 0, evidence: `${ll} landing layouts` };
        },
      },
      {
        name: "corporate_url_keywords",
        weight: 1.5,
        test: (g) => {
          const url = g.seedUrl.toLowerCase();
          const matched = ["corp", "company", "inc", "llc", "ltd", "business", "enterprise", "solutions", "services"].some(k => url.includes(k));
          return { matched, evidence: `seed URL: ${g.seedUrl}` };
        },
      },
      {
        name: "docs_content_type",
        weight: 1.0,
        test: (g) => {
          const docs = g.stats.byContentType["DOCS"] ?? 0;
          return { matched: docs > 0, evidence: `${docs} docs nodes` };
        },
      },
    ],
  },
  {
    siteType: "documentation",
    designStrategy: "readable",
    layoutStrategy: "documentation",
    signals: [
      {
        name: "docs_dominant",
        weight: 3.5,
        test: (g) => {
          const docs = g.stats.byContentType["DOCS"] ?? 0;
          return { matched: docs / Math.max(g.stats.contentNodes, 1) > 0.4, evidence: `${docs} docs nodes` };
        },
      },
      {
        name: "docs_layout",
        weight: 2.5,
        test: (g) => {
          const dl = g.stats.byLayout["DocumentationLayout"] ?? 0;
          return { matched: dl / Math.max(g.stats.totalNodes, 1) > 0.3, evidence: `${dl} doc layouts` };
        },
      },
      {
        name: "docs_url_keywords",
        weight: 2.0,
        test: (g) => {
          const url = g.seedUrl.toLowerCase();
          const matched = ["docs", "documentation", "wiki", "guide", "reference", "api", "developer", "dev."].some(k => url.includes(k));
          return { matched, evidence: `seed URL: ${g.seedUrl}` };
        },
      },
    ],
  },
  {
    siteType: "travel",
    designStrategy: "immersive",
    layoutStrategy: "full_bleed",
    signals: [
      {
        name: "travel_url_keywords",
        weight: 2.0,
        test: (g) => {
          const url = g.seedUrl.toLowerCase();
          const matched = ["travel", "trip", "journey", "adventure", "explore", "destination", "hotel", "tour"].some(k => url.includes(k));
          return { matched, evidence: `seed URL: ${g.seedUrl}` };
        },
      },
      {
        name: "high_image_density",
        weight: 2.0,
        test: (g) => {
          return { matched: g.stats.averageImagesPerPage > 4, evidence: `${g.stats.averageImagesPerPage.toFixed(1)} images/page` };
        },
      },
      {
        name: "many_articles_with_images",
        weight: 1.5,
        test: (g) => {
          const articles = g.stats.byContentType["ARTICLE"] ?? 0;
          return { matched: articles > 10 && g.stats.totalImages > 30, evidence: `${articles} articles, ${g.stats.totalImages} images` };
        },
      },
    ],
  },
  {
    siteType: "luxury",
    designStrategy: "elegant",
    layoutStrategy: "full_bleed",
    signals: [
      {
        name: "luxury_url_keywords",
        weight: 2.5,
        test: (g) => {
          const url = g.seedUrl.toLowerCase();
          const matched = ["luxury", "premium", "exclusive", "bespoke", "haute", "prestige", "elite", "couture"].some(k => url.includes(k));
          return { matched, evidence: `seed URL: ${g.seedUrl}` };
        },
      },
      {
        name: "visual_with_sparse_text",
        weight: 2.0,
        test: (g) => {
          return { matched: g.stats.averageImagesPerPage > 3 && g.stats.averageWordCount < 400, evidence: `${g.stats.averageImagesPerPage.toFixed(1)} img/page, ${g.stats.averageWordCount} words` };
        },
      },
      {
        name: "small_curated_content",
        weight: 1.5,
        test: (g) => {
          return { matched: g.stats.contentNodes <= 15, evidence: `${g.stats.contentNodes} content nodes` };
        },
      },
    ],
  },
  {
    siteType: "lifestyle",
    designStrategy: "friendly",
    layoutStrategy: "card_grid",
    signals: [
      {
        name: "lifestyle_url_keywords",
        weight: 2.0,
        test: (g) => {
          const url = g.seedUrl.toLowerCase();
          const matched = ["lifestyle", "living", "home", "fashion", "beauty", "wellness", "health", "food", "recipe"].some(k => url.includes(k));
          return { matched, evidence: `seed URL: ${g.seedUrl}` };
        },
      },
      {
        name: "mixed_content_and_images",
        weight: 1.5,
        test: (g) => {
          return { matched: g.stats.averageImagesPerPage >= 2 && g.stats.averageWordCount >= 300, evidence: `${g.stats.averageImagesPerPage.toFixed(1)} img/page, ${g.stats.averageWordCount} words` };
        },
      },
      {
        name: "multiple_categories",
        weight: 1.0,
        test: (g) => {
          return { matched: g.stats.totalCategories >= 3, evidence: `${g.stats.totalCategories} categories` };
        },
      },
    ],
  },
  {
    siteType: "wedding",
    designStrategy: "elegant",
    layoutStrategy: "full_bleed",
    signals: [
      {
        name: "wedding_url_keywords",
        weight: 3.5,
        test: (g) => {
          const url = g.seedUrl.toLowerCase();
          const matched = ["wedding", "bride", "bridal", "nuptial", "ceremony", "engagement"].some(k => url.includes(k));
          return { matched, evidence: `seed URL: ${g.seedUrl}` };
        },
      },
      {
        name: "gallery_heavy",
        weight: 2.0,
        test: (g) => {
          const gallery = g.stats.byContentType["GALLERY"] ?? 0;
          return { matched: gallery > 0 && g.stats.averageImagesPerPage > 3, evidence: `${gallery} galleries` };
        },
      },
    ],
  },
  {
    siteType: "marketplace",
    designStrategy: "bold",
    layoutStrategy: "card_grid",
    signals: [
      {
        name: "marketplace_url_keywords",
        weight: 2.0,
        test: (g) => {
          const url = g.seedUrl.toLowerCase();
          const matched = ["shop", "store", "market", "buy", "sell", "product", "ecommerce", "commerce"].some(k => url.includes(k));
          return { matched, evidence: `seed URL: ${g.seedUrl}` };
        },
      },
      {
        name: "many_categories_and_pages",
        weight: 2.5,
        test: (g) => {
          return { matched: g.stats.totalCategories > 8 && g.stats.contentNodes > 20, evidence: `${g.stats.totalCategories} categories, ${g.stats.contentNodes} nodes` };
        },
      },
      {
        name: "landing_pages_present",
        weight: 1.5,
        test: (g) => {
          const lp = g.stats.byContentType["LANDING_PAGE"] ?? 0;
          return { matched: lp > 3, evidence: `${lp} landing pages` };
        },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Scoring engine
// ---------------------------------------------------------------------------

function scoreProfile(
  profile: SiteTypeProfile,
  graph: SiteGraph,
  blueprint: WebsiteBlueprint,
): SiteTypeScore {
  let totalWeight = 0;
  let matchedWeight = 0;
  const signals: SiteClassificationSignal[] = [];

  for (const sig of profile.signals) {
    const { matched, evidence } = sig.test(graph, blueprint);
    totalWeight += sig.weight;
    if (matched) matchedWeight += sig.weight;
    signals.push({ signal: sig.name, weight: sig.weight, matched, evidence });
  }

  const score = totalWeight > 0 ? matchedWeight / totalWeight : 0;
  const confidence = Math.min(score * (matchedWeight / Math.max(totalWeight, 1)) * 1.5, 1.0);

  return { siteType: profile.siteType, score, confidence, signals };
}

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

export function classifySite(graph: SiteGraph, blueprint: WebsiteBlueprint): SiteClassification {
  const scores = PROFILES.map(p => ({ profile: p, result: scoreProfile(p, graph, blueprint) }));
  scores.sort((a, b) => b.result.score - a.result.score);

  const best = scores[0];
  const primary = best.result.score > 0.1 ? best.profile.siteType : "unknown";
  const profile = best.profile;

  const confidence = Math.min(best.result.confidence + 0.15, 1.0);

  const alternatives = scores
    .slice(1, 4)
    .filter(s => s.result.score > 0.1)
    .map(s => s.result);

  const matchedSignals = best.result.signals.filter(s => s.matched).map(s => s.signal).join(", ");

  return {
    primary,
    confidence,
    alternatives,
    designStrategy: profile.designStrategy,
    layoutStrategy: profile.layoutStrategy,
    reasoning: `Classified as "${primary}" (confidence: ${(confidence * 100).toFixed(0)}%) based on signals: ${matchedSignals || "default fallback"}. ${graph.stats.contentNodes} content nodes, avg ${graph.stats.averageWordCount} words, ${graph.stats.averageImagesPerPage.toFixed(1)} images/page.`,
  };
}
