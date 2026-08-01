import type { SiteGraph, PortableManifest } from "@workspace/site-intelligence";
import type { SiteAssembly } from "@workspace/stencil-assembly-engine";
import type { WebsiteBlueprint } from "@workspace/stencil-generator";
import type { DesignSystem } from "@workspace/theme-intelligence";

// ---------------------------------------------------------------------------
// Stage names & results
// ---------------------------------------------------------------------------

export type GenerationStageName =
  | "classification"
  | "stencil_selection"
  | "site_assembly"
  | "blueprint"
  | "design_system";

export interface GenerationStageResult {
  name: GenerationStageName;
  status: "success" | "failed" | "skipped";
  durationMs: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Per-stage outputs (included in report)
// ---------------------------------------------------------------------------

export interface ClassificationSummary {
  nodeCount: number;
  contentTypeCounts: Record<string, number>;
  dominantContentType: string;
  stats: SiteGraph["stats"];
}

export interface StencilScore {
  stencilId: string;
  score: number;
  reason: string;
}

export interface StencilSelectionResult {
  selectedStencilId: string;
  selectedStencilName: string;
  candidateCount: number;
  selectionReason: string;
  scores: StencilScore[];
}

export interface GenerationOutputStats {
  pageCount: number;
  routeCount: number;
  componentCount: number;
  tokenCount: number;
}

export interface GenerationOutput {
  siteAssembly: SiteAssembly;
  blueprint: WebsiteBlueprint;
  designSystem: DesignSystem;
  stats: GenerationOutputStats;
}

// ---------------------------------------------------------------------------
// Top-level report
// ---------------------------------------------------------------------------

export interface GenerationReport {
  version: "1.0";
  jobId: string;
  seedUrl: string;
  generatedAt: string;
  durationMs: number;
  pipeline: {
    status: "success" | "failed";
    error?: string;
    stages: GenerationStageResult[];
  };
  classification: ClassificationSummary | null;
  stencilSelection: StencilSelectionResult | null;
  generation: GenerationOutput | null;
}

// ---------------------------------------------------------------------------
// Pipeline input
// ---------------------------------------------------------------------------

export interface GenerationPipelineInput {
  manifest: PortableManifest;
  jobId: string;
  seedUrl: string;
}
