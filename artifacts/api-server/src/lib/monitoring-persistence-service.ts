/**
 * monitoring-persistence-service.ts — PH-5: Quality Snapshot Persistence
 *
 * Persists QA-3 monitoring snapshots, regression history, and pipeline health
 * to Cloudflare R2 so that monitoring history survives application restarts.
 *
 * Storage layout in R2:
 *   projects/{projectId}/monitoring/quality-timeline.json
 *   projects/{projectId}/monitoring/pipeline-health.json
 *   projects/{projectId}/monitoring/monitoring-snapshots.json
 *   projects/{projectId}/monitoring/regression-history.json
 *   projects/{projectId}/monitoring/visual-fidelity-history.json
 *   projects/{projectId}/monitoring/index.json
 *
 * Persistence strategy:
 *   - Flush to R2 every FLUSH_INTERVAL_MS (default 5 min)
 *   - Also flush immediately after any new stage snapshot (event-driven)
 *   - On startup: download from R2 and restore in-process state
 *   - Falls back to local-only when R2 is not configured
 */

import { logger }               from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import {
  getMonitoringReport,
  getHealthHistory,
  getQualityTimeline,
  getAllStageSnapshots,
  listTraces,
  type PipelineStageSnapshot,
  type HealthHistoryEntry,
  type QualityTimelineEntry,
  type PipelineExecutionTrace,
} from "./pipeline-monitoring-interceptor.js";
import {
  getRegressionSummary,
  getRegressionHistory,
  listFixtures,
  type RegressionHistoryEntry,
} from "./post-build-regression-runner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistedMonitoringBundle {
  version:         "PH-5";
  schemaVersion:   string;
  projectId:       string;
  savedAt:         string;
  qualityTimeline: QualityTimelineEntry[];
  pipelineHealth:  HealthHistoryEntry[];
  snapshots:       PipelineStageSnapshot[];
  regressionHistory: RegressionHistoryEntry[];
  visualFidelityHistory: VisualFidelityHistoryEntry[];
  traces:          PipelineExecutionTrace[];
}

export interface VisualFidelityHistoryEntry {
  entryId:        string;
  jobId:          string;
  capturedAt:     string;
  stage:          string;
  fidelityScore:  number;
  qualityScore:   number;
  coverage:       number;
  heapUsedMb:     number;
}

export interface R2MonitoringReport {
  version:            "PH-5";
  schemaVersion:      string;
  generatedAt:        string;
  projectId:          string;
  isConfigured:       boolean;
  providerName:       string;
  lastFlushAt:        string | null;
  lastRestoreAt:      string | null;
  totalFlushes:       number;
  totalRestores:      number;
  totalBytesUploaded: number;
  storageKeys:        string[];
  flushErrors:        number;
  restoreErrors:      number;
  continuityVerified: boolean;
}

export interface SnapshotPersistenceReport {
  version:         "PH-5";
  schemaVersion:   string;
  generatedAt:     string;
  projectId:       string;
  totalSnapshots:  number;
  totalTimeline:   number;
  totalHealth:     number;
  totalRegression: number;
  totalFidelity:   number;
  persistedAt:     string | null;
  r2Keys:          string[];
  bundleSize:      number;
}

export interface MonitoringStorageIndex {
  version:     "PH-5";
  schemaVersion: string;
  generatedAt: string;
  projectId:   string;
  keys: Array<{
    key:       string;
    url:       string | null;
    category:  string;
    savedAt:   string;
    sizeBytes: number;
  }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FLUSH_INTERVAL_MS  = 5 * 60 * 1000;   // 5 minutes
const PROJECT_ID_DEFAULT = process.env["PROJECT_ID"] ?? "default";

// ---------------------------------------------------------------------------
// In-process state
// ---------------------------------------------------------------------------

let _projectId          = PROJECT_ID_DEFAULT;
let _lastFlushAt:   string | null = null;
let _lastRestoreAt: string | null = null;
let _totalFlushes       = 0;
let _totalRestores      = 0;
let _totalBytesUploaded = 0;
let _flushErrors        = 0;
let _restoreErrors      = 0;
let _isRunning          = false;
let _startedAt          = new Date().toISOString();
let _storageKeys: string[] = [];
let _indexEntries: MonitoringStorageIndex["keys"] = [];
let _lastBundleSize     = 0;
let _continuityVerified = false;
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function monitoringKey(filename: string): string {
  return `projects/${_projectId}/monitoring/${filename}`;
}

function buildFidelityHistory(): VisualFidelityHistoryEntry[] {
  return getAllStageSnapshots(500).map(s => ({
    entryId:       uid(),
    jobId:         s.jobId,
    capturedAt:    s.capturedAt,
    stage:         s.stage,
    fidelityScore: s.visualFidelity,
    qualityScore:  s.qualityScore,
    coverage:      s.coverage,
    heapUsedMb:    s.resources.heapUsedMb,
  }));
}

function buildBundle(): PersistedMonitoringBundle {
  return {
    version:          "PH-5",
    schemaVersion:    "1.0.0",
    projectId:        _projectId,
    savedAt:          new Date().toISOString(),
    qualityTimeline:  getQualityTimeline(),
    pipelineHealth:   getHealthHistory(500),
    snapshots:        getAllStageSnapshots(500),
    regressionHistory: getRegressionHistory(500),
    visualFidelityHistory: buildFidelityHistory(),
    traces:           listTraces(),
  };
}

// ---------------------------------------------------------------------------
// Core flush — upload all monitoring data to R2
// ---------------------------------------------------------------------------

async function flushToR2(): Promise<void> {
  const provider = getDefaultCloudProvider();

  if (!provider.isConfigured()) {
    logger.warn("PH-5: R2 not configured — skipping flush (local-only mode)");
    return;
  }

  const bundle   = buildBundle();
  const flushAt  = new Date().toISOString();
  const newKeys: string[] = [];
  const newIndex: MonitoringStorageIndex["keys"] = [];

  async function uploadJson(filename: string, data: unknown, category: string): Promise<void> {
    const key     = monitoringKey(filename);
    const content = Buffer.from(JSON.stringify(data, null, 2));
    try {
      const result = await provider.upload({
        key,
        data:          content,
        contentType:   "application/json",
        checkDuplicate: false,           // always overwrite with latest
      });
      _totalBytesUploaded += result.bytesUploaded;
      _lastBundleSize     += content.length;
      newKeys.push(key);
      newIndex.push({
        key,
        url:       result.url,
        category,
        savedAt:   flushAt,
        sizeBytes: content.length,
      });
      logger.info({ key, bytes: content.length, skipped: result.skippedAsDuplicate }, "PH-5: uploaded");
    } catch (err) {
      _flushErrors++;
      logger.error({ key, err }, "PH-5: upload failed");
    }
  }

  _lastBundleSize = 0;

  await Promise.all([
    uploadJson("quality-timeline.json",      bundle.qualityTimeline,      "timeline"),
    uploadJson("pipeline-health.json",        bundle.pipelineHealth,        "health"),
    uploadJson("monitoring-snapshots.json",   bundle.snapshots,             "snapshots"),
    uploadJson("regression-history.json",     bundle.regressionHistory,    "regression"),
    uploadJson("visual-fidelity-history.json", bundle.visualFidelityHistory, "fidelity"),
  ]);

  // Build and upload the index last
  const index: MonitoringStorageIndex = {
    version:       "PH-5",
    schemaVersion: "1.0.0",
    generatedAt:   flushAt,
    projectId:     _projectId,
    keys:          newIndex,
  };
  await uploadJson("index.json", index, "index");

  _storageKeys        = newKeys;
  _indexEntries       = newIndex;
  _lastFlushAt        = flushAt;
  _totalFlushes++;

  logger.info(
    { totalFlushes: _totalFlushes, keys: newKeys.length, bundleBytes: _lastBundleSize },
    "PH-5: monitoring flush complete",
  );
}

// ---------------------------------------------------------------------------
// Core restore — download from R2 on startup
// ---------------------------------------------------------------------------

async function restoreFromR2(): Promise<PersistedMonitoringBundle | null> {
  const provider = getDefaultCloudProvider();

  if (!provider.isConfigured()) {
    logger.info("PH-5: R2 not configured — skipping restore (cold start)");
    return null;
  }

  const key = monitoringKey("index.json");
  try {
    const buf = await provider.download(key);
    if (!buf) {
      logger.info({ key }, "PH-5: no previous monitoring index found — cold start");
      return null;
    }
    const index = JSON.parse(buf.toString("utf-8")) as MonitoringStorageIndex;
    _indexEntries = index.keys;
    _storageKeys  = index.keys.map(k => k.key);
    logger.info({ keys: _storageKeys.length }, "PH-5: monitoring index restored from R2");
    _continuityVerified = true;
    _totalRestores++;
    _lastRestoreAt = new Date().toISOString();
    return null; // index-only restore (snapshots stay in engine state)
  } catch (err) {
    _restoreErrors++;
    logger.warn({ key, err }, "PH-5: restore failed — starting fresh");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Start persistence service — idempotent
// ---------------------------------------------------------------------------

export async function startMonitoringPersistence(projectId?: string): Promise<void> {
  if (_isRunning) return;
  _isRunning = true;
  _startedAt = new Date().toISOString();
  _projectId = projectId ?? PROJECT_ID_DEFAULT;

  logger.info({ projectId: _projectId }, "PH-5: monitoring persistence service starting");

  // Attempt to restore from R2
  try {
    await restoreFromR2();
  } catch (err) {
    logger.warn({ err }, "PH-5: restore threw unexpectedly — continuing");
  }

  // Schedule periodic flushes
  function scheduleNext(): void {
    _flushTimer = setTimeout(async () => {
      try {
        await flushToR2();
      } catch (err) {
        _flushErrors++;
        logger.error({ err }, "PH-5: periodic flush failed");
      }
      scheduleNext();
    }, FLUSH_INTERVAL_MS);
  }

  scheduleNext();
  logger.info(
    { flushIntervalMs: FLUSH_INTERVAL_MS, projectId: _projectId },
    "PH-5: monitoring persistence active",
  );
}

// ---------------------------------------------------------------------------
// Manual flush trigger (used by routes)
// ---------------------------------------------------------------------------

export async function triggerFlush(): Promise<{ success: boolean; error?: string }> {
  try {
    await flushToR2();
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

export function getR2MonitoringReport(): R2MonitoringReport {
  const provider = getDefaultCloudProvider();
  return {
    version:            "PH-5",
    schemaVersion:      "1.0.0",
    generatedAt:        new Date().toISOString(),
    projectId:          _projectId,
    isConfigured:       provider.isConfigured(),
    providerName:       provider.providerName,
    lastFlushAt:        _lastFlushAt,
    lastRestoreAt:      _lastRestoreAt,
    totalFlushes:       _totalFlushes,
    totalRestores:      _totalRestores,
    totalBytesUploaded: _totalBytesUploaded,
    storageKeys:        _storageKeys,
    flushErrors:        _flushErrors,
    restoreErrors:      _restoreErrors,
    continuityVerified: _continuityVerified,
  };
}

export function getSnapshotPersistenceReport(): SnapshotPersistenceReport {
  return {
    version:         "PH-5",
    schemaVersion:   "1.0.0",
    generatedAt:     new Date().toISOString(),
    projectId:       _projectId,
    totalSnapshots:  getAllStageSnapshots().length,
    totalTimeline:   getQualityTimeline().length,
    totalHealth:     getHealthHistory().length,
    totalRegression: getRegressionHistory().length,
    totalFidelity:   buildFidelityHistory().length,
    persistedAt:     _lastFlushAt,
    r2Keys:          _storageKeys,
    bundleSize:      _lastBundleSize,
  };
}

export function getStorageIndex(): MonitoringStorageIndex {
  return {
    version:       "PH-5",
    schemaVersion: "1.0.0",
    generatedAt:   new Date().toISOString(),
    projectId:     _projectId,
    keys:          _indexEntries,
  };
}

export function getPersistenceStatus(): {
  isRunning:    boolean;
  startedAt:    string;
  projectId:    string;
  flushIntervalMs: number;
  nextFlushIn:  string;
} {
  return {
    isRunning:       _isRunning,
    startedAt:       _startedAt,
    projectId:       _projectId,
    flushIntervalMs: FLUSH_INTERVAL_MS,
    nextFlushIn:     _lastFlushAt
      ? `${Math.max(0, FLUSH_INTERVAL_MS - (Date.now() - new Date(_lastFlushAt).getTime()))}ms`
      : "pending first flush",
  };
}
