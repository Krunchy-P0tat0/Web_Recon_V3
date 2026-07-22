/**
 * cloudflare.ts — Phase 6.1 Deployment Target: Cloudflare
 *
 * Generates configuration for two Cloudflare deployment modes:
 *   1. Cloudflare Pages — React/Vite static frontend (free, global CDN)
 *   2. Cloudflare Workers — Express API via @hono/node-server or itty-router adapter
 *
 * Files generated:
 *   - wrangler.toml          (Workers + Pages config)
 *   - _routes.json           (Pages function routing)
 *   - .env.cloudflare.example
 *   - .github/workflows/cloudflare-deploy.yml
 */

import type { TargetAdapter, TargetPlan, EnvironmentProfile } from "./types.js";

export const cloudflareAdapter: TargetAdapter = {
  target: "cloudflare",

  generate(sourceUrl: string, env: EnvironmentProfile): TargetPlan {
    const now = new Date().toISOString();
    const hasR2  = env.storage.detected && env.storage.kind === "r2";
    const hasDb  = env.database.detected;
    const missingVars = env.envVars.filter((v) => v.required && !v.detected);

    const wranglerToml = [
      `name = "web-reconstruction-platform"`,
      `main = "artifacts/api-server/dist/worker.mjs"`,
      `compatibility_date = "2025-01-01"`,
      `compatibility_flags = ["nodejs_compat"]`,
      ``,
      `# Cloudflare Pages — serves the React/Vite frontend`,
      `[site]`,
      `bucket = "artifacts/article-scraper/dist"`,
      ``,
      `# R2 bucket binding (replaces environment variable R2)`,
      `[[r2_buckets]]`,
      `binding = "ASSETS"`,
      `bucket_name = "${env.storage.bucket ?? "assets-stencil"}"`,
      ``,
      `# Environment variables (non-secret)`,
      `[vars]`,
      `NODE_ENV = "production"`,
      `CLOUD_PROVIDER = "r2"`,
      ``,
      `# Production environment`,
      `[env.production]`,
      `name = "web-reconstruction-platform-production"`,
      ``,
      `[env.production.vars]`,
      `NODE_ENV = "production"`,
    ].join("\n");

    const routesJson = JSON.stringify(
      {
        version: 1,
        include: ["/api/*"],
        exclude: ["/_next/*", "/static/*", "/*.js", "/*.css", "/*.png", "/*.jpg"],
      },
      null,
      2
    );

    const envExample = [
      `# Web Reconstruction Platform — Cloudflare Environment`,
      `# Add secrets via: wrangler secret put SECRET_NAME`,
      ``,
      `# Database (use Cloudflare D1 or external Hyperdrive-compatible Postgres)`,
      `DATABASE_URL=postgresql://user:pass@host:5432/webrecon`,
      `SESSION_SECRET=change-me-long-random-string`,
      ``,
      `# R2 Storage (bind via wrangler.toml [[r2_buckets]] — no credentials needed)`,
      `# The R2 bucket is accessed via the ASSETS binding, not env vars`,
      `R2_BUCKET_NAME=assets-stencil`,
      `R2_PUBLIC_BASE_URL=https://pub-xxx.r2.dev`,
      ``,
      `# Cloudflare API (for wrangler deploys from CI)`,
      `CLOUDFLARE_API_TOKEN=your-api-token`,
      `CLOUDFLARE_ACCOUNT_ID=your-account-id`,
    ].join("\n");

    const ciYaml = [
      `name: Deploy to Cloudflare`,
      `on:`,
      `  push:`,
      `    branches: [main]`,
      ``,
      `jobs:`,
      `  deploy:`,
      `    runs-on: ubuntu-latest`,
      `    steps:`,
      `      - uses: actions/checkout@v4`,
      `      - uses: pnpm/action-setup@v3`,
      `        with:`,
      `          version: 10`,
      `      - uses: actions/setup-node@v4`,
      `        with:`,
      `          node-version: '22'`,
      `          cache: 'pnpm'`,
      `      - run: pnpm install`,
      `      - name: Build API`,
      `        run: pnpm --filter @workspace/api-server run build`,
      `      - name: Build Frontend`,
      `        run: pnpm --filter @workspace/article-scraper run build`,
      `      - name: Deploy to Cloudflare`,
      `        uses: cloudflare/wrangler-action@v3`,
      `        with:`,
      `          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}`,
      `          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}`,
      `          command: deploy --env production`,
    ].join("\n");

    return {
      version: "1.0",
      target: "cloudflare",
      targetLabel: "Cloudflare Pages + Workers",
      generatedAt: now,
      sourceUrl,
      summary:
        "Deploy the frontend to Cloudflare Pages (global edge CDN) and the API to Cloudflare Workers. Natively integrates with your existing R2 bucket via the ASSETS binding — no credentials needed for storage in production.",
      tier: "free-tier",
      recommended: hasR2,
      confidence: hasR2 ? "high" : "medium",
      files: [
        {
          path: "wrangler.toml",
          content: wranglerToml,
          description: "Wrangler config — registers the Worker, Pages site bucket, and R2 binding",
        },
        {
          path: "public/_routes.json",
          content: routesJson,
          description: "Pages function routing — sends /api/* to the Worker, everything else to static CDN",
        },
        {
          path: ".env.cloudflare.example",
          content: envExample,
          description: "Secrets template — use 'wrangler secret put' for sensitive values",
        },
        {
          path: ".github/workflows/cloudflare-deploy.yml",
          content: ciYaml,
          description: "GitHub Actions CI/CD — deploys via Wrangler on push to main",
        },
      ],
      envVars: env.envVars,
      deploySteps: [
        {
          order: 1,
          title: "Install Wrangler and authenticate",
          command: "npm install -g wrangler && wrangler login",
          notes: ["Requires a Cloudflare account (free tier available)"],
        },
        {
          order: 2,
          title: "Create R2 bucket (if not already exists)",
          command: `wrangler r2 bucket create ${env.storage.bucket ?? "assets-stencil"}`,
          notes: [
            hasR2
              ? `Bucket '${env.storage.bucket ?? "assets-stencil"}' — verify it exists in your Cloudflare dashboard`
              : "Create a new R2 bucket for asset storage",
            "Update wrangler.toml [[r2_buckets]] with your bucket name",
          ],
        },
        {
          order: 3,
          title: "Add secrets via Wrangler",
          command: "wrangler secret put DATABASE_URL && wrangler secret put SESSION_SECRET",
          notes: [
            "Secrets are encrypted at rest and injected at runtime",
            hasDb ? "Database URL is required — use Cloudflare Hyperdrive for Postgres connection pooling" : "No database configured",
          ],
        },
        {
          order: 4,
          title: "Build and deploy",
          command: "pnpm install && pnpm --filter @workspace/api-server run build && wrangler deploy",
          notes: [
            "First deployment provisions the Worker and Pages site",
            "Subsequent deploys are instant (~30 seconds)",
          ],
        },
      ],
      estimatedDeployTime: "3–6 minutes (first deploy), ~30s thereafter",
      limitations: [
        "Cloudflare Workers have a 128MB memory limit — Puppeteer/Chromium CANNOT run in Workers",
        "CPU time limit: 50ms (free) / 30 seconds (paid) per request — long scrapes must be offloaded",
        "No persistent local filesystem in Workers — all state must use R2, D1, or KV",
        "Postgres connections require Cloudflare Hyperdrive for connection pooling (paid feature)",
        "Workers runtime is V8-based (not Node.js) — some Node.js APIs are polyfilled via nodejs_compat",
      ],
      checklist: [
        missingVars.length > 0
          ? `⚠ Missing env vars: ${missingVars.map((v) => v.key).join(", ")}`
          : "✓ All required env vars detected",
        hasR2 ? "✓ R2 storage configured — bind via wrangler.toml [[r2_buckets]]" : "⚠ Create an R2 bucket first",
        "Create wrangler.toml with your account and bucket details",
        "Add DATABASE_URL and SESSION_SECRET via: wrangler secret put",
        "Verify: wrangler dev (local emulation)",
        "Deploy: wrangler deploy --env production",
      ],
    };
  },
};
