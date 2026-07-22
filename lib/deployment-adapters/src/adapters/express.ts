import type { DeploymentAdapter, DeploymentContext, DeploymentPlan } from "../types.js";

export const expressAdapter: DeploymentAdapter = {
  framework: "express",

  generate(ctx: DeploymentContext): DeploymentPlan {
    const now = new Date().toISOString();
    return {
      version: "1.0",
      generatedAt: now,
      framework: "express",
      frameworkVersion: ctx.version,
      sourceUrl: ctx.sourceUrl,
      summary:
        "Express API/server — deploy as a persistent Node.js process. Railway and Fly.io have the easiest DX; Docker gives you full portability.",

      hostingOptions: [
        {
          name: "Railway",
          provider: "railway",
          tier: "hobby",
          url: "https://railway.app",
          recommended: true,
          deployMethod: "git",
          config: {
            buildCommand: "npm run build",
            startCommand: "npm start",
          },
          notes: [
            "Railway injects PORT automatically — read it with process.env.PORT.",
            "Connect your GitHub repo; every push triggers a deploy.",
            "Add a PostgreSQL or Redis service with one click.",
          ],
        },
        {
          name: "Fly.io",
          provider: "fly",
          tier: "hobby",
          url: "https://fly.io",
          recommended: false,
          deployMethod: "docker",
          config: {
            regions: "iad",
            memory: "256mb",
            internalPort: "3000",
          },
          notes: [
            "Run `fly launch` to auto-generate fly.toml, then `fly deploy`.",
            "Fly provisions a free TLS certificate and global anycast IPs.",
          ],
        },
        {
          name: "Render",
          provider: "render",
          tier: "hobby",
          url: "https://render.com",
          recommended: false,
          deployMethod: "git",
          config: {
            buildCommand: "npm run build",
            startCommand: "npm start",
            envVars: "NODE_ENV=production",
          },
          notes: [
            "Free tier spins down after 15 minutes of inactivity — upgrade to keep it alive.",
            "Managed PostgreSQL and Redis available as add-ons.",
          ],
        },
        {
          name: "DigitalOcean App Platform",
          provider: "digitalocean",
          tier: "pro",
          url: "https://cloud.digitalocean.com/apps",
          recommended: false,
          deployMethod: "git",
          config: {
            runCommand: "npm start",
            httpPort: "8080",
            envVars: "NODE_ENV=production",
          },
          notes: [
            "Set HTTP port to match your Express app's PORT env var.",
            "Managed databases available in the same project.",
          ],
        },
        {
          name: "AWS EC2 + Elastic Beanstalk",
          provider: "aws",
          tier: "pro",
          url: "https://aws.amazon.com/elasticbeanstalk/",
          recommended: false,
          deployMethod: "cli",
          config: {
            platform: "Node.js 20",
            environmentType: "SingleInstance",
          },
          notes: [
            "Run `eb init` then `eb deploy`.",
            "Elastic Beanstalk handles load balancing and auto-scaling.",
          ],
        },
      ],

      buildConfig: {
        installCommand: "npm install",
        buildCommand: "npm run build",
        outputDirectory: "dist",
        startCommand: "node dist/index.js",
        nodeVersion: "20",
        phpVersion: null,
        envVars: [
          {
            name: "PORT",
            required: true,
            description: "Port the Express server listens on",
            example: "3000",
          },
          {
            name: "NODE_ENV",
            required: true,
            description: "Set to 'production' to disable dev middleware",
            example: "production",
          },
          {
            name: "DATABASE_URL",
            required: false,
            description: "Postgres/MySQL connection string",
            example: "postgresql://user:pass@host:5432/db",
          },
          {
            name: "SESSION_SECRET",
            required: false,
            description: "Secret for signing session cookies — at least 32 chars",
            example: null,
          },
          {
            name: "CORS_ORIGIN",
            required: false,
            description: "Allowed CORS origins (comma-separated or *)",
            example: "https://your-frontend.vercel.app",
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
          "FROM node:20-alpine AS runner",
          "WORKDIR /app",
          "ENV NODE_ENV=production",
          "COPY --from=builder /app/dist ./dist",
          "COPY package*.json ./",
          "RUN npm ci --omit=dev",
        ],
        exposePort: 3000,
        cmd: ["node", "dist/index.js"],
        dockerfileSnippet: [
          "FROM node:20-alpine AS builder",
          "WORKDIR /app",
          "COPY package*.json ./",
          "RUN npm ci",
          "COPY . .",
          "RUN npm run build",
          "",
          "FROM node:20-alpine AS runner",
          "WORKDIR /app",
          "ENV NODE_ENV=production",
          "COPY --from=builder /app/dist ./dist",
          "COPY package*.json ./",
          "RUN npm ci --omit=dev",
          "EXPOSE 3000",
          'CMD ["node", "dist/index.js"]',
        ].join("\n"),
      },

      ciConfig: {
        platform: "github-actions",
        filename: ".github/workflows/deploy.yml",
        content: [
          "name: Deploy Express App",
          "on:",
          "  push:",
          "    branches: [main]",
          "jobs:",
          "  build-and-push:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/checkout@v4",
          "      - uses: actions/setup-node@v4",
          "        with:",
          "          node-version: '20'",
          "          cache: 'npm'",
          "      - run: npm ci",
          "      - run: npm run build",
          "      - name: Build Docker image",
          "        run: docker build -t my-express-app .",
          "      # Add: docker push + deploy step for your host",
        ].join("\n"),
      },

      checklist: [
        "Read PORT from process.env.PORT (not hardcoded) — all hosts inject it",
        "Set NODE_ENV=production before starting in production",
        "Configure CORS to only allow your frontend's origin — never use * in production",
        "Add a health-check endpoint (e.g. GET /healthz returning 200) for load balancers",
        "Use a process manager (PM2) or systemd if running on a raw VM",
        "Secure secrets in environment variables — never commit .env to source control",
        "Set up database connection pooling (e.g. PgBouncer) for high-traffic APIs",
      ],
    };
  },
};
