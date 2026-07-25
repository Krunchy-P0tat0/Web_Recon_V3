/**
 * extractor.ts — Visual Extraction Engine (Phase 4.2)
 *
 * Derives a complete DesignDNA from scraped page HTML.
 *
 * Design rules:
 *   - Pure and synchronous — no I/O, no external calls
 *   - Deterministic — same pages always produce the same DesignDNA
 *   - Defensive — always produces a valid DesignDNA even from empty input
 *   - Signal-based — reads class names, inline styles, tag counts, text patterns
 *
 * Pipeline:
 *   ExtractionInput (pages of HTML)
 *     → aggregateSignals()
 *       → derive{Typography,Colors,Spacing,Borders,Navigation,Hero,Cards,Gallery,Layout}()
 *         → DesignDNA
 */

import { createHash } from "crypto";
import type {
  DesignDNA,
  TypographyDNA,
  ColorDNA,
  SpacingDNA,
  BorderDNA,
  NavigationDNA,
  HeroDNA,
  CardDNA,
  GalleryDNA,
  LayoutDNA,
  ColorScale,
  SemanticColorMap,
  FontEntry,
  TypeScaleStep,
  SpacingScale,
  RadiusTokens,
  ShadowTokens,
  GridSystem,
  FontClass,
  TypeScale,
  SpacingDensity,
  NavPosition,
  NavBackground,
  HeroLayout,
  CtaStyle,
  CardLayout,
  CardImagePosition,
  CardHoverEffect,
  GalleryLayout,
  HeroHeight,
  SectionSpacing,
  LayoutStrategy,
  SectionDivider,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Public input types
// ─────────────────────────────────────────────────────────────────────────────

/** One scraped page, as provided by the manifest worker. */
export interface PageInput {
  url: string;
  /** PageNode.content.cleanHtml */
  html: string;
  /** PageNode.nodeType — "root" | "index" | "article" | "pagination" | "asset" */
  nodeType: string;
  /** PageNode.metadata.title */
  title?: string | null;
  /** PageNode.media.images.length */
  imageCount?: number;
}

/** Full input to the extraction engine. */
export interface ExtractionInput {
  /** Seed URL of the crawl job. */
  url: string;
  /** Scrape job ID — included in the DNA meta block. */
  jobId: string;
  /** All scraped pages from the manifest. */
  pages: PageInput[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal evidence (consumed by audit.ts)
// ─────────────────────────────────────────────────────────────────────────────

export interface SignalEvidence {
  field: string;
  confidence: "high" | "medium" | "low" | "default";
  signal: string;
  resolvedValue: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page weight table — root/index pages carry more structural signal
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_WEIGHT: Record<string, number> = {
  root:       4,
  index:      3,
  pagination: 1,
  article:    1,
  asset:      0,
};

function weight(nodeType: string): number {
  return PAGE_WEIGHT[nodeType] ?? 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Low-level HTML signal utilities
// ─────────────────────────────────────────────────────────────────────────────

function extractClasses(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/\bclass="([^"]+)"/g)) {
    out.push(...m[1].split(/\s+/).filter(Boolean));
  }
  return out;
}

function extractStyleValues(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/\bstyle="([^"]+)"/g)) {
    out.push(m[1]);
  }
  return out;
}

function countTag(html: string, tag: string): number {
  return (html.match(new RegExp(`<${tag}[\\s>/]`, "gi")) ?? []).length;
}

function hasTag(html: string, tag: string): boolean {
  return new RegExp(`<${tag}[\\s>/]`, "i").test(html);
}

function hasAnyClass(classes: string[], targets: string[]): boolean {
  const set = new Set(classes);
  return targets.some((t) => set.has(t));
}

function hasClassPrefix(classes: string[], prefix: string): boolean {
  return classes.some((c) => c.startsWith(prefix));
}

function findClass(classes: string[], re: RegExp): string | null {
  return classes.find((c) => re.test(c)) ?? null;
}

function extractHexColors(styles: string[]): string[] {
  const out: string[] = [];
  const re = /#([0-9a-f]{3}|[0-9a-f]{6})\b/gi;
  for (const s of styles) {
    for (const m of s.matchAll(re)) {
      out.push(m[0].toLowerCase());
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal aggregation
// ─────────────────────────────────────────────────────────────────────────────

interface AggregatedSignals {
  allClasses: string[];
  allStyles: string[];
  /** HTML of root/index pages only — used for structural analysis. */
  rootHtml: string;
  /** HTML of all pages concatenated — used for frequency analysis. */
  allHtml: string;
  tagCounts: {
    nav: number;
    header: number;
    footer: number;
    aside: number;
    article: number;
    section: number;
    figure: number;
    h1: number;
    h2: number;
    h3: number;
    li: number;
    ul: number;
  };
  totalImages: number;
  pageCount: number;
  hexColors: string[];
}

function aggregateSignals(pages: PageInput[]): AggregatedSignals {
  // Deterministic ordering: weight desc, then URL asc
  const sorted = [...pages].sort((a, b) => {
    const d = weight(b.nodeType) - weight(a.nodeType);
    return d !== 0 ? d : a.url.localeCompare(b.url);
  });

  const allClasses: string[] = [];
  const allStyles: string[] = [];
  const allHtmlParts: string[] = [];
  const rootHtmlParts: string[] = [];
  let totalImages = 0;

  for (const page of sorted) {
    const w = weight(page.nodeType);
    if (w === 0 || !page.html) continue;
    allClasses.push(...extractClasses(page.html));
    allStyles.push(...extractStyleValues(page.html));
    allHtmlParts.push(page.html);
    totalImages += page.imageCount ?? 0;
    if (w >= 3) rootHtmlParts.push(page.html);
  }

  const allHtml  = allHtmlParts.join("\n");
  const rootHtml = rootHtmlParts.join("\n") || allHtml;

  return {
    allClasses,
    allStyles,
    rootHtml,
    allHtml,
    tagCounts: {
      nav:     countTag(rootHtml, "nav"),
      header:  countTag(rootHtml, "header"),
      footer:  countTag(rootHtml, "footer"),
      aside:   countTag(allHtml,  "aside"),
      article: countTag(allHtml,  "article"),
      section: countTag(rootHtml, "section"),
      figure:  countTag(allHtml,  "figure"),
      h1:      countTag(allHtml,  "h1"),
      h2:      countTag(allHtml,  "h2"),
      h3:      countTag(allHtml,  "h3"),
      li:      countTag(allHtml,  "li"),
      ul:      countTag(allHtml,  "ul"),
    },
    totalImages,
    pageCount: sorted.filter((p) => weight(p.nodeType) > 0).length,
    hexColors: extractHexColors(allStyles),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Default palettes
// ─────────────────────────────────────────────────────────────────────────────

const BLUE: ColorScale   = { 50:"#eff6ff",100:"#dbeafe",200:"#bfdbfe",300:"#93c5fd",400:"#60a5fa",500:"#3b82f6",600:"#2563eb",700:"#1d4ed8",800:"#1e40af",900:"#1e3a8a",950:"#172554" };
const GRAY: ColorScale   = { 50:"#f9fafb",100:"#f3f4f6",200:"#e5e7eb",300:"#d1d5db",400:"#9ca3af",500:"#6b7280",600:"#4b5563",700:"#374151",800:"#1f2937",900:"#111827",950:"#030712" };
const INDIGO: ColorScale = { 50:"#eef2ff",100:"#e0e7ff",200:"#c7d2fe",300:"#a5b4fc",400:"#818cf8",500:"#6366f1",600:"#4f46e5",700:"#4338ca",800:"#3730a3",900:"#312e81",950:"#1e1b4b" };
const EMERALD: ColorScale= { 50:"#ecfdf5",100:"#d1fae5",200:"#a7f3d0",300:"#6ee7b7",400:"#34d399",500:"#10b981",600:"#059669",700:"#047857",800:"#065f46",900:"#064e3b",950:"#022c22" };
const ROSE: ColorScale   = { 50:"#fff1f2",100:"#ffe4e6",200:"#fecdd3",300:"#fda4af",400:"#fb7185",500:"#f43f5e",600:"#e11d48",700:"#be123c",800:"#9f1239",900:"#881337",950:"#4c0519" };
const AMBER: ColorScale  = { 50:"#fffbeb",100:"#fef3c7",200:"#fde68a",300:"#fcd34d",400:"#fbbf24",500:"#f59e0b",600:"#d97706",700:"#b45309",800:"#92400e",900:"#78350f",950:"#451a03" };
const VIOLET: ColorScale = { 50:"#f5f3ff",100:"#ede9fe",200:"#ddd6fe",300:"#c4b5fd",400:"#a78bfa",500:"#8b5cf6",600:"#7c3aed",700:"#6d28d9",800:"#5b21b6",900:"#4c1d95",950:"#2e1065" };
const TEAL: ColorScale   = { 50:"#f0fdfa",100:"#ccfbf1",200:"#99f6e4",300:"#5eead4",400:"#2dd4bf",500:"#14b8a6",600:"#0d9488",700:"#0f766e",800:"#115e59",900:"#134e4a",950:"#042f2e" };

const TAILWIND_PALETTES: Record<string, ColorScale> = {
  blue: BLUE, indigo: INDIGO, emerald: EMERALD, rose: ROSE,
  amber: AMBER, violet: VIOLET, teal: TEAL, green: EMERALD, red: ROSE,
  purple: VIOLET, sky: BLUE, cyan: TEAL,
};

const NEUTRAL_NAMES = new Set(["gray", "slate", "zinc", "stone", "neutral"]);

function detectPrimaryPalette(classes: string[]): { scale: ColorScale; name: string } {
  const counts: Record<string, number> = {};
  for (const cls of classes) {
    const m = cls.match(/^(?:bg|text|border|ring|from|to|via)-([a-z]+)-(\d{2,3})$/);
    if (m && !NEUTRAL_NAMES.has(m[1])) {
      counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    }
  }
  let best = "blue";
  let bestN = 0;
  for (const [name, n] of Object.entries(counts)) {
    if (n > bestN && name in TAILWIND_PALETTES) { best = name; bestN = n; }
  }
  return { scale: TAILWIND_PALETTES[best] ?? BLUE, name: best };
}

const DEFAULT_SEMANTIC: SemanticColorMap = {
  background:"#ffffff", surface:"#f9fafb", surfaceAlt:"#f3f4f6",
  border:"#e5e7eb", borderStrong:"#d1d5db",
  textPrimary:"#111827", textSecondary:"#374151", textMuted:"#6b7280", textInverse:"#ffffff",
  link:"#2563eb", linkHover:"#1d4ed8",
  success:"#10b981", warning:"#f59e0b", error:"#ef4444", info:"#3b82f6",
};

const DEFAULT_DARK_SEMANTIC: SemanticColorMap = {
  background:"#111827", surface:"#1f2937", surfaceAlt:"#374151",
  border:"#374151", borderStrong:"#4b5563",
  textPrimary:"#f9fafb", textSecondary:"#e5e7eb", textMuted:"#9ca3af", textInverse:"#111827",
  link:"#60a5fa", linkHover:"#93c5fd",
  success:"#34d399", warning:"#fbbf24", error:"#f87171", info:"#60a5fa",
};

// ─────────────────────────────────────────────────────────────────────────────
// Typography defaults
// ─────────────────────────────────────────────────────────────────────────────

function makeFontEntry(family: string, fontClass: FontClass, weights = [400, 500, 700]): FontEntry {
  const isSerif = fontClass.includes("serif");
  const isMono  = fontClass === "mono";
  const fallback = isMono ? "monospace" : isSerif ? "Georgia, serif" : "system-ui, sans-serif";
  const GOOGLE_FONTS = new Set([
    "Inter","Roboto","Open Sans","Lato","Montserrat","Source Sans Pro","Nunito","DM Sans",
    "Poppins","Raleway","Work Sans","Figtree","Plus Jakarta Sans",
    "Playfair Display","Merriweather","Lora","EB Garamond","PT Serif","Libre Baskerville",
    "JetBrains Mono","Fira Code","Source Code Pro","Inconsolata",
  ]);
  return {
    family,
    fallback,
    googleFontUrl: GOOGLE_FONTS.has(family)
      ? `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weights.join(";")}&display=swap`
      : null,
    fontClass,
    weights,
    styles: ["normal"],
  };
}

const DEFAULT_SCALE_STEPS: TypeScaleStep[] = [
  { name:"xs",   size:"0.75rem",  lineHeight:"1rem",    letterSpacing:"0em",     fontWeight:400, useCase:"caption"        },
  { name:"sm",   size:"0.875rem", lineHeight:"1.25rem", letterSpacing:"0em",     fontWeight:400, useCase:"small text"     },
  { name:"base", size:"1rem",     lineHeight:"1.5rem",  letterSpacing:"0em",     fontWeight:400, useCase:"body copy"      },
  { name:"lg",   size:"1.125rem", lineHeight:"1.75rem", letterSpacing:"-0.01em", fontWeight:500, useCase:"lead paragraph" },
  { name:"xl",   size:"1.25rem",  lineHeight:"1.75rem", letterSpacing:"-0.01em", fontWeight:600, useCase:"H4"             },
  { name:"2xl",  size:"1.5rem",   lineHeight:"2rem",    letterSpacing:"-0.02em", fontWeight:700, useCase:"H3"             },
  { name:"3xl",  size:"1.875rem", lineHeight:"2.25rem", letterSpacing:"-0.02em", fontWeight:700, useCase:"H2"             },
  { name:"4xl",  size:"2.25rem",  lineHeight:"2.5rem",  letterSpacing:"-0.03em", fontWeight:700, useCase:"H1"             },
  { name:"5xl",  size:"3rem",     lineHeight:"1",       letterSpacing:"-0.04em", fontWeight:800, useCase:"display"        },
];

// ─────────────────────────────────────────────────────────────────────────────
// Spacing defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SPACING_SCALE: SpacingScale = {
  px:"1px","0.5":"0.125rem","1":"0.25rem","2":"0.5rem","3":"0.75rem",
  "4":"1rem","5":"1.25rem","6":"1.5rem","8":"2rem","10":"2.5rem",
  "12":"3rem","16":"4rem","20":"5rem","24":"6rem","32":"8rem",
  "40":"10rem","48":"12rem","64":"16rem",
};

// ─────────────────────────────────────────────────────────────────────────────
// Border/shadow defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_RADIUS: RadiusTokens = {
  none:"0", sm:"0.125rem", md:"0.375rem", lg:"0.5rem",
  xl:"0.75rem", "2xl":"1rem", full:"9999px",
};

const DEFAULT_SHADOWS: ShadowTokens = {
  none:"none",
  sm:"0 1px 2px 0 rgb(0 0 0/0.05)",
  md:"0 4px 6px -1px rgb(0 0 0/0.1),0 2px 4px -2px rgb(0 0 0/0.1)",
  lg:"0 10px 15px -3px rgb(0 0 0/0.1),0 4px 6px -4px rgb(0 0 0/0.1)",
  xl:"0 20px 25px -5px rgb(0 0 0/0.1),0 8px 10px -6px rgb(0 0 0/0.1)",
  inner:"inset 0 2px 4px 0 rgb(0 0 0/0.05)",
};

// ─────────────────────────────────────────────────────────────────────────────
// Color utility
// ─────────────────────────────────────────────────────────────────────────────

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6) return { h: 0, s: 0, l: 0 };
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let s = 0, hDeg = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: hDeg = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: hDeg = ((b - r) / d + 2) / 6; break;
      case b: hDeg = ((r - g) / d + 4) / 6; break;
    }
  }
  return { h: Math.round(hDeg * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-derivers
// ─────────────────────────────────────────────────────────────────────────────

type Derived<T> = { value: T; evidence: SignalEvidence[] };

function deriveTypography(sig: AggregatedSignals): Derived<TypographyDNA> {
  const ev: SignalEvidence[] = [];
  const classes = sig.allClasses;

  // ── Font family ──────────────────────────────────────────────────────────
  let headingFamily = "Inter";
  let headingClass: FontClass = "modern-sans";
  let bodyFamily = "Inter";
  let bodyClass: FontClass = "modern-sans";

  // Inline font-family check
  const familyMatch = sig.allStyles.join(" ").match(/font-family\s*:\s*['"]?([A-Za-z\s\-]+?)['"]?(?:,|;|$)/i);
  if (familyMatch) {
    const detected = familyMatch[1].trim();
    headingFamily = detected;
    bodyFamily = detected;
    const isSerif = /serif|georgia|times|garamond|playfair|merriweather|lora/i.test(detected);
    headingClass = isSerif ? "elegant-serif" : "modern-sans";
    bodyClass    = isSerif ? "readable-serif" : "modern-sans";
    ev.push({ field:"typography.heading.family", confidence:"high", signal:`font-family: ${detected} in inline style`, resolvedValue: detected });
  } else if (hasAnyClass(classes, ["font-serif"])) {
    headingFamily = "Playfair Display";
    headingClass  = "elegant-serif";
    bodyFamily    = "Lora";
    bodyClass     = "readable-serif";
    ev.push({ field:"typography.heading.fontClass", confidence:"medium", signal:"font-serif Tailwind class", resolvedValue:"elegant-serif" });
  } else if (hasAnyClass(classes, ["font-mono"])) {
    headingFamily = "JetBrains Mono";
    headingClass  = "mono";
    bodyFamily    = "JetBrains Mono";
    bodyClass     = "mono";
    ev.push({ field:"typography.heading.fontClass", confidence:"medium", signal:"font-mono Tailwind class", resolvedValue:"mono" });
  } else {
    // Try to detect named fonts from class names like "font-inter", "font-poppins"
    const named = findClass(classes, /^font-([a-z-]+)$/);
    if (named) {
      const fam = named.replace("font-", "").split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      headingFamily = fam;
      bodyFamily    = fam;
      ev.push({ field:"typography.heading.family", confidence:"low", signal:`${named} font class`, resolvedValue: fam });
    } else {
      ev.push({ field:"typography.heading.family", confidence:"default", signal:"no font signal detected", resolvedValue:"Inter" });
    }
  }

  // ── Type scale ───────────────────────────────────────────────────────────
  const xl2Plus = classes.filter((c) => /^text-[2-9]xl$/.test(c)).length;
  const xlMd    = classes.filter((c) => /^text-(?:xl|lg)$/.test(c)).length;

  let scale: TypeScale = "default";
  if (xl2Plus > 8) {
    scale = "editorial";
    ev.push({ field:"typography.scale", confidence:"medium", signal:`${xl2Plus} text-2xl+ classes`, resolvedValue:"editorial" });
  } else if (xlMd > 5) {
    scale = "generous";
    ev.push({ field:"typography.scale", confidence:"low",    signal:`${xlMd} text-lg/xl classes`, resolvedValue:"generous" });
  } else if (classes.some((c) => /^text-xs$/.test(c)) && xl2Plus === 0) {
    scale = "compact";
    ev.push({ field:"typography.scale", confidence:"low",    signal:"text-xs classes dominant", resolvedValue:"compact" });
  } else {
    ev.push({ field:"typography.scale", confidence:"default", signal:"no strong scale signal",    resolvedValue:"default" });
  }

  const isSerif = headingClass.includes("serif");
  return {
    value: {
      heading:          makeFontEntry(headingFamily, headingClass),
      body:             makeFontEntry(bodyFamily, bodyClass),
      display:          makeFontEntry(headingFamily, headingClass, [700, 800, 900]),
      mono:             makeFontEntry("JetBrains Mono", "mono", [400, 500]),
      scale,
      scaleSteps:       DEFAULT_SCALE_STEPS,
      baseFontSize:     "16px",
      baseLineHeight:   "1.5",
      paragraphSpacing: "1em",
      headingTracking:  isSerif ? "-0.01em" : "-0.02em",
    },
    evidence: ev,
  };
}

function deriveColors(sig: AggregatedSignals): Derived<ColorDNA> {
  const ev: SignalEvidence[] = [];
  const { scale: primary, name: primaryName } = detectPrimaryPalette(sig.allClasses);
  const detected = sig.allClasses.some((c) => /^(?:bg|text|border)-[a-z]+-\d{2,3}$/.test(c));

  ev.push({
    field: "colors.primary",
    confidence: detected ? "medium" : "default",
    signal: detected ? `Tailwind ${primaryName}-* class frequency` : "no Tailwind color classes",
    resolvedValue: primaryName,
  });

  // Dark mode
  const hasDarkMode = /\bdark:/i.test(sig.allClasses.join(" "));
  ev.push({ field:"colors.darkMode", confidence: hasDarkMode ? "medium" : "default", signal: hasDarkMode ? "dark: prefix found" : "no dark classes", resolvedValue: hasDarkMode ? "standard-dark" : "default" });

  // Swatches from inline hex colors (top 6 unique)
  const uniqueHex = [...new Set(sig.hexColors)].slice(0, 6);
  const swatches = uniqueHex.map((hex, i) => ({
    hex,
    hsl:   hexToHsl(hex),
    label: `swatch-${i + 1}`,
    role:  (i === 0 ? "accent" : "surface") as "accent" | "surface",
  }));

  if (uniqueHex.length > 0) {
    ev.push({ field:"colors.swatches", confidence:"medium", signal:`${uniqueHex.length} unique hex colors in inline styles`, resolvedValue: uniqueHex.join(", ") });
  }

  return {
    value: {
      primary,
      secondary: GRAY,
      accent:    primary === INDIGO ? VIOLET : INDIGO,
      neutral:   GRAY,
      semantic:  DEFAULT_SEMANTIC,
      darkMode:  DEFAULT_DARK_SEMANTIC,
      swatches,
      derivationMethod: "site-type-profile",
    },
    evidence: ev,
  };
}

function deriveSpacing(sig: AggregatedSignals): Derived<SpacingDNA> {
  const ev: SignalEvidence[] = [];
  const classes = sig.allClasses;

  // Density from padding/margin class distribution
  const tightCls = classes.filter((c) => /^(?:p|px|py|m|mx|my)-[012]$/.test(c)).length;
  const spaceCls = classes.filter((c) => /^(?:p|px|py|m|mx|my)-(?:1[268]|20|24|32)$/.test(c)).length;

  let density: SpacingDensity = "default";
  if (tightCls > spaceCls * 2.5) {
    density = "compact";
    ev.push({ field:"spacing.density", confidence:"medium", signal:`${tightCls} tight padding classes vs ${spaceCls} loose`, resolvedValue:"compact" });
  } else if (spaceCls > tightCls * 2.5) {
    density = "comfortable";
    ev.push({ field:"spacing.density", confidence:"medium", signal:`${spaceCls} spacious padding classes`, resolvedValue:"comfortable" });
  } else {
    ev.push({ field:"spacing.density", confidence:"default", signal:"balanced padding distribution", resolvedValue:"default" });
  }

  // Container max-width
  const MW_MAP: Array<[string[], string]> = [
    [["max-w-screen-2xl","max-w-8xl"],  "1536px"],
    [["max-w-7xl"],                      "1280px"],
    [["max-w-6xl"],                      "1152px"],
    [["max-w-5xl"],                      "1024px"],
    [["max-w-4xl"],                      "896px" ],
    [["max-w-3xl"],                      "768px" ],
    [["container"],                      "1200px"],
  ];
  let containerMaxWidth = "1280px";
  let mwFound = false;
  for (const [targets, w] of MW_MAP) {
    if (hasAnyClass(classes, targets)) {
      containerMaxWidth = w;
      mwFound = true;
      ev.push({ field:"spacing.containerMaxWidth", confidence:"high", signal: targets[0], resolvedValue: w });
      break;
    }
  }
  if (!mwFound) ev.push({ field:"spacing.containerMaxWidth", confidence:"default", signal:"no max-w class", resolvedValue:"1280px" });

  // Grid gap
  let gridGap = "1.5rem";
  const gapMatch = findClass(classes, /^gap-(\d+)$/);
  if (gapMatch) {
    const n = parseInt(gapMatch.slice(4), 10);
    gridGap = `${n * 0.25}rem`;
    ev.push({ field:"spacing.gridGap", confidence:"high", signal: gapMatch, resolvedValue: gridGap });
  }

  return {
    value: {
      density,
      scale: DEFAULT_SPACING_SCALE,
      containerMaxWidth,
      contentMaxWidth: "768px",
      sectionVerticalPadding: density === "compact" ? "2rem" : density === "comfortable" ? "6rem" : "4rem",
      cardPadding: density === "compact" ? "1rem" : "1.5rem",
      gridGap,
    },
    evidence: ev,
  };
}

function deriveBorders(sig: AggregatedSignals): Derived<BorderDNA> {
  const ev: SignalEvidence[] = [];
  const classes = sig.allClasses;

  // Border radius
  let cardBorderRadius = "0.5rem";
  let buttonBorderRadius = "0.375rem";

  if (hasAnyClass(classes, ["rounded-none"])) {
    cardBorderRadius = "0"; buttonBorderRadius = "0";
    ev.push({ field:"borders.cardBorderRadius", confidence:"high", signal:"rounded-none", resolvedValue:"0" });
  } else if (hasAnyClass(classes, ["rounded-2xl","rounded-3xl"])) {
    cardBorderRadius = "1rem"; buttonBorderRadius = "0.75rem";
    ev.push({ field:"borders.cardBorderRadius", confidence:"high", signal:"rounded-2xl/3xl", resolvedValue:"1rem" });
  } else if (hasAnyClass(classes, ["rounded-xl"])) {
    cardBorderRadius = "0.75rem"; buttonBorderRadius = "0.75rem";
    ev.push({ field:"borders.cardBorderRadius", confidence:"high", signal:"rounded-xl", resolvedValue:"0.75rem" });
  } else if (hasAnyClass(classes, ["rounded-full"])) {
    buttonBorderRadius = "9999px";
    ev.push({ field:"borders.buttonBorderRadius", confidence:"high", signal:"rounded-full", resolvedValue:"9999px" });
  } else if (hasAnyClass(classes, ["rounded","rounded-md","rounded-lg"])) {
    ev.push({ field:"borders.cardBorderRadius", confidence:"medium", signal:"rounded/md/lg", resolvedValue:"0.5rem" });
  } else {
    ev.push({ field:"borders.cardBorderRadius", confidence:"default", signal:"no radius class", resolvedValue:"0.5rem" });
  }

  // Shadow
  let cardShadow: BorderDNA["cardShadow"] = "subtle";
  if (hasAnyClass(classes, ["shadow-none"])) {
    cardShadow = "none";
    ev.push({ field:"borders.cardShadow", confidence:"high", signal:"shadow-none", resolvedValue:"none" });
  } else if (hasAnyClass(classes, ["shadow-2xl","shadow-xl"])) {
    cardShadow = "strong";
    ev.push({ field:"borders.cardShadow", confidence:"high", signal:"shadow-xl/2xl", resolvedValue:"strong" });
  } else if (hasAnyClass(classes, ["shadow-lg","shadow-md","shadow"])) {
    cardShadow = "medium";
    ev.push({ field:"borders.cardShadow", confidence:"medium", signal:"shadow/md/lg", resolvedValue:"medium" });
  } else {
    ev.push({ field:"borders.cardShadow", confidence:"default", signal:"no shadow class", resolvedValue:"subtle" });
  }

  const cardBorder = hasAnyClass(classes, ["border","border-gray-200","border-slate-200","divide-y","ring-1","ring-gray-200"]);
  ev.push({ field:"borders.cardBorder", confidence: cardBorder ? "medium" : "default", signal: cardBorder ? "border/ring class" : "no border class", resolvedValue: String(cardBorder) });

  return {
    value: {
      radius: DEFAULT_RADIUS,
      shadows: DEFAULT_SHADOWS,
      cardBorderRadius,
      imageBorderRadius: cardBorderRadius,
      buttonBorderRadius,
      cardShadow,
      cardBorder,
    },
    evidence: ev,
  };
}

function deriveNavigation(sig: AggregatedSignals): Derived<NavigationDNA> {
  const ev: SignalEvidence[] = [];
  const classes = sig.allClasses;
  const rootHtml = sig.rootHtml;

  const hasNav = sig.tagCounts.nav > 0 || sig.tagCounts.header > 0;
  ev.push({ field:"navigation.exists", confidence: hasNav ? "high" : "default", signal: hasNav ? "<nav>/<header> found" : "no nav/header tags", resolvedValue: String(hasNav) });

  // Position
  let position: NavPosition = "sticky";
  if (hasAnyClass(classes, ["fixed"]) && hasTag(rootHtml, "nav")) {
    position = "fixed";
    ev.push({ field:"navigation.position", confidence:"medium", signal:"fixed + nav tag", resolvedValue:"fixed" });
  } else if (hasAnyClass(classes, ["sticky"])) {
    ev.push({ field:"navigation.position", confidence:"medium", signal:"sticky class", resolvedValue:"sticky" });
  } else {
    ev.push({ field:"navigation.position", confidence:"default", signal:"no positioning signal", resolvedValue:"sticky" });
  }

  // Background
  let background: NavBackground = "solid";
  if (hasAnyClass(classes, ["backdrop-blur","backdrop-blur-sm","backdrop-blur-md","backdrop-blur-lg"])) {
    background = "blur";
    ev.push({ field:"navigation.background", confidence:"high", signal:"backdrop-blur class", resolvedValue:"blur" });
  } else if (hasAnyClass(classes, ["bg-transparent","bg-white/0","bg-black/0"])) {
    background = "transparent";
    ev.push({ field:"navigation.background", confidence:"high", signal:"bg-transparent", resolvedValue:"transparent" });
  } else {
    ev.push({ field:"navigation.background", confidence:"default", signal:"no transparency signal", resolvedValue:"solid" });
  }

  const hasHamburger = /hamburger|burger|menu.toggle|nav.toggle|menu-icon/i.test(rootHtml)
    || hasAnyClass(classes, ["lg:hidden","md:hidden"]) && sig.tagCounts.nav > 0;

  const hasSearch = /type="search"|role="search"|placeholder="[Ss]earch/i.test(rootHtml)
    || hasAnyClass(classes, ["search-input","search-box","search-form"]);

  const hasCta = hasAnyClass(classes, ["btn-primary","btn-cta","cta-button"])
    || (/sign.?up|get.started|try.for.free|subscribe/i.test(rootHtml) && sig.tagCounts.nav > 0);

  const isCenter = hasAnyClass(classes, ["justify-center","mx-auto"]) && sig.tagCounts.nav > 0;

  return {
    value: {
      position,
      background,
      height: "64px",
      logoPosition: isCenter ? "center" : "left",
      mobileStyle: hasHamburger ? "hamburger" : "hamburger",
      hasSearch,
      hasCta,
      isTransparentOnHero: background === "transparent",
    },
    evidence: ev,
  };
}

function deriveHero(sig: AggregatedSignals): Derived<HeroDNA> {
  const ev: SignalEvidence[] = [];
  const classes = sig.allClasses;
  const rootHtml = sig.rootHtml;

  // Layout
  let layout: HeroLayout = "text-centered";
  const hasBgImage = /background-image\s*:/i.test(sig.allStyles.join(" "))
    || hasAnyClass(classes, ["bg-cover","bg-center","bg-no-repeat","object-cover"]);
  const hasVideo = hasTag(rootHtml, "video") || /video.background|video-hero/i.test(rootHtml);
  const hasCarousel = /carousel|slider|swiper|splide|glide|slick/i.test(rootHtml);
  const hasSplit = hasAnyClass(classes, ["grid-cols-2","md:grid-cols-2","lg:grid-cols-2","lg:flex-row","md:flex-row"]);

  if (hasVideo) {
    layout = "video-background";
    ev.push({ field:"hero.layout", confidence:"high", signal:"video element in hero area", resolvedValue:"video-background" });
  } else if (hasCarousel) {
    layout = "carousel";
    ev.push({ field:"hero.layout", confidence:"high", signal:"carousel/slider pattern", resolvedValue:"carousel" });
  } else if (hasBgImage) {
    layout = "full-bleed-image";
    ev.push({ field:"hero.layout", confidence:"high", signal:"bg-cover or background-image style", resolvedValue:"full-bleed-image" });
  } else if (hasSplit) {
    layout = "split-content-image";
    ev.push({ field:"hero.layout", confidence:"medium", signal:"2-column grid in root section", resolvedValue:"split-content-image" });
  } else {
    const hasCentered = hasAnyClass(classes, ["text-center","items-center","justify-center"]);
    layout = hasCentered ? "text-centered" : "text-left";
    ev.push({ field:"hero.layout", confidence:"low", signal: hasCentered ? "text-center class" : "no centering", resolvedValue: layout });
  }

  // Overlay
  const hasOverlay = hasAnyClass(classes, ["bg-black/40","bg-black/50","bg-black/60","bg-black/70","overlay"])
    || /rgba\(0,\s*0,\s*0,\s*0\.[3-9]/i.test(sig.allStyles.join(" "));
  const overlayOpacity = hasOverlay ? 0.5 : 0;

  // Min height
  let minHeight = "60vh";
  if (hasAnyClass(classes, ["min-h-screen","h-screen"])) {
    minHeight = "100vh";
    ev.push({ field:"hero.minHeight", confidence:"high", signal:"min-h-screen / h-screen", resolvedValue:"100vh" });
  } else if (hasAnyClass(classes, ["min-h-\\[80vh\\]","min-h-\\[75vh\\]"])) {
    minHeight = "80vh";
    ev.push({ field:"hero.minHeight", confidence:"high", signal:"min-h-[80vh]", resolvedValue:"80vh" });
  } else {
    ev.push({ field:"hero.minHeight", confidence:"default", signal:"no viewport height class", resolvedValue:"60vh" });
  }

  // CTA style
  let ctaStyle: CtaStyle = "filled";
  if (hasAnyClass(classes, ["btn-outline","border-2","border-white","ring-2"])) {
    ctaStyle = "outlined";
    ev.push({ field:"hero.ctaStyle", confidence:"medium", signal:"outline button pattern", resolvedValue:"outlined" });
  } else {
    ev.push({ field:"hero.ctaStyle", confidence:"default", signal:"filled CTA assumed", resolvedValue:"filled" });
  }

  const onDark = hasBgImage || hasVideo || hasOverlay;
  return {
    value: {
      layout,
      overlayOpacity,
      overlayColor: "#000000",
      textColor: onDark ? "#ffffff" : "#111827",
      minHeight,
      headlineSize: "3.75rem",
      ctaStyle,
      ctaBorderRadius: "0.375rem",
      hasSubheadline: sig.tagCounts.h2 > 0 || /subtitle|subheadline|lead|tagline/i.test(rootHtml),
      hasBackgroundMedia: hasBgImage || hasVideo,
    },
    evidence: ev,
  };
}

function deriveCards(sig: AggregatedSignals): Derived<CardDNA> {
  const ev: SignalEvidence[] = [];
  const classes = sig.allClasses;
  const allHtml = sig.allHtml;

  // Card layout
  let layout: CardLayout = "vertical";
  const hasHoriz = (hasAnyClass(classes, ["flex-row","md:flex-row","sm:flex-row"])
    && sig.tagCounts.article > 0) || hasAnyClass(classes, ["media","media-object"]);
  if (hasHoriz) {
    layout = "horizontal";
    ev.push({ field:"cards.layout", confidence:"medium", signal:"flex-row on article elements", resolvedValue:"horizontal" });
  } else if (hasAnyClass(classes, ["overlay","bg-gradient-to-t"]) && sig.totalImages > 3) {
    layout = "overlay";
    ev.push({ field:"cards.layout", confidence:"medium", signal:"overlay gradient + images", resolvedValue:"overlay" });
  } else {
    ev.push({ field:"cards.layout", confidence:"default", signal:"vertical card assumed", resolvedValue:"vertical" });
  }

  // Image position
  let imagePosition: CardImagePosition = "top";
  if (layout === "horizontal") {
    imagePosition = hasAnyClass(classes, ["order-last","flex-row-reverse"]) ? "right" : "left";
  } else if (layout === "overlay") {
    imagePosition = "background";
  }

  // Metadata shown
  const showDate     = /\bdate\b|\bdatetime\b|\bpublished\b|\bposted\b/i.test(allHtml);
  const showAuthor   = /\bauthor\b|\bby\s+[A-Z]|\bbyline\b/i.test(allHtml);
  const showCategory = /\bcategory\b|\btag\b|\blabel\b|\bbadge\b|\btopic\b/i.test(allHtml);
  const showReadTime = /\bmin read\b|\breading time\b|\bmin\. read\b/i.test(allHtml);

  ev.push({ field:"cards.showDate",     confidence: showDate     ? "high" : "low", signal: showDate     ? "date/datetime/published keyword" : "no date keyword", resolvedValue: String(showDate) });
  ev.push({ field:"cards.showAuthor",   confidence: showAuthor   ? "high" : "low", signal: showAuthor   ? "author/byline keyword" : "no author keyword",          resolvedValue: String(showAuthor) });
  ev.push({ field:"cards.showCategory", confidence: showCategory ? "high" : "low", signal: showCategory ? "category/tag/badge keyword" : "no category keyword",    resolvedValue: String(showCategory) });

  // Hover effect
  let hoverEffect: CardHoverEffect = "none";
  if (hasAnyClass(classes, ["hover:shadow-xl","hover:shadow-lg","hover:-translate-y-1","hover:-translate-y-2"])) {
    hoverEffect = "lift";
    ev.push({ field:"cards.hoverEffect", confidence:"high", signal:"hover:shadow-lg/xl or translate-y", resolvedValue:"lift" });
  } else if (hasAnyClass(classes, ["hover:scale-105","hover:scale-110","group-hover:scale-105"])) {
    hoverEffect = "scale";
    ev.push({ field:"cards.hoverEffect", confidence:"high", signal:"hover:scale-105/110", resolvedValue:"scale" });
  } else if (hasAnyClass(classes, ["hover:border-","hover:ring-"])) {
    hoverEffect = "border-accent";
    ev.push({ field:"cards.hoverEffect", confidence:"medium", signal:"hover:border or hover:ring class", resolvedValue:"border-accent" });
  }

  // Image aspect ratio
  let imageAspectRatio: CardDNA["imageAspectRatio"] = "16:9";
  if (hasAnyClass(classes, ["aspect-square","aspect-[1/1]"])) {
    imageAspectRatio = "1:1";
    ev.push({ field:"cards.imageAspectRatio", confidence:"high", signal:"aspect-square", resolvedValue:"1:1" });
  } else if (hasAnyClass(classes, ["aspect-video","aspect-[16/9]"])) {
    ev.push({ field:"cards.imageAspectRatio", confidence:"high", signal:"aspect-video", resolvedValue:"16:9" });
  } else if (hasAnyClass(classes, ["aspect-[4/3]","aspect-4/3"])) {
    imageAspectRatio = "4:3";
    ev.push({ field:"cards.imageAspectRatio", confidence:"high", signal:"aspect-[4/3]", resolvedValue:"4:3" });
  } else {
    ev.push({ field:"cards.imageAspectRatio", confidence:"default", signal:"no aspect-ratio class", resolvedValue:"16:9" });
  }

  return {
    value: {
      layout,
      imagePosition,
      showCategory,
      showDate,
      showReadTime,
      showAuthor,
      hoverEffect,
      imageAspectRatio,
      hasOverlay: layout === "overlay" || hasAnyClass(classes, ["bg-gradient-to-t","bg-gradient-to-b"]),
    },
    evidence: ev,
  };
}

function deriveGallery(sig: AggregatedSignals): Derived<GalleryDNA> {
  const ev: SignalEvidence[] = [];
  const classes = sig.allClasses;
  const allHtml = sig.allHtml;

  // Layout
  let layout: GalleryLayout = "grid";
  if (hasAnyClass(classes, ["masonry","columns-2","columns-3","columns-4","columns-5"])) {
    layout = "masonry";
    ev.push({ field:"gallery.layout", confidence:"high", signal:"masonry/columns class", resolvedValue:"masonry" });
  } else if (/\bcarousel\b|\bslider\b|\bswiper\b|\bsplide\b|\bglide\b|\bslick\b/i.test(allHtml)) {
    layout = "carousel";
    ev.push({ field:"gallery.layout", confidence:"high", signal:"carousel/slider library", resolvedValue:"carousel" });
  } else if (/filmstrip|thumbnail-strip|thumbnail-row/i.test(allHtml)) {
    layout = "filmstrip";
    ev.push({ field:"gallery.layout", confidence:"medium", signal:"filmstrip pattern", resolvedValue:"filmstrip" });
  } else if (sig.tagCounts.figure >= 4) {
    layout = "grid";
    ev.push({ field:"gallery.layout", confidence:"medium", signal:`${sig.tagCounts.figure} figure elements`, resolvedValue:"grid" });
  } else {
    ev.push({ field:"gallery.layout", confidence:"default", signal:"no gallery pattern", resolvedValue:"grid" });
  }

  // Columns
  const COL_MAP: Array<[string[], number]> = [
    [["grid-cols-5","lg:grid-cols-5","xl:grid-cols-5"], 5],
    [["grid-cols-4","lg:grid-cols-4","xl:grid-cols-4"], 4],
    [["grid-cols-3","lg:grid-cols-3","md:grid-cols-3"], 3],
    [["grid-cols-2","lg:grid-cols-2","md:grid-cols-2"], 2],
  ];
  let columnsDesktop = 3;
  for (const [targets, n] of COL_MAP) {
    if (hasAnyClass(classes, targets)) {
      columnsDesktop = n;
      ev.push({ field:"gallery.columnsDesktop", confidence:"high", signal: targets[0], resolvedValue: String(n) });
      break;
    }
  }
  if (columnsDesktop === 3 && !hasAnyClass(classes, COL_MAP.flatMap((r) => r[0]))) {
    ev.push({ field:"gallery.columnsDesktop", confidence:"default", signal:"no grid-cols class", resolvedValue:"3" });
  }

  // Lightbox
  const hasLightbox = /\blightbox\b|\bfancybox\b|\bmagnific\b|\bglightbox\b|\bphotoswipe\b/i.test(allHtml);
  if (hasLightbox) ev.push({ field:"gallery.hasLightbox", confidence:"high", signal:"lightbox library detected", resolvedValue:"true" });

  // Caption
  const hasCaption = /\bfigcaption\b/i.test(allHtml) && sig.tagCounts.figure > 0;

  // Gap
  let gapSize: GalleryDNA["gapSize"] = "normal";
  if (hasAnyClass(classes, ["gap-0","gap-px","gap-0.5"])) gapSize = "none";
  else if (hasAnyClass(classes, ["gap-1","gap-2"])) gapSize = "tight";
  else if (hasAnyClass(classes, ["gap-8","gap-10","gap-12","gap-16"])) gapSize = "loose";

  return {
    value: {
      layout,
      columnsDesktop,
      columnsTablet: Math.max(2, columnsDesktop - 1),
      columnsMobile: 1,
      aspectRatio: sig.totalImages > 10 ? "mixed" : "16:9",
      hasLightbox,
      hasCaption,
      gapSize,
      animationStyle: hasAnyClass(classes, ["fade","animate-fade","transition-opacity"]) ? "fade" : "none",
    },
    evidence: ev,
  };
}

function deriveLayout(sig: AggregatedSignals): Derived<LayoutDNA> {
  const ev: SignalEvidence[] = [];
  const classes = sig.allClasses;

  // Strategy
  let strategy: LayoutStrategy = "card_grid";
  const hasSidebar   = sig.tagCounts.aside > 0;
  const hasDocNav    = hasAnyClass(classes, ["toc","table-of-contents","docs-sidebar","sidebar-nav"]);
  const hasPortfolio = /portfolio|work|projects|case.study/i.test(sig.rootHtml)
    && sig.totalImages > 10;
  const hasMagazine  = hasAnyClass(classes, ["col-span-2","md:col-span-2"]) && sig.tagCounts.article > 5;
  const hasGrid      = hasClassPrefix(classes, "grid-cols-");
  const hasEditorial = sig.tagCounts.article > sig.tagCounts.section * 2 && !hasGrid;

  if (hasDocNav) {
    strategy = "documentation";
    ev.push({ field:"layout.strategy", confidence:"high", signal:"docs-sidebar/toc class", resolvedValue:"documentation" });
  } else if (hasSidebar) {
    strategy = "sidebar_content";
    ev.push({ field:"layout.strategy", confidence:"high", signal:"<aside> element", resolvedValue:"sidebar_content" });
  } else if (hasPortfolio) {
    strategy = "portfolio_showcase";
    ev.push({ field:"layout.strategy", confidence:"medium", signal:"portfolio keyword + images", resolvedValue:"portfolio_showcase" });
  } else if (hasMagazine) {
    strategy = "magazine";
    ev.push({ field:"layout.strategy", confidence:"medium", signal:"col-span-2 grid with articles", resolvedValue:"magazine" });
  } else if (hasEditorial) {
    strategy = "editorial_flow";
    ev.push({ field:"layout.strategy", confidence:"medium", signal:"many article elements", resolvedValue:"editorial_flow" });
  } else if (hasGrid) {
    strategy = "card_grid";
    ev.push({ field:"layout.strategy", confidence:"medium", signal:"grid-cols-* class", resolvedValue:"card_grid" });
  } else {
    ev.push({ field:"layout.strategy", confidence:"default", signal:"no strong layout signal", resolvedValue:"card_grid" });
  }

  const grid: GridSystem = {
    columns: 12,
    gutterWidth: "1.5rem",
    marginWidth: "1rem",
    breakpoints: { sm:"640px", md:"768px", lg:"1024px", xl:"1280px", "2xl":"1536px" },
  };

  // Hero height
  let heroHeight: HeroHeight = "auto";
  if (hasAnyClass(classes, ["min-h-screen","h-screen"])) {
    heroHeight = "full-viewport";
    ev.push({ field:"layout.heroHeight", confidence:"high", signal:"h-screen/min-h-screen", resolvedValue:"full-viewport" });
  } else if (hasAnyClass(classes, ["min-h-\\[80vh\\]","h-\\[75vh\\]"])) {
    heroHeight = "three-quarter";
    ev.push({ field:"layout.heroHeight", confidence:"high", signal:"[80/75vh] class", resolvedValue:"three-quarter" });
  } else if (hasTag(sig.rootHtml, "section") && sig.totalImages > 2) {
    heroHeight = "half";
    ev.push({ field:"layout.heroHeight", confidence:"low", signal:"section + images", resolvedValue:"half" });
  } else {
    ev.push({ field:"layout.heroHeight", confidence:"default", signal:"no viewport height signal", resolvedValue:"auto" });
  }

  // Section spacing
  let sectionSpacing: SectionSpacing = "normal";
  if (hasAnyClass(classes, ["py-24","py-32","space-y-24","space-y-32"])) {
    sectionSpacing = "loose";
    ev.push({ field:"layout.sectionSpacing", confidence:"high", signal:"py-24/32", resolvedValue:"loose" });
  } else if (hasAnyClass(classes, ["py-6","py-8","space-y-6","space-y-8"])) {
    sectionSpacing = "tight";
    ev.push({ field:"layout.sectionSpacing", confidence:"medium", signal:"py-6/8", resolvedValue:"tight" });
  } else {
    ev.push({ field:"layout.sectionSpacing", confidence:"default", signal:"no section spacing class", resolvedValue:"normal" });
  }

  // Divider style
  let dividerStyle: SectionDivider = "space";
  if (hasAnyClass(classes, ["divide-y","border-b","border-t"])) {
    dividerStyle = "line";
    ev.push({ field:"layout.dividerStyle", confidence:"medium", signal:"divide-y/border-b/t", resolvedValue:"line" });
  } else if (hasAnyClass(classes, ["bg-gradient-to-b","bg-gradient-to-r"])) {
    dividerStyle = "gradient";
    ev.push({ field:"layout.dividerStyle", confidence:"medium", signal:"bg-gradient class", resolvedValue:"gradient" });
  }

  return {
    value: {
      strategy,
      grid,
      heroHeight,
      sectionSpacing,
      dividerStyle,
      sidebarWidth: hasSidebar ? "280px" : "0px",
      contentBlockSpacing: sectionSpacing === "loose" ? "3rem" : sectionSpacing === "tight" ? "1rem" : "2rem",
    },
    evidence: ev,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Content hash — deterministic fingerprint of the input
// ─────────────────────────────────────────────────────────────────────────────

function computeContentHash(input: ExtractionInput): string {
  const sorted = [...input.pages]
    .sort((a, b) => a.url.localeCompare(b.url))
    .map((p) => `${p.url}:${p.html?.length ?? 0}`);
  return createHash("sha256")
    .update(`design-dna:1.0:${input.url}:${sorted.join("|")}`)
    .digest("hex")
    .slice(0, 32);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractionResult {
  dna: DesignDNA;
  evidence: SignalEvidence[];
  extractionTimeMs: number;
}

/**
 * Extracts a DesignDNA from scraped page HTML.
 *
 * Same input always produces the same output (deterministic).
 * Never throws — always returns a fully populated DesignDNA.
 */
export function extractDesignDNA(input: ExtractionInput): DesignDNA {
  return extractDesignDNAWithEvidence(input).dna;
}

/**
 * Same as extractDesignDNA but also returns per-field signal evidence
 * and extraction timing. Used by generateAuditReport().
 */
export function extractDesignDNAWithEvidence(input: ExtractionInput): ExtractionResult {
  const t0  = Date.now();
  const sig = aggregateSignals(input.pages);

  const typography  = deriveTypography(sig);
  const colors      = deriveColors(sig);
  const spacing     = deriveSpacing(sig);
  const borders     = deriveBorders(sig);
  const navigation  = deriveNavigation(sig);
  const hero        = deriveHero(sig);
  const cards       = deriveCards(sig);
  const gallery     = deriveGallery(sig);
  const layout      = deriveLayout(sig);

  const evidence: SignalEvidence[] = [
    ...typography.evidence,
    ...colors.evidence,
    ...spacing.evidence,
    ...borders.evidence,
    ...navigation.evidence,
    ...hero.evidence,
    ...cards.evidence,
    ...gallery.evidence,
    ...layout.evidence,
  ];

  const dna: DesignDNA = {
    meta: {
      version:       "1.0",
      generatedAt:   new Date().toISOString(),
      jobId:         input.jobId,
      url:           input.url,
      contentHash:   computeContentHash(input),
    },
    typography:  typography.value,
    colors:      colors.value,
    spacing:     spacing.value,
    borders:     borders.value,
    navigation:  navigation.value,
    hero:        hero.value,
    cards:       cards.value,
    gallery:     gallery.value,
    layout:      layout.value,
  };

  return { dna, evidence, extractionTimeMs: Date.now() - t0 };
}
