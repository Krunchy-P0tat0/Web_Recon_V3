/**
 * targets/registry.ts — Phase 6.1
 *
 * Registry for deployment target adapters.
 * Targets: replit | vercel | cloudflare | docker
 */

import { replitAdapter }     from "./replit.js";
import { vercelAdapter }     from "./vercel.js";
import { cloudflareAdapter } from "./cloudflare.js";
import { dockerAdapter }     from "./docker.js";
import type { TargetAdapter, TargetId, TargetPlan, EnvironmentProfile } from "./types.js";

export const TARGET_ADAPTERS: Map<TargetId, TargetAdapter> = new Map([
  ["replit",     replitAdapter],
  ["vercel",     vercelAdapter],
  ["cloudflare", cloudflareAdapter],
  ["docker",     dockerAdapter],
]);

export function getSupportedTargets(): TargetId[] {
  return Array.from(TARGET_ADAPTERS.keys());
}

export function generateTargetPlan(
  target: TargetId,
  sourceUrl: string,
  env: EnvironmentProfile
): TargetPlan {
  const adapter = TARGET_ADAPTERS.get(target);
  if (!adapter) {
    throw new Error(
      `No deployment target adapter for '${target}'. Supported: ${getSupportedTargets().join(", ")}`
    );
  }
  return adapter.generate(sourceUrl, env);
}

export function generateAllTargetPlans(
  sourceUrl: string,
  env: EnvironmentProfile
): Record<TargetId, TargetPlan> {
  const result = {} as Record<TargetId, TargetPlan>;
  for (const [id, adapter] of TARGET_ADAPTERS.entries()) {
    result[id] = adapter.generate(sourceUrl, env);
  }
  return result;
}

export function pickRecommendedTarget(
  plans: Record<TargetId, TargetPlan>,
  env: EnvironmentProfile
): { target: TargetId; reasoning: string } {
  const hasR2     = env.storage.detected && env.storage.kind === "r2";
  const isReplit  = env.detectedHosting === "replit";

  if (isReplit) {
    return {
      target: "replit",
      reasoning: "Currently running on Replit — Autoscale deployment is the fastest path to production with zero infra setup.",
    };
  }

  if (hasR2) {
    return {
      target: "cloudflare",
      reasoning: "Cloudflare R2 already configured — using Cloudflare Pages + Workers gives native R2 binding with no credential exposure, lowest latency, and free CDN.",
    };
  }

  return {
    target: "docker",
    reasoning: "No cloud provider detected — Docker gives maximum portability and full Puppeteer/Chromium support for the scraping pipeline. Deploy to any VPS, Railway, Render, or Fly.io.",
  };
}
