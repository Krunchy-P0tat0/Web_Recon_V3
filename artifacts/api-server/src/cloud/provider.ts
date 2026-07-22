/**
 * cloud/provider.ts — Canonical CloudProvider interface
 *
 * All cloud storage operations route through this interface.
 * No module outside of src/cloud/ may import from @aws-sdk/* directly.
 *
 * The UploadResult struct is the single authoritative cloud asset shape:
 *   { provider, key, url }
 * Any manifest field or report that references a cloud asset must produce
 * or consume this shape — never ad-hoc bucket-URL string concatenation.
 */

// ---------------------------------------------------------------------------
// Upload parameters
// ---------------------------------------------------------------------------

export interface UploadParams {
  /** Object key within the provider's bucket/namespace. */
  key: string;
  /** Raw bytes to upload. */
  data: Buffer;
  /** MIME type — providers derive one from key extension when omitted. */
  contentType?: string;
  /**
   * When true (default), HEAD-checks the key before uploading so an already-
   * existing object is silently skipped rather than re-uploaded.
   */
  checkDuplicate?: boolean;
}

// ---------------------------------------------------------------------------
// Canonical cloud asset — the authoritative shape for all uploaded resources
// ---------------------------------------------------------------------------

export interface UploadResult {
  /** Provider discriminant (e.g. "r2", "s3", "local", "mock"). */
  provider: string;
  /** Object key within the provider's bucket/namespace. */
  key: string;
  /** Fully-qualified public URL. Must start with http:// or https://. */
  url: string;
  /** True when the key already existed and the upload was skipped. */
  skippedAsDuplicate: boolean;
  /** Bytes written to the provider (0 when skippedAsDuplicate). */
  bytesUploaded: number;
  /** Number of upload attempts made (including the duplicate HEAD check). */
  attempts: number;
  /** Total wall-clock duration of the upload operation in milliseconds. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// CloudProvider interface — the single contract all backends satisfy
// ---------------------------------------------------------------------------

export interface CloudProvider {
  /**
   * Stable discriminant string used for logging and invariant checks.
   * Examples: "r2", "s3", "local", "mock", "noop"
   */
  readonly providerName: string;

  /**
   * Returns true if credentials/configuration are present and the provider
   * can make real network calls. Returns false for no-op providers.
   */
  isConfigured(): boolean;

  /**
   * Upload data to the given key.
   *
   * On success returns a canonical UploadResult.
   * On duplicate (when checkDuplicate is true) returns an UploadResult with
   *   skippedAsDuplicate=true and bytesUploaded=0.
   * On unrecoverable failure throws CloudUploadError after exhausting retries.
   * Transient errors are retried internally before throwing.
   */
  upload(params: UploadParams): Promise<UploadResult>;

  /**
   * Verify that a key exists in the provider's storage.
   * Returns true if the key exists, false if missing or on error.
   * Never throws — callers treat false as "not verified".
   */
  verify(key: string): Promise<boolean>;

  /**
   * Derive the fully-qualified public URL for a key.
   * Pure string computation — no network calls.
   */
  getPublicUrl(key: string): string;

  /**
   * Download the content of a key as a Buffer.
   * Returns null if the key does not exist or the provider is not configured.
   * Never throws — callers treat null as "not available".
   */
  download(key: string): Promise<Buffer | null>;

  /**
   * Delete a key from the provider's storage.
   * No-op if the key does not exist.
   * Optional — providers that don't support deletion omit this method.
   */
  delete?(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// CloudUploadError — thrown by provider.upload() on unrecoverable failure
// ---------------------------------------------------------------------------

export class CloudUploadError extends Error {
  constructor(
    public readonly key: string,
    public readonly attempts: number,
    public readonly permanent: boolean,
    cause: unknown,
  ) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(
      `CloudUploadError: key="${key}" failed after ${attempts} attempt(s): ${causeMsg}`,
    );
    this.name = "CloudUploadError";
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Invariant validation — enforce the canonical cloud asset shape
// ---------------------------------------------------------------------------

/**
 * Asserts that an UploadResult satisfies the canonical cloud asset contract.
 * Call this after every upload to catch provider bugs early.
 *
 * Invariants:
 *   1. provider field is non-empty
 *   2. key field is non-empty
 *   3. url is a valid http:// or https:// URL
 *   4. No direct bucket URL bypasses provider.getPublicUrl()
 */
export function assertUploadResult(result: UploadResult): void {
  if (!result.provider) {
    throw new Error(
      "CloudProvider invariant violated: result.provider is missing or empty",
    );
  }
  if (!result.key) {
    throw new Error(
      "CloudProvider invariant violated: result.key is missing or empty",
    );
  }
  if (!result.url || !/^https?:\/\//.test(result.url)) {
    throw new Error(
      `CloudProvider invariant violated: invalid public URL "${result.url}" — must start with http:// or https://`,
    );
  }
}
