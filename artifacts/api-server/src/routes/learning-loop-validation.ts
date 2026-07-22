/**
 * routes/learning-loop-validation.ts  — P0-3
 *
 * GET  /api/learning-loop/:jobId/validate   — run (or dry-run) validation
 * GET  /api/learning-loop/:jobId/report     — return last learning-loop-report.json
 * GET  /api/learning-loop/:jobId/iterations — return last iteration-history.json
 * GET  /api/learning-loop/:jobId/improvement — return last improvement-summary.json
 */

import { Router } from "express";
import {
  runLearningLoopValidation,
  type ValidationOptions,
} from "../lib/learning-loop-validator.js";
import { readFile } from "fs/promises";
import { join }     from "path";

const router = Router();
const OUT_DIR = process.cwd();

// ── POST /api/learning-loop/:jobId/validate ────────────────────────────────
router.post("/learning-loop/:jobId/validate", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };
  const {
    generationEndpoint,
    targetScore    = 75,
    maxIterations  = 3,
    dryRun         = false,
  } = req.body as Partial<ValidationOptions & { dryRun: boolean }>;

  req.log.info({ jobId, dryRun, targetScore }, "POST /learning-loop/:jobId/validate");

  try {
    const opts: ValidationOptions = {
      sourceJobId: jobId,
      generationEndpoint,
      targetScore,
      maxIterations,
      dryRun,
    };

    const { report, iterationHistory, improvementSummary } =
      await runLearningLoopValidation(opts);

    res.json({
      ok: true,
      jobId,
      validationStatus:     report.validationStatus,
      initialScore:         report.initialScore,
      finalScore:           report.finalScore,
      totalDelta:           report.totalDelta,
      iterationsRun:        report.iterationsRun,
      failurePoint:         report.failurePoint,
      adjustmentsGenerated: report.adjustmentsGenerated,
      adjustmentCategories: report.adjustmentCategories,
      measurableImprovement: improvementSummary.measurableImprovement,
      improvementPercent:   improvementSummary.improvementPercent,
      r2Keys:               report.r2Keys,
      stages:               report.stages,
    });
  } catch (err) {
    req.log.error({ err, jobId }, "learning-loop validate: unexpected error");
    res.status(500).json({ ok: false, error: "Validation failed", detail: String(err) });
  }
});

// ── GET /api/learning-loop/:jobId/report ──────────────────────────────────
router.get("/learning-loop/:jobId/report", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };
  req.log.info({ jobId }, "GET /learning-loop/:jobId/report");
  try {
    const raw = await readFile(join(OUT_DIR, "learning-loop-report.json"), "utf8");
    res.type("application/json").send(raw);
  } catch {
    res.status(404).json({ ok: false, error: "learning-loop-report.json not yet generated for this job" });
  }
});

// ── GET /api/learning-loop/:jobId/iterations ──────────────────────────────
router.get("/learning-loop/:jobId/iterations", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };
  req.log.info({ jobId }, "GET /learning-loop/:jobId/iterations");
  try {
    const raw = await readFile(join(OUT_DIR, "iteration-history.json"), "utf8");
    res.type("application/json").send(raw);
  } catch {
    res.status(404).json({ ok: false, error: "iteration-history.json not yet generated" });
  }
});

// ── GET /api/learning-loop/:jobId/improvement ─────────────────────────────
router.get("/learning-loop/:jobId/improvement", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };
  req.log.info({ jobId }, "GET /learning-loop/:jobId/improvement");
  try {
    const raw = await readFile(join(OUT_DIR, "improvement-summary.json"), "utf8");
    res.type("application/json").send(raw);
  } catch {
    res.status(404).json({ ok: false, error: "improvement-summary.json not yet generated" });
  }
});

export default router;
