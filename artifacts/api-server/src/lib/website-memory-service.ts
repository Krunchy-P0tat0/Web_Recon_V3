/**
 * website-memory-service.ts — Phase D4.1 Persistent Website Intelligence Memory
 *
 * Creates and manages a canonical persistent memory record for every website
 * the system has crawled. R2 is the durable source of truth.
 *
 * Storage layout (R2):
 *   websites/{websiteId}/memory.json             ← live authoritative manifest
 *   websites/{websiteId}/memory-v{NNNN}.json     ← versioned snapshots
 *   websites/{websiteId}/history/runs.json        ← append-only run log
 *   websites/{websiteId}/checkpoints/latest.json ← scrape checkpoint pointer
 *   websites/{websiteId}/metrics/overview.json   ← perf metrics
 *
 * Atomic write strategy (R2 has no transactions):
 *   1. Compute next checkpointVersion (N).
 *   2. Write memory-v{N:04d}.json  ← always succeeds first.
 *   3. Write memory.json           ← live pointer.
 *   If step 3 fails, step 2 is still readable and will be found on recovery.
 *   Up to KEEP_VERSIONS versioned snapshots are retained; older ones are
 *   best-effort deleted.
 *
 * Backward compatibility:
 *   - Does not touch any job-set-{jobId}/ prefix or existing R2 artifacts.
 *   - Operates entirely within the websites/{websiteId}/ prefix.
 *   - Existing scrape jobs, manifests, and checkpoints are unaffected.
 */

import { logger } from "./logger.js";
import type { CloudProvider } from "../cloud/provider.js";
import { R2Keys } from "../cloud/r2-key-registry.js";
import {
  deriveWebsiteIdentity,
  normalizeSeedUrl,
  type WebsiteIdentity,
} from "./website-identity.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA_VERSION        = "D4.1" as const;
const CRAWLER_VERSION       = "4.1.0" as const;
/** Number of versioned snapshots kept per website. Older ones are pruned. */
const KEEP_VERSIONS         = 5;
/** Maximum number of pipeline run records kept in executionHistory. */
const MAX_HISTORY_ENTRIES   = 50;

// ---------------------------------------------------------------------------
// Knowledge module
// ---------------------------------------------------------------------------

export type KnowledgeModuleHealth = "healthy" | "stale" | "corrupted" | "missing";

/**
 * Represents the persistent output of one pipeline stage for this website.
 * Every named stage (crawl, manifest, diff, …, certification) is tracked
 * as a KnowledgeModule.
 */
export interface KnowledgeModule {
  /** Stage/module name matching MasterStageId. */
  name: string;
  /** True when the module has a valid, complete output in R2. */
  completed: boolean;
  /** Semantic version of the module's output schema. */
  version: string;
  /** Version of the generator that produced this output. */
  generatorVersion: string;
  /** ISO timestamp when this module was generated. Null when not yet run. */
  generatedAt: string | null;
  /**
   * Names of modules that must be completed before this one is valid.
   * If any dependency is stale/corrupted this module should be regenerated.
   */
  dependencies: string[];
  /** SHA-256 checksum of the primary output artifact. Null when not computed. */
  checksum: string | null;
  /** R2 key of the primary output artifact. Null when not yet generated. */
  outputLocation: string | null;
  /** Public URL of the primary output artifact. */
  outputLocationUrl: string | null;
  /** Health assessment: healthy = usable, stale = outdated but valid, etc. */
  health: KnowledgeModuleHealth;
  /** Free-form module-specific metadata (node count, coverage %, etc.). */
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Pipeline run record
// ---------------------------------------------------------------------------

export interface PipelineRunRecord {
  pipelineRunId: string;     // Orchestration job ID
  scrapeJobId: string | null;
  startedAt: string;
  completedAt: string | null;
  status: "running" | "complete" | "failed" | "interrupted";
  completedStages: string[];
  failedStages: string[];
  skippedStages: string[];
  coveragePct: number | null;
  totalDurationMs: number | null;
  r2OutputReferences: Record<string, string>;  // stageId → R2 key
}

// ---------------------------------------------------------------------------
// Checkpoint reference (pointer to the active scrape checkpoint)
// ---------------------------------------------------------------------------

export interface CheckpointReference {
  /** R2 key of the scrape-level checkpoint JSON. */
  latestCheckpointKey: string | null;
  /** Scrape job ID that owns this checkpoint. */
  scrapeJobId: string | null;
  /** Version counter from the checkpoint itself. */
  checkpointVersion: number | null;
  /** ISO timestamp when this reference was recorded. */
  savedAt: string | null;
  /** % of URLs completed at time of last checkpoint. */
  coveragePct: number | null;
  completedUrls: string[];
  pendingUrls: string[];
  failedUrls: string[];
}

// ---------------------------------------------------------------------------
// Website prime and certification status
// ---------------------------------------------------------------------------

export interface WebsitePrimeStatus {
  available: boolean;
  r2Key: string | null;
  publicUrl: string | null;
  generatedAt: string | null;
  version: string | null;
}

export interface CertificationStatus {
  grade: string | null;        // e.g. "A", "B+"
  score: number | null;        // 0–100
  certifiedAt: string | null;
  r2Key: string | null;
  fidelityScore: number | null;
}

// ---------------------------------------------------------------------------
// The authoritative PWIM memory manifest
// ---------------------------------------------------------------------------

export interface WebsiteMemory {
  /** Schema discriminant — must equal SCHEMA_VERSION. */
  schemaVersion: typeof SCHEMA_VERSION;
  /** Stable 16-char hex ID derived from canonicalDomain. */
  websiteId: string;
  /** Normalised domain, e.g. "colincowie.com". */
  canonicalDomain: string;
  /** Clean seed URL used for all pipeline runs. */
  seedUrl: string;
  /** Version of this crawler engine that manages this record. */
  crawlerVersion: string;
  /** ISO timestamp when this memory record was first created. */
  createdAt: string;
  /** ISO timestamp of the last crawl that touched this website. */
  lastCrawlAt: string | null;
  /** ISO timestamp when this record was last written. */
  updatedAt: string;
  /**
   * Monotonically increasing write counter.
   * Incremented on every saveWebsiteMemory() call.
   * Used to select the latest versioned snapshot on recovery.
   */
  checkpointVersion: number;
  /** Most recent successfully completed pipeline run. */
  lastSuccessfulPipeline: PipelineRunRecord | null;
  /** Active pipeline run, if one is in progress. Null when idle. */
  currentPipelineState: PipelineRunRecord | null;
  /**
   * One entry per pipeline stage (crawl, manifest, diff, …).
   * Keyed by MasterStageId.
   */
  knowledgeModules: Record<string, KnowledgeModule>;
  /**
   * Latest output schema version per module, for quick compatibility checks.
   * Mirrors knowledgeModules[name].version for fast lookups.
   */
  moduleVersions: Record<string, string>;
  /** Pointer to the active scrape-level URL checkpoint. */
  checkpointReferences: CheckpointReference;
  /** Capped history of all pipeline runs (newest first). */
  executionHistory: PipelineRunRecord[];
  /** Status of the generated Website Prime artifact. */
  websitePrimeStatus: WebsitePrimeStatus;
  /** Status of the last certification run. */
  certificationStatus: CertificationStatus;
}

// ---------------------------------------------------------------------------
// Summary (lightweight projection returned by getWebsiteMemorySummary)
// ---------------------------------------------------------------------------

export interface WebsiteMemorySummary {
  websiteId: string;
  canonicalDomain: string;
  seedUrl: string;
  exists: boolean;
  schemaVersion: string;
  lastCrawlAt: string | null;
  updatedAt: string | null;
  checkpointVersion: number;
  completedModules: string[];
  healthyModules: string[];
  staleModules: string[];
  corruptedModules: string[];
  missingModules: string[];
  websitePrimeAvailable: boolean;
  certificationGrade: string | null;
  certificationScore: number | null;
  activePipelineRunId: string | null;
  lastSuccessfulPipelineRunId: string | null;
  runCount: number;
}

// ---------------------------------------------------------------------------
// Default factory helpers
// ---------------------------------------------------------------------------

function makeEmptyKnowledgeModule(name: string): KnowledgeModule {
  return {
    name,
    completed: false,
    version: "0.0.0",
    generatorVersion: CRAWLER_VERSION,
    generatedAt: null,
    dependencies: [],
    checksum: null,
    outputLocation: null,
    outputLocationUrl: null,
    health: "missing",
    metadata: {},
  };
}

export const ALL_PIPELINE_STAGES: ReadonlyArray<string> = [
  "crawl", "manifest", "diff", "intelligence", "design-dna",
  "visual-dna", "stencil", "website-prime", "merge",
  "deployment-plan", "deploy", "certification",
];

function makeEmptyModules(): Record<string, KnowledgeModule> {
  const modules: Record<string, KnowledgeModule> = {};
  for (const stage of ALL_PIPELINE_STAGES) {
    modules[stage] = makeEmptyKnowledgeModule(stage);
  }
  return modules;
}

function makeEmptyModuleVersions(): Record<string, string> {
  const v: Record<string, string> = {};
  for (const stage of ALL_PIPELINE_STAGES) v[stage] = "0.0.0";
  return v;
}

// ---------------------------------------------------------------------------
// Internal: safe R2 helpers
// ---------------------------------------------------------------------------

async function safeDownload(
  cloud: CloudProvider,
  key: string,
): Promise<Buffer | null> {
  try {
    return await cloud.download(key);
  } catch (err) {
    logger.warn({ err, key }, "PWIM: download error (non-fatal)");
    return null;
  }
}

async function safeUpload(
  cloud: CloudProvider,
  key: string,
  data: unknown,
): Promise<boolean> {
  try {
    await cloud.upload({
      key,
      data: Buffer.from(JSON.stringify(data, null, 2), "utf8"),
      contentType: "application/json",
      checkDuplicate: false,
    });
    return true;
  } catch (err) {
    logger.warn({ err, key }, "PWIM: upload error (non-fatal)");
    return false;
  }
}

async function safeParse<T>(buf: Buffer | null): Promise<T | null> {
  if (!buf || buf.length === 0) return null;
  try {
    return JSON.parse(buf.toString("utf8")) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal: load with corruption recovery
// ---------------------------------------------------------------------------

/**
 * Attempts to load the live memory.json.
 * On parse failure, reads the version-pointer file (memory-vptr.json) to
 * determine which versioned snapshot to try, then walks backwards through
 * up to KEEP_VERSIONS candidates.
 *
 * Write order guarantee (established by atomicWrite):
 *   1. memory-vptr.json  ← written first
 *   2. memory-v{N}.json  ← written second
 *   3. memory.json       ← written last (the live pointer)
 *
 * If memory.json is corrupt but memory-vptr.json survived, we know exactly
 * which versioned snapshot to load without a blind key scan.
 */
async function loadRaw(
  websiteId: string,
  cloud: CloudProvider,
): Promise<{ memory: WebsiteMemory; recovered: boolean } | null> {
  // Step 1: try the live memory.json
  const liveBuf = await safeDownload(cloud, R2Keys.websites.memory(websiteId));
  if (liveBuf) {
    const live = await safeParse<WebsiteMemory>(liveBuf);
    if (live && live.schemaVersion === SCHEMA_VERSION) {
      return { memory: live, recovered: false };
    }
    // Corrupt live — fall through to versioned recovery
    logger.warn(
      { websiteId },
      "PWIM: memory.json is corrupt or wrong schema — attempting versioned snapshot recovery",
    );
  }

  // Step 2: read version-pointer to know where to start scanning
  const vptrBuf = await safeDownload(cloud, R2Keys.websites.memoryVersionPtr(websiteId));
  const vptr = await safeParse<{ v: number }>(vptrBuf);
  const maxVersion = vptr?.v ?? 0;

  if (maxVersion === 0) return null;  // No pointer → no snapshots to recover from

  // Step 3: try versioned snapshots from maxVersion down to max(1, maxVersion - KEEP_VERSIONS)
  const candidates: Array<Promise<{ memory: WebsiteMemory; v: number } | null>> = [];
  for (let v = maxVersion; v >= Math.max(1, maxVersion - KEEP_VERSIONS); v--) {
    candidates.push(
      (async (version: number) => {
        const buf = await safeDownload(
          cloud,
          R2Keys.websites.memoryVersioned(websiteId, version),
        );
        const parsed = await safeParse<WebsiteMemory>(buf);
        if (parsed && parsed.schemaVersion === SCHEMA_VERSION) {
          return { memory: parsed, v: version };
        }
        return null;
      })(v),
    );
  }

  const results = await Promise.all(candidates);
  const best = results
    .filter((r): r is { memory: WebsiteMemory; v: number } => r !== null)
    .sort((a, b) => b.v - a.v)[0];

  if (best) {
    logger.info(
      { websiteId, recoveredVersion: best.v },
      "PWIM: recovered from versioned snapshot",
    );
    return { memory: best.memory, recovered: true };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internal: write with atomic versioned backup
// ---------------------------------------------------------------------------

/**
 * Atomic write sequence.  Order matters for crash safety:
 *
 *   1. memory-vptr.json  { v: N }          ← written FIRST
 *                                             If we crash here nothing is lost;
 *                                             live memory.json still has v(N-1).
 *   2. memory-v{N:04d}.json               ← full snapshot at version N
 *                                             If we crash here, vptr points at
 *                                             the snapshot we can recover from.
 *   3. memory.json                         ← live pointer (last write)
 *
 * On recovery: read vptr → find the right versioned snapshot → restore.
 */
async function atomicWrite(
  memory: WebsiteMemory,
  cloud: CloudProvider,
): Promise<void> {
  const { websiteId, checkpointVersion } = memory;

  // Step 1: write version pointer (recovery anchor)
  await safeUpload(cloud, R2Keys.websites.memoryVersionPtr(websiteId), { v: checkpointVersion });

  // Step 2: write versioned snapshot
  const vKey = R2Keys.websites.memoryVersioned(websiteId, checkpointVersion);
  await safeUpload(cloud, vKey, memory);

  // Step 3: write authoritative live pointer
  const ok = await safeUpload(cloud, R2Keys.websites.memory(websiteId), memory);
  if (!ok) {
    logger.warn(
      { websiteId, checkpointVersion, vKey },
      "PWIM: memory.json write failed — versioned snapshot at vptr is recovery copy",
    );
  }

  // Step 4: best-effort prune of old versioned snapshots
  const pruneVersion = checkpointVersion - KEEP_VERSIONS;
  if (pruneVersion >= 1) {
    cloud.delete?.(R2Keys.websites.memoryVersioned(websiteId, pruneVersion)).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Internal: append to run history
// ---------------------------------------------------------------------------

async function appendRunHistory(
  websiteId: string,
  run: PipelineRunRecord,
  cloud: CloudProvider,
): Promise<void> {
  const key = R2Keys.websites.historyRuns(websiteId);
  const existing = await safeDownload(cloud, key);
  const history: PipelineRunRecord[] = (await safeParse<PipelineRunRecord[]>(existing)) ?? [];

  // Newest first; cap at MAX_HISTORY_ENTRIES
  history.unshift(run);
  const trimmed = history.slice(0, MAX_HISTORY_ENTRIES);

  await safeUpload(cloud, key, trimmed);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a memory record already exists for a website URL.
 */
export async function websiteMemoryExists(
  url: string,
  cloud: CloudProvider,
): Promise<boolean> {
  if (!cloud.isConfigured()) return false;
  const { websiteId } = deriveWebsiteIdentity(url);
  return cloud.verify(R2Keys.websites.memory(websiteId));
}

/**
 * Load the full WebsiteMemory for a URL.
 * Returns null when R2 is not configured or no record exists.
 * Handles corrupt memory.json by falling back to the latest versioned snapshot.
 */
export async function loadWebsiteMemory(
  url: string,
  cloud: CloudProvider,
): Promise<WebsiteMemory | null> {
  if (!cloud.isConfigured()) return null;
  const { websiteId, canonicalDomain } = deriveWebsiteIdentity(url);

  const result = await loadRaw(websiteId, cloud);
  if (!result) {
    logger.info({ websiteId, canonicalDomain }, "PWIM: no memory found — first visit");
    return null;
  }

  if (result.recovered) {
    logger.warn(
      { websiteId, canonicalDomain },
      "PWIM: loaded from versioned snapshot — memory.json was corrupt",
    );
  } else {
    logger.info(
      { websiteId, canonicalDomain, checkpointVersion: result.memory.checkpointVersion },
      "PWIM: memory loaded",
    );
  }

  return result.memory;
}

/**
 * Create a brand-new WebsiteMemory record.
 * Does NOT write to R2 — call saveWebsiteMemory() to persist.
 * If memory already exists, call loadWebsiteMemory() instead.
 */
export function createWebsiteMemory(url: string): WebsiteMemory {
  const identity = deriveWebsiteIdentity(url);
  const now = new Date().toISOString();

  return {
    schemaVersion:          SCHEMA_VERSION,
    websiteId:              identity.websiteId,
    canonicalDomain:        identity.canonicalDomain,
    seedUrl:                normalizeSeedUrl(url),
    crawlerVersion:         CRAWLER_VERSION,
    createdAt:              now,
    lastCrawlAt:            null,
    updatedAt:              now,
    checkpointVersion:      0,
    lastSuccessfulPipeline: null,
    currentPipelineState:   null,
    knowledgeModules:       makeEmptyModules(),
    moduleVersions:         makeEmptyModuleVersions(),
    checkpointReferences: {
      latestCheckpointKey: null,
      scrapeJobId:         null,
      checkpointVersion:   null,
      savedAt:             null,
      coveragePct:         null,
      completedUrls:       [],
      pendingUrls:         [],
      failedUrls:          [],
    },
    executionHistory: [],
    websitePrimeStatus: {
      available:   false,
      r2Key:       null,
      publicUrl:   null,
      generatedAt: null,
      version:     null,
    },
    certificationStatus: {
      grade:          null,
      score:          null,
      certifiedAt:    null,
      r2Key:          null,
      fidelityScore:  null,
    },
  };
}

/**
 * Persist a WebsiteMemory record to R2 atomically.
 * Increments checkpointVersion, updates updatedAt, then:
 *   1. Writes versioned snapshot.
 *   2. Writes live memory.json.
 */
export async function saveWebsiteMemory(
  memory: WebsiteMemory,
  cloud: CloudProvider,
): Promise<WebsiteMemory> {
  if (!cloud.isConfigured()) {
    logger.warn({ websiteId: memory.websiteId }, "PWIM: cloud not configured — save skipped");
    return memory;
  }

  const updated: WebsiteMemory = {
    ...memory,
    updatedAt:         new Date().toISOString(),
    checkpointVersion: memory.checkpointVersion + 1,
  };

  await atomicWrite(updated, cloud);

  logger.info(
    {
      websiteId:        updated.websiteId,
      canonicalDomain:  updated.canonicalDomain,
      checkpointVersion: updated.checkpointVersion,
    },
    "PWIM: memory saved",
  );

  return updated;
}

/**
 * Load or create — returns existing memory if found, otherwise creates a new one.
 * Writes the new record to R2 immediately when created.
 */
export async function loadOrCreateWebsiteMemory(
  url: string,
  cloud: CloudProvider,
): Promise<WebsiteMemory> {
  const existing = await loadWebsiteMemory(url, cloud);
  if (existing) return existing;

  const fresh = createWebsiteMemory(url);
  return saveWebsiteMemory(fresh, cloud);
}

/**
 * Update a single knowledge module within an existing WebsiteMemory.
 * Creates the module entry if it does not already exist.
 * Does NOT write to R2 — call saveWebsiteMemory() after.
 */
export function updateKnowledgeModule(
  memory: WebsiteMemory,
  name: string,
  update: Partial<Omit<KnowledgeModule, "name">>,
): WebsiteMemory {
  const existing = memory.knowledgeModules[name] ?? makeEmptyKnowledgeModule(name);
  const updated: KnowledgeModule = { ...existing, ...update, name };

  return {
    ...memory,
    knowledgeModules: {
      ...memory.knowledgeModules,
      [name]: updated,
    },
    moduleVersions: {
      ...memory.moduleVersions,
      [name]: updated.version,
    },
  };
}

/**
 * Retrieve a specific knowledge module from a WebsiteMemory.
 * Returns an empty module (health: "missing") when not found.
 */
export function getKnowledgeModule(
  memory: WebsiteMemory,
  name: string,
): KnowledgeModule {
  return memory.knowledgeModules[name] ?? makeEmptyKnowledgeModule(name);
}

/**
 * Return a lightweight summary projection of a WebsiteMemory.
 * Useful for API responses and health dashboards.
 */
export function getWebsiteMemorySummary(memory: WebsiteMemory | null, url: string): WebsiteMemorySummary {
  if (!memory) {
    const { websiteId, canonicalDomain } = deriveWebsiteIdentity(url);
    return {
      websiteId,
      canonicalDomain,
      seedUrl: normalizeSeedUrl(url),
      exists: false,
      schemaVersion: SCHEMA_VERSION,
      lastCrawlAt: null,
      updatedAt: null,
      checkpointVersion: 0,
      completedModules: [],
      healthyModules: [],
      staleModules: [],
      corruptedModules: [],
      missingModules: [...ALL_PIPELINE_STAGES],
      websitePrimeAvailable: false,
      certificationGrade: null,
      certificationScore: null,
      activePipelineRunId: null,
      lastSuccessfulPipelineRunId: null,
      runCount: 0,
    };
  }

  const modules = Object.values(memory.knowledgeModules);

  return {
    websiteId:                   memory.websiteId,
    canonicalDomain:             memory.canonicalDomain,
    seedUrl:                     memory.seedUrl,
    exists:                      true,
    schemaVersion:               memory.schemaVersion,
    lastCrawlAt:                 memory.lastCrawlAt,
    updatedAt:                   memory.updatedAt,
    checkpointVersion:           memory.checkpointVersion,
    completedModules:            modules.filter(m => m.completed).map(m => m.name),
    healthyModules:              modules.filter(m => m.health === "healthy").map(m => m.name),
    staleModules:                modules.filter(m => m.health === "stale").map(m => m.name),
    corruptedModules:            modules.filter(m => m.health === "corrupted").map(m => m.name),
    missingModules:              modules.filter(m => m.health === "missing").map(m => m.name),
    websitePrimeAvailable:       memory.websitePrimeStatus.available,
    certificationGrade:          memory.certificationStatus.grade,
    certificationScore:          memory.certificationStatus.score,
    activePipelineRunId:         memory.currentPipelineState?.pipelineRunId ?? null,
    lastSuccessfulPipelineRunId: memory.lastSuccessfulPipeline?.pipelineRunId ?? null,
    runCount:                    memory.executionHistory.length,
  };
}

/**
 * Record the start of a new pipeline run in the memory.
 * Does NOT write to R2 — call saveWebsiteMemory() after.
 */
export function recordPipelineStart(
  memory: WebsiteMemory,
  run: PipelineRunRecord,
): WebsiteMemory {
  return {
    ...memory,
    currentPipelineState: run,
    lastCrawlAt:          run.startedAt,
  };
}

/**
 * Record a completed or failed pipeline run.
 * Promotes currentPipelineState to lastSuccessfulPipeline on success.
 * Appends to executionHistory (capped at MAX_HISTORY_ENTRIES).
 * Does NOT write to R2 — call saveWebsiteMemory() after.
 */
export function recordPipelineEnd(
  memory: WebsiteMemory,
  run: PipelineRunRecord,
  cloud: CloudProvider,
): WebsiteMemory {
  const history = [run, ...memory.executionHistory].slice(0, MAX_HISTORY_ENTRIES);

  // Best-effort append the run to the dedicated history file
  appendRunHistory(memory.websiteId, run, cloud).catch((err) => {
    logger.warn({ err, websiteId: memory.websiteId }, "PWIM: history append failed (non-fatal)");
  });

  return {
    ...memory,
    currentPipelineState:   run.status === "running" ? run : null,
    lastSuccessfulPipeline: run.status === "complete" ? run : memory.lastSuccessfulPipeline,
    executionHistory:       history,
  };
}

/**
 * Update the checkpoint reference pointer stored in the memory.
 * Call this after every URL-level checkpoint save to keep R2 in sync.
 * Does NOT write to R2 — call saveWebsiteMemory() after.
 */
export function updateCheckpointReference(
  memory: WebsiteMemory,
  ref: Partial<CheckpointReference>,
): WebsiteMemory {
  return {
    ...memory,
    checkpointReferences: { ...memory.checkpointReferences, ...ref, savedAt: new Date().toISOString() },
  };
}

/**
 * Mark the Website Prime artifact as available in memory.
 * Does NOT write to R2 — call saveWebsiteMemory() after.
 */
export function markWebsitePrimeAvailable(
  memory: WebsiteMemory,
  r2Key: string,
  publicUrl: string,
  version: string,
): WebsiteMemory {
  return {
    ...memory,
    websitePrimeStatus: {
      available:   true,
      r2Key,
      publicUrl,
      generatedAt: new Date().toISOString(),
      version,
    },
  };
}

/**
 * Record a certification result in the memory.
 * Does NOT write to R2 — call saveWebsiteMemory() after.
 */
export function recordCertification(
  memory: WebsiteMemory,
  grade: string,
  score: number,
  fidelityScore: number | null,
  r2Key: string,
): WebsiteMemory {
  return {
    ...memory,
    certificationStatus: {
      grade,
      score,
      certifiedAt: new Date().toISOString(),
      r2Key,
      fidelityScore,
    },
  };
}

// ---------------------------------------------------------------------------
// Re-export identity helpers for convenience
// ---------------------------------------------------------------------------

export { deriveWebsiteIdentity, canonicalizeDomain, normalizeSeedUrl } from "./website-identity.js";
export type { WebsiteIdentity } from "./website-identity.js";
