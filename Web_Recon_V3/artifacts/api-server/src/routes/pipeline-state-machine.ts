/**
 * pipeline-state-machine.ts — Phase 7.2 routes
 *
 * POST /api/state-machine                  — create a machine + launch pipeline
 * GET  /api/state-machine                  — list all machines
 * GET  /api/state-machine/schema           — pipeline-state-machine.json schema
 * GET  /api/state-machine/:id              — get machine detail + full history
 * POST /api/state-machine/:id/pause        — pause before next stage
 * POST /api/state-machine/:id/resume       — resume a paused machine
 * POST /api/state-machine/:id/cancel       — cancel pipeline → FAILED
 * POST /api/state-machine/:id/retry        — retry from last checkpoint
 * GET  /api/state-machine/:id/history      — transition history only
 */

import { Router, type IRouter } from "express";
import {
  createMachine,
  getMachine,
  listMachines,
  advanceState,
  pause,
  resume,
  cancel,
  retry,
  linkPipelineJob,
  getSchema,
  persistSchemaToDisk,
} from "../lib/pipeline-state-machine.js";
import { createJob, runPipeline } from "../lib/master-orchestrator.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /state-machine — create machine + launch pipeline
// ---------------------------------------------------------------------------

router.post("/state-machine", async (req, res): Promise<void> => {
  const { url, baseJobId } = (req.body ?? {}) as {
    url?:       string;
    baseJobId?: string | null;
  };

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url is required" });
    return;
  }
  try { new URL(url); } catch {
    res.status(400).json({ error: "url must be a valid URL" });
    return;
  }

  // Create Phase 7.1 job
  const pipelineJob = createJob({ url, baseJobId });

  // Create Phase 7.2 state machine, linked to the pipeline job
  const machine = createMachine({ url, pipelineJobId: pipelineJob.id });

  req.log.info(
    { smId: machine.id, pipelineJobId: pipelineJob.id, url },
    "STATE-MACHINE: created, launching pipeline"
  );

  // Advance to DISCOVERING immediately
  advanceState(machine.id, "START");

  // Fire-and-forget pipeline with state machine advancement
  runPipelineWithStateMachine(machine.id, pipelineJob).catch((err) => {
    req.log.error({ smId: machine.id, err }, "STATE-MACHINE: unhandled pipeline error");
  });

  res.status(202).json({
    stateMachineId: machine.id,
    pipelineJobId:  pipelineJob.id,
    url,
    state:          getMachine(machine.id)?.state ?? "DISCOVERING",
    controls: {
      pause:  `/api/state-machine/${machine.id}/pause`,
      resume: `/api/state-machine/${machine.id}/resume`,
      cancel: `/api/state-machine/${machine.id}/cancel`,
      retry:  `/api/state-machine/${machine.id}/retry`,
      poll:   `/api/state-machine/${machine.id}`,
    },
    message: "Pipeline launched with state machine. Use controls to pause/cancel.",
  });
});

// ---------------------------------------------------------------------------
// GET /state-machine — list all machines
// ---------------------------------------------------------------------------

router.get("/state-machine", (_req, res): void => {
  const machines = listMachines();
  res.json({
    total: machines.length,
    machines: machines.map((m) => ({
      id:             m.id,
      pipelineJobId:  m.pipelineJobId,
      url:            m.url,
      state:          m.state,
      paused:         m.paused,
      retryCount:     m.retryCount,
      checkpointState:m.checkpointState,
      createdAt:      m.createdAt,
      completedAt:    m.completedAt,
      error:          m.error,
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /state-machine/schema — pipeline-state-machine.json
// ---------------------------------------------------------------------------

router.get("/state-machine/schema", async (_req, res): Promise<void> => {
  await persistSchemaToDisk().catch(() => {});
  res.json(getSchema());
});

// ---------------------------------------------------------------------------
// GET /state-machine/:id
// ---------------------------------------------------------------------------

router.get("/state-machine/:id", (req, res): void => {
  const m = getMachine(req.params["id"] ?? "");
  if (!m) {
    res.status(404).json({ error: "State machine not found" });
    return;
  }
  res.json(m);
});

// ---------------------------------------------------------------------------
// GET /state-machine/:id/history
// ---------------------------------------------------------------------------

router.get("/state-machine/:id/history", (req, res): void => {
  const m = getMachine(req.params["id"] ?? "");
  if (!m) {
    res.status(404).json({ error: "State machine not found" });
    return;
  }
  res.json({
    stateMachineId: m.id,
    state:          m.state,
    totalTransitions: m.history.length,
    history:        m.history,
  });
});

// ---------------------------------------------------------------------------
// POST /state-machine/:id/pause
// ---------------------------------------------------------------------------

router.post("/state-machine/:id/pause", (req, res): void => {
  const id = req.params["id"] ?? "";
  try {
    const m = pause(id);
    req.log.info({ smId: id, state: m.state }, "STATE-MACHINE: paused");
    res.json({
      stateMachineId: m.id,
      state:          m.state,
      paused:         m.paused,
      pausedAt:       m.pausedAt,
      message:        "Pipeline will freeze before the next stage boundary.",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// POST /state-machine/:id/resume
// ---------------------------------------------------------------------------

router.post("/state-machine/:id/resume", (req, res): void => {
  const id = req.params["id"] ?? "";
  try {
    const m = resume(id);
    req.log.info({ smId: id, state: m.state }, "STATE-MACHINE: resumed");
    res.json({
      stateMachineId: m.id,
      state:          m.state,
      paused:         m.paused,
      message:        "Pipeline resumed.",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// POST /state-machine/:id/cancel
// ---------------------------------------------------------------------------

router.post("/state-machine/:id/cancel", (req, res): void => {
  const id     = req.params["id"] ?? "";
  const reason = (req.body as { reason?: string })?.reason;
  try {
    const m = cancel(id, reason);
    req.log.info({ smId: id, reason }, "STATE-MACHINE: cancelled");
    res.json({
      stateMachineId: m.id,
      state:          m.state,
      cancelledAt:    m.cancelledAt,
      cancelReason:   m.cancelReason,
      message:        "Pipeline cancelled and transitioned to FAILED.",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// POST /state-machine/:id/retry
// ---------------------------------------------------------------------------

router.post("/state-machine/:id/retry", async (req, res): Promise<void> => {
  const id = req.params["id"] ?? "";
  let m = getMachine(id);
  if (!m) {
    res.status(404).json({ error: "State machine not found" });
    return;
  }

  try {
    // Reset the state machine to QUEUED
    m = retry(id);

    // Create a new pipeline job for the retry
    const newJob = createJob({ url: m.url });
    linkPipelineJob(id, newJob.id);

    // Advance to DISCOVERING
    advanceState(id, "START");

    req.log.info(
      { smId: id, retryCount: m.retryCount, checkpoint: m.checkpointState, newPipelineJobId: newJob.id },
      "STATE-MACHINE: retry launched"
    );

    // Re-launch the pipeline
    runPipelineWithStateMachine(id, newJob).catch((err) => {
      req.log.error({ smId: id, err }, "STATE-MACHINE: retry pipeline error");
    });

    res.json({
      stateMachineId:  id,
      state:           getMachine(id)?.state ?? "DISCOVERING",
      pipelineJobId:   newJob.id,
      retryCount:      m.retryCount,
      checkpointState: m.checkpointState,
      message:         `Retry #${m.retryCount} launched from checkpoint: ${m.checkpointState ?? "QUEUED"}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// Pipeline runner with state machine advancement
// ---------------------------------------------------------------------------

import { CancellationError } from "../lib/pipeline-state-machine.js";
import type { OrchestrationJob } from "../lib/master-orchestrator.js";

async function runPipelineWithStateMachine(
  machineId: string,
  pipelineJob: OrchestrationJob,
): Promise<void> {
  try {
    // Phase 7.1 runner handles the actual work; we listen via the machine
    // The state machine advances as the pipeline job's currentStage changes.
    // We poll the job to advance the machine in lock-step.

    const advanceWatcher = watchAndAdvanceMachine(machineId, pipelineJob);

    await runPipeline(pipelineJob);

    // Signal watcher to stop
    _watcherStopped.set(machineId, true);
    await advanceWatcher;

    // Final state
    const m = getMachine(machineId);
    if (m && m.state !== "COMPLETE" && m.state !== "FAILED" && m.state !== "ROLLED_BACK") {
      advanceState(machineId, pipelineJob.status === "complete" ? "DEPLOY_DONE" : "ERROR",
        pipelineJob.error ?? undefined);
    }
  } catch (err) {
    _watcherStopped.set(machineId, true);
    const isCancelled = err instanceof CancellationError;
    const m           = getMachine(machineId);
    if (m && !["COMPLETE","FAILED","ROLLED_BACK"].includes(m.state)) {
      try {
        advanceState(machineId, "ERROR", isCancelled ? "Cancelled" : (err instanceof Error ? err.message : String(err)));
      } catch { /* ignore bad transition */ }
    }
  }
}

// Stage → state machine trigger mapping
const STAGE_TO_TRIGGER: Record<string, string> = {
  "crawl":           "CRAWL_STARTED",
  "manifest":        "CRAWL_DONE",
  "diff":            "MANIFEST_DONE",
  "intelligence":    "DIFF_DONE",
  "design-dna":      "INTELLIGENCE_DONE",
  "visual-dna":      "INTELLIGENCE_DONE",
  "stencil":         "VISUAL_DONE",
  "website-prime":   "STENCIL_DONE",
  "merge":           "SITE_DONE",
  "deployment-plan": "MERGE_DONE",
  "deploy":          "PLAN_DONE",
};

const _watcherStopped = new Map<string, boolean>();

async function watchAndAdvanceMachine(
  machineId:   string,
  pipelineJob: OrchestrationJob,
): Promise<void> {
  let lastStage: string | null = null;

  while (!_watcherStopped.get(machineId)) {
    await new Promise((r) => setTimeout(r, 300));

    const currentStage = pipelineJob.currentStage;
    if (!currentStage || currentStage === lastStage) continue;

    lastStage = currentStage;
    const trigger = STAGE_TO_TRIGGER[currentStage];
    if (!trigger) continue;

    const m = getMachine(machineId);
    if (!m || ["COMPLETE","FAILED","ROLLED_BACK"].includes(m.state)) break;

    // Handle diff-skipped case
    if (currentStage === "intelligence" && m.state === "MANIFESTING") {
      try { advanceState(machineId, "DIFF_SKIPPED"); } catch { /* already past */ }
    }

    try {
      advanceState(machineId, trigger as import("../lib/pipeline-state-machine.js").StateTrigger);
    } catch {
      // Transition may already have happened; that's fine
    }
  }
}

export default router;
