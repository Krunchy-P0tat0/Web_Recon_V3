/**
 * multi-page-consistency-engine.ts — Phase 6.7 Multi-Page Consistency Engine
 *
 * Input:  visualStencilMap.json + manifest.json
 * Output: consistencyReport.json + normalizedStencilMap.json (uploaded to R2)
 *
 * Responsibilities:
 *   1. Detect repeated patterns across pages
 *   2. Normalize: headers, spacing rules, typography hierarchy, card layouts
 *   3. Enforce shared design tokens: spacing scale, font scale, grid system
 *
 * Rules:
 *   - Does NOT redesign pages
 *   - Only enforces consistency rules across pages
 *   - Preserves all content and ordering from source map
 */

import { logger } from "./logger";
import type { VisualStencilMap, StencilNodeEntry, VisualStencilType } from "./visual-stencil-mapper";

// ── Design token types ─────────────────────────────────────────────────────────

export interface SpacingScale {
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
  xxl: number;
}

export interface FontScale {
  xs: number;
  sm: number;
  base: number;
  md: number;
  lg: number;
  xl: number;
  "2xl": number;
  "3xl": number;
  "4xl": number;
}

export interface GridSystem {
  /** Canonical column count for GridLayout pages */
  gridColumns: 2 | 3 | 4;
  /** Column gap in spacing units */
  columnGap: "sm" | "md" | "lg";
  /** Row gap in spacing units */
  rowGap: "sm" | "md" | "lg";
  /** Max content width in px */
  maxContentWidth: number;
}

export interface DesignTokens {
  spacingScale: SpacingScale;
  fontScale: FontScale;
  gridSystem: GridSystem;
  /** Canonical heading depth per stencil type */
  headingDepthByStencil: Record<VisualStencilType, number>;
  /** Canonical section count range per stencil type */
  sectionRangeByStencil: Record<VisualStencilType, { min: number; max: number; median: number }>;
  derivedFrom: {
    totalPages: number;
    spacingDensity: "compact" | "normal" | "spacious";
    typographyComplexity: "simple" | "standard" | "rich";
    gridImageMedian: number;
  };
}

// ── Consistency issue types ───────────────────────────────────────────────────

export type ConsistencyIssueSeverity = "info" | "warning" | "error";
export type ConsistencyIssueType =
  | "heading_depth_deviation"
  | "section_count_deviation"
  | "card_layout_deviation"
  | "typography_inconsistency"
  | "spacing_inconsistency"
  | "stencil_singleton"          // only one page of this type — normalization is approximate
  | "missing_visual_hierarchy";

export interface ConsistencyIssue {
  nodeId: string;
  url: string;
  stencilType: VisualStencilType;
  issueType: ConsistencyIssueType;
  severity: ConsistencyIssueSeverity;
  description: string;
  canonicalValue: string | number;
  actualValue: string | number;
  fix: string;
}

// ── Normalized node override ───────────────────────────────────────────────────

export interface NormalizedLayout {
  /** Applied heading depth override */
  headingDepth: number;
  /** Applied section count guidance */
  sectionCount: number;
  /** Applied grid columns (GridLayout only) */
  gridColumns?: 2 | 3 | 4;
  /** Spacing density override */
  spacingDensity: "compact" | "normal" | "spacious";
  /** Typography complexity */
  typographyComplexity: "simple" | "standard" | "rich";
  /** Whether any normalization was applied */
  normalized: boolean;
  /** Token keys applied */
  appliedTokens: string[];
}

export interface NormalizedStencilNode extends StencilNodeEntry {
  normalizedLayout: NormalizedLayout;
}

// ── Main output types ──────────────────────────────────────────────────────────

export interface PatternSummary {
  stencilType: VisualStencilType;
  pageCount: number;
  /** Canonical heading depth derived from majority vote */
  canonicalHeadingDepth: number;
  /** Median section count */
  medianSections: number;
  /** Median image count */
  medianImages: number;
  /** Whether this type has enough pages for reliable normalization */
  reliable: boolean;
}

export interface ConsistencyReport {
  schemaVersion: "6.7";
  jobId: string;
  seedUrl: string;
  generatedAt: string;
  designTokens: DesignTokens;
  patternSummary: PatternSummary[];
  issues: ConsistencyIssue[];
  summary: {
    totalNodes: number;
    normalizedNodes: number;
    issueCount: number;
    issuesByType: Record<ConsistencyIssueType, number>;
    issueBySeverity: Record<ConsistencyIssueSeverity, number>;
    designTokensApplied: number;
    overallConsistencyScore: number;  // 0–100
  };
  r2Key?: string;
}

export interface NormalizedStencilMap extends VisualStencilMap {
  designTokens: DesignTokens;
  nodes: NormalizedStencilNode[];
  r2Key?: string;
}

// ── Statistical helpers ───────────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function mode(values: number[]): number {
  if (values.length === 0) return 0;
  const freq = new Map<number, number>();
  for (const v of values) freq.set(v, (freq.get(v) ?? 0) + 1);
  let best = values[0]!;
  let bestCount = 0;
  for (const [val, count] of freq) {
    if (count > bestCount) { best = val; bestCount = count; }
  }
  return best;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length);
}

// ── Design token derivation ───────────────────────────────────────────────────

const STENCIL_TYPES: VisualStencilType[] = [
  "HeroSection", "ArticleLayout", "GridLayout", "FeatureBlock", "NavigationLayout"
];

function deriveSpacingScale(spacingDensity: "compact" | "normal" | "spacious"): SpacingScale {
  if (spacingDensity === "compact")  return { xs: 4,  sm: 8,  md: 12, lg: 16, xl: 24, xxl: 32 };
  if (spacingDensity === "spacious") return { xs: 8,  sm: 16, md: 24, lg: 32, xl: 48, xxl: 64 };
  return                                    { xs: 4,  sm: 8,  md: 16, lg: 24, xl: 32, xxl: 48 };
}

function deriveFontScale(typographyComplexity: "simple" | "standard" | "rich"): FontScale {
  if (typographyComplexity === "simple") return {
    xs: 11, sm: 13, base: 16, md: 18, lg: 20, xl: 24, "2xl": 28, "3xl": 32, "4xl": 40
  };
  if (typographyComplexity === "rich") return {
    xs: 12, sm: 14, base: 16, md: 18, lg: 20, xl: 24, "2xl": 30, "3xl": 36, "4xl": 48
  };
  return {
    xs: 12, sm: 14, base: 16, md: 18, lg: 20, xl: 24, "2xl": 28, "3xl": 36, "4xl": 48
  };
}

function deriveGridSystem(gridImageMedian: number): GridSystem {
  const gridColumns: 2 | 3 | 4 =
    gridImageMedian <= 2 ? 2 : gridImageMedian <= 4 ? 3 : 4;
  const columnGap: "sm" | "md" | "lg" =
    gridColumns === 4 ? "sm" : gridColumns === 3 ? "md" : "lg";
  return {
    gridColumns,
    columnGap,
    rowGap: "md",
    maxContentWidth: gridColumns === 4 ? 1280 : gridColumns === 3 ? 1200 : 1024,
  };
}

// ── Core engine ───────────────────────────────────────────────────────────────

export function runConsistencyEngine(
  stencilMap: VisualStencilMap
): { report: ConsistencyReport; normalizedMap: NormalizedStencilMap } {

  const nodes = stencilMap.nodes;

  // ── 1. Group nodes by stencil type ────────────────────────────────────────

  const byType = new Map<VisualStencilType, StencilNodeEntry[]>();
  for (const type of STENCIL_TYPES) byType.set(type, []);
  for (const node of nodes) {
    byType.get(node.stencilType)?.push(node);
  }

  // ── 2. Compute per-type pattern summaries ─────────────────────────────────

  const patternSummary: PatternSummary[] = [];
  const headingDepthByStencil = {} as Record<VisualStencilType, number>;
  const sectionRangeByStencil = {} as Record<VisualStencilType, { min: number; max: number; median: number }>;

  for (const type of STENCIL_TYPES) {
    const group = byType.get(type) ?? [];
    const pageCount = group.length;
    const reliable = pageCount >= 2;

    const headingDepths = group.map(n => n.visualHierarchy.headingDepth);
    const sectionCounts = group.map(n => n.visualHierarchy.sections);
    const imageCounts   = group.map(n => n.visualHierarchy.imageCount);

    const canonicalHeadingDepth = reliable ? mode(headingDepths) : (headingDepths[0] ?? 2);
    const medianSections        = reliable ? median(sectionCounts) : (sectionCounts[0] ?? 3);
    const medianImages          = reliable ? median(imageCounts)   : (imageCounts[0]   ?? 2);

    headingDepthByStencil[type] = canonicalHeadingDepth;
    sectionRangeByStencil[type] = {
      min:    Math.max(1, Math.floor(medianSections - stdDev(sectionCounts) - 0.5)),
      max:    Math.ceil(medianSections + stdDev(sectionCounts) + 0.5),
      median: medianSections,
    };

    patternSummary.push({
      stencilType: type,
      pageCount,
      canonicalHeadingDepth,
      medianSections,
      medianImages,
      reliable,
    });
  }

  // ── 3. Derive global density signals ──────────────────────────────────────

  const allSections   = nodes.map(n => n.visualHierarchy.sections);
  const allDepths     = nodes.map(n => n.visualHierarchy.headingDepth);
  const gridNodes     = byType.get("GridLayout") ?? [];
  const gridImages    = gridNodes.map(n => n.visualHierarchy.imageCount);
  const gridImageMedian = gridImages.length > 0 ? median(gridImages) : 3;

  const globalMedianSections = median(allSections);
  const spacingDensity: "compact" | "normal" | "spacious" =
    globalMedianSections > 6 ? "compact" : globalMedianSections < 3 ? "spacious" : "normal";

  const globalMedianDepth = median(allDepths);
  const typographyComplexity: "simple" | "standard" | "rich" =
    globalMedianDepth <= 1 ? "simple" : globalMedianDepth >= 3 ? "rich" : "standard";

  // ── 4. Assemble design tokens ─────────────────────────────────────────────

  const designTokens: DesignTokens = {
    spacingScale:         deriveSpacingScale(spacingDensity),
    fontScale:            deriveFontScale(typographyComplexity),
    gridSystem:           deriveGridSystem(gridImageMedian),
    headingDepthByStencil,
    sectionRangeByStencil,
    derivedFrom: {
      totalPages:            nodes.length,
      spacingDensity,
      typographyComplexity,
      gridImageMedian,
    },
  };

  // ── 5. Detect consistency issues ──────────────────────────────────────────

  const issues: ConsistencyIssue[] = [];
  const issuesByType = {} as Record<ConsistencyIssueType, number>;
  const issueBySeverity = {} as Record<ConsistencyIssueSeverity, number>;
  const initCount = (k: string) => { if (!issuesByType[k as ConsistencyIssueType]) issuesByType[k as ConsistencyIssueType] = 0; };
  const initSev   = (k: string) => { if (!issueBySeverity[k as ConsistencyIssueSeverity]) issueBySeverity[k as ConsistencyIssueSeverity] = 0; };

  const addIssue = (issue: ConsistencyIssue) => {
    issues.push(issue);
    initCount(issue.issueType); issuesByType[issue.issueType]++;
    initSev(issue.severity);   issueBySeverity[issue.severity]++;
  };

  for (const node of nodes) {
    const pattern = patternSummary.find(p => p.stencilType === node.stencilType)!;
    const canonical = headingDepthByStencil[node.stencilType];
    const sectionRange = sectionRangeByStencil[node.stencilType];

    // Heading depth deviation
    if (pattern.reliable && node.visualHierarchy.headingDepth !== canonical) {
      const delta = Math.abs(node.visualHierarchy.headingDepth - canonical);
      addIssue({
        nodeId:         node.nodeId,
        url:            node.url,
        stencilType:    node.stencilType,
        issueType:      "heading_depth_deviation",
        severity:       delta >= 2 ? "warning" : "info",
        description:    `Heading depth ${node.visualHierarchy.headingDepth} deviates from canonical ${canonical} for ${node.stencilType} pages.`,
        canonicalValue: canonical,
        actualValue:    node.visualHierarchy.headingDepth,
        fix:            `Normalize heading hierarchy to H1–H${canonical} structure.`,
      });
    }

    // Section count deviation
    const sc = node.visualHierarchy.sections;
    if (pattern.reliable && (sc < sectionRange.min || sc > sectionRange.max)) {
      const severe = sc < sectionRange.min / 2 || sc > sectionRange.max * 2;
      addIssue({
        nodeId:         node.nodeId,
        url:            node.url,
        stencilType:    node.stencilType,
        issueType:      "section_count_deviation",
        severity:       severe ? "warning" : "info",
        description:    `Section count ${sc} is outside expected range [${sectionRange.min}–${sectionRange.max}] for ${node.stencilType} pages.`,
        canonicalValue: `${sectionRange.min}–${sectionRange.max}`,
        actualValue:    sc,
        fix:            `Consolidate or split sections to align with the ${sectionRange.median}-section canonical pattern.`,
      });
    }

    // Card layout deviation (GridLayout pages only)
    if (node.stencilType === "GridLayout" && gridImages.length >= 2) {
      const imgMedian = gridImageMedian;
      const imgStd    = stdDev(gridImages) + 1;
      if (Math.abs(node.visualHierarchy.imageCount - imgMedian) > imgStd) {
        addIssue({
          nodeId:         node.nodeId,
          url:            node.url,
          stencilType:    "GridLayout",
          issueType:      "card_layout_deviation",
          severity:       "info",
          description:    `Image count ${node.visualHierarchy.imageCount} deviates from grid median ${Math.round(imgMedian)} — grid column count may mismatch.`,
          canonicalValue: Math.round(imgMedian),
          actualValue:    node.visualHierarchy.imageCount,
          fix:            `Apply ${designTokens.gridSystem.gridColumns}-column grid with consistent card density.`,
        });
      }
    }

    // Missing visual hierarchy (pages with no headings at all)
    if (node.visualHierarchy.headingDepth === 0 && node.visualHierarchy.wordCount > 100) {
      addIssue({
        nodeId:         node.nodeId,
        url:            node.url,
        stencilType:    node.stencilType,
        issueType:      "missing_visual_hierarchy",
        severity:       "warning",
        description:    `Page has ${node.visualHierarchy.wordCount} words but no detected heading structure.`,
        canonicalValue: canonical,
        actualValue:    0,
        fix:            `Add H1 and at least one H${Math.min(canonical, 2)} to establish heading hierarchy.`,
      });
    }

    // Singleton stencil types — flag for awareness
    if (!pattern.reliable && pattern.pageCount === 1) {
      addIssue({
        nodeId:         node.nodeId,
        url:            node.url,
        stencilType:    node.stencilType,
        issueType:      "stencil_singleton",
        severity:       "info",
        description:    `Only one page classified as ${node.stencilType} — consistency normalization is approximate.`,
        canonicalValue: "≥2 pages",
        actualValue:    1,
        fix:            `Tokens derived from global defaults; verify design intent for this page type.`,
      });
    }
  }

  // ── 6. Build normalized stencil map ───────────────────────────────────────

  let normalizedCount = 0;
  const designTokensApplied = new Set<string>();

  const normalizedNodes: NormalizedStencilNode[] = nodes.map(node => {
    const canonical        = headingDepthByStencil[node.stencilType];
    const sectionRange     = sectionRangeByStencil[node.stencilType];
    const appliedTokens: string[] = [];
    let changed = false;

    // Heading depth normalization
    let headingDepth = node.visualHierarchy.headingDepth;
    if (headingDepth !== canonical) {
      headingDepth = canonical;
      appliedTokens.push("headingDepth");
      designTokensApplied.add("headingDepth");
      changed = true;
    }

    // Section count normalization (clamp to canonical range)
    let sectionCount = node.visualHierarchy.sections;
    if (sectionCount < sectionRange.min) {
      sectionCount = sectionRange.min;
      appliedTokens.push("sectionMin");
      designTokensApplied.add("sectionRange");
      changed = true;
    } else if (sectionCount > sectionRange.max) {
      sectionCount = sectionRange.max;
      appliedTokens.push("sectionMax");
      designTokensApplied.add("sectionRange");
      changed = true;
    }

    // Grid columns (GridLayout only)
    let gridColumns: 2 | 3 | 4 | undefined;
    if (node.stencilType === "GridLayout") {
      gridColumns = designTokens.gridSystem.gridColumns;
      appliedTokens.push("gridColumns");
      designTokensApplied.add("gridColumns");
    }

    // Spacing density (from global token)
    appliedTokens.push(`spacing:${spacingDensity}`);
    designTokensApplied.add("spacingScale");

    // Typography complexity
    appliedTokens.push(`typography:${typographyComplexity}`);
    designTokensApplied.add("fontScale");

    if (changed) normalizedCount++;

    return {
      ...node,
      normalizedLayout: {
        headingDepth,
        sectionCount,
        gridColumns,
        spacingDensity,
        typographyComplexity,
        normalized: changed,
        appliedTokens,
      },
    };
  });

  // ── 7. Compute overall consistency score ──────────────────────────────────
  // Score = 100 - (weighted issue penalty)
  const errorCount   = issueBySeverity["error"]   ?? 0;
  const warningCount = issueBySeverity["warning"]  ?? 0;
  const infoCount    = issueBySeverity["info"]     ?? 0;
  const penalty = (errorCount * 10 + warningCount * 5 + infoCount * 1);
  const maxPenalty = nodes.length * 16; // worst case: every node has all severity levels
  const overallConsistencyScore = Math.max(0, Math.round(
    100 - (maxPenalty > 0 ? (penalty / maxPenalty) * 100 : 0)
  ));

  // ── 8. Assemble report ────────────────────────────────────────────────────

  const report: ConsistencyReport = {
    schemaVersion:  "6.7",
    jobId:          stencilMap.jobId,
    seedUrl:        stencilMap.seedUrl,
    generatedAt:    new Date().toISOString(),
    designTokens,
    patternSummary,
    issues,
    summary: {
      totalNodes:               nodes.length,
      normalizedNodes:          normalizedCount,
      issueCount:               issues.length,
      issuesByType,
      issueBySeverity,
      designTokensApplied:      designTokensApplied.size,
      overallConsistencyScore,
    },
  };

  const normalizedMap: NormalizedStencilMap = {
    ...stencilMap,
    designTokens,
    nodes: normalizedNodes,
  };

  logger.info(
    {
      jobId:                  stencilMap.jobId,
      totalNodes:             nodes.length,
      normalizedNodes:        normalizedCount,
      issueCount:             issues.length,
      overallConsistencyScore,
      designTokensApplied:    designTokensApplied.size,
    },
    "CONSISTENCY: engine complete"
  );

  return { report, normalizedMap };
}

// ── R2 helpers ────────────────────────────────────────────────────────────────

async function r2Client() {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({
    region:      "auto",
    endpoint:    process.env.R2_ENDPOINT          ?? "",
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID     ?? "",
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    },
  });
}

async function uploadJson(data: unknown, key: string): Promise<boolean> {
  const bucket = process.env.R2_BUCKET_NAME ?? "";
  if (!bucket || !process.env.R2_ENDPOINT) return false;
  try {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await r2Client();
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: key,
      Body: Buffer.from(JSON.stringify(data, null, 2), "utf8"),
      ContentType: "application/json",
    }));
    return true;
  } catch (err) {
    logger.warn({ err, key }, "CONSISTENCY: R2 upload failed");
    return false;
  }
}

async function fetchJson<T>(key: string): Promise<T | null> {
  const bucket = process.env.R2_BUCKET_NAME ?? "";
  if (!bucket || !process.env.R2_ENDPOINT) return null;
  try {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await r2Client();
    const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks: Buffer[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const chunk of (resp.Body as any)) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ConsistencyEngineResult {
  report:        ConsistencyReport;
  normalizedMap: NormalizedStencilMap;
  reportR2Key?:  string;
  mapR2Key?:     string;
}

/**
 * runAndStoreConsistencyEngine — Phase 6.7 public entry point.
 *
 * Loads visualStencilMap from R2, runs consistency analysis,
 * uploads both outputs, returns the full result.
 */
export async function runAndStoreConsistencyEngine(
  jobId: string,
  /** Optional pre-loaded stencil map (avoids a second R2 fetch) */
  stencilMap?: VisualStencilMap
): Promise<ConsistencyEngineResult> {

  // Load stencil map if not provided
  const map = stencilMap ?? await fetchJson<VisualStencilMap>(`jobs/${jobId}/visual-stencil-map.json`);
  if (!map) {
    throw new Error(`CONSISTENCY: visual-stencil-map.json not found for job "${jobId}". ` +
      `Run POST /api/stencil-map/${jobId} first.`);
  }

  const { report, normalizedMap } = runConsistencyEngine(map);

  // Upload both outputs in parallel
  const reportKey = `jobs/${jobId}/consistency-report.json`;
  const mapKey    = `jobs/${jobId}/normalized-stencil-map.json`;

  const [reportUploaded, mapUploaded] = await Promise.all([
    uploadJson(report,        reportKey),
    uploadJson(normalizedMap, mapKey),
  ]);

  if (reportUploaded) report.r2Key        = reportKey;
  if (mapUploaded)    normalizedMap.r2Key = mapKey;

  return {
    report,
    normalizedMap,
    reportR2Key: reportUploaded ? reportKey : undefined,
    mapR2Key:    mapUploaded    ? mapKey    : undefined,
  };
}
