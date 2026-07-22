/**
 * diff-intelligence.ts — Differential Intelligence Layer
 *
 * Answers: what changed, when, how often, page volatility, savings metrics,
 * and manifest lineage across the full history of differential crawl runs.
 *
 * Components:
 *   Timeline           — ordered run history with per-run change stats
 *   Hotspot Analysis   — per-URL change frequency across all past runs
 *   Velocity Engine    — weekly rate of new/changed/deleted content
 *   Crawl Prioritization — URL ranking based on historical change frequency
 *   Savings Analytics  — cumulative bandwidth / storage / time savings
 *   Manifest Lineage   — ancestry chain and generation count
 *   Restoration Compatibility — validates all required diff artifacts exist
 *   Audit Report       — comprehensive summary of this diff run
 *
 * All reports are written to R2 as JSON files under jobs/{jobId}/.
 * History is persisted in the differential_history Postgres table.
 */

import { randomUUID } from "crypto";
import { logger } from "./logger";
import type { DiffReport, SavingsReport } from "./diff-engine";
import type { CloudProvider } from "../cloud/provider";
import type { ScrapeJobRecord } from "./db-queue";
import {
  insertDiffHistory,
  listDiffHistoryForSeedUrl,
  getDiffHistoryForJob,
} from "./db-queue";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ChangedUrlEntry {
  url: string;
  classification: "new" | "changed" | "deleted";
  changeReasons: string[];
}

export interface TimelineEntry {
  jobId: string;
  baseJobId: string | null;
  computedAt: string;
  newCount: number;
  changedCount: number;
  unchangedCount: number;
  deletedCount: number;
  skipRatePercent: number;
  bandwidthSavedBytes: number;
  storageSavedBytes: number;
  processingTimeSavedMs: number;
}

export interface SiteTimeline {
  seedUrl: string;
  generatedAt: string;
  totalDiffRuns: number;
  entries: TimelineEntry[];
  firstRunAt: string | null;
  latestRunAt: string | null;
}

export interface HotspotEntry {
  url: string;
  changeCount: number;
  lastChanged: string | null;
  lastClassification: "new" | "changed" | "deleted" | null;
  volatilityScore: number;
  priority: "HIGH" | "MEDIUM" | "LOW";
}

export interface HotspotAnalysis {
  seedUrl: string;
  generatedAt: string;
  totalUrlsTracked: number;
  topVolatile: HotspotEntry[];
  topStable: HotspotEntry[];
  allHotspots: HotspotEntry[];
}

export interface VelocityWindow {
  windowDays: number;
  newPagesPerWeek: number;
  changesPerWeek: number;
  deletionsPerWeek: number;
}

export interface VelocityReport {
  seedUrl: string;
  generatedAt: string;
  historyDays: number;
  velocity: VelocityWindow;
  stabilityScore: number;
  contentGrowthRate: number;
  changeRate: number;
  deletionRate: number;
  trend: "growing" | "stable" | "shrinking" | "volatile";
}

export interface CrawlPriorityEntry {
  url: string;
  priority: "HIGH" | "MEDIUM" | "LOW" | "SKIP";
  changeCount: number;
  lastChanged: string | null;
  reason: string;
}

export interface CrawlPriorityReport {
  seedUrl: string;
  generatedAt: string;
  totalUrls: number;
  highPriority: CrawlPriorityEntry[];
  mediumPriority: CrawlPriorityEntry[];
  lowPriority: CrawlPriorityEntry[];
  skipUrls: CrawlPriorityEntry[];
}

export interface PerRunSavings {
  jobId: string;
  computedAt: string;
  bandwidthSavedBytes: number;
  storageSavedBytes: number;
  processingTimeSavedMs: number;
  pagesSkipped: number;
  skipRatePercent: number;
}

export interface SavingsAnalytics {
  seedUrl: string;
  generatedAt: string;
  totalDiffRuns: number;
  cumulative: {
    bandwidthSavedBytes: number;
    storageSavedBytes: number;
    processingTimeSavedMs: number;
    pagesSkipped: number;
    bandwidthSavedMb: number;
    processingTimeSavedSec: number;
  };
  averagePerRun: {
    bandwidthSavedBytes: number;
    storageSavedBytes: number;
    processingTimeSavedMs: number;
    pagesSkipped: number;
    skipRatePercent: number;
  };
  perRunSavings: PerRunSavings[];
}

export interface LineageNode {
  jobId: string;
  computedAt: string;
  baseJobId: string | null;
  diffGeneration: number;
}

export interface ManifestLineage {
  jobId: string;
  seedUrl: string;
  generatedAt: string;
  diffGeneration: number;
  parentJobId: string | null;
  ancestry: LineageNode[];
  totalGenerations: number;
}

export interface DifferentialAuditReport {
  jobId: string;
  baseJobId: string | null;
  seedUrl: string;
  generatedAt: string;
  runClassification: "DIFF_CRAWL" | "FIRST_DIFF";
  diffGeneration: number;
  changeSummary: {
    new: number;
    changed: number;
    unchanged: number;
    deleted: number;
    total: number;
    skipRatePercent: number;
  };
  savingsThisRun: {
    bandwidthSavedBytes: number;
    bandwidthSavedMb: number;
    storageSavedBytes: number;
    processingTimeSavedMs: number;
    processingTimeSavedSec: number;
    pagesSkipped: number;
  };
  cumulativeSavings: {
    bandwidthSavedBytes: number;
    bandwidthSavedMb: number;
    storageSavedBytes: number;
    processingTimeSavedMs: number;
    totalDiffRuns: number;
  };
  timeline: {
    totalRuns: number;
    firstRunAt: string | null;
    latestRunAt: string | null;
    isFirstDiffRun: boolean;
  };
  hotspots: {
    topVolatileUrls: Array<{ url: string; changeCount: number }>;
    totalTrackedUrls: number;
  };
  velocity: {
    stabilityScore: number;
    trend: string;
    changesPerWeek: number;
  };
  lineage: {
    diffGeneration: number;
    parentJobId: string | null;
    ancestorCount: number;
  };
  restorationCompatibility: {
    r2KeysExpected: string[];
    status: "COMPLETE" | "PARTIAL";
  };
  artifactsWritten: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildChangedUrls(diffReport: DiffReport): ChangedUrlEntry[] {
  const entries: ChangedUrlEntry[] = [];

  for (const node of diffReport.newNodes) {
    entries.push({ url: node.url, classification: "new", changeReasons: [] });
  }
  for (const node of diffReport.changedNodes) {
    entries.push({
      url: node.url,
      classification: "changed",
      changeReasons: node.changeReasons,
    });
  }
  for (const node of diffReport.deletedNodes) {
    entries.push({ url: node.url, classification: "deleted", changeReasons: [] });
  }

  return entries;
}

function computeDiffGeneration(
  history: Awaited<ReturnType<typeof listDiffHistoryForSeedUrl>>,
  currentJobId: string
): number {
  return history.filter((h) => h.jobId !== currentJobId).length;
}

function buildTimeline(
  history: Awaited<ReturnType<typeof listDiffHistoryForSeedUrl>>
): SiteTimeline {
  const entries: TimelineEntry[] = history
    .slice()
    .sort((a, b) => a.computedAt.getTime() - b.computedAt.getTime())
    .map((h) => ({
      jobId: h.jobId,
      baseJobId: h.baseJobId ?? null,
      computedAt: h.computedAt.toISOString(),
      newCount: h.newCount,
      changedCount: h.changedCount,
      unchangedCount: h.unchangedCount,
      deletedCount: h.deletedCount,
      skipRatePercent: h.skipRatePercent,
      bandwidthSavedBytes: h.bandwidthSavedBytes,
      storageSavedBytes: h.storageSavedBytes,
      processingTimeSavedMs: h.processingTimeSavedMs,
    }));

  const seedUrl = history[0]?.seedUrl ?? "";
  return {
    seedUrl,
    generatedAt: new Date().toISOString(),
    totalDiffRuns: entries.length,
    entries,
    firstRunAt: entries[0]?.computedAt ?? null,
    latestRunAt: entries[entries.length - 1]?.computedAt ?? null,
  };
}

function buildHotspots(
  history: Awaited<ReturnType<typeof listDiffHistoryForSeedUrl>>,
  seedUrl: string
): HotspotAnalysis {
  const urlMap = new Map<
    string,
    { count: number; lastChanged: string | null; lastClassification: "new" | "changed" | "deleted" | null }
  >();

  for (const run of history) {
    let urlEntries: ChangedUrlEntry[] = [];
    try {
      urlEntries = JSON.parse(run.changedUrlsJson) as ChangedUrlEntry[];
    } catch {
      continue;
    }

    for (const entry of urlEntries) {
      const existing = urlMap.get(entry.url);
      const runDate = run.computedAt.toISOString();
      if (!existing) {
        urlMap.set(entry.url, {
          count: 1,
          lastChanged: runDate,
          lastClassification: entry.classification,
        });
      } else {
        const prev = existing.lastChanged;
        const isLater = !prev || runDate > prev;
        urlMap.set(entry.url, {
          count: existing.count + 1,
          lastChanged: isLater ? runDate : prev,
          lastClassification: isLater ? entry.classification : existing.lastClassification,
        });
      }
    }
  }

  const totalRuns = history.length;

  const allHotspots: HotspotEntry[] = Array.from(urlMap.entries()).map(
    ([url, data]) => {
      const volatilityScore = totalRuns > 0 ? Math.round((data.count / totalRuns) * 100) : 0;
      let priority: HotspotEntry["priority"];
      if (volatilityScore >= 60) priority = "HIGH";
      else if (volatilityScore >= 25) priority = "MEDIUM";
      else priority = "LOW";

      return {
        url,
        changeCount: data.count,
        lastChanged: data.lastChanged,
        lastClassification: data.lastClassification,
        volatilityScore,
        priority,
      };
    }
  );

  allHotspots.sort((a, b) => b.changeCount - a.changeCount);

  return {
    seedUrl,
    generatedAt: new Date().toISOString(),
    totalUrlsTracked: urlMap.size,
    topVolatile: allHotspots.slice(0, 20),
    topStable: allHotspots
      .slice()
      .sort((a, b) => a.changeCount - b.changeCount)
      .slice(0, 10),
    allHotspots,
  };
}

function buildVelocityReport(
  history: Awaited<ReturnType<typeof listDiffHistoryForSeedUrl>>,
  seedUrl: string
): VelocityReport {
  const sorted = history
    .slice()
    .sort((a, b) => a.computedAt.getTime() - b.computedAt.getTime());

  const now = new Date();
  const firstRun = sorted[0];
  const historyDays =
    firstRun
      ? Math.max(1, (now.getTime() - firstRun.computedAt.getTime()) / (1000 * 60 * 60 * 24))
      : 1;

  const totalNew = sorted.reduce((s, h) => s + h.newCount, 0);
  const totalChanged = sorted.reduce((s, h) => s + h.changedCount, 0);
  const totalDeleted = sorted.reduce((s, h) => s + h.deletedCount, 0);
  const totalScanned = sorted.reduce((s, h) => s + h.pagesScanned, 0);

  const weeksElapsed = historyDays / 7;

  const newPagesPerWeek = weeksElapsed > 0 ? totalNew / weeksElapsed : 0;
  const changesPerWeek = weeksElapsed > 0 ? totalChanged / weeksElapsed : 0;
  const deletionsPerWeek = weeksElapsed > 0 ? totalDeleted / weeksElapsed : 0;

  const contentGrowthRate = totalScanned > 0 ? totalNew / totalScanned : 0;
  const changeRate = totalScanned > 0 ? totalChanged / totalScanned : 0;
  const deletionRate = totalScanned > 0 ? totalDeleted / totalScanned : 0;

  const avgSkipRate =
    sorted.length > 0
      ? sorted.reduce((s, h) => s + h.skipRatePercent, 0) / sorted.length
      : 0;
  const stabilityScore = Math.round(avgSkipRate);

  let trend: VelocityReport["trend"];
  if (stabilityScore >= 75) trend = "stable";
  else if (contentGrowthRate > 0.1) trend = "growing";
  else if (deletionRate > 0.1) trend = "shrinking";
  else trend = "volatile";

  return {
    seedUrl,
    generatedAt: new Date().toISOString(),
    historyDays: Math.round(historyDays),
    velocity: {
      windowDays: Math.round(historyDays),
      newPagesPerWeek: Math.round(newPagesPerWeek * 10) / 10,
      changesPerWeek: Math.round(changesPerWeek * 10) / 10,
      deletionsPerWeek: Math.round(deletionsPerWeek * 10) / 10,
    },
    stabilityScore,
    contentGrowthRate: Math.round(contentGrowthRate * 1000) / 1000,
    changeRate: Math.round(changeRate * 1000) / 1000,
    deletionRate: Math.round(deletionRate * 1000) / 1000,
    trend,
  };
}

function buildCrawlPriority(hotspots: HotspotAnalysis): CrawlPriorityReport {
  const entries: CrawlPriorityEntry[] = hotspots.allHotspots.map((h) => {
    let priority: CrawlPriorityEntry["priority"];
    let reason: string;

    if (h.volatilityScore >= 60) {
      priority = "HIGH";
      reason = `Changed in ${h.changeCount} run(s) — highly volatile`;
    } else if (h.volatilityScore >= 25) {
      priority = "MEDIUM";
      reason = `Changed in ${h.changeCount} run(s) — moderately volatile`;
    } else if (h.changeCount === 0) {
      priority = "SKIP";
      reason = "Never changed — consider skipping in future crawls";
    } else {
      priority = "LOW";
      reason = `Changed in ${h.changeCount} run(s) — relatively stable`;
    }

    return {
      url: h.url,
      priority,
      changeCount: h.changeCount,
      lastChanged: h.lastChanged,
      reason,
    };
  });

  return {
    seedUrl: hotspots.seedUrl,
    generatedAt: new Date().toISOString(),
    totalUrls: entries.length,
    highPriority: entries.filter((e) => e.priority === "HIGH"),
    mediumPriority: entries.filter((e) => e.priority === "MEDIUM"),
    lowPriority: entries.filter((e) => e.priority === "LOW"),
    skipUrls: entries.filter((e) => e.priority === "SKIP"),
  };
}

function buildSavingsAnalytics(
  history: Awaited<ReturnType<typeof listDiffHistoryForSeedUrl>>,
  seedUrl: string
): SavingsAnalytics {
  const perRunSavings: PerRunSavings[] = history
    .slice()
    .sort((a, b) => a.computedAt.getTime() - b.computedAt.getTime())
    .map((h) => ({
      jobId: h.jobId,
      computedAt: h.computedAt.toISOString(),
      bandwidthSavedBytes: h.bandwidthSavedBytes,
      storageSavedBytes: h.storageSavedBytes,
      processingTimeSavedMs: h.processingTimeSavedMs,
      pagesSkipped: h.unchangedCount,
      skipRatePercent: h.skipRatePercent,
    }));

  const totalRuns = perRunSavings.length;
  const cumulativeBw = perRunSavings.reduce((s, r) => s + r.bandwidthSavedBytes, 0);
  const cumulativeSt = perRunSavings.reduce((s, r) => s + r.storageSavedBytes, 0);
  const cumulativeMs = perRunSavings.reduce((s, r) => s + r.processingTimeSavedMs, 0);
  const cumulativeSkipped = perRunSavings.reduce((s, r) => s + r.pagesSkipped, 0);

  const avgBw = totalRuns > 0 ? Math.round(cumulativeBw / totalRuns) : 0;
  const avgSt = totalRuns > 0 ? Math.round(cumulativeSt / totalRuns) : 0;
  const avgMs = totalRuns > 0 ? Math.round(cumulativeMs / totalRuns) : 0;
  const avgSkipped = totalRuns > 0 ? Math.round(cumulativeSkipped / totalRuns) : 0;
  const avgSkipRate =
    totalRuns > 0
      ? Math.round(perRunSavings.reduce((s, r) => s + r.skipRatePercent, 0) / totalRuns)
      : 0;

  return {
    seedUrl,
    generatedAt: new Date().toISOString(),
    totalDiffRuns: totalRuns,
    cumulative: {
      bandwidthSavedBytes: cumulativeBw,
      storageSavedBytes: cumulativeSt,
      processingTimeSavedMs: cumulativeMs,
      pagesSkipped: cumulativeSkipped,
      bandwidthSavedMb: Math.round((cumulativeBw / 1024 / 1024) * 100) / 100,
      processingTimeSavedSec: Math.round(cumulativeMs / 1000),
    },
    averagePerRun: {
      bandwidthSavedBytes: avgBw,
      storageSavedBytes: avgSt,
      processingTimeSavedMs: avgMs,
      pagesSkipped: avgSkipped,
      skipRatePercent: avgSkipRate,
    },
    perRunSavings,
  };
}

function buildManifestLineage(
  history: Awaited<ReturnType<typeof listDiffHistoryForSeedUrl>>,
  record: ScrapeJobRecord
): ManifestLineage {
  const sorted = history
    .slice()
    .sort((a, b) => a.computedAt.getTime() - b.computedAt.getTime());

  const diffGeneration = sorted.findIndex((h) => h.jobId === record.jobId);
  const currentIdx = diffGeneration >= 0 ? diffGeneration : sorted.length - 1;

  const ancestry: LineageNode[] = sorted.slice(0, currentIdx + 1).map((h, idx) => ({
    jobId: h.jobId,
    computedAt: h.computedAt.toISOString(),
    baseJobId: h.baseJobId ?? null,
    diffGeneration: idx,
  }));

  return {
    jobId: record.jobId,
    seedUrl: record.seedUrl,
    generatedAt: new Date().toISOString(),
    diffGeneration: currentIdx,
    parentJobId: record.baseJobId ?? null,
    ancestry,
    totalGenerations: sorted.length,
  };
}

function buildAuditReport(
  record: ScrapeJobRecord,
  diffReport: DiffReport,
  savingsReport: SavingsReport,
  timeline: SiteTimeline,
  hotspots: HotspotAnalysis,
  velocity: VelocityReport,
  lineage: ManifestLineage,
  savings: SavingsAnalytics,
  artifactsWritten: string[]
): DifferentialAuditReport {
  const isFirst = timeline.totalDiffRuns <= 1;

  const r2KeysExpected = [
    `jobs/${record.jobId}/_diff-report.json`,
    `jobs/${record.jobId}/_savings-report.json`,
    `jobs/${record.jobId}/_timeline.json`,
    `jobs/${record.jobId}/_hotspots.json`,
    `jobs/${record.jobId}/_velocity-report.json`,
    `jobs/${record.jobId}/_crawl-priority.json`,
    `jobs/${record.jobId}/_savings-analytics.json`,
    `jobs/${record.jobId}/_manifest-lineage.json`,
  ];

  const written = new Set(artifactsWritten);
  const status: DifferentialAuditReport["restorationCompatibility"]["status"] =
    r2KeysExpected.every((k) => written.has(k)) ? "COMPLETE" : "PARTIAL";

  return {
    jobId: record.jobId,
    baseJobId: record.baseJobId ?? null,
    seedUrl: record.seedUrl,
    generatedAt: new Date().toISOString(),
    runClassification: isFirst ? "FIRST_DIFF" : "DIFF_CRAWL",
    diffGeneration: lineage.diffGeneration,
    changeSummary: {
      new: diffReport.summary.new,
      changed: diffReport.summary.changed,
      unchanged: diffReport.summary.unchanged,
      deleted: diffReport.summary.deleted,
      total: diffReport.summary.total,
      skipRatePercent: Math.round(diffReport.summary.skipRate * 100),
    },
    savingsThisRun: {
      bandwidthSavedBytes: savingsReport.bandwidthSavedBytes,
      bandwidthSavedMb: Math.round((savingsReport.bandwidthSavedBytes / 1024 / 1024) * 100) / 100,
      storageSavedBytes: savingsReport.storageSavedBytes,
      processingTimeSavedMs: savingsReport.processingTimeSavedMs,
      processingTimeSavedSec: Math.round(savingsReport.processingTimeSavedMs / 1000),
      pagesSkipped: savingsReport.pagesSkipped,
    },
    cumulativeSavings: {
      bandwidthSavedBytes: savings.cumulative.bandwidthSavedBytes,
      bandwidthSavedMb: savings.cumulative.bandwidthSavedMb,
      storageSavedBytes: savings.cumulative.storageSavedBytes,
      processingTimeSavedMs: savings.cumulative.processingTimeSavedMs,
      totalDiffRuns: savings.totalDiffRuns,
    },
    timeline: {
      totalRuns: timeline.totalDiffRuns,
      firstRunAt: timeline.firstRunAt,
      latestRunAt: timeline.latestRunAt,
      isFirstDiffRun: isFirst,
    },
    hotspots: {
      topVolatileUrls: hotspots.topVolatile.slice(0, 5).map((h) => ({
        url: h.url,
        changeCount: h.changeCount,
      })),
      totalTrackedUrls: hotspots.totalUrlsTracked,
    },
    velocity: {
      stabilityScore: velocity.stabilityScore,
      trend: velocity.trend,
      changesPerWeek: velocity.velocity.changesPerWeek,
    },
    lineage: {
      diffGeneration: lineage.diffGeneration,
      parentJobId: lineage.parentJobId,
      ancestorCount: lineage.ancestry.length,
    },
    restorationCompatibility: {
      r2KeysExpected,
      status,
    },
    artifactsWritten,
  };
}

// ---------------------------------------------------------------------------
// Upload helper
// ---------------------------------------------------------------------------

async function uploadReport(
  cloudProvider: CloudProvider,
  key: string,
  data: unknown
): Promise<boolean> {
  try {
    await cloudProvider.upload({
      key,
      data: Buffer.from(JSON.stringify(data, null, 2), "utf8"),
      contentType: "application/json",
      checkDuplicate: false,
    });
    return true;
  } catch (err) {
    logger.warn({ err, key }, "INTELLIGENCE: failed to upload report");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs the full differential intelligence layer after a diff job completes.
 * Non-fatal — failures are logged but never bubble up to fail the job.
 */
export async function runIntelligenceLayer(
  record: ScrapeJobRecord,
  diffReport: DiffReport,
  savingsReport: SavingsReport,
  cloudProvider: CloudProvider
): Promise<void> {
  const startMs = Date.now();
  logger.info({ jobId: record.jobId }, "INTELLIGENCE: starting intelligence layer");

  try {
    // 1. Build compact changed-URLs list and persist history in DB
    const changedUrls = buildChangedUrls(diffReport);
    await insertDiffHistory({
      id: randomUUID(),
      jobId: record.jobId,
      baseJobId: record.baseJobId ?? null,
      seedUrl: record.seedUrl,
      computedAt: new Date(),
      pagesScanned: savingsReport.pagesScanned,
      newCount: diffReport.summary.new,
      changedCount: diffReport.summary.changed,
      unchangedCount: diffReport.summary.unchanged,
      deletedCount: diffReport.summary.deleted,
      bandwidthSavedBytes: savingsReport.bandwidthSavedBytes,
      storageSavedBytes: savingsReport.storageSavedBytes,
      processingTimeSavedMs: savingsReport.processingTimeSavedMs,
      skipRatePercent: savingsReport.skipRatePercent,
      changedUrlsJson: JSON.stringify(changedUrls),
    });

    // 2. Load full history for this seed URL (includes the just-inserted entry)
    const history = await listDiffHistoryForSeedUrl(record.seedUrl, 200);

    // 3. Generate all reports
    const timeline = buildTimeline(history);
    const hotspots = buildHotspots(history, record.seedUrl);
    const velocity = buildVelocityReport(history, record.seedUrl);
    const crawlPriority = buildCrawlPriority(hotspots);
    const savingsAnalytics = buildSavingsAnalytics(history, record.seedUrl);
    const lineage = buildManifestLineage(history, record);

    // 4. Upload all reports to R2 in parallel
    const uploads = await Promise.all([
      uploadReport(cloudProvider, `jobs/${record.jobId}/_timeline.json`, timeline).then(
        (ok) => (ok ? `jobs/${record.jobId}/_timeline.json` : null)
      ),
      uploadReport(cloudProvider, `jobs/${record.jobId}/_hotspots.json`, hotspots).then(
        (ok) => (ok ? `jobs/${record.jobId}/_hotspots.json` : null)
      ),
      uploadReport(cloudProvider, `jobs/${record.jobId}/_velocity-report.json`, velocity).then(
        (ok) => (ok ? `jobs/${record.jobId}/_velocity-report.json` : null)
      ),
      uploadReport(cloudProvider, `jobs/${record.jobId}/_crawl-priority.json`, crawlPriority).then(
        (ok) => (ok ? `jobs/${record.jobId}/_crawl-priority.json` : null)
      ),
      uploadReport(
        cloudProvider,
        `jobs/${record.jobId}/_savings-analytics.json`,
        savingsAnalytics
      ).then((ok) => (ok ? `jobs/${record.jobId}/_savings-analytics.json` : null)),
      uploadReport(
        cloudProvider,
        `jobs/${record.jobId}/_manifest-lineage.json`,
        lineage
      ).then((ok) => (ok ? `jobs/${record.jobId}/_manifest-lineage.json` : null)),
    ]);

    const artifactsWritten: string[] = [
      `jobs/${record.jobId}/_diff-report.json`,
      `jobs/${record.jobId}/_savings-report.json`,
      ...uploads.filter((k): k is string => k !== null),
    ];

    // 5. Build and upload audit report
    const auditReport = buildAuditReport(
      record,
      diffReport,
      savingsReport,
      timeline,
      hotspots,
      velocity,
      lineage,
      savingsAnalytics,
      artifactsWritten
    );

    const auditKey = `jobs/${record.jobId}/_differential-audit-report.json`;
    const auditOk = await uploadReport(cloudProvider, auditKey, auditReport);
    if (auditOk) artifactsWritten.push(auditKey);

    const durationMs = Date.now() - startMs;
    logger.info(
      {
        jobId: record.jobId,
        diffGeneration: lineage.diffGeneration,
        totalDiffRuns: timeline.totalDiffRuns,
        stabilityScore: velocity.stabilityScore,
        trend: velocity.trend,
        topVolatileCount: hotspots.topVolatile.length,
        artifactsWritten: artifactsWritten.length,
        durationMs,
      },
      "INTELLIGENCE: intelligence layer complete"
    );
  } catch (err) {
    logger.warn({ err, jobId: record.jobId }, "INTELLIGENCE: intelligence layer failed (non-fatal)");
  }
}

/**
 * Load a single JSON report from R2 for a given job.
 * Returns null if not found or if cloud not configured.
 */
export async function loadIntelligenceReport<T>(
  cloudProvider: CloudProvider,
  jobId: string,
  reportName:
    | "_timeline.json"
    | "_hotspots.json"
    | "_velocity-report.json"
    | "_crawl-priority.json"
    | "_savings-analytics.json"
    | "_manifest-lineage.json"
    | "_differential-audit-report.json"
): Promise<T | null> {
  if (!cloudProvider.isConfigured()) return null;

  try {
    const data = await cloudProvider.download(`jobs/${jobId}/${reportName}`);
    if (!data) return null;
    return JSON.parse(data.toString("utf8")) as T;
  } catch {
    return null;
  }
}

export { getDiffHistoryForJob };
