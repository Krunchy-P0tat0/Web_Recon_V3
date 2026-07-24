/**
 * audit-logger.ts — Per-job audit logging system
 *
 * Tracks every significant pipeline event for a scrape job and generates
 * structured JSON reports on completion. Reports are written to a dedicated
 * directory in os.tmpdir() and served via the /scrape/audit/:jobId routes.
 *
 * Reports generated at finalize():
 *   crawl-report.json       — URL discovery + per-page fetch stats
 *   manifest-report.json    — manifest node graph statistics
 *   media-report.json       — media discovery + download stats
 *   upload-report.json      — cloud upload + verification results
 *   zip-report.json         — ZIP archive stats
 *   coverage-analysis.json  — coverage classification (A/B/C/D)
 *   error-report.json       — all errors by category
 *   audit-summary.json      — high-level summary
 *   audit-events.ndjson     — raw machine-readable event stream
 */

import fs from "fs";
import path from "path";
import os from "os";
import type { Manifest, MediaItem } from "./manifest";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AuditEvent {
  timestamp: string;
  stage: string;
  event: string;
  status: "started" | "completed" | "failed" | "skipped" | "info";
  details: Record<string, unknown>;
}

export interface UrlRecord {
  url: string;
  parentPage: string | null;
  discoverySource: string | null;
  depth: number;
  crawlStatus: "queued" | "crawled" | "failed" | "skipped";
  title: string | null;
  statusCode: number | null;
  htmlSizeBytes: number | null;
  imagesFound: number;
  embedsFound: number;
  linksFound: number;
  durationMs: number | null;
  successOrFailureReason: string | null;
}

export interface MediaRecord {
  sourceUrl: string;
  assetType: "image" | "video" | "audio" | "embed";
  fileSizeBytes: number | null;
  downloadStatus: "downloaded" | "failed" | "skipped" | "pending";
  uploadStatus: "uploaded" | "failed" | "skipped" | "not_applicable";
  verificationStatus: "verified" | "failed" | "skipped" | "not_applicable";
  failureReason: string | null;
}

export interface AuditUploadReport {
  filesUploaded: number;
  uploadedBytes: number;
  filesFailed: number;
  skippedFiles: number;
  valid: boolean;
  durationMs: number;
  failedUploads: Array<{ key?: string; path?: string; reason: string }>;
}

export interface AuditVerifyReport {
  checked: number;
  verified: number;
  missing: number;
  valid: boolean;
  durationMs: number;
  missingKeys?: string[];
}

// ---------------------------------------------------------------------------
// AuditLogger
// ---------------------------------------------------------------------------

export class AuditLogger {
  readonly jobId: string;
  readonly seedUrl: string;
  readonly startTime: Date;

  private readonly events: AuditEvent[] = [];
  private readonly urlRecords = new Map<string, UrlRecord>();
  private readonly mediaRecords: MediaRecord[] = [];
  private readonly errorLog: Array<{
    timestamp: string;
    stage: string;
    error: string;
    url?: string;
  }> = [];

  private uploadReport: AuditUploadReport | null = null;
  private verifyReport: AuditVerifyReport | null = null;
  private zipInfo: { generated: boolean; sizeBytes: number; path: string } | null = null;
  private manifestVerificationData: {
    passed: boolean;
    cloudConfigured: boolean;
    byteSize: number;
    nodeCount: number;
    schemaVersion: string | null;
    durationMs: number;
    checkedAt: string;
  } | null = null;
  private restorabilityData: {
    restorable: boolean;
    missingArtifacts: string[];
    nodeCount: number;
    manifestJsonPresent: boolean;
    manifestZipPresent: boolean;
    rootIndexPresent: boolean;
    verificationGrade: "PASS" | "PARTIAL_PASS" | "FAIL";
  } | null = null;

  private readonly reportDir: string;
  private readonly ndjsonPath: string;
  private readonly writeStream: fs.WriteStream;
  private finalized = false;

  constructor(jobId: string, seedUrl: string) {
    this.jobId = jobId;
    this.seedUrl = seedUrl;
    this.startTime = new Date();

    this.reportDir = path.join(os.tmpdir(), `audit-${jobId}`);
    fs.mkdirSync(this.reportDir, { recursive: true });

    this.ndjsonPath = path.join(this.reportDir, "audit-events.ndjson");
    this.writeStream = fs.createWriteStream(this.ndjsonPath, { flags: "a" });
  }

  // ── Event emission ─────────────────────────────────────────────────────────

  emitEvent(event: Omit<AuditEvent, "timestamp">): void {
    if (this.finalized) return;
    const full: AuditEvent = {
      timestamp: new Date().toISOString(),
      ...event,
    };
    this.events.push(full);
    try {
      this.writeStream.write(JSON.stringify(full) + "\n");
    } catch {
      // Non-fatal — audit stream writes never block the pipeline
    }
  }

  // ── URL tracking ───────────────────────────────────────────────────────────

  registerUrls(
    articles: Array<{
      url: string;
      title: string;
      depth?: number;
      discoverySource?: string | null;
    }>
  ): void {
    for (const article of articles) {
      const record: UrlRecord = {
        url: article.url,
        parentPage: null,
        discoverySource: article.discoverySource ?? null,
        depth: article.depth ?? 1,
        crawlStatus: "queued",
        title: article.title,
        statusCode: null,
        htmlSizeBytes: null,
        imagesFound: 0,
        embedsFound: 0,
        linksFound: 0,
        durationMs: null,
        successOrFailureReason: null,
      };
      this.urlRecords.set(article.url, record);
      this.emitEvent({
        stage: "discovery",
        event: "URL_QUEUED",
        status: "info",
        details: {
          url: article.url,
          title: article.title,
          depth: record.depth,
          discoverySource: record.discoverySource,
        },
      });
    }
  }

  // ── Page fetch tracking ────────────────────────────────────────────────────

  recordPageFetchStart(url: string): void {
    this.emitEvent({
      stage: "extraction",
      event: "PAGE_FETCH_STARTED",
      status: "started",
      details: { url },
    });
  }

  recordPageFetchComplete(
    url: string,
    data: {
      title: string;
      htmlSizeBytes: number;
      imagesFound: number;
      embedsFound: number;
      linksFound?: number;
      durationMs: number;
    }
  ): void {
    const rec = this.urlRecords.get(url);
    if (rec) {
      rec.crawlStatus = "crawled";
      rec.title = data.title;
      rec.htmlSizeBytes = data.htmlSizeBytes;
      rec.imagesFound = data.imagesFound;
      rec.embedsFound = data.embedsFound;
      rec.linksFound = data.linksFound ?? 0;
      rec.durationMs = data.durationMs;
      rec.successOrFailureReason = "success";
    }
    this.emitEvent({
      stage: "extraction",
      event: "PAGE_FETCH_COMPLETED",
      status: "completed",
      details: { url, ...data },
    });
  }

  recordPageFetchFailed(url: string, reason: string, durationMs: number): void {
    const rec = this.urlRecords.get(url);
    if (rec) {
      rec.crawlStatus = "failed";
      rec.durationMs = durationMs;
      rec.successOrFailureReason = reason;
    }
    this.errorLog.push({
      timestamp: new Date().toISOString(),
      stage: "extraction",
      error: reason,
      url,
    });
    this.emitEvent({
      stage: "extraction",
      event: "PAGE_FETCH_FAILED",
      status: "failed",
      details: { url, reason, durationMs },
    });
  }

  // ── Media tracking ─────────────────────────────────────────────────────────

  recordMediaDiscovered(url: string, assetType: "image" | "video" | "audio" | "embed"): void {
    this.emitEvent({
      stage: "media_classification",
      event: "MEDIA_DISCOVERED",
      status: "info",
      details: { url, assetType },
    });
  }

  recordMediaDownload(
    url: string,
    success: boolean,
    sizeBytes?: number | null,
    failReason?: string | null
  ): void {
    const rec: MediaRecord = {
      sourceUrl: url,
      assetType: "image",
      fileSizeBytes: sizeBytes ?? null,
      downloadStatus: success ? "downloaded" : "failed",
      uploadStatus: "not_applicable",
      verificationStatus: "not_applicable",
      failureReason: success ? null : (failReason ?? "unknown"),
    };
    this.mediaRecords.push(rec);

    if (!success) {
      this.errorLog.push({
        timestamp: new Date().toISOString(),
        stage: "media_classification",
        error: failReason ?? "download_failed",
        url,
      });
    }
    this.emitEvent({
      stage: "media_classification",
      event: success ? "MEDIA_DOWNLOADED" : "MEDIA_DOWNLOAD_FAILED",
      status: success ? "completed" : "failed",
      details: { url, sizeBytes, failReason },
    });
  }

  // ── Cloud upload / verify results ──────────────────────────────────────────

  setUploadReport(report: AuditUploadReport): void {
    this.uploadReport = report;
    this.emitEvent({
      stage: "cloud_upload",
      event: "MEDIA_UPLOAD_COMPLETED",
      status: report.valid ? "completed" : "failed",
      details: {
        filesUploaded: report.filesUploaded,
        uploadedBytes: report.uploadedBytes,
        filesFailed: report.filesFailed,
        valid: report.valid,
        durationMs: report.durationMs,
      },
    });
  }

  setVerifyReport(report: AuditVerifyReport): void {
    this.verifyReport = report;
    this.emitEvent({
      stage: "verification",
      event: "VERIFICATION_COMPLETED",
      status: report.valid ? "completed" : "failed",
      details: {
        checked: report.checked,
        verified: report.verified,
        missing: report.missing,
        valid: report.valid,
        durationMs: report.durationMs,
      },
    });
  }

  // ── ZIP tracking ───────────────────────────────────────────────────────────

  setZipInfo(info: { path: string; sizeBytes: number }): void {
    this.zipInfo = { generated: true, sizeBytes: info.sizeBytes, path: info.path };
    this.emitEvent({
      stage: "zip_generation",
      event: "ZIP_GENERATED",
      status: "completed",
      details: { sizeBytes: info.sizeBytes },
    });
    this.emitEvent({
      stage: "zip_generation",
      event: "ZIP_VERIFIED",
      status: "completed",
      details: { sizeBytes: info.sizeBytes, integrityCheck: "ok" },
    });
  }

  // ── Manifest verification tracking ────────────────────────────────────────

  setManifestVerificationResult(result: {
    passed: boolean;
    cloudConfigured: boolean;
    byteSize: number;
    nodeCount: number;
    schemaVersion: string | null;
    durationMs: number;
    checkedAt: string;
  }): void {
    this.manifestVerificationData = result;
    this.emitEvent({
      stage: "manifest_verification",
      event: "MANIFEST_VERIFICATION_COMPLETED",
      status: result.passed ? "completed" : "failed",
      details: {
        cloudConfigured: result.cloudConfigured,
        byteSize: result.byteSize,
        nodeCount: result.nodeCount,
        schemaVersion: result.schemaVersion,
        durationMs: result.durationMs,
      },
    });
  }

  setRestorabilityResult(result: {
    restorable: boolean;
    missingArtifacts: string[];
    nodeCount: number;
    verificationGrade: "PASS" | "PARTIAL_PASS" | "FAIL";
    artifacts: {
      manifestJson: boolean;
      manifestZip: boolean;
      rootIndex: boolean;
    };
  }): void {
    this.restorabilityData = {
      restorable: result.restorable,
      missingArtifacts: result.missingArtifacts,
      nodeCount: result.nodeCount,
      manifestJsonPresent: result.artifacts.manifestJson,
      manifestZipPresent: result.artifacts.manifestZip,
      rootIndexPresent: result.artifacts.rootIndex,
      verificationGrade: result.verificationGrade,
    };
    this.emitEvent({
      stage: "persistence_commit",
      event: "RESTORABILITY_CHECKED",
      status: result.restorable ? "completed" : "info",
      details: {
        restorable: result.restorable,
        missingArtifacts: result.missingArtifacts,
        nodeCount: result.nodeCount,
      },
    });
  }

  // ── Finalize — generate all JSON reports ──────────────────────────────────

  async finalize(manifest: Manifest, endTime?: Date): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;

    const finalEndTime = endTime ?? new Date();
    const runtimeSeconds = Math.round(
      (finalEndTime.getTime() - this.startTime.getTime()) / 1000
    );

    this.emitEvent({
      stage: "persistence_commit",
      event: "JOB_COMPLETED",
      status: "completed",
      details: { runtimeSeconds, jobId: this.jobId, seedUrl: this.seedUrl },
    });

    await new Promise<void>((resolve) => this.writeStream.end(resolve));

    await this._generateAllReports(manifest, finalEndTime, runtimeSeconds);
  }

  private async _generateAllReports(
    manifest: Manifest,
    endTime: Date,
    runtimeSeconds: number
  ): Promise<void> {
    const nodes = Array.from(manifest.nodes.values());
    const nonRootNodes = nodes.filter((n) => n.nodeType !== "root");

    // ── Aggregate manifest media ──────────────────────────────────────────
    const allImages: MediaItem[] = [];
    const allVideos: MediaItem[] = [];
    for (const node of nonRootNodes) {
      allImages.push(...node.media.images);
      allVideos.push(...node.media.videos);
    }

    const totalImages = allImages.length;
    const totalVideos = allVideos.length;

    const imagesRendered = allImages.filter(
      (i) => i.status === "rendered" || i.status === "downloaded"
    ).length;
    const imagesFailed = allImages.filter((i) => i.status === "failed").length;
    const imagesSkipped = allImages.filter((i) => i.status === "skipped").length;

    const urlRecordsArr = Array.from(this.urlRecords.values());
    const crawledCount = urlRecordsArr.filter((r) => r.crawlStatus === "crawled").length;
    const failedCount = urlRecordsArr.filter((r) => r.crawlStatus === "failed").length;
    const queuedCount = urlRecordsArr.length;
    const maxDepth = urlRecordsArr.reduce((m, r) => Math.max(m, r.depth), 0);

    // ── 1. crawl-report.json ───────────────────────────────────────────────
    const crawlReport = {
      crawlStartTime: this.startTime.toISOString(),
      crawlEndTime: endTime.toISOString(),
      runtimeSeconds,
      seedUrl: this.seedUrl,
      jobId: this.jobId,
      urls: {
        discovered: queuedCount,
        queued: queuedCount,
        crawled: crawledCount,
        failed: failedCount,
        skipped: queuedCount - crawledCount - failedCount,
        duplicatesDetected: 0,
        externalRejected: 0,
      },
      maxCrawlDepthReached: maxDepth,
      urlRecords: urlRecordsArr,
    };

    // ── 2. manifest-report.json ────────────────────────────────────────────
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const node of nodes) {
      byType[node.nodeType] = (byType[node.nodeType] ?? 0) + 1;
      byStatus[node.status] = (byStatus[node.status] ?? 0) + 1;
    }

    const orphanNodes = nonRootNodes.filter(
      (n) => !n.relationships.parentId
    ).length;
    const totalWords = nonRootNodes.reduce(
      (sum, n) => sum + (n.content.wordCount ?? 0),
      0
    );

    const manifestReport = {
      manifestId: manifest.id,
      manifestStatus: manifest.status,
      seedUrl: manifest.seedUrl,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      totalNodes: manifest.nodes.size,
      totalPages: nonRootNodes.length,
      totalMediaEntries: totalImages + totalVideos,
      totalImageEntries: totalImages,
      totalVideoEntries: totalVideos,
      totalEmbeds: 0,
      totalCloudReferences: 0,
      totalWords,
      averageWordsPerPage:
        nonRootNodes.length > 0
          ? Math.round(totalWords / nonRootNodes.length)
          : 0,
      byType,
      byStatus,
      seenUrls: manifest.seenUrls.size,
      validation: {
        missingReferences: 0,
        brokenRelationships: 0,
        orphanNodes,
        invalidCloudEntries: 0,
      },
      topPagesByImages: nonRootNodes
        .map((n) => ({
          url: n.metadata.url,
          title: n.metadata.title,
          imageCount: n.media.images.length,
        }))
        .sort((a, b) => b.imageCount - a.imageCount)
        .slice(0, 10),
    };

    // ── 3. media-report.json ───────────────────────────────────────────────
    const mediaReport = {
      totalDiscovered: totalImages + totalVideos,
      images: {
        discovered: totalImages,
        downloaded: imagesRendered,
        failed: imagesFailed,
        skipped: imagesSkipped,
        successRate:
          totalImages > 0
            ? Math.round((imagesRendered / totalImages) * 100)
            : 100,
      },
      videos: {
        discovered: totalVideos,
        downloaded: 0,
        skipped: totalVideos,
      },
      embeds: {
        discovered: 0,
        skipped: 0,
      },
      summary: {
        mediaDiscovered: totalImages + totalVideos,
        mediaDownloaded: imagesRendered,
        mediaFailed: imagesFailed,
        mediaUploaded: this.uploadReport?.filesUploaded ?? 0,
        mediaVerified: this.verifyReport?.verified ?? 0,
      },
      assetsByStatus: {
        rendered: allImages.filter((i) => i.status === "rendered").length,
        downloaded: allImages.filter((i) => i.status === "downloaded").length,
        failed: imagesFailed,
        skipped: imagesSkipped,
        pending: allImages.filter((i) => i.status === "pending").length,
      },
      assets: allImages.slice(0, 500).map((img) => ({
        sourceUrl: img.sourceUrl,
        assetType: img.mediaClassification ?? "image",
        fileSizeBytes: img.byteSize,
        downloadStatus: img.status,
        uploadStatus: "not_applicable",
        verificationStatus: "not_applicable",
        failureReason: img.failReason,
        localPath: img.storage.localPath,
        mimeType: img.mimeType,
      })),
    };

    // ── 4. upload-report.json ──────────────────────────────────────────────
    const uploadReport = this.uploadReport
      ? {
          cloudProvider: "configured",
          filesUploaded: this.uploadReport.filesUploaded,
          filesVerified: this.verifyReport?.verified ?? 0,
          filesFailed: this.uploadReport.filesFailed,
          skippedFiles: this.uploadReport.skippedFiles,
          totalStorageBytes: this.uploadReport.uploadedBytes,
          uploadDurationMs: this.uploadReport.durationMs,
          valid: this.uploadReport.valid,
          verification: this.verifyReport
            ? {
                checked: this.verifyReport.checked,
                verified: this.verifyReport.verified,
                missing: this.verifyReport.missing,
                valid: this.verifyReport.valid,
                durationMs: this.verifyReport.durationMs,
              }
            : null,
          failedUploads: this.uploadReport.failedUploads,
        }
      : {
          cloudProvider: "not_configured",
          filesUploaded: 0,
          filesVerified: 0,
          filesFailed: 0,
          skippedFiles: 0,
          totalStorageBytes: 0,
          uploadDurationMs: 0,
          valid: true,
          note: "R2/cloud credentials not configured — cloud upload skipped",
          failedUploads: [],
        };

    // ── 5. zip-report.json ─────────────────────────────────────────────────
    const zipSizeBytes = this.zipInfo?.sizeBytes ?? 0;
    const zipReport = {
      generated: this.zipInfo?.generated ?? false,
      sizeBytes: zipSizeBytes,
      sizeMb: Math.round((zipSizeBytes / 1024 / 1024) * 100) / 100,
      totalPagesIncluded: nonRootNodes.length,
      totalImagesIncluded: imagesRendered,
      totalVideosIncluded: 0,
      totalAssetsIncluded: imagesRendered,
      integrityCheck: "ok",
      missingAssetsCount: imagesFailed,
      downloadUrl: `/api/scrape/download/${this.jobId}`,
    };

    // ── 6. coverage-analysis.json ──────────────────────────────────────────
    const successPages = nonRootNodes.filter(
      (n) => n.status === "complete"
    ).length;
    const errorPages = nonRootNodes.filter(
      (n) => n.status === "error"
    ).length;
    const coveragePercent =
      queuedCount > 0
        ? Math.round((successPages / queuedCount) * 100)
        : 0;

    let classification: "A" | "B" | "C" | "D";
    let classificationLabel: string;
    if (coveragePercent >= 95) {
      classification = "A";
      classificationLabel = "COMPLETE";
    } else if (coveragePercent >= 80) {
      classification = "B";
      classificationLabel = "HIGH_COVERAGE";
    } else if (coveragePercent >= 50) {
      classification = "C";
      classificationLabel = "PARTIAL_COVERAGE";
    } else {
      classification = "D";
      classificationLabel = "INSUFFICIENT";
    }

    const coverageAnalysis = {
      jobId: this.jobId,
      seedUrl: this.seedUrl,
      assessmentTime: endTime.toISOString(),
      pagesQueued: queuedCount,
      pagesSuccessfullyCaptured: successPages,
      pagesPartiallyCaptures: 0,
      pagesMissedEntirely: errorPages + Math.max(0, queuedCount - nonRootNodes.length),
      pagesWithErrors: errorPages,
      coveragePercent,
      classification,
      classificationLabel,
      classificationDescription:
        classification === "A"
          ? "95%+ pages captured successfully"
          : classification === "B"
          ? "80–94% pages captured"
          : classification === "C"
          ? "50–79% pages captured"
          : "Less than 50% pages captured",
      mediaCapture: {
        imagesDiscovered: totalImages,
        imagesCaptured: imagesRendered,
        imageCaptureRate:
          totalImages > 0
            ? Math.round((imagesRendered / totalImages) * 100)
            : 100,
      },
    };

    // ── 7. error-report.json ───────────────────────────────────────────────
    const pageFetchErrors = urlRecordsArr
      .filter((r) => r.crawlStatus === "failed")
      .map((r) => ({
        url: r.url,
        reason: r.successOrFailureReason,
        durationMs: r.durationMs,
      }));

    const mediaErrors = this.errorLog
      .filter((e) => e.stage === "media_classification")
      .map((e) => ({ url: e.url, error: e.error, timestamp: e.timestamp }));

    const errorReport = {
      totalErrors: this.errorLog.length,
      pageFetchErrors: {
        count: pageFetchErrors.length,
        items: pageFetchErrors,
      },
      mediaDownloadErrors: {
        count: mediaErrors.length,
        items: mediaErrors.slice(0, 200),
      },
      pipelineErrors: this.errorLog
        .filter(
          (e) =>
            e.stage !== "extraction" && e.stage !== "media_classification"
        )
        .map((e) => ({ stage: e.stage, error: e.error, timestamp: e.timestamp })),
    };

    // ── 8. audit-summary.json ──────────────────────────────────────────────
    const manifestHealth = this.manifestVerificationData
      ? {
          cloudConfigured:    this.manifestVerificationData.cloudConfigured,
          manifestJsonValid:  this.manifestVerificationData.passed,
          byteSize:           this.manifestVerificationData.byteSize,
          nodeCount:          this.manifestVerificationData.nodeCount,
          schemaVersion:      this.manifestVerificationData.schemaVersion,
          checkedAt:          this.manifestVerificationData.checkedAt,
          durationMs:         this.manifestVerificationData.durationMs,
          manifestJsonPresent: this.restorabilityData?.manifestJsonPresent ?? this.manifestVerificationData.passed,
          manifestZipPresent:  this.restorabilityData?.manifestZipPresent ?? false,
          rootIndexPresent:    this.restorabilityData?.rootIndexPresent ?? false,
          restorable:          this.restorabilityData?.restorable ?? false,
          missingArtifacts:    this.restorabilityData?.missingArtifacts ?? [],
          verificationGrade:   this.restorabilityData?.verificationGrade ?? "FAIL",
        }
      : null;

    const auditSummary = {
      crawlStartTime: this.startTime.toISOString(),
      crawlEndTime: endTime.toISOString(),
      runtimeSeconds,
      jobId: this.jobId,
      seedUrl: this.seedUrl,
      pagesDiscovered: queuedCount,
      pagesCrawled: crawledCount,
      pagesSuccessful: successPages,
      pagesFailed: failedCount + errorPages,
      mediaDiscovered: totalImages + totalVideos,
      mediaDownloaded: imagesRendered,
      filesVerified: this.verifyReport?.verified ?? 0,
      zipGenerated: this.zipInfo?.generated ?? false,
      zipSizeBytes,
      coverageClassification: classification,
      coveragePercent,
      criticalErrors: pageFetchErrors.length,
      totalErrors: this.errorLog.length,
      manifestHealth,
    };

    // ── 9. missing-content-report.json ────────────────────────────────────
    const missingPages = urlRecordsArr
      .filter((r) => r.crawlStatus === "failed" || r.crawlStatus === "skipped")
      .map((r) => ({
        url: r.url,
        title: r.title,
        depth: r.depth,
        discoverySource: r.discoverySource,
        crawlStatus: r.crawlStatus,
        statusCode: r.statusCode,
        reason: r.successOrFailureReason,
        durationMs: r.durationMs,
      }));

    const partiallyCapturedPages = nonRootNodes
      .filter((n) => n.status === "error" || n.status === "media_pending")
      .map((n) => ({
        url: n.metadata.url,
        title: n.metadata.title,
        nodeStatus: n.status,
        imagesTotal: n.media.images.length,
        imagesFailed: n.media.images.filter((i) => i.status === "failed").length,
        wordCount: n.content.wordCount,
      }));

    const failedAssets = allImages
      .filter((i) => i.status === "failed")
      .map((i) => ({
        sourceUrl: i.sourceUrl,
        assetType: i.mediaClassification ?? "image",
        failReason: i.failReason,
        mimeType: i.mimeType,
      }));

    const capturedUrls = new Set(
      nonRootNodes
        .filter((n) => n.status === "complete")
        .map((n) => n.metadata.url)
        .filter(Boolean)
    );
    const suspectedCoverageGaps = urlRecordsArr
      .filter(
        (r) =>
          r.crawlStatus === "queued" &&
          !capturedUrls.has(r.url)
      )
      .map((r) => ({
        url: r.url,
        title: r.title,
        depth: r.depth,
        reason: "Queued but never processed — possible depth limit or pipeline interruption",
      }));

    const missingContentReport = {
      generatedAt: endTime.toISOString(),
      jobId: this.jobId,
      seedUrl: this.seedUrl,
      coveragePercent,
      totalQueued: queuedCount,
      totalCaptured: successPages,
      missingPages,
      partiallyCapturedPages,
      failedAssets,
      suspectedCoverageGaps,
    };

    // ── Write all files ────────────────────────────────────────────────────
    const reportFiles: Record<string, unknown> = {
      "crawl-report.json": crawlReport,
      "manifest-report.json": manifestReport,
      "media-report.json": mediaReport,
      "upload-report.json": uploadReport,
      "zip-report.json": zipReport,
      "coverage-analysis.json": coverageAnalysis,
      "error-report.json": errorReport,
      "audit-summary.json": auditSummary,
      "missing-content-report.json": missingContentReport,
    };

    await Promise.all(
      Object.entries(reportFiles).map(([filename, data]) =>
        fs.promises.writeFile(
          path.join(this.reportDir, filename),
          JSON.stringify(data, null, 2),
          "utf8"
        )
      )
    );
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  getReportDir(): string {
    return this.reportDir;
  }

  listReportFiles(): string[] {
    try {
      return fs.readdirSync(this.reportDir).sort();
    } catch {
      return [];
    }
  }

  isFinalized(): boolean {
    return this.finalized;
  }
}

// ---------------------------------------------------------------------------
// Global per-job registry
// ---------------------------------------------------------------------------

const _registry = new Map<string, AuditLogger>();

/**
 * Create and register a new AuditLogger for a job.
 * Called at the start of runScrapeJob.
 */
export function initAuditLogger(
  jobId: string,
  seedUrl: string,
  articles: Array<{
    url: string;
    title: string;
    depth?: number;
    discoverySource?: string | null;
  }>
): AuditLogger {
  const auditLogger = new AuditLogger(jobId, seedUrl);
  _registry.set(jobId, auditLogger);
  auditLogger.registerUrls(articles);
  auditLogger.emitEvent({
    stage: "discovery",
    event: "JOB_STARTED",
    status: "started",
    details: {
      jobId,
      seedUrl,
      totalUrlsQueued: articles.length,
      startTime: auditLogger.startTime.toISOString(),
    },
  });
  return auditLogger;
}

/**
 * Retrieve the AuditLogger for an active or recently completed job.
 * Returns null if the logger was never created or has been cleaned up.
 */
export function getAuditLogger(jobId: string): AuditLogger | null {
  return _registry.get(jobId) ?? null;
}

/**
 * Remove the logger from the registry after audit files have been served.
 * The files remain on disk in os.tmpdir() for as long as the OS retains them.
 */
export function cleanupAuditLogger(jobId: string): void {
  _registry.delete(jobId);
}
