/**
 * cloud/index.ts — Cloud provider factory and public API
 *
 * Usage:
 *   import { createCloudProvider } from "../cloud";
 *   const provider = createCloudProvider("r2");
 *
 * The factory returns a fully-configured provider instance when credentials
 * are present, or a NoOpCloudProvider when they are not. Callers check
 * provider.isConfigured() before performing any uploads.
 *
 * Architecture is open for future backends:
 *   createCloudProvider("s3")     → S3Provider (not yet implemented)
 *   createCloudProvider("local")  → LocalCloudProvider (for testing)
 *   createCloudProvider("mock")   → MockCloudProvider (for unit tests)
 */

import { logger } from "../lib/logger";
import type { CloudProvider, UploadParams, UploadResult } from "./provider";
import { CloudUploadError } from "./provider";
import { R2Provider } from "./r2.provider";
import { LocalCloudProvider } from "./local.provider";

// Re-export the canonical interface and types so importers only need one import.
export type { CloudProvider, UploadParams, UploadResult };
export { CloudUploadError, assertUploadResult } from "./provider";

// ---------------------------------------------------------------------------
// Supported provider type discriminants
// ---------------------------------------------------------------------------

export type CloudProviderType = "r2" | "local" | "noop";

// ---------------------------------------------------------------------------
// NoOpCloudProvider — returned when credentials are absent or type is "noop"
// ---------------------------------------------------------------------------

class NoOpCloudProvider implements CloudProvider {
  readonly providerName = "noop";

  isConfigured(): boolean {
    return false;
  }

  async upload(params: UploadParams): Promise<UploadResult> {
    logger.debug(
      { provider: this.providerName, key: params.key },
      "CLOUD[noop]: upload() — no-op (provider not configured)",
    );
    throw new CloudUploadError(
      params.key,
      0,
      true,
      new Error("NoOpCloudProvider: provider is not configured"),
    );
  }

  async verify(_key: string): Promise<boolean> {
    return false;
  }

  async download(_key: string): Promise<Buffer | null> {
    return null;
  }

  getPublicUrl(key: string): string {
    return key;
  }

  async delete(_key: string): Promise<void> {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a CloudProvider for the given type.
 *
 * Returns a NoOpCloudProvider (isConfigured() === false) when:
 *   - type is "noop"
 *   - type is "r2" but R2 env vars are absent
 *
 * Never throws — callers check provider.isConfigured() instead.
 *
 * Architecture note: adding a new provider requires only:
 *   1. A new class implementing CloudProvider in src/cloud/<name>.provider.ts
 *   2. A case in this switch statement
 *   3. Adding the type discriminant to CloudProviderType above
 */
export function createCloudProvider(type: CloudProviderType): CloudProvider;
export function createCloudProvider(type: string): CloudProvider;
export function createCloudProvider(type: string): CloudProvider {
  switch (type) {
    case "r2": {
      const provider = new R2Provider();
      if (!provider.isConfigured()) {
        logger.debug(
          { type },
          "CLOUD: R2 credentials not configured — returning no-op provider",
        );
        return new NoOpCloudProvider();
      }
      return provider;
    }
    case "local": {
      const provider = new LocalCloudProvider();
      logger.debug(
        { type, rootDir: provider.rootDirectory },
        "CLOUD: local filesystem provider created",
      );
      return provider;
    }
    case "noop":
      return new NoOpCloudProvider();
    default:
      throw new Error(
        `createCloudProvider: unknown provider type "${type}". Supported: r2, local, noop`,
      );
  }
}

/**
 * Returns the default cloud provider based on available credentials.
 * Checks R2 first; falls back to no-op when nothing is configured.
 *
 * Prefer createCloudProvider("r2") when the caller knows which backend
 * to use. Use this only when the choice should be environment-driven.
 */
/**
 * Returns the default cloud provider based on environment variables.
 *
 * Selection order:
 *   1. CLOUD_PROVIDER=r2     → R2Provider (falls back to noop if unconfigured)
 *   2. CLOUD_PROVIDER=local  → LocalCloudProvider (always configured)
 *   3. CLOUD_PROVIDER=noop   → NoOpCloudProvider
 *   4. (unset) R2 creds present → R2Provider
 *   5. (unset) LOCAL_CLOUD_DIR set → LocalCloudProvider
 *   6. (unset, no creds)    → NoOpCloudProvider
 */
export function getDefaultCloudProvider(): CloudProvider {
  const explicit = process.env["CLOUD_PROVIDER"]?.toLowerCase().trim();
  if (explicit) return createCloudProvider(explicit);

  if (R2Provider.isR2Configured()) return new R2Provider();
  if (process.env["LOCAL_CLOUD_DIR"]) return new LocalCloudProvider();
  return new NoOpCloudProvider();
}
