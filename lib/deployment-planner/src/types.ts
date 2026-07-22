// ─── Phase 6.2 — Deployment Planning Engine ──────────────────────────────────

export type PlanTargetId =
  | "replit"
  | "railway"
  | "render"
  | "vercel"
  | "vps";

export type Difficulty          = "easy" | "medium" | "hard";
export type RollbackComplexity  = "simple" | "moderate" | "complex";
export type DeployMethod        = "managed" | "git" | "cli" | "docker" | "panel";

// ─── Sub-structures ───────────────────────────────────────────────────────────

export interface BuildCommands {
  install:   string;
  build:     string | null;
  start:     string;
  typecheck: string | null;
  migrate:   string | null;
}

export interface EnvVarRequirement {
  name:        string;
  required:    boolean;
  description: string;
  example:     string | null;
  sensitive:   boolean;
}

export interface DatabaseRequirement {
  needed:            boolean;
  kind:              string;
  provisioning:      string;
  migrationCommand:  string | null;
  backupStrategy:    string | null;
  estimatedCost:     string | null;
}

export interface StorageRequirement {
  needed:       boolean;
  kind:         string;
  provisioning: string;
  notes:        string[];
}

export interface DomainRequirement {
  customDomainSupported: boolean;
  defaultDomain:         string;
  sslAutomatic:          boolean;
  dnsManagedBy:          string;
  notes:                 string[];
}

export interface CostBreakdown {
  monthly:   string;
  compute:   string;
  database:  string | null;
  storage:   string | null;
  bandwidth: string | null;
  notes:     string[];
}

// ─── Per-target plan ──────────────────────────────────────────────────────────

export interface TargetDeploymentPlan {
  target:             PlanTargetId;
  targetLabel:        string;
  deployMethod:       DeployMethod;
  url:                string;

  riskScore:          number;
  estimatedCost:      string;
  costBreakdown:      CostBreakdown;
  difficulty:         Difficulty;
  rollbackComplexity: RollbackComplexity;
  recommended:        boolean;

  buildCommands:  BuildCommands;
  envVars:        EnvVarRequirement[];
  database:       DatabaseRequirement;
  storage:        StorageRequirement;
  domain:         DomainRequirement;

  deploySteps:    string[];
  risks:          string[];
  notes:          string[];
}

// ─── Merge context (from Phase 5.8 merge-plan.json) ──────────────────────────

export interface MergeContext {
  hasConflicts:   boolean;
  conflictCount:  number;
  mergeRisk:      string;
  pagesAffected:  number;
  summary:        string;
}

// ─── Root deployment plan ─────────────────────────────────────────────────────

export interface DeploymentPlan {
  version:     "1.0";
  phase:       "6.2";
  generatedAt: string;
  sourceUrl:   string | null;
  jobId:       string | null;

  fromFrameworkProfile: string;
  fromMergePlan:        string | null;

  stack: {
    frontend:       string;
    backend:        string;
    database:       string;
    currentHosting: string;
  };

  mergeContext: MergeContext | null;

  targets:               Record<PlanTargetId, TargetDeploymentPlan>;
  recommended:           PlanTargetId;
  recommendationReason:  string;

  outputFiles: {
    deploymentPlan: string;
  };
}
