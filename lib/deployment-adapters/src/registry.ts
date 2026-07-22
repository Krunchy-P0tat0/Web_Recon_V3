import { reactAdapter } from "./adapters/react.js";
import { nextjsAdapter } from "./adapters/nextjs.js";
import { astroAdapter } from "./adapters/astro.js";
import { expressAdapter } from "./adapters/express.js";
import { laravelAdapter } from "./adapters/laravel.js";
import { wordpressAdapter } from "./adapters/wordpress.js";
import type { DeploymentAdapter, DeploymentContext, DeploymentPlan, FrameworkId } from "./types.js";

const ADAPTERS: Map<FrameworkId, DeploymentAdapter> = new Map([
  ["react", reactAdapter],
  ["nextjs", nextjsAdapter],
  ["astro", astroAdapter],
  ["express", expressAdapter],
  ["laravel", laravelAdapter],
  ["wordpress", wordpressAdapter],
]);

export function getSupportedFrameworks(): FrameworkId[] {
  return Array.from(ADAPTERS.keys());
}

export function hasAdapter(framework: FrameworkId): boolean {
  return ADAPTERS.has(framework);
}

export function generateDeploymentPlan(ctx: DeploymentContext): DeploymentPlan {
  const adapter = ADAPTERS.get(ctx.framework);
  if (!adapter) {
    throw new Error(
      `No deployment adapter for framework '${ctx.framework}'. Supported: ${getSupportedFrameworks().join(", ")}`
    );
  }
  return adapter.generate(ctx);
}

export function generateAllDeploymentPlans(
  sourceUrl: string
): Record<FrameworkId, DeploymentPlan> {
  const result = {} as Record<FrameworkId, DeploymentPlan>;
  for (const [id, adapter] of ADAPTERS.entries()) {
    result[id] = adapter.generate({
      framework: id,
      version: null,
      features: [],
      sourceUrl,
    });
  }
  return result;
}
