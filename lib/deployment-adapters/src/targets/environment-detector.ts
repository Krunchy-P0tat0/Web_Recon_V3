/**
 * environment-detector.ts — Phase 6.1
 *
 * Inspects the current runtime environment to produce an EnvironmentProfile:
 *   - What hosting environment is this running in?
 *   - What database is configured?
 *   - What object storage is configured?
 *   - What env vars exist and which are missing?
 */

import type {
  EnvironmentProfile,
  DatabaseProfile,
  StorageProfile,
  EnvVarEntry,
  HostingEnv,
  DatabaseKind,
  StorageKind,
} from "./types.js";

// ── Hosting Detection ─────────────────────────────────────────────────────────

function detectHosting(): HostingEnv {
  if (process.env["REPL_ID"] || process.env["REPLIT_DEPLOYMENT"])      return "replit";
  if (process.env["VERCEL"] || process.env["VERCEL_ENV"])               return "vercel";
  if (process.env["CF_PAGES"] || process.env["CLOUDFLARE_WORKER"])      return "cloudflare";
  if (process.env["RAILWAY_ENVIRONMENT"])                                return "railway";
  if (process.env["RENDER"])                                             return "render";
  if (process.env["DOCKER_CONTAINER"] || process.env["container"])      return "docker";
  return "unknown";
}

// ── Database Detection ────────────────────────────────────────────────────────

function detectDatabase(): DatabaseProfile {
  const url = process.env["DATABASE_URL"] ?? "";

  let kind: DatabaseKind = "none";
  let detected = false;
  let migrationCommand: string | null = null;

  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    kind = "postgres";
    detected = true;
    migrationCommand = "pnpm --filter @workspace/db run push";
  } else if (url.startsWith("mysql://") || url.startsWith("mysql2://")) {
    kind = "mysql";
    detected = true;
  } else if (url.startsWith("mongodb://") || url.startsWith("mongodb+srv://")) {
    kind = "mongodb";
    detected = true;
  } else if (url.includes(".sqlite") || url.includes("file:")) {
    kind = "sqlite";
    detected = true;
  }

  return {
    kind,
    detected,
    connectionEnvVar: detected ? "DATABASE_URL" : null,
    migrationCommand,
    notes: detected
      ? [`${kind} detected via DATABASE_URL`, "Ensure the database is provisioned before deploying"]
      : ["No database configured — app will run stateless"],
  };
}

// ── Storage Detection ─────────────────────────────────────────────────────────

function detectStorage(): StorageProfile {
  const cloudProvider = process.env["CLOUD_PROVIDER"] ?? "";
  const r2AccountId  = process.env["R2_ACCOUNT_ID"]  ?? "";
  const r2Bucket     = process.env["R2_BUCKET_NAME"]  ?? "";
  const r2PublicUrl  = process.env["R2_PUBLIC_BASE_URL"] ?? "";

  if (cloudProvider === "r2" || r2AccountId) {
    const kind: StorageKind = "r2";
    return {
      kind,
      detected: true,
      provider: "Cloudflare R2",
      bucket: r2Bucket || null,
      publicBaseUrl: r2PublicUrl || null,
      notes: [
        "Cloudflare R2 configured — S3-compatible object storage",
        r2Bucket ? `Bucket: ${r2Bucket}` : "R2_BUCKET_NAME not set",
        "Credentials: R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY",
      ],
    };
  }

  const s3Bucket = process.env["AWS_S3_BUCKET"] ?? process.env["S3_BUCKET"] ?? "";
  if (s3Bucket || process.env["AWS_ACCESS_KEY_ID"]) {
    return {
      kind: "s3",
      detected: true,
      provider: "AWS S3",
      bucket: s3Bucket || null,
      publicBaseUrl: null,
      notes: ["AWS S3 configured via AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY"],
    };
  }

  return {
    kind: "none",
    detected: false,
    provider: null,
    bucket: null,
    publicBaseUrl: null,
    notes: ["No cloud storage configured — using local filesystem fallback"],
  };
}

// ── Env Var Catalogue ─────────────────────────────────────────────────────────

const KNOWN_VARS: Array<Omit<EnvVarEntry, "detected">> = [
  { key: "DATABASE_URL",        required: true,  description: "PostgreSQL connection string",                   example: "postgresql://user:pass@host:5432/db", secret: true  },
  { key: "SESSION_SECRET",      required: true,  description: "Express session signing secret",                 example: "long-random-string",                  secret: true  },
  { key: "R2_ACCOUNT_ID",       required: false, description: "Cloudflare account ID for R2 access",           example: "69ba6c...",                            secret: false },
  { key: "R2_ACCESS_KEY_ID",    required: false, description: "R2 / S3-compatible access key",                 example: "abc123",                              secret: true  },
  { key: "R2_SECRET_ACCESS_KEY",required: false, description: "R2 / S3-compatible secret key",                 example: "secret",                              secret: true  },
  { key: "R2_BUCKET_NAME",      required: false, description: "R2 bucket name for asset storage",              example: "assets-stencil",                      secret: false },
  { key: "R2_PUBLIC_BASE_URL",  required: false, description: "Public CDN base URL for R2 assets",             example: "https://pub-xxx.r2.dev",              secret: false },
  { key: "CLOUD_PROVIDER",      required: false, description: "Cloud storage provider selection (r2 | local)",  example: "r2",                                  secret: false },
  { key: "NODE_ENV",            required: false, description: "Runtime environment",                            example: "production",                           secret: false },
  { key: "PORT",                required: false, description: "HTTP server port",                               example: "8080",                                 secret: false },
  { key: "CLOUDFLARE_API_TOKEN",required: false, description: "Cloudflare API token for wrangler deploys",     example: "cf_token",                             secret: true  },
];

function buildEnvVarList(): EnvVarEntry[] {
  return KNOWN_VARS.map((v) => ({
    ...v,
    detected: Boolean(process.env[v.key]),
  }));
}

// ── Node Version ──────────────────────────────────────────────────────────────

function detectNodeVersion(): string {
  const raw = process.version; // "v22.0.0"
  return raw.replace(/^v/, "");
}

// ── Main Detector ─────────────────────────────────────────────────────────────

export function detectEnvironment(): EnvironmentProfile {
  return {
    detectedHosting: detectHosting(),
    nodeVersion: detectNodeVersion(),
    runtime: "node",
    database: detectDatabase(),
    storage: detectStorage(),
    envVars: buildEnvVarList(),
    detectedAt: new Date().toISOString(),
  };
}
