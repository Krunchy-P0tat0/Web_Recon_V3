import type { DiscoveredApiEndpoint } from "@workspace/site-discovery";
import type { RouteEntry } from "@workspace/site-intelligence";
import type { MergeConflict, MergeDecision } from "./types.js";

let seq = 0;
const nextDecId = () => `dec-api-${(++seq).toString().padStart(4, "0")}`;
const nextConId = () => `con-api-${seq.toString().padStart(4, "0")}-${Date.now()}`;

// ─── Path utilities ───────────────────────────────────────────────────────────

function normalizeApiPath(path: string): string {
  return path
    .replace(/:(\w+)/g, "[$1]")
    .replace(/\[\[?\.{0,3}(\w+)\]?\]/g, "[$1]")
    .replace(/\/+$/, "");
}

function extractPathFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.startsWith("/") ? url : `/${url}`;
  }
}

// ─── Infer APIs that scraped content depends on ───────────────────────────────
//
// SiteGraph doesn't have explicit API definitions — only scraped page URLs.
// However, we can infer needed API endpoints from the scraped routes:
// e.g. scraped /blog/[slug] → likely needs GET /api/posts/[slug]

function inferNeededApis(routeEntries: RouteEntry[]): Set<string> {
  const needed = new Set<string>();

  for (const entry of routeEntries) {
    const path = extractPathFromUrl(entry.url);
    // If it's a list page (no slug), infer a list endpoint
    if (!/\[/.test(path)) {
      const segments = path.split("/").filter(Boolean);
      if (segments.length >= 1) {
        needed.add(`/api/${segments.join("/")}`);
      }
    }
  }

  return needed;
}

function pathsStructurallyMatch(a: string, b: string): boolean {
  const aParts = normalizeApiPath(a).split("/").filter(Boolean);
  const bParts = normalizeApiPath(b).split("/").filter(Boolean);
  if (aParts.length !== bParts.length) return false;
  return aParts.every((seg, i) => {
    if (seg.startsWith("[")) return true;
    if (bParts[i]!.startsWith("[")) return true;
    return seg === bParts[i];
  });
}

// ─── Method collision detection ───────────────────────────────────────────────

function detectMethodCollisions(apis: DiscoveredApiEndpoint[]): MergeConflict[] {
  const conflicts: MergeConflict[] = [];
  const byPath = new Map<string, DiscoveredApiEndpoint[]>();

  for (const api of apis) {
    const key = normalizeApiPath(api.path);
    if (!byPath.has(key)) byPath.set(key, []);
    byPath.get(key)!.push(api);
  }

  for (const [path, group] of byPath) {
    if (group.length < 2) continue;

    // Find overlapping methods across distinct file sources
    const methodsByFile = new Map<string, string[]>();
    for (const api of group) {
      const key = api.filePath;
      if (!methodsByFile.has(key)) methodsByFile.set(key, []);
      methodsByFile.get(key)!.push(...api.methods);
    }

    const files = [...methodsByFile.keys()];
    if (files.length < 2) continue;

    const allMethods = [...methodsByFile.values()].flat();
    const overlapping = allMethods.filter((m, i) => allMethods.indexOf(m) !== i);

    if (overlapping.length > 0) {
      conflicts.push({
        id: nextConId(),
        kind: "method-collision",
        severity: "error",
        description: `API path '${path}' is defined in multiple files (${files.map((f) => f.split("/").pop()).join(", ")}) with overlapping HTTP methods: [${[...new Set(overlapping)].join(", ")}].`,
        sourceRef: null,
        targetRef: { id: group[0]!.id, path, graph: "discovery" },
        resolution: "Consolidate the API handlers into a single file, or remove the duplicate method definitions.",
        isBlocker: true,
      });
    }
  }

  return conflicts;
}

// ─── Main matcher ─────────────────────────────────────────────────────────────

export interface ApiMatchResult {
  decisions: MergeDecision[];
  conflicts: MergeConflict[];
}

export function matchApis(
  discoveredApis: DiscoveredApiEndpoint[],
  routeEntries: RouteEntry[]
): ApiMatchResult {
  seq = 0;
  const decisions: MergeDecision[] = [];

  // Method collision detection
  const conflicts = detectMethodCollisions(discoveredApis);

  const neededApiPaths = inferNeededApis(routeEntries);

  for (const api of discoveredApis) {
    const normalizedPath = normalizeApiPath(api.path);

    // Check if this API serves content that scraped routes would need
    const servedByScrapedRoute = routeEntries.some((entry) => {
      const scrapedPath = extractPathFromUrl(entry.url);
      // API path like /api/posts/[id] could serve scraped page /blog/[slug]
      // Heuristic: share a common non-api segment
      const scrapedSegments = scrapedPath.split("/").filter((s) => s && s !== "api");
      const apiSegments = normalizedPath.split("/").filter((s) => s && s !== "api");
      return scrapedSegments.some((ss) =>
        apiSegments.some((as) => !as.startsWith("[") && ss.includes(as) || as.includes(ss))
      );
    });

    const matchedNeeded = [...neededApiPaths].some((np) =>
      pathsStructurallyMatch(normalizedPath, np)
    );

    if (matchedNeeded || servedByScrapedRoute) {
      decisions.push({
        id: nextDecId(),
        action: "IGNORE",
        entityKind: "api",
        reason: `API endpoint [${api.methods.join(",")}] '${api.path}' already exists and likely serves the scraped content. No changes needed.`,
        confidence: 0.82,
        source: null,
        target: { id: api.id, path: api.path, graph: "discovery" },
        conflicts: [],
        metadata: {
          methods: api.methods,
          isAuth: api.isAuth,
          hasValidation: api.hasValidation,
          paramNames: api.paramNames,
        },
      });
    } else {
      // Existing API with no clear connection to scraped content — keep it
      decisions.push({
        id: nextDecId(),
        action: "IGNORE",
        entityKind: "api",
        reason: `API endpoint [${api.methods.join(",")}] '${api.path}' is part of the site's infrastructure and not directly related to the scraped content merge.`,
        confidence: 0.95,
        source: null,
        target: { id: api.id, path: api.path, graph: "discovery" },
        conflicts: [],
        metadata: {
          methods: api.methods,
          isAuth: api.isAuth,
          paramNames: api.paramNames,
        },
      });
    }
  }

  // Infer API endpoints that need to be created for new routes
  for (const neededPath of neededApiPaths) {
    const exists = discoveredApis.some((api) =>
      pathsStructurallyMatch(normalizeApiPath(api.path), neededPath)
    );
    if (!exists) {
      decisions.push({
        id: nextDecId(),
        action: "CREATE",
        entityKind: "api",
        reason: `Scraped content requires a data endpoint at '${neededPath}' to serve page content, but no matching API route exists in the codebase.`,
        confidence: 0.65,
        source: null,
        target: null,
        conflicts: [],
        metadata: { inferredPath: neededPath, methods: ["GET"] },
      });
    }
  }

  return { decisions, conflicts };
}
