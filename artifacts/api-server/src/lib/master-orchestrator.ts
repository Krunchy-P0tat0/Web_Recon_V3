/**
 * master-orchestrator.ts — Phase 7.1 Master Orchestration Engine
 *
 * Single-endpoint, full 12-stage reconstruction pipeline:
 *
 *   crawl → manifest → diff → intelligence → design-dna → visual-dna
 *   → stencil → website-prime → merge → deployment-plan → deploy
 *
 * Features:
 *   - Per-stage status, timing, error capture
 *   - Retry with exponential back-off (up to MAX_RETRIES per stage)
 *   - Tracks: currentStage, completedStages, failedStages, retries
 *   - Writes orchestration-engine.json (live state) + orchestration-audit.json (history)
 *   - Uploads both files to R2
 *   - Non-blocking: caller receives job immediately; polls for progress
 */

import { randomUUID }              from "crypto";
import { writeFile, readFile }     from "fs/promises";
import { join }                    from "path";
import { logger }                  from "./logger.js";
import { submitScrapeJob, waitForJobCompletion } from "./scrape-bridge.js";
import { loadManifest }            from "./manifest-store.js";
import { runAndStoreGenerationPipeline } from "./generation-runner.js";
import { runAndStoreClassification }     from "./classification-runner.js";
import { runVisualDna }            from "./visual-dna-engine.js";
import { runAndStoreStencilSelection }   from "./stencil-selection-runner.js";
import { runAndStoreStencilAssembly }    from "./stencil-assembly-runner.js";
import { runAndStoreMerge }        from "./merge-runner.js";
import { runAndStoreDeploymentPlan }     from "./deployment-plan-runner.js";
import { runDeploymentIntelligence }     from "./deployment-intelligence.js";
import { executeDeployment }       from "./deployment-executor.js";
import { generateRollbackPlan }    from "./rollback-plan-engine.js";
import { recordExecution, saveAuditToDisk } from "./deployment-audit-store.js";
import { runAndStoreConstruction } from "./construction-runner.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import { waitIfPaused, isCancelled, CancellationError } from "./pipeline-state-machine.js";
import { publishEvent } from "./event-bus.js";
import { runCertification } from "./certification-engine-c6.js";
import { db, orchestrationJobsTable, type InsertOrchestrationJob } from "../db/index.js";
import { loadBaselineManifest, computeDiff, computeSavingsReport } from "./diff-engine.js";
import { runIntelligenceLayer } from "./diff-intelligence.js";
import { getJobRecord } from "./db-queue.js";
import { classifyFailure } from "./failure-classifier.js";
import { executeRecovery } from "./autonomous-recovery-engine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MasterStageId =
  | "crawl"
  | "manifest"
  | "diff"
  | "intelligence"
  | "design-dna"
  | "visual-dna"
  | "stencil"
  | "website-prime"
  | "merge"
  | "deployment-plan"
  | "deploy"
  | "certification";

export type MasterStageStatus =
  | "pending"
  | "running"
  | "complete"
  | "failed"
  | "skipped"
  | "retrying";

export type MasterJobStatus =
  | "pending"
  | "running"
  | "complete"
  | "failed"
  | "cancelled";

export interface MasterStageResult {
  id: MasterStageId;
  label: string;
  status: MasterStageStatus;
  startedAt:   string | null;
  completedAt: string | null;
  durationMs:  number | null;
  retryCount:  number;
  maxRetries:  number;
  error:       string | null;
  metadata:    Record<string, unknown>;
}

export interface OrchestrationJob {
  id:                    string;
  url:                   string;
  includeDiff:           boolean;
  baseJobId:             string | null;
  status:                MasterJobStatus;
  currentStage:          MasterStageId | null;
  completedStages:       MasterStageId[];
  failedStages:          MasterStageId[];
  skippedStages:         MasterStageId[];
  stages:                MasterStageResult[];
  underlyingJobId:       string | null;
  deploymentExecutionId: string | null;
  startedAt:             string;
  completedAt:           string | null;
  totalDurationMs:       number | null;
  error:                 string | null;
  /** Minimum site coverage % (0–100) required before entering stencil phase. */
  coverageThreshold:     number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES    = 2;
const RETRY_BASE_MS  = 1_500;

const STAGE_LABELS: Record<MasterStageId, string> = {
  "crawl":           "Crawl — scrape all pages",
  "manifest":        "Manifest — verify content manifest",
  "diff":            "Diff — detect changes vs baseline",
  "intelligence":    "Intelligence — deployment environment analysis",
  "design-dna":      "Design DNA — archetype classification",
  "visual-dna":      "Visual DNA — layout & colour analysis",
  "stencil":         "Stencil — select & assemble stencil",
  "website-prime":   "Website Prime — generate site blueprint",
  "merge":           "Merge — compile merge plan",
  "deployment-plan": "Deployment Plan — multi-framework plan",
  "deploy":          "Deploy — execute & verify deployment",
  "certification":   "Certification — production readiness gate",
};

const ALL_STAGES: MasterStageId[] = [
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
];

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const _jobs = new Map<string, OrchestrationJob>();

export function getJob(id: string): OrchestrationJob | undefined {
  return _jobs.get(id);
}

export function listJobs(): OrchestrationJob[] {
  return Array.from(_jobs.values()).sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
}

// ---------------------------------------------------------------------------
// Disk paths
// ---------------------------------------------------------------------------

const ENGINE_PATH        = join(process.cwd(), "..", "..", "orchestration-engine.json");
const AUDIT_PATH         = join(process.cwd(), "..", "..", "orchestration-audit.json");
const ENGINE_PATH_LOCAL  = join(process.cwd(), "orchestration-engine.json");
const AUDIT_PATH_LOCAL   = join(process.cwd(), "orchestration-audit.json");

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persist(job: OrchestrationJob): Promise<void> {
  const json    = JSON.stringify(job, null, 2);
  const cloud   = getDefaultCloudProvider();

  const writes: Promise<unknown>[] = [
    writeFile(ENGINE_PATH,       json, "utf8").catch(() => {}),
    writeFile(ENGINE_PATH_LOCAL, json, "utf8").catch(() => {}),
  ];

  if (cloud.isConfigured()) {
    writes.push(
      cloud.upload({ key: "orchestration/orchestration-engine.json", data: Buffer.from(json, "utf8"), contentType: "application/json", checkDuplicate: false })
        .catch(() => {})
    );
  }

  // Persist to orchestration_jobs table (AD-2 fix)
  writes.push(
    (async () => {
      const statusMap: Record<string, string> = {
        pending:   "discovering",
        running:   "crawling",
        complete:  "complete",
        failed:    "failed",
        cancelled: "failed",
      };
      const row: InsertOrchestrationJob = {
        orchestrationId: job.id,
        url:             job.url,
        goal:            (job.includeDiff ? "update_existing" : "clone_site") as InsertOrchestrationJob["goal"],
        status:          (statusMap[job.status] ?? "discovering") as InsertOrchestrationJob["status"],
        executionPlan:   {
          goal:      job.includeDiff ? "update_existing" : "clone_site",
          reasoning: `Orchestrated via master pipeline (${job.stages.length} stages)`,
          stages:    job.stages.map((s) => ({
            name:        s.id as InsertOrchestrationJob["status"],
            status:      (s.status === "complete" ? "complete" : s.status === "failed" ? "failed" : s.status === "skipped" ? "skipped" : "pending") as "pending" | "running" | "complete" | "skipped" | "failed",
            startedAt:   s.startedAt ?? undefined,
            completedAt: s.completedAt ?? undefined,
            error:       s.error ?? undefined,
          })),
        },
        underlyingJobId: job.underlyingJobId,
        baseJobId:       job.baseJobId,
        errorMessage:    job.error,
        updatedAt:       new Date(),
        completedAt:     job.completedAt ? new Date(job.completedAt) : null,
      };
      await db
        .insert(orchestrationJobsTable)
        .values(row)
        .onConflictDoUpdate({
          target: orchestrationJobsTable.orchestrationId,
          set: {
            status:          row.status,
            executionPlan:   row.executionPlan,
            underlyingJobId: row.underlyingJobId,
            baseJobId:       row.baseJobId,
            errorMessage:    row.errorMessage,
            updatedAt:       row.updatedAt,
            completedAt:     row.completedAt,
          },
        });
    })().catch((err) => {
      logger.warn({ err, jobId: job.id }, "MASTER: DB persist failed (non-fatal)");
    })
  );

  await Promise.allSettled(writes);
}

async function persistAudit(): Promise<void> {
  const jobs = listJobs();
  const audit = {
    version:     "1.0",
    generatedAt: new Date().toISOString(),
    total:       jobs.length,
    summary: {
      complete: jobs.filter((j) => j.status === "complete").length,
      failed:   jobs.filter((j) => j.status === "failed").length,
      running:  jobs.filter((j) => j.status === "running").length,
    },
    jobs,
  };
  const json  = JSON.stringify(audit, null, 2);
  const cloud = getDefaultCloudProvider();

  const writes: Promise<unknown>[] = [
    writeFile(AUDIT_PATH,       json, "utf8").catch(() => {}),
    writeFile(AUDIT_PATH_LOCAL, json, "utf8").catch(() => {}),
  ];

  if (cloud.isConfigured()) {
    writes.push(
      cloud.upload({ key: "orchestration/orchestration-audit.json", data: Buffer.from(json, "utf8"), contentType: "application/json", checkDuplicate: false })
        .catch(() => {})
    );
  }

  await Promise.allSettled(writes);
}

// ---------------------------------------------------------------------------
// Stage helpers
// ---------------------------------------------------------------------------

function makeStages(includeDiff: boolean): MasterStageResult[] {
  return ALL_STAGES.map((id) => ({
    id,
    label:       STAGE_LABELS[id],
    status:      "pending" as MasterStageStatus,
    startedAt:   null,
    completedAt: null,
    durationMs:  null,
    retryCount:  0,
    maxRetries:  MAX_RETRIES,
    error:       null,
    metadata:    {},
  }));
}

function patchStage(
  job: OrchestrationJob,
  id: MasterStageId,
  patch: Partial<MasterStageResult>
): void {
  const idx = job.stages.findIndex((s) => s.id === id);
  if (idx !== -1) job.stages[idx] = { ...job.stages[idx]!, ...patch };
}

async function runWithRetry(
  job: OrchestrationJob,
  stageId: MasterStageId,
  fn: () => Promise<void | Record<string, unknown>>
): Promise<void> {
  const stage = job.stages.find((s) => s.id === stageId)!;
  const t0    = Date.now();

  patchStage(job, stageId, {
    status:    "running",
    startedAt: new Date().toISOString(),
    error:     null,
  });
  job.currentStage = stageId;
  await persist(job);

  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const wait = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      logger.warn({ jobId: job.id, stageId, attempt, wait }, "MASTER: retrying stage");
      patchStage(job, stageId, { status: "retrying", retryCount: attempt });
      await persist(job);
      await new Promise((r) => setTimeout(r, wait));
    }

    try {
      const meta = await fn();
      patchStage(job, stageId, {
        status:      "complete",
        completedAt: new Date().toISOString(),
        durationMs:  Date.now() - t0,
        retryCount:  attempt,
        error:       null,
        metadata:    (meta as Record<string, unknown>) ?? {},
      });
      job.completedStages.push(stageId);
      logger.info({ jobId: job.id, stageId, attempt, durationMs: Date.now() - t0 }, "MASTER: stage complete");
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      logger.warn({ jobId: job.id, stageId, attempt, err }, "MASTER: stage attempt failed");
    }
  }

  // All attempts exhausted
  patchStage(job, stageId, {
    status:      "failed",
    completedAt: new Date().toISOString(),
    durationMs:  Date.now() - t0,
    retryCount:  MAX_RETRIES,
    error:       lastErr?.message ?? "Unknown error",
  });
  job.failedStages.push(stageId);
  throw lastErr ?? new Error(`Stage ${stageId} failed`);
}

async function skipStage(job: OrchestrationJob, stageId: MasterStageId, reason: string): Promise<void> {
  const now = new Date().toISOString();
  patchStage(job, stageId, {
    status:      "skipped",
    startedAt:   now,
    completedAt: now,
    durationMs:  0,
    error:       null,
    metadata:    { reason },
  });
  job.skippedStages.push(stageId);
  await persist(job);
}

// ---------------------------------------------------------------------------
// Job factory
// ---------------------------------------------------------------------------

export function createJob(opts: {
  url:                string;
  baseJobId?:         string | null;
  coverageThreshold?: number;
}): OrchestrationJob {
  const id  = randomUUID();
  const now = new Date().toISOString();
  const job: OrchestrationJob = {
    id,
    url:                   opts.url,
    includeDiff:           !!opts.baseJobId,
    baseJobId:             opts.baseJobId ?? null,
    status:                "pending",
    currentStage:          null,
    completedStages:       [],
    failedStages:          [],
    skippedStages:         [],
    stages:                makeStages(!!opts.baseJobId),
    underlyingJobId:       null,
    deploymentExecutionId: null,
    startedAt:             now,
    completedAt:           null,
    totalDurationMs:       null,
    error:                 null,
    coverageThreshold:     opts.coverageThreshold ?? 0,
  };
  _jobs.set(id, job);
  return job;
}

// ---------------------------------------------------------------------------
// Stage runners
// ---------------------------------------------------------------------------

async function stageCrawl(job: OrchestrationJob): Promise<Record<string, unknown>> {
  const scrapeJobId = await submitScrapeJob({
    url:               job.url,
    includeImages:     true,
    diffMode:          job.includeDiff && !!job.baseJobId,
    baseJobId:         job.baseJobId ?? undefined,
    crawlAllPages:     true,
    coverageThreshold: job.coverageThreshold ?? 0,
  });
  job.underlyingJobId = scrapeJobId;
  await persist(job);
  logger.info({ jobId: job.id, scrapeJobId, crawlAllPages: true }, "MASTER[crawl]: job submitted, waiting…");
  await waitForJobCompletion(scrapeJobId, 3000, 90 * 60 * 1000);
  return { scrapeJobId };
}

async function stageManifest(job: OrchestrationJob): Promise<Record<string, unknown>> {
  if (!job.underlyingJobId) throw new Error("No underlying job ID — crawl stage must complete first");
  const manifest = await loadManifest(job.underlyingJobId);
  if (!manifest) throw new Error(`Manifest not found for job ${job.underlyingJobId}`);

  const pageCount  = manifest.nodes.size;
  const totalNodes = manifest.stats.totalNodes ?? pageCount;
  const completed  = manifest.stats.byStatus?.["complete"] ?? 0;
  const coveragePct = totalNodes > 0 ? Math.round((completed / totalNodes) * 100) : 0;

  logger.info(
    { jobId: job.id, pageCount, totalNodes, completed, coveragePct, threshold: job.coverageThreshold },
    "MASTER[manifest]: manifest verified"
  );

  // ── Coverage gate ────────────────────────────────────────────────────────
  // Block entry to stencil/rebuild phases until the required coverage is met.
  if (job.coverageThreshold > 0 && coveragePct < job.coverageThreshold) {
    throw new Error(
      `Coverage gate failed: achieved ${coveragePct}% but ${job.coverageThreshold}% is required. ` +
      `Scraped ${completed} of ${totalNodes} pages. Re-run the pipeline to continue crawling.`
    );
  }

  return { pageCount, seedUrl: manifest.seedUrl, coveragePct, totalNodes, completed };
}

async function stageDiff(job: OrchestrationJob): Promise<Record<string, unknown>> {
  if (!job.includeDiff || !job.baseJobId) {
    throw new Error("Diff stage reached but no baseJobId — should have been skipped");
  }
  if (!job.underlyingJobId) {
    throw new Error("Diff stage requires underlyingJobId (crawl must complete first)");
  }

  const cloud = getDefaultCloudProvider();
  const t0 = Date.now();

  // 1. Load both manifests
  const [newManifest, baseManifest] = await Promise.all([
    loadManifest(job.underlyingJobId),
    loadBaselineManifest(cloud, job.baseJobId),
  ]);

  if (!newManifest) {
    throw new Error(`No manifest found for new job ${job.underlyingJobId} — crawl may have failed`);
  }
  if (!baseManifest) {
    throw new Error(`No baseline manifest found for job ${job.baseJobId} — cannot compute diff`);
  }

  // 2. Compute diff and savings
  const diffReport    = computeDiff(baseManifest, newManifest, job.baseJobId, job.underlyingJobId);
  const savingsReport = computeSavingsReport(diffReport, Date.now() - t0);

  // 3. Run intelligence layer (persist to DB + upload R2 reports) — non-fatal
  try {
    const record = await getJobRecord(job.underlyingJobId);
    if (record) {
      await runIntelligenceLayer(record, diffReport, savingsReport, cloud);
    }
  } catch (err) {
    logger.warn({ err, jobId: job.id }, "MASTER[diff]: intelligence layer failed — continuing");
  }

  return {
    baseJobId:       job.baseJobId,
    newJobId:        job.underlyingJobId,
    new:             diffReport.summary.new,
    changed:         diffReport.summary.changed,
    unchanged:       diffReport.summary.unchanged,
    deleted:         diffReport.summary.deleted,
    skipRate:        `${(diffReport.summary.skipRate * 100).toFixed(1)}%`,
    bandwidthSaved:  savingsReport.bandwidthSavedBytes,
    processingMsSaved: savingsReport.processingTimeSavedMs,
  };
}

async function stageIntelligence(job: OrchestrationJob): Promise<Record<string, unknown>> {
  const cloud = getDefaultCloudProvider();
  const report = await runDeploymentIntelligence(job.url, job.underlyingJobId, cloud);
  return {
    deploymentRisk:     report.risk.deploymentRisk,
    compatibilityScore: report.risk.compatibilityScore,
    recommended:        report.recommended,
  };
}

async function stageDesignDna(job: OrchestrationJob): Promise<Record<string, unknown>> {
  if (!job.underlyingJobId) throw new Error("No underlying job ID");
  await runAndStoreClassification(job.underlyingJobId, getDefaultCloudProvider());
  return { jobId: job.underlyingJobId };
}

async function stageVisualDna(job: OrchestrationJob): Promise<Record<string, unknown>> {
  if (!job.underlyingJobId) throw new Error("No underlying job ID");
  const manifest = await loadManifest(job.underlyingJobId);
  if (!manifest) throw new Error(`Manifest not found for visual DNA stage`);
  const result = await runVisualDna(job.underlyingJobId, manifest);
  return {
    pagesAnalyzed:     result.pagesAnalyzed,
    pagesSkipped:      result.pagesSkipped,
    overallConfidence: result.overallConfidence,
  };
}

async function stageStencil(job: OrchestrationJob): Promise<Record<string, unknown>> {
  if (!job.underlyingJobId) throw new Error("No underlying job ID");
  const cloud = getDefaultCloudProvider();
  await runAndStoreStencilSelection(job.underlyingJobId, cloud);
  await runAndStoreStencilAssembly(job.underlyingJobId, cloud).catch((err) => {
    logger.warn({ err, jobId: job.id }, "MASTER[stencil]: assembly non-fatal — continuing");
  });
  return { jobId: job.underlyingJobId };
}

async function stageWebsitePrime(job: OrchestrationJob): Promise<Record<string, unknown>> {
  if (!job.underlyingJobId) throw new Error("No underlying job ID");
  await runAndStoreGenerationPipeline(job.underlyingJobId, getDefaultCloudProvider());
  await runAndStoreConstruction(job.underlyingJobId).catch((err) => {
    logger.warn({ err, jobId: job.id }, "MASTER[website-prime]: construction non-fatal — continuing");
  });

  // ── P0-2: Auto-trigger VR-1…VR-8 visual pipeline ────────────────────────
  // Fires asynchronously after website-prime so it never blocks pipeline
  // progression into merge/deployment-plan/deploy.
  const jobId = job.underlyingJobId;
  setImmediate(() => {
    Promise.all([
      import("./visual-pipeline-orchestrator.js"),
      import("./manifest-store.js"),
    ]).then(async ([{ runVisualPipeline }, { loadManifest }]) => {
      const manifest = await loadManifest(jobId);
      if (manifest) {
        await runVisualPipeline(jobId, manifest).catch((err) => {
          logger.warn({ jobId, err }, "MASTER[website-prime]: visual pipeline auto-run failed (non-fatal)");
        });
      }
    }).catch(() => {});
  });

  return { jobId: job.underlyingJobId };
}

async function stageMerge(job: OrchestrationJob): Promise<Record<string, unknown>> {
  if (!job.underlyingJobId) throw new Error("No underlying job ID");
  await runAndStoreMerge(job.underlyingJobId, getDefaultCloudProvider());
  return { jobId: job.underlyingJobId };
}

async function stageDeploymentPlan(job: OrchestrationJob): Promise<Record<string, unknown>> {
  if (!job.underlyingJobId) throw new Error("No underlying job ID");
  await runAndStoreDeploymentPlan(job.underlyingJobId, getDefaultCloudProvider());
  return { jobId: job.underlyingJobId };
}

async function stageDeploy(job: OrchestrationJob): Promise<Record<string, unknown>> {
  if (!job.underlyingJobId) throw new Error("No underlying job ID");
  const cloud = getDefaultCloudProvider();

  const execution = await executeDeployment({
    jobId:     job.underlyingJobId,
    framework: null,
    target:    "r2-static",
  });
  recordExecution(execution);
  await saveAuditToDisk().catch(() => {});

  job.deploymentExecutionId = execution.id;
  await persist(job);

  // Phase 6.5 gate — generate rollback plan for every deployment
  await generateRollbackPlan(execution, cloud).catch((err) => {
    logger.warn({ err, jobId: job.id }, "MASTER[deploy]: rollback plan non-fatal");
  });

  if (execution.status === "failed") {
    throw new Error(`Deployment execution failed: ${execution.error ?? "unknown"}`);
  }

  return {
    executionId:   execution.id,
    status:        execution.status,
    deploymentUrl: execution.deploymentUrl,
    filesDeployed: execution.filesDeployed,
  };
}

async function stageCertification(job: OrchestrationJob): Promise<Record<string, unknown>> {
  if (!job.underlyingJobId) throw new Error("No underlying job ID");
  const bundle = await runCertification({ jobId: job.underlyingJobId });
  return {
    certificationId:    bundle.certification.certificationId,
    certificationLevel: bundle.certification.certificationLevel,
    overallGrade:       bundle.certification.overallGrade,
    overallScore:       bundle.certification.overallScore,
  };
}

// ---------------------------------------------------------------------------
// Main pipeline runner (runs async — caller polls)
// ---------------------------------------------------------------------------

export async function runPipeline(job: OrchestrationJob): Promise<void> {
  const t0 = Date.now();
  job.status = "running";
  await persist(job);

  logger.info({ jobId: job.id, url: job.url, includeDiff: job.includeDiff }, "MASTER: pipeline started");
  publishEvent("job-started", job.id, { url: job.url, includeDiff: job.includeDiff });

  /**
   * Gate helper — called before every stage.
   * Waits if paused (Phase 7.2 control plane), throws CancellationError if cancelled.
   */
  async function gate(stageId: MasterStageId): Promise<void> {
    await waitIfPaused(job.id);
    if (isCancelled(job.id)) {
      throw new CancellationError(`Pipeline ${job.id} cancelled before stage ${stageId}`);
    }
  }

  try {
    // 1. crawl
    await gate("crawl");
    publishEvent("crawl-started", job.id, { url: job.url }, "crawl");
    await runWithRetry(job, "crawl", () => stageCrawl(job));
    await persist(job);

    // 2. manifest
    await gate("manifest");
    await runWithRetry(job, "manifest", () => stageManifest(job));
    publishEvent("manifest-generated", job.id, { scrapeJobId: job.underlyingJobId }, "manifest");
    await persist(job);

    // 3. diff (skip if no baseJobId)
    await gate("diff");
    if (job.includeDiff && job.baseJobId) {
      await runWithRetry(job, "diff", () => stageDiff(job));
      publishEvent("diff-computed", job.id, { baseJobId: job.baseJobId }, "diff");
    } else {
      await skipStage(job, "diff", "No baseline job provided — diff not required");
    }
    await persist(job);

    // 4. intelligence
    await gate("intelligence");
    await runWithRetry(job, "intelligence", () => stageIntelligence(job));
    publishEvent("intelligence-complete", job.id, {}, "intelligence");
    await persist(job);

    // 5. design-dna
    await gate("design-dna");
    await runWithRetry(job, "design-dna", () => stageDesignDna(job));
    publishEvent("design-dna-complete", job.id, {}, "design-dna");
    await persist(job);

    // 6. visual-dna
    await gate("visual-dna");
    await runWithRetry(job, "visual-dna", () => stageVisualDna(job));
    publishEvent("visual-dna-complete", job.id, {}, "visual-dna");
    await persist(job);

    // 7. stencil
    await gate("stencil");
    await runWithRetry(job, "stencil", () => stageStencil(job));
    publishEvent("stencil-generated", job.id, {}, "stencil");
    await persist(job);

    // 8. website-prime
    await gate("website-prime");
    await runWithRetry(job, "website-prime", () => stageWebsitePrime(job));
    publishEvent("website-prime-complete", job.id, {}, "website-prime");
    await persist(job);

    // 9. merge
    await gate("merge");
    await runWithRetry(job, "merge", () => stageMerge(job));
    publishEvent("merge-complete", job.id, {}, "merge");
    await persist(job);

    // 10. deployment-plan
    await gate("deployment-plan");
    await runWithRetry(job, "deployment-plan", () => stageDeploymentPlan(job));
    publishEvent("deployment-plan-ready", job.id, {}, "deployment-plan");
    await persist(job);

    // 11. deploy
    await gate("deploy");
    await runWithRetry(job, "deploy", () => stageDeploy(job));
    publishEvent("deployment-complete", job.id, { executionId: job.deploymentExecutionId }, "deploy");
    await persist(job);

    // 12. certification (Stage 19 — Production Certification)
    await gate("certification");
    await runWithRetry(job, "certification", () => stageCertification(job));
    publishEvent("certification-complete", job.id, {}, "certification");
    await persist(job);

    // Done
    job.status          = "complete";
    job.currentStage    = null;
    job.completedAt     = new Date().toISOString();
    job.totalDurationMs = Date.now() - t0;
    publishEvent("job-complete", job.id, { durationMs: job.totalDurationMs });
    logger.info({ jobId: job.id, durationMs: job.totalDurationMs }, "MASTER: pipeline complete");
  } catch (err) {
    const isCancelErr   = err instanceof CancellationError;
    const msg           = err instanceof Error ? err.message : String(err);
    const stack         = err instanceof Error ? (err.stack ?? null) : null;
    job.status          = "failed";
    job.error           = isCancelErr ? `Cancelled: ${msg}` : msg;
    job.completedAt     = new Date().toISOString();
    job.totalDurationMs = Date.now() - t0;
    if (isCancelErr) {
      publishEvent("job-cancelled", job.id, { stage: job.currentStage, reason: msg });
      logger.info({ jobId: job.id, currentStage: job.currentStage }, "MASTER: pipeline cancelled");
    } else {
      publishEvent("job-failed", job.id, { stage: job.currentStage, error: msg });
      logger.error({ jobId: job.id, err, currentStage: job.currentStage }, "MASTER: pipeline failed");

      // ── Phase H: auto-invoke F3 recovery when the crawl stage fails
      // (the underlying scrape job is the only entity F3 can operate on)
      if (job.underlyingJobId && (job.currentStage === "crawl" || job.currentStage === "manifest")) {
        try {
          const scrapeRecord = await getJobRecord(job.underlyingJobId);
          const classification = classifyFailure({
            jobId:        job.underlyingJobId,
            seedUrl:      job.url,
            errorMessage: msg,
            errorStack:   stack,
            retryCount:   scrapeRecord?.retryCount  ?? 0,
            maxRetries:   scrapeRecord?.maxRetries  ?? 3,
          });
          logger.info(
            { jobId: job.id, underlyingJobId: job.underlyingJobId, failureClass: classification.failureClass, stage: job.currentStage },
            "MASTER: auto-triggering F3 recovery",
          );
          // Non-blocking — recovery is best-effort
          void executeRecovery(classification).catch((recErr) => {
            logger.warn({ err: recErr, jobId: job.underlyingJobId }, "MASTER: F3 auto-recovery failed (non-fatal)");
          });
        } catch (recErr) {
          logger.warn({ err: recErr, jobId: job.id }, "MASTER: could not classify failure for F3 auto-recovery");
        }
      }
    }
  }

  await persist(job);
  await persistAudit();
}

// ---------------------------------------------------------------------------
// Audit file loaders (for GET endpoints)
// ---------------------------------------------------------------------------

export async function readEngineFile(): Promise<OrchestrationJob | null> {
  try {
    const raw = await readFile(ENGINE_PATH, "utf8");
    return JSON.parse(raw) as OrchestrationJob;
  } catch {
    try {
      const raw = await readFile(ENGINE_PATH_LOCAL, "utf8");
      return JSON.parse(raw) as OrchestrationJob;
    } catch { return null; }
  }
}

export async function readAuditFile(): Promise<unknown> {
  try {
    const raw = await readFile(AUDIT_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    try {
      const raw = await readFile(AUDIT_PATH_LOCAL, "utf8");
      return JSON.parse(raw);
    } catch { return null; }
  }
}
