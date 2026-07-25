/**
 * semantic-merge-planner-d2.ts — Phase D2: Semantic Merge Planner
 *
 * READ-ONLY analysis engine. Never modifies source files.
 *
 * Compares two source directories:
 *   primePath    — Website Prime (reconstructed output)
 *   existingPath — Existing backend to merge into
 *
 * Analysis dimensions:
 *   1. Routes & controllers
 *   2. API contracts (OpenAPI / GraphQL)
 *   3. Database schemas
 *   4. Authentication systems
 *   5. Storage configuration
 *   6. Environment variables
 *   7. Dependency trees
 *   8. Configuration files
 *   9. Assets (public/ static/)
 *  10. Background workers / queues
 *
 * Outputs 3 R2 reports:
 *   semantic-merge-plan.json
 *   conflict-map.json
 *   merge-risk-report.json
 *
 * Every finding is classified:
 *   SAFE    — additive, no conflict, merge freely
 *   REVIEW  — potential conflict, needs human sign-off
 *   BLOCKED — definitive conflict, must resolve before merge
 */

import * as fs   from "fs";
import * as path from "path";
import { logger } from "./logger.js";
import { createCloudProvider } from "../cloud/index.js";

// ─── R2 ───────────────────────────────────────────────────────────────────────

function r2Key(detectionId: string, file: string): string { return `d2/${detectionId}/${file}`; }

async function storeR2(detectionId: string, file: string, data: unknown): Promise<string> {
  const key = r2Key(detectionId, file);
  const provider = createCloudProvider("r2");
  if (!provider.isConfigured()) { logger.warn({ detectionId, file }, "D2: R2 not configured"); return key; }
  const buf = Buffer.from(JSON.stringify(data, null, 2), "utf-8");
  await provider.upload({ key, data: buf, contentType: "application/json", checkDuplicate: false });
  logger.info({ key }, "D2: stored to R2");
  return key;
}

// ─── File system helpers ──────────────────────────────────────────────────────

const SCAN_IGNORE = new Set([
  "node_modules", ".git", "dist", "build", ".next", "__pycache__",
  ".venv", "venv", "vendor", "target", ".gradle", "tmp", "temp",
  ".cache", ".terraform", ".serverless", "coverage",
]);

const MAX_DEPTH = 6;
const MAX_FILES = 3000;
const MAX_READ  = 512 * 1024; // 512 KB

interface SFile { rel: string; abs: string; name: string; ext: string; size: number; }

function scanDir(root: string): SFile[] {
  const out: SFile[] = [];
  function walk(dir: string, depth: number) {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (SCAN_IGNORE.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs, depth + 1); continue; }
      let size = 0;
      try { size = fs.statSync(abs).size; } catch { /* */ }
      out.push({ rel: path.relative(root, abs), abs, name: e.name, ext: path.extname(e.name).toLowerCase(), size });
    }
  }
  walk(root, 0);
  return out;
}

function readSafe(abs: string): string {
  try {
    if (fs.statSync(abs).size > MAX_READ) return "";
    return fs.readFileSync(abs, "utf-8");
  } catch { return ""; }
}

function hasFile(files: SFile[], name: string): boolean { return files.some(f => f.name === name); }
function hasDir(files: SFile[], dir: string): boolean {
  return files.some(f => { const parts = f.rel.split(path.sep); return parts[0] === dir || parts.includes(dir); });
}
function findFiles(files: SFile[], pred: (f: SFile) => boolean): SFile[] { return files.filter(pred); }

// ─── Classification ───────────────────────────────────────────────────────────

export type Classification = "SAFE" | "REVIEW" | "BLOCKED";
export type ConflictCategory =
  | "route_collision"
  | "route_overlap"
  | "schema_drift"
  | "schema_type_mismatch"
  | "auth_incompatibility"
  | "env_conflict"
  | "env_missing"
  | "dep_version_conflict"
  | "dep_singleton_conflict"
  | "config_conflict"
  | "asset_collision"
  | "api_contract_conflict"
  | "storage_conflict"
  | "worker_conflict"
  | "breaking_change";

export interface Conflict {
  id: string;
  category: ConflictCategory;
  classification: Classification;
  title: string;
  description: string;
  primeSide:    { location: string; value?: string };
  existingSide: { location: string; value?: string };
  resolutionHint: string;
  autoResolvable: boolean;
  riskWeight: number;             // contribution to overall risk score (0-20)
}

export interface MergeDimension {
  name: string;
  classification: Classification;
  primeItems:    number;
  existingItems: number;
  conflicts:     number;
  safe:          number;
  review:        number;
  blocked:       number;
  notes:         string[];
}

// ─── Route extraction ─────────────────────────────────────────────────────────

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "all"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number] | "ANY";

export interface RouteEntry {
  method: HttpMethod;
  pattern: string;
  normalizedPattern: string; // :param replaced → {param}
  sourceFile: string;
  line?: number;
  framework: string;
}

function normalizePattern(p: string): string {
  return p
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, "{$1}")   // Express :id → {id}
    .replace(/\[([^\]]+)\]/g, "{$1}")                  // Next.js [id] → {id}
    .replace(/\{\.{3}[^}]+\}/g, "{...rest}")           // catch-all
    .replace(/\/+/g, "/")
    .replace(/\/$/, "") || "/";
}

function extractExpressRoutes(files: SFile[]): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const routeFiles = findFiles(files, f => [".ts", ".js", ".mjs"].includes(f.ext) && (f.rel.includes("route") || f.rel.includes("controller") || f.rel.includes("api")));

  // Patterns:  router.get('/path', ...)  |  app.post('/path', ...)  |  .route('/path').get(...)
  const singleRE = /(?:router|app|server)\s*\.\s*(get|post|put|patch|delete|head|options|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  const routeMethodRE = /\.route\s*\(\s*['"`]([^'"`]+)['"`]\s*\)(?:\s*\.\s*(get|post|put|patch|delete|head|options))+/gi;

  for (const f of routeFiles) {
    const content = readSafe(f.abs);
    if (!content) continue;

    let m: RegExpExecArray | null;
    singleRE.lastIndex = 0;
    while ((m = singleRE.exec(content)) !== null) {
      const method = (m[1]?.toLowerCase() ?? "get") as HttpMethod;
      const pattern = m[2] ?? "/";
      routes.push({ method, pattern, normalizedPattern: normalizePattern(pattern), sourceFile: f.rel, framework: "express" });
    }

    routeMethodRE.lastIndex = 0;
    while ((m = routeMethodRE.exec(content)) !== null) {
      const pattern = m[1] ?? "/";
      const methods = [...content.slice(m.index, m.index + m[0].length).matchAll(/\.\s*(get|post|put|patch|delete)/gi)].map(x => x[1]?.toLowerCase() as HttpMethod);
      for (const method of methods) {
        routes.push({ method, pattern, normalizedPattern: normalizePattern(pattern), sourceFile: f.rel, framework: "express" });
      }
    }
  }
  return routes;
}

function extractNextJsRoutes(files: SFile[]): RouteEntry[] {
  const routes: RouteEntry[] = [];

  // pages/api/** pattern
  const pagesApi = findFiles(files, f => f.rel.startsWith(`pages${path.sep}api`) || f.rel.startsWith("pages/api"));
  for (const f of pagesApi) {
    if (![".ts", ".js"].includes(f.ext)) continue;
    const rel = f.rel.replace(/\\/g, "/");
    let route = rel.replace(/^pages\/api/, "/api").replace(/\.(ts|js)$/, "").replace(/\/index$/, "");
    routes.push({ method: "ANY", pattern: route, normalizedPattern: normalizePattern(route), sourceFile: f.rel, framework: "nextjs-pages" });
  }

  // app/api/**/route.ts pattern
  const appApi = findFiles(files, f => (f.rel.includes("/api/") || f.rel.startsWith("app/api")) && f.name === "route.ts" || f.name === "route.js");
  for (const f of appApi) {
    const rel = f.rel.replace(/\\/g, "/");
    const route = "/" + rel.replace(/\/route\.(ts|js)$/, "").replace(/^app\//, "");
    const content = readSafe(f.abs);
    const exportedMethods = [...(content.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/g))].map(m => m[1]!.toLowerCase() as HttpMethod);
    const methods: HttpMethod[] = exportedMethods.length > 0 ? exportedMethods : ["ANY"];
    for (const method of methods) {
      routes.push({ method, pattern: route, normalizedPattern: normalizePattern(route), sourceFile: f.rel, framework: "nextjs-app" });
    }
  }
  return routes;
}

function extractNestJsRoutes(files: SFile[]): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const srcFiles = findFiles(files, f => [".ts"].includes(f.ext) && (f.name.endsWith(".controller.ts")));

  const controllerRE = /@Controller\s*\(\s*['"`]?([^'"`)\s]*)['"`]?\s*\)/;
  const methodRE = /@(Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(\s*['"`]?([^'"`)\s]*)['"`]?\s*\)/gi;

  for (const f of srcFiles) {
    const content = readSafe(f.abs);
    if (!content) continue;
    const controllerMatch = controllerRE.exec(content);
    const prefix = controllerMatch?.[1] ? `/${controllerMatch[1]}` : "";
    let m: RegExpExecArray | null;
    methodRE.lastIndex = 0;
    while ((m = methodRE.exec(content)) !== null) {
      const method = (m[1]?.toLowerCase() ?? "get") as HttpMethod;
      const sub = m[2] ?? "";
      const pattern = [prefix, sub ? `/${sub}` : ""].join("").replace(/\/+/g, "/") || "/";
      routes.push({ method, pattern, normalizedPattern: normalizePattern(pattern), sourceFile: f.rel, framework: "nestjs" });
    }
  }
  return routes;
}

function extractFastApiRoutes(files: SFile[]): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const pyFiles = findFiles(files, f => f.ext === ".py");
  const methodRE = /@(?:app|router)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/gi;

  for (const f of pyFiles) {
    const content = readSafe(f.abs);
    if (!content) continue;
    let m: RegExpExecArray | null;
    methodRE.lastIndex = 0;
    while ((m = methodRE.exec(content)) !== null) {
      const method = (m[1]?.toLowerCase() ?? "get") as HttpMethod;
      const pattern = m[2] ?? "/";
      routes.push({ method, pattern, normalizedPattern: normalizePattern(pattern), sourceFile: f.rel, framework: "fastapi" });
    }
  }
  return routes;
}

function extractDjangoRoutes(files: SFile[]): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const urlFiles = findFiles(files, f => f.name === "urls.py");
  const pathRE = /path\s*\(\s*['"`]([^'"`]*)['"`]/gi;

  for (const f of urlFiles) {
    const content = readSafe(f.abs);
    if (!content) continue;
    let m: RegExpExecArray | null;
    pathRE.lastIndex = 0;
    while ((m = pathRE.exec(content)) !== null) {
      const pattern = `/${m[1]}`.replace(/\/+/g, "/");
      routes.push({ method: "ANY", pattern, normalizedPattern: normalizePattern(pattern), sourceFile: f.rel, framework: "django" });
    }
  }
  return routes;
}

function extractLaravelRoutes(files: SFile[]): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const routeFiles = findFiles(files, f => f.rel.startsWith("routes/") && f.ext === ".php");
  const routeRE = /Route\s*::\s*(get|post|put|patch|delete|any|match)\s*\(\s*['"`]([^'"`]+)['"`]/gi;

  for (const f of routeFiles) {
    const content = readSafe(f.abs);
    if (!content) continue;
    let m: RegExpExecArray | null;
    routeRE.lastIndex = 0;
    while ((m = routeRE.exec(content)) !== null) {
      const method = (m[1]?.toLowerCase() === "any" ? "all" : m[1]?.toLowerCase() ?? "get") as HttpMethod;
      const pattern = m[2] ?? "/";
      routes.push({ method, pattern, normalizedPattern: normalizePattern(pattern), sourceFile: f.rel, framework: "laravel" });
    }
  }
  return routes;
}

function extractRailsRoutes(files: SFile[]): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const routeFile = files.find(f => f.rel.includes("config/routes.rb"));
  if (!routeFile) return routes;

  const content = readSafe(routeFile.abs);
  const routeRE = /\b(get|post|put|patch|delete|resources?|namespace|scope)\s+['"`:]([^'"`\s,]+)/gi;
  let m: RegExpExecArray | null;
  routeRE.lastIndex = 0;
  while ((m = routeRE.exec(content)) !== null) {
    const verb = m[1]?.toLowerCase() ?? "get";
    const pattern = `/${m[2]}`.replace(/\/+/g, "/");
    const method: HttpMethod = ["get","post","put","patch","delete"].includes(verb) ? verb as HttpMethod : "ANY";
    routes.push({ method, pattern, normalizedPattern: normalizePattern(pattern), sourceFile: routeFile.rel, framework: "rails" });
  }
  return routes;
}

function extractAllRoutes(files: SFile[]): RouteEntry[] {
  return [
    ...extractExpressRoutes(files),
    ...extractNextJsRoutes(files),
    ...extractNestJsRoutes(files),
    ...extractFastApiRoutes(files),
    ...extractDjangoRoutes(files),
    ...extractLaravelRoutes(files),
    ...extractRailsRoutes(files),
  ];
}

// ─── Schema extraction ────────────────────────────────────────────────────────

export interface SchemaModel {
  name: string;
  fields: Array<{ name: string; type: string; optional: boolean; isRelation: boolean }>;
  sourceFile: string;
  orm: string;
}

function extractPrismaModels(files: SFile[]): SchemaModel[] {
  const models: SchemaModel[] = [];
  const schemaFiles = findFiles(files, f => f.name === "schema.prisma");

  const modelRE   = /model\s+(\w+)\s*\{([^}]+)\}/gs;
  const fieldRE   = /^\s+(\w+)\s+([\w[\]?]+)/gm;

  for (const f of schemaFiles) {
    const content = readSafe(f.abs);
    let m: RegExpExecArray | null;
    modelRE.lastIndex = 0;
    while ((m = modelRE.exec(content)) !== null) {
      const name   = m[1]!;
      const body   = m[2]!;
      const fields: SchemaModel["fields"] = [];
      let fm: RegExpExecArray | null;
      fieldRE.lastIndex = 0;
      while ((fm = fieldRE.exec(body)) !== null) {
        const fieldName = fm[1]!;
        if (["@@", "//"].some(p => fieldName.startsWith(p))) continue;
        const rawType   = fm[2]!;
        const optional  = rawType.endsWith("?");
        const isRelation = /^[A-Z]/.test(rawType.replace(/[?\[\]]/g, ""));
        fields.push({ name: fieldName, type: rawType.replace(/[?\[\]]/g, ""), optional, isRelation });
      }
      models.push({ name, fields, sourceFile: f.rel, orm: "prisma" });
    }
  }
  return models;
}

function extractDrizzleModels(files: SFile[]): SchemaModel[] {
  const models: SchemaModel[] = [];
  // Drizzle: export const users = pgTable('users', { ... })
  const tableFiles = findFiles(files, f => [".ts",".js"].includes(f.ext) && (f.rel.includes("schema") || f.rel.includes("model") || f.rel.includes("table")));
  const tableRE = /export\s+const\s+(\w+)\s*=\s*(?:pgTable|mysqlTable|sqliteTable|table)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{([^}]+)\}/gs;
  const fieldRE  = /(\w+)\s*:\s*(\w+)\s*\(/gm;

  for (const f of tableFiles) {
    const content = readSafe(f.abs);
    if (!content.includes("Table") && !content.includes("pgTable")) continue;
    let m: RegExpExecArray | null;
    tableRE.lastIndex = 0;
    while ((m = tableRE.exec(content)) !== null) {
      const name = m[2] ?? m[1]!;
      const body = m[3]!;
      const fields: SchemaModel["fields"] = [];
      let fm: RegExpExecArray | null;
      fieldRE.lastIndex = 0;
      while ((fm = fieldRE.exec(body)) !== null) {
        fields.push({ name: fm[1]!, type: fm[2]!, optional: false, isRelation: false });
      }
      models.push({ name, fields, sourceFile: f.rel, orm: "drizzle" });
    }
  }
  return models;
}

function extractSqlMigrationTables(files: SFile[]): SchemaModel[] {
  const models: SchemaModel[] = [];
  const sqlFiles = findFiles(files, f => f.ext === ".sql" && (f.rel.includes("migrat") || f.rel.includes("schema")));
  const createRE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s*\(([^;]+)/gis;
  const colRE    = /^\s+["'`]?(\w+)["'`]?\s+([A-Z]+(?:\([^)]*\))?)/gim;

  for (const f of sqlFiles.slice(0, 20)) { // cap at 20 SQL files
    const content = readSafe(f.abs);
    let m: RegExpExecArray | null;
    createRE.lastIndex = 0;
    while ((m = createRE.exec(content)) !== null) {
      const name   = m[1]!;
      const body   = m[2]!;
      const fields: SchemaModel["fields"] = [];
      let fm: RegExpExecArray | null;
      colRE.lastIndex = 0;
      while ((fm = colRE.exec(body)) !== null) {
        if (/PRIMARY|FOREIGN|UNIQUE|INDEX|CONSTRAINT|CHECK/.test(fm[1]!.toUpperCase())) continue;
        fields.push({ name: fm[1]!, type: fm[2]!.split("(")[0]!, optional: !body.includes("NOT NULL"), isRelation: false });
      }
      if (fields.length > 0) models.push({ name, fields, sourceFile: f.rel, orm: "sql" });
    }
  }
  return models;
}

function extractAllModels(files: SFile[]): SchemaModel[] {
  return [...extractPrismaModels(files), ...extractDrizzleModels(files), ...extractSqlMigrationTables(files)];
}

// ─── Env var extraction ───────────────────────────────────────────────────────

interface EnvEntry { key: string; value: string; sourceFile: string; }

function extractEnvVars(files: SFile[]): EnvEntry[] {
  const entries: EnvEntry[] = [];
  const envFiles = findFiles(files, f => f.name.startsWith(".env") && !f.name.endsWith(".js") && !f.name.endsWith(".ts"));
  const lineRE = /^([A-Z_][A-Z0-9_]*)=(.*)$/gm;

  for (const f of envFiles) {
    const content = readSafe(f.abs);
    let m: RegExpExecArray | null;
    lineRE.lastIndex = 0;
    while ((m = lineRE.exec(content)) !== null) {
      entries.push({ key: m[1]!, value: m[2]?.trim() ?? "", sourceFile: f.rel });
    }
  }
  return entries;
}

// Also pull env references from source files (process.env.VAR_NAME)
function extractEnvReferences(files: SFile[]): string[] {
  const keys = new Set<string>();
  const srcFiles = findFiles(files, f => [".ts",".js",".py",".php",".rb"].includes(f.ext)).slice(0, 200);
  const re = /process\.env\.([A-Z_][A-Z0-9_]*)|os\.environ(?:\.get)?\(['"]([A-Z_][A-Z0-9_]*)['"]|env\('([A-Z_][A-Z0-9_]*)'\)|getenv\(['"]([A-Z_][A-Z0-9_]*)['"]|ENV\[['"]([A-Z_][A-Z0-9_]*)['"]|settings\.([A-Z_][A-Z0-9_]*)/g;
  for (const f of srcFiles) {
    const content = readSafe(f.abs);
    if (!content) continue;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      const key = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6];
      if (key) keys.add(key);
    }
  }
  return [...keys];
}

// ─── Dependency extraction ────────────────────────────────────────────────────

interface DepEntry { name: string; version: string; isDev: boolean; }

function extractNpmDeps(files: SFile[]): DepEntry[] {
  const pkgFile = files.find(f => f.name === "package.json" && f.rel.split(path.sep).length === 1);
  if (!pkgFile) return [];
  try {
    const json = JSON.parse(readSafe(pkgFile.abs)) as Record<string, unknown>;
    const deps    = (json["dependencies"] as Record<string, string> | undefined) ?? {};
    const devDeps = (json["devDependencies"] as Record<string, string> | undefined) ?? {};
    return [
      ...Object.entries(deps).map(([name, version]) => ({ name, version, isDev: false })),
      ...Object.entries(devDeps).map(([name, version]) => ({ name, version, isDev: true })),
    ];
  } catch { return []; }
}

function parseSemverMajor(version: string): number | null {
  const cleaned = version.replace(/^[\^~>=<* ]+/, "").split(".")[0];
  const n = parseInt(cleaned ?? "", 10);
  return isNaN(n) ? null : n;
}

// ─── Auth extraction ──────────────────────────────────────────────────────────

interface AuthProfile {
  system: string;
  sessionStore: string | null;
  jwtUsed: boolean;
  oauthProviders: string[];
  middlewareFiles: string[];
}

function extractAuthProfile(files: SFile[], deps: DepEntry[]): AuthProfile {
  const depNames = new Set(deps.map(d => d.name));

  const system =
    depNames.has("next-auth") || depNames.has("@auth/core") ? "NextAuth.js" :
    [...depNames].some(d => d.startsWith("@clerk/")) ? "Clerk" :
    [...depNames].some(d => d.startsWith("@auth0/")) ? "Auth0" :
    depNames.has("passport") ? "Passport.js" :
    depNames.has("@supabase/supabase-js") ? "Supabase Auth" :
    depNames.has("firebase-admin") ? "Firebase Auth" :
    depNames.has("jsonwebtoken") || depNames.has("jose") ? "JWT (custom)" :
    "None";

  const sessionStore =
    depNames.has("connect-redis") ? "Redis" :
    depNames.has("express-session") ? "In-memory" :
    depNames.has("connect-pg-simple") ? "PostgreSQL" :
    null;

  const jwtUsed = depNames.has("jsonwebtoken") || depNames.has("jose") || depNames.has("@nestjs/jwt");

  // OAuth providers from NextAuth config
  const providers: string[] = [];
  const authConfigFiles = findFiles(files, f => (f.name.includes("auth") || f.name.includes("next-auth")) && [".ts",".js"].includes(f.ext));
  const providerRE = /(?:GoogleProvider|GithubProvider|FacebookProvider|TwitterProvider|DiscordProvider|SpotifyProvider|SlackProvider|AppleProvider)\s*\(/g;
  for (const f of authConfigFiles.slice(0, 5)) {
    const content = readSafe(f.abs);
    const matches = [...content.matchAll(providerRE)].map(m => m[0].replace(/Provider.*/, ""));
    providers.push(...matches);
  }

  const middlewareFiles = findFiles(files, f =>
    (f.name.includes("middleware") || f.name.includes("auth") || f.name.includes("guard")) && [".ts",".js",".py",".php",".rb"].includes(f.ext)
  ).map(f => f.rel);

  return { system, sessionStore, jwtUsed, oauthProviders: [...new Set(providers)], middlewareFiles };
}

// ─── Asset extraction ─────────────────────────────────────────────────────────

interface AssetEntry { rel: string; name: string; ext: string; size: number; }

function extractAssets(files: SFile[]): AssetEntry[] {
  const assetExts = new Set([".png",".jpg",".jpeg",".gif",".webp",".svg",".ico",".woff",".woff2",".ttf",".eot",".pdf",".mp4",".mp3",".json",".css"]);
  return findFiles(files, f => assetExts.has(f.ext) && (f.rel.startsWith("public") || f.rel.startsWith("static") || f.rel.startsWith("assets"))).map(f => ({ rel: f.rel, name: f.name, ext: f.ext, size: f.size }));
}

// ─── API Contract extraction ──────────────────────────────────────────────────

interface ApiContract {
  type: "openapi" | "graphql" | "trpc" | "unknown";
  file: string;
  endpoints?: string[];
  version?: string;
}

function extractApiContracts(files: SFile[]): ApiContract[] {
  const contracts: ApiContract[] = [];

  // OpenAPI / Swagger
  const openApiFiles = findFiles(files, f => (f.name === "openapi.json" || f.name === "openapi.yaml" || f.name === "swagger.json" || f.name === "swagger.yaml" || f.name.includes("openapi")));
  for (const f of openApiFiles) {
    const content = readSafe(f.abs);
    const endpoints = [...(content.matchAll(/^\s+\/[^:'"]+:/gm))].map(m => m[0].trim().replace(/:$/, "")).slice(0, 50);
    const versionMatch = content.match(/version['":\s]+(['"]?)(\d+\.\d+)/);
    contracts.push({ type: "openapi", file: f.rel, endpoints, version: versionMatch?.[2] });
  }

  // GraphQL schemas
  const gqlFiles = findFiles(files, f => f.ext === ".graphql" || f.ext === ".gql" || f.name === "schema.graphql");
  for (const f of gqlFiles) {
    const content = readSafe(f.abs);
    const types = [...(content.matchAll(/^type\s+(\w+)/gm))].map(m => m[1]!);
    contracts.push({ type: "graphql", file: f.rel, endpoints: types });
  }

  // tRPC
  const trpcFiles = findFiles(files, f => f.name.includes("router") && f.ext === ".ts");
  for (const f of trpcFiles.slice(0, 5)) {
    const content = readSafe(f.abs);
    if (content.includes("createTRPCRouter") || content.includes("router(")) {
      const procedures = [...(content.matchAll(/\.(query|mutation|subscription)\s*\(/gm))].map(m => m[0]).slice(0, 20);
      if (procedures.length > 0) contracts.push({ type: "trpc", file: f.rel, endpoints: procedures });
    }
  }

  return contracts;
}

// ─── Config file extraction ───────────────────────────────────────────────────

interface ConfigEntry { name: string; file: string; keys: string[]; }

function extractConfigs(files: SFile[]): ConfigEntry[] {
  const configNames = ["next.config.js","next.config.ts","next.config.mjs","vite.config.ts","vite.config.js","tailwind.config.js","tailwind.config.ts","jest.config.ts","vitest.config.ts","tsconfig.json","eslintrc.json",".eslintrc.js","babel.config.js","webpack.config.js","drizzle.config.ts","drizzle.config.js","prisma/schema.prisma"];

  const configs: ConfigEntry[] = [];
  for (const name of configNames) {
    const f = files.find(g => g.name === path.basename(name) || g.rel.endsWith(name));
    if (!f) continue;
    const content = readSafe(f.abs);
    const keys = [...(content.matchAll(/^\s+['"]?([a-zA-Z][a-zA-Z0-9]+)['"]?\s*[=:]/gm))].map(m => m[1]!).slice(0, 30);
    configs.push({ name: path.basename(name), file: f.rel, keys });
  }
  return configs;
}

// ─── Conflict detection ───────────────────────────────────────────────────────

let _conflictSeq = 0;
function makeId(): string { return `C${String(++_conflictSeq).padStart(4, "0")}`; }

function detectRouteConflicts(primeRoutes: RouteEntry[], existingRoutes: RouteEntry[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const existingIndex = new Map<string, RouteEntry[]>();

  for (const r of existingRoutes) {
    const key = r.normalizedPattern;
    existingIndex.set(key, [...(existingIndex.get(key) ?? []), r]);
  }

  for (const prime of primeRoutes) {
    const matches = existingIndex.get(prime.normalizedPattern) ?? [];
    for (const existing of matches) {
      const exactMethodMatch = prime.method !== "ANY" && existing.method !== "ANY" && prime.method === existing.method;
      const anyOverlap       = prime.method === "ANY" || existing.method === "ANY";

      if (exactMethodMatch) {
        conflicts.push({
          id: makeId(), category: "route_collision", classification: "BLOCKED",
          title: `Route collision: ${prime.method.toUpperCase()} ${prime.normalizedPattern}`,
          description: `Both sides define ${prime.method.toUpperCase()} ${prime.normalizedPattern}. Only one handler will be active after merge — the other will be silently shadowed.`,
          primeSide:    { location: prime.sourceFile,    value: `${prime.method.toUpperCase()} ${prime.pattern}` },
          existingSide: { location: existing.sourceFile, value: `${existing.method.toUpperCase()} ${existing.pattern}` },
          resolutionHint: "Rename or namespace the Website Prime route (e.g. prefix with /prime/) or consolidate the handlers into one.",
          autoResolvable: false, riskWeight: 18,
        });
      } else if (anyOverlap) {
        conflicts.push({
          id: makeId(), category: "route_overlap", classification: "REVIEW",
          title: `Route overlap: ${prime.normalizedPattern}`,
          description: `Both sides define a handler at the same path with catch-all or different methods. Verify middleware ordering.`,
          primeSide:    { location: prime.sourceFile,    value: `${prime.method.toUpperCase()} ${prime.pattern}` },
          existingSide: { location: existing.sourceFile, value: `${existing.method.toUpperCase()} ${existing.pattern}` },
          resolutionHint: "Audit middleware order in the combined router to ensure the correct handler is reached first.",
          autoResolvable: false, riskWeight: 8,
        });
      }
    }

    // Partial path prefix conflicts (e.g. /api/users vs /api/users/profile — could shadow)
    for (const existing of existingRoutes) {
      if (existing.normalizedPattern === prime.normalizedPattern) continue; // already handled
      if (prime.normalizedPattern !== "/" && existing.normalizedPattern.startsWith(prime.normalizedPattern + "/") && prime.method === "ANY") {
        conflicts.push({
          id: makeId(), category: "route_overlap", classification: "REVIEW",
          title: `Prefix shadow risk: ${prime.normalizedPattern} may shadow ${existing.normalizedPattern}`,
          description: `A catch-all handler at ${prime.normalizedPattern} could intercept requests destined for ${existing.normalizedPattern}.`,
          primeSide:    { location: prime.sourceFile,    value: prime.normalizedPattern },
          existingSide: { location: existing.sourceFile, value: existing.normalizedPattern },
          resolutionHint: "Register more-specific routes before the catch-all in the merged router.",
          autoResolvable: true, riskWeight: 5,
        });
      }
    }
  }
  return conflicts;
}

function detectSchemaConflicts(primeModels: SchemaModel[], existingModels: SchemaModel[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const existingIndex = new Map(existingModels.map(m => [m.name.toLowerCase(), m]));

  for (const prime of primeModels) {
    const existing = existingIndex.get(prime.name.toLowerCase());
    if (!existing) continue; // Same table name exists on both sides — check field compatibility

    for (const pf of prime.fields) {
      const ef = existing.fields.find(f => f.name.toLowerCase() === pf.name.toLowerCase());
      if (!ef) {
        // Field in prime but not in existing — could be a migration needed
        conflicts.push({
          id: makeId(), category: "schema_drift", classification: "REVIEW",
          title: `Schema drift: ${prime.name}.${pf.name} not in existing schema`,
          description: `Field "${pf.name}" exists in Website Prime's ${prime.name} model but is absent from the existing schema. A migration will be required.`,
          primeSide:    { location: prime.sourceFile,    value: `${pf.name}: ${pf.type}` },
          existingSide: { location: existing.sourceFile, value: "(field absent)" },
          resolutionHint: `Add migration: ALTER TABLE ${prime.name} ADD COLUMN ${pf.name} ${pf.type};`,
          autoResolvable: pf.optional, riskWeight: pf.optional ? 5 : 12,
        });
      } else if (ef.type.toLowerCase() !== pf.type.toLowerCase() && !pf.isRelation && !ef.isRelation) {
        // Type mismatch
        conflicts.push({
          id: makeId(), category: "schema_type_mismatch", classification: "BLOCKED",
          title: `Type mismatch: ${prime.name}.${pf.name} (${pf.type} vs ${ef.type})`,
          description: `Field "${pf.name}" in model "${prime.name}" has type "${pf.type}" in Website Prime but "${ef.type}" in the existing schema. Runtime type errors will occur.`,
          primeSide:    { location: prime.sourceFile,    value: `${pf.name}: ${pf.type}` },
          existingSide: { location: existing.sourceFile, value: `${ef.name}: ${ef.type}` },
          resolutionHint: "Align field types before merge. Choose one canonical type and apply a SQL CAST migration if needed.",
          autoResolvable: false, riskWeight: 20,
        });
      }
    }
  }

  // Models in existing but not in prime — flag as REVIEW (prime may be incomplete)
  const primeNames = new Set(primeModels.map(m => m.name.toLowerCase()));
  for (const existing of existingModels) {
    if (!primeNames.has(existing.name.toLowerCase())) {
      conflicts.push({
        id: makeId(), category: "schema_drift", classification: "REVIEW",
        title: `Schema gap: ${existing.name} exists in existing backend, absent from Website Prime`,
        description: `Model "${existing.name}" was not detected in the Website Prime source. This model and its data must be preserved during merge.`,
        primeSide:    { location: "(not found)", value: undefined },
        existingSide: { location: existing.sourceFile, value: existing.name },
        resolutionHint: "Add the missing model to the Website Prime schema or verify it is intentionally omitted.",
        autoResolvable: false, riskWeight: 8,
      });
    }
  }

  return conflicts;
}

function detectAuthConflicts(primeAuth: AuthProfile, existingAuth: AuthProfile): Conflict[] {
  const conflicts: Conflict[] = [];

  if (primeAuth.system !== existingAuth.system && primeAuth.system !== "None" && existingAuth.system !== "None") {
    const incompatiblePairs = new Set([
      `${primeAuth.system}|${existingAuth.system}`,
      `${existingAuth.system}|${primeAuth.system}`,
    ]);
    const definitivelyIncompatible = [
      "Clerk|Passport.js", "Clerk|JWT (custom)", "Auth0|Passport.js",
      "NextAuth.js|Clerk", "NextAuth.js|Auth0", "Firebase Auth|Clerk",
    ].some(pair => incompatiblePairs.has(pair));

    conflicts.push({
      id: makeId(), category: "auth_incompatibility",
      classification: definitivelyIncompatible ? "BLOCKED" : "REVIEW",
      title: `Auth system mismatch: ${primeAuth.system} vs ${existingAuth.system}`,
      description: `Website Prime uses ${primeAuth.system} while the existing backend uses ${existingAuth.system}. Sessions, tokens, and user records may be incompatible.`,
      primeSide:    { location: "detected from deps/config", value: primeAuth.system },
      existingSide: { location: "detected from deps/config", value: existingAuth.system },
      resolutionHint: definitivelyIncompatible
        ? "Choose one auth system as the canonical provider. Migrate user sessions and update all protected route middleware."
        : "Audit all protected routes on both sides. Unify under one auth strategy or use an adapter layer.",
      autoResolvable: false, riskWeight: definitivelyIncompatible ? 20 : 12,
    });
  }

  if (primeAuth.sessionStore !== existingAuth.sessionStore && primeAuth.sessionStore !== null && existingAuth.sessionStore !== null) {
    conflicts.push({
      id: makeId(), category: "auth_incompatibility", classification: "REVIEW",
      title: `Session store mismatch: ${primeAuth.sessionStore} vs ${existingAuth.sessionStore}`,
      description: `Existing sessions will be invalidated when the session store is switched.`,
      primeSide:    { location: "detected from deps", value: primeAuth.sessionStore ?? undefined },
      existingSide: { location: "detected from deps", value: existingAuth.sessionStore ?? undefined },
      resolutionHint: "Plan a session drain period or invalidate all sessions on deploy. Migrate to a shared Redis session store.",
      autoResolvable: false, riskWeight: 8,
    });
  }
  return conflicts;
}

function detectEnvConflicts(primeEnv: EnvEntry[], existingEnv: EnvEntry[], primeRefs: string[], existingRefs: string[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const primeMap    = new Map<string, string>(primeEnv.map(e => [e.key, e.value]));
  const existingMap = new Map<string, string>(existingEnv.map(e => [e.key, e.value]));
  const existingFileMap = new Map<string, string>(existingEnv.map(e => [e.key, e.sourceFile]));
  const primeFileMap    = new Map<string, string>(primeEnv.map(e => [e.key, e.sourceFile]));

  const SENSITIVE_RE = /SECRET|KEY|TOKEN|PASSWORD|PASS|SALT|PRIVATE|CREDENTIALS?/i;

  for (const [key, primeVal] of primeMap) {
    const existingVal = existingMap.get(key);
    if (existingVal === undefined) continue;

    // Same key, different non-empty values
    if (primeVal && existingVal && primeVal !== existingVal && !SENSITIVE_RE.test(key)) {
      conflicts.push({
        id: makeId(), category: "env_conflict", classification: "REVIEW",
        title: `Env conflict: ${key}`,
        description: `Both sides define ${key} with different values. The merged app will use only one.`,
        primeSide:    { location: primeFileMap.get(key) ?? ".env",    value: primeVal },
        existingSide: { location: existingFileMap.get(key) ?? ".env", value: existingVal },
        resolutionHint: "Decide which value is authoritative. If environment-specific, use separate .env.production files.",
        autoResolvable: false, riskWeight: 6,
      });
    } else if (primeVal && existingVal && primeVal !== existingVal && SENSITIVE_RE.test(key)) {
      conflicts.push({
        id: makeId(), category: "env_conflict", classification: "BLOCKED",
        title: `Secret conflict: ${key}`,
        description: `Both sides define the secret ${key} with different values. Using the wrong secret will break authentication, encryption, or API access.`,
        primeSide:    { location: primeFileMap.get(key) ?? ".env",    value: "***" },
        existingSide: { location: existingFileMap.get(key) ?? ".env", value: "***" },
        resolutionHint: "Reconcile secrets in a vault (e.g. Doppler, AWS Secrets Manager). Never commit production secrets to source.",
        autoResolvable: false, riskWeight: 18,
      });
    }
  }

  // Vars referenced in prime but missing from existing's env
  for (const ref of primeRefs) {
    if (!existingMap.has(ref) && !primeMap.has(ref)) {
      conflicts.push({
        id: makeId(), category: "env_missing", classification: "REVIEW",
        title: `Missing env var: ${ref}`,
        description: `Website Prime references process.env.${ref} but it is not declared in any .env file on the existing backend.`,
        primeSide:    { location: "source reference", value: ref },
        existingSide: { location: "(not found)", value: undefined },
        resolutionHint: `Add ${ref} to the existing backend's .env file or secrets manager before deploying the merged application.`,
        autoResolvable: false, riskWeight: 5,
      });
    }
  }

  return conflicts;
}

function detectDepConflicts(primeDeps: DepEntry[], existingDeps: DepEntry[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const existingMap = new Map<string, DepEntry>(existingDeps.map(d => [d.name, d]));

  // Singleton conflicts — two competing libraries for the same purpose
  const singletonGroups: Record<string, string[]> = {
    "HTTP Framework":  ["express","fastify","koa","@hapi/hapi","restify"],
    "ORM":             ["@prisma/client","drizzle-orm","typeorm","sequelize","mongoose","@mikro-orm/core"],
    "Auth":            ["next-auth","passport","@clerk/backend","@auth0/auth0-spa-js","@supabase/supabase-js"],
    "Validation":      ["zod","joi","yup","class-validator","@sinclair/typebox"],
    "Logger":          ["pino","winston","bunyan","morgan"],
    "Job Queue":       ["bullmq","bull","bee-queue"],
    "GraphQL server":  ["@apollo/server","graphql-yoga","@nestjs/graphql","mercurius"],
  };

  const primeDepSet    = new Set(primeDeps.map(d => d.name));
  const existingDepSet = new Set(existingDeps.map(d => d.name));

  for (const [category, libs] of Object.entries(singletonGroups)) {
    const inPrime    = libs.filter(l => primeDepSet.has(l));
    const inExisting = libs.filter(l => existingDepSet.has(l));
    const inBoth     = inPrime.filter(l => inExisting.includes(l));

    // Different singletons on each side
    if (inPrime.length > 0 && inExisting.length > 0 && inBoth.length === 0) {
      const classification: Classification = ["HTTP Framework","ORM","Auth"].includes(category) ? "BLOCKED" : "REVIEW";
      conflicts.push({
        id: makeId(), category: "dep_singleton_conflict",
        classification,
        title: `${category} conflict: ${inPrime.join(",")} vs ${inExisting.join(",")}`,
        description: `Both sides use different ${category.toLowerCase()} libraries. Only one can be active in the merged application.`,
        primeSide:    { location: "package.json", value: inPrime.join(", ") },
        existingSide: { location: "package.json", value: inExisting.join(", ") },
        resolutionHint: `Standardize on one ${category.toLowerCase()} library. Migrate the other side's usage.`,
        autoResolvable: false, riskWeight: classification === "BLOCKED" ? 18 : 8,
      });
    }
  }

  // Major version conflicts
  for (const primeDep of primeDeps) {
    const existingDep = existingMap.get(primeDep.name);
    if (!existingDep) continue;
    const primeM    = parseSemverMajor(primeDep.version);
    const existingM = parseSemverMajor(existingDep.version);
    if (primeM !== null && existingM !== null && primeM !== existingM) {
      conflicts.push({
        id: makeId(), category: "dep_version_conflict", classification: "REVIEW",
        title: `Version conflict: ${primeDep.name} v${primeM} vs v${existingM}`,
        description: `Major version mismatch for ${primeDep.name}. Breaking API changes between v${existingM} and v${primeM} may cause runtime errors.`,
        primeSide:    { location: "package.json", value: primeDep.version },
        existingSide: { location: "package.json", value: existingDep.version },
        resolutionHint: `Align on one major version. Review the ${primeDep.name} changelog for breaking changes between v${existingM} and v${primeM}.`,
        autoResolvable: false, riskWeight: 10,
      });
    }
  }

  return conflicts;
}

function detectAssetConflicts(primeAssets: AssetEntry[], existingAssets: AssetEntry[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const existingNames = new Map<string, AssetEntry[]>();
  for (const a of existingAssets) {
    existingNames.set(a.name, [...(existingNames.get(a.name) ?? []), a]);
  }
  for (const prime of primeAssets) {
    const matches = existingNames.get(prime.name) ?? [];
    for (const existing of matches) {
      if (prime.size !== existing.size) {
        conflicts.push({
          id: makeId(), category: "asset_collision", classification: "REVIEW",
          title: `Asset filename collision: ${prime.name}`,
          description: `Both sides have a file named "${prime.name}" but with different sizes (${prime.size}B vs ${existing.size}B). One will overwrite the other on merge.`,
          primeSide:    { location: prime.rel,    value: `${prime.size} bytes` },
          existingSide: { location: existing.rel, value: `${existing.size} bytes` },
          resolutionHint: "Rename one of the files or consolidate into a shared assets directory.",
          autoResolvable: false, riskWeight: 5,
        });
      }
    }
  }
  return conflicts;
}

function detectApiContractConflicts(primeContracts: ApiContract[], existingContracts: ApiContract[]): Conflict[] {
  const conflicts: Conflict[] = [];

  const primeTypes    = new Set(primeContracts.map(c => c.type));
  const existingTypes = new Set(existingContracts.map(c => c.type));

  const primeHasGraphQL    = primeTypes.has("graphql");
  const existingHasGraphQL = existingTypes.has("graphql");
  const primeHasOpenApi    = primeTypes.has("openapi");
  const existingHasOpenApi = existingTypes.has("openapi");

  if (primeHasGraphQL && existingHasGraphQL) {
    const primeTypes_   = primeContracts.filter(c => c.type === "graphql").flatMap(c => c.endpoints ?? []);
    const existingTypes_ = existingContracts.filter(c => c.type === "graphql").flatMap(c => c.endpoints ?? []);
    const overlap = primeTypes_.filter(t => existingTypes_.includes(t));
    if (overlap.length > 0) {
      conflicts.push({
        id: makeId(), category: "api_contract_conflict", classification: "REVIEW",
        title: `GraphQL type collision: ${overlap.slice(0, 5).join(", ")}${overlap.length > 5 ? "…" : ""}`,
        description: `${overlap.length} GraphQL type(s) are defined on both sides. Schema stitching or federation may be needed.`,
        primeSide:    { location: primeContracts.find(c => c.type === "graphql")?.file ?? "schema.graphql", value: overlap.join(", ") },
        existingSide: { location: existingContracts.find(c => c.type === "graphql")?.file ?? "schema.graphql", value: overlap.join(", ") },
        resolutionHint: "Use Apollo Federation or schema stitching, or merge the schemas manually with renamed types.",
        autoResolvable: false, riskWeight: 12,
      });
    }
  }

  if (primeHasOpenApi && existingHasOpenApi) {
    const primeEps    = primeContracts.filter(c => c.type === "openapi").flatMap(c => c.endpoints ?? []);
    const existingEps = existingContracts.filter(c => c.type === "openapi").flatMap(c => c.endpoints ?? []);
    const overlap     = primeEps.filter(e => existingEps.includes(e));
    if (overlap.length > 0) {
      conflicts.push({
        id: makeId(), category: "api_contract_conflict", classification: "REVIEW",
        title: `OpenAPI path overlap: ${overlap.length} paths defined on both sides`,
        description: `${overlap.slice(0, 5).join(", ")}${overlap.length > 5 ? "…" : ""} — these paths appear in both OpenAPI specs.`,
        primeSide:    { location: primeContracts.find(c => c.type === "openapi")?.file ?? "openapi.json", value: overlap.join(", ") },
        existingSide: { location: existingContracts.find(c => c.type === "openapi")?.file ?? "openapi.json", value: overlap.join(", ") },
        resolutionHint: "Merge the OpenAPI specs with path deduplication and version the combined spec.",
        autoResolvable: false, riskWeight: 8,
      });
    }
  }

  return conflicts;
}

// ─── Merge step planner ───────────────────────────────────────────────────────

export interface MergeStep {
  step: number;
  area: string;
  classification: Classification;
  action: string;
  effort: "trivial" | "low" | "medium" | "high" | "critical";
  prerequisite: number | null; // step number that must complete first
  automated: boolean;
  detail: string;
}

function buildMergeSteps(conflicts: Conflict[], dimensions: MergeDimension[]): MergeStep[] {
  const steps: MergeStep[] = [];
  let n = 0;

  const dim = (name: string) => dimensions.find(d => d.name === name);

  const blocked = conflicts.filter(c => c.classification === "BLOCKED");
  const review  = conflicts.filter(c => c.classification === "REVIEW");

  if (blocked.length > 0) {
    steps.push({ step: ++n, area: "Pre-merge blockers", classification: "BLOCKED", action: `Resolve ${blocked.length} BLOCKED conflict(s) before proceeding`, effort: "critical", prerequisite: null, automated: false, detail: "No merge step can proceed safely until all BLOCKED items are resolved." });
  }

  const secretConflicts = blocked.filter(c => c.category === "env_conflict");
  if (secretConflicts.length > 0) {
    steps.push({ step: ++n, area: "Secrets & environment", classification: "BLOCKED", action: "Reconcile conflicting secrets / environment variables", effort: "medium", prerequisite: null, automated: false, detail: "Use a secrets manager (Doppler, AWS Secrets Manager, Vercel env dashboard) to hold the authoritative values." });
  }

  const schemaBlocked = blocked.filter(c => c.category === "schema_type_mismatch");
  if (schemaBlocked.length > 0) {
    steps.push({ step: ++n, area: "Database schema", classification: "BLOCKED", action: "Resolve schema type mismatches with SQL migrations", effort: "high", prerequisite: null, automated: false, detail: `${schemaBlocked.length} field(s) have incompatible types. Write and test migrations in a staging environment first.` });
  }

  const authBlocked = blocked.filter(c => c.category === "auth_incompatibility");
  if (authBlocked.length > 0) {
    steps.push({ step: ++n, area: "Authentication", classification: "BLOCKED", action: "Unify auth systems before merge", effort: "high", prerequisite: null, automated: false, detail: "Choose one canonical auth provider. Migrate protected routes, user sessions, and token validation." });
  }

  const routeBlocked = blocked.filter(c => c.category === "route_collision");
  if (routeBlocked.length > 0) {
    steps.push({ step: ++n, area: "Routing", classification: "BLOCKED", action: `Namespace or consolidate ${routeBlocked.length} colliding route(s)`, effort: "medium", prerequisite: null, automated: false, detail: "Consider prefixing Website Prime routes with /prime/ temporarily while merging, then reconcile." });
  }

  const depBlocked = blocked.filter(c => c.category === "dep_singleton_conflict");
  if (depBlocked.length > 0) {
    steps.push({ step: ++n, area: "Dependencies", classification: "BLOCKED", action: "Standardize singleton libraries", effort: "high", prerequisite: null, automated: false, detail: `${depBlocked.length} singleton library conflict(s) (e.g. framework, ORM, auth). Pick one per category and migrate all usages.` });
  }

  // REVIEW steps (order: env → deps → schema → routes → auth → assets → contracts)
  const prevBlockerStep = n > 0 ? 1 : null;

  if (dim("Environment variables")?.review ?? 0 > 0) {
    steps.push({ step: ++n, area: "Environment variables", classification: "REVIEW", action: "Audit and merge .env files", effort: "low", prerequisite: prevBlockerStep, automated: false, detail: "Compare .env.example from both sides. Add all vars from Website Prime to the existing backend's environment." });
  }

  if (dim("Dependencies")?.review ?? 0 > 0) {
    steps.push({ step: ++n, area: "Dependencies", classification: "REVIEW", action: "Merge package.json and resolve version ranges", effort: "low", prerequisite: prevBlockerStep, automated: true, detail: "Use `npm-merge-driver` or manually pick the higher compatible version for each package. Run `pnpm install` after." });
  }

  if (dim("Database schema")?.review ?? 0 > 0) {
    steps.push({ step: ++n, area: "Database schema", classification: "REVIEW", action: "Generate and review pending migrations", effort: "medium", prerequisite: prevBlockerStep, automated: true, detail: "Run `prisma migrate diff` or equivalent to produce migration SQL. Validate in a staging DB." });
  }

  if ((dim("Routing")?.safe ?? 0) > 0 || (dim("Routing")?.review ?? 0) > 0) {
    steps.push({ step: ++n, area: "Routing", classification: "REVIEW", action: "Integrate Website Prime routes into the existing router", effort: "medium", prerequisite: prevBlockerStep, automated: false, detail: "Mount Website Prime's router under its existing prefix. Audit middleware order to avoid shadow routing." });
  }

  if (dim("Authentication")?.review ?? 0 > 0) {
    steps.push({ step: ++n, area: "Authentication", classification: "REVIEW", action: "Validate auth middleware coverage on merged routes", effort: "low", prerequisite: prevBlockerStep, automated: false, detail: "Ensure all new routes from Website Prime are protected by the correct auth guards." });
  }

  if (dim("Assets")?.review ?? 0 > 0) {
    steps.push({ step: ++n, area: "Assets", classification: "REVIEW", action: "Merge static asset directories", effort: "low", prerequisite: null, automated: true, detail: "Copy Website Prime assets to the existing public/ directory. Rename colliding filenames." });
  }

  if ((dim("API contracts")?.blocked ?? 0) > 0 || (dim("API contracts")?.review ?? 0) > 0) {
    steps.push({ step: ++n, area: "API contracts", classification: "REVIEW", action: "Consolidate OpenAPI / GraphQL schemas", effort: "medium", prerequisite: prevBlockerStep, automated: false, detail: "Merge schemas and regenerate client code. Update all consumers." });
  }

  // SAFE final steps
  steps.push({ step: ++n, area: "Smoke tests", classification: "SAFE", action: "Run full integration test suite on merged codebase", effort: "low", prerequisite: n - 1, automated: true, detail: "Execute existing test suite against the merged application. Add tests for newly merged routes." });
  steps.push({ step: ++n, area: "Deployment", classification: "SAFE", action: "Deploy to staging and run production smoke tests", effort: "low", prerequisite: n - 1, automated: true, detail: "Use a blue/green or canary deployment. Validate all BLOCKED items are confirmed resolved." });

  return steps;
}

// ─── Risk scoring ─────────────────────────────────────────────────────────────

function computeMergeRiskScore(conflicts: Conflict[]): number {
  const totalWeight = conflicts.reduce((acc, c) => acc + c.riskWeight, 0);
  return Math.min(100, Math.round(totalWeight * 1.2));
}

function riskLabel(score: number): string {
  if (score >= 80) return "CRITICAL";
  if (score >= 60) return "HIGH";
  if (score >= 35) return "MEDIUM";
  if (score >= 15) return "LOW";
  return "MINIMAL";
}

// ─── Report shapes ────────────────────────────────────────────────────────────

export interface SemanticMergePlan {
  detectionId: string;
  generatedAt: string;
  primePath: string;
  existingPath: string;
  overallClassification: Classification;
  mergeRiskScore: number;
  mergeRiskLabel: string;
  totalConflicts: number;
  blocked: number;
  review: number;
  safe: number;
  dimensions: MergeDimension[];
  mergeSteps: MergeStep[];
  estimatedResolutionHours: number;
  isMergeSafe: boolean;
  executiveSummary: string;
}

export interface ConflictMap {
  detectionId: string;
  generatedAt: string;
  totalConflicts: number;
  blocked: Conflict[];
  review:  Conflict[];
  safe:    Conflict[];
  byCategory: Record<string, Conflict[]>;
}

export interface MergeRiskReport {
  detectionId: string;
  generatedAt: string;
  mergeRiskScore: number;
  mergeRiskLabel: string;
  overallClassification: Classification;
  isMergeSafe: boolean;
  blockedCount: number;
  reviewCount: number;
  estimatedResolutionHours: number;
  criticalBlockers: Array<{ id: string; title: string; riskWeight: number }>;
  dimensionScores: Array<{ dimension: string; riskScore: number; blocked: number; review: number }>;
  topRecommendations: string[];
  mergeReadinessChecklist: Array<{ check: string; status: "pass" | "warn" | "fail" }>;
}

export interface D2Bundle {
  detectionId: string;
  generatedAt: string;
  semanticMergePlan: SemanticMergePlan;
  conflictMap: ConflictMap;
  mergeRiskReport: MergeRiskReport;
  r2Keys: { semanticMergePlan: string; conflictMap: string; mergeRiskReport: string };
}

// ─── In-memory store ──────────────────────────────────────────────────────────

const _store = new Map<string, D2Bundle>();
export function getD2Bundle(id: string): D2Bundle | undefined { return _store.get(id); }
export function listD2Bundles(): Array<{ detectionId: string; generatedAt: string; mergeRiskScore: number; overallClassification: Classification }> {
  return [..._store.values()].map(b => ({
    detectionId:            b.detectionId,
    generatedAt:            b.generatedAt,
    mergeRiskScore:         b.semanticMergePlan.mergeRiskScore,
    overallClassification:  b.semanticMergePlan.overallClassification,
  }));
}

// ─── Main export ──────────────────────────────────────────────────────────────

export interface D2Options {
  detectionId: string;
  primePath: string;
  existingPath: string;
}

export async function runSemanticMergePlanner(options: D2Options): Promise<D2Bundle> {
  const { detectionId, primePath, existingPath } = options;
  const now = new Date().toISOString();

  logger.info({ detectionId, primePath, existingPath }, "D2: starting semantic merge analysis");

  for (const [label, p] of [["primePath", primePath], ["existingPath", existingPath]] as const) {
    if (!fs.existsSync(p)) throw new Error(`D2: ${label} does not exist: ${p}`);
    if (!fs.statSync(p).isDirectory()) throw new Error(`D2: ${label} is not a directory: ${p}`);
  }

  // Scan both directories
  logger.info({ detectionId }, "D2: scanning directories");
  const [primeFiles, existingFiles] = await Promise.all([
    Promise.resolve(scanDir(primePath)),
    Promise.resolve(scanDir(existingPath)),
  ]);
  logger.info({ detectionId, primeFiles: primeFiles.length, existingFiles: existingFiles.length }, "D2: scan complete");

  // Reset conflict counter for this run
  _conflictSeq = 0;

  // ── Extract all artifacts in parallel ────────────────────────────────────
  const [
    primeRoutes, existingRoutes,
    primeModels, existingModels,
    primeDeps,   existingDeps,
    primeEnv,    existingEnv,
    primeAuth,   existingAuth,
    primeAssets, existingAssets,
    primeContracts, existingContracts,
    primeEnvRefs,
  ] = await Promise.all([
    Promise.resolve(extractAllRoutes(primeFiles)),
    Promise.resolve(extractAllRoutes(existingFiles)),
    Promise.resolve(extractAllModels(primeFiles)),
    Promise.resolve(extractAllModels(existingFiles)),
    Promise.resolve(extractNpmDeps(primeFiles)),
    Promise.resolve(extractNpmDeps(existingFiles)),
    Promise.resolve(extractEnvVars(primeFiles)),
    Promise.resolve(extractEnvVars(existingFiles)),
    Promise.resolve(extractAuthProfile(primeFiles, extractNpmDeps(primeFiles))),
    Promise.resolve(extractAuthProfile(existingFiles, extractNpmDeps(existingFiles))),
    Promise.resolve(extractAssets(primeFiles)),
    Promise.resolve(extractAssets(existingFiles)),
    Promise.resolve(extractApiContracts(primeFiles)),
    Promise.resolve(extractApiContracts(existingFiles)),
    Promise.resolve(extractEnvReferences(primeFiles)),
  ]);

  // ── Detect conflicts ──────────────────────────────────────────────────────
  logger.info({ detectionId }, "D2: detecting conflicts");
  const routeConflicts    = detectRouteConflicts(primeRoutes, existingRoutes);
  const schemaConflicts   = detectSchemaConflicts(primeModels, existingModels);
  const authConflicts     = detectAuthConflicts(primeAuth, existingAuth);
  const envConflicts      = detectEnvConflicts(primeEnv, existingEnv, primeEnvRefs, extractEnvReferences(existingFiles));
  const depConflicts      = detectDepConflicts(primeDeps, existingDeps);
  const assetConflicts    = detectAssetConflicts(primeAssets, existingAssets);
  const contractConflicts = detectApiContractConflicts(primeContracts, existingContracts);

  const configConflicts: Conflict[] = [];
  const primeConfigs    = extractConfigs(primeFiles);
  const existingConfigs = extractConfigs(existingFiles);
  for (const pc of primeConfigs) {
    const ec = existingConfigs.find(c => c.name === pc.name);
    if (ec) {
      const sharedKeys = pc.keys.filter(k => ec.keys.includes(k));
      if (sharedKeys.length > 0) {
        configConflicts.push({
          id: makeId(), category: "config_conflict", classification: "REVIEW",
          title: `Config overlap: ${pc.name}`,
          description: `Both sides have ${pc.name} with overlapping keys: ${sharedKeys.slice(0, 6).join(", ")}`,
          primeSide:    { location: pc.file, value: sharedKeys.join(", ") },
          existingSide: { location: ec.file, value: sharedKeys.join(", ") },
          resolutionHint: "Merge config files manually and verify all shared keys have compatible values.",
          autoResolvable: false, riskWeight: 4,
        });
      }
    }
  }

  const allConflicts = [
    ...routeConflicts, ...schemaConflicts, ...authConflicts, ...envConflicts,
    ...depConflicts, ...assetConflicts, ...contractConflicts, ...configConflicts,
  ];

  const blocked = allConflicts.filter(c => c.classification === "BLOCKED");
  const review  = allConflicts.filter(c => c.classification === "REVIEW");
  const safe    = allConflicts.filter(c => c.classification === "SAFE");

  // ── Build dimensions ──────────────────────────────────────────────────────
  function buildDim(name: string, primeItems: number, existingItems: number, conflicts: Conflict[]): MergeDimension {
    const bl = conflicts.filter(c => c.classification === "BLOCKED").length;
    const rv = conflicts.filter(c => c.classification === "REVIEW").length;
    const sf = conflicts.filter(c => c.classification === "SAFE").length;
    const cls: Classification = bl > 0 ? "BLOCKED" : rv > 0 ? "REVIEW" : "SAFE";
    const notes: string[] = [];
    if (primeItems === 0 && existingItems === 0) notes.push("Not detected on either side");
    if (primeItems > 0 && existingItems === 0) notes.push("Only present in Website Prime");
    if (primeItems === 0 && existingItems > 0) notes.push("Only present in existing backend");
    return { name, classification: cls, primeItems, existingItems, conflicts: conflicts.length, safe: sf, review: rv, blocked: bl, notes };
  }

  const dimensions: MergeDimension[] = [
    buildDim("Routing",              primeRoutes.length,    existingRoutes.length,    routeConflicts),
    buildDim("Database schema",      primeModels.length,    existingModels.length,    schemaConflicts),
    buildDim("Authentication",       primeAuth.system !== "None" ? 1 : 0, existingAuth.system !== "None" ? 1 : 0, authConflicts),
    buildDim("Environment variables",primeEnv.length,       existingEnv.length,       envConflicts),
    buildDim("Dependencies",         primeDeps.length,      existingDeps.length,      depConflicts),
    buildDim("Assets",               primeAssets.length,    existingAssets.length,    assetConflicts),
    buildDim("API contracts",        primeContracts.length, existingContracts.length, contractConflicts),
    buildDim("Configuration",        primeConfigs.length,   existingConfigs.length,   configConflicts),
  ];

  // ── Merge steps ───────────────────────────────────────────────────────────
  const mergeSteps = buildMergeSteps(allConflicts, dimensions);

  // ── Overall classification ────────────────────────────────────────────────
  const overallClassification: Classification = blocked.length > 0 ? "BLOCKED" : review.length > 0 ? "REVIEW" : "SAFE";
  const mergeRiskScore = computeMergeRiskScore(allConflicts);
  const isMergeSafe    = blocked.length === 0;

  // Estimated resolution effort
  const blockedHours = blocked.reduce((h, c) => h + (c.riskWeight >= 18 ? 8 : c.riskWeight >= 12 ? 4 : 2), 0);
  const reviewHours  = review.reduce((h, c) => h + 0.5, 0);
  const estimatedResolutionHours = Math.round(blockedHours + reviewHours);

  const executiveSummary = [
    `Semantic merge analysis of Website Prime (${primeRoutes.length} routes, ${primeModels.length} models)`,
    `against the existing backend (${existingRoutes.length} routes, ${existingModels.length} models).`,
    `Found ${allConflicts.length} total conflict(s): ${blocked.length} BLOCKED, ${review.length} REVIEW, ${safe.length} SAFE.`,
    `Overall risk: ${riskLabel(mergeRiskScore)} (${mergeRiskScore}/100).`,
    isMergeSafe
      ? "No blocking conflicts — merge can proceed with review items addressed."
      : `${blocked.length} blocking conflict(s) must be resolved before merge can proceed.`,
  ].join(" ");

  // ── Build reports ─────────────────────────────────────────────────────────
  const semanticMergePlan: SemanticMergePlan = {
    detectionId, generatedAt: now, primePath, existingPath,
    overallClassification, mergeRiskScore, mergeRiskLabel: riskLabel(mergeRiskScore),
    totalConflicts: allConflicts.length, blocked: blocked.length, review: review.length, safe: safe.length,
    dimensions, mergeSteps, estimatedResolutionHours, isMergeSafe, executiveSummary,
  };

  // Group by category
  const byCategory: Record<string, Conflict[]> = {};
  for (const c of allConflicts) {
    byCategory[c.category] = [...(byCategory[c.category] ?? []), c];
  }

  const conflictMap: ConflictMap = {
    detectionId, generatedAt: now,
    totalConflicts: allConflicts.length,
    blocked, review, safe, byCategory,
  };

  // Dimension risk scores
  const dimensionScores = dimensions.map(d => ({
    dimension:  d.name,
    riskScore:  allConflicts.filter(c => {
      const dimConflicts = (
        d.name === "Routing"              ? routeConflicts :
        d.name === "Database schema"      ? schemaConflicts :
        d.name === "Authentication"       ? authConflicts :
        d.name === "Environment variables"? envConflicts :
        d.name === "Dependencies"         ? depConflicts :
        d.name === "Assets"               ? assetConflicts :
        d.name === "API contracts"        ? contractConflicts :
        configConflicts
      );
      return dimConflicts.includes(c);
    }).reduce((s, c) => s + c.riskWeight, 0),
    blocked: d.blocked,
    review:  d.review,
  }));

  const topRecommendations: string[] = [];
  if (blocked.length > 0) topRecommendations.push(`Resolve ${blocked.length} BLOCKED conflict(s) first — these are merge stoppers.`);
  if (authConflicts.some(c => c.classification === "BLOCKED")) topRecommendations.push("Unify the authentication system before any code merge.");
  if (schemaConflicts.some(c => c.classification === "BLOCKED")) topRecommendations.push("Fix schema type mismatches in a staging database before touching production.");
  if (routeConflicts.some(c => c.classification === "BLOCKED")) topRecommendations.push("Namespace Website Prime routes to avoid collisions during the integration phase.");
  if (envConflicts.some(c => c.category === "env_missing")) topRecommendations.push("Audit all environment variable references — missing vars will cause silent runtime failures.");
  if (depConflicts.some(c => c.category === "dep_version_conflict")) topRecommendations.push("Lock all shared dependencies to the same major version after picking the higher compatible one.");
  if (topRecommendations.length === 0) topRecommendations.push("No critical recommendations — proceed with REVIEW items and run the full test suite after merge.");

  const checklist: MergeRiskReport["mergeReadinessChecklist"] = [
    { check: "No BLOCKED route collisions",       status: routeConflicts.some(c => c.classification === "BLOCKED")  ? "fail" : "pass" },
    { check: "No schema type mismatches",          status: schemaConflicts.some(c => c.category === "schema_type_mismatch") ? "fail" : "pass" },
    { check: "Auth system compatible",             status: authConflicts.some(c => c.classification === "BLOCKED")   ? "fail" : authConflicts.length > 0 ? "warn" : "pass" },
    { check: "No conflicting secrets",             status: envConflicts.some(c => c.classification === "BLOCKED")    ? "fail" : "pass" },
    { check: "No singleton library conflicts",     status: depConflicts.some(c => c.category === "dep_singleton_conflict" && c.classification === "BLOCKED") ? "fail" : depConflicts.some(c => c.category === "dep_singleton_conflict") ? "warn" : "pass" },
    { check: "No major dependency version conflicts", status: depConflicts.some(c => c.category === "dep_version_conflict") ? "warn" : "pass" },
    { check: "No asset collisions",                status: assetConflicts.length > 0 ? "warn" : "pass" },
    { check: "API contracts compatible",           status: contractConflicts.some(c => c.classification === "BLOCKED") ? "fail" : contractConflicts.length > 0 ? "warn" : "pass" },
    { check: "All env vars declared",              status: envConflicts.some(c => c.category === "env_missing") ? "warn" : "pass" },
    { check: "Merge risk score ≤ 40",             status: mergeRiskScore <= 40 ? "pass" : mergeRiskScore <= 70 ? "warn" : "fail" },
  ];

  const mergeRiskReport: MergeRiskReport = {
    detectionId, generatedAt: now,
    mergeRiskScore, mergeRiskLabel: riskLabel(mergeRiskScore),
    overallClassification, isMergeSafe,
    blockedCount: blocked.length, reviewCount: review.length,
    estimatedResolutionHours,
    criticalBlockers: blocked.slice(0, 10).map(c => ({ id: c.id, title: c.title, riskWeight: c.riskWeight })),
    dimensionScores,
    topRecommendations,
    mergeReadinessChecklist: checklist,
  };

  // ── Store to R2 ───────────────────────────────────────────────────────────
  logger.info({ detectionId }, "D2: storing reports to R2");
  const [r2Plan, r2Map, r2Risk] = await Promise.all([
    storeR2(detectionId, "semantic-merge-plan.json",  semanticMergePlan),
    storeR2(detectionId, "conflict-map.json",          conflictMap),
    storeR2(detectionId, "merge-risk-report.json",     mergeRiskReport),
  ]);

  const bundle: D2Bundle = {
    detectionId, generatedAt: now,
    semanticMergePlan, conflictMap, mergeRiskReport,
    r2Keys: { semanticMergePlan: r2Plan!, conflictMap: r2Map!, mergeRiskReport: r2Risk! },
  };
  _store.set(detectionId, bundle);

  logger.info({ detectionId, riskScore: mergeRiskScore, blocked: blocked.length, review: review.length }, "D2: semantic merge planner complete");
  return bundle;
}
