/**
 * website-identity.ts — Phase D4.1 Canonical Website Identity
 *
 * Produces a stable, deterministic identity for any website URL.
 *
 * Design rules:
 *   - Strip protocol (http / https treated identically)
 *   - Strip leading "www." subdomain
 *   - Lowercase the hostname
 *   - Preserve non-standard ports (port 80 / 443 are stripped)
 *   - Strip paths, search params, and fragments
 *   - The canonical domain is the string placed in R2 paths
 *   - The websiteId is SHA-256(canonicalDomain).slice(0, 16) —
 *     short enough for path segments, collision-resistant for realistic workloads
 *
 * Examples:
 *   https://www.colincowie.com/   → colincowie.com  → 7f4a8b2d1e9c3f60
 *   http://colincowie.com         → colincowie.com  → 7f4a8b2d1e9c3f60  (same)
 *   https://shop.mysite.com:8080  → shop.mysite.com:8080
 *
 * The identity is intentionally stable across protocol changes and
 * www-redirect variations — the most common source of duplicate crawls.
 */

import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WebsiteIdentity {
  /** Normalised domain used for storage paths and display. */
  canonicalDomain: string;
  /** Stable 16-char hex ID derived from canonicalDomain. */
  websiteId: string;
  /** Clean origin used as the canonical seed URL (https + no www). */
  normalizedOrigin: string;
}

// ---------------------------------------------------------------------------
// Core: canonicalize a URL to its stable domain identity
// ---------------------------------------------------------------------------

/**
 * Derives a canonical website identity from any URL.
 *
 * Two URLs that represent the same website (e.g. http://www.foo.com and
 * https://foo.com) will produce the same WebsiteIdentity.
 *
 * Never throws — malformed URLs fall back to treating the raw string as the
 * domain so the caller always gets a usable identity.
 */
export function deriveWebsiteIdentity(url: string): WebsiteIdentity {
  const canonicalDomain = canonicalizeDomain(url);
  const websiteId       = domainToWebsiteId(canonicalDomain);
  const normalizedOrigin = `https://${canonicalDomain}`;

  return { canonicalDomain, websiteId, normalizedOrigin };
}

/**
 * Normalise a URL to its canonical domain string.
 *
 * - Strips protocol
 * - Strips leading "www."
 * - Strips standard ports (80, 443)
 * - Lowercases
 * - Strips path, query, fragment
 */
export function canonicalizeDomain(url: string): string {
  // Prepend a scheme so URL() can parse bare domains
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;

  try {
    const parsed = new URL(withScheme);
    let host = parsed.hostname.toLowerCase();

    // Strip leading www.
    if (host.startsWith("www.")) {
      host = host.slice(4);
    }

    // Include port only when it is non-standard
    const port = parsed.port;
    const isStandardPort =
      port === "" ||
      (parsed.protocol === "http:" && port === "80") ||
      (parsed.protocol === "https:" && port === "443");

    return isStandardPort ? host : `${host}:${port}`;
  } catch {
    // Fallback: strip scheme + www, take the first path segment only
    return url
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      ?.split("?")[0]
      ?.split("#")[0] ?? url.toLowerCase();
  }
}

/**
 * Derive a stable 16-character hex websiteId from a canonical domain string.
 * Uses SHA-256 so the ID is deterministic and collision-resistant.
 */
export function domainToWebsiteId(canonicalDomain: string): string {
  return createHash("sha256")
    .update(canonicalDomain.toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

/**
 * Returns true when two URLs refer to the same website identity.
 * Ignores protocol, www-prefix, standard ports, paths, and fragments.
 */
export function isSameWebsite(urlA: string, urlB: string): boolean {
  return canonicalizeDomain(urlA) === canonicalizeDomain(urlB);
}

/**
 * Returns a clean seed URL suitable for storage.
 * Uses https, strips www, strips trailing slash.
 */
export function normalizeSeedUrl(url: string): string {
  try {
    const parsed = new URL(
      /^https?:\/\//i.test(url) ? url : `https://${url}`
    );
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);

    const port = parsed.port;
    const isStandardPort =
      port === "" ||
      (parsed.protocol === "http:" && port === "80") ||
      (parsed.protocol === "https:" && port === "443");

    const hostPart = isStandardPort ? host : `${host}:${port}`;
    const path     = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");

    return `https://${hostPart}${path}`;
  } catch {
    return url;
  }
}
