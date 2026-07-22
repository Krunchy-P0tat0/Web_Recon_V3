/**
 * merge-certification-d5.ts — Phase D5 Routes
 *
 * POST /merge-certification/run                           — run merge certification
 * GET  /merge-certification                              — list all certification runs
 * GET  /merge-certification/:certificationId             — full D5 bundle
 * GET  /merge-certification/:certificationId/certification    — merge-certification.json
 * GET  /merge-certification/:certificationId/readiness-score  — merge-readiness-score.json
 * GET  /merge-certification/:certificationId/production-report — production-merge-report.json
 * GET  /merge-certification/:certificationId/score        — quick score summary
 * GET  /merge-certification/:certificationId/checklist    — production checklist
 * GET  /merge-certification/:certificationId/dimensions   — per-dimension breakdown
 * GET  /merge-certification/:certificationId/blockers     — blockers only
 */

import { Router, type IRouter } from "express";
import { randomUUID }            from "crypto";
import {
  runMergeCertification,
  getD5Bundle,
  listD5Bundles,
} from "../lib/merge-certification-engine-d5.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /merge-certification/run
// ---------------------------------------------------------------------------
router.post("/merge-certification/run", async (req, res): Promise<void> => {
  const {
    certificationId,
    d3ExecutionId,
    d4ValidationId,
    primeJobId,
    backendUrl,
    force,
  } = req.body ?? {};

  const id = typeof certificationId === "string" && certificationId.trim()
    ? certificationId.trim()
    : `d5-${randomUUID()}`;

  try {
    const bundle = await runMergeCertification({
      certificationId: id,
      d3ExecutionId:   typeof d3ExecutionId  === "string" ? d3ExecutionId  : undefined,
      d4ValidationId:  typeof d4ValidationId === "string" ? d4ValidationId : undefined,
      primeJobId:      typeof primeJobId     === "string" ? primeJobId     : undefined,
      backendUrl:      typeof backendUrl     === "string" ? backendUrl     : undefined,
      force:           !!force,
    });

    const c = bundle.mergeCertification;
    const s = bundle.mergeReadinessScore;

    res.status(200).json({
      certificationId:      bundle.certificationId,
      generatedAt:          bundle.generatedAt,
      durationMs:           bundle.durationMs,
      r2Keys:               bundle.r2Keys,
      mergeScore:           bundle.mergeScore,
      mergeGrade:           bundle.mergeGrade,
      riskLevel:            bundle.riskLevel,
      readinessTag:         c.readinessTag,
      certificationPassed:  c.certificationPassed,
      totalBlockers:        c.totalBlockers,
      totalWarnings:        c.totalWarnings,
      certificationSummary: c.certificationSummary,
      dimensionSummary:     c.dimensions.map(d => ({
        dimension: d.dimension,
        phase:     d.phase,
        status:    d.status,
        score:     d.score,
        blockers:  d.blockers.length,
        warnings:  d.warnings.length,
      })),
      apiCompatibilityScore:  s.apiCompatibilityScore,
      codeConflictScore:      s.codeConflictScore,
      runtimeStabilityScore:  s.runtimeStabilityScore,
      nextSteps:              c.nextSteps,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "D5: merge certification failed");
    res.status(500).json({ error: "Merge certification failed", detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /merge-certification
// ---------------------------------------------------------------------------
router.get("/merge-certification", (_req, res): void => {
  res.status(200).json(listD5Bundles());
});

// ---------------------------------------------------------------------------
// GET /merge-certification/:certificationId — full D5 bundle
// ---------------------------------------------------------------------------
router.get("/merge-certification/:certificationId", (req, res): void => {
  const bundle = getD5Bundle(req.params.certificationId!);
  if (!bundle) {
    res.status(404).json({ error: `No D5 certification found for id "${req.params.certificationId}"` });
    return;
  }
  res.status(200).json(bundle);
});

// ---------------------------------------------------------------------------
// GET /merge-certification/:certificationId/certification — merge-certification.json
// ---------------------------------------------------------------------------
router.get("/merge-certification/:certificationId/certification", (req, res): void => {
  const bundle = getD5Bundle(req.params.certificationId!);
  if (!bundle) {
    res.status(404).json({ error: `No D5 certification found for id "${req.params.certificationId}"` });
    return;
  }
  res.status(200).json(bundle.mergeCertification);
});

// ---------------------------------------------------------------------------
// GET /merge-certification/:certificationId/readiness-score — merge-readiness-score.json
// ---------------------------------------------------------------------------
router.get("/merge-certification/:certificationId/readiness-score", (req, res): void => {
  const bundle = getD5Bundle(req.params.certificationId!);
  if (!bundle) {
    res.status(404).json({ error: `No D5 certification found for id "${req.params.certificationId}"` });
    return;
  }
  res.status(200).json(bundle.mergeReadinessScore);
});

// ---------------------------------------------------------------------------
// GET /merge-certification/:certificationId/production-report — production-merge-report.json
// ---------------------------------------------------------------------------
router.get("/merge-certification/:certificationId/production-report", (req, res): void => {
  const bundle = getD5Bundle(req.params.certificationId!);
  if (!bundle) {
    res.status(404).json({ error: `No D5 certification found for id "${req.params.certificationId}"` });
    return;
  }
  res.status(200).json(bundle.productionMergeReport);
});

// ---------------------------------------------------------------------------
// GET /merge-certification/:certificationId/score — quick score card
// ---------------------------------------------------------------------------
router.get("/merge-certification/:certificationId/score", (req, res): void => {
  const bundle = getD5Bundle(req.params.certificationId!);
  if (!bundle) {
    res.status(404).json({ error: `No D5 certification found for id "${req.params.certificationId}"` });
    return;
  }
  const s = bundle.mergeReadinessScore;
  const c = bundle.mergeCertification;
  res.status(200).json({
    certificationId:       bundle.certificationId,
    generatedAt:           bundle.generatedAt,
    mergeScore:            bundle.mergeScore,
    mergeGrade:            bundle.mergeGrade,
    riskLevel:             bundle.riskLevel,
    readinessTag:          c.readinessTag,
    certificationPassed:   c.certificationPassed,
    apiCompatibilityScore: s.apiCompatibilityScore,
    codeConflictScore:     s.codeConflictScore,
    runtimeStabilityScore: s.runtimeStabilityScore,
    authScore:             s.authScore,
    dbScore:               s.dbScore,
    storageScore:          s.storageScore,
    routingScore:          s.routingScore,
    rollbackScore:         s.rollbackScore,
    assetScore:            s.assetScore,
  });
});

// ---------------------------------------------------------------------------
// GET /merge-certification/:certificationId/checklist
// ---------------------------------------------------------------------------
router.get("/merge-certification/:certificationId/checklist", (req, res): void => {
  const bundle = getD5Bundle(req.params.certificationId!);
  if (!bundle) {
    res.status(404).json({ error: `No D5 certification found for id "${req.params.certificationId}"` });
    return;
  }
  const checklist = bundle.productionMergeReport.productionChecklist;
  const passed  = checklist.filter(c => c.status === "PASS").length;
  const failed  = checklist.filter(c => c.status === "FAIL").length;
  const warned  = checklist.filter(c => c.status === "WARN").length;
  const pending = checklist.filter(c => c.status === "PENDING").length;
  res.status(200).json({
    certificationId: bundle.certificationId,
    total:   checklist.length,
    passed, failed, warned, pending,
    checklist,
  });
});

// ---------------------------------------------------------------------------
// GET /merge-certification/:certificationId/dimensions
// ---------------------------------------------------------------------------
router.get("/merge-certification/:certificationId/dimensions", (req, res): void => {
  const bundle = getD5Bundle(req.params.certificationId!);
  if (!bundle) {
    res.status(404).json({ error: `No D5 certification found for id "${req.params.certificationId}"` });
    return;
  }
  res.status(200).json({
    certificationId: bundle.certificationId,
    mergeScore:      bundle.mergeScore,
    dimensions:      bundle.mergeCertification.dimensions,
  });
});

// ---------------------------------------------------------------------------
// GET /merge-certification/:certificationId/blockers
// ---------------------------------------------------------------------------
router.get("/merge-certification/:certificationId/blockers", (req, res): void => {
  const bundle = getD5Bundle(req.params.certificationId!);
  if (!bundle) {
    res.status(404).json({ error: `No D5 certification found for id "${req.params.certificationId}"` });
    return;
  }
  const c = bundle.mergeCertification;
  res.status(200).json({
    certificationId:     bundle.certificationId,
    certificationPassed: c.certificationPassed,
    totalBlockers:       c.totalBlockers,
    totalWarnings:       c.totalWarnings,
    blockers:            c.blockerDetail,
    warnings:            c.warningDetail,
    nextSteps:           c.nextSteps,
  });
});

export default router;
