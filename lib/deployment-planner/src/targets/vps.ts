import type { TargetDeploymentPlan, EnvVarRequirement } from "../types.js";
import type { PlanInput } from "../planner.js";

export function planVps(input: PlanInput): TargetDeploymentPlan {
  const { frontend, backend, database, hasStorage, mergeContext } = input;

  const isPython = backend === "django";
  const isRuby   = backend === "rails";
  const isPHP    = backend === "laravel";
  const isNode   = !isPython && !isRuby && !isPHP;

  const envVars: EnvVarRequirement[] = [
    { name: "DATABASE_URL",   required: database !== "none" && database !== "unknown", description: "PostgreSQL connection string (local or managed)", example: "postgresql://user:pass@localhost:5432/db", sensitive: true },
    { name: "NODE_ENV",       required: isNode, description: "Node.js environment", example: "production", sensitive: false },
    { name: "SESSION_SECRET", required: true,  description: "Session/cookie secret (32+ chars)", example: "change-me-32-chars", sensitive: true },
    { name: "PORT",           required: true,  description: "Port to bind (nginx proxies to this)", example: "3000", sensitive: false },
  ];
  if (isPython) envVars.push({ name: "DJANGO_SECRET_KEY", required: true, description: "Django secret key", example: null, sensitive: true });
  if (isRuby)   envVars.push({ name: "RAILS_MASTER_KEY",  required: true, description: "Rails master key", example: null, sensitive: true });
  if (hasStorage) {
    envVars.push(
      { name: "R2_ACCESS_KEY_ID",     required: true, description: "Cloudflare R2 access key", example: null, sensitive: true },
      { name: "R2_SECRET_ACCESS_KEY", required: true, description: "Cloudflare R2 secret key", example: null, sensitive: true },
      { name: "R2_BUCKET_NAME",       required: true, description: "R2 bucket name", example: "my-bucket", sensitive: false },
    );
  }

  const riskBase  = 35;
  const riskBonus = mergeContext?.hasConflicts ? 10 : 0;

  return {
    target:       "vps",
    targetLabel:  "VPS / Self-Hosted",
    deployMethod: "docker",
    url:          "https://www.digitalocean.com/products/droplets",

    riskScore:          riskBase + riskBonus,
    estimatedCost:      "$5–20/mo",
    difficulty:         "hard",
    rollbackComplexity: "complex",
    recommended:        false,

    costBreakdown: {
      monthly:   "$5–20/mo",
      compute:   "$6/mo (DigitalOcean 1GB Droplet) to $18/mo (2GB)",
      database:  database !== "none" ? "Self-hosted PostgreSQL ($0) or managed DO Postgres ($15/mo)" : null,
      storage:   hasStorage ? "Cloudflare R2 ($0.015/GB) or DigitalOcean Spaces ($5/mo for 250GB)" : null,
      bandwidth: "$0 (most VPS providers include 1–5TB/mo transfer)",
      notes:     [
        "Cheapest option for sustained workloads",
        "Requires sysadmin knowledge: nginx, SSL (certbot), firewalls, uptime monitoring",
      ],
    },

    buildCommands: {
      install:   isNode   ? "pnpm install --frozen-lockfile"
                          : isPython ? "pip install -r requirements.txt"
                          : isRuby   ? "bundle install --deployment"
                          : "composer install --no-dev",
      build:     isNode   ? "pnpm --filter @workspace/api-server run build" : null,
      start:     isNode   ? "node dist/index.mjs"
                          : isPython ? "gunicorn wsgi:application --workers 3 --bind 0.0.0.0:$PORT"
                          : isRuby   ? "bundle exec puma -C config/puma.rb"
                          : "php-fpm",
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
      provisioning:     `Install ${database} on the VPS (apt-get install postgresql) or use a managed provider (DO Postgres, Neon, Supabase)`,
      migrationCommand: database === "postgres" && isNode   ? "pnpm --filter @workspace/db run push"
                      : database === "postgres" && isPython ? "python manage.py migrate"
                      : database === "postgres" && isRuby   ? "bundle exec rails db:migrate"
                      : null,
      backupStrategy:   "Automate pg_dump to R2/Spaces via cron + DigitalOcean volume snapshots",
      estimatedCost:    "Self-hosted: $0; DO Managed Postgres: $15/mo",
    },

    storage: {
      needed:       hasStorage,
      kind:         hasStorage ? "r2" : "disk",
      provisioning: "Use attached block storage (DigitalOcean Volumes, $1/GB/mo) for uploads, or Cloudflare R2 for CDN-served assets",
      notes:        [
        "Ephemeral disks reset on droplet rebuild — always use object storage for uploads",
        "R2 already configured in environment — reuse existing credentials",
      ],
    },

    domain: {
      customDomainSupported: true,
      defaultDomain:         "Your VPS IP (e.g., 134.209.xxx.xxx)",
      sslAutomatic:          false,
      dnsManagedBy:          "External DNS (Cloudflare, Route53) — point A record to VPS IP",
      notes:                 [
        "Run: certbot --nginx -d yourdomain.com for free Let's Encrypt SSL",
        "Use Cloudflare proxied DNS for DDoS protection + free CDN",
      ],
    },

    deploySteps: [
      "1. Provision a Droplet/VM: Ubuntu 22.04, 1–2 GB RAM",
      "2. Install runtime: Node.js 20 / Python 3.11 / Ruby 3.2 / PHP 8.2",
      "3. Install nginx and configure reverse proxy to app port",
      "4. Clone repo: git clone <repo> && cd <project>",
      `5. Install deps: ${isNode ? "pnpm install --frozen-lockfile" : isPython ? "pip install -r requirements.txt" : isRuby ? "bundle install" : "composer install"}`,
      ...(isNode ? ["6. Build: pnpm --filter @workspace/api-server run build"] : []),
      "7. Create .env file and set all environment variables",
      "8. Run database migrations",
      "9. Start with systemd or PM2 (Node) / Gunicorn + supervisor (Python) / Puma (Rails)",
      "10. Install certbot and enable Let's Encrypt SSL",
      "11. Configure Cloudflare DNS (A record → VPS IP)",
    ],

    risks: [
      ...(mergeContext?.hasConflicts ? [`Merge has ${mergeContext.conflictCount} conflict(s) — resolve before deploying`] : []),
      "Manual server administration required — no automatic security patches",
      "No automatic failover — single point of failure unless load-balanced",
      "Rollback requires SSH, git reset, service restart, and migration revert",
    ],

    notes: [
      "Maximum flexibility — full Puppeteer/Chromium support, persistent filesystem, any stack",
      "Best total cost of ownership for high-traffic apps ($5–20/mo vs $100+/mo on PaaS)",
      `Detected stack: ${frontend} + ${backend} + ${database}`,
    ],
  };
}
