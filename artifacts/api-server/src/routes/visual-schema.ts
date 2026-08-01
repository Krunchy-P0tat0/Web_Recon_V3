/**
 * visual-schema.ts — CP-2 routes
 *
 *   GET  /api/visual-schema/v1               — full canonical schema document
 *   GET  /api/visual-schema/v1/types         — list of canonical type names
 *   GET  /api/visual-schema/v1/type/:name    — single type definition
 *   GET  /api/visual-schema/compatibility    — compatibility report across lineages
 */

import { Router, type IRouter } from "express";
import { VISUAL_SCHEMA_V1_REGISTRY } from "../lib/visual-schema-v1.js";

const router: IRouter = Router();

const SCHEMA_DEFINITIONS: Record<string, object> = {
  CanonicalLayoutDNA: {
    description: "Unified layout token set — canonical replacement for Phase 2.5B LayoutDNA and Phase 6.x layout fragments.",
    fields: {
      schemaVersion:   "v1",
      containerWidths: "string[]  — e.g. ['1280px','1440px']",
      gridColumns:     "number[]  — e.g. [12,6,4,2]",
      breakpoints:     "string[]  — e.g. ['640px','768px','1024px']",
      maxWidth:        "string | null",
      sectionSpacing:  "string[]  — vertical rhythm values",
      confidence:      "number    — 0–1",
    },
    legacyAliases:   ["LayoutDNA (Phase 2.5B)"],
  },
  CanonicalColorPalette: {
    description: "Unified color palette — canonical home for color data previously duplicated across 5 engines.",
    fields: {
      schemaVersion: "v1",
      primary:       "string[]  — top brand hex colors",
      secondary:     "string[]",
      background:    "string[]",
      text:          "string[]",
      accent:        "string[]",
      confidence:    "number    — 0–1",
    },
    legacyAliases:   ["ColorSystem (visual-dna-engine)", "ColorPalette (screenshot-visual-dna-engine)"],
  },
  CanonicalVisualDNA: {
    description: "Unified Visual DNA — canonical replacement for Phase 2.5B VisualDNA and VR-2 VisualDNAReport.",
    fields: {
      schemaVersion:     "v1",
      jobId:             "string",
      pageCount:         "number",
      generatedAt:       "string (ISO-8601)",
      colors:            "CanonicalColorPalette",
      typography:        "CanonicalTypographyDNA",
      spacing:           "CanonicalSpacingDNA",
      layout:            "CanonicalLayoutDNA",
      hierarchy:         "CanonicalHierarchyDNA",
      borders:           "CanonicalBordersDNA",
      viewports:         "{ desktop, tablet, mobile }",
      overallConfidence: "number — 0–1",
    },
    legacyAliases: ["VisualDNA (visual-dna-engine)", "VisualDNAReport (screenshot-visual-dna-engine)"],
  },
  CanonicalBrandDNA: {
    description: "Brand DNA — new in v1, previously absent from the platform entirely.",
    fields: {
      schemaVersion:     "v1",
      jobId:             "string",
      seedUrl:           "string",
      generatedAt:       "string (ISO-8601)",
      identity:          "{ brandName, logoPresent, logoShape, faviconColor }",
      voice:             "{ tone, ctaLanguage, headlineStyle }",
      palette:           "CanonicalColorPalette",
      typography:        "CanonicalTypographyDNA",
      motion:            "{ hasAnimations, transitionStyle }",
      overallConfidence: "number — 0–1",
    },
    legacyAliases: [],
    status: "NEW — not yet produced by any engine. Requires CP-1 CAPTURE + DNA stages.",
  },
  CanonicalRuleAdjustment: {
    description: "Unified RuleAdjustment — canonical form from rule-adjustment-contract.ts, with priority + autoApplicable fields added.",
    fields: {
      schemaVersion:     "v1",
      id:                "string (UUID)",
      targetNode:        "string — CSS selector or logical name",
      adjustmentType:    "layout | typography | spacing | colors | component_placement | navigation | images | responsive",
      currentValue:      "unknown",
      suggestedValue:    "unknown",
      confidence:        "number — 0–1",
      reason:            "string",
      originatingEngine: "string — e.g. 'VR-7'",
      timestamp:         "string (ISO-8601)",
      priority:          "number — 1=highest",
      autoApplicable:    "boolean — true if confidence ≥ 0.75",
    },
    legacyAliases: [
      "RuleAdjustment (rule-adjustment-contract.ts) — compatible, missing priority+autoApplicable",
      "RuleAdjustment union (reconstruction-loop-engine-vr8.ts) — incompatible shape, use adaptVR8AdjustmentToCanonical()",
    ],
  },
  CanonicalFidelityReport: {
    description: "Unified FidelityReport — canonical replacement for Phase 6.5 VisualFidelityReport and VR-7 FidelityReport.",
    fields: {
      schemaVersion:   "v1",
      sourceJobId:     "string",
      generatedJobId:  "string",
      seedUrl:         "string",
      generatedAt:     "string (ISO-8601)",
      durationMs:      "number",
      pipelineStage:   "string — e.g. 'VR-7'",
      dimensions:      "CanonicalFidelityDimension[]",
      totalScore:      "number — 0–100",
      grade:           "A+ | A | B | C | D | F",
      issues:          "CanonicalFidelityIssue[]",
      pagesCompared:   "number",
      summary:         "{ topDimension, weakDimension, issueBySeverity, pagesAbove75, pagesBelowPass }",
    },
    legacyAliases: [
      "VisualFidelityReport (visual-fidelity-engine.ts) — use adaptPhase65ToCanonicalFidelityReport()",
      "FidelityReport (visual-fidelity-scoring-engine-vr7.ts) — schemaVersion 'VR-7', use adaptVR7ToCanonical()",
    ],
  },
};

const COMPATIBILITY_REPORT = {
  version:      "CP-2",
  generatedAt:  new Date().toISOString(),
  schemaVersion: "v1",
  summary: {
    totalTypes:        12,
    newTypes:          1,    // BrandDNA
    unifiedTypes:      5,    // Layout, ColorPalette, VisualDNA, RuleAdjustment, FidelityReport
    fullyCompatible:   2,    // LayoutDNA, VisualDNA (shape-compatible with adapters)
    adapterRequired:   2,    // Phase 6.5 FidelityReport, VR-8 RuleAdjustment union
    breakingChanges:   0,
  },
  types: [
    {
      canonicalType:  "CanonicalLayoutDNA",
      compatibility:  "COMPATIBLE",
      lineages: [
        { source: "Phase 2.5B / visual-dna-engine.ts", status: "ADAPTER", note: "adaptPhase25BToCanonicalVisualDNA() wraps the whole DNA including layout" },
        { source: "VR-2 / screenshot-visual-dna-engine.ts", status: "COMPATIBLE", note: "Field names match; add schemaVersion field" },
      ],
    },
    {
      canonicalType:  "CanonicalVisualDNA",
      compatibility:  "ADAPTER_REQUIRED for Phase 2.5B",
      lineages: [
        { source: "Phase 2.5B / visual-dna-engine.ts", status: "ADAPTER", note: "Different field names (colorSystem vs colors). Use adaptPhase25BToCanonicalVisualDNA()" },
        { source: "VR-2 / screenshot-visual-dna-engine.ts", status: "COMPATIBLE", note: "Shape matches canonical; add schemaVersion field" },
      ],
    },
    {
      canonicalType:  "CanonicalBrandDNA",
      compatibility:  "NEW — no existing consumers or producers",
      lineages:       [],
    },
    {
      canonicalType:  "CanonicalRuleAdjustment",
      compatibility:  "MIXED",
      lineages: [
        { source: "rule-adjustment-contract.ts", status: "COMPATIBLE", note: "Add priority + autoApplicable fields" },
        { source: "VR-8 internal union", status: "BREAKING", note: "Discriminated union shape. Use adaptVR8AdjustmentToCanonical()" },
      ],
    },
    {
      canonicalType:  "CanonicalFidelityReport",
      compatibility:  "ADAPTER_REQUIRED",
      lineages: [
        { source: "Phase 6.5 / visual-fidelity-engine.ts", status: "ADAPTER", note: "Scores in 0–1 range vs canonical 0–100. Use adaptPhase65ToCanonicalFidelityReport()" },
        { source: "VR-7 / visual-fidelity-scoring-engine-vr7.ts", status: "NEAR_COMPATIBLE", note: "schemaVersion 'VR-7'. Rename fields + add pipelineStage field" },
        { source: "api-zod generated FidelityReport", status: "PARTIAL", note: "Sparse shape from OpenAPI spec; does not include dimensions array" },
      ],
    },
  ],
};

// GET /visual-schema/v1
router.get("/visual-schema/v1", (_req, res): void => {
  res.json({
    version:       "CP-2",
    schemaVersion: "v1",
    generatedAt:   new Date().toISOString(),
    registry:      VISUAL_SCHEMA_V1_REGISTRY,
    definitions:   SCHEMA_DEFINITIONS,
  });
});

// GET /visual-schema/v1/types
router.get("/visual-schema/v1/types", (_req, res): void => {
  res.json({
    schemaVersion: "v1",
    types:         VISUAL_SCHEMA_V1_REGISTRY.types,
    legacyAliases: VISUAL_SCHEMA_V1_REGISTRY.legacyAliases,
  });
});

// GET /visual-schema/v1/type/:name
router.get("/visual-schema/v1/type/:name", (req, res): void => {
  const { name } = req.params;
  const def = SCHEMA_DEFINITIONS[name];
  if (!def) {
    res.status(404).json({ error: `Unknown type: ${name}`, available: Object.keys(SCHEMA_DEFINITIONS) });
    return;
  }
  res.json({ schemaVersion: "v1", name, ...def });
});

// GET /visual-schema/compatibility
router.get("/visual-schema/compatibility", (_req, res): void => {
  res.json(COMPATIBILITY_REPORT);
});

export default router;
