/**
 * visual-schema-v1.ts — CP-2: Canonical Visual Schema (v1)
 *
 * Single source of truth for all visual types across the pipeline.
 * Unifies Layout, Components, VisualDNA, BrandDNA, RuleAdjustment,
 * and FidelityReport shapes that were previously fragmented across
 * Phase 2.5x, Phase 6.x, and VR-N engines.
 *
 * All engines should import from this file. Legacy type aliases are
 * provided for backward compatibility.
 */

// ---------------------------------------------------------------------------
// Schema metadata
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = "v1" as const;
export const SCHEMA_DATE    = "2026-06-30" as const;

// ---------------------------------------------------------------------------
// 1. Layout Schema
// ---------------------------------------------------------------------------

export interface CanonicalLayoutDNA {
  schemaVersion:   typeof SCHEMA_VERSION;
  containerWidths: string[];          // e.g. ["1280px", "1440px"]
  gridColumns:     number[];          // e.g. [12, 6, 4, 2]
  breakpoints:     string[];          // e.g. ["640px", "768px", "1024px"]
  maxWidth:        string | null;
  sectionSpacing:  string[];          // vertical rhythm values
  confidence:      number;            // 0–1
}

/** Legacy alias — Phase 2.5B / VR-2 */
export type LayoutDNA = CanonicalLayoutDNA;

// ---------------------------------------------------------------------------
// 2. Component Schema
// ---------------------------------------------------------------------------

export type CanonicalComponentRole =
  | "navigation"
  | "hero"
  | "feature"
  | "article"
  | "grid"
  | "footer"
  | "sidebar"
  | "form"
  | "cta"
  | "media"
  | "testimonial"
  | "pricing"
  | "unknown";

export interface CanonicalComponent {
  schemaVersion: typeof SCHEMA_VERSION;
  role:          CanonicalComponentRole;
  selector:      string;              // CSS selector or logical name
  count:         number;              // occurrences on page
  confidence:    number;
  attributes:    Record<string, unknown>;
}

export interface CanonicalComponentMap {
  schemaVersion: typeof SCHEMA_VERSION;
  jobId:         string;
  generatedAt:   string;
  components:    CanonicalComponent[];
  pageCount:     number;
  confidence:    number;
}

// ---------------------------------------------------------------------------
// 3. Color Schema (shared across 5 engines — canonical home)
// ---------------------------------------------------------------------------

export interface CanonicalColorPalette {
  schemaVersion: typeof SCHEMA_VERSION;
  primary:       string[];            // top brand hex colors
  secondary:     string[];
  background:    string[];
  text:          string[];
  accent:        string[];
  confidence:    number;
}

export interface CanonicalTypographyDNA {
  schemaVersion:  typeof SCHEMA_VERSION;
  families:       string[];
  sizeScale:      string[];
  weightScale:    (string | number)[];
  lineHeights:    string[];
  letterSpacings: string[];
  confidence:     number;
}

export interface CanonicalSpacingDNA {
  schemaVersion:  typeof SCHEMA_VERSION;
  scale:          string[];
  sectionSpacing: string[];
  containerGaps:  string[];
  confidence:     number;
}

export interface CanonicalBordersDNA {
  schemaVersion: typeof SCHEMA_VERSION;
  radiusScale:   string[];
  widthScale:    string[];
  stylePatterns: string[];
  confidence:    number;
}

export interface CanonicalHierarchyDNA {
  schemaVersion:    typeof SCHEMA_VERSION;
  headingLevels:    Record<string, number>;
  shadowScale:      string[];
  zIndexLevels:     number[];
  overlayOpacities: number[];
  confidence:       number;
}

// ---------------------------------------------------------------------------
// 4. Visual DNA Schema (canonical — replaces Phase 2.5B & VR-2 variants)
// ---------------------------------------------------------------------------

export interface CanonicalVisualDNA {
  schemaVersion:     typeof SCHEMA_VERSION;
  jobId:             string;
  pageCount:         number;
  generatedAt:       string;
  colors:            CanonicalColorPalette;
  typography:        CanonicalTypographyDNA;
  spacing:           CanonicalSpacingDNA;
  layout:            CanonicalLayoutDNA;
  hierarchy:         CanonicalHierarchyDNA;
  borders:           CanonicalBordersDNA;
  viewports: {
    desktop: string;
    tablet:  string;
    mobile:  string;
  };
  overallConfidence: number;
}

/** Legacy alias for Phase 2.5B consumers */
export type VisualDNA = CanonicalVisualDNA;

// ---------------------------------------------------------------------------
// 5. Brand DNA Schema (new in v1 — previously absent)
// ---------------------------------------------------------------------------

export interface CanonicalBrandDNA {
  schemaVersion:   typeof SCHEMA_VERSION;
  jobId:           string;
  seedUrl:         string;
  generatedAt:     string;

  identity: {
    brandName:       string | null;
    logoPresent:     boolean;
    logoShape:       "wordmark" | "icon" | "combined" | "unknown";
    faviconColor:    string | null;
  };

  voice: {
    tone:            "formal" | "casual" | "technical" | "playful" | "unknown";
    ctaLanguage:     string[];         // detected CTA button text patterns
    headlineStyle:   "title_case" | "sentence_case" | "all_caps" | "mixed";
  };

  palette: CanonicalColorPalette;
  typography: CanonicalTypographyDNA;

  motion: {
    hasAnimations:   boolean;
    transitionStyle: "instant" | "subtle" | "expressive" | "unknown";
  };

  overallConfidence: number;
}

// ---------------------------------------------------------------------------
// 6. Rule Adjustment Schema (canonical — from rule-adjustment-contract.ts)
// ---------------------------------------------------------------------------

export type CanonicalAdjustmentType =
  | "layout"
  | "typography"
  | "spacing"
  | "colors"
  | "component_placement"
  | "navigation"
  | "images"
  | "responsive";

export interface CanonicalRuleAdjustment {
  schemaVersion:    typeof SCHEMA_VERSION;
  id:               string;
  targetNode:       string;
  adjustmentType:   CanonicalAdjustmentType;
  currentValue:     unknown;
  suggestedValue:   unknown;
  confidence:       number;            // 0–1
  reason:           string;
  originatingEngine: string;           // e.g. "VR-7"
  timestamp:        string;
  priority:         number;            // 1 = highest
  autoApplicable:   boolean;           // safe for VR-8 auto-apply
}

/** Legacy alias */
export type RuleAdjustment = CanonicalRuleAdjustment;

// ---------------------------------------------------------------------------
// 7. Fidelity Report Schema (canonical — replaces Phase 6.5 & VR-7 variants)
// ---------------------------------------------------------------------------

export type CanonicalFidelityGrade = "A+" | "A" | "B" | "C" | "D" | "F";

export interface CanonicalFidelityDimension {
  name:   string;
  score:  number;       // 0–100
  weight: number;       // relative weight in total
  issues: string[];
}

export interface CanonicalFidelityIssue {
  severity:  "high" | "medium" | "low";
  dimension: string;
  message:   string;
  targetNode?: string;
  adjustment?: CanonicalRuleAdjustment;
}

export interface CanonicalFidelityReport {
  schemaVersion:   typeof SCHEMA_VERSION;
  sourceJobId:     string;
  generatedJobId:  string;
  seedUrl:         string;
  generatedAt:     string;
  durationMs:      number;
  pipelineStage:   string;             // e.g. "VR-7"
  dimensions:      CanonicalFidelityDimension[];
  totalScore:      number;             // 0–100 weighted average
  grade:           CanonicalFidelityGrade;
  issues:          CanonicalFidelityIssue[];
  pagesCompared:   number;
  summary: {
    topDimension:    string;
    weakDimension:   string;
    issueBySeverity: Record<"high" | "medium" | "low", number>;
    pagesAbove75:    number;
    pagesBelowPass:  number;
  };
}

// ---------------------------------------------------------------------------
// Schema registry — machine-readable map for compatibility checks
// ---------------------------------------------------------------------------

export const VISUAL_SCHEMA_V1_REGISTRY = {
  version:     SCHEMA_VERSION,
  date:        SCHEMA_DATE,
  types: [
    "CanonicalLayoutDNA",
    "CanonicalComponent",
    "CanonicalComponentMap",
    "CanonicalColorPalette",
    "CanonicalTypographyDNA",
    "CanonicalSpacingDNA",
    "CanonicalBordersDNA",
    "CanonicalHierarchyDNA",
    "CanonicalVisualDNA",
    "CanonicalBrandDNA",
    "CanonicalRuleAdjustment",
    "CanonicalFidelityReport",
  ],
  legacyAliases: {
    LayoutDNA:       "CanonicalLayoutDNA",
    VisualDNA:       "CanonicalVisualDNA",
    RuleAdjustment:  "CanonicalRuleAdjustment",
  },
} as const;
