/**
 * index.ts — Public API for @workspace/stencil-registry
 *
 * Phase B1: Stencil Registry
 *
 * Two-step pipeline:
 *
 *   1. buildStencilRegistry()
 *      Assembles all 8 stencil definitions into a StencilRegistry with a
 *      pre-computed index and statistics. Pure and synchronous.
 *
 *   2. exportStencilRegistry(registry, outputDir)
 *      Writes stencil-registry.json to disk. Async (I/O only).
 *
 * Query helpers:
 *   enumerateStencilTypes()         → StencilId[]
 *   getStencil(id)                  → StencilDefinition | undefined
 *   findStencilsByContent(types)    → StencilDefinition[]
 *   findStencilsByNavigation(navs)  → StencilDefinition[]
 *
 * Registered stencils:
 *   agency | blog | magazine | portfolio | documentation |
 *   marketplace | directory | wedding
 */

export { buildStencilRegistry }        from "./registry.js";
export { enumerateStencilTypes }       from "./registry.js";
export { getStencil }                  from "./registry.js";
export { findStencilsByContent }       from "./registry.js";
export { findStencilsByNavigation }    from "./registry.js";

export { exportStencilRegistry }       from "./exporter.js";

// Individual stencil definitions (for direct import)
export { agencyStencil }        from "./stencils/agency.js";
export { blogStencil }          from "./stencils/blog.js";
export { magazineStencil }      from "./stencils/magazine.js";
export { portfolioStencil }     from "./stencils/portfolio.js";
export { documentationStencil } from "./stencils/documentation.js";
export { marketplaceStencil }   from "./stencils/marketplace.js";
export { directoryStencil }     from "./stencils/directory.js";
export { weddingStencil }       from "./stencils/wedding.js";

export type {
  // Stencil identity
  StencilId,

  // Core stencil definition
  StencilDefinition,
  ContentCapability,
  ContentSupport,
  LayoutCapability,
  PageTypeCapability,
  NavigationStructure,

  // Registry
  StencilRegistry,
  StencilRegistryStats,

  // Export
  ExportRegistryResult,

  // Pass-through from stencil-generator for convenience
  ContentType,
  LayoutType,
  PageType,
  ComponentType,
} from "./types.js";
