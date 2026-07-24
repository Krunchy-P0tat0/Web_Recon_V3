import type {
  DiscoveredApiEndpoint,
  DiscoveredComponent,
  DiscoveredDataSource,
  DiscoveredLayout,
  DiscoveredRelationship,
  DiscoveredRoute,
  NodeKind,
  RelationshipKind,
  VirtualFileSystem,
} from "./types.js";

let relSeq = 0;
function nextId(): string {
  return `rel-${(++relSeq).toString().padStart(4, "0")}`;
}

function rel(
  kind: RelationshipKind,
  fromId: string,
  fromType: NodeKind,
  toId: string,
  toType: NodeKind,
  confidence: number,
  filePath: string
): DiscoveredRelationship {
  return { id: nextId(), kind, fromId, fromType, toId, toType, confidence, filePath };
}

// ─── Import-based resolution ──────────────────────────────────────────────────

function getImportedPaths(content: string): string[] {
  const paths: string[] = [];
  const matches = content.matchAll(/import\s+.*?from\s+['"]([^'"]+)['"]/g);
  for (const m of matches) paths.push(m[1]!);
  return paths;
}

function fuzzyMatchPath(importPath: string, filePath: string): boolean {
  const normalized = importPath
    .replace(/^@\//, "src/")
    .replace(/^~\//, "src/")
    .replace(/\\/g, "/");
  const fp = filePath.replace(/\\/g, "/").replace(/\.[tj]sx?$/, "");
  return (
    fp.endsWith(normalized) ||
    fp.endsWith(normalized + "/index") ||
    fp.includes("/" + normalized.split("/").pop()!)
  );
}

// ─── Route ↔ Layout ──────────────────────────────────────────────────────────

function routeLayoutRelationships(
  routes: DiscoveredRoute[],
  layouts: DiscoveredLayout[]
): DiscoveredRelationship[] {
  const rels: DiscoveredRelationship[] = [];

  for (const layout of layouts) {
    for (const routeId of layout.wrapsRouteIds) {
      const route = routes.find((r) => r.id === routeId);
      if (!route) continue;
      rels.push(rel("layout-wraps-route", layout.id, "layout", routeId, "route", 0.95, layout.filePath));
      rels.push(rel("route-uses-layout", routeId, "route", layout.id, "layout", 0.95, route.filePath));
    }
  }

  return rels;
}

// ─── Route ↔ Component ────────────────────────────────────────────────────────

function routeComponentRelationships(
  vfs: VirtualFileSystem,
  routes: DiscoveredRoute[],
  components: DiscoveredComponent[]
): DiscoveredRelationship[] {
  const rels: DiscoveredRelationship[] = [];

  for (const route of routes) {
    const content = vfs[route.filePath] ?? "";
    const importedPaths = getImportedPaths(content);

    for (const comp of components) {
      const isImported = importedPaths.some((p) => fuzzyMatchPath(p, comp.filePath));
      if (!isImported) continue;

      rels.push(rel("route-uses-component", route.id, "route", comp.id, "component", 0.9, route.filePath));
      if (!comp.usedInRouteIds.includes(route.id)) {
        comp.usedInRouteIds.push(route.id);
      }
    }
  }

  return rels;
}

// ─── Component ↔ Component ────────────────────────────────────────────────────

function componentComponentRelationships(
  vfs: VirtualFileSystem,
  components: DiscoveredComponent[]
): DiscoveredRelationship[] {
  const rels: DiscoveredRelationship[] = [];

  for (const comp of components) {
    const content = vfs[comp.filePath] ?? "";
    const importedPaths = getImportedPaths(content);

    for (const other of components) {
      if (other.id === comp.id) continue;
      const isImported = importedPaths.some((p) => fuzzyMatchPath(p, other.filePath));
      if (!isImported) continue;
      rels.push(rel("component-imports-component", comp.id, "component", other.id, "component", 0.85, comp.filePath));
    }
  }

  return rels;
}

// ─── Route ↔ DataSource ───────────────────────────────────────────────────────

function routeDataSourceRelationships(
  vfs: VirtualFileSystem,
  routes: DiscoveredRoute[],
  dataSources: DiscoveredDataSource[]
): DiscoveredRelationship[] {
  const rels: DiscoveredRelationship[] = [];

  for (const route of routes) {
    const content = vfs[route.filePath] ?? "";
    for (const ds of dataSources) {
      const usedHere = ds.usedInFiles.includes(route.filePath) ||
        ds.envVarsReferenced.some((v) => content.includes(v));
      if (!usedHere) continue;
      rels.push(rel("route-uses-datasource", route.id, "route", ds.id, "datasource", ds.confidence * 0.8, route.filePath));
      if (!ds.usedInRouteIds.includes(route.id)) {
        ds.usedInRouteIds.push(route.id);
      }
    }
  }

  return rels;
}

// ─── API ↔ DataSource ─────────────────────────────────────────────────────────

function apiDataSourceRelationships(
  vfs: VirtualFileSystem,
  apis: DiscoveredApiEndpoint[],
  dataSources: DiscoveredDataSource[]
): DiscoveredRelationship[] {
  const rels: DiscoveredRelationship[] = [];

  for (const api of apis) {
    const content = vfs[api.filePath] ?? "";
    for (const ds of dataSources) {
      const usedHere = ds.usedInFiles.includes(api.filePath) ||
        ds.envVarsReferenced.some((v) => content.includes(v));
      if (!usedHere) continue;
      rels.push(rel("api-uses-datasource", api.id, "api", ds.id, "datasource", ds.confidence * 0.85, api.filePath));
    }
  }

  return rels;
}

// ─── Route ↔ Route (links) ────────────────────────────────────────────────────

function routeLinkRelationships(
  vfs: VirtualFileSystem,
  routes: DiscoveredRoute[]
): DiscoveredRelationship[] {
  const rels: DiscoveredRelationship[] = [];
  const routePaths = new Map(routes.map((r) => [r.path, r]));

  for (const route of routes) {
    const content = vfs[route.filePath] ?? "";
    const hrefMatches = content.matchAll(/href=['"`](\/[^'"`?#]+)/g);
    for (const m of hrefMatches) {
      const target = m[1]!;
      const targetRoute = routePaths.get(target);
      if (targetRoute && targetRoute.id !== route.id) {
        rels.push(rel("route-links-route", route.id, "route", targetRoute.id, "route", 0.7, route.filePath));
      }
    }
    const redirectMatches = content.matchAll(/(?:redirect|useRouter|router\.push)\s*\(\s*['"`](\/[^'"`?#]+)/g);
    for (const m of redirectMatches) {
      const target = m[1]!;
      const targetRoute = routePaths.get(target);
      if (targetRoute && targetRoute.id !== route.id) {
        rels.push(rel("route-redirects-route", route.id, "route", targetRoute.id, "route", 0.75, route.filePath));
      }
    }
  }

  return rels;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function buildRelationships(
  vfs: VirtualFileSystem,
  routes: DiscoveredRoute[],
  layouts: DiscoveredLayout[],
  components: DiscoveredComponent[],
  apis: DiscoveredApiEndpoint[],
  dataSources: DiscoveredDataSource[]
): DiscoveredRelationship[] {
  relSeq = 0;

  return [
    ...routeLayoutRelationships(routes, layouts),
    ...routeComponentRelationships(vfs, routes, components),
    ...componentComponentRelationships(vfs, components),
    ...routeDataSourceRelationships(vfs, routes, dataSources),
    ...apiDataSourceRelationships(vfs, apis, dataSources),
    ...routeLinkRelationships(vfs, routes),
  ];
}
