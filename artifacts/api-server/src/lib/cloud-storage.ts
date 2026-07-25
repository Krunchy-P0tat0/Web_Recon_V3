import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface CloudStorageBackend {
  /** Returns the cloud URL on success, null on failure. */
  upload(localPath: string, cloudPath: string): Promise<string | null>;

  /**
   * Retries failed uploads up to maxAttempts times with exponential back-off.
   * Upload failures do NOT block the caller — returns null after all attempts.
   */
  uploadWithRetry(
    localPath: string,
    cloudPath: string,
    maxAttempts?: number
  ): Promise<string | null>;

  isEnabled(): boolean;
}

// ---------------------------------------------------------------------------
// No-op implementation (default when CLOUD_STORAGE_ENABLED is not set)
// ---------------------------------------------------------------------------

class NoOpCloudStorage implements CloudStorageBackend {
  isEnabled(): boolean {
    return false;
  }

  async upload(_localPath: string, _cloudPath: string): Promise<string | null> {
    return null;
  }

  async uploadWithRetry(
    _localPath: string,
    _cloudPath: string,
    _maxAttempts = 3
  ): Promise<string | null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Retry wrapper — can wrap any real CloudStorageBackend implementation
// ---------------------------------------------------------------------------

export function withRetry(
  backend: CloudStorageBackend,
  defaultMaxAttempts = 3
): CloudStorageBackend {
  return {
    isEnabled: () => backend.isEnabled(),
    upload: (lp, cp) => backend.upload(lp, cp),
    async uploadWithRetry(localPath, cloudPath, maxAttempts = defaultMaxAttempts) {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const url = await backend.upload(localPath, cloudPath);
          if (url) return url;
        } catch (err) {
          logger.warn(
            { localPath, cloudPath, attempt, maxAttempts, err },
            "CLOUD: upload attempt failed"
          );
        }
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
      logger.error(
        { localPath, cloudPath, maxAttempts },
        "CLOUD: all upload attempts exhausted"
      );
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Cloud-ready contract (Phase H.3)
// ---------------------------------------------------------------------------
//
// The system is architected for cloud integration but does NOT perform any
// cloud uploads today.  All nodes and MediaItems carry a precomputed,
// deterministic `cloudPath` field (see deriveCloudPath in manifest.ts), but
// that field is NEVER read during ZIP generation — it is purely metadata.
//
// When a real backend is ready (Phase G cloud worker):
//   1. Replace `NoOpCloudStorage` with a real implementation (S3, GCS, etc.).
//   2. Export the instance with `withRetry(new RealBackend())`.
//   3. Point job-worker.ts at the new instance — no PageNode logic changes needed.
//
// Invariants this module enforces today:
//   - `isEnabled()` returns false  → uploadWithRetry is never invoked
//   - `upload()` returns null      → no side effects, no network calls
//   - ZIP output is identical with or without a real backend wired in

export const cloudStorage: CloudStorageBackend = new NoOpCloudStorage();
