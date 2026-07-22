/**
 * subsystem-emitters.ts — Auto-emit events from every platform subsystem.
 *
 * Call startSubsystemEmitters() once at server startup.
 * Each emitter runs independently and publishes to webReconBus,
 * which the sseManager then broadcasts to all connected clients.
 *
 * Subsystems covered:
 *   pipeline     — bridged from existing PipelineEventBus
 *   checkpoints  — polls .checkpoints/watcher-status.json every 30s
 *   storage      — polls R2 upload counters + monitors cloud events
 *   recovery     — polls recovery-report.json every 45s
 *   coverage     — derived from manifest/crawl pipeline events
 *   differential — derived from diff pipeline events
 */

import { readFile } from "fs/promises";
import { join }     from "path";
import { eventBus, publishWebReconEvent, type PipelineEvent } from "./event-bus.js";
import { logger }   from "./logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = join(process.cwd(), "..", "..");

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. Pipeline bridge — converts existing PipelineEvents → WebReconEvents
// ---------------------------------------------------------------------------

type PipelineSubsystem = "pipeline" | "differential" | "recovery" | "coverage";
type Severity = "info" | "warn" | "error" | "critical";

function pipelineEventToSubsystem(type: string): PipelineSubsystem {
  if (type === "diff-computed")         return "differential";
  if (type === "rollback-complete")     return "recovery";
  if (
    type === "manifest-generated" ||
    type === "crawl-complete"
  )                                     return "coverage";
  return "pipeline";
}

function pipelineEventToSeverity(type: string): Severity {
  if (type === "job-failed")            return "error";
  if (
    type === "stage-retrying"    ||
    type === "approval-rejected" ||
    type === "pipeline-paused"   ||
    type === "job-cancelled"
  )                                     return "warn";
  return "info";
}

function startPipelineBridge(): void {
  eventBus.on("event", (evt: PipelineEvent) => {
    publishWebReconEvent(
      pipelineEventToSubsystem(evt.type),
      evt.type,
      evt.pipelineJobId,
      pipelineEventToSeverity(evt.type),
      {
        stageId: evt.stageId,
        pipelineEventId: evt.id,
        ...evt.data,
      },
    );
  });

  logger.info("SubsystemEmitter: pipeline bridge started");
}

// ---------------------------------------------------------------------------
// 2. Checkpoints emitter — polls watcher-status.json
// ---------------------------------------------------------------------------

interface WatcherStatus {
  lastSave?:     string;
  lastMilestone?: string;
  saveCount?:    number;
  autosaveRef?:  string;
  [k: string]:   unknown;
}

function startCheckpointsEmitter(intervalMs = 30_000): void {
  const statusPath = join(process.cwd(), ".checkpoints", "watcher-status.json");

  let lastSeen: string | null = null;

  const poll = async (): Promise<void> => {
    const status = await readJson<WatcherStatus>(statusPath);
    if (!status) return;

    // Fingerprint to detect actual change
    const fingerprint = JSON.stringify({
      lastSave:      status["lastSave"],
      saveCount:     status["saveCount"],
      autosaveRef:   status["autosaveRef"],
      lastMilestone: status["lastMilestone"],
    });

    if (fingerprint === lastSeen) return;
    lastSeen = fingerprint;

    publishWebReconEvent(
      "checkpoints",
      "checkpoint-status-updated",
      null,
      "info",
      {
        lastSave:      status["lastSave"]      ?? null,
        lastMilestone: status["lastMilestone"] ?? null,
        saveCount:     status["saveCount"]     ?? 0,
        autosaveRef:   status["autosaveRef"]   ?? null,
        raw:           status,
      },
    );
  };

  // Run immediately, then on interval
  void poll().catch(() => {});
  setInterval(() => void poll().catch(() => {}), intervalMs);

  logger.info({ intervalMs }, "SubsystemEmitter: checkpoints emitter started");
}

// ---------------------------------------------------------------------------
// 3. Storage emitter — polls cloud event log / R2 stats
// ---------------------------------------------------------------------------

interface StorageReport {
  uploadsTotal?:    number;
  lastUploadKey?:   string;
  lastUploadAt?:    string;
  bytesTotal?:      number;
  [k: string]:      unknown;
}

function startStorageEmitter(intervalMs = 60_000): void {
  // Try multiple possible report paths
  const candidates = [
    join(process.cwd(), "r2-upload-report.json"),
    join(ROOT, "r2-upload-report.json"),
    join(process.cwd(), "storage-report.json"),
  ];

  let lastCount: number | null = null;
  let lastKey:   string | null = null;

  const poll = async (): Promise<void> => {
    let report: StorageReport | null = null;
    for (const path of candidates) {
      report = await readJson<StorageReport>(path);
      if (report) break;
    }
    if (!report) return;

    const count = report["uploadsTotal"] ?? null;
    const key   = report["lastUploadKey"] ?? null;

    if (count === lastCount && key === lastKey) return;
    lastCount = count as number;
    lastKey   = key as string;

    publishWebReconEvent(
      "storage",
      "storage-stats-updated",
      null,
      "info",
      {
        uploadsTotal:  report["uploadsTotal"]  ?? 0,
        bytesTotal:    report["bytesTotal"]    ?? 0,
        lastUploadKey: report["lastUploadKey"] ?? null,
        lastUploadAt:  report["lastUploadAt"]  ?? null,
      },
    );
  };

  void poll().catch(() => {});
  setInterval(() => void poll().catch(() => {}), intervalMs);

  // Also listen for pipeline events that imply R2 uploads
  eventBus.on("event", (evt: PipelineEvent) => {
    const uploadEvents = [
      "manifest-generated",
      "intelligence-complete",
      "design-dna-complete",
      "visual-dna-complete",
      "merge-complete",
      "deployment-complete",
    ];
    if (!uploadEvents.includes(evt.type)) return;

    publishWebReconEvent(
      "storage",
      "storage-artifact-uploaded",
      evt.pipelineJobId,
      "info",
      {
        trigger:    evt.type,
        stageId:    evt.stageId,
        pipelineId: evt.pipelineJobId,
      },
    );
  });

  logger.info({ intervalMs }, "SubsystemEmitter: storage emitter started");
}

// ---------------------------------------------------------------------------
// 4. Recovery emitter — polls recovery-report.json
// ---------------------------------------------------------------------------

interface RecoveryReport {
  timestamp?:       string;
  status?:          string;
  activeRecoveries?: number;
  lastRecovery?:    { jobId?: string; reason?: string; at?: string };
  [k: string]:      unknown;
}

function startRecoveryEmitter(intervalMs = 45_000): void {
  const candidates = [
    join(process.cwd(), "recovery-report.json"),
    join(ROOT, "recovery-report.json"),
  ];

  let lastTimestamp: string | null = null;

  const poll = async (): Promise<void> => {
    let report: RecoveryReport | null = null;
    for (const path of candidates) {
      report = await readJson<RecoveryReport>(path);
      if (report) break;
    }
    if (!report) return;

    const ts = report["timestamp"] ?? null;
    if (ts === lastTimestamp) return;
    lastTimestamp = ts as string;

    const severity: Severity =
      report["status"] === "failed" ? "error"
      : report["status"] === "recovering" ? "warn"
      : "info";

    publishWebReconEvent(
      "recovery",
      "recovery-status-updated",
      report["lastRecovery"]?.["jobId"] ?? null,
      severity,
      {
        status:           report["status"]           ?? "idle",
        activeRecoveries: report["activeRecoveries"] ?? 0,
        lastRecovery:     report["lastRecovery"]     ?? null,
        timestamp:        ts,
      },
    );
  };

  void poll().catch(() => {});
  setInterval(() => void poll().catch(() => {}), intervalMs);

  // Bridge recovery pipeline events
  const recoveryTypes = ["rollback-complete", "stage-retrying", "job-failed"];
  eventBus.on("event", (evt: PipelineEvent) => {
    if (!recoveryTypes.includes(evt.type)) return;
    publishWebReconEvent(
      "recovery",
      evt.type === "rollback-complete" ? "recovery-rollback-complete"
        : evt.type === "job-failed"    ? "recovery-job-failed"
        : "recovery-stage-retrying",
      evt.pipelineJobId,
      evt.type === "job-failed" ? "error" : "warn",
      { stageId: evt.stageId, ...evt.data },
    );
  });

  logger.info({ intervalMs }, "SubsystemEmitter: recovery emitter started");
}

// ---------------------------------------------------------------------------
// 5. Coverage emitter — derived from manifest/crawl events
// ---------------------------------------------------------------------------

function startCoverageEmitter(): void {
  eventBus.on("event", (evt: PipelineEvent) => {
    if (evt.type === "crawl-complete") {
      const data = evt.data as Record<string, unknown>;
      publishWebReconEvent(
        "coverage",
        "coverage-crawl-complete",
        evt.pipelineJobId,
        "info",
        {
          pagesDiscovered: data["pagesDiscovered"] ?? null,
          pagesScraped:    data["pagesScraped"]    ?? null,
          coveragePct:     data["coveragePct"]     ?? null,
          url:             data["url"]             ?? null,
        },
      );
    }

    if (evt.type === "manifest-generated") {
      const data = evt.data as Record<string, unknown>;
      const coveragePct = data["coveragePct"] as number | null ?? null;
      const threshold   = data["threshold"]   as number | null ?? 96;
      const passed      = coveragePct != null ? coveragePct >= threshold : null;

      publishWebReconEvent(
        "coverage",
        "coverage-manifest-generated",
        evt.pipelineJobId,
        passed === false ? "warn" : "info",
        {
          coveragePct,
          threshold,
          passed,
          totalNodes:   data["totalNodes"]   ?? null,
          completed:    data["completed"]    ?? null,
        },
      );
    }
  });

  logger.info("SubsystemEmitter: coverage emitter started");
}

// ---------------------------------------------------------------------------
// 6. Differential emitter — derived from diff events
// ---------------------------------------------------------------------------

function startDifferentialEmitter(): void {
  eventBus.on("event", (evt: PipelineEvent) => {
    if (evt.type !== "diff-computed") return;
    const data = evt.data as Record<string, unknown>;

    publishWebReconEvent(
      "differential",
      "differential-computed",
      evt.pipelineJobId,
      "info",
      {
        changesDetected: data["changesDetected"] ?? null,
        addedNodes:      data["addedNodes"]      ?? null,
        removedNodes:    data["removedNodes"]    ?? null,
        modifiedNodes:   data["modifiedNodes"]   ?? null,
        diffSizeBytes:   data["diffSizeBytes"]   ?? null,
      },
    );
  });

  logger.info("SubsystemEmitter: differential emitter started");
}

// ---------------------------------------------------------------------------
// 7. Platform heartbeat — broadcasts system health every 60s
// ---------------------------------------------------------------------------

function startPlatformHeartbeat(intervalMs = 60_000): void {
  setInterval(() => {
    publishWebReconEvent(
      "platform",
      "platform-heartbeat",
      null,
      "info",
      {
        uptimeSeconds: Math.floor(process.uptime()),
        memoryMB:      Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        nodeVersion:   process.version,
        pid:           process.pid,
      },
    );
  }, intervalMs);

  logger.info({ intervalMs }, "SubsystemEmitter: platform heartbeat started");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function startSubsystemEmitters(): void {
  try {
    startPipelineBridge();
    startCheckpointsEmitter();
    startStorageEmitter();
    startRecoveryEmitter();
    startCoverageEmitter();
    startDifferentialEmitter();
    startPlatformHeartbeat();

    logger.info("SubsystemEmitters: all emitters started");
  } catch (err) {
    logger.error({ err }, "SubsystemEmitters: startup error");
  }
}
