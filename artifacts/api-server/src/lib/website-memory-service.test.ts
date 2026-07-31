/**
 * website-memory-service.test.ts — Phase D4.1 PWIM Foundation Tests
 *
 * Standalone executable tests — no external framework required.
 * Run with:  npx tsx src/lib/website-memory-service.test.ts
 *
 * Tests:
 *   T1  Create memory for a new website
 *   T2  Load existing memory from R2
 *   T3  Update a knowledge module
 *   T4  Detect an existing website (websiteMemoryExists)
 *   T5  Canonicalize equivalent URLs to the same identity
 *   T6  Handle missing memory.json gracefully
 *   T7  Handle malformed memory.json safely (corruption recovery)
 *   T8  Preserve existing R2 artifacts (no-overlap with job-set-* keys)
 */

import { createHash } from "crypto";
import {
  createWebsiteMemory,
  loadWebsiteMemory,
  saveWebsiteMemory,
  loadOrCreateWebsiteMemory,
  updateKnowledgeModule,
  getKnowledgeModule,
  websiteMemoryExists,
  getWebsiteMemorySummary,
  updateCheckpointReference,
  recordPipelineStart,
  recordPipelineEnd,
  type WebsiteMemory,
  type PipelineRunRecord,
} from "./website-memory-service.js";
import {
  deriveWebsiteIdentity,
  canonicalizeDomain,
  isSameWebsite,
  normalizeSeedUrl,
} from "./website-identity.js";
import { R2Keys } from "../cloud/r2-key-registry.js";
import type { CloudProvider, UploadParams, UploadResult } from "../cloud/provider.js";

// ---------------------------------------------------------------------------
// In-memory mock cloud provider
// ---------------------------------------------------------------------------

class MockCloudProvider implements CloudProvider {
  readonly providerName = "mock";
  private store = new Map<string, Buffer>();
  /** Keys written, in insertion order. Used to verify key namespacing. */
  readonly writtenKeys: string[] = [];

  isConfigured() { return true; }

  async upload(params: UploadParams): Promise<UploadResult> {
    this.store.set(params.key, params.data);
    this.writtenKeys.push(params.key);
    return {
      provider: "mock",
      key: params.key,
      url: `https://mock-r2/${params.key}`,
      skippedAsDuplicate: false,
      bytesUploaded: params.data.length,
      attempts: 1,
      durationMs: 0,
    };
  }

  async download(key: string): Promise<Buffer | null> {
    return this.store.get(key) ?? null;
  }

  async verify(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  getPublicUrl(key: string): string {
    return `https://mock-r2/${key}`;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Inject raw content at a key (for simulating corrupt data). */
  inject(key: string, content: string): void {
    this.store.set(key, Buffer.from(content, "utf8"));
  }

  /** Returns all keys currently in the store. */
  allKeys(): string[] {
    return Array.from(this.store.keys());
  }

  /** Returns all keys that start with the given prefix. */
  keysWithPrefix(prefix: string): string[] {
    return this.allKeys().filter(k => k.startsWith(prefix));
  }
}

/** Mock provider that is not configured (simulates missing credentials). */
class UnconfiguredMockProvider extends MockCloudProvider {
  override isConfigured() { return false; }
}

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------

type TestFn = () => Promise<void>;

const tests: Array<{ id: string; label: string; fn: TestFn }> = [];
let passed = 0;
let failed = 0;

function test(id: string, label: string, fn: TestFn) {
  tests.push({ id, label, fn });
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

async function runAll(): Promise<void> {
  console.log("\n=== Phase D4.1 — PWIM Foundation Tests ===\n");
  for (const { id, label, fn } of tests) {
    process.stdout.write(`  [${id}] ${label} ... `);
    try {
      await fn();
      console.log("PASS");
      passed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`FAIL\n      ${msg}`);
      failed++;
    }
  }
  console.log(`\n  Results: ${passed} passed, ${failed} failed out of ${tests.length} tests`);
  if (failed > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// T1 — Create memory for a new website
// ---------------------------------------------------------------------------

test("T1", "Create memory for a new website", async () => {
  const cloud = new MockCloudProvider();
  const url = "https://www.colincowie.com/";

  const memory = await loadOrCreateWebsiteMemory(url, cloud);

  assertEqual(memory.schemaVersion,     "D4.1",         "schemaVersion");
  assertEqual(memory.canonicalDomain,   "colincowie.com", "canonicalDomain");
  assert(memory.websiteId.length === 16,                 "websiteId is 16 chars");
  assert(memory.createdAt.length > 0,                    "createdAt populated");
  assertEqual(memory.checkpointVersion, 1,               "first save increments to v1");
  assert(!memory.lastSuccessfulPipeline,                 "no pipeline run yet");
  assert(Object.keys(memory.knowledgeModules).length >= 12, "12 modules created");

  // Must be persisted to R2
  const exists = await websiteMemoryExists(url, cloud);
  assert(exists, "memory.json exists in R2 after creation");

  // R2 key must be under websites/ namespace
  const wsKey = R2Keys.websites.memory(memory.websiteId);
  assert(wsKey.startsWith("websites/"),                  "key under websites/ prefix");
});

// ---------------------------------------------------------------------------
// T2 — Load existing memory from R2
// ---------------------------------------------------------------------------

test("T2", "Load existing memory from R2", async () => {
  const cloud = new MockCloudProvider();
  const url = "https://colincowie.com";

  // First: create and save
  const created = await loadOrCreateWebsiteMemory(url, cloud);
  assertEqual(created.checkpointVersion, 1, "initial checkpointVersion");

  // Second: load — should return same record, NOT create another
  const loaded = await loadWebsiteMemory(url, cloud);
  assert(loaded !== null, "loaded memory is non-null");
  assertEqual(loaded!.websiteId,        created.websiteId,        "same websiteId");
  assertEqual(loaded!.canonicalDomain,  created.canonicalDomain,  "same canonicalDomain");
  assertEqual(loaded!.checkpointVersion, 1,                        "same checkpointVersion");
});

// ---------------------------------------------------------------------------
// T3 — Update a knowledge module
// ---------------------------------------------------------------------------

test("T3", "Update a knowledge module", async () => {
  const cloud = new MockCloudProvider();
  const url = "https://example.com";

  let memory = createWebsiteMemory(url);

  // Module starts missing
  const before = getKnowledgeModule(memory, "crawl");
  assertEqual(before.health, "missing", "initial health is missing");
  assert(!before.completed,             "initial completed is false");

  // Update it
  memory = updateKnowledgeModule(memory, "crawl", {
    completed:        true,
    health:           "healthy",
    version:          "1.2.0",
    generatorVersion: "4.1.0",
    generatedAt:      new Date().toISOString(),
    outputLocation:   R2Keys.raw.pages("test-job-abc"),
    checksum:         "abc123def456",
    metadata:         { totalUrls: 42 },
  });

  const after = getKnowledgeModule(memory, "crawl");
  assertEqual(after.health,    "healthy", "health updated");
  assertEqual(after.completed, true,       "completed updated");
  assertEqual(after.version,   "1.2.0",   "version updated");
  assertEqual(memory.moduleVersions["crawl"], "1.2.0", "moduleVersions synced");

  // Persist and reload
  const saved = await saveWebsiteMemory(memory, cloud);
  const reloaded = await loadWebsiteMemory(url, cloud);
  const reloadedModule = getKnowledgeModule(reloaded!, "crawl");
  assertEqual(reloadedModule.health,    "healthy", "health survived round-trip");
  assertEqual(reloadedModule.completed, true,       "completed survived round-trip");
  _ = saved; // used
});

// ---------------------------------------------------------------------------
// T4 — Detect an existing website
// ---------------------------------------------------------------------------

test("T4", "Detect an existing website via websiteMemoryExists", async () => {
  const cloud = new MockCloudProvider();
  const url = "https://brand-new-site.io/";

  const beforeCreate = await websiteMemoryExists(url, cloud);
  assert(!beforeCreate, "should not exist before creation");

  await loadOrCreateWebsiteMemory(url, cloud);

  const afterCreate = await websiteMemoryExists(url, cloud);
  assert(afterCreate, "should exist after creation");
});

// ---------------------------------------------------------------------------
// T5 — Canonicalize equivalent URLs to the same identity
// ---------------------------------------------------------------------------

test("T5", "Equivalent URLs resolve to the same websiteId", async () => {
  const variants = [
    "https://www.colincowie.com/",
    "http://www.colincowie.com",
    "https://colincowie.com/",
    "http://colincowie.com",
    "https://colincowie.com",
    "colincowie.com",
  ];

  const ids = variants.map(u => deriveWebsiteIdentity(u).websiteId);
  const domains = variants.map(u => canonicalizeDomain(u));

  const firstId = ids[0]!;
  for (let i = 1; i < ids.length; i++) {
    assertEqual(ids[i]!, firstId, `variant ${variants[i]} should have same websiteId`);
    assertEqual(domains[i]!, "colincowie.com", `variant ${variants[i]} should normalize to colincowie.com`);
  }

  assert(isSameWebsite("https://www.foo.com", "http://foo.com/page"), "www+protocol agnostic");
  assert(!isSameWebsite("https://foo.com", "https://bar.com"),         "different domains differ");

  // Non-www subdomains are NOT collapsed (shop.foo.com ≠ foo.com)
  assert(!isSameWebsite("https://shop.foo.com", "https://foo.com"),    "subdomain is distinct");

  // normalizeSeedUrl strips www but keeps path
  const cleanUrl = normalizeSeedUrl("http://www.example.com/blog/");
  assert(cleanUrl === "https://example.com/blog",  `normalizeSeedUrl: expected https://example.com/blog, got ${cleanUrl}`);
});

// ---------------------------------------------------------------------------
// T6 — Handle missing memory.json gracefully
// ---------------------------------------------------------------------------

test("T6", "Handle missing memory.json gracefully", async () => {
  const cloud = new MockCloudProvider();
  const result = await loadWebsiteMemory("https://never-crawled.io", cloud);
  assert(result === null, "should return null when no memory exists");

  // Summary of null memory should have exists: false
  const summary = getWebsiteMemorySummary(null, "https://never-crawled.io");
  assert(!summary.exists,                             "summary.exists is false");
  assertEqual(summary.checkpointVersion, 0,           "no checkpoints");
  assert(summary.missingModules.length >= 12,         "all modules missing");
  assert(summary.completedModules.length === 0,       "no completed modules");
});

// ---------------------------------------------------------------------------
// T7 — Handle malformed memory.json safely (corruption recovery)
// ---------------------------------------------------------------------------

test("T7", "Recover from corrupt memory.json via versioned snapshot", async () => {
  const cloud = new MockCloudProvider();
  const url = "https://recovery-test.com";

  // Create a valid memory record and save it (produces v1 + memory.json)
  let memory = createWebsiteMemory(url);
  memory = await saveWebsiteMemory(memory, cloud);
  assertEqual(memory.checkpointVersion, 1, "saved as v1");

  // Now corrupt the live memory.json
  const { websiteId } = deriveWebsiteIdentity(url);
  cloud.inject(R2Keys.websites.memory(websiteId), "{corrupt json!!!}");

  // Load should recover from memory-v0001.json
  const recovered = await loadWebsiteMemory(url, cloud);
  assert(recovered !== null,                          "recovered despite corruption");
  assertEqual(recovered!.websiteId, memory.websiteId, "recovered websiteId matches");
  assertEqual(recovered!.checkpointVersion, 1,        "recovered checkpointVersion matches");

  // Fully malformed — no versioned snapshots either
  const freshCloud = new MockCloudProvider();
  const { websiteId: freshId } = deriveWebsiteIdentity("https://total-loss.io");
  freshCloud.inject(R2Keys.websites.memory(freshId), "null");
  // No versioned snapshots exist either → should return null gracefully
  const totalLoss = await loadWebsiteMemory("https://total-loss.io", freshCloud);
  assert(totalLoss === null, "returns null when all snapshots are missing");
});

// ---------------------------------------------------------------------------
// T8 — Preserve existing R2 artifacts (namespace isolation)
// ---------------------------------------------------------------------------

test("T8", "PWIM writes stay in websites/ — no job-set-* namespace pollution", async () => {
  const cloud = new MockCloudProvider();

  // Pre-populate some existing job-set keys (simulating live system artifacts)
  const existingKeys = [
    R2Keys.raw.pages("old-job-123"),
    R2Keys.manifest.index("old-job-123"),
    R2Keys.certification.report("old-job-123"),
    R2Keys.websitePrime.zip("old-job-123"),
    R2Keys.checkpoints.latest("old-job-123"),
  ];
  for (const key of existingKeys) {
    await cloud.upload({ key, data: Buffer.from('{"existing":true}'), contentType: "application/json" });
  }

  // Create PWIM memory for a website
  await loadOrCreateWebsiteMemory("https://colincowie.com", cloud);

  // All pre-existing keys must still be present
  for (const key of existingKeys) {
    const still = await cloud.verify(key);
    assert(still, `existing key "${key}" must not be deleted by PWIM`);
  }

  // All PWIM writes must be under websites/ only
  const newPwimKeys = cloud.writtenKeys.filter(
    k => !existingKeys.includes(k)
  );
  for (const key of newPwimKeys) {
    assert(
      key.startsWith("websites/"),
      `PWIM key "${key}" must start with websites/`,
    );
  }
});

// ---------------------------------------------------------------------------
// T9 — Pipeline run lifecycle (start → end → history)
// ---------------------------------------------------------------------------

test("T9", "Pipeline run lifecycle recorded in memory", async () => {
  const cloud = new MockCloudProvider();
  const url = "https://lifecycle-test.com";

  let memory = createWebsiteMemory(url);

  const run: PipelineRunRecord = {
    pipelineRunId:     "orch-abc-001",
    scrapeJobId:       "scrape-xyz-001",
    startedAt:         new Date().toISOString(),
    completedAt:       null,
    status:            "running",
    completedStages:   [],
    failedStages:      [],
    skippedStages:     [],
    coveragePct:       null,
    totalDurationMs:   null,
    r2OutputReferences: {},
  };

  // Record start
  memory = recordPipelineStart(memory, run);
  assert(memory.currentPipelineState !== null,     "currentPipelineState set");
  assertEqual(memory.currentPipelineState!.pipelineRunId, "orch-abc-001", "run ID stored");

  // Record completion
  const completedRun: PipelineRunRecord = {
    ...run,
    completedAt:     new Date().toISOString(),
    status:          "complete",
    completedStages: ["crawl", "manifest"],
    coveragePct:     100,
    totalDurationMs: 12345,
  };
  memory = recordPipelineEnd(memory, completedRun, cloud);

  assert(memory.currentPipelineState === null,                "currentPipelineState cleared after completion");
  assert(memory.lastSuccessfulPipeline !== null,              "lastSuccessfulPipeline promoted");
  assertEqual(memory.lastSuccessfulPipeline!.status, "complete", "status is complete");
  assertEqual(memory.executionHistory.length, 1,              "one run in history");

  const summary = getWebsiteMemorySummary(memory, url);
  assertEqual(summary.lastSuccessfulPipelineRunId, "orch-abc-001", "summary points to correct run");
  assertEqual(summary.runCount, 1,                              "runCount=1");
});

// ---------------------------------------------------------------------------
// T10 — Checkpoint reference updates
// ---------------------------------------------------------------------------

test("T10", "Checkpoint reference pointer updates", async () => {
  const cloud = new MockCloudProvider();
  const url = "https://checkpoint-test.com";

  let memory = createWebsiteMemory(url);
  assertEqual(memory.checkpointReferences.coveragePct, null, "initial coverage null");

  memory = updateCheckpointReference(memory, {
    scrapeJobId:         "scrape-job-999",
    latestCheckpointKey: R2Keys.checkpoints.latest("scrape-job-999"),
    checkpointVersion:   7,
    coveragePct:         70,
    completedUrls:       ["https://ex.com/a", "https://ex.com/b"],
    pendingUrls:         ["https://ex.com/c"],
    failedUrls:          [],
  });

  assertEqual(memory.checkpointReferences.coveragePct, 70,          "coveragePct stored");
  assertEqual(memory.checkpointReferences.completedUrls.length, 2,   "completedUrls stored");
  assertEqual(memory.checkpointReferences.pendingUrls.length, 1,     "pendingUrls stored");
  assert(memory.checkpointReferences.savedAt !== null,               "savedAt populated");

  // Round-trip through R2
  const saved = await saveWebsiteMemory(memory, cloud);
  const loaded = await loadWebsiteMemory(url, cloud);
  assertEqual(loaded!.checkpointReferences.coveragePct, 70,          "coveragePct survived round-trip");
  _ = saved;
});

// ---------------------------------------------------------------------------
// T11 — Unconfigured cloud provider behaves safely
// ---------------------------------------------------------------------------

test("T11", "Unconfigured cloud provider returns null and skips writes", async () => {
  const cloud = new UnconfiguredMockProvider();

  const exists = await websiteMemoryExists("https://foo.com", cloud);
  assert(!exists, "exists returns false when unconfigured");

  const loaded = await loadWebsiteMemory("https://foo.com", cloud);
  assert(loaded === null, "load returns null when unconfigured");

  // Save should not throw and returns updated memory (without R2 write)
  const memory = createWebsiteMemory("https://foo.com");
  const result = await saveWebsiteMemory(memory, cloud);
  assert(result !== null,              "save returns memory even when unconfigured");
  assertEqual(cloud.allKeys().length, 0, "no R2 writes when unconfigured");
});

// ---------------------------------------------------------------------------
// T12 — websiteId is a valid deterministic 16-char hex string
// ---------------------------------------------------------------------------

test("T12", "websiteId is deterministic 16-char hex", async () => {
  const { websiteId } = deriveWebsiteIdentity("https://colincowie.com");
  assert(/^[0-9a-f]{16}$/.test(websiteId), `websiteId must be 16 hex chars, got "${websiteId}"`);

  // Must be stable across repeated calls
  const { websiteId: again } = deriveWebsiteIdentity("https://colincowie.com");
  assertEqual(again, websiteId, "deterministic across calls");

  // Verify it matches the expected SHA-256 derivation
  const expected = createHash("sha256").update("colincowie.com").digest("hex").slice(0, 16);
  assertEqual(websiteId, expected, "matches SHA-256(canonicalDomain).slice(0,16)");
});

// ---------------------------------------------------------------------------
// Unused-variable shim (tests reference `_` to suppress TS warnings)
// ---------------------------------------------------------------------------

let _: unknown;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

runAll().catch(err => {
  console.error("\nTest runner threw:", err);
  process.exit(1);
});
