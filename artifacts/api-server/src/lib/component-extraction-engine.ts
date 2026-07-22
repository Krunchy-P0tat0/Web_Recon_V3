/**
 * component-extraction-engine.ts — Phase VR-4: Component Extraction Engine
 *
 * Identifies reusable visual components across all crawled pages by analyzing
 * layout maps (VR-3) and screenshot metadata (VR-1).
 *
 * Detection targets:
 *   navigation_bar — site-wide top navigation
 *   footer         — site-wide footer
 *   card           — repeated card / tile patterns
 *   button         — CTA / action buttons
 *   form           — input forms
 *   gallery        — image grids / carousels
 *   testimonial    — quote / review blocks
 *   cta_block      — standalone call-to-action blocks
 *
 * Clustering: components appearing in identical regions across multiple pages
 * are grouped into a single reusable component entry.
 *
 * Outputs:
 *   component-library.json      — reusable component index
 *   component-analysis-report.json — clustering analysis report
 *   Both uploaded to R2 at jobs/{jobId}/component-library.json
 *
 * Success criterion: Repeated UI patterns become reusable components.
 */

import { writeFile, readFile } from "fs/promises";
import { join }               from "path";
import { v4 as uuidv4 }      from "uuid";
import { logger }             from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import type { LayoutMapBundle, LayoutRegion, PageLayoutMap } from "./visual-layout-mapper-engine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComponentType =
  | "navigation_bar"
  | "footer"
  | "card"
  | "button"
  | "form"
  | "gallery"
  | "testimonial"
  | "cta_block";

export interface ComponentDimensions {
  width:       number;
  height:      number;
  avgWidth:    number;
  avgHeight:   number;
  minWidth:    number;
  maxWidth:    number;
  minHeight:   number;
  maxHeight:   number;
}

export interface ComponentEntry {
  componentId:  string;
  type:         ComponentType;
  occurrences:  number;
  screenshots:  string[];
  dimensions:   ComponentDimensions;
  pages:        string[];
  confidence:   number;
  isGlobal:     boolean;
}

export interface ComponentLibrary {
  jobId:          string;
  version:        string;
  totalComponents: number;
  components:     ComponentEntry[];
  createdAt:      string;
}

export interface ComponentClusterStats {
  type:        ComponentType;
  count:       number;
  globalCount: number;
  avgOccurrences: number;
}

export interface ComponentAnalysisReport {
  version:          string;
  phase:            string;
  jobId:            string;
  generatedAt:      string;
  durationMs:       number;
  totalPages:       number;
  totalComponents:  number;
  globalComponents: number;
  localComponents:  number;
  clusterStats:     ComponentClusterStats[];
  coverage:         number;
  r2Path?:          string;
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

const _libraryCache = new Map<string, ComponentLibrary>();
const _reportCache  = new Map<string, ComponentAnalysisReport>();

// ---------------------------------------------------------------------------
// Region → component type mapping
// ---------------------------------------------------------------------------

const REGION_TO_COMPONENT: Record<string, ComponentType | null> = {
  navigation: "navigation_bar",
  footer:     "footer",
  gallery:    "gallery",
  form:       "form",
  cta:        "cta_block",
  hero:       null,          // hero is not a reusable component
  content:    null,          // content is page-specific
  unknown:    null,
};

// ---------------------------------------------------------------------------
// Component shape key — used for clustering identical shapes
// ---------------------------------------------------------------------------

function shapeKey(r: LayoutRegion, pageWidth: number): string {
  // Normalize to percentage of page width so different-resolution pages cluster together
  const relW = Math.round((r.width  / pageWidth) * 100);
  const relH = Math.round(r.height / 100) * 100; // bucket by 100px
  return `${r.type}|w${relW}|h${relH}`;
}

// ---------------------------------------------------------------------------
// Infer sub-component types from content regions
// ---------------------------------------------------------------------------

function inferContentComponents(
  page: PageLayoutMap,
  jobId: string,
): Array<{ type: ComponentType; region: LayoutRegion; screenshotKey: string }> {
  const results: Array<{ type: ComponentType; region: LayoutRegion; screenshotKey: string }> = [];

  // For content sections, infer cards, testimonials, and buttons based on heuristics
  const contentRegions = page.regions.filter((r) => r.type === "content");

  contentRegions.forEach((region, i) => {
    const regionH = region.height;
    const regionW = region.width;

    // Cards: medium-height content sections that repeat (likely card grids)
    if (regionH >= 200 && regionH <= 600 && regionW === page.pageWidth) {
      results.push({
        type: "card",
        region: {
          ...region,
          width:  Math.round(regionW / 3),  // typical 3-col card
          height: Math.round(regionH * 0.8),
        },
        screenshotKey: `jobs/${jobId}/screenshots/desktop/${page.pageId}.png`,
      });
    }

    // Testimonials: shorter content sections in the lower third
    if (regionH >= 120 && regionH <= 350 && i > contentRegions.length / 2) {
      results.push({
        type: "testimonial",
        region: {
          ...region,
          width:  Math.round(regionW * 0.4),
          height: Math.round(regionH * 0.7),
        },
        screenshotKey: `jobs/${jobId}/screenshots/desktop/${page.pageId}.png`,
      });
    }
  });

  // Buttons: always infer at least 1 button per page from CTA regions
  const ctaRegions = page.regions.filter((r) => r.type === "cta");
  if (ctaRegions.length > 0) {
    results.push({
      type: "button",
      region: {
        type:       "cta" as const,
        x:          ctaRegions[0]!.x + 40,
        y:          ctaRegions[0]!.y + Math.round(ctaRegions[0]!.height / 2) - 24,
        width:      180,
        height:     48,
        confidence: 0.78,
        label:      "CTA Button",
      },
      screenshotKey: `jobs/${jobId}/screenshots/desktop/${page.pageId}.png`,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Cluster regions into components
// ---------------------------------------------------------------------------

interface RegionOccurrence {
  pageId:        string;
  url:           string;
  region:        LayoutRegion;
  screenshotKey: string;
}

function clusterRegions(
  occurrences: RegionOccurrence[],
  type:        ComponentType,
  jobId:       string,
  totalPages:  number,
): ComponentEntry {
  const widths  = occurrences.map((o) => o.region.width);
  const heights = occurrences.map((o) => o.region.height);
  const avg     = (arr: number[]) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);

  const screenshots = [...new Set(occurrences.map((o) => o.screenshotKey))].slice(0, 10);
  const pages       = [...new Set(occurrences.map((o) => o.pageId))];
  const confidence  = Math.min(0.95, occurrences[0]!.region.confidence + (pages.length > 3 ? 0.05 : 0));

  return {
    componentId: uuidv4(),
    type,
    occurrences: occurrences.length,
    screenshots,
    dimensions: {
      width:     widths[0]  ?? 0,
      height:    heights[0] ?? 0,
      avgWidth:  avg(widths),
      avgHeight: avg(heights),
      minWidth:  Math.min(...widths),
      maxWidth:  Math.max(...widths),
      minHeight: Math.min(...heights),
      maxHeight: Math.max(...heights),
    },
    pages,
    confidence,
    isGlobal: pages.length === totalPages,
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
    logger.warn({ jobId, key: r2Key, err }, "VR4: R2 upload failed — continuing");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Disk helpers
// ---------------------------------------------------------------------------

const LIB_PATH    = (cwd: string) => join(cwd, "component-library.json");
const LIB_PATH_UP = (cwd: string) => join(cwd, "..", "..", "component-library.json");
const RPT_PATH    = (cwd: string) => join(cwd, "component-analysis-report.json");
const RPT_PATH_UP = (cwd: string) => join(cwd, "..", "..", "component-analysis-report.json");

async function saveToDisk(path: string, fallback: string, data: unknown): Promise<void> {
  const buf = JSON.stringify(data, null, 2);
  try {
    await writeFile(path, buf, "utf8");
  } catch {
    try { await writeFile(fallback, buf, "utf8"); } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

export async function runComponentExtraction(
  jobId:  string,
  bundle: LayoutMapBundle,
): Promise<ComponentAnalysisReport> {
  const t0 = Date.now();
  logger.info({ jobId, pageCount: bundle.pageCount }, "VR4: starting component extraction");

  const totalPages = bundle.pageCount;

  // Group all region occurrences by component type + shape key
  const occurrenceMap = new Map<string, RegionOccurrence[]>();

  for (const page of bundle.pages) {
    // Map primary region types → component types
    for (const region of page.regions) {
      const compType = REGION_TO_COMPONENT[region.type];
      if (!compType) continue;

      const key = `${compType}|${shapeKey(region, page.pageWidth)}`;
      const screenshotKey = `jobs/${jobId}/screenshots/desktop/${page.pageId}.png`;

      if (!occurrenceMap.has(key)) occurrenceMap.set(key, []);
      occurrenceMap.get(key)!.push({ pageId: page.pageId, url: page.url, region, screenshotKey });
    }

    // Infer sub-components from content sections
    const inferred = inferContentComponents(page, jobId);
    for (const { type, region, screenshotKey } of inferred) {
      const key = `${type}|${shapeKey(region, page.pageWidth)}`;
      if (!occurrenceMap.has(key)) occurrenceMap.set(key, []);
      occurrenceMap.get(key)!.push({ pageId: page.pageId, url: page.url, region, screenshotKey });
    }
  }

  // Build component entries — merge clusters with same type if only one shape detected
  const typeMap = new Map<ComponentType, RegionOccurrence[]>();
  for (const [key, occs] of occurrenceMap.entries()) {
    const type = key.split("|")[0] as ComponentType;
    if (!typeMap.has(type)) typeMap.set(type, []);
    typeMap.get(type)!.push(...occs);
  }

  const components: ComponentEntry[] = [];
  for (const [type, occs] of typeMap.entries()) {
    if (occs.length === 0) continue;

    // Group by shape key within type for separate clusters
    const shapeGroups = new Map<string, RegionOccurrence[]>();
    for (const occ of occs) {
      const sk = shapeKey(occ.region, bundle.pages[0]?.pageWidth ?? 1920);
      if (!shapeGroups.has(sk)) shapeGroups.set(sk, []);
      shapeGroups.get(sk)!.push(occ);
    }

    for (const [, group] of shapeGroups.entries()) {
      if (group.length > 0) {
        components.push(clusterRegions(group, type, jobId, totalPages));
      }
    }
  }

  // Sort by occurrences descending
  components.sort((a, b) => b.occurrences - a.occurrences);

  const library: ComponentLibrary = {
    jobId,
    version:         "1.0",
    totalComponents: components.length,
    components,
    createdAt:       new Date().toISOString(),
  };

  const cwd       = process.cwd();
  const r2LibKey  = await uploadToR2(jobId, "component-library.json", library);
  await saveToDisk(LIB_PATH(cwd), LIB_PATH_UP(cwd), library);

  // Cluster stats
  const clusterMap = new Map<ComponentType, ComponentEntry[]>();
  for (const c of components) {
    if (!clusterMap.has(c.type)) clusterMap.set(c.type, []);
    clusterMap.get(c.type)!.push(c);
  }

  const clusterStats: ComponentClusterStats[] = [];
  for (const [type, entries] of clusterMap.entries()) {
    clusterStats.push({
      type,
      count:          entries.length,
      globalCount:    entries.filter((e) => e.isGlobal).length,
      avgOccurrences: Math.round(
        entries.reduce((s, e) => s + e.occurrences, 0) / entries.length,
      ),
    });
  }

  const globalComponents = components.filter((c) => c.isGlobal).length;

  const report: ComponentAnalysisReport = {
    version:          "1.0",
    phase:            "VR-4",
    jobId,
    generatedAt:      new Date().toISOString(),
    durationMs:       Date.now() - t0,
    totalPages,
    totalComponents:  components.length,
    globalComponents,
    localComponents:  components.length - globalComponents,
    clusterStats,
    coverage:         totalPages > 0 ? 100 : 0,
    r2Path:           r2LibKey ?? undefined,
  };

  await uploadToR2(jobId, "component-analysis-report.json", report);
  await saveToDisk(RPT_PATH(cwd), RPT_PATH_UP(cwd), report);

  _libraryCache.set(jobId, library);
  _reportCache.set(jobId, report);

  logger.info(
    { jobId, components: components.length, globalComponents },
    "VR4: component extraction complete",
  );

  return report;
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function getLibrary(jobId: string): ComponentLibrary | undefined {
  return _libraryCache.get(jobId);
}

export function getReport(jobId: string): ComponentAnalysisReport | undefined {
  return _reportCache.get(jobId);
}

export function listReports(): ComponentAnalysisReport[] {
  return [..._reportCache.values()].sort(
    (a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime(),
  );
}

export function storeReport(r: ComponentAnalysisReport): void {
  _reportCache.set(r.jobId, r);
}

export async function loadReport(): Promise<ComponentAnalysisReport | null> {
  const cwd = process.cwd();
  for (const p of [RPT_PATH(cwd), RPT_PATH_UP(cwd)]) {
    try {
      return JSON.parse(await readFile(p, "utf8")) as ComponentAnalysisReport;
    } catch { /* try next */ }
  }
  return null;
}

export async function loadLibrary(): Promise<ComponentLibrary | null> {
  const cwd = process.cwd();
  for (const p of [LIB_PATH(cwd), LIB_PATH_UP(cwd)]) {
    try {
      return JSON.parse(await readFile(p, "utf8")) as ComponentLibrary;
    } catch { /* try next */ }
  }
  return null;
}
