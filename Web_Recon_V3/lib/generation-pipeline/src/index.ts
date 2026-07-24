/**
 * @workspace/generation-pipeline
 *
 * Phase C1: Generation Pipeline
 *
 * Orchestrates the five-stage site generation pipeline:
 *   manifest → classification → stencil selection → site generation
 *
 * Main entry point:
 *   runGenerationPipeline(input)  → GenerationReport
 *
 * Pipeline stages:
 *   1. classification   — PortableManifest → SiteGraph  (@workspace/site-intelligence)
 *   2. stencil_selection — SiteGraph → StencilId        (@workspace/stencil-registry)
 *   3. site_assembly    — manifest + StencilId → SiteAssembly (@workspace/stencil-assembly-engine)
 *   4. blueprint        — SiteGraph → WebsiteBlueprint  (@workspace/stencil-generator)
 *   5. design_system    — SiteGraph + Blueprint → DesignSystem (@workspace/theme-intelligence)
 *
 * Output:
 *   GenerationReport — full pipeline result including all stage outputs.
 *   Persisted to R2 at jobs/{jobId}/generation-report.json
 *
 * All operations are:
 *   - Deterministic (same input → same output)
 *   - Pure (no I/O, no external services)
 *   - Synchronous (no async)
 */

export { runGenerationPipeline } from "./pipeline.js";
export { selectStencil } from "./stencil-selector.js";

export type {
  GenerationReport,
  GenerationPipelineInput,
  GenerationStageResult,
  GenerationStageName,
  ClassificationSummary,
  StencilSelectionResult,
  StencilScore,
  GenerationOutput,
  GenerationOutputStats,
} from "./types.js";
