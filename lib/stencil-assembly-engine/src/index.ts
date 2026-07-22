/**
 * index.ts — Public API for @workspace/stencil-assembly-engine
 *
 * Phase B3: Stencil Assembly Engine
 *
 * Two-step pipeline:
 *
 *   1. assembleStencil(manifest, stencilId, options?)
 *      Takes a PortableManifest and a selected StencilId. Internally builds a
 *      SiteGraph via @workspace/site-intelligence, then runs five parallel
 *      builders to produce a complete SiteAssembly with:
 *        - Navigation    (primary, sidebar, mega-menu, footer, tag cloud, etc.)
 *        - Routes        (static + dynamic URL patterns)
 *        - Landing pages (homepage + LANDING_PAGE + GALLERY nodes)
 *        - Article pages (ARTICLE / BLOG / GUIDE / DOCS / PORTFOLIO nodes)
 *        - Category pages (one per category + one per qualifying tag)
 *        - Search structure (route, indexed types, total indexable pages)
 *      Pure and synchronous. Same inputs always produce the same output.
 *
 *   2. exportSiteAssembly(assembly, outputDir)
 *      Writes site-assembly.json to disk. Async (I/O only at this step).
 *
 * Supported stencils: agency | blog | magazine | portfolio |
 *                     documentation | marketplace | directory | wedding
 */

export { assembleStencil }    from "./assembler.js";
export { exportSiteAssembly } from "./exporter.js";

export type {
  // Primary I/O
  AssemblyOptions,
  SiteAssembly,

  // Navigation
  AssemblyNavigation,
  AssemblyNavItem,
  AssemblyMegaMenuSection,
  AssemblyFooterGroup,
  AssemblyBreadcrumbSchema,
  AssemblyTagCloudItem,
  AssemblyCategoryNode,
  AssemblyFilterConfig,
  AssemblyPaginationConfig,

  // Pages
  AssemblyPage,
  AssemblyPageMeta,

  // Routes
  AssemblyRouteMap,
  AssemblyRoute,
  AssemblyRouteParam,

  // Search
  AssemblySearchStructure,

  // Stats & diagnostics
  SiteAssemblyStats,
  AssemblyWarning,

  // Export
  ExportAssemblyResult,

  // Re-exported for convenience
  PortableManifest,
  StencilId,
  ContentType,
  LayoutType,
  PageType,
  ComponentType,
  NavigationStructure,
} from "./types.js";
