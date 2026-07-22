export type FrameworkId =
  | "react"
  | "nextjs"
  | "astro"
  | "express"
  | "laravel"
  | "wordpress"
  | "unknown";

export type HostingTier = "free" | "hobby" | "pro" | "enterprise";

export interface EnvVarSpec {
  name: string;
  required: boolean;
  description: string;
  example: string | null;
}

export interface HostingOption {
  name: string;
  provider: string;
  tier: HostingTier;
  url: string;
  recommended: boolean;
  deployMethod: "git" | "cli" | "docker" | "panel" | "managed";
  config: Record<string, string>;
  notes: string[];
}

export interface BuildConfig {
  installCommand: string;
  buildCommand: string | null;
  outputDirectory: string | null;
  startCommand: string | null;
  nodeVersion: string | null;
  phpVersion: string | null;
  envVars: EnvVarSpec[];
}

export interface DockerConfig {
  baseImage: string;
  buildSteps: string[];
  exposePort: number;
  cmd: string[];
  dockerfileSnippet: string;
}

export interface CIConfig {
  platform: "github-actions";
  filename: string;
  content: string;
}

export interface DeploymentPlan {
  version: "1.0";
  generatedAt: string;
  framework: FrameworkId;
  frameworkVersion: string | null;
  sourceUrl: string;
  summary: string;
  hostingOptions: HostingOption[];
  buildConfig: BuildConfig;
  dockerConfig: DockerConfig | null;
  ciConfig: CIConfig | null;
  checklist: string[];
}

export interface DeploymentContext {
  framework: FrameworkId;
  version: string | null;
  features: string[];
  sourceUrl: string;
}

export interface DeploymentAdapter {
  framework: FrameworkId;
  generate(ctx: DeploymentContext): DeploymentPlan;
}
