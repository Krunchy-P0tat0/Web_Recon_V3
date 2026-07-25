import type {
  DiscoveredApiEndpoint,
  DiscoveredRoute,
  Framework,
  FrameworkDetectionResult,
  RouteMethod,
  VirtualFileSystem,
} from "./types.js";

let apiSeq = 0;
function nextId(): string {
  return `api-${(++apiSeq).toString().padStart(4, "0")}`;
}

// ─── Heuristics ───────────────────────────────────────────────────────────────

function hasAuth(content: string): boolean {
  return (
    content.includes("auth") ||
    content.includes("session") ||
    content.includes("jwt") ||
    content.includes("getServerSession") ||
    content.includes("verifyToken") ||
    content.includes("protect") ||
    content.includes("middleware") ||
    content.includes("authenticate")
  );
}

function hasValidation(content: string): boolean {
  return (
    content.includes(".parse(") ||
    content.includes(".safeParse(") ||
    content.includes("validate(") ||
    content.includes("Joi.") ||
    content.includes("yup.") ||
    content.includes("zod") ||
    content.includes("express-validator") ||
    content.includes("class-validator")
  );
}

function returnsJson(content: string): boolean {
  return (
    content.includes("json(") ||
    content.includes("JSON.stringify") ||
    content.includes("response.json") ||
    content.includes("res.json") ||
    content.includes("NextResponse.json") ||
    content.includes("return json")
  );
}

function extractParamNames(path: string): string[] {
  return [...path.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!.replace(/^\.{3}/, ""));
}

function extractQueryParams(content: string): string[] {
  const params: string[] = [];
  const matches = content.matchAll(/(?:searchParams|query)(?:\.|get\(|\.get\()['"]?(\w+)['"]?/g);
  for (const m of matches) {
    if (!params.includes(m[1]!)) params.push(m[1]!);
  }
  return params;
}

function extractHandlerName(content: string, method: RouteMethod): string | null {
  const patterns = [
    new RegExp(`export\\s+(?:async\\s+)?function\\s+(\\w+)`),
    new RegExp(`export\\s+const\\s+(\\w+)\\s*=`),
    new RegExp(`(?:app|router)\\.${method.toLowerCase()}\\([^,]+,\\s*(?:async\\s+)?(?:function\\s+)?(\\w+)`),
  ];
  for (const re of patterns) {
    const m = content.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

// ─── Next.js API routes ───────────────────────────────────────────────────────

function detectNextApiEndpoints(
  vfs: VirtualFileSystem,
  routes: DiscoveredRoute[],
  framework: Framework
): DiscoveredApiEndpoint[] {
  return routes
    .filter((r) => r.routeType === "api")
    .map((route) => {
      const content = vfs[route.filePath] ?? "";
      return {
        id: nextId(),
        path: route.path,
        methods: route.methods,
        filePath: route.filePath,
        framework,
        isAuth: hasAuth(content),
        hasValidation: hasValidation(content),
        returnsJson: returnsJson(content),
        paramNames: extractParamNames(route.path),
        queryParams: extractQueryParams(content),
        handlerName: extractHandlerName(content, route.methods[0] ?? "GET"),
      };
    });
}

// ─── Express API detection ────────────────────────────────────────────────────

const EXPRESS_FULL_RE = /(?:app|router)\.(get|post|put|patch|delete|all)\s*\(\s*['"`](\/[^'"`]*)/gi;

function detectExpressEndpoints(
  vfs: VirtualFileSystem,
  framework: Framework
): DiscoveredApiEndpoint[] {
  const endpoints: DiscoveredApiEndpoint[] = [];
  const methodMap: Record<string, RouteMethod> = {
    get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE", all: "ALL",
  };

  for (const [filePath, content] of Object.entries(vfs)) {
    if (!/\.[tj]s$/.test(filePath)) continue;
    if (!content.includes("express") && !content.includes("Router()")) continue;

    EXPRESS_FULL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EXPRESS_FULL_RE.exec(content)) !== null) {
      const method = methodMap[m[1]!.toLowerCase()] ?? "GET";
      const rawPath = m[2]!;
      const normPath = rawPath.replace(/:(\w+)/g, "[$1]");

      endpoints.push({
        id: nextId(),
        path: normPath,
        methods: [method],
        filePath,
        framework,
        isAuth: hasAuth(content),
        hasValidation: hasValidation(content),
        returnsJson: returnsJson(content),
        paramNames: (rawPath.match(/:(\w+)/g) ?? []).map((p) => p.slice(1)),
        queryParams: extractQueryParams(content),
        handlerName: extractHandlerName(content, method),
      });
    }
  }

  return endpoints;
}

// ─── Laravel API ──────────────────────────────────────────────────────────────

const LARAVEL_API_RE = /Route::(get|post|put|patch|delete|any)\s*\(\s*['"]([^'"]+)/gi;

function detectLaravelEndpoints(
  vfs: VirtualFileSystem,
  framework: Framework
): DiscoveredApiEndpoint[] {
  const endpoints: DiscoveredApiEndpoint[] = [];
  const methodMap: Record<string, RouteMethod> = {
    get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE", any: "ALL",
  };

  const apiFile = Object.keys(vfs).find((f) => /routes\/api\.php$/.test(f));
  if (!apiFile) return endpoints;

  const content = vfs[apiFile]!;
  LARAVEL_API_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = LARAVEL_API_RE.exec(content)) !== null) {
    const method = methodMap[m[1]!.toLowerCase()] ?? "GET";
    const rawPath = m[2]!.startsWith("/") ? m[2]! : "/" + m[2]!;
    const normPath = rawPath.replace(/\{(\w+)\??}/g, "[$1]");

    endpoints.push({
      id: nextId(),
      path: normPath,
      methods: [method],
      filePath: apiFile,
      framework,
      isAuth: content.includes("auth:api") || content.includes("middleware"),
      hasValidation: hasValidation(content),
      returnsJson: true,
      paramNames: (rawPath.match(/\{(\w+)\??}/g) ?? []).map((p) => p.replace(/[{}?]/g, "")),
      queryParams: [],
      handlerName: null,
    });
  }

  return endpoints;
}

// ─── WordPress REST API ───────────────────────────────────────────────────────

const WP_REST_RE = /register_rest_route\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g;

function detectWordPressEndpoints(
  vfs: VirtualFileSystem,
  framework: Framework
): DiscoveredApiEndpoint[] {
  const endpoints: DiscoveredApiEndpoint[] = [];

  for (const [filePath, content] of Object.entries(vfs)) {
    if (!/\.php$/.test(filePath)) continue;
    if (!content.includes("register_rest_route")) continue;

    WP_REST_RE.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = WP_REST_RE.exec(content)) !== null) {
      const namespace = m[1]!;
      const route = m[2]!;
      const fullPath = `/wp-json/${namespace}/${route}`.replace(/\/+/g, "/");
      const normPath = fullPath.replace(/\(\?P<(\w+)>[^)]+\)/g, "[$1]");

      endpoints.push({
        id: nextId(),
        path: normPath,
        methods: ["GET"],
        filePath,
        framework,
        isAuth: content.includes("permission_callback"),
        hasValidation: content.includes("validate_callback") || content.includes("sanitize_callback"),
        returnsJson: true,
        paramNames: extractParamNames(normPath),
        queryParams: [],
        handlerName: null,
      });
    }
  }

  return endpoints;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function detectApiEndpoints(
  vfs: VirtualFileSystem,
  routes: DiscoveredRoute[],
  fw: FrameworkDetectionResult
): DiscoveredApiEndpoint[] {
  apiSeq = 0;

  if (fw.primary === "nextjs") {
    return detectNextApiEndpoints(vfs, routes, fw.primary);
  }
  if (fw.primary === "express") {
    return detectExpressEndpoints(vfs, fw.primary);
  }
  if (fw.primary === "laravel") {
    return detectLaravelEndpoints(vfs, fw.primary);
  }
  if (fw.primary === "wordpress") {
    return detectWordPressEndpoints(vfs, fw.primary);
  }

  return [
    ...detectNextApiEndpoints(vfs, routes, "nextjs"),
    ...detectExpressEndpoints(vfs, "express"),
  ];
}
