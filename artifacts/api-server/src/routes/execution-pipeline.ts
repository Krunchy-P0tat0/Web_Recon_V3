/**
 * execution-pipeline.ts — Phase 6.3 Deployment Execution Engine routes
 *
 *   POST /execute/pipeline          — Run all checks, generate deployment-execution.json
 *   GET  /execute/pipeline          — Return latest cached execution plan
 *   GET  /execute/pipeline/stages   — List all 5 stages with status
 *   GET  /execute/pipeline/checks   — All validation checks grouped by type
 *   GET  /execute/pipeline/stages/:stage — Full detail for a single stage
 */

import { writeFile }  from "fs/promises";
import { readFile }   from "fs/promises";
import { join }       from "path";
import { existsSync } from "fs";
import { Router, type IRouter } from "express";
import { generateExecutionPipeline } from "../lib/execution-pipeline.js";
import type { DeploymentExecutionJson, StageId } from "../lib/execution-pipeline.js";
import { R2Provider } from "../cloud/r2.provider.js";

const router: IRouter = Router();

const WORKSPACE_ROOT    = join(process.cwd(), "..", "..");
const EXECUTION_PATH    = join(WORKSPACE_ROOT, "deployment-execution.json");

let latestExecution: DeploymentExecutionJson | null = null;

// ─── helper ───────────────────────────────────────────────────────────────────

async function readCached(): Promise<DeploymentExecutionJson | null> {
  if (latestExecution) return latestExecution;
  if (!existsSync(EXECUTION_PATH)) return null;
  try {
    const raw = await readFile(EXECUTION_PATH, "utf8");
    latestExecution = JSON.parse(raw) as DeploymentExecutionJson;
    return latestExecution;
  } catch { return null; }
}

// ─── POST /execute/pipeline ───────────────────────────────────────────────────

router.post("/execute/pipeline", async (req, res): Promise<void> => {
  const { target, jobId } = req.body as { target?: string; jobId?: string };

  req.log.info({ target, jobId }, "EXECUTION-PIPELINE: starting checks");

  try {
    const execution = await generateExecutionPipeline(target, jobId ?? null);
    latestExecution = execution;

    const json   = JSON.stringify(execution, null, 2);
    const cloud  = new R2Provider();

    const writes: Promise<void>[] = [
      writeFile(EXECUTION_PATH, json, "utf8")
        .catch(e => req.log.warn({ e }, "EXECUTION-PIPELINE: local write failed")),
    ];

    if (jobId && cloud.isConfigured()) {
      writes.push(
        cloud.upload({
          key:            `jobs/${jobId}/deployment-execution.json`,
          data:           Buffer.from(json, "utf8"),
          contentType:    "application/json",
          checkDuplicate: false,
        })
        .then(() => req.log.info({ jobId }, "EXECUTION-PIPELINE: uploaded to R2"))
        .catch(e  => req.log.warn({ e }, "EXECUTION-PIPELINE: R2 upload failed (non-fatal)")),
      );
    }

    await Promise.allSettled(writes);

    const blockedCount  = execution.blockingIssues.length;
    const warningCount  = execution.warnings.length;
    const passCount     = [
      ...execution.preflightChecks,
      ...execution.buildValidation,
      ...execution.artifactValidation,
      ...execution.environmentValidation,
    ].filter(c => c.status === "pass").length;

    req.log.info(
      { target: execution.target, overallStatus: execution.overallStatus, blockedCount, warningCount, passCount },
      "EXECUTION-PIPELINE: complete",
    );

    res.status(200).json({
      ok:                   true,
      overallStatus:        execution.overallStatus,
      readyToExecute:       execution.readyToExecute,
      target:               execution.target,
      targetLabel:          execution.targetLabel,
      stack:                execution.stack,
      summary: {
        totalChecks:    passCount + blockedCount + warningCount,
        passed:         passCount,
        warnings:       warningCount,
        blocking:       blockedCount,
      },
      blockingIssues:       execution.blockingIssues,
      warnings:             execution.warnings,
      estimatedDuration:    execution.estimatedTotalDuration,
      stages:               execution.stages.map(s => ({
        name:              s.name,
        label:             s.label,
        order:             s.order,
        status:            s.status,
        estimatedDuration: s.estimatedDuration,
      })),
      outputFiles:          execution.outputFiles,
    });
  } catch (err) {
    req.log.error({ err }, "EXECUTION-PIPELINE: failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── GET /execute/pipeline ────────────────────────────────────────────────────

router.get("/execute/pipeline", async (_req, res): Promise<void> => {
  const data = await readCached();
  if (!data) {
    res.status(404).json({ error: "No execution plan found. Run POST /api/execute/pipeline first." });
    return;
  }
  res.status(200).json(data);
});

// ─── GET /execute/pipeline/checks ─────────────────────────────────────────────

router.get("/execute/pipeline/checks", async (_req, res): Promise<void> => {
  const data = await readCached();
  if (!data) {
    res.status(404).json({ error: "No execution plan found. Run POST /api/execute/pipeline first." });
    return;
  }
  res.status(200).json({
    overallStatus:   data.overallStatus,
    readyToExecute:  data.readyToExecute,
    preflight:       data.preflightChecks,
    build:           data.buildValidation,
    artifact:        data.artifactValidation,
    environment:     data.environmentValidation,
    blockingIssues:  data.blockingIssues,
    warnings:        data.warnings,
  });
});

// ─── GET /execute/pipeline/stages ─────────────────────────────────────────────

router.get("/execute/pipeline/stages", async (_req, res): Promise<void> => {
  const data = await readCached();
  if (!data) {
    res.status(404).json({ error: "No execution plan found. Run POST /api/execute/pipeline first." });
    return;
  }
  res.status(200).json({
    target:  data.target,
    stages:  data.stages,
    overallStatus: data.overallStatus,
  });
});

// ─── GET /execute/pipeline/stages/:stage ──────────────────────────────────────

router.get("/execute/pipeline/stages/:stage", async (req, res): Promise<void> => {
  const stageName = req.params["stage"] as StageId;
  const validStages: StageId[] = ["prepare", "build", "verify", "deploy", "monitor"];

  if (!validStages.includes(stageName)) {
    res.status(400).json({
      error: `Unknown stage '${stageName}'. Valid stages: ${validStages.join(", ")}`,
    });
    return;
  }

  const data = await readCached();
  if (!data) {
    res.status(404).json({ error: "No execution plan found. Run POST /api/execute/pipeline first." });
    return;
  }

  const stage = data.stages.find(s => s.name === stageName);
  if (!stage) {
    res.status(404).json({ error: `Stage '${stageName}' not found in current execution plan.` });
    return;
  }

  res.status(200).json(stage);
});

export default router;
