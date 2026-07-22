import { detectFrontend }            from "./frontend-detector.js";
import { detectBackend }             from "./backend-detector.js";
import { detectDatabase }            from "./database-detector.js";
import { scoreHostingCompatibility, detectCurrentHosting } from "./hosting-scorer.js";
import type { FrameworkProfile, DeployReadiness } from "./types.js";

type Vfs = Record<string, string>;

function buildSummary(profile: Omit<FrameworkProfile, "summary" | "deploymentReadiness" | "outputFiles">): string {
  const parts: string[] = [];

  if (profile.frontend.detected !== "unknown") {
    parts.push(`Frontend: ${profile.frontend.detected}${profile.frontend.version ? ` v${profile.frontend.version}` : ""}`);
  }
  if (profile.backend.detected !== "unknown") {
    parts.push(`Backend: ${profile.backend.detected}${profile.backend.version ? ` v${profile.backend.version}` : ""}`);
  }
  if (profile.database.detected) {
    parts.push(`Database: ${profile.database.primary}${profile.database.orm ? ` (${profile.database.orm})` : ""}`);
  }

  const topHosting = profile.hosting.compatibility[0];
  if (topHosting) {
    parts.push(`Best hosting match: ${topHosting.name} (${topHosting.score}/100)`);
  }

  return parts.length > 0 ? parts.join(" · ") : "No frameworks detected";
}

function computeReadiness(profile: Omit<FrameworkProfile, "summary" | "deploymentReadiness" | "outputFiles">): DeployReadiness {
  const bestHost = profile.hosting.compatibility[0];
  if (!bestHost || bestHost.score < 40) return "not-ready";

  const hasCaveats = (bestHost.caveats?.length ?? 0) > 0;
  if (profile.frontend.detected === "unknown" && profile.backend.detected === "unknown") return "not-ready";
  if (hasCaveats) return "warnings";
  return "ready";
}

/**
 * buildFrameworkProfile — detect frontend, backend, database, and hosting
 * compatibility from a VirtualFileSystem + current environment.
 *
 * Pass an empty VFS ({}) to rely purely on environment detection.
 */
export function buildFrameworkProfile(
  vfs:       Vfs = {},
  sourceUrl: string | null = null,
  jobId:     string | null = null,
): FrameworkProfile {
  const frontend = detectFrontend(vfs);
  const backend  = detectBackend(vfs);
  const database = detectDatabase(vfs);

  const hasStorage = !!(
    process.env["R2_ACCESS_KEY_ID"] ||
    process.env["AWS_ACCESS_KEY_ID"] ||
    process.env["GCS_BUCKET"]
  );

  const compatibility = scoreHostingCompatibility(
    frontend.detected,
    backend.detected,
    database.primary,
    hasStorage,
  );

  const partial = {
    version:     "1.0" as const,
    phase:       "6.1" as const,
    generatedAt: new Date().toISOString(),
    sourceUrl,
    jobId,
    frontend,
    backend,
    database,
    hosting: {
      current:       detectCurrentHosting(),
      compatibility,
    },
  };

  return {
    ...partial,
    summary:             buildSummary(partial),
    deploymentReadiness: computeReadiness(partial),
    outputFiles: {
      frameworkProfile: "framework-profile.json",
    },
  };
}
