/**
 * execution-pipeline.ts — Phase 6.3 Deployment Execution Engine
 *
 * Reads deployment-plan.json, runs all live checks (preflight, build,
 * artifact, environment), and produces deployment-execution.json:
 * a fully validated 5-stage execution manifest ready for controlled deployment.
 *
 * Stages: prepare → build → verify → deploy → monitor
 */

import { existsSync } from "fs";
import { readFile }   from "fs/promises";
import { join }       from "path";
import { exec }       from "child_process";
import { promisify }  from "util";

const execAsync = promisify(exec);

// ─── Types ────────────────────────────────────────────────────────────────────

export type StageId          = "prepare" | "build" | "verify" | "deploy" | "monitor";
export type CheckStatus      = "pass" | "fail" | "warning" | "skip";
export type CheckType        = "preflight" | "build" | "artifact" | "environment";
export type StageStatus      = "ready" | "blocked" | "conditional";
export type OverallStatus    = "ready" | "warnings" | "blocked";

export interface ExecutionCheck {
  name:     string;
  type:     CheckType;
  status:   CheckStatus;
  required: boolean;
  message:  string;
  detail:   string | null;
}

export interface PipelineStage {
  name:              StageId;
  label:             string;
  order:             number;
  status:            StageStatus;
  description:       string;
  commands:          string[];
  artifacts:         string[];
  estimatedDuration: string;
  rollbackCommands:  string[];
  blockingIssues:    string[];
}

export interface DeploymentExecutionJson {
  version:     "1.0";
  phase:       "6.3";
  generatedAt: string;
  jobId:       string | null;

  fromDeploymentPlan:     string;
  target:                 string;
  targetLabel:            string;
  stack:                  Record<string, string>;

  preflightChecks:        ExecutionCheck[];
  buildValidation:        ExecutionCheck[];
  artifactValidation:     ExecutionCheck[];
  environmentValidation:  ExecutionCheck[];

  stages:                 PipelineStage[];

  overallStatus:          OverallStatus;
  blockingIssues:         string[];
  warnings:               string[];
  readyToExecute:         boolean;
  estimatedTotalDuration: string;

  outputFiles: { deploymentExecution: string };
}

// ─── Path constants ───────────────────────────────────────────────────────────

const WORKSPACE_ROOT   = join(process.cwd(), "..", "..");
const PLAN_PATH        = join(WORKSPACE_ROOT, "deployment-plan.json");
const PROFILE_PATH     = join(WORKSPACE_ROOT, "framework-profile.json");
const MERGE_PLAN_PATH  = join(WORKSPACE_ROOT, "merge-plan.json");
const SERVER_DIST      = join(WORKSPACE_ROOT, "artifacts", "api-server", "dist", "index.mjs");
const ROOT_PKG         = join(WORKSPACE_ROOT, "package.json");

// ─── Helper ───────────────────────────────────────────────────────────────────

function check(
  name: string,
  type: CheckType,
  required: boolean,
  status: CheckStatus,
  message: string,
  detail: string | null = null,
): ExecutionCheck {
  return { name, type, required, status, message, detail };
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch { return null; }
}

// ─── 1. Pre-flight checks ─────────────────────────────────────────────────────

async function runPreflightChecks(): Promise<ExecutionCheck[]> {
  const checks: ExecutionCheck[] = [];

  // Git status
  try {
    const { stdout } = await execAsync("git --no-optional-locks status --porcelain", { cwd: WORKSPACE_ROOT, timeout: 5000 });
    const dirty = stdout.trim().split("\n").filter(l => l && !l.startsWith("?? "));
    checks.push(check(
      "Git working tree",
      "preflight",
      false,
      dirty.length === 0 ? "pass" : "warning",
      dirty.length === 0 ? "Working tree is clean" : `${dirty.length} modified tracked file(s)`,
      dirty.length > 0 ? dirty.slice(0, 5).join(", ") : null,
    ));
  } catch {
    checks.push(check("Git working tree", "preflight", false, "skip", "git not available or not a git repo", null));
  }

  // package.json
  checks.push(check(
    "Root package.json",
    "preflight",
    true,
    existsSync(ROOT_PKG) ? "pass" : "fail",
    existsSync(ROOT_PKG) ? "Found at workspace root" : "Root package.json missing",
    null,
  ));

  // Node.js version
  const nodeVer = process.version;
  const nodeMajor = parseInt(nodeVer.replace("v", "").split(".")[0] ?? "0", 10);
  checks.push(check(
    "Node.js version",
    "preflight",
    true,
    nodeMajor >= 20 ? "pass" : "fail",
    `${nodeVer} (${nodeMajor >= 20 ? "compatible, ≥20 required" : "too old — requires Node 20+"})`,
    null,
  ));

  // pnpm
  try {
    const { stdout } = await execAsync("pnpm --version", { timeout: 5000 });
    checks.push(check("pnpm package manager", "preflight", true, "pass", `pnpm ${stdout.trim()} available`, null));
  } catch {
    checks.push(check("pnpm package manager", "preflight", true, "fail", "pnpm not found in PATH", null));
  }

  // framework-profile.json
  checks.push(check(
    "framework-profile.json present",
    "preflight",
    true,
    existsSync(PROFILE_PATH) ? "pass" : "fail",
    existsSync(PROFILE_PATH) ? "Phase 6.1 output found" : "Run POST /api/detect/framework-profile first",
    null,
  ));

  // deployment-plan.json
  checks.push(check(
    "deployment-plan.json present",
    "preflight",
    true,
    existsSync(PLAN_PATH) ? "pass" : "fail",
    existsSync(PLAN_PATH) ? "Phase 6.2 output found" : "Run POST /api/deploy/plan/v2 first",
    null,
  ));

  // merge-plan.json (optional)
  checks.push(check(
    "merge-plan.json present",
    "preflight",
    false,
    existsSync(MERGE_PLAN_PATH) ? "pass" : "warning",
    existsSync(MERGE_PLAN_PATH) ? "Phase 5.8 merge plan found" : "merge-plan.json not found — deployment will proceed without merge context",
    null,
  ));

  return checks;
}

// ─── 2. Build validation ──────────────────────────────────────────────────────

async function runBuildValidation(): Promise<ExecutionCheck[]> {
  const checks: ExecutionCheck[] = [];

  // API server package.json has build script
  const serverPkg = await readJson<Record<string, unknown>>(
    join(WORKSPACE_ROOT, "artifacts", "api-server", "package.json"),
  );
  const scripts = (serverPkg?.["scripts"] as Record<string, string> | undefined) ?? {};

  checks.push(check(
    "Build script exists",
    "build",
    true,
    "build" in scripts ? "pass" : "fail",
    "build" in scripts ? `Build command: ${scripts["build"]}` : "No 'build' script in api-server/package.json",
    null,
  ));

  checks.push(check(
    "Start script exists",
    "build",
    true,
    "start" in scripts ? "pass" : "fail",
    "start" in scripts ? `Start command: ${scripts["start"]}` : "No 'start' script in api-server/package.json",
    null,
  ));

  // TypeScript config
  const tsConfig = join(WORKSPACE_ROOT, "artifacts", "api-server", "tsconfig.json");
  checks.push(check(
    "TypeScript config present",
    "build",
    true,
    existsSync(tsConfig) ? "pass" : "fail",
    existsSync(tsConfig) ? "tsconfig.json found in api-server" : "tsconfig.json missing",
    null,
  ));

  // Server dist built
  checks.push(check(
    "Server binary compiled",
    "build",
    false,
    existsSync(SERVER_DIST) ? "pass" : "warning",
    existsSync(SERVER_DIST)
      ? "artifacts/api-server/dist/index.mjs is present"
      : "dist/index.mjs not found — run build before deploy",
    existsSync(SERVER_DIST) ? null : "pnpm --filter @workspace/api-server run build",
  ));

  // node_modules present
  const nodeModules = join(WORKSPACE_ROOT, "node_modules");
  checks.push(check(
    "node_modules installed",
    "build",
    true,
    existsSync(nodeModules) ? "pass" : "fail",
    existsSync(nodeModules) ? "Workspace node_modules present" : "Run pnpm install first",
    null,
  ));

  // pnpm-lock.yaml
  const lockFile = join(WORKSPACE_ROOT, "pnpm-lock.yaml");
  checks.push(check(
    "pnpm lockfile present",
    "build",
    true,
    existsSync(lockFile) ? "pass" : "fail",
    existsSync(lockFile) ? "pnpm-lock.yaml found" : "pnpm-lock.yaml missing — run pnpm install",
    null,
  ));

  return checks;
}

// ─── 3. Artifact validation ───────────────────────────────────────────────────

async function runArtifactValidation(): Promise<ExecutionCheck[]> {
  const checks: ExecutionCheck[] = [];

  // framework-profile.json integrity
  const profile = await readJson<Record<string, unknown>>(PROFILE_PATH);
  checks.push(check(
    "framework-profile.json integrity",
    "artifact",
    true,
    profile?.["phase"] === "6.1" ? "pass" : profile ? "warning" : "fail",
    profile?.["phase"] === "6.1"
      ? `Phase 6.1 profile valid (frontend: ${(profile["frontend"] as Record<string,string>)?.["detected"] ?? "?"}, backend: ${(profile["backend"] as Record<string,string>)?.["detected"] ?? "?"})`
      : profile ? "Profile exists but phase is not 6.1" : "framework-profile.json is missing or corrupt",
    null,
  ));

  // deployment-plan.json integrity
  const plan = await readJson<Record<string, unknown>>(PLAN_PATH);
  checks.push(check(
    "deployment-plan.json integrity",
    "artifact",
    true,
    plan?.["phase"] === "6.2" ? "pass" : plan ? "warning" : "fail",
    plan?.["phase"] === "6.2"
      ? `Phase 6.2 plan valid (target: ${String(plan["recommended"] ?? "?")}, ${Object.keys((plan["targets"] as object) ?? {}).length} targets)`
      : plan ? "Plan exists but phase is not 6.2" : "deployment-plan.json is missing or corrupt",
    null,
  ));

  // Server binary
  checks.push(check(
    "API server binary",
    "artifact",
    false,
    existsSync(SERVER_DIST) ? "pass" : "warning",
    existsSync(SERVER_DIST)
      ? "artifacts/api-server/dist/index.mjs ready"
      : "Server not compiled — build step will produce it",
    null,
  ));

  // merge-plan.json (optional artifact)
  const mergePlan = await readJson<Record<string, unknown>>(MERGE_PLAN_PATH);
  checks.push(check(
    "merge-plan.json artifact",
    "artifact",
    false,
    mergePlan ? "pass" : "warning",
    mergePlan ? "Phase 5.8 merge plan present — merge context will be included" : "No merge plan — clean deployment (no existing backend to merge with)",
    null,
  ));

  return checks;
}

// ─── 4. Environment validation ────────────────────────────────────────────────

async function runEnvironmentValidation(
  planData: Record<string, unknown> | null,
  target: string,
): Promise<ExecutionCheck[]> {
  const checks: ExecutionCheck[] = [];

  // Extract required env vars from plan
  const targetPlan = (planData?.["targets"] as Record<string, unknown>)?.[target] as Record<string, unknown> | undefined;
  const envVars = (targetPlan?.["envVars"] as Array<{ name: string; required: boolean; sensitive: boolean }>) ?? [];

  for (const ev of envVars) {
    const present = process.env[ev.name] !== undefined && process.env[ev.name] !== "";
    checks.push(check(
      `Env var: ${ev.name}`,
      "environment",
      ev.required,
      present ? "pass" : ev.required ? "fail" : "warning",
      present
        ? `${ev.name} is set${ev.sensitive ? " (value hidden)" : ""}`
        : `${ev.name} is not set${ev.required ? " — REQUIRED" : " (optional)"}`,
      present ? null : `Set ${ev.name} in your .env or deployment secrets`,
    ));
  }

  // DATABASE_URL format check
  const dbUrl = process.env["DATABASE_URL"] ?? "";
  const dbKind = (planData?.["stack"] as Record<string,string>)?.["database"] ?? "";
  if (dbUrl && dbKind && dbKind !== "none") {
    const expectedPrefix: Record<string, string[]> = {
      postgres: ["postgres://", "postgresql://"],
      mysql:    ["mysql://", "mysql2://"],
      mongodb:  ["mongodb://", "mongodb+srv://"],
      sqlite:   ["file:", ".sqlite"],
    };
    const prefixes = expectedPrefix[dbKind] ?? [];
    const formatOk = prefixes.length === 0 || prefixes.some(p => dbUrl.startsWith(p));
    checks.push(check(
      "DATABASE_URL format",
      "environment",
      true,
      formatOk ? "pass" : "warning",
      formatOk
        ? `DATABASE_URL matches expected ${dbKind} format`
        : `DATABASE_URL scheme doesn't look like ${dbKind} — expected ${prefixes[0] ?? "?"}...`,
      null,
    ));
  }

  return checks;
}

// ─── 5. Stage builder ─────────────────────────────────────────────────────────

function buildStages(
  target: string,
  plan: Record<string, unknown> | null,
  allBlocking: string[],
): PipelineStage[] {
  const targetPlan = (plan?.["targets"] as Record<string, unknown>)?.[target] as Record<string, unknown> | undefined;
  const buildCmds  = targetPlan?.["buildCommands"] as Record<string, string | null> | undefined;
  const migCmd     = buildCmds?.["migrate"];
  const buildCmd   = buildCmds?.["build"];
  const startCmd   = buildCmds?.["start"];
  const installCmd = buildCmds?.["install"] ?? "pnpm install --frozen-lockfile";

  return [
    {
      name:  "prepare",
      label: "Prepare",
      order: 1,
      status: allBlocking.length === 0 ? "ready" : "blocked",
      description: "Install dependencies, validate environment, run pre-flight checks",
      commands: [
        installCmd,
        "pnpm run typecheck:libs",
        ...(migCmd ? [`# Optional pre-deploy migration: ${migCmd}`] : []),
      ],
      artifacts:         ["node_modules/", "pnpm-lock.yaml"],
      estimatedDuration: "2–3 min",
      rollbackCommands:  ["# Nothing to roll back in prepare stage"],
      blockingIssues:    allBlocking.filter(b => b.toLowerCase().includes("env") || b.toLowerCase().includes("missing")),
    },
    {
      name:  "build",
      label: "Build",
      order: 2,
      status: "ready",
      description: "Typecheck, compile TypeScript, and bundle the API server",
      commands: [
        "pnpm run typecheck",
        ...(buildCmd ? [buildCmd] : ["pnpm --filter @workspace/api-server run build"]),
      ],
      artifacts:         ["artifacts/api-server/dist/index.mjs", "artifacts/api-server/dist/index.mjs.map"],
      estimatedDuration: "1–2 min",
      rollbackCommands:  ["rm -rf artifacts/api-server/dist/", "# Restore previous dist from git: git checkout HEAD -- artifacts/api-server/dist/"],
      blockingIssues:    [],
    },
    {
      name:  "verify",
      label: "Verify",
      order: 3,
      status: "ready",
      description: "Validate compiled artifacts, health-check the built server, confirm all output files exist",
      commands: [
        "test -f artifacts/api-server/dist/index.mjs || (echo 'MISSING: dist/index.mjs' && exit 1)",
        "test -f framework-profile.json || (echo 'MISSING: framework-profile.json' && exit 1)",
        "test -f deployment-plan.json || (echo 'MISSING: deployment-plan.json' && exit 1)",
        "node -e \"require('./artifacts/api-server/dist/index.mjs')\" 2>&1 | head -5 || true",
      ],
      artifacts:         ["framework-profile.json", "deployment-plan.json", "deployment-execution.json"],
      estimatedDuration: "30 sec",
      rollbackCommands:  ["# Restore previous JSON artifacts from git stash or checkpoint"],
      blockingIssues:    [],
    },
    {
      name:  "deploy",
      label: "Deploy",
      order: 4,
      status: "conditional",
      description: buildDeployDescription(target, targetPlan),
      commands: buildDeployCommands(target, startCmd, migCmd),
      artifacts:         ["# Target-specific: deployment URL, container ID, or release tag"],
      estimatedDuration: "2–5 min",
      rollbackCommands:  buildRollbackCommands(target),
      blockingIssues:    [],
    },
    {
      name:  "monitor",
      label: "Monitor",
      order: 5,
      status: "conditional",
      description: "Verify the deployed service is healthy, check logs for errors, confirm all env vars are loaded",
      commands: [
        "# Replace <URL> with your deployed domain",
        "curl -sf https://<URL>/api/healthz | jq .status",
        "# Confirm critical endpoints:",
        "curl -sf https://<URL>/api/detect/framework-profile | jq .phase",
        "curl -sf https://<URL>/api/deploy/plan/v2 | jq .phase",
        "# Check logs for ERROR-level entries (first 5 minutes post-deploy)",
      ],
      artifacts:         ["# Health report from deployed service"],
      estimatedDuration: "5–10 min",
      rollbackCommands: [
        "# If health checks fail, execute rollback on the deploy stage",
        ...buildRollbackCommands(target),
      ],
      blockingIssues: [],
    },
  ];
}

function buildDeployDescription(target: string, targetPlan: Record<string, unknown> | undefined): string {
  const labels: Record<string, string> = {
    replit:  "Trigger Replit Autoscale deployment from the Deployments tab",
    railway: "Push to git remote — Railway auto-deploys on push",
    render:  "Push to git remote — Render auto-deploys on push",
    vercel:  "Push to git remote or run `vercel --prod` CLI",
    vps:     "SSH into the server, pull latest, restart the service via systemd or PM2",
  };
  const method = (targetPlan?.["deployMethod"] as string) ?? "git";
  return labels[target] ?? `Deploy using ${method} method`;
}

function buildDeployCommands(target: string, startCmd: string | null | undefined, migCmd: string | null | undefined): string[] {
  const base: Record<string, string[]> = {
    replit: [
      "# In Replit UI: Deployments tab → Autoscale → Deploy",
      "# Or via Replit CLI:",
      "replit deploy --prod",
    ],
    railway: [
      "git add -A && git commit -m 'chore: deploy'",
      "git push origin main",
      "# Railway auto-deploys on push — monitor at railway.app dashboard",
      ...(migCmd ? [`# Run migrations via Railway CLI: railway run ${migCmd}`] : []),
    ],
    render: [
      "git add -A && git commit -m 'chore: deploy'",
      "git push origin main",
      "# Render auto-deploys on push — monitor at dashboard.render.com",
      ...(migCmd ? [`# Run migrations via Render Shell: ${migCmd}`] : []),
    ],
    vercel: [
      "git add -A && git commit -m 'chore: deploy'",
      "git push origin main",
      "# Or: vercel --prod",
      ...(migCmd ? [`# Run migrations via Vercel CLI: vercel env pull && ${migCmd}`] : []),
    ],
    vps: [
      "ssh user@your-server",
      "cd /opt/your-app && git pull origin main",
      startCmd ? `${startCmd === "node dist/index.mjs" ? "pnpm --filter @workspace/api-server run build && " : ""}${startCmd}` : "pnpm --filter @workspace/api-server run build",
      ...(migCmd ? [migCmd] : []),
      "sudo systemctl restart your-app.service",
      "# Or with PM2: pm2 restart ecosystem.config.js",
    ],
  };
  return base[target] ?? ["# Deploy via your target-specific CLI"];
}

function buildRollbackCommands(target: string): string[] {
  const cmds: Record<string, string[]> = {
    replit:  ["# In Replit UI: Deployments tab → select previous deployment → Rollback"],
    railway: ["railway rollback", "# Or: git revert HEAD && git push"],
    render:  ["# Render UI: Events tab → previous successful deploy → Rollback"],
    vercel:  ["vercel rollback", "# Or: Vercel UI → Deployments → previous → Promote to Production"],
    vps:     ["ssh user@your-server", "cd /opt/your-app && git reset --hard HEAD~1", "pnpm --filter @workspace/api-server run build", "sudo systemctl restart your-app.service"],
  };
  return cmds[target] ?? ["# Rollback via your target-specific dashboard"];
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

export async function generateExecutionPipeline(
  targetOverride?: string,
  jobId:           string | null = null,
): Promise<DeploymentExecutionJson> {
  const plan = await readJson<Record<string, unknown>>(PLAN_PATH);
  const target = targetOverride ?? (plan?.["recommended"] as string | undefined) ?? "replit";

  const targetPlan = (plan?.["targets"] as Record<string, unknown>)?.[target] as Record<string, unknown> | undefined;
  const targetLabel = (targetPlan?.["targetLabel"] as string | undefined) ?? target;
  const stack = (plan?.["stack"] as Record<string, string> | undefined) ?? {};

  const [preflight, build, artifact, environment] = await Promise.all([
    runPreflightChecks(),
    runBuildValidation(),
    runArtifactValidation(),
    runEnvironmentValidation(plan, target),
  ]);

  const allChecks = [...preflight, ...build, ...artifact, ...environment];

  const blockingIssues = allChecks
    .filter(c => c.required && c.status === "fail")
    .map(c => `[${c.type.toUpperCase()}] ${c.name}: ${c.message}`);

  const warnings = allChecks
    .filter(c => c.status === "warning")
    .map(c => `[${c.type.toUpperCase()}] ${c.name}: ${c.message}`);

  const stages = buildStages(target, plan, blockingIssues);

  const overallStatus: OverallStatus =
    blockingIssues.length > 0 ? "blocked"
    : warnings.length > 0    ? "warnings"
    : "ready";

  return {
    version:     "1.0",
    phase:       "6.3",
    generatedAt: new Date().toISOString(),
    jobId,

    fromDeploymentPlan: "deployment-plan.json",
    target,
    targetLabel,
    stack,

    preflightChecks:       preflight,
    buildValidation:       build,
    artifactValidation:    artifact,
    environmentValidation: environment,

    stages,

    overallStatus,
    blockingIssues,
    warnings,
    readyToExecute: blockingIssues.length === 0,
    estimatedTotalDuration: "8–15 min (full pipeline including deploy verification)",

    outputFiles: { deploymentExecution: "deployment-execution.json" },
  };
}
