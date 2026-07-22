/**
 * serializer.ts — DesignDNA ↔ JSON conversion
 *
 * Guarantees:
 *   - Stable key ordering so two identical DesignDNA objects always produce
 *     the same JSON bytes (required for content-hash determinism).
 *   - deserializeDesignDNA validates the parsed value through Zod before
 *     returning — callers receive a typed, schema-validated object or an error.
 */

import type { DesignDNA } from "./types";
import { DesignDNASchema } from "./schema";

// ---------------------------------------------------------------------------
// Stable JSON helpers
// ---------------------------------------------------------------------------

/**
 * Recursively sorts object keys so JSON output is deterministic regardless
 * of insertion order. Arrays are preserved in their original order.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Converts a DesignDNA to a deterministic JSON string.
 *
 * The output is pretty-printed (2-space indent) to make design-dna.json
 * human-readable when inspected alongside the manifest.
 */
export function serializeDesignDNA(dna: DesignDNA): string {
  return JSON.stringify(sortKeys(dna), null, 2);
}

// ---------------------------------------------------------------------------
// Deserializer
// ---------------------------------------------------------------------------

export type DeserializeResult =
  | { ok: true; dna: DesignDNA }
  | { ok: false; error: string };

/**
 * Parses a JSON string and validates it as a DesignDNA.
 *
 * Returns a discriminated union — always check `.ok` before accessing `.dna`.
 * Never throws; all failure modes are captured in the error branch.
 */
export function deserializeDesignDNA(json: string): DeserializeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const result = DesignDNASchema.safeParse(raw);
  if (result.success) {
    return { ok: true, dna: result.data };
  }

  const errors = result.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  return { ok: false, error: `Schema validation failed: ${errors}` };
}
