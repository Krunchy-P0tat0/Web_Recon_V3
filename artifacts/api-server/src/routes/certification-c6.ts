/**
 * certification-c6.ts — Phase C6 Routes
 *
 * POST /certification/certify                                — run C6 for a jobId
 * GET  /certification                                        — list all certifications
 * GET  /certification/:jobId                                 — full C6 bundle
 * GET  /certification/:jobId/website-prime-certification     — website-prime-certification.json
 * GET  /certification/:jobId/website-prime-score             — website-prime-score.json
 * GET  /certification/:jobId/production-readiness-report     — production-readiness-report.json
 * GET  /certification/:jobId/preflight-checklist             — preflight check list only
 * GET  /certification/:jobId/deployment-checklist            — deployment steps only
 */

import { Router, type IRouter } from "express";
import {
  runCertification,
  getC6Bundle,
  listC6Bundles,
} from "../lib/certification-engine-c6.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /certification/certify
// ---------------------------------------------------------------------------
router.post("/certification/certify", async (req, res): Promise<void> => {
  const { jobId } = req.body ?? {};

  if (!jobId || typeof jobId !== "string") {
    res.status(400).json({ error: "jobId (string) is required in the request body" });
    return;
  }

  try {
    const bundle = await runCertification({ jobId });
    const cert   = bundle.certification;
    const pr     = bundle.productionReadiness;

    res.status(200).json({
      jobId:                bundle.jobId,
      generatedAt:          bundle.generatedAt,
      certificationId:      cert.certificationId,
      r2Keys:               bundle.r2Keys,
      certificationLevel:   cert.certificationLevel,
      enterpriseTier:       cert.enterpriseTier,
      overallScore:         cert.overallScore,
      overallGrade:         cert.overallGrade,
      overallRating:        cert.overallRating,
      grades: {
        performance:     { score: cert.grades.performance.score,     grade: cert.grades.performance.grade },
        seo:             { score: cert.grades.seo.score,             grade: cert.grades.seo.grade },
        accessibility:   { score: cert.grades.accessibility.score,   grade: cert.grades.accessibility.grade },
        maintainability: { score: cert.grades.maintainability.score, grade: cert.grades.maintainability.grade },
        scalability:     { score: cert.grades.scalability.score,     grade: cert.grades.scalability.grade },
        runtime:         { score: cert.grades.runtime.score,         grade: cert.grades.runtime.grade },
      },
      blockers:             pr.blockers.length,
      criticalIssues:       pr.criticalIssues.length,
      majorIssues:          pr.majorIssues.length,
      totalIssues:          pr.blockers.length + pr.criticalIssues.length + pr.majorIssues.length + pr.minorIssues.length,
      phasesCompleted:      cert.phasesCompleted,
      phasesIncomplete:     cert.phasesIncomplete,
      certificationStatement: cert.certificationStatement,
      auditorNote:          cert.auditorNote,
      estimatedRemediation: pr.estimatedRemediation,
      readyForProduction:   pr.readyForProduction,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("manifest not found")) {
      res.status(404).json({ error: msg });
      return;
    }
    req.log.error({ err, jobId }, "C6: certification failed");
    res.status(500).json({ error: "Website Prime certification failed", detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /certification
// ---------------------------------------------------------------------------
router.get("/certification", (_req, res): void => {
  res.status(200).json(listC6Bundles());
});

// ---------------------------------------------------------------------------
// GET /certification/:jobId — full bundle
// ---------------------------------------------------------------------------
router.get("/certification/:jobId", (req, res): void => {
  const bundle = getC6Bundle(req.params.jobId!);
  if (!bundle) { res.status(404).json({ error: `No C6 certification found for jobId "${req.params.jobId}"` }); return; }
  res.status(200).json(bundle);
});

// ---------------------------------------------------------------------------
// GET /certification/:jobId/website-prime-certification
// ---------------------------------------------------------------------------
router.get("/certification/:jobId/website-prime-certification", (req, res): void => {
  const bundle = getC6Bundle(req.params.jobId!);
  if (!bundle) { res.status(404).json({ error: `No C6 certification found for jobId "${req.params.jobId}"` }); return; }
  res.status(200).json(bundle.certification);
});

// ---------------------------------------------------------------------------
// GET /certification/:jobId/website-prime-score
// ---------------------------------------------------------------------------
router.get("/certification/:jobId/website-prime-score", (req, res): void => {
  const bundle = getC6Bundle(req.params.jobId!);
  if (!bundle) { res.status(404).json({ error: `No C6 certification found for jobId "${req.params.jobId}"` }); return; }
  res.status(200).json(bundle.score);
});

// ---------------------------------------------------------------------------
// GET /certification/:jobId/production-readiness-report
// ---------------------------------------------------------------------------
router.get("/certification/:jobId/production-readiness-report", (req, res): void => {
  const bundle = getC6Bundle(req.params.jobId!);
  if (!bundle) { res.status(404).json({ error: `No C6 certification found for jobId "${req.params.jobId}"` }); return; }
  res.status(200).json(bundle.productionReadiness);
});

// ---------------------------------------------------------------------------
// GET /certification/:jobId/preflight-checklist
// ---------------------------------------------------------------------------
router.get("/certification/:jobId/preflight-checklist", (req, res): void => {
  const bundle = getC6Bundle(req.params.jobId!);
  if (!bundle) { res.status(404).json({ error: `No C6 certification found for jobId "${req.params.jobId}"` }); return; }
  res.status(200).json({
    jobId: bundle.jobId,
    certificationLevel: bundle.certification.certificationLevel,
    items: bundle.productionReadiness.preflightChecklist,
    passCount:  bundle.productionReadiness.preflightChecklist.filter(i => i.status === "pass").length,
    failCount:  bundle.productionReadiness.preflightChecklist.filter(i => i.status === "fail").length,
    warnCount:  bundle.productionReadiness.preflightChecklist.filter(i => i.status === "warn").length,
    unknownCount: bundle.productionReadiness.preflightChecklist.filter(i => i.status === "unknown").length,
  });
});

// ---------------------------------------------------------------------------
// GET /certification/:jobId/deployment-checklist
// ---------------------------------------------------------------------------
router.get("/certification/:jobId/deployment-checklist", (req, res): void => {
  const bundle = getC6Bundle(req.params.jobId!);
  if (!bundle) { res.status(404).json({ error: `No C6 certification found for jobId "${req.params.jobId}"` }); return; }
  res.status(200).json({
    jobId: bundle.jobId,
    certificationLevel: bundle.certification.certificationLevel,
    steps: bundle.productionReadiness.deploymentChecklist,
    mustDoCount:      bundle.productionReadiness.deploymentChecklist.filter(i => i.priority === "must-do").length,
    shouldDoCount:    bundle.productionReadiness.deploymentChecklist.filter(i => i.priority === "should-do").length,
    niceToHaveCount:  bundle.productionReadiness.deploymentChecklist.filter(i => i.priority === "nice-to-have").length,
  });
});

export default router;
