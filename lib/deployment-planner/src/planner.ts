import { planReplit }  from "./targets/replit.js";
import { planRailway } from "./targets/railway.js";
import { planRender }  from "./targets/render.js";
import { planVercel }  from "./targets/vercel.js";
import { planVps }     from "./targets/vps.js";
import type {
  DeploymentPlan,
  PlanTargetId,
  TargetDeploymentPlan,
  MergeContext,
} from "./types.js";

// ─── Input shape (passed in by callers) ──────────────────────────────────────

export interface PlanInput {
  frontend:     string;
  backend:      string;
  database:     string;
  hasStorage:   boolean;
  currentHost:  string;
  mergeContext: MergeContext | null;
}

// ─── Merge-plan shape (subset we care about) ─────────────────────────────────

interface MergePlanJson {
  mergeRiskScore?: { level?: string };
  conflicts?:      unknown[];
  routeConflicts?: unknown[];
  apiConflicts?:   unknown[];
  databaseConflicts?: unknown[];
  componentConflicts?: unknown[];
  pages?:          unknown[];
  summary?:        string;
}

// ─── Framework-profile shape (subset) ────────────────────────────────────────

interface FrameworkProfileJson {
  frontend?:  { detected?: string; version?: string | null };
  backend?:   { detected?: string };
  database?:  { primary?: string };
  hosting?:   { current?: string };
}

// ─── Recommendation logic ─────────────────────────────────────────────────────

function pickRecommended(
  targets: Record<PlanTargetId, TargetDeploymentPlan>,
  input: PlanInput,
): { target: PlanTargetId; reason: string } {
  const { frontend, backend, currentHost } = input;

  if (currentHost === "replit") {
    return {
      target: "replit",
      reason: "Already running on Replit — Autoscale deployment is the fastest path to production with zero infrastructure setup.",
    };
  }

  if (frontend === "nextjs") {
    return {
      target: "vercel",
      reason: "Next.js detected — Vercel is the native platform with zero-config SSR, ISR, and Edge functions.",
    };
  }

  if (backend === "django" || backend === "rails") {
    return {
      target: "railway",
      reason: `${backend} detected — Railway provides native Python/Ruby support with a managed Postgres addon and no cold starts.`,
    };
  }

  // Score-based fallback
  const ordered = (Object.entries(targets) as Array<[PlanTargetId, TargetDeploymentPlan]>)
    .sort((a, b) => a[1].riskScore - b[1].riskScore);

  const best = ordered[0]!;
  return {
    target: best[0],
    reason: `Lowest risk score (${best[1].riskScore}/100) for the detected stack: ${input.frontend} + ${input.backend} + ${input.database}.`,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function buildDeploymentPlan(
  profileJson:   FrameworkProfileJson,
  mergePlanJson: MergePlanJson | null,
  sourceUrl:     string | null = null,
  jobId:         string | null = null,
): DeploymentPlan {
  const frontend   = profileJson.frontend?.detected  ?? "unknown";
  const backend    = profileJson.backend?.detected   ?? "unknown";
  const database   = profileJson.database?.primary   ?? "none";
  const currentHost = profileJson.hosting?.current   ?? "unknown";

  const hasStorage = !!(
    process.env["R2_ACCESS_KEY_ID"] ||
    process.env["AWS_ACCESS_KEY_ID"]
  );

  // Build merge context
  let mergeContext: MergeContext | null = null;
  if (mergePlanJson) {
    const allConflicts = [
      ...(mergePlanJson.conflicts          ?? []),
      ...(mergePlanJson.routeConflicts     ?? []),
      ...(mergePlanJson.apiConflicts       ?? []),
      ...(mergePlanJson.databaseConflicts  ?? []),
      ...(mergePlanJson.componentConflicts ?? []),
    ];
    mergeContext = {
      hasConflicts:  allConflicts.length > 0,
      conflictCount: allConflicts.length,
      mergeRisk:     mergePlanJson.mergeRiskScore?.level ?? "UNKNOWN",
      pagesAffected: (mergePlanJson.pages ?? []).length,
      summary:       mergePlanJson.summary ?? "Merge plan available",
    };
  }

  const input: PlanInput = { frontend, backend, database, hasStorage, currentHost, mergeContext };

  // Generate per-target plans
  const replit  = planReplit(input);
  const railway = planRailway(input);
  const render  = planRender(input);
  const vercel  = planVercel(input);
  const vps     = planVps(input);

  const targets: Record<PlanTargetId, TargetDeploymentPlan> = {
    replit, railway, render, vercel, vps,
  };

  const { target: recommended, reason: recommendationReason } = pickRecommended(targets, input);
  targets[recommended] = { ...targets[recommended]!, recommended: true };

  return {
    version:     "1.0",
    phase:       "6.2",
    generatedAt: new Date().toISOString(),
    sourceUrl,
    jobId,

    fromFrameworkProfile: "framework-profile.json",
    fromMergePlan:        mergePlanJson ? "merge-plan.json" : null,

    stack: { frontend, backend, database, currentHosting: currentHost },

    mergeContext,
    targets,
    recommended,
    recommendationReason,

    outputFiles: { deploymentPlan: "deployment-plan.json" },
  };
}
