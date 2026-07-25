/**
 * website-memory.ts — Phase D3.5 Website Memory Engine
 *
 * Answers the question: "Does the system already know this website?"
 *
 * Before any crawl begins, the system checks R2 for a domain-scoped memory
 * record. If one exists, the crawler loads its prior knowledge and continues
 * from there rather than starting from zero.
 *
 * Storage layout (R2):
 *   website-memory/{domain}/latest.json   — current memory record
 *   website-memory/{domain}/history.json  — append-only history of all jobs
 *
 * A memory record captures:
 *   - Which orchestration job last ran against this domain
 *   - Which stages completed
 *   - The underlying scrape job ID (so its checkpoint can be loaded)
 *   - Pipeline status at the time of recording
 */

import { logger } from "./logger.js";
import type { CloudProvider } from "../cloud/provider.js";
import type { OrchestrationJob } from "./master-orchestrator.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebsiteMemoryRecord {
  schemaVersion: "1.0.0";
  domain:         string;
  url:            string;            // canonical seed URL
  jobId:          string;            // orchestration job ID
  scrapeJobId:    string | null;     // underlying scrape/crawl job
  completedStages: string[];
  skippedStages:  string[];
  pipelineStatus: "running" | "complete" | "failed" | "interrupted";
  coveragePct:    number | null;
  totalDurationMs: number | null;
  savedAt:        string;
}

export interface WebsiteMemoryHistory {
  domain: string;
  entries: Array<{
    jobId:          string;
    pipelineStatus: string;
    completedStages: string[];
    savedAt:        string;
  }>;
}

// ---------------------------------------------------------------------------
// Domain normalisation
// ---------------------------------------------------------------------------

export function normalizeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url.toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? url;
  }
}

// ---------------------------------------------------------------------------
// R2 keys
// ---------------------------------------------------------------------------

function memoryKey(domain: string): string {
  return `website-memory/${domain}/latest.json`;
}

function historyKey(domain: string): string {
  return `website-memory/${domain}/history.json`;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Look up existing website memory for a given URL.
 * Returns null if R2 is not configured or no prior crawl exists.
 */
export async function lookupWebsiteMemory(
  url: string,
  cloud: CloudProvider
): Promise<WebsiteMemoryRecord | null> {
  if (!cloud.isConfigured()) return null;

  const domain = normalizeDomain(url);
  const key    = memoryKey(domain);

  try {
    const data = await cloud.download(key);
    if (!data) return null;
    const record = JSON.parse(data.toString("utf8")) as WebsiteMemoryRecord;
    logger.info(
      { domain, jobId: record.jobId, completedStages: record.completedStages.length, pipelineStatus: record.pipelineStatus },
      "WEBSITE-MEMORY: prior crawl found"
    );
    return record;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Update (called after each pipeline stage or on completion)
// ---------------------------------------------------------------------------

/**
 * Write (or overwrite) the domain memory record after a pipeline run.
 * Call this after job completion or after significant stage progress.
 */
export async function updateWebsiteMemory(
  job: OrchestrationJob,
  cloud: CloudProvider
): Promise<void> {
  if (!cloud.isConfigured()) return;

  const domain = normalizeDomain(job.url);

  const status: WebsiteMemoryRecord["pipelineStatus"] =
    job.status === "complete" ? "complete" :
    job.status === "failed"   ? "failed"   :
    job.status === "running"  ? "running"  :
    "interrupted";

  const record: WebsiteMemoryRecord = {
    schemaVersion:   "1.0.0",
    domain,
    url:             job.url,
    jobId:           job.id,
    scrapeJobId:     job.underlyingJobId,
    completedStages: job.completedStages,
    skippedStages:   job.skippedStages,
    pipelineStatus:  status,
    coveragePct:     null,
    totalDurationMs: job.totalDurationMs,
    savedAt:         new Date().toISOString(),
  };

  try {
    // Write latest record
    await cloud.upload({
      key:           memoryKey(domain),
      data:          Buffer.from(JSON.stringify(record, null, 2), "utf8"),
      contentType:   "application/json",
      checkDuplicate: false,
    });

    // Append to history (best-effort)
    void appendToHistory(domain, record, cloud).catch(() => {});

    logger.info(
      { domain, jobId: job.id, status, completedStages: job.completedStages.length },
      "WEBSITE-MEMORY: memory updated"
    );
  } catch (err) {
    logger.warn({ err, domain, jobId: job.id }, "WEBSITE-MEMORY: update failed (non-fatal)");
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete the domain memory record.
 * This forces the next crawl to start fresh.
 */
export async function deleteWebsiteMemory(
  domain: string,
  cloud: CloudProvider
): Promise<{ deleted: boolean; domain: string }> {
  if (!cloud.isConfigured()) {
    return { deleted: false, domain };
  }

  try {
    await Promise.allSettled([
      cloud.delete(memoryKey(domain)),
      cloud.delete(historyKey(domain)),
    ]);
    logger.info({ domain }, "WEBSITE-MEMORY: memory deleted");
    return { deleted: true, domain };
  } catch (err) {
    logger.warn({ err, domain }, "WEBSITE-MEMORY: delete failed");
    return { deleted: false, domain };
  }
}

// ---------------------------------------------------------------------------
// Internal: history append
// ---------------------------------------------------------------------------

async function appendToHistory(
  domain: string,
  record: WebsiteMemoryRecord,
  cloud: CloudProvider
): Promise<void> {
  let history: WebsiteMemoryHistory = { domain, entries: [] };

  try {
    const existing = await cloud.download(historyKey(domain));
    if (existing) {
      history = JSON.parse(existing.toString("utf8")) as WebsiteMemoryHistory;
    }
  } catch {
    // no history yet
  }

  history.entries.unshift({
    jobId:           record.jobId,
    pipelineStatus:  record.pipelineStatus,
    completedStages: record.completedStages,
    savedAt:         record.savedAt,
  });

  // Keep last 20 entries
  history.entries = history.entries.slice(0, 20);

  await cloud.upload({
    key:           historyKey(domain),
    data:          Buffer.from(JSON.stringify(history, null, 2), "utf8"),
    contentType:   "application/json",
    checkDuplicate: false,
  });
}
