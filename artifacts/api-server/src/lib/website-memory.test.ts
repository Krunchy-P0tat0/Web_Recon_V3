/**
 * website-memory.test.ts — Phase D4.1 PWIM test suite
 *
 * Tests cover all 8 required scenarios:
 *   1. Creating memory for a new website
 *   2. Loading existing memory
 *   3. Updating a knowledge module
 *   4. Detecting an existing website
 *   5. Canonicalizing equivalent URLs
 *   6. Handling missing memory.json
 *   7. Handling malformed memory safely
 *   8. Preserving existing R2 artifacts
 *
 * Uses an in-memory CloudProvider — no real R2 or filesystem required.
 */

import { describe, it, expect } from "vitest";
import type { CloudProvider, UploadParams, UploadResult } from "../cloud/provider.js";
import { WebsiteMemoryService, WebsiteMemoryNotFoundError, WebsiteMemoryCorruptError } from "./website-memory-service.js";
import { resolveWebsiteIdentity } from "./website-identity.js";
import { MEMORY_SCHEMA_VERSION } from "./website-memory-types.js";

// ---------------------------------------------------------------------------
// In-memory CloudProvider for tests
//
// Uses a Map<string, Buffer> as storage and returns http://local/<key> URLs
// so the assertUploadResult invariant (must be http:// or https://) is met.
// ---------------------------------------------------------------------------

class MemoryCloudProvider implements CloudProvider {
  readonly providerName = "memory";
  private readonly store = new Map<string, Buffer>();

  isConfigured(): boolean { return true; }

  getPublicUrl(key: string): string { return `http://local/${key}`; }

  async upload(params: UploadParams): Promise<UploadResult> {
    const { key, data, checkDuplicate = true } = params;
    if (checkDuplicate && this.store.has(key)) {
      return { provider: this.providerName, key, url: this.getPublicUrl(key), skippedAsDuplicate: true, bytesUploaded: 0, attempts: 0, durationMs: 0 };
    }
    this.store.set(key, Buffer.from(data));
    return { provider: this.providerName, key, url: this.getPublicUrl(key), skippedAsDuplicate: false, bytesUploaded: data.length, attempts: 1, durationMs: 0 };
  }

  async verify(key: string): Promise<boolean> { return this.store.has(key); }

  async download(key: string): Promise<Buffer | null> { return this.store.get(key) ?? null; }

  async delete(key: string): Promise<void> { this.store.delete(key); }

  async list(prefix?: string): Promise<Array<{ key: string; size: number; lastModified: string }>> {
    const results: Array<{ key: string; size: number; lastModified: string }> = [];
    for (const [k, v] of this.store) {
      if (!prefix || k.startsWith(prefix)) {
        results.push({ key: k, size: v.length, lastModified: new Date().toISOString() });
      }
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(): { service: WebsiteMemoryService; provider: MemoryCloudProvider } {
  const provider = new MemoryCloudProvider();
  const service = new WebsiteMemoryService(provider);
  return { service, provider };
}

// ---------------------------------------------------------------------------
// Test 1: Creating memory for a new website
// ---------------------------------------------------------------------------

describe("1. createWebsiteMemory — new website", () => {
  it("creates a valid memory manifest with correct identity and defaults", async () => {
    const { service } = await makeService();
    const mem = await service.createWebsiteMemory("https://www.colincowie.com/");

    expect(mem.canonicalDomain).toBe("colincowie.com");
    expect(mem.websiteId).toHaveLength(12);
    expect(mem.schemaVersion).toBe(MEMORY_SCHEMA_VERSION);
    expect(mem.currentPipelineState).toBe("idle");
    expect(mem.currentJobId).toBeNull();
    expect(mem.lastCrawlAt).toBeNull();
    expect(mem.lastSuccessfulPipeline).toBeNull();
    expect(mem.websitePrimeStatus).toBe("not-generated");
    expect(mem.certificationStatus.grade).toBeNull();
    expect(mem._version).toBe(1);
    expect(mem._checksum).toHaveLength(32);
    expect(mem.executionHistory).toHaveLength(0);
    // All 12 knowledge modules present and empty
    expect(Object.keys(mem.knowledgeModules)).toHaveLength(12);
    for (const mod of Object.values(mem.knowledgeModules)) {
      expect(mod.completed).toBe(false);
      expect(mod.health).toBe("missing");
    }
  });

  it("is idempotent — calling createWebsiteMemory twice returns existing memory", async () => {
    const { service } = await makeService();
    const mem1 = await service.createWebsiteMemory("https://example.com");
    const mem2 = await service.createWebsiteMemory("https://example.com");
    expect(mem1._version).toBe(mem2._version);
    expect(mem1._checksum).toBe(mem2._checksum);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Loading existing memory
// ---------------------------------------------------------------------------

describe("2. loadWebsiteMemory — round-trip", () => {
  it("loads a previously created manifest with identical fields", async () => {
    const { service } = await makeService();
    await service.createWebsiteMemory("https://example.com");
    const loaded = await service.loadWebsiteMemory("https://example.com");

    expect(loaded.canonicalDomain).toBe("example.com");
    expect(loaded.schemaVersion).toBe(MEMORY_SCHEMA_VERSION);
    expect(loaded._version).toBe(1);
  });

  it("can load by URL, domain, or any equivalent variant", async () => {
    const { service } = await makeService();
    await service.createWebsiteMemory("example.com");

    const a = await service.loadWebsiteMemory("https://example.com");
    const b = await service.loadWebsiteMemory("http://www.example.com/");
    expect(a.canonicalDomain).toBe(b.canonicalDomain);
    expect(a._checksum).toBe(b._checksum);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Updating a knowledge module
// ---------------------------------------------------------------------------

describe("3. updateKnowledgeModule", () => {
  it("marks a stage as completed and increments its version", async () => {
    const { service } = await makeService();
    await service.createWebsiteMemory("https://test.example.com");

    const updated = await service.updateKnowledgeModule("test.example.com", "crawl", {
      completed: true,
      generatorVersion: "3.0.0",
      outputLocation: "websites/test.example.com/pipeline/crawl.json",
      checksum: "abc123",
    });

    const mod = updated.knowledgeModules["crawl"];
    expect(mod.completed).toBe(true);
    expect(mod.version).toBe(1);
    expect(mod.health).toBe("healthy");
    expect(mod.generatedAt).not.toBeNull();
    expect(updated.moduleVersions["crawl"]).toBe(1);
    // Manifest version should have incremented twice (create=1, update=2)
    expect(updated._version).toBe(2);
  });

  it("can retrieve the updated module via getKnowledgeModule", async () => {
    const { service } = await makeService();
    await service.createWebsiteMemory("get-module.example.com");
    await service.updateKnowledgeModule("get-module.example.com", "intelligence", {
      completed: true,
      outputLocation: "websites/get-module.example.com/pipeline/intelligence.json",
    });

    const mod = await service.getKnowledgeModule("get-module.example.com", "intelligence");
    expect(mod.completed).toBe(true);
    expect(mod.health).toBe("healthy");
  });
});

// ---------------------------------------------------------------------------
// Test 4: Detecting an existing website
// ---------------------------------------------------------------------------

describe("4. websiteMemoryExists", () => {
  it("returns false before memory is created", async () => {
    const { service } = await makeService();
    const exists = await service.websiteMemoryExists("https://never-created.com");
    expect(exists).toBe(false);
  });

  it("returns true after memory is created", async () => {
    const { service } = await makeService();
    await service.createWebsiteMemory("https://was-created.com");
    const exists = await service.websiteMemoryExists("was-created.com");
    expect(exists).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Canonicalizing equivalent URLs
// ---------------------------------------------------------------------------

describe("5. URL canonicalization", () => {
  const equivalentUrls = [
    "https://www.colincowie.com/",
    "https://colincowie.com",
    "http://www.colincowie.com",
    "http://colincowie.com/about",
    "HTTPS://WWW.COLINCOWIE.COM/",
    "colincowie.com",
    "www.colincowie.com",
  ];

  it("all equivalent URL variants resolve to the same identity", () => {
    const identities = equivalentUrls.map(resolveWebsiteIdentity);
    const domains = new Set(identities.map((i) => i.canonicalDomain));
    const ids = new Set(identities.map((i) => i.websiteId));

    expect(domains.size).toBe(1);
    expect([...domains][0]).toBe("colincowie.com");
    expect(ids.size).toBe(1);
    expect([...ids][0]).toHaveLength(12);
  });

  it("distinct domains produce distinct IDs", () => {
    const a = resolveWebsiteIdentity("example.com");
    const b = resolveWebsiteIdentity("example.org");
    expect(a.websiteId).not.toBe(b.websiteId);
    expect(a.canonicalDomain).not.toBe(b.canonicalDomain);
  });

  it("websiteId is stable across calls", () => {
    const id1 = resolveWebsiteIdentity("https://www.example.com").websiteId;
    const id2 = resolveWebsiteIdentity("example.com").websiteId;
    expect(id1).toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Handling missing memory.json
// ---------------------------------------------------------------------------

describe("6. missing memory.json", () => {
  it("loadWebsiteMemory throws WebsiteMemoryNotFoundError", async () => {
    const { service } = await makeService();
    await expect(
      service.loadWebsiteMemory("https://ghost.example.com"),
    ).rejects.toThrow(WebsiteMemoryNotFoundError);
  });

  it("getKnowledgeModule propagates WebsiteMemoryNotFoundError", async () => {
    const { service } = await makeService();
    await expect(
      service.getKnowledgeModule("ghost.example.com", "crawl"),
    ).rejects.toThrow(WebsiteMemoryNotFoundError);
  });

  it("getWebsiteMemorySummary propagates WebsiteMemoryNotFoundError", async () => {
    const { service } = await makeService();
    await expect(
      service.getWebsiteMemorySummary("https://ghost.example.com"),
    ).rejects.toThrow(WebsiteMemoryNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Handling malformed memory safely
// ---------------------------------------------------------------------------

describe("7. malformed memory.json", () => {
  it("throws WebsiteMemoryCorruptError on truncated JSON", async () => {
    const { service, provider } = makeService();

    // Write deliberately truncated JSON (missing closing brace)
    await provider.upload({
      key: "websites/corrupt.example.com/memory.json",
      data: Buffer.from('{"canonicalDomain":"corrupt.example.com","_checksum":"bad"'),
      contentType: "application/json",
      checkDuplicate: false,
    });

    await expect(
      service.loadWebsiteMemory("corrupt.example.com"),
    ).rejects.toThrow(WebsiteMemoryCorruptError);
  });

  it("throws WebsiteMemoryCorruptError on checksum mismatch", async () => {
    const { service, provider } = makeService();

    // Create valid memory, then tamper with a field to break the checksum
    await service.createWebsiteMemory("tamper.example.com");
    const raw = await provider.download("websites/tamper.example.com/memory.json");
    const parsed = JSON.parse(raw!.toString("utf8"));
    parsed.canonicalDomain = "TAMPERED"; // checksum now invalid
    await provider.upload({
      key: "websites/tamper.example.com/memory.json",
      data: Buffer.from(JSON.stringify(parsed)),
      contentType: "application/json",
      checkDuplicate: false,
    });

    await expect(
      service.loadWebsiteMemory("tamper.example.com"),
    ).rejects.toThrow(WebsiteMemoryCorruptError);
  });
});

// ---------------------------------------------------------------------------
// Test 8: Preserving existing R2 artifacts
// ---------------------------------------------------------------------------

describe("8. preserving existing R2 artifacts", () => {
  it("does not touch job-scoped keys when creating website memory", async () => {
    const { service, provider } = makeService();

    // Simulate a pre-existing job-scoped artifact
    const existingKey = "job-set-abc123/manifest/manifest.json";
    await provider.upload({
      key: existingKey,
      data: Buffer.from(JSON.stringify({ pages: 42 })),
      contentType: "application/json",
      checkDuplicate: false,
    });

    // Create website memory — must not disturb the job artifact
    await service.createWebsiteMemory("https://preserve-test.com");

    // Existing job artifact must still be present and unchanged
    const still = await provider.download(existingKey);
    expect(still).not.toBeNull();
    const parsed = JSON.parse(still!.toString("utf8"));
    expect(parsed.pages).toBe(42);
  });

  it("getWebsiteMemorySummary returns correct module counts", async () => {
    const { service } = makeService();
    await service.createWebsiteMemory("summary-test.example.com");

    // Complete two stages
    await service.updateKnowledgeModule("summary-test.example.com", "crawl", { completed: true });
    await service.updateKnowledgeModule("summary-test.example.com", "manifest", { completed: true });

    const summary = await service.getWebsiteMemorySummary("summary-test.example.com");
    expect(summary.completedModules).toBe(2);
    expect(summary.totalModules).toBe(12);
    expect(summary.canonicalDomain).toBe("summary-test.example.com");
    expect(summary.currentPipelineState).toBe("idle");
  });
});
