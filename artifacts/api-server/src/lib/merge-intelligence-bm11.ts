/**
 * merge-intelligence-bm11.ts — Phase BM-11: Merge Intelligence Layer
 *
 * Learns from every merge execution. Records outcomes, detects conflict
 * patterns, computes success/rollback rates, and surfaces actionable
 * recommendations so future merges become progressively safer.
 *
 * Persistence: in-memory store + R2 upload (merge-intelligence.json)
 */

import { writeFile, readFile } from "fs/promises";
import { existsSync }          from "fs";
import { join }                from "path";
import { logger }              from "./logger.js";
import type { CloudProvider }  from "../cloud/provider.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MergeOutcome = "success" | "failure" | "rollback" | "partial";

export interface ConflictRecord {
  dimension: string;
  path:      string;
  kind:      string;
  count:     number;
}

export interface MergeRecord {
  recordId:    string;
  jobId:       string;
  recordedAt:  string;
  outcome:     MergeOutcome;
  durationMs:  number;
  decisions:   number;
  conflicts:   number;
  fileChanges: number;
  dryRun:      boolean;
  conflictDetails: ConflictRecord[];
  notes?:      string;
}

export interface ConflictPattern {
  dimension:    string;
  path:         string;
  kind:         string;
  occurrences:  number;
  lastSeen:     string;
  affectedJobs: string[];
}

export interface DimensionStats {
  dimension:    string;
  totalConflicts: number;
  avgConflictsPerMerge: number;
  commonPaths:  string[];
}

export interface MergeIntelligenceReport {
  generatedAt:       string;
  version:           string;
  totalMerges:       number;
  successCount:      number;
  failureCount:      number;
  rollbackCount:     number;
  partialCount:      number;
  successRate:       number;
  rollbackRate:      number;
  failureRate:       number;
  avgDurationMs:     number;
  avgConflicts:      number;
  avgFileChanges:    number;
  conflictPatterns:  ConflictPattern[];
  dimensionStats:    DimensionStats[];
  recentRecords:     MergeRecord[];
  recommendations:   string[];
  riskLevel:         "low" | "medium" | "high" | "critical";
  safeToAutoMerge:   boolean;
}

// ── In-memory store ───────────────────────────────────────────────────────────

const LOCAL_PATH = join(process.cwd(), "merge-intelligence.json");

let records: MergeRecord[] = [];
let loaded  = false;

function genId(): string {
  return `MRG-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

// ── Persistence helpers ───────────────────────────────────────────────────────

async function loadFromDisk(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    if (existsSync(LOCAL_PATH)) {
      const raw  = await readFile(LOCAL_PATH, "utf8");
      const data = JSON.parse(raw) as { records?: MergeRecord[] };
      if (Array.isArray(data.records)) records = data.records;
    }
  } catch {
    /* start fresh */
  }
}

async function persistToDisk(report: MergeIntelligenceReport): Promise<void> {
  const payload = JSON.stringify({ records, report }, null, 2);
  await writeFile(LOCAL_PATH, payload, "utf8").catch(() => {/* non-fatal */});
}

async function persistToR2(cloud: CloudProvider, report: MergeIntelligenceReport): Promise<void> {
  if (!cloud.isConfigured()) return;
  await cloud.upload({
    key:            "intelligence/merge-intelligence.json",
    data:           Buffer.from(JSON.stringify({ records, report }, null, 2), "utf8"),
    contentType:    "application/json",
    checkDuplicate: false,
  }).catch(err => logger.warn({ err }, "BM11: R2 upload failed (non-fatal)"));
}

// ── Record a merge outcome ────────────────────────────────────────────────────

export interface RecordMergeInput {
  jobId:           string;
  outcome:         MergeOutcome;
  durationMs:      number;
  decisions:       number;
  conflicts:       number;
  fileChanges:     number;
  dryRun:          boolean;
  conflictDetails?: ConflictRecord[];
  notes?:          string;
}

export async function recordMerge(
  input: RecordMergeInput,
  cloud: CloudProvider,
): Promise<MergeRecord> {
  await loadFromDisk();

  const record: MergeRecord = {
    recordId:        genId(),
    jobId:           input.jobId,
    recordedAt:      new Date().toISOString(),
    outcome:         input.outcome,
    durationMs:      input.durationMs,
    decisions:       input.decisions,
    conflicts:       input.conflicts,
    fileChanges:     input.fileChanges,
    dryRun:          input.dryRun,
    conflictDetails: input.conflictDetails ?? [],
    notes:           input.notes,
  };

  records.push(record);
  // Keep last 500 records
  if (records.length > 500) records = records.slice(-500);

  logger.info({ recordId: record.recordId, outcome: record.outcome, jobId: record.jobId }, "BM11: merge outcome recorded");

  const report = computeReport();
  await persistToDisk(report);
  await persistToR2(cloud, report);

  return record;
}

// ── Compute intelligence report ───────────────────────────────────────────────

function computeConflictPatterns(recs: MergeRecord[]): ConflictPattern[] {
  const patternMap = new Map<string, ConflictPattern>();

  for (const rec of recs) {
    for (const cd of rec.conflictDetails) {
      const key = `${cd.dimension}::${cd.path}::${cd.kind}`;
      const existing = patternMap.get(key);
      if (existing) {
        existing.occurrences++;
        existing.lastSeen = rec.recordedAt > existing.lastSeen ? rec.recordedAt : existing.lastSeen;
        if (!existing.affectedJobs.includes(rec.jobId)) existing.affectedJobs.push(rec.jobId);
      } else {
        patternMap.set(key, {
          dimension:    cd.dimension,
          path:         cd.path,
          kind:         cd.kind,
          occurrences:  1,
          lastSeen:     rec.recordedAt,
          affectedJobs: [rec.jobId],
        });
      }
    }
  }

  return [...patternMap.values()].sort((a, b) => b.occurrences - a.occurrences).slice(0, 50);
}

function computeDimensionStats(recs: MergeRecord[]): DimensionStats[] {
  const dimMap = new Map<string, { total: number; paths: Map<string, number>; mergeCount: number }>();

  for (const rec of recs) {
    for (const cd of rec.conflictDetails) {
      let d = dimMap.get(cd.dimension);
      if (!d) { d = { total: 0, paths: new Map(), mergeCount: 0 }; dimMap.set(cd.dimension, d); }
      d.total++;
      d.mergeCount++;
      d.paths.set(cd.path, (d.paths.get(cd.path) ?? 0) + 1);
    }
  }

  return [...dimMap.entries()].map(([dim, stats]) => ({
    dimension:   dim,
    totalConflicts: stats.total,
    avgConflictsPerMerge: stats.mergeCount > 0 ? +(stats.total / stats.mergeCount).toFixed(2) : 0,
    commonPaths: [...stats.paths.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([p]) => p),
  }));
}

function computeRiskLevel(successRate: number, rollbackRate: number, avgConflicts: number): MergeIntelligenceReport["riskLevel"] {
  if (successRate >= 0.85 && rollbackRate <= 0.05 && avgConflicts <= 2) return "low";
  if (successRate >= 0.70 && rollbackRate <= 0.15 && avgConflicts <= 5) return "medium";
  if (successRate >= 0.50 && rollbackRate <= 0.30)                       return "high";
  return "critical";
}

function buildRecommendations(
  successRate:     number,
  rollbackRate:    number,
  avgConflicts:    number,
  patterns:        ConflictPattern[],
  dimensionStats:  DimensionStats[],
  totalMerges:     number,
): string[] {
  const recs: string[] = [];

  if (totalMerges < 5) {
    recs.push("Not enough merge history yet — run more merges to build meaningful intelligence.");
  }
  if (successRate < 0.7) {
    recs.push(`Success rate is ${(successRate * 100).toFixed(0)}% — investigate common failure causes before automating.`);
  }
  if (rollbackRate > 0.2) {
    recs.push(`High rollback rate (${(rollbackRate * 100).toFixed(0)}%) — consider stricter pre-merge simulation gates.`);
  }
  if (avgConflicts > 5) {
    recs.push(`Average of ${avgConflicts.toFixed(1)} conflicts per merge — route deduplication may reduce friction.`);
  }
  if (patterns.length > 0) {
    const top = patterns[0];
    recs.push(`Most frequent conflict: "${top.path}" (${top.dimension}, ${top.occurrences}×) — consider adding a merge rule for it.`);
  }
  const worstDim = dimensionStats.sort((a, b) => b.totalConflicts - a.totalConflicts)[0];
  if (worstDim) {
    recs.push(`Highest conflict dimension: ${worstDim.dimension} (${worstDim.totalConflicts} total) — review merge strategy for this layer.`);
  }
  if (successRate >= 0.9 && rollbackRate <= 0.05) {
    recs.push("Merge history looks healthy — auto-merge is safe to enable for low-risk jobs.");
  }

  return recs.length > 0 ? recs : ["No recommendations — merge history is clean."];
}

export function computeReport(): MergeIntelligenceReport {
  const total     = records.length;
  const successes = records.filter(r => r.outcome === "success").length;
  const failures  = records.filter(r => r.outcome === "failure").length;
  const rollbacks = records.filter(r => r.outcome === "rollback").length;
  const partials  = records.filter(r => r.outcome === "partial").length;

  const successRate  = total > 0 ? successes  / total : 0;
  const rollbackRate = total > 0 ? rollbacks  / total : 0;
  const failureRate  = total > 0 ? failures   / total : 0;

  const avgDurationMs  = total > 0 ? records.reduce((s, r) => s + r.durationMs, 0)  / total : 0;
  const avgConflicts   = total > 0 ? records.reduce((s, r) => s + r.conflicts, 0)   / total : 0;
  const avgFileChanges = total > 0 ? records.reduce((s, r) => s + r.fileChanges, 0) / total : 0;

  const conflictPatterns = computeConflictPatterns(records);
  const dimensionStats   = computeDimensionStats(records);
  const riskLevel        = computeRiskLevel(successRate, rollbackRate, avgConflicts);
  const safeToAutoMerge  = riskLevel === "low" && total >= 3;
  const recommendations  = buildRecommendations(successRate, rollbackRate, avgConflicts, conflictPatterns, dimensionStats, total);

  return {
    generatedAt:      new Date().toISOString(),
    version:          "1.0",
    totalMerges:      total,
    successCount:     successes,
    failureCount:     failures,
    rollbackCount:    rollbacks,
    partialCount:     partials,
    successRate:      +successRate.toFixed(4),
    rollbackRate:     +rollbackRate.toFixed(4),
    failureRate:      +failureRate.toFixed(4),
    avgDurationMs:    +avgDurationMs.toFixed(0),
    avgConflicts:     +avgConflicts.toFixed(2),
    avgFileChanges:   +avgFileChanges.toFixed(2),
    conflictPatterns,
    dimensionStats,
    recentRecords:    [...records].reverse().slice(0, 20),
    recommendations,
    riskLevel,
    safeToAutoMerge,
  };
}

export async function getIntelligenceReport(cloud: CloudProvider): Promise<MergeIntelligenceReport> {
  await loadFromDisk();
  const report = computeReport();
  await persistToDisk(report);
  await persistToR2(cloud, report);
  return report;
}

export async function getAllRecords(): Promise<MergeRecord[]> {
  await loadFromDisk();
  return [...records].reverse();
}
