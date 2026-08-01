/**
 * event-bus.ts — Phase 7.6: Pipeline Event Bus
 *
 * Singleton EventEmitter that carries typed pipeline events.
 * Producers (master-orchestrator, deployment-executor, rollback) call emit().
 * Consumers (SSE route, event-stream-report writer) call on().
 *
 * Events are also stored in an in-memory ring buffer (last 500) so new SSE
 * connections can replay recent history, and the report file is always fresh.
 */

import { EventEmitter } from "events";
import { writeFile }    from "fs/promises";
import { join }         from "path";
import { logger }       from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type PipelineEventType =
  | "job-started"
  | "crawl-started"
  | "crawl-complete"
  | "manifest-generated"
  | "diff-computed"
  | "intelligence-complete"
  | "design-dna-complete"
  | "visual-dna-complete"
  | "stencil-generated"
  | "website-prime-complete"
  | "merge-complete"
  | "deployment-plan-ready"
  | "deployment-complete"
  | "certification-complete"
  | "rollback-complete"
  | "job-complete"
  | "job-failed"
  | "job-cancelled"
  | "stage-retrying"
  | "pipeline-paused"
  | "pipeline-resumed"
  | "approval-requested"
  | "approval-granted"
  | "approval-rejected"
  | "decision-made";

export interface PipelineEvent {
  id:            string;
  type:          PipelineEventType;
  pipelineJobId: string | null;
  stageId:       string | null;
  at:            string;
  data:          Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal bus + ring buffer
// ---------------------------------------------------------------------------

class PipelineEventBus extends EventEmitter {
  private static _instance: PipelineEventBus;
  private _buffer: PipelineEvent[] = [];
  private readonly BUFFER_SIZE = 500;
  private _seq = 0;

  private constructor() {
    super();
    this.setMaxListeners(200);   // many SSE clients can listen
  }

  static get instance(): PipelineEventBus {
    if (!PipelineEventBus._instance) {
      PipelineEventBus._instance = new PipelineEventBus();
    }
    return PipelineEventBus._instance;
  }

  publish(
    type:          PipelineEventType,
    pipelineJobId: string | null,
    data:          Record<string, unknown> = {},
    stageId:       string | null           = null,
  ): PipelineEvent {
    const event: PipelineEvent = {
      id:            `evt-${Date.now()}-${++this._seq}`,
      type,
      pipelineJobId,
      stageId,
      at:            new Date().toISOString(),
      data,
    };

    // Ring buffer — drop oldest when full
    if (this._buffer.length >= this.BUFFER_SIZE) {
      this._buffer.shift();
    }
    this._buffer.push(event);

    this.emit("event", event);
    this.emit(`event:${type}`, event);
    if (pipelineJobId) this.emit(`job:${pipelineJobId}`, event);

    logger.info({ eventId: event.id, type, pipelineJobId, stageId }, "EVENT-BUS: published");

    // Persist report async, non-blocking
    void persistEventReport().catch(() => {});

    return event;
  }

  /** Returns all buffered events, optionally filtered by jobId */
  getBuffer(pipelineJobId?: string): PipelineEvent[] {
    if (!pipelineJobId) return [...this._buffer];
    return this._buffer.filter((e) => e.pipelineJobId === pipelineJobId);
  }

  /** Summary counts for the report */
  getSummary(): Record<PipelineEventType | string, number> {
    const counts: Record<string, number> = {};
    for (const e of this._buffer) {
      counts[e.type] = (counts[e.type] ?? 0) + 1;
    }
    return counts;
  }
}

export const eventBus = PipelineEventBus.instance;

// ---------------------------------------------------------------------------
// Convenience publisher (used by master-orchestrator and others)
// ---------------------------------------------------------------------------

export function publishEvent(
  type:          PipelineEventType,
  pipelineJobId: string | null,
  data:          Record<string, unknown> = {},
  stageId?:      string,
): PipelineEvent {
  return eventBus.publish(type, pipelineJobId, data, stageId ?? null);
}

// ---------------------------------------------------------------------------
// event-stream-report.json persistence
// ---------------------------------------------------------------------------

const REPORT_PATH    = join(process.cwd(), "event-stream-report.json");
const REPORT_PATH_UP = join(process.cwd(), "..", "..", "event-stream-report.json");

// ============================================================================
// WebRecon Unified Event Envelope
// ============================================================================

export type Subsystem =
  | "pipeline"
  | "recovery"
  | "storage"
  | "checkpoints"
  | "coverage"
  | "differential"
  | "platform";

export type Severity = "info" | "warn" | "error" | "critical";

export interface WebReconEvent {
  id:        string;
  timestamp: string;                  // ISO-8601
  jobId:     string | null;
  subsystem: Subsystem;
  event:     string;                  // machine-readable event name
  severity:  Severity;
  payload:   Record<string, unknown>;
}

class WebReconEventBus extends EventEmitter {
  private static _instance: WebReconEventBus;
  private _buffer: WebReconEvent[] = [];
  private readonly BUFFER_SIZE = 1000;
  private _seq = 0;

  private constructor() {
    super();
    this.setMaxListeners(300);
  }

  static get instance(): WebReconEventBus {
    if (!WebReconEventBus._instance) {
      WebReconEventBus._instance = new WebReconEventBus();
    }
    return WebReconEventBus._instance;
  }

  publish(
    subsystem: Subsystem,
    event:     string,
    jobId:     string | null = null,
    severity:  Severity      = "info",
    payload:   Record<string, unknown> = {},
  ): WebReconEvent {
    const evt: WebReconEvent = {
      id:        `wre-${Date.now()}-${++this._seq}`,
      timestamp: new Date().toISOString(),
      jobId,
      subsystem,
      event,
      severity,
      payload,
    };

    if (this._buffer.length >= this.BUFFER_SIZE) this._buffer.shift();
    this._buffer.push(evt);

    this.emit("event", evt);
    this.emit(`subsystem:${subsystem}`, evt);
    if (jobId) this.emit(`job:${jobId}`, evt);

    return evt;
  }

  getBuffer(filter?: {
    subsystem?: Subsystem;
    jobId?:     string;
    limit?:     number;
  }): WebReconEvent[] {
    let buf = [...this._buffer];
    if (filter?.subsystem) buf = buf.filter((e) => e.subsystem === filter.subsystem);
    if (filter?.jobId)     buf = buf.filter((e) => e.jobId     === filter.jobId);
    if (filter?.limit)     buf = buf.slice(-filter.limit);
    return buf;
  }
}

export const webReconBus = WebReconEventBus.instance;

export function publishWebReconEvent(
  subsystem: Subsystem,
  event:     string,
  jobId?:    string | null,
  severity:  Severity = "info",
  payload:   Record<string, unknown> = {},
): WebReconEvent {
  return webReconBus.publish(subsystem, event, jobId ?? null, severity, payload);
}

// ============================================================================

export async function persistEventReport(): Promise<void> {
  const events = eventBus.getBuffer();
  const doc = {
    version:     "1.0",
    phase:       "7.6",
    generatedAt: new Date().toISOString(),
    totalEvents: events.length,
    summary:     eventBus.getSummary(),
    events,
  };
  const json  = JSON.stringify(doc, null, 2);
  const cloud = getDefaultCloudProvider();

  await Promise.allSettled([
    writeFile(REPORT_PATH,    json, "utf8"),
    writeFile(REPORT_PATH_UP, json, "utf8"),
    ...(cloud.isConfigured() ? [
      cloud.upload({
        key:            "orchestration/event-stream-report.json",
        data:           Buffer.from(json, "utf8"),
        contentType:    "application/json",
        checkDuplicate: false,
      }),
    ] : []),
  ]);
}
