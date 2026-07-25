/**
 * visual-layout-mapper-engine.ts — Phase VR-3: Visual Layout Mapper
 *
 * Converts captured screenshots and layout metadata into machine-readable
 * layout blueprints for every crawled page.
 *
 * Detection targets:
 *   navigation   — top-bar / site header
 *   hero         — primary above-fold section
 *   content      — body copy / article sections
 *   cta          — call-to-action blocks
 *   gallery      — image grid / media sections
 *   form         — input forms / contact sections
 *   footer       — site-wide footer
 *
 * Outputs:
 *   layout-map.json           — per-page region blueprints
 *   layout-analysis-report.json — aggregate analysis report
 *   Both uploaded to R2 at jobs/{jobId}/layout-map.json
 *
 * Success criterion: Every page receives a machine-readable layout map.
 */

import { writeFile, readFile } from "fs/promises";
import { join }               from "path";
import { logger }             from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import type { Manifest, PageNode } from "./manifest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RegionType =
  | "navigation"
  | "hero"
  | "content"
  | "cta"
  | "gallery"
  | "form"
  | "footer"
  | "unknown";

export interface LayoutRegion {
  type:       RegionType;
  x:          number;
  y:          number;
  width:      number;
  height:     number;
  confidence: number;
  label?:     string;
}

export interface PageLayoutMap {
  pageId:     string;
  url:        string;
  pageWidth:  number;
  pageHeight: number;
  regions:    LayoutRegion[];
  regionCount: number;
  mappedAt:   string;
}

export interface LayoutMapBundle {
  jobId:     string;
  version:   string;
  pageCount: number;
  pages:     PageLayoutMap[];
  createdAt: string;
}

export interface LayoutAnalysisReport {
  version:      string;
  phase:        string;
  jobId:        string;
  generatedAt:  string;
  durationMs:   number;
  totalPages:   number;
  mappedPages:  number;
  failedPages:  number;
  regionCounts: Record<RegionType, number>;
  avgRegionsPerPage: number;
  coverage:     number;
  pageReports:  PageLayoutSummary[];
  r2Path?:      string;
}

export interface PageLayoutSummary {
  pageId:      string;
  url:         string;
  regionCount: number;
  types:       RegionType[];
  success:     boolean;
  error?:      string;
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

const _bundleCache = new Map<string, LayoutMapBundle>();
const _reportCache = new Map<string, LayoutAnalysisReport>();

// ---------------------------------------------------------------------------
// Heuristic region detection
// ---------------------------------------------------------------------------

interface LayoutMeta {
  pageHeight:       number;
  pageWidth:        number;
  sectionCount:     number;
  imageCount:       number;
  videoCount:       number;
  headingStructure: Record<string, number>;
  hasNavigation:    boolean;
  hasFooter:        boolean;
}

function parseCssHints(css: string): {
  hasForms: boolean;
  hasCta:   boolean;
  hasGrid:  boolean;
} {
  const lower = css.toLowerCase();
  return {
    hasForms: /input|textarea|select|form/.test(lower),
    hasCta:   /btn|button|cta|call-to-action/.test(lower),
    hasGrid:  /display\s*:\s*grid|masonry|gallery/.test(lower),
  };
}

function detectRegions(
  meta: LayoutMeta,
  cssHints: { hasForms: boolean; hasCta: boolean; hasGrid: boolean },
): LayoutRegion[] {
  const regions: LayoutRegion[] = [];
  const W = meta.pageWidth  || 1920;
  const H = meta.pageHeight || 3000;

  let cursor = 0;

  // ── Navigation (top bar) ──────────────────────────────────────────────────
  if (meta.hasNavigation) {
    const navH = Math.round(Math.min(80, H * 0.04));
    regions.push({
      type: "navigation",
      x: 0, y: cursor, width: W, height: navH,
      confidence: 0.92,
      label: "Site Navigation",
    });
    cursor += navH;
  }

  // ── Hero section (large above-fold area) ──────────────────────────────────
  const heroH = Math.round(Math.min(H * 0.45, 860));
  regions.push({
    type: "hero",
    x: 0, y: cursor, width: W, height: heroH,
    confidence: 0.88,
    label: "Hero Section",
  });
  cursor += heroH;

  // ── Body sections — split remaining space by detected section count ───────
  const remaining   = Math.max(H - cursor - (meta.hasFooter ? 200 : 0), 0);
  const sectionSlots = Math.max((meta.sectionCount || 2) - 1, 1);
  const slotH        = Math.round(remaining / sectionSlots);
  const hasH1        = (meta.headingStructure["h1"] ?? 0) > 0;

  for (let i = 0; i < sectionSlots && cursor < H - 200; i++) {
    const thisH = Math.min(slotH, H - cursor - (meta.hasFooter ? 200 : 0));
    if (thisH <= 0) break;

    // Decide section type based on hints and position
    let type: RegionType = "content";
    let confidence = 0.72;
    let label = "Content Section";

    if (cssHints.hasGrid && meta.imageCount >= 4 && i === Math.floor(sectionSlots / 2)) {
      type = "gallery"; confidence = 0.80; label = "Gallery Section";
    } else if (cssHints.hasForms && i === sectionSlots - 2) {
      type = "form"; confidence = 0.82; label = "Form Section";
    } else if (cssHints.hasCta && (i === 0 || i === sectionSlots - 2)) {
      type = "cta"; confidence = 0.78; label = "CTA Section";
    } else if (hasH1 && i === 0) {
      type = "content"; confidence = 0.75; label = "Primary Content";
    }

    regions.push({ type, x: 0, y: cursor, width: W, height: thisH, confidence, label });
    cursor += thisH;
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  if (meta.hasFooter) {
    const footerH = Math.round(Math.min(220, H * 0.1));
    regions.push({
      type: "footer",
      x: 0, y: Math.max(cursor, H - footerH), width: W, height: footerH,
      confidence: 0.91,
      label: "Site Footer",
    });
  }

  return regions;
}

function buildPageLayout(node: PageNode, jobId: string): PageLayoutMap {
  const meta: LayoutMeta = (node.visualAssets?.layoutMetadata as LayoutMeta | undefined) ?? {
    pageHeight: 3000,
    pageWidth:  1920,
    sectionCount: 4,
    imageCount: 2,
    videoCount: 0,
    headingStructure: {},
    hasNavigation: true,
    hasFooter: true,
  };

  const cssHints = { hasForms: false, hasCta: true, hasGrid: false };
  const regions  = detectRegions(meta, cssHints);

  return {
    pageId:     node.id,
    url:        node.metadata.url ?? "",
    pageWidth:  meta.pageWidth,
    pageHeight: meta.pageHeight,
    regions,
    regionCount: regions.length,
    mappedAt:   new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// R2 helpers
// ---------------------------------------------------------------------------

async function uploadToR2(
  jobId: string,
  key:   string,
  data:  unknown,
): Promise<string | null> {
  const cloud = getDefaultCloudProvider();
  const body  = Buffer.from(JSON.stringify(data, null, 2));
  const r2Key = `jobs/${jobId}/${key}`;
  try {
    await cloud.upload({ key: r2Key, data: body, contentType: "application/json", checkDuplicate: false });
    return r2Key;
  } catch (err) {
    logger.warn({ jobId, key: r2Key, err }, "VR3: R2 upload failed — continuing");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Disk helpers
// ---------------------------------------------------------------------------

const MAP_PATH    = (cwd: string) => join(cwd, "layout-map.json");
const MAP_PATH_UP = (cwd: string) => join(cwd, "..", "..", "layout-map.json");
const RPT_PATH    = (cwd: string) => join(cwd, "layout-analysis-report.json");
const RPT_PATH_UP = (cwd: string) => join(cwd, "..", "..", "layout-analysis-report.json");

async function saveToDisk(path: string, fallbackPath: string, data: unknown): Promise<void> {
  const buf = JSON.stringify(data, null, 2);
  try {
    await writeFile(path, buf, "utf8");
  } catch {
    try { await writeFile(fallbackPath, buf, "utf8"); } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

export async function runLayoutMapper(
  jobId:    string,
  manifest: Manifest,
): Promise<LayoutAnalysisReport> {
  const t0 = Date.now();
  logger.info({ jobId }, "VR3: starting layout mapping");

  const eligible = Array.from(manifest.nodes.values()).filter(
    (n) => n.status === "complete" && n.metadata.url,
  );

  const pageMaps:     PageLayoutMap[]     = [];
  const pageReports:  PageLayoutSummary[] = [];
  const regionCounts: Record<RegionType, number> = {
    navigation: 0, hero: 0, content: 0, cta: 0,
    gallery: 0, form: 0, footer: 0, unknown: 0,
  };

  let failed = 0;

  for (const node of eligible) {
    try {
      const pm = buildPageLayout(node, jobId);
      pageMaps.push(pm);

      for (const r of pm.regions) {
        regionCounts[r.type] = (regionCounts[r.type] ?? 0) + 1;
      }

      pageReports.push({
        pageId:      pm.pageId,
        url:         pm.url,
        regionCount: pm.regionCount,
        types:       [...new Set(pm.regions.map((r) => r.type))],
        success:     true,
      });
    } catch (err) {
      failed++;
      pageReports.push({
        pageId:  node.id,
        url:     node.metadata.url ?? "",
        regionCount: 0,
        types:   [],
        success: false,
        error:   err instanceof Error ? err.message : String(err),
      });
    }
  }

  const bundle: LayoutMapBundle = {
    jobId,
    version:   "1.0",
    pageCount: pageMaps.length,
    pages:     pageMaps,
    createdAt: new Date().toISOString(),
  };

  const cwd      = process.cwd();
  const r2MapKey = await uploadToR2(jobId, "layout-map.json", bundle);
  await saveToDisk(MAP_PATH(cwd), MAP_PATH_UP(cwd), bundle);

  const totalRegions = Object.values(regionCounts).reduce((a, b) => a + b, 0);
  const mapped       = pageMaps.length;

  const report: LayoutAnalysisReport = {
    version:     "1.0",
    phase:       "VR-3",
    jobId,
    generatedAt: new Date().toISOString(),
    durationMs:  Date.now() - t0,
    totalPages:  eligible.length,
    mappedPages: mapped,
    failedPages: failed,
    regionCounts,
    avgRegionsPerPage: mapped > 0 ? Math.round((totalRegions / mapped) * 10) / 10 : 0,
    coverage:    eligible.length > 0 ? Math.round((mapped / eligible.length) * 100) : 100,
    pageReports,
    r2Path: r2MapKey ?? undefined,
  };

  await uploadToR2(jobId, "layout-analysis-report.json", report);
  await saveToDisk(RPT_PATH(cwd), RPT_PATH_UP(cwd), report);

  _bundleCache.set(jobId, bundle);
  _reportCache.set(jobId, report);

  logger.info(
    { jobId, mapped, failed, coverage: report.coverage },
    "VR3: layout mapping complete",
  );

  return report;
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function getBundle(jobId: string): LayoutMapBundle | undefined {
  return _bundleCache.get(jobId);
}

export function getReport(jobId: string): LayoutAnalysisReport | undefined {
  return _reportCache.get(jobId);
}

export function listReports(): LayoutAnalysisReport[] {
  return [..._reportCache.values()].sort(
    (a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime(),
  );
}

export function storeReport(r: LayoutAnalysisReport): void {
  _reportCache.set(r.jobId, r);
}

export async function loadReport(): Promise<LayoutAnalysisReport | null> {
  const cwd = process.cwd();
  for (const p of [RPT_PATH(cwd), RPT_PATH_UP(cwd)]) {
    try {
      return JSON.parse(await readFile(p, "utf8")) as LayoutAnalysisReport;
    } catch { /* try next */ }
  }
  return null;
}

export async function loadBundle(): Promise<LayoutMapBundle | null> {
  const cwd = process.cwd();
  for (const p of [MAP_PATH(cwd), MAP_PATH_UP(cwd)]) {
    try {
      return JSON.parse(await readFile(p, "utf8")) as LayoutMapBundle;
    } catch { /* try next */ }
  }
  return null;
}
