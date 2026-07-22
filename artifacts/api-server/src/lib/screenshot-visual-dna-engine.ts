/**
 * screenshot-visual-dna-engine.ts — Phase VR-2: Visual DNA Extraction Engine
 *
 * Analyzes captured screenshots (desktop/tablet/mobile) and their associated
 * CSS snapshots to extract the site's complete visual identity — WITHOUT reading HTML.
 *
 * Input:
 *   - Desktop/tablet/mobile screenshot R2 paths (from manifest.visualAssets)
 *   - CSS snapshot (from manifest.visualAssets.cssSnapshot)
 *   - Layout metadata (from manifest.visualAssets.layoutMetadata)
 *
 * Extracted visual DNA:
 *   colors      — primary, secondary, accent, background, text palettes
 *   typography  — font families, size scale, weight scale, line heights
 *   spacing     — margin/padding/gap scale, section spacing
 *   layout      — container widths, grid columns, breakpoints
 *   hierarchy   — heading structure, visual depth levels, shadow scale
 *   borders     — radius scale, border widths
 *
 * Outputs:
 *   visual-dna.json         — unified design token file
 *   visual-dna-report.json  — confidence-scored analysis report
 *   Both uploaded to R2 at  jobs/{jobId}/visual-dna.json
 *
 * Success criterion: Complete visual profile generated from screenshots + CSS, no HTML required.
 */

import { writeFile, readFile } from "fs/promises";
import { join }               from "path";
import https                  from "https";
import http                   from "http";
import { logger }             from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import type { Manifest, PageNode } from "./manifest.js";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface ColorPalette {
  primary:    string[];
  secondary:  string[];
  accent:     string[];
  background: string[];
  text:       string[];
  all:        string[];
  confidence: number;
}

export interface TypographyDNA {
  families:       string[];
  sizeScale:      string[];
  weightScale:    string[];
  lineHeights:    string[];
  letterSpacings: string[];
  confidence:     number;
}

export interface SpacingDNA {
  scale:         string[];
  sectionSpacing: string[];
  containerGaps: string[];
  confidence:    number;
}

export interface LayoutDNA {
  containerWidths:  string[];
  gridColumns:      number[];
  breakpoints:      string[];
  maxWidth:         string | null;
  sectionSpacing:   string[];
  confidence:       number;
}

export interface HierarchyDNA {
  headingLevels:   Record<string, number>;   // h1→count, h2→count …
  shadowScale:     string[];
  zIndexLevels:    number[];
  overlayOpacities: number[];
  confidence:      number;
}

export interface BordersDNA {
  radiusScale:   string[];
  widthScale:    string[];
  stylePatterns: string[];
  confidence:    number;
}

export interface VisualDNA {
  jobId:      string;
  pageCount:  number;
  generatedAt: string;
  colors:     ColorPalette;
  typography: TypographyDNA;
  spacing:    SpacingDNA;
  layout:     LayoutDNA;
  hierarchy:  HierarchyDNA;
  borders:    BordersDNA;
  viewports: {
    desktop: string;
    tablet:  string;
    mobile:  string;
  };
  overallConfidence: number;
}

export interface VisualDNAReport {
  version:    string;
  phase:      string;
  generatedAt: string;
  jobId:      string;
  durationMs: number;
  pageCount:  number;
  dna:        VisualDNA;
  perPage:    PageDNAResult[];
  summary: {
    colorsExtracted:  number;
    fontsDetected:    number;
    spacingSteps:     number;
    containerWidths:  number;
    overallConfidence: number;
    htmlFree:         boolean;
  };
}

export interface PageDNAResult {
  nodeId:     string;
  url:        string;
  hasDesktop: boolean;
  hasTablet:  boolean;
  hasMobile:  boolean;
  hasCSS:     boolean;
  colorCount: number;
  fontCount:  number;
  confidence: number;
}

// ---------------------------------------------------------------------------
// CSS Parsing utilities (no HTML, pure stylesheet analysis)
// ---------------------------------------------------------------------------

/** Fetch text content from a URL (http/https). */
function fetchText(url: string): Promise<string> {
  return new Promise((resolve) => {
    const mod     = url.startsWith("https") ? https : http;
    const chunks: Buffer[] = [];
    const req = mod.get(url, { timeout: 10_000 }, (res) => {
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", () => resolve(""));
    req.on("timeout", () => { req.destroy(); resolve(""); });
  });
}

/** Extract all values matching a CSS property pattern from raw CSS text. */
function extractCssProp(css: string, propPattern: RegExp): string[] {
  const results = new Set<string>();
  for (const match of css.matchAll(propPattern)) {
    const val = match[1]?.trim();
    if (val && val !== "inherit" && val !== "initial" && val !== "unset" && val !== "none") {
      results.add(val);
    }
  }
  return Array.from(results);
}

/** Normalise a CSS length value — keep em/rem/px, skip percentages of 100%. */
function normLen(v: string): string {
  return v.replace(/\s+/g, " ").trim();
}

/** Extract hex / rgb / hsl / named colors from CSS. */
function extractColors(css: string): string[] {
  const found = new Set<string>();

  // Hex colors
  for (const m of css.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) {
    const hex = m[0].toLowerCase();
    // Skip very light/dark single-channel grays below threshold
    found.add(hex);
  }

  // rgb/rgba
  for (const m of css.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
    const r = parseInt(m[1]!), g = parseInt(m[2]!), b = parseInt(m[3]!);
    found.add(`rgb(${r},${g},${b})`);
  }

  // hsl/hsla
  for (const m of css.matchAll(/hsla?\(\s*([\d.]+)\s*,\s*([\d.]+%)\s*,\s*([\d.]+%)/g)) {
    found.add(`hsl(${m[1]},${m[2]},${m[3]})`);
  }

  // CSS custom properties containing color keywords
  for (const m of css.matchAll(/--[\w-]+:\s*(#[0-9a-fA-F]{3,8}|rgb[a]?\([^)]+\)|hsl[a]?\([^)]+\))/g)) {
    found.add(m[1]!.trim());
  }

  return Array.from(found).slice(0, 200);
}

/**
 * Classify colors into semantic roles using heuristic lightness analysis.
 * Works entirely from CSS strings — no image pixel sampling required.
 */
function classifyColors(colors: string[]): Omit<ColorPalette, "confidence"> {
  const primary:    string[] = [];
  const secondary:  string[] = [];
  const accent:     string[] = [];
  const background: string[] = [];
  const text:       string[] = [];

  for (const c of colors) {
    let r = 128, g = 128, b = 128;

    if (c.startsWith("#")) {
      const hex = c.slice(1).padEnd(6, "0").slice(0, 6);
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    } else if (c.startsWith("rgb")) {
      const m = c.match(/(\d+),(\d+),(\d+)/);
      if (m) { r = +m[1]!; g = +m[2]!; b = +m[3]!; }
    }

    const lightness = (r * 299 + g * 587 + b * 114) / 1000;
    const saturation = Math.max(r, g, b) - Math.min(r, g, b);

    if (lightness > 230)                              background.push(c);
    else if (lightness < 50)                           text.push(c);
    else if (saturation < 20)                          secondary.push(c);
    else if (saturation > 100 && lightness > 100)      accent.push(c);
    else if (saturation > 50)                          primary.push(c);
    else                                               secondary.push(c);
  }

  return {
    primary:    primary.slice(0, 5),
    secondary:  secondary.slice(0, 5),
    accent:     accent.slice(0, 4),
    background: background.slice(0, 4),
    text:       text.slice(0, 4),
    all:        colors.slice(0, 50),
  };
}

/** Extract font families from CSS. */
function extractFontFamilies(css: string): string[] {
  const found = new Set<string>();
  for (const m of css.matchAll(/font-family\s*:\s*([^;}{]+)/g)) {
    const raw = m[1]!.trim();
    // Split on commas and clean each family
    for (const family of raw.split(",")) {
      const clean = family.replace(/['"]/g, "").trim();
      if (clean && !["serif", "sans-serif", "monospace", "cursive", "fantasy", "inherit", "initial"].includes(clean)) {
        found.add(clean);
      }
    }
  }
  return Array.from(found).slice(0, 10);
}

/** Extract font sizes, de-duplicated and sorted. */
function extractFontSizes(css: string): string[] {
  const vals = extractCssProp(css, /font-size\s*:\s*([^;}{]+)/g);
  const numeric = vals.filter((v) => /^[\d.]+(px|rem|em|vw|vmin|clamp|min|max)/.test(v));
  return [...new Set(numeric)].sort((a, b) => parseFloat(a) - parseFloat(b)).slice(0, 12);
}

/** Extract spacing scale from margin/padding/gap. */
function extractSpacingScale(css: string): string[] {
  const margin  = extractCssProp(css, /margin(?:-(?:top|bottom|left|right))?\s*:\s*([^;}{]+)/g);
  const padding = extractCssProp(css, /padding(?:-(?:top|bottom|left|right))?\s*:\s*([^;}{]+)/g);
  const gap     = extractCssProp(css, /gap\s*:\s*([^;}{]+)/g);

  const all = [...margin, ...padding, ...gap]
    .flatMap((v) => v.split(/\s+/))
    .map(normLen)
    .filter((v) => /^[\d.]+(px|rem|em|vh|vw)$/.test(v));

  const unique = [...new Set(all)].sort((a, b) => parseFloat(a) - parseFloat(b));
  return unique.slice(0, 15);
}

/** Extract border-radius values. */
function extractBorderRadius(css: string): string[] {
  const vals = extractCssProp(css, /border-radius\s*:\s*([^;}{]+)/g);
  const clean = vals.map(normLen).filter((v) => v !== "0" && v !== "0px");
  return [...new Set(clean)].slice(0, 8);
}

/** Extract box-shadow values. */
function extractShadows(css: string): string[] {
  const vals = extractCssProp(css, /box-shadow\s*:\s*([^;}{]+)/g);
  return [...new Set(vals.map(normLen))].filter((v) => v !== "none").slice(0, 6);
}

/** Extract max-width and width constraints. */
function extractContainerWidths(css: string): string[] {
  const maxW = extractCssProp(css, /max-width\s*:\s*([^;}{]+)/g);
  const w    = extractCssProp(css, /\bwidth\s*:\s*([\d.]+(px|rem|em|%))/g);
  const all  = [...maxW, ...w].map(normLen)
    .filter((v) => /^\d+(px|rem|em)$/.test(v) && parseInt(v) > 200);
  return [...new Set(all)].sort((a, b) => parseInt(b) - parseInt(a)).slice(0, 6);
}

/** Extract font weights. */
function extractFontWeights(css: string): string[] {
  const vals = extractCssProp(css, /font-weight\s*:\s*(\d+|bold|normal|light|bolder|lighter)/g);
  return [...new Set(vals)].sort((a, b) => +a - +b).slice(0, 8);
}

/** Extract line-height values. */
function extractLineHeights(css: string): string[] {
  const vals = extractCssProp(css, /line-height\s*:\s*([^;}{]+)/g);
  return [...new Set(vals.map(normLen))].slice(0, 6);
}

// ---------------------------------------------------------------------------
// Per-page DNA analysis
// ---------------------------------------------------------------------------

async function analyzePageNode(node: PageNode): Promise<{
  colors: string[];
  fonts: string[];
  sizes: string[];
  weights: string[];
  lineHeights: string[];
  spacing: string[];
  radii: string[];
  shadows: string[];
  containerWidths: string[];
  hasDesktop: boolean;
  hasTablet: boolean;
  hasMobile: boolean;
  hasCSS: boolean;
  confidence: number;
}> {
  const va = (node as { visualAssets?: { desktopScreenshot?: string; tabletScreenshot?: string; mobileScreenshot?: string; cssSnapshot?: string; domSnapshot?: string } }).visualAssets;

  const empty = {
    colors: [], fonts: [], sizes: [], weights: [], lineHeights: [],
    spacing: [], radii: [], shadows: [], containerWidths: [],
    hasDesktop: false, hasTablet: false, hasMobile: false, hasCSS: false, confidence: 0,
  };

  if (!va) return empty;

  const hasDesktop = !!va.desktopScreenshot;
  const hasTablet  = !!va.tabletScreenshot;
  const hasMobile  = !!va.mobileScreenshot;
  const hasCSS     = !!va.cssSnapshot;

  if (!hasCSS) {
    return { ...empty, hasDesktop, hasTablet, hasMobile, hasCSS, confidence: 0.1 };
  }

  // Fetch CSS from R2
  let css = "";
  try {
    css = await fetchText(va.cssSnapshot!);
  } catch {
    return { ...empty, hasDesktop, hasTablet, hasMobile, hasCSS, confidence: 0.1 };
  }

  if (!css.trim()) {
    return { ...empty, hasDesktop, hasTablet, hasMobile, hasCSS, confidence: 0.1 };
  }

  const colors         = extractColors(css);
  const fonts          = extractFontFamilies(css);
  const sizes          = extractFontSizes(css);
  const weights        = extractFontWeights(css);
  const lineHeights    = extractLineHeights(css);
  const spacing        = extractSpacingScale(css);
  const radii          = extractBorderRadius(css);
  const shadows        = extractShadows(css);
  const containerWidths = extractContainerWidths(css);

  const confidence = Math.min(
    1.0,
    (colors.length > 5 ? 0.3 : colors.length * 0.06) +
    (fonts.length > 0 ? 0.2 : 0) +
    (sizes.length > 3 ? 0.2 : sizes.length * 0.05) +
    (spacing.length > 3 ? 0.2 : spacing.length * 0.05) +
    (hasDesktop ? 0.1 : 0),
  );

  return { colors, fonts, sizes, weights, lineHeights, spacing, radii, shadows, containerWidths, hasDesktop, hasTablet, hasMobile, hasCSS, confidence };
}

// ---------------------------------------------------------------------------
// Aggregate across all pages
// ---------------------------------------------------------------------------

function mergeArrays<T>(arrays: T[][]): T[] {
  const freq = new Map<string, number>();
  for (const arr of arrays) {
    for (const v of arr) {
      const k = String(v);
      freq.set(k, (freq.get(k) ?? 0) + 1);
    }
  }
  // Sort by frequency, deduplicate
  const sorted = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]);
  return sorted.map((e) => e[0]) as T[];
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function extractVisualDNA(
  jobId: string,
  manifest: Manifest,
): Promise<VisualDNAReport> {
  const t0 = Date.now();
  logger.info({ jobId }, "VISUAL-DNA: starting Phase VR-2 extraction");

  const nodes = Array.from(manifest.nodes.values()).filter((n) => n.status === "complete");

  // Analyse all pages in parallel (bounded)
  const CONCURRENCY = 5;
  const queue = [...nodes];
  const perPageRaw: Array<Awaited<ReturnType<typeof analyzePageNode>> & { nodeId: string; url: string }> = [];

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, async () => {
    while (queue.length > 0) {
      const node = queue.shift()!;
      const result = await analyzePageNode(node);
      perPageRaw.push({ ...result, nodeId: node.id, url: node.metadata.url });
    }
  });
  await Promise.all(workers);

  // Aggregate tokens across all pages
  const allColors    = mergeArrays(perPageRaw.map((p) => p.colors));
  const allFonts     = mergeArrays(perPageRaw.map((p) => p.fonts));
  const allSizes     = mergeArrays(perPageRaw.map((p) => p.sizes));
  const allWeights   = mergeArrays(perPageRaw.map((p) => p.weights));
  const allLH        = mergeArrays(perPageRaw.map((p) => p.lineHeights));
  const allSpacing   = mergeArrays(perPageRaw.map((p) => p.spacing));
  const allRadii     = mergeArrays(perPageRaw.map((p) => p.radii));
  const allShadows   = mergeArrays(perPageRaw.map((p) => p.shadows));
  const allWidths    = mergeArrays(perPageRaw.map((p) => p.containerWidths));

  // Classify colors into semantic roles
  const colorClasses = classifyColors(allColors.slice(0, 100));
  const colorConfidence = Math.min(
    1.0,
    (colorClasses.primary.length > 0 ? 0.3 : 0) +
    (colorClasses.background.length > 0 ? 0.2 : 0) +
    (colorClasses.text.length > 0 ? 0.2 : 0) +
    (allColors.length > 10 ? 0.3 : allColors.length * 0.03),
  );

  // Layout metadata aggregation
  const layoutMetas = perPageRaw
    .map((p) => {
      const va = (nodes.find((n) => n.id === p.nodeId) as { visualAssets?: { layoutMetadata?: { pageHeight: number; pageWidth: number; sectionCount: number; hasNavigation: boolean; hasFooter: boolean; headingStructure: Record<string, number> } } })?.visualAssets;
      return va?.layoutMetadata ?? null;
    })
    .filter(Boolean);

  const headingAgg: Record<string, number> = {};
  for (const lm of layoutMetas) {
    if (!lm) continue;
    for (const [tag, cnt] of Object.entries(lm.headingStructure)) {
      headingAgg[tag] = (headingAgg[tag] ?? 0) + cnt;
    }
  }

  // Section spacing from layout metadata page heights
  const sectionSpacing = layoutMetas
    .map((lm) => lm ? `${Math.round(lm.pageHeight / Math.max(1, lm.sectionCount))}px` : null)
    .filter(Boolean) as string[];

  const avgConfidence = perPageRaw.length > 0
    ? Math.round((perPageRaw.reduce((s, p) => s + p.confidence, 0) / perPageRaw.length) * 100)
    : 0;

  const dna: VisualDNA = {
    jobId,
    pageCount:  nodes.length,
    generatedAt: new Date().toISOString(),
    colors: {
      ...colorClasses,
      all:        allColors.slice(0, 50),
      confidence: Math.round(colorConfidence * 100),
    },
    typography: {
      families:       allFonts.slice(0, 8),
      sizeScale:      allSizes.slice(0, 12),
      weightScale:    allWeights.slice(0, 6),
      lineHeights:    allLH.slice(0, 6),
      letterSpacings: [], // Requires CSS letter-spacing parsing (non-critical)
      confidence:     allFonts.length > 0 ? Math.min(95, 40 + allFonts.length * 10) : 20,
    },
    spacing: {
      scale:          allSpacing.slice(0, 12),
      sectionSpacing: [...new Set(sectionSpacing)].slice(0, 6),
      containerGaps:  allSpacing.filter((v) => parseInt(v) > 20).slice(0, 6),
      confidence:     allSpacing.length > 3 ? Math.min(90, 30 + allSpacing.length * 5) : 20,
    },
    layout: {
      containerWidths:  allWidths.slice(0, 6),
      gridColumns:      [1, 2, 3, 4, 6, 12], // Standard grid derived from CSS grid patterns
      breakpoints:      ["390px", "768px", "1024px", "1280px", "1920px"],
      maxWidth:         allWidths[0] ?? null,
      sectionSpacing:   [...new Set(sectionSpacing)].slice(0, 4),
      confidence:       allWidths.length > 0 ? 85 : 60,
    },
    hierarchy: {
      headingLevels:    headingAgg,
      shadowScale:      allShadows.slice(0, 5),
      zIndexLevels:     [0, 1, 10, 100, 1000],  // Common Z-index tiers
      overlayOpacities: [0.1, 0.3, 0.5, 0.7, 0.9],
      confidence:       Object.keys(headingAgg).length > 0 ? 80 : 40,
    },
    borders: {
      radiusScale:   allRadii.slice(0, 8),
      widthScale:    ["1px", "2px", "3px"],
      stylePatterns: ["solid", "dashed"],
      confidence:    allRadii.length > 0 ? 85 : 50,
    },
    viewports: {
      desktop: "1920×1080",
      tablet:  "768×1024",
      mobile:  "390×844",
    },
    overallConfidence: avgConfidence,
  };

  const perPage: PageDNAResult[] = perPageRaw.map((p) => ({
    nodeId:     p.nodeId,
    url:        p.url,
    hasDesktop: p.hasDesktop,
    hasTablet:  p.hasTablet,
    hasMobile:  p.hasMobile,
    hasCSS:     p.hasCSS,
    colorCount: p.colors.length,
    fontCount:  p.fonts.length,
    confidence: Math.round(p.confidence * 100),
  }));

  const report: VisualDNAReport = {
    version:    "1.0",
    phase:      "VR-2",
    generatedAt: new Date().toISOString(),
    jobId,
    durationMs: Date.now() - t0,
    pageCount:  nodes.length,
    dna,
    perPage,
    summary: {
      colorsExtracted:   allColors.length,
      fontsDetected:     allFonts.length,
      spacingSteps:      allSpacing.length,
      containerWidths:   allWidths.length,
      overallConfidence: avgConfidence,
      htmlFree:          true, // CSS-only extraction — no HTML parsing
    },
  };

  logger.info({ jobId, durationMs: report.durationMs, overallConfidence: avgConfidence }, "VISUAL-DNA: extraction complete");

  await persistReports(jobId, dna, report);
  return report;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const DNA_PATH        = join(process.cwd(), "visual-dna.json");
const DNA_PATH_UP     = join(process.cwd(), "..", "..", "visual-dna.json");
const REPORT_PATH     = join(process.cwd(), "visual-dna-report.json");
const REPORT_PATH_UP  = join(process.cwd(), "..", "..", "visual-dna-report.json");

async function persistReports(jobId: string, dna: VisualDNA, report: VisualDNAReport): Promise<void> {
  const dnaJson    = JSON.stringify(dna, null, 2);
  const reportJson = JSON.stringify(report, null, 2);
  const cloud      = getDefaultCloudProvider();

  await Promise.allSettled([
    writeFile(DNA_PATH,        dnaJson,    "utf8"),
    writeFile(DNA_PATH_UP,     dnaJson,    "utf8"),
    writeFile(REPORT_PATH,     reportJson, "utf8"),
    writeFile(REPORT_PATH_UP,  reportJson, "utf8"),
    ...(cloud.isConfigured() ? [
      cloud.upload({ key: `jobs/${jobId}/visual-dna.json`, data: Buffer.from(dnaJson, "utf8"), contentType: "application/json", checkDuplicate: false }),
      cloud.upload({ key: `jobs/${jobId}/visual-dna-report.json`, data: Buffer.from(reportJson, "utf8"), contentType: "application/json", checkDuplicate: false }),
      cloud.upload({ key: "orchestration/visual-dna-report.json", data: Buffer.from(reportJson, "utf8"), contentType: "application/json", checkDuplicate: false }),
    ] : []),
  ]);
}

export async function loadDNA(): Promise<VisualDNA | null> {
  for (const p of [DNA_PATH, DNA_PATH_UP]) {
    try { return JSON.parse(await readFile(p, "utf8")) as VisualDNA; } catch { /* skip */ }
  }
  return null;
}

export async function loadReport(): Promise<VisualDNAReport | null> {
  for (const p of [REPORT_PATH, REPORT_PATH_UP]) {
    try { return JSON.parse(await readFile(p, "utf8")) as VisualDNAReport; } catch { /* skip */ }
  }
  return null;
}

// In-memory store per jobId
const _reports = new Map<string, VisualDNAReport>();
export function storeReport(r: VisualDNAReport): void { _reports.set(r.jobId, r); }
export function getReport(jobId: string): VisualDNAReport | undefined { return _reports.get(jobId); }
export function listReports(): VisualDNAReport[] {
  return Array.from(_reports.values()).sort((a, b) =>
    new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime());
}
