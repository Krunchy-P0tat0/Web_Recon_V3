/**
 * differential-api.ts — thin fetch layer for the Differential Center.
 *
 * Mirrors jobs-api.ts: root-relative "/api/..." URLs resolved by the Replit
 * proxy. Wraps the pre-existing Differential Engine (diff-engine.ts) and
 * Differential Intelligence Layer (diff-intelligence.ts) — no diff logic
 * lives here, only reads of what the pipeline already persisted.
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

async function request<T>(path: string): Promise<T> {
  const res = await fetch(url(path));
  const body = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !body.ok) {
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return body.data as T;
}

export interface ChangedUrlEntry {
  url: string;
  classification: "new" | "changed" | "deleted";
  changeReasons: string[];
}

export interface DiffHistoryRecord {
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
  storageSavedBytes: number;
  processingTimeSavedMs: number;
  skipRatePercent: number;
  changedUrlsJson: string;
  createdAt: string;
}

export interface DiffRunDetail extends DiffHistoryRecord {
  changedUrls: ChangedUrlEntry[];
}

export interface DiffGlobalSummary {
  totalDiffRuns: number;
  totalBandwidthSavedBytes: number;
  totalStorageSavedBytes: number;
  totalProcessingTimeSavedMs: number;
  totalPagesSkipped: number;
  averageSkipRatePercent: number;
  uniqueSeedUrls: number;
}

export interface DifferentialAuditReport {
  jobId: string;
  baseJobId: string | null;
  seedUrl: string;
  generatedAt: string;
  runClassification: "DIFF_CRAWL" | "FIRST_DIFF";
  diffGeneration: number;
  changeSummary: {
    new: number;
    changed: number;
    unchanged: number;
    deleted: number;
    total: number;
    skipRatePercent: number;
  };
  savingsThisRun: {
    bandwidthSavedBytes: number;
    bandwidthSavedMb: number;
    storageSavedBytes: number;
    processingTimeSavedMs: number;
    processingTimeSavedSec: number;
    pagesSkipped: number;
  };
  cumulativeSavings: {
    bandwidthSavedBytes: number;
    bandwidthSavedMb: number;
    storageSavedBytes: number;
    processingTimeSavedMs: number;
    totalDiffRuns: number;
  };
  timeline: {
    totalRuns: number;
    firstRunAt: string | null;
    latestRunAt: string | null;
    isFirstDiffRun: boolean;
  };
  hotspots: {
    topVolatileUrls: Array<{ url: string; changeCount: number }>;
    totalTrackedUrls: number;
  };
  velocity: {
    stabilityScore: number;
    trend: string;
    changesPerWeek: number;
  };
  lineage: {
    diffGeneration: number;
    parentJobId: string | null;
    ancestorCount: number;
  };
  restorationCompatibility: {
    r2KeysExpected: string[];
    status: "COMPLETE" | "PARTIAL";
  };
  artifactsWritten: string[];
}

export function fetchDiffSummary(): Promise<DiffGlobalSummary> {
  return request<DiffGlobalSummary>("/differential/summary");
}

export function fetchDiffHistory(limit = 50): Promise<DiffHistoryRecord[]> {
  return request<DiffHistoryRecord[]>(`/differential/history?limit=${limit}`);
}

export function fetchDiffRun(jobId: string): Promise<DiffRunDetail> {
  return request<DiffRunDetail>(`/differential/${encodeURIComponent(jobId)}`);
}

export async function fetchDiffAuditReport(jobId: string): Promise<DifferentialAuditReport | null> {
  try {
    return await request<DifferentialAuditReport>(`/differential/${encodeURIComponent(jobId)}/report`);
  } catch {
    return null;
  }
}
