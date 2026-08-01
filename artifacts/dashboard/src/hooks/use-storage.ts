/**
 * use-storage.ts — Storage hooks for the Storage page.
 * Ported from V2. Uses direct fetch to /api/storage/* endpoints.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export interface StorageStatus {
  provider: string;
  configured: boolean;
}

export interface UploadRequest {
  key: string;
  contentBase64: string;
  contentType?: string;
}

export interface UploadResult {
  key: string;
  url?: string;
  size?: number;
}

const getBaseUrl = () => import.meta.env.BASE_URL.replace(/\/$/, "");

export function useStorageStatus() {
  return useQuery<StorageStatus>({
    queryKey: ["storage", "status"],
    queryFn: async () => {
      const res = await fetch(`${getBaseUrl()}/api/storage/status`);
      if (!res.ok) {
        if (res.status === 503) return { provider: "not configured", configured: false };
        throw new Error("Failed to fetch storage status");
      }
      return res.json();
    },
    refetchInterval: 15000,
  });
}

export function useStorageUpload() {
  const queryClient = useQueryClient();
  return useMutation<UploadResult, Error, UploadRequest>({
    mutationFn: async (data) => {
      const res = await fetch(`${getBaseUrl()}/api/storage/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Upload failed");
      return res.json();
    },
    onSuccess: () => {
      toast.success("File uploaded successfully");
      void queryClient.invalidateQueries({ queryKey: ["storage"] });
    },
    onError: (error) => {
      toast.error(`Upload error: ${error.message}`);
    },
  });
}

export function useStorageDelete() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (key: string) => {
      const res = await fetch(`${getBaseUrl()}/api/storage/${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      toast.success("File deleted");
      void queryClient.invalidateQueries({ queryKey: ["storage"] });
    },
    onError: (error) => {
      toast.error(`Delete error: ${error.message}`);
    },
  });
}

export async function downloadStorageFile(key: string) {
  const url = `${getBaseUrl()}/api/storage/${encodeURIComponent(key)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Download failed");
  const blob = await res.blob();
  const downloadUrl = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = downloadUrl;
  a.download = key;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(downloadUrl);
}
