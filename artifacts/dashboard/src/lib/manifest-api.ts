/**
 * manifest-api.ts — thin fetch layer for the Manifest Center.
 *
 * Mirrors jobs-api.ts. Wraps the pre-existing Manifest engine
 * (manifest.ts / manifest-store.ts / manifest-export.ts) — no manifest
 * logic lives here, only reads of the persisted snapshot.
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

export interface ManifestSummary {
  jobId: string;
  manifestStatus: string;
  schemaVersion: string;
  renderSource: string | null;
  updatedAt: string;
  totalNodes: number;
  completedNodes: number;
  progressPercent: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  totalImages: number;
  totalVideos: number;
  pathConsistencyCheck: boolean | null;
  seedUrl: string;
  createdAt: string;
}

export function fetchManifestSummary(jobId: string): Promise<ManifestSummary> {
  return request<ManifestSummary>(`/jobs/${encodeURIComponent(jobId)}/manifest/summary`);
}

export function manifestDownloadUrl(jobId: string): string {
  return url(`/jobs/${encodeURIComponent(jobId)}/manifest`);
}

/** Fetches and parses the full portable manifest JSON for the tree explorer. */
export async function fetchManifestJson(jobId: string): Promise<unknown> {
  const res = await fetch(manifestDownloadUrl(jobId));
  if (!res.ok) throw new Error(`Failed to load manifest JSON: ${res.status}`);
  return res.json();
}
