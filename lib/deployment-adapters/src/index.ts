/**
 * @workspace/deployment-adapters
 *
 * Phase D2: Framework deployment adapters
 * Phase 6.1: Deployment target intelligence (replit | vercel | cloudflare | docker)
 *
 * Framework adapters (what stack a site uses):
 *   generateDeploymentPlan(ctx)         → DeploymentPlan
 *   generateAllDeploymentPlans(url)     → Record<FrameworkId, DeploymentPlan>
 *   getSupportedFrameworks()            → FrameworkId[]
 *   hasAdapter(framework)               → boolean
 *
 * Target adapters (where to deploy):
 *   detectEnvironment()                 → EnvironmentProfile
 *   generateAllTargetPlans(url, env)    → Record<TargetId, TargetPlan>
 *   generateTargetPlan(target, url, env)→ TargetPlan
 *   getSupportedTargets()               → TargetId[]
 *   pickRecommendedTarget(plans, env)   → { target, reasoning }
 */

export type {
  DeploymentAdapter,
  DeploymentContext,
  DeploymentPlan,
  HostingOption,
  BuildConfig,
  DockerConfig,
  CIConfig,
  EnvVarSpec,
  FrameworkId,
  HostingTier,
} from "./types.js";

export { generateDeploymentPlan, generateAllDeploymentPlans, getSupportedFrameworks, hasAdapter } from "./registry.js";

export { reactAdapter }     from "./adapters/react.js";
export { nextjsAdapter }    from "./adapters/nextjs.js";
export { astroAdapter }     from "./adapters/astro.js";
export { expressAdapter }   from "./adapters/express.js";
export { laravelAdapter }   from "./adapters/laravel.js";
export { wordpressAdapter } from "./adapters/wordpress.js";

export type {
  TargetId,
  TargetAdapter,
  TargetPlan,
  EnvironmentProfile,
  DatabaseProfile,
  StorageProfile,
  EnvVarEntry,
  GeneratedFile,
  DeployStep,
  DeploymentIntelligenceReport,
  DeploymentRisk,
  DeploymentRiskAssessment,
  RiskFactor,
  CompatibilityNote,
  DatabaseKind,
  StorageKind,
  HostingEnv,
} from "./targets/types.js";

export { scoreDeploymentRisk, buildDeploymentChecklist } from "./risk-scorer.js";
export type { ChecklistItem, DeploymentChecklist } from "./risk-scorer.js";

export { detectEnvironment }                                                                        from "./targets/environment-detector.js";
export { generateTargetPlan, generateAllTargetPlans, getSupportedTargets, pickRecommendedTarget }   from "./targets/registry.js";
export { replitAdapter }         from "./targets/replit.js";
export { vercelAdapter }         from "./targets/vercel.js";
export { cloudflareAdapter }     from "./targets/cloudflare.js";
export { dockerAdapter }         from "./targets/docker.js";
