/**
 * visual-fidelity-vr7.ts — Phase VR-7: Visual Fidelity Scoring Engine Routes
 *
 * POST /api/fidelity-vr7/:sourceJobId/compare
 *   Body: { generatedJobId, force? }
 *   Runs VR-7 fidelity scoring. Loads VR-2/3/4/5/6 outputs for both jobs
 *   automatically from /tmp/vr* dirs and R2 cache.
 *   Returns: full FidelityReport (includes scoreFile and report).
 *
 * GET  /api/fidelity-vr7/:sourceJobId/:generatedJobId/report
 *   Full fidelity-report.json (global metrics, per-page detail, issues, grade).
 *
 * GET  /api/fidelity-vr7/:sourceJobId/:generatedJobId/score
 *   fidelity-score.json — per-page array:
 *   [{ pageId, layoutScore, colorScore, spacingScore, typographyScore,
 *      componentScore, totalScore }]
 *
 * GET  /api/fidelity-vr7/:sourceJobId/:generatedJobId/metrics
 *   Five headline scores + grade + totalScore (global only, no per-page detail).
 *
 * GET  /api/fidelity-vr7/:sourceJobId/:generatedJobId/pages
 *   Per-page breakdown with matched gen page IDs and region sequences.
 *
 * GET  /api/fidelity-vr7/:sourceJobId/:generatedJobId/issues
 *   All detected fidelity issues.
 *   Query params: ?dimension=layout|color|spacing|typography|component
 *                 ?severity=high|medium|low
 *
 * GET  /api/fidelity-vr7/:sourceJobId/:generatedJobId/grade
 *   Quick-check: grade + totalScore + weak/top dimensions only.
 */

import { Router, type IRouter }    from "express";
import {
  runFidelityScoringVR7,
  getCachedFidelityReport,
  type FidelityReport,
}                                  from "../lib/visual-fidelity-scoring-engine-vr7.js";

const router: IRouter = Router();

// ── Helper — require cached report ──────────────────────────────────────────

function requireCached(
  sourceJobId:    string,
  generatedJobId: string,
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): FidelityReport | null {
  const report = getCachedFidelityReport(sourceJobId, generatedJobId);
  if (!report) {
    res.status(404).json({
      error: "No VR-7 fidelity report found for this job pair.",
      hint:  `POST /api/fidelity-vr7/${sourceJobId}/compare with body { generatedJobId: "${generatedJobId}" }`,
    });
    return null;
  }
  return report;
}

// ── POST /api/fidelity-vr7/:sourceJobId/compare ───────────────────────────────

router.post("/fidelity-vr7/:sourceJobId/compare", async (req, res): Promise<void> => {
  const sourceJobId = (req.params as Record<string, string>)["sourceJobId"] ?? "";
  if (!sourceJobId) { res.status(400).json({ error: "sourceJobId path param is required" }); return; }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const generatedJobId = typeof body["generatedJobId"] === "string" ? body["generatedJobId"].trim() : "";
  const force          = body["force"] === true;

  if (!generatedJobId) {
    res.status(400).json({ error: "generatedJobId is required in the request body" });
    return;
  }

  req.log.info({ sourceJobId, generatedJobId, force }, "VR7: compare request");

  try {
    const report = await runFidelityScoringVR7({ sourceJobId, generatedJobId, force });
    res.status(200).json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err, sourceJobId, generatedJobId }, "VR7: compare failed");
    res.status(500).json({ error: "VR-7 fidelity scoring failed", detail: message });
  }
});

// ── GET /api/fidelity-vr7/:sourceJobId/:generatedJobId/report ─────────────────

router.get("/fidelity-vr7/:sourceJobId/:generatedJobId/report", (req, res): void => {
  const p             = req.params as Record<string, string>;
  const sourceJobId   = p["sourceJobId"]    ?? "";
  const generatedJobId = p["generatedJobId"] ?? "";
  const report        = requireCached(sourceJobId, generatedJobId, res);
  if (report) res.status(200).json(report);
});

// ── GET /api/fidelity-vr7/:sourceJobId/:generatedJobId/score ──────────────────

router.get("/fidelity-vr7/:sourceJobId/:generatedJobId/score", (req, res): void => {
  const p             = req.params as Record<string, string>;
  const sourceJobId   = p["sourceJobId"]    ?? "";
  const generatedJobId = p["generatedJobId"] ?? "";
  const report        = requireCached(sourceJobId, generatedJobId, res);
  if (!report) return;

  res.status(200).json(report.scoreFile);
});

// ── GET /api/fidelity-vr7/:sourceJobId/:generatedJobId/metrics ────────────────

router.get("/fidelity-vr7/:sourceJobId/:generatedJobId/metrics", (req, res): void => {
  const p             = req.params as Record<string, string>;
  const sourceJobId   = p["sourceJobId"]    ?? "";
  const generatedJobId = p["generatedJobId"] ?? "";
  const report        = requireCached(sourceJobId, generatedJobId, res);
  if (!report) return;

  res.status(200).json({
    sourceJobId,
    generatedJobId,
    generatedAt:   report.generatedAt,
    durationMs:    report.durationMs,
    global:        report.global,
    inputsUsed:    report.inputsUsed,
    pagesCompared: report.summary.pagesCompared,
  });
});

// ── GET /api/fidelity-vr7/:sourceJobId/:generatedJobId/pages ──────────────────

router.get("/fidelity-vr7/:sourceJobId/:generatedJobId/pages", (req, res): void => {
  const p             = req.params as Record<string, string>;
  const sourceJobId   = p["sourceJobId"]    ?? "";
  const generatedJobId = p["generatedJobId"] ?? "";
  const report        = requireCached(sourceJobId, generatedJobId, res);
  if (!report) return;

  res.status(200).json({
    sourceJobId,
    generatedJobId,
    pageCount:   report.pages.length,
    globalGrade: report.global.grade,
    pages:       report.pages.map(p => ({
      pageId:           p.pageId,
      url:              p.url,
      matchedGenPageId: p.matchedGenPageId,
      matchedGenUrl:    p.matchedGenUrl,
      layoutScore:      p.layoutScore,
      colorScore:       p.colorScore,
      spacingScore:     p.spacingScore,
      typographyScore:  p.typographyScore,
      componentScore:   p.componentScore,
      totalScore:       p.totalScore,
      issueCount:       p.issues.length,
      sourceRegions:    p.sourceRegions,
      genRegions:       p.genRegions,
    })),
  });
});

// ── GET /api/fidelity-vr7/:sourceJobId/:generatedJobId/issues ─────────────────

router.get("/fidelity-vr7/:sourceJobId/:generatedJobId/issues", (req, res): void => {
  const p             = req.params as Record<string, string>;
  const sourceJobId   = p["sourceJobId"]    ?? "";
  const generatedJobId = p["generatedJobId"] ?? "";
  const report        = requireCached(sourceJobId, generatedJobId, res);
  if (!report) return;

  const dimension = req.query["dimension"] as string | undefined;
  const severity  = req.query["severity"]  as string | undefined;

  let issues = report.issues;
  if (dimension) issues = issues.filter(i => i.dimension === dimension);
  if (severity)  issues = issues.filter(i => i.severity  === severity);

  res.status(200).json({
    sourceJobId,
    generatedJobId,
    totalIssues:    report.issues.length,
    filteredIssues: issues.length,
    filters:        { dimension: dimension ?? null, severity: severity ?? null },
    issueBySeverity: report.summary.issueBySeverity,
    issues,
  });
});

// ── GET /api/fidelity-vr7/:sourceJobId/:generatedJobId/grade ──────────────────

router.get("/fidelity-vr7/:sourceJobId/:generatedJobId/grade", (req, res): void => {
  const p             = req.params as Record<string, string>;
  const sourceJobId   = p["sourceJobId"]    ?? "";
  const generatedJobId = p["generatedJobId"] ?? "";
  const report        = requireCached(sourceJobId, generatedJobId, res);
  if (!report) return;

  res.status(200).json({
    sourceJobId,
    generatedJobId,
    grade:           report.global.grade,
    totalScore:      report.global.totalScore,
    topDimension:    report.summary.topDimension,
    weakDimension:   report.summary.weakDimension,
    pagesCompared:   report.summary.pagesCompared,
    pagesAbove75:    report.summary.pagesAbove75,
    pagesBelowPass:  report.summary.pagesBelowPass,
    issueBySeverity: report.summary.issueBySeverity,
    generatedAt:     report.generatedAt,
  });
});

export default router;
