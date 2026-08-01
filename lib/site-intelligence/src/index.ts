/**
 * @workspace/site-intelligence
 *
 * Site Intelligence Layer — converts a PortableManifest into a SiteGraph.
 *
 * Main entry point:
 *   compileSiteGraph(manifest)  → SiteGraph
 *   validateSiteGraph(graph)    → SiteValidationReport
 *   STENCIL_CONTRACT            → StencilContract
 *
 * Individual engines (for testing or partial use):
 *   classifyAllNodes            → ClassificationResult[]
 *   buildNavigationTree         → NavigationTree
 *   buildRouteMap               → RouteMap
 *   assignAllLayouts            → LayoutAssignment[]
 *   buildCategoryGraph          → CategoryGraph
 *   buildAssetGraph             → AssetGraph
 *
 * All operations are:
 *   - Deterministic (same input → same output)
 *   - Pure (no I/O, no external services)
 *   - Synchronous (no async)
 */

export { compileSiteGraph } from "./compiler";
export { validateSiteGraph } from "./validator";
export {
  STENCIL_CONTRACT,
  validateSiteGraphForRendering,
  evaluateRendererCapabilities,
} from "./stencil-contract";

export { classifyAllNodes, classifyNode } from "./classification";
export { buildNavigationTree } from "./navigation";
export { buildRouteMap } from "./routing";
export { assignAllLayouts, assignLayout } from "./layout";
export { buildCategoryGraph } from "./categories";
export { buildAssetGraph } from "./assets";

export type {
  // Manifest input types
  PortableManifest,
  PortablePageNode,
  PortablePageMetadata,
  PortablePageContent,
  PortablePageMedia,
  PortablePageRelationships,
  PortableMediaItem,
  PortableStorageMap,
  ManifestConfig,
  ManifestStats,
  NodeType,
  NodeStatus,
  MediaStatus,
  ManifestStatus,

  // SiteGraph output
  SiteGraph,
  SiteGraphStats,

  // Classification
  ContentType,
  ClassificationResult,
  ClassificationSignal,

  // Navigation
  NavigationTree,
  NavItem,
  BreadcrumbEntry,
  OrphanPage,
  DuplicatePath,

  // Routing
  RouteMap,
  RouteEntry,

  // Layout
  LayoutType,
  LayoutAssignment,

  // Categories
  CategoryGraph,
  CategoryNode,
  TagRelationship,

  // Assets
  AssetGraph,
  AssetEntry,
  AssetType,

  // Stencil
  StencilContract,
  StencilCapability,
  StencilRendererRequirement,
  StencilOutputSpec,

  // Validation
  SiteValidationReport,
  ValidationSection,
  ValidationIssue,
  ValidationGrade,
} from "./types";

export type { RendererCapabilityReport } from "./stencil-contract";
