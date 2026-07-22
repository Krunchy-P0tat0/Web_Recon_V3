import { compileSiteGraph } from "@workspace/site-intelligence";
import { assembleStencil } from "@workspace/stencil-assembly-engine";
import { compileBlueprint } from "@workspace/stencil-generator";
import { compileDesignSystem } from "@workspace/theme-intelligence";
import type { StencilId } from "@workspace/stencil-assembly-engine";
import { selectStencil } from "./stencil-selector.js";
import type {
  GenerationReport,
  GenerationPipelineInput,
  GenerationStageName,
  GenerationStageResult,
  ClassificationSummary,
  StencilSelectionResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// runGenerationPipeline
//
// Orchestrates the five-stage generation pipeline:
//   1. classification   — PortableManifest → SiteGraph
//   2. stencil_selection — SiteGraph → StencilId (scored selection)
//   3. site_assembly    — manifest + StencilId → SiteAssembly
//   4. blueprint        — SiteGraph → WebsiteBlueprint
//   5. design_system    — SiteGraph + Blueprint → DesignSystem
//
// Always returns a GenerationReport — pipeline.status indicates success/failure.
// ---------------------------------------------------------------------------

export function runGenerationPipeline(input: GenerationPipelineInput): GenerationReport {
  const { manifest, jobId, seedUrl } = input;
  const pipelineStart = Date.now();
  const stages: GenerationStageResult[] = [];

  let classificationSummary: ClassificationSummary | null = null;
  let stencilResult: StencilSelectionResult | null = null;

  function runStage<T>(name: GenerationStageName, fn: () => T): T {
    const start = Date.now();
    try {
      const result = fn();
      stages.push({ name, status: "success", durationMs: Date.now() - start });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      stages.push({ name, status: "failed", durationMs: Date.now() - start, error });
      throw err;
    }
  }

  try {
    // ── Stage 1: Classification ──────────────────────────────────────────────
    const siteGraph = runStage("classification", () => compileSiteGraph(manifest));

    const typeCounts: Record<string, number> = {};
    for (const cls of siteGraph.classifications) {
      const key = String(cls.contentType);
      typeCounts[key] = (typeCounts[key] ?? 0) + 1;
    }
    const dominantContentType =
      Object.entries(typeCounts).sort(([, a], [, b]) => b - a)[0]?.[0] ?? "unknown";

    classificationSummary = {
      nodeCount: siteGraph.classifications.length,
      contentTypeCounts: typeCounts,
      dominantContentType,
      stats: siteGraph.stats,
    };

    // ── Stage 2: Stencil Selection ───────────────────────────────────────────
    stencilResult = runStage("stencil_selection", () => selectStencil(siteGraph));

    // ── Stage 3: Site Assembly ───────────────────────────────────────────────
    const siteAssembly = runStage("site_assembly", () =>
      assembleStencil(manifest, stencilResult!.selectedStencilId as StencilId)
    );

    // ── Stage 4: Blueprint ───────────────────────────────────────────────────
    const blueprint = runStage("blueprint", () => compileBlueprint(siteGraph));

    // ── Stage 5: Design System ───────────────────────────────────────────────
    const designSystem = runStage("design_system", () =>
      compileDesignSystem(siteGraph, blueprint)
    );

    const tokenCount = designSystem.tokens
      ? Object.keys(designSystem.tokens as unknown as Record<string, unknown>).length
      : 0;

    const componentRegistry = blueprint.componentRegistry as unknown as Record<string, unknown>;

    return {
      version: "1.0",
      jobId,
      seedUrl,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - pipelineStart,
      pipeline: { status: "success", stages },
      classification: classificationSummary,
      stencilSelection: stencilResult,
      generation: {
        siteAssembly,
        blueprint,
        designSystem,
        stats: {
          pageCount: blueprint.pages.length,
          routeCount: blueprint.routePatterns.length,
          componentCount: Object.keys(componentRegistry).length,
          tokenCount,
        },
      },
    };
  } catch (err) {
    return {
      version: "1.0",
      jobId,
      seedUrl,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - pipelineStart,
      pipeline: {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        stages,
      },
      classification: classificationSummary,
      stencilSelection: stencilResult,
      generation: null,
    };
  }
}
