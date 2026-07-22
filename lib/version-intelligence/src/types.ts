// ─── Phase 6.4 — Version Intelligence Engine ─────────────────────────────────

export type BumpType = "major" | "minor" | "patch";
export type ReleaseChannel = "stable" | "preview" | "hotfix";

// ─── Semver ───────────────────────────────────────────────────────────────────

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

// ─── Bump reason ─────────────────────────────────────────────────────────────

export interface BumpReason {
  type:       BumpType;
  category:   string;
  description: string;
}

// ─── Component versions (sub-artifact tracking) ──────────────────────────────

export interface ComponentVersions {
  manifestVersion:   string;
  diffVersion:       string;
  deploymentVersion: string;
  frameworkProfile:  string;
  deploymentPlan:    string;
  deploymentExecution: string;
}

// ─── Changelog ───────────────────────────────────────────────────────────────

export interface Changelog {
  major: string[];
  minor: string[];
  patch: string[];
}

// ─── Release manifest (release-manifest.json) ────────────────────────────────

export interface ReleaseManifest {
  version:         "1.0";
  phase:           "6.4";
  releaseId:       string;
  semver:          string;
  semverParsed:    SemVer;
  previousSemver:  string | null;
  bumpType:        BumpType;
  channel:         ReleaseChannel;
  generatedAt:     string;
  sourceUrl:       string | null;
  jobId:           string | null;

  componentVersions: ComponentVersions;

  stack: {
    frontend:       string;
    backend:        string;
    database:       string;
    currentHosting: string;
  };

  deployment: {
    recommendedTarget:   string;
    executionStatus:     string;
    readyToExecute:      boolean;
  };

  bumpReasons:   BumpReason[];
  changelog:     Changelog;

  outputFiles: {
    releaseManifest: string;
    releaseHistory:  string;
  };
}

// ─── Release history entry ───────────────────────────────────────────────────

export interface ReleaseHistoryEntry {
  releaseId:      string;
  semver:         string;
  bumpType:       BumpType;
  channel:        ReleaseChannel;
  generatedAt:    string;
  sourceUrl:      string | null;
  jobId:          string | null;
  stack:          { frontend: string; backend: string; database: string };
  bumpReasons:    BumpReason[];
}

// ─── Release history (release-history.json) ──────────────────────────────────

export interface ReleaseHistory {
  version:        "1.0";
  phase:          "6.4";
  currentSemver:  string;
  totalReleases:  number;
  lastUpdated:    string;
  releases:       ReleaseHistoryEntry[];
}
