/**
 * color-engine.ts — PS-1: Color Engine Consolidation Routes
 *
 *   GET  /api/color-engine/report         — full canonical color engine manifest
 *   GET  /api/color-engine/duplication    — duplication audit across engine files
 *   GET  /api/color-engine/functions      — list of all exported canonical functions
 *   POST /api/color-engine/palette        — classify colors from a hex list
 *   POST /api/color-engine/similarity     — palette similarity score between two palettes
 *   POST /api/color-engine/extract        — extract and classify colors from raw CSS text
 *   GET  /api/color-engine/scale/:hex     — generate a 9-stop color scale from a seed hex
 */

import { Router, type IRouter } from "express";
import {
  hexToRgb,
  rgbToHsl,
  hslToHex,
  normalizeHex,
  colorDistance,
  hslColorDistance,
  luminance,
  deduplicateColors,
  paletteSimilarity,
  extractColorsFromCss,
  classifyColors,
  buildColorScale,
  COLOR_FUNCTION_AUDIT,
} from "../lib/canonical-color-engine.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Engine report
// ---------------------------------------------------------------------------

// GET /color-engine/report
router.get("/color-engine/report", (_req, res): void => {
  const exportedFunctions = [
    { name: "hexToRgb",           signature: "hexToRgb(hex: string): Rgb | null",                               category: "conversion" },
    { name: "rgbToHsl",           signature: "rgbToHsl(rgb: Rgb): Hsl",                                         category: "conversion" },
    { name: "hslToHex",           signature: "hslToHex(hsl: Hsl): string",                                      category: "conversion" },
    { name: "rgbToHex",           signature: "rgbToHex(rgb: Rgb): string",                                      category: "conversion" },
    { name: "normalizeHex",       signature: "normalizeHex(raw: string): string | null",                        category: "normalisation" },
    { name: "colorDistance",      signature: "colorDistance(a: Rgb, b: Rgb): number",                           category: "distance" },
    { name: "hslColorDistance",   signature: "hslColorDistance(a: Hsl, b: Hsl): number",                       category: "distance" },
    { name: "luminance",          signature: "luminance(rgb: Rgb): number",                                      category: "analysis" },
    { name: "deduplicateColors",  signature: "deduplicateColors(hexColors: string[], threshold?: number): ColorFrequency[]", category: "palette" },
    { name: "paletteSimilarity",  signature: "paletteSimilarity(source: string[], generated: string[]): number",category: "palette" },
    { name: "extractColorsFromCss",signature:"extractColorsFromCss(cssText: string): string[]",                  category: "extraction" },
    { name: "classifyColors",     signature: "classifyColors(colors: ColorFrequency[], total: number): ClassifiedPalette", category: "classification" },
    { name: "buildColorScale",    signature: "buildColorScale(seedHex: string): Record<string, string>",        category: "generation" },
    { name: "COLOR_FUNCTION_AUDIT",signature:"COLOR_FUNCTION_AUDIT: ColorFunctionDuplicate[]",                  category: "audit" },
  ];

  res.json({
    version:          "PS-1",
    generatedAt:      new Date().toISOString(),
    engine:           "canonical-color-engine.ts",
    description:      "Single source of truth for all color utilities across the pipeline",
    totalFunctions:   exportedFunctions.length,
    duplicatesRemoved: COLOR_FUNCTION_AUDIT.length,
    totalDuplicateInstances: COLOR_FUNCTION_AUDIT.reduce((sum, d) => sum + d.duplicatedIn.length, 0),
    consumersRefactored: [
      "visual-dna-engine.ts",
      "visual-fidelity-engine.ts",
      "visual-fidelity-scoring-engine-vr7.ts",
      "visual-reconstruction-engine.ts",
      "screenshot-visual-dna-engine.ts",
    ],
    categories: {
      conversion:     exportedFunctions.filter(f => f.category === "conversion").map(f => f.name),
      normalisation:  exportedFunctions.filter(f => f.category === "normalisation").map(f => f.name),
      distance:       exportedFunctions.filter(f => f.category === "distance").map(f => f.name),
      analysis:       exportedFunctions.filter(f => f.category === "analysis").map(f => f.name),
      palette:        exportedFunctions.filter(f => f.category === "palette").map(f => f.name),
      extraction:     exportedFunctions.filter(f => f.category === "extraction").map(f => f.name),
      classification: exportedFunctions.filter(f => f.category === "classification").map(f => f.name),
      generation:     exportedFunctions.filter(f => f.category === "generation").map(f => f.name),
    },
    exportedFunctions,
  });
});

// GET /color-engine/duplication
router.get("/color-engine/duplication", (_req, res): void => {
  const totalDuplicates = COLOR_FUNCTION_AUDIT.reduce((s, d) => s + d.duplicatedIn.length, 0);
  const affectedFiles   = [...new Set(COLOR_FUNCTION_AUDIT.flatMap(d => d.duplicatedIn))];

  res.json({
    version:           "PS-1",
    generatedAt:       new Date().toISOString(),
    summary:           `Found ${COLOR_FUNCTION_AUDIT.length} duplicated function groups across ${affectedFiles.length} files (${totalDuplicates} total duplicate instances)`,
    canonicalEngine:   "canonical-color-engine.ts",
    duplicateGroups:   COLOR_FUNCTION_AUDIT.length,
    totalInstances:    totalDuplicates,
    affectedFiles,
    duplicates:        COLOR_FUNCTION_AUDIT,
    migrationStatus:   "canonical engine created — consumers should import from canonical-color-engine.js",
  });
});

// GET /color-engine/functions
router.get("/color-engine/functions", (_req, res): void => {
  res.json({
    engine: "canonical-color-engine.ts",
    functions: COLOR_FUNCTION_AUDIT.map(f => ({ name: f.functionName, signature: f.signature, consolidatedFrom: f.duplicatedIn.length })),
  });
});

// ---------------------------------------------------------------------------
// Live color utilities
// ---------------------------------------------------------------------------

// POST /color-engine/palette  { colors: string[] }
router.post("/color-engine/palette", (req, res): void => {
  const colors: unknown = req.body?.colors;
  if (!Array.isArray(colors) || colors.some(c => typeof c !== "string")) {
    res.status(400).json({ error: "Body must be { colors: string[] } of hex values" });
    return;
  }
  const deduped    = deduplicateColors(colors as string[]);
  const classified = classifyColors(deduped, colors.length);
  res.json({
    input:      colors.length,
    deduped:    deduped.length,
    classified,
    frequencies: deduped.slice(0, 20),
  });
});

// POST /color-engine/similarity  { source: string[], generated: string[] }
router.post("/color-engine/similarity", (req, res): void => {
  const { source, generated } = req.body ?? {};
  if (!Array.isArray(source) || !Array.isArray(generated)) {
    res.status(400).json({ error: "Body must be { source: string[], generated: string[] }" });
    return;
  }
  const score = paletteSimilarity(source as string[], generated as string[]);
  res.json({ score, sourceColors: source.length, generatedColors: generated.length });
});

// POST /color-engine/extract  { css: string }
router.post("/color-engine/extract", (req, res): void => {
  const css: unknown = req.body?.css;
  if (typeof css !== "string") {
    res.status(400).json({ error: "Body must be { css: string }" });
    return;
  }
  const raw        = extractColorsFromCss(css);
  const deduped    = deduplicateColors(raw);
  const classified = classifyColors(deduped, raw.length);
  res.json({ rawCount: raw.length, dedupedCount: deduped.length, classified, topColors: deduped.slice(0, 10) });
});

// GET /color-engine/scale/:hex
router.get("/color-engine/scale/:hex", (req, res): void => {
  const rawHex = `#${req.params["hex"]?.replace(/^#/, "") ?? ""}`;
  const rgb    = hexToRgb(rawHex);
  if (!rgb) {
    res.status(400).json({ error: `Invalid hex color: ${rawHex}` });
    return;
  }
  const hsl   = rgbToHsl(rgb);
  const scale = buildColorScale(rawHex);
  res.json({
    input:     rawHex,
    rgb,
    hsl,
    luminance: parseFloat(luminance(rgb).toFixed(2)),
    scale,
  });
});

// GET /color-engine/analyze/:hex
router.get("/color-engine/analyze/:hex", (req, res): void => {
  const rawHex = `#${req.params["hex"]?.replace(/^#/, "") ?? ""}`;
  const rgb    = hexToRgb(rawHex);
  if (!rgb) {
    res.status(400).json({ error: `Invalid hex color: ${rawHex}` });
    return;
  }
  const hsl  = rgbToHsl(rgb);
  const norm = normalizeHex(rawHex);
  res.json({
    input:        rawHex,
    normalized:   norm,
    rgb,
    hsl,
    hex:          hslToHex(hsl),
    luminance:    parseFloat(luminance(rgb).toFixed(2)),
    isDark:       luminance(rgb) < 128,
    isHighSat:    hsl.s > 60,
  });
});

export default router;
