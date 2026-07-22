/**
 * jobs-api.ts — thin fetch layer for the Job Control Center.
 *
 * Mirrors the pattern used by event-stream.ts: root-relative "/api/..." URLs
 * resolved by the Replit proxy. Raw fetch (not generated hooks) because these
 * endpoints wrap the pre-existing job-dashboard.ts engine directly.
 */

const API_BASE = "/api";

function url(path: string): string {
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

export interface ResourceUsage {
  estimatedBytesProcessed: number;
  articlesPerMinute: number | null;
  lastActiveAt: string | null;
  workerId: string | null;
  uptimeMs: number | null;
}

export interface FailureHistoryEntry {
  classifiedAt: string;
  failureClass: string;
  rootCause: string;
  retryRecommendation: string;
  riskLevel: string;
  confidence: number;
}

export interface CheckpointSummary {
  checkpointVersion: number;
  checkpointedAt: string;
  completedUrls: number;
  pendingUrls: number;
  failedUrls: number;
  coveragePercent: number;
  isValid: boolean;
}

export interface JobDetail {
  jobId: string;
  seedUrl: string;
  status: string;
  completedArticles: number;
  totalArticles: number;
  progressPercent: number;
  currentArticle: string | null;
  coveragePercent: number;
  visitedUrlCount: number;
  pendingUrlCount: number;
  remainingUrls: string[];
  retryCount: number;
  maxRetries: number;
  retriesRemaining: number;
  resourceUsage: ResourceUsage;
  failureHistory: FailureHistoryEntry[];
  recoveryActions: Array<{
    actionType: string;
    outcome: string;
    triggeredAt: string;
    actionReason: string;
  }>;
  checkpoint: CheckpointSummary | null;
  healthStatus: string | null;
  stalledForMs: number;
  diffMode: boolean;
  baseJobId: string | null;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  isChildJob: boolean;
  parentJobId: string | null;
  childJobIds: string[];
  zipPath: string | null;
  downloadUrl: string | null;
  errorMessage: string | null;
}

export interface JobSet {
  setId: string;
  seedUrl: string;
  rootJobId: string;
  parentJob: JobDetail;
  childJobs: JobDetail[];
  totalJobs: number;
  aggregateStatus: string;
  totalArticles: number;
  completedArticles: number;
  progressPercent: number;
  coveragePercent: number;
  totalRetries: number;
  failedJobs: number;
  runningJobs: number;
  completedJobs: number;
  queuedJobs: number;
  createdAt: string;
  updatedAt: string;
}

export interface ControlResult {
  operationId: string;
  jobId: string;
  operation: string;
  executedAt: string;
  success: boolean;
  detail: string;
  affectedJobIds: string[];
}

export interface SystemResources {
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    systemFreeBytes: number;
    systemTotalBytes: number;
  };
  cpu: {
    loadAvg1m: number;
    loadAvg5m: number;
    loadAvg15m: number;
    cpuCount: number;
  };
  scope: string;
  sampledAt: string;
}

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url(path), {
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  const body = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !body.ok) {
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return body.data as T;
}

export function fetchJobSets(): Promise<JobSet[]> {
  return request<JobSet[]>("/jobs");
}

export function fetchJobDetail(jobId: string): Promise<JobDetail> {
  return request<JobDetail>(`/jobs/${encodeURIComponent(jobId)}`);
}

export function fetchJobLogs(jobId: string) {
  return request<Array<{ id: string; timestamp: string; event: string; severity: string; subsystem: string; payload: Record<string, unknown> }>>(
    `/jobs/${encodeURIComponent(jobId)}/logs`,
  );
}

export function fetchSystemResources(): Promise<SystemResources> {
  return request<SystemResources>("/jobs/system/resources");
}

function post(jobId: string, action: string): Promise<ControlResult> {
  return request<ControlResult>(`/jobs/${encodeURIComponent(jobId)}/${action}`, { method: "POST" });
}

export const pauseJobApi = (jobId: string) => post(jobId, "pause");
export const resumeJobApi = (jobId: string) => post(jobId, "resume");
export const retryJobApi = (jobId: string) => post(jobId, "retry");
export const cancelJobApi = (jobId: string) => post(jobId, "cancel");

export function cloneJobApi(jobId: string) {
  return request<{ jobId: string; clonedFrom: string; seedUrl: string }>(
    `/jobs/${encodeURIComponent(jobId)}/clone`,
    { method: "POST" },
  );
}

export function runDiffApi(jobId: string) {
  return request<{ jobId: string; baseJobId: string; seedUrl: string }>(
    `/jobs/${encodeURIComponent(jobId)}/run-diff`,
    { method: "POST" },
  );
}

export function generateWebsitePrimeApi(jobId: string) {
  return request<ControlResult>(
    `/jobs/${encodeURIComponent(jobId)}/generate-website-prime`,
    { method: "POST" },
  );
}

export function triggerRecoveryApi(jobId: string) {
  return request<ControlResult>(
    `/recovery/trigger/${encodeURIComponent(jobId)}`,
    { method: "POST" },
  );
}

export interface GenerationStatus {
  generationStatus: string | null;
  constructionStatus: string | null;
  generationError: string | null;
  constructionError: string | null;
  hasOutput: boolean;
}

export async function fetchGenerationStatus(jobId: string): Promise<GenerationStatus | null> {
  try {
    return await request<GenerationStatus>(`/jobs/${encodeURIComponent(jobId)}/generation-status`);
  } catch { return null; }
}

export function manifestDownloadUrl(jobId: string): string {
  return url(`/jobs/${encodeURIComponent(jobId)}/manifest`);
}

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/** Flattens Job Sets into a flat list of individual jobs. */
export function flattenJobSets(sets: JobSet[]): JobDetail[] {
  const out: JobDetail[] = [];
  for (const s of sets) {
    out.push(s.parentJob);
    out.push(...s.childJobs);
  }
  return out;
}

export type JobCategory =
  | "all"
  | "running"
  | "queued"
  | "completed"
  | "failed"
  | "paused"
  | "recovered"
  | "retry"
  | "diff";

export function jobMatchesCategory(job: JobDetail, category: JobCategory): boolean {
  switch (category) {
    case "all": return true;
    case "running": return job.status === "running";
    case "queued": return job.status === "queued";
    case "completed": return job.status === "done";
    case "failed": return job.status === "failed" || job.status === "dead_letter";
    case "paused": return job.status === "paused";
    case "recovered": return job.recoveryActions.length > 0;
    case "retry": return job.retryCount > 0;
    case "diff": return job.diffMode === true;
    default: return false;
  }
}

/** Estimated time remaining, computed client-side from real throughput fields. */
export function estimateEtaMs(job: JobDetail): number | null {
  const rate = job.resourceUsage.articlesPerMinute;
  if (!rate || rate <= 0) return null;
  const remaining = job.totalArticles - job.completedArticles;
  if (remaining <= 0) return 0;
  return (remaining / rate) * 60_000;
}
