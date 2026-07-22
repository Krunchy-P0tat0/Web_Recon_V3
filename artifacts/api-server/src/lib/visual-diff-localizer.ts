/**
 * visual-diff-localizer.ts  — PF-2
 *
 * Automatically locates visual mismatches between source and generated screenshots.
 *
 * Identifies:
 *   spacing · typography · image placement · component sizing ·
 *   alignment · color differences · navigation differences
 *
 * Approach:
 *   1. Divide both images into a NxM grid of cells
 *   2. Compute per-cell SSIM, colour delta, edge density
 *   3. Cluster adjacent failing cells into "blobs" via connected components
 *   4. Classify each blob by dominant signal type + spatial position heuristics
 *   5. Assign severity (critical/high/medium/low) and confidence (0–1)
 *
 * Outputs (disk + R2):
 *   visual-diff-map.json
 *   difference-heatmap.json
 *   component-error-report.json
 */

import { writeFile }         from "fs/promises";
import { join }              from "path";
import { logger }            from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import type { PixelComparisonReport, RegionScore } from "./pixel-comparison-engine.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type VisualDiffType =
  | "spacing"
  | "typography"
  | "image_placement"
  | "component_sizing"
  | "alignment"
  | "color_difference"
  | "navigation"
  | "section_mismatch";

export type IssueSeverity = "critical" | "high" | "medium" | "low";

export interface IssueLocation {
  xPct:      number;   // 0–100 from left
  yPct:      number;   // 0–100 from top
  widthPct:  number;
  heightPct: number;
  /** Pixel coordinates (when screenshots available) */
  xPx?:     number;
  yPx?:     number;
  wPx?:     number;
  hPx?:     number;
}

export interface VisualDiffIssue {
  id:             string;
  type:           VisualDiffType;
  severity:       IssueSeverity;
  confidence:     number;          // 0–1
  location:       IssueLocation;
  description:    string;
  affectedPixels: number;
  ssimDelta:      number;          // drop from 1.0 in this region
  colorDelta:     number;          // mean absolute colour diff (0–255)
  edgeDensity:    number;          // 0–1; high = text/edges present
  suggestedFix:   string;
}

export interface VisualDiffMap {
  schemaVersion:  "PF-2";
  sourceJobId:    string;
  generatedJobId: string;
  generatedAt:    string;
  durationMs:     number;
  imageSize:      { width: number; height: number } | null;
  grid:           { cols: number; rows: number };
  totalIssues:    number;
  issuesBySeverity: Record<IssueSeverity, number>;
  issuesByType:   Record<VisualDiffType, number>;
  issues:         VisualDiffIssue[];
  r2Keys:         { diffMap: string | null; heatmap: string | null; errorReport: string | null };
}

export interface DifferenceHeatmap {
  schemaVersion:  "PF-2";
  sourceJobId:    string;
  generatedJobId: string;
  generatedAt:    string;
  /** Flat row-major grid of normalised diff intensity 0–100, cols×rows cells */
  gridCols:       number;
  gridRows:       number;
  cells:          Array<{
    col:       number;
    row:       number;
    ssim:      number;       // 0–1
    colorDelta: number;      // 0–255
    edgeDelta:  number;      // 0–255
    intensity:  number;      // 0–100 composite diff score
    issueType:  VisualDiffType | "clean";
  }>;
}

export interface ComponentError {
  componentId:   string;
  componentType: VisualDiffType;
  severity:      IssueSeverity;
  confidence:    number;
  location:      IssueLocation;
  description:   string;
  suggestedFix:  string;
  estimatedGain: number;   // expected SSIM improvement 0–1 if fixed
}

export interface ComponentErrorReport {
  schemaVersion:   "PF-2";
  sourceJobId:     string;
  generatedJobId:  string;
  generatedAt:     string;
  durationMs:      number;
  totalComponents: number;
  criticalCount:   number;
  highCount:       number;
  mediumCount:     number;
  lowCount:        number;
  components:      ComponentError[];
  topPriorityFixes: string[];
}

export interface LocalizerOptions {
  sourceJobId:    string;
  generatedJobId: string;
  /** Override: source screenshot R2 key */
  sourceKey?:     string;
  /** Override: generated screenshot R2 key */
  generatedKey?:  string;
  /** Grid columns (default 16) */
  gridCols?:      number;
  /** Grid rows (default 12) */
  gridRows?:      number;
  /**
   * Pre-computed PF-1 report — used as fallback when screenshots unavailable.
   * When provided and screenshots are absent, issues are derived from region SSIMs.
   */
  pf1Report?:     PixelComparisonReport;
  /** Cell SSIM threshold below which a cell is "failing" (default 0.85) */
  failThreshold?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OUT_DIR   = process.cwd();
const GRID_COLS = 16;
const GRID_ROWS = 12;

// SSIM thresholds for severity
const SSIM_CRITICAL = 0.40;
const SSIM_HIGH     = 0.60;
const SSIM_MEDIUM   = 0.80;
// >= 0.80 → low (still differs slightly)

// ---------------------------------------------------------------------------
// Internal: pixel helpers
// ---------------------------------------------------------------------------

/** Extract RGBA data for a cell from a flat RGBA buffer */
function cellData(
  buf: Buffer,
  imgW: number,
  c0: number, r0: number,
  cW: number, cH: number,
): Buffer {
  const out = Buffer.alloc(cW * cH * 4);
  for (let r = 0; r < cH; r++) {
    const srcOff = ((r0 + r) * imgW + c0) * 4;
    const dstOff = r * cW * 4;
    buf.copy(out, dstOff, srcOff, srcOff + cW * 4);
  }
  return out;
}

/** Mean absolute difference for single channel across two RGBA bufs */
function meanAbsChannelDiff(a: Buffer, b: Buffer, ch: number): number {
  let sum = 0;
  const n = Math.floor(a.length / 4);
  for (let i = 0; i < n; i++) {
    sum += Math.abs((a[i * 4 + ch]!) - (b[i * 4 + ch]!));
  }
  return n > 0 ? sum / n : 0;
}

/** Mean colour delta (Euclidean RGB) */
function meanColorDelta(a: Buffer, b: Buffer): number {
  let sum = 0;
  const n = Math.floor(a.length / 4);
  for (let i = 0; i < n; i++) {
    const dr = (a[i * 4]!)     - (b[i * 4]!);
    const dg = (a[i * 4 + 1]!) - (b[i * 4 + 1]!);
    const db = (a[i * 4 + 2]!) - (b[i * 4 + 2]!);
    sum += Math.sqrt(dr * dr + dg * dg + db * db) / Math.sqrt(3 * 255 * 255) * 255;
  }
  return n > 0 ? sum / n : 0;
}

/** Approximate edge density using horizontal/vertical gradient */
function edgeDensity(buf: Buffer, w: number, h: number): number {
  if (w < 2 || h < 2) return 0;
  let sum = 0;
  let count = 0;
  for (let r = 0; r < h - 1; r++) {
    for (let c = 0; c < w - 1; c++) {
      const idx = (r * w + c) * 4;
      const L00 = 0.2126 * buf[idx]! + 0.7152 * buf[idx + 1]! + 0.0722 * buf[idx + 2]!;
      const L10 = 0.2126 * buf[idx + 4]! + 0.7152 * buf[idx + 5]! + 0.0722 * buf[idx + 6]!;
      const L01 = 0.2126 * buf[idx + w * 4]! + 0.7152 * buf[idx + w * 4 + 1]! + 0.0722 * buf[idx + w * 4 + 2]!;
      sum += Math.abs(L10 - L00) + Math.abs(L01 - L00);
      count++;
    }
  }
  return count > 0 ? Math.min(1, (sum / count) / 255) : 0;
}

/** Luminance SSIM between two same-size RGBA bufs */
function ssimBuffers(a: Buffer, b: Buffer): number {
  const n = Math.floor(a.length / 4);
  if (n === 0) return 1;
  const lumaA = new Float32Array(n);
  const lumaB = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lumaA[i] = 0.2126 * a[i * 4]! + 0.7152 * a[i * 4 + 1]! + 0.0722 * a[i * 4 + 2]!;
    lumaB[i] = 0.2126 * b[i * 4]! + 0.7152 * b[i * 4 + 1]! + 0.0722 * b[i * 4 + 2]!;
  }
  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) { sumA += lumaA[i]!; sumB += lumaB[i]!; }
  const muA = sumA / n, muB = sumB / n;
  let varA = 0, varB = 0, cov = 0;
  for (let i = 0; i < n; i++) {
    const da = lumaA[i]! - muA; const db = lumaB[i]! - muB;
    varA += da * da; varB += db * db; cov += da * db;
  }
  varA /= n; varB /= n; cov /= n;
  const C1 = 6.5025, C2 = 58.5225;
  const num = (2 * muA * muB + C1) * (2 * cov + C2);
  const den = (muA * muA + muB * muB + C1) * (varA + varB + C2);
  return den === 0 ? 1 : Math.max(0, Math.min(1, num / den));
}

// ---------------------------------------------------------------------------
// Issue classification heuristics
// ---------------------------------------------------------------------------

function classifyCell(
  col: number, row: number, cols: number, rows: number,
  ssim: number, colorDelta: number, edgeA: number, edgeB: number,
): VisualDiffType {
  const yFrac = row / rows;
  const edgeDiff = Math.abs(edgeA - edgeB);

  // Position-based: navigation bar (top 12%)
  if (yFrac < 0.12) return "navigation";

  // Bottom strip: footer / navigation at bottom
  if (yFrac > 0.88) return "section_mismatch";

  // High colour delta with similar edge structure → colour difference
  if (colorDelta > 40 && edgeDiff < 0.15) return "color_difference";

  // High edge density in both + big diff → typography mismatch
  if (edgeA > 0.3 && edgeB > 0.3 && edgeDiff > 0.2) return "typography";

  // One has edges, other doesn't → image placement or component
  if (edgeA > 0.25 && edgeB < 0.10) return "image_placement";
  if (edgeB > 0.25 && edgeA < 0.10) return "component_sizing";

  // Both have similar edge density but big SSIM drop → alignment offset
  if (edgeDiff < 0.10 && ssim < 0.60) return "alignment";

  // Low edge density in both, medium diff → spacing
  if (edgeA < 0.15 && edgeB < 0.15) return "spacing";

  // Fallback
  return "section_mismatch";
}

function severityFromSsim(ssim: number): IssueSeverity {
  if (ssim < SSIM_CRITICAL) return "critical";
  if (ssim < SSIM_HIGH)     return "high";
  if (ssim < SSIM_MEDIUM)   return "medium";
  return "low";
}

function confidenceFromSignals(
  ssim: number, colorDelta: number, edgeDiff: number,
): number {
  // Low SSIM → more confident something is wrong
  const ssimConf    = 1 - ssim;
  const colorConf   = Math.min(1, colorDelta / 100);
  const edgeConf    = Math.min(1, edgeDiff * 3);
  const raw = (ssimConf * 0.5 + colorConf * 0.3 + edgeConf * 0.2);
  return Math.round(Math.min(1, raw) * 100) / 100;
}

function describeIssue(type: VisualDiffType, severity: IssueSeverity, yFrac: number): string {
  const zone = yFrac < 0.15 ? "header" : yFrac > 0.80 ? "footer" : "body";
  const severityLabel = severity === "critical" ? "Critical" : severity === "high" ? "Significant" : severity === "medium" ? "Moderate" : "Minor";
  const descs: Record<VisualDiffType, string> = {
    spacing:          `${severityLabel} spacing mismatch in ${zone} — margins or padding differ from source`,
    typography:       `${severityLabel} typography difference in ${zone} — font size, weight, or line-height diverges`,
    image_placement:  `${severityLabel} image placement issue in ${zone} — image position or dimensions don't match`,
    component_sizing: `${severityLabel} component sizing mismatch in ${zone} — element is undersized or oversized`,
    alignment:        `${severityLabel} alignment offset in ${zone} — content is horizontally or vertically shifted`,
    color_difference: `${severityLabel} colour mismatch in ${zone} — palette or tone differs from source`,
    navigation:       `${severityLabel} navigation difference — nav bar layout, items, or styling diverge`,
    section_mismatch: `${severityLabel} section structure mismatch — section boundaries or order differ`,
  };
  return descs[type];
}

function suggestFix(type: VisualDiffType): string {
  const fixes: Record<VisualDiffType, string> = {
    spacing:          "Apply spacing RuleAdjustment to override padding/margin scale tokens",
    typography:       "Apply typography RuleAdjustment to align font families and size scale",
    image_placement:  "Apply images RuleAdjustment to correct alt-text, sizing and layout of image blocks",
    component_sizing: "Apply component_placement RuleAdjustment to fix element dimensions",
    alignment:        "Apply layout RuleAdjustment to reorder or anchor sections correctly",
    color_difference: "Apply colors RuleAdjustment to override primary, background and accent palette",
    navigation:       "Apply navigation RuleAdjustment to correct nav placement and structure",
    section_mismatch: "Apply layout RuleAdjustment to restructure page sections in canonical order",
  };
  return fixes[type];
}

// ---------------------------------------------------------------------------
// Connected-component blob detection on failing cells
// ---------------------------------------------------------------------------

interface Cell {
  col: number; row: number;
  ssim: number; colorDelta: number;
  edgeA: number; edgeB: number;
  type: VisualDiffType;
  intensity: number;
  failing: boolean;
}

function findBlobs(cells: Cell[], cols: number, rows: number): Cell[][] {
  const visited = new Set<number>();
  const blobs: Cell[][] = [];
  const key = (c: number, r: number) => r * cols + c;

  for (const cell of cells) {
    if (!cell.failing) continue;
    const k = key(cell.col, cell.row);
    if (visited.has(k)) continue;

    // BFS
    const blob: Cell[] = [];
    const queue = [cell];
    visited.add(k);

    while (queue.length > 0) {
      const cur = queue.shift()!;
      blob.push(cur);
      const neighbours = [
        { col: cur.col - 1, row: cur.row },
        { col: cur.col + 1, row: cur.row },
        { col: cur.col, row: cur.row - 1 },
        { col: cur.col, row: cur.row + 1 },
      ];
      for (const nb of neighbours) {
        if (nb.col < 0 || nb.col >= cols || nb.row < 0 || nb.row >= rows) continue;
        const nk = key(nb.col, nb.row);
        if (visited.has(nk)) continue;
        const nbCell = cells.find((c) => c.col === nb.col && c.row === nb.row);
        if (nbCell?.failing) {
          visited.add(nk);
          queue.push(nbCell);
        }
      }
    }
    blobs.push(blob);
  }
  return blobs;
}

function blobToIssue(
  blob: Cell[],
  cols: number, rows: number,
  imgW: number, imgH: number,
  index: number,
): VisualDiffIssue {
  const minCol = Math.min(...blob.map((c) => c.col));
  const maxCol = Math.max(...blob.map((c) => c.col));
  const minRow = Math.min(...blob.map((c) => c.row));
  const maxRow = Math.max(...blob.map((c) => c.row));

  const xPct      = Math.round(minCol / cols * 1000) / 10;
  const yPct      = Math.round(minRow / rows * 1000) / 10;
  const widthPct  = Math.round((maxCol - minCol + 1) / cols * 1000) / 10;
  const heightPct = Math.round((maxRow - minRow + 1) / rows * 1000) / 10;
  const yFrac     = minRow / rows;

  const cellW  = Math.floor(imgW / cols);
  const cellH  = Math.floor(imgH / rows);

  // Dominant type: most common in blob
  const typeCount: Record<string, number> = {};
  for (const c of blob) typeCount[c.type] = (typeCount[c.type] ?? 0) + 1;
  const dominantType = (Object.entries(typeCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "section_mismatch") as VisualDiffType;

  const avgSsim       = blob.reduce((s, c) => s + c.ssim, 0)       / blob.length;
  const avgColorDelta = blob.reduce((s, c) => s + c.colorDelta, 0)  / blob.length;
  const avgEdgeDiff   = blob.reduce((s, c) => s + Math.abs(c.edgeA - c.edgeB), 0) / blob.length;
  const severity      = severityFromSsim(avgSsim);
  const confidence    = confidenceFromSignals(avgSsim, avgColorDelta, avgEdgeDiff);
  const cellPxArea    = cellW * cellH;
  const affectedPx    = blob.length * cellPxArea;

  return {
    id:             `pf2-issue-${String(index + 1).padStart(3, "0")}`,
    type:           dominantType,
    severity,
    confidence,
    location: {
      xPct, yPct, widthPct, heightPct,
      xPx:  minCol * cellW,
      yPx:  minRow * cellH,
      wPx:  (maxCol - minCol + 1) * cellW,
      hPx:  (maxRow - minRow + 1) * cellH,
    },
    description:    describeIssue(dominantType, severity, yFrac),
    affectedPixels: affectedPx,
    ssimDelta:      Math.round((1 - avgSsim) * 1000) / 1000,
    colorDelta:     Math.round(avgColorDelta * 10) / 10,
    edgeDensity:    Math.round(avgEdgeDiff * 1000) / 1000,
    suggestedFix:   suggestFix(dominantType),
  };
}

// ---------------------------------------------------------------------------
// Pixel-based analysis path
// ---------------------------------------------------------------------------

async function analyzeWithPixels(
  aBuf: Buffer, bBuf: Buffer,
  imgW: number, imgH: number,
  cols: number, rows: number,
  failThreshold: number,
): Promise<{ cells: Cell[]; allCells: DifferenceHeatmap["cells"] }> {
  const cellW = Math.floor(imgW / cols);
  const cellH = Math.floor(imgH / rows);

  const cells: Cell[] = [];
  const allCells: DifferenceHeatmap["cells"] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const c0 = col * cellW;
      const r0 = row * cellH;

      const cA = cellData(aBuf, imgW, c0, r0, cellW, cellH);
      const cB = cellData(bBuf, imgW, c0, r0, cellW, cellH);

      const ssim       = ssimBuffers(cA, cB);
      const colorDelta = meanColorDelta(cA, cB);
      const edgeA      = edgeDensity(cA, cellW, cellH);
      const edgeB      = edgeDensity(cB, cellW, cellH);
      const edgeDiff   = Math.abs(edgeA - edgeB);
      const intensity  = Math.round((1 - ssim) * 60 + (colorDelta / 255) * 25 + edgeDiff * 15);

      const type = ssim < failThreshold
        ? classifyCell(col, row, cols, rows, ssim, colorDelta, edgeA, edgeB)
        : "clean" as const;

      const failing = ssim < failThreshold;

      cells.push({
        col, row, ssim, colorDelta, edgeA, edgeB,
        type: failing ? type as VisualDiffType : "section_mismatch",
        intensity,
        failing,
      });

      allCells.push({
        col, row,
        ssim:       Math.round(ssim * 1000)       / 1000,
        colorDelta: Math.round(colorDelta * 10)   / 10,
        edgeDelta:  Math.round(edgeDiff * 255 * 10) / 10,
        intensity:  Math.min(100, intensity),
        issueType:  failing ? type as VisualDiffType : "clean",
      });
    }
  }

  return { cells, allCells };
}

// ---------------------------------------------------------------------------
// Fallback: derive issues from PF-1 region scores (no screenshots)
// ---------------------------------------------------------------------------

const REGION_TO_DIFF_TYPE: Record<string, VisualDiffType> = {
  full_layout:  "alignment",
  navigation:   "navigation",
  header:       "section_mismatch",
  main_content: "component_sizing",
  footer:       "section_mismatch",
  whitespace:   "spacing",
  typography:   "typography",
  images:       "image_placement",
  sections:     "section_mismatch",
};

const REGION_LOCATION: Record<string, { xPct: number; yPct: number; widthPct: number; heightPct: number }> = {
  full_layout:  { xPct: 0,  yPct: 0,  widthPct: 100, heightPct: 100 },
  navigation:   { xPct: 0,  yPct: 0,  widthPct: 100, heightPct: 12  },
  header:       { xPct: 0,  yPct: 0,  widthPct: 100, heightPct: 30  },
  main_content: { xPct: 0,  yPct: 15, widthPct: 100, heightPct: 70  },
  footer:       { xPct: 0,  yPct: 85, widthPct: 100, heightPct: 15  },
  whitespace:   { xPct: 0,  yPct: 10, widthPct: 100, heightPct: 80  },
  typography:   { xPct: 0,  yPct: 15, widthPct: 100, heightPct: 55  },
  images:       { xPct: 0,  yPct: 0,  widthPct: 100, heightPct: 60  },
  sections:     { xPct: 0,  yPct: 20, widthPct: 100, heightPct: 65  },
};

function issuesFromRegions(
  regions: RegionScore[],
  sourceJobId: string,
): VisualDiffIssue[] {
  const issues: VisualDiffIssue[] = [];
  let idx = 0;

  // Skip full_layout (redundant) and only emit non-clean regions
  for (const region of regions) {
    if (region.region === "full_layout") continue;
    if (region.ssim >= 0.90) continue;       // essentially clean

    const type = REGION_TO_DIFF_TYPE[region.region] ?? "section_mismatch";
    const loc  = REGION_LOCATION[region.region] ?? { xPct: 0, yPct: 0, widthPct: 100, heightPct: 100 };
    const severity = severityFromSsim(region.ssim);
    const confidence = confidenceFromSignals(region.ssim, region.mismatchPct * 2.55, 0.1);
    const yFrac = loc.yPct / 100;

    issues.push({
      id:             `pf2-region-${String(idx + 1).padStart(3, "0")}`,
      type,
      severity,
      confidence,
      location:       loc,
      description:    describeIssue(type, severity, yFrac),
      affectedPixels: Math.round(region.mismatchPct / 100 * 1920 * 1080), // estimate
      ssimDelta:      Math.round((1 - region.ssim) * 1000) / 1000,
      colorDelta:     region.mismatchPct,
      edgeDensity:    0,
      suggestedFix:   suggestFix(type),
    });
    idx++;
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Fallback heatmap (from region-level data)
// ---------------------------------------------------------------------------

function heatmapFromRegions(
  sourceJobId: string,
  generatedJobId: string,
  regions: RegionScore[],
): DifferenceHeatmap {
  const cells: DifferenceHeatmap["cells"] = [];
  // 1D row per region — simplified representation
  regions.forEach((r, i) => {
    cells.push({
      col:       i,
      row:       0,
      ssim:      r.ssim,
      colorDelta: r.mismatchPct * 2.55,
      edgeDelta:  0,
      intensity:  Math.min(100, Math.round((1 - r.ssim) * 100)),
      issueType:  r.ssim < 0.90 ? (REGION_TO_DIFF_TYPE[r.region] ?? "section_mismatch") : "clean",
    });
  });
  return {
    schemaVersion: "PF-2",
    sourceJobId,
    generatedJobId,
    generatedAt:   new Date().toISOString(),
    gridCols:      regions.length,
    gridRows:      1,
    cells,
  };
}

// ---------------------------------------------------------------------------
// Disk + R2 helpers
// ---------------------------------------------------------------------------

async function writeDisk(filename: string, data: unknown): Promise<void> {
  await writeFile(join(OUT_DIR, filename), JSON.stringify(data, null, 2), "utf8");
}

async function uploadR2Json(key: string, data: unknown): Promise<boolean> {
  try {
    const p = getDefaultCloudProvider();
    if (!p.isConfigured()) return false;
    await p.upload({
      key,
      data: Buffer.from(JSON.stringify(data, null, 2), "utf8"),
      contentType: "application/json",
    });
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runVisualDiffLocalizer(
  opts: LocalizerOptions,
): Promise<{
  diffMap:            VisualDiffMap;
  heatmap:            DifferenceHeatmap;
  componentErrors:    ComponentErrorReport;
}> {
  const {
    sourceJobId, generatedJobId,
    gridCols = GRID_COLS, gridRows = GRID_ROWS,
    failThreshold = 0.85,
  } = opts;
  const t0 = Date.now();

  logger.info({ sourceJobId, generatedJobId }, "PF-2: starting visual diff localizer");

  const provider   = getDefaultCloudProvider();
  const r2Base     = `jobs/${sourceJobId}/visual-diff`;

  // ── Attempt to download screenshots ───────────────────────────────────────
  let aBuf: Buffer | null = null, bBuf: Buffer | null = null;
  let imgW = 0, imgH = 0;

  async function tryDownload(key: string): Promise<Buffer | null> {
    try { return await provider.download(key); } catch { return null; }
  }

  const srcKey = opts.sourceKey    ?? `jobs/${sourceJobId}/screenshots/desktop/home.png`;
  const genKey = opts.generatedKey ?? `jobs/${generatedJobId}/screenshots/desktop/home.png`;

  const [srcRaw, genRaw] = await Promise.all([
    tryDownload(srcKey),
    tryDownload(genKey),
  ]);

  let issues: VisualDiffIssue[] = [];
  let heatmapData: DifferenceHeatmap;
  let allCells: DifferenceHeatmap["cells"] = [];

  if (srcRaw && genRaw) {
    // ── Full pixel-level analysis ─────────────────────────────────────────
    const { PNG } = await import("pngjs");
    const pngA    = PNG.sync.read(srcRaw);
    const pngB    = PNG.sync.read(genRaw);

    imgW = Math.min(pngA.width,  pngB.width);
    imgH = Math.min(pngA.height, pngB.height);

    // Crop to min dimensions
    function crop(png: ReturnType<typeof PNG.sync.read>): Buffer {
      if (png.width === imgW && png.height === imgH) return Buffer.from(png.data);
      const out = Buffer.alloc(imgW * imgH * 4);
      for (let y = 0; y < imgH; y++) {
        const s = y * png.width * 4;
        const d = y * imgW * 4;
        Buffer.from(png.data).copy(out, d, s, s + imgW * 4);
      }
      return out;
    }

    aBuf = crop(pngA);
    bBuf = crop(pngB);

    const { cells, allCells: ac } = await analyzeWithPixels(
      aBuf, bBuf, imgW, imgH, gridCols, gridRows, failThreshold,
    );
    allCells = ac;

    const failingCells  = cells.filter((c) => c.failing);
    const blobs         = findBlobs(failingCells.length > 0 ? cells : [], gridCols, gridRows);
    issues              = blobs.map((b, i) => blobToIssue(b, gridCols, gridRows, imgW, imgH, i));

    heatmapData = {
      schemaVersion: "PF-2",
      sourceJobId, generatedJobId,
      generatedAt: new Date().toISOString(),
      gridCols, gridRows,
      cells: allCells,
    };
  } else {
    // ── Fallback: derive from PF-1 region-level data ─────────────────────
    const regions = opts.pf1Report?.regions ?? [];
    issues      = issuesFromRegions(regions, sourceJobId);
    heatmapData = heatmapFromRegions(sourceJobId, generatedJobId, regions);

    logger.info(
      { sourceJobId, usingFallback: true },
      "PF-2: screenshots not in R2 — using PF-1 region data as fallback",
    );
  }

  // Sort: critical first, then high, medium, low; within same severity by ssimDelta desc
  const severityOrder: Record<IssueSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  issues.sort((a, b) =>
    (severityOrder[a.severity] - severityOrder[b.severity]) ||
    (b.ssimDelta - a.ssimDelta),
  );

  // ── Aggregate counts ───────────────────────────────────────────────────────
  const issuesBySeverity: Record<IssueSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const issuesByType = {} as Record<VisualDiffType, number>;
  for (const issue of issues) {
    issuesBySeverity[issue.severity]++;
    issuesByType[issue.type] = (issuesByType[issue.type] ?? 0) + 1;
  }

  // ── Build ComponentErrorReport ─────────────────────────────────────────────
  const components: ComponentError[] = issues.map((iss, i) => ({
    componentId:   iss.id,
    componentType: iss.type,
    severity:      iss.severity,
    confidence:    iss.confidence,
    location:      iss.location,
    description:   iss.description,
    suggestedFix:  iss.suggestedFix,
    estimatedGain: Math.round(iss.ssimDelta * iss.confidence * 100) / 100,
  }));

  const topPriorityFixes = issues
    .filter((i) => i.severity === "critical" || i.severity === "high")
    .slice(0, 5)
    .map((i) => i.suggestedFix);

  const durationMs = Date.now() - t0;

  const diffMap: VisualDiffMap = {
    schemaVersion:   "PF-2",
    sourceJobId, generatedJobId,
    generatedAt:     new Date().toISOString(),
    durationMs,
    imageSize:       imgW > 0 ? { width: imgW, height: imgH } : null,
    grid:            { cols: gridCols, rows: gridRows },
    totalIssues:     issues.length,
    issuesBySeverity,
    issuesByType,
    issues,
    r2Keys:          { diffMap: null, heatmap: null, errorReport: null },
  };

  const componentErrors: ComponentErrorReport = {
    schemaVersion:   "PF-2",
    sourceJobId, generatedJobId,
    generatedAt:     new Date().toISOString(),
    durationMs,
    totalComponents: components.length,
    criticalCount:   issuesBySeverity.critical,
    highCount:       issuesBySeverity.high,
    mediumCount:     issuesBySeverity.medium,
    lowCount:        issuesBySeverity.low,
    components,
    topPriorityFixes: [...new Set(topPriorityFixes)],
  };

  // ── Write disk ─────────────────────────────────────────────────────────────
  await Promise.all([
    writeDisk("visual-diff-map.json",        diffMap),
    writeDisk("difference-heatmap.json",     heatmapData),
    writeDisk("component-error-report.json", componentErrors),
  ]);

  // ── Upload R2 ──────────────────────────────────────────────────────────────
  const [u1, u2, u3] = await Promise.all([
    uploadR2Json(`${r2Base}/visual-diff-map.json`,        diffMap),
    uploadR2Json(`${r2Base}/difference-heatmap.json`,     heatmapData),
    uploadR2Json(`${r2Base}/component-error-report.json`, componentErrors),
  ]);
  diffMap.r2Keys = {
    diffMap:     u1 ? `${r2Base}/visual-diff-map.json`        : null,
    heatmap:     u2 ? `${r2Base}/difference-heatmap.json`     : null,
    errorReport: u3 ? `${r2Base}/component-error-report.json` : null,
  };
  await writeDisk("visual-diff-map.json", diffMap);

  logger.info({ sourceJobId, generatedJobId, totalIssues: issues.length, durationMs }, "PF-2: done");
  return { diffMap, heatmap: heatmapData, componentErrors };
}
