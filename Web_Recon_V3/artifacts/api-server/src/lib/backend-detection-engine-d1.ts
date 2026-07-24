/**
 * backend-detection-engine-d1.ts — Phase D1: Backend Detection Engine
 *
 * Static file analysis engine that identifies the backend architecture of
 * an imported project directory.
 *
 * Detection strategy (layered):
 *   1. Manifest files   — package.json, requirements.txt, Gemfile, composer.json,
 *                         pom.xml, build.gradle, go.mod, Cargo.toml, pyproject.toml
 *   2. Config files     — next.config.*, nest-cli.json, artisan, manage.py,
 *                         Dockerfile, docker-compose.yml, .env*
 *   3. File patterns    — *.module.ts, *.controller.ts, *.blade.php, etc.
 *   4. Directory layout — pages/, app/, src/, config/, db/migrate/, alembic/
 *   5. Content probes   — grep key identifiers inside source files
 *
 * Produces (stored in R2 + in-memory):
 *   backend-profile.json
 *   framework-detection-report.json
 *   technology-stack.json
 *   dependency-map.json
 */

import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger.js";
import { createCloudProvider } from "../cloud/index.js";

// ─── R2 helpers ───────────────────────────────────────────────────────────────

function makeR2Key(detectionId: string, filename: string): string {
  return `d1/${detectionId}/${filename}`;
}

async function storeJsonToR2(detectionId: string, filename: string, data: unknown): Promise<string> {
  const key = makeR2Key(detectionId, filename);
  const provider = createCloudProvider("r2");
  if (!provider.isConfigured()) {
    logger.warn({ detectionId, filename }, "D1: R2 not configured — skipping upload");
    return key;
  }
  const buf = Buffer.from(JSON.stringify(data, null, 2), "utf-8");
  await provider.upload({ key, data: buf, contentType: "application/json", checkDuplicate: false });
  logger.info({ detectionId, key }, "D1: artifact stored to R2");
  return key;
}

// ─── File scanning ────────────────────────────────────────────────────────────

const SCAN_IGNORE = new Set([
  "node_modules", ".git", ".svn", "dist", "build", ".next", "__pycache__",
  ".venv", "venv", "env", ".env", "vendor", "target", ".gradle", ".idea",
  ".vscode", "coverage", ".nyc_output", "tmp", "temp", "logs", ".cache",
  "public/assets", "storage", ".terraform", ".serverless",
]);

const MAX_DEPTH   = 6;
const MAX_FILES   = 2000;
const MAX_FILE_KB = 256; // only read files up to 256KB for content probing

interface ScannedFile {
  relativePath: string;
  absolutePath: string;
  name: string;
  ext: string;
  sizeBytes: number;
}

function scanDirectory(rootPath: string): ScannedFile[] {
  const files: ScannedFile[] = [];

  function recurse(dir: string, depth: number): void {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (SCAN_IGNORE.has(entry.name)) continue;

      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        recurse(absPath, depth + 1);
      } else if (entry.isFile()) {
        let sizeBytes = 0;
        try { sizeBytes = fs.statSync(absPath).size; } catch { /* ignore */ }
        const ext = path.extname(entry.name).toLowerCase();
        files.push({
          relativePath: path.relative(rootPath, absPath),
          absolutePath: absPath,
          name: entry.name,
          ext,
          sizeBytes,
        });
      }
    }
  }

  recurse(rootPath, 0);
  return files;
}

function readFileSafe(absPath: string, maxBytes = MAX_FILE_KB * 1024): string {
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > maxBytes) return "";
    return fs.readFileSync(absPath, "utf-8");
  } catch {
    return "";
  }
}

function parseJsonSafe(content: string): Record<string, unknown> | null {
  try { return JSON.parse(content) as Record<string, unknown>; } catch { return null; }
}

// ─── Detection types ──────────────────────────────────────────────────────────

type Confidence = "definitive" | "high" | "medium" | "low";

export type SupportedFramework =
  | "Next.js" | "NestJS" | "Express" | "Fastify" | "Koa" | "Hapi"
  | "Laravel" | "WordPress" | "Symfony" | "CodeIgniter"
  | "Django" | "Flask" | "FastAPI" | "Starlette" | "Tornado"
  | "Ruby on Rails" | "Sinatra" | "Hanami"
  | "ASP.NET Core" | "ASP.NET MVC"
  | "Spring Boot" | "Micronaut" | "Quarkus"
  | "Go (Gin)" | "Go (Echo)" | "Go (Fiber)" | "Go (net/http)"
  | "Rust (Actix)" | "Rust (Axum)"
  | "Phoenix (Elixir)"
  | "Unknown";

export type Language = "TypeScript" | "JavaScript" | "Python" | "PHP" | "Ruby" | "Java" | "C#" | "Go" | "Rust" | "Kotlin" | "Elixir" | "Unknown";
export type Database = "PostgreSQL" | "MySQL" | "MariaDB" | "MongoDB" | "SQLite" | "Redis" | "DynamoDB" | "Cassandra" | "CockroachDB" | "Supabase" | "PlanetScale" | "Neon" | "Unknown";
export type ORM = "Prisma" | "Drizzle" | "TypeORM" | "Sequelize" | "MikroORM" | "Mongoose" | "SQLAlchemy" | "Tortoise ORM" | "ActiveRecord" | "Eloquent" | "Hibernate" | "GORM" | "Diesel" | "Ecto" | "None detected";
export type AuthSystem = "NextAuth.js" | "Clerk" | "Auth0" | "Supabase Auth" | "Firebase Auth" | "Passport.js" | "JWT (custom)" | "Laravel Sanctum" | "Laravel Passport" | "Devise (Rails)" | "Django Auth" | "Spring Security" | "ASP.NET Identity" | "None detected";
export type ApiStyle = "REST" | "GraphQL" | "tRPC" | "gRPC" | "WebSocket" | "REST + GraphQL" | "REST + tRPC" | "Unknown";
export type StorageProvider = "AWS S3" | "Cloudflare R2" | "Google Cloud Storage" | "Azure Blob" | "Supabase Storage" | "Uploadthing" | "Cloudinary" | "Local filesystem" | "None detected";
export type CacheSystem = "Redis" | "Memcached" | "In-memory (node-cache)" | "Upstash" | "Vercel KV" | "None detected";
export type QueueSystem = "BullMQ" | "Bull" | "Celery" | "Sidekiq" | "Resque" | "RabbitMQ" | "AWS SQS" | "Kafka" | "None detected";
export type CmsSystem = "WordPress" | "Strapi" | "Contentful" | "Sanity" | "Directus" | "Payload CMS" | "Ghost" | "Prismic" | "None detected";
export type DeploymentTarget = "Vercel" | "Netlify" | "Railway" | "Fly.io" | "Heroku" | "AWS" | "GCP" | "Azure" | "Docker" | "Bare Node" | "Unknown";
export type RoutingStyle = "File-based" | "Code-based" | "Hybrid" | "Unknown";

export interface DetectedTech<T extends string> {
  value: T;
  confidence: Confidence;
  signals: string[];
}

// ─── Detection matrix ─────────────────────────────────────────────────────────

interface DepsBundle {
  all: Record<string, string>;   // all deps + devDeps
  prod: Record<string, string>;
  dev: Record<string, string>;
  scripts: Record<string, string>;
  packageName: string | null;
  engines: Record<string, string>;
}

function extractNpmDeps(files: ScannedFile[], rootPath: string): DepsBundle {
  // Find root package.json (not nested)
  const pkg = files.find(f => f.name === "package.json" && f.relativePath.split(path.sep).length === 1);
  if (!pkg) return { all: {}, prod: {}, dev: {}, scripts: {}, packageName: null, engines: {} };
  const json = parseJsonSafe(readFileSafe(pkg.absolutePath)) ?? {};
  const prod    = (json["dependencies"] as Record<string, string> | undefined) ?? {};
  const dev     = (json["devDependencies"] as Record<string, string> | undefined) ?? {};
  const scripts = (json["scripts"] as Record<string, string> | undefined) ?? {};
  const engines = (json["engines"] as Record<string, string> | undefined) ?? {};
  const packageName = (json["name"] as string | undefined) ?? null;
  return { all: { ...prod, ...dev }, prod, dev, scripts, packageName, engines };
}

function extractPythonDeps(files: ScannedFile[]): string[] {
  const deps: string[] = [];
  const reqFiles = files.filter(f => f.name.startsWith("requirements") && f.ext === ".txt");
  for (const f of reqFiles) {
    const content = readFileSafe(f.absolutePath);
    for (const line of content.split("\n")) {
      const dep = line.trim().split(/[>=<!\[;]/)[0]?.trim().toLowerCase();
      if (dep && !dep.startsWith("#")) deps.push(dep);
    }
  }
  // Also check pyproject.toml
  const pyproj = files.find(f => f.name === "pyproject.toml");
  if (pyproj) {
    const content = readFileSafe(pyproj.absolutePath);
    const matches = content.match(/["']([a-z][a-z0-9_-]+)/gi) ?? [];
    for (const m of matches) deps.push(m.replace(/["']/g, "").toLowerCase());
  }
  return [...new Set(deps)];
}

function extractRubyDeps(files: ScannedFile[]): string[] {
  const gemfile = files.find(f => f.name === "Gemfile");
  if (!gemfile) return [];
  const content = readFileSafe(gemfile.absolutePath);
  const matches = content.match(/gem ['"]([^'"]+)['"]/g) ?? [];
  return matches.map(m => m.replace(/gem ['"]/, "").replace(/['"].*/, "").trim().toLowerCase());
}

function extractPhpDeps(files: ScannedFile[]): Record<string, string> {
  const composerFile = files.find(f => f.name === "composer.json" && f.relativePath.split(path.sep).length === 1);
  if (!composerFile) return {};
  const json = parseJsonSafe(readFileSafe(composerFile.absolutePath)) ?? {};
  const req    = (json["require"] as Record<string, string> | undefined) ?? {};
  const reqDev = (json["require-dev"] as Record<string, string> | undefined) ?? {};
  return { ...req, ...reqDev };
}

function extractJavaDeps(files: ScannedFile[]): string[] {
  const deps: string[] = [];
  const pomFile = files.find(f => f.name === "pom.xml");
  if (pomFile) {
    const content = readFileSafe(pomFile.absolutePath);
    const matches = content.match(/<artifactId>([^<]+)<\/artifactId>/g) ?? [];
    for (const m of matches) deps.push(m.replace(/<\/?artifactId>/g, "").trim().toLowerCase());
  }
  const gradleFiles = files.filter(f => f.name === "build.gradle" || f.name === "build.gradle.kts");
  for (const gf of gradleFiles) {
    const content = readFileSafe(gf.absolutePath);
    const matches = content.match(/['"]([^:'"]+:[^:'"]+:[^'"]+)['"]/g) ?? [];
    for (const m of matches) deps.push(m.replace(/['"]/g, "").split(":")[1] ?? "");
  }
  return [...new Set(deps.filter(Boolean))];
}

function extractGoDeps(files: ScannedFile[]): string[] {
  const goMod = files.find(f => f.name === "go.mod");
  if (!goMod) return [];
  const content = readFileSafe(goMod.absolutePath);
  const matches = content.match(/^\s+([^\s]+)\s+v/gm) ?? [];
  return matches.map(m => m.trim().split(/\s+/)[0] ?? "").filter(Boolean);
}

function extractRustDeps(files: ScannedFile[]): string[] {
  const cargoToml = files.find(f => f.name === "Cargo.toml" && f.relativePath.split(path.sep).length === 1);
  if (!cargoToml) return [];
  const content = readFileSafe(cargoToml.absolutePath);
  const matches = content.match(/^([a-z][a-z0-9_-]+)\s*=/gm) ?? [];
  return matches.map(m => m.replace(/\s*=$/, "").trim().toLowerCase());
}

function hasDep(deps: Record<string, string> | string[], name: string | RegExp): boolean {
  if (Array.isArray(deps)) {
    return deps.some(d => (typeof name === "string" ? d === name || d.startsWith(name) : name.test(d)));
  }
  return Object.keys(deps).some(k => typeof name === "string" ? k === name || k.startsWith(name) : name.test(k));
}

function hasFile(files: ScannedFile[], name: string): boolean {
  return files.some(f => f.name === name);
}

function hasFilePattern(files: ScannedFile[], pattern: RegExp): boolean {
  return files.some(f => pattern.test(f.relativePath));
}

function hasDir(files: ScannedFile[], dir: string): boolean {
  return files.some(f => f.relativePath.split(path.sep)[0] === dir || f.relativePath.includes(`${path.sep}${dir}${path.sep}`));
}

function hasContentIn(files: ScannedFile[], pattern: RegExp, exts: string[]): boolean {
  const candidates = files.filter(f => exts.includes(f.ext) && f.sizeBytes < MAX_FILE_KB * 1024).slice(0, 100);
  return candidates.some(f => pattern.test(readFileSafe(f.absolutePath)));
}

// ─── Framework detection ──────────────────────────────────────────────────────

function detectFramework(
  files: ScannedFile[],
  npm: DepsBundle,
  pyDeps: string[],
  rubyDeps: string[],
  phpDeps: Record<string, string>,
  javaDeps: string[],
  goDeps: string[],
  rustDeps: string[],
): DetectedTech<SupportedFramework> {
  // ── Node.js / TypeScript frameworks ──────────────────────────────────────

  if (hasDep(npm.all, "next")) {
    const signals = ["next in dependencies"];
    const conf: Confidence = hasFile(files, "next.config.js") || hasFile(files, "next.config.ts") || hasFile(files, "next.config.mjs")
      ? "definitive" : "high";
    if (hasDir(files, "pages") || hasDir(files, "app")) signals.push("pages/ or app/ directory detected");
    if (hasFile(files, "next.config.js") || hasFile(files, "next.config.ts")) signals.push("next.config.* present");
    return { value: "Next.js", confidence: conf, signals };
  }

  if (hasDep(npm.all, "@nestjs/core") || hasDep(npm.all, "@nestjs/common")) {
    const signals = ["@nestjs/core in dependencies"];
    if (hasFile(files, "nest-cli.json")) signals.push("nest-cli.json present");
    if (hasFilePattern(files, /\.module\.ts$/)) signals.push("*.module.ts files found");
    if (hasFilePattern(files, /\.controller\.ts$/)) signals.push("*.controller.ts files found");
    return { value: "NestJS", confidence: "definitive", signals };
  }

  if (hasDep(npm.all, "fastify")) {
    return { value: "Fastify", confidence: "high", signals: ["fastify in dependencies"] };
  }

  if (hasDep(npm.all, "koa")) {
    return { value: "Koa", confidence: "high", signals: ["koa in dependencies"] };
  }

  if (hasDep(npm.all, "@hapi/hapi") || hasDep(npm.all, "hapi")) {
    return { value: "Hapi", confidence: "high", signals: ["@hapi/hapi in dependencies"] };
  }

  if (hasDep(npm.all, "express")) {
    const signals = ["express in dependencies"];
    if (hasFilePattern(files, /routes?\//)) signals.push("routes/ directory found");
    if (hasFilePattern(files, /controllers?\//)) signals.push("controllers/ directory found");
    return { value: "Express", confidence: "high", signals };
  }

  // ── PHP frameworks ────────────────────────────────────────────────────────

  if (phpDeps["laravel/framework"] || hasFile(files, "artisan")) {
    const signals = ["laravel/framework in composer.json"];
    if (hasFile(files, "artisan")) signals.push("artisan file found");
    if (hasDir(files, "app") && hasDir(files, "routes")) signals.push("app/ and routes/ structure");
    return { value: "Laravel", confidence: "definitive", signals };
  }

  if (hasFile(files, "wp-config.php") || hasDir(files, "wp-content")) {
    const signals: string[] = [];
    if (hasFile(files, "wp-config.php")) signals.push("wp-config.php found");
    if (hasDir(files, "wp-content")) signals.push("wp-content/ directory found");
    if (hasFile(files, "wp-login.php")) signals.push("wp-login.php found");
    return { value: "WordPress", confidence: "definitive", signals };
  }

  if (phpDeps["symfony/framework-bundle"] || hasFilePattern(files, /symfony/)) {
    return { value: "Symfony", confidence: "high", signals: ["symfony/framework-bundle in composer.json"] };
  }

  if (phpDeps["codeigniter4/framework"] || phpDeps["codeigniter/framework"]) {
    return { value: "CodeIgniter", confidence: "high", signals: ["codeigniter in composer.json"] };
  }

  // ── Python frameworks ─────────────────────────────────────────────────────

  if (pyDeps.includes("fastapi")) {
    const signals = ["fastapi in requirements"];
    if (pyDeps.includes("uvicorn")) signals.push("uvicorn in requirements");
    return { value: "FastAPI", confidence: "high", signals };
  }

  if (pyDeps.includes("django") || hasFile(files, "manage.py")) {
    const signals: string[] = [];
    if (pyDeps.includes("django")) signals.push("django in requirements");
    if (hasFile(files, "manage.py")) signals.push("manage.py found");
    if (hasFilePattern(files, /settings\.py$/)) signals.push("settings.py found");
    return { value: "Django", confidence: "definitive", signals };
  }

  if (pyDeps.includes("flask")) {
    const signals = ["flask in requirements"];
    if (hasFile(files, "app.py") || hasFile(files, "wsgi.py")) signals.push("app.py / wsgi.py found");
    return { value: "Flask", confidence: "high", signals };
  }

  if (pyDeps.includes("starlette")) {
    return { value: "Starlette", confidence: "medium", signals: ["starlette in requirements"] };
  }

  if (pyDeps.includes("tornado")) {
    return { value: "Tornado", confidence: "high", signals: ["tornado in requirements"] };
  }

  // ── Ruby frameworks ───────────────────────────────────────────────────────

  if (rubyDeps.includes("rails") || hasFile(files, "config/routes.rb") || hasDir(files, "app/controllers")) {
    const signals: string[] = [];
    if (rubyDeps.includes("rails")) signals.push("rails in Gemfile");
    if (hasFile(files, "Rakefile")) signals.push("Rakefile found");
    if (hasFilePattern(files, /config\/routes\.rb/)) signals.push("config/routes.rb found");
    return { value: "Ruby on Rails", confidence: "definitive", signals };
  }

  if (rubyDeps.includes("sinatra")) {
    return { value: "Sinatra", confidence: "high", signals: ["sinatra in Gemfile"] };
  }

  // ── Java / Kotlin frameworks ──────────────────────────────────────────────

  if (javaDeps.some(d => d.includes("spring-boot"))) {
    const signals = ["spring-boot in pom.xml / build.gradle"];
    if (hasContentIn(files, /@SpringBootApplication/, [".java", ".kt"])) signals.push("@SpringBootApplication annotation found");
    return { value: "Spring Boot", confidence: "definitive", signals };
  }

  if (javaDeps.some(d => d.includes("micronaut"))) {
    return { value: "Micronaut", confidence: "high", signals: ["micronaut in build file"] };
  }

  if (javaDeps.some(d => d.includes("quarkus"))) {
    return { value: "Quarkus", confidence: "high", signals: ["quarkus in build file"] };
  }

  // ── C# / ASP.NET ──────────────────────────────────────────────────────────

  if (hasFilePattern(files, /\.csproj$/)) {
    const csprojFile = files.find(f => f.ext === ".csproj");
    const content = csprojFile ? readFileSafe(csprojFile.absolutePath) : "";
    const signals = [".csproj file found"];
    if (content.includes("Microsoft.AspNetCore")) signals.push("Microsoft.AspNetCore reference");
    const isMvc = content.includes("Mvc") || hasFilePattern(files, /Controllers\/.*Controller\.cs$/);
    if (isMvc) signals.push("Controllers/ structure found");
    return {
      value: isMvc ? "ASP.NET MVC" : "ASP.NET Core",
      confidence: "definitive",
      signals,
    };
  }

  // ── Go frameworks ─────────────────────────────────────────────────────────

  if (goDeps.some(d => d.includes("gin-gonic/gin"))) {
    return { value: "Go (Gin)", confidence: "definitive", signals: ["gin-gonic/gin in go.mod"] };
  }
  if (goDeps.some(d => d.includes("labstack/echo"))) {
    return { value: "Go (Echo)", confidence: "definitive", signals: ["labstack/echo in go.mod"] };
  }
  if (goDeps.some(d => d.includes("gofiber/fiber"))) {
    return { value: "Go (Fiber)", confidence: "definitive", signals: ["gofiber/fiber in go.mod"] };
  }
  if (hasFile(files, "go.mod")) {
    return { value: "Go (net/http)", confidence: "medium", signals: ["go.mod found — standard library assumed"] };
  }

  // ── Rust frameworks ───────────────────────────────────────────────────────

  if (rustDeps.includes("actix-web")) {
    return { value: "Rust (Actix)", confidence: "definitive", signals: ["actix-web in Cargo.toml"] };
  }
  if (rustDeps.includes("axum")) {
    return { value: "Rust (Axum)", confidence: "definitive", signals: ["axum in Cargo.toml"] };
  }

  return { value: "Unknown", confidence: "low", signals: ["No recognizable backend framework detected"] };
}

// ─── Language detection ───────────────────────────────────────────────────────

function detectLanguage(files: ScannedFile[], npm: DepsBundle): DetectedTech<Language> {
  const counts: Record<Language, number> = {
    TypeScript: 0, JavaScript: 0, Python: 0, PHP: 0, Ruby: 0,
    Java: 0, "C#": 0, Go: 0, Rust: 0, Kotlin: 0, Elixir: 0, Unknown: 0,
  };
  const extMap: Record<string, Language> = {
    ".ts": "TypeScript", ".tsx": "TypeScript",
    ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
    ".py": "Python", ".php": "PHP", ".rb": "Ruby",
    ".java": "Java", ".kt": "Kotlin", ".kts": "Kotlin",
    ".cs": "C#", ".go": "Go", ".rs": "Rust", ".ex": "Elixir", ".exs": "Elixir",
  };
  for (const f of files) {
    const lang = extMap[f.ext];
    if (lang) counts[lang]++;
  }

  // TypeScript config boosts TS
  if (hasFile(files, "tsconfig.json")) counts["TypeScript"] += 10;
  if (hasDep(npm.all, "typescript")) counts["TypeScript"] += 5;

  const sorted = (Object.entries(counts) as [Language, number][]).filter(([l]) => l !== "Unknown").sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  if (!top || top[1] === 0) return { value: "Unknown", confidence: "low", signals: ["No source files detected"] };

  const conf: Confidence = top[1] > 50 ? "definitive" : top[1] > 10 ? "high" : top[1] > 2 ? "medium" : "low";
  return { value: top[0], confidence: conf, signals: [`${top[1]} ${top[0]} source files found`] };
}

// ─── Database detection ───────────────────────────────────────────────────────

function detectDatabases(
  files: ScannedFile[],
  npm: DepsBundle,
  pyDeps: string[],
  phpDeps: Record<string, string>,
  javaDeps: string[],
): DetectedTech<Database>[] {
  const dbs: DetectedTech<Database>[] = [];

  const envContent = files.filter(f => f.name.startsWith(".env")).map(f => readFileSafe(f.absolutePath)).join("\n");
  const hasEnvSignal = (patterns: string[]) => patterns.some(p => envContent.toLowerCase().includes(p));

  // PostgreSQL
  const pgSignals: string[] = [];
  if (hasDep(npm.all, "pg") || hasDep(npm.all, "postgres")) pgSignals.push("pg / postgres in npm deps");
  if (hasDep(npm.all, "@neondatabase/serverless")) pgSignals.push("@neondatabase/serverless detected (Neon)");
  if (pyDeps.includes("psycopg2") || pyDeps.includes("psycopg") || pyDeps.includes("asyncpg")) pgSignals.push("psycopg2/asyncpg in Python deps");
  if (javaDeps.some(d => d.includes("postgresql"))) pgSignals.push("postgresql driver in Java deps");
  if (hasEnvSignal(["postgres", "postgresql", "pg_"]) || hasFilePattern(files, /migrations?\/.*\.sql$/)) pgSignals.push(".env PostgreSQL reference");
  if (hasFile(files, "prisma/schema.prisma") || hasFilePattern(files, /schema\.prisma$/)) {
    const prismaContent = files.filter(f => f.name === "schema.prisma").map(f => readFileSafe(f.absolutePath)).join("");
    if (prismaContent.includes("postgresql")) pgSignals.push("Prisma schema: provider = postgresql");
  }
  if (pgSignals.length > 0) dbs.push({ value: "PostgreSQL", confidence: pgSignals.length >= 2 ? "definitive" : "high", signals: pgSignals });

  // MySQL / MariaDB
  const mysqlSignals: string[] = [];
  if (hasDep(npm.all, "mysql2") || hasDep(npm.all, "mysql")) mysqlSignals.push("mysql2 in npm deps");
  if (pyDeps.includes("pymysql") || pyDeps.includes("mysqlclient")) mysqlSignals.push("pymysql in Python deps");
  if (phpDeps["mysqli"] !== undefined || hasEnvSignal(["mysql", "mariadb", "db_host"])) mysqlSignals.push(".env MySQL reference");
  if (mysqlSignals.length > 0) dbs.push({ value: "MySQL", confidence: mysqlSignals.length >= 2 ? "high" : "medium", signals: mysqlSignals });

  // MongoDB
  const mongoSignals: string[] = [];
  if (hasDep(npm.all, "mongodb") || hasDep(npm.all, "mongoose")) mongoSignals.push("mongodb / mongoose in npm deps");
  if (pyDeps.includes("pymongo") || pyDeps.includes("motor")) mongoSignals.push("pymongo in Python deps");
  if (hasEnvSignal(["mongodb", "mongo_uri", "mongo_url"])) mongoSignals.push(".env MongoDB URI reference");
  if (mongoSignals.length > 0) dbs.push({ value: "MongoDB", confidence: mongoSignals.length >= 2 ? "high" : "medium", signals: mongoSignals });

  // SQLite
  const sqliteSignals: string[] = [];
  if (hasDep(npm.all, "better-sqlite3") || hasDep(npm.all, "sqlite3") || hasDep(npm.all, "sqlite")) sqliteSignals.push("sqlite in npm deps");
  if (pyDeps.includes("sqlite3")) sqliteSignals.push("sqlite3 in Python deps");
  if (hasFilePattern(files, /\.sqlite$/) || hasFilePattern(files, /\.db$/)) sqliteSignals.push(".sqlite / .db file found");
  if (sqliteSignals.length > 0) dbs.push({ value: "SQLite", confidence: "high", signals: sqliteSignals });

  // Redis
  const redisSignals: string[] = [];
  if (hasDep(npm.all, "redis") || hasDep(npm.all, "ioredis")) redisSignals.push("redis / ioredis in npm deps");
  if (pyDeps.includes("redis") || pyDeps.includes("aioredis")) redisSignals.push("redis in Python deps");
  if (hasEnvSignal(["redis_url", "redis_host"])) redisSignals.push(".env Redis reference");
  if (redisSignals.length > 0) dbs.push({ value: "Redis", confidence: redisSignals.length >= 2 ? "definitive" : "high", signals: redisSignals });

  // DynamoDB
  if (hasDep(npm.all, "@aws-sdk/client-dynamodb") || hasDep(npm.all, "dynamoose") || hasDep(npm.all, "@aws-sdk/lib-dynamodb")) {
    dbs.push({ value: "DynamoDB", confidence: "high", signals: ["@aws-sdk/client-dynamodb in npm deps"] });
  }

  return dbs;
}

// ─── ORM detection ────────────────────────────────────────────────────────────

function detectOrm(files: ScannedFile[], npm: DepsBundle, pyDeps: string[], rubyDeps: string[], javaDeps: string[], goDeps: string[]): DetectedTech<ORM> {
  if (hasDep(npm.all, "@prisma/client") || hasFilePattern(files, /schema\.prisma$/)) {
    return { value: "Prisma", confidence: "definitive", signals: ["@prisma/client in deps", "schema.prisma found"].filter((s, i) => i === 0 || hasFilePattern(files, /schema\.prisma$/)) };
  }
  if (hasDep(npm.all, "drizzle-orm")) {
    const signals = ["drizzle-orm in deps"];
    if (hasFile(files, "drizzle.config.ts") || hasFile(files, "drizzle.config.js")) signals.push("drizzle.config.ts found");
    return { value: "Drizzle", confidence: "definitive", signals };
  }
  if (hasDep(npm.all, "typeorm")) {
    return { value: "TypeORM", confidence: "definitive", signals: ["typeorm in deps"] };
  }
  if (hasDep(npm.all, "@mikro-orm/core") || hasDep(npm.all, "mikro-orm")) {
    return { value: "MikroORM", confidence: "definitive", signals: ["@mikro-orm/core in deps"] };
  }
  if (hasDep(npm.all, "sequelize")) {
    return { value: "Sequelize", confidence: "high", signals: ["sequelize in deps"] };
  }
  if (hasDep(npm.all, "mongoose")) {
    return { value: "Mongoose", confidence: "definitive", signals: ["mongoose in deps"] };
  }
  if (pyDeps.includes("sqlalchemy") || pyDeps.includes("flask-sqlalchemy") || pyDeps.includes("sqlmodel")) {
    return { value: "SQLAlchemy", confidence: "definitive", signals: ["sqlalchemy in Python deps"] };
  }
  if (pyDeps.includes("tortoise-orm")) {
    return { value: "Tortoise ORM", confidence: "high", signals: ["tortoise-orm in Python deps"] };
  }
  if (rubyDeps.includes("rails") || rubyDeps.includes("activerecord")) {
    return { value: "ActiveRecord", confidence: "definitive", signals: ["ActiveRecord via Rails"] };
  }
  if (javaDeps.some(d => d.includes("hibernate"))) {
    return { value: "Hibernate", confidence: "high", signals: ["hibernate in Java deps"] };
  }
  if (goDeps.some(d => d.includes("gorm"))) {
    return { value: "GORM", confidence: "high", signals: ["gorm.io/gorm in go.mod"] };
  }
  return { value: "None detected", confidence: "medium", signals: ["No ORM dependency found"] };
}

// ─── Auth detection ───────────────────────────────────────────────────────────

function detectAuth(files: ScannedFile[], npm: DepsBundle, pyDeps: string[], rubyDeps: string[], javaDeps: string[]): DetectedTech<AuthSystem> {
  if (hasDep(npm.all, "@auth/core") || hasDep(npm.all, "next-auth")) {
    return { value: "NextAuth.js", confidence: "definitive", signals: ["next-auth in deps"] };
  }
  if (hasDep(npm.all, /^@clerk\//)) {
    return { value: "Clerk", confidence: "definitive", signals: ["@clerk/* in deps"] };
  }
  if (hasDep(npm.all, /^@auth0\//)) {
    return { value: "Auth0", confidence: "definitive", signals: ["@auth0/* in deps"] };
  }
  if (hasDep(npm.all, "@supabase/supabase-js")) {
    return { value: "Supabase Auth", confidence: "high", signals: ["@supabase/supabase-js in deps"] };
  }
  if (hasDep(npm.all, "firebase-admin") || hasDep(npm.all, "firebase")) {
    return { value: "Firebase Auth", confidence: "high", signals: ["firebase in deps"] };
  }
  if (hasDep(npm.all, "passport")) {
    return { value: "Passport.js", confidence: "high", signals: ["passport in deps"] };
  }
  if (hasDep(npm.all, "jsonwebtoken") || hasDep(npm.all, "jose")) {
    return { value: "JWT (custom)", confidence: "medium", signals: ["jsonwebtoken / jose in deps — custom JWT auth assumed"] };
  }
  if (rubyDeps.includes("devise")) {
    return { value: "Devise (Rails)", confidence: "definitive", signals: ["devise in Gemfile"] };
  }
  if (pyDeps.includes("django")) {
    return { value: "Django Auth", confidence: "high", signals: ["Django includes built-in auth"] };
  }
  if (javaDeps.some(d => d.includes("spring-security"))) {
    return { value: "Spring Security", confidence: "definitive", signals: ["spring-security in Java deps"] };
  }
  return { value: "None detected", confidence: "medium", signals: ["No auth library detected"] };
}

// ─── API style detection ──────────────────────────────────────────────────────

function detectApiStyle(files: ScannedFile[], npm: DepsBundle, pyDeps: string[], javaDeps: string[]): DetectedTech<ApiStyle> {
  const hasGraphQL = hasDep(npm.all, "graphql") || hasDep(npm.all, "@apollo/server") || hasDep(npm.all, "apollo-server") || pyDeps.includes("graphene") || pyDeps.includes("strawberry-graphql");
  const hasTrpc = hasDep(npm.all, "@trpc/server");
  const hasGrpc = hasDep(npm.all, "@grpc/grpc-js") || pyDeps.includes("grpcio") || javaDeps.some(d => d.includes("grpc"));
  const hasRest = hasDep(npm.all, "express") || hasDep(npm.all, "fastify") || hasDep(npm.all, "@nestjs/core") || pyDeps.includes("django") || pyDeps.includes("fastapi") || pyDeps.includes("flask");

  if (hasGraphQL && hasTrpc) return { value: "REST + GraphQL", confidence: "high", signals: ["graphql + @trpc/server detected"] };
  if (hasGraphQL && hasRest)  return { value: "REST + GraphQL", confidence: "high", signals: ["graphql + REST framework detected"] };
  if (hasTrpc && hasRest)     return { value: "REST + tRPC",    confidence: "high", signals: ["@trpc/server + REST framework detected"] };
  if (hasGraphQL) return { value: "GraphQL", confidence: "definitive", signals: ["graphql in deps"] };
  if (hasTrpc)    return { value: "tRPC",    confidence: "definitive", signals: ["@trpc/server in deps"] };
  if (hasGrpc)    return { value: "gRPC",    confidence: "definitive", signals: ["grpc in deps"] };
  if (hasRest)    return { value: "REST",    confidence: "high",       signals: ["REST framework detected"] };
  return { value: "Unknown", confidence: "low", signals: ["No API style signals detected"] };
}

// ─── Routing style detection ──────────────────────────────────────────────────

function detectRoutingStyle(files: ScannedFile[], framework: SupportedFramework, npm: DepsBundle): DetectedTech<RoutingStyle> {
  if (framework === "Next.js") {
    const hasPages = hasDir(files, "pages");
    const hasApp   = hasDir(files, "app");
    if (hasPages || hasApp) return { value: "File-based", confidence: "definitive", signals: [`${hasApp ? "app/" : "pages/"} directory — Next.js file routing`] };
  }
  if (framework === "Ruby on Rails") return { value: "Code-based", confidence: "definitive", signals: ["Rails: config/routes.rb"] };
  if (framework === "Laravel")       return { value: "Code-based", confidence: "definitive", signals: ["Laravel: routes/ directory"] };
  if (framework === "NestJS")        return { value: "Code-based", confidence: "definitive", signals: ["NestJS: decorator-based routing"] };
  if (framework === "Django")        return { value: "Code-based", confidence: "definitive", signals: ["Django: urls.py routing"] };
  if (hasDep(npm.all, "react-router") || hasDep(npm.all, "@tanstack/router")) {
    return { value: "Code-based", confidence: "high", signals: ["react-router / @tanstack/router detected"] };
  }
  if (hasFilePattern(files, /pages\//)) return { value: "File-based", confidence: "medium", signals: ["pages/ directory found"] };
  return { value: "Unknown", confidence: "low", signals: [] };
}

// ─── Storage detection ────────────────────────────────────────────────────────

function detectStorage(files: ScannedFile[], npm: DepsBundle, pyDeps: string[]): DetectedTech<StorageProvider>[] {
  const results: DetectedTech<StorageProvider>[] = [];
  if (hasDep(npm.all, "@aws-sdk/client-s3") || hasDep(npm.all, "aws-sdk") || pyDeps.includes("boto3")) {
    results.push({ value: "AWS S3", confidence: "definitive", signals: ["@aws-sdk/client-s3 / boto3 detected"] });
  }
  if (hasDep(npm.all, "@cloudflare/workers-types") || files.some(f => f.name.includes("r2") && (f.ext === ".ts" || f.ext === ".js"))) {
    results.push({ value: "Cloudflare R2", confidence: "medium", signals: ["Cloudflare R2 reference detected"] });
  }
  if (hasDep(npm.all, "@google-cloud/storage") || pyDeps.includes("google-cloud-storage")) {
    results.push({ value: "Google Cloud Storage", confidence: "definitive", signals: ["@google-cloud/storage detected"] });
  }
  if (hasDep(npm.all, "@supabase/supabase-js")) {
    results.push({ value: "Supabase Storage", confidence: "medium", signals: ["@supabase/supabase-js (includes storage)"] });
  }
  if (hasDep(npm.all, "uploadthing")) {
    results.push({ value: "Uploadthing", confidence: "definitive", signals: ["uploadthing in deps"] });
  }
  if (hasDep(npm.all, "cloudinary") || pyDeps.includes("cloudinary")) {
    results.push({ value: "Cloudinary", confidence: "definitive", signals: ["cloudinary in deps"] });
  }
  if (results.length === 0) {
    results.push({ value: "Local filesystem", confidence: "low", signals: ["No cloud storage library detected — local filesystem assumed"] });
  }
  return results;
}

// ─── Cache detection ──────────────────────────────────────────────────────────

function detectCache(files: ScannedFile[], npm: DepsBundle, pyDeps: string[]): DetectedTech<CacheSystem> {
  if (hasDep(npm.all, "@upstash/redis")) return { value: "Upstash", confidence: "definitive", signals: ["@upstash/redis in deps"] };
  if (hasDep(npm.all, "redis") || hasDep(npm.all, "ioredis") || pyDeps.includes("redis")) {
    return { value: "Redis", confidence: "definitive", signals: ["redis in deps"] };
  }
  if (hasDep(npm.all, "node-cache") || hasDep(npm.all, "lru-cache")) {
    return { value: "In-memory (node-cache)", confidence: "high", signals: ["node-cache / lru-cache in deps"] };
  }
  if (hasDep(npm.all, "memcached") || pyDeps.includes("pylibmc") || pyDeps.includes("pymemcache")) {
    return { value: "Memcached", confidence: "high", signals: ["memcached dep detected"] };
  }
  return { value: "None detected", confidence: "medium", signals: ["No cache library detected"] };
}

// ─── Queue detection ──────────────────────────────────────────────────────────

function detectQueue(files: ScannedFile[], npm: DepsBundle, pyDeps: string[]): DetectedTech<QueueSystem> {
  if (hasDep(npm.all, "bullmq")) return { value: "BullMQ", confidence: "definitive", signals: ["bullmq in deps"] };
  if (hasDep(npm.all, "bull"))   return { value: "Bull",   confidence: "high",       signals: ["bull in deps"] };
  if (hasDep(npm.all, "amqplib") || hasDep(npm.all, "@nestjs/microservices")) {
    return { value: "RabbitMQ", confidence: "high", signals: ["amqplib / @nestjs/microservices detected"] };
  }
  if (hasDep(npm.all, "@aws-sdk/client-sqs")) {
    return { value: "AWS SQS", confidence: "definitive", signals: ["@aws-sdk/client-sqs in deps"] };
  }
  if (pyDeps.includes("celery")) {
    return { value: "Celery", confidence: "definitive", signals: ["celery in Python deps"] };
  }
  if (pyDeps.includes("kafka-python") || hasDep(npm.all, "kafkajs")) {
    return { value: "Kafka", confidence: "high", signals: ["kafka library detected"] };
  }
  return { value: "None detected", confidence: "medium", signals: ["No queue system detected"] };
}

// ─── CMS detection ────────────────────────────────────────────────────────────

function detectCms(files: ScannedFile[], npm: DepsBundle): DetectedTech<CmsSystem> {
  if (hasFile(files, "wp-config.php")) return { value: "WordPress", confidence: "definitive", signals: ["wp-config.php found"] };
  if (hasDep(npm.all, "@strapi/strapi") || hasDep(npm.all, "strapi")) return { value: "Strapi", confidence: "definitive", signals: ["strapi in deps"] };
  if (hasDep(npm.all, "contentful") || hasDep(npm.all, "contentful-management")) return { value: "Contentful", confidence: "definitive", signals: ["contentful in deps"] };
  if (hasDep(npm.all, "@sanity/client") || hasDep(npm.all, "sanity")) return { value: "Sanity", confidence: "definitive", signals: ["@sanity/client in deps"] };
  if (hasDep(npm.all, "payload") || hasDep(npm.all, "@payloadcms/next")) return { value: "Payload CMS", confidence: "definitive", signals: ["payload in deps"] };
  if (hasDep(npm.all, "directus") || hasDep(npm.all, "@directus/sdk")) return { value: "Directus", confidence: "definitive", signals: ["directus in deps"] };
  if (hasDep(npm.all, "@prismicio/client") || hasDep(npm.all, "prismic-javascript")) return { value: "Prismic", confidence: "high", signals: ["@prismicio/client in deps"] };
  if (hasDep(npm.all, "ghost")) return { value: "Ghost", confidence: "high", signals: ["ghost in deps"] };
  return { value: "None detected", confidence: "medium", signals: ["No CMS detected"] };
}

// ─── Deployment target ────────────────────────────────────────────────────────

function detectDeployment(files: ScannedFile[], npm: DepsBundle): DetectedTech<DeploymentTarget>[] {
  const results: DetectedTech<DeploymentTarget>[] = [];
  if (hasFile(files, "vercel.json") || hasDep(npm.all, "vercel")) {
    results.push({ value: "Vercel", confidence: "definitive", signals: ["vercel.json / vercel dep"] });
  }
  if (hasFile(files, "netlify.toml")) {
    results.push({ value: "Netlify", confidence: "definitive", signals: ["netlify.toml found"] });
  }
  if (hasFile(files, "fly.toml")) {
    results.push({ value: "Fly.io", confidence: "definitive", signals: ["fly.toml found"] });
  }
  if (hasFile(files, "railway.json") || hasFile(files, "railway.toml")) {
    results.push({ value: "Railway", confidence: "definitive", signals: ["railway.toml found"] });
  }
  if (hasFile(files, "Procfile")) {
    results.push({ value: "Heroku", confidence: "high", signals: ["Procfile found"] });
  }
  if (hasFile(files, "Dockerfile") || hasFile(files, "docker-compose.yml") || hasFile(files, "docker-compose.yaml")) {
    results.push({ value: "Docker", confidence: "high", signals: ["Dockerfile / docker-compose found"] });
  }
  if (files.some(f => f.name === "serverless.yml" || f.name === "serverless.yaml")) {
    results.push({ value: "AWS", confidence: "high", signals: ["serverless.yml found"] });
  }
  if (results.length === 0) results.push({ value: "Unknown", confidence: "low", signals: [] });
  return results;
}

// ─── Background workers ───────────────────────────────────────────────────────

function detectWorkers(files: ScannedFile[], npm: DepsBundle): string[] {
  const workers: string[] = [];
  if (hasDep(npm.all, "bullmq") || hasDep(npm.all, "bull")) workers.push("BullMQ/Bull job workers");
  if (hasDep(npm.all, "node-cron") || hasDep(npm.all, "cron") || hasDep(npm.all, "node-schedule")) workers.push("Cron-based scheduled tasks");
  if (hasFilePattern(files, /workers?\//)) workers.push("workers/ directory detected");
  if (hasFilePattern(files, /jobs?\//))    workers.push("jobs/ directory detected");
  if (hasDep(npm.all, "@nestjs/schedule")) workers.push("NestJS @Cron decorators");
  return workers;
}

// ─── Confidence score ─────────────────────────────────────────────────────────

const CONF_WEIGHT: Record<Confidence, number> = {
  definitive: 1.0, high: 0.85, medium: 0.6, low: 0.3,
};

function computeBackendConfidenceScore(
  framework: DetectedTech<SupportedFramework>,
  language: DetectedTech<Language>,
  dbs: DetectedTech<Database>[],
  orm: DetectedTech<ORM>,
  auth: DetectedTech<AuthSystem>,
  api: DetectedTech<ApiStyle>,
  fileCount: number,
): number {
  let score = 0;
  let weight = 0;

  const add = (tech: DetectedTech<string>, w: number) => {
    if (tech.value !== "Unknown" && tech.value !== "None detected") {
      score  += CONF_WEIGHT[tech.confidence] * w;
      weight += w;
    }
  };

  add(framework, 35);
  add(language,  20);
  for (const db of dbs) add(db, 10);
  add(orm,  10);
  add(auth,  8);
  add(api,   7);

  // File count bonus — more files = more signal
  const fileBonusPct = Math.min(10, Math.floor(fileCount / 50));

  if (weight === 0) return fileBonusPct;
  return Math.min(100, Math.round((score / weight) * 90) + fileBonusPct);
}

// ─── Dependency map ───────────────────────────────────────────────────────────

export interface DependencyMap {
  detectionId: string;
  generatedAt: string;
  packageManager: "npm" | "yarn" | "pnpm" | "pip" | "bundle" | "composer" | "maven" | "gradle" | "go mod" | "cargo" | "unknown";
  manifestFiles: string[];
  totalDependencies: number;
  productionDeps: Array<{ name: string; version: string; category: string }>;
  devDeps: Array<{ name: string; version: string; category: string }>;
  pythonDeps: string[];
  rubyDeps: string[];
  phpDeps: string[];
  javaDeps: string[];
  goDeps: string[];
  rustDeps: string[];
}

function categorizeDep(name: string): string {
  if (/^@prisma|drizzle-orm|typeorm|sequelize|mongoose|mikroorm/.test(name)) return "ORM";
  if (/^next$|^nuxt$|^react$|^vue|^svelte|^solid/.test(name)) return "Frontend Framework";
  if (/express|fastify|koa|hapi|@nestjs/.test(name)) return "Backend Framework";
  if (/^pg$|^postgres$|mysql2|mongodb|redis|ioredis/.test(name)) return "Database Driver";
  if (/next-auth|passport|@clerk|@auth0|firebase|supabase/.test(name)) return "Authentication";
  if (/graphql|@apollo|@trpc|@grpc/.test(name)) return "API Layer";
  if (/bullmq|bull$|celery|amqplib/.test(name)) return "Queue";
  if (/^aws-sdk|@aws-sdk|@google-cloud|cloudinary|uploadthing/.test(name)) return "Storage/Cloud";
  if (/jest|vitest|mocha|chai|testing-library|cypress|playwright/.test(name)) return "Testing";
  if (/eslint|prettier|typescript|ts-node|tsx|esbuild|vite|webpack|turbo/.test(name)) return "Tooling";
  if (/zod|yup|joi|class-validator/.test(name)) return "Validation";
  return "Other";
}

// ─── Report shapes ────────────────────────────────────────────────────────────

export interface BackendProfile {
  detectionId: string;
  generatedAt: string;
  projectName: string | null;
  sourcePath: string;
  backendConfidenceScore: number;
  framework: DetectedTech<SupportedFramework>;
  language: DetectedTech<Language>;
  databases: DetectedTech<Database>[];
  orm: DetectedTech<ORM>;
  auth: DetectedTech<AuthSystem>;
  apiStyle: DetectedTech<ApiStyle>;
  routingStyle: DetectedTech<RoutingStyle>;
  storage: DetectedTech<StorageProvider>[];
  cache: DetectedTech<CacheSystem>;
  queue: DetectedTech<QueueSystem>;
  cms: DetectedTech<CmsSystem>;
  deploymentTargets: DetectedTech<DeploymentTarget>[];
  backgroundWorkers: string[];
  nodeVersion: string | null;
  packageManager: DependencyMap["packageManager"];
  totalFilesScanned: number;
  summary: string;
}

export interface FrameworkDetectionReport {
  detectionId: string;
  generatedAt: string;
  primaryFramework: DetectedTech<SupportedFramework>;
  language: DetectedTech<Language>;
  frameworkFamily: string;
  isFullStack: boolean;
  isMicroservices: boolean;
  isMonolith: boolean;
  isServerless: boolean;
  detectionSignals: Array<{ source: string; signal: string; weight: string }>;
  frameworkCapabilities: string[];
  frameworkLimitations: string[];
  productionReadinessNotes: string[];
}

export interface TechnologyStack {
  detectionId: string;
  generatedAt: string;
  layer: {
    runtime: string;
    framework: string;
    language: string;
    apiStyle: string;
    routing: string;
    database: string[];
    orm: string;
    auth: string;
    cache: string;
    queue: string;
    storage: string[];
    cms: string;
    deployment: string[];
    workers: string[];
  };
  stackName: string;
  stackDescription: string;
  modernityScore: number;       // 0-100 — how modern the stack is
  maturityScore: number;        // 0-100 — how battle-tested the stack is
  developerExperienceScore: number;
  recommendations: string[];
}

export interface D1Bundle {
  detectionId: string;
  generatedAt: string;
  backendProfile: BackendProfile;
  frameworkDetectionReport: FrameworkDetectionReport;
  technologyStack: TechnologyStack;
  dependencyMap: DependencyMap;
  r2Keys: {
    backendProfile: string;
    frameworkDetectionReport: string;
    technologyStack: string;
    dependencyMap: string;
  };
}

// ─── In-memory store ──────────────────────────────────────────────────────────

const _store = new Map<string, D1Bundle>();

export function getD1Bundle(detectionId: string): D1Bundle | undefined { return _store.get(detectionId); }
export function listD1Bundles(): Array<{ detectionId: string; generatedAt: string; framework: string; backendConfidenceScore: number }> {
  return [..._store.values()].map(b => ({
    detectionId: b.detectionId,
    generatedAt: b.generatedAt,
    framework:   b.backendProfile.framework.value,
    backendConfidenceScore: b.backendProfile.backendConfidenceScore,
  }));
}

// ─── Report builders ──────────────────────────────────────────────────────────

function buildFrameworkReport(
  detectionId: string,
  framework: DetectedTech<SupportedFramework>,
  language: DetectedTech<Language>,
  npm: DepsBundle,
  files: ScannedFile[],
  now: string,
): FrameworkDetectionReport {
  const allSignals: Array<{ source: string; signal: string; weight: string }> = [];

  for (const s of framework.signals) allSignals.push({ source: "framework", signal: s, weight: "35%" });
  for (const s of language.signals)  allSignals.push({ source: "language",  signal: s, weight: "20%" });

  const isFullStack  = hasDep(npm.all, "next") || hasDep(npm.all, /^nuxt$/) || framework.value === "Ruby on Rails" || framework.value === "Laravel" || framework.value === "Django";
  const isMicroservices = hasDep(npm.all, "@nestjs/microservices") || hasDep(npm.all, "@grpc/grpc-js") || files.some(f => f.name === "docker-compose.yml");
  const isServerless = hasFile(files, "vercel.json") || files.some(f => f.name === "serverless.yml");
  const isMonolith   = !isMicroservices && (framework.value === "Ruby on Rails" || framework.value === "Laravel" || framework.value === "Django" || framework.value === "Spring Boot");

  const frameworkFamily = (() => {
    if (["Next.js", "NestJS", "Express", "Fastify", "Koa", "Hapi"].includes(framework.value)) return "Node.js";
    if (["Django", "Flask", "FastAPI", "Starlette", "Tornado"].includes(framework.value)) return "Python";
    if (["Laravel", "WordPress", "Symfony", "CodeIgniter"].includes(framework.value)) return "PHP";
    if (["Ruby on Rails", "Sinatra", "Hanami"].includes(framework.value)) return "Ruby";
    if (["ASP.NET Core", "ASP.NET MVC"].includes(framework.value)) return ".NET";
    if (["Spring Boot", "Micronaut", "Quarkus"].includes(framework.value)) return "JVM";
    if (framework.value.startsWith("Go")) return "Go";
    if (framework.value.startsWith("Rust")) return "Rust";
    return "Unknown";
  })();

  const capabilities: string[] = [];
  const limitations: string[] = [];
  const prodNotes: string[] = [];

  if (framework.value === "Next.js") {
    capabilities.push("SSR / SSG / ISR / RSC support", "API routes co-located with pages", "Edge runtime support", "Built-in image optimization");
    limitations.push("Cold start latency on serverless deployments", "Complex state management across server/client boundary");
    prodNotes.push("Deploy to Vercel or a Node.js server", "Configure ISR revalidation per route");
  } else if (framework.value === "NestJS") {
    capabilities.push("Modular architecture", "Built-in dependency injection", "First-class TypeScript", "Microservices support");
    limitations.push("Steep learning curve", "Heavy initial boilerplate");
    prodNotes.push("Use clustering or PM2 for multi-core utilization");
  } else if (framework.value === "Express") {
    capabilities.push("Minimal and flexible", "Huge ecosystem", "Easy to learn");
    limitations.push("No built-in structure", "Requires manual architecture decisions");
    prodNotes.push("Use helmet.js for security headers", "Add rate limiting with express-rate-limit");
  } else if (framework.value === "Django") {
    capabilities.push("Batteries included", "Built-in admin panel", "Mature ORM", "Strong security defaults");
    limitations.push("Synchronous by default (async support added in 3.1+)", "Template engine can limit SPA patterns");
    prodNotes.push("Use gunicorn + nginx in production", "Enable Django caching framework");
  } else if (framework.value === "FastAPI") {
    capabilities.push("Async-first", "Auto-generated OpenAPI docs", "Python type hints for validation", "High performance");
    limitations.push("Smaller ecosystem than Django/Flask");
    prodNotes.push("Use uvicorn with multiple workers in production");
  } else if (framework.value === "Laravel") {
    capabilities.push("Eloquent ORM", "Artisan CLI", "Built-in queues", "Blade templating");
    limitations.push("PHP runtime overhead", "Synchronous by default");
    prodNotes.push("Use Laravel Octane for persistent process mode", "Enable opcache in PHP config");
  }

  return { detectionId, generatedAt: now, primaryFramework: framework, language, frameworkFamily, isFullStack, isMicroservices, isMonolith, isServerless, detectionSignals: allSignals, frameworkCapabilities: capabilities, frameworkLimitations: limitations, productionReadinessNotes: prodNotes };
}

function buildTechStack(
  detectionId: string,
  profile: BackendProfile,
  now: string,
): TechnologyStack {
  const runtimeLabel = (() => {
    const fam = profile.framework.value;
    if (["Next.js","NestJS","Express","Fastify","Koa","Hapi"].includes(fam)) return `Node.js ${profile.nodeVersion ?? ""}`.trim();
    if (["Django","Flask","FastAPI","Starlette","Tornado"].includes(fam)) return "Python";
    if (fam.startsWith("Ruby")) return "Ruby";
    if (["Laravel","WordPress","Symfony"].includes(fam)) return "PHP";
    if (fam.startsWith("Go")) return "Go";
    if (fam.startsWith("Rust")) return "Rust";
    if (["Spring Boot","Micronaut","Quarkus"].includes(fam)) return "JVM (Java/Kotlin)";
    if (["ASP.NET Core","ASP.NET MVC"].includes(fam)) return ".NET";
    return profile.language.value;
  })();

  const stackName = [profile.framework.value, profile.orm.value, profile.databases[0]?.value].filter(v => v && v !== "None detected" && v !== "Unknown").join(" + ");

  const stackDescription = [
    `${profile.framework.value} backend`,
    profile.language.value !== "Unknown" ? `written in ${profile.language.value}` : null,
    profile.databases.length > 0 ? `using ${profile.databases.map(d => d.value).join(" + ")}` : null,
    profile.orm.value !== "None detected" ? `via ${profile.orm.value}` : null,
  ].filter(Boolean).join(", ") + ".";

  // Modernity score — newer tech = higher
  let modernityScore = 50;
  const modernFrameworks = new Set(["Next.js","NestJS","Fastify","FastAPI","Remix","SvelteKit","Astro","Go (Gin)","Go (Fiber)","Rust (Axum)"]);
  if (modernFrameworks.has(profile.framework.value)) modernityScore += 20;
  if (profile.language.value === "TypeScript") modernityScore += 10;
  if (profile.orm.value === "Drizzle" || profile.orm.value === "Prisma") modernityScore += 10;
  if (profile.auth.value === "Clerk" || profile.auth.value === "NextAuth.js") modernityScore += 5;
  if (profile.cache.value === "Upstash") modernityScore += 5;
  modernityScore = Math.min(100, modernityScore);

  // Maturity score — older/battle-tested = higher
  const matureFrameworks = new Set(["Express","Django","Laravel","Ruby on Rails","Spring Boot","ASP.NET MVC","WordPress"]);
  const maturityScore = Math.min(100, 40 + (matureFrameworks.has(profile.framework.value) ? 40 : 10) + (profile.backendConfidenceScore > 70 ? 10 : 0));

  // DX score
  let dxScore = 50;
  if (profile.language.value === "TypeScript") dxScore += 15;
  if (profile.orm.value === "Prisma" || profile.orm.value === "Drizzle") dxScore += 10;
  if (profile.framework.value === "NestJS" || profile.framework.value === "Next.js") dxScore += 10;
  if (profile.auth.value !== "None detected" && profile.auth.value !== "JWT (custom)") dxScore += 5;
  dxScore = Math.min(100, dxScore);

  const recommendations: string[] = [];
  if (profile.cache.value === "None detected") recommendations.push("Add a caching layer (Redis/Upstash) to reduce database load on frequently read data.");
  if (profile.queue.value === "None detected") recommendations.push("Consider a job queue (BullMQ) for async operations like email delivery, report generation, and webhooks.");
  if (profile.auth.value === "None detected") recommendations.push("Implement authentication — consider Clerk, Auth0, or NextAuth.js depending on your framework.");
  if (profile.databases.length === 0) recommendations.push("No database detected — configure a persistent data store before production.");
  if (profile.orm.value === "None detected" && profile.databases.length > 0) recommendations.push("Consider adding an ORM (Prisma, Drizzle, TypeORM) for type-safe database access.");

  return {
    detectionId, generatedAt: now,
    layer: {
      runtime: runtimeLabel,
      framework: profile.framework.value,
      language: profile.language.value,
      apiStyle: profile.apiStyle.value,
      routing: profile.routingStyle.value,
      database: profile.databases.map(d => d.value),
      orm: profile.orm.value,
      auth: profile.auth.value,
      cache: profile.cache.value,
      queue: profile.queue.value,
      storage: profile.storage.map(s => s.value),
      cms: profile.cms.value,
      deployment: profile.deploymentTargets.map(d => d.value),
      workers: profile.backgroundWorkers,
    },
    stackName: stackName || "Custom stack",
    stackDescription,
    modernityScore, maturityScore, developerExperienceScore: dxScore,
    recommendations,
  };
}

function buildDependencyMap(
  detectionId: string,
  files: ScannedFile[],
  npm: DepsBundle,
  pyDeps: string[],
  rubyDeps: string[],
  phpDeps: Record<string, string>,
  javaDeps: string[],
  goDeps: string[],
  rustDeps: string[],
  now: string,
): DependencyMap {
  const manifestFiles = files.filter(f => ["package.json","requirements.txt","Gemfile","composer.json","pom.xml","build.gradle","go.mod","Cargo.toml","pyproject.toml"].includes(f.name)).map(f => f.relativePath);

  const pkgMgr: DependencyMap["packageManager"] = (() => {
    if (files.some(f => f.name === "pnpm-lock.yaml" || f.name === "pnpm-workspace.yaml")) return "pnpm";
    if (files.some(f => f.name === "yarn.lock")) return "yarn";
    if (files.some(f => f.name === "package-lock.json")) return "npm";
    if (files.some(f => f.name === "requirements.txt" || f.name === "pyproject.toml")) return "pip";
    if (files.some(f => f.name === "Gemfile")) return "bundle";
    if (files.some(f => f.name === "composer.json")) return "composer";
    if (files.some(f => f.name === "pom.xml")) return "maven";
    if (files.some(f => f.name === "build.gradle")) return "gradle";
    if (files.some(f => f.name === "go.mod")) return "go mod";
    if (files.some(f => f.name === "Cargo.toml")) return "cargo";
    return "unknown";
  })();

  const productionDeps = Object.entries(npm.prod).map(([name, version]) => ({ name, version, category: categorizeDep(name) }));
  const devDeps        = Object.entries(npm.dev).map(([name, version]) => ({ name, version, category: categorizeDep(name) }));
  const total = productionDeps.length + devDeps.length + pyDeps.length + rubyDeps.length + Object.keys(phpDeps).length + javaDeps.length + goDeps.length + rustDeps.length;

  return {
    detectionId, generatedAt: now,
    packageManager: pkgMgr,
    manifestFiles,
    totalDependencies: total,
    productionDeps, devDeps,
    pythonDeps: pyDeps,
    rubyDeps,
    phpDeps: Object.keys(phpDeps),
    javaDeps, goDeps, rustDeps,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export interface D1Options {
  detectionId: string;
  sourcePath: string;
  projectName?: string;
}

export async function runBackendDetection(options: D1Options): Promise<D1Bundle> {
  const { detectionId, sourcePath, projectName } = options;
  const now = new Date().toISOString();

  logger.info({ detectionId, sourcePath }, "D1: starting backend detection");

  // Validate source path
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`D1: source path does not exist: ${sourcePath}`);
  }
  const stat = fs.statSync(sourcePath);
  if (!stat.isDirectory()) {
    throw new Error(`D1: source path is not a directory: ${sourcePath}`);
  }

  // File scan
  logger.info({ detectionId }, "D1: scanning directory");
  const files = scanDirectory(sourcePath);
  logger.info({ detectionId, fileCount: files.length }, "D1: scan complete");

  // Extract all dependency manifests in parallel
  const npm     = extractNpmDeps(files, sourcePath);
  const pyDeps  = extractPythonDeps(files);
  const rubyDeps = extractRubyDeps(files);
  const phpDeps  = extractPhpDeps(files);
  const javaDeps = extractJavaDeps(files);
  const goDeps   = extractGoDeps(files);
  const rustDeps = extractRustDeps(files);

  // Run all detectors
  const framework    = detectFramework(files, npm, pyDeps, rubyDeps, phpDeps, javaDeps, goDeps, rustDeps);
  const language     = detectLanguage(files, npm);
  const databases    = detectDatabases(files, npm, pyDeps, phpDeps, javaDeps);
  const orm          = detectOrm(files, npm, pyDeps, rubyDeps, javaDeps, goDeps);
  const auth         = detectAuth(files, npm, pyDeps, rubyDeps, javaDeps);
  const apiStyle     = detectApiStyle(files, npm, pyDeps, javaDeps);
  const routingStyle = detectRoutingStyle(files, framework.value, npm);
  const storage      = detectStorage(files, npm, pyDeps);
  const cache        = detectCache(files, npm, pyDeps);
  const queue        = detectQueue(files, npm, pyDeps);
  const cms          = detectCms(files, npm);
  const deploymentTargets = detectDeployment(files, npm);
  const backgroundWorkers = detectWorkers(files, npm);

  // Node version
  const nodeVersion = npm.engines["node"] ?? (hasDep(npm.all, "node") ? "unknown" : null);

  // Confidence score
  const backendConfidenceScore = computeBackendConfidenceScore(framework, language, databases, orm, auth, apiStyle, files.length);

  // Summary sentence
  const summary = [
    `Detected ${framework.value} (${language.value})`,
    databases.length > 0 ? `with ${databases.map(d => d.value).join(" + ")}` : null,
    orm.value !== "None detected" ? `via ${orm.value}` : null,
    `— Backend Confidence Score: ${backendConfidenceScore}/100`,
  ].filter(Boolean).join(" ") + ".";

  const backendProfile: BackendProfile = {
    detectionId, generatedAt: now,
    projectName: projectName ?? npm.packageName ?? null,
    sourcePath,
    backendConfidenceScore,
    framework, language, databases, orm, auth,
    apiStyle, routingStyle, storage, cache, queue, cms,
    deploymentTargets, backgroundWorkers,
    nodeVersion,
    packageManager: (() => {
      if (files.some(f => f.name === "pnpm-lock.yaml")) return "pnpm";
      if (files.some(f => f.name === "yarn.lock")) return "yarn";
      if (files.some(f => f.name === "package-lock.json")) return "npm";
      return "unknown";
    })() as DependencyMap["packageManager"],
    totalFilesScanned: files.length,
    summary,
  };

  const frameworkDetectionReport = buildFrameworkReport(detectionId, framework, language, npm, files, now);
  const dependencyMap = buildDependencyMap(detectionId, files, npm, pyDeps, rubyDeps, phpDeps, javaDeps, goDeps, rustDeps, now);
  const technologyStack = buildTechStack(detectionId, backendProfile, now);

  logger.info({ detectionId, framework: framework.value, score: backendConfidenceScore }, "D1: storing reports to R2");

  const [r2Profile, r2Framework, r2Stack, r2Deps] = await Promise.all([
    storeJsonToR2(detectionId, "backend-profile.json",            backendProfile),
    storeJsonToR2(detectionId, "framework-detection-report.json", frameworkDetectionReport),
    storeJsonToR2(detectionId, "technology-stack.json",           technologyStack),
    storeJsonToR2(detectionId, "dependency-map.json",             dependencyMap),
  ]);

  const bundle: D1Bundle = {
    detectionId, generatedAt: now,
    backendProfile, frameworkDetectionReport, technologyStack, dependencyMap,
    r2Keys: {
      backendProfile:            r2Profile!,
      frameworkDetectionReport:  r2Framework!,
      technologyStack:           r2Stack!,
      dependencyMap:             r2Deps!,
    },
  };

  _store.set(detectionId, bundle);
  logger.info({ detectionId, score: backendConfidenceScore, framework: framework.value }, "D1: backend detection complete");
  return bundle;
}
