/**
 * pixel-comparison-engine.ts  — PF-1
 *
 * Pixel-level visual comparison using perceptual similarity (SSIM + pixelmatch).
 *
 * Compares:  original screenshot  vs  generated Website Prime screenshot
 *
 * Measures per region:
 *   layout · whitespace · typography · images · navigation · sections
 *
 * Outputs written to disk + uploaded to R2:
 *   pixel-comparison-report.json
 *   perceptual-score.json
 *   heatmap-overlay.png
 */

import { writeFile }         from "fs/promises";
import { join }              from "path";
import { logger }            from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RegionName =
  | "full_layout"
  | "navigation"
  | "header"
  | "main_content"
  | "footer"
  | "whitespace"
  | "typography"
  | "images"
  | "sections";

export interface RegionScore {
  region:    RegionName;
  ssim:      number;          // 0–1 (1 = identical)
  mismatchPx: number;         // pixels that differ (pixelmatch)
  mismatchPct: number;        // 0–100
  grade:     "A" | "B" | "C" | "D" | "F";
}

export interface PixelComparisonReport {
  schemaVersion:    "PF-1";
  sourceJobId:      string;
  generatedJobId:   string;
  generatedAt:      string;
  durationMs:       number;
  viewport:         { width: number; height: number };
  sourcePage:       string | null;
  generatedPage:    string | null;
  overallSsim:      number;
  overallGrade:     "A" | "B" | "C" | "D" | "F";
  totalMismatchPct: number;
  regions:          RegionScore[];
  r2Keys: {
    report:        string | null;
    perceptualScore: string | null;
    heatmap:       string | null;
  };
  notes:            string[];
}

export interface PerceptualScore {
  schemaVersion: "PF-1";
  sourceJobId:   string;
  generatedJobId: string;
  generatedAt:   string;
  scores: {
    layout:     number;
    whitespace: number;
    typography: number;
    images:     number;
    navigation: number;
    sections:   number;
    overall:    number;
  };
  grades: {
    layout:     string;
    whitespace: string;
    typography: string;
    images:     string;
    navigation: string;
    sections:   string;
    overall:    string;
  };
  interpretation: string;
}

export interface ComparisonOptions {
  sourceJobId:    string;
  generatedJobId: string;
  /** R2 key of the source screenshot (overrides auto-discovery) */
  sourceKey?:     string;
  /** R2 key of the generated screenshot (overrides auto-discovery) */
  generatedKey?:  string;
  /** pixelmatch threshold 0–1, default 0.1 */
  threshold?:     number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const OUT_DIR = process.cwd();

function gradeFromSsim(ssim: number): "A" | "B" | "C" | "D" | "F" {
  if (ssim >= 0.90) return "A";
  if (ssim >= 0.75) return "B";
  if (ssim >= 0.60) return "C";
  if (ssim >= 0.45) return "D";
  return "F";
}

async function writeDisk(filename: string, data: unknown): Promise<void> {
  await writeFile(join(OUT_DIR, filename), JSON.stringify(data, null, 2), "utf8");
}

async function writeBinaryDisk(filename: string, buf: Buffer): Promise<void> {
  await writeFile(join(OUT_DIR, filename), buf);
}

async function uploadR2(key: string, data: Buffer, contentType: string): Promise<boolean> {
  try {
    const provider = getDefaultCloudProvider();
    if (!provider.isConfigured()) return false;
    await provider.upload({ key, data, contentType });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SSIM computation (pure TypeScript, no native deps)
//
// Computes Mean SSIM over the luminance channel of a rectangular region.
// Formula: SSIM(x,y) = (2μxμy + C1)(2σxy + C2) / ((μx²+μy²+C1)(σx²+σy²+C2))
// ---------------------------------------------------------------------------

const C1 = 6.5025;   // (0.01 * 255)²
const C2 = 58.5225;  // (0.03 * 255)²

/**
 * Extract luminance values for a rectangular region from RGBA pixel data.
 * data: flat Uint8Array / Buffer in RGBA order, width × height pixels total.
 */
function extractLuma(
  data:   Uint8Array | Buffer,
  imgW:   number,
  x0: number, y0: number,
  rW: number, rH: number,
): Float32Array {
  const luma = new Float32Array(rW * rH);
  let idx = 0;
  for (let y = y0; y < y0 + rH; y++) {
    for (let x = x0; x < x0 + rW; x++) {
      const p = (y * imgW + x) * 4;
      // ITU-R BT.709 luma: 0.2126 R + 0.7152 G + 0.0722 B
      luma[idx++] = 0.2126 * (data[p]!) + 0.7152 * (data[p + 1]!) + 0.0722 * (data[p + 2]!);
    }
  }
  return luma;
}

function computeSsimFromArrays(a: Float32Array, b: Float32Array): number {
  const n = a.length;
  if (n === 0) return 1;

  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) { sumA += a[i]!; sumB += b[i]!; }
  const muA = sumA / n;
  const muB = sumB / n;

  let varA = 0, varB = 0, cov = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - muA;
    const db = b[i]! - muB;
    varA += da * da;
    varB += db * db;
    cov  += da * db;
  }
  varA /= n; varB /= n; cov /= n;

  const num = (2 * muA * muB + C1) * (2 * cov + C2);
  const den = (muA * muA + muB * muB + C1) * (varA + varB + C2);
  return den === 0 ? 1 : Math.max(0, Math.min(1, num / den));
}

/** Compute SSIM for a sub-region by pixel row/col bounds. */
function ssimForRegion(
  aData: Uint8Array | Buffer, bData: Uint8Array | Buffer,
  imgW: number,
  x0: number, y0: number,
  rW: number, rH: number,
): number {
  const lumaA = extractLuma(aData, imgW, x0, y0, rW, rH);
  const lumaB = extractLuma(bData, imgW, x0, y0, rW, rH);
  return computeSsimFromArrays(lumaA, lumaB);
}

// ---------------------------------------------------------------------------
// Region definitions (fractions of image height)
// ---------------------------------------------------------------------------

interface RegionDef {
  name:    RegionName;
  y0Frac:  number;   // start Y as fraction of height
  hFrac:   number;   // height as fraction of height
  x0Frac?: number;   // start X fraction (default 0)
  wFrac?:  number;   // width fraction (default 1)
}

const REGION_DEFS: RegionDef[] = [
  { name: "navigation",   y0Frac: 0.00, hFrac: 0.12 },
  { name: "header",       y0Frac: 0.00, hFrac: 0.30 },
  { name: "main_content", y0Frac: 0.15, hFrac: 0.70 },
  { name: "footer",       y0Frac: 0.85, hFrac: 0.15 },
  { name: "full_layout",  y0Frac: 0.00, hFrac: 1.00 },
  // Thematic regions — approximated structurally
  { name: "whitespace",   y0Frac: 0.10, hFrac: 0.80 },   // body centre (excludes nav/footer chrome)
  { name: "typography",   y0Frac: 0.15, hFrac: 0.55 },   // main text band
  { name: "images",       y0Frac: 0.00, hFrac: 0.60 },   // upper portion (images tend to be here)
  { name: "sections",     y0Frac: 0.20, hFrac: 0.65 },   // section content band
];

// ---------------------------------------------------------------------------
// Heatmap generation using pixelmatch diff output → pngjs PNG
// ---------------------------------------------------------------------------

async function buildHeatmap(
  aData: Uint8Array | Buffer,
  bData: Uint8Array | Buffer,
  width:  number,
  height: number,
  threshold: number,
): Promise<{ buf: Buffer; mismatchPx: number }> {
  const pixelmatch = (await import("pixelmatch") as unknown) as (
    img1: Uint8ClampedArray, img2: Uint8ClampedArray,
    output: Uint8ClampedArray | null,
    width: number, height: number,
    options?: { threshold?: number; includeAA?: boolean; alpha?: number; aaColor?: number[]; diffColor?: number[] },
  ) => number;
  const { PNG } = await import("pngjs");

  const diffData = new Uint8ClampedArray(width * height * 4);

  const mismatchPx = pixelmatch(
    new Uint8ClampedArray(aData.buffer, aData.byteOffset, aData.byteLength),
    new Uint8ClampedArray(bData.buffer, bData.byteOffset, bData.byteLength),
    diffData,
    width,
    height,
    { threshold, includeAA: true, alpha: 0.15, aaColor: [255, 165, 0], diffColor: [255, 0, 0] },
  );

  // Composite: blend original (greyscale) with diff highlights
  const heatmapPng = new PNG({ width, height });
  for (let i = 0; i < width * height * 4; i += 4) {
    const luma = Math.round(
      0.2126 * (aData[i]!) + 0.7152 * (aData[i + 1]!) + 0.0722 * (aData[i + 2]!),
    );
    const dr = diffData[i]!;
    const dg = diffData[i + 1]!;
    const db = diffData[i + 2]!;

    // If diff shows a mismatch (high red, low green/blue), keep diff colour; else show greyscale original
    const isDiff = dr > 150 && dg < 100 && db < 100;
    heatmapPng.data[i]     = isDiff ? dr   : luma;
    heatmapPng.data[i + 1] = isDiff ? dg   : luma;
    heatmapPng.data[i + 2] = isDiff ? db   : luma;
    heatmapPng.data[i + 3] = 255;
  }

  const buf = PNG.sync.write(heatmapPng);
  return { buf: Buffer.from(buf), mismatchPx };
}

// ---------------------------------------------------------------------------
// Screenshot discovery
// ---------------------------------------------------------------------------

async function discoverScreenshot(
  provider: ReturnType<typeof getDefaultCloudProvider>,
  jobId:    string,
  nodeIdHint = "home",
): Promise<{ key: string; buf: Buffer } | null> {
  // Try common R2 paths: desktop screenshot of home/index page
  const candidates = [
    `jobs/${jobId}/screenshots/desktop/${nodeIdHint}.png`,
    `jobs/${jobId}/screenshots/desktop/0.png`,
    `jobs/${jobId}/screenshots/desktop/index.png`,
    `jobs/${jobId}/screenshots/desktop/root.png`,
    `jobs/${jobId}/screenshots/desktop/page-0.png`,
  ];
  for (const key of candidates) {
    try {
      const buf = await provider.download(key);
      if (buf && buf.length > 4096) return { key, buf };
    } catch { /* try next */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parse PNG → dimensions + raw RGBA data
// ---------------------------------------------------------------------------

async function parsePng(
  buf: Buffer,
): Promise<{ width: number; height: number; data: Buffer } | null> {
  try {
    const { PNG } = await import("pngjs");
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: Buffer.from(png.data) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Resize/crop both images to the minimum shared dimension
// ---------------------------------------------------------------------------

function cropToMinDimensions(
  aImg: { width: number; height: number; data: Buffer },
  bImg: { width: number; height: number; data: Buffer },
): { aData: Buffer; bData: Buffer; width: number; height: number } {
  const width  = Math.min(aImg.width,  bImg.width);
  const height = Math.min(aImg.height, bImg.height);

  function cropData(img: typeof aImg): Buffer {
    if (img.width === width && img.height === height) return img.data;
    const out = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      const srcOff = y * img.width * 4;
      const dstOff = y * width * 4;
      img.data.copy(out, dstOff, srcOff, srcOff + width * 4);
    }
    return out;
  }

  return { aData: cropData(aImg), bData: cropData(bImg), width, height };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runPixelComparison(
  opts: ComparisonOptions,
): Promise<{
  report:          PixelComparisonReport;
  perceptualScore: PerceptualScore;
  heatmapPng:      Buffer | null;
}> {
  const { sourceJobId, generatedJobId, threshold = 0.1 } = opts;
  const t0    = msNow();
  const notes: string[] = [];

  logger.info({ sourceJobId, generatedJobId }, "PF-1: starting pixel comparison");

  const provider = getDefaultCloudProvider();

  // ── Download screenshots ──────────────────────────────────────────────────
  let sourcePng:    { key: string; buf: Buffer } | null = null;
  let generatedPng: { key: string; buf: Buffer } | null = null;

  if (opts.sourceKey) {
    const buf = await provider.download(opts.sourceKey).catch(() => null);
    if (buf) sourcePng = { key: opts.sourceKey, buf };
  } else {
    sourcePng = await discoverScreenshot(provider, sourceJobId);
  }

  if (opts.generatedKey) {
    const buf = await provider.download(opts.generatedKey).catch(() => null);
    if (buf) generatedPng = { key: opts.generatedKey, buf };
  } else {
    generatedPng = await discoverScreenshot(provider, generatedJobId);
  }

  const r2Base = `jobs/${sourceJobId}/pixel-comparison`;

  // ── If screenshots unavailable, produce a "no data" report ───────────────
  if (!sourcePng || !generatedPng) {
    if (!sourcePng)    notes.push(`Source screenshot not found in R2 for job "${sourceJobId}"`);
    if (!generatedPng) notes.push(`Generated screenshot not found in R2 for job "${generatedJobId}"`);

    const emptyReport: PixelComparisonReport = {
      schemaVersion:    "PF-1",
      sourceJobId,
      generatedJobId,
      generatedAt:      new Date().toISOString(),
      durationMs:       msNow() - t0,
      viewport:         { width: 0, height: 0 },
      sourcePage:       null,
      generatedPage:    null,
      overallSsim:      0,
      overallGrade:     "F",
      totalMismatchPct: 100,
      regions:          [],
      r2Keys:           { report: null, perceptualScore: null, heatmap: null },
      notes,
    };
    const emptyPerceptual: PerceptualScore = {
      schemaVersion:  "PF-1",
      sourceJobId,
      generatedJobId,
      generatedAt:    new Date().toISOString(),
      scores: { layout: 0, whitespace: 0, typography: 0, images: 0, navigation: 0, sections: 0, overall: 0 },
      grades: { layout: "F", whitespace: "F", typography: "F", images: "F", navigation: "F", sections: "F", overall: "F" },
      interpretation: "Screenshots unavailable — run VR-1 screenshot capture first",
    };
    await writeDisk("pixel-comparison-report.json", emptyReport);
    await writeDisk("perceptual-score.json",        emptyPerceptual);
    return { report: emptyReport, perceptualScore: emptyPerceptual, heatmapPng: null };
  }

  // ── Parse PNGs ─────────────────────────────────────────────────────────────
  const [srcImg, genImg] = await Promise.all([
    parsePng(sourcePng.buf),
    parsePng(generatedPng.buf),
  ]);

  if (!srcImg || !genImg) {
    notes.push("Failed to decode one or both PNG screenshots");
    const failReport: PixelComparisonReport = {
      schemaVersion:    "PF-1",
      sourceJobId, generatedJobId,
      generatedAt:      new Date().toISOString(),
      durationMs:       msNow() - t0,
      viewport:         { width: srcImg?.width ?? 0, height: srcImg?.height ?? 0 },
      sourcePage:       sourcePng.key,
      generatedPage:    generatedPng.key,
      overallSsim:      0, overallGrade: "F", totalMismatchPct: 100,
      regions: [], r2Keys: { report: null, perceptualScore: null, heatmap: null },
      notes,
    };
    await writeDisk("pixel-comparison-report.json", failReport);
    return { report: failReport, perceptualScore: buildPerceptualScore(sourceJobId, generatedJobId, []), heatmapPng: null };
  }

  if (srcImg.width !== genImg.width || srcImg.height !== genImg.height) {
    notes.push(`Dimension mismatch: source ${srcImg.width}×${srcImg.height} vs generated ${genImg.width}×${genImg.height}. Cropping to minimum.`);
  }

  const { aData, bData, width, height } = cropToMinDimensions(srcImg, genImg);

  // ── Compute per-region SSIM ───────────────────────────────────────────────
  const regionScores: RegionScore[] = [];

  for (const def of REGION_DEFS) {
    const x0 = Math.floor((def.x0Frac ?? 0)  * width);
    const y0 = Math.floor(def.y0Frac          * height);
    const rW = Math.floor((def.wFrac  ?? 1)   * width);
    const rH = Math.max(1, Math.floor(def.hFrac * height));

    // Clamp to image bounds
    const clampedW = Math.min(rW, width  - x0);
    const clampedH = Math.min(rH, height - y0);
    if (clampedW <= 0 || clampedH <= 0) continue;

    const ssim = ssimForRegion(aData, bData, width, x0, y0, clampedW, clampedH);
    // Approximate mismatch pixels from SSIM (1 - ssim) × region area
    const regionPx   = clampedW * clampedH;
    const mismatchPx  = Math.round((1 - ssim) * regionPx);
    const mismatchPct = Math.round(mismatchPx / regionPx * 1000) / 10;

    regionScores.push({
      region:     def.name,
      ssim:       Math.round(ssim * 1000) / 1000,
      mismatchPx,
      mismatchPct,
      grade:      gradeFromSsim(ssim),
    });
  }

  // ── Build heatmap ─────────────────────────────────────────────────────────
  let heatmapBuf: Buffer | null = null;
  let totalMismatchPx = 0;
  try {
    const { buf, mismatchPx } = await buildHeatmap(aData, bData, width, height, threshold);
    heatmapBuf      = buf;
    totalMismatchPx = mismatchPx;
  } catch (err) {
    notes.push(`Heatmap generation failed: ${err instanceof Error ? err.message : String(err)}`);
    // Fallback: estimate from full-layout SSIM
    const full = regionScores.find((r) => r.region === "full_layout");
    totalMismatchPx = full?.mismatchPx ?? 0;
  }

  // ── Aggregate scores ───────────────────────────────────────────────────────
  const getScore = (name: RegionName): number =>
    regionScores.find((r) => r.region === name)?.ssim ?? 0;

  const overallSsim = getScore("full_layout");
  const totalPx     = width * height;
  const totalMismatchPct = Math.round(totalMismatchPx / totalPx * 1000) / 10;

  // ── Upload to R2 ──────────────────────────────────────────────────────────
  const r2Keys = {
    report:         `${r2Base}/pixel-comparison-report.json`,
    perceptualScore: `${r2Base}/perceptual-score.json`,
    heatmap:         `${r2Base}/heatmap-overlay.png`,
  };

  const perceptualScore = buildPerceptualScore(sourceJobId, generatedJobId, regionScores);

  const report: PixelComparisonReport = {
    schemaVersion:    "PF-1",
    sourceJobId,
    generatedJobId,
    generatedAt:      new Date().toISOString(),
    durationMs:       msNow() - t0,
    viewport:         { width, height },
    sourcePage:       sourcePng.key,
    generatedPage:    generatedPng.key,
    overallSsim:      Math.round(overallSsim * 1000) / 1000,
    overallGrade:     gradeFromSsim(overallSsim),
    totalMismatchPct,
    regions:          regionScores,
    r2Keys:           { report: null, perceptualScore: null, heatmap: null },
    notes,
  };

  // Write disk
  await writeDisk("pixel-comparison-report.json", report);
  await writeDisk("perceptual-score.json",        perceptualScore);
  if (heatmapBuf) await writeBinaryDisk("heatmap-overlay.png", heatmapBuf);

  // Upload R2
  const [u1, u2, u3] = await Promise.all([
    uploadR2(r2Keys.report,         Buffer.from(JSON.stringify(report, null, 2)),         "application/json"),
    uploadR2(r2Keys.perceptualScore, Buffer.from(JSON.stringify(perceptualScore, null, 2)), "application/json"),
    heatmapBuf ? uploadR2(r2Keys.heatmap, heatmapBuf, "image/png") : Promise.resolve(false),
  ]);

  report.r2Keys = {
    report:          u1 ? r2Keys.report          : null,
    perceptualScore: u2 ? r2Keys.perceptualScore : null,
    heatmap:         u3 ? r2Keys.heatmap         : null,
  };

  // Re-write with populated r2Keys
  await writeDisk("pixel-comparison-report.json", report);

  logger.info({
    sourceJobId, generatedJobId,
    overallSsim, overallGrade: report.overallGrade,
    totalMismatchPct,
  }, "PF-1: pixel comparison complete");

  return { report, perceptualScore, heatmapPng: heatmapBuf };
}

// ---------------------------------------------------------------------------
// Helper: build PerceptualScore from region results
// ---------------------------------------------------------------------------

function buildPerceptualScore(
  sourceJobId:   string,
  generatedJobId: string,
  regions:        RegionScore[],
): PerceptualScore {
  const get = (name: RegionName): number =>
    regions.find((r) => r.region === name)?.ssim ?? 0;

  const layout     = get("full_layout");
  const whitespace = get("whitespace");
  const typography = get("typography");
  const images     = get("images");
  const navigation = get("navigation");
  const sections   = get("sections");

  const overall = regions.length > 0
    ? Math.round(
        (layout * 0.30 + whitespace * 0.10 + typography * 0.20 +
         images  * 0.15 + navigation * 0.10 + sections  * 0.15) * 1000,
      ) / 1000
    : 0;

  const g = gradeFromSsim;
  const interpretation = overall >= 0.90
    ? "Excellent pixel-level fidelity — generated site closely mirrors the original"
    : overall >= 0.75
    ? "Good fidelity — minor visual differences in some regions"
    : overall >= 0.60
    ? "Moderate fidelity — notable layout or style divergence detected"
    : overall >= 0.45
    ? "Poor fidelity — significant visual mismatch; reconstruction needs refinement"
    : regions.length === 0
    ? "No screenshot data available"
    : "Very poor fidelity — fundamental layout differences detected";

  return {
    schemaVersion:  "PF-1",
    sourceJobId,
    generatedJobId,
    generatedAt:    new Date().toISOString(),
    scores:  { layout, whitespace, typography, images, navigation, sections, overall },
    grades:  {
      layout:     g(layout),
      whitespace: g(whitespace),
      typography: g(typography),
      images:     g(images),
      navigation: g(navigation),
      sections:   g(sections),
      overall:    g(overall),
    },
    interpretation,
  };
}

function msNow(): number { return Date.now(); }
