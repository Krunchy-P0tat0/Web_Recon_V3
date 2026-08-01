import type { DatabaseProfile, DatabaseKind } from "./types.js";

type Vfs = Record<string, string>;

function nodeDeps(vfs: Vfs): Record<string, string> {
  try {
    const pkg = JSON.parse(vfs["package.json"] ?? vfs["./package.json"] ?? "{}") as Record<string, unknown>;
    return {
      ...((pkg["dependencies"]    as Record<string, string>) ?? {}),
      ...((pkg["devDependencies"] as Record<string, string>) ?? {}),
    };
  } catch { return {}; }
}

function fileContent(vfs: Vfs, ...paths: string[]): string {
  for (const p of paths) {
    if (p in vfs)        return vfs[p]!;
    if (`./${p}` in vfs) return vfs[`./${p}`]!;
  }
  return "";
}

// ─── VFS-based detection ──────────────────────────────────────────────────────

function detectFromVfs(vfs: Vfs, d: Record<string, string>): {
  kind: DatabaseKind; signals: string[]; orm: string | null
} {
  const signals: string[] = [];
  let kind: DatabaseKind  = "unknown";
  let orm: string | null  = null;

  // ORM detection
  if ("drizzle-orm" in d) { orm = "drizzle"; signals.push("drizzle-orm in deps"); }
  else if ("prisma" in d || "@prisma/client" in d) { orm = "prisma"; signals.push("prisma in deps"); }
  else if ("sequelize" in d) { orm = "sequelize"; signals.push("sequelize in deps"); }
  else if ("mongoose" in d) { orm = "mongoose"; signals.push("mongoose in deps"); kind = "mongodb"; }

  // Database client detection
  if ("pg" in d || "@neondatabase/serverless" in d || "postgres" in d) {
    kind = "postgres"; signals.push("postgres client in deps");
  } else if ("mysql2" in d || "mysql" in d) {
    kind = "mysql"; signals.push("mysql2 in deps");
  } else if ("better-sqlite3" in d || "sqlite3" in d) {
    kind = "sqlite"; signals.push("sqlite3 in deps");
  } else if ("mongodb" in d || "mongoose" in d) {
    kind = "mongodb"; signals.push("mongodb client in deps");
  }

  // Config file detection
  const drizzleConfig = fileContent(vfs, "drizzle.config.ts", "drizzle.config.js");
  if (drizzleConfig.includes("postgres") || drizzleConfig.includes("pg")) {
    if (kind === "unknown") kind = "postgres";
    signals.push("drizzle.config points to postgres");
    if (!orm) orm = "drizzle";
  }

  // Python requirements
  const req = fileContent(vfs, "requirements.txt", "requirements/base.txt");
  if (req.includes("psycopg") || req.includes("psycopg2") || req.includes("asyncpg")) {
    kind = "postgres"; signals.push("psycopg in requirements.txt");
  } else if (req.includes("mysqlclient") || req.includes("PyMySQL")) {
    kind = "mysql"; signals.push("mysql client in requirements.txt");
  } else if (req.includes("pymongo") || req.includes("motor")) {
    kind = "mongodb"; signals.push("pymongo in requirements.txt");
  }

  // Gemfile (Rails)
  const gemfile = fileContent(vfs, "Gemfile");
  if (gemfile.includes("pg") || gemfile.includes("activerecord-postgresql")) {
    kind = "postgres"; signals.push("pg gem in Gemfile");
  } else if (gemfile.includes("mysql2")) {
    kind = "mysql"; signals.push("mysql2 gem in Gemfile");
  } else if (gemfile.includes("sqlite3")) {
    kind = "sqlite"; signals.push("sqlite3 gem in Gemfile");
  }

  return { kind, signals, orm };
}

// ─── Environment-based detection ──────────────────────────────────────────────

function detectFromEnv(): { kind: DatabaseKind; signals: string[]; connectionEnvVar: string | null; migrationCommand: string | null } {
  const url = process.env["DATABASE_URL"] ?? "";

  let kind: DatabaseKind = "none";
  let connectionEnvVar: string | null = null;
  let migrationCommand: string | null = null;
  const signals: string[] = [];

  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    kind = "postgres"; connectionEnvVar = "DATABASE_URL";
    migrationCommand = "pnpm --filter @workspace/db run push";
    signals.push("postgres:// in DATABASE_URL");
  } else if (url.startsWith("mysql://") || url.startsWith("mysql2://")) {
    kind = "mysql"; connectionEnvVar = "DATABASE_URL";
    signals.push("mysql:// in DATABASE_URL");
  } else if (url.startsWith("mongodb://") || url.startsWith("mongodb+srv://")) {
    kind = "mongodb"; connectionEnvVar = "DATABASE_URL";
    signals.push("mongodb:// in DATABASE_URL");
  } else if (url.includes(".sqlite") || url.includes("file:")) {
    kind = "sqlite"; connectionEnvVar = "DATABASE_URL";
    signals.push("sqlite in DATABASE_URL");
  }

  return { kind, signals, connectionEnvVar, migrationCommand };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function detectDatabase(vfs: Vfs): DatabaseProfile {
  const d       = nodeDeps(vfs);
  const fromVfs = detectFromVfs(vfs, d);
  const fromEnv = detectFromEnv();

  // Env takes precedence for kind (runtime truth), VFS supplements
  const kind: DatabaseKind = fromEnv.kind !== "none" ? fromEnv.kind
    : fromVfs.kind !== "unknown" ? fromVfs.kind
    : "none";

  const detected  = kind !== "none" && kind !== "unknown";
  const signals   = [...new Set([...fromVfs.signals, ...fromEnv.signals])];

  return {
    primary:          kind,
    detected,
    orm:              fromVfs.orm,
    connectionEnvVar: fromEnv.connectionEnvVar,
    migrationCommand: fromEnv.migrationCommand,
    signals,
  };
}
