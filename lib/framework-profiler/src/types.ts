// ─── Phase 6.1 — Framework Detection Engine ──────────────────────────────────

export type FrontendFramework =
  | "react"
  | "nextjs"
  | "astro"
  | "vue"
  | "angular"
  | "unknown";

export type BackendFramework =
  | "express"
  | "nestjs"
  | "laravel"
  | "django"
  | "rails"
  | "unknown";

export type DatabaseKind =
  | "postgres"
  | "mysql"
  | "sqlite"
  | "mongodb"
  | "none"
  | "unknown";

export type HostingProvider =
  | "vercel"
  | "netlify"
  | "replit"
  | "railway"
  | "render"
  | "vps";

export type DeployReadiness = "ready" | "warnings" | "not-ready";

// ─── Sub-profiles ─────────────────────────────────────────────────────────────

export interface FrontendProfile {
  detected:   FrontendFramework;
  version:    string | null;
  confidence: number;
  features:   string[];
  signals:    string[];
}

export interface BackendProfile {
  detected:   BackendFramework;
  version:    string | null;
  confidence: number;
  features:   string[];
  signals:    string[];
}

export interface DatabaseProfile {
  primary:           DatabaseKind;
  detected:          boolean;
  orm:               string | null;
  connectionEnvVar:  string | null;
  migrationCommand:  string | null;
  signals:           string[];
}

export interface HostingCompatibility {
  provider:     HostingProvider;
  name:         string;
  score:        number;
  compatible:   boolean;
  deployMethod: string;
  url:          string;
  reasons:      string[];
  caveats:      string[];
}

export interface HostingProfile {
  current:       string;
  compatibility: HostingCompatibility[];
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export interface FrameworkProfile {
  version:     "1.0";
  phase:       "6.1";
  generatedAt: string;
  sourceUrl:   string | null;
  jobId:       string | null;

  frontend: FrontendProfile;
  backend:  BackendProfile;
  database: DatabaseProfile;
  hosting:  HostingProfile;

  summary:             string;
  deploymentReadiness: DeployReadiness;

  outputFiles: {
    frameworkProfile: string;
  };
}
