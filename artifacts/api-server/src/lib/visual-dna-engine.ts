/**
 * visual-dna-engine.ts — Phase 2.5B Visual DNA Engine
 *
 * Converts screenshots, DOM snapshots, CSS, and layout metadata into
 * structured design intelligence — without relying on screenshots directly.
 *
 * Produces (uploaded to R2 under jobs/{jobId}/):
 *   _visual-dna.json        — per-page analysis + aggregate
 *   _layout-map.json        — layout classification per page
 *   _component-map.json     — component detection per page
 *   _design-tokens.json     — unified design token system
 *   visual-analysis-report.json — confidence-scored audit report
 *
 * Pipeline placement: visual_capture → visual_dna → manifest_generation
 */

import type * as cheerioType from "cheerio";
import { logger } from "./logger";
import {
  hexToRgb,
  rgbToHsl,
  normalizeHex,
  colorDistance,
  deduplicateColors,
} from "./canonical-color-engine.js";
import type { Manifest, PageNode } from "./manifest";

// Cheerio is an optional dependency — not present in the lite api-server build.
// We load it at module init via require() so the module still loads when absent.
// All call sites guard with `cheerioLib?.load(...)` and bail out when null.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cheerioLib: typeof cheerioType | null = null;
try {
  // globalThis.require is injected by the esbuild banner
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cheerioLib = (globalThis as any).require("cheerio") as typeof cheerioType;
} catch {
  cheerioLib = null;
}

// ── Output Types ───────────────────────────────────────────────────────────────

export interface HslColor {
  h: number;
  s: number;
  l: number;
  hex: string;
  frequency: number;
}

export interface ColorSystem {
  primary: string[];
  secondary: string[];
  accent: string[];
  background: string[];
  text: string[];
  allExtracted: HslColor[];
  confidence: number;
}

export interface TypographySystem {
  fontFamilies: string[];
  fontSizes: string[];
  fontWeights: string[];
  lineHeights: string[];
  letterSpacings: string[];
  headingHierarchy: Record<string, { fontSize: string; fontWeight: string }>;
  spacingRhythm: string[];
  confidence: number;
}

export type LayoutType =
  | "editorial"
  | "agency"
  | "luxury"
  | "ecommerce"
  | "documentation"
  | "portfolio"
  | "magazine";

export interface LayoutClassification {
  type: LayoutType;
  confidence: number;
  scores: Record<LayoutType, number>;
  signals: Record<string, boolean | number>;
}

export type NavigationPattern =
  | "top-navigation"
  | "sidebar"
  | "mega-menu"
  | "hamburger"
  | "sticky";

export interface NavigationAnalysis {
  patterns: NavigationPattern[];
  navItemCount: number;
  hasSearch: boolean;
  hasBreadcrumbs: boolean;
  confidence: number;
}

export interface ComponentDetection {
  hero: boolean;
  heroVariant: "fullscreen" | "split" | "centered" | "none";
  cards: number;
  gallery: boolean;
  galleryItemCount: number;
  testimonials: boolean;
  testimonialCount: number;
  ctaButtons: number;
  hasFooter: boolean;
  faqBlocks: number;
  forms: number;
  videoEmbeds: number;
  pricingTable: boolean;
  confidence: number;
}

export interface ResponsiveAnalysis {
  breakpoints: string[];
  desktopWidth: number;
  mobileWidth: number;
  heightRatioMobileToDesktop: number;
  stackingBehavior: "full-stack" | "partial-stack" | "minimal-change" | "unknown";
  strategy: "mobile-first" | "desktop-first" | "fluid" | "unknown";
  confidence: number;
}

export interface PageDna {
  nodeId: string;
  url: string;
  colorSystem: ColorSystem;
  typographySystem: TypographySystem;
  layoutClassification: LayoutClassification;
  navigationAnalysis: NavigationAnalysis;
  componentDetection: ComponentDetection;
  responsiveAnalysis: ResponsiveAnalysis;
  cssCharCount: number;
  domElementCount: number;
}

export interface VisualDnaAggregate {
  dominantColors: string[];
  dominantFonts: string[];
  dominantLayoutType: LayoutType;
  presentNavigationPatterns: NavigationPattern[];
  presentComponents: string[];
  totalPages: number;
}

export interface VisualDnaOutput {
  jobId: string;
  generatedAt: string;
  pages: Record<string, PageDna>;
  aggregate: VisualDnaAggregate;
}

export interface LayoutMapOutput {
  jobId: string;
  generatedAt: string;
  pages: Record<string, {
    url: string;
    layoutType: LayoutType;
    confidence: number;
    scores: Record<LayoutType, number>;
  }>;
}

export interface ComponentMapOutput {
  jobId: string;
  generatedAt: string;
  pages: Record<string, {
    url: string;
    components: ComponentDetection;
  }>;
  aggregate: {
    commonComponents: string[];
    heroPresent: number;
    pagesWithGallery: number;
    pagesWithTestimonials: number;
  };
}

export interface DesignTokensOutput {
  jobId: string;
  generatedAt: string;
  colors: {
    primary: string[];
    secondary: string[];
    accent: string[];
    background: string[];
    text: string[];
  };
  typography: {
    fontFamilies: string[];
    fontSizes: string[];
    fontWeights: string[];
    headingHierarchy: Record<string, { fontSize: string; fontWeight: string }>;
    spacingRhythm: string[];
  };
  layout: {
    dominantType: LayoutType;
    navigationPatterns: NavigationPattern[];
  };
  breakpoints: string[];
  components: string[];
}

export interface VisualAnalysisReport {
  jobId: string;
  generatedAt: string;
  summary: {
    pagesAnalyzed: number;
    colorSystemConfidence: number;
    typographySystemConfidence: number;
    layoutClassificationConfidence: number;
    componentDetectionConfidence: number;
    navigationAnalysisConfidence: number;
    responsiveAnalysisConfidence: number;
    overallConfidence: number;
  };
  perPage: Record<string, {
    url: string;
    confidenceScores: {
      colorSystem: number;
      typography: number;
      layout: number;
      navigation: number;
      components: number;
      responsive: number;
    };
    layoutType: LayoutType;
    topColors: string[];
    topFonts: string[];
    detectedComponents: string[];
  }>;
  systemDescription: string;
  warnings: string[];
}

export interface VisualDnaAudit {
  pagesAnalyzed: number;
  pagesSkipped: number;
  overallConfidence: number;
  r2Uploads: number;
  r2Failures: number;
  durationMs: number;
}

// ── Colour utilities — imported from canonical-color-engine ───────────────────

function extractColors(cssText: string): ColorSystem {
  const rawColors: string[] = [];

  // Hex colors
  const hexRe = /#([0-9a-fA-F]{3,8})\b/g;
  let m: RegExpExecArray | null;
  while ((m = hexRe.exec(cssText)) !== null) {
    const norm = normalizeHex(m[0]);
    if (norm) rawColors.push(norm);
  }

  // rgb/rgba
  const rgbRe = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g;
  while ((m = rgbRe.exec(cssText)) !== null) {
    const r = parseInt(m[1]);
    const g = parseInt(m[2]);
    const b = parseInt(m[3]);
    if (r > 255 || g > 255 || b > 255) continue;
    const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    rawColors.push(hex);
  }

  if (rawColors.length === 0) {
    return { primary: [], secondary: [], accent: [], background: [], text: [], allExtracted: [], confidence: 0 };
  }

  const freq = deduplicateColors(rawColors);
  const sorted = [...freq]
    .sort((a, b) => b.count - a.count)
    .slice(0, 40);

  const allExtracted: HslColor[] = sorted.map((cf) => {
    const rgb = hexToRgb(cf.hex)!;
    const hsl = rgbToHsl(rgb);
    return { ...hsl, hex: cf.hex, frequency: cf.count };
  });

  const backgrounds = allExtracted.filter(c => c.l > 88);
  const textColors  = allExtracted.filter(c => c.l < 20 && c.s < 20);
  const saturated   = allExtracted.filter(c => c.s > 25 && c.l >= 20 && c.l <= 80);
  const light       = allExtracted.filter(c => c.l >= 20 && c.l <= 88 && c.s <= 25);

  const primary   = saturated.slice(0, 2).map(c => c.hex);
  const secondary = (saturated.length > 2 ? saturated.slice(2, 4) : light.slice(0, 2)).map(c => c.hex);
  const accent    = saturated.slice(4, 6).map(c => c.hex);

  const confidence = Math.min(1, rawColors.length / 60);

  return {
    primary,
    secondary,
    accent,
    background: backgrounds.slice(0, 3).map(c => c.hex),
    text: textColors.slice(0, 3).map(c => c.hex),
    allExtracted: allExtracted.slice(0, 20),
    confidence: parseFloat(confidence.toFixed(2)),
  };
}

// ── Typography utilities ───────────────────────────────────────────────────────

function cleanCssValue(v: string): string {
  return v.replace(/!important/g, "").replace(/['";]/g, "").trim();
}

function extractTypography(cssText: string, $: ReturnType<typeof cheerioType.load>): TypographySystem {
  // Font families
  const familyRe = /font-family\s*:\s*([^;}{]+)/gi;
  const families = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = familyRe.exec(cssText)) !== null) {
    const raw = cleanCssValue(m[1]);
    // Split by comma and take the first meaningful name
    raw.split(",").forEach(f => {
      const name = f.trim().replace(/^["']|["']$/g, "").trim();
      if (name && !name.toLowerCase().includes("sans-serif") && !name.toLowerCase().includes("serif") && !name.toLowerCase().includes("monospace") && name.length > 1) {
        families.add(name);
      }
    });
  }

  // Also scrape link[rel=stylesheet] hrefs for Google Fonts names
  $("link[rel='stylesheet'][href*='fonts.googleapis']").each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    const match = href.match(/family=([^&:]+)/);
    if (match) {
      match[1].split("|").forEach(f => families.add(decodeURIComponent(f.split(":")[0])));
    }
  });

  // Font sizes
  const sizeRe = /font-size\s*:\s*([^;}{]+)/gi;
  const sizeSet = new Set<string>();
  while ((m = sizeRe.exec(cssText)) !== null) {
    const v = cleanCssValue(m[1]);
    if (/^[\d.]+(?:px|rem|em|%)$/.test(v)) sizeSet.add(v);
  }

  // Font weights
  const weightRe = /font-weight\s*:\s*([^;}{]+)/gi;
  const weightSet = new Set<string>();
  while ((m = weightRe.exec(cssText)) !== null) {
    const v = cleanCssValue(m[1]);
    if (/^(?:\d{3}|bold|normal|light|bolder|lighter)$/.test(v)) weightSet.add(v);
  }

  // Line heights
  const lhRe = /line-height\s*:\s*([^;}{]+)/gi;
  const lhSet = new Set<string>();
  while ((m = lhRe.exec(cssText)) !== null) {
    const v = cleanCssValue(m[1]);
    if (v && v.length < 10) lhSet.add(v);
  }

  // Letter spacings
  const lsRe = /letter-spacing\s*:\s*([^;}{]+)/gi;
  const lsSet = new Set<string>();
  while ((m = lsRe.exec(cssText)) !== null) {
    const v = cleanCssValue(m[1]);
    if (v && v.length < 10) lsSet.add(v);
  }

  // Spacing rhythm — most common margin/padding values
  const spacingRe = /(?:margin|padding)(?:-top|-bottom|-left|-right)?\s*:\s*([^;}{]+)/gi;
  const spacingFreq = new Map<string, number>();
  while ((m = spacingRe.exec(cssText)) !== null) {
    cleanCssValue(m[1]).split(" ").forEach(v => {
      if (/^[\d.]+(?:px|rem|em)$/.test(v.trim())) {
        spacingFreq.set(v.trim(), (spacingFreq.get(v.trim()) ?? 0) + 1);
      }
    });
  }
  const spacingRhythm = [...spacingFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(e => e[0]);

  // Heading hierarchy from CSS rules: h1-h6 { font-size: ...; font-weight: ... }
  const headingHierarchy: Record<string, { fontSize: string; fontWeight: string }> = {};
  const headingRe = /(h[1-6])\s*\{([^}]+)\}/gi;
  while ((m = headingRe.exec(cssText)) !== null) {
    const tag = m[1].toLowerCase();
    const block = m[2];
    const fs = block.match(/font-size\s*:\s*([^;]+)/i);
    const fw = block.match(/font-weight\s*:\s*([^;]+)/i);
    headingHierarchy[tag] = {
      fontSize: fs ? cleanCssValue(fs[1]) : "",
      fontWeight: fw ? cleanCssValue(fw[1]) : "",
    };
  }

  // Sort sizes numerically
  const sortedSizes = [...sizeSet].sort((a, b) => parseFloat(a) - parseFloat(b));

  const confidence = Math.min(1, (families.size + sizeSet.size) / 10);

  return {
    fontFamilies: [...families].slice(0, 8),
    fontSizes: sortedSizes.slice(0, 12),
    fontWeights: [...weightSet].slice(0, 6),
    lineHeights: [...lhSet].slice(0, 6),
    letterSpacings: [...lsSet].slice(0, 4),
    headingHierarchy,
    spacingRhythm,
    confidence: parseFloat(confidence.toFixed(2)),
  };
}

// ── Layout classification ──────────────────────────────────────────────────────

function classifyLayout(
  $: ReturnType<typeof cheerioType.load>,
  cssText: string,
  layoutMeta: NonNullable<PageNode["visualAssets"]>["layoutMetadata"]
): LayoutClassification {
  const scores: Record<LayoutType, number> = {
    editorial: 0, agency: 0, luxury: 0, ecommerce: 0,
    documentation: 0, portfolio: 0, magazine: 0,
  };
  const signals: Record<string, boolean | number> = {};

  // — Editorial signals —
  const articleCount = $("article").length;
  const timeCount    = $("time").length;
  const authorCount  = $("[class*='author'], [class*='byline'], [rel='author']").length;
  signals.articles     = articleCount;
  signals.timestamps   = timeCount;
  signals.authorByline = authorCount > 0;
  scores.editorial += Math.min(articleCount * 1.5, 4);
  scores.editorial += timeCount > 0 ? 2 : 0;
  scores.editorial += authorCount > 0 ? 2 : 0;
  scores.editorial += (layoutMeta?.headingStructure?.h1 ?? 0) > 0 ? 1 : 0;
  scores.editorial += layoutMeta?.hasNavigation ? 1 : 0;

  // — Agency signals —
  const serviceCount = $("[class*='service']").length;
  const teamCount    = $("[class*='team'], [class*='staff']").length;
  const caseStudy    = $("[class*='case-study'], [class*='casestudy']").length;
  signals.serviceBlocks = serviceCount;
  signals.teamSection   = teamCount > 0;
  signals.caseStudies   = caseStudy;
  scores.agency += Math.min(serviceCount * 1.5, 4);
  scores.agency += teamCount > 0 ? 2 : 0;
  scores.agency += caseStudy > 0 ? 2 : 0;
  scores.agency += $("[class*='portfolio'], [class*='our-work'], [class*='ourwork']").length > 0 ? 2 : 0;
  scores.agency += $("[class*='client'], [class*='partner']").length > 0 ? 1 : 0;

  // — Luxury signals —
  const sectionCount = layoutMeta?.sectionCount ?? $("section").length;
  const heightPerSection = sectionCount > 0 ? (layoutMeta?.pageHeight ?? 0) / sectionCount : 0;
  const luxuryClass = $("[class*='luxury'], [class*='premium'], [class*='exclusive'], [class*='couture']").length;
  signals.sectionsCount    = sectionCount;
  signals.heightPerSection = Math.round(heightPerSection);
  signals.luxuryKeywords   = luxuryClass > 0;
  scores.luxury += sectionCount <= 4 ? 2 : 0;
  scores.luxury += heightPerSection > 800 ? 2 : 0;
  scores.luxury += luxuryClass > 0 ? 3 : 0;
  scores.luxury += (layoutMeta?.imageCount ?? 0) > 0 && sectionCount <= 5 ? 1 : 0;

  // — Ecommerce signals —
  const productCount  = $("[class*='product'], [class*='item'], [data-product-id]").length;
  const priceCount    = $("[class*='price'], .price, [data-price], [class*='cost']").length;
  const cartCount     = $("[class*='cart'], [class*='basket'], [class*='checkout']").length;
  const buyBtnCount   = $("button, a").filter((_i, el) =>
    /buy|add to cart|shop now|order/i.test($(el).text())
  ).length;
  signals.productElements = productCount;
  signals.priceElements   = priceCount;
  signals.cartElements    = cartCount;
  signals.buyButtons      = buyBtnCount;
  scores.ecommerce += Math.min(productCount * 0.5, 3);
  scores.ecommerce += priceCount > 0 ? 3 : 0;
  scores.ecommerce += cartCount > 0 ? 2 : 0;
  scores.ecommerce += buyBtnCount > 0 ? 2 : 0;

  // — Documentation signals —
  const codeCount   = $("pre, code, kbd").length;
  const tocCount    = $("[class*='toc'], [id*='toc'], nav[aria-label*='contents' i]").length;
  const sidebarNav  = $("aside nav, .sidebar nav, [class*='sidebar'] nav").length;
  signals.codeBlocks   = codeCount;
  signals.tocPresent   = tocCount > 0;
  signals.sidebarNav   = sidebarNav > 0;
  scores.documentation += Math.min(codeCount * 0.8, 4);
  scores.documentation += tocCount > 0 ? 2 : 0;
  scores.documentation += sidebarNav > 0 ? 2 : 0;
  // Many hierarchical headings
  const h3h4 = (layoutMeta?.headingStructure?.h3 ?? 0) + (layoutMeta?.headingStructure?.h4 ?? 0);
  scores.documentation += h3h4 > 5 ? 1 : 0;

  // — Portfolio signals —
  const workCount    = $("[class*='work'], [class*='project'], [class*='folio']").length;
  const figureCount  = $("figure").length;
  const galleryCount = $("[class*='gallery'], [class*='grid'] img").length;
  signals.workItems      = workCount;
  signals.figureElements = figureCount;
  signals.galleryItems   = galleryCount;
  scores.portfolio += Math.min(workCount * 1.5, 4);
  scores.portfolio += figureCount > 2 ? 2 : 0;
  scores.portfolio += galleryCount > 2 ? 1 : 0;
  scores.portfolio += caseStudy > 0 ? 1 : 0;

  // — Magazine signals —
  const categoryCount  = $("[class*='category'], [class*='tag'], [class*='topic']").length;
  const featuredCount  = $("[class*='featured'], [class*='spotlight']").length;
  const multipleArticles = articleCount > 3;
  signals.categories  = categoryCount;
  signals.featuredItems = featuredCount;
  signals.multiArticles = multipleArticles;
  scores.magazine += Math.min(categoryCount * 0.8, 3);
  scores.magazine += featuredCount > 0 ? 2 : 0;
  scores.magazine += multipleArticles ? 2 : 0;
  scores.magazine += sectionCount > 5 ? 1 : 0;
  scores.magazine += (layoutMeta?.imageCount ?? 0) > 5 ? 1 : 0;

  // Normalise scores to [0,1]
  const maxPossible = 10;
  const normalised = Object.fromEntries(
    Object.entries(scores).map(([k, v]) => [k, parseFloat((v / maxPossible).toFixed(3))])
  ) as Record<LayoutType, number>;

  const sorted = Object.entries(normalised).sort((a, b) => b[1] - a[1]);
  const winner = sorted[0];
  const confidence = Math.min(1, winner[1] > 0
    ? parseFloat(((winner[1] - (sorted[1]?.[1] ?? 0)) * 2 + winner[1]).toFixed(2))
    : 0
  );

  return {
    type: winner[0] as LayoutType,
    confidence: Math.min(confidence, 1),
    scores: normalised,
    signals,
  };
}

// ── Navigation analysis ────────────────────────────────────────────────────────

function analyzeNavigation(
  $: ReturnType<typeof cheerioType.load>,
  cssText: string
): NavigationAnalysis {
  const patterns: NavigationPattern[] = [];

  // Top navigation
  const topNav = $("header nav, .header nav, nav.main, nav.primary, [class*='navbar'], [class*='topnav']").length;
  if (topNav > 0 || $("nav").first().closest("header, [class*='header']").length > 0) {
    patterns.push("top-navigation");
  } else if ($("nav").length > 0) {
    patterns.push("top-navigation"); // default assumption
  }

  // Sidebar
  const sidebarNav = $("aside nav, .sidebar, [class*='sidebar']").length;
  if (sidebarNav > 0) patterns.push("sidebar");

  // Mega menu (nav with deeply nested lists or many items)
  const megaMenuItems = $("nav ul li ul").length;
  const largeNavList  = $("nav ul").filter((_i, el) => $(el).find("li").length > 8).length;
  if (megaMenuItems > 2 || largeNavList > 0) patterns.push("mega-menu");

  // Hamburger / mobile menu toggle
  const hamburger = $("[class*='hamburger'], [class*='menu-toggle'], [class*='nav-toggle'], [class*='menu-btn'], [aria-label*='menu' i], [aria-label*='navigation' i]").length;
  if (hamburger > 0) patterns.push("hamburger");

  // Sticky navigation
  const stickyNav  = cssText.includes("position: sticky") || cssText.includes("position:sticky");
  const fixedHeader = cssText.includes("position: fixed") && (
    cssText.includes("header") || cssText.includes("nav") || cssText.includes("navbar")
  );
  if (stickyNav || fixedHeader) patterns.push("sticky");

  // Count nav items
  const navItemCount = Math.max($("nav > ul > li").length, $("nav li").length);

  // Search
  const hasSearch = $("input[type='search'], [class*='search'], [role='search']").length > 0;

  // Breadcrumbs
  const hasBreadcrumbs = $("[class*='breadcrumb'], [aria-label*='breadcrumb' i], nav[aria-label*='you are here' i]").length > 0;

  const confidence = patterns.length > 0 ? 0.85 : 0.4;

  return {
    patterns: [...new Set(patterns)],
    navItemCount,
    hasSearch,
    hasBreadcrumbs,
    confidence,
  };
}

// ── Component detection ────────────────────────────────────────────────────────

function detectComponents(
  $: ReturnType<typeof cheerioType.load>
): ComponentDetection {
  // Hero
  const heroEl    = $("[class*='hero'], .hero, [id*='hero']");
  const hasHero   = heroEl.length > 0;
  let heroVariant: ComponentDetection["heroVariant"] = "none";
  if (hasHero) {
    if (heroEl.find("img, video").length > 0 && heroEl.find("[class*='text'], p, h1, h2").length > 0) {
      heroVariant = "split";
    } else if (heroEl.css?.("min-height")?.includes("100") || heroEl.attr("style")?.includes("100vh")) {
      heroVariant = "fullscreen";
    } else {
      heroVariant = "centered";
    }
  }

  // Cards
  const cardCount = $(".card, [class*='card'], [class*='tile'], [class*='item']").length;

  // Gallery
  const galleryEl        = $("[class*='gallery'], .gallery, [class*='slider'], [class*='carousel']");
  const galleryItemCount = galleryEl.find("img").length || $("[class*='grid'] img, .grid img").length;
  const hasGallery       = galleryEl.length > 0 || galleryItemCount > 2;

  // Testimonials
  const testimonialEl    = $("[class*='testimonial'], [class*='review'], [class*='quote'] blockquote, .testimonials blockquote");
  const testimonialCount = testimonialEl.length;

  // CTA buttons
  const ctaCount = $(".cta, [class*='cta'], [class*='call-to-action'], a[class*='btn'][class*='primary']").length
    + $("button, a").filter((_i, el) => {
      const text = $(el).text().toLowerCase().trim();
      return /^(get started|learn more|sign up|try free|start free|contact us|book a demo|get a quote|see pricing)$/.test(text);
    }).length;

  // Footer
  const hasFooter = $("footer, [class*='footer'], [role='contentinfo']").length > 0;

  // FAQ
  const faqCount = $("[class*='faq'], [class*='accordion'], details").length;

  // Forms
  const formCount = $("form:not([class*='search'])").length;

  // Video embeds
  const videoCount = $("video, iframe[src*='youtube'], iframe[src*='vimeo'], iframe[src*='loom']").length;

  // Pricing table
  const hasPricing = $("[class*='pricing'], [class*='plan'], [class*='tier']").length > 0
    && $("[class*='price'], .price").length > 0;

  const detectedCount = [hasHero, cardCount > 0, hasGallery, testimonialCount > 0, ctaCount > 0, hasFooter, faqCount > 0].filter(Boolean).length;
  const confidence = Math.min(1, 0.5 + detectedCount * 0.07);

  return {
    hero: hasHero,
    heroVariant,
    cards: cardCount,
    gallery: hasGallery,
    galleryItemCount,
    testimonials: testimonialCount > 0,
    testimonialCount,
    ctaButtons: ctaCount,
    hasFooter,
    faqBlocks: faqCount,
    forms: formCount,
    videoEmbeds: videoCount,
    pricingTable: hasPricing,
    confidence: parseFloat(confidence.toFixed(2)),
  };
}

// ── Responsive analysis ────────────────────────────────────────────────────────

function analyzeResponsive(
  cssText: string,
  layoutMeta?: NonNullable<PageNode["visualAssets"]>["layoutMetadata"]
): ResponsiveAnalysis {
  // Extract breakpoints from media queries
  const bpRe = /@media[^{]*\((?:min|max)-width\s*:\s*([\d.]+)(px|em|rem)\)/gi;
  const bpSet = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = bpRe.exec(cssText)) !== null) {
    bpSet.add(`${m[1]}${m[2]}`);
  }

  // Determine mobile-first vs desktop-first from min-width vs max-width usage
  const minWidthCount = (cssText.match(/min-width/gi) ?? []).length;
  const maxWidthCount = (cssText.match(/max-width/gi) ?? []).length;
  let strategy: ResponsiveAnalysis["strategy"] = "unknown";
  if (minWidthCount + maxWidthCount > 5) {
    if (minWidthCount > maxWidthCount * 1.5) strategy = "mobile-first";
    else if (maxWidthCount > minWidthCount * 1.5) strategy = "desktop-first";
    else strategy = "fluid";
  }

  // Stacking behavior from layout metadata
  const desktopWidth = layoutMeta?.pageWidth ?? 1280;
  const mobileWidth  = 390; // our standard capture width

  let stackingBehavior: ResponsiveAnalysis["stackingBehavior"] = "unknown";
  if (layoutMeta) {
    const ratio = (layoutMeta.pageHeight / desktopWidth) / (mobileWidth / desktopWidth);
    if (ratio > 3) stackingBehavior = "full-stack";
    else if (ratio > 1.5) stackingBehavior = "partial-stack";
    else stackingBehavior = "minimal-change";
  }

  const heightRatioMobileToDesktop = layoutMeta
    ? parseFloat(((layoutMeta.pageHeight / (layoutMeta.pageWidth || 1280))).toFixed(2))
    : 1;

  // Sort breakpoints numerically
  const sortedBps = [...bpSet].sort((a, b) => parseFloat(a) - parseFloat(b));

  const confidence = bpSet.size > 0 ? Math.min(1, 0.6 + bpSet.size * 0.08) : 0.35;

  return {
    breakpoints: sortedBps,
    desktopWidth,
    mobileWidth,
    heightRatioMobileToDesktop,
    stackingBehavior,
    strategy,
    confidence: parseFloat(confidence.toFixed(2)),
  };
}

// ── CSS extraction from HTML ───────────────────────────────────────────────────

function extractCssFromHtml(html: string): string {
  if (!cheerioLib) return "";
  const $ = cheerioLib.load(html);
  const parts: string[] = [];

  // Inline <style> tags
  $("style").each((_i, el) => {
    parts.push($(el).html() ?? "");
  });

  // Inline style attributes (reduced)
  const inlineStyles: string[] = [];
  $("[style]").each((_i, el) => {
    const s = $(el).attr("style");
    if (s) inlineStyles.push(s);
  });
  if (inlineStyles.length > 0) {
    parts.push(`/* inline styles */ .x { ${inlineStyles.join(" ")} }`);
  }

  return parts.join("\n\n");
}

// ── Per-page analysis ──────────────────────────────────────────────────────────

function analysePage(node: PageNode): PageDna | null {
  try {
    const html = node.content?.cleanHtml ?? "";
    if (!html || html.length < 50) return null;

    if (!cheerioLib) return null;
    const $ = cheerioLib.load(html);
    const cssText = extractCssFromHtml(html);

    const colorSystem         = extractColors(cssText);
    const typographySystem    = extractTypography(cssText, $);
    const layoutClassification = classifyLayout($, cssText, node.visualAssets?.layoutMetadata);
    const navigationAnalysis  = analyzeNavigation($, cssText);
    const componentDetection  = detectComponents($);
    const responsiveAnalysis  = analyzeResponsive(cssText, node.visualAssets?.layoutMetadata);

    const domElementCount = $("*").length;

    return {
      nodeId: node.id,
      url: node.metadata?.url ?? "",
      colorSystem,
      typographySystem,
      layoutClassification,
      navigationAnalysis,
      componentDetection,
      responsiveAnalysis,
      cssCharCount: cssText.length,
      domElementCount,
    };
  } catch (err) {
    logger.warn({ nodeId: node.id, err }, "VISUAL_DNA: per-page analysis failed");
    return null;
  }
}

// ── Aggregation ────────────────────────────────────────────────────────────────

function aggregateResults(pages: PageDna[]): VisualDnaAggregate {
  // Colour frequency across pages
  const colorFreq = new Map<string, number>();
  for (const p of pages) {
    for (const c of p.colorSystem.primary) colorFreq.set(c, (colorFreq.get(c) ?? 0) + 2);
    for (const c of p.colorSystem.secondary) colorFreq.set(c, (colorFreq.get(c) ?? 0) + 1);
  }
  const dominantColors = [...colorFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(e => e[0]);

  // Font frequency
  const fontFreq = new Map<string, number>();
  for (const p of pages) {
    for (const f of p.typographySystem.fontFamilies) fontFreq.set(f, (fontFreq.get(f) ?? 0) + 1);
  }
  const dominantFonts = [...fontFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(e => e[0]);

  // Dominant layout type
  const layoutFreq = new Map<LayoutType, number>();
  for (const p of pages) {
    const t = p.layoutClassification.type;
    layoutFreq.set(t, (layoutFreq.get(t) ?? 0) + 1);
  }
  const dominantLayoutType = ([...layoutFreq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "editorial") as LayoutType;

  // Navigation patterns
  const navPatternFreq = new Map<NavigationPattern, number>();
  for (const p of pages) {
    for (const pat of p.navigationAnalysis.patterns) {
      navPatternFreq.set(pat, (navPatternFreq.get(pat) ?? 0) + 1);
    }
  }
  const threshold = Math.max(1, Math.ceil(pages.length * 0.4));
  const presentNavigationPatterns = [...navPatternFreq.entries()]
    .filter(([, cnt]) => cnt >= threshold)
    .map(([p]) => p);

  // Present components
  const compFreq = new Map<string, number>();
  for (const p of pages) {
    const c = p.componentDetection;
    if (c.hero)              compFreq.set("hero", (compFreq.get("hero") ?? 0) + 1);
    if (c.cards > 0)         compFreq.set("cards", (compFreq.get("cards") ?? 0) + 1);
    if (c.gallery)           compFreq.set("gallery", (compFreq.get("gallery") ?? 0) + 1);
    if (c.testimonials)      compFreq.set("testimonials", (compFreq.get("testimonials") ?? 0) + 1);
    if (c.ctaButtons > 0)    compFreq.set("cta", (compFreq.get("cta") ?? 0) + 1);
    if (c.hasFooter)         compFreq.set("footer", (compFreq.get("footer") ?? 0) + 1);
    if (c.faqBlocks > 0)     compFreq.set("faq", (compFreq.get("faq") ?? 0) + 1);
    if (c.pricingTable)      compFreq.set("pricing", (compFreq.get("pricing") ?? 0) + 1);
  }
  const presentComponents = [...compFreq.entries()]
    .filter(([, cnt]) => cnt >= threshold)
    .map(([c]) => c);

  return {
    dominantColors,
    dominantFonts,
    dominantLayoutType,
    presentNavigationPatterns,
    presentComponents,
    totalPages: pages.length,
  };
}

// ── Output assembly ────────────────────────────────────────────────────────────

function buildLayoutMap(jobId: string, pages: PageDna[]): LayoutMapOutput {
  const result: LayoutMapOutput["pages"] = {};
  for (const p of pages) {
    result[p.nodeId] = {
      url: p.url,
      layoutType: p.layoutClassification.type,
      confidence: p.layoutClassification.confidence,
      scores: p.layoutClassification.scores,
    };
  }
  return { jobId, generatedAt: new Date().toISOString(), pages: result };
}

function buildComponentMap(jobId: string, pages: PageDna[]): ComponentMapOutput {
  const result: ComponentMapOutput["pages"] = {};
  let heroPresent = 0, pagesWithGallery = 0, pagesWithTestimonials = 0;
  const compFreq = new Map<string, number>();

  for (const p of pages) {
    const c = p.componentDetection;
    result[p.nodeId] = { url: p.url, components: c };
    if (c.hero)         { heroPresent++; compFreq.set("hero", (compFreq.get("hero") ?? 0) + 1); }
    if (c.gallery)      { pagesWithGallery++; compFreq.set("gallery", (compFreq.get("gallery") ?? 0) + 1); }
    if (c.testimonials) { pagesWithTestimonials++; compFreq.set("testimonials", (compFreq.get("testimonials") ?? 0) + 1); }
    if (c.cards > 0)         compFreq.set("cards", (compFreq.get("cards") ?? 0) + 1);
    if (c.ctaButtons > 0)    compFreq.set("cta", (compFreq.get("cta") ?? 0) + 1);
    if (c.hasFooter)         compFreq.set("footer", (compFreq.get("footer") ?? 0) + 1);
    if (c.faqBlocks > 0)     compFreq.set("faq", (compFreq.get("faq") ?? 0) + 1);
    if (c.pricingTable)      compFreq.set("pricing", (compFreq.get("pricing") ?? 0) + 1);
  }

  const threshold = Math.max(1, Math.ceil(pages.length * 0.5));
  const commonComponents = [...compFreq.entries()]
    .filter(([, cnt]) => cnt >= threshold)
    .map(([c]) => c);

  return {
    jobId,
    generatedAt: new Date().toISOString(),
    pages: result,
    aggregate: { commonComponents, heroPresent, pagesWithGallery, pagesWithTestimonials },
  };
}

function buildDesignTokens(jobId: string, pages: PageDna[], aggregate: VisualDnaAggregate): DesignTokensOutput {
  // Aggregate colors across pages
  const colorBuckets: Record<string, Map<string, number>> = {
    primary: new Map(), secondary: new Map(), accent: new Map(),
    background: new Map(), text: new Map(),
  };
  for (const p of pages) {
    const cs = p.colorSystem;
    (["primary", "secondary", "accent", "background", "text"] as const).forEach(bucket => {
      for (const hex of cs[bucket]) {
        colorBuckets[bucket].set(hex, (colorBuckets[bucket].get(hex) ?? 0) + 1);
      }
    });
  }
  const topColors = (bucket: Map<string, number>) =>
    [...bucket.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);

  // Font sizes — collect and deduplicate
  const allSizes: string[] = [];
  for (const p of pages) allSizes.push(...p.typographySystem.fontSizes);
  const sizeFreq = new Map<string, number>();
  for (const s of allSizes) sizeFreq.set(s, (sizeFreq.get(s) ?? 0) + 1);
  const topSizes = [...sizeFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(e => e[0]);

  // Font weights — collect
  const allWeights: string[] = [];
  for (const p of pages) allWeights.push(...p.typographySystem.fontWeights);
  const weightSet = [...new Set(allWeights)];

  // Heading hierarchy — prefer the most complete page
  const richestPage = [...pages].sort((a, b) =>
    Object.keys(b.typographySystem.headingHierarchy).length - Object.keys(a.typographySystem.headingHierarchy).length
  )[0];
  const headingHierarchy = richestPage?.typographySystem.headingHierarchy ?? {};

  // Spacing rhythm
  const allSpacing: string[] = [];
  for (const p of pages) allSpacing.push(...p.typographySystem.spacingRhythm);
  const spacingFreq = new Map<string, number>();
  for (const s of allSpacing) spacingFreq.set(s, (spacingFreq.get(s) ?? 0) + 1);
  const spacingRhythm = [...spacingFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(e => e[0]);

  // Breakpoints
  const allBreakpoints: string[] = [];
  for (const p of pages) allBreakpoints.push(...p.responsiveAnalysis.breakpoints);
  const bpFreq = new Map<string, number>();
  for (const bp of allBreakpoints) bpFreq.set(bp, (bpFreq.get(bp) ?? 0) + 1);
  const breakpoints = [...bpFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(e => e[0]);

  return {
    jobId,
    generatedAt: new Date().toISOString(),
    colors: {
      primary:    topColors(colorBuckets.primary),
      secondary:  topColors(colorBuckets.secondary),
      accent:     topColors(colorBuckets.accent),
      background: topColors(colorBuckets.background),
      text:       topColors(colorBuckets.text),
    },
    typography: {
      fontFamilies:     aggregate.dominantFonts,
      fontSizes:        topSizes,
      fontWeights:      weightSet,
      headingHierarchy,
      spacingRhythm,
    },
    layout: {
      dominantType:       aggregate.dominantLayoutType,
      navigationPatterns: aggregate.presentNavigationPatterns,
    },
    breakpoints,
    components: aggregate.presentComponents,
  };
}

function buildReport(jobId: string, pages: PageDna[], aggregate: VisualDnaAggregate): VisualAnalysisReport {
  const warnings: string[] = [];

  const avg = (vals: number[]) => vals.length > 0
    ? parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2))
    : 0;

  const colorConfs   = pages.map(p => p.colorSystem.confidence);
  const typoConfs    = pages.map(p => p.typographySystem.confidence);
  const layoutConfs  = pages.map(p => p.layoutClassification.confidence);
  const compConfs    = pages.map(p => p.componentDetection.confidence);
  const navConfs     = pages.map(p => p.navigationAnalysis.confidence);
  const respConfs    = pages.map(p => p.responsiveAnalysis.confidence);

  const colorSystemConfidence           = avg(colorConfs);
  const typographySystemConfidence      = avg(typoConfs);
  const layoutClassificationConfidence  = avg(layoutConfs);
  const componentDetectionConfidence    = avg(compConfs);
  const navigationAnalysisConfidence    = avg(navConfs);
  const responsiveAnalysisConfidence    = avg(respConfs);
  const overallConfidence               = avg([
    colorSystemConfidence,
    typographySystemConfidence,
    layoutClassificationConfidence,
    componentDetectionConfidence,
    navigationAnalysisConfidence,
    responsiveAnalysisConfidence,
  ]);

  if (colorSystemConfidence < 0.4) warnings.push("Low color extraction confidence — pages may use CSS-in-JS or external stylesheets.");
  if (typographySystemConfidence < 0.4) warnings.push("Low typography confidence — font stack may be loaded via JavaScript.");
  if (layoutClassificationConfidence < 0.5) warnings.push("Ambiguous layout type — signals are mixed across pages.");

  // Per-page summary
  const perPage: VisualAnalysisReport["perPage"] = {};
  for (const p of pages) {
    const compNames: string[] = [];
    const c = p.componentDetection;
    if (c.hero)         compNames.push("hero");
    if (c.cards > 0)    compNames.push("cards");
    if (c.gallery)      compNames.push("gallery");
    if (c.testimonials) compNames.push("testimonials");
    if (c.ctaButtons)   compNames.push("cta");
    if (c.hasFooter)    compNames.push("footer");
    if (c.faqBlocks)    compNames.push("faq");
    if (c.pricingTable) compNames.push("pricing");

    perPage[p.nodeId] = {
      url: p.url,
      confidenceScores: {
        colorSystem:  p.colorSystem.confidence,
        typography:   p.typographySystem.confidence,
        layout:       p.layoutClassification.confidence,
        navigation:   p.navigationAnalysis.confidence,
        components:   p.componentDetection.confidence,
        responsive:   p.responsiveAnalysis.confidence,
      },
      layoutType:         p.layoutClassification.type,
      topColors:          [...p.colorSystem.primary, ...p.colorSystem.secondary].slice(0, 4),
      topFonts:           p.typographySystem.fontFamilies.slice(0, 3),
      detectedComponents: compNames,
    };
  }

  // Human-readable system description
  const fontDesc  = aggregate.dominantFonts.length > 0
    ? `using ${aggregate.dominantFonts.slice(0, 2).join(" and ")}`
    : "with unspecified typefaces";
  const colorDesc = aggregate.dominantColors.length > 0
    ? `a palette anchored by ${aggregate.dominantColors.slice(0, 2).join(", ")}`
    : "an unextracted colour palette";
  const navDesc   = aggregate.presentNavigationPatterns.length > 0
    ? aggregate.presentNavigationPatterns.join(", ")
    : "standard";
  const compDesc  = aggregate.presentComponents.length > 0
    ? aggregate.presentComponents.join(", ")
    : "standard elements";

  const systemDescription =
    `${aggregate.dominantLayoutType.charAt(0).toUpperCase() + aggregate.dominantLayoutType.slice(1)}-style site ${fontDesc}, ` +
    `with ${colorDesc}. Navigation: ${navDesc}. Recurring components: ${compDesc}. ` +
    `Overall analysis confidence: ${Math.round(overallConfidence * 100)}%.`;

  return {
    jobId,
    generatedAt: new Date().toISOString(),
    summary: {
      pagesAnalyzed: pages.length,
      colorSystemConfidence,
      typographySystemConfidence,
      layoutClassificationConfidence,
      componentDetectionConfidence,
      navigationAnalysisConfidence,
      responsiveAnalysisConfidence,
      overallConfidence,
    },
    perPage,
    systemDescription,
    warnings,
  };
}

// ── R2 JSON upload ─────────────────────────────────────────────────────────────

async function uploadJsonToR2(data: unknown, key: string): Promise<string | null> {
  const accessKeyId     = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint        = process.env.R2_ENDPOINT;
  const bucket          = process.env.R2_BUCKET_NAME;
  const publicBase      = process.env.R2_PUBLIC_BASE_URL ?? "";

  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) return null;

  try {
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
    const body = Buffer.from(JSON.stringify(data, null, 2), "utf-8");
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json" }));
    return publicBase ? `${publicBase.replace(/\/$/, "")}/${key}` : key;
  } catch (err) {
    logger.warn({ key, err }, "VISUAL_DNA: R2 JSON upload failed");
    return null;
  }
}

// ── Main entry point ───────────────────────────────────────────────────────────

export async function runVisualDna(
  jobId: string,
  manifest: Manifest
): Promise<VisualDnaAudit> {
  const startMs = Date.now();

  const eligibleNodes = [...manifest.nodes.values()].filter(
    n => n.status === "complete" && n.content?.cleanHtml && n.content.cleanHtml.length > 100
  );

  if (eligibleNodes.length === 0) {
    return { pagesAnalyzed: 0, pagesSkipped: 0, overallConfidence: 0, r2Uploads: 0, r2Failures: 0, durationMs: Date.now() - startMs };
  }

  logger.info({ jobId, eligible: eligibleNodes.length }, "VISUAL_DNA: starting analysis");

  // Analyse all pages
  const analyzed: PageDna[] = [];
  let skipped = 0;
  for (const node of eligibleNodes) {
    const result = analysePage(node);
    if (result) analyzed.push(result);
    else skipped++;
  }

  if (analyzed.length === 0) {
    logger.warn({ jobId }, "VISUAL_DNA: no pages produced usable analysis");
    return { pagesAnalyzed: 0, pagesSkipped: skipped, overallConfidence: 0, r2Uploads: 0, r2Failures: 0, durationMs: Date.now() - startMs };
  }

  const aggregate     = aggregateResults(analyzed);
  const visualDna     = { jobId, generatedAt: new Date().toISOString(), pages: Object.fromEntries(analyzed.map(p => [p.nodeId, p])), aggregate };
  const layoutMap     = buildLayoutMap(jobId, analyzed);
  const componentMap  = buildComponentMap(jobId, analyzed);
  const designTokens  = buildDesignTokens(jobId, analyzed, aggregate);
  const report        = buildReport(jobId, analyzed, aggregate);

  // Upload all files to R2 in parallel
  const uploads = await Promise.all([
    uploadJsonToR2(visualDna,    `jobs/${jobId}/_visual-dna.json`),
    uploadJsonToR2(layoutMap,    `jobs/${jobId}/_layout-map.json`),
    uploadJsonToR2(componentMap, `jobs/${jobId}/_component-map.json`),
    uploadJsonToR2(designTokens, `jobs/${jobId}/_design-tokens.json`),
    uploadJsonToR2(report,       `jobs/${jobId}/visual-analysis-report.json`),
  ]);

  const r2Uploads  = uploads.filter(Boolean).length;
  const r2Failures = uploads.filter(u => u === null).length;

  const overallConfidence = report.summary.overallConfidence;

  logger.info(
    { jobId, pagesAnalyzed: analyzed.length, skipped, r2Uploads, r2Failures, overallConfidence },
    "VISUAL_DNA: complete"
  );

  return {
    pagesAnalyzed: analyzed.length,
    pagesSkipped: skipped,
    overallConfidence,
    r2Uploads,
    r2Failures,
    durationMs: Date.now() - startMs,
  };
}
