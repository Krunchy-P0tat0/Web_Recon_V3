/**
 * human-override.ts — Phase 7.4 routes
 *
 * Checkpoint policy management:
 *   GET  /api/overrides/policy                       — full policy document
 *   PUT  /api/overrides/policy/global                — set global mode
 *   GET  /api/overrides/policy/:checkpointId         — get one checkpoint policy
 *   PUT  /api/overrides/policy/:checkpointId         — update one checkpoint policy
 *   POST /api/overrides/policy/:checkpointId/reset   — reset to default
 *
 * Approval request lifecycle:
 *   POST /api/overrides/request                      — create approval request
 *   GET  /api/overrides/requests                     — list all requests
 *   GET  /api/overrides/requests/pending             — pending only
 *   GET  /api/overrides/requests/:id                 — get one request
 *   POST /api/overrides/requests/:id/approve         — approve
 *   POST /api/overrides/requests/:id/reject          — reject
 *
 * Utility:
 *   POST /api/overrides/expire                       — expire stale requests
 */

import { Router, type IRouter } from "express";
import {
  getAllPolicies,
  getPolicy,
  setGlobalMode,
  updatePolicy,
  resetPolicy,
  getGlobalMode,
  createApprovalRequest,
  getApprovalRequest,
  listApprovalRequests,
  approve,
  reject,
  expireStaleRequests,
  loadPolicyFromDisk,
  persistPolicy,
} from "../lib/human-override-engine.js";
import type { OverrideMode, CheckpointId } from "../lib/human-override-engine.js";

const router: IRouter = Router();

const VALID_MODES       = new Set<OverrideMode>(["AUTO", "SEMI_AUTO", "MANUAL"]);
const VALID_CHECKPOINTS = new Set<CheckpointId>([
  "before-merge", "before-deployment", "before-deletion", "before-rollback",
]);

// ---------------------------------------------------------------------------
// GET /overrides/policy — full policy document
// ---------------------------------------------------------------------------

router.get("/overrides/policy", async (_req, res): Promise<void> => {
  const policies = getAllPolicies();
  res.json({
    version:     "1.0",
    phase:       "7.4",
    generatedAt: new Date().toISOString(),
    globalMode:  getGlobalMode(),
    checkpoints: policies,
    policyFile:  "override-policy.json",
  });
});

// ---------------------------------------------------------------------------
// PUT /overrides/policy/global — set global mode
// ---------------------------------------------------------------------------

router.put("/overrides/policy/global", (req, res): void => {
  const { mode } = (req.body ?? {}) as { mode?: string };
  if (!mode || !VALID_MODES.has(mode as OverrideMode)) {
    res.status(400).json({ error: `mode must be one of: ${[...VALID_MODES].join(", ")}` });
    return;
  }
  setGlobalMode(mode as OverrideMode);
  void persistPolicy().catch(() => {});
  res.json({ globalMode: getGlobalMode(), message: `Global mode set to ${mode}` });
});

// ---------------------------------------------------------------------------
// GET /overrides/policy/:checkpointId
// ---------------------------------------------------------------------------

router.get("/overrides/policy/:checkpointId", (req, res): void => {
  const id = req.params["checkpointId"] as CheckpointId;
  if (!VALID_CHECKPOINTS.has(id)) {
    res.status(400).json({ error: `Unknown checkpoint. Valid: ${[...VALID_CHECKPOINTS].join(", ")}` });
    return;
  }
  const policy = getPolicy(id);
  if (!policy) { res.status(404).json({ error: "Policy not found" }); return; }
  res.json(policy);
});

// ---------------------------------------------------------------------------
// PUT /overrides/policy/:checkpointId — update
// ---------------------------------------------------------------------------

router.put("/overrides/policy/:checkpointId", (req, res): void => {
  const id = req.params["checkpointId"] as CheckpointId;
  if (!VALID_CHECKPOINTS.has(id)) {
    res.status(400).json({ error: `Unknown checkpoint. Valid: ${[...VALID_CHECKPOINTS].join(", ")}` });
    return;
  }

  const { mode, ttlSeconds, notifyOnAuto } = (req.body ?? {}) as {
    mode?:         string;
    ttlSeconds?:   number;
    notifyOnAuto?: boolean;
  };

  if (mode && !VALID_MODES.has(mode as OverrideMode)) {
    res.status(400).json({ error: `mode must be one of: ${[...VALID_MODES].join(", ")}` });
    return;
  }

  try {
    const updated = updatePolicy(id, {
      ...(mode         ? { mode: mode as OverrideMode } : {}),
      ...(ttlSeconds   ? { ttlSeconds }                 : {}),
      ...(notifyOnAuto !== undefined ? { notifyOnAuto } : {}),
    });
    void persistPolicy().catch(() => {});
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /overrides/policy/:checkpointId/reset
// ---------------------------------------------------------------------------

router.post("/overrides/policy/:checkpointId/reset", (req, res): void => {
  const id = req.params["checkpointId"] as CheckpointId;
  if (!VALID_CHECKPOINTS.has(id)) {
    res.status(400).json({ error: "Unknown checkpoint" });
    return;
  }
  const reset = resetPolicy(id);
  res.json({ message: `Policy for '${id}' reset to default`, policy: reset });
});

// ---------------------------------------------------------------------------
// POST /overrides/request — create approval request (non-blocking)
// ---------------------------------------------------------------------------

router.post("/overrides/request", (req, res): void => {
  const { checkpointId, pipelineJobId, context } = (req.body ?? {}) as {
    checkpointId?:  string;
    pipelineJobId?: string | null;
    context?:       Record<string, unknown>;
  };

  if (!checkpointId || !VALID_CHECKPOINTS.has(checkpointId as CheckpointId)) {
    res.status(400).json({ error: `checkpointId must be one of: ${[...VALID_CHECKPOINTS].join(", ")}` });
    return;
  }

  try {
    const request = createApprovalRequest({
      checkpointId:  checkpointId as CheckpointId,
      pipelineJobId: pipelineJobId ?? null,
      context:       context ?? {},
    });
    res.status(202).json({
      request,
      approveUrl: `/api/overrides/requests/${request.id}/approve`,
      rejectUrl:  `/api/overrides/requests/${request.id}/reject`,
      pollUrl:    `/api/overrides/requests/${request.id}`,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /overrides/requests — list all
// ---------------------------------------------------------------------------

router.get("/overrides/requests", (req, res): void => {
  const { checkpointId, status } = req.query as { checkpointId?: string; status?: string };
  expireStaleRequests();
  const list = listApprovalRequests({
    checkpointId: VALID_CHECKPOINTS.has(checkpointId as CheckpointId) ? checkpointId as CheckpointId : undefined,
    status:       status as any,
  });
  res.json({
    total:   list.length,
    requests: list,
  });
});

// ---------------------------------------------------------------------------
// GET /overrides/requests/pending — shortcut for pending requests
// ---------------------------------------------------------------------------

router.get("/overrides/requests/pending", (_req, res): void => {
  expireStaleRequests();
  const list = listApprovalRequests({ status: "pending" });
  res.json({
    total:    list.length,
    requests: list,
    message:  list.length === 0 ? "No pending approval requests" : `${list.length} requests awaiting approval`,
  });
});

// ---------------------------------------------------------------------------
// GET /overrides/requests/:id
// ---------------------------------------------------------------------------

router.get("/overrides/requests/:id", (req, res): void => {
  const req_ = getApprovalRequest(req.params["id"] ?? "");
  if (!req_) { res.status(404).json({ error: "Approval request not found" }); return; }
  res.json(req_);
});

// ---------------------------------------------------------------------------
// POST /overrides/requests/:id/approve
// ---------------------------------------------------------------------------

router.post("/overrides/requests/:id/approve", (req, res): void => {
  const { approvedBy, note } = (req.body ?? {}) as { approvedBy?: string; note?: string };
  try {
    const result = approve(req.params["id"] ?? "", { approvedBy, note });
    req.log.info({ requestId: req.params["id"], approvedBy }, "OVERRIDE: approved");
    res.json({ message: "Request approved", request: result });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /overrides/requests/:id/reject
// ---------------------------------------------------------------------------

router.post("/overrides/requests/:id/reject", (req, res): void => {
  const { rejectedBy, reason } = (req.body ?? {}) as { rejectedBy?: string; reason?: string };
  try {
    const result = reject(req.params["id"] ?? "", { rejectedBy, reason });
    req.log.info({ requestId: req.params["id"], rejectedBy, reason }, "OVERRIDE: rejected");
    res.json({ message: "Request rejected", request: result });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /overrides/expire — housekeeping
// ---------------------------------------------------------------------------

router.post("/overrides/expire", (_req, res): void => {
  const count = expireStaleRequests();
  res.json({ expired: count, message: `${count} stale requests expired` });
});

export default router;
