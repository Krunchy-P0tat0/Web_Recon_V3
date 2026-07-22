import type { TargetDeploymentPlan, EnvVarRequirement } from "../types.js";
import type { PlanInput } from "../planner.js";

export function planRailway(input: PlanInput): TargetDeploymentPlan {
  const { frontend, backend, database, hasStorage, mergeContext } = input;

  const isPython = backend === "django";
  const isRuby   = backend === "rails";
  const isPHP    = backend === "laravel";
  const isNode   = !isPython && !isRuby && !isPHP;

  const envVars: EnvVarRequirement[] = [
    { name: "DATABASE_URL",   required: database !== "none" && database !== "unknown", description: "Injected automatically when Railway Postgres plugin is added", example: "postgresql://...", sensitive: true },
    { name: "NODE_ENV",       required: isNode,   description: "Node.js environment", example: "production", sensitive: false },
    { name: "SESSION_SECRET", required: true,     description: "Session/cookie secret", example: "change-me-32-chars", sensitive: true },
    { name: "PORT",           required: false,    description: "Auto-injected by Railway — do not hardcode", example: "3000", sensitive: false },
  ];
  if (isPython) envVars.push({ name: "DJANGO_SECRET_KEY", required: true, description: "Django secret key", example: null, sensitive: true });
  if (isRuby)   envVars.push({ name: "RAILS_MASTER_KEY", required: true, description: "Rails master key (config/master.key)", example: null, sensitive: true });
  if (hasStorage) {
    envVars.push(
      { name: "R2_ACCESS_KEY_ID",     required: true, description: "Cloudflare R2 / AWS access key", example: null, sensitive: true },
      { name: "R2_SECRET_ACCESS_KEY", required: true, description: "Cloudflare R2 / AWS secret key", example: null, sensitive: true },
      { name: "R2_BUCKET_NAME",       required: true, description: "Storage bucket name", example: "my-bucket", sensitive: false },
    );
  }

  const riskBase  = 15;
  const riskBonus = mergeContext?.hasConflicts ? 10 : 0;

  let difficulty: "easy" | "medium" | "hard" = "easy";
  if (isPHP) difficulty = "medium";

  return {
    target:       "railway",
    targetLabel:  "Railway",
    deployMethod: "git",
    url:          "https://railway.app",

    riskScore:          riskBase + riskBonus,
    estimatedCost:      "$5–25/mo",
    difficulty,
    rollbackComplexity: "simple",
    recommended:        false,

    costBreakdown: {
      monthly:   "$5–25/mo",
      compute:   "$5–10/mo (Hobby) — pay per usage",
      database:  database !== "none" ? "$5/mo (Railway Postgres Plugin, shared)" : null,
      storage:   hasStorage ? "External (Cloudflare R2 ~$0.015/GB)" : null,
      bandwidth: "$0.10/GB egress after 100 GB",
      notes:     ["Railway Hobby plan includes $5 free credit/mo", "No cold starts — container stays warm"],
    },

    buildCommands: {
      install:   isNode   ? "pnpm install --frozen-lockfile"
                          : isPython ? "pip install -r requirements.txt"
                          : isRuby   ? "bundle install"
                          : "composer install",
      build:     isNode   ? "pnpm --filter @workspace/api-server run build" : null,
      start:     isNode   ? "node dist/index.mjs"
                          : isPython ? "gunicorn wsgi:application"
                          : isRuby   ? "bundle exec rails server -p $PORT"
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
      provisioning:     "Add Railway Postgres plugin from the project dashboard — DATABASE_URL is auto-injected",
      migrationCommand: database === "postgres" && isNode   ? "pnpm --filter @workspace/db run push"
                      : database === "postgres" && isPython ? "python manage.py migrate"
                      : database === "postgres" && isRuby   ? "bundle exec rails db:migrate"
                      : null,
      backupStrategy:   "Enable Railway automatic backups (Pro plan) or pg_dump to R2 via cron",
      estimatedCost:    "$5/mo (Railway Postgres Plugin)",
    },

    storage: {
      needed:       hasStorage,
      kind:         hasStorage ? "r2" : "none",
      provisioning: "Set R2_* environment variables in Railway project settings",
      notes:        ["Railway does not provide built-in object storage — use Cloudflare R2 or AWS S3"],
    },

    domain: {
      customDomainSupported: true,
      defaultDomain:         "your-app.up.railway.app",
      sslAutomatic:          true,
      dnsManagedBy:          "Railway (automatic CNAME) or custom domain",
      notes:                 ["Custom domains supported on all plans at no extra cost"],
    },

    deploySteps: [
      "1. Push code to GitHub",
      "2. Create a new Railway project → 'Deploy from GitHub repo'",
      "3. Add the Postgres plugin if database is needed",
      "4. Set all environment variables in Railway → Variables tab",
      ...(isNode ? ["5. Set Start command: node dist/index.mjs"] : []),
      ...(isPython ? ["5. Add a Procfile: web: gunicorn wsgi:application"] : []),
      ...(isRuby   ? ["5. Railway auto-detects Rails via Gemfile"] : []),
      "6. Trigger a deploy — Railway builds and starts the container",
      "7. Verify health at /api/healthz (or your health route)",
    ],

    risks: [
      ...(mergeContext?.hasConflicts ? [`Merge has ${mergeContext.conflictCount} conflict(s) — resolve before deploying`] : []),
      ...(isPHP ? ["Laravel on Railway requires php-fpm Dockerfile — add one to the repo"] : []),
    ],

    notes: [
      "No cold starts — Railway keeps containers warm (unlike Vercel/Netlify serverless)",
      `Detected stack: ${frontend} + ${backend} + ${database}`,
    ],
  };
}
