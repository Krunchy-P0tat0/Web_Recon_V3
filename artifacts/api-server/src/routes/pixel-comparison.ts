/**
 * routes/pixel-comparison.ts  — PF-1
 *
 * POST /api/pixel-compare/:sourceJobId/:generatedJobId  — run comparison
 * GET  /api/pixel-compare/:sourceJobId/:generatedJobId/report
 * GET  /api/pixel-compare/:sourceJobId/:generatedJobId/score
 * GET  /api/pixel-compare/:sourceJobId/:generatedJobId/heatmap  (PNG)
 */

import { Router }   from "express";
import { readFile } from "fs/promises";
import { join }     from "path";
import {
  runPixelComparison,
  type ComparisonOptions,
} from "../lib/pixel-comparison-engine.js";

const router  = Router();
const OUT_DIR = process.cwd();

// ── POST /api/pixel-compare/:sourceJobId/:generatedJobId ──────────────────
router.post(
  "/pixel-compare/:sourceJobId/:generatedJobId",
  async (req, res): Promise<void> => {
    const { sourceJobId, generatedJobId } =
      req.params as { sourceJobId: string; generatedJobId: string };
    const { sourceKey, generatedKey, threshold = 0.1 } =
      req.body as Partial<ComparisonOptions>;

    req.log.info({ sourceJobId, generatedJobId }, "POST /pixel-compare");

    try {
      const { report, perceptualScore, heatmapPng } = await runPixelComparison({
        sourceJobId,
        generatedJobId,
        sourceKey,
        generatedKey,
        threshold,
      });

      res.json({
        ok: true,
        sourceJobId,
        generatedJobId,
        overallSsim:      report.overallSsim,
        overallGrade:     report.overallGrade,
        totalMismatchPct: report.totalMismatchPct,
        scores:           perceptualScore.scores,
        grades:           perceptualScore.grades,
        interpretation:   perceptualScore.interpretation,
        heatmapAvailable: heatmapPng !== null,
        r2Keys:           report.r2Keys,
        notes:            report.notes,
      });
    } catch (err) {
      req.log.error({ err, sourceJobId, generatedJobId }, "pixel-compare: unexpected error");
      res.status(500).json({ ok: false, error: "Pixel comparison failed", detail: String(err) });
    }
  },
);

// ── GET /api/pixel-compare/:sourceJobId/:generatedJobId/report ────────────
router.get(
  "/pixel-compare/:sourceJobId/:generatedJobId/report",
  async (req, res): Promise<void> => {
    req.log.info(req.params, "GET /pixel-compare/.../report");
    try {
      const raw = await readFile(join(OUT_DIR, "pixel-comparison-report.json"), "utf8");
      res.type("application/json").send(raw);
    } catch {
      res.status(404).json({ ok: false, error: "pixel-comparison-report.json not yet generated" });
    }
  },
);

// ── GET /api/pixel-compare/:sourceJobId/:generatedJobId/score ─────────────
router.get(
  "/pixel-compare/:sourceJobId/:generatedJobId/score",
  async (req, res): Promise<void> => {
    req.log.info(req.params, "GET /pixel-compare/.../score");
    try {
      const raw = await readFile(join(OUT_DIR, "perceptual-score.json"), "utf8");
      res.type("application/json").send(raw);
    } catch {
      res.status(404).json({ ok: false, error: "perceptual-score.json not yet generated" });
    }
  },
);

// ── GET /api/pixel-compare/:sourceJobId/:generatedJobId/heatmap ───────────
router.get(
  "/pixel-compare/:sourceJobId/:generatedJobId/heatmap",
  async (req, res): Promise<void> => {
    req.log.info(req.params, "GET /pixel-compare/.../heatmap");
    try {
      const buf = await readFile(join(OUT_DIR, "heatmap-overlay.png"));
      res.type("image/png").send(buf);
    } catch {
      res.status(404).json({ ok: false, error: "heatmap-overlay.png not yet generated" });
    }
  },
);

export default router;
