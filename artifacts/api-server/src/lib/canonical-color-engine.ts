/**
 * canonical-color-engine.ts — PS-1: Shared Color Engine
 *
 * Single source of truth for all color utilities across the pipeline.
 * Eliminates duplication of hexToRgb / rgbToHsl / colorDistance / paletteSim
 * found in 4+ engine files:
 *   - visual-dna-engine.ts
 *   - visual-fidelity-engine.ts
 *   - visual-fidelity-scoring-engine-vr7.ts
 *   - visual-reconstruction-engine.ts
 *
 * Usage: import { hexToRgb, colorDistance, paletteSimilarity, ... }
 *        from "./canonical-color-engine.js"
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Rgb { r: number; g: number; b: number }
export interface Hsl { h: number; s: number; l: number }

export interface ColorFrequency {
  hex:   string;
  rgb:   Rgb;
  count: number;
}

export interface ClassifiedPalette {
  primary:    string[];
  secondary:  string[];
  background: string[];
  text:       string[];
  accent:     string[];
}

// ---------------------------------------------------------------------------
// Core conversion utilities
// ---------------------------------------------------------------------------

/**
 * Parse a 3-or-6-digit hex string into RGB components.
 * Returns null for invalid input.
 */
export function hexToRgb(hex: string): Rgb | null {
  const clean = hex.replace(/^#/, "");
  const full  = clean.length === 3
    ? clean.split("").map(c => c + c).join("")
    : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/**
 * Convert an Rgb value to Hsl { h: 0–360, s: 0–100, l: 0–100 }.
 */
export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l   = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if      (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else                 h = ((rn - gn) / d + 4) / 6;
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/**
 * Convert Hsl { h: 0–360, s: 0–100, l: 0–100 } to a lowercase hex string.
 */
export function hslToHex({ h, s, l }: Hsl): string {
  const sn = s / 100, ln = l / 100;
  const a  = sn * Math.min(ln, 1 - ln);
  const f  = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = ln - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Convert Rgb to a lowercase 6-digit hex string.
 */
export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/**
 * Normalise a raw color token (handles 3-digit, rgba(), rgb(), named stub).
 * Returns a lowercase 6-digit hex string or null.
 */
export function normalizeHex(raw: string): string | null {
  const trimmed = raw.trim();

  // Already a hex
  const rgb = hexToRgb(trimmed);
  if (rgb) return rgbToHex(rgb);

  // rgb(r, g, b)
  const rgbMatch = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgbMatch) {
    return rgbToHex({ r: +rgbMatch[1], g: +rgbMatch[2], b: +rgbMatch[3] });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Distance metrics
// ---------------------------------------------------------------------------

/**
 * Euclidean RGB distance (0 = identical, ~441 = max).
 */
export function colorDistance(a: Rgb, b: Rgb): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/**
 * HSL-aware perceptual distance (hue weighted, 0 = identical, 1 = max).
 */
export function hslColorDistance(a: Hsl, b: Hsl): number {
  const dh = Math.abs(a.h - b.h) / 360;
  const ds = Math.abs(a.s - b.s) / 100;
  const dl = Math.abs(a.l - b.l) / 100;
  return parseFloat((Math.sqrt(dh * dh + ds * ds + dl * dl) / Math.sqrt(3)).toFixed(4));
}

/**
 * Perceived luminance (0–255 scale).
 */
export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ---------------------------------------------------------------------------
// Palette utilities
// ---------------------------------------------------------------------------

/**
 * Deduplicate a list of hex colors using Euclidean RGB clustering.
 * Colors within `threshold` distance of an existing representative are merged.
 * Returns a Map<representativeHex, frequency>.
 */
export function deduplicateColors(
  hexColors: string[],
  threshold = 30,
): ColorFrequency[] {
  const reps: Array<{ hex: string; rgb: Rgb; count: number }> = [];

  for (const hex of hexColors) {
    const rgb = hexToRgb(hex);
    if (!rgb) continue;
    const match = reps.find(r => colorDistance(r.rgb, rgb) < threshold);
    if (match) { match.count++; }
    else       { reps.push({ hex, rgb, count: 1 }); }
  }

  return reps.sort((a, b) => b.count - a.count);
}

/**
 * Palette similarity score between source and generated palettes (0–100).
 * Each source color is matched to its nearest generated color; score is
 * 100 - (avg distance / 4.41) to stay in 0–100 range.
 */
export function paletteSimilarity(source: string[], generated: string[]): number {
  if (source.length === 0 || generated.length === 0) return 0;

  const genRgbs = generated.map(hexToRgb).filter(Boolean) as Rgb[];
  if (genRgbs.length === 0) return 0;

  let totalDist = 0;
  let matched   = 0;

  for (const sc of source) {
    const srcRgb = hexToRgb(sc);
    if (!srcRgb) continue;
    const best = Math.min(...genRgbs.map(gr => colorDistance(srcRgb, gr)));
    totalDist += best;
    matched++;
  }

  if (matched === 0) return 0;
  const avgDist = totalDist / matched;
  return Math.max(0, Math.round(100 - avgDist / 4.41));
}

// ---------------------------------------------------------------------------
// Color extraction from CSS text
// ---------------------------------------------------------------------------

/**
 * Extract all hex color tokens from a CSS/HTML text blob.
 * Returns raw (potentially duplicated) hex strings.
 */
export function extractColorsFromCss(cssText: string): string[] {
  const HEX_RE = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g;
  const matches = cssText.match(HEX_RE) ?? [];
  return matches.map(m => m.toLowerCase());
}

/**
 * Classify a list of deduplicated hex colors into semantic roles.
 * Heuristic: luminance, saturation, and frequency determine role.
 */
export function classifyColors(
  colors: ColorFrequency[],
  total: number,
): ClassifiedPalette {
  const result: ClassifiedPalette = {
    primary: [], secondary: [], background: [], text: [], accent: [],
  };

  for (const { hex, rgb, count } of colors) {
    const hsl  = rgbToHsl(rgb);
    const lum  = luminance(rgb);
    const freq = total > 0 ? count / total : 0;

    if (lum > 200)                         { result.background.push(hex); }
    else if (lum < 40)                     { result.text.push(hex); }
    else if (hsl.s > 60 && freq < 0.05)   { result.accent.push(hex); }
    else if (freq >= 0.1)                  { result.primary.push(hex); }
    else                                   { result.secondary.push(hex); }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Color scale generation (used by visual-reconstruction-engine)
// ---------------------------------------------------------------------------

/**
 * Generate a 9-stop Tailwind-style color scale from a seed hex.
 * Steps: 100 (lightest) → 900 (darkest).
 */
export function buildColorScale(seedHex: string): Record<string, string> {
  const rgb = hexToRgb(seedHex);
  if (!rgb) return {};
  const base = rgbToHsl(rgb);
  const stops = [90, 80, 70, 60, 50, 40, 30, 20, 10];
  const scale: Record<string, string> = {};
  stops.forEach((l, i) => {
    scale[`${(i + 1) * 100}`] = hslToHex({ h: base.h, s: base.s, l });
  });
  return scale;
}

// ---------------------------------------------------------------------------
// Duplication audit (used by PS-1 route to self-report)
// ---------------------------------------------------------------------------

export interface ColorFunctionDuplicate {
  functionName:  string;
  canonical:     string;          // canonical-color-engine.ts
  duplicatedIn:  string[];        // files that had their own copy
  signature:     string;
}

export const COLOR_FUNCTION_AUDIT: ColorFunctionDuplicate[] = [
  {
    functionName: "hexToRgb",
    canonical:    "canonical-color-engine.ts",
    duplicatedIn: [
      "visual-dna-engine.ts",
      "visual-fidelity-engine.ts",
      "visual-fidelity-scoring-engine-vr7.ts",
      "visual-reconstruction-engine.ts",
    ],
    signature: "hexToRgb(hex: string): Rgb | null",
  },
  {
    functionName: "rgbToHsl",
    canonical:    "canonical-color-engine.ts",
    duplicatedIn: [
      "visual-dna-engine.ts",
      "visual-reconstruction-engine.ts",
    ],
    signature: "rgbToHsl(rgb: Rgb): Hsl",
  },
  {
    functionName: "colorDistance",
    canonical:    "canonical-color-engine.ts",
    duplicatedIn: [
      "visual-dna-engine.ts",
      "visual-fidelity-engine.ts",
      "visual-fidelity-scoring-engine-vr7.ts (as colorDist)",
    ],
    signature: "colorDistance(a: Rgb, b: Rgb): number",
  },
  {
    functionName: "paletteSimilarity",
    canonical:    "canonical-color-engine.ts",
    duplicatedIn: [
      "visual-fidelity-engine.ts (as paletteSimilarity)",
      "visual-fidelity-scoring-engine-vr7.ts (as paletteSim)",
    ],
    signature: "paletteSimilarity(source: string[], generated: string[]): number",
  },
  {
    functionName: "hslColorDistance",
    canonical:    "canonical-color-engine.ts",
    duplicatedIn: [
      "visual-reconstruction-engine.ts (as hslColorDistance)",
    ],
    signature: "hslColorDistance(a: Hsl, b: Hsl): number",
  },
  {
    functionName: "extractColors / extractColorsFromCss",
    canonical:    "canonical-color-engine.ts (as extractColorsFromCss)",
    duplicatedIn: [
      "visual-dna-engine.ts (as extractColors)",
      "screenshot-visual-dna-engine.ts (as extractColors)",
    ],
    signature: "extractColorsFromCss(cssText: string): string[]",
  },
  {
    functionName: "deduplicateColors",
    canonical:    "canonical-color-engine.ts",
    duplicatedIn: [
      "visual-dna-engine.ts",
    ],
    signature: "deduplicateColors(hexColors: string[], threshold?: number): ColorFrequency[]",
  },
  {
    functionName: "normalizeHex",
    canonical:    "canonical-color-engine.ts",
    duplicatedIn: [
      "visual-dna-engine.ts",
    ],
    signature: "normalizeHex(raw: string): string | null",
  },
  {
    functionName: "buildColorScale",
    canonical:    "canonical-color-engine.ts",
    duplicatedIn: [
      "visual-reconstruction-engine.ts",
    ],
    signature: "buildColorScale(seedHex: string): Record<string, string>",
  },
  {
    functionName: "classifyColors",
    canonical:    "canonical-color-engine.ts",
    duplicatedIn: [
      "screenshot-visual-dna-engine.ts",
    ],
    signature: "classifyColors(colors: ColorFrequency[], total: number): ClassifiedPalette",
  },
];
