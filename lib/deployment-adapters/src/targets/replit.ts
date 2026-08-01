/**
 * replit.ts — Phase 6.1 Deployment Target: Replit
 *
 * Generates all config files needed to run the Web Reconstruction Platform
 * directly on Replit (autoscale or reserved-VM deployments).
 *
 * Files generated:
 *   - replit.md              (project description)
 *   - .replit-artifact/artifact.toml   (service registration)
 *   - .env.replit.example    (required env vars)
 */

import type { TargetAdapter, TargetPlan, EnvironmentProfile } from "./types.js";

export const replitAdapter: TargetAdapter = {
  target: "replit",

  generate(sourceUrl: string, env: EnvironmentProfile): TargetPlan {
    const now = new Date().toISOString();
    const hasDb      = env.database.detected;
    const hasR2      = env.storage.detected && env.storage.kind === "r2";
    const missingVars = env.envVars.filter((v) => v.required && !v.detected);

    const artifactToml = [
      `kind = "api"`,
      `previewPath = "/api"`,
      `title = "Web Reconstruction Platform — API"`,
      `version = "1.0.0"`,
      ``,
      `[[services]]`,
      `name = "API Server"`,
      `paths = ["/api"]`,
      `localPort = 8080`,
      ``,
      `[services.development]`,
      `run = "pnpm --filter @workspace/api-server run dev"`,
      ``,
      `[services.production]`,
      ``,
      `[services.production.build]`,
      `args = ["pnpm", "--filter", "@workspace/api-server", "run", "build"]`,
      ``,
      `[services.production.build.env]`,
      `NODE_ENV = "production"`,
      ``,
      `[services.production.run]`,
      `args = ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]`,
      ``,
      `[services.production.run.env]`,
      `PORT = "8080"`,
      `NODE_ENV = "production"`,
      ``,
      `[services.production.health.startup]`,
      `path = "/api/healthz"`,
    ].join("\n");

    const envExample = [
      `# Web Reconstruction Platform — Replit Environment`,
      `# Copy to Replit Secrets (never commit actual values)`,
      ``,
      `DATABASE_URL=postgresql://user:pass@host:5432/webrecon`,
      `SESSION_SECRET=change-me-long-random-string`,
      ``,
      `# Cloudflare R2 Storage`,
      `CLOUD_PROVIDER=r2`,
      `R2_ACCOUNT_ID=your-account-id`,
      `R2_ACCESS_KEY_ID=your-access-key`,
      `R2_SECRET_ACCESS_KEY=your-secret-key`,
      `R2_BUCKET_NAME=assets-stencil`,
      `R2_PUBLIC_BASE_URL=https://pub-xxx.r2.dev`,
      `R2_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com`,
    ].join("\n");

    return {
      version: "1.0",
      target: "replit",
      targetLabel: "Replit Autoscale",
      generatedAt: now,
      sourceUrl,
      summary:
        "Deploy directly on Replit using Autoscale deployments. Zero infrastructure setup — Replit manages TLS, routing, and scaling. Best for rapid iteration.",
      tier: "paid",
      recommended: env.detectedHosting === "replit",
      confidence: "high",
      files: [
        {
          path: "artifacts/api-server/.replit-artifact/artifact.toml",
          content: artifactToml,
          description: "Replit artifact service registration — routes /api to the Express server",
        },
        {
          path: ".env.replit.example",
          content: envExample,
          description: "Template for Replit Secrets — copy values from your .env into Replit's secrets panel",
        },
      ],
      envVars: env.envVars,
      deploySteps: [
        {
          order: 1,
          title: "Add secrets to Replit",
          command: null,
          notes: [
            "Open the Replit Secrets panel (padlock icon)",
            "Add all variables from .env.replit.example",
            "DATABASE_URL and SESSION_SECRET are mandatory",
          ],
        },
        {
          order: 2,
          title: "Provision PostgreSQL database",
          command: "pnpm --filter @workspace/db run push",
          notes: [
            hasDb
              ? "DATABASE_URL detected — run push to apply schema"
              : "No DATABASE_URL found — provision a Replit PostgreSQL database first",
          ],
        },
        {
          order: 3,
          title: "Deploy via Replit Deploy button",
          command: null,
          notes: [
            "Click Deploy → Autoscale in the Replit workspace",
            "Replit builds the project and routes traffic automatically",
            "Health check: GET /api/healthz must return 200",
          ],
        },
        {
          order: 4,
          title: "Verify R2 connection after deploy",
          command: null,
          notes: [
            hasR2
              ? "R2 configured — verify at GET /api/healthz/r2"
              : "R2 not configured — scrape jobs will use local fallback storage",
          ],
        },
      ],
      estimatedDeployTime: "2–4 minutes",
      limitations: [
        "Replit Autoscale has a cold-start window of ~1–2 seconds on first request after idle",
        "Puppeteer/Chromium requires sufficient RAM — use a Reserved VM deployment for heavy crawl workloads",
        "Local filesystem writes (os.tmpdir/) are ephemeral — all persisted data must go to R2 or PostgreSQL",
      ],
      checklist: [
        missingVars.length > 0
          ? `⚠ Missing required secrets: ${missingVars.map((v) => v.key).join(", ")}`
          : "✓ All required env vars detected",
        "✓ Run pnpm --filter @workspace/db run push before first request",
        hasR2 ? "✓ R2 storage configured" : "⚠ R2 not configured — configure for persistent scrape storage",
        "✓ Health check endpoint: GET /api/healthz",
      ],
    };
  },
};

