import type {
  DiscoveredRoute,
  Framework,
  FrameworkDetectionResult,
  PageType,
  RouteMethod,
  RouteType,
  VirtualFileSystem,
} from "./types.js";

let routeSeq = 0;
function nextId(): string {
  return `route-${(++routeSeq).toString().padStart(4, "0")}`;
}

// ─── Path normalizers ─────────────────────────────────────────────────────────

function normalizeNextAppPath(filePath: string): string | null {
  const pageMatch = filePath.match(/(?:^|\/)(app)\/(.*?)\/page\.[tj]sx?$/);
  if (!pageMatch) {
    const rootMatch = filePath.match(/(?:^|\/)(app)\/page\.[tj]sx?$/);
    if (rootMatch) return "/";
    return null;
  }
  const segments = pageMatch[2]!
    .split("/")
    .filter((s) => !/^\(.*\)$/.test(s)); // strip route groups like (marketing)
  const path = "/" + segments.join("/");
  return path || "/";
}

function normalizeNextPagesPath(filePath: string): string | null {
  const m = filePath.match(/(?:^|\/)pages\/(.+)\.[tj]sx?$/);
  if (!m) return null;
  const rel = m[1]!;
  const excluded = ["_app", "_document", "_error", "404", "500"];
  if (excluded.includes(rel)) return null;
  if (rel === "index") return "/";
  const path = "/" + rel.replace(/\/index$/, "").replace(/\\/g, "/");
  return path;
}

function normalizeAstroPath(filePath: string): string | null {
  const m = filePath.match(/(?:^|\/)(?:src\/)?pages\/(.+)\.(?:astro|mdx?|tsx?|jsx?)$/);
  if (!m) return null;
  const rel = m[1]!;
  if (rel === "index") return "/";
  const path = "/" + rel.replace(/\/index$/, "");
  return path;
}

function extractParams(path: string): string[] {
  const params: string[] = [];
  const matches = path.matchAll(/\[{1,2}\.{0,3}([^\]]+)\]{1,2}/g);
  for (const m of matches) {
    const name = m[1]!.replace(/^\.{3}/, "");
    if (name) params.push(name);
  }
  return params;
}

function classifyPageType(path: string): PageType {
  if (/\[\[\.{3}/.test(path)) return "optional-catch-all";
  if (/\[\.{3}/.test(path)) return "catch-all";
  if (/\[/.test(path)) return "dynamic";
  return "static";
}

function pathDepth(path: string): number {
  return path === "/" ? 0 : path.split("/").filter(Boolean).length;
}

// ─── Next.js App Router ───────────────────────────────────────────────────────

function analyzeNextAppRouter(
  vfs: VirtualFileSystem,
  framework: Framework
): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];

  for (const filePath of Object.keys(vfs)) {
    if (!/\/app\/.*page\.[tj]sx?$/.test(filePath) && !/^app\/.*page\.[tj]sx?$/.test(filePath)) continue;

    const path = normalizeNextAppPath(filePath);
    if (!path) continue;

    const pageType = classifyPageType(path);
    const params = extractParams(path);

    routes.push({
      id: nextId(),
      path,
      filePath,
      routeType: "page",
      pageType,
      methods: ["GET"],
      isDynamic: pageType !== "static",
      params,
      layoutId: null,
      parentRouteId: null,
      childRouteIds: [],
      isOrphan: false,
      duplicateOf: null,
      framework,
      depth: pathDepth(path),
    });
  }

  return routes;
}

// ─── Next.js API Routes ───────────────────────────────────────────────────────

function analyzeNextApiRoutes(
  vfs: VirtualFileSystem,
  framework: Framework
): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];

  for (const filePath of Object.keys(vfs)) {
    const isAppApi = /(?:^|\/)app\/api\/.*route\.[tj]sx?$/.test(filePath);
    const isPagesApi = /(?:^|\/)pages\/api\/.*\.[tj]sx?$/.test(filePath);
    if (!isAppApi && !isPagesApi) continue;

    const content = vfs[filePath] ?? "";
    const methods: RouteMethod[] = [];

    if (isAppApi) {
      for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"] as RouteMethod[]) {
        if (content.includes(`export async function ${m}`) || content.includes(`export function ${m}`)) {
          methods.push(m);
        }
      }
    } else {
      if (content.includes("req.method")) methods.push("GET", "POST", "PUT", "PATCH", "DELETE");
      else methods.push("GET");
    }

    let path: string | null = null;
    if (isAppApi) {
      const m = filePath.match(/(?:^|\/)app\/(api\/.+)\/route\.[tj]sx?$/);
      if (m) path = "/" + m[1];
    } else {
      const m = filePath.match(/(?:^|\/)pages\/(api\/.+)\.[tj]sx?$/);
      if (m) path = "/" + m[1];
    }
    if (!path) continue;

    path = path.replace(/\/index$/, "");
    const pageType = classifyPageType(path);
    const params = extractParams(path);

    routes.push({
      id: nextId(),
      path,
      filePath,
      routeType: "api",
      pageType,
      methods: methods.length ? methods : ["GET"],
      isDynamic: pageType !== "static",
      params,
      layoutId: null,
      parentRouteId: null,
      childRouteIds: [],
      isOrphan: false,
      duplicateOf: null,
      framework,
      depth: pathDepth(path),
    });
  }

  return routes;
}

// ─── Next.js Pages Router ─────────────────────────────────────────────────────

function analyzeNextPagesRouter(
  vfs: VirtualFileSystem,
  framework: Framework
): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];

  for (const filePath of Object.keys(vfs)) {
    if (!/\/pages\/[^_]/.test(filePath) && !/^pages\/[^_]/.test(filePath)) continue;
    if (/\/pages\/api\//.test(filePath)) continue;
    if (!/\.[tj]sx?$/.test(filePath)) continue;

    const path = normalizeNextPagesPath(filePath);
    if (!path) continue;

    const pageType = classifyPageType(path);
    const params = extractParams(path);

    routes.push({
      id: nextId(),
      path,
      filePath,
      routeType: "page",
      pageType,
      methods: ["GET"],
      isDynamic: pageType !== "static",
      params,
      layoutId: null,
      parentRouteId: null,
      childRouteIds: [],
      isOrphan: false,
      duplicateOf: null,
      framework,
      depth: pathDepth(path),
    });
  }

  return routes;
}

// ─── Astro ────────────────────────────────────────────────────────────────────

function analyzeAstroRoutes(
  vfs: VirtualFileSystem,
  framework: Framework
): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];

  for (const filePath of Object.keys(vfs)) {
    if (!/\/pages\//.test(filePath) && !/^pages\//.test(filePath)) continue;
    if (!/\.(astro|mdx?|tsx?|jsx?)$/.test(filePath)) continue;

    const path = normalizeAstroPath(filePath);
    if (!path) continue;

    const pageType = classifyPageType(path);
    const params = extractParams(path);

    routes.push({
      id: nextId(),
      path,
      filePath,
      routeType: "page",
      pageType,
      methods: ["GET"],
      isDynamic: pageType !== "static",
      params,
      layoutId: null,
      parentRouteId: null,
      childRouteIds: [],
      isOrphan: false,
      duplicateOf: null,
      framework,
      depth: pathDepth(path),
    });
  }

  return routes;
}

// ─── Express ──────────────────────────────────────────────────────────────────

const EXPRESS_ROUTE_RE = /(?:app|router)\.(get|post|put|patch|delete|all)\s*\(\s*['"`](\/[^'"`]*)/gi;

function analyzeExpressRoutes(
  vfs: VirtualFileSystem,
  framework: Framework
): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  const methodMap: Record<string, RouteMethod> = {
    get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE", all: "ALL",
  };

  for (const [filePath, content] of Object.entries(vfs)) {
    if (!/\.[tj]s$/.test(filePath)) continue;
    if (!content.includes("express") && !content.includes("Router") && !content.includes("router")) continue;

    let m: RegExpExecArray | null;
    EXPRESS_ROUTE_RE.lastIndex = 0;
    while ((m = EXPRESS_ROUTE_RE.exec(content)) !== null) {
      const verb = m[1]!.toLowerCase();
      const path = m[2]!;
      const method = methodMap[verb] ?? "GET";
      const expressPath = path.replace(/:(\w+)/g, "[$1]");
      const pageType = classifyPageType(expressPath);
      const params = path.match(/:(\w+)/g)?.map((p) => p.slice(1)) ?? [];

      routes.push({
        id: nextId(),
        path: expressPath,
        filePath,
        routeType: "api",
        pageType,
        methods: [method],
        isDynamic: params.length > 0,
        params,
        layoutId: null,
        parentRouteId: null,
        childRouteIds: [],
        isOrphan: false,
        duplicateOf: null,
        framework,
        depth: pathDepth(expressPath),
      });
    }
  }

  return routes;
}

// ─── Laravel ─────────────────────────────────────────────────────────────────

const LARAVEL_ROUTE_RE = /Route::(get|post|put|patch|delete|any)\s*\(\s*['"]([^'"]+)/gi;

function analyzeLaravelRoutes(
  vfs: VirtualFileSystem,
  framework: Framework
): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  const methodMap: Record<string, RouteMethod> = {
    get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE", any: "ALL",
  };

  const routeFiles = Object.keys(vfs).filter((f) => /routes\/[^/]+\.php$/.test(f));

  for (const filePath of routeFiles) {
    const content = vfs[filePath] ?? "";
    const isApiFile = filePath.includes("routes/api");

    let m: RegExpExecArray | null;
    LARAVEL_ROUTE_RE.lastIndex = 0;
    while ((m = LARAVEL_ROUTE_RE.exec(content)) !== null) {
      const verb = m[1]!.toLowerCase();
      const rawPath = m[2]!.startsWith("/") ? m[2]! : "/" + m[2]!;
      const path = rawPath.replace(/\{(\w+)\??\}/g, "[$1]");
      const method = methodMap[verb] ?? "GET";
      const pageType = classifyPageType(path);
      const params = (rawPath.match(/\{(\w+)\??}/g) ?? []).map((p) =>
        p.replace(/[{}?]/g, "")
      );

      routes.push({
        id: nextId(),
        path,
        filePath,
        routeType: isApiFile ? "api" : "page",
        pageType,
        methods: [method],
        isDynamic: params.length > 0,
        params,
        layoutId: null,
        parentRouteId: null,
        childRouteIds: [],
        isOrphan: false,
        duplicateOf: null,
        framework,
        depth: pathDepth(path),
      });
    }
  }

  return routes;
}

// ─── WordPress ────────────────────────────────────────────────────────────────

function analyzeWordPressRoutes(
  vfs: VirtualFileSystem,
  framework: Framework
): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  const wpTemplates: Record<string, string> = {
    "index.php": "/",
    "front-page.php": "/",
    "home.php": "/blog",
    "single.php": "/[post_type]/[slug]",
    "page.php": "/[slug]",
    "archive.php": "/[post_type]",
    "category.php": "/category/[slug]",
    "tag.php": "/tag/[slug]",
    "search.php": "/?s=[query]",
    "404.php": "/404",
    "author.php": "/author/[slug]",
    "attachment.php": "/[parent]/[slug]",
  };

  for (const [fileName, path] of Object.entries(wpTemplates)) {
    if (fileName in vfs || `./${fileName}` in vfs) {
      const filePath = fileName in vfs ? fileName : `./${fileName}`;
      const pageType = classifyPageType(path);
      const params = extractParams(path);
      routes.push({
        id: nextId(),
        path,
        filePath,
        routeType: "page",
        pageType,
        methods: ["GET"],
        isDynamic: pageType !== "static",
        params,
        layoutId: null,
        parentRouteId: null,
        childRouteIds: [],
        isOrphan: false,
        duplicateOf: null,
        framework,
        depth: pathDepth(path),
      });
    }
  }

  for (const filePath of Object.keys(vfs)) {
    const m = filePath.match(/(?:^|\/)(?:page|template)-([^/.]+)\.php$/);
    if (!m) continue;
    const slug = m[1]!;
    const path = `/${slug}`;
    routes.push({
      id: nextId(),
      path,
      filePath,
      routeType: "page",
      pageType: "static",
      methods: ["GET"],
      isDynamic: false,
      params: [],
      layoutId: null,
      parentRouteId: null,
      childRouteIds: [],
      isOrphan: false,
      duplicateOf: null,
      framework,
      depth: 1,
    });
  }

  return routes;
}

// ─── Build hierarchy ──────────────────────────────────────────────────────────

function buildHierarchy(routes: DiscoveredRoute[]): void {
  for (const route of routes) {
    if (route.path === "/" || route.routeType === "api") continue;
    const parts = route.path.split("/").filter(Boolean);
    if (parts.length <= 1) continue;
    const parentPath = "/" + parts.slice(0, -1).join("/");
    const parent = routes.find((r) => r.path === parentPath && r.routeType === "page");
    if (parent) {
      route.parentRouteId = parent.id;
      parent.childRouteIds.push(route.id);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function analyzeRoutes(
  vfs: VirtualFileSystem,
  fw: FrameworkDetectionResult
): DiscoveredRoute[] {
  routeSeq = 0;
  const { primary, features } = fw;
  let routes: DiscoveredRoute[] = [];

  if (primary === "nextjs") {
    if (features.includes("app-router")) {
      routes.push(...analyzeNextAppRouter(vfs, primary));
      routes.push(...analyzeNextApiRoutes(vfs, primary));
    }
    if (features.includes("pages-router")) {
      routes.push(...analyzeNextPagesRouter(vfs, primary));
      routes.push(...analyzeNextApiRoutes(vfs, primary));
    }
    if (!features.includes("app-router") && !features.includes("pages-router")) {
      routes.push(...analyzeNextAppRouter(vfs, primary));
      routes.push(...analyzeNextPagesRouter(vfs, primary));
      routes.push(...analyzeNextApiRoutes(vfs, primary));
    }
  } else if (primary === "astro") {
    routes = analyzeAstroRoutes(vfs, primary);
  } else if (primary === "express") {
    routes = analyzeExpressRoutes(vfs, primary);
  } else if (primary === "laravel") {
    routes = analyzeLaravelRoutes(vfs, primary);
  } else if (primary === "wordpress") {
    routes = analyzeWordPressRoutes(vfs, primary);
  } else {
    routes = [
      ...analyzeNextAppRouter(vfs, "react"),
      ...analyzeNextPagesRouter(vfs, "react"),
      ...analyzeExpressRoutes(vfs, "express"),
    ];
  }

  const seen = new Map<string, string>();
  for (const route of routes) {
    const key = `${route.routeType}::${route.path}`;
    if (seen.has(key)) {
      route.duplicateOf = seen.get(key)!;
    } else {
      seen.set(key, route.id);
    }
  }

  buildHierarchy(routes);
  return routes;
}
