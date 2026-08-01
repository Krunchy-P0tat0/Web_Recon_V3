/**
 * execution-planner.ts — Phase D4.3 Intelligent Differential Execution Planner API
 *
 * Exposes the execution planner through a REST endpoint so the dashboard and
 * external callers can query the minimum required work for a website before
 * triggering a pipeline run.
 *
 * POST /execution-planner/plan  — generate an execution plan for a website
 * GET  /execution-planner/plan  — (future) retrieve latest plan summary
 */

import { Router, type IRouter } from "express";
import { getExecutionPlanner } from "../lib/differential-execution-planner.js";
import type { ExecutionMode } from "../lib/differential-execution-planner-types.js";

const router: IRouter = Router();

/**
 * POST /execution-planner/plan
 *
 * Generates an execution plan for the given website URL.
 *
 * Request body:
 *   url            — required, the target website URL
 *   baseJobId      — optional, explicit baseline job ID for differential comparison
 *   preferredMode  — optional, preferred execution mode (auto-selected if omitted)
 *
 * Returns:
 *   200 with the full ExecutionPlan JSON
 *   400 if url is missing or invalid
 *   500 on unexpected errors
 */
router.post("/execution-planner/plan", async (req, res, next) => {
  try {
    const { url, baseJobId, preferredMode } = req.body as Record<string, unknown>;

    if (typeof url !== "string" || !url.startsWith("http")) {
      res.status(400).json({
        error: "url is required and must be a valid HTTP/S URL",
      });
      return;
    }

    // Validate preferredMode if provided
    const validModes: ExecutionMode[] = [
      "fresh",
      "differential",
      "resume",
      "upgrade",
      "regenerate-website-prime",
    ];

    if (preferredMode !== undefined && preferredMode !== null) {
      if (!validModes.includes(preferredMode as ExecutionMode)) {
        res.status(400).json({
          error: `preferredMode must be one of: ${validModes.join(", ")}`,
        });
        return;
      }
    }

    const planner = getExecutionPlanner();
    const plan = await planner.createExecutionPlan({
      url: url as string,
      baseJobId: typeof baseJobId === "string" ? baseJobId : undefined,
      preferredMode: validModes.includes(preferredMode as ExecutionMode)
        ? (preferredMode as ExecutionMode)
        : undefined,
    });

    res.json(plan);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /execution-planner/plan
 *
 * Placeholder for retrieving previously generated plans.
 * Returns an empty list for now; will support plan history in a future phase.
 */
router.get("/execution-planner/plan", (_req, res) => {
  res.json({ plans: [] });
});

export default router;
