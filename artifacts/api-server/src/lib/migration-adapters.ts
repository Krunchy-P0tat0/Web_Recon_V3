/**
 * migration-adapters.ts — CP-1: Migration Adapters
 *
 * Adapts deprecated Phase 2.5x and Phase 6.x type shapes into
 * the canonical visual-schema-v1 types so that consumers can be
 * migrated incrementally without breaking changes.
 *
 * Adapters follow the naming convention:
 *   adapt<SourcePhase>To<CanonicalType>(input) → CanonicalType
 */

import type {
  CanonicalVisualDNA,
  CanonicalFidelityReport,
  CanonicalRuleAdjustment,
  CanonicalFidelityGrade,
  CanonicalColorPalette,
  CanonicalTypographyDNA,
  CanonicalSpacingDNA,
  CanonicalLayoutDNA,
  CanonicalBordersDNA,
  CanonicalHierarchyDNA,
} from "./visual-schema-v1.js";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Adapter 1: Phase 2.5B VisualDna → CanonicalVisualDNA
// Source: visual-dna-engine.ts (deprecated)
// Target: screenshot-visual-dna-engine.ts / visual-schema-v1.ts
// ---------------------------------------------------------------------------

interface Phase25BColorSystem {
  primary?:    string[];
  secondary?:  string[];
  background?: string[];
  text?:       string[];
  confidence?: number;
}

interface Phase25BTypography {
  families?:   string[];
  sizeScale?:  string[];
  weights?:    (string | number)[];
  lineHeights?: string[];
  confidence?: number;
}

interface Phase25BLayout {
  containerWidths?: string[];
  gridColumns?:     number[];
  breakpoints?:     string[];
  maxWidth?:        string | null;
  sectionSpacing?:  string[];
  confidence?:      number;
}

interface Phase25BVisualDna {
  jobId?:       string;
  pageCount?:   number;
  generatedAt?: string;
  colorSystem?: Phase25BColorSystem;
  typography?:  Phase25BTypography;
  layout?:      Phase25BLayout;
  confidence?:  number;
}

export function adaptPhase25BToCanonicalVisualDNA(
  input: Phase25BVisualDna,
  jobId: string,
): CanonicalVisualDNA {
  const cs = input.colorSystem ?? {};
  const ty = input.typography ?? {};
  const ly = input.layout ?? {};

  const colors: CanonicalColorPalette = {
    schemaVersion: "v1",
    primary:       cs.primary    ?? [],
    secondary:     cs.secondary  ?? [],
    background:    cs.background ?? [],
    text:          cs.text       ?? [],
    accent:        [],
    confidence:    cs.confidence ?? 0,
  };

  const typography: CanonicalTypographyDNA = {
    schemaVersion:  "v1",
    families:       ty.families    ?? [],
    sizeScale:      ty.sizeScale   ?? [],
    weightScale:    ty.weights     ?? [],
    lineHeights:    ty.lineHeights ?? [],
    letterSpacings: [],
    confidence:     ty.confidence  ?? 0,
  };

  const spacing: CanonicalSpacingDNA = {
    schemaVersion:  "v1",
    scale:          ly.sectionSpacing ?? [],
    sectionSpacing: ly.sectionSpacing ?? [],
    containerGaps:  [],
    confidence:     ly.confidence ?? 0,
  };

  const layout: CanonicalLayoutDNA = {
    schemaVersion:   "v1",
    containerWidths: ly.containerWidths ?? [],
    gridColumns:     ly.gridColumns     ?? [],
    breakpoints:     ly.breakpoints     ?? [],
    maxWidth:        ly.maxWidth        ?? null,
    sectionSpacing:  ly.sectionSpacing  ?? [],
    confidence:      ly.confidence      ?? 0,
  };

  const hierarchy: CanonicalHierarchyDNA = {
    schemaVersion:    "v1",
    headingLevels:    {},
    shadowScale:      [],
    zIndexLevels:     [],
    overlayOpacities: [],
    confidence:       0,
  };

  const borders: CanonicalBordersDNA = {
    schemaVersion: "v1",
    radiusScale:   [],
    widthScale:    [],
    stylePatterns: [],
    confidence:    0,
  };

  return {
    schemaVersion:     "v1",
    jobId:             input.jobId ?? jobId,
    pageCount:         input.pageCount ?? 0,
    generatedAt:       input.generatedAt ?? new Date().toISOString(),
    colors,
    typography,
    spacing,
    layout,
    hierarchy,
    borders,
    viewports:         { desktop: "1440px", tablet: "768px", mobile: "390px" },
    overallConfidence: input.confidence ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Adapter 2: Phase 6.5 FidelityReport → CanonicalFidelityReport
// Source: visual-fidelity-engine.ts (deprecated)
// Target: visual-schema-v1.ts
// ---------------------------------------------------------------------------

interface Phase65MetricScore {
  score:  number;
  weight: number;
  issues: string[];
}

interface Phase65FidelityReport {
  sourceJobId?:    string;
  generatedJobId?: string;
  seedUrl?:        string;
  generatedAt?:    string;
  durationMs?:     number;
  grade?:          string;
  totalScore?:     number;
  dimensions?: {
    layout?:     Phase65MetricScore;
    color?:      Phase65MetricScore;
    spacing?:    Phase65MetricScore;
    component?:  Phase65MetricScore;
    navigation?: Phase65MetricScore;
    responsive?: Phase65MetricScore;
  };
}

function gradeFrom(score: number): CanonicalFidelityGrade {
  if (score >= 95) return "A+";
  if (score >= 85) return "A";
  if (score >= 75) return "B";
  if (score >= 65) return "C";
  if (score >= 50) return "D";
  return "F";
}

export function adaptPhase65ToCanonicalFidelityReport(
  input: Phase65FidelityReport,
): CanonicalFidelityReport {
  const dims = input.dimensions ?? {};
  const dimNames: (keyof typeof dims)[] = [
    "layout", "color", "spacing", "component", "navigation", "responsive",
  ];

  const dimensions = dimNames
    .filter(n => dims[n] !== undefined)
    .map(n => ({
      name:   n,
      score:  dims[n]!.score  * 100,
      weight: dims[n]!.weight,
      issues: dims[n]!.issues ?? [],
    }));

  const totalScore = input.totalScore != null
    ? input.totalScore * 100
    : dimensions.reduce((s, d) => s + d.score * d.weight, 0) /
      Math.max(dimensions.reduce((s, d) => s + d.weight, 0), 1);

  const sorted = [...dimensions].sort((a, b) => b.score - a.score);

  return {
    schemaVersion:   "v1",
    sourceJobId:     input.sourceJobId    ?? "",
    generatedJobId:  input.generatedJobId ?? "",
    seedUrl:         input.seedUrl        ?? "",
    generatedAt:     input.generatedAt    ?? new Date().toISOString(),
    durationMs:      input.durationMs     ?? 0,
    pipelineStage:   "Phase-6.5→v1-adapter",
    dimensions,
    totalScore,
    grade:           gradeFrom(totalScore),
    issues:          [],
    pagesCompared:   1,
    summary: {
      topDimension:    sorted[0]?.name    ?? "unknown",
      weakDimension:   sorted[sorted.length - 1]?.name ?? "unknown",
      issueBySeverity: { high: 0, medium: 0, low: 0 },
      pagesAbove75:    totalScore >= 75 ? 1 : 0,
      pagesBelowPass:  totalScore < 60  ? 1 : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter 3: VR-8 internal RuleAdjustment union → CanonicalRuleAdjustment
// Source: reconstruction-loop-engine-vr8.ts (internal discriminated union)
// Target: visual-schema-v1.ts
// ---------------------------------------------------------------------------

interface VR8ColorAdjustment {
  kind:        "color";
  action:      string;
  palette?:    string[];
  confidence:  number;
  priority:    number;
}

interface VR8LayoutAdjustment {
  kind:        "layout";
  action:      string;
  breakpoints?: string[];
  maxWidth?:    string;
  confidence:  number;
  priority:    number;
}

interface VR8ComponentAdjustment {
  kind:        "component";
  action:      string;
  slot?:       string;
  stencilId?:  string;
  confidence:  number;
  priority:    number;
}

interface VR8SpacingAdjustment {
  kind:        "spacing";
  action:      string;
  scale?:      string[];
  confidence:  number;
  priority:    number;
}

interface VR8TypographyAdjustment {
  kind:         "typography";
  action:       string;
  families?:    string[];
  sizeScale?:   string[];
  weights?:     string[];
  confidence:   number;
  priority:     number;
}

type VR8RuleAdjustment =
  | VR8ColorAdjustment
  | VR8LayoutAdjustment
  | VR8ComponentAdjustment
  | VR8SpacingAdjustment
  | VR8TypographyAdjustment;

const KIND_TO_ADJUSTMENT_TYPE: Record<string, CanonicalRuleAdjustment["adjustmentType"]> = {
  color:      "colors",
  layout:     "layout",
  component:  "component_placement",
  spacing:    "spacing",
  typography: "typography",
};

export function adaptVR8AdjustmentToCanonical(
  input: VR8RuleAdjustment,
  originatingEngine = "VR-8",
): CanonicalRuleAdjustment {
  const adjustmentType = KIND_TO_ADJUSTMENT_TYPE[input.kind] ?? "layout";

  let currentValue: unknown = null;
  let suggestedValue: unknown = null;
  let targetNode = "*";

  if (input.kind === "color") {
    suggestedValue = input.palette ?? [];
  } else if (input.kind === "layout") {
    suggestedValue = { maxWidth: input.maxWidth, breakpoints: input.breakpoints };
  } else if (input.kind === "component") {
    targetNode     = input.slot ?? "*";
    suggestedValue = { stencilId: input.stencilId, action: input.action };
  } else if (input.kind === "spacing") {
    suggestedValue = input.scale ?? [];
  } else if (input.kind === "typography") {
    suggestedValue = {
      families:  input.families,
      sizeScale: input.sizeScale,
      weights:   input.weights,
    };
  }

  return {
    schemaVersion:     "v1",
    id:                randomUUID(),
    targetNode,
    adjustmentType,
    currentValue,
    suggestedValue,
    confidence:        input.confidence,
    reason:            `VR-8 ${input.kind} adjustment: ${input.action}`,
    originatingEngine,
    timestamp:         new Date().toISOString(),
    priority:          input.priority,
    autoApplicable:    input.confidence >= 0.75,
  };
}

export function adaptVR8AdjustmentsToCanonical(
  inputs: VR8RuleAdjustment[],
  originatingEngine = "VR-8",
): CanonicalRuleAdjustment[] {
  return inputs.map(i => adaptVR8AdjustmentToCanonical(i, originatingEngine));
}
