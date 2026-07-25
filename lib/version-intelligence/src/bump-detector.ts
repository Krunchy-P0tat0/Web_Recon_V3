import type { BumpType, BumpReason, Changelog } from "./types.js";

// Partial shapes for the artifact JSONs we read
interface FrameworkProfileArtifact {
  phase?: string;
  frontend?: { detected?: string };
  backend?:  { detected?: string };
  database?: { primary?: string };
  deploymentReadiness?: string;
}

interface DeploymentPlanArtifact {
  phase?: string;
  recommended?: string;
  stack?: { frontend?: string; backend?: string; database?: string };
  mergeContext?: { hasConflicts?: boolean; conflictCount?: number; mergeRisk?: string } | null;
  targets?: Record<string, { riskScore?: number; database?: { migrationCommand?: string | null } }>;
}

interface DeploymentExecutionArtifact {
  phase?: string;
  overallStatus?: string;
  readyToExecute?: boolean;
  blockingIssues?: string[];
  warnings?: string[];
  stages?: Array<{ name: string; status: string }>;
}

interface PreviousEntry {
  stack?: { frontend?: string; backend?: string; database?: string };
}

export interface BumpAnalysis {
  bumpType:    BumpType;
  reasons:     BumpReason[];
  changelog:   Changelog;
}

export function detectBumpType(
  profile:   FrameworkProfileArtifact | null,
  plan:      DeploymentPlanArtifact | null,
  execution: DeploymentExecutionArtifact | null,
  previous:  PreviousEntry | null,
  forceBump: BumpType | null,
): BumpAnalysis {
  if (forceBump) {
    return {
      bumpType: forceBump,
      reasons: [{ type: forceBump, category: "manual", description: `Manually forced ${forceBump} bump` }],
      changelog: buildChangelog([], [], [`Manually forced ${forceBump} bump`]),
    };
  }

  const majorReasons: BumpReason[] = [];
  const minorReasons: BumpReason[] = [];
  const patchReasons: BumpReason[] = [];

  // ── Major: breaking changes ──────────────────────────────────────────────────

  // Stack changed from previous release
  if (previous?.stack && profile) {
    const prev = previous.stack;
    const curr = { frontend: profile.frontend?.detected, backend: profile.backend?.detected, database: profile.database?.primary };
    if (prev.frontend && curr.frontend && prev.frontend !== curr.frontend && curr.frontend !== "unknown") {
      majorReasons.push({ type: "major", category: "stack-change", description: `Frontend framework changed: ${prev.frontend} → ${curr.frontend}` });
    }
    if (prev.backend && curr.backend && prev.backend !== curr.backend && curr.backend !== "unknown") {
      majorReasons.push({ type: "major", category: "stack-change", description: `Backend framework changed: ${prev.backend} → ${curr.backend}` });
    }
    if (prev.database && curr.database && prev.database !== curr.database && curr.database !== "none") {
      majorReasons.push({ type: "major", category: "stack-change", description: `Database changed: ${prev.database} → ${curr.database}` });
    }
  }

  // Blocking execution issues = deployment not ready = major problem
  if (execution?.blockingIssues && execution.blockingIssues.length > 0) {
    majorReasons.push({ type: "major", category: "execution-blocked", description: `Deployment blocked: ${execution.blockingIssues[0]}` });
  }

  // High merge conflict risk
  if (plan?.mergeContext?.hasConflicts && (plan.mergeContext.conflictCount ?? 0) > 3) {
    majorReasons.push({ type: "major", category: "merge-conflicts", description: `High conflict count: ${plan.mergeContext.conflictCount} merge conflicts` });
  }

  // ── Minor: new features ──────────────────────────────────────────────────────

  // First release ever (no previous)
  if (!previous) {
    minorReasons.push({ type: "minor", category: "initial-release", description: "First release — initial version" });
  }

  // Database migration present
  const recommendedTarget = plan?.recommended ?? "replit";
  const targetPlan = plan?.targets?.[recommendedTarget];
  if (targetPlan?.database?.migrationCommand) {
    minorReasons.push({ type: "minor", category: "database-migration", description: `Database migration required: ${targetPlan.database.migrationCommand}` });
  }

  // New stack detected (first time detecting a framework)
  if (profile?.frontend?.detected && profile.frontend.detected !== "unknown" && !previous?.stack?.frontend) {
    minorReasons.push({ type: "minor", category: "stack-detected", description: `Frontend framework identified: ${profile.frontend.detected}` });
  }
  if (profile?.backend?.detected && profile.backend.detected !== "unknown" && !previous?.stack?.backend) {
    minorReasons.push({ type: "minor", category: "stack-detected", description: `Backend framework identified: ${profile.backend.detected}` });
  }

  // Deployment target changed
  if (previous && plan?.recommended) {
    // If we have a new recommended target noted vs previous — minor feature
    minorReasons.push({ type: "minor", category: "deployment-target", description: `Deployment target: ${plan.recommended} (recommended)` });
  }

  // ── Patch: fixes / updates ───────────────────────────────────────────────────

  // Execution warnings (non-blocking)
  if (execution?.warnings && execution.warnings.length > 0) {
    patchReasons.push({ type: "patch", category: "execution-warnings", description: `${execution.warnings.length} execution warning(s) noted` });
  }

  // Merge conflicts present but low count
  if (plan?.mergeContext?.hasConflicts && (plan.mergeContext.conflictCount ?? 0) <= 3) {
    patchReasons.push({ type: "patch", category: "merge-conflicts", description: `${plan.mergeContext.conflictCount} minor merge conflict(s) resolved` });
  }

  // Deployment readiness
  if (profile?.deploymentReadiness) {
    patchReasons.push({ type: "patch", category: "readiness", description: `Deployment readiness: ${profile.deploymentReadiness}` });
  }

  // Always have at least one patch reason
  if (majorReasons.length === 0 && minorReasons.length === 0 && patchReasons.length === 0) {
    patchReasons.push({ type: "patch", category: "routine", description: "Routine re-generation — content and configuration refreshed" });
  }

  // Determine the winning bump type
  const bumpType: BumpType =
    majorReasons.length > 0 ? "major" :
    minorReasons.length > 0 ? "minor" : "patch";

  const allReasons = [...majorReasons, ...minorReasons, ...patchReasons];

  return {
    bumpType,
    reasons: allReasons,
    changelog: buildChangelog(
      majorReasons.map(r => r.description),
      minorReasons.map(r => r.description),
      patchReasons.map(r => r.description),
    ),
  };
}

function buildChangelog(major: string[], minor: string[], patch: string[]): Changelog {
  return { major, minor, patch };
}
