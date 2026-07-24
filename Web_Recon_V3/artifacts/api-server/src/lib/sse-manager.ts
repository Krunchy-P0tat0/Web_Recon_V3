/**
 * sse-manager.ts — Centralized SSE client registry and broadcaster.
 *
 * Channels:
 *   "all"                     → /api/events/platform    (every event)
 *   "subsystem:pipeline"      → /api/events/pipeline
 *   "subsystem:recovery"      → /api/events/recovery
 *   "subsystem:storage"       → /api/events/storage
 *   "subsystem:checkpoints"   → /api/events/checkpoints
 *   "subsystem:coverage"      → /api/events/coverage
 *   "subsystem:differential"  → /api/events/differential
 *   "job:<jobId>"             → /api/events/jobs/:jobId
 *
 * Backpressure: each client carries a bounded write queue (MAX_QUEUE).
 * When res.write() returns false (TCP buffer full), payloads are queued and
 * flushed on the 'drain' event. Clients whose queue exceeds MAX_QUEUE are
 * disconnected — they are too far behind to catch up safely.
 *
 * Channel cleanup: empty Sets are removed from the Map when the last client
 * disconnects, preventing unbounded growth over many unique job IDs.
 */

import type { Request, Response } from "express";
import { webReconBus, type WebReconEvent } from "./event-bus.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_QUEUE    = 200;   // max buffered payloads before a client is dropped
const HEARTBEAT_MS = 15_000;

// ---------------------------------------------------------------------------
// Client record
// ---------------------------------------------------------------------------

interface SseClient {
  id:       string;
  res:      Response;
  hb:       ReturnType<typeof setInterval>;
  queue:    string[];   // pending SSE payloads
  draining: boolean;    // true while waiting for TCP 'drain'
  closed:   boolean;    // set on cleanup to avoid double-remove
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

class SseManager {
  private static _instance: SseManager;
  private channels = new Map<string, Set<SseClient>>();
  private seq      = 0;

  private constructor() {
    webReconBus.on("event", (evt: WebReconEvent) => {
      this._broadcast("all",                        "webrecon-event", evt);
      this._broadcast(`subsystem:${evt.subsystem}`, "webrecon-event", evt);
      if (evt.jobId) this._broadcast(`job:${evt.jobId}`, "webrecon-event", evt);
    });
  }

  static get instance(): SseManager {
    if (!SseManager._instance) SseManager._instance = new SseManager();
    return SseManager._instance;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  subscribe(
    channelKey:    string,
    req:           Request,
    res:           Response,
    replayBuffer:  WebReconEvent[] = [],
  ): () => void {
    res.setHeader("Content-Type",        "text/event-stream");
    res.setHeader("Cache-Control",       "no-cache");
    res.setHeader("Connection",          "keep-alive");
    res.setHeader("X-Accel-Buffering",   "no");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.flushHeaders();

    const id     = `sse-${++this.seq}`;
    const client: SseClient = {
      id,
      res,
      hb:       null as unknown as ReturnType<typeof setInterval>,
      queue:    [],
      draining: false,
      closed:   false,
    };

    // Wire the drain handler — flushes the bounded queue when TCP catches up
    res.on("drain", () => {
      client.draining = false;
      this._flush(client);
    });

    // Ack + replay
    this._writeClient(client, `event: connected\ndata: ${JSON.stringify({
      clientId:    id,
      channel:     channelKey,
      serverTime:  new Date().toISOString(),
      replayCount: replayBuffer.length,
    })}\n\n`);

    for (const evt of replayBuffer) {
      this._writeClient(client, `event: webrecon-event\ndata: ${JSON.stringify(evt)}\n\n`);
    }

    // Heartbeat
    client.hb = setInterval(() => {
      this._writeClient(client, ": heartbeat\n\n");
    }, HEARTBEAT_MS);

    this._addClient(channelKey, client);
    logger.info({ clientId: id, channelKey }, "SSE: client connected");

    const cleanup = (): void => {
      if (client.closed) return;
      client.closed = true;
      clearInterval(client.hb);
      this._removeClient(channelKey, client);
      logger.info({ clientId: id, channelKey }, "SSE: client disconnected");
    };

    req.on("close", cleanup);
    return cleanup;
  }

  /** Broadcast an arbitrary named event to a channel (used by subsystem emitters). */
  broadcast(channelKey: string, eventName: string, data: unknown): void {
    this._broadcast(channelKey, eventName, data);
  }

  getStats(): { total: number; byChannel: Record<string, number> } {
    let total = 0;
    const byChannel: Record<string, number> = {};
    for (const [key, set] of this.channels) {
      byChannel[key] = set.size;
      total += set.size;
    }
    return { total, byChannel };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _addClient(channelKey: string, client: SseClient): void {
    if (!this.channels.has(channelKey)) this.channels.set(channelKey, new Set());
    this.channels.get(channelKey)!.add(client);
  }

  private _removeClient(channelKey: string, client: SseClient): void {
    const set = this.channels.get(channelKey);
    if (!set) return;
    set.delete(client);
    // Remove empty Sets to prevent unbounded Map growth for job:* channels
    if (set.size === 0) this.channels.delete(channelKey);
  }

  private _broadcast(channelKey: string, eventName: string, data: unknown): void {
    const set = this.channels.get(channelKey);
    if (!set || set.size === 0) return;
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of set) {
      this._writeClient(client, payload);
    }
  }

  /**
   * Write a payload to a single client, respecting TCP backpressure.
   *
   * - If not draining: write directly; if the kernel buffer is full (write → false),
   *   enter draining mode and enqueue the payload.
   * - If draining: enqueue; if queue exceeds MAX_QUEUE the client is too far
   *   behind — disconnect it to prevent unbounded memory growth.
   */
  private _writeClient(client: SseClient, payload: string): void {
    if (client.closed) return;

    if (client.draining) {
      if (client.queue.length >= MAX_QUEUE) {
        // Client cannot keep up — close it
        logger.warn({ clientId: client.id }, "SSE: client queue full — disconnecting");
        client.closed = true;
        clearInterval(client.hb);
        try { client.res.end(); } catch (_) {}
        return;
      }
      client.queue.push(payload);
      return;
    }

    try {
      const ok = client.res.write(payload);
      if (!ok) {
        client.draining = true;
        // Don't enqueue here; the direct write already sent it to the kernel buffer.
      }
    } catch (_) {
      // Socket gone — mark closed; cleanup fires on 'close' event
      client.closed = true;
    }
  }

  /** Flush queued payloads after a TCP 'drain'. */
  private _flush(client: SseClient): void {
    while (client.queue.length > 0 && !client.draining && !client.closed) {
      const payload = client.queue.shift()!;
      try {
        const ok = client.res.write(payload);
        if (!ok) {
          client.draining = true;
          return;
        }
      } catch (_) {
        client.closed = true;
        return;
      }
    }
  }
}

export const sseManager = SseManager.instance;
