/**
 * index.ts — Public API for @workspace/manifest-binding
 *
 * Three-step pipeline:
 *
 *   1. buildBindingGraph(input)
 *      Reads manifest + R2 inventory → constructs the page-to-asset mapping.
 *      Pure and synchronous. Same inputs always produce the same output.
 *
 *   2. validateBindingGraph(buildResult)
 *      Runs coverage checks against the success criteria. Pure and synchronous.
 *
 *   3. exportBindingManifest(buildResult, validation, outputDir)
 *      Writes the 5 output files to disk. Async (I/O only at this step).
 *
 * All types needed to call these functions are re-exported from this barrel.
 */

export { buildBindingGraph }    from "./buildBindingGraph.js";
export { validateBindingGraph } from "./validateBindingGraph.js";
export { exportBindingManifest } from "./exportBindingManifest.js";

export type {
  // Input types
  BindingInput,
  R2ObjectRecord,
  ManifestInput,
  ManifestNodeInput,
  ManifestStorageInput,
  ManifestMediaItemInput,
  ManifestPageMediaInput,
  ManifestPageContentInput,
  ManifestPageMetadataInput,
  ManifestPageRelationshipsInput,

  // Binding record types
  AssetBinding,
  HtmlBinding,
  PageBinding,
  OrphanAsset,
  OrphanPage,

  // Core enums
  BindingSource,
  MediaClassification,

  // Graph output
  BindingGraph,
  BuildBindingGraphResult,

  // Audit log
  BindingEvent,

  // Validation
  ValidationResult,
  ValidationIssue,
  ValidationIssueKind,
  ValidationMetrics,

  // Export
  ExportResult,
  ExportPaths,
} from "./types.js";
