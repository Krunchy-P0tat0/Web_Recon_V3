/**
 * human-review-gate.ts — PS-2: Human Review Gate Routes
 *
 *   POST /api/review-gate/open                        — open a new review gate
 *   GET  /api/review-gate/pending                     — all pending gates
 *   GET  /api/review-gate/report                      — approval report
 *   GET  /api/review-gate/log                         — full decision log
 *   GET  /api/review-gate/:gateId                     — get a specific gate
 *   POST /api/review-gate/:gateId/approve             — approve iteration
 *   POST /api/review-gate/:gateId/reject              — reject iteration
 *   POST /api/review-gate/:gateId/edit                — edit adjustments + approve
 *   POST /api/review-gate/:gateId/skip                — skip iteration
 *   GET  /api/review-gate/job/:jobId                  — all gates for a job
 *   GET  /api/review-gate/job/:jobId/log              — decision log for a job
 */

import { Router, type IRouter } from "express";
import {
  openGate,
  approveGate,
  rejectGate,
  editAndApproveGate,
  skipGate,
  getGate,
  getPendingGates,
  getGatesForJob,
  listAllGates,
  getDecisionLog,
  getApprovalReport,
  type IterationContext,
} from "../lib/human-review-gate-engine.js";
import type { CanonicalRuleAdjustment } from "../lib/rule-adjustment-contract.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Global views
// ---------------------------------------------------------------------------

// GET /review-gate/pending
router.get("/review-gate/pending", (_req, res): void => {
  const pending = getPendingGates();
  res.json({ pendingCount: pending.length, gates: pending });
});

// GET /review-gate/report
router.get("/review-gate/report", (_req, res): void => {
  res.json(getApprovalReport());
});

// GET /review-gate/log
router.get("/review-gate/log", (_req, res): void => {
  const log = getDecisionLog();
  res.json({ totalDecisions: log.length, log });
});

// GET /review-gate/all
router.get("/review-gate/all", (_req, res): void => {
  const all = listAllGates();
  res.json({ totalGates: all.length, gates: all });
});

// ---------------------------------------------------------------------------
// Open a gate
// ---------------------------------------------------------------------------

// POST /review-gate/open
router.post("/review-gate/open", (req, res): void => {
  const {
    jobId, sourceJobId, generatedJobId, iteration,
  } = req.body ?? {};

  if (!jobId || !sourceJobId || !generatedJobId || !iteration) {
    res.status(400).json({
      error: "Body must include: jobId, sourceJobId, generatedJobId, iteration",
    });
    return;
  }

  try {
    const gate = openGate(jobId, sourceJobId, generatedJobId, iteration as IterationContext);
    res.status(201).json(gate);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// Gate actions
// ---------------------------------------------------------------------------

// GET /review-gate/:gateId
router.get("/review-gate/:gateId", (req, res): void => {
  const { gateId } = req.params as { gateId: string };
  const gate = getGate(gateId);
  if (!gate) {
    res.status(404).json({ error: `Gate "${gateId}" not found.` });
    return;
  }
  res.json(gate);
});

// POST /review-gate/:gateId/approve  { actedBy?, reason? }
router.post("/review-gate/:gateId/approve", (req, res): void => {
  const { gateId } = req.params as { gateId: string };
  const { actedBy = "human", reason = "" } = req.body ?? {};
  try {
    const gate = approveGate(gateId, actedBy, reason);
    res.json(gate);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(msg.includes("not found") ? 404 : 409).json({ error: msg });
  }
});

// POST /review-gate/:gateId/reject  { actedBy?, reason? }
router.post("/review-gate/:gateId/reject", (req, res): void => {
  const { gateId } = req.params as { gateId: string };
  const { actedBy = "human", reason = "" } = req.body ?? {};
  try {
    const gate = rejectGate(gateId, actedBy, reason);
    res.json(gate);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(msg.includes("not found") ? 404 : 409).json({ error: msg });
  }
});

// POST /review-gate/:gateId/edit  { adjustments: CanonicalRuleAdjustment[], actedBy?, reason? }
router.post("/review-gate/:gateId/edit", (req, res): void => {
  const { gateId } = req.params as { gateId: string };
  const { adjustments, actedBy = "human", reason = "" } = req.body ?? {};

  if (!Array.isArray(adjustments)) {
    res.status(400).json({ error: "Body must include adjustments: CanonicalRuleAdjustment[]" });
    return;
  }

  try {
    const gate = editAndApproveGate(gateId, adjustments as CanonicalRuleAdjustment[], actedBy, reason);
    res.json(gate);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(msg.includes("not found") ? 404 : 409).json({ error: msg });
  }
});

// POST /review-gate/:gateId/skip  { actedBy?, reason? }
router.post("/review-gate/:gateId/skip", (req, res): void => {
  const { gateId } = req.params as { gateId: string };
  const { actedBy = "human", reason = "" } = req.body ?? {};
  try {
    const gate = skipGate(gateId, actedBy, reason);
    res.json(gate);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(msg.includes("not found") ? 404 : 409).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// Per-job views
// ---------------------------------------------------------------------------

// GET /review-gate/job/:jobId
router.get("/review-gate/job/:jobId", (req, res): void => {
  const { jobId } = req.params as { jobId: string };
  const gates = getGatesForJob(jobId);
  res.json({ jobId, totalGates: gates.length, gates });
});

// GET /review-gate/job/:jobId/log
router.get("/review-gate/job/:jobId/log", (req, res): void => {
  const { jobId } = req.params as { jobId: string };
  const log = getDecisionLog(jobId);
  res.json({ jobId, totalDecisions: log.length, log });
});

export default router;
