/**
 * mission-api.ts — API helpers for the Job Mission Control page (Phase D3.4).
 *
 * Only calls pre-existing backend endpoints. No logic lives here.
 */

const API_BASE = "/api";

function url(path: string): string {
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
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
  if (!res.ok || !body.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body.data as T;
}

// ── Checkpoint ───────────────────────────────────────────────────────────────

export interface JobCheckpointSnapshot {
  jobId: string;
  seedUrl: string;
  checkpointVersion: number;
  checkpointedAt: string;
  completedUrls: string[];
  pendingUrls: string[];
  failedUrls: string[];
  coverageState: { total: number; completed: number; failed: number; coveragePercent: number };
  manifestState: { hasManifest: boolean; nodeCount: number; lastSavedAt: string | null };
  storageState: { uploadedKeys: string[]; totalBytesUploaded: number; pendingKeys: string[] };
  isValid: boolean;
  checksum: string;
}

export function fetchJobCheckpoint(jobId: string): Promise<JobCheckpointSnapshot> {
  return request<JobCheckpointSnapshot>(`/checkpoint/${encodeURIComponent(jobId)}`);
}

export function flushCheckpoints(): Promise<{ flushed: number }> {
  return request<{ flushed: number }>("/checkpoint/flush", { method: "POST" });
}

export function resetJobCheckpoint(jobId: string): Promise<void> {
  return request(`/checkpoint/${encodeURIComponent(jobId)}/reset`, { method: "POST" });
}

// ── Manifest summary ─────────────────────────────────────────────────────────

export interface ManifestSummary {
  jobId: string;
  seedUrl: string;
  totalNodes: number;
  completed: number;
  coveragePct: number;
  lastUpdated: string | null;
}

export function fetchManifestSummary(jobId: string): Promise<ManifestSummary> {
  return request<ManifestSummary>(`/jobs/${encodeURIComponent(jobId)}/manifest/summary`);
}

// ── Differential ─────────────────────────────────────────────────────────────

export interface DiffRunResult {
  id: string;
  jobId: string;
  baseJobId: string | null;
  seedUrl: string;
  computedAt: string;
  pagesScanned: number;
  newCount: number;
  changedCount: number;
  unchangedCount: number;
  deletedCount: number;
  bandwidthSavedBytes: number;
  skipRatePercent: number;
  changedUrls: Array<{ url: string; classification: string; changeReasons: string[] }>;
}

export async function fetchJobDiffRun(jobId: string): Promise<DiffRunResult | null> {
  try {
    return await request<DiffRunResult>(`/differential/${encodeURIComponent(jobId)}`);
  } catch { return null; }
}

// ── Prime index ──────────────────────────────────────────────────────────────

export interface PrimeIndexNav {
  routes: Array<{ path: string; title: string; type: string }>;
  totalPages: number;
}

export async function fetchPrimeIndexNav(jobId: string): Promise<PrimeIndexNav | null> {
  try {
    return await request<PrimeIndexNav>(`/jobs/${encodeURIComponent(jobId)}/prime-index/nav`);
  } catch { return null; }
}

// ── Production Certification ─────────────────────────────────────────────────

export interface CertRunResult {
  certId: string;
  status: string;
  score?: number;
}

export function runProductionCertification(jobId?: string): Promise<CertRunResult> {
  return request<CertRunResult>("/production-certification/run", {
    method: "POST",
    body: JSON.stringify({ jobId }),
  });
}

export interface CertReport {
  certId: string;
  score: number;
  status: string;
  issues: Array<{ severity: string; message: string; dimension: string }>;
  generatedAt: string;
}

export async function fetchCertReport(certId: string): Promise<CertReport | null> {
  try {
    return await request<CertReport>(`/production-certification/${encodeURIComponent(certId)}/report`);
  } catch { return null; }
}

// ── Generation pipeline status ───────────────────────────────────────────────

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

// ── Recovery trigger ─────────────────────────────────────────────────────────

export interface RecoveryTriggerResult {
  success: boolean;
  detail?: string;
}

export async function triggerJobRecovery(jobId: string): Promise<RecoveryTriggerResult> {
  return request<RecoveryTriggerResult>(`/recovery/trigger/${encodeURIComponent(jobId)}`, { method: "POST" });
}

// ── Recovery for a specific job ──────────────────────────────────────────────

export interface RecoveryTimeline {
  jobId: string;
  seedUrl: string;
  failureClass: string | null;
  currentStatus: string;
  events: Array<{ type: string; at: string; detail: Record<string, unknown> }>;
}

export async function fetchJobRecoveryTimeline(jobId: string): Promise<RecoveryTimeline | null> {
  try {
    const all = await request<{ timelines: RecoveryTimeline[] }>("/recovery/timeline");
    return all.timelines.find((t) => t.jobId === jobId) ?? null;
  } catch { return null; }
}
