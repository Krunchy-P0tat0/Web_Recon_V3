/**
 * human-review-gate-engine.ts — PS-2: Human Review Gate
 *
 * Introduces mandatory approval checkpoints into the autonomous VR-8
 * reconstruction loop so that uncontrolled iterations cannot run indefinitely
 * without a human decision.
 *
 * Gate lifecycle per iteration:
 *   pipeline run completes → gate OPENS (status: PENDING)
 *   human acts             → gate CLOSES (status: APPROVED | REJECTED | SKIPPED)
 *     APPROVED  → pipeline continues with current RuleAdjustment[]
 *     REJECTED  → pipeline halts; no further iterations for this job
 *     EDITED    → human edits RuleAdjustment[] before approving; edited list used
 *     SKIPPED   → this iteration is skipped; pipeline moves to next without applying
 *
 * Decision log is append-only and persists the full audit trail.
 */

import { logger } from "./logger.js";
import type { CanonicalRuleAdjustment } from "./rule-adjustment-contract.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GateStatus = "PENDING" | "APPROVED" | "REJECTED" | "EDITED" | "SKIPPED" | "EXPIRED";
export type GateAction = "approve" | "reject" | "edit" | "skip";

export interface IterationContext {
  iterationNumber:   number;
  fidelityBefore:    number;
  fidelityAfter:     number | null;
  fidelityDelta:     number | null;
  adjustmentsProposed: CanonicalRuleAdjustment[];
  pipelineStage:     string;
  durationMs:        number;
}

export interface ReviewGate {
  gateId:          string;
  jobId:           string;
  sourceJobId:     string;
  generatedJobId:  string;
  openedAt:        string;
  closedAt:        string | null;
  expiresAt:       string;            // auto-reject after TTL
  status:          GateStatus;
  iteration:       IterationContext;
  decision: {
    action:            GateAction | null;
    actedBy:           string | null;   // "system" | human actor id
    actedAt:           string | null;
    editedAdjustments: CanonicalRuleAdjustment[] | null;
    reason:            string | null;
  };
}

export interface IterationDecision {
  decisionId:      string;
  gateId:          string;
  jobId:           string;
  iterationNumber: number;
  action:          GateAction;
  actedBy:         string;
  actedAt:         string;
  fidelityBefore:  number;
  fidelityAfter:   number | null;
  adjustmentsIn:   number;
  adjustmentsOut:  number;          // after edit (same as in for approve/reject/skip)
  reason:          string;
  outcome:         "continued" | "halted" | "skipped" | "adjusted";
}

// ---------------------------------------------------------------------------
// In-process state
// ---------------------------------------------------------------------------

const _gates    = new Map<string, ReviewGate>();          // gateId → gate
const _byJobId  = new Map<string, ReviewGate[]>();        // jobId  → gates (newest first)
const _log:     IterationDecision[] = [];                 // append-only decision log

const GATE_TTL_MS = 30 * 60 * 1_000;  // 30 min auto-expire

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function pushGate(gate: ReviewGate): void {
  _gates.set(gate.gateId, gate);
  if (!_byJobId.has(gate.jobId)) _byJobId.set(gate.jobId, []);
  _byJobId.get(gate.jobId)!.unshift(gate);
}

function pushDecision(d: IterationDecision): void {
  _log.unshift(d);
  if (_log.length > 1_000) _log.length = 1_000;
}

function expireStaleGates(): void {
  const now = new Date().toISOString();
  for (const gate of _gates.values()) {
    if (gate.status === "PENDING" && gate.expiresAt < now) {
      gate.status   = "EXPIRED";
      gate.closedAt = now;
      gate.decision.action  = "reject";
      gate.decision.actedBy = "system-ttl";
      gate.decision.actedAt = now;
      gate.decision.reason  = "Gate expired (TTL exceeded) — iteration auto-rejected";
      pushDecision({
        decisionId:      uid(),
        gateId:          gate.gateId,
        jobId:           gate.jobId,
        iterationNumber: gate.iteration.iterationNumber,
        action:          "reject",
        actedBy:         "system-ttl",
        actedAt:         now,
        fidelityBefore:  gate.iteration.fidelityBefore,
        fidelityAfter:   null,
        adjustmentsIn:   gate.iteration.adjustmentsProposed.length,
        adjustmentsOut:  0,
        reason:          "Auto-rejected: gate TTL exceeded",
        outcome:         "halted",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Public API — open a gate
// ---------------------------------------------------------------------------

export function openGate(
  jobId:           string,
  sourceJobId:     string,
  generatedJobId:  string,
  iteration:       IterationContext,
): ReviewGate {
  expireStaleGates();

  const gateId    = `gate-${jobId.slice(0, 10)}-i${iteration.iterationNumber}-${uid()}`;
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + GATE_TTL_MS).toISOString();

  const gate: ReviewGate = {
    gateId,
    jobId,
    sourceJobId,
    generatedJobId,
    openedAt:  now.toISOString(),
    closedAt:  null,
    expiresAt,
    status:    "PENDING",
    iteration,
    decision: {
      action:            null,
      actedBy:           null,
      actedAt:           null,
      editedAdjustments: null,
      reason:            null,
    },
  };

  pushGate(gate);
  logger.info({ gateId, jobId, iteration: iteration.iterationNumber }, "PS-2: review gate opened");
  return gate;
}

// ---------------------------------------------------------------------------
// Public API — act on a gate
// ---------------------------------------------------------------------------

function closeGate(
  gateId:   string,
  action:   GateAction,
  actedBy:  string,
  reason:   string,
  edits:    CanonicalRuleAdjustment[] | null,
): ReviewGate {
  expireStaleGates();

  const gate = _gates.get(gateId);
  if (!gate) throw new Error(`Gate "${gateId}" not found`);
  if (gate.status !== "PENDING") throw new Error(`Gate "${gateId}" is already ${gate.status}`);

  const now     = new Date().toISOString();
  const outcome: IterationDecision["outcome"] =
    action === "approve" ? "continued"
    : action === "reject"  ? "halted"
    : action === "skip"    ? "skipped"
    :                        "adjusted";

  gate.status   = action === "edit" ? "EDITED" : action === "skip" ? "SKIPPED"
                : action === "reject" ? "REJECTED" : "APPROVED";
  gate.closedAt = now;
  gate.decision = {
    action,
    actedBy,
    actedAt: now,
    editedAdjustments: edits,
    reason,
  };

  const d: IterationDecision = {
    decisionId:      uid(),
    gateId,
    jobId:           gate.jobId,
    iterationNumber: gate.iteration.iterationNumber,
    action,
    actedBy,
    actedAt:         now,
    fidelityBefore:  gate.iteration.fidelityBefore,
    fidelityAfter:   gate.iteration.fidelityAfter,
    adjustmentsIn:   gate.iteration.adjustmentsProposed.length,
    adjustmentsOut:  edits ? edits.length : (action === "reject" || action === "skip" ? 0 : gate.iteration.adjustmentsProposed.length),
    reason,
    outcome,
  };

  pushDecision(d);
  logger.info({ gateId, action, actedBy, outcome }, "PS-2: review gate closed");
  return gate;
}

export function approveGate(gateId: string, actedBy = "human", reason = ""): ReviewGate {
  return closeGate(gateId, "approve", actedBy, reason || "Approved — continue with proposed adjustments", null);
}

export function rejectGate(gateId: string, actedBy = "human", reason = ""): ReviewGate {
  return closeGate(gateId, "reject", actedBy, reason || "Rejected — halt reconstruction loop", null);
}

export function editAndApproveGate(
  gateId:   string,
  edits:    CanonicalRuleAdjustment[],
  actedBy = "human",
  reason  = "",
): ReviewGate {
  return closeGate(gateId, "edit", actedBy, reason || "Approved with edited adjustments", edits);
}

export function skipGate(gateId: string, actedBy = "human", reason = ""): ReviewGate {
  return closeGate(gateId, "skip", actedBy, reason || "Iteration skipped — no adjustments applied", null);
}

// ---------------------------------------------------------------------------
// Public API — reads
// ---------------------------------------------------------------------------

export function getGate(gateId: string): ReviewGate | undefined {
  expireStaleGates();
  return _gates.get(gateId);
}

export function getPendingGates(jobId?: string): ReviewGate[] {
  expireStaleGates();
  const all = [..._gates.values()].filter(g => g.status === "PENDING");
  return jobId ? all.filter(g => g.jobId === jobId) : all;
}

export function getGatesForJob(jobId: string): ReviewGate[] {
  expireStaleGates();
  return _byJobId.get(jobId) ?? [];
}

export function listAllGates(): ReviewGate[] {
  expireStaleGates();
  return [..._gates.values()].sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}

export function getDecisionLog(jobId?: string): IterationDecision[] {
  return jobId ? _log.filter(d => d.jobId === jobId) : _log.slice(0, 500);
}

// ---------------------------------------------------------------------------
// Approval report — aggregate stats
// ---------------------------------------------------------------------------

export interface ApprovalReport {
  version:           "PS-2";
  generatedAt:       string;
  totalGates:        number;
  pendingGates:      number;
  approvedGates:     number;
  rejectedGates:     number;
  editedGates:       number;
  skippedGates:      number;
  expiredGates:      number;
  approvalRate:      number;   // approved / closed * 100
  avgDecisionMs:     number;   // avg time to close a gate
  pendingList:       ReviewGate[];
  recentDecisions:   IterationDecision[];
  jobSummaries: {
    jobId:        string;
    gateCount:    number;
    pendingCount: number;
    approvedCount:number;
    rejectedCount:number;
    editedCount:  number;
    skippedCount: number;
  }[];
}

export function getApprovalReport(): ApprovalReport {
  expireStaleGates();
  const allGates = [..._gates.values()];
  const closed   = allGates.filter(g => g.closedAt !== null);

  const count = (s: GateStatus) => allGates.filter(g => g.status === s).length;

  const approvedCount  = count("APPROVED") + count("EDITED");
  const closedCount    = closed.length;
  const approvalRate   = closedCount > 0 ? parseFloat(((approvedCount / closedCount) * 100).toFixed(1)) : 100;

  const totalDecisionMs = closed.reduce((sum, g) => {
    if (!g.closedAt) return sum;
    return sum + (new Date(g.closedAt).getTime() - new Date(g.openedAt).getTime());
  }, 0);
  const avgDecisionMs = closed.length > 0 ? Math.round(totalDecisionMs / closed.length) : 0;

  const jobSummaries = [..._byJobId.entries()].map(([jobId, gates]) => ({
    jobId,
    gateCount:     gates.length,
    pendingCount:  gates.filter(g => g.status === "PENDING").length,
    approvedCount: gates.filter(g => g.status === "APPROVED").length,
    rejectedCount: gates.filter(g => g.status === "REJECTED").length,
    editedCount:   gates.filter(g => g.status === "EDITED").length,
    skippedCount:  gates.filter(g => g.status === "SKIPPED").length,
  }));

  return {
    version:       "PS-2",
    generatedAt:   new Date().toISOString(),
    totalGates:    allGates.length,
    pendingGates:  count("PENDING"),
    approvedGates: count("APPROVED"),
    rejectedGates: count("REJECTED"),
    editedGates:   count("EDITED"),
    skippedGates:  count("SKIPPED"),
    expiredGates:  count("EXPIRED"),
    approvalRate,
    avgDecisionMs,
    pendingList:   getPendingGates(),
    recentDecisions: _log.slice(0, 20),
    jobSummaries,
  };
}
