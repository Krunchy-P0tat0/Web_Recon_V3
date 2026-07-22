/**
 * events.ts — Real-time SSE endpoints for every platform subsystem.
 *
 * All endpoints share the same WebReconEvent envelope:
 *   { id, timestamp, jobId, subsystem, event, severity, payload }
 *
 * Routes:
 *   GET /api/events/platform        → all events (master channel)
 *   GET /api/events/jobs/:jobId     → events for one job
 *   GET /api/events/pipeline        → pipeline subsystem only
 *   GET /api/events/recovery        → recovery subsystem only
 *   GET /api/events/storage         → storage subsystem only
 *   GET /api/events/checkpoints     → checkpoints subsystem only
 *   GET /api/events/coverage        → coverage subsystem only
 *   GET /api/events/differential    → differential subsystem only
 *   GET /api/events/stats           → connection stats (JSON, not SSE)
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { webReconBus, type Subsystem }  from "../lib/event-bus.js";
import { sseManager }                   from "../lib/sse-manager.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Replay the last N events from the WebRecon buffer, optionally filtered. */
function replayBuffer(opts: { subsystem?: Subsystem; jobId?: string; limit?: number }) {
  return webReconBus.getBuffer({ ...opts, limit: opts.limit ?? 100 });
}

// ---------------------------------------------------------------------------
// GET /api/events/platform  — master channel, all events
// ---------------------------------------------------------------------------

router.get("/events/platform", (req: Request, res: Response) => {
  sseManager.subscribe("all", req, res, replayBuffer({ limit: 100 }));
});

// ---------------------------------------------------------------------------
// GET /api/events/jobs/:jobId  — per-job events
// ---------------------------------------------------------------------------

router.get("/events/jobs/:jobId", (req: Request, res: Response) => {
  const jobId = req.params["jobId"] as string;
  sseManager.subscribe(
    `job:${jobId}`,
    req,
    res,
    replayBuffer({ jobId, limit: 200 }),
  );
});

// ---------------------------------------------------------------------------
// GET /api/events/pipeline
// ---------------------------------------------------------------------------

router.get("/events/pipeline", (req: Request, res: Response) => {
  sseManager.subscribe(
    "subsystem:pipeline",
    req,
    res,
    replayBuffer({ subsystem: "pipeline", limit: 50 }),
  );
});

// ---------------------------------------------------------------------------
// GET /api/events/recovery
// ---------------------------------------------------------------------------

router.get("/events/recovery", (req: Request, res: Response) => {
  sseManager.subscribe(
    "subsystem:recovery",
    req,
    res,
    replayBuffer({ subsystem: "recovery", limit: 50 }),
  );
});

// ---------------------------------------------------------------------------
// GET /api/events/storage
// ---------------------------------------------------------------------------

router.get("/events/storage", (req: Request, res: Response) => {
  sseManager.subscribe(
    "subsystem:storage",
    req,
    res,
    replayBuffer({ subsystem: "storage", limit: 50 }),
  );
});

// ---------------------------------------------------------------------------
// GET /api/events/checkpoints
// ---------------------------------------------------------------------------

router.get("/events/checkpoints", (req: Request, res: Response) => {
  sseManager.subscribe(
    "subsystem:checkpoints",
    req,
    res,
    replayBuffer({ subsystem: "checkpoints", limit: 50 }),
  );
});

// ---------------------------------------------------------------------------
// GET /api/events/coverage
// ---------------------------------------------------------------------------

router.get("/events/coverage", (req: Request, res: Response) => {
  sseManager.subscribe(
    "subsystem:coverage",
    req,
    res,
    replayBuffer({ subsystem: "coverage", limit: 50 }),
  );
});

// ---------------------------------------------------------------------------
// GET /api/events/differential
// ---------------------------------------------------------------------------

router.get("/events/differential", (req: Request, res: Response) => {
  sseManager.subscribe(
    "subsystem:differential",
    req,
    res,
    replayBuffer({ subsystem: "differential", limit: 50 }),
  );
});

// ---------------------------------------------------------------------------
// GET /api/events/stats  — JSON snapshot of connected clients (not SSE)
// ---------------------------------------------------------------------------

router.get("/events/stats", (_req: Request, res: Response) => {
  const stats = sseManager.getStats();
  res.json({
    ok: true,
    connectedAt: new Date().toISOString(),
    ...stats,
  });
});

export default router;
