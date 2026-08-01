/**
 * risk-scorer.ts — Phase 5.9
 *
 * Computes deploymentRisk (LOW | MEDIUM | HIGH) and compatibilityScore (0-100)
 * from an EnvironmentProfile + recommended TargetPlan.
 */

import type {
  EnvironmentProfile,
  TargetId,
  TargetPlan,
  DeploymentRisk,
  DeploymentRiskAssessment,
  RiskFactor,
  CompatibilityNote,
} from "./targets/types.js";

// ── Framework risk weights ─────────────────────────────────────────────────────
// Higher complexity = more deployment risk

const FRAMEWORK_COMPLEXITY: Record<string, "low" | "medium" | "high"> = {
  react:     "low",
  astro:     "low",
  nextjs:    "medium",
  express:   "medium",
  laravel:   "high",
  wordpress: "high",
  unknown:   "medium",
};

// ── Database risk map ─────────────────────────────────────────────────────────

const DB_RISK: Record<string, "low" | "medium" | "high"> = {
  none:     "low",
  sqlite:   "low",
  postgres: "medium",
  mysql:    "medium",
  mongodb:  "medium",
};

// ── Main scorer ───────────────────────────────────────────────────────────────

export function scoreDeploymentRisk(
  env: EnvironmentProfile,
  targets: Record<TargetId, TargetPlan>,
  recommended: TargetId,
  detectedFramework?: string
): DeploymentRiskAssessment {
  const riskFactors: RiskFactor[] = [];
  const compatibilityNotes: CompatibilityNote[] = [];

  let score = 80; // start at 80 — base of "things work"

  // ── Database risk ────────────────────────────────────────────────────────────
  if (env.database.detected) {
    const dbRisk = DB_RISK[env.database.kind] ?? "medium";

    riskFactors.push({
      factor:     `Database dependency: ${env.database.kind}`,
      severity:   dbRisk,
      mitigation: env.database.migrationCommand
        ? `Run migrations before deploy: \`${env.database.migrationCommand}\``
        : "Provision the database and run migrations before first deployment",
    });

    const dbScore = dbRisk === "low" ? 5 : dbRisk === "medium" ? -5 : -15;
    score += dbScore;
    compatibilityNotes.push({
      aspect: "Database",
      score:  dbScore,
      note:   `${env.database.kind} detected — ensure provisioned on target`,
    });
  } else {
    score += 10;
    compatibilityNotes.push({
      aspect: "Database",
      score:  10,
      note:   "No database required — stateless deployment, lowest risk",
    });
  }

  // ── Storage risk ─────────────────────────────────────────────────────────────
  if (env.storage.detected) {
    const isR2 = env.storage.kind === "r2";
    const storageScore = isR2 && recommended === "cloudflare" ? 10 : 0;
    score += storageScore;
    compatibilityNotes.push({
      aspect: "Object Storage",
      score:  storageScore,
      note:   isR2
        ? "Cloudflare R2 detected — native binding available on Cloudflare target"
        : `${env.storage.kind} storage configured — verify credentials on target`,
    });
    if (!isR2 || recommended !== "cloudflare") {
      riskFactors.push({
        factor:     `Object storage: ${env.storage.kind} (${env.storage.provider ?? "unknown"})`,
        severity:   "low",
        mitigation: "Ensure storage credentials are set as environment variables on the deployment target",
      });
    }
  } else {
    score += 5;
    compatibilityNotes.push({
      aspect: "Object Storage",
      score:  5,
      note:   "No cloud storage configured — local filesystem only",
    });
  }

  // ── Missing required env vars ────────────────────────────────────────────────
  const missingRequired = env.envVars.filter(v => v.required && !v.detected);
  for (const v of missingRequired) {
    riskFactors.push({
      factor:     `Missing required env var: ${v.key}`,
      severity:   "high",
      mitigation: `Set ${v.key} in your deployment target's environment variables dashboard`,
    });
    score -= 8;
  }
  if (missingRequired.length > 0) {
    compatibilityNotes.push({
      aspect: "Environment Variables",
      score:  -(missingRequired.length * 8),
      note:   `${missingRequired.length} required env var(s) not detected: ${missingRequired.map(v => v.key).join(", ")}`,
    });
  } else {
    score += 5;
    compatibilityNotes.push({
      aspect: "Environment Variables",
      score:  5,
      note:   "All required environment variables detected",
    });
  }

  // ── Framework complexity ──────────────────────────────────────────────────────
  const fw = detectedFramework ?? "unknown";
  const fwComplexity = FRAMEWORK_COMPLEXITY[fw] ?? "medium";
  const fwScore = fwComplexity === "low" ? 5 : fwComplexity === "medium" ? 0 : -10;
  score += fwScore;
  compatibilityNotes.push({
    aspect: "Framework Complexity",
    score:  fwScore,
    note:   `${fw} — ${fwComplexity} deployment complexity`,
  });
  if (fwComplexity === "high") {
    riskFactors.push({
      factor:     `High-complexity framework: ${fw}`,
      severity:   "medium",
      mitigation: fw === "wordpress"
        ? "Use a managed WordPress host (WP Engine, Kinsta) or ensure server has PHP + MySQL"
        : "Ensure PHP runtime, Composer, and database are configured on the target server",
    });
  }

  // ── Target confidence bonus ───────────────────────────────────────────────────
  const recommendedPlan = targets[recommended];
  if (recommendedPlan) {
    const confBonus = recommendedPlan.confidence === "high" ? 10
                    : recommendedPlan.confidence === "medium" ? 5
                    : 0;
    score += confBonus;
    compatibilityNotes.push({
      aspect: "Target Confidence",
      score:  confBonus,
      note:   `${recommended} target confidence: ${recommendedPlan.confidence}`,
    });
  }

  // ── Hosting environment match bonus ──────────────────────────────────────────
  if (env.detectedHosting !== "unknown" && env.detectedHosting === recommended) {
    score += 5;
    compatibilityNotes.push({
      aspect: "Hosting Match",
      score:  5,
      note:   `Currently running on ${env.detectedHosting} — deploying to the same platform`,
    });
  }

  // ── Clamp score to 0-100 ─────────────────────────────────────────────────────
  const compatibilityScore = Math.max(0, Math.min(100, Math.round(score)));

  // ── Determine risk tier ───────────────────────────────────────────────────────
  const highSeverityCount = riskFactors.filter(f => f.severity === "high").length;
  const medSeverityCount  = riskFactors.filter(f => f.severity === "medium").length;

  let deploymentRisk: DeploymentRisk;
  if (highSeverityCount >= 2 || (highSeverityCount >= 1 && missingRequired.length > 0)) {
    deploymentRisk = "HIGH";
  } else if (highSeverityCount >= 1 || medSeverityCount >= 2 || compatibilityScore < 60) {
    deploymentRisk = "MEDIUM";
  } else {
    deploymentRisk = "LOW";
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  const summary =
    deploymentRisk === "LOW"
      ? `Deployment risk is LOW (compatibility score ${compatibilityScore}/100). The environment is well-configured for the recommended ${recommended} target.`
      : deploymentRisk === "MEDIUM"
      ? `Deployment risk is MEDIUM (compatibility score ${compatibilityScore}/100). Address ${riskFactors.length} risk factor(s) before deploying to ${recommended}.`
      : `Deployment risk is HIGH (compatibility score ${compatibilityScore}/100). ${highSeverityCount} critical issue(s) must be resolved before deploying.`;

  return {
    deploymentRisk,
    compatibilityScore,
    riskFactors,
    compatibilityNotes,
    summary,
  };
}

// ── Checklist aggregator ──────────────────────────────────────────────────────
// Builds a unified deployment checklist from risk factors + target plans

export interface ChecklistItem {
  id: string;
  priority: "critical" | "high" | "medium" | "low";
  category: string;
  task: string;
  detail: string | null;
  completed: boolean;
}

export interface DeploymentChecklist {
  version: "1.0";
  phase: "5.9";
  generatedAt: string;
  sourceUrl: string;
  recommendedTarget: TargetId;
  deploymentRisk: DeploymentRisk;
  compatibilityScore: number;
  totalItems: number;
  criticalItems: number;
  items: ChecklistItem[];
}

export function buildDeploymentChecklist(
  sourceUrl: string,
  recommended: TargetId,
  targets: Record<TargetId, TargetPlan>,
  risk: DeploymentRiskAssessment,
  env: EnvironmentProfile
): DeploymentChecklist {
  const items: ChecklistItem[] = [];
  let seq = 0;

  function add(
    priority: ChecklistItem["priority"],
    category: string,
    task: string,
    detail: string | null = null
  ) {
    items.push({
      id:       `chk-${String(++seq).padStart(3, "0")}`,
      priority,
      category,
      task,
      detail,
      completed: false,
    });
  }

  // ── Critical: missing required env vars ──────────────────────────────────────
  const missingRequired = env.envVars.filter(v => v.required && !v.detected);
  for (const v of missingRequired) {
    add("critical", "Environment", `Set ${v.key}`, v.description);
  }

  // ── Critical: risk factors ────────────────────────────────────────────────────
  for (const rf of risk.riskFactors.filter(r => r.severity === "high")) {
    add("critical", "Risk", rf.factor, rf.mitigation);
  }

  // ── High: database setup ──────────────────────────────────────────────────────
  if (env.database.detected) {
    add("high", "Database", `Provision ${env.database.kind} database on the ${recommended} target`, null);
    if (env.database.migrationCommand) {
      add("high", "Database", "Run database migrations before first deployment", `Command: ${env.database.migrationCommand}`);
    }
    add("high", "Database", "Verify DATABASE_URL is set in deployment target environment", null);
  }

  // ── High: storage setup ───────────────────────────────────────────────────────
  if (env.storage.detected) {
    add("high", "Storage", `Configure ${env.storage.kind} storage credentials on ${recommended}`,
      `Bucket: ${env.storage.bucket ?? "not set"} — set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME`);
  }

  // ── Medium: risk factor mitigations ──────────────────────────────────────────
  for (const rf of risk.riskFactors.filter(r => r.severity === "medium")) {
    add("medium", "Risk", rf.factor, rf.mitigation);
  }

  // ── Target-specific checklist items ──────────────────────────────────────────
  const plan = targets[recommended];
  if (plan?.checklist) {
    for (const item of plan.checklist) {
      add("medium", `Target: ${recommended}`, item, null);
    }
  }

  // ── Low: general best practices ──────────────────────────────────────────────
  add("low", "Security", "Enable HTTPS on the deployment target", "Most platforms provide this automatically");
  add("low", "Security", "Review exposed environment variables — never commit secrets to source control", null);
  add("low", "Performance", "Set cache-control headers for static assets", "Long TTL for hashed assets, no-cache for HTML");
  add("low", "Observability", "Configure error tracking (Sentry, Datadog) before going live", null);
  add("low", "Rollback", "Document rollback procedure", "Know how to revert to the previous version if deployment fails");

  // ── Low: CI/CD ────────────────────────────────────────────────────────────────
  add("low", "CI/CD", "Set up CI/CD pipeline using a GitHub Actions workflow", "Add a .github/workflows/deploy.yml that builds and deploys on push to main");

  const criticalItems = items.filter(i => i.priority === "critical").length;

  return {
    version:           "1.0",
    phase:             "5.9",
    generatedAt:       new Date().toISOString(),
    sourceUrl,
    recommendedTarget: recommended,
    deploymentRisk:    risk.deploymentRisk,
    compatibilityScore: risk.compatibilityScore,
    totalItems:        items.length,
    criticalItems,
    items,
  };
}
