import type { DeploymentAdapter, DeploymentContext, DeploymentPlan } from "../types.js";

export const reactAdapter: DeploymentAdapter = {
  framework: "react",

  generate(ctx: DeploymentContext): DeploymentPlan {
    const now = new Date().toISOString();
    return {
      version: "1.0",
      generatedAt: now,
      framework: "react",
      frameworkVersion: ctx.version,
      sourceUrl: ctx.sourceUrl,
      summary:
        "React SPA — compile to static assets and serve from any CDN or static host. No server runtime required at runtime.",

      hostingOptions: [
        {
          name: "Vercel",
          provider: "vercel",
          tier: "free",
          url: "https://vercel.com",
          recommended: true,
          deployMethod: "git",
          config: {
            buildCommand: "npm run build",
            outputDirectory: "dist",
            framework: "vite",
          },
          notes: [
            "Connect your Git repo and Vercel auto-detects Vite/CRA.",
            "Zero-config HTTPS, global CDN, and preview URLs per PR.",
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
            "Add a _redirects file with `/* /index.html 200` for client-side routing.",
          ],
        },
        {
          name: "Cloudflare Pages",
          provider: "cloudflare",
          tier: "free",
          url: "https://pages.cloudflare.com",
          recommended: false,
          deployMethod: "git",
          config: {
            buildCommand: "npm run build",
            outputDirectory: "dist",
            nodeVersion: "20",
          },
          notes: [
            "Fastest global edge network. Add _redirects for SPA routing.",
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
            base: "/your-repo-name/",
          },
          notes: [
            "Set `base` in vite.config.ts to match the repo name.",
            "Use the peaceiris/actions-gh-pages action to deploy from CI.",
          ],
        },
        {
          name: "AWS S3 + CloudFront",
          provider: "aws",
          tier: "pro",
          url: "https://aws.amazon.com/cloudfront/",
          recommended: false,
          deployMethod: "cli",
          config: {
            s3Bucket: "<your-bucket>",
            distributionId: "<cloudfront-id>",
          },
          notes: [
            "Run: aws s3 sync dist/ s3://<bucket> --delete",
            "Invalidate CloudFront: aws cloudfront create-invalidation --paths '/*'",
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
            name: "VITE_API_URL",
            required: false,
            description: "Base URL for the backend API",
            example: "https://api.example.com",
          },
        ],
      },

      dockerConfig: {
        baseImage: "nginx:alpine",
        buildSteps: [
          "FROM node:20-alpine AS builder",
          "WORKDIR /app",
          "COPY package*.json ./",
          "RUN npm ci",
          "COPY . .",
          "RUN npm run build",
          "",
          "FROM nginx:alpine",
          "COPY --from=builder /app/dist /usr/share/nginx/html",
          "COPY nginx.conf /etc/nginx/conf.d/default.conf",
        ],
        exposePort: 80,
        cmd: ["nginx", "-g", "daemon off;"],
        dockerfileSnippet: [
          "FROM node:20-alpine AS builder",
          "WORKDIR /app",
          "COPY package*.json ./",
          "RUN npm ci",
          "COPY . .",
          "RUN npm run build",
          "",
          "FROM nginx:alpine",
          "COPY --from=builder /app/dist /usr/share/nginx/html",
          "EXPOSE 80",
          'CMD ["nginx", "-g", "daemon off;"]',
        ].join("\n"),
      },

      ciConfig: {
        platform: "github-actions",
        filename: ".github/workflows/deploy.yml",
        content: [
          "name: Deploy React App",
          "on:",
          "  push:",
          "    branches: [main]",
          "jobs:",
          "  deploy:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/checkout@v4",
          "      - uses: actions/setup-node@v4",
          "        with:",
          "          node-version: '20'",
          "          cache: 'npm'",
          "      - run: npm ci",
          "      - run: npm run build",
          "      - uses: actions/upload-artifact@v4",
          "        with:",
          "          name: dist",
          "          path: dist/",
        ].join("\n"),
      },

      checklist: [
        "Ensure all environment variables are prefixed with VITE_ (for Vite projects)",
        "Configure client-side routing fallback (/* → /index.html) on your host",
        "Enable HTTPS — all major static hosts provide it for free",
        "Set cache-control headers: long TTL for hashed assets, no-cache for index.html",
        "Run `npm run build` locally first and verify the dist/ output",
      ],
    };
  },
};
