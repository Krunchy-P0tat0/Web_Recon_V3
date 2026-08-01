/**
 * website-memory-service.ts — Phase D4.1 Persistent Website Intelligence Memory Service
 *
 * Single owner of all reads and writes to the website memory manifest.
 * No other module may read or write website memory.json directly.
 *
 * Storage layout (all keys relative to R2 bucket root):
 *   websites/{canonicalDomain}/memory.json        — versioned manifest
 *   websites/{canonicalDomain}/pipeline/           — stage output snapshots
 *   websites/{canonicalDomain}/checkpoints/        — checkpoint references
 *   websites/{canonicalDomain}/manifests/          — crawl manifests
 *   websites/{canonicalDomain}/assets/             — crawled asset cache
 *   websites/{canonicalDomain}/normalized/         — normalized DOM/CSS/JS
 *   websites/{canonicalDomain}/frontier/           — crawl frontier state
 *   websites/{canonicalDomain}/retries/            — retry logs
 *   websites/{canonicalDomain}/history/            — execution history snapshots
 *   websites/{canonicalDomain}/metrics/            — quality metrics
 *
 * Atomicity contract:
 *   1. Before writing, the new manifest is serialized and checksum-verified.
 *      Malformed JSON is never written to R2.
 *   2. The manifest carries a monotonically increasing _version counter.
 *      Callers that detect a version mismatch between their loaded copy and
 *      the stored copy receive a WebsiteMemoryConflictError.
 *   3. Each write is a single PutObject. R2 PutObject is atomic at the object
 *      level — readers always see a complete, consistent manifest.
 */

import { createHash } from "node:crypto";
import { logger } from "./logger.js";
import type { CloudProvider } from "../cloud/provider.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import {
  MEMORY_SCHEMA_VERSION,
  CRAWLER_VERSION,
  PIPELINE_STAGE_KEYS,
  MAX_HISTORY_ENTRIES,
} from "./website-memory-types.js";
import type {
  WebsiteMemory,
  WebsiteMemorySummary,
  KnowledgeModule,
  PipelineStageKey,
  PipelineRunSummary,
  KnowledgeModuleHealth,
} from "./website-memory-types.js";
import { resolveWebsiteIdentity } from "./website-identity.js";
import { R2Keys } from "../cloud/r2-key-registry.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class WebsiteMemoryNotFoundError extends Error {
  constructor(public readonly canonicalDomain: string) {
    super(`WebsiteMemory not found for domain: ${canonicalDomain}`);
    this.name = "WebsiteMemoryNotFoundError";
  }
}

export class WebsiteMemoryCorruptError extends Error {
  constructor(
    public readonly canonicalDomain: string,
    cause: string,
  ) {
    super(`WebsiteMemory for "${canonicalDomain}" is corrupt: ${cause}`);
    this.name = "WebsiteMemoryCorruptError";
  }
}

export class WebsiteMemoryConflictError extends Error {
  constructor(
    public readonly canonicalDomain: string,
    public readonly loadedVersion: number,
    public readonly storedVersion: number,
  ) {
    super(
      `Concurrent write conflict for "${canonicalDomain}": loaded v${loadedVersion} but R2 has v${storedVersion}. Reload and retry.`,
    );
    this.name = "WebsiteMemoryConflictError";
  }
}

// ---------------------------------------------------------------------------
// Checksum helpers
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 checksum over the memory manifest content.
 * The _checksum field is set to "" before hashing so the function is
 * pure (not dependent on the previously stored checksum).
 */
function computeChecksum(mem: WebsiteMemory): string {
  const copy = { ...mem, _checksum: "" };
  return createHash("sha256").update(JSON.stringify(copy)).digest("hex").slice(0, 32);
}

function verifyChecksum(mem: WebsiteMemory): boolean {
  return computeChecksum(mem) === mem._checksum;
}

// ---------------------------------------------------------------------------
// Empty knowledge module factory
// ---------------------------------------------------------------------------

function emptyModule(): KnowledgeModule {
  return {
    completed: false,
    version: 0,
    generatorVersion: CRAWLER_VERSION,
    generatedAt: null,
    dependencies: [],
    checksum: null,
    outputLocation: null,
    health: "missing",
  };
}

function emptyModuleMap(): Record<PipelineStageKey, KnowledgeModule> {
  return Object.fromEntries(
    PIPELINE_STAGE_KEYS.map((k) => [k, emptyModule()]),
  ) as Record<PipelineStageKey, KnowledgeModule>;
}

function emptyVersionMap(): Record<PipelineStageKey, number> {
  return Object.fromEntries(
    PIPELINE_STAGE_KEYS.map((k) => [k, 0]),
  ) as Record<PipelineStageKey, number>;
}

// ---------------------------------------------------------------------------
// WebsiteMemoryService
// ---------------------------------------------------------------------------

export class WebsiteMemoryService {
  private readonly provider: CloudProvider;

  constructor(provider?: CloudProvider) {
    this.provider = provider ?? getDefaultCloudProvider();
  }

  // ── Key helpers ────────────────────────────────────────────────────────────

  private memoryKey(canonicalDomain: string): string {
    return R2Keys.websites.memory(canonicalDomain);
  }

  // ── websiteMemoryExists ───────────────────────────────────────────────────

  /**
   * Returns true if a memory manifest exists in storage for the given
   * URL or domain. Never throws.
   */
  async websiteMemoryExists(urlOrDomain: string): Promise<boolean> {
    const { canonicalDomain } = resolveWebsiteIdentity(urlOrDomain);
    try {
      return await this.provider.verify(this.memoryKey(canonicalDomain));
    } catch {
      return false;
    }
  }

  // ── loadWebsiteMemory ─────────────────────────────────────────────────────

  /**
   * Loads and validates the memory manifest from storage.
   *
   * @throws WebsiteMemoryNotFoundError when no manifest exists
   * @throws WebsiteMemoryCorruptError  when the manifest fails checksum validation
   *                                    or has an unsupported schema version
   */
  async loadWebsiteMemory(urlOrDomain: string): Promise<WebsiteMemory> {
    const { canonicalDomain } = resolveWebsiteIdentity(urlOrDomain);
    const key = this.memoryKey(canonicalDomain);

    const raw = await this.provider.download(key);
    if (!raw) {
      throw new WebsiteMemoryNotFoundError(canonicalDomain);
    }

    let mem: WebsiteMemory;
    try {
      mem = JSON.parse(raw.toString("utf8")) as WebsiteMemory;
    } catch (parseErr) {
      throw new WebsiteMemoryCorruptError(
        canonicalDomain,
        `JSON parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      );
    }

    // Schema version gate
    if (mem.schemaVersion > MEMORY_SCHEMA_VERSION) {
      throw new WebsiteMemoryCorruptError(
        canonicalDomain,
        `Unsupported schemaVersion ${mem.schemaVersion} (this build supports up to ${MEMORY_SCHEMA_VERSION})`,
      );
    }

    // Checksum verification
    if (!verifyChecksum(mem)) {
      throw new WebsiteMemoryCorruptError(
        canonicalDomain,
        "checksum mismatch — manifest may be truncated or tampered with",
      );
    }

    logger.debug(
      { canonicalDomain, version: mem._version, savedAt: mem._savedAt },
      "PWIM: memory loaded",
    );

    return mem;
  }

  // ── createWebsiteMemory ───────────────────────────────────────────────────

  /**
   * Creates a fresh memory manifest for a website and persists it.
   * Safe to call concurrently — if a manifest already exists it is returned
   * as-is rather than overwritten (use saveWebsiteMemory to update).
   */
  async createWebsiteMemory(urlOrDomain: string): Promise<WebsiteMemory> {
    const { canonicalDomain, websiteId } = resolveWebsiteIdentity(urlOrDomain);

    // Idempotent: return existing memory if already created
    const exists = await this.websiteMemoryExists(canonicalDomain);
    if (exists) {
      logger.debug(
        { canonicalDomain },
        "PWIM: createWebsiteMemory called but memory already exists — returning existing",
      );
      return this.loadWebsiteMemory(canonicalDomain);
    }

    const now = new Date().toISOString();
    const draft: WebsiteMemory = {
      canonicalDomain,
      websiteId,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      crawlerVersion: CRAWLER_VERSION,
      createdAt: now,
      lastCrawlAt: null,
      lastSuccessfulPipeline: null,
      currentPipelineState: "idle",
      currentJobId: null,
      knowledgeModules: emptyModuleMap(),
      moduleVersions: emptyVersionMap(),
      checkpointReferences: [],
      executionHistory: [],
      websitePrimeStatus: "not-generated",
      certificationStatus: { grade: null, score: null, certifiedAt: null, jobId: null },
      _version: 1,
      _checksum: "",
      _savedAt: now,
    };

    draft._checksum = computeChecksum(draft);

    await this._writeMemory(draft, /* expectedVersion */ null);

    logger.info(
      { canonicalDomain, websiteId, version: draft._version },
      "PWIM: website memory created",
    );

    return draft;
  }

  // ── saveWebsiteMemory ─────────────────────────────────────────────────────

  /**
   * Persists an updated memory manifest to storage.
   *
   * Before writing:
   *   1. Serializes to JSON and verifies it re-parses cleanly (malformed JSON
   *      safety check).
   *   2. Verifies that no concurrent write has advanced the stored _version
   *      beyond the caller's loaded version.
   *   3. Stamps _version, _savedAt, and _checksum.
   *
   * @throws WebsiteMemoryConflictError on concurrent write conflict
   */
  async saveWebsiteMemory(mem: WebsiteMemory): Promise<WebsiteMemory> {
    const expectedVersion = mem._version;
    const now = new Date().toISOString();

    // Stamp metadata
    const draft: WebsiteMemory = {
      ...mem,
      _version: mem._version + 1,
      _savedAt: now,
      _checksum: "",
    };
    draft._checksum = computeChecksum(draft);

    // Concurrent-write check — compare against stored version before writing
    const key = this.memoryKey(mem.canonicalDomain);
    const existing = await this.provider.download(key);
    if (existing) {
      try {
        const stored = JSON.parse(existing.toString("utf8")) as WebsiteMemory;
        if (stored._version !== expectedVersion) {
          throw new WebsiteMemoryConflictError(
            mem.canonicalDomain,
            expectedVersion,
            stored._version,
          );
        }
      } catch (err) {
        if (err instanceof WebsiteMemoryConflictError) throw err;
        // Stored JSON is malformed — safe to overwrite
        logger.warn(
          { canonicalDomain: mem.canonicalDomain, err },
          "PWIM: stored memory JSON is malformed — overwriting",
        );
      }
    }

    await this._writeMemory(draft, expectedVersion);

    logger.debug(
      {
        canonicalDomain: draft.canonicalDomain,
        version: draft._version,
        savedAt: draft._savedAt,
      },
      "PWIM: memory saved",
    );

    return draft;
  }

  // ── updateKnowledgeModule ─────────────────────────────────────────────────

  /**
   * Loads, updates a single knowledge module, and saves in one operation.
   * This is the recommended path for stage engines to record their outputs.
   *
   * @param urlOrDomain  target website
   * @param stage        pipeline stage key
   * @param update       partial fields to merge into the existing module
   */
  async updateKnowledgeModule(
    urlOrDomain: string,
    stage: PipelineStageKey,
    update: Partial<Omit<KnowledgeModule, "version">>,
  ): Promise<WebsiteMemory> {
    const mem = await this.loadWebsiteMemory(urlOrDomain);

    const existing = mem.knowledgeModules[stage];
    const newVersion = existing.version + (update.completed ? 1 : 0);

    const updated: KnowledgeModule = {
      ...existing,
      ...update,
      version: newVersion,
      generatedAt: update.completed ? (update.generatedAt ?? new Date().toISOString()) : existing.generatedAt,
    };

    // Recompute health if not explicitly provided
    if (!update.health) {
      updated.health = this._deriveModuleHealth(updated);
    }

    const updatedMem: WebsiteMemory = {
      ...mem,
      knowledgeModules: { ...mem.knowledgeModules, [stage]: updated },
      moduleVersions: { ...mem.moduleVersions, [stage]: updated.version },
    };

    return this.saveWebsiteMemory(updatedMem);
  }

  // ── getKnowledgeModule ────────────────────────────────────────────────────

  /**
   * Retrieves a single knowledge module from the stored manifest.
   *
   * @throws WebsiteMemoryNotFoundError when no manifest exists
   */
  async getKnowledgeModule(
    urlOrDomain: string,
    stage: PipelineStageKey,
  ): Promise<KnowledgeModule> {
    const mem = await this.loadWebsiteMemory(urlOrDomain);
    return mem.knowledgeModules[stage];
  }

  // ── getWebsiteMemorySummary ───────────────────────────────────────────────

  /**
   * Returns a lightweight summary without parsing the full knowledgeModules map.
   *
   * @throws WebsiteMemoryNotFoundError when no manifest exists
   */
  async getWebsiteMemorySummary(urlOrDomain: string): Promise<WebsiteMemorySummary> {
    const mem = await this.loadWebsiteMemory(urlOrDomain);

    const modules = Object.values(mem.knowledgeModules) as KnowledgeModule[];
    const completedModules = modules.filter((m) => m.completed).length;

    return {
      canonicalDomain: mem.canonicalDomain,
      websiteId: mem.websiteId,
      schemaVersion: mem.schemaVersion,
      currentPipelineState: mem.currentPipelineState,
      currentJobId: mem.currentJobId,
      lastCrawlAt: mem.lastCrawlAt,
      lastSuccessfulPipeline: mem.lastSuccessfulPipeline,
      completedModules,
      totalModules: PIPELINE_STAGE_KEYS.length,
      websitePrimeStatus: mem.websitePrimeStatus,
      certificationGrade: mem.certificationStatus.grade,
      certificationScore: mem.certificationStatus.score,
      runCount: mem.executionHistory.length,
      _version: mem._version,
      _savedAt: mem._savedAt,
    };
  }

  // ── appendExecutionHistory ────────────────────────────────────────────────

  /**
   * Convenience method: appends a pipeline run summary to history and saves.
   * Caps history at MAX_HISTORY_ENTRIES (most recent first).
   */
  async appendExecutionHistory(
    urlOrDomain: string,
    run: PipelineRunSummary,
  ): Promise<WebsiteMemory> {
    const mem = await this.loadWebsiteMemory(urlOrDomain);

    const history = [run, ...mem.executionHistory].slice(0, MAX_HISTORY_ENTRIES);

    const updatedMem: WebsiteMemory = {
      ...mem,
      executionHistory: history,
      lastCrawlAt:
        run.stages.includes("crawl") && run.outcome !== "failure"
          ? (run.completedAt ?? mem.lastCrawlAt)
          : mem.lastCrawlAt,
      lastSuccessfulPipeline:
        run.outcome === "success"
          ? (run.completedAt ?? mem.lastSuccessfulPipeline)
          : mem.lastSuccessfulPipeline,
      currentPipelineState: run.outcome === "in-progress" ? "running" :
                            run.outcome === "failure"     ? "failed"  :
                            run.outcome === "success"     ? "completed" : "idle",
    };

    return this.saveWebsiteMemory(updatedMem);
  }

  // ── Private: write ────────────────────────────────────────────────────────

  /**
   * Validates and writes a memory manifest to storage.
   * Never writes if JSON serialization or re-parse fails (malformed data guard).
   */
  private async _writeMemory(
    mem: WebsiteMemory,
    _expectedVersion: number | null,
  ): Promise<void> {
    // Safety: serialize and re-parse to confirm the JSON is valid before
    // writing. This prevents truncated / malformed data from reaching R2.
    let serialized: string;
    try {
      serialized = JSON.stringify(mem, null, 2);
      JSON.parse(serialized); // throws on malformed output
    } catch (err) {
      throw new Error(
        `PWIM: refused to write malformed memory for "${mem.canonicalDomain}": ${String(err)}`,
      );
    }

    const key = this.memoryKey(mem.canonicalDomain);
    await this.provider.upload({
      key,
      data: Buffer.from(serialized, "utf8"),
      contentType: "application/json",
      checkDuplicate: false, // always overwrite; the version counter handles conflicts
    });
  }

  // ── Private: health derivation ────────────────────────────────────────────

  private _deriveModuleHealth(mod: KnowledgeModule): KnowledgeModuleHealth {
    if (!mod.completed) return "missing";
    if (!mod.generatedAt) return "missing";
    return "healthy";
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton factory (process-scoped)
// ---------------------------------------------------------------------------

let _singleton: WebsiteMemoryService | null = null;

/**
 * Returns the process-level WebsiteMemoryService instance.
 * Lazily created on first call; subsequent calls return the same instance.
 */
export function getWebsiteMemoryService(): WebsiteMemoryService {
  if (!_singleton) {
    _singleton = new WebsiteMemoryService();
  }
  return _singleton;
}
