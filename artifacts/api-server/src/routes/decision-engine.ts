/**
 * decision-engine.ts — Phase 7.3 routes
 *
 * POST /api/decisions               — run decision engine (optionally for a jobId)
 * GET  /api/decisions               — get latest decision-engine-report.json
 * GET  /api/decisions/:id           — get one decision by id
 */

import { Router, type IRouter } from "express";
import { runDecisionEngine, loadReport } from "../lib/decision-engine.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /decisions — run the autonomous decision engine
// ---------------------------------------------------------------------------

router.post("/decisions", async (req, res): Promise<void> => {
  const { jobId, url } = (req.body ?? {}) as { jobId?: string; url?: string };

  req.log.info({ jobId, url }, "DECISION-ENGINE: run requested");

  try {
    const report = await runDecisionEngine(jobId ?? null, url ?? null);
    res.json({
      generated: true,
      report,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "DECISION-ENGINE: run failed");
    res.status(500).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /decisions — latest report
// ---------------------------------------------------------------------------

router.get("/decisions", async (_req, res): Promise<void> => {
  const report = await loadReport();
  if (!report) {
    res.status(404).json({
      error: "No decision-engine-report.json yet. POST /api/decisions to generate.",
    });
    return;
  }
  res.json(report);
});

// ---------------------------------------------------------------------------
// GET /decisions/:id — single decision
// ---------------------------------------------------------------------------

router.get("/decisions/:id", async (req, res): Promise<void> => {
  const report = await loadReport();
  if (!report) {
    res.status(404).json({ error: "No report available. POST /api/decisions first." });
    return;
  }

  const decision = report.decisions.find((d) => d.id === req.params["id"]);
  if (!decision) {
    res.status(404).json({
      error:      `Decision '${req.params["id"]}' not found`,
      available:  report.decisions.map((d) => d.id),
    });
    return;
  }

  res.json({ reportGeneratedAt: report.generatedAt, decision });
});

export default router;
