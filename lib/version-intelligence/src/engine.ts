import { randomUUID }      from "crypto";
import { readFile, writeFile } from "fs/promises";
import { join }               from "path";
import { existsSync }         from "fs";
import { parse, format, bump, INITIAL_VERSION, compare } from "./semver.js";
import { detectBumpType }     from "./bump-detector.js";
import type {
  ReleaseManifest,
  ReleaseHistory,
  ReleaseHistoryEntry,
  BumpType,
  ComponentVersions,
} from "./types.js";

// ─── File paths ───────────────────────────────────────────────────────────────

const WORKSPACE_ROOT     = process.env["WORKSPACE_ROOT"]
  ?? (typeof process !== "undefined" ? (() => {
    // Detect from cwd: either we're in artifacts/api-server or workspace root
    const cwd = process.cwd();
    if (cwd.includes("api-server")) return join(cwd, "..", "..");
    return cwd;
  })() : ".");

export const MANIFEST_PATH   = join(WORKSPACE_ROOT, "release-manifest.json");
export const HISTORY_PATH    = join(WORKSPACE_ROOT, "release-history.json");
export const PROFILE_PATH    = join(WORKSPACE_ROOT, "framework-profile.json");
export const PLAN_PATH       = join(WORKSPACE_ROOT, "deployment-plan.json");
export const EXECUTION_PATH  = join(WORKSPACE_ROOT, "deployment-execution.json");

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function readJson<T>(path: string): Promise<T | null> {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch { return null; }
}

// ─── History I/O ──────────────────────────────────────────────────────────────

export async function loadHistory(): Promise<ReleaseHistory | null> {
  return readJson<ReleaseHistory>(HISTORY_PATH);
}

export function currentVersion(history: ReleaseHistory | null): string {
  return history?.currentSemver ?? INITIAL_VERSION;
}

// ─── Main: generate a new release ────────────────────────────────────────────

export async function generateRelease(opts: {
  sourceUrl?:  string | null;
  jobId?:      string | null;
  forceBump?:  BumpType | null;
  channel?:    "stable" | "preview" | "hotfix";
}): Promise<{ manifest: ReleaseManifest; history: ReleaseHistory }> {
  const { sourceUrl = null, jobId = null, forceBump = null, channel = "stable" } = opts;

  // Load all inputs in parallel
  const [profile, plan, execution, history] = await Promise.all([
    readJson<Record<string, unknown>>(PROFILE_PATH),
    readJson<Record<string, unknown>>(PLAN_PATH),
    readJson<Record<string, unknown>>(EXECUTION_PATH),
    loadHistory(),
  ]);

  // Determine current + next version
  const previousSemver = currentVersion(history);
  const lastEntry      = history?.releases[0] ?? null;

  const { bumpType, reasons, changelog } = detectBumpType(
    profile  as Parameters<typeof detectBumpType>[0],
    plan     as Parameters<typeof detectBumpType>[1],
    execution as Parameters<typeof detectBumpType>[2],
    lastEntry as Parameters<typeof detectBumpType>[3],
    forceBump,
  );

  const newSemver = bump(previousSemver, bumpType);

  // Build component versions (sub-artifact version tracking)
  const componentVersions: ComponentVersions = {
    manifestVersion:     profile?.["phase"] as string ?? "unknown",
    diffVersion:         "6.0",   // diff-intelligence phase
    deploymentVersion:   plan?.["phase"]      as string ?? "unknown",
    frameworkProfile:    profile?.["phase"]   as string ?? "unknown",
    deploymentPlan:      plan?.["phase"]      as string ?? "unknown",
    deploymentExecution: execution?.["phase"] as string ?? "unknown",
  };

  // Stack from framework-profile or deployment-plan
  const stack = {
    frontend:       (profile?.["frontend"] as Record<string,string> | undefined)?.["detected"]  ?? (plan?.["stack"] as Record<string,string> | undefined)?.["frontend"]  ?? "unknown",
    backend:        (profile?.["backend"]  as Record<string,string> | undefined)?.["detected"]  ?? (plan?.["stack"] as Record<string,string> | undefined)?.["backend"]   ?? "unknown",
    database:       (profile?.["database"] as Record<string,string> | undefined)?.["primary"]   ?? (plan?.["stack"] as Record<string,string> | undefined)?.["database"]  ?? "unknown",
    currentHosting: (profile?.["hosting"]  as Record<string,string> | undefined)?.["current"]   ?? (plan?.["stack"] as Record<string,string> | undefined)?.["currentHosting"] ?? "unknown",
  };

  const manifest: ReleaseManifest = {
    version:     "1.0",
    phase:       "6.4",
    releaseId:   randomUUID(),
    semver:      newSemver,
    semverParsed: parse(newSemver),
    previousSemver,
    bumpType,
    channel,
    generatedAt: new Date().toISOString(),
    sourceUrl:   sourceUrl ?? (profile?.["sourceUrl"] as string | null | undefined) ?? null,
    jobId,

    componentVersions,
    stack,

    deployment: {
      recommendedTarget: plan?.["recommended"] as string ?? "unknown",
      executionStatus:   execution?.["overallStatus"] as string ?? "unknown",
      readyToExecute:    execution?.["readyToExecute"] as boolean ?? false,
    },

    bumpReasons: reasons,
    changelog,

    outputFiles: {
      releaseManifest: "release-manifest.json",
      releaseHistory:  "release-history.json",
    },
  };

  // Build the new history entry
  const entry: ReleaseHistoryEntry = {
    releaseId:   manifest.releaseId,
    semver:      newSemver,
    bumpType,
    channel,
    generatedAt: manifest.generatedAt,
    sourceUrl,
    jobId,
    stack: { frontend: stack.frontend, backend: stack.backend, database: stack.database },
    bumpReasons: reasons,
  };

  // Update history
  const existingReleases = history?.releases ?? [];
  const updatedReleases  = [entry, ...existingReleases]
    .sort((a, b) => compare(b.semver, a.semver));

  const updatedHistory: ReleaseHistory = {
    version:       "1.0",
    phase:         "6.4",
    currentSemver: newSemver,
    totalReleases: updatedReleases.length,
    lastUpdated:   manifest.generatedAt,
    releases:      updatedReleases,
  };

  // Persist both files
  await Promise.all([
    writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8"),
    writeFile(HISTORY_PATH,  JSON.stringify(updatedHistory, null, 2), "utf8"),
  ]);

  return { manifest, history: updatedHistory };
}
