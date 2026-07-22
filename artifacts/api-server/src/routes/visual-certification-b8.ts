/**
 * visual-certification-b8.ts — Phase B8 Routes
 *
 * POST /visual-certification/run                    — run full B8 certification
 * GET  /visual-certification                        — list all certifications
 * GET  /visual-certification/:srcId/:genId          — full B8 bundle
 * GET  /visual-certification/:srcId/:genId/report   — visual-certification-report.json
 * GET  /visual-certification/:srcId/:genId/grade    — visual-grade.json
 * GET  /visual-certification/:srcId/:genId/readiness — visual-readiness-report.json
 */

import { Router, type IRouter } from "express";
import {
  runVisualCertification,
  getCertification,
  listCertifications,
  type CertificationInput,
} from "../lib/visual-certification-engine-b8.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /visual-certification/run
// ---------------------------------------------------------------------------

router.post("/visual-certification/run", async (req, res): Promise<void> => {
  const {
    sourceJobId,
    generatedJobId,
    fidelityReport,
    pixelReport,
    perceptualScore,
    componentReport,
    consistencyReport,
    typographyReport,
  } = req.body ?? {};

  if (!sourceJobId || typeof sourceJobId !== "string") {
    res.status(400).json({ error: "sourceJobId must be a non-empty string" });
    return;
  }
  if (!generatedJobId || typeof generatedJobId !== "string") {
    res.status(400).json({ error: "generatedJobId must be a non-empty string" });
    return;
  }

  // Validate optional sub-reports are plain objects when provided
  const optionalReports = { fidelityReport, pixelReport, perceptualScore, componentReport, consistencyReport, typographyReport };
  for (const [name, val] of Object.entries(optionalReports)) {
    if (val !== undefined && (typeof val !== "object" || val === null || Array.isArray(val))) {
      res.status(400).json({ error: `${name} must be a plain object when provided` });
      return;
    }
  }

  try {
    const input: CertificationInput = {
      sourceJobId,
      generatedJobId,
      fidelityReport,
      pixelReport,
      perceptualScore,
      componentReport,
      consistencyReport,
      typographyReport,
    };

    const { report, grade, readiness } = await runVisualCertification(input);

    res.status(200).json({
      ok:              true,
      sourceJobId,
      generatedJobId,
      overallScore:    report.overallScore,
      grade:           report.grade,
      productionReady: report.productionReady,
      readinessStatus: readiness.readinessStatus,
      blockingIssues:  readiness.blockingIssues.length,
      majorIssues:     readiness.majorIssues.length,
      minorIssues:     readiness.minorIssues.length,
      certificationId: grade.certificationId,
      durationMs:      report.durationMs,
      r2Keys:          report.r2Keys,
    });
  } catch (err) {
    req.log.error({ err, sourceJobId, generatedJobId }, "B8: certification run failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /visual-certification
// ---------------------------------------------------------------------------

router.get("/visual-certification", (_req, res): void => {
  res.json({ certifications: listCertifications() });
});

// ---------------------------------------------------------------------------
// GET /visual-certification/:srcId/:genId
// ---------------------------------------------------------------------------

router.get("/visual-certification/:srcId/:genId", (req, res): void => {
  const { srcId, genId } = req.params as { srcId: string; genId: string };
  const stored = getCertification(srcId, genId);
  if (!stored) {
    res.status(404).json({
      error: "No B8 certification found — run POST /visual-certification/run first",
    });
    return;
  }
  res.json({
    report:    stored.report,
    grade:     stored.grade,
    readiness: stored.readiness,
  });
});

// ---------------------------------------------------------------------------
// GET /visual-certification/:srcId/:genId/report
// ---------------------------------------------------------------------------

router.get("/visual-certification/:srcId/:genId/report", (req, res): void => {
  const { srcId, genId } = req.params as { srcId: string; genId: string };
  const stored = getCertification(srcId, genId);
  if (!stored) { res.status(404).json({ error: "No B8 certification report found" }); return; }
  res.json(stored.report);
});

// ---------------------------------------------------------------------------
// GET /visual-certification/:srcId/:genId/grade
// ---------------------------------------------------------------------------

router.get("/visual-certification/:srcId/:genId/grade", (req, res): void => {
  const { srcId, genId } = req.params as { srcId: string; genId: string };
  const stored = getCertification(srcId, genId);
  if (!stored) { res.status(404).json({ error: "No B8 grade found" }); return; }
  res.json(stored.grade);
});

// ---------------------------------------------------------------------------
// GET /visual-certification/:srcId/:genId/readiness
// ---------------------------------------------------------------------------

router.get("/visual-certification/:srcId/:genId/readiness", (req, res): void => {
  const { srcId, genId } = req.params as { srcId: string; genId: string };
  const stored = getCertification(srcId, genId);
  if (!stored) { res.status(404).json({ error: "No B8 readiness report found" }); return; }
  res.json(stored.readiness);
});

export default router;
