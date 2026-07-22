export { compileDiscoverySiteGraph } from "./compiler.js";

export type {
  ComponentProp,
  ComponentType,
  DataSourceKind,
  DataSourceProvider,
  DiscoveredApiEndpoint,
  DiscoveredComponent,
  DiscoveredDataSource,
  DiscoveredLayout,
  DiscoveredRelationship,
  DiscoveredRoute,
  DiscoverySiteGraph,
  DiscoveryStats,
  DuplicateRoute,
  DuplicateReason,
  Framework,
  FrameworkDetectionResult,
  FrameworkFeature,
  NodeKind,
  PackageManager,
  PageType,
  RelationshipKind,
  RouteMethod,
  RouteType,
  SiteDiscoveryOptions,
  VirtualFileSystem,
} from "./types.js";

export { detectFramework } from "./framework-detector.js";
export { analyzeRoutes } from "./route-analyzer.js";
export { scanComponents } from "./component-scanner.js";
export { detectLayouts } from "./layout-detector.js";
export { detectApiEndpoints } from "./api-detector.js";
export { analyzeDataSources } from "./datasource-analyzer.js";
export { buildRelationships } from "./relationship-builder.js";
export { detectOrphans, detectDuplicates } from "./orphan-detector.js";
