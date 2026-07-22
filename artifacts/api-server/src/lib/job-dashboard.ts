/**
 * job-dashboard.ts — Phase F5 Job Dashboard API
 *
 * Provides a production-grade view and control surface for every Job Set and
 * child job in the pipeline. Aggregates data from F1 (Supervisor), F2
 * (Failure Classifier), F3 (Recovery Engine), and F4 (Checkpoint Engine).
 *
 * Each job exposes:
 *   Status, Progress, Coverage, Retries, Resource Usage,
 *   Failure History, Checkpoint, Remaining URLs
 *
 * Supported control operations:
 *   pause | resume | retry | restart | cancel | split | merge | promote | demote
 *
 * Generates:
 *   job-dashboard-report.json
 *   dashboard-api-report.json
 *   job-control-report.json
 */

import { writeFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { logger } from "./logger.js";
import { db, scrapeJobsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  listAllJobs,
  getJobRecord,
  enqueueJob,
  type ScrapeJobRecord,
} from "./db-queue.js";
import { getSupervisorReport, getHealthReport } from "./job-supervisor.js";
import { allClassifications, type FailureClassification } from "./failure-classifier.js";
import { getRecoveryReport, type RecoveryAction } from "./autonomous-recovery-engine.js";
import { getJobCheckpoint, type JobCheckpoint } from "./checkpoint-engine.js";
import type { ArticleLink } from "./scraper.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResourceUsage {
  estimatedBytesProcessed: number;
  articlesPerMinute: number | null;
  lastActiveAt: string | null;
  workerId: string | null;
  uptimeMs: number | null;
}

export interface FailureHistoryEntry {
  classifiedAt: string;
  failureClass: string;
  rootCause: string;
  retryRecommendation: string;
  riskLevel: string;
  confidence: number;
}

export interface CheckpointSummary {
  checkpointVersion: number;
  checkpointedAt: string;
  completedUrls: number;
  pendingUrls: number;
  failedUrls: number;
  coveragePercent: number;
  isValid: boolean;
}

export interface JobDetail {
  jobId: string;
  seedUrl: string;
  status: string;
  // Progress
  completedArticles: number;
  totalArticles: number;
  progressPercent: number;
  currentArticle: string | null;
  // Coverage
  coveragePercent: number;
  visitedUrlCount: number;
  pendingUrlCount: number;
  remainingUrls: string[];
  // Retries
  retryCount: number;
  maxRetries: number;
  retriesRemaining: number;
  // Resource usage
  resourceUsage: ResourceUsage;
  // Failure history
  failureHistory: FailureHistoryEntry[];
  // Recovery actions
  recoveryActions: Array<{
    actionType: string;
    outcome: string;
    triggeredAt: string;
    actionReason: string;
  }>;
  // Checkpoint
  checkpoint: CheckpointSummary | null;
  // Health (from F1 supervisor)
  healthStatus: string | null;
  stalledForMs: number;
  // Metadata
  diffMode: boolean;
  baseJobId: string | null;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  // Relationships
  isChildJob: boolean;
  parentJobId: string | null;
  childJobIds: string[];
  zipPath: string | null;
  downloadUrl: string | null;
  errorMessage: string | null;
}

export interface JobSet {
  setId: string;
  seedUrl: string;
  rootJobId: string;
  parentJob: JobDetail;
  childJobs: JobDetail[];
  totalJobs: number;
  aggregateStatus: string;
  totalArticles: number;
  completedArticles: number;
  progressPercent: number;
  coveragePercent: number;
  totalRetries: number;
  failedJobs: number;
  runningJobs: number;
  completedJobs: number;
  queuedJobs: number;
  createdAt: string;
  updatedAt: string;
}

export type ControlOperation =
  | "pause"
  | "resume"
  | "retry"
  | "restart"
  | "cancel"
  | "split"
  | "merge"
  | "promote"
  | "demote";

export interface ControlResult {
  operationId: string;
  jobId: string;
  operation: ControlOperation;
  executedAt: string;
  success: boolean;
  detail: string;
  affectedJobIds: string[];
}

export interface JobDashboardReport {
  generatedAt: string;
  totalJobSets: number;
  totalJobs: number;
  jobsByStatus: Record<string, number>;
  totalArticles: number;
  totalCompleted: number;
  overallProgressPercent: number;
  activeJobSets: JobSet[];
}

export interface DashboardApiReport {
  generatedAt: string;
  totalEndpoints: number;
  totalOperationsExecuted: number;
  operationsByType: Partial<Record<ControlOperation, number>>;
  successRate: number;
  controlHistory: ControlResult[];
}

export interface JobControlReport {
  generatedAt: string;
  totalControls: number;
  successful: number;
  failed: number;
  byOperation: Partial<Record<ControlOperation, number>>;
  recentControls: ControlResult[];
}

// ---------------------------------------------------------------------------
// In-memory control history
// ---------------------------------------------------------------------------

const controlHistory: ControlResult[] = [];

function recordControl(result: ControlResult): void {
  controlHistory.push(result);
  flushReports().catch(() => {});
}

// ---------------------------------------------------------------------------
// Data assembly helpers
// ---------------------------------------------------------------------------

function parseArticles(json: string): ArticleLink[] {
  try { return JSON.parse(json) as ArticleLink[]; } catch { return []; }
}

function buildResourceUsage(record: ScrapeJobRecord): ResourceUsage {
  const claimedAt = record.claimedAt ? new Date(record.claimedAt).getTime() : null;
  const now = Date.now();
  const uptimeMs = claimedAt ? now - claimedAt : null;

  const articlesPerMinute =
    uptimeMs && uptimeMs > 60_000 && record.completedArticles > 0
      ? Math.round((record.completedArticles / (uptimeMs / 60_000)) * 10) / 10
      : null;

  // Rough estimate: ~2KB per article (HTML + metadata)
  const estimatedBytesProcessed = record.completedArticles * 2048;

  return {
    estimatedBytesProcessed,
    articlesPerMinute,
    lastActiveAt: record.updatedAt ? new Date(record.updatedAt).toISOString() : null,
    workerId: record.claimedBy ?? null,
    uptimeMs,
  };
}

function buildCheckpointSummary(cp: JobCheckpoint | null): CheckpointSummary | null {
  if (!cp) return null;
  return {
    checkpointVersion: cp.checkpointVersion,
    checkpointedAt: cp.checkpointedAt,
    completedUrls: cp.completedUrls.length,
    pendingUrls: cp.pendingUrls.length,
    failedUrls: cp.failedUrls.length,
    coveragePercent: cp.coverageState.coveragePercent,
    isValid: cp.isValid,
  };
}

function buildFailureHistory(
  jobId: string,
  classifications: FailureClassification[]
): FailureHistoryEntry[] {
  return classifications
    .filter((c) => c.jobId === jobId)
    .map((c) => ({
      classifiedAt: c.classifiedAt,
      failureClass: c.failureClass,
      rootCause: c.rootCause,
      retryRecommendation: c.retryRecommendation,
      riskLevel: c.riskLevel,
      confidence: c.confidence,
    }));
}

function buildRecoveryActionsForJob(jobId: string, actions: RecoveryAction[]) {
  return actions
    .filter((a) => a.jobId === jobId)
    .map((a) => ({
      actionType: a.actionType,
      outcome: a.outcome,
      triggeredAt: a.triggeredAt,
      actionReason: a.actionReason,
    }));
}

// ---------------------------------------------------------------------------
// Build a full JobDetail from all available data sources
// ---------------------------------------------------------------------------

export function buildJobDetail(
  record: ScrapeJobRecord,
  {
    allClassificationsData,
    allRecoveryActions,
    supervisorTrackedJobs,
    childJobIds,
    parentJobId,
  }: {
    allClassificationsData: FailureClassification[];
    allRecoveryActions: RecoveryAction[];
    supervisorTrackedJobs: Map<string, { healthStatus: string; stalledForMs: number }>;
    childJobIds: string[];
    parentJobId: string | null;
  }
): JobDetail {
  const articles = parseArticles(record.articlesJson);
  const cp = getJobCheckpoint(record.jobId);
  const supervisorEntry = supervisorTrackedJobs.get(record.jobId);

  // Coverage from F4 checkpoint or estimated from DB progress
  const coveragePercent = cp
    ? cp.coverageState.coveragePercent
    : record.totalArticles > 0
      ? Math.round((record.completedArticles / record.totalArticles) * 100)
      : 0;

  // Remaining URLs: from checkpoint or from article list position
  const completedSet = new Set(cp?.completedUrls ?? []);
  const remainingUrls =
    cp && cp.pendingUrls.length > 0
      ? cp.pendingUrls
      : articles.slice(record.completedArticles).map((a) => a.url);

  const progressPercent =
    record.totalArticles > 0
      ? Math.round((record.completedArticles / record.totalArticles) * 100)
      : 0;

  return {
    jobId: record.jobId,
    seedUrl: record.seedUrl,
    status: record.status,
    completedArticles: record.completedArticles,
    totalArticles: record.totalArticles,
    progressPercent,
    currentArticle: record.currentArticle ?? null,
    coveragePercent,
    visitedUrlCount: cp ? cp.visitedUrls.length : record.completedArticles,
    pendingUrlCount: remainingUrls.length,
    remainingUrls,
    retryCount: record.retryCount,
    maxRetries: record.maxRetries,
    retriesRemaining: Math.max(0, record.maxRetries - record.retryCount),
    resourceUsage: buildResourceUsage(record),
    failureHistory: buildFailureHistory(record.jobId, allClassificationsData),
    recoveryActions: buildRecoveryActionsForJob(record.jobId, allRecoveryActions),
    checkpoint: buildCheckpointSummary(cp),
    healthStatus: supervisorEntry?.healthStatus ?? null,
    stalledForMs: supervisorEntry?.stalledForMs ?? 0,
    diffMode: record.diffMode ?? false,
    baseJobId: record.baseJobId ?? null,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    claimedAt: record.claimedAt ? new Date(record.claimedAt).toISOString() : null,
    completedAt: record.completedAt ? new Date(record.completedAt).toISOString() : null,
    isChildJob: parentJobId !== null || record.jobId.startsWith("child-"),
    parentJobId,
    childJobIds,
    zipPath: record.zipPath ?? null,
    downloadUrl: record.downloadUrl ?? null,
    errorMessage: record.errorMessage ?? null,
  };
}

// ---------------------------------------------------------------------------
// Fetch rich data for one job
// ---------------------------------------------------------------------------

export async function getJobDetails(jobId: string): Promise<JobDetail | null> {
  const record = await getJobRecord(jobId);
  if (!record) return null;

  const classifications = allClassifications();
  const recoveryReport = getRecoveryReport();

  const supervisorMap = new Map<string, { healthStatus: string; stalledForMs: number }>();
  const healthReport = getHealthReport();
  if (healthReport) {
    for (const j of healthReport.trackedJobs ?? []) {
      supervisorMap.set(j.jobId, { healthStatus: j.healthStatus, stalledForMs: j.stalledForMs ?? 0 });
    }
  }

  // Find child jobs by looking for jobs that reference this one
  const allJobs = await listAllJobs(200);
  const childJobIds = allJobs
    .filter((j) => j.baseJobId === jobId || j.jobId.startsWith(`child-`) && j.seedUrl === record.seedUrl)
    .map((j) => j.jobId);

  const parentJobId = record.baseJobId ?? null;

  return buildJobDetail(record, {
    allClassificationsData: classifications,
    allRecoveryActions: recoveryReport.actions,
    supervisorTrackedJobs: supervisorMap,
    childJobIds,
    parentJobId,
  });
}

// ---------------------------------------------------------------------------
// Fetch all job sets
// ---------------------------------------------------------------------------

export async function getAllJobSets(): Promise<JobSet[]> {
  const allJobs = await listAllJobs(200);
  const classifications = allClassifications();
  const recoveryReport = getRecoveryReport();

  const supervisorMap = new Map<string, { healthStatus: string; stalledForMs: number }>();
  const healthReport = getHealthReport();
  if (healthReport) {
    for (const j of healthReport.trackedJobs ?? []) {
      supervisorMap.set(j.jobId, { healthStatus: j.healthStatus, stalledForMs: j.stalledForMs ?? 0 });
    }
  }

  // Group jobs by seedUrl to form Job Sets
  const setsBySeed = new Map<string, ScrapeJobRecord[]>();
  for (const j of allJobs) {
    const key = j.seedUrl;
    if (!setsBySeed.has(key)) setsBySeed.set(key, []);
    setsBySeed.get(key)!.push(j);
  }

  const jobSets: JobSet[] = [];

  for (const [seedUrl, jobs] of setsBySeed) {
    // Parent = oldest non-child job for this seed
    const sorted = jobs.slice().sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    const parentRecord = sorted[0]!;
    const childRecords = sorted.slice(1);

    const childJobIds = childRecords.map((j) => j.jobId);

    const makeDetail = (r: ScrapeJobRecord, pid: string | null, kids: string[]) =>
      buildJobDetail(r, {
        allClassificationsData: classifications,
        allRecoveryActions: recoveryReport.actions,
        supervisorTrackedJobs: supervisorMap,
        childJobIds: kids,
        parentJobId: pid,
      });

    const parentDetail = makeDetail(parentRecord, null, childJobIds);
    const childDetails = childRecords.map((r) => makeDetail(r, parentRecord.jobId, []));

    const allInSet = [parentRecord, ...childRecords];
    const totalArticles = allInSet.reduce((n, j) => n + j.totalArticles, 0);
    const completedArticles = allInSet.reduce((n, j) => n + j.completedArticles, 0);
    const totalRetries = allInSet.reduce((n, j) => n + j.retryCount, 0);

    const statusCounts = { failed: 0, running: 0, done: 0, queued: 0, dead_letter: 0, paused: 0 };
    for (const j of allInSet) {
      const s = j.status as keyof typeof statusCounts;
      if (s in statusCounts) statusCounts[s]++;
    }

    const aggregateStatus =
      statusCounts.running > 0 ? "running" :
      statusCounts.queued > 0 ? "queued" :
      statusCounts.failed > 0 ? "partially_failed" :
      statusCounts.dead_letter > 0 ? "dead_letter" :
      statusCounts.paused > 0 ? "paused" :
      "done";

    const coverages = [parentDetail, ...childDetails].map((d) => d.coveragePercent);
    const avgCoverage = coverages.length > 0
      ? Math.round(coverages.reduce((a, b) => a + b, 0) / coverages.length)
      : 0;

    jobSets.push({
      setId: parentRecord.jobId,
      seedUrl,
      rootJobId: parentRecord.jobId,
      parentJob: parentDetail,
      childJobs: childDetails,
      totalJobs: allInSet.length,
      aggregateStatus,
      totalArticles,
      completedArticles,
      progressPercent: totalArticles > 0 ? Math.round((completedArticles / totalArticles) * 100) : 0,
      coveragePercent: avgCoverage,
      totalRetries,
      failedJobs: statusCounts.failed,
      runningJobs: statusCounts.running,
      completedJobs: statusCounts.done,
      queuedJobs: statusCounts.queued,
      createdAt: new Date(parentRecord.createdAt).toISOString(),
      updatedAt: new Date(parentRecord.updatedAt).toISOString(),
    });
  }

  return jobSets.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

// ---------------------------------------------------------------------------
// Control operations
// ---------------------------------------------------------------------------

async function assertJobExists(jobId: string): Promise<ScrapeJobRecord> {
  const record = await getJobRecord(jobId);
  if (!record) throw new Error(`Job not found: ${jobId}`);
  return record;
}

export async function pauseJob(jobId: string): Promise<ControlResult> {
  const result: ControlResult = {
    operationId: randomUUID(),
    jobId,
    operation: "pause",
    executedAt: new Date().toISOString(),
    success: false,
    detail: "",
    affectedJobIds: [jobId],
  };
  try {
    const record = await assertJobExists(jobId);
    if (record.status === "paused") {
      result.success = true;
      result.detail = "Job was already paused";
    } else if (!["queued", "running", "failed"].includes(record.status)) {
      result.detail = `Cannot pause job in status "${record.status}"`;
    } else {
      await db.update(scrapeJobsTable)
        .set({ status: "paused", claimedBy: null, claimedAt: null, updatedAt: new Date() })
        .where(eq(scrapeJobsTable.jobId, jobId));
      result.success = true;
      result.detail = `Job paused (was: ${record.status})`;
      logger.info({ jobId }, "DASHBOARD: job paused");
    }
  } catch (err) {
    result.detail = `Pause failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  recordControl(result);
  return result;
}

export async function resumeJob(jobId: string): Promise<ControlResult> {
  const result: ControlResult = {
    operationId: randomUUID(),
    jobId,
    operation: "resume",
    executedAt: new Date().toISOString(),
    success: false,
    detail: "",
    affectedJobIds: [jobId],
  };
  try {
    const record = await assertJobExists(jobId);
    if (record.status !== "paused") {
      result.detail = `Job is not paused (status: ${record.status})`;
    } else {
      await db.update(scrapeJobsTable)
        .set({ status: "queued", errorMessage: null, updatedAt: new Date() })
        .where(eq(scrapeJobsTable.jobId, jobId));
      result.success = true;
      result.detail = "Job resumed — re-queued for pickup";
      logger.info({ jobId }, "DASHBOARD: job resumed");
    }
  } catch (err) {
    result.detail = `Resume failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  recordControl(result);
  return result;
}

export async function retryJob(jobId: string): Promise<ControlResult> {
  const result: ControlResult = {
    operationId: randomUUID(),
    jobId,
    operation: "retry",
    executedAt: new Date().toISOString(),
    success: false,
    detail: "",
    affectedJobIds: [jobId],
  };
  try {
    await assertJobExists(jobId);
    await db.update(scrapeJobsTable)
      .set({ status: "queued", retryCount: 0, errorMessage: null, claimedBy: null, claimedAt: null, updatedAt: new Date() })
      .where(eq(scrapeJobsTable.jobId, jobId));
    result.success = true;
    result.detail = "Retry queued — retry counter reset to 0";
    logger.info({ jobId }, "DASHBOARD: job retry triggered");
  } catch (err) {
    result.detail = `Retry failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  recordControl(result);
  return result;
}

export async function restartJob(jobId: string): Promise<ControlResult> {
  const result: ControlResult = {
    operationId: randomUUID(),
    jobId,
    operation: "restart",
    executedAt: new Date().toISOString(),
    success: false,
    detail: "",
    affectedJobIds: [jobId],
  };
  try {
    await assertJobExists(jobId);
    // Full reset: status, retries, progress, checkpoint
    await db.update(scrapeJobsTable)
      .set({
        status: "queued",
        retryCount: 0,
        completedArticles: 0,
        currentArticle: null,
        errorMessage: null,
        claimedBy: null,
        claimedAt: null,
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(scrapeJobsTable.jobId, jobId));
    // Clear F4 checkpoint so job starts from zero
    const { resetCheckpoint } = await import("./checkpoint-engine.js");
    await resetCheckpoint(jobId).catch(() => {});
    result.success = true;
    result.detail = "Full restart — progress reset, checkpoint cleared, re-queued";
    logger.info({ jobId }, "DASHBOARD: job full restart");
  } catch (err) {
    result.detail = `Restart failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  recordControl(result);
  return result;
}

export async function cancelJob(jobId: string): Promise<ControlResult> {
  const result: ControlResult = {
    operationId: randomUUID(),
    jobId,
    operation: "cancel",
    executedAt: new Date().toISOString(),
    success: false,
    detail: "",
    affectedJobIds: [jobId],
  };
  try {
    const record = await assertJobExists(jobId);
    if (record.status === "done") {
      result.detail = "Cannot cancel a completed job";
    } else {
      await db.update(scrapeJobsTable)
        .set({
          status: "dead_letter",
          errorMessage: "[CANCELLED] Job cancelled via dashboard",
          claimedBy: null,
          claimedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(scrapeJobsTable.jobId, jobId));
      result.success = true;
      result.detail = `Job cancelled (was: ${record.status})`;
      logger.info({ jobId }, "DASHBOARD: job cancelled");
    }
  } catch (err) {
    result.detail = `Cancel failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  recordControl(result);
  return result;
}

export async function splitJob(jobId: string, parts = 2): Promise<ControlResult> {
  const result: ControlResult = {
    operationId: randomUUID(),
    jobId,
    operation: "split",
    executedAt: new Date().toISOString(),
    success: false,
    detail: "",
    affectedJobIds: [jobId],
  };
  try {
    const record = await assertJobExists(jobId);
    const articles = parseArticles(record.articlesJson);

    if (articles.length <= 1) {
      result.detail = "Cannot split: article list has ≤ 1 entry";
      recordControl(result);
      return result;
    }

    const clampedParts = Math.min(Math.max(2, parts), articles.length);
    const chunkSize = Math.ceil(articles.length / clampedParts);
    const childIds: string[] = [];

    for (let i = 0; i < clampedParts; i++) {
      const batch = articles.slice(i * chunkSize, (i + 1) * chunkSize);
      if (batch.length === 0) continue;
      const childId = `child-${randomUUID().slice(0, 8)}`;
      await enqueueJob(childId, record.seedUrl, batch.length, record.includeImages, batch, record.diffMode ?? false, record.baseJobId ?? null);
      childIds.push(childId);
    }

    await db.update(scrapeJobsTable)
      .set({
        status: "done",
        errorMessage: `[SPLIT] Delegated to: [${childIds.join(", ")}]`,
        completedAt: new Date(),
        updatedAt: new Date(),
        claimedBy: null,
      })
      .where(eq(scrapeJobsTable.jobId, jobId));

    result.success = true;
    result.affectedJobIds = [jobId, ...childIds];
    result.detail = `Split into ${childIds.length} child jobs: [${childIds.join(", ")}]`;
    logger.info({ jobId, childIds }, "DASHBOARD: job split");
  } catch (err) {
    result.detail = `Split failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  recordControl(result);
  return result;
}

export async function mergeJobs(jobIds: string[]): Promise<ControlResult> {
  const primaryId = jobIds[0]!;
  const result: ControlResult = {
    operationId: randomUUID(),
    jobId: primaryId,
    operation: "merge",
    executedAt: new Date().toISOString(),
    success: false,
    detail: "",
    affectedJobIds: jobIds,
  };
  try {
    if (jobIds.length < 2) {
      result.detail = "Merge requires at least 2 job IDs";
      recordControl(result);
      return result;
    }

    const records = await Promise.all(jobIds.map(getJobRecord));
    const valid = records.filter((r): r is ScrapeJobRecord => r !== null);
    if (valid.length < 2) {
      result.detail = "Not enough valid jobs found to merge";
      recordControl(result);
      return result;
    }

    // Combine all article lists, de-duplicating by URL
    const urlSeen = new Set<string>();
    const merged: ArticleLink[] = [];
    for (const r of valid) {
      for (const a of parseArticles(r.articlesJson)) {
        if (!urlSeen.has(a.url)) {
          urlSeen.add(a.url);
          merged.push(a);
        }
      }
    }

    // Create a new merged job
    const mergedId = `merged-${randomUUID().slice(0, 8)}`;
    const primary = valid[0]!;
    await enqueueJob(mergedId, primary.seedUrl, merged.length, primary.includeImages, merged, primary.diffMode ?? false, null);

    // Cancel all source jobs
    for (const r of valid) {
      await db.update(scrapeJobsTable)
        .set({ status: "dead_letter", errorMessage: `[MERGED] into ${mergedId}`, updatedAt: new Date(), claimedBy: null })
        .where(eq(scrapeJobsTable.jobId, r.jobId));
    }

    result.success = true;
    result.affectedJobIds = [...jobIds, mergedId];
    result.detail = `Merged ${valid.length} jobs (${merged.length} unique URLs) into ${mergedId}`;
    logger.info({ jobIds, mergedId, totalUrls: merged.length }, "DASHBOARD: jobs merged");
  } catch (err) {
    result.detail = `Merge failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  recordControl(result);
  return result;
}

export async function promoteJob(jobId: string): Promise<ControlResult> {
  const result: ControlResult = {
    operationId: randomUUID(),
    jobId,
    operation: "promote",
    executedAt: new Date().toISOString(),
    success: false,
    detail: "",
    affectedJobIds: [jobId],
  };
  try {
    await assertJobExists(jobId);
    // Move to front of queue by setting createdAt to epoch
    await db.update(scrapeJobsTable)
      .set({ createdAt: new Date(0), updatedAt: new Date() })
      .where(eq(scrapeJobsTable.jobId, jobId));
    result.success = true;
    result.detail = "Job promoted to front of queue";
    logger.info({ jobId }, "DASHBOARD: job promoted");
  } catch (err) {
    result.detail = `Promote failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  recordControl(result);
  return result;
}

export async function demoteJob(jobId: string): Promise<ControlResult> {
  const result: ControlResult = {
    operationId: randomUUID(),
    jobId,
    operation: "demote",
    executedAt: new Date().toISOString(),
    success: false,
    detail: "",
    affectedJobIds: [jobId],
  };
  try {
    await assertJobExists(jobId);
    // Move to back of queue by setting createdAt to far future
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    await db.update(scrapeJobsTable)
      .set({ createdAt: farFuture, updatedAt: new Date() })
      .where(eq(scrapeJobsTable.jobId, jobId));
    result.success = true;
    result.detail = "Job demoted to back of queue";
    logger.info({ jobId }, "DASHBOARD: job demoted");
  } catch (err) {
    result.detail = `Demote failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  recordControl(result);
  return result;
}

// ---------------------------------------------------------------------------
// Report builders
// ---------------------------------------------------------------------------

export async function buildDashboardReport(): Promise<JobDashboardReport> {
  const jobSets = await getAllJobSets();
  const allJobs = jobSets.flatMap((s) => [s.parentJob, ...s.childJobs]);

  const jobsByStatus: Record<string, number> = {};
  let totalArticles = 0, totalCompleted = 0;
  for (const j of allJobs) {
    jobsByStatus[j.status] = (jobsByStatus[j.status] ?? 0) + 1;
    totalArticles += j.totalArticles;
    totalCompleted += j.completedArticles;
  }

  return {
    generatedAt: new Date().toISOString(),
    totalJobSets: jobSets.length,
    totalJobs: allJobs.length,
    jobsByStatus,
    totalArticles,
    totalCompleted,
    overallProgressPercent: totalArticles > 0 ? Math.round((totalCompleted / totalArticles) * 100) : 0,
    activeJobSets: jobSets,
  };
}

export function buildDashboardApiReport(): DashboardApiReport {
  const byOp: Partial<Record<ControlOperation, number>> = {};
  let successful = 0;
  for (const c of controlHistory) {
    byOp[c.operation] = (byOp[c.operation] ?? 0) + 1;
    if (c.success) successful++;
  }
  return {
    generatedAt: new Date().toISOString(),
    totalEndpoints: 18, // 9 GET + 9 POST
    totalOperationsExecuted: controlHistory.length,
    operationsByType: byOp,
    successRate: controlHistory.length > 0 ? Math.round((successful / controlHistory.length) * 100) : 100,
    controlHistory,
  };
}

export function buildJobControlReport(): JobControlReport {
  const byOp: Partial<Record<ControlOperation, number>> = {};
  let successful = 0, failed = 0;
  for (const c of controlHistory) {
    byOp[c.operation] = (byOp[c.operation] ?? 0) + 1;
    if (c.success) successful++; else failed++;
  }
  return {
    generatedAt: new Date().toISOString(),
    totalControls: controlHistory.length,
    successful,
    failed,
    byOperation: byOp,
    recentControls: controlHistory.slice(-50),
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const REPORT_DIR = process.cwd();

export async function flushReports(): Promise<void> {
  const [dashboardReport, apiReport, controlReport] = await Promise.all([
    buildDashboardReport(),
    Promise.resolve(buildDashboardApiReport()),
    Promise.resolve(buildJobControlReport()),
  ]);

  await Promise.allSettled([
    writeFile(join(REPORT_DIR, "job-dashboard-report.json"), JSON.stringify(dashboardReport, null, 2)),
    writeFile(join(REPORT_DIR, "dashboard-api-report.json"), JSON.stringify(apiReport, null, 2)),
    writeFile(join(REPORT_DIR, "job-control-report.json"), JSON.stringify(controlReport, null, 2)),
  ]);

  logger.info(
    { jobSets: dashboardReport.totalJobSets, operations: controlReport.totalControls },
    "F5: dashboard reports flushed"
  );
}
