/**
 * cloud/local.provider.ts — Local filesystem implementation of CloudProvider
 *
 * Writes uploaded objects as files under a configurable root directory on
 * the local filesystem. Designed for:
 *   - Development testing without R2 credentials
 *   - Integration test suites that need inspectable output
 *   - CI/CD pipeline runs that don't have cloud access
 *
 * Configuration (env vars):
 *   LOCAL_CLOUD_DIR   Root directory for stored objects.
 *                     Defaults to /tmp/article-scraper-cloud
 *
 * URL scheme:
 *   getPublicUrl(key) returns file:///LOCAL_CLOUD_DIR/key
 *   These are not network-accessible — use for local inspection only.
 *
 * Always returns isConfigured() === true once constructed.
 */

import { mkdir, writeFile, readFile, access, unlink, constants } from "fs/promises";
import { dirname, join } from "path";
import { logger } from "../lib/logger";
import type { CloudProvider, UploadParams, UploadResult } from "./provider";
import { CloudUploadError, assertUploadResult } from "./provider";

// ---------------------------------------------------------------------------
// LocalCloudProvider
// ---------------------------------------------------------------------------

export class LocalCloudProvider implements CloudProvider {
  readonly providerName = "local";

  private readonly rootDir: string;

  constructor(rootDir?: string) {
    this.rootDir =
      rootDir ??
      process.env["LOCAL_CLOUD_DIR"] ??
      "/tmp/article-scraper-cloud";
  }

  isConfigured(): boolean {
    return true;
  }

  // ── Public URL ─────────────────────────────────────────────────────────────

  getPublicUrl(key: string): string {
    return `file://${this.rootDir}/${key}`;
  }

  // ── Upload ─────────────────────────────────────────────────────────────────

  async upload(params: UploadParams): Promise<UploadResult> {
    const { key, data, checkDuplicate = true } = params;
    const startMs   = Date.now();
    const filePath  = join(this.rootDir, key);

    // ── Duplicate prevention ──────────────────────────────────────────────
    if (checkDuplicate) {
      const exists = await this._fileExists(filePath);
      if (exists) {
        logger.debug(
          { provider: this.providerName, key, filePath },
          "LOCAL CLOUD: key already exists — skipping (duplicate prevention)",
        );
        const result: UploadResult = {
          provider: this.providerName,
          key,
          url: this.getPublicUrl(key),
          skippedAsDuplicate: true,
          bytesUploaded: 0,
          attempts: 0,
          durationMs: Date.now() - startMs,
        };
        assertUploadResult(result);
        return result;
      }
    }

    // ── Write to disk ─────────────────────────────────────────────────────
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, data);

      const result: UploadResult = {
        provider: this.providerName,
        key,
        url: this.getPublicUrl(key),
        skippedAsDuplicate: false,
        bytesUploaded: data.length,
        attempts: 1,
        durationMs: Date.now() - startMs,
      };
      assertUploadResult(result);

      logger.debug(
        {
          provider: this.providerName,
          key,
          filePath,
          bytes: data.length,
          durationMs: result.durationMs,
        },
        "LOCAL CLOUD: upload written to disk",
      );

      return result;
    } catch (err) {
      throw new CloudUploadError(key, 1, true, err);
    }
  }

  // ── Verify ─────────────────────────────────────────────────────────────────

  async verify(key: string): Promise<boolean> {
    const filePath = join(this.rootDir, key);
    return this._fileExists(filePath);
  }

  // ── Download ───────────────────────────────────────────────────────────────

  async download(key: string): Promise<Buffer | null> {
    const filePath = join(this.rootDir, key);
    try {
      return await readFile(filePath);
    } catch {
      return null;
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async delete(key: string): Promise<void> {
    const filePath = join(this.rootDir, key);
    try {
      await unlink(filePath);
      logger.debug({ provider: this.providerName, key, filePath }, "LOCAL CLOUD: file deleted");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger.warn({ provider: this.providerName, key, err }, "LOCAL CLOUD: delete failed");
      }
    }
  }

  // ── Accessors (for testing / reporting) ────────────────────────────────────

  get rootDirectory(): string {
    return this.rootDir;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async _fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}
