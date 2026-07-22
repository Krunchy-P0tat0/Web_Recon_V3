import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db, scrapeJobsTable } from "@workspace/db";
import { logger } from "./logger";
import {
  claimNextJob,
  updateJobProgress,
  markJobDone,
  markJobFailed,
  recoverInterruptedJobs,
  getQueueDepth,
  listAllJobs,
  type ScrapeJobRecord,
} from "./db-queue";
import { saveManifest, loadManifest } from "./manifest-store";
import { cloudStorage } from "./cloud-storage";
import {
  uploadPreZip,
  verifyR2Uploads,
  uploadZipToR2,
} from "./r2-executor";
import { getDefaultCloudProvider } from "../cloud";
import { createJobFromRecord, runScrapeJob, scrapeLinks } from "./scraper";
import type { ArticleLink } from "./scraper";
import { getAuditLogger } from "./audit-logger";
import type { Manifest } from "./manifest";
import type { MediaBufferStore } from "./media-pipeline";
import { PipelineOrchestrator } from "./pipeline-orchestrator";
import {
  runManifestVerification,
  validateRestorableJob,
  ManifestVerificationError,
  RestorabilityEnforcementError,
} from "./manifest-verifier";
import { renderManifestJson } from "./manifest-export";
import {
  loadBaselineManifest,
  findLatestBaselineJobId,
  computeDiff,
  computeSavingsReport,
} from "./diff-engine";
import {
  buildDeltaZip,
  buildMergedZip,
  uploadDiffZips,
} from "./diff-zip";
import { runIntelligenceLayer } from "./diff-intelligence";
import { runAndStoreGenerationPipeline } from "./generation-runner";
import { runPhase6Pipeline } from "./phase6-runner";
import { runWebsitePrimeIndexer } from "./website-prime-indexer";
import { startJobSupervisor, stopJobSupervisor } from "./job-supervisor.js";
import { classifyFailure, loadPersistedClassifications } from "./failure-classifier.js";
import { executeRecovery, loadPersistedRecoveryActions } from "./autonomous-recovery-engine.js";
import {
  loadCheckpoint,
  computeResumeList,
  finalizeCheckpoint,
} from "./checkpoint-engine.js";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const WORKER_ID = `worker-${randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------------------
// Cloud provider — created once at module load; isConfigured() is false when
// credentials are absent so all cloud operations become no-ops.
// ---------------------------------------------------------------------------

// Auto-selects provider from CLOUD_PROVIDER env var.
// Set CLOUD_PROVIDER=local (+ optionally LOCAL_CLOUD_DIR) for testing without R2.
// Set CLOUD_PROVIDER=r2 (+ R2_* vars) for production Cloudflare R2.
// Defaults to R2 if creds present, local if LOCAL_CLOUD_DIR set, noop otherwise.
const cloudProvider = getDefaultCloudProvider();

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS        = 2_000;
const PROGRESS_SYNC_INTERVAL_MS = 3_000;
const MAX_CONCURRENT_JOBS     = 2;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let active   = false;
let inFlight = 0;

export async function startWorkerLoop(): Promise<void> {
  if (active) return;
  active = true;

  // Load persisted failure classifications so the classifier survives restarts.
  await loadPersistedClassifications().catch(() => {});

  // Load persisted F3 recovery actions so the recovery engine survives restarts.
  await loadPersistedRecoveryActions().catch(() => {});

  // Start the Job Supervisor (F1) — runs above the scheduler.
  // startJobSupervisor is safe to call concurrently with job processing.
  startJobSupervisor().catch((err) => {
    logger.warn({ err }, "WORKER: job supervisor startup error (non-fatal)");
  });

  // Recover any jobs that were mid-flight when the process last crashed.
  // These are reset to 'queued' so they are picked up immediately and run
  // again — safe because runScrapeJob has ZIP idempotency built in.
  const recovered = await recoverInterruptedJobs();
  if (recovered > 0) {
    logger.warn(
      { recovered, workerId: WORKER_ID },
      "WORKER: crash-recovered jobs re-queued"
    );
  }

  const depth = await getQueueDepth();
  logger.info(
    { workerId: WORKER_ID, ...depth },
    "WORKER: background job loop started"
  );

  scheduleNext();
}

export function stopWorkerLoop(): void {
  active = false;
  stopJobSupervisor();
  logger.info({ workerId: WORKER_ID }, "WORKER: shutdown signal received");
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

function scheduleNext(): void {
  if (!active) return;
  if (inFlight >= MAX_CONCURRENT_JOBS) {
    setTimeout(scheduleNext, POLL_INTERVAL_MS);
    return;
  }

  setImmediate(async () => {
    try {
      const record = await claimNextJob(WORKER_ID);
      if (record) {
        inFlight++;
        processJobRecord(record)
          .catch((err) =>
            logger.error(
              { err, jobId: record.jobId },
              "WORKER: unhandled job error"
            )
          )
          .finally(() => {
            inFlight--;
            scheduleNext();
          });
        // Poll immediately — there may be more queued jobs
        scheduleNext();
      } else {
        setTimeout(scheduleNext, POLL_INTERVAL_MS);
      }
    } catch (err) {
      logger.error({ err }, "WORKER: poll error");
      setTimeout(scheduleNext, POLL_INTERVAL_MS);
    }
  });
}

// ---------------------------------------------------------------------------
// Job processing
// ---------------------------------------------------------------------------

async function processJobRecord(record: ScrapeJobRecord): Promise<void> {
  logger.info(
    {
      jobId: record.jobId,
      workerId: WORKER_ID,
      retryCount: record.retryCount,
      totalArticles: record.totalArticles,
    },
    "WORKER: job started"
  );

  let articles = parseArticles(record.articlesJson);

  // ── Link discovery ───────────────────────────────────────────────────────
  // When a job is submitted with empty articles (e.g. from the orchestrator),
  // run scrapeLinks first to build the full URL list before scraping content.
  if (articles.length === 0) {
    logger.info(
      { jobId: record.jobId, seedUrl: record.seedUrl, crawlAllPages: record.crawlAllPages },
      "WORKER: no pre-discovered articles — running link discovery"
    );
    try {
      const discovered = await scrapeLinks(record.seedUrl, record.crawlAllPages ?? false);
      articles = discovered.links;
      logger.info(
        { jobId: record.jobId, discovered: articles.length, frontierStats: discovered.frontierStats },
        "WORKER: link discovery complete"
      );
      // Persist discovered articles + total back to DB so retries don't re-discover
      await db
        .update(scrapeJobsTable)
        .set({
          articlesJson:  JSON.stringify(articles),
          totalArticles: articles.length,
          updatedAt:     new Date(),
        })
        .where(eq(scrapeJobsTable.jobId, record.jobId));
      record.articlesJson  = JSON.stringify(articles);
      record.totalArticles = articles.length;
    } catch (discoverErr) {
      const discoverErrMsg = `Link discovery failed: ${discoverErr instanceof Error ? discoverErr.message : String(discoverErr)}`;
      logger.error({ err: discoverErr, jobId: record.jobId }, "WORKER: link discovery failed");
      classifyFailure({
        jobId:        record.jobId,
        seedUrl:      record.seedUrl,
        errorMessage: discoverErrMsg,
        errorStack:   discoverErr instanceof Error ? (discoverErr.stack ?? null) : null,
        retryCount:   record.retryCount,
        maxRetries:   record.maxRetries,
      });
      await markJobFailed(record.jobId, discoverErrMsg, record.retryCount, record.maxRetries);
      return;
    }
  }

  // ── Phase F4: Checkpoint Resume ─────────────────────────────────────────
  // If a prior run was interrupted, restore from the last valid checkpoint
  // and skip already-completed URLs — never restart from zero.
  const f4Checkpoint = await loadCheckpoint(record.jobId).catch(() => null);
  if (f4Checkpoint && f4Checkpoint.completedUrls.length > 0 && articles.length > 0) {
    const resumeList = computeResumeList(record.jobId, record.seedUrl, articles, f4Checkpoint);
    if (resumeList.length < articles.length) {
      logger.info(
        {
          jobId: record.jobId,
          originalCount: articles.length,
          resumeCount: resumeList.length,
          skipped: articles.length - resumeList.length,
          coverage: f4Checkpoint.coverageState.coveragePercent,
        },
        "WORKER: F4 checkpoint resume — skipping completed URLs"
      );
      articles = resumeList;
    }
  }

  // Register an in-memory ScrapeJob for hot-path status reads
  const job = createJobFromRecord(record);

  // ── Load manifest checkpoint for crash-recovery resume ──────────────────
  // On a fresh job loadManifest returns null and runScrapeJob runs normally.
  const checkpoint = await loadManifest(record.jobId).catch(() => null);
  if (checkpoint && checkpoint.nodes.size > 1) {
    logger.info(
      {
        jobId: record.jobId,
        checkpointNodes: checkpoint.nodes.size,
        checkpointStatus: checkpoint.status,
      },
      "WORKER: found persisted manifest checkpoint — resuming from last state"
    );
  }

  // ── Pipeline orchestrator ────────────────────────────────────────────────
  // Load a previous execution manifest (if any) for stage-level resume.
  // Falls back to a fresh orchestrator when no checkpoint exists.
  const orchestrator =
    (await PipelineOrchestrator.load(record.jobId, WORKER_ID).catch(() => null)) ??
    new PipelineOrchestrator(record.jobId, WORKER_ID);

  logger.info(
    {
      jobId: record.jobId,
      workerId: WORKER_ID,
      pipelineStatus: orchestrator.getExecution().pipelineStatus,
      retryAttempt: orchestrator.getExecution().retryAttempt,
      lastSuccessfulStage: orchestrator.getExecution().lastSuccessfulStage,
    },
    "WORKER: pipeline orchestrator ready"
  );

  // Periodic DB progress sync so the status endpoint reflects live progress
  const syncInterval = setInterval(async () => {
    await updateJobProgress(record.jobId, {
      completedArticles: job.completed,
      currentArticle: job.currentArticle ?? null,
    });
  }, PROGRESS_SYNC_INTERVAL_MS);

  // ── Incremental manifest persistence ────────────────────────────────────
  // Called at each phase boundary inside runScrapeJob.
  const onManifestSave = async (manifest: Manifest): Promise<void> => {
    await saveManifest(record.jobId, manifest);
    logger.debug(
      {
        jobId: record.jobId,
        manifestStatus: manifest.status,
        nodeCount: manifest.nodes.size,
        workerId: WORKER_ID,
      },
      "WORKER: manifest snapshot persisted"
    );
  };

  // ── Pre-finalize callback: Stages 7 (cloud_upload) + 8 (verification) ───
  //
  // Invoked inside runScrapeJob between Phase 2 (media download) and
  // ZIP finalization. Media buffers are still live in memory here, giving
  // cloud upload direct access to raw file content without reading the ZIP.
  //
  // CONTRACT: this callback MUST NOT throw. All errors are handled
  // internally so that zip_generation (Stage 9) can always proceed —
  // both cloud_upload and verification will always reach "completed" or
  // "skipped" status when this function returns.
  const onPreFinalize = async (
    manifest: Manifest,
    mediaBuffers: MediaBufferStore
  ): Promise<void> => {
    if (!cloudProvider.isConfigured()) {
      await orchestrator.skipStage("cloud_upload", "Cloud provider not configured").catch(() => {});
      await orchestrator.skipStage("verification", "Cloud provider not configured").catch(() => {});
      return;
    }

    // ── Stage 7: cloud_upload ──────────────────────────────────────────────
    // Uploads article HTML, embed JSON, and image buffers to R2 before the
    // ZIP is sealed. Uses manifest-derived cloud paths (never re-derives them).
    // Partial upload failures are logged as warnings but do not fail the stage.
    try {
      await orchestrator.beginStage("cloud_upload");
      const uploadReport = await uploadPreZip(cloudProvider, manifest, mediaBuffers, record.jobId);

      if (!uploadReport.valid) {
        logger.warn(
          {
            jobId: record.jobId,
            failedCount: uploadReport.failedUploads.length,
            uploadedFiles: uploadReport.uploadedFiles,
          },
          "WORKER: cloud_upload completed with partial failures (non-fatal)"
        );
      }

      await orchestrator.completeStage("cloud_upload");

      logger.info(
        {
          jobId: record.jobId,
          uploadedFiles: uploadReport.uploadedFiles,
          uploadedBytes: uploadReport.uploadedBytes,
          skippedFiles: uploadReport.skippedFiles,
          failedCount: uploadReport.failedUploads.length,
          durationMs: uploadReport.uploadDurationMs,
          valid: uploadReport.valid,
        },
        "WORKER: Stage 7 cloud_upload complete"
      );

      // ── Audit: record upload results ────────────────────────────────────────
      {
        const _al = getAuditLogger(record.jobId);
        if (_al) {
          _al.setUploadReport({
            filesUploaded: uploadReport.uploadedFiles,
            uploadedBytes: uploadReport.uploadedBytes,
            filesFailed: (uploadReport.failedUploads as unknown[]).length,
            skippedFiles: uploadReport.skippedFiles,
            valid: uploadReport.valid,
            durationMs: uploadReport.uploadDurationMs,
            failedUploads: (uploadReport.failedUploads as unknown as Array<Record<string, unknown>>).map(
              (u) => ({ key: String(u["key"] ?? u["path"] ?? ""), reason: String(u["reason"] ?? "unknown") })
            ),
          });
        }
      }
    } catch (err) {
      // uploadPreZip threw — mark cloud_upload as skipped (not failed)
      // so verification can also be skipped and zip_generation proceeds.
      logger.warn(
        { err, jobId: record.jobId },
        "WORKER: cloud_upload threw unexpectedly (non-fatal) — skipping verification"
      );
      await orchestrator.skipStage(
        "cloud_upload",
        `exception: ${err instanceof Error ? err.message : String(err)}`
      ).catch(() => {});
      await orchestrator.skipStage(
        "verification",
        "skipped — upstream cloud_upload failed"
      ).catch(() => {});
      return; // zip_generation can proceed
    }

    // ── Stage 8: verification ──────────────────────────────────────────────
    // HEAD checks on critical cloud keys to confirm Stage 7 uploads landed.
    // Missing keys are logged as warnings but do not fail the stage — the
    // pipeline must not be blocked by transient R2 propagation delays.
    try {
      await orchestrator.beginStage("verification");
      const verifyReport = await verifyR2Uploads(cloudProvider, manifest, record.jobId);

      if (!verifyReport.valid) {
        logger.warn(
          {
            jobId: record.jobId,
            missingKeys: verifyReport.missingKeys,
            missing: verifyReport.missing,
            checked: verifyReport.checked,
          },
          "WORKER: R2 verification: some keys not found (non-fatal)"
        );
      }

      await orchestrator.completeStage("verification");

      logger.info(
        {
          jobId: record.jobId,
          checked: verifyReport.checked,
          verified: verifyReport.verified,
          missing: verifyReport.missing,
          valid: verifyReport.valid,
          durationMs: verifyReport.durationMs,
        },
        "WORKER: Stage 8 verification complete"
      );

      // ── Audit: record verification results ─────────────────────────────────
      {
        const _alV = getAuditLogger(record.jobId);
        if (_alV) {
          _alV.setVerifyReport({
            checked: verifyReport.checked,
            verified: verifyReport.verified,
            missing: verifyReport.missing,
            valid: verifyReport.valid,
            durationMs: verifyReport.durationMs,
            missingKeys: verifyReport.missingKeys,
          });
        }
      }
    } catch (err) {
      // verifyR2Uploads threw — skip rather than fail so zip_generation proceeds
      logger.warn(
        { err, jobId: record.jobId },
        "WORKER: verification threw unexpectedly (non-fatal)"
      );
      await orchestrator.skipStage(
        "verification",
        `exception: ${err instanceof Error ? err.message : String(err)}`
      ).catch(() => {});
    }
  };

  // ── Main execution try/catch ─────────────────────────────────────────────
  try {
    // Stages 1–9 are orchestrated inside runScrapeJob via the orchestrator
    // and onPreFinalize hook. Stages 10–11 run below.
    await runScrapeJob(
      record.jobId,
      record.seedUrl,
      articles,
      record.includeImages,
      onManifestSave,
      checkpoint ?? undefined,
      orchestrator,
      onPreFinalize
    );

    clearInterval(syncInterval);

    // Final progress flush
    await updateJobProgress(record.jobId, {
      completedArticles: job.completed,
      currentArticle: null,
    });

    // ── Stage 10: manifest_verification ───────────────────────────────────
    // FATAL gate: if _manifest.json is absent, empty, or invalid in R2,
    // this stage throws ManifestVerificationError which propagates to the
    // outer catch → markJobFailed. The job must NOT be marked COMPLETE.
    //
    // When cloud is not configured the stage is skipped (vacuously passes)
    // so local-only jobs still reach persistence_commit and COMPLETE.
    if (!cloudProvider.isConfigured()) {
      await orchestrator
        .skipStage(
          "manifest_verification",
          "Cloud provider not configured — skipping manifest verification"
        )
        .catch(() => {});
      logger.debug(
        { jobId: record.jobId },
        "WORKER: Stage 10 manifest_verification skipped (no cloud provider)"
      );
    } else {
      // ── Emergency manifest re-upload guard ──────────────────────────────
      // If Stage 7 (cloud_upload) completed but failed to upload _manifest.json
      // (e.g. renderManifestJson threw, transient R2 error, or pipeline resumed
      // from a prior run and skipped Stage 7), attempt an idempotent re-upload
      // from the local checkpoint BEFORE Stage 10 verification runs.
      // This prevents ManifestVerificationError on otherwise healthy jobs.
      {
        const manifestR2Key = `jobs/${record.jobId}/_manifest.json`;
        const alreadyInR2 = await cloudProvider.verify(manifestR2Key).catch(() => false);
        if (!alreadyInR2) {
          logger.warn(
            { jobId: record.jobId, r2Key: manifestR2Key },
            "WORKER: _manifest.json absent from R2 before Stage 10 — attempting emergency re-upload"
          );
          const emergencyManifest = await loadManifest(record.jobId).catch(() => null);
          if (emergencyManifest) {
            try {
              const emergencyJson = renderManifestJson(emergencyManifest);
              await cloudProvider.upload({
                key: manifestR2Key,
                data: Buffer.from(emergencyJson, "utf8"),
                contentType: "application/json",
                checkDuplicate: false,
              });
              logger.info(
                { jobId: record.jobId },
                "WORKER: emergency manifest re-upload succeeded — Stage 10 can proceed"
              );
            } catch (emergencyErr) {
              logger.warn(
                { jobId: record.jobId, err: emergencyErr },
                "WORKER: emergency manifest re-upload failed — Stage 10 will likely fail"
              );
            }
          } else {
            logger.warn(
              { jobId: record.jobId },
              "WORKER: no local manifest checkpoint for emergency re-upload — Stage 10 will likely fail"
            );
          }
        }
      }

      await orchestrator.beginStage("manifest_verification");
      try {
        const mvResult = await runManifestVerification(cloudProvider, record.jobId);

        await orchestrator.completeStage("manifest_verification");

        logger.info(
          {
            jobId: record.jobId,
            nodeCount: mvResult.nodeCount,
            byteSize: mvResult.byteSize,
            schemaVersion: mvResult.schemaVersion,
            durationMs: mvResult.durationMs,
          },
          "WORKER: Stage 10 manifest_verification passed"
        );

        const _alMV = getAuditLogger(record.jobId);
        if (_alMV) {
          _alMV.setManifestVerificationResult(mvResult);
        }
      } catch (mvErr) {
        // FATAL — mark the stage failed then re-throw so the outer catch
        // calls markJobFailed instead of markJobDone.
        await orchestrator
          .failStage(
            "manifest_verification",
            mvErr instanceof Error ? mvErr : new Error(String(mvErr))
          )
          .catch(() => {});
        throw mvErr;
      }
    }

    // ── Stage 11: persistence_commit ──────────────────────────────────────
    await orchestrator.beginStage("persistence_commit");

    try {
      // Optional legacy cloud upload (no-op unless CLOUD_STORAGE_ENABLED)
      if (job.zipPath && cloudStorage.isEnabled()) {
        const cloudUrl = await cloudStorage.uploadWithRetry(
          job.zipPath,
          `zips/${record.jobId}.zip`,
          3
        );
        if (cloudUrl) {
          logger.info(
            { jobId: record.jobId, cloudUrl },
            "WORKER: ZIP uploaded via legacy cloud storage"
          );
        }
      }

      // Upload the finalized ZIP to cloud storage (separate from pre-ZIP media upload)
      if (job.zipPath && cloudProvider.isConfigured()) {
        const finalManifest = await loadManifest(record.jobId).catch(() => null);
        if (finalManifest) {
          await uploadZipToR2(cloudProvider, job.zipPath, finalManifest, record.jobId);
          // Persist manifest with updated r2Upload report
          await saveManifest(record.jobId, finalManifest);
        } else {
          logger.warn(
            { jobId: record.jobId },
            "WORKER: ZIP cloud upload skipped — could not reload final manifest"
          );
        }
      } else if (!cloudProvider.isConfigured()) {
        logger.debug(
          { jobId: record.jobId },
          "WORKER: cloud provider not configured — skipping ZIP upload"
        );
      }

      // ── Stage 11: Restorability gate (FATAL) ───────────────────────────
      // Verifies all 3 required R2 artifacts exist with valid content:
      //   jobs/{jobId}/_manifest.json — downloaded + parsed + nodeCount > 0
      //   jobs/{jobId}/_manifest.zip  — exists in R2
      //   jobs/{jobId}/index.html     — downloaded + size > 0
      //
      // If any artifact is missing or invalid the job MUST NOT become DONE.
      // RestorabilityEnforcementError propagates to the outer catch which
      // calls markJobFailed — the job status becomes "error".
      if (cloudProvider.isConfigured()) {
        const restoreResult = await validateRestorableJob(
          cloudProvider,
          record.jobId
        );
        const _alR = getAuditLogger(record.jobId);
        if (_alR) {
          _alR.setRestorabilityResult(restoreResult);
        }
        if (!restoreResult.restorable) {
          throw new RestorabilityEnforcementError(
            record.jobId,
            restoreResult.missingArtifacts,
            restoreResult.verificationGrade
          );
        }
      }

      // ── Diff post-processing ─────────────────────────────────────────────
      // When the job was submitted as a differential crawl, run the diff
      // engine now (after the standard pipeline) and upload delta + merged ZIPs.
      // Failures here are non-fatal — the job still completes normally.
      if (record.diffMode && cloudProvider.isConfigured()) {
        try {
          const diffJobStartMs = Date.now();

          // 1. Resolve baseline job ID (explicit or auto-detected)
          let baseJobId: string | null = record.baseJobId ?? null;
          if (!baseJobId) {
            baseJobId = await findLatestBaselineJobId(
              record.seedUrl,
              record.jobId,
              async () => {
                const allJobs = await listAllJobs(200);
                return allJobs.map(j => ({
                  jobId: j.jobId,
                  seedUrl: j.seedUrl,
                  status: j.status,
                  createdAt: j.createdAt.toISOString(),
                }));
              }
            );
          }

          if (!baseJobId) {
            logger.warn(
              { jobId: record.jobId },
              "WORKER: diff mode — no baseline job found, treating all nodes as NEW"
            );
          } else {
            // 2. Load baseline manifest
            const baseManifest = await loadBaselineManifest(cloudProvider, baseJobId);

            if (baseManifest) {
              const newManifest = await loadManifest(record.jobId).catch(() => null);

              if (newManifest) {
                // 3. Compute diff (stamps classification onto newManifest nodes in-place)
                const diffReport = computeDiff(baseManifest, newManifest, baseJobId, record.jobId);

                // 4. Build delta ZIP and merged ZIP
                const articles = parseArticles(record.articlesJson);
                const [deltaBuffer, mergedBuffer] = await Promise.all([
                  buildDeltaZip(newManifest, diffReport),
                  buildMergedZip(newManifest, diffReport, articles),
                ]);

                // 5. Upload both ZIPs + reports to R2
                const zipReport = await uploadDiffZips(
                  cloudProvider,
                  record.jobId,
                  baseJobId,
                  deltaBuffer,
                  mergedBuffer,
                  diffReport
                );

                // 6. Upload differential-report.json and savings-report.json
                const actualRebuildMs = Date.now() - diffJobStartMs;
                const savingsReport = computeSavingsReport(diffReport, actualRebuildMs);

                await Promise.all([
                  cloudProvider.upload({
                    key: `jobs/${record.jobId}/_diff-report.json`,
                    data: Buffer.from(JSON.stringify(diffReport, null, 2), "utf8"),
                    contentType: "application/json",
                    checkDuplicate: false,
                  }).catch(() => {}),
                  cloudProvider.upload({
                    key: `jobs/${record.jobId}/_savings-report.json`,
                    data: Buffer.from(JSON.stringify(savingsReport, null, 2), "utf8"),
                    contentType: "application/json",
                    checkDuplicate: false,
                  }).catch(() => {}),
                ]);

                // 7. Persist updated manifest (with diff classifications stamped)
                await saveManifest(record.jobId, newManifest);

                // 8. Run intelligence layer — computes timeline, hotspots, velocity,
                //    crawl priority, savings analytics, manifest lineage, and audit report.
                //    Stores results in DB + R2. Non-fatal.
                await runIntelligenceLayer(record, diffReport, savingsReport, cloudProvider);

                logger.info(
                  {
                    jobId: record.jobId,
                    baseJobId,
                    new: diffReport.summary.new,
                    changed: diffReport.summary.changed,
                    unchanged: diffReport.summary.unchanged,
                    deleted: diffReport.summary.deleted,
                    skipRatePercent: savingsReport.skipRatePercent,
                    deltaZipBytes: zipReport.deltaZip.sizeBytes,
                    mergedZipBytes: zipReport.mergedZip.sizeBytes,
                    durationMs: actualRebuildMs,
                  },
                  "WORKER: diff post-processing complete"
                );
              } else {
                logger.warn(
                  { jobId: record.jobId },
                  "WORKER: diff mode — could not reload new manifest for diff computation"
                );
              }
            }
          }
        } catch (diffErr) {
          logger.warn(
            { err: diffErr, jobId: record.jobId },
            "WORKER: diff post-processing failed (non-fatal) — job will still complete"
          );
        }
      }

      // Persist the job as done in the database
      await markJobDone(
        record.jobId,
        job.zipPath ?? null,
        job.downloadUrl ?? null
      );

      await orchestrator.completeStage("persistence_commit");

      // Seal the execution manifest — writes final pipeline.execution.json
      await orchestrator.completePipeline();

      // ── Phase C1: Generation Pipeline ────────────────────────────────────────
      // Runs automatically after every successful scrape job. Non-fatal.
      await runAndStoreGenerationPipeline(record.jobId, cloudProvider).catch(
        (genErr) => {
          logger.warn(
            { err: genErr, jobId: record.jobId },
            "WORKER: generation pipeline failed (non-fatal)"
          );
        }
      );

      // ── Phase 6: Visual Enrichment Pipeline ──────────────────────────────────
      // Runs after every successful crawl in sequence:
      //   visual_capture → component_map → stencil_map → consistency_check
      // All stages are non-fatal. Status stored in R2 as _phase6-status.json.
      await runPhase6Pipeline(record.jobId).catch(
        (p6Err) => {
          logger.warn(
            { err: p6Err, jobId: record.jobId },
            "WORKER: Phase 6 pipeline failed (non-fatal)"
          );
        }
      );

      // ── Phase 7: Website Prime Indexing ───────────────────────────────────────
      // Runs automatically after Phase 6 completes. Consumes:
      //   - jobs/{jobId}/normalized-stencil-map.json  (Phase 6.7 output)
      //   - jobs/{jobId}/_manifest.json               (crawl manifest)
      // Produces four static JSON indexes uploaded to R2:
      //   - prime-index/routeIndex.json
      //   - prime-index/searchIndex.json
      //   - prime-index/contentIndex.json
      //   - prime-index/websitePrimeIndex.json  (master index)
      // Non-fatal: failures are logged as warnings; the job still completes.
      await runWebsitePrimeIndexer({ jobId: record.jobId }).then(
        (p7Out) => {
          logger.info(
            {
              jobId:       record.jobId,
              totalRoutes: p7Out.routeIndex.totalRoutes,
              uploadedAll: p7Out.uploadedAll,
              r2Keys:      p7Out.r2Keys,
            },
            "WORKER: Phase 7 prime_index complete"
          );
        }
      ).catch(
        (p7Err) => {
          logger.warn(
            { err: p7Err, jobId: record.jobId },
            "WORKER: Phase 7 prime_index failed (non-fatal)"
          );
        }
      );

      // ── Audit: finalize all JSON reports ────────────────────────────────────
      {
        const _alFinal = getAuditLogger(record.jobId);
        if (_alFinal) {
          const auditManifest = await loadManifest(record.jobId).catch(() => null);
          if (auditManifest) {
            await _alFinal.finalize(auditManifest).catch((auditErr) => {
              logger.warn(
                { err: auditErr, jobId: record.jobId },
                "WORKER: audit finalization failed (non-fatal)"
              );
            });
          }
        }
      }

      // ── Phase F4: Finalize checkpoint on success ──────────────────────────
      await finalizeCheckpoint(record.jobId).catch(() => {});

      const depth = await getQueueDepth();
      logger.info(
        {
          jobId: record.jobId,
          workerId: WORKER_ID,
          completed: job.completed,
          zipPath: job.zipPath,
          queueDepth: depth,
          totalDurationMs: orchestrator.getExecution().totalDurationMs,
        },
        "WORKER: job done"
      );
    } catch (commitErr) {
      // persistence_commit failures are fatal — the job did not fully land
      await orchestrator
        .failStage(
          "persistence_commit",
          commitErr instanceof Error ? commitErr : new Error(String(commitErr))
        )
        .catch(() => {});
      throw commitErr;
    }
  } catch (err) {
    clearInterval(syncInterval);
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack   = err instanceof Error ? (err.stack ?? null) : null;
    const isManifestError = err instanceof ManifestVerificationError;

    // Best-effort pipeline failure record — never masks the real error
    await orchestrator
      .failPipeline(err instanceof Error ? err : new Error(errorMessage))
      .catch(() => {});

    // ── Phase F2: Classify the failure before recovery begins ────────────────
    // Every failed job receives a classified failure object so the supervisor
    // and recovery system know WHY it failed before deciding how to act.
    const classification = classifyFailure({
      jobId:        record.jobId,
      seedUrl:      record.seedUrl,
      errorMessage,
      errorStack,
      retryCount:   record.retryCount,
      maxRetries:   record.maxRetries,
    });

    // ── Phase F3: Autonomous Recovery Engine ─────────────────────────────────
    // Immediately execute the recovery strategy selected for this failure class.
    // This runs concurrently with markJobFailed so recovery is never blocked by
    // DB latency. Errors inside executeRecovery are non-fatal and do not mask
    // the original failure.
    if (classification) {
      executeRecovery(classification).catch((recErr) => {
        logger.warn(
          { err: recErr, jobId: record.jobId, failureClass: classification.failureClass },
          "WORKER: F3 autonomous recovery action failed (non-fatal)"
        );
      });
    }

    logger.error(
      {
        err,
        jobId: record.jobId,
        workerId: WORKER_ID,
        retryCount: record.retryCount,
        maxRetries: record.maxRetries,
        failedStage: isManifestError ? "manifest_verification" : undefined,
        reason: isManifestError ? (err as ManifestVerificationError).reason : undefined,
      },
      isManifestError
        ? "WORKER: job failed — manifest_verification gate blocked completion"
        : "WORKER: job failed"
    );

    await markJobFailed(
      record.jobId,
      errorMessage,
      record.retryCount,
      record.maxRetries
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArticles(articlesJson: string): ArticleLink[] {
  try {
    return JSON.parse(articlesJson) as ArticleLink[];
  } catch {
    return [];
  }
}

// Re-export for observability — callers may want to check worker state
export function workerStatus(): {
  workerId: string;
  active: boolean;
  inFlight: number;
} {
  return { workerId: WORKER_ID, active, inFlight };
}
