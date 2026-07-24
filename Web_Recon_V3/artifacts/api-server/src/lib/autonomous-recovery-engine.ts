/**
 * autonomous-recovery-engine.ts — Phase F3 Autonomous Recovery Engine
 *
 * Automatically recovers failed scrape jobs without human intervention.
 * Every recovery strategy is selected based on the F2 failure classification.
 *
 * Recovery action types:
 *   auto_retry         — immediate re-queue (BrowserCrash, unknown errors)
 *   delayed_retry      — re-queue after a computed delay (NetworkTimeout, 429, 5xx)
 *   checkpoint_resume  — restore from checkpoint and continue (Parser, Storage, Manifest)
 *   batch_split        — split articles into smaller child jobs (OOM, repeated failures)
 *   worker_migration   — reset claimed_by so any fresh worker picks it up
 *   safe_abort         — mark dead_letter with full audit trail (exhausted retries)
 *
 * Every action is logged via the pino logger before and after execution.
 *
 * Generates (on every action and on explicit flush):
 *   recovery-report.json
 *   retry-history.json
 *   automatic-recovery-report.json
 */

import { writeFile, readFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { logger } from "./logger.js";
import type { FailureClassification, FailureClass } from "./failure-classifier.js";
import { enqueueJob, markJobFailed, getJobRecord } from "./db-queue.js";
import { db, scrapeJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { ArticleLink } from "./scraper.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RecoveryActionType =
  | "auto_retry"
  | "delayed_retry"
  | "checkpoint_resume"
  | "batch_split"
  | "worker_migration"
  | "safe_abort";

export type RecoveryOutcome = "succeeded" | "failed" | "scheduled" | "aborted";

export interface RecoveryAction {
  actionId: string;
  jobId: string;
  seedUrl: string;
  triggeredAt: string;
  completedAt: string | null;
  failureClass: FailureClass;
  retryCount: number;
  maxRetries: number;
  actionType: RecoveryActionType;
  actionReason: string;
  delayMs: number | null;
  childJobIds: string[];
  originalBatchSize: number | null;
  newBatchSize: number | null;
  outcome: RecoveryOutcome;
  outcomeDetail: string | null;
}

export interface RetryHistoryEntry {
  entryId: string;
  jobId: string;
  seedUrl: string;
  failureClass: FailureClass;
  retryCount: number;
  actionType: RecoveryActionType;
  attemptedAt: string;
  outcome: RecoveryOutcome;
  notes: string;
}

export interface RecoveryReport {
  generatedAt: string;
  totalActionsTriggered: number;
  totalSucceeded: number;
  totalFailed: number;
  totalScheduled: number;
  totalAborted: number;
  byActionType: Partial<Record<RecoveryActionType, number>>;
  byFailureClass: Partial<Record<FailureClass, number>>;
  actions: RecoveryAction[];
}

export interface AutomaticRecoveryReport {
  generatedAt: string;
  summary: {
    jobsAutoRecovered: number;
    jobsAborted: number;
    childJobsSpawned: number;
    totalDelayMsAccumulated: number;
    averageRecoveryDelayMs: number;
  };
  recoveryChains: Array<{
    jobId: string;
    seedUrl: string;
    failureClass: FailureClass;
    recoveryChain: Array<{
      actionType: RecoveryActionType;
      outcome: RecoveryOutcome;
      triggeredAt: string;
    }>;
    finalOutcome: "recovered" | "aborted";
  }>;
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const recoveryActions: RecoveryAction[] = [];
const retryHistory: RetryHistoryEntry[] = [];
const pendingRetries = new Map<string, ReturnType<typeof setTimeout>>();
const failureFrequency = new Map<string, number>(); // key = jobId:failureClass

// ---------------------------------------------------------------------------
// Strategy selector
// ---------------------------------------------------------------------------

interface RecoveryStrategy {
  actionType: RecoveryActionType;
  delayMs: number | null;
  reason: string;
}

function selectStrategy(
  classification: FailureClassification,
  failureKey: string
): RecoveryStrategy {
  const { failureClass, retryCount, maxRetries } = classification;
  const repetitions = failureFrequency.get(failureKey) ?? 0;

  // Exhausted retries → safe abort regardless of class
  if (retryCount >= maxRetries) {
    return {
      actionType: "safe_abort",
      delayMs: null,
      reason: `Retry limit reached (${retryCount}/${maxRetries}) — aborting job`,
    };
  }

  // Same failure class ≥ 3 times → batch split
  if (repetitions >= 3) {
    return {
      actionType: "batch_split",
      delayMs: null,
      reason: `Failure class "${failureClass}" repeated ${repetitions}× — splitting workload into child jobs`,
    };
  }

  switch (failureClass) {
    case "OOM":
      return {
        actionType: "batch_split",
        delayMs: null,
        reason: "OOM detected — splitting batch to reduce per-job memory pressure",
      };

    case "NetworkTimeout":
      return {
        actionType: "delayed_retry",
        delayMs: Math.min(10_000 * Math.pow(2, retryCount), 300_000),
        reason: `Network timeout — exponential backoff (${Math.min(10_000 * Math.pow(2, retryCount), 300_000) / 1000}s)`,
      };

    case "DNSFailure":
      return {
        actionType: "delayed_retry",
        delayMs: 30_000,
        reason: "DNS failure — waiting 30s for DNS propagation",
      };

    case "HTTPFailure":
      return {
        actionType: "delayed_retry",
        delayMs: 15_000,
        reason: "HTTP failure — waiting 15s before retry",
      };

    case "429RateLimit": {
      const delay = 60_000 + retryCount * 30_000;
      return {
        actionType: "delayed_retry",
        delayMs: delay,
        reason: `Rate-limited (429) — backing off ${delay / 1000}s`,
      };
    }

    case "5xxServerError":
      return {
        actionType: "delayed_retry",
        delayMs: Math.min(30_000 * Math.pow(2, retryCount), 600_000),
        reason: "Server 5xx — exponential backoff retry",
      };

    case "BrowserCrash":
      return {
        actionType: "auto_retry",
        delayMs: null,
        reason: "Browser crashed — immediate re-queue for fresh worker pickup",
      };

    case "ParserFailure":
      return {
        actionType: "checkpoint_resume",
        delayMs: null,
        reason: "Parser failure — skipping failed URLs and resuming from checkpoint",
      };

    case "StorageFailure":
      return {
        actionType: "checkpoint_resume",
        delayMs: null,
        reason: "Storage failure — flushing pending writes then resuming from checkpoint",
      };

    case "CheckpointFailure":
      return {
        actionType: "checkpoint_resume",
        delayMs: null,
        reason: "Checkpoint failure — restoring from last valid checkpoint",
      };

    case "ManifestFailure":
      return {
        actionType: "checkpoint_resume",
        delayMs: null,
        reason: "Manifest verification failure — checkpoint-based resume",
      };

    case "UnexpectedException":
    case "Unknown":
    default:
      if (retryCount < maxRetries - 1) {
        return {
          actionType: "auto_retry",
          delayMs: null,
          reason: `Unexpected failure — auto-retry (attempt ${retryCount + 1}/${maxRetries})`,
        };
      }
      return {
        actionType: "delayed_retry",
        delayMs: 30_000,
        reason: "Unexpected failure on last retry — 30s delay before final attempt",
      };
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function requeueJob(jobId: string, delayMs: number | null): Promise<boolean> {
  const doRequeue = async (): Promise<boolean> => {
    try {
      await db
        .update(scrapeJobsTable)
        .set({
          status: "queued",
          errorMessage: null,
          claimedBy: null,
          claimedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(scrapeJobsTable.jobId, jobId));
      logger.info({ jobId, delayMs }, "F3: job re-queued");
      return true;
    } catch (err) {
      logger.error({ err, jobId }, "F3: failed to re-queue job");
      return false;
    }
  };

  if (!delayMs || delayMs <= 0) return doRequeue();

  // Delayed: schedule then return immediately (outcome will be "scheduled")
  const timer = setTimeout(async () => {
    pendingRetries.delete(jobId);
    await doRequeue();
  }, delayMs);
  pendingRetries.set(jobId, timer);
  logger.info({ jobId, delayMs }, "F3: delayed re-queue scheduled");
  return true;
}

async function splitAndSpawnChildJobs(
  classification: FailureClassification,
  action: RecoveryAction
): Promise<string[]> {
  const record = await getJobRecord(classification.jobId);
  if (!record) {
    logger.warn({ jobId: classification.jobId }, "F3: job not found for batch split");
    return [];
  }

  let articles: ArticleLink[] = [];
  try {
    articles = JSON.parse(record.articlesJson) as ArticleLink[];
  } catch {
    return [];
  }

  if (articles.length <= 1) {
    // Too small to split — fall back to auto_retry
    logger.warn({ jobId: classification.jobId, articleCount: articles.length }, "F3: batch too small to split — fallback auto_retry");
    await requeueJob(classification.jobId, null);
    return [];
  }

  const mid = Math.ceil(articles.length / 2);
  const batches: ArticleLink[][] = [articles.slice(0, mid), articles.slice(mid)];
  const childIds: string[] = [];

  for (const batch of batches) {
    const childId = `child-${randomUUID().slice(0, 8)}`;
    try {
      await enqueueJob(
        childId,
        record.seedUrl,
        batch.length,
        record.includeImages,
        batch,
        record.diffMode ?? false,
        record.baseJobId ?? null
      );
      childIds.push(childId);
      logger.info({ jobId: classification.jobId, childId, batchSize: batch.length }, "F3: child job spawned");
    } catch (err) {
      logger.error({ err, jobId: classification.jobId, childId }, "F3: failed to spawn child job");
    }
  }

  if (childIds.length > 0) {
    // Delegate original to children
    try {
      await db
        .update(scrapeJobsTable)
        .set({
          status: "done",
          errorMessage: `[BATCH_SPLIT] delegated to child jobs: [${childIds.join(", ")}]`,
          completedAt: new Date(),
          updatedAt: new Date(),
          claimedBy: null,
        })
        .where(eq(scrapeJobsTable.jobId, classification.jobId));
    } catch (err) {
      logger.warn({ err, jobId: classification.jobId }, "F3: could not mark parent job done after split");
    }
  }

  action.childJobIds = childIds;
  action.originalBatchSize = articles.length;
  action.newBatchSize = mid;
  return childIds;
}

async function performCheckpointResume(jobId: string): Promise<boolean> {
  try {
    await db
      .update(scrapeJobsTable)
      .set({
        status: "queued",
        claimedBy: null,
        claimedAt: null,
        updatedAt: new Date(),
        errorMessage: "checkpoint_resume_requested",
      })
      .where(eq(scrapeJobsTable.jobId, jobId));
    logger.info({ jobId }, "F3: checkpoint resume flagged — job re-queued");
    return true;
  } catch (err) {
    logger.error({ err, jobId }, "F3: checkpoint resume failed");
    return false;
  }
}

async function performWorkerMigration(jobId: string): Promise<boolean> {
  try {
    await db
      .update(scrapeJobsTable)
      .set({ claimedBy: null, claimedAt: null, status: "queued", updatedAt: new Date() })
      .where(eq(scrapeJobsTable.jobId, jobId));
    logger.info({ jobId }, "F3: worker migration — claim released, job available for any worker");
    return true;
  } catch (err) {
    logger.error({ err, jobId }, "F3: worker migration failed");
    return false;
  }
}

async function executeSafeAbort(classification: FailureClassification): Promise<void> {
  logger.warn(
    { jobId: classification.jobId, failureClass: classification.failureClass, retryCount: classification.retryCount },
    "F3: safe abort — retries exhausted"
  );
  await markJobFailed(
    classification.jobId,
    `[SAFE_ABORT] ${classification.errorMessage} | class=${classification.failureClass} retries=${classification.retryCount}/${classification.maxRetries}`,
    classification.retryCount,
    classification.maxRetries
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// Core: execute recovery for a classified failure
// ---------------------------------------------------------------------------

export async function executeRecovery(
  classification: FailureClassification
): Promise<RecoveryAction> {
  const failureKey = `${classification.jobId}:${classification.failureClass}`;
  failureFrequency.set(failureKey, (failureFrequency.get(failureKey) ?? 0) + 1);

  const strategy = selectStrategy(classification, failureKey);

  const action: RecoveryAction = {
    actionId: randomUUID(),
    jobId: classification.jobId,
    seedUrl: classification.seedUrl,
    triggeredAt: new Date().toISOString(),
    completedAt: null,
    failureClass: classification.failureClass,
    retryCount: classification.retryCount,
    maxRetries: classification.maxRetries,
    actionType: strategy.actionType,
    actionReason: strategy.reason,
    delayMs: strategy.delayMs,
    childJobIds: [],
    originalBatchSize: null,
    newBatchSize: null,
    outcome: "scheduled",
    outcomeDetail: null,
  };

  logger.info(
    { jobId: classification.jobId, failureClass: classification.failureClass, actionType: strategy.actionType, delayMs: strategy.delayMs },
    "F3: executing recovery action"
  );

  try {
    switch (strategy.actionType) {
      case "auto_retry": {
        const ok = await requeueJob(classification.jobId, null);
        action.outcome = ok ? "succeeded" : "failed";
        action.outcomeDetail = ok ? "Job re-queued immediately" : "Re-queue DB update failed";
        break;
      }

      case "delayed_retry": {
        await requeueJob(classification.jobId, strategy.delayMs);
        action.outcome = "scheduled";
        action.outcomeDetail = `Retry scheduled in ${strategy.delayMs}ms`;
        break;
      }

      case "checkpoint_resume": {
        const ok = await performCheckpointResume(classification.jobId);
        action.outcome = ok ? "succeeded" : "failed";
        action.outcomeDetail = ok ? "Re-queued for checkpoint resume" : "Checkpoint resume DB update failed";
        break;
      }

      case "batch_split": {
        const childIds = await splitAndSpawnChildJobs(classification, action);
        if (childIds.length > 0) {
          action.outcome = "succeeded";
          action.outcomeDetail = `Spawned ${childIds.length} child jobs: [${childIds.join(", ")}]`;
        } else {
          // Fallback to auto_retry
          const ok = await requeueJob(classification.jobId, null);
          action.actionType = "auto_retry";
          action.outcome = ok ? "succeeded" : "failed";
          action.outcomeDetail = ok ? "Split fallback: re-queued" : "All recovery paths failed";
        }
        break;
      }

      case "worker_migration": {
        const ok = await performWorkerMigration(classification.jobId);
        action.outcome = ok ? "succeeded" : "failed";
        action.outcomeDetail = ok ? "Worker claim released — migrated to next available worker" : "Migration failed";
        break;
      }

      case "safe_abort": {
        await executeSafeAbort(classification);
        action.outcome = "aborted";
        action.outcomeDetail = `Job aborted after ${classification.retryCount}/${classification.maxRetries} retries`;
        failureFrequency.delete(failureKey);
        break;
      }
    }
  } catch (err) {
    action.outcome = "failed";
    action.outcomeDetail = `Recovery threw: ${err instanceof Error ? err.message : String(err)}`;
    logger.error({ err, jobId: classification.jobId }, "F3: recovery action threw");
  }

  action.completedAt = new Date().toISOString();
  recoveryActions.push(action);

  retryHistory.push({
    entryId: randomUUID(),
    jobId: classification.jobId,
    seedUrl: classification.seedUrl,
    failureClass: classification.failureClass,
    retryCount: classification.retryCount,
    actionType: action.actionType,
    attemptedAt: action.triggeredAt,
    outcome: action.outcome,
    notes: action.outcomeDetail ?? "",
  });

  logger.info(
    { jobId: classification.jobId, actionId: action.actionId, actionType: action.actionType, outcome: action.outcome },
    "F3: recovery action logged"
  );

  flushReports().catch(() => {});
  return action;
}

// ---------------------------------------------------------------------------
// Report builders
// ---------------------------------------------------------------------------

export function getRecoveryReport(): RecoveryReport {
  const byActionType: Partial<Record<RecoveryActionType, number>> = {};
  const byFailureClass: Partial<Record<FailureClass, number>> = {};
  for (const a of recoveryActions) {
    byActionType[a.actionType] = (byActionType[a.actionType] ?? 0) + 1;
    byFailureClass[a.failureClass] = (byFailureClass[a.failureClass] ?? 0) + 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    totalActionsTriggered: recoveryActions.length,
    totalSucceeded: recoveryActions.filter((a) => a.outcome === "succeeded").length,
    totalFailed: recoveryActions.filter((a) => a.outcome === "failed").length,
    totalScheduled: recoveryActions.filter((a) => a.outcome === "scheduled").length,
    totalAborted: recoveryActions.filter((a) => a.outcome === "aborted").length,
    byActionType,
    byFailureClass,
    actions: recoveryActions,
  };
}

export function getRetryHistory(): { generatedAt: string; entries: RetryHistoryEntry[] } {
  return { generatedAt: new Date().toISOString(), entries: retryHistory };
}

export function getAutomaticRecoveryReport(): AutomaticRecoveryReport {
  const chainMap = new Map<string, { seedUrl: string; failureClass: FailureClass; steps: RecoveryAction[] }>();
  for (const a of recoveryActions) {
    if (!chainMap.has(a.jobId)) {
      chainMap.set(a.jobId, { seedUrl: a.seedUrl, failureClass: a.failureClass, steps: [] });
    }
    chainMap.get(a.jobId)!.steps.push(a);
  }

  const recoveryChains = Array.from(chainMap.entries()).map(([jobId, chain]) => {
    const last = chain.steps[chain.steps.length - 1];
    return {
      jobId,
      seedUrl: chain.seedUrl,
      failureClass: chain.failureClass,
      recoveryChain: chain.steps.map((s) => ({ actionType: s.actionType, outcome: s.outcome, triggeredAt: s.triggeredAt })),
      finalOutcome: (last?.outcome === "aborted" ? "aborted" : "recovered") as "recovered" | "aborted",
    };
  });

  const totalDelayMs = recoveryActions.reduce((n, a) => n + (a.delayMs ?? 0), 0);
  const delayedCount = recoveryActions.filter((a) => a.delayMs).length;

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      jobsAutoRecovered: recoveryChains.filter((c) => c.finalOutcome === "recovered").length,
      jobsAborted: recoveryChains.filter((c) => c.finalOutcome === "aborted").length,
      childJobsSpawned: recoveryActions.reduce((n, a) => n + a.childJobIds.length, 0),
      totalDelayMsAccumulated: totalDelayMs,
      averageRecoveryDelayMs: delayedCount > 0 ? Math.round(totalDelayMs / delayedCount) : 0,
    },
    recoveryChains,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const REPORT_DIR = process.cwd();

export async function flushReports(): Promise<{
  recoveryReport: RecoveryReport;
  retryHistoryReport: ReturnType<typeof getRetryHistory>;
  automaticRecoveryReport: AutomaticRecoveryReport;
}> {
  const recoveryReport = getRecoveryReport();
  const retryHistoryReport = getRetryHistory();
  const automaticRecoveryReport = getAutomaticRecoveryReport();

  await Promise.allSettled([
    writeFile(join(REPORT_DIR, "recovery-report.json"), JSON.stringify(recoveryReport, null, 2)),
    writeFile(join(REPORT_DIR, "retry-history.json"), JSON.stringify(retryHistoryReport, null, 2)),
    writeFile(join(REPORT_DIR, "automatic-recovery-report.json"), JSON.stringify(automaticRecoveryReport, null, 2)),
  ]);

  logger.info(
    { actions: recoveryReport.totalActionsTriggered, recovered: recoveryReport.totalSucceeded, aborted: recoveryReport.totalAborted },
    "F3: reports flushed"
  );

  return { recoveryReport, retryHistoryReport, automaticRecoveryReport };
}

export async function loadPersistedRecoveryActions(): Promise<void> {
  try {
    const raw = await readFile(join(REPORT_DIR, "recovery-report.json"), "utf8");
    const parsed = JSON.parse(raw) as RecoveryReport;
    for (const a of parsed.actions ?? []) recoveryActions.push(a);
    logger.info({ count: recoveryActions.length }, "F3: loaded persisted recovery actions");
  } catch {
    // no prior file — start fresh
  }
}

export function cancelPendingRetry(jobId: string): boolean {
  const timer = pendingRetries.get(jobId);
  if (!timer) return false;
  clearTimeout(timer);
  pendingRetries.delete(jobId);
  logger.info({ jobId }, "F3: pending delayed retry cancelled");
  return true;
}
