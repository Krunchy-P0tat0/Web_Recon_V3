/**
 * media-pipeline.ts — Media acquisition pipeline
 *
 * Separates media fetching from rendering. Responsibilities:
 *   1. Fetch a media URL and capture response metadata (mimeType, byteSize).
 *   2. Detect image dimensions from raw buffer bytes — no external libraries.
 *   3. Classify fetched media into a semantic category (image/video/audio/document).
 *   4. Compute a SHA-256 checksum for each downloaded buffer.
 *   5. Validate the fetched result before it enters the runtime store.
 *   6. Provide a typed buffer store (MediaBufferStore) that Phase 2 populates
 *      and Phase 2.5 consumes; renderers only read from the store, never fetch.
 *
 * Lifecycle this module enforces:
 *   pending → downloaded → rendered   (success path)
 *   pending → skipped                 (not applicable for extraction mode)
 *   pending → failed                  (fetch or validation failure)
 *
 * Constraints:
 *   - NO database access
 *   - NO queue abstractions
 *   - NO imports from renderer.ts or scraper.ts
 *   - Renderers must NOT import this module — they consume the prepared store
 */

import crypto from "crypto";
import axios from "axios";
import { logger } from "./logger";
import type { MediaClassification } from "./manifest";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { MediaClassification };

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface MediaFetchResult {
  buffer: Buffer;
  mimeType: string;
  mediaClassification: MediaClassification;
  byteSize: number;
  dimensions: ImageDimensions | null;
  checksum: string;
}

export interface MediaValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Runtime buffer store — keyed by MediaItem.id.
 * Phase 2 writes here after a successful fetch + validation.
 * Phase 2.5 reads here and appends each buffer to the archive, then discards.
 * Never persisted; lives only for the duration of one runScrapeJob() call.
 */
export type MediaBufferStore = Map<string, MediaFetchResult>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_IMAGE_BYTES   = 5  * 1024 * 1024;   // 5 MB per image
const MAX_MEDIA_BYTES   = 20 * 1024 * 1024;   // 20 MB for video/audio/document
const FETCH_TIMEOUT_MS  = 15_000;
const MAX_REDIRECTS     = 3;
const USER_AGENT =
  "Mozilla/5.0 (compatible; WebScraper/1.0; +https://example.com/bot)";

// ---------------------------------------------------------------------------
// Checksum
// ---------------------------------------------------------------------------

/**
 * Computes a SHA-256 hex digest of the given buffer.
 * Stored on MediaItem.checksum for deduplication and integrity checks.
 */
export function computeChecksum(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * classifyMedia — derives a MediaClassification from a MIME type string.
 *
 * This is the SINGLE authoritative mapping from MIME → semantic category.
 * No other code in the system should make this determination.
 */
export function classifyMedia(mimeType: string): MediaClassification {
  const t = mimeType.toLowerCase();

  if (t.startsWith("image/"))                         return "image";
  if (t.startsWith("video/"))                         return "video";
  if (t.startsWith("audio/"))                         return "audio";

  // Document formats
  if (
    t === "application/pdf" ||
    t === "application/msword" ||
    t === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    t === "application/vnd.ms-excel" ||
    t === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    t === "application/vnd.ms-powerpoint" ||
    t === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    t === "application/epub+zip" ||
    t === "text/plain" ||
    t === "text/csv" ||
    t === "text/markdown"
  ) {
    return "document";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// MIME type detection
// ---------------------------------------------------------------------------

/**
 * Magic-byte signatures — format detection without Content-Type header.
 */
function isPng(buf: Buffer): boolean {
  return (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  );
}

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
}

function isGif(buf: Buffer): boolean {
  return (
    buf.length >= 6 &&
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46
  );
}

function isWebP(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  );
}

function isPdf(buf: Buffer): boolean {
  return buf.length >= 4 && buf.slice(0, 4).toString("ascii") === "%PDF";
}

function isMp4(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  const ftyp = buf.slice(4, 8).toString("ascii");
  return ftyp === "ftyp" || ftyp === "moov";
}

function isMp3(buf: Buffer): boolean {
  return (
    buf.length >= 3 &&
    ((buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) ||  // MPEG sync
     (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33))  // ID3 tag
  );
}

/**
 * detectMimeType — derives the MIME type string.
 * Prefers Content-Type response header; falls back to magic-byte inspection.
 * Returns "application/octet-stream" when nothing can be determined.
 */
export function detectMimeType(buffer: Buffer, contentType?: string): string {
  if (contentType) {
    const clean = contentType.split(";")[0].trim().toLowerCase();
    if (clean.length > 0) return clean;
  }
  if (isPng(buffer))  return "image/png";
  if (isJpeg(buffer)) return "image/jpeg";
  if (isGif(buffer))  return "image/gif";
  if (isWebP(buffer)) return "image/webp";
  if (isPdf(buffer))  return "application/pdf";
  if (isMp4(buffer))  return "video/mp4";
  if (isMp3(buffer))  return "audio/mpeg";

  const head = buffer.slice(0, 64).toString("utf8").trim().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("svg"))) {
    return "image/svg+xml";
  }
  return "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Dimension detection — pure, no external dependencies
// ---------------------------------------------------------------------------

function readPngDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

function readJpegDimensions(buf: Buffer): ImageDimensions | null {
  let offset = 2;
  while (offset + 8 < buf.length) {
    if (buf[offset] !== 0xff) break;
    const marker = buf[offset + 1];
    const segLen = buf.readUInt16BE(offset + 2);
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (offset + 8 >= buf.length) return null;
      const height = buf.readUInt16BE(offset + 5);
      const width  = buf.readUInt16BE(offset + 7);
      if (width === 0 || height === 0) return null;
      return { width, height };
    }
    offset += 2 + segLen;
  }
  return null;
}

function readGifDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 10) return null;
  const width  = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

function readWebpDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 30) return null;
  const subtype = buf.slice(12, 16).toString("ascii");
  if (subtype === "VP8 ") {
    const width  = (buf.readUInt16LE(26) & 0x3fff) + 1;
    const height = (buf.readUInt16LE(28) & 0x3fff) + 1;
    return { width, height };
  }
  if (subtype === "VP8L") {
    if (buf.length < 25) return null;
    const bits   = buf.readUInt32LE(21);
    const width  = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  if (subtype === "VP8X") {
    const width  = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
    const height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
    return { width, height };
  }
  return null;
}

/**
 * detectImageDimensions — parses image dimensions from raw bytes.
 * Only meaningful for image/* MIME types; returns null for all others.
 */
export function detectImageDimensions(
  buffer: Buffer,
  mimeType: string
): ImageDimensions | null {
  try {
    if (mimeType === "image/png"  || isPng(buffer))  return readPngDimensions(buffer);
    if (mimeType === "image/jpeg" || mimeType === "image/jpg" || isJpeg(buffer)) return readJpegDimensions(buffer);
    if (mimeType === "image/gif"  || isGif(buffer))  return readGifDimensions(buffer);
    if (mimeType === "image/webp" || isWebP(buffer)) return readWebpDimensions(buffer);
  } catch {
    // Parsing failure is non-fatal
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * sizeLimit — per-classification maximum byte count.
 * Images get a tighter budget since they're always downloaded.
 * Other types get a larger budget if the extraction mode requests them.
 */
function sizeLimit(classification: MediaClassification): number {
  return classification === "image" ? MAX_IMAGE_BYTES : MAX_MEDIA_BYTES;
}

/**
 * validateMediaFetch — validates a fetched result before the buffer store.
 *
 * Updated from the old version: accepts all classifiable MIME types (not just
 * image/*). Unknown/unclassifiable types are still rejected.
 */
export function validateMediaFetch(
  result: MediaFetchResult,
  sourceUrl: string
): MediaValidationResult {
  if (result.mediaClassification === "unknown") {
    return {
      valid: false,
      reason: `unclassifiable_mime_type:${result.mimeType}`,
    };
  }
  const limit = sizeLimit(result.mediaClassification);
  if (result.byteSize > limit) {
    return {
      valid: false,
      reason: `exceeds_size_limit:${result.byteSize}>${limit}`,
    };
  }
  if (result.byteSize === 0) {
    return { valid: false, reason: "empty_response" };
  }
  logger.debug(
    {
      sourceUrl,
      mimeType: result.mimeType,
      classification: result.mediaClassification,
      byteSize: result.byteSize,
      dimensions: result.dimensions,
      checksum: result.checksum.slice(0, 12) + "…",
    },
    "MEDIA_PIPELINE: validation passed"
  );
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * fetchMedia — fetches a single media URL and returns a fully populated
 * MediaFetchResult including classification and checksum.
 *
 * Returns null on network failure, timeout, or non-2xx response.
 * Never throws.
 */
export async function fetchMedia(
  sourceUrl: string
): Promise<MediaFetchResult | null> {
  try {
    const response = await axios.get<ArrayBuffer>(sourceUrl, {
      responseType: "arraybuffer",
      headers: { "User-Agent": USER_AGENT },
      timeout: FETCH_TIMEOUT_MS,
      maxRedirects: MAX_REDIRECTS,
      maxContentLength: MAX_MEDIA_BYTES,
      maxBodyLength: MAX_MEDIA_BYTES,
    });

    const buffer = Buffer.from(response.data);
    const contentType =
      (response.headers["content-type"] as string | undefined) ?? undefined;
    const mimeType            = detectMimeType(buffer, contentType);
    const mediaClassification = classifyMedia(mimeType);
    const byteSize            = buffer.length;
    const dimensions          = detectImageDimensions(buffer, mimeType);
    const checksum            = computeChecksum(buffer);

    return { buffer, mimeType, mediaClassification, byteSize, dimensions, checksum };
  } catch (err) {
    logger.debug({ sourceUrl, err }, "MEDIA_PIPELINE: fetch failed");
    return null;
  }
}

/**
 * fetchMediaWithRetry — exponential back-off retry wrapper for fetchMedia.
 * Returns null after all attempts are exhausted.
 */
export async function fetchMediaWithRetry(
  sourceUrl: string,
  maxAttempts = 3
): Promise<MediaFetchResult | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fetchMedia(sourceUrl);
    if (result !== null) return result;
    if (attempt < maxAttempts) {
      const delay = 300 * attempt;
      logger.debug(
        { sourceUrl, attempt, delay },
        "MEDIA_PIPELINE: retrying after fetch failure"
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  logger.debug({ sourceUrl, maxAttempts }, "MEDIA_PIPELINE: all attempts exhausted");
  return null;
}
