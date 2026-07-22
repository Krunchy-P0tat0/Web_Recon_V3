/**
 * rule-adjustment-contract.ts — P0-1: Shared Rule Adjustment Contract
 *
 * Defines the canonical RuleAdjustment type shared across:
 *   - Visual Reconstruction (VR-1 … VR-8)
 *   - Website Prime Generator
 *   - Stencil Generator
 *
 * Every adjustment carries a full audit trail: id, targetNode,
 * adjustmentType, currentValue, suggestedValue, confidence,
 * reason, originatingEngine, and timestamp.
 *
 * Categories (adjustmentType):
 *   layout | typography | spacing | colors | component_placement |
 *   navigation | images | responsive
 */

import { randomUUID } from "crypto";

// Alias used by engines that import CanonicalRuleAdjustment by name
export type CanonicalRuleAdjustment = RuleAdjustment;

// ---------------------------------------------------------------------------
// Adjustment type discriminant
// ---------------------------------------------------------------------------

export type AdjustmentType =
  | "layout"
  | "typography"
  | "spacing"
  | "colors"
  | "component_placement"
  | "navigation"
  | "images"
  | "responsive";

// ---------------------------------------------------------------------------
// Core contract — every adjustment must satisfy this shape
// ---------------------------------------------------------------------------

export interface RuleAdjustment {
  /** Unique identifier for this adjustment instance. */
  id: string;

  /**
   * CSS selector, component name, stencil slot, or logical node
   * identifier that this adjustment targets.
   */
  targetNode: string;

  /** Category of the adjustment. */
  adjustmentType: AdjustmentType;

  /** The value currently in the generated output. */
  currentValue: unknown;

  /** The recommended replacement value derived from the source site. */
  suggestedValue: unknown;

  /** Confidence score 0–1 (higher = more certain). */
  confidence: number;

  /** Human-readable explanation of why this adjustment is needed. */
  reason: string;

  /** Name of the VR engine that produced this adjustment (e.g. "VR-7"). */
  originatingEngine: string;

  /** ISO-8601 timestamp when the adjustment was created. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Per-category helper builders
// ---------------------------------------------------------------------------

export function makeLayoutAdjustment(
  targetNode: string,
  currentValue: unknown,
  suggestedValue: unknown,
  reason: string,
  confidence: number,
  originatingEngine: string,
): RuleAdjustment {
  return {
    id: randomUUID(),
    targetNode,
    adjustmentType: "layout",
    currentValue,
    suggestedValue,
    confidence,
    reason,
    originatingEngine,
    timestamp: new Date().toISOString(),
  };
}

export function makeTypographyAdjustment(
  targetNode: string,
  currentValue: unknown,
  suggestedValue: unknown,
  reason: string,
  confidence: number,
  originatingEngine: string,
): RuleAdjustment {
  return {
    id: randomUUID(),
    targetNode,
    adjustmentType: "typography",
    currentValue,
    suggestedValue,
    confidence,
    reason,
    originatingEngine,
    timestamp: new Date().toISOString(),
  };
}

export function makeSpacingAdjustment(
  targetNode: string,
  currentValue: unknown,
  suggestedValue: unknown,
  reason: string,
  confidence: number,
  originatingEngine: string,
): RuleAdjustment {
  return {
    id: randomUUID(),
    targetNode,
    adjustmentType: "spacing",
    currentValue,
    suggestedValue,
    confidence,
    reason,
    originatingEngine,
    timestamp: new Date().toISOString(),
  };
}

export function makeColorsAdjustment(
  targetNode: string,
  currentValue: unknown,
  suggestedValue: unknown,
  reason: string,
  confidence: number,
  originatingEngine: string,
): RuleAdjustment {
  return {
    id: randomUUID(),
    targetNode,
    adjustmentType: "colors",
    currentValue,
    suggestedValue,
    confidence,
    reason,
    originatingEngine,
    timestamp: new Date().toISOString(),
  };
}

export function makeComponentPlacementAdjustment(
  targetNode: string,
  currentValue: unknown,
  suggestedValue: unknown,
  reason: string,
  confidence: number,
  originatingEngine: string,
): RuleAdjustment {
  return {
    id: randomUUID(),
    targetNode,
    adjustmentType: "component_placement",
    currentValue,
    suggestedValue,
    confidence,
    reason,
    originatingEngine,
    timestamp: new Date().toISOString(),
  };
}

export function makeNavigationAdjustment(
  targetNode: string,
  currentValue: unknown,
  suggestedValue: unknown,
  reason: string,
  confidence: number,
  originatingEngine: string,
): RuleAdjustment {
  return {
    id: randomUUID(),
    targetNode,
    adjustmentType: "navigation",
    currentValue,
    suggestedValue,
    confidence,
    reason,
    originatingEngine,
    timestamp: new Date().toISOString(),
  };
}

export function makeImagesAdjustment(
  targetNode: string,
  currentValue: unknown,
  suggestedValue: unknown,
  reason: string,
  confidence: number,
  originatingEngine: string,
): RuleAdjustment {
  return {
    id: randomUUID(),
    targetNode,
    adjustmentType: "images",
    currentValue,
    suggestedValue,
    confidence,
    reason,
    originatingEngine,
    timestamp: new Date().toISOString(),
  };
}

export function makeResponsiveAdjustment(
  targetNode: string,
  currentValue: unknown,
  suggestedValue: unknown,
  reason: string,
  confidence: number,
  originatingEngine: string,
): RuleAdjustment {
  return {
    id: randomUUID(),
    targetNode,
    adjustmentType: "responsive",
    currentValue,
    suggestedValue,
    confidence,
    reason,
    originatingEngine,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Adjustment set — groups adjustments for a single generation pass
// ---------------------------------------------------------------------------

export interface AdjustmentSet {
  /** Unique ID for this set (tied to a generation job). */
  id: string;
  /** The scrape/generation job these adjustments apply to. */
  jobId: string;
  /** Which VR iteration produced this set (1-based). */
  iterationNumber: number;
  /** Fidelity score before applying adjustments. */
  scoreBefore: number;
  /** Adjustments to apply in the next generation pass. */
  adjustments: RuleAdjustment[];
  /** When this set was created. */
  createdAt: string;
}

export function makeAdjustmentSet(
  jobId: string,
  iterationNumber: number,
  scoreBefore: number,
  adjustments: RuleAdjustment[],
): AdjustmentSet {
  return {
    id: randomUUID(),
    jobId,
    iterationNumber,
    scoreBefore,
    adjustments,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Contract manifest (written to rule-adjustment-contract.json)
// ---------------------------------------------------------------------------

export interface RuleAdjustmentContractManifest {
  version: string;
  generatedAt: string;
  description: string;
  adjustmentTypes: AdjustmentType[];
  requiredFields: string[];
  consumers: string[];
  producers: string[];
}

export function buildContractManifest(): RuleAdjustmentContractManifest {
  return {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    description:
      "Canonical RuleAdjustment contract shared across Visual Reconstruction, Website Prime Generator, and Stencil Generator.",
    adjustmentTypes: [
      "layout",
      "typography",
      "spacing",
      "colors",
      "component_placement",
      "navigation",
      "images",
      "responsive",
    ],
    requiredFields: [
      "id",
      "targetNode",
      "adjustmentType",
      "currentValue",
      "suggestedValue",
      "confidence",
      "reason",
      "originatingEngine",
      "timestamp",
    ],
    consumers: [
      "generation-runner (Website Prime Generator)",
      "stencil-assembly-runner (Stencil Generator)",
      "visual-pipeline-orchestrator (VR-1…VR-8)",
    ],
    producers: [
      "reconstruction-loop-engine-vr8 (VR-8)",
      "visual-fidelity-scoring-engine-vr7 (VR-7)",
      "consistency-engine-vr6 (VR-6)",
    ],
  };
}

// ---------------------------------------------------------------------------
// Translator — convert legacy VR-8 adjustments to contract shape
// ---------------------------------------------------------------------------

import type {
  RuleAdjustment as LegacyRuleAdjustment,
} from "./reconstruction-loop-engine-vr8.js";

export function translateLegacyAdjustments(
  legacy: LegacyRuleAdjustment[],
  originatingEngine = "VR-8",
): RuleAdjustment[] {
  return legacy.map((adj) => {
    const base = {
      id: randomUUID(),
      originatingEngine,
      timestamp: new Date().toISOString(),
      confidence: adj.confidence,
    };

    switch (adj.kind) {
      case "color":
        return {
          ...base,
          targetNode: `design-token:${adj.field}`,
          adjustmentType: "colors" as const,
          currentValue: null,
          suggestedValue: adj.sourceColors,
          reason: `Override ${adj.field} palette with source site colors (action: ${adj.action})`,
        };
      case "layout":
        return {
          ...base,
          targetNode: "page:section-order",
          adjustmentType: "layout" as const,
          currentValue: null,
          suggestedValue: adj.canonicalOrder,
          reason: `Reorder sections to match source canonical layout (action: ${adj.action})`,
        };
      case "component":
        return {
          ...base,
          targetNode: `component:${adj.component}`,
          adjustmentType: "component_placement" as const,
          currentValue: null,
          suggestedValue: { component: adj.component, pages: adj.pageIds, action: adj.action },
          reason: `Component placement fix: ${adj.action} for ${adj.component}`,
        };
      case "spacing":
        return {
          ...base,
          targetNode: "design-token:spacing",
          adjustmentType: "spacing" as const,
          currentValue: null,
          suggestedValue: { scale: adj.scale, sectionGap: adj.sectionGap, density: adj.density },
          reason: `Spacing adjustment (action: ${adj.action})`,
        };
      case "typography":
        return {
          ...base,
          targetNode: "design-token:typography",
          adjustmentType: "typography" as const,
          currentValue: null,
          suggestedValue: { families: adj.families, sizeScale: adj.sizeScale, weights: adj.weights },
          reason: `Typography adjustment (action: ${adj.action})`,
        };
    }
  });
}
