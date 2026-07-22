/**
 * storage.ts — DesignDNA persistence layer
 *
 * This module is provider-agnostic: it defines a minimal DesignDNAStore
 * interface and pure key-derivation helpers. The caller (e.g. the API server)
 * supplies a concrete implementation — typically by wrapping its existing
 * StorageProvider — so this lib stays free of I/O dependencies.
 *
 * Storage key convention:
 *   dna/{jobId}/design-dna.json
 *
 * This mirrors the manifest storage pattern (jobs/{jobId}/manifest.json) so
 * both artefacts live under the same job namespace in the object store.
 */

import type { DesignDNA } from "./types";
import { serializeDesignDNA, deserializeDesignDNA } from "./serializer";

// ---------------------------------------------------------------------------
// DesignDNAStore interface
// ---------------------------------------------------------------------------

/**
 * Minimal storage contract.  Wire a concrete implementation by wrapping
 * an existing StorageProvider:
 *
 *   const store: DesignDNAStore = {
 *     write: (key, data) => provider.write(key, data),
 *     read:  (key)       => provider.read(key).then(buf => buf.toString("utf8")),
 *     exists:(key)       => provider.exists(key),
 *   };
 */
export interface DesignDNAStore {
  write(key: string, data: string): Promise<void>;
  read(key: string): Promise<string>;
  exists(key: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

/** Storage object key for a given job's DesignDNA. */
export function designDnaKey(jobId: string): string {
  return `dna/${jobId}/design-dna.json`;
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export interface SaveDesignDNAResult {
  ok: boolean;
  key: string;
  error?: string;
}

/**
 * Serializes and persists a DesignDNA to the store.
 *
 * @param store  - Any DesignDNAStore implementation
 * @param jobId  - The scrape job ID this DNA belongs to
 * @param dna    - The DesignDNA to persist
 */
export async function saveDesignDNA(
  store: DesignDNAStore,
  jobId: string,
  dna: DesignDNA,
): Promise<SaveDesignDNAResult> {
  const key = designDnaKey(jobId);
  try {
    const json = serializeDesignDNA(dna);
    await store.write(key, json);
    return { ok: true, key };
  } catch (err) {
    return {
      ok: false,
      key,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export type LoadDesignDNAResult =
  | { ok: true; dna: DesignDNA }
  | { ok: false; notFound: true }
  | { ok: false; notFound: false; error: string };

/**
 * Loads and validates a DesignDNA from the store.
 *
 * @param store  - Any DesignDNAStore implementation
 * @param jobId  - The scrape job ID whose DNA to load
 */
export async function loadDesignDNA(
  store: DesignDNAStore,
  jobId: string,
): Promise<LoadDesignDNAResult> {
  const key = designDnaKey(jobId);
  try {
    const exists = await store.exists(key);
    if (!exists) return { ok: false, notFound: true };

    const json = await store.read(key);
    const result = deserializeDesignDNA(json);
    if (!result.ok) {
      return { ok: false, notFound: false, error: result.error };
    }
    return { ok: true, dna: result.dna };
  } catch (err) {
    return {
      ok: false,
      notFound: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export interface DeleteDesignDNAResult {
  ok: boolean;
  key: string;
  error?: string;
}

export interface DesignDNAStoreWithDelete extends DesignDNAStore {
  delete(key: string): Promise<void>;
}

/**
 * Removes a stored DesignDNA. Only available when the store supports deletion.
 */
export async function deleteDesignDNA(
  store: DesignDNAStoreWithDelete,
  jobId: string,
): Promise<DeleteDesignDNAResult> {
  const key = designDnaKey(jobId);
  try {
    await store.delete(key);
    return { ok: true, key };
  } catch (err) {
    return {
      ok: false,
      key,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
