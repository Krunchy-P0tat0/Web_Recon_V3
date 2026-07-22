/**
 * @workspace/deployment-adapters — Phase 6.1 Target Exports
 */

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
  DatabaseKind,
  StorageKind,
  HostingEnv,
} from "./types.js";

export { detectEnvironment }     from "./environment-detector.js";
export { generateTargetPlan, generateAllTargetPlans, getSupportedTargets, pickRecommendedTarget } from "./registry.js";
export { replitAdapter }         from "./replit.js";
export { vercelAdapter }         from "./vercel.js";
export { cloudflareAdapter }     from "./cloudflare.js";
export { dockerAdapter }         from "./docker.js";
