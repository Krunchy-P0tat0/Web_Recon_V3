/**
 * component-merge-engine-bm6.ts — Phase BM-6: Component Merge Engine
 *
 * Merges Website Prime UI with existing frontend systems by analyzing
 * components, layouts, design systems, and shared assets and classifying
 * each item for the merge pipeline.
 *
 * Classifications:
 *   REUSE   — existing component is identical or compatible; prime should import it directly
 *   WRAP    — existing component works but prime needs a thin wrapper (prop mapping, style override)
 *   REPLACE — prime's generated component supersedes the existing one
 *   SKIP    — component is not needed in the merged output (duplicate, deprecated, internal-only)
 *
 * Outputs (disk + R2):
 *   component-merge-report.json
 *
 * Success criteria:
 *   Existing frontend components are reused whenever possible.
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join }                        from "path";
import { logger }                      from "./logger.js";
import { getDefaultCloudProvider }     from "../cloud/index.js";

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type MergeClassification = "REUSE" | "WRAP" | "REPLACE" | "SKIP";
export type ComponentKind =
  | "ui-component"   // button, input, card, modal, …
  | "layout"         // header, footer, sidebar, grid, page-shell
  | "page"           // full page component (Home, About, Dashboard)
  | "design-token"   // color, spacing, typography token/variable
  | "icon"           // icon set or individual icon
  | "asset"          // image, font, SVG, media
  | "hook"           // React/Vue hook that produces UI state
  | "provider"       // context provider, theme provider
  | "utility"        // shared CSS class, utility function used by UI
  | "unknown";

export type DesignSystem =
  | "tailwind"
  | "mui"            // Material UI
  | "shadcn"         // shadcn/ui
  | "chakra"
  | "ant-design"
  | "mantine"
  | "bootstrap"
  | "custom-css"
  | "css-modules"
  | "styled-components"
  | "emotion"
  | "none"
  | "unknown";

// ---------------------------------------------------------------------------
// Input descriptor
// ---------------------------------------------------------------------------

export interface ComponentDescriptor {
  id?:            string;
  name:           string;                   // e.g. "Button", "NavBar", "colors.ts"
  kind:           ComponentKind;
  path?:          string;                   // file path in the existing codebase
  framework?:     string;                   // react, vue, svelte, angular, vanilla
  designSystem?:  DesignSystem;
  propsInterface?: Record<string, string>;  // prop name → type string
  cssClasses?:    string[];                 // notable CSS classes or design tokens used
  dependencies?:  string[];                 // npm packages or internal modules
  isExported?:    boolean;
  isDeprecated?:  boolean;
  usedInPages?:   string[];                 // page paths where this component is used
  primeEquivalent?: string;                 // name of the prime-generated equivalent
  hasPrimeMatch:  boolean;                  // true if a generated prime component covers the same concern
  similarity?:    number;                   // 0–1 structural/visual similarity to prime equivalent
}

export interface ComponentMergeInput {
  primeJobId:      string;
  backendJobId?:   string;
  force?:          boolean;
  components?:     ComponentDescriptor[];   // existing backend components
  primeComponents?: ComponentDescriptor[];  // prime-generated components
  designSystem?:   DesignSystem;           // overall design system of the existing frontend
  framework?:      string;
}

// ---------------------------------------------------------------------------
// Merge decision
// ---------------------------------------------------------------------------

export interface MergeDecision {
  id:              string;
  component:       ComponentDescriptor;
  classification:  MergeClassification;
  confidence:      number;       // 0–1
  reason:          string;
  mergeAction:     string;       // precise instruction for the merge pipeline
  wrapperSpec?:    WrapperSpec;  // present when classification === "WRAP"
  reuseImportPath?: string;      // present when classification === "REUSE"
  replacedBy?:     string;       // prime component name when classification === "REPLACE"
  skippedReason?:  string;       // present when classification === "SKIP"
  effort:          "none" | "trivial" | "low" | "medium" | "high";
  breakingChange:  boolean;
}

export interface WrapperSpec {
  wrapperName:     string;
  wraps:           string;       // existing component name
  propMappings:    Array<{ from: string; to: string; transform?: string }>;
  styleOverrides?: string[];
  notes:           string[];
}

// ---------------------------------------------------------------------------
// Design system analysis
// ---------------------------------------------------------------------------

export interface DesignSystemAnalysis {
  existingSystem:  DesignSystem;
  primeSystem:     DesignSystem;
  compatible:      boolean;
  tokenConflicts:  string[];
  migrationNotes:  string[];
  mergeStrategy:   "adopt-existing" | "adopt-prime" | "hybrid" | "parallel";
}

// ---------------------------------------------------------------------------
// Category summary
// ---------------------------------------------------------------------------

export interface CategorySummary {
  kind:         ComponentKind;
  total:        number;
  reuseCount:   number;
  wrapCount:    number;
  replaceCount: number;
  skipCount:    number;
  decisions:    MergeDecision[];
}

// ---------------------------------------------------------------------------
// Output — component-merge-report.json
// ---------------------------------------------------------------------------

export interface ComponentMergeReport {
  schemaVersion:      "BM-6";
  primeJobId:         string;
  backendJobId:       string;
  generatedAt:        string;
  durationMs:         number;
  framework:          string;
  designSystemAnalysis: DesignSystemAnalysis;
  totalComponents:    number;
  mergeScore:         number;          // 0–100; higher = more reuse
  grade:              "A" | "B" | "C" | "D" | "F";
  reuseRate:          number;          // fraction 0–1
  // Flattened classification views
  reuse:              MergeDecision[];
  wrap:               MergeDecision[];
  replace:            MergeDecision[];
  skip:               MergeDecision[];
  // Per-kind breakdown
  byKind:             Record<ComponentKind, CategorySummary>;
  // All decisions
  decisions:          MergeDecision[];
  summary: {
    reuseCount:       number;
    wrapCount:        number;
    replaceCount:     number;
    skipCount:        number;
    wrappersToCreate: number;
    breakingChanges:  number;
    highEffortItems:  string[];
    recommendation:   string;
  };
  r2Key?: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const _cache = new Map<string, ComponentMergeReport>();

export function getCachedComponentMergeReport(primeJobId: string): ComponentMergeReport | undefined {
  return _cache.get(primeJobId);
}

// ---------------------------------------------------------------------------
// ID generator
// ---------------------------------------------------------------------------

let _seq = 0;
function nextId(): string { return `CMP-${String(++_seq).padStart(4, "0")}`; }

// ---------------------------------------------------------------------------
// Design system compatibility
// ---------------------------------------------------------------------------

const DESIGN_SYSTEM_COMPAT: Partial<Record<DesignSystem, DesignSystem[]>> = {
  tailwind:          ["tailwind", "shadcn"],
  shadcn:            ["tailwind", "shadcn"],
  mui:               ["mui", "emotion"],
  emotion:           ["mui", "styled-components", "chakra", "emotion"],
  "styled-components":["emotion", "styled-components"],
  chakra:            ["emotion", "chakra"],
  bootstrap:         ["bootstrap"],
  "css-modules":     ["css-modules", "custom-css"],
  "custom-css":      ["css-modules", "custom-css"],
  none:              ["none", "unknown", "tailwind", "css-modules", "custom-css"],
};

function isDesignSystemCompatible(a: DesignSystem, b: DesignSystem): boolean {
  if (a === b) return true;
  return DESIGN_SYSTEM_COMPAT[a]?.includes(b) ?? false;
}

function inferMergeStrategy(
  existing: DesignSystem,
  prime: DesignSystem,
): DesignSystemAnalysis["mergeStrategy"] {
  if (existing === prime) return "adopt-existing";
  if (existing === "none" || existing === "unknown") return "adopt-prime";
  if (prime === "none" || prime === "unknown") return "adopt-existing";
  if (isDesignSystemCompatible(existing, prime)) return "hybrid";
  return "parallel";
}

function analyzeDesignSystems(
  existing: DesignSystem,
  prime: DesignSystem,
): DesignSystemAnalysis {
  const compatible    = isDesignSystemCompatible(existing, prime);
  const mergeStrategy = inferMergeStrategy(existing, prime);

  const tokenConflicts: string[] = [];
  const migrationNotes: string[] = [];

  if (!compatible) {
    tokenConflicts.push(`Color token naming: ${existing} vs ${prime} use different token conventions`);
    tokenConflicts.push(`Spacing scale: ${existing} and ${prime} may use different spacing units`);
    migrationNotes.push(`Consider extracting shared design tokens into a neutral token file`);
    migrationNotes.push(`Use CSS custom properties (--var) to bridge the two systems at the boundary`);
  }

  if (mergeStrategy === "hybrid") {
    migrationNotes.push(`Both ${existing} and ${prime} can coexist; apply the prime system to new prime components only`);
  }

  if (mergeStrategy === "parallel") {
    migrationNotes.push(`Run ${existing} and ${prime} in parallel namespaces; plan a phased migration`);
    migrationNotes.push(`Wrap existing components in an isolation layer to prevent style leakage`);
  }

  return { existingSystem: existing, primeSystem: prime, compatible, tokenConflicts, migrationNotes, mergeStrategy };
}

// ---------------------------------------------------------------------------
// Component classification logic
// ---------------------------------------------------------------------------

function classifyComponent(
  comp: ComponentDescriptor,
  designCompat: boolean,
): { classification: MergeClassification; reason: string; confidence: number } {
  // Deprecated → SKIP
  if (comp.isDeprecated) {
    return {
      classification: "SKIP",
      reason: `Component is deprecated — exclude from merged output`,
      confidence: 1.0,
    };
  }

  // No prime equivalent → REUSE (existing component has no counterpart in prime)
  if (!comp.hasPrimeMatch) {
    return {
      classification: "REUSE",
      reason: `No prime equivalent exists — import and reuse the existing component directly`,
      confidence: 0.95,
    };
  }

  const sim = comp.similarity ?? 0.5;

  // High similarity with compatible design system → REUSE
  if (sim >= 0.85 && designCompat) {
    return {
      classification: "REUSE",
      reason: `High structural similarity (${Math.round(sim * 100)}%) and compatible design system — reuse as-is`,
      confidence: 0.90,
    };
  }

  // Medium similarity or minor design system mismatch → WRAP
  if (sim >= 0.50) {
    return {
      classification: "WRAP",
      reason: `Moderate similarity (${Math.round(sim * 100)}%) — wrap the existing component to align props/styles with prime`,
      confidence: 0.80,
    };
  }

  // Low similarity and prime has a full equivalent → REPLACE
  if (sim < 0.50 && comp.hasPrimeMatch) {
    return {
      classification: "REPLACE",
      reason: `Low similarity (${Math.round(sim * 100)}%) — prime's generated component is a better fit`,
      confidence: 0.75,
    };
  }

  // Design tokens / assets without a prime match → REUSE
  if (comp.kind === "design-token" || comp.kind === "asset" || comp.kind === "icon") {
    return {
      classification: "REUSE",
      reason: `Design token/asset has no prime equivalent — carry it forward`,
      confidence: 0.90,
    };
  }

  // Default fallback
  return {
    classification: "WRAP",
    reason: `Insufficient similarity data — wrapping is the safe default`,
    confidence: 0.60,
  };
}

// ---------------------------------------------------------------------------
// Wrapper spec builder
// ---------------------------------------------------------------------------

function buildWrapperSpec(comp: ComponentDescriptor): WrapperSpec {
  const mappings: WrapperSpec["propMappings"] = [];
  for (const [prop, type] of Object.entries(comp.propsInterface ?? {})) {
    mappings.push({ from: prop, to: prop });
    if (type.includes("className") || prop === "className") {
      mappings.push({ from: "className", to: "class", transform: "passthrough" });
    }
  }

  return {
    wrapperName:   `${comp.name}Adapter`,
    wraps:         comp.name,
    propMappings:  mappings.length ? mappings : [{ from: "...rest", to: "...rest" }],
    styleOverrides: comp.cssClasses?.slice(0, 3),
    notes: [
      `Import ${comp.name} from "${comp.path ?? `@existing/${comp.name.toLowerCase()}`}"`,
      `Forward all unrecognized props with spread to ensure forward compatibility`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Effort estimator
// ---------------------------------------------------------------------------

function estimateEffort(cls: MergeClassification, comp: ComponentDescriptor): MergeDecision["effort"] {
  if (cls === "SKIP")    return "none";
  if (cls === "REUSE")   return "trivial";
  if (cls === "REPLACE") return comp.kind === "layout" ? "medium" : "low";
  // WRAP
  const propCount = Object.keys(comp.propsInterface ?? {}).length;
  if (propCount > 10) return "high";
  if (propCount > 4)  return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Build a single merge decision
// ---------------------------------------------------------------------------

function buildDecision(
  comp: ComponentDescriptor,
  designCompat: boolean,
): MergeDecision {
  const id = comp.id ?? nextId();
  const { classification, reason, confidence } = classifyComponent(comp, designCompat);

  let mergeAction = "";
  let wrapperSpec: WrapperSpec | undefined;
  let reuseImportPath: string | undefined;
  let replacedBy: string | undefined;
  let skippedReason: string | undefined;

  switch (classification) {
    case "REUSE":
      reuseImportPath = comp.path ?? `@existing/${comp.name.toLowerCase()}`;
      mergeAction = `Import ${comp.name} from "${reuseImportPath}" and use directly in prime pages`;
      break;
    case "WRAP":
      wrapperSpec = buildWrapperSpec(comp);
      mergeAction = `Create ${wrapperSpec.wrapperName} adapter component that wraps the existing ${comp.name}`;
      break;
    case "REPLACE":
      replacedBy  = comp.primeEquivalent ?? `Prime${comp.name}`;
      mergeAction = `Use ${replacedBy} from the prime bundle; retire ${comp.name} after migration`;
      break;
    case "SKIP":
      skippedReason = comp.isDeprecated ? "Deprecated" : "Covered by prime equivalent";
      mergeAction   = `Exclude ${comp.name} from merged output; update all import sites`;
      break;
  }

  const effort        = estimateEffort(classification, comp);
  const breakingChange = classification === "REPLACE" && (comp.usedInPages ?? []).length > 0;

  return {
    id,
    component:       comp,
    classification,
    confidence,
    reason,
    mergeAction,
    wrapperSpec,
    reuseImportPath,
    replacedBy,
    skippedReason,
    effort,
    breakingChange,
  };
}

// ---------------------------------------------------------------------------
// Default component list
// ---------------------------------------------------------------------------

function buildDefaultComponents(): ComponentDescriptor[] {
  return [];
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

function computeScore(decisions: MergeDecision[]): number {
  if (!decisions.length) return 100;
  const total = decisions.length;
  const pts   = decisions.reduce((sum, d) => {
    const p =
      d.classification === "REUSE"   ? 100 :
      d.classification === "WRAP"    ?  70 :
      d.classification === "REPLACE" ?  40 :
      /* SKIP */                         90;
    return sum + p;
  }, 0);
  return Math.round(pts / total);
}

function grade(score: number): ComponentMergeReport["grade"] {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

// ---------------------------------------------------------------------------
// Category summary
// ---------------------------------------------------------------------------

const ALL_KINDS: ComponentKind[] = [
  "ui-component", "layout", "page", "design-token", "icon",
  "asset", "hook", "provider", "utility", "unknown",
];

function buildCategorySummaries(
  decisions: MergeDecision[],
): Record<ComponentKind, CategorySummary> {
  return Object.fromEntries(ALL_KINDS.map(kind => {
    const items = decisions.filter(d => d.component.kind === kind);
    return [kind, {
      kind,
      total:        items.length,
      reuseCount:   items.filter(d => d.classification === "REUSE").length,
      wrapCount:    items.filter(d => d.classification === "WRAP").length,
      replaceCount: items.filter(d => d.classification === "REPLACE").length,
      skipCount:    items.filter(d => d.classification === "SKIP").length,
      decisions:    items,
    }];
  })) as Record<ComponentKind, CategorySummary>;
}

// ---------------------------------------------------------------------------
// Disk / R2 helpers
// ---------------------------------------------------------------------------

async function saveToDisk(jobId: string, report: ComponentMergeReport): Promise<void> {
  const dir = join("/tmp/bm6", jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "component-merge-report.json"), JSON.stringify(report, null, 2));
}

async function saveToR2(jobId: string, report: ComponentMergeReport): Promise<string | undefined> {
  try {
    const cloud = getDefaultCloudProvider();
    const key   = `bm6/${jobId}/component-merge-report.json`;
    await cloud.upload({ key, data: Buffer.from(JSON.stringify(report, null, 2)), contentType: "application/json" });
    return key;
  } catch (err) {
    logger.warn({ err, jobId }, "BM6: R2 upload failed (non-fatal)");
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

export async function runComponentMergeEngine(
  input: ComponentMergeInput,
): Promise<ComponentMergeReport> {
  const { primeJobId, backendJobId = "unknown", force = false } = input;
  const t0 = Date.now();

  if (!force) {
    const cached = _cache.get(primeJobId);
    if (cached) {
      logger.info({ primeJobId }, "BM6: returning cached report");
      return cached;
    }
  }

  logger.info({ primeJobId, backendJobId }, "BM6: component merge analysis started");

  // Resolve components
  let components: ComponentDescriptor[] = input.components ?? buildDefaultComponents();

  // Assign IDs
  components = components.map((c, i) => ({ ...c, id: c.id ?? `CMP-${String(i + 1).padStart(4, "0")}` }));

  // Infer design systems
  const existingDS: DesignSystem = input.designSystem ?? "unknown";
  const primeDS: DesignSystem    =
    input.primeComponents?.find(c => c.designSystem)?.designSystem ?? "tailwind";

  const dsAnalysis    = analyzeDesignSystems(existingDS, primeDS);
  const designCompat  = dsAnalysis.compatible;
  const framework     = input.framework ?? "react";

  // Build decisions
  const decisions = components.map(c => buildDecision(c, designCompat));

  // Flattened views
  const reuse   = decisions.filter(d => d.classification === "REUSE");
  const wrap    = decisions.filter(d => d.classification === "WRAP");
  const replace = decisions.filter(d => d.classification === "REPLACE");
  const skip    = decisions.filter(d => d.classification === "SKIP");

  const byKind      = buildCategorySummaries(decisions);
  const mergeScore  = computeScore(decisions);
  const reuseRate   = decisions.length ? reuse.length / decisions.length : 1;

  const highEffortItems = decisions
    .filter(d => d.effort === "high" || d.effort === "medium")
    .map(d => d.id);

  const recommendation =
    reuseRate >= 0.8 ? "Excellent reuse rate — minimal merge work required. Focus on creating a few adapters." :
    reuseRate >= 0.6 ? "Good reuse rate — create wrappers for the WRAP items and verify breaking changes." :
    reuseRate >= 0.4 ? "Moderate reuse — significant adapter work needed; consider running a design audit first." :
                       "Low reuse rate — most components will be replaced; plan a full UI migration alongside the merge.";

  const report: ComponentMergeReport = {
    schemaVersion:        "BM-6",
    primeJobId,
    backendJobId,
    generatedAt:          new Date().toISOString(),
    durationMs:           Date.now() - t0,
    framework,
    designSystemAnalysis: dsAnalysis,
    totalComponents:      decisions.length,
    mergeScore,
    grade:                grade(mergeScore),
    reuseRate,
    reuse,
    wrap,
    replace,
    skip,
    byKind,
    decisions,
    summary: {
      reuseCount:       reuse.length,
      wrapCount:        wrap.length,
      replaceCount:     replace.length,
      skipCount:        skip.length,
      wrappersToCreate: wrap.length,
      breakingChanges:  decisions.filter(d => d.breakingChange).length,
      highEffortItems,
      recommendation,
    },
  };

  try {
    await saveToDisk(primeJobId, report);
    const r2Key = await saveToR2(primeJobId, report);
    if (r2Key) report.r2Key = r2Key;
  } catch (err) {
    logger.warn({ err, primeJobId }, "BM6: persistence failed (non-fatal)");
  }

  _cache.set(primeJobId, report);
  logger.info(
    { primeJobId, mergeScore, reuseCount: reuse.length, wrapCount: wrap.length, replaceCount: replace.length },
    "BM6: component merge analysis complete",
  );

  return report;
}
