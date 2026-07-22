import type { TargetDeploymentPlan, EnvVarRequirement } from "../types.js";
import type { PlanInput } from "../planner.js";

export function planReplit(input: PlanInput): TargetDeploymentPlan {
  const { frontend, backend, database, hasStorage, mergeContext } = input;

  const envVars: EnvVarRequirement[] = [
    { name: "DATABASE_URL",    required: database !== "none" && database !== "unknown", description: "PostgreSQL connection string", example: "postgresql://user:pass@host:5432/db", sensitive: true },
    { name: "SESSION_SECRET",  required: true,  description: "Express session secret (32+ random chars)", example: "super-secret-key-change-me", sensitive: true },
    { name: "NODE_ENV",        required: true,  description: "Node.js environment", example: "production", sensitive: false },
    { name: "PORT",            required: false, description: "Auto-injected by Replit — do not set manually", example: "3000", sensitive: false },
  ];
  if (hasStorage) {
    envVars.push(
      { name: "R2_ACCESS_KEY_ID",     required: true, description: "Cloudflare R2 access key", example: null, sensitive: true },
      { name: "R2_SECRET_ACCESS_KEY", required: true, description: "Cloudflare R2 secret key", example: null, sensitive: true },
      { name: "R2_BUCKET_NAME",       required: true, description: "R2 bucket name", example: "my-bucket", sensitive: false },
    );
  }

  const riskBonus = mergeContext?.hasConflicts ? 10 : 0;

  return {
    target:       "replit",
    targetLabel:  "Replit Autoscale",
    deployMethod: "managed",
    url:          "https://replit.com/deployments",

    riskScore:          5 + riskBonus,
    estimatedCost:      "$7–25/mo",
    difficulty:         "easy",
    rollbackComplexity: "simple",
    recommended:        false,

    costBreakdown: {
      monthly:   "$7–25/mo",
      compute:   "$7/mo (Hobby) → $25/mo (Autoscale)",
      database:  database !== "none" ? "External DB required (~$0–15/mo via Neon free tier)" : null,
      storage:   hasStorage ? "Cloudflare R2 (~$0.015/GB)" : null,
      bandwidth: null,
      notes:     ["Replit Autoscale scales to zero — pay only for active compute"],
    },

    buildCommands: {
      install:   "pnpm install --frozen-lockfile",
      build:     `pnpm --filter @workspace/api-server run build`,
      start:     "pnpm --filter @workspace/api-server run start",
      typecheck: "pnpm run typecheck",
      migrate:   database === "postgres" ? "pnpm --filter @workspace/db run push" : null,
    },

    envVars,

    database: {
      needed:           database !== "none" && database !== "unknown",
      kind:             database,
      provisioning:     "Create a Replit PostgreSQL database or connect Neon (free tier) via DATABASE_URL secret",
      migrationCommand: database === "postgres" ? "pnpm --filter @workspace/db run push" : null,
      backupStrategy:   "Enable Neon PITR or pg_dump via cron",
      estimatedCost:    "Neon free tier: $0/mo up to 0.5 GB",
    },

    storage: {
      needed:       hasStorage,
      kind:         hasStorage ? "r2" : "none",
      provisioning: "Cloudflare R2 bucket — add R2_* secrets to Replit Secrets tab",
      notes:        hasStorage ? ["R2 secrets are already configured in this environment"] : [],
    },

    domain: {
      customDomainSupported: true,
      defaultDomain:         "your-repl.repl.co",
      sslAutomatic:          true,
      dnsManagedBy:          "Replit (automatic) or custom CNAME",
      notes:                 ["Custom domains available on Hacker plan and above"],
    },

    deploySteps: [
      "1. Open the Deployments tab in Replit",
      "2. Choose 'Autoscale' deployment type",
      "3. Set Run command: pnpm --filter @workspace/api-server run start",
      "4. Add all required secrets in the Secrets tab",
      "5. Click 'Deploy' — Replit builds and serves automatically",
      "6. Verify health at /api/healthz",
    ],

    risks: [
      ...(mergeContext?.hasConflicts ? [`Merge has ${mergeContext.conflictCount} unresolved conflict(s) — resolve before deploying`] : []),
      "Replit Autoscale cold-starts can add 1–3s latency on first request",
    ],

    notes: [
      "Fastest path to production — zero infra setup required",
      "Already running in this environment — no migration needed",
      `Detected stack: ${frontend} + ${backend} + ${database}`,
    ],
  };
}
