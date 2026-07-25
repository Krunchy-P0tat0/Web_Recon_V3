/**
 * Phase 6.1 — Deployment Target Intelligence Types
 *
 * Targets: replit | vercel | cloudflare | docker
 */

export type TargetId = "replit" | "vercel" | "cloudflare" | "docker";

export type DatabaseKind = "postgres" | "mysql" | "sqlite" | "mongodb" | "none";
export type StorageKind = "r2" | "s3" | "gcs" | "local" | "none";
export type HostingEnv = "replit" | "vercel" | "cloudflare" | "docker" | "railway" | "render" | "bare" | "unknown";

// ── Environment Profile ───────────────────────────────────────────────────────

export interface EnvVarEntry {
  key: string;
  required: boolean;
  detected: boolean;
  description: string;
  example: string | null;
  secret: boolean;
}

export interface DatabaseProfile {
  kind: DatabaseKind;
  detected: boolean;
  connectionEnvVar: string | null;
  notes: string[];
  migrationCommand: string | null;
}

export interface StorageProfile {
  kind: StorageKind;
  detected: boolean;
  provider: string | null;
  bucket: string | null;
  publicBaseUrl: string | null;
  notes: string[];
}

export interface EnvironmentProfile {
  detectedHosting: HostingEnv;
  nodeVersion: string;
  runtime: "node" | "bun" | "deno" | "php" | "unknown";
  database: DatabaseProfile;
  storage: StorageProfile;
  envVars: EnvVarEntry[];
  detectedAt: string;
}

// ── Target Plan ───────────────────────────────────────────────────────────────

export interface GeneratedFile {
  path: string;
  content: string;
  description: string;
}

export interface DeployStep {
  order: number;
  title: string;
  command: string | null;
  notes: string[];
}

export interface TargetPlan {
  version: "1.0";
  target: TargetId;
  targetLabel: string;
  generatedAt: string;
  sourceUrl: string;
  summary: string;
  tier: "free" | "free-tier" | "paid";
  recommended: boolean;
  confidence: "high" | "medium" | "low";
  files: GeneratedFile[];
  envVars: EnvVarEntry[];
  deploySteps: DeployStep[];
  estimatedDeployTime: string;
  limitations: string[];
  checklist: string[];
}

export type DeploymentRisk = "LOW" | "MEDIUM" | "HIGH";

export interface RiskFactor {
  factor: string;
  severity: "low" | "medium" | "high";
  mitigation: string;
}

export interface CompatibilityNote {
  aspect: string;
  score: number;
  note: string;
}

export interface DeploymentRiskAssessment {
  deploymentRisk: DeploymentRisk;
  compatibilityScore: number;
  riskFactors: RiskFactor[];
  compatibilityNotes: CompatibilityNote[];
  summary: string;
}

export interface DeploymentIntelligenceReport {
  version: "1.0";
  phase: "5.9";
  generatedAt: string;
  sourceUrl: string;
  jobId: string | null;
  environment: EnvironmentProfile;
  targets: Record<TargetId, TargetPlan>;
  recommended: TargetId;
  reasoning: string;
  risk: DeploymentRiskAssessment;
  outputFiles: {
    intelligenceReport: string;
    checklist: string;
  };
}

export interface TargetAdapter {
  target: TargetId;
  generate(sourceUrl: string, env: EnvironmentProfile): TargetPlan;
}
