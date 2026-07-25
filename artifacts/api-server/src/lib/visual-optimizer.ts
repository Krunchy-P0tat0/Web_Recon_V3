/**
 * visual-optimizer.ts  — PF-3
 *
 * Converts visual differences (PF-2 issues) into prioritised RuleAdjustment[].
 *
 * Prioritisation criteria:
 *   1. Largest visual gain (ssimDelta × affectedArea)
 *   2. Lowest implementation cost (simpler adjustments score higher)
 *   3. Highest confidence
 *
 * Outputs (disk + R2):
 *   optimization-plan.json
 *   expected-fidelity-gain.json
 *   updated-adjustments.json
 */

import { writeFile }         from "fs/promises";
import { join }              from "path";
import { logger }            from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import {
  makeLayoutAdjustment,
  makeTypographyAdjustment,
  makeSpacingAdjustment,
  makeColorsAdjustment,
  makeComponentPlacementAdjustment,
  makeNavigationAdjustment,
  makeImagesAdjustment,
  makeResponsiveAdjustment,
  type RuleAdjustment,
  type AdjustmentType,
} from "./rule-adjustment-contract.js";
import type {
  VisualDiffIssue,
  VisualDiffType,
  IssueSeverity,
  ComponentErrorReport,
} from "./visual-diff-localizer.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OptimizationItem {
  rank:              number;
  adjustmentType:    AdjustmentType;
  sourceIssueIds:    string[];        // PF-2 issue IDs this addresses
  expectedSsimGain:  number;          // 0–1 per issue, aggregated
  implementationCost: number;         // 1 (low) – 5 (high)
  priorityScore:     number;          // computed composite score
  confidence:        number;          // 0–1
  affectedRegions:   string[];
  description:       string;
  rationale:         string;
}

export interface OptimizationPlan {
  schemaVersion:    "PF-3";
  sourceJobId:      string;
  generatedJobId:   string;
  generatedAt:      string;
  durationMs:       number;
  totalItems:       number;
  estimatedOverallGain: number;       // total expected SSIM improvement (sum, capped at 0.6)
  items:            OptimizationItem[];
  r2Keys: {
    plan:                string | null;
    expectedGain:        string | null;
    updatedAdjustments:  string | null;
  };
}

export interface CategoryGain {
  adjustmentType:  AdjustmentType;
  currentSsim:     number | null;     // null = unknown
  expectedSsim:    number | null;
  expectedGain:    number;            // absolute SSIM gain
  gainPercent:     number;            // relative gain
  issueCount:      number;
  confidence:      number;
}

export interface ExpectedFidelityGain {
  schemaVersion:     "PF-3";
  sourceJobId:       string;
  generatedJobId:    string;
  generatedAt:       string;
  baselineSsim:      number | null;
  projectedSsim:     number | null;
  totalExpectedGain: number;
  byCategory:        CategoryGain[];
  methodology:       string;
}

export interface OptimizerOptions {
  sourceJobId:    string;
  generatedJobId: string;
  /** PF-2 component error report (required) */
  componentErrors: ComponentErrorReport;
  /** Current overall SSIM from PF-1 (for baseline) */
  baselineSsim?:  number;
  /** Max adjustments to produce (default 10) */
  maxAdjustments?: number;
  /** Existing adjustments to merge into (P0-1 compatible) */
  existingAdjustments?: RuleAdjustment[];
}

// ---------------------------------------------------------------------------
// Cost model: how expensive is each adjustment to implement
// ---------------------------------------------------------------------------

const IMPLEMENTATION_COST: Record<AdjustmentType, number> = {
  colors:               1,   // easiest — swap palette tokens
  spacing:              2,   // medium — adjust scale tokens
  typography:           2,   // medium — font/size tokens
  navigation:           2,   // medium — structural but isolated
  images:               3,   // slightly harder — layout + alt text
  layout:               4,   // harder — section reorder
  component_placement:  4,   // harder — component wiring
  responsive:           5,   // hardest — breakpoint system
};

// Mapping from PF-2 diff type → most relevant AdjustmentType
const DIFF_TO_ADJUSTMENT: Record<VisualDiffType, AdjustmentType> = {
  spacing:          "spacing",
  typography:       "typography",
  image_placement:  "images",
  component_sizing: "component_placement",
  alignment:        "layout",
  color_difference: "colors",
  navigation:       "navigation",
  section_mismatch: "layout",
};

// Secondary adjustment (sometimes an issue benefits from 2 categories)
const DIFF_TO_SECONDARY: Partial<Record<VisualDiffType, AdjustmentType>> = {
  typography:       "spacing",
  image_placement:  "component_placement",
  component_sizing: "layout",
  section_mismatch: "responsive",
};

// Severity → raw gain weight
const SEVERITY_GAIN: Record<IssueSeverity, number> = {
  critical: 0.20,
  high:     0.12,
  medium:   0.06,
  low:      0.02,
};

// ---------------------------------------------------------------------------
// Priority scoring
// ---------------------------------------------------------------------------

function priorityScore(
  gain:       number,
  cost:       number,
  confidence: number,
): number {
  const costFactor = (6 - cost) / 5;       // invert so cost 1 → 1.0, cost 5 → 0.2
  return Math.round(gain * costFactor * confidence * 1000) / 10;
}

// ---------------------------------------------------------------------------
// Build RuleAdjustment from PF-2 issues grouped by type
// ---------------------------------------------------------------------------

function makeAdjustmentForType(
  type:    AdjustmentType,
  issues:  VisualDiffIssue[],
  jobId:   string,
): RuleAdjustment {
  const avgConf    = issues.reduce((s, i) => s + i.confidence, 0) / issues.length;
  const totalGain  = issues.reduce((s, i) => s + SEVERITY_GAIN[i.severity], 0);
  const regionList = [...new Set(issues.map((i) => {
    if (i.location.yPct < 15)          return "navigation";
    if (i.location.yPct > 80)          return "footer";
    if (i.location.yPct < 35)          return "header";
    return "main_content";
  }))];
  const desc = `PF-3 optimization: fix ${issues.length} ${type} issue(s) — estimated SSIM gain ${Math.round(totalGain * 100) / 100}`;

  const regions = regionList.join(", ");
  switch (type) {
    case "layout":
      return makeLayoutAdjustment(
        jobId, "section-misaligned", `reorder-to-match-source:${regions}`,
        desc, avgConf, "PF-3",
      );
    case "typography":
      return makeTypographyAdjustment(
        jobId, "font-mismatch", `align-typography:${regions}`,
        desc, avgConf, "PF-3",
      );
    case "spacing":
      return makeSpacingAdjustment(
        jobId, "padding-gap", `fix-spacing:${regions}`,
        desc, avgConf, "PF-3",
      );
    case "colors":
      return makeColorsAdjustment(
        jobId, "palette-drift", `correct-palette:${regions}`,
        desc, avgConf, "PF-3",
      );
    case "component_placement":
      return makeComponentPlacementAdjustment(
        jobId, "sizing-mismatch", `fix-component:${regions}`,
        desc, avgConf, "PF-3",
      );
    case "navigation":
      return makeNavigationAdjustment(
        jobId, "nav-structure", "fix-navigation-layout",
        desc, avgConf, "PF-3",
      );
    case "images":
      return makeImagesAdjustment(
        jobId, "image-placement", `fix-image:${regions}`,
        desc, avgConf, "PF-3",
      );
    case "responsive":
      return makeResponsiveAdjustment(
        jobId, "breakpoint-drift", `fix-responsive:${regions}`,
        desc, avgConf, "PF-3",
      );
  }
}

// ---------------------------------------------------------------------------
// Merge adjustments: if same type already in existingAdjustments, keep higher-confidence
// ---------------------------------------------------------------------------

function mergeAdjustments(
  existing: RuleAdjustment[],
  newAdjs:  RuleAdjustment[],
): RuleAdjustment[] {
  const merged = new Map<AdjustmentType, RuleAdjustment>();

  for (const adj of existing) {
    merged.set(adj.adjustmentType, adj);
  }
  for (const adj of newAdjs) {
    const ex = merged.get(adj.adjustmentType);
    if (!ex || adj.confidence > ex.confidence) {
      merged.set(adj.adjustmentType, adj);
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.confidence - a.confidence);
}

// ---------------------------------------------------------------------------
// Disk + R2 helpers
// ---------------------------------------------------------------------------

async function writeDisk(filename: string, data: unknown): Promise<void> {
  await writeFile(join(process.cwd(), filename), JSON.stringify(data, null, 2), "utf8");
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

export async function runVisualOptimizer(
  opts: OptimizerOptions,
): Promise<{
  plan:               OptimizationPlan;
  expectedGain:       ExpectedFidelityGain;
  updatedAdjustments: RuleAdjustment[];
}> {
  const {
    sourceJobId, generatedJobId,
    componentErrors,
    baselineSsim = null,
    maxAdjustments = 10,
    existingAdjustments = [],
  } = opts;
  const t0 = Date.now();

  logger.info({ sourceJobId, generatedJobId, issueCount: componentErrors.totalComponents },
    "PF-3: starting visual optimizer");

  const issues = componentErrors.components.map((c): VisualDiffIssue => ({
    id:             c.componentId,
    type:           c.componentType,
    severity:       c.severity,
    confidence:     c.confidence,
    location:       c.location,
    description:    c.description,
    affectedPixels: 0,
    ssimDelta:      c.estimatedGain,
    colorDelta:     0,
    edgeDensity:    0,
    suggestedFix:   c.suggestedFix,
  }));

  // ── Group issues by primary adjustment type ────────────────────────────────
  const byType = new Map<AdjustmentType, VisualDiffIssue[]>();
  for (const issue of issues) {
    const primary   = DIFF_TO_ADJUSTMENT[issue.type];
    const secondary = DIFF_TO_SECONDARY[issue.type];
    for (const adjType of [primary, ...(secondary ? [secondary] : [])]) {
      const arr = byType.get(adjType) ?? [];
      arr.push(issue);
      byType.set(adjType, arr);
    }
  }

  // ── Score each adjustment group ─────────────────────────────────────────────
  const items: OptimizationItem[] = [];

  for (const [adjType, groupIssues] of byType.entries()) {
    const gain       = Math.min(0.4, groupIssues.reduce((s, i) => s + SEVERITY_GAIN[i.severity], 0));
    const cost       = IMPLEMENTATION_COST[adjType];
    const avgConf    = groupIssues.reduce((s, i) => s + i.confidence, 0) / groupIssues.length;
    const pScore     = priorityScore(gain, cost, avgConf);
    const regions    = [...new Set(groupIssues.map((i) => {
      if (i.location.yPct < 15) return "navigation";
      if (i.location.yPct > 80) return "footer";
      if (i.location.yPct < 35) return "header";
      return "main_content";
    }))];

    items.push({
      rank:              0,  // assigned after sort
      adjustmentType:    adjType,
      sourceIssueIds:    [...new Set(groupIssues.map((i) => i.id))],
      expectedSsimGain:  Math.round(gain * 1000) / 1000,
      implementationCost: cost,
      priorityScore:     pScore,
      confidence:        Math.round(avgConf * 100) / 100,
      affectedRegions:   regions,
      description:       `Apply ${adjType} adjustment to resolve ${groupIssues.length} visual issue(s)`,
      rationale:         `Gain: ${Math.round(gain * 100)}% SSIM improvement | Cost: ${cost}/5 | Confidence: ${Math.round(avgConf * 100)}%`,
    });
  }

  // Sort by priority descending; assign ranks
  items.sort((a, b) => b.priorityScore - a.priorityScore);
  items.forEach((item, i) => { item.rank = i + 1; });
  const topItems = items.slice(0, maxAdjustments);

  // ── Build RuleAdjustments ──────────────────────────────────────────────────
  const newAdjustments: RuleAdjustment[] = topItems.map((item) =>
    makeAdjustmentForType(item.adjustmentType, byType.get(item.adjustmentType) ?? [], sourceJobId),
  );
  const updatedAdjustments = mergeAdjustments(existingAdjustments, newAdjustments);

  // ── Build expected fidelity gain ───────────────────────────────────────────
  const totalExpectedGain = Math.min(
    0.60,
    topItems.reduce((s, i) => s + i.expectedSsimGain, 0),
  );

  const byCategory: CategoryGain[] = topItems.map((item) => {
    const groupIssues = byType.get(item.adjustmentType) ?? [];
    return {
      adjustmentType: item.adjustmentType,
      currentSsim:    baselineSsim !== null ? Math.round(baselineSsim * 1000) / 1000 : null,
      expectedSsim:   baselineSsim !== null
        ? Math.round(Math.min(1, baselineSsim + item.expectedSsimGain) * 1000) / 1000
        : null,
      expectedGain:   item.expectedSsimGain,
      gainPercent:    Math.round(item.expectedSsimGain * 100 * 10) / 10,
      issueCount:     groupIssues.length,
      confidence:     item.confidence,
    };
  });

  const projectedSsim = baselineSsim !== null
    ? Math.round(Math.min(1, baselineSsim + totalExpectedGain) * 1000) / 1000
    : null;

  const durationMs = Date.now() - t0;
  const r2Base     = `jobs/${sourceJobId}/visual-optimizer`;

  const plan: OptimizationPlan = {
    schemaVersion:        "PF-3",
    sourceJobId, generatedJobId,
    generatedAt:          new Date().toISOString(),
    durationMs,
    totalItems:           topItems.length,
    estimatedOverallGain: Math.round(totalExpectedGain * 1000) / 1000,
    items:                topItems,
    r2Keys: { plan: null, expectedGain: null, updatedAdjustments: null },
  };

  const expectedGain: ExpectedFidelityGain = {
    schemaVersion:     "PF-3",
    sourceJobId, generatedJobId,
    generatedAt:       new Date().toISOString(),
    baselineSsim:      baselineSsim !== null ? Math.round(baselineSsim * 1000) / 1000 : null,
    projectedSsim,
    totalExpectedGain: Math.round(totalExpectedGain * 1000) / 1000,
    byCategory,
    methodology:
      "Priority score = gain × (6 - cost)/5 × confidence. Gain is derived from severity weights " +
      "(critical=0.20, high=0.12, medium=0.06, low=0.02 SSIM points per issue) aggregated per " +
      "adjustment category, capped at 0.40. Total gain capped at 0.60 to reflect diminishing returns.",
  };

  // ── Write disk ─────────────────────────────────────────────────────────────
  await Promise.all([
    writeDisk("optimization-plan.json",    plan),
    writeDisk("expected-fidelity-gain.json", expectedGain),
    writeDisk("updated-adjustments.json",  updatedAdjustments),
  ]);

  // ── Upload R2 ──────────────────────────────────────────────────────────────
  const [u1, u2, u3] = await Promise.all([
    uploadR2Json(`${r2Base}/optimization-plan.json`,    plan),
    uploadR2Json(`${r2Base}/expected-fidelity-gain.json`, expectedGain),
    uploadR2Json(`${r2Base}/updated-adjustments.json`,  updatedAdjustments),
  ]);
  plan.r2Keys = {
    plan:               u1 ? `${r2Base}/optimization-plan.json`      : null,
    expectedGain:       u2 ? `${r2Base}/expected-fidelity-gain.json` : null,
    updatedAdjustments: u3 ? `${r2Base}/updated-adjustments.json`    : null,
  };
  await writeDisk("optimization-plan.json", plan);

  logger.info({
    sourceJobId, generatedJobId,
    topItems: topItems.length,
    totalExpectedGain,
    updatedAdjustmentsCount: updatedAdjustments.length,
    durationMs,
  }, "PF-3: done");

  return { plan, expectedGain, updatedAdjustments };
}
