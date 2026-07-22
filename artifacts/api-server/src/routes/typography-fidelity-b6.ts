/**
 * typography-fidelity-b6.ts — Phase B6 Routes
 *
 * POST /typography-fidelity/run              — run full B6 analysis
 * GET  /typography-fidelity                  — list all completed analyses
 * GET  /typography-fidelity/:srcId/:genId    — full B6 report bundle
 * GET  /typography-fidelity/:srcId/:genId/report        — typography-fidelity-report.json
 * GET  /typography-fidelity/:srcId/:genId/spacing-map   — spacing-map.json
 * GET  /typography-fidelity/:srcId/:genId/layout-rhythm — layout-rhythm.json
 * GET  /typography-fidelity/:srcId/:genId/rhythm-score  — design-rhythm-score.json
 */

import { Router, type IRouter } from "express";
import {
  runTypographyFidelity,
  getTypographyReport,
  listTypographyReports,
  type TypographyFidelityOptions,
} from "../lib/typography-fidelity-engine.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /typography-fidelity/run
// ---------------------------------------------------------------------------

router.post("/typography-fidelity/run", async (req, res): Promise<void> => {
  const { sourceJobId, generatedJobId, sourceData, generatedData } = req.body ?? {};

  if (!sourceJobId || !generatedJobId) {
    res.status(400).json({ error: "sourceJobId and generatedJobId are required" });
    return;
  }
  if (!sourceData || !generatedData) {
    res.status(400).json({ error: "sourceData and generatedData (VisualDnaOutput) are required" });
    return;
  }

  try {
    const opts: TypographyFidelityOptions = { sourceJobId, generatedJobId, sourceData, generatedData };
    const results = await runTypographyFidelity(opts);

    res.status(200).json({
      ok:             true,
      sourceJobId,
      generatedJobId,
      overallScore:   results.report.summary.overallScore,
      grade:          results.report.summary.grade,
      pagesAnalyzed:  results.report.summary.pagesAnalyzed,
      durationMs:     results.report.durationMs,
      rhythmScore:    results.rhythmScore.overallRhythmScore,
      rhythmGrade:    results.rhythmScore.grade,
      r2Keys:         results.report.r2Keys,
    });
  } catch (err) {
    req.log.error({ err, sourceJobId, generatedJobId }, "B6: run failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /typography-fidelity
// ---------------------------------------------------------------------------

router.get("/typography-fidelity", (_req, res): void => {
  res.json({ analyses: listTypographyReports() });
});

// ---------------------------------------------------------------------------
// GET /typography-fidelity/:srcId/:genId
// ---------------------------------------------------------------------------

router.get("/typography-fidelity/:srcId/:genId", (req, res): void => {
  const { srcId, genId } = req.params as { srcId: string; genId: string };
  const stored = getTypographyReport(srcId, genId);
  if (!stored) {
    res.status(404).json({ error: "No B6 analysis found for this job pair — run POST /typography-fidelity/run first" });
    return;
  }
  res.json({
    report:       stored.report,
    spacingMap:   stored.spacingMap,
    layoutRhythm: stored.layoutRhythm,
    rhythmScore:  stored.rhythmScore,
  });
});

// ---------------------------------------------------------------------------
// GET /typography-fidelity/:srcId/:genId/report
// ---------------------------------------------------------------------------

router.get("/typography-fidelity/:srcId/:genId/report", (req, res): void => {
  const { srcId, genId } = req.params as { srcId: string; genId: string };
  const stored = getTypographyReport(srcId, genId);
  if (!stored) {
    res.status(404).json({ error: "No B6 report found" });
    return;
  }
  res.json(stored.report);
});

// ---------------------------------------------------------------------------
// GET /typography-fidelity/:srcId/:genId/spacing-map
// ---------------------------------------------------------------------------

router.get("/typography-fidelity/:srcId/:genId/spacing-map", (req, res): void => {
  const { srcId, genId } = req.params as { srcId: string; genId: string };
  const stored = getTypographyReport(srcId, genId);
  if (!stored) {
    res.status(404).json({ error: "No B6 spacing map found" });
    return;
  }
  res.json(stored.spacingMap);
});

// ---------------------------------------------------------------------------
// GET /typography-fidelity/:srcId/:genId/layout-rhythm
// ---------------------------------------------------------------------------

router.get("/typography-fidelity/:srcId/:genId/layout-rhythm", (req, res): void => {
  const { srcId, genId } = req.params as { srcId: string; genId: string };
  const stored = getTypographyReport(srcId, genId);
  if (!stored) {
    res.status(404).json({ error: "No B6 layout rhythm found" });
    return;
  }
  res.json(stored.layoutRhythm);
});

// ---------------------------------------------------------------------------
// GET /typography-fidelity/:srcId/:genId/rhythm-score
// ---------------------------------------------------------------------------

router.get("/typography-fidelity/:srcId/:genId/rhythm-score", (req, res): void => {
  const { srcId, genId } = req.params as { srcId: string; genId: string };
  const stored = getTypographyReport(srcId, genId);
  if (!stored) {
    res.status(404).json({ error: "No B6 rhythm score found" });
    return;
  }
  res.json(stored.rhythmScore);
});

export default router;
