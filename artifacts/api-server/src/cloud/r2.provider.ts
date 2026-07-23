/**
 * cloud/r2.provider.ts — Cloudflare R2 implementation of CloudProvider
 *
 * Encapsulates ALL Cloudflare R2 / AWS S3 SDK usage in this one file.
 * No other module in the project may import from @aws-sdk/client-s3.
 *
 * Responsibilities:
 *   - Reading R2 credentials from environment variables
 *   - Creating and managing the S3Client instance
 *   - Content-type derivation from object key extension
 *   - Transient error detection for retry decisions
 *   - Single-file upload with duplicate prevention (HEAD before PUT)
 *   - Exponential backoff retry for transient failures
 *   - SHA-256 integrity checksum on every upload
 *   - HEAD-based key verification
 *   - Public URL generation from bucket base URL
 */

import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createHash } from "crypto";
import { logger } from "../lib/logger";
import type { CloudProvider, UploadParams, UploadResult } from "./provider";
import { CloudUploadError, assertUploadResult } from "./provider";

// ---------------------------------------------------------------------------
// R2 configuration — read exclusively from environment variables
// ---------------------------------------------------------------------------

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicBaseUrl: string;
  endpoint: string;
}

/**
 * Reads R2 credentials from environment variables.
 * Returns null (rather than throwing) when any required variable is absent.
 *
 * Required env vars:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 *   R2_BUCKET_NAME, R2_PUBLIC_BASE_URL
 */
export function getR2Config(): R2Config | null {
  const accountId    = process.env["R2_ACCOUNT_ID"];
  const accessKeyId  = process.env["R2_ACCESS_KEY_ID"];
  const secretKey    = process.env["R2_SECRET_ACCESS_KEY"];
  const bucketName   = process.env["R2_BUCKET_NAME"];
  const publicBaseUrl = process.env["R2_PUBLIC_BASE_URL"];

  if (!accountId || !accessKeyId || !secretKey || !bucketName || !publicBaseUrl) {
    return null;
  }

  return {
    accountId,
    accessKeyId,
    secretAccessKey: secretKey,
    bucketName,
    publicBaseUrl: publicBaseUrl.replace(/\/$/, ""),
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

// ---------------------------------------------------------------------------
// Content-type derivation
// ---------------------------------------------------------------------------

const EXT_TO_CONTENT_TYPE: Record<string, string> = {
  ".html":  "text/html; charset=utf-8",
  ".htm":   "text/html; charset=utf-8",
  ".css":   "text/css; charset=utf-8",
  ".js":    "application/javascript; charset=utf-8",
  ".json":  "application/json; charset=utf-8",
  ".txt":   "text/plain; charset=utf-8",
  ".xml":   "application/xml",
  ".jpg":   "image/jpeg",
  ".jpeg":  "image/jpeg",
  ".png":   "image/png",
  ".gif":   "image/gif",
  ".webp":  "image/webp",
  ".svg":   "image/svg+xml",
  ".avif":  "image/avif",
  ".ico":   "image/x-icon",
  ".bmp":   "image/bmp",
  ".tiff":  "image/tiff",
  ".mp3":   "audio/mpeg",
  ".ogg":   "audio/ogg",
  ".wav":   "audio/wav",
  ".aac":   "audio/aac",
  ".m4a":   "audio/mp4",
  ".zip":   "application/zip",
  ".embed": "application/octet-stream",
};

function contentTypeForKey(key: string): string {
  const dot = key.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  const ext = key.slice(dot).toLowerCase();
  return EXT_TO_CONTENT_TYPE[ext] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Transient error detection
// ---------------------------------------------------------------------------

function isTransientError(err: unknown): boolean {
  const msg    = err instanceof Error ? err.message : String(err);
  const code   = (err as { Code?: string; code?: string }).Code
               ?? (err as { Code?: string; code?: string }).code
               ?? "";
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
                   ?.httpStatusCode ?? 0;

  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  const TRANSIENT_CODES = new Set([
    "RequestTimeout", "ServiceUnavailable", "SlowDown",
    "InternalError",  "ThrottlingException", "RequestThrottled",
    "TooManyRequests", "Throttling",
  ]);
  if (TRANSIENT_CODES.has(code)) return true;

  const lower = msg.toLowerCase();
  const TRANSIENT_MSGS = [
    "econnreset", "etimedout", "econnrefused", "enotfound",
    "socket hang up", "network", "timeout", "connect",
  ];
  if (TRANSIENT_MSGS.some((t) => lower.includes(t))) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

const MAX_UPLOAD_ATTEMPTS = 5;
const BACKOFF_BASE_MS     = 1000;
/** Adds ±20% jitter to avoid thundering-herd on concurrent batch uploads. */
function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// R2Provider — implements CloudProvider using Cloudflare R2 / AWS S3 SDK
// ---------------------------------------------------------------------------

export class R2Provider implements CloudProvider {
  readonly providerName = "r2";

  private readonly config: R2Config | null;
  private readonly client: S3Client | null;

  constructor() {
    this.config = getR2Config();
    this.client = this.config ? R2Provider.createClient(this.config) : null;
  }

  static isR2Configured(): boolean {
    return getR2Config() !== null;
  }

  isConfigured(): boolean {
    return this.config !== null && this.client !== null;
  }

  // ── Public URL ─────────────────────────────────────────────────────────────

  getPublicUrl(key: string): string {
    if (!this.config) return key;
    return `${this.config.publicBaseUrl}/${key}`;
  }

  // ── Upload ─────────────────────────────────────────────────────────────────

  async upload(params: UploadParams): Promise<UploadResult> {
    const { key, data, contentType, checkDuplicate = true } = params;
    const startMs = Date.now();

    if (!this.config || !this.client) {
      throw new CloudUploadError(key, 0, true, new Error("R2 not configured"));
    }

    const cfg    = this.config;
    const client = this.client;

    // ── Duplicate prevention: HEAD before PUT ─────────────────────────────
    if (checkDuplicate) {
      try {
        await client.send(
          new HeadObjectCommand({ Bucket: cfg.bucketName, Key: key }),
        );
        // Key already exists — skip
        logger.debug(
          { provider: this.providerName, key, bucket: cfg.bucketName },
          "R2: key already exists — skipping (duplicate prevention)",
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
      } catch (headErr) {
        const status =
          (headErr as { $metadata?: { httpStatusCode?: number } }).$metadata
            ?.httpStatusCode;
        if (status !== 404) {
          logger.debug(
            { key, headErr },
            "R2: HEAD check returned unexpected error — proceeding with upload",
          );
        }
        // 404 = key does not exist → proceed
      }
    }

    // ── SHA-256 integrity checksum ────────────────────────────────────────
    const checksumSha256 = createHash("sha256").update(data).digest("base64");
    const resolvedContentType = contentType ?? contentTypeForKey(key);

    let lastError: unknown = null;
    let attempts = 0;

    for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
      attempts++;
      try {
        await client.send(
          new PutObjectCommand({
            Bucket:        cfg.bucketName,
            Key:           key,
            Body:          data,
            ContentLength: data.length,
            ContentType:   resolvedContentType,
            ChecksumSHA256: checksumSha256,
            Metadata: {
              "x-source":          "article-scraper",
              "x-checksum-sha256": checksumSha256,
            },
          }),
        );

        const result: UploadResult = {
          provider: this.providerName,
          key,
          url: this.getPublicUrl(key),
          skippedAsDuplicate: false,
          bytesUploaded: data.length,
          attempts,
          durationMs: Date.now() - startMs,
        };
        assertUploadResult(result);

        logger.debug(
          {
            provider: this.providerName,
            key,
            bytes: data.length,
            attempt,
            contentType: resolvedContentType,
            durationMs: result.durationMs,
          },
          "R2: upload success",
        );

        return result;
      } catch (err) {
        lastError = err;
        const permanent = !isTransientError(err);
        logger.warn(
          {
            provider: this.providerName,
            key,
            attempt,
            maxAttempts: MAX_UPLOAD_ATTEMPTS,
            error: err instanceof Error ? err.message : String(err),
            permanent,
          },
          "R2: upload attempt failed",
        );
        if (permanent || attempt === MAX_UPLOAD_ATTEMPTS) break;
        await sleep(jitter(BACKOFF_BASE_MS * Math.pow(2, attempt - 1)));
      }
    }

    throw new CloudUploadError(
      key,
      attempts,
      !isTransientError(lastError),
      lastError,
    );
  }

  // ── Verify ─────────────────────────────────────────────────────────────────

  async verify(key: string): Promise<boolean> {
    if (!this.config || !this.client) return false;
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucketName, Key: key }),
      );
      return true;
    } catch (err) {
      const status =
        (err as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
      if (status !== 404) {
        logger.debug(
          { provider: this.providerName, key, err },
          "R2: verify HEAD returned unexpected error (treating as missing)",
        );
      }
      return false;
    }
  }

  // ── Download ───────────────────────────────────────────────────────────────

  async download(key: string): Promise<Buffer | null> {
    if (!this.config || !this.client) return null;
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucketName, Key: key }),
      );
      if (!res.Body) return null;
      const chunks: Uint8Array[] = [];
      for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (err) {
      const status =
        (err as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
      if (status !== 404) {
        logger.debug(
          { provider: this.providerName, key, err },
          "R2: download returned unexpected error (returning null)",
        );
      }
      return null;
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async delete(key: string): Promise<void> {
    if (!this.config || !this.client) return;
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.config.bucketName, Key: key }),
      );
      logger.debug({ provider: this.providerName, key }, "R2: delete complete");
    } catch (err) {
      logger.warn(
        { provider: this.providerName, key, err },
        "R2: delete failed (non-fatal)",
      );
    }
  }

  // ── List ───────────────────────────────────────────────────────────────────

  /**
   * List all objects whose key starts with `prefix`.
   * Paginates automatically; caps at 5 000 objects for safety.
   */
  async list(prefix?: string): Promise<Array<{ key: string; size: number; lastModified: string }>> {
    if (!this.config || !this.client) return [];

    const results: Array<{ key: string; size: number; lastModified: string }> = [];
    let continuationToken: string | undefined;

    do {
      const resp = await this.client.send(
        new ListObjectsV2Command({
          Bucket:            this.config.bucketName,
          Prefix:            prefix,
          ContinuationToken: continuationToken,
          MaxKeys:           1_000,
        }),
      );

      for (const obj of resp.Contents ?? []) {
        if (obj.Key) {
          results.push({
            key:          obj.Key,
            size:         obj.Size ?? 0,
            lastModified: obj.LastModified?.toISOString() ?? new Date().toISOString(),
          });
        }
      }
      continuationToken = resp.NextContinuationToken;
    } while (continuationToken && results.length < 5_000);

    return results;
  }

  // ── Accessors for reporting (R2-specific metadata) ─────────────────────────

  get bucketName(): string {
    return this.config?.bucketName ?? "";
  }

  get endpoint(): string {
    return this.config?.endpoint ?? "";
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private static createClient(config: R2Config): S3Client {
    return new S3Client({
      region:    "auto",
      endpoint:  config.endpoint,
      credentials: {
        accessKeyId:     config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: false,
    });
  }
}
