/**
 * pipeline-state-machine.ts — Phase 7.2: Deterministic Pipeline State Machine
 *
 * Defines 15 deterministic states, valid transitions, and a full control plane:
 *   pause · resume · cancel · retry (from last successful checkpoint)
 *
 * Integration with Phase 7.1 master orchestrator:
 *   - isPaused(pipelineJobId)       — checked before every stage advance
 *   - isCancelled(pipelineJobId)    — checked before every stage advance
 *   - waitIfPaused(pipelineJobId)   — yields until resumed or cancelled
 *   - advanceState(pipelineJobId, trigger) — called by the pipeline runner
 *     to keep the state machine in sync with actual execution
 *
 * Generates pipeline-state-machine.json (schema) on first load and on demand.
 */

import { randomUUID }          from "crypto";
import { writeFile, readFile } from "fs/promises";
import { join }                from "path";
import { logger }              from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";

// ---------------------------------------------------------------------------
// State & trigger enums
// ---------------------------------------------------------------------------

export type PipelineState =
  | "QUEUED"
  | "DISCOVERING"
  | "SCRAPING"
  | "MANIFESTING"
  | "DIFFING"
  | "INTELLIGENCE"
  | "VISUAL_RECONSTRUCTION"
  | "STENCIL_GENERATION"
  | "SITE_GENERATION"
  | "MERGING"
  | "DEPLOYMENT_PLANNING"
  | "DEPLOYING"
  | "COMPLETE"
  | "FAILED"
  | "ROLLED_BACK";

export type StateTrigger =
  | "START"
  | "CRAWL_STARTED"
  | "CRAWL_DONE"
  | "MANIFEST_DONE"
  | "DIFF_DONE"
  | "DIFF_SKIPPED"
  | "INTELLIGENCE_DONE"
  | "VISUAL_DONE"
  | "STENCIL_DONE"
  | "SITE_DONE"
  | "MERGE_DONE"
  | "PLAN_DONE"
  | "DEPLOY_DONE"
  | "ERROR"
  | "ROLLBACK"
  | "RETRY"
  | "CANCEL";

export type ControlAction = "pause" | "resume" | "cancel" | "retry";

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

interface Transition {
  from:        PipelineState[];
  to:          PipelineState;
  trigger:     StateTrigger;
  description: string;
}

export const TRANSITIONS: Transition[] = [
  { from: ["QUEUED"],                to: "DISCOVERING",        trigger: "START",            description: "Validate URL and initialise execution context" },
  { from: ["DISCOVERING"],           to: "SCRAPING",           trigger: "CRAWL_STARTED",    description: "Submit scrape job and begin crawling all pages" },
  { from: ["SCRAPING"],              to: "MANIFESTING",        trigger: "CRAWL_DONE",       description: "Crawl complete — verify content manifest in DB" },
  { from: ["MANIFESTING"],           to: "DIFFING",            trigger: "MANIFEST_DONE",    description: "Manifest verified — run diff against baseline if provided" },
  { from: ["DIFFING"],               to: "INTELLIGENCE",       trigger: "DIFF_DONE",        description: "Diff computed — run deployment environment intelligence" },
  { from: ["MANIFESTING"],           to: "INTELLIGENCE",       trigger: "DIFF_SKIPPED",     description: "No baseline — skip diff and proceed to intelligence" },
  { from: ["INTELLIGENCE"],          to: "VISUAL_RECONSTRUCTION", trigger: "INTELLIGENCE_DONE", description: "Intelligence complete — classify design DNA and run visual analysis" },
  { from: ["VISUAL_RECONSTRUCTION"], to: "STENCIL_GENERATION", trigger: "VISUAL_DONE",     description: "Visual DNA done — select and assemble stencil" },
  { from: ["STENCIL_GENERATION"],    to: "SITE_GENERATION",    trigger: "STENCIL_DONE",     description: "Stencil assembled — generate full site blueprint" },
  { from: ["SITE_GENERATION"],       to: "MERGING",            trigger: "SITE_DONE",        description: "Site blueprint ready — compile merge plan" },
  { from: ["MERGING"],               to: "DEPLOYMENT_PLANNING", trigger: "MERGE_DONE",      description: "Merge plan compiled — generate multi-framework deployment plan" },
  { from: ["DEPLOYMENT_PLANNING"],   to: "DEPLOYING",          trigger: "PLAN_DONE",        description: "Deployment plan ready — execute deployment" },
  { from: ["DEPLOYING"],             to: "COMPLETE",           trigger: "DEPLOY_DONE",      description: "Deployment succeeded — pipeline complete" },
  { from: ["DEPLOYING"],             to: "ROLLED_BACK",        trigger: "ROLLBACK",         description: "Deployment failed — rollback plan executed" },
  {
    from: [
      "QUEUED","DISCOVERING","SCRAPING","MANIFESTING","DIFFING","INTELLIGENCE",
      "VISUAL_RECONSTRUCTION","STENCIL_GENERATION","SITE_GENERATION",
      "MERGING","DEPLOYMENT_PLANNING","DEPLOYING",
    ],
    to:          "FAILED",
    trigger:     "ERROR",
    description: "Unrecoverable error — pipeline halted",
  },
  {
    from: [
      "QUEUED","DISCOVERING","SCRAPING","MANIFESTING","DIFFING","INTELLIGENCE",
      "VISUAL_RECONSTRUCTION","STENCIL_GENERATION","SITE_GENERATION",
      "MERGING","DEPLOYMENT_PLANNING","DEPLOYING",
    ],
    to:          "FAILED",
    trigger:     "CANCEL",
    description: "Pipeline cancelled by operator",
  },
  {
    from: ["FAILED","ROLLED_BACK"],
    to:          "QUEUED",
    trigger:     "RETRY",
    description: "Re-queue pipeline for execution from last checkpoint",
  },
];

// ---------------------------------------------------------------------------
// State descriptions
// ---------------------------------------------------------------------------

export const STATE_DESCRIPTIONS: Record<PipelineState, string> = {
  QUEUED:               "Waiting in queue — not yet started",
  DISCOVERING:          "Validating URL and building execution plan",
  SCRAPING:             "Crawling all pages via the scrape pipeline",
  MANIFESTING:          "Verifying page content manifest in the database",
  DIFFING:              "Computing diff against baseline job (if provided)",
  INTELLIGENCE:         "Running deployment environment and risk intelligence",
  VISUAL_RECONSTRUCTION:"Classifying design DNA, running visual DNA analysis",
  STENCIL_GENERATION:   "Selecting stencil type and assembling page structure",
  SITE_GENERATION:      "Generating full site blueprint (Website Prime)",
  MERGING:              "Compiling backend merge plan",
  DEPLOYMENT_PLANNING:  "Generating multi-framework deployment plan",
  DEPLOYING:            "Executing deployment and verifying output",
  COMPLETE:             "Pipeline finished successfully — site deployed",
  FAILED:               "Pipeline halted due to unrecoverable error or cancellation",
  ROLLED_BACK:          "Deployment rolled back — previous version restored",
};

// Terminal states (no forward transitions)
const TERMINAL_STATES = new Set<PipelineState>(["COMPLETE", "FAILED", "ROLLED_BACK"]);

// Ordered active states (for checkpoint retry)
const ORDERED_STATES: PipelineState[] = [
  "QUEUED","DISCOVERING","SCRAPING","MANIFESTING","DIFFING","INTELLIGENCE",
  "VISUAL_RECONSTRUCTION","STENCIL_GENERATION","SITE_GENERATION",
  "MERGING","DEPLOYMENT_PLANNING","DEPLOYING","COMPLETE",
];

// ---------------------------------------------------------------------------
// Runtime record
// ---------------------------------------------------------------------------

export interface StateTransitionEvent {
  from:        PipelineState;
  to:          PipelineState;
  trigger:     StateTrigger | ControlAction;
  at:          string;
  durationInStateMs?: number;
  note?:       string;
}

export interface StateMachineRecord {
  id:                  string;
  pipelineJobId:       string | null;
  url:                 string;
  state:               PipelineState;
  previousState:       PipelineState | null;
  checkpointState:     PipelineState | null;
  history:             StateTransitionEvent[];
  paused:              boolean;
  pausedAt:            string | null;
  cancelledAt:         string | null;
  cancelReason:        string | null;
  retryCount:          number;
  maxRetries:          number;
  enteredCurrentStateAt: string;
  createdAt:           string;
  updatedAt:           string;
  completedAt:         string | null;
  error:               string | null;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const _machines = new Map<string, StateMachineRecord>();

// Control flag maps — keyed by pipelineJobId (for Phase 7.1 integration)
const _pauseFlags    = new Map<string, boolean>();
const _cancelFlags   = new Map<string, boolean>();

// ---------------------------------------------------------------------------
// Control flag hooks (imported by master-orchestrator.ts)
// ---------------------------------------------------------------------------

/** Returns true if the pipeline job is currently paused */
export function isPaused(pipelineJobId: string): boolean {
  return _pauseFlags.get(pipelineJobId) === true;
}

/** Returns true if the pipeline job has been cancelled */
export function isCancelled(pipelineJobId: string): boolean {
  return _cancelFlags.get(pipelineJobId) === true;
}

/**
 * Called at the start of each stage by the pipeline runner.
 * Polls every 500ms until unpaused or cancelled.
 * Throws CancellationError if cancelled while waiting.
 */
export async function waitIfPaused(pipelineJobId: string): Promise<void> {
  while (_pauseFlags.get(pipelineJobId) === true) {
    if (_cancelFlags.get(pipelineJobId) === true) {
      throw new CancellationError(`Pipeline ${pipelineJobId} was cancelled`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (_cancelFlags.get(pipelineJobId) === true) {
    throw new CancellationError(`Pipeline ${pipelineJobId} was cancelled`);
  }
}

export class CancellationError extends Error {
  constructor(msg: string) { super(msg); this.name = "CancellationError"; }
}

// ---------------------------------------------------------------------------
// State machine helpers
// ---------------------------------------------------------------------------

function findTransition(from: PipelineState, trigger: StateTrigger): Transition | undefined {
  return TRANSITIONS.find((t) => t.from.includes(from) && t.trigger === trigger);
}

function machineById(id: string): StateMachineRecord | undefined {
  return _machines.get(id);
}

function saveMachine(m: StateMachineRecord): void {
  m.updatedAt = new Date().toISOString();
  _machines.set(m.id, m);
}

// ---------------------------------------------------------------------------
// Disk persistence
// ---------------------------------------------------------------------------

const ENGINE_JSON_PATH = join(process.cwd(), "pipeline-state-machine.json");
const AUDIT_PATH       = join(process.cwd(), "pipeline-state-machine-audit.json");

async function persistSchemaToDisk(): Promise<void> {
  const schema = buildSchemaDoc();
  const json   = JSON.stringify(schema, null, 2);
  const cloud  = getDefaultCloudProvider();

  await writeFile(ENGINE_JSON_PATH, json, "utf8").catch(() => {});

  if (cloud.isConfigured()) {
    await cloud.upload({
      key: "orchestration/pipeline-state-machine.json",
      data: Buffer.from(json, "utf8"),
      contentType: "application/json",
      checkDuplicate: false,
    }).catch(() => {});
  }
}

async function persistAuditToDisk(): Promise<void> {
  const machines = listMachines();
  const doc = {
    version:     "1.0",
    generatedAt: new Date().toISOString(),
    total:       machines.length,
    summary: {
      complete:    machines.filter((m) => m.state === "COMPLETE").length,
      failed:      machines.filter((m) => m.state === "FAILED").length,
      rolledBack:  machines.filter((m) => m.state === "ROLLED_BACK").length,
      running:     machines.filter((m) => !TERMINAL_STATES.has(m.state) && m.state !== "QUEUED").length,
      queued:      machines.filter((m) => m.state === "QUEUED").length,
      paused:      machines.filter((m) => m.paused).length,
    },
    machines,
  };
  const json  = JSON.stringify(doc, null, 2);
  const cloud = getDefaultCloudProvider();

  await writeFile(AUDIT_PATH, json, "utf8").catch(() => {});

  if (cloud.isConfigured()) {
    await cloud.upload({
      key: "orchestration/pipeline-state-machine-audit.json",
      data: Buffer.from(json, "utf8"),
      contentType: "application/json",
      checkDuplicate: false,
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Schema document builder
// ---------------------------------------------------------------------------

function buildSchemaDoc() {
  return {
    version:     "1.0",
    generatedAt: new Date().toISOString(),
    phase:       "7.2",
    description: "Deterministic pipeline state machine for website reconstruction",
    states:      Object.entries(STATE_DESCRIPTIONS).map(([id, description]) => ({
      id,
      description,
      terminal:  TERMINAL_STATES.has(id as PipelineState),
      pauseable: !TERMINAL_STATES.has(id as PipelineState),
    })),
    transitions: TRANSITIONS.map((t) => ({
      from:        t.from,
      to:          t.to,
      trigger:     t.trigger,
      description: t.description,
    })),
    controls: {
      pause:  { availableIn: ORDERED_STATES.filter((s) => !TERMINAL_STATES.has(s)), description: "Freeze pipeline before next stage" },
      resume: { availableIn: ORDERED_STATES.filter((s) => !TERMINAL_STATES.has(s)), description: "Unfreeze paused pipeline" },
      cancel: { availableIn: ORDERED_STATES.filter((s) => !TERMINAL_STATES.has(s)), description: "Terminate pipeline, transition to FAILED" },
      retry:  { availableIn: ["FAILED","ROLLED_BACK"],                               description: "Re-queue from last checkpoint" },
    },
    orderedFlow: ORDERED_STATES,
  };
}

// Eagerly write schema on module load
persistSchemaToDisk().catch(() => {});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createMachine(opts: {
  url:           string;
  pipelineJobId?: string | null;
}): StateMachineRecord {
  const id  = randomUUID();
  const now = new Date().toISOString();
  const m: StateMachineRecord = {
    id,
    pipelineJobId:         opts.pipelineJobId ?? null,
    url:                   opts.url,
    state:                 "QUEUED",
    previousState:         null,
    checkpointState:       null,
    history:               [],
    paused:                false,
    pausedAt:              null,
    cancelledAt:           null,
    cancelReason:          null,
    retryCount:            0,
    maxRetries:            3,
    enteredCurrentStateAt: now,
    createdAt:             now,
    updatedAt:             now,
    completedAt:           null,
    error:                 null,
  };
  _machines.set(id, m);

  if (opts.pipelineJobId) {
    _pauseFlags.set(opts.pipelineJobId, false);
    _cancelFlags.set(opts.pipelineJobId, false);
  }

  logger.info({ smId: id, url: opts.url }, "SM: machine created");
  return m;
}

export function getMachine(id: string): StateMachineRecord | undefined {
  return machineById(id);
}

export function getMachineByPipelineJobId(pipelineJobId: string): StateMachineRecord | undefined {
  for (const m of _machines.values()) {
    if (m.pipelineJobId === pipelineJobId) return m;
  }
  return undefined;
}

export function listMachines(): StateMachineRecord[] {
  return Array.from(_machines.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * Advance state via a trigger — called by the pipeline runner after each stage.
 * Idempotent if already in the target state.
 */
export function advanceState(
  machineId: string,
  trigger: StateTrigger,
  note?: string,
): StateMachineRecord {
  const m = machineById(machineId);
  if (!m) throw new Error(`State machine ${machineId} not found`);

  const tx = findTransition(m.state, trigger);
  if (!tx) {
    logger.warn({ smId: machineId, from: m.state, trigger }, "SM: no valid transition");
    throw new Error(`No transition from ${m.state} via ${trigger}`);
  }

  const now = new Date().toISOString();
  const event: StateTransitionEvent = {
    from:               m.state,
    to:                 tx.to,
    trigger,
    at:                 now,
    durationInStateMs:  Date.now() - new Date(m.enteredCurrentStateAt).getTime(),
    note,
  };

  m.history.push(event);
  m.previousState         = m.state;

  // Update checkpoint to last non-terminal state before moving forward
  if (!TERMINAL_STATES.has(m.state)) {
    m.checkpointState = m.state;
  }

  m.state                 = tx.to;
  m.enteredCurrentStateAt = now;

  if (TERMINAL_STATES.has(tx.to)) {
    m.completedAt = now;
    if (tx.to === "FAILED") m.error = note ?? "Pipeline failed";
  }

  saveMachine(m);
  logger.info({ smId: machineId, from: event.from, to: tx.to, trigger }, "SM: transition");
  return m;
}

/**
 * Pause — freeze before the next stage boundary.
 * Throws if already in a terminal state.
 */
export function pause(machineId: string): StateMachineRecord {
  const m = machineById(machineId);
  if (!m) throw new Error(`State machine ${machineId} not found`);
  if (TERMINAL_STATES.has(m.state)) throw new Error(`Cannot pause: machine is in terminal state ${m.state}`);
  if (m.paused) return m;

  m.paused   = true;
  m.pausedAt = new Date().toISOString();

  if (m.pipelineJobId) _pauseFlags.set(m.pipelineJobId, true);

  m.history.push({
    from:    m.state,
    to:      m.state,
    trigger: "pause",
    at:      m.pausedAt,
    note:    "Operator paused pipeline",
  });
  saveMachine(m);
  logger.info({ smId: machineId, state: m.state }, "SM: paused");
  return m;
}

/**
 * Resume — unfreeze a paused pipeline.
 */
export function resume(machineId: string): StateMachineRecord {
  const m = machineById(machineId);
  if (!m) throw new Error(`State machine ${machineId} not found`);
  if (!m.paused) return m;

  m.paused   = false;
  m.pausedAt = null;

  if (m.pipelineJobId) _pauseFlags.set(m.pipelineJobId, false);

  m.history.push({
    from:    m.state,
    to:      m.state,
    trigger: "resume",
    at:      new Date().toISOString(),
    note:    "Operator resumed pipeline",
  });
  saveMachine(m);
  logger.info({ smId: machineId, state: m.state }, "SM: resumed");
  return m;
}

/**
 * Cancel — transition to FAILED (cancellation).
 */
export function cancel(machineId: string, reason?: string): StateMachineRecord {
  const m = machineById(machineId);
  if (!m) throw new Error(`State machine ${machineId} not found`);
  if (TERMINAL_STATES.has(m.state)) throw new Error(`Cannot cancel: already in terminal state ${m.state}`);

  const now   = new Date().toISOString();
  const note  = reason ?? "Cancelled by operator";

  // Signal the pipeline runner to stop
  if (m.pipelineJobId) {
    _cancelFlags.set(m.pipelineJobId, true);
    _pauseFlags.set(m.pipelineJobId, false);   // unblock any waitIfPaused loop so it exits
  }

  m.history.push({
    from:    m.state,
    to:      "FAILED",
    trigger: "cancel",
    at:      now,
    note,
  });

  m.checkpointState = m.state;
  m.previousState   = m.state;
  m.state           = "FAILED";
  m.cancelledAt     = now;
  m.cancelReason    = note;
  m.error           = `Cancelled: ${note}`;
  m.completedAt     = now;
  m.paused          = false;

  saveMachine(m);
  logger.info({ smId: machineId, reason }, "SM: cancelled");

  void persistAuditToDisk().catch(() => {});
  return m;
}

/**
 * Retry — re-queue from the last successful checkpoint.
 * Resets state to QUEUED; the caller must re-invoke the pipeline runner.
 */
export function retry(machineId: string): StateMachineRecord {
  const m = machineById(machineId);
  if (!m) throw new Error(`State machine ${machineId} not found`);

  if (!TERMINAL_STATES.has(m.state)) {
    throw new Error(`Cannot retry: machine is not in a terminal state (current: ${m.state})`);
  }

  if (m.retryCount >= m.maxRetries) {
    throw new Error(`Max retries (${m.maxRetries}) exhausted`);
  }

  const now = new Date().toISOString();

  m.history.push({
    from:    m.state,
    to:      "QUEUED",
    trigger: "retry",
    at:      now,
    note:    `Retry #${m.retryCount + 1} from checkpoint: ${m.checkpointState ?? "QUEUED"}`,
  });

  m.retryCount           += 1;
  m.previousState         = m.state;
  m.state                 = "QUEUED";
  m.enteredCurrentStateAt = now;
  m.completedAt           = null;
  m.error                 = null;
  m.paused                = false;
  m.pausedAt              = null;
  m.cancelledAt           = null;
  m.cancelReason          = null;

  // Reset control flags for the pipeline job
  if (m.pipelineJobId) {
    _pauseFlags.set(m.pipelineJobId, false);
    _cancelFlags.set(m.pipelineJobId, false);
  }

  saveMachine(m);
  logger.info({ smId: machineId, retryCount: m.retryCount, checkpoint: m.checkpointState }, "SM: retry queued");

  void persistAuditToDisk().catch(() => {});
  return m;
}

/**
 * Link an existing machine to a new pipeline job ID (used when a retry
 * creates a fresh Phase 7.1 job but keeps the same machine record).
 */
export function linkPipelineJob(machineId: string, pipelineJobId: string): StateMachineRecord {
  const m = machineById(machineId);
  if (!m) throw new Error(`State machine ${machineId} not found`);

  m.pipelineJobId = pipelineJobId;
  _pauseFlags.set(pipelineJobId, false);
  _cancelFlags.set(pipelineJobId, false);

  saveMachine(m);
  return m;
}

// ---------------------------------------------------------------------------
// Schema accessors
// ---------------------------------------------------------------------------

export function getSchema() {
  return buildSchemaDoc();
}

export async function readSchemaFromDisk(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(ENGINE_JSON_PATH, "utf8"));
  } catch { return null; }
}

export { persistSchemaToDisk, persistAuditToDisk };
