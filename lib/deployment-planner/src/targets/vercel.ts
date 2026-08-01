import type { TargetDeploymentPlan, Difficulty, EnvVarRequirement } from "../types.js";
import type { PlanInput } from "../planner.js";

export function planVercel(input: PlanInput): TargetDeploymentPlan {
  const { frontend, backend, database, hasStorage, mergeContext } = input;

  const isNextjs  = frontend === "nextjs";
  const isStatic  = frontend === "react" || frontend === "astro" || frontend === "vue" || frontend === "angular";
  const isServer  = backend === "express" || backend === "nestjs";
  const isPython  = backend === "django";
  const isRuby    = backend === "rails";
  const isPHP     = backend === "laravel";
  const unsupported = isPython || isRuby || isPHP;

  const envVars: EnvVarRequirement[] = [
    { name: "DATABASE_URL",   required: database !== "none" && database !== "unknown", description: "External database (Neon, PlanetScale, or Supabase) — Vercel has no managed DB", example: "postgresql://...", sensitive: true },
    { name: "NODE_ENV",       required: true, description: "Set to 'production' in Vercel dashboard", example: "production", sensitive: false },
    { name: "SESSION_SECRET", required: isServer, description: "Session secret for API functions", example: "change-me-32-chars", sensitive: true },
  ];
  if (hasStorage) {
    envVars.push(
      { name: "R2_ACCESS_KEY_ID",     required: true, description: "Cloudflare R2 access key", example: null, sensitive: true },
      { name: "R2_SECRET_ACCESS_KEY", required: true, description: "Cloudflare R2 secret key", example: null, sensitive: true },
      { name: "R2_BUCKET_NAME",       required: true, description: "Storage bucket name", example: "my-bucket", sensitive: false },
    );
  }

  let riskScore: number;
  let difficulty: Difficulty;

  if (isNextjs)       { riskScore = 10; difficulty = "easy"; }
  else if (isStatic)  { riskScore = 15; difficulty = "easy"; }
  else if (isServer)  { riskScore = 45; difficulty = "medium"; }
  else if (unsupported) { riskScore = 80; difficulty = "hard"; }
  else                { riskScore = 30; difficulty = "medium"; }

  if (mergeContext?.hasConflicts) riskScore += 10;

  const serverlessNote = isServer
    ? "Express/NestJS routes must be wrapped as Vercel Serverless Functions — persistent state (WebSockets, cron) is not supported"
    : null;

  return {
    target:       "vercel",
    targetLabel:  "Vercel",
    deployMethod: "git",
    url:          "https://vercel.com",

    riskScore:          Math.min(riskScore, 100),
    estimatedCost:      isNextjs || isStatic ? "$0–20/mo" : "$20–40/mo",
    difficulty,
    rollbackComplexity: "simple",
    recommended:        false,

    costBreakdown: {
      monthly:   isNextjs || isStatic ? "$0–20/mo" : "$20–40/mo",
      compute:   "Pro plan $20/mo — includes 1M serverless function invocations",
      database:  database !== "none" ? "External required: Neon free tier ($0) or PlanetScale ($0–29/mo)" : null,
      storage:   hasStorage ? "Vercel Blob ($0.023/GB) or external R2 ($0.015/GB)" : null,
      bandwidth: "100 GB/mo on Pro; $0.08/GB after",
      notes:     [
        "Hobby (free) plan available for personal projects",
        ...(isServer ? ["Serverless function duration: 10s (Hobby), 60s (Pro)"] : []),
      ],
    },

    buildCommands: {
      install:   "pnpm install --frozen-lockfile",
      build:     isNextjs ? "pnpm --filter @workspace/frontend run build"
               : isStatic ? "pnpm --filter @workspace/frontend run build"
               : isServer ? "pnpm --filter @workspace/api-server run build"
               : null,
      start:     isNextjs ? "pnpm --filter @workspace/frontend run start"
               : isServer ? "vercel dev"
               : "N/A — static deployment",
      typecheck: "pnpm run typecheck",
      migrate:   database === "postgres" ? "pnpm --filter @workspace/db run push" : null,
    },

    envVars,

    database: {
      needed:           database !== "none" && database !== "unknown",
      kind:             database,
      provisioning:     "Vercel does not provide a managed database — connect Neon (free), PlanetScale, or Supabase via the Vercel Integrations marketplace",
      migrationCommand: database === "postgres" ? "pnpm --filter @workspace/db run push" : null,
      backupStrategy:   "Managed by external DB provider (Neon PITR, Supabase daily backups)",
      estimatedCost:    "Neon free: $0/mo; Neon Pro: $19/mo",
    },

    storage: {
      needed:       hasStorage,
      kind:         hasStorage ? "r2" : "blob",
      provisioning: "Add Vercel Blob Storage or configure Cloudflare R2 via environment variables",
      notes:        ["Vercel Blob: $0.023/GB (easiest)", "Cloudflare R2: $0.015/GB (cheapest, already configured)"],
    },

    domain: {
      customDomainSupported: true,
      defaultDomain:         "your-app.vercel.app",
      sslAutomatic:          true,
      dnsManagedBy:          "Vercel (automatic) or external DNS with CNAME",
      notes:                 ["Unlimited custom domains on all plans"],
    },

    deploySteps: [
      "1. Push code to GitHub",
      "2. Import project at vercel.com/new → select the repo",
      "3. Set Framework Preset: Next.js (if using Next.js) or Other",
      ...(isServer ? [
        "3b. Create api/ directory and wrap Express routes as Vercel serverless functions",
        "3c. Add vercel.json with rewrites routing /api/* to serverless functions",
      ] : []),
      "4. Add environment variables in Vercel → Settings → Environment Variables",
      "5. Connect external database via Vercel Integrations (Neon, PlanetScale, or Supabase)",
      "6. Deploy — Vercel builds and CDN-distributes automatically",
      "7. Verify at /api/healthz",
    ],

    risks: [
      ...(mergeContext?.hasConflicts ? [`Merge has ${mergeContext.conflictCount} conflict(s) — resolve before deploying`] : []),
      ...(serverlessNote ? [serverlessNote] : []),
      ...(unsupported ? [`${backend} is not natively supported on Vercel — Railway or Render recommended instead`] : []),
      "No persistent filesystem — all file writes must go to Blob/R2 storage",
    ],

    notes: [
      isNextjs ? "Next.js on Vercel: zero-config SSR, ISR, and Edge functions" : `${frontend} deploys as static CDN output`,
      `Detected stack: ${frontend} + ${backend} + ${database}`,
    ],
  };
}
