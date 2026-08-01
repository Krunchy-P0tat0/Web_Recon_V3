import { Router, type IRouter } from "express";
import { createJob, runPipeline, getJob, listJobs } from "../lib/master-orchestrator.js";
import { getExecutionPlanner } from "../lib/differential-execution-planner.js";
import type { ExecutionMode } from "../lib/differential-execution-planner-types.js";

const VALID_MODES: ExecutionMode[] = [
  "fresh", "differential", "resume", "upgrade", "regenerate-website-prime",
];

const router: IRouter = Router();

router.post("/orchestrate", async (req, res, next) => {
  try {
    const { url, baseJobId, coverageThreshold, executionMode } = req.body as Record<string, unknown>;

    if (typeof url !== "string" || !url.startsWith("http")) {
      res.status(400).json({ error: "url is required and must be a valid HTTP/S URL" });
      return;
    }

    const threshold = typeof coverageThreshold === "number"
      ? coverageThreshold
      : typeof coverageThreshold === "string"
        ? parseInt(coverageThreshold, 10)
        : 96;

    if (isNaN(threshold) || threshold < 0 || threshold > 100) {
      res.status(400).json({ error: "coverageThreshold must be a number between 0 and 100" });
      return;
    }

    // Validate executionMode if provided
    let resolvedMode: ExecutionMode | undefined;
    if (executionMode !== undefined && executionMode !== null) {
      if (!VALID_MODES.includes(executionMode as ExecutionMode)) {
        res.status(400).json({
          error: `executionMode must be one of: ${VALID_MODES.join(", ")}`,
        });
        return;
      }
      resolvedMode = executionMode as ExecutionMode;
    }

    // Run the execution planner to determine the optimal plan
    let executionPlan = null;
    try {
      const planner = getExecutionPlanner();
      executionPlan = await planner.createExecutionPlan({
        url: url,
        baseJobId: typeof baseJobId === "string" ? baseJobId : undefined,
        preferredMode: resolvedMode,
      });
      req.log.info(
        { url, mode: executionPlan.executionMode, stages: executionPlan.recommendedStages.length },
        "orchestrate: execution plan generated",
      );
    } catch (planErr) {
      req.log.warn({ url, err: planErr }, "orchestrate: planner failed — falling through to default pipeline");
    }

    const job = createJob({
      url:                url,
      baseJobId:          typeof baseJobId === "string" ? baseJobId : null,
      coverageThreshold:  threshold,
      executionMode:      executionPlan?.executionMode ?? resolvedMode,
      executionPlan:      executionPlan ? JSON.stringify(executionPlan) : undefined,
      recommendedStages:  executionPlan?.recommendedStages,
    });

    res.status(202).json({
      jobId:             job.id,
      url:               job.url,
      coverageThreshold: job.coverageThreshold,
      status:            job.status,
      startedAt:         job.startedAt,
      executionMode:     executionPlan?.executionMode ?? resolvedMode ?? "auto",
      executionPlan,
    });

    runPipeline(job).catch((err: unknown) => {
      req.log.error({ err, jobId: job.id }, "orchestrate: unhandled pipeline error");
    });
  } catch (err) {
    next(err);
  }
});

router.get("/orchestrate/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(job);
});

router.get("/orchestrate", (_req, res) => {
  res.json(listJobs());
});

export default router;
