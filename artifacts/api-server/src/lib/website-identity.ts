/**
 * website-identity.ts — Phase D4.1 Deterministic Website Identity
 *
 * Produces a canonical domain and a stable website ID from any URL or
 * domain variant. Two inputs that refer to the same website must always
 * produce the same canonicalDomain and websiteId.
 *
 * Canonicalization rules (applied in order):
 *   1. Trim whitespace and lowercase
 *   2. Add https:// if no protocol present (for URL parsing)
 *   3. Extract hostname via URL parser
 *   4. Strip leading "www." (and "www2.", "www3." etc.)
 *   5. Strip trailing dot (some resolvers append one)
 *
 * Examples:
 *   https://www.colincowie.com/  →  colincowie.com
 *   https://colincowie.com       →  colincowie.com
 *   http://WWW.COLINCOWIE.COM    →  colincowie.com
 *   colincowie.com               →  colincowie.com
 *
 * websiteId:
 *   SHA-256(canonicalDomain) → first 12 hex chars.
 *   Deterministic, collision-resistant for O(millions) of distinct domains.
 */

import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Canonicalize
// ---------------------------------------------------------------------------

/**
 * Returns the canonical domain for any URL or bare-domain string.
 * Never throws — falls back to a best-effort normalization on malformed input.
 */
export function canonicalizeDomain(input: string): string {
  const trimmed = input.trim().toLowerCase();

  // Add a scheme so URL can parse it
  const withScheme =
    trimmed.startsWith("http://") || trimmed.startsWith("https://")
      ? trimmed
      : `https://${trimmed}`;

  let hostname: string;
  try {
    hostname = new URL(withScheme).hostname;
  } catch {
    // URL parsing failed; extract hostname manually
    hostname = withScheme
      .replace(/^https?:\/\//, "")
      .split("/")[0]!
      .split("?")[0]!
      .split("#")[0]!;
  }

  // Strip trailing dot (FQDN artefact)
  if (hostname.endsWith(".")) {
    hostname = hostname.slice(0, -1);
  }

  // Strip leading www[0-9]*. prefix
  hostname = hostname.replace(/^www\d*\./, "");

  return hostname;
}

// ---------------------------------------------------------------------------
// Website ID
// ---------------------------------------------------------------------------

/**
 * Derives a stable 12-char hex ID from a canonical domain.
 * Stable across runs, servers, and time.
 */
export function deriveWebsiteId(canonicalDomain: string): string {
  return createHash("sha256").update(canonicalDomain).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Combined helper
// ---------------------------------------------------------------------------

export interface WebsiteIdentity {
  /** Normalised hostname, e.g. "colincowie.com". */
  canonicalDomain: string;
  /** Stable 12-hex-char ID derived from canonicalDomain. */
  websiteId: string;
}

/**
 * Accepts any URL or bare domain and returns a fully resolved identity.
 * This is the single entry point for all website identity resolution.
 */
export function resolveWebsiteIdentity(urlOrDomain: string): WebsiteIdentity {
  const canonicalDomain = canonicalizeDomain(urlOrDomain);
  const websiteId = deriveWebsiteId(canonicalDomain);
  return { canonicalDomain, websiteId };
}
