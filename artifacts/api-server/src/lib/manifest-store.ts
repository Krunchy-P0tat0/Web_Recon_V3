import { db, manifestSnapshotsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import type {
  Manifest,
  PageNode,
  ManifestStatus,
  ManifestStats,
  ManifestConfig,
  ManifestOutput,
} from "./manifest";

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

interface SerializedManifest {
  id: string;
  version: "1.0";
  status: ManifestStatus;
  createdAt: string;
  updatedAt: string;
  seedUrl: string;
  config: ManifestConfig;
  nodes: [string, PageNode][];
  seenUrls: string[];
  stats: ManifestStats;
  output?: ManifestOutput;
}

export function serializeManifest(manifest: Manifest): string {
  const payload: SerializedManifest = {
    id: manifest.id,
    version: manifest.version,
    status: manifest.status,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    seedUrl: manifest.seedUrl,
    config: manifest.config,
    nodes: Array.from(manifest.nodes.entries()),
    seenUrls: Array.from(manifest.seenUrls),
    stats: manifest.stats,
    output: manifest.output,
  };
  return JSON.stringify(payload);
}

/**
 * Coerces a persisted ManifestStatus string to the current phase vocabulary.
 * Snapshots written before the phase rename contain "running" and
 * "media_complete". Map them forward so crash-recovered manifests don't
 * fail validateManifestTransition when the worker resumes.
 *
 * Old → New:
 *   "running"        → "scraping"   (was: combined crawl+scrape phase)
 *   "media_complete" → "media"      (was: end-of-phase-2 marker)
 */
function coerceLegacyStatus(status: string): ManifestStatus {
  const LEGACY: Record<string, ManifestStatus> = {
    running:        "scraping",
    media_complete: "media",
  };
  return (LEGACY[status] ?? status) as ManifestStatus;
}

export function deserializeManifest(json: string): Manifest {
  const raw = JSON.parse(json) as SerializedManifest;
  return {
    id: raw.id,
    version: raw.version,
    status: coerceLegacyStatus(raw.status),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    seedUrl: raw.seedUrl,
    config: raw.config,
    nodes: new Map(raw.nodes),
    seenUrls: new Set(raw.seenUrls),
    stats: raw.stats,
    output: raw.output,
  };
}

// ---------------------------------------------------------------------------
// DB persistence
// ---------------------------------------------------------------------------

export async function saveManifest(
  jobId: string,
  manifest: Manifest
): Promise<void> {
  try {
    const json = serializeManifest(manifest);
    await db
      .insert(manifestSnapshotsTable)
      .values({
        jobId,
        manifestJson: json,
        schemaVersion: "1.0",
        renderSource: manifest.stats.renderSource ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: manifestSnapshotsTable.jobId,
        set: {
          manifestJson: json,
          renderSource: manifest.stats.renderSource ?? null,
          updatedAt: new Date(),
        },
      });
    logger.debug({ jobId }, "MANIFEST_STORE: snapshot saved");
  } catch (err) {
    // Use console.error here instead of logger to avoid pino thread-stream errors
    // crashing the process when the log payload is very large.
    console.error("[MANIFEST_STORE] failed to save manifest", jobId, (err as Error)?.message);
  }
}

export async function loadManifest(jobId: string): Promise<Manifest | null> {
  try {
    const [row] = await db
      .select()
      .from(manifestSnapshotsTable)
      .where(eq(manifestSnapshotsTable.jobId, jobId))
      .limit(1);
    if (!row) return null;
    return deserializeManifest(row.manifestJson);
  } catch (err) {
    logger.error({ err, jobId }, "MANIFEST_STORE: failed to load manifest");
    return null;
  }
}

export interface ManifestSnapshotMeta {
  jobId: string;
  schemaVersion: string;
  renderSource: string | null;
  updatedAt: Date;
}

/**
 * Loads the persisted snapshot row's storage-level metadata (schema version,
 * render source, last-updated timestamp) without deserializing the full
 * manifest JSON. Used by the Manifest Center summary endpoint.
 */
export async function loadManifestSnapshotMeta(jobId: string): Promise<ManifestSnapshotMeta | null> {
  try {
    const [row] = await db
      .select({
        jobId: manifestSnapshotsTable.jobId,
        schemaVersion: manifestSnapshotsTable.schemaVersion,
        renderSource: manifestSnapshotsTable.renderSource,
        updatedAt: manifestSnapshotsTable.updatedAt,
      })
      .from(manifestSnapshotsTable)
      .where(eq(manifestSnapshotsTable.jobId, jobId))
      .limit(1);
    return row ?? null;
  } catch (err) {
    logger.error({ err, jobId }, "MANIFEST_STORE: failed to load manifest snapshot meta");
    return null;
  }
}
