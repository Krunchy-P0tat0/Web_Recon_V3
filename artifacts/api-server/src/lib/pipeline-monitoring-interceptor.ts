/**
 * pipeline-monitoring-interceptor.ts — PH-2: QA-3 Pipeline Monitoring Integration
 *
 * Subscribes to the pipeline event bus and automatically captures quality
 * snapshots + system resource metrics after each of the 8 named pipeline stages:
 *
 *   crawl-complete            → SCRAPE
 *   manifest-generated        → MANIFEST
 *   diff-computed             → DIFFERENTIAL_INTELLIGENCE
 *   visual-dna-complete       → VISUAL_DNA
 *   intelligence-complete     → VISUAL_RECONSTRUCTION
 *   website-prime-complete    → WEBSITE_PRIME
 *   merge-complete            → BACKEND_MERGE
 *   deployment-complete       → DEPLOYMENT
 *
 * Monitoring starts automatically when this module is imported (side-effect).
 * All state is in-process. Disk persistence is non-blocking.
 */

import { cpus, freemem, totalmem } from "os";
import { writeFile, mkdir }         from "fs/promises";
import { join }                     from "path";
import { logger }                   from "./logger.js";
import { eventBus, type PipelineEvent } from "./event-bus.js";
import { recordSnapshot, type QualitySnapshot } from "./quality-monitoring-engine.js";

// ---------------------------------------------------------------------------
// Stage mapping — event type → canonical pipeline stage label
// ---------------------------------------------------------------------------

const EVENT_TO_STAGE: Partial<Record<string, PipelineStageLabel>> = {
  "crawl-complete":         "SCRAPE",
  "manifest-generated":     "MANIFEST",
  "diff-computed":          "DIFFERENTIAL_INTELLIGENCE",
  "visual-dna-complete":    "VISUAL_DNA",
  "intelligence-complete":  "VISUAL_RECONSTRUCTION",
  "website-prime-complete": "WEBSITE_PRIME",
  "merge-complete":         "BACKEND_MERGE",
  "deployment-complete":    "DEPLOYMENT",
};

export type PipelineStageLabel =
  | "SCRAPE"
  | "MANIFEST"
  | "DIFFERENTIAL_INTELLIGENCE"
  | "VISUAL_DNA"
  | "VISUAL_RECONSTRUCTION"
  | "WEBSITE_PRIME"
  | "BACKEND_MERGE"
  | "DEPLOYMENT";

// ---------------------------------------------------------------------------
// Stage monitoring snapshot — richer than QualitySnapshot
// ---------------------------------------------------------------------------

export interface StageResourceUsage {
  heapUsedMb:  number;
  heapTotalMb: number;
  rssMb:       number;
  cpuUserMs:   number;
  cpuSysMs:    number;
  freeMemMb:   number;
  totalMemMb:  number;
  cpuCount:    number;
}

export interface PipelineStageSnapshot {
  snapshotId:    string;
  jobId:         string;
  stage:         PipelineStageLabel;
  capturedAt:    string;
  durationMs:    number | null;
  resources:     StageResourceUsage;
  qualitySnapshot: QualitySnapshot;
  warnings:      string[];
  errors:        string[];
  qualityScore:  number;
  coverage:      number;
  visualFidelity: number;
}

export interface PipelineExecutionTrace {
  traceId:       string;
  jobId:         string;
  startedAt:     string;
  lastUpdatedAt: string;
  stages:        PipelineStageSnapshot[];
  isComplete:    boolean;
}

// ---------------------------------------------------------------------------
// In-process state
// ---------------------------------------------------------------------------

/** jobId → execution trace */
const _traces = new Map<string, PipelineExecutionTrace>();

/** All stage snapshots across all jobs (newest first, capped at 500) */
const _allSnapshots: PipelineStageSnapshot[] = [];

/** Track when each job's stage last fired (for duration calculation) */
const _stageTimes = new Map<string, Map<PipelineStageLabel, number>>();

/** CPU times sampled at stage start (approximated per-job) */
const _cpuStart = new Map<string, NodeJS.CpuUsage>();

let _totalSnapshotsRecorded = 0;
let _interceptorStartedAt   = new Date().toISOString();
let _isListening            = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function captureResources(cpuStart?: NodeJS.CpuUsage): StageResourceUsage {
  const mem  = process.memoryUsage();
  const cpu  = process.cpuUsage(cpuStart);
  const free = freemem();
  const total = totalmem();

  return {
    heapUsedMb:  Math.round((mem.heapUsed  / 1024 / 1024) * 10) / 10,
    heapTotalMb: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
    rssMb:       Math.round((mem.rss       / 1024 / 1024) * 10) / 10,
    cpuUserMs:   Math.round(cpu.user   / 1000),
    cpuSysMs:    Math.round(cpu.system / 1000),
    freeMemMb:   Math.round((free  / 1024 / 1024) * 10) / 10,
    totalMemMb:  Math.round((total / 1024 / 1024) * 10) / 10,
    cpuCount:    cpus().length,
  };
}

function getOrCreateTrace(jobId: string): PipelineExecutionTrace {
  if (!_traces.has(jobId)) {
    const trace: PipelineExecutionTrace = {
      traceId:       `trace-${uid()}`,
      jobId,
      startedAt:     new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      stages:        [],
      isComplete:    false,
    };
    _traces.set(jobId, trace);
    logger.info({ jobId, traceId: trace.traceId }, "PH-2: new execution trace started");
  }
  return _traces.get(jobId)!;
}

function stageWarnings(event: PipelineEvent, stage: PipelineStageLabel): string[] {
  const data = event.data ?? {};
  const w: string[] = [];
  if ((data["warnings"] as string[] | undefined)?.length) {
    w.push(...(data["warnings"] as string[]));
  }
  if (stage === "DEPLOYMENT" && data["rollbackRequired"]) {
    w.push("Deployment flagged for potential rollback");
  }
  return w;
}

function stageErrors(event: PipelineEvent): string[] {
  const data = event.data ?? {};
  const errs: string[] = [];
  if ((data["errors"] as string[] | undefined)?.length) {
    errs.push(...(data["errors"] as string[]));
  }
  if (data["errorMessage"]) errs.push(String(data["errorMessage"]));
  return errs;
}

function computeQualityScore(snap: QualitySnapshot, stage: PipelineStageLabel): number {
  const weights: Record<PipelineStageLabel, Partial<Record<keyof QualitySnapshot, number>>> = {
    SCRAPE:                    { coveragePct: 0.5, assetSuccessRate: 0.5 },
    MANIFEST:                  { coveragePct: 0.7, assetSuccessRate: 0.3 },
    DIFFERENTIAL_INTELLIGENCE: { fidelityScore: 0.6, adjustmentEffPct: 0.4 },
    VISUAL_DNA:                { fidelityScore: 0.8, assetSuccessRate: 0.2 },
    VISUAL_RECONSTRUCTION:     { fidelityScore: 0.7, adjustmentEffPct: 0.3 },
    WEBSITE_PRIME:             { fidelityScore: 0.6, coveragePct: 0.3, assetSuccessRate: 0.1 },
    BACKEND_MERGE:             { coveragePct: 0.5, assetSuccessRate: 0.5 },
    DEPLOYMENT:                { coveragePct: 0.4, assetSuccessRate: 0.4, adjustmentEffPct: 0.2 },
  };
  const w = weights[stage] ?? { fidelityScore: 1 };
  let score = 0;
  for (const [key, weight] of Object.entries(w)) {
    const val = snap[key as keyof QualitySnapshot] as number;
    if (typeof val === "number") score += val * weight;
  }
  return Math.round(Math.min(100, Math.max(0, score)) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Core interceptor — fires on every mapped event
// ---------------------------------------------------------------------------

function handlePipelineEvent(event: PipelineEvent): void {
  const stage = EVENT_TO_STAGE[event.type];
  if (!stage) return;

  const jobId  = event.pipelineJobId ?? `anonymous-${uid()}`;
  const stageKey  = `${jobId}:${stage}`;

  const cpuStart   = _cpuStart.get(stageKey) ?? process.cpuUsage();
  const stageStart = _stageTimes.get(jobId)?.get(stage);
  const durationMs = stageStart != null ? Date.now() - stageStart : null;

  const resources      = captureResources(cpuStart);
  const qualitySnapshot = recordSnapshot(jobId, "pipeline");
  const warnings       = stageWarnings(event, stage);
  const errors         = stageErrors(event);
  const qualityScore   = computeQualityScore(qualitySnapshot, stage);

  const stageSnap: PipelineStageSnapshot = {
    snapshotId:      uid(),
    jobId,
    stage,
    capturedAt:      new Date().toISOString(),
    durationMs,
    resources,
    qualitySnapshot,
    warnings,
    errors,
    qualityScore,
    coverage:        qualitySnapshot.coveragePct,
    visualFidelity:  qualitySnapshot.fidelityScore,
  };

  const trace = getOrCreateTrace(jobId);
  trace.stages.push(stageSnap);
  trace.lastUpdatedAt = stageSnap.capturedAt;

  if (stage === "DEPLOYMENT") {
    trace.isComplete = true;
    logger.info({ jobId, stages: trace.stages.length }, "PH-2: execution trace complete");
  }

  _allSnapshots.unshift(stageSnap);
  if (_allSnapshots.length > 500) _allSnapshots.length = 500;
  _totalSnapshotsRecorded++;

  logger.info(
    { jobId, stage, qualityScore, durationMs, heapMb: resources.heapUsedMb },
    "PH-2: stage snapshot captured",
  );

  // Non-blocking persistence
  void persistAll().catch(() => {});
}

// ---------------------------------------------------------------------------
// Start listening — idempotent, call once at server boot
// ---------------------------------------------------------------------------

export function startPipelineMonitoring(): void {
  if (_isListening) return;
  _isListening = true;
  _interceptorStartedAt = new Date().toISOString();

  eventBus.on("event", handlePipelineEvent);

  logger.info(
    { stages: Object.keys(EVENT_TO_STAGE) },
    "PH-2: pipeline monitoring interceptor active",
  );
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

export function getTrace(jobId: string): PipelineExecutionTrace | undefined {
  return _traces.get(jobId);
}

export function listTraces(): PipelineExecutionTrace[] {
  return Array.from(_traces.values())
    .sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt));
}

export function getAllStageSnapshots(limit = 200): PipelineStageSnapshot[] {
  return _allSnapshots.slice(0, limit);
}

export function getSnapshotsForJob(jobId: string): PipelineStageSnapshot[] {
  return _allSnapshots.filter(s => s.jobId === jobId);
}

export function getMonitoringReport(): PipelineMonitoringReport {
  const traces      = listTraces();
  const complete    = traces.filter(t => t.isComplete);
  const allStages   = _allSnapshots;
  const byStage: Record<string, { count: number; avgQuality: number; avgDurationMs: number }> = {};

  for (const snap of allStages) {
    if (!byStage[snap.stage]) byStage[snap.stage] = { count: 0, avgQuality: 0, avgDurationMs: 0 };
    const b = byStage[snap.stage]!;
    b.count++;
    b.avgQuality    = (b.avgQuality    * (b.count - 1) + snap.qualityScore)  / b.count;
    b.avgDurationMs = (b.avgDurationMs * (b.count - 1) + (snap.durationMs ?? 0)) / b.count;
  }

  const fidelities = allStages.map(s => s.visualFidelity).filter(Boolean);
  const avgFidelity = fidelities.length
    ? fidelities.reduce((a, b) => a + b, 0) / fidelities.length
    : 0;

  return {
    version:                  "PH-2",
    schemaVersion:            "1.0.0",
    generatedAt:              new Date().toISOString(),
    interceptorStartedAt:     _interceptorStartedAt,
    isListening:              _isListening,
    totalExecutionTraces:     traces.length,
    completeTraces:           complete.length,
    totalStageSnapshotsRecorded: _totalSnapshotsRecorded,
    averageVisualFidelity:    Math.round(avgFidelity * 10) / 10,
    stageBreakdown:           byStage,
    monitoredStages:          Object.values(EVENT_TO_STAGE).filter(Boolean) as PipelineStageLabel[],
    recentSnapshots:          allStages.slice(0, 10),
    recentTraces:             traces.slice(0, 5),
  };
}

export interface PipelineMonitoringReport {
  version:                  "PH-2";
  schemaVersion:            string;
  generatedAt:              string;
  interceptorStartedAt:     string;
  isListening:              boolean;
  totalExecutionTraces:     number;
  completeTraces:           number;
  totalStageSnapshotsRecorded: number;
  averageVisualFidelity:    number;
  stageBreakdown:           Record<string, { count: number; avgQuality: number; avgDurationMs: number }>;
  monitoredStages:          PipelineStageLabel[];
  recentSnapshots:          PipelineStageSnapshot[];
  recentTraces:             PipelineExecutionTrace[];
}

export function getHealthHistory(limit = 50): HealthHistoryEntry[] {
  return _allSnapshots.slice(0, limit).map(s => ({
    entryId:       s.snapshotId,
    jobId:         s.jobId,
    stage:         s.stage,
    capturedAt:    s.capturedAt,
    qualityScore:  s.qualityScore,
    fidelity:      s.visualFidelity,
    coverage:      s.coverage,
    heapUsedMb:    s.resources.heapUsedMb,
    durationMs:    s.durationMs,
    hasErrors:     s.errors.length > 0,
    hasWarnings:   s.warnings.length > 0,
  }));
}

export interface HealthHistoryEntry {
  entryId:      string;
  jobId:        string;
  stage:        PipelineStageLabel;
  capturedAt:   string;
  qualityScore: number;
  fidelity:     number;
  coverage:     number;
  heapUsedMb:   number;
  durationMs:   number | null;
  hasErrors:    boolean;
  hasWarnings:  boolean;
}

export function getQualityTimeline(jobId?: string): QualityTimelineEntry[] {
  const snaps = jobId ? _allSnapshots.filter(s => s.jobId === jobId) : _allSnapshots;
  return snaps.slice(0, 200).map(s => ({
    snapshotId:    s.snapshotId,
    jobId:         s.jobId,
    stage:         s.stage,
    capturedAt:    s.capturedAt,
    qualityScore:  s.qualityScore,
    visualFidelity: s.visualFidelity,
    coverage:       s.coverage,
    heapUsedMb:     s.resources.heapUsedMb,
    cpuUserMs:      s.resources.cpuUserMs,
    durationMs:     s.durationMs,
    warnings:       s.warnings.length,
    errors:         s.errors.length,
  }));
}

export interface QualityTimelineEntry {
  snapshotId:     string;
  jobId:          string;
  stage:          PipelineStageLabel;
  capturedAt:     string;
  qualityScore:   number;
  visualFidelity: number;
  coverage:       number;
  heapUsedMb:     number;
  cpuUserMs:      number;
  durationMs:     number | null;
  warnings:       number;
  errors:         number;
}

// ---------------------------------------------------------------------------
// Disk persistence — writes 3 JSON files non-blocking
// ---------------------------------------------------------------------------

const ROOT = join(process.cwd(), "..", "..");

async function persistAll(): Promise<void> {
  const outDir = join(ROOT);
  await mkdir(outDir, { recursive: true });

  await Promise.all([
    writeFile(
      join(outDir, "pipeline-monitoring-report.json"),
      JSON.stringify(getMonitoringReport(), null, 2),
    ),
    writeFile(
      join(outDir, "pipeline-health-history.json"),
      JSON.stringify(
        {
          version:     "PH-2",
          generatedAt: new Date().toISOString(),
          total:       _allSnapshots.length,
          history:     getHealthHistory(200),
        },
        null, 2,
      ),
    ),
    writeFile(
      join(outDir, "quality-timeline.json"),
      JSON.stringify(
        {
          version:     "PH-2",
          generatedAt: new Date().toISOString(),
          total:       _allSnapshots.length,
          timeline:    getQualityTimeline(),
        },
        null, 2,
      ),
    ),
  ]);
}
