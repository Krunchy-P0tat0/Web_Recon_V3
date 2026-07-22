import type { DeploymentAdapter, DeploymentContext, DeploymentPlan } from "../types.js";

export const astroAdapter: DeploymentAdapter = {
  framework: "astro",

  generate(ctx: DeploymentContext): DeploymentPlan {
    const now = new Date().toISOString();
    return {
      version: "1.0",
      generatedAt: now,
      framework: "astro",
      frameworkVersion: ctx.version,
      sourceUrl: ctx.sourceUrl,
      summary:
        "Astro site — defaults to static output (zero JS by default). For SSR, install an Astro adapter matching your host. Cloudflare Pages is ideal for edge SSR; any static host works for static output.",

      hostingOptions: [
        {
          name: "Cloudflare Pages",
          provider: "cloudflare",
          tier: "free",
          url: "https://pages.cloudflare.com",
          recommended: true,
          deployMethod: "git",
          config: {
            buildCommand: "npm run build",
            outputDirectory: "dist",
            nodeVersion: "20",
            framework: "Astro",
          },
          notes: [
            "For SSR: install @astrojs/cloudflare adapter and set output: 'server'.",
            "Static output: no adapter needed — just connect your repo.",
            "Use `wrangler pages deploy` for CLI deployments.",
          ],
        },
        {
          name: "Vercel",
          provider: "vercel",
          tier: "free",
          url: "https://vercel.com",
          recommended: false,
          deployMethod: "git",
          config: {
            framework: "astro",
          },
          notes: [
            "For SSR: install @astrojs/vercel adapter.",
            "Static output works without any adapter.",
          ],
        },
        {
          name: "Netlify",
          provider: "netlify",
          tier: "free",
          url: "https://netlify.com",
          recommended: false,
          deployMethod: "git",
          config: {
            buildCommand: "npm run build",
            publishDirectory: "dist",
          },
          notes: [
            "For SSR: install @astrojs/netlify adapter.",
            "Add a netlify.toml with [[redirects]] if using SSR.",
          ],
        },
        {
          name: "GitHub Pages",
          provider: "github",
          tier: "free",
          url: "https://pages.github.com",
          recommended: false,
          deployMethod: "git",
          config: {
            site: "https://<username>.github.io/<repo>",
            base: "/<repo>/",
          },
          notes: [
            "Set `site` and `base` in astro.config.mjs.",
            "Use withastro/action GitHub Action for automated deploys.",
            "Static output only — SSR requires a different host.",
          ],
        },
        {
          name: "Railway",
          provider: "railway",
          tier: "hobby",
          url: "https://railway.app",
          recommended: false,
          deployMethod: "git",
          config: {
            buildCommand: "npm run build",
            startCommand: "node ./dist/server/entry.mjs",
          },
          notes: [
            "For SSR: install @astrojs/node adapter with mode: 'standalone'.",
            "Set PORT and HOST environment variables.",
          ],
        },
      ],

      buildConfig: {
        installCommand: "npm install",
        buildCommand: "npm run build",
        outputDirectory: "dist",
        startCommand: null,
        nodeVersion: "20",
        phpVersion: null,
        envVars: [
          {
            name: "ASTRO_OUTPUT",
            required: false,
            description: "Override output mode: 'static' | 'server' | 'hybrid'",
            example: "static",
          },
          {
            name: "PUBLIC_API_URL",
            required: false,
            description: "Client-accessible API base URL (prefix PUBLIC_ for Astro env exposure)",
            example: "https://api.example.com",
          },
        ],
      },

      dockerConfig: {
        baseImage: "node:20-alpine",
        buildSteps: [
          "FROM node:20-alpine AS builder",
          "WORKDIR /app",
          "COPY package*.json ./",
          "RUN npm ci",
          "COPY . .",
          "RUN npm run build",
          "",
          "# For SSR (node adapter):",
          "FROM node:20-alpine AS runner",
          "WORKDIR /app",
          "COPY --from=builder /app/dist ./dist",
          "COPY --from=builder /app/package*.json ./",
          "RUN npm ci --omit=dev",
        ],
        exposePort: 4321,
        cmd: ["node", "./dist/server/entry.mjs"],
        dockerfileSnippet: [
          "# SSR mode — requires @astrojs/node adapter with mode: 'standalone'",
          "FROM node:20-alpine AS builder",
          "WORKDIR /app",
          "COPY package*.json ./",
          "RUN npm ci",
          "COPY . .",
          "RUN npm run build",
          "",
          "FROM node:20-alpine AS runner",
          "WORKDIR /app",
          "COPY --from=builder /app/dist ./dist",
          "COPY --from=builder /app/package*.json ./",
          "RUN npm ci --omit=dev",
          "ENV HOST=0.0.0.0 PORT=4321",
          "EXPOSE 4321",
          'CMD ["node", "./dist/server/entry.mjs"]',
        ].join("\n"),
      },

      ciConfig: {
        platform: "github-actions",
        filename: ".github/workflows/deploy.yml",
        content: [
          "name: Deploy Astro Site",
          "on:",
          "  push:",
          "    branches: [main]",
          "jobs:",
          "  build:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/checkout@v4",
          "      - uses: actions/setup-node@v4",
          "        with:",
          "          node-version: '20'",
          "          cache: 'npm'",
          "      - run: npm ci",
          "      - run: npm run build",
          "      # Static: upload dist/ to your host",
          "      # SSR: build Docker image and push",
        ].join("\n"),
      },

      checklist: [
        "Choose your output mode: 'static' (default), 'server' (SSR), or 'hybrid'",
        "Install the correct adapter for your host (@astrojs/cloudflare, @astrojs/vercel, @astrojs/node, etc.)",
        "For static: verify all pages are pre-rendered with `astro build --verbose`",
        "Prefix client-accessible env vars with PUBLIC_ (Astro requirement)",
        "Set `site` and `base` in astro.config.mjs if deploying to a sub-path",
        "For SSR: set HOST=0.0.0.0 so the server binds to all interfaces in production",
      ],
    };
  },
};
