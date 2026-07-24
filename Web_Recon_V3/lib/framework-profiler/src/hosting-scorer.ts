import type {
  FrontendFramework,
  BackendFramework,
  DatabaseKind,
  HostingCompatibility,
  HostingProvider,
} from "./types.js";

interface ScoringContext {
  frontend:  FrontendFramework;
  backend:   BackendFramework;
  database:  DatabaseKind;
  hasStorage: boolean;
}

// ─── Per-provider scorers ─────────────────────────────────────────────────────

function scoreVercel(ctx: ScoringContext): HostingCompatibility {
  let score = 50;
  const reasons: string[] = [];
  const caveats: string[] = [];

  if (ctx.frontend === "nextjs")  { score += 45; reasons.push("Next.js: Vercel is the native platform — zero-config SSR, ISR, and Edge functions"); }
  else if (ctx.frontend === "react")   { score += 30; reasons.push("React (Vite/CRA): excellent static deployment via Vercel CDN"); }
  else if (ctx.frontend === "astro")   { score += 30; reasons.push("Astro: first-class Vercel adapter available"); }
  else if (ctx.frontend === "vue")     { score += 25; reasons.push("Vue/Nuxt: Vercel works well with Nuxt"); }
  else if (ctx.frontend === "angular") { score += 20; reasons.push("Angular: deployable as static output"); }

  if (ctx.backend === "express")  { score += 10; reasons.push("Express can run as Vercel serverless functions"); caveats.push("Long-running processes not supported — Express routes become serverless fns"); }
  else if (ctx.backend === "nestjs")  { score += 5; reasons.push("NestJS: deployable as serverless with vercel-nestjs"); caveats.push("Cold starts may affect NestJS performance at scale"); }
  else if (ctx.backend === "laravel") { score -= 15; caveats.push("Laravel requires vercel-php runtime (beta) — limited support"); }
  else if (ctx.backend === "django")  { score -= 20; caveats.push("Django not natively supported on Vercel — use Railway/Render instead"); }
  else if (ctx.backend === "rails")   { score -= 20; caveats.push("Rails not supported on Vercel — use Railway/Render instead"); }

  if (ctx.database !== "none" && ctx.database !== "unknown") {
    caveats.push("No managed database — connect to Neon, PlanetScale, or Supabase externally");
  }

  return {
    provider: "vercel",
    name: "Vercel",
    score: Math.max(0, Math.min(score, 100)),
    compatible: score >= 50,
    deployMethod: "git",
    url: "https://vercel.com",
    reasons,
    caveats,
  };
}

function scoreNetlify(ctx: ScoringContext): HostingCompatibility {
  let score = 50;
  const reasons: string[] = [];
  const caveats: string[] = [];

  if (ctx.frontend === "react")   { score += 35; reasons.push("React: excellent static deployment with Netlify CDN"); }
  else if (ctx.frontend === "astro")   { score += 35; reasons.push("Astro: official Netlify adapter for SSR + static"); }
  else if (ctx.frontend === "vue")     { score += 30; reasons.push("Vue: straightforward static or SSR via Netlify functions"); }
  else if (ctx.frontend === "angular") { score += 25; reasons.push("Angular: static output deploys cleanly"); }
  else if (ctx.frontend === "nextjs")  { score += 20; reasons.push("Next.js: works via @netlify/next plugin"); caveats.push("Some Next.js 13+ App Router features need @netlify/next plugin"); }

  if (ctx.backend === "express") { score += 5; reasons.push("Express endpoints can be wrapped as Netlify Functions"); caveats.push("Persistent server not supported — Express routes must become Netlify Functions"); }
  else if (ctx.backend === "nestjs") { score -= 5; caveats.push("NestJS requires significant adaptation for Netlify Functions"); }
  else if (ctx.backend === "laravel" || ctx.backend === "django" || ctx.backend === "rails") {
    score -= 25; caveats.push(`${ctx.backend} not well supported on Netlify — use Railway or Render`);
  }

  if (ctx.database !== "none" && ctx.database !== "unknown") {
    caveats.push("No managed database — use external provider (Neon, PlanetScale, Supabase)");
  }

  return {
    provider: "netlify",
    name: "Netlify",
    score: Math.max(0, Math.min(score, 100)),
    compatible: score >= 50,
    deployMethod: "git",
    url: "https://netlify.com",
    reasons,
    caveats,
  };
}

function scoreReplit(ctx: ScoringContext): HostingCompatibility {
  const reasons: string[] = ["Current environment — zero-config deployment via Replit Autoscale"];
  const caveats: string[] = [];

  if (ctx.backend === "django" || ctx.backend === "rails" || ctx.backend === "laravel") {
    caveats.push(`${ctx.backend} works on Replit but requires Nix package configuration`);
  }

  return {
    provider: "replit",
    name: "Replit",
    score: 95,
    compatible: true,
    deployMethod: "managed",
    url: "https://replit.com",
    reasons,
    caveats,
  };
}

function scoreRailway(ctx: ScoringContext): HostingCompatibility {
  let score = 60;
  const reasons: string[] = [];
  const caveats: string[] = [];

  if (ctx.backend === "express")  { score += 30; reasons.push("Express: Railway has excellent Node.js support with zero config"); }
  else if (ctx.backend === "nestjs")  { score += 28; reasons.push("NestJS: Railway auto-detects Node.js — just set PORT"); }
  else if (ctx.backend === "laravel") { score += 25; reasons.push("Laravel: Railway has PHP support with composer auto-detection"); }
  else if (ctx.backend === "django")  { score += 28; reasons.push("Django: Railway auto-detects Python via Procfile or nixpacks"); }
  else if (ctx.backend === "rails")   { score += 28; reasons.push("Rails: Railway has Ruby support with nixpacks"); }

  if (ctx.database === "postgres") { score += 10; reasons.push("PostgreSQL: Railway provides a managed Postgres addon"); }
  else if (ctx.database === "mysql") { score += 8; reasons.push("MySQL: Railway provides a managed MySQL addon"); }
  else if (ctx.database === "mongodb") { score += 5; reasons.push("MongoDB: Railway supports MongoDB via plugin"); }

  if (ctx.frontend !== "unknown") {
    reasons.push(`${ctx.frontend}: static assets served via Railway's public directory`);
  }

  return {
    provider: "railway",
    name: "Railway",
    score: Math.max(0, Math.min(score, 100)),
    compatible: score >= 50,
    deployMethod: "git",
    url: "https://railway.app",
    reasons,
    caveats,
  };
}

function scoreRender(ctx: ScoringContext): HostingCompatibility {
  let score = 60;
  const reasons: string[] = [];
  const caveats: string[] = [];

  if (ctx.backend === "express")  { score += 28; reasons.push("Express: Render auto-detects Node.js Web Service"); }
  else if (ctx.backend === "nestjs")  { score += 26; reasons.push("NestJS: Render deploys Node.js with custom start command"); }
  else if (ctx.backend === "laravel") { score += 20; reasons.push("Laravel: Render supports PHP via Docker"); caveats.push("PHP requires Dockerfile or Render native PHP support"); }
  else if (ctx.backend === "django")  { score += 25; reasons.push("Django: Render has native Python Web Service support"); }
  else if (ctx.backend === "rails")   { score += 22; reasons.push("Rails: Render supports Ruby Web Service"); }

  if (ctx.database === "postgres") { score += 10; reasons.push("PostgreSQL: Render provides a managed Postgres database"); }
  else if (ctx.database === "mysql") { caveats.push("MySQL: not natively managed on Render — use PlanetScale externally"); }

  if (ctx.frontend !== "unknown") {
    reasons.push(`${ctx.frontend}: Static Site service available for free`);
  }

  return {
    provider: "render",
    name: "Render",
    score: Math.max(0, Math.min(score, 100)),
    compatible: score >= 50,
    deployMethod: "git",
    url: "https://render.com",
    reasons,
    caveats,
  };
}

function scoreVps(_ctx: ScoringContext): HostingCompatibility {
  return {
    provider: "vps",
    name: "VPS / Self-Hosted",
    score: 95,
    compatible: true,
    deployMethod: "docker",
    url: "https://www.digitalocean.com/products/droplets",
    reasons: [
      "Maximum flexibility — any stack, any database, any configuration",
      "Full Puppeteer/Chromium support (no sandboxing restrictions)",
      "Persistent volumes for SQLite, file uploads, build artifacts",
    ],
    caveats: [
      "Requires DevOps setup: nginx/caddy reverse proxy, SSL, firewall",
      "No managed database — provision separately or run in Docker",
    ],
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function scoreHostingCompatibility(
  frontend:   FrontendFramework,
  backend:    BackendFramework,
  database:   DatabaseKind,
  hasStorage: boolean,
): HostingCompatibility[] {
  const ctx: ScoringContext = { frontend, backend, database, hasStorage };

  const scores = [
    scoreVercel(ctx),
    scoreNetlify(ctx),
    scoreReplit(ctx),
    scoreRailway(ctx),
    scoreRender(ctx),
    scoreVps(ctx),
  ];

  return scores.sort((a, b) => b.score - a.score);
}

export function detectCurrentHosting(): string {
  if (process.env["REPL_ID"] || process.env["REPLIT_DEPLOYMENT"]) return "replit";
  if (process.env["VERCEL"] || process.env["VERCEL_ENV"])          return "vercel";
  if (process.env["NETLIFY"])                                        return "netlify";
  if (process.env["RAILWAY_ENVIRONMENT"])                            return "railway";
  if (process.env["RENDER"])                                         return "render";
  if (process.env["DOCKER_CONTAINER"])                               return "vps (docker)";
  return "unknown";
}
