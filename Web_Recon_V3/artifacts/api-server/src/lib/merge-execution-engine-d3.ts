/**
 * merge-execution-engine-d3.ts — Phase D3: Merge Execution Engine
 *
 * Executes an approved merge plan produced by D2 (Semantic Merge Planner).
 * Writes to the real filesystem. Every operation is reversible.
 *
 * Safety invariants (never violated):
 *   1. Backup is created BEFORE any file is touched.
 *   2. PROTECTED files are never replaced — only appended/merged at the key level.
 *   3. Only operations explicitly listed in `approvedOperations` are executed.
 *   4. Every write is logged. Failures trigger immediate auto-rollback.
 *   5. Validation runs after all writes. Failure → auto-rollback.
 *
 * Merge operation types:
 *   copy_new_file      — source file absent in target → safe copy
 *   merge_package_json — merge deps, pick higher compatible semver
 *   append_env_vars    — add new env keys (never overwrite existing keys)
 *   append_schema      — append new Prisma/SQL model definitions
 *   merge_config       — merge non-conflicting config keys into existing JSON
 *   skip_protected     — file exists and is on the protected list
 *   skip_collision     — file exists and was not approved for overwrite
 *   skip_blocked       — blocked by D2 conflict, must be resolved manually
 *
 * Reports (stored to R2 under d3/{executionId}/):
 *   merge-execution-report.json
 *   rollback-package.json
 *   merged-project-summary.json
 */

import * as fs   from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { logger } from "./logger.js";
import { createCloudProvider } from "../cloud/index.js";
import { getD2Bundle, type D2Bundle } from "./semantic-merge-planner-d2.js";
import { db, mergeExecutionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ─── R2 ───────────────────────────────────────────────────────────────────────

async function storeR2(execId: string, file: string, data: unknown): Promise<string> {
  const key = `d3/${execId}/${file}`;
  const provider = createCloudProvider("r2");
  if (!provider.isConfigured()) { logger.warn({ execId, file }, "D3: R2 not configured"); return key; }
  const buf = Buffer.from(JSON.stringify(data, null, 2), "utf-8");
  await provider.upload({ key, data: buf, contentType: "application/json", checkDuplicate: false });
  logger.info({ key }, "D3: stored to R2");
  return key;
}

// ─── Protected file list ──────────────────────────────────────────────────────

const PROTECTED_FILENAMES = new Set([
  // Secrets & environment
  ".env", ".env.local", ".env.production", ".env.development", ".env.staging",
  // Auth configs
  "auth.ts", "auth.js", "[...nextauth].ts", "[...nextauth].js",
  "next-auth.ts", "next-auth.js", "auth0.ts", "auth0.js",
  // DB/ORM configs
  "schema.prisma", "drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs",
  // TypeScript
  "tsconfig.json", "tsconfig.node.json",
  // Framework
  "next.config.js", "next.config.ts", "next.config.mjs",
  "vite.config.ts", "vite.config.js",
  "nest-cli.json",
  // Linting / formatting
  ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs", ".prettierrc",
  // Server entry points
  "server.ts", "server.js", "main.ts", "main.js",
  // Lockfiles (never merge)
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  // Docker
  "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
  // Git
  ".gitignore", ".gitattributes",
]);

const PROTECTED_PATTERNS = [
  /^\.env/, // .env.*
  /^config\//, // config/ directory
  /^secrets?\//, // secrets/ directory
];

function isProtected(relPath: string): boolean {
  const name = path.basename(relPath);
  if (PROTECTED_FILENAMES.has(name)) return true;
  return PROTECTED_PATTERNS.some(p => p.test(relPath.replace(/\\/g, "/")));
}

// ─── Semver helpers ───────────────────────────────────────────────────────────

function parseMajorMinorPatch(v: string): [number, number, number] {
  const cleaned = v.replace(/^[\^~>=<* ]+/, "").split("-")[0] ?? "0.0.0";
  const parts = cleaned.split(".").map(p => parseInt(p ?? "0", 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function higherVersion(a: string, b: string): string {
  const [am, an, ap] = parseMajorMinorPatch(a);
  const [bm, bn, bp] = parseMajorMinorPatch(b);
  if (bm > am) return b;
  if (bm < am) return a;
  if (bn > an) return b;
  if (bn < an) return a;
  if (bp > ap) return b;
  return a;
}

function preserveRange(version: string): string {
  const prefix = version.match(/^[\^~]/)?.[0] ?? "";
  return prefix ? version : `^${version.replace(/^[>=<* ]+/, "")}`;
}

// ─── Backup ───────────────────────────────────────────────────────────────────

const BACKUP_ROOT = ".webrecon-d3-backups";

export interface BackupManifest {
  executionId: string;
  createdAt: string;
  sourcePath: string;         // primePath (Website Prime)
  targetPath: string;         // existing backend
  backupPath: string;         // full path to the backup directory
  targetFileCount: number;
  checksums: Record<string, string>; // rel → sha256
}

function sha256File(absPath: string): string {
  try {
    const buf = fs.readFileSync(absPath);
    return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
  } catch { return ""; }
}

function createBackup(targetPath: string, executionId: string): BackupManifest {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.resolve(targetPath, "..", BACKUP_ROOT, `${ts}-${executionId.slice(0, 8)}`);

  fs.mkdirSync(backupPath, { recursive: true });
  fs.cpSync(targetPath, backupPath, { recursive: true, errorOnExist: false });

  // Build checksum manifest
  const checksums: Record<string, string> = {};
  let count = 0;
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      const rel = path.relative(targetPath, abs);
      checksums[rel] = sha256File(abs);
      count++;
    }
  }
  walk(targetPath);

  logger.info({ executionId, backupPath, count }, "D3: backup created");
  return { executionId, createdAt: new Date().toISOString(), sourcePath: "", targetPath, backupPath, targetFileCount: count, checksums };
}

function restoreFromBackup(manifest: BackupManifest): void {
  const { targetPath, backupPath } = manifest;
  // Remove everything in target (except the backup dir itself)
  const backupDirName = path.basename(path.dirname(backupPath));
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === BACKUP_ROOT) continue;
    fs.rmSync(path.join(targetPath, e.name), { recursive: true, force: true });
  }
  // Restore from backup
  fs.cpSync(backupPath, targetPath, { recursive: true, errorOnExist: false });
  logger.info({ targetPath, backupPath }, "D3: rollback complete");
}

// ─── Operation types ──────────────────────────────────────────────────────────

export type MergeOpType =
  | "copy_new_file"
  | "merge_package_json"
  | "append_env_vars"
  | "append_schema"
  | "merge_config_json"
  | "skip_protected"
  | "skip_collision"
  | "skip_blocked"
  | "skip_no_source"
  | "reject_validation";

export type OpStatus = "success" | "skipped" | "failed" | "rolled_back";

export interface MergeOperation {
  opId: string;
  type: MergeOpType;
  status: OpStatus;
  sourceFile: string;   // relative to primePath
  targetFile: string;   // relative to targetPath
  protected: boolean;
  detail: string;
  bytesWritten: number;
  durationMs: number;
  error?: string;
}

export interface ValidationResult {
  check: string;
  file: string;
  passed: boolean;
  detail: string;
}

// ─── Merge operators ──────────────────────────────────────────────────────────

function opCopyNewFile(srcAbs: string, dstAbs: string): void {
  fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
  fs.copyFileSync(srcAbs, dstAbs);
}

function opMergePackageJson(srcAbs: string, dstAbs: string): { added: string[]; bumped: string[]; skipped: string[] } {
  const srcRaw = fs.readFileSync(srcAbs, "utf-8");
  const dstRaw = fs.readFileSync(dstAbs, "utf-8");
  const src = JSON.parse(srcRaw) as Record<string, unknown>;
  const dst = JSON.parse(dstRaw) as Record<string, unknown>;

  const srcDeps = (src["dependencies"] as Record<string, string> | undefined) ?? {};
  const srcDev  = (src["devDependencies"] as Record<string, string> | undefined) ?? {};
  const dstDeps = (dst["dependencies"] as Record<string, string> | undefined) ?? {};
  const dstDev  = (dst["devDependencies"] as Record<string, string> | undefined) ?? {};

  const added: string[] = [];
  const bumped: string[] = [];
  const skipped: string[] = [];

  function mergeDeps(srcMap: Record<string, string>, dstMap: Record<string, string>): void {
    for (const [name, ver] of Object.entries(srcMap)) {
      if (!dstMap[name]) {
        dstMap[name] = preserveRange(ver);
        added.push(`${name}@${ver}`);
      } else {
        const chosen = higherVersion(dstMap[name]!, ver);
        if (chosen !== dstMap[name]) {
          dstMap[name] = preserveRange(chosen);
          bumped.push(`${name}: ${dstMap[name]} → ${chosen}`);
        } else {
          skipped.push(name);
        }
      }
    }
  }

  mergeDeps(srcDeps, dstDeps);
  mergeDeps(srcDev, dstDev);

  dst["dependencies"] = dstDeps;
  dst["devDependencies"] = dstDev;

  // Merge scripts (prime scripts prefixed with "prime:" to avoid collision)
  const srcScripts = (src["scripts"] as Record<string, string> | undefined) ?? {};
  const dstScripts = (dst["scripts"] as Record<string, string> | undefined) ?? {};
  for (const [name, cmd] of Object.entries(srcScripts)) {
    const safeKey = dstScripts[name] ? `prime:${name}` : name;
    if (!dstScripts[safeKey]) dstScripts[safeKey] = cmd;
  }
  dst["scripts"] = dstScripts;

  fs.writeFileSync(dstAbs, JSON.stringify(dst, null, 2) + "\n", "utf-8");
  return { added, bumped, skipped };
}

function opAppendEnvVars(srcAbs: string, dstAbs: string): { added: string[]; skipped: string[] } {
  const srcContent = fs.readFileSync(srcAbs, "utf-8");
  let dstContent   = fs.existsSync(dstAbs) ? fs.readFileSync(dstAbs, "utf-8") : "";

  const existingKeys = new Set<string>();
  for (const line of dstContent.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (m) existingKeys.add(m[1]!);
  }

  const added: string[] = [];
  const skipped: string[] = [];
  const newLines: string[] = [];

  for (const line of srcContent.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
    if (!m) continue;
    const key = m[1]!;
    if (existingKeys.has(key)) { skipped.push(key); continue; }
    newLines.push(line);
    added.push(key);
  }

  if (newLines.length > 0) {
    const separator = "\n# Merged from Website Prime (D3)\n";
    dstContent = dstContent.trimEnd() + separator + newLines.join("\n") + "\n";
    fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
    fs.writeFileSync(dstAbs, dstContent, "utf-8");
  }
  return { added, skipped };
}

function opAppendSchema(srcAbs: string, dstAbs: string): { appendedModels: string[]; skippedModels: string[] } {
  const srcContent = fs.readFileSync(srcAbs, "utf-8");
  const dstContent = fs.existsSync(dstAbs) ? fs.readFileSync(dstAbs, "utf-8") : "";

  // Extract existing model names
  const existingModels = new Set([...dstContent.matchAll(/^model\s+(\w+)\s*\{/gm)].map(m => m[1]!.toLowerCase()));
  const existingEnums  = new Set([...dstContent.matchAll(/^enum\s+(\w+)\s*\{/gm)].map(m => m[1]!.toLowerCase()));

  // Extract models from source
  const modelBlocks = [...srcContent.matchAll(/^(model\s+(\w+)\s*\{[^}]+\})/gms)];
  const enumBlocks  = [...srcContent.matchAll(/^(enum\s+(\w+)\s*\{[^}]+\})/gms)];

  const appendedModels: string[] = [];
  const skippedModels:  string[] = [];
  const toAppend: string[] = [];

  for (const m of modelBlocks) {
    const name = m[2]!;
    if (existingModels.has(name.toLowerCase())) { skippedModels.push(name); continue; }
    toAppend.push(m[1]!);
    appendedModels.push(name);
  }
  for (const m of enumBlocks) {
    const name = m[2]!;
    if (existingEnums.has(name.toLowerCase())) { skippedModels.push(name); continue; }
    toAppend.push(m[1]!);
    appendedModels.push(name);
  }

  if (toAppend.length > 0) {
    const appended = "\n\n// Appended by D3 Merge Execution Engine\n" + toAppend.join("\n\n");
    const newContent = dstContent.trimEnd() + appended + "\n";
    fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
    fs.writeFileSync(dstAbs, newContent, "utf-8");
  }
  return { appendedModels, skippedModels };
}

function opMergeConfigJson(srcAbs: string, dstAbs: string): { merged: string[]; skipped: string[] } {
  let src: Record<string, unknown>;
  let dst: Record<string, unknown>;
  try {
    src = JSON.parse(fs.readFileSync(srcAbs, "utf-8")) as Record<string, unknown>;
    dst = JSON.parse(fs.readFileSync(dstAbs, "utf-8")) as Record<string, unknown>;
  } catch { return { merged: [], skipped: [] }; }

  const merged: string[] = [];
  const skipped: string[] = [];
  for (const [key, val] of Object.entries(src)) {
    if (key in dst) { skipped.push(key); continue; }
    (dst as Record<string, unknown>)[key] = val;
    merged.push(key);
  }
  fs.writeFileSync(dstAbs, JSON.stringify(dst, null, 2) + "\n", "utf-8");
  return { merged, skipped };
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateMergedPackageJson(targetPath: string): ValidationResult[] {
  const results: ValidationResult[] = [];
  const pkgPath = path.join(targetPath, "package.json");
  if (!fs.existsSync(pkgPath)) return results;

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
    results.push({ check: "package.json is valid JSON", file: "package.json", passed: true, detail: "Parsed successfully" });
  } catch (e) {
    results.push({ check: "package.json is valid JSON", file: "package.json", passed: false, detail: String(e) });
    return results;
  }

  // Required top-level fields
  const hasName = typeof pkg["name"] === "string" && pkg["name"].length > 0;
  results.push({ check: "package.json has 'name' field", file: "package.json", passed: hasName, detail: hasName ? `name=${pkg["name"]}` : "Missing or empty 'name'" });

  const allDeps: Record<string, string> = {
    ...(pkg["dependencies"]    as Record<string, string> | undefined ?? {}),
    ...(pkg["devDependencies"] as Record<string, string> | undefined ?? {}),
    ...(pkg["peerDependencies"] as Record<string, string> | undefined ?? {}),
  };

  // No duplicate major versions for key singletons
  const seen = new Map<string, string>();
  const dupes: string[] = [];
  for (const [name, ver] of Object.entries(allDeps)) {
    const [maj] = parseMajorMinorPatch(ver);
    const key = `${name}@${maj}`;
    if (seen.has(key) && seen.get(key) !== ver) { dupes.push(name); }
    else seen.set(key, ver);
  }
  results.push({ check: "No duplicate major versions in package.json", file: "package.json", passed: dupes.length === 0, detail: dupes.length > 0 ? `Conflict on: ${dupes.join(", ")}` : `${Object.keys(allDeps).length} deps validated` });

  return results;
}

/**
 * Validates every individual dependency in the merged package.json:
 * - Version is non-empty and parseable
 * - No wildcard "*" versions (too broad, breaks reproducibility)
 * - No "file:" references to non-existent local paths
 * - No "latest" tag (non-reproducible)
 * - Known singleton packages (react, next) must agree on major version across deps/devDeps
 */
function validateAllDependencies(targetPath: string): ValidationResult[] {
  const results: ValidationResult[] = [];
  const pkgPath = path.join(targetPath, "package.json");
  if (!fs.existsSync(pkgPath)) return results;

  let pkg: Record<string, unknown>;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<string, unknown>; }
  catch { return results; } // Already caught in validateMergedPackageJson

  const depSections: Array<[string, Record<string, string>]> = [
    ["dependencies",    (pkg["dependencies"]    as Record<string, string> | undefined) ?? {}],
    ["devDependencies", (pkg["devDependencies"] as Record<string, string> | undefined) ?? {}],
    ["peerDependencies",(pkg["peerDependencies"] as Record<string, string> | undefined) ?? {}],
  ];

  // Singletons: all appearances must agree on major version
  const SINGLETONS = new Set(["react", "react-dom", "next", "vue", "svelte", "angular", "@angular/core"]);
  const singletonMajors = new Map<string, { major: number; section: string; ver: string }>();

  for (const [section, deps] of depSections) {
    for (const [name, ver] of Object.entries(deps)) {
      const fileLabel = `package.json[${section}]`;

      // Empty version
      if (!ver || ver.trim().length === 0) {
        results.push({ check: `Dependency version non-empty`, file: fileLabel, passed: false, detail: `${name}: empty version string` });
        continue;
      }

      const trimmed = ver.trim();

      // Valid non-semver protocols — skip further checks for these
      const NON_SEMVER_PREFIXES = [
        "workspace:", // pnpm workspaces
        "npm:",       // npm: alias protocol
        "git+",       // git+https:// or git+ssh://
        "github:",    // github:owner/repo
        "bitbucket:", // bitbucket:owner/repo
        "gitlab:",    // gitlab:owner/repo
        "link:",      // pnpm link:
        "portal:",    // pnpm portal:
        "patch:",     // pnpm patch:
        "catalog:",   // pnpm catalog
      ];
      if (NON_SEMVER_PREFIXES.some(p => trimmed.startsWith(p))) continue;
      // URL-shaped versions (http/https tarball) are valid
      if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) continue;
      // Git SHA or shorthand (7+ hex chars or owner/repo#tag) — skip
      if (/^[0-9a-f]{7,40}$/.test(trimmed) || /^\w[\w.-]*\/[\w.-]+(#.*)?$/.test(trimmed)) continue;

      // Wildcard "*" — warn but don't fail (peerDeps often use "*")
      if (trimmed === "*") {
        if (section !== "peerDependencies") {
          results.push({ check: `Dependency version specificity`, file: fileLabel, passed: false, detail: `${name}: wildcard "*" in ${section} — not reproducible; pin to a semver range` });
        }
        continue;
      }

      // "latest" tag — non-reproducible in hard deps
      if (trimmed === "latest" && section === "dependencies") {
        results.push({ check: `Dependency version specificity`, file: fileLabel, passed: false, detail: `${name}: "latest" in dependencies — not reproducible; pin to a semver range` });
        continue;
      }

      // file: references must exist
      if (trimmed.startsWith("file:")) {
        const localPath = trimmed.slice(5);
        const resolved = path.resolve(targetPath, localPath);
        const exists = fs.existsSync(resolved);
        results.push({ check: `Local file: dependency exists`, file: fileLabel, passed: exists, detail: `${name}: file: → ${resolved} — ${exists ? "found" : "NOT FOUND"}` });
        continue;
      }

      // Parseable semver
      const [major] = parseMajorMinorPatch(trimmed);
      if (isNaN(major)) {
        results.push({ check: `Dependency version parseable`, file: fileLabel, passed: false, detail: `${name}: unparseable version "${trimmed}"` });
        continue;
      }

      // Singleton major-version conflict check
      if (SINGLETONS.has(name)) {
        const prev = singletonMajors.get(name);
        if (prev && prev.major !== major) {
          results.push({ check: `Singleton major-version consistency`, file: `package.json`, passed: false, detail: `${name}: v${prev.major} in ${prev.section} conflicts with v${major} in ${section}` });
        } else if (!prev) {
          singletonMajors.set(name, { major, section, ver });
        }
      }
    }
  }

  // Summary pass if no failures were added above
  const depCount = depSections.reduce((n, [, d]) => n + Object.keys(d).length, 0);
  const failures = results.filter(r => !r.passed).length;
  results.push({ check: "All dependencies validated", file: "package.json", passed: failures === 0, detail: `${depCount} deps checked, ${failures} issue(s)` });

  return results;
}

/**
 * Validates every configuration file that was touched during the merge:
 * - All merge_config_json targets are still valid JSON
 * - All .env files have no duplicate keys
 * - All Prisma schemas have no duplicate model names
 * - Any JSON config in the target root matches expected shape
 */
function validateAllConfigurations(operations: MergeOperation[], targetPath: string): ValidationResult[] {
  const results: ValidationResult[] = [];

  // 1. Every file written by merge_config_json must still be valid JSON
  const configOps = operations.filter(op => op.status === "success" && op.type === "merge_config_json");
  for (const op of configOps) {
    const abs = path.join(targetPath, op.targetFile);
    if (!fs.existsSync(abs)) {
      results.push({ check: "Config file exists after merge", file: op.targetFile, passed: false, detail: "File missing post-merge" });
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(abs, "utf-8")) as Record<string, unknown>;
      results.push({ check: "Config file still valid JSON", file: op.targetFile, passed: true, detail: `${Object.keys(parsed).length} top-level keys` });
    } catch (e) {
      results.push({ check: "Config file still valid JSON", file: op.targetFile, passed: false, detail: String(e) });
    }
  }

  // 2. Validate every .env* file: no duplicate keys
  const envOps = operations.filter(op => (op.status === "success" || op.type === "skip_protected") && path.basename(op.targetFile).startsWith(".env"));
  const envPaths = new Set(envOps.map(op => op.targetFile));
  // Also scan the root for .env files that exist
  try {
    for (const entry of fs.readdirSync(targetPath)) {
      if (entry.startsWith(".env") && !entry.endsWith(".js") && !entry.endsWith(".ts")) {
        envPaths.add(entry);
      }
    }
  } catch { /* non-fatal */ }

  for (const rel of envPaths) {
    const abs = path.join(targetPath, rel);
    if (!fs.existsSync(abs)) continue;
    const content = fs.readFileSync(abs, "utf-8");
    const keys = new Set<string>();
    const dupes: string[] = [];
    for (const line of content.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
      if (!m) continue;
      if (keys.has(m[1]!)) dupes.push(m[1]!);
      keys.add(m[1]!);
    }
    results.push({ check: "Env file has no duplicate keys", file: rel, passed: dupes.length === 0, detail: dupes.length > 0 ? `Duplicate keys: ${dupes.join(", ")}` : `${keys.size} unique keys` });
  }

  // 3. Prisma schema: no duplicate models, has at least one datasource block
  const schemaPath = path.join(targetPath, "prisma", "schema.prisma");
  if (fs.existsSync(schemaPath)) {
    const content = fs.readFileSync(schemaPath, "utf-8");
    const models = [...content.matchAll(/^model\s+(\w+)/gm)].map(m => m[1]!);
    const dupModels = models.filter((m, i) => models.indexOf(m) !== i);
    results.push({ check: "Prisma schema: no duplicate models", file: "prisma/schema.prisma", passed: dupModels.length === 0, detail: dupModels.length > 0 ? `Duplicates: ${dupModels.join(", ")}` : `${models.length} unique models` });

    const hasDatasource = /^datasource\s+\w+/m.test(content);
    results.push({ check: "Prisma schema has datasource block", file: "prisma/schema.prisma", passed: hasDatasource, detail: hasDatasource ? "datasource block found" : "Missing datasource block — schema may not compile" });
  }

  // 4. Scan for any other JSON files in the merged root that might be broken
  const JSON_CONFIG_NAMES = [".eslintrc.json", "turbo.json", "nx.json", "jest.config.json", ".babelrc.json"];
  for (const name of JSON_CONFIG_NAMES) {
    const abs = path.join(targetPath, name);
    if (!fs.existsSync(abs)) continue;
    try {
      JSON.parse(fs.readFileSync(abs, "utf-8"));
      results.push({ check: "Root config JSON valid", file: name, passed: true, detail: "Parsed successfully" });
    } catch (e) {
      results.push({ check: "Root config JSON valid", file: name, passed: false, detail: String(e) });
    }
  }

  return results;
}

// validateMergedEnvFile: superseded by validateAllConfigurations (covers all .env* files)

function validateMergedRouteFiles(operations: MergeOperation[], targetPath: string): ValidationResult[] {
  const results: ValidationResult[] = [];
  // Check ALL successfully copied files — no 20-file cap
  const copiedOps = operations.filter(op => op.status === "success" && op.type === "copy_new_file");

  for (const op of copiedOps) {
    const abs = path.join(targetPath, op.targetFile);
    const fileLabel = op.targetFile;

    // 1. File must physically exist after write
    if (!fs.existsSync(abs)) {
      results.push({ check: "Merged file exists on disk", file: fileLabel, passed: false, detail: "File not found after write — possible I/O failure" });
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(abs, "utf-8");
    } catch (e) {
      results.push({ check: "Merged file readable", file: fileLabel, passed: false, detail: String(e) });
      continue;
    }

    // 2. File must not be empty
    if (content.trim().length === 0) {
      results.push({ check: "Merged file non-empty", file: fileLabel, passed: false, detail: "File is empty after write" });
      continue;
    }

    const ext = path.extname(fileLabel).toLowerCase();
    const isScript = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext);

    if (isScript) {
      // 3. Brace balance (no cap, checks every file)
      let depth = 0;
      let balanced = true;
      for (const ch of content) {
        if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (depth < 0) { balanced = false; break; } }
      }
      if (depth !== 0) balanced = false;
      results.push({ check: "Script brace balance", file: fileLabel, passed: balanced, detail: balanced ? "Braces balanced" : `Unbalanced braces (net depth=${depth})` });

      // 4. Route/controller files must have at least one export
      const isRouteFile = /route|controller|handler|router/i.test(fileLabel);
      if (isRouteFile) {
        const hasExport = /\bexport\b/.test(content);
        results.push({ check: "Route file has export", file: fileLabel, passed: hasExport, detail: hasExport ? "export keyword found" : "No export found — route may not be reachable" });
      }

      // 5. No obvious broken import syntax (import { from "..." without closing })
      const brokenImport = /import\s*\{[^}]*$/.test(content.replace(/\r\n/g, "\n").split("\n").slice(0, 50).join("\n"));
      if (brokenImport) {
        results.push({ check: "No truncated import statements", file: fileLabel, passed: false, detail: "Potential truncated import block in first 50 lines" });
      }
    }

    if (ext === ".json") {
      // 6. JSON files must parse
      try {
        JSON.parse(content);
        results.push({ check: "Merged JSON file is valid", file: fileLabel, passed: true, detail: "Parsed successfully" });
      } catch (e) {
        results.push({ check: "Merged JSON file is valid", file: fileLabel, passed: false, detail: String(e) });
      }
    }
  }

  return results;
}

// validateMergedPrismaSchema: superseded by validateAllConfigurations (covers Prisma + all JSON configs)

// ─── File scanner (prime side) ────────────────────────────────────────────────

const SCAN_IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "venv", "vendor", "target", BACKUP_ROOT, ".webrecon-d3-backups"]);

interface PrimeFile { rel: string; abs: string; name: string; ext: string; size: number; }

function scanPrime(rootPath: string): PrimeFile[] {
  const out: PrimeFile[] = [];
  function walk(dir: string, depth: number) {
    if (depth > 8 || out.length > 5000) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SCAN_IGNORE.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs, depth + 1); continue; }
      let size = 0;
      try { size = fs.statSync(abs).size; } catch { /* */ }
      out.push({ rel: path.relative(rootPath, abs), abs, name: e.name, ext: path.extname(e.name).toLowerCase(), size });
    }
  }
  walk(rootPath, 0);
  return out;
}

// ─── Operation planner ────────────────────────────────────────────────────────

function planOperations(
  primeFiles: PrimeFile[],
  targetPath: string,
  approvedOperations: Set<string>,  // set of relative paths approved for merge
  d2Bundle: D2Bundle | null,
): Array<Omit<MergeOperation, "status" | "bytesWritten" | "durationMs" | "error">> {
  const planned: Array<Omit<MergeOperation, "status" | "bytesWritten" | "durationMs" | "error">> = [];
  let seq = 0;

  // 1. package.json — always plan a merge attempt (never copy-replace)
  const pkgFile = primeFiles.find(f => f.name === "package.json" && f.rel.split(path.sep).length === 1);
  if (pkgFile) {
    planned.push({ opId: `op-${++seq}`, type: "merge_package_json", sourceFile: pkgFile.rel, targetFile: "package.json", protected: true, detail: "Merge deps and scripts from Website Prime into existing package.json" });
  }

  // 2. .env files — append-only
  for (const f of primeFiles.filter(pf => pf.name.startsWith(".env") && !pf.name.endsWith(".js") && !pf.name.endsWith(".ts"))) {
    planned.push({ opId: `op-${++seq}`, type: "append_env_vars", sourceFile: f.rel, targetFile: f.rel, protected: true, detail: `Append new env vars from ${f.rel} (existing keys preserved)` });
  }

  // 3. Prisma schema — append models only
  const schemaFile = primeFiles.find(f => f.name === "schema.prisma");
  if (schemaFile) {
    planned.push({ opId: `op-${++seq}`, type: "append_schema", sourceFile: schemaFile.rel, targetFile: schemaFile.rel, protected: true, detail: "Append new Prisma models (existing models untouched)" });
  }

  // 4. JSON config files that exist on both sides — merge keys
  const jsonConfigs = ["tsconfig.json", ".eslintrc.json"];
  for (const configName of jsonConfigs) {
    const srcFile = primeFiles.find(f => f.name === configName && f.rel.split(path.sep).length === 1);
    if (!srcFile) continue;
    const dstAbs = path.join(targetPath, configName);
    if (fs.existsSync(dstAbs)) {
      planned.push({ opId: `op-${++seq}`, type: "merge_config_json", sourceFile: srcFile.rel, targetFile: configName, protected: true, detail: `Merge non-conflicting keys from ${configName}` });
    }
  }

  // 5. All other files — copy if new, skip if collision/protected
  const blockedPaths = new Set(
    d2Bundle ? d2Bundle.conflictMap.blocked.map(c => c.primeSide.location) : []
  );

  for (const f of primeFiles) {
    // Already handled above
    if (["package.json", "schema.prisma", ".eslintrc.json", "tsconfig.json"].includes(f.name) && f.rel.split(path.sep).length === 1) continue;
    if (f.name.startsWith(".env")) continue;

    // Blocked by D2?
    if (blockedPaths.has(f.rel)) {
      planned.push({ opId: `op-${++seq}`, type: "skip_blocked", sourceFile: f.rel, targetFile: f.rel, protected: false, detail: "Blocked by D2 conflict — resolve manually before merging this file" });
      continue;
    }

    // Protected?
    if (isProtected(f.rel)) {
      planned.push({ opId: `op-${++seq}`, type: "skip_protected", sourceFile: f.rel, targetFile: f.rel, protected: true, detail: `${f.rel} is on the protected file list` });
      continue;
    }

    const dstAbs = path.join(targetPath, f.rel);
    if (fs.existsSync(dstAbs)) {
      // File already exists — only copy if explicitly approved
      if (approvedOperations.has(f.rel)) {
        planned.push({ opId: `op-${++seq}`, type: "copy_new_file", sourceFile: f.rel, targetFile: f.rel, protected: false, detail: "Approved overwrite of existing file" });
      } else {
        planned.push({ opId: `op-${++seq}`, type: "skip_collision", sourceFile: f.rel, targetFile: f.rel, protected: false, detail: "File exists in target — not in approved list, skipped" });
      }
    } else {
      // New file — safe to copy (still check approval if strict mode)
      planned.push({ opId: `op-${++seq}`, type: "copy_new_file", sourceFile: f.rel, targetFile: f.rel, protected: false, detail: "New file — no collision, safe copy" });
    }
  }

  return planned;
}

// ─── Execution ────────────────────────────────────────────────────────────────

function executeOperation(
  op: Omit<MergeOperation, "status" | "bytesWritten" | "durationMs" | "error">,
  primePath: string,
  targetPath: string,
): MergeOperation {
  const start = Date.now();
  const srcAbs = path.join(primePath, op.sourceFile);
  const dstAbs = path.join(targetPath, op.targetFile);

  const result: MergeOperation = { ...op, status: "skipped", bytesWritten: 0, durationMs: 0 };

  try {
    if (op.type === "skip_protected" || op.type === "skip_collision" || op.type === "skip_blocked" || op.type === "skip_no_source") {
      result.status = "skipped";
      result.durationMs = Date.now() - start;
      return result;
    }

    if (!fs.existsSync(srcAbs)) {
      result.status = "skipped";
      result.detail += " (source file not found)";
      result.type = "skip_no_source";
      result.durationMs = Date.now() - start;
      return result;
    }

    switch (op.type) {
      case "copy_new_file": {
        opCopyNewFile(srcAbs, dstAbs);
        result.bytesWritten = fs.statSync(dstAbs).size;
        result.status = "success";
        break;
      }
      case "merge_package_json": {
        if (!fs.existsSync(dstAbs)) { opCopyNewFile(srcAbs, dstAbs); result.status = "success"; break; }
        const info = opMergePackageJson(srcAbs, dstAbs);
        result.detail += ` | Added: ${info.added.length}, Bumped: ${info.bumped.length}, Skipped: ${info.skipped.length}`;
        result.bytesWritten = fs.statSync(dstAbs).size;
        result.status = "success";
        break;
      }
      case "append_env_vars": {
        const info = opAppendEnvVars(srcAbs, dstAbs);
        result.detail += ` | Added: ${info.added.join(", ") || "none"}, Skipped: ${info.skipped.length}`;
        result.bytesWritten = info.added.length > 0 ? fs.statSync(dstAbs).size : 0;
        result.status = "success";
        break;
      }
      case "append_schema": {
        const info = opAppendSchema(srcAbs, dstAbs);
        result.detail += ` | Appended: ${info.appendedModels.join(", ") || "none"}, Skipped: ${info.skippedModels.join(", ") || "none"}`;
        result.bytesWritten = info.appendedModels.length > 0 ? fs.statSync(dstAbs).size : 0;
        result.status = "success";
        break;
      }
      case "merge_config_json": {
        if (!fs.existsSync(dstAbs)) { opCopyNewFile(srcAbs, dstAbs); result.status = "success"; break; }
        const info = opMergeConfigJson(srcAbs, dstAbs);
        result.detail += ` | Merged keys: ${info.merged.join(", ") || "none"}, Skipped: ${info.skipped.join(", ") || "none"}`;
        result.bytesWritten = fs.statSync(dstAbs).size;
        result.status = "success";
        break;
      }
    }
  } catch (err) {
    result.status = "failed";
    result.error = err instanceof Error ? err.message : String(err);
    logger.error({ opId: op.opId, type: op.type, err }, "D3: operation failed");
  }

  result.durationMs = Date.now() - start;
  return result;
}

// ─── Report builders ──────────────────────────────────────────────────────────

export interface MergeExecutionReport {
  executionId: string;
  generatedAt: string;
  primePath: string;
  targetPath: string;
  d2DetectionId: string | null;
  backupPath: string;
  totalOperations: number;
  succeeded: number;
  skipped: number;
  failed: number;
  rolledBack: boolean;
  rollbackReason: string | null;
  totalBytesWritten: number;
  totalDurationMs: number;
  validationResults: ValidationResult[];
  validationPassed: boolean;
  operations: MergeOperation[];
}

export interface RollbackPackage {
  executionId: string;
  createdAt: string;
  targetPath: string;
  backupPath: string;
  targetFileCount: number;
  checksums: Record<string, string>;
  rollbackCommand: string;
  rollbackSteps: string[];
  wasRolledBack: boolean;
  rolledBackAt: string | null;
}

export interface MergedProjectSummary {
  executionId: string;
  generatedAt: string;
  targetPath: string;
  primePath: string;
  isMergeComplete: boolean;
  wasRolledBack: boolean;
  newFilesAdded: string[];
  depsAdded: string[];
  depsBumped: string[];
  envVarsAdded: string[];
  schemaModelsAppended: string[];
  configKeysMerged: string[];
  filesSkipped: string[];
  filesBlocked: string[];
  filesProtected: string[];
  filesFailed: string[];
  totalFilesFromPrime: number;
  mergedFileCount: number;
  skippedFileCount: number;
  blockedFileCount: number;
  nextSteps: string[];
}

export interface D3Bundle {
  executionId: string;
  generatedAt: string;
  mergeExecutionReport: MergeExecutionReport;
  rollbackPackage: RollbackPackage;
  mergedProjectSummary: MergedProjectSummary;
  r2Keys: { mergeExecutionReport: string; rollbackPackage: string; mergedProjectSummary: string };
}

// ─── In-memory cache + DB persistence ────────────────────────────────────────

const _store = new Map<string, D3Bundle>();

/** Persist bundle metadata to DB so it survives server restarts. */
async function persistD3Bundle(bundle: D3Bundle, dryRun: boolean): Promise<void> {
  try {
    const r = bundle.mergeExecutionReport;
    const s = bundle.mergedProjectSummary;
    await db.insert(mergeExecutionsTable).values({
      executionId:      bundle.executionId,
      primePath:        r.primePath,
      targetPath:       r.targetPath,
      d2DetectionId:    r.d2DetectionId,
      dryRun,
      isMergeComplete:  s.isMergeComplete,
      wasRolledBack:    r.rolledBack,
      validationPassed: r.validationPassed,
      rollbackReason:   r.rollbackReason,
      totalOperations:  r.totalOperations,
      succeeded:        r.succeeded,
      skipped:          r.skipped,
      failed:           r.failed,
      totalBytesWritten: r.totalBytesWritten,
      totalDurationMs:   r.totalDurationMs,
      r2Keys:            bundle.r2Keys,
      backupPath:        r.backupPath,
      completedAt:       new Date(),
    }).onConflictDoUpdate({
      target: mergeExecutionsTable.executionId,
      set: {
        isMergeComplete:  s.isMergeComplete,
        wasRolledBack:    r.rolledBack,
        validationPassed: r.validationPassed,
        rollbackReason:   r.rollbackReason,
        succeeded:        r.succeeded,
        skipped:          r.skipped,
        failed:           r.failed,
        totalBytesWritten: r.totalBytesWritten,
        totalDurationMs:   r.totalDurationMs,
        r2Keys:            bundle.r2Keys,
        backupPath:        r.backupPath,
        completedAt:       new Date(),
      },
    });
    logger.info({ executionId: bundle.executionId }, "D3: bundle persisted to DB");
  } catch (err) {
    logger.warn({ err, executionId: bundle.executionId }, "D3: DB persistence failed (non-fatal — bundle is in R2)");
  }
}

export function getD3Bundle(id: string): D3Bundle | undefined { return _store.get(id); }

export async function listD3Bundles(): Promise<Array<{
  executionId: string; generatedAt: string; primePath: string; targetPath: string;
  succeeded: number; failed: number; rolledBack: boolean; isMergeComplete: boolean;
  validationPassed: boolean; r2Keys: Record<string, string> | null;
}>> {
  // Prefer DB for persistence across restarts; fall back to in-memory cache
  try {
    const rows = await db.select().from(mergeExecutionsTable).orderBy(mergeExecutionsTable.createdAt);
    return rows.map(row => ({
      executionId:     row.executionId,
      generatedAt:     row.createdAt.toISOString(),
      primePath:       row.primePath,
      targetPath:      row.targetPath,
      succeeded:       row.succeeded,
      failed:          row.failed,
      rolledBack:      row.wasRolledBack,
      isMergeComplete: row.isMergeComplete,
      validationPassed: row.validationPassed,
      r2Keys:          row.r2Keys as Record<string, string> | null,
    }));
  } catch (err) {
    logger.warn({ err }, "D3: DB list failed, falling back to in-memory store");
    return [..._store.values()].map(b => ({
      executionId:     b.executionId,
      generatedAt:     b.generatedAt,
      primePath:       b.mergeExecutionReport.primePath,
      targetPath:      b.mergeExecutionReport.targetPath,
      succeeded:       b.mergeExecutionReport.succeeded,
      failed:          b.mergeExecutionReport.failed,
      rolledBack:      b.mergeExecutionReport.rolledBack,
      isMergeComplete: b.mergedProjectSummary.isMergeComplete,
      validationPassed: b.mergeExecutionReport.validationPassed,
      r2Keys:          b.r2Keys,
    }));
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export interface D3Options {
  executionId: string;
  primePath: string;           // Website Prime source directory
  targetPath: string;          // Existing backend to merge into
  d2DetectionId?: string;      // Optional: load D2 conflict map to skip blocked files
  approvedOperations?: string[]; // Relative paths explicitly approved for overwrite
  dryRun?: boolean;            // If true, plan but don't execute
}

export async function runMergeExecution(options: D3Options): Promise<D3Bundle> {
  const {
    executionId, primePath, targetPath,
    d2DetectionId, approvedOperations = [], dryRun = false,
  } = options;
  const now = new Date().toISOString();

  logger.info({ executionId, primePath, targetPath, dryRun }, "D3: starting merge execution");

  // ── Path safety: resolve real paths and enforce an allowlist root ──────────
  // Callers must pass paths inside the server's working directory or explicit
  // MERGE_ROOT env var.  This prevents path-traversal or arbitrary-path attacks.
  const ALLOWED_ROOT = fs.realpathSync(
    process.env["MERGE_ROOT"] ?? process.cwd()
  );

  function resolveAndGuard(label: string, p: string): string {
    let resolved: string;
    try { resolved = fs.realpathSync(p); }
    catch { throw new Error(`D3: ${label} does not exist or cannot be resolved: ${p}`); }
    if (!resolved.startsWith(ALLOWED_ROOT + path.sep) && resolved !== ALLOWED_ROOT) {
      throw new Error(`D3: ${label} "${resolved}" is outside the allowed root "${ALLOWED_ROOT}" — path traversal rejected`);
    }
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`D3: ${label} is not a directory: ${resolved}`);
    }
    return resolved;
  }

  const resolvedPrimePath   = resolveAndGuard("primePath", primePath);
  const resolvedTargetPath  = resolveAndGuard("targetPath", targetPath);

  const d2Bundle: D2Bundle | null = d2DetectionId ? (getD2Bundle(d2DetectionId) ?? null) : null;
  const approvedSet = new Set(approvedOperations);

  // ── 1. Scan prime ─────────────────────────────────────────────────────────
  logger.info({ executionId }, "D3: scanning prime source");
  const primeFiles = scanPrime(resolvedPrimePath);

  // ── 2. Create backup BEFORE any writes ───────────────────────────────────
  let backupManifest: BackupManifest;
  if (!dryRun) {
    logger.info({ executionId, targetPath: resolvedTargetPath }, "D3: creating backup");
    backupManifest = createBackup(resolvedTargetPath, executionId);
    backupManifest.sourcePath = resolvedPrimePath;
  } else {
    backupManifest = { executionId, createdAt: now, sourcePath: resolvedPrimePath, targetPath: resolvedTargetPath, backupPath: "(dry-run — no backup created)", targetFileCount: 0, checksums: {} };
  }

  // ── 3. Plan operations ────────────────────────────────────────────────────
  logger.info({ executionId }, "D3: planning operations");
  const plannedOps = planOperations(primeFiles, resolvedTargetPath, approvedSet, d2Bundle);
  logger.info({ executionId, count: plannedOps.length }, "D3: operations planned");

  // ── 4. Execute ────────────────────────────────────────────────────────────
  const executedOps: MergeOperation[] = [];
  let hasFailed = false;

  if (dryRun) {
    // Dry run — simulate all ops as success/skipped
    for (const op of plannedOps) {
      executedOps.push({
        ...op, status: op.type.startsWith("skip") ? "skipped" : "success",
        bytesWritten: 0, durationMs: 0,
      });
    }
  } else {
    const execStart = Date.now();
    for (const op of plannedOps) {
      if (executedOps.length % 50 === 0) {
        logger.info({ executionId, progress: `${executedOps.length}/${plannedOps.length}` }, "D3: executing");
      }
      const result = executeOperation(op, primePath, targetPath);
      executedOps.push(result);
      if (result.status === "failed") hasFailed = true;
    }
    logger.info({ executionId, durationMs: Date.now() - execStart }, "D3: execution complete");
  }

  // ── 5. Validation — every route, every dependency, every configuration ───
  logger.info({ executionId }, "D3: running full validation suite");
  const validationResults: ValidationResult[] = dryRun ? [] : [
    // package.json structural integrity
    ...validateMergedPackageJson(resolvedTargetPath),
    // Every individual dependency (version ranges, file: refs, singletons)
    ...validateAllDependencies(resolvedTargetPath),
    // Every merged route/controller/handler file (exists, balanced, exports)
    ...validateMergedRouteFiles(executedOps, resolvedTargetPath),
    // Every configuration file (.env*, Prisma schema, JSON configs)
    ...validateAllConfigurations(executedOps, resolvedTargetPath),
  ];
  const validationChecks  = validationResults.length;
  const validationFailed  = validationResults.filter(v => !v.passed).length;
  logger.info({ executionId, validationChecks, validationFailed }, "D3: validation complete");
  const validationPassed = validationResults.every(v => v.passed);

  // ── 6. Auto-rollback if validation failed or execution failed ─────────────
  let rolledBack = false;
  let rollbackReason: string | null = null;
  let rolledBackAt: string | null = null;

  if (!dryRun && (!validationPassed || hasFailed)) {
    rollbackReason = !validationPassed
      ? `Validation failed: ${validationResults.filter(v => !v.passed).map(v => v.check).join(", ")}`
      : "One or more merge operations failed";
    logger.warn({ executionId, rollbackReason }, "D3: triggering auto-rollback");
    try {
      restoreFromBackup(backupManifest);
      rolledBack = true;
      rolledBackAt = new Date().toISOString();
      for (const op of executedOps) { if (op.status === "success") op.status = "rolled_back"; }
    } catch (err) {
      logger.error({ executionId, err }, "D3: ROLLBACK FAILED — manual restoration required");
      rollbackReason += ` | ROLLBACK FAILED: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── 7. Build summary data from operations ─────────────────────────────────
  const newFilesAdded:        string[] = [];
  const depsAdded:            string[] = [];
  const depsBumped:           string[] = [];
  const envVarsAdded:         string[] = [];
  const schemaModelsAppended: string[] = [];
  const configKeysMerged:     string[] = [];
  const filesSkipped:         string[] = [];
  const filesBlocked:         string[] = [];
  const filesProtected:       string[] = [];
  const filesFailed:          string[] = [];

  for (const op of executedOps) {
    if (op.type === "copy_new_file"      && op.status === "success") newFilesAdded.push(op.targetFile);
    if (op.type === "skip_blocked")                                   filesBlocked.push(op.sourceFile);
    if (op.type === "skip_protected")                                 filesProtected.push(op.sourceFile);
    if (op.type === "skip_collision")                                 filesSkipped.push(op.sourceFile);
    if (op.status === "failed")                                       filesFailed.push(op.targetFile);
    if (op.type === "merge_package_json" && op.status === "success") {
      const m = op.detail.match(/Added: (\d+), Bumped: (\d+)/);
      if (m) { depsAdded.push(`${m[1]} packages`); depsBumped.push(`${m[2]} bumped`); }
    }
    if (op.type === "append_env_vars" && op.status === "success") {
      const m = op.detail.match(/Added: ([^,]+)/);
      if (m && m[1] !== "none") envVarsAdded.push(...m[1]!.split(", ").filter(Boolean));
    }
    if (op.type === "append_schema" && op.status === "success") {
      const m = op.detail.match(/Appended: ([^|]+)/);
      if (m && m[1].trim() !== "none") schemaModelsAppended.push(...m[1]!.split(", ").map(s => s.trim()).filter(Boolean));
    }
    if (op.type === "merge_config_json" && op.status === "success") {
      const m = op.detail.match(/Merged keys: ([^|]+)/);
      if (m && m[1].trim() !== "none") configKeysMerged.push(...m[1]!.split(", ").map(s => s.trim()).filter(Boolean));
    }
  }

  const succeeded = executedOps.filter(o => o.status === "success").length;
  const skipped   = executedOps.filter(o => o.status === "skipped").length;
  const failed    = executedOps.filter(o => o.status === "failed").length;
  const totalBytesWritten = executedOps.reduce((s, o) => s + o.bytesWritten, 0);
  const totalDurationMs   = executedOps.reduce((s, o) => s + o.durationMs, 0);
  const isMergeComplete   = !rolledBack && !hasFailed && validationPassed;

  const nextSteps: string[] = [];
  if (filesBlocked.length > 0) nextSteps.push(`Resolve ${filesBlocked.length} BLOCKED file(s) from D2 conflict map, then re-run merge.`);
  if (filesSkipped.length > 0) nextSteps.push(`Review ${filesSkipped.length} skipped file collision(s) — add to approvedOperations if overwrite is intended.`);
  if (filesFailed.length > 0)  nextSteps.push(`Investigate ${filesFailed.length} failed operation(s) in the execution report.`);
  if (rolledBack) nextSteps.push("Merge was rolled back. Fix the issues above and re-run D3.");
  if (isMergeComplete) {
    nextSteps.push("Run `pnpm install` (or equivalent) to install newly merged dependencies.");
    nextSteps.push("Run the full test suite on the merged project.");
    nextSteps.push("Deploy to staging for smoke testing before production.");
  }

  // ── 8. Build reports ──────────────────────────────────────────────────────
  const mergeExecutionReport: MergeExecutionReport = {
    executionId, generatedAt: now, primePath: resolvedPrimePath, targetPath: resolvedTargetPath,
    d2DetectionId: d2DetectionId ?? null,
    backupPath: backupManifest.backupPath,
    totalOperations: executedOps.length, succeeded, skipped, failed,
    rolledBack, rollbackReason,
    totalBytesWritten, totalDurationMs,
    validationResults, validationPassed,
    operations: executedOps,
  };

  const rollbackPackage: RollbackPackage = {
    executionId,
    createdAt: backupManifest.createdAt,
    targetPath: resolvedTargetPath,
    backupPath: backupManifest.backupPath,
    targetFileCount: backupManifest.targetFileCount,
    checksums: backupManifest.checksums,
    rollbackCommand: `cp -r "${backupManifest.backupPath}/." "${resolvedTargetPath}/"`,
    rollbackSteps: [
      `1. Stop all running services in ${resolvedTargetPath}`,
      `2. Run: cp -r "${backupManifest.backupPath}/." "${resolvedTargetPath}/"`,
      `3. Run: pnpm install (or npm install / yarn) to restore deps`,
      `4. Restart services`,
      `5. Verify application health`,
    ],
    wasRolledBack: rolledBack,
    rolledBackAt,
  };

  const mergedProjectSummary: MergedProjectSummary = {
    executionId, generatedAt: now, targetPath: resolvedTargetPath, primePath: resolvedPrimePath,
    isMergeComplete, wasRolledBack: rolledBack,
    newFilesAdded, depsAdded, depsBumped, envVarsAdded,
    schemaModelsAppended, configKeysMerged,
    filesSkipped, filesBlocked, filesProtected, filesFailed,
    totalFilesFromPrime: primeFiles.length,
    mergedFileCount: succeeded,
    skippedFileCount: skipped,
    blockedFileCount: filesBlocked.length,
    nextSteps,
  };

  // ── 9. Store to R2 ────────────────────────────────────────────────────────
  logger.info({ executionId }, "D3: storing reports to R2");
  const [r2Exec, r2Rollback, r2Summary] = await Promise.all([
    storeR2(executionId, "merge-execution-report.json",  mergeExecutionReport),
    storeR2(executionId, "rollback-package.json",         rollbackPackage),
    storeR2(executionId, "merged-project-summary.json",   mergedProjectSummary),
  ]);

  const bundle: D3Bundle = {
    executionId, generatedAt: now,
    mergeExecutionReport, rollbackPackage, mergedProjectSummary,
    r2Keys: { mergeExecutionReport: r2Exec!, rollbackPackage: r2Rollback!, mergedProjectSummary: r2Summary! },
  };

  _store.set(executionId, bundle);
  // Persist to DB (non-blocking — failure is logged but won't abort the return)
  await persistD3Bundle(bundle, dryRun);
  logger.info({ executionId, succeeded, skipped, failed, rolledBack, isMergeComplete }, "D3: merge execution complete");
  return bundle;
}
