import type { TargetDeploymentPlan, EnvVarRequirement } from "../types.js";
import type { PlanInput } from "../planner.js";

export function planRender(input: PlanInput): TargetDeploymentPlan {
  const { frontend, backend, database, hasStorage, mergeContext } = input;

  const isPython = backend === "django";
  const isRuby   = backend === "rails";
  const isPHP    = backend === "laravel";
  const isNode   = !isPython && !isRuby && !isPHP;

  const envVars: EnvVarRequirement[] = [
    { name: "DATABASE_URL",   required: database !== "none" && database !== "unknown", description: "Injected automatically when Render Postgres is linked", example: "postgresql://...", sensitive: true },
    { name: "NODE_ENV",       required: isNode,  description: "Node.js environment", example: "production", sensitive: false },
    { name: "SESSION_SECRET", required: true,    description: "Session/cookie secret", example: "change-me-32-chars", sensitive: true },
    { name: "PORT",           required: false,   description: "Auto-injected by Render — do not hardcode", example: "10000", sensitive: false },
  ];
  if (isPython) envVars.push({ name: "DJANGO_SECRET_KEY", required: true, description: "Django secret key", example: null, sensitive: true });
  if (isRuby)   envVars.push({ name: "RAILS_MASTER_KEY",  required: true, description: "Rails master key", example: null, sensitive: true });
  if (hasStorage) {
    envVars.push(
      { name: "R2_ACCESS_KEY_ID",     required: true, description: "Cloudflare R2 / S3 access key", example: null, sensitive: true },
      { name: "R2_SECRET_ACCESS_KEY", required: true, description: "Cloudflare R2 / S3 secret key", example: null, sensitive: true },
      { name: "R2_BUCKET_NAME",       required: true, description: "Storage bucket name", example: "my-bucket", sensitive: false },
    );
  }

  const riskBase  = 20;
  const riskBonus = mergeContext?.hasConflicts ? 10 : 0;

  let difficulty: "easy" | "medium" | "hard" = "easy";
  if (isPHP) difficulty = "medium";

  return {
    target:       "render",
    targetLabel:  "Render",
    deployMethod: "git",
    url:          "https://render.com",

    riskScore:          riskBase + riskBonus,
    estimatedCost:      "$7–25/mo",
    difficulty,
    rollbackComplexity: "simple",
    recommended:        false,

    costBreakdown: {
      monthly:   "$7–25/mo",
      compute:   "$7/mo (Starter) to $25/mo (Standard)",
      database:  database !== "none" ? "$7/mo (Render Postgres Starter)" : null,
      storage:   hasStorage ? "External (Cloudflare R2 ~$0.015/GB)" : null,
      bandwidth: "100 GB/mo included; $0.10/GB after",
      notes:     ["Free tier available but sleeps after 15 minutes of inactivity", "Starter plan ($7/mo) has no sleep"],
    },

    buildCommands: {
      install:   isNode   ? "pnpm install --frozen-lockfile"
                          : isPython ? "pip install -r requirements.txt"
                          : isRuby   ? "bundle install"
                          : "composer install",
      build:     isNode   ? "pnpm --filter @workspace/api-server run build" : null,
      start:     isNode   ? "node dist/index.mjs"
                          : isPython ? "gunicorn wsgi:application --bind 0.0.0.0:$PORT"
                          : isRuby   ? "bundle exec rails server -p $PORT -b 0.0.0.0"
                          : "php artisan serve --host=0.0.0.0 --port=$PORT",
      typecheck: isNode   ? "pnpm run typecheck" : null,
      migrate:   database === "postgres" && isNode   ? "pnpm --filter @workspace/db run push"
               : database === "postgres" && isPython ? "python manage.py migrate"
               : database === "postgres" && isRuby   ? "bundle exec rails db:migrate"
               : null,
    },

    envVars,

    database: {
      needed:           database !== "none" && database !== "unknown",
      kind:             database,
      provisioning:     "Create a Render PostgreSQL database in the same region as your web service — DATABASE_URL auto-injected via 'Internal Database URL'",
      migrationCommand: database === "postgres" && isNode   ? "pnpm --filter @workspace/db run push"
                      : database === "postgres" && isPython ? "python manage.py migrate"
                      : database === "postgres" && isRuby   ? "bundle exec rails db:migrate"
                      : null,
      backupStrategy:   "Render daily backups included on Starter plan ($7/mo+)",
      estimatedCost:    "$7/mo (Starter Postgres)",
    },

    storage: {
      needed:       hasStorage,
      kind:         hasStorage ? "r2" : "none",
      provisioning: "Set R2_* environment variables in Render → Environment tab",
      notes:        ["Render provides ephemeral disk (loses data on restart) — use Cloudflare R2 for persistent uploads"],
    },

    domain: {
      customDomainSupported: true,
      defaultDomain:         "your-app.onrender.com",
      sslAutomatic:          true,
      dnsManagedBy:          "Render (automatic TLS) or custom CNAME",
      notes:                 ["Custom domains included on all paid plans"],
    },

    deploySteps: [
      "1. Push code to GitHub",
      "2. Create a new Render Web Service → connect GitHub repo",
      "3. Set Runtime: Node / Python / Ruby as appropriate",
      "4. Set Build command and Start command",
      "5. Create a Render PostgreSQL database (if needed) and link it",
      "6. Add environment variables in Render → Environment tab",
      "7. Deploy — Render builds automatically on every git push",
      "8. Verify at /api/healthz",
    ],

    risks: [
      ...(mergeContext?.hasConflicts ? [`Merge has ${mergeContext.conflictCount} conflict(s) — resolve before deploying`] : []),
      "Free tier sleeps after 15 min inactivity — use Starter plan ($7/mo) to avoid",
      ...(isPHP ? ["Laravel requires PHP runtime — set environment to 'Docker' or use render.yaml with PHP buildpack"] : []),
    ],

    notes: [
      "Render supports native Node.js, Python, Ruby, and Docker runtimes",
      `Detected stack: ${frontend} + ${backend} + ${database}`,
    ],
  };
}
