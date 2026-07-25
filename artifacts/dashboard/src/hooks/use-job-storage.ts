/**
 * use-job-storage.ts — React Query hooks for Phase D3.4 Memory Layer endpoints.
 */
import { useQuery } from "@tanstack/react-query";

const getBase = () => import.meta.env.BASE_URL.replace(/\/$/, "");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StorageOverview {
  provider:            string;
  configured:          boolean;
  bucketName:          string;
  totalFiles:          number;
  totalBytes:          number;
  jobCount:            number;
  artifactsGenerated:  number;
  storageHealth:       "healthy" | "degraded" | "unconfigured";
  lastActivity:        string | null;
}

export interface JobStorageSummary {
  jobId:                 string;
  seedUrl:               string;
  fileCount:             number;
  totalBytes:            number;
  manifestPresent:       boolean;
  websitePrimePresent:   boolean;
  certificationPresent:  boolean;
  differentialPresent:   boolean;
  visualDnaPresent:      boolean;
  brandDnaPresent:       boolean;
  checkpointCount:       number;
  hasDifferential:       boolean;
  pipelineStatus:        string;
  lastActivity:          string | null;
}

export interface ArtifactHealth {
  key:         string;
  present:     boolean;
  url:         string | null;
  sizeBytes:   number | null;
  lastChecked: string;
}

export interface JobManifest {
  schemaVersion:    string;
  jobId:            string;
  scrapeJobId:      string | null;
  seedUrl:          string;
  generatedAt:      string;
  updatedAt:        string;
  pipelineComplete: boolean;
  pipelineStatus:   string;
  stages:           Record<string, {
    stageId:     string;
    label:       string;
    status:      string;
    startedAt:   string | null;
    completedAt: string | null;
    durationMs:  number | null;
    artifacts:   Array<{ key: string; url: string; status: string }>;
    metadata:    Record<string, unknown>;
  }>;
  artifacts: {
    manifest:      string;
    websitePrime:  string;
    siteZip:       string;
    certification: string;
    differential:  string;
    visualDna:     string;
    brandDna:      string;
    checkpoints:   number;
  };
  storageStats: { estimatedFileCount: number; estimatedBytes: number };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useStorageOverview() {
  return useQuery<StorageOverview>({
    queryKey: ["storage", "overview"],
    queryFn: async () => {
      const res = await fetch(`${getBase()}/api/storage/overview`);
      if (!res.ok) {
        return {
          provider: "r2", configured: false, bucketName: "",
          totalFiles: 0, totalBytes: 0, jobCount: 0,
          artifactsGenerated: 0, storageHealth: "unconfigured" as const,
          lastActivity: null,
        };
      }
      return res.json();
    },
    refetchInterval: 30_000,
  });
}

export function useJobStorageList() {
  return useQuery<JobStorageSummary[]>({
    queryKey: ["storage", "jobs"],
    queryFn: async () => {
      const res = await fetch(`${getBase()}/api/storage/jobs`);
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: 20_000,
  });
}

export function useJobManifest(jobId: string | null) {
  return useQuery<JobManifest | null>({
    queryKey: ["storage", "jobs", jobId, "manifest"],
    queryFn: async () => {
      if (!jobId) return null;
      const res = await fetch(`${getBase()}/api/storage/jobs/${jobId}/manifest`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!jobId,
    staleTime: 10_000,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
