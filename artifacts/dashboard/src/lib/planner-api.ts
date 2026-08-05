/**
 * planner-api.ts — Phase D4.4 API client for the Website Memory Center.
 *
 * Wraps:
 *   GET  /api/website-memory?url=<url>    — lightweight memory summary
 *   POST /api/execution-planner/plan      — full execution plan (D4.3)
 *   POST /api/orchestrate                 — launch pipeline with executionMode
 */

const API_BASE = "/api";

function apiUrl(path: string): string {
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    let msg = `Request failed: ${res.status}`;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Types — mirrors backend types from differential-execution-planner-types.ts
// ---------------------------------------------------------------------------

export type ExecutionMode =
  | "fresh"
  | "differential"
  | "resume"
  | "upgrade"
  | "regenerate-website-prime";

export type KnowledgeModuleStatus = "missing" | "outdated" | "current";

export type PipelineStageKey =
  | "crawl" | "manifest" | "diff" | "intelligence" | "design-dna"
  | "visual-dna" | "stencil" | "website-prime" | "merge"
  | "deployment-plan" | "deploy" | "certification";

export interface ModuleStatusDetail {
  stage: PipelineStageKey;
  status: KnowledgeModuleStatus;
  storedVersion: number | null;
  requiredVersion: string;
  storedGeneratorVersion: string | null;
  health: string | null;
  completed: boolean;
  generatedAt: string | null;
  checksum: string | null;
}

export interface KnowledgeStatusReport {
  modules: ModuleStatusDetail[];
  missingModules: PipelineStageKey[];
  outdatedModules: PipelineStageKey[];
  currentModules: PipelineStageKey[];
}

export interface WebsiteChangeSummary {
  detected: boolean;
  urls: { added: string[]; removed: string[]; changed: string[]; unchanged: string[] };
  assets: { added: string[]; changed: string[]; unchanged: string[] };
  baselineJobId: string | null;
  computedAt: string;
}

export interface ExecutionPlan {
  website: string;
  plannedAt: string;
  executionMode: ExecutionMode;
  memoryStatus: {
    exists: boolean;
    websiteId: string | null;
    state: string | null;
    jobId: string | null;
    lastCrawlAt: string | null;
    lastSuccessfulPipeline: string | null;
  };
  knowledgeStatus: KnowledgeStatusReport;
  websiteChangeSummary: WebsiteChangeSummary | null;
  missingModules: PipelineStageKey[];
  outdatedModules: PipelineStageKey[];
  affectedDownstreamModules: PipelineStageKey[];
  recommendedStages: PipelineStageKey[];
  estimatedWork: { totalStages: number; stagesToRun: number; description: string };
  reusableArtifacts: string[];
  unavailableArtifacts: string[];
  recoveryOptions: {
    canResume: boolean;
    lastCheckpointStage: string | null;
    checkpointJobId: string | null;
    resumeInstructions: string | null;
  };
  reasoning: string;
}

export interface WebsiteMemorySummaryResponse {
  exists: boolean;
  canonicalDomain?: string;
  websiteId?: string;
  schemaVersion?: number;
  currentPipelineState?: string;
  currentJobId?: string | null;
  lastCrawlAt?: string | null;
  lastSuccessfulPipeline?: string | null;
  completedModules?: number;
  totalModules?: number;
  websitePrimeStatus?: string;
  certificationGrade?: string | null;
  certificationScore?: number | null;
  runCount?: number;
  _version?: number;
  _savedAt?: string;
}

export interface OrchestrateResponse {
  jobId: string;
  url: string;
  status: string;
  startedAt: string;
  executionMode: string;
  executionPlan: ExecutionPlan | null;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Fetch lightweight memory summary for a URL.
 * Returns { exists: false } when no memory found.
 */
export function fetchWebsiteMemory(url: string): Promise<WebsiteMemorySummaryResponse> {
  return apiFetch<WebsiteMemorySummaryResponse>(
    `/website-memory?url=${encodeURIComponent(url)}`,
  );
}

/**
 * Generate a full execution plan by calling the D4.3 planner.
 */
export function fetchExecutionPlan(
  url: string,
  opts?: { baseJobId?: string; preferredMode?: ExecutionMode },
): Promise<ExecutionPlan> {
  return apiFetch<ExecutionPlan>("/execution-planner/plan", {
    method: "POST",
    body: JSON.stringify({ url, ...opts }),
  });
}

/**
 * Launch a pipeline job with a specific execution mode.
 */
export function orchestrateWithMode(
  url: string,
  executionMode: ExecutionMode,
  opts?: { baseJobId?: string },
): Promise<OrchestrateResponse> {
  return apiFetch<OrchestrateResponse>("/orchestrate", {
    method: "POST",
    body: JSON.stringify({ url, executionMode, ...opts }),
  });
}
