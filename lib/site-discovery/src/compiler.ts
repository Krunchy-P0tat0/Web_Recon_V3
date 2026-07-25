import { detectFramework } from "./framework-detector.js";
import { analyzeRoutes } from "./route-analyzer.js";
import { scanComponents } from "./component-scanner.js";
import { detectLayouts } from "./layout-detector.js";
import { detectApiEndpoints } from "./api-detector.js";
import { analyzeDataSources } from "./datasource-analyzer.js";
import { buildRelationships } from "./relationship-builder.js";
import { detectOrphans, detectDuplicates } from "./orphan-detector.js";
import type {
  DiscoverySiteGraph,
  SiteDiscoveryOptions,
  VirtualFileSystem,
} from "./types.js";

export function compileDiscoverySiteGraph(
  vfs: VirtualFileSystem,
  _options: SiteDiscoveryOptions = {}
): DiscoverySiteGraph {
  const startMs = Date.now();

  const filteredVfs: VirtualFileSystem = {};
  for (const [path, content] of Object.entries(vfs)) {
    if (path.includes("node_modules/")) continue;
    if (path.includes(".git/")) continue;
    if (path.includes("dist/") || path.includes(".next/") || path.includes(".astro/")) continue;
    filteredVfs[path] = content;
  }

  const framework = detectFramework(filteredVfs);
  const routes = analyzeRoutes(filteredVfs, framework);
  const components = scanComponents(filteredVfs);
  const layouts = detectLayouts(filteredVfs, routes, framework);
  const apis = detectApiEndpoints(filteredVfs, routes, framework);
  const dataSources = analyzeDataSources(filteredVfs);
  const relationships = buildRelationships(filteredVfs, routes, layouts, components, apis, dataSources);
  const orphanPages = detectOrphans(routes, relationships);
  const duplicateRoutes = detectDuplicates(routes);

  const analysisTimeMs = Date.now() - startMs;

  return {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    stats: {
      totalFiles: Object.keys(filteredVfs).length,
      routeCount: routes.length,
      layoutCount: layouts.length,
      componentCount: components.length,
      apiCount: apis.length,
      dataSourceCount: dataSources.length,
      relationshipCount: relationships.length,
      orphanCount: orphanPages.length,
      duplicateCount: duplicateRoutes.length,
      analysisTimeMs,
    },
    framework,
    routes,
    layouts,
    components,
    apis,
    dataSources,
    relationships,
    orphanPages,
    duplicateRoutes,
  };
}
