/**
 * vercel.ts — Phase 6.1 Deployment Target: Vercel
 *
 * Generates configuration for deploying to Vercel:
 *   - vercel.json        (routing + build config)
 *   - .env.vercel.example
 *   - .github/workflows/vercel-deploy.yml
 *
 * Architecture: Express API → Vercel Serverless Function
 * Frontend (React/Vite) → Vercel static CDN
 */

import type { TargetAdapter, TargetPlan, EnvironmentProfile } from "./types.js";

export const vercelAdapter: TargetAdapter = {
  target: "vercel",

  generate(sourceUrl: string, env: EnvironmentProfile): TargetPlan {
    const now = new Date().toISOString();
    const hasDb  = env.database.detected;
    const hasR2  = env.storage.detected;
    const nodeVer = env.nodeVersion.split(".")[0] ?? "22";
    const missingVars = env.envVars.filter((v) => v.required && !v.detected);

    const vercelJson = JSON.stringify(
      {
        version: 2,
        framework: null,
        buildCommand: "pnpm --filter @workspace/api-server run build",
        outputDirectory: "artifacts/api-server/dist",
        installCommand: "pnpm install",
        functions: {
          "artifacts/api-server/dist/index.mjs": {
            runtime: `@vercel/node@${nodeVer}`,
            maxDuration: 60,
          },
        },
        routes: [
          { src: "/api/(.*)", dest: "artifacts/api-server/dist/index.mjs" },
          { src: "/(.*)",     dest: "artifacts/article-scraper/dist/$1" },
        ],
        env: {
          NODE_ENV: "production",
        },
      },
      null,
      2
    );

    const envExample = [
      `# Web Reconstruction Platform — Vercel Environment Variables`,
      `# Add these in: Vercel Dashboard → Project → Settings → Environment Variables`,
      ``,
      `DATABASE_URL=postgresql://user:pass@host:5432/webrecon`,
      `SESSION_SECRET=change-me-long-random-string`,
      ``,
      `# Cloudflare R2`,
      `CLOUD_PROVIDER=r2`,
      `R2_ACCOUNT_ID=your-account-id`,
      `R2_ACCESS_KEY_ID=your-access-key`,
      `R2_SECRET_ACCESS_KEY=your-secret-key`,
      `R2_BUCKET_NAME=assets-stencil`,
      `R2_PUBLIC_BASE_URL=https://pub-xxx.r2.dev`,
      `R2_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com`,
      ``,
      `NODE_ENV=production`,
    ].join("\n");

    const ciYaml = [
      `name: Deploy to Vercel`,
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
      `          node-version: '${nodeVer}'`,
      `          cache: 'pnpm'`,
      `      - run: pnpm install`,
      `      - run: pnpm --filter @workspace/api-server run build`,
      `      - uses: amondnet/vercel-action@v25`,
      `        with:`,
      `          vercel-token: \${{ secrets.VERCEL_TOKEN }}`,
      `          vercel-org-id: \${{ secrets.VERCEL_ORG_ID }}`,
      `          vercel-project-id: \${{ secrets.VERCEL_PROJECT_ID }}`,
      `          vercel-args: '--prod'`,
    ].join("\n");

    return {
      version: "1.0",
      target: "vercel",
      targetLabel: "Vercel Serverless",
      generatedAt: now,
      sourceUrl,
      summary:
        "Deploy the Express API as Vercel Serverless Functions and the React frontend as static CDN assets. Free tier supports up to 100GB bandwidth/month and 1M serverless function invocations.",
      tier: "free-tier",
      recommended: true,
      confidence: "high",
      files: [
        {
          path: "vercel.json",
          content: vercelJson,
          description: "Vercel build + routing configuration — routes /api/* to the serverless function",
        },
        {
          path: ".env.vercel.example",
          content: envExample,
          description: "Template for Vercel environment variables — copy to the Vercel dashboard, never commit",
        },
        {
          path: ".github/workflows/vercel-deploy.yml",
          content: ciYaml,
          description: "GitHub Actions CI/CD pipeline — auto-deploys to Vercel on push to main",
        },
      ],
      envVars: env.envVars,
      deploySteps: [
        {
          order: 1,
          title: "Install Vercel CLI and link project",
          command: "npm i -g vercel && vercel link",
          notes: [
            "Creates .vercel/project.json with your project and org IDs",
            "You'll need these for the GitHub Actions secrets",
          ],
        },
        {
          order: 2,
          title: "Add environment variables in Vercel dashboard",
          command: null,
          notes: [
            "Vercel Dashboard → Project → Settings → Environment Variables",
            "Add all variables from .env.vercel.example",
            hasDb ? "DATABASE_URL is required — use a managed Postgres provider (Supabase, Neon, Railway)" : "No database configured",
            hasR2 ? "R2 credentials already configured" : "Add R2 credentials for persistent storage",
          ],
        },
        {
          order: 3,
          title: "Run DB migration on production DB",
          command: "DATABASE_URL=<prod_url> pnpm --filter @workspace/db run push",
          notes: ["Must run before first deployment", "Only needs to run when schema changes"],
        },
        {
          order: 4,
          title: "Deploy to Vercel",
          command: "vercel --prod",
          notes: [
            "Or push to main branch to trigger GitHub Actions CI/CD",
            "First deployment takes ~3 minutes; subsequent ones ~1 minute",
          ],
        },
      ],
      estimatedDeployTime: "3–5 minutes (first deploy)",
      limitations: [
        "Serverless functions have a 60-second execution limit — long crawl jobs will time out",
        "Puppeteer/Chromium cannot run in Vercel serverless — headless browser crawling requires a separate worker service",
        "Vercel free tier limits: 100GB bandwidth, 100GB-hours compute, 12 regions",
        "For Puppeteer support, run the crawler as a background service on Railway or Render alongside the Vercel API",
      ],
      checklist: [
        missingVars.length > 0
          ? `⚠ Missing required env vars: ${missingVars.map((v) => v.key).join(", ")}`
          : "✓ All required env vars detected",
        "Run: vercel link to connect to your project",
        "Add secrets in Vercel dashboard before first deploy",
        hasDb ? "✓ Database configured" : "⚠ Provision a managed Postgres DB (Supabase, Neon, or Railway)",
        hasR2 ? "✓ R2 storage configured" : "⚠ Configure R2 credentials for asset storage",
        "Test locally: vercel dev",
      ],
    };
  },
};
