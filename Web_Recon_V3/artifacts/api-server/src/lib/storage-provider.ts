/**
 * storage-provider.ts — Storage abstraction layer
 *
 * Defines a uniform StorageProvider interface covering local, cloud, and CDN
 * backends. All paths supplied to a provider MUST originate from a StorageMap
 * field (localPath or cloudPath) — never from ad-hoc path.join() or
 * os.tmpdir() calls in caller code.
 *
 * Hierarchy today:
 *   LocalStorageProvider      — wraps fs.promises; the ONLY authorised
 *                               importer of fs/path/os in the storage layer
 *   NoOpCloudStorageProvider  — placeholder; logs every call, never uploads
 *   NoOpCdnStorageProvider    — placeholder; logs every call, returns paths
 *
 * Future phases add real implementations without changing this interface:
 *   S3StorageProvider, R2StorageProvider, CloudflareStorageProvider, …
 *
 * Contract for renderers and producers:
 *   - Receive a StorageProvider; NEVER import fs, path, or os directly
 *   - All key arguments must be values from StorageMap.localPath or .cloudPath
 *   - LocalStorageProvider.resolvePath() is the sole escape hatch for
 *     streaming writes (ZIP archiver) — caller-site usage is marked clearly
 */

import fs from "fs";
import path from "path";
import os from "os";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Provider type discriminant
// ---------------------------------------------------------------------------

export type StorageProviderType = "local" | "cloud" | "cdn";

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

/**
 * Credential placeholders — populated from environment variables when a real
 * backend is wired in. All fields are optional so the local provider can use
 * an empty object without special-casing.
 */
export interface StorageCredentialConfig {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  endpoint?: string;
  bucket?: string;
  region?: string;
  accountId?: string;
}

export interface StorageProviderConfig {
  /**
   * Discriminant used by the factory and for structured log fields.
   */
  type: StorageProviderType;

  /**
   * Base prefix applied to all keys:
   *   local  — absolute directory (e.g. os.tmpdir() or a dedicated data dir)
   *   cloud  — bucket name or object key prefix (e.g. "my-bucket/jobs")
   *   cdn    — origin prefix served by the CDN (e.g. "jobs")
   */
  rootPrefix: string;

  /**
   * Base URL prepended to keys by getPublicUrl().
   *   local  — empty string (no public URL) or a dev server URL
   *   cloud  — "https://bucket.s3.amazonaws.com" / "https://r2.example.com"
   *   cdn    — "https://cdn.example.com"
   */
  publicBaseUrl: string;

  /**
   * Credential placeholders — unused until a real backend is wired in.
   */
  credentials: StorageCredentialConfig;
}

// ---------------------------------------------------------------------------
// StorageProvider interface — the single contract all backends satisfy
// ---------------------------------------------------------------------------

/** Accepted data types for write operations. */
export type StorageData = Buffer | string | Uint8Array;

export interface StorageProvider {
  /** Provider configuration — frozen after construction. */
  readonly config: Readonly<StorageProviderConfig>;

  /**
   * Write data to the given key.
   * key MUST come from StorageMap.localPath (local) or .cloudPath (cloud/cdn).
   */
  write(key: string, data: StorageData): Promise<void>;

  /**
   * Read data from the given key. Throws if the key does not exist.
   */
  read(key: string): Promise<Buffer>;

  /**
   * Return true if the given key exists and is non-empty.
   */
  exists(key: string): Promise<boolean>;

  /**
   * Delete the item at the given key. No-op if the key does not exist.
   */
  delete(key: string): Promise<void>;

  /**
   * Derive the public-facing URL for a key.
   * Concatenates config.publicBaseUrl and the key.
   */
  getPublicUrl(key: string): string;
}

// ---------------------------------------------------------------------------
// LocalStorageProvider
// ---------------------------------------------------------------------------

/**
 * Filesystem-backed StorageProvider.
 *
 * Wraps fs.promises — the ONLY place in the system where fs is imported
 * for storage operations. All other modules must go through this class
 * (or another StorageProvider) instead of calling fs directly.
 *
 * resolvePath() is a local-only escape hatch for streaming writes (e.g. the
 * ZIP archiver pipeline). It must NOT be called by code that should remain
 * provider-agnostic. Typed as LocalStorageProvider (not StorageProvider) at
 * call sites to make this coupling explicit and grep-able.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly config: Readonly<StorageProviderConfig>;

  constructor(config: StorageProviderConfig) {
    this.config = Object.freeze({
      ...config,
      credentials: Object.freeze({ ...config.credentials }),
    });
  }

  /**
   * Resolves a storage key to an absolute filesystem path by joining
   * config.rootPrefix with the key.
   *
   * STREAMING ESCAPE HATCH — only call this from the Producer layer
   * (scraper.ts) when the archiver requires a raw WriteStream destination.
   * All text/buffer writes must use write() instead.
   */
  resolvePath(key: string): string {
    return path.join(this.config.rootPrefix, key);
  }

  async write(key: string, data: StorageData): Promise<void> {
    const fullPath = this.resolvePath(key);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, data);
    logger.debug(
      { provider: "local", key, fullPath },
      "STORAGE[local]: write complete"
    );
  }

  async read(key: string): Promise<Buffer> {
    const fullPath = this.resolvePath(key);
    logger.debug({ provider: "local", key, fullPath }, "STORAGE[local]: read");
    return fs.promises.readFile(fullPath);
  }

  async exists(key: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(this.resolvePath(key));
      return stat.size > 0;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.promises.unlink(this.resolvePath(key));
      logger.debug({ provider: "local", key }, "STORAGE[local]: delete");
    } catch {
      // treat missing file as already deleted
    }
  }

  getPublicUrl(key: string): string {
    const base = this.config.publicBaseUrl.replace(/\/$/, "");
    return base ? `${base}/${key}` : key;
  }
}

// ---------------------------------------------------------------------------
// NoOpCloudStorageProvider — placeholder until real SDK is wired in
// ---------------------------------------------------------------------------

class NoOpCloudStorageProvider implements StorageProvider {
  readonly config: Readonly<StorageProviderConfig>;

  constructor(config: StorageProviderConfig) {
    this.config = Object.freeze({
      ...config,
      credentials: Object.freeze({ ...config.credentials }),
    });
  }

  async write(key: string, _data: StorageData): Promise<void> {
    logger.debug(
      { provider: "cloud", key, rootPrefix: this.config.rootPrefix },
      "STORAGE[cloud]: write() — no-op (real SDK not yet wired)"
    );
  }

  async read(key: string): Promise<Buffer> {
    logger.debug({ provider: "cloud", key }, "STORAGE[cloud]: read() — no-op");
    throw new Error(
      `NoOpCloudStorageProvider.read(): key="${key}" — cloud reads not implemented yet`
    );
  }

  async exists(key: string): Promise<boolean> {
    logger.debug(
      { provider: "cloud", key },
      "STORAGE[cloud]: exists() — returns false (no-op)"
    );
    return false;
  }

  async delete(key: string): Promise<void> {
    logger.debug(
      { provider: "cloud", key },
      "STORAGE[cloud]: delete() — no-op"
    );
  }

  getPublicUrl(key: string): string {
    const base = this.config.publicBaseUrl.replace(/\/$/, "");
    return base ? `${base}/${key}` : key;
  }
}

// ---------------------------------------------------------------------------
// NoOpCdnStorageProvider — placeholder until CDN push is wired in
// ---------------------------------------------------------------------------

class NoOpCdnStorageProvider implements StorageProvider {
  readonly config: Readonly<StorageProviderConfig>;

  constructor(config: StorageProviderConfig) {
    this.config = Object.freeze({
      ...config,
      credentials: Object.freeze({ ...config.credentials }),
    });
  }

  async write(key: string, _data: StorageData): Promise<void> {
    logger.debug(
      { provider: "cdn", key, rootPrefix: this.config.rootPrefix },
      "STORAGE[cdn]: write() — no-op (CDN push not yet wired)"
    );
  }

  async read(key: string): Promise<Buffer> {
    logger.debug({ provider: "cdn", key }, "STORAGE[cdn]: read() — no-op");
    throw new Error(
      `NoOpCdnStorageProvider.read(): key="${key}" — CDN reads not implemented yet`
    );
  }

  async exists(key: string): Promise<boolean> {
    logger.debug(
      { provider: "cdn", key },
      "STORAGE[cdn]: exists() — returns false (no-op)"
    );
    return false;
  }

  async delete(key: string): Promise<void> {
    logger.debug(
      { provider: "cdn", key },
      "STORAGE[cdn]: delete() — no-op"
    );
  }

  getPublicUrl(key: string): string {
    const base = this.config.publicBaseUrl.replace(/\/$/, "");
    return base ? `${base}/${key}` : key;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Constructs the appropriate StorageProvider for the given config.
 * Exhaustive — adding a new StorageProviderType requires a case here.
 */
export function createStorageProvider(
  config: StorageProviderConfig
): StorageProvider {
  switch (config.type) {
    case "local":
      return new LocalStorageProvider(config);
    case "cloud":
      return new NoOpCloudStorageProvider(config);
    case "cdn":
      return new NoOpCdnStorageProvider(config);
    default: {
      const _exhaustive: never = config.type;
      throw new Error(
        `createStorageProvider: unknown type "${String(_exhaustive)}"`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Default local provider — system temp directory
// ---------------------------------------------------------------------------

/**
 * Pre-configured LocalStorageProvider rooted at os.tmpdir().
 *
 * Import this instead of calling os.tmpdir() / path.join() directly.
 * Used by scraper.ts for ZIP and JSON file creation.
 *
 * To use a different root (e.g. a mounted volume in production), replace
 * this with createStorageProvider({ type: "local", rootPrefix: "/data/jobs" }).
 */
export const defaultLocalProvider = new LocalStorageProvider({
  type: "local",
  rootPrefix: os.tmpdir(),
  publicBaseUrl: "",
  credentials: {},
});
