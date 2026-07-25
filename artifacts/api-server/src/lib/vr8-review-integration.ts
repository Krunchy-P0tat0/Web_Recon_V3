/**
 * vr8-review-integration.ts — PH-1: VR-8 ↔ PS-2 Human Review Gate Integration
 *
 * Inserts the PS-2 Human Review Gate between VR-8 RuleAdjustment[] generation
 * and Website Prime regeneration so every autonomous iteration requires a
 * human decision before the generator is called.
 *
 * Integrated pipeline per iteration:
 *   1. Call generationEndpoint → generatedJobId
 *   2. Run VR-7 fidelity scoring
 *   3. Derive RuleAdjustment[] via VR-8 adjustment engine
 *   4. Open PS-2 gate (status: PENDING) — loop PAUSES here
 *   5. Poll gate until human acts (or TTL expires → auto-REJECTED)
 *   6. APPROVED  → continue with proposed adjustments
 *      EDITED    → use human-edited adjustments
 *      REJECTED  → terminate loop for this job
 *      SKIPPED   → continue next iteration with no adjustments
 *   7. Log decision, update history
 *   8. Repeat from step 1 unless stopping condition met
 *
 * Duplicate-approval guard: if a PENDING gate already exists for a job+iteration,
 * openGateForIteration returns it rather than creating a second one.
 */

import { logger }           from "./logger.js";
import {
  openGate,
  getGate,
  getGatesForJob,
  getDecisionLog,
  getApprovalReport,
  type ReviewGate,
  type IterationContext,
  type GateStatus,
}                           from "./human-review-gate-engine.js";
import {
  translateLegacyAdjustments,
  type CanonicalRuleAdjustment,
}                           from "./rule-adjustment-contract.js";
import {
  startReconstructionLoop,
  getLoopState,
  requestStop,
  deriveAdjustments,
  type LoopState,
  type RuleAdjustment,
  type LoopStatus,
  type StoppingCondition,
}                           from "./reconstruction-loop-engine-vr8.js";
import {
  runFidelityScoringVR7,
  getCachedFidelityReport,
}                           from "./visual-fidelity-scoring-engine-vr7.js";
import { writeFile, mkdir } from "fs/promises";
import { join }             from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IntegratedStatus =
  | "idle"
  | "running"           // iteration executing
  | "awaiting_review"   // gate PENDING — waiting for human
  | "stopping"
  | "completed"
  | "failed";

export interface GateDecisionRecord {
  iterationNumber: number;
  gateId:          string;
  action:          string;
  actedBy:         string;
  actedAt:         string;
  adjustmentsIn:   number;
  adjustmentsOut:  number;
  outcome:         string;
  reason:          string;
}

export interface IntegratedIterationRecord {
  iterationNumber:     number;
  generatedJobId:      string;
  scoreBefore:         number;
  scoreAfter:          number;
  delta:               number;
  adjustmentsProposed: number;
  adjustmentsApplied:  number;
  gateId:              string;
  gateAction:          string;
  gateActedBy:         string;
  durationMs:          number;
  timestamp:           string;
}

export interface IntegratedLoopState {
  sourceJobId:         string;
  status:              IntegratedStatus;
  currentIteration:    number;
  maxIterations:       number;
  targetScore:         number;
  currentScore:        number;
  bestScore:           number;
  bestIteration:       number;
  stoppingCondition:   StoppingCondition | "human_rejected" | "gate_expired" | null;
  startedAt:           string;
  completedAt:         string | null;
  currentGateId:       string | null;
  generationEndpoint:  string;
  iterations:          IntegratedIterationRecord[];
  gateDecisions:       GateDecisionRecord[];
  lastError:           string | null;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const _integratedLoops = new Map<string, IntegratedLoopState>();
const _stopFlags       = new Set<string>();

export function getIntegratedLoopState(sourceJobId: string): IntegratedLoopState | undefined {
  return _integratedLoops.get(sourceJobId);
}

export function listIntegratedLoops(): IntegratedLoopState[] {
  return [..._integratedLoops.values()].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt)
  );
}

export function requestIntegratedStop(sourceJobId: string): void {
  _stopFlags.add(sourceJobId);
  const state = _integratedLoops.get(sourceJobId);
  if (state && (state.status === "running" || state.status === "awaiting_review")) {
    state.status = "stopping";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callGenerationEndpoint(
  endpoint: string,
  payload: Record<string, unknown>,
): Promise<{ generatedJobId: string }> {
  const { default: http }  = await import("http");
  const { default: https } = await import("https");

  return new Promise((resolve, reject) => {
    let url: URL;
    try { url = new URL(endpoint); } catch {
      reject(new Error(`Invalid generation endpoint: ${endpoint}`));
      return;
    }

    const body    = JSON.stringify(payload);
    const options = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === "https:" ? 443 : 80),
      path:     url.pathname + url.search,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout:  120_000,
    };

    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Generation endpoint returned ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(data) as { generatedJobId: string };
          if (!parsed.generatedJobId) {
            reject(new Error(`Response missing generatedJobId: ${data.slice(0, 200)}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Response not valid JSON: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on("timeout", () => { req.destroy(); reject(new Error("Generation endpoint timed out")); });
    req.on("error",   (err: Error) => reject(err));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Duplicate-approval guard
// ---------------------------------------------------------------------------

function findExistingPendingGate(jobId: string, iterationNumber: number): ReviewGate | null {
  const gates = getGatesForJob(jobId);
  return gates.find(
    g => g.iteration.iterationNumber === iterationNumber && g.status === "PENDING"
  ) ?? null;
}

// ---------------------------------------------------------------------------
// Open gate for a VR-8 iteration (with duplicate guard)
// ---------------------------------------------------------------------------

function openGateForIteration(
  state: IntegratedLoopState,
  generatedJobId: string,
  scoreBefore: number,
  scoreAfter: number,
  rawAdjustments: RuleAdjustment[],
  durationMs: number,
): ReviewGate {
  // Duplicate-approval guard
  const existing = findExistingPendingGate(state.sourceJobId, state.currentIteration);
  if (existing) {
    logger.info(
      { gateId: existing.gateId, iterationNumber: state.currentIteration },
      "PH-1: reusing existing PENDING gate (duplicate-approval guard)"
    );
    return existing;
  }

  const canonicalAdjustments = translateLegacyAdjustments(rawAdjustments, "VR-8");

  const iterCtx: IterationContext = {
    iterationNumber:     state.currentIteration,
    fidelityBefore:      scoreBefore,
    fidelityAfter:       scoreAfter,
    fidelityDelta:       parseFloat((scoreAfter - scoreBefore).toFixed(2)),
    adjustmentsProposed: canonicalAdjustments,
    pipelineStage:       "VR-8 → Website Prime Generator",
    durationMs,
  };

  return openGate(state.sourceJobId, state.sourceJobId, generatedJobId, iterCtx);
}

// ---------------------------------------------------------------------------
// Poll gate until closed (or TTL)
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 1_000;
const MAX_POLL_MS      = 31 * 60 * 1_000;   // 31 min (1 min past gate TTL)

async function pollGateUntilClosed(
  gateId: string,
  state: IntegratedLoopState,
): Promise<ReviewGate> {
  const deadline = Date.now() + MAX_POLL_MS;

  while (Date.now() < deadline) {
    // Respect external stop signal
    if (_stopFlags.has(state.sourceJobId)) {
      const gate = getGate(gateId);
      if (gate) return gate;
    }

    const gate = getGate(gateId);
    if (!gate) throw new Error(`Gate "${gateId}" disappeared from store`);

    const closed: GateStatus[] = ["APPROVED", "REJECTED", "EDITED", "SKIPPED", "EXPIRED"];
    if (closed.includes(gate.status)) return gate;

    await sleep(POLL_INTERVAL_MS);
  }

  // Should not reach here — gate TTL will have expired it
  const gate = getGate(gateId);
  if (!gate) throw new Error(`Gate "${gateId}" missing after poll timeout`);
  return gate;
}

// ---------------------------------------------------------------------------
// Record decision from a closed gate
// ---------------------------------------------------------------------------

function recordDecision(
  state: IntegratedLoopState,
  gate: ReviewGate,
  adjustmentsOut: number,
): void {
  const record: GateDecisionRecord = {
    iterationNumber: gate.iteration.iterationNumber,
    gateId:          gate.gateId,
    action:          gate.decision.action ?? "unknown",
    actedBy:         gate.decision.actedBy ?? "unknown",
    actedAt:         gate.decision.actedAt ?? new Date().toISOString(),
    adjustmentsIn:   gate.iteration.adjustmentsProposed.length,
    adjustmentsOut,
    outcome:
      gate.status === "APPROVED" ? "continued"
      : gate.status === "EDITED"   ? "adjusted"
      : gate.status === "REJECTED" ? "halted"
      : gate.status === "SKIPPED"  ? "skipped"
      :                              "halted",
    reason: gate.decision.reason ?? "",
  };

  state.gateDecisions.unshift(record);
  if (state.gateDecisions.length > 500) state.gateDecisions.length = 500;
}

// ---------------------------------------------------------------------------
// Persist state to disk (/tmp/vr8-integrated/<sourceJobId>/)
// ---------------------------------------------------------------------------

async function persistIntegratedState(state: IntegratedLoopState): Promise<void> {
  try {
    const dir = join("/tmp/vr8-integrated", state.sourceJobId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "pipeline-review-state.json"), JSON.stringify(state, null, 2));
    await writeFile(
      join(dir, "vr8-review-audit.json"),
      JSON.stringify(
        {
          schemaVersion:   "PH-1",
          sourceJobId:     state.sourceJobId,
          generatedAt:     new Date().toISOString(),
          status:          state.status,
          gateDecisions:   state.gateDecisions,
          approvalReport:  getApprovalReport(),
          decisionLog:     getDecisionLog(state.sourceJobId).slice(0, 100),
        },
        null, 2
      )
    );
  } catch (err) {
    logger.warn({ err }, "PH-1: failed to persist integrated state");
  }
}

// ---------------------------------------------------------------------------
// Core integrated loop
// ---------------------------------------------------------------------------

async function runIntegratedLoop(state: IntegratedLoopState): Promise<void> {
  const loopStart = Date.now();

  for (let i = 1; i <= state.maxIterations; i++) {
    if (_stopFlags.has(state.sourceJobId)) {
      state.status           = "completed";
      state.stoppingCondition = "manual_stop";
      break;
    }

    state.currentIteration = i;
    state.status           = "running";

    logger.info(
      { sourceJobId: state.sourceJobId, iteration: i, score: state.currentScore },
      "PH-1: starting integrated iteration"
    );

    const iterStart = Date.now();

    // ── Step 1: Call generation endpoint ─────────────────────────────────────
    let generatedJobId: string;
    try {
      const resp = await callGenerationEndpoint(state.generationEndpoint, {
        sourceJobId:    state.sourceJobId,
        iterationNumber: i,
        ruleAdjustments: [],   // carried from previous iteration (starts empty on i=1)
      });
      generatedJobId = resp.generatedJobId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ sourceJobId: state.sourceJobId, iteration: i, err: msg }, "PH-1: generation call failed");
      state.status           = "failed";
      state.stoppingCondition = "generation_error";
      state.lastError        = msg;
      state.completedAt      = new Date().toISOString();
      break;
    }

    // ── Step 2: VR-7 fidelity scoring ─────────────────────────────────────────
    const scoreBefore = state.currentScore;
    let scoreAfter    = scoreBefore;
    let rawAdjustments: RuleAdjustment[] = [];

    try {
      const fidelityReport = await runFidelityScoringVR7({
        sourceJobId:    state.sourceJobId,
        generatedJobId,
        force:          true,
      });
      scoreAfter      = (fidelityReport.global as unknown as { overallScore: number }).overallScore;
      rawAdjustments  = deriveAdjustments(fidelityReport, i);

      logger.info(
        { sourceJobId: state.sourceJobId, iteration: i, scoreBefore, scoreAfter, adjustments: rawAdjustments.length },
        "PH-1: VR-7 scoring complete"
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg, iteration: i }, "PH-1: VR-7 scoring failed — using prior score");
      rawAdjustments = [];
    }

    const durationMs = Date.now() - iterStart;

    // ── Step 3: Open PS-2 gate (PAUSE) ────────────────────────────────────────
    state.status = "awaiting_review";

    const gate = openGateForIteration(
      state,
      generatedJobId,
      scoreBefore,
      scoreAfter,
      rawAdjustments,
      durationMs,
    );
    state.currentGateId = gate.gateId;

    logger.info(
      { gateId: gate.gateId, iteration: i, adjustments: rawAdjustments.length },
      "PH-1: loop paused — awaiting human review"
    );

    await persistIntegratedState(state);

    // ── Step 4: Wait for gate decision ────────────────────────────────────────
    const closedGate = await pollGateUntilClosed(gate.gateId, state);
    state.currentGateId = null;

    // ── Step 5: Apply decision ────────────────────────────────────────────────
    let adjustmentsForNextIter: CanonicalRuleAdjustment[] = [];
    let shouldHalt = false;

    switch (closedGate.status) {
      case "APPROVED":
        adjustmentsForNextIter = closedGate.iteration.adjustmentsProposed;
        logger.info({ gateId: gate.gateId, iteration: i }, "PH-1: APPROVED — continue with proposed adjustments");
        break;

      case "EDITED":
        adjustmentsForNextIter = closedGate.decision.editedAdjustments ?? closedGate.iteration.adjustmentsProposed;
        logger.info(
          { gateId: gate.gateId, iteration: i, editedCount: adjustmentsForNextIter.length },
          "PH-1: EDITED — using human-edited adjustments"
        );
        break;

      case "REJECTED":
        logger.info({ gateId: gate.gateId, iteration: i }, "PH-1: REJECTED — terminating loop");
        shouldHalt = true;
        break;

      case "SKIPPED":
        adjustmentsForNextIter = [];
        logger.info({ gateId: gate.gateId, iteration: i }, "PH-1: SKIPPED — continuing without adjustments");
        break;

      case "EXPIRED":
        logger.warn({ gateId: gate.gateId, iteration: i }, "PH-1: gate EXPIRED (TTL) — treating as REJECTED");
        shouldHalt = true;
        break;

      default:
        logger.warn({ gateId: gate.gateId, status: closedGate.status }, "PH-1: unexpected gate status — halting");
        shouldHalt = true;
    }

    // ── Step 6: Record iteration ──────────────────────────────────────────────
    const iterRecord: IntegratedIterationRecord = {
      iterationNumber:     i,
      generatedJobId,
      scoreBefore,
      scoreAfter,
      delta:               parseFloat((scoreAfter - scoreBefore).toFixed(2)),
      adjustmentsProposed: rawAdjustments.length,
      adjustmentsApplied:  shouldHalt ? 0 : adjustmentsForNextIter.length,
      gateId:              gate.gateId,
      gateAction:          closedGate.decision.action ?? closedGate.status.toLowerCase(),
      gateActedBy:         closedGate.decision.actedBy ?? "system",
      durationMs:          Date.now() - iterStart,
      timestamp:           new Date().toISOString(),
    };
    state.iterations.push(iterRecord);

    recordDecision(state, closedGate, iterRecord.adjustmentsApplied);

    // Update scores
    state.currentScore = scoreAfter;
    if (scoreAfter > state.bestScore) {
      state.bestScore     = scoreAfter;
      state.bestIteration = i;
    }

    await persistIntegratedState(state);

    // ── Step 7: Check halt / stopping conditions ───────────────────────────────
    if (shouldHalt) {
      state.status = "completed";
      state.stoppingCondition =
        closedGate.status === "EXPIRED" ? "gate_expired" : "human_rejected";
      break;
    }

    if (_stopFlags.has(state.sourceJobId)) {
      state.status           = "completed";
      state.stoppingCondition = "manual_stop";
      break;
    }

    if (state.currentScore >= state.targetScore) {
      state.status           = "completed";
      state.stoppingCondition = "target_reached";
      break;
    }
  }

  // ── Finalize ─────────────────────────────────────────────────────────────────
  if (state.status === "running" || state.status === "awaiting_review") {
    state.status           = "completed";
    state.stoppingCondition = "max_iterations";
  }

  state.completedAt = new Date().toISOString();
  _stopFlags.delete(state.sourceJobId);

  logger.info(
    {
      sourceJobId:       state.sourceJobId,
      status:            state.status,
      stoppingCondition: state.stoppingCondition,
      iterations:        state.iterations.length,
      finalScore:        state.currentScore,
      bestScore:         state.bestScore,
      durationMs:        Date.now() - loopStart,
    },
    "PH-1: integrated loop completed"
  );

  await persistIntegratedState(state);
}

// ---------------------------------------------------------------------------
// Public API — start integrated loop
// ---------------------------------------------------------------------------

export interface StartIntegratedLoopInput {
  sourceJobId:        string;
  generationEndpoint: string;
  targetScore?:       number;
  maxIterations?:     number;
  initialScore?:      number;
}

export function startIntegratedLoop(input: StartIntegratedLoopInput): IntegratedLoopState {
  const {
    sourceJobId,
    generationEndpoint,
    targetScore    = 75,
    maxIterations  = 5,
    initialScore   = 0,
  } = input;

  const existing = _integratedLoops.get(sourceJobId);
  if (existing?.status === "running" || existing?.status === "awaiting_review") {
    throw new Error(`An integrated loop is already active for "${sourceJobId}" (status: ${existing.status})`);
  }

  _stopFlags.delete(sourceJobId);

  const state: IntegratedLoopState = {
    sourceJobId,
    status:              "running",
    currentIteration:    0,
    maxIterations,
    targetScore,
    currentScore:        initialScore,
    bestScore:           initialScore,
    bestIteration:       0,
    stoppingCondition:   null,
    startedAt:           new Date().toISOString(),
    completedAt:         null,
    currentGateId:       null,
    generationEndpoint,
    iterations:          [],
    gateDecisions:       [],
    lastError:           null,
  };

  _integratedLoops.set(sourceJobId, state);

  // Fire-and-forget — callers poll /status
  void runIntegratedLoop(state).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    state.status       = "failed";
    state.lastError    = msg;
    state.completedAt  = new Date().toISOString();
    logger.error({ sourceJobId, err: msg }, "PH-1: integrated loop crashed");
  });

  return state;
}

// ---------------------------------------------------------------------------
// Integration report generator
// ---------------------------------------------------------------------------

export interface ReviewGateIntegrationReport {
  schemaVersion:       "PH-1";
  generatedAt:         string;
  description:         string;
  integrationStatus:   "active";
  pipeline: {
    vr8Stage:          string;
    gateStage:         string;
    generatorStage:    string;
    pausePoint:        string;
    resumeConditions:  string[];
  };
  behaviour: {
    onApprove:  string;
    onEdit:     string;
    onReject:   string;
    onSkip:     string;
    onTimeout:  string;
  };
  auditFeatures:       string[];
  activeLoops:         number;
  totalGateDecisions:  number;
  approvalReport:      ReturnType<typeof getApprovalReport>;
}

export function buildIntegrationReport(): ReviewGateIntegrationReport {
  const approvalReport = getApprovalReport();
  const loops          = listIntegratedLoops();
  const activeLoops    = loops.filter(l => l.status === "running" || l.status === "awaiting_review").length;
  const totalDecisions = loops.reduce((n, l) => n + l.gateDecisions.length, 0);

  return {
    schemaVersion: "PH-1",
    generatedAt:   new Date().toISOString(),
    description:
      "PS-2 Human Review Gate is now integrated directly into the VR-8 Autonomous Reconstruction Loop. " +
      "Every iteration pauses after RuleAdjustment[] generation and requires a human decision " +
      "before Website Prime regeneration proceeds.",
    integrationStatus: "active",
    pipeline: {
      vr8Stage:       "VR-8: Autonomous Reconstruction Loop (RuleAdjustment[] generation)",
      gateStage:      "PS-2: Human Review Gate (PENDING → APPROVED|EDITED|REJECTED|SKIPPED)",
      generatorStage: "Website Prime Generator (next iteration call)",
      pausePoint:     "After VR-8 deriveAdjustments(), before callGenerationEndpoint() for next iteration",
      resumeConditions: [
        "APPROVED  — continue with proposed RuleAdjustment[]",
        "EDITED    — continue with human-edited RuleAdjustment[]",
        "REJECTED  — terminate reconstruction loop",
        "SKIPPED   — continue next iteration with empty RuleAdjustment[]",
        "EXPIRED   — TTL exceeded: auto-reject, terminate loop",
      ],
    },
    behaviour: {
      onApprove: "Pipeline continues with the proposed RuleAdjustment[] unchanged.",
      onEdit:    "Human edits the RuleAdjustment[] via PUT /api/review-gate/:gateId/edit; edited list is used.",
      onReject:  "Reconstruction loop is terminated; no further iterations run for this job.",
      onSkip:    "Next iteration is called without any adjustments (empty RuleAdjustment[]).",
      onTimeout: "After 30 min gate TTL, gate is auto-EXPIRED which acts as REJECTED.",
    },
    auditFeatures: [
      "Append-only decision log (max 1 000 entries)",
      "Per-job gate history via getGatesForJob()",
      "Duplicate-approval guard (no two PENDING gates per job+iteration)",
      "Timeout handling via 30-min gate TTL with EXPIRED status",
      "Iteration history with gate action recorded per iteration",
      "Approval rate, average decision time in getApprovalReport()",
      "Disk persistence to /tmp/vr8-integrated/<sourceJobId>/",
    ],
    activeLoops,
    totalGateDecisions: totalDecisions,
    approvalReport,
  };
}
