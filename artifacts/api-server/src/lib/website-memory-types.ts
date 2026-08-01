/**
 * website-memory-types.ts — Phase D4.1 Persistent Website Intelligence Memory (PWIM)
 *
 * Canonical types for the persistent memory layer. Every pipeline stage
 * writes its outputs into the KnowledgeModule registry; the WebsiteMemory
 * manifest is the single source of truth for a website's accumulated
 * intelligence across runs.
 *
 * Schema versioning:
 *   MEMORY_SCHEMA_VERSION must be bumped whenever a breaking field is added
 *   or removed. The memory service rejects manifests whose schemaVersion
 *   exceeds the currently supported version.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MEMORY_SCHEMA_VERSION = 1;
export const CRAWLER_VERSION = "3.0.0";

/**
 * All 12 pipeline stage identifiers, in execution order.
 * Must match the stage IDs used by master-orchestrator.ts.
 */
export const PIPELINE_STAGE_KEYS = [
  "crawl",
  "manifest",
  "diff",
  "intelligence",
  "design-dna",
  "visual-dna",
  "stencil",
  "website-prime",
  "merge",
  "deployment-plan",
  "deploy",
  "certification",
] as const;

export type PipelineStageKey = (typeof PIPELINE_STAGE_KEYS)[number];

// ---------------------------------------------------------------------------
// KnowledgeModule — per-stage artifact record
// ---------------------------------------------------------------------------

/**
 * Health status of a knowledge module's stored output.
 *
 *   healthy   — output present, checksum valid, dependencies satisfied
 *   stale     — output present but a dependency changed since generation
 *   error     — generation failed; outputLocation may be null
 *   missing   — no output has been produced yet for this stage
 */
export type KnowledgeModuleHealth = "healthy" | "stale" | "error" | "missing";

export interface KnowledgeModule {
  /** True when this stage completed successfully at least once. */
  completed: boolean;
  /** Incremented on each successful regeneration of this module. */
  version: number;
  /** Semver string of the engine that produced this module. */
  generatorVersion: string;
  /** ISO-8601 timestamp of the most recent successful generation, or null. */
  generatedAt: string | null;
  /**
   * Stage keys that must be healthy for this module to be considered valid.
   * If any dependency is stale/error, this module is automatically stale.
   */
  dependencies: PipelineStageKey[];
  /**
   * SHA-256 hex digest of the stage output JSON at the time of generation.
   * Used to detect stale modules when dependencies are re-run.
   */
  checksum: string | null;
  /**
   * R2 key (relative to the website prefix) where the stage output lives.
   * Null when the stage has never run or its output was not persisted.
   */
  outputLocation: string | null;
  health: KnowledgeModuleHealth;
}

// ---------------------------------------------------------------------------
// Pipeline run summary — one entry per execution in history
// ---------------------------------------------------------------------------

export type PipelineRunOutcome = "success" | "failure" | "partial" | "in-progress";

export interface PipelineRunSummary {
  /** Job ID from the DB job queue. */
  jobId: string;
  startedAt: string;
  completedAt: string | null;
  outcome: PipelineRunOutcome;
  /** Stage keys that completed (successfully or not) in this run. */
  stages: PipelineStageKey[];
  fidelityScore: number | null;
  certificationGrade: string | null;
  certificationScore: number | null;
}

// ---------------------------------------------------------------------------
// Certification status — summary of the latest certification run
// ---------------------------------------------------------------------------

export interface CertificationStatus {
  grade: string | null;
  score: number | null;
  certifiedAt: string | null;
  jobId: string | null;
}

// ---------------------------------------------------------------------------
// WebsiteMemory — the root manifest persisted to R2
// ---------------------------------------------------------------------------

export type WebsiteMemoryPipelineState =
  | "idle"
  | "running"
  | "paused"
  | "failed"
  | "completed";

export type WebsitePrimeStatus =
  | "not-generated"
  | "generating"
  | "ready"
  | "stale";

export interface WebsiteMemory {
  // ── Identity ─────────────────────────────────────────────────────────────
  /** Canonical domain, e.g. "colincowie.com". Never includes www. or protocol. */
  canonicalDomain: string;
  /**
   * Deterministic 12-hex-char identifier derived from canonicalDomain.
   * Stable across all runs and processes; used in internal references.
   */
  websiteId: string;

  // ── Schema version ───────────────────────────────────────────────────────
  /** Must equal MEMORY_SCHEMA_VERSION; reject manifests with higher values. */
  schemaVersion: number;
  /** Semver of the crawler that created/last updated this memory. */
  crawlerVersion: string;

  // ── Timestamps ───────────────────────────────────────────────────────────
  /** ISO-8601: when this memory was first created. */
  createdAt: string;
  /** ISO-8601: when the last crawl stage completed, or null. */
  lastCrawlAt: string | null;
  /** ISO-8601: when the last fully successful pipeline run completed, or null. */
  lastSuccessfulPipeline: string | null;

  // ── Current pipeline state ───────────────────────────────────────────────
  currentPipelineState: WebsiteMemoryPipelineState;
  /** jobId of the currently running or last-run job, or null. */
  currentJobId: string | null;

  // ── Knowledge modules ────────────────────────────────────────────────────
  /** One entry per pipeline stage. */
  knowledgeModules: Record<PipelineStageKey, KnowledgeModule>;
  /** Current version number for each module (mirrors knowledgeModules[k].version). */
  moduleVersions: Record<PipelineStageKey, number>;

  // ── Checkpoint references ────────────────────────────────────────────────
  /** R2 keys of checkpoint files associated with this website's pipeline runs. */
  checkpointReferences: string[];

  // ── Execution history ────────────────────────────────────────────────────
  /** Most recent runs first. Capped at MAX_HISTORY_ENTRIES. */
  executionHistory: PipelineRunSummary[];

  // ── Output status ────────────────────────────────────────────────────────
  websitePrimeStatus: WebsitePrimeStatus;
  certificationStatus: CertificationStatus;

  // ── Internal integrity (managed by WebsiteMemoryService) ─────────────────
  /**
   * Monotonically increasing integer. Incremented on every save.
   * Callers that load memory and then save must increment this; a mismatch
   * between the loaded version and what is in R2 at save time indicates a
   * concurrent write conflict.
   */
  _version: number;
  /**
   * SHA-256 hex digest of the JSON serialization of this object with
   * _checksum set to "". Used to detect truncated or corrupted manifests.
   */
  _checksum: string;
  /** ISO-8601 timestamp of the last successful write. */
  _savedAt: string;
}

// ---------------------------------------------------------------------------
// Summary — lightweight view returned by getWebsiteMemorySummary()
// ---------------------------------------------------------------------------

export interface WebsiteMemorySummary {
  canonicalDomain: string;
  websiteId: string;
  schemaVersion: number;
  currentPipelineState: WebsiteMemoryPipelineState;
  currentJobId: string | null;
  lastCrawlAt: string | null;
  lastSuccessfulPipeline: string | null;
  completedModules: number;
  totalModules: number;
  websitePrimeStatus: WebsitePrimeStatus;
  certificationGrade: string | null;
  certificationScore: number | null;
  runCount: number;
  _version: number;
  _savedAt: string;
}

// ---------------------------------------------------------------------------
// Max history cap
// ---------------------------------------------------------------------------

export const MAX_HISTORY_ENTRIES = 50;
