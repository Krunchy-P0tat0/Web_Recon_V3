/**
 * deployment-execution.ts — Phase D3 Deployment Execution API routes
 *
 * Endpoints:
 *   POST /deploy/execute                  — Execute a deployment for a job's generated site
 *   GET  /deploy/executions               — List all execution records
 *   GET  /deploy/executions/:id           — Get a single execution record
 *   POST /deploy/executions/:id/rollback  — Rollback an execution to the previous one
 *   GET  /deploy/audit                    — Get the deployment-audit.json
 */

import { Router, type IRouter } from "express";
import {
  executeDeployment,
  rollbackExecution,
  type ExecutionTarget,
} from "../lib/deployment-executor.js";
import {
  recordExecution,
  updateExecution,
  getExecution,
  listExecutions,
  getPreviousSuccessfulForJob,
  generateAuditJson,
  saveAuditToDisk,
} from "../lib/deployment-audit-store.js";
import { generateRollbackPlan } from "../lib/rollback-plan-engine.js";
import { getDefaultCloudProvider } from "../cloud/index.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /deploy/execute
// ---------------------------------------------------------------------------

router.post("/deploy/execute", async (req, res): Promise<void> => {
  const body = req.body as { jobId?: unknown; framework?: unknown; target?: unknown };
  if (typeof body.jobId !== "string" || !body.jobId) {
    res.status(400).json({ error: "jobId (string) is required" });
    return;
  }
  if (typeof body.framework !== "string" || !body.framework) {
    res.status(400).json({ error: "framework (string) is required" });
    return;
  }
  if (body.target !== "r2-static") {
    res.status(400).json({ error: 'target must be "r2-static"' });
    return;
  }
  const jobId = body.jobId;
  const framework = body.framework;
  const target: ExecutionTarget = body.target;

  req.log.info({ jobId, target }, "DEPLOY-EXECUTE: starting");

  const execution = await executeDeployment({ jobId, framework: framework ?? null, target });
  recordExecution(execution);
  await saveAuditToDisk().catch(() => {/* non-fatal */});

  // Phase 6.5 gate: every deployment must have a rollback plan
  const rollbackPlan = await generateRollbackPlan(execution, getDefaultCloudProvider()).catch((err) => {
    req.log.warn({ executionId: execution.id, err }, "DEPLOY-EXECUTE: rollback plan generation failed (non-fatal)");
    return null;
  });

  const statusCode = execution.status === "success" ? 200 : 500;

  req.log.info(
    {
      executionId:      execution.id,
      status:           execution.status,
      durationMs:       execution.durationMs,
      rollbackReadiness: rollbackPlan?.readiness ?? "unavailable",
    },
    "DEPLOY-EXECUTE: completed"
  );

  res.status(statusCode).json({ execution, rollbackPlan });
});

// ---------------------------------------------------------------------------
// GET /deploy/executions
// ---------------------------------------------------------------------------

router.get("/deploy/executions", (_req, res): void => {
  const executions = listExecutions();
  res.json({
    total: executions.length,
    executions,
  });
});

// ---------------------------------------------------------------------------
// GET /deploy/executions/:id
// ---------------------------------------------------------------------------

router.get("/deploy/executions/:id", (req, res): void => {
  const execution = getExecution(req.params["id"] ?? "");
  if (!execution) {
    res.status(404).json({ error: "Execution not found" });
    return;
  }
  res.json({ execution });
});

// ---------------------------------------------------------------------------
// POST /deploy/executions/:id/rollback
// ---------------------------------------------------------------------------

router.post("/deploy/executions/:id/rollback", (req, res): void => {
  const id = req.params["id"] ?? "";
  const execution = getExecution(id);
  if (!execution) {
    res.status(404).json({ error: "Execution not found" });
    return;
  }
  if (execution.status === "rolled_back") {
    res.status(409).json({ error: "Execution is already rolled back" });
    return;
  }
  if (!execution.jobId) {
    res.status(422).json({ error: "Cannot rollback — execution has no associated jobId" });
    return;
  }

  const previous = getPreviousSuccessfulForJob(execution.jobId, id);
  if (!previous) {
    res.status(422).json({
      error: "No previous successful deployment found to rollback to",
      executionId: id,
    });
    return;
  }

  const rolledBack = rollbackExecution(execution, previous);
  updateExecution(rolledBack);

  saveAuditToDisk().catch(() => {/* non-fatal */});

  req.log.info(
    { executionId: id, rolledBackToId: previous.id, url: previous.deploymentUrl },
    "DEPLOY-EXECUTE: rolled back"
  );

  res.json({
    execution: rolledBack,
    activeDeploymentUrl: previous.deploymentUrl,
    message: `Rolled back to deployment ${previous.id}`,
  });
});

// ---------------------------------------------------------------------------
// GET /deploy/audit
// ---------------------------------------------------------------------------

router.get("/deploy/audit", async (_req, res): Promise<void> => {
  const audit = generateAuditJson();
  await saveAuditToDisk().catch(() => {/* non-fatal */});
  res.json(audit);
});

export default router;
