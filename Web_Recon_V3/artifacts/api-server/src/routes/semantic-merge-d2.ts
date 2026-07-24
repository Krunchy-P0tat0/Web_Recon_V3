/**
 * semantic-merge-d2.ts — Phase D2 Routes
 *
 * POST /semantic-merge/analyze                          — run D2 on two source paths
 * GET  /semantic-merge                                  — list all analyses
 * GET  /semantic-merge/:detectionId                     — full D2 bundle
 * GET  /semantic-merge/:detectionId/merge-plan          — semantic-merge-plan.json
 * GET  /semantic-merge/:detectionId/conflict-map        — conflict-map.json
 * GET  /semantic-merge/:detectionId/risk-report         — merge-risk-report.json
 * GET  /semantic-merge/:detectionId/conflicts/blocked   — BLOCKED conflicts only
 * GET  /semantic-merge/:detectionId/conflicts/review    — REVIEW conflicts only
 * GET  /semantic-merge/:detectionId/checklist           — merge readiness checklist
 */

import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import {
  runSemanticMergePlanner,
  getD2Bundle,
  listD2Bundles,
} from "../lib/semantic-merge-planner-d2.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /semantic-merge/analyze
// ---------------------------------------------------------------------------
router.post("/semantic-merge/analyze", async (req, res): Promise<void> => {
  const { primePath, existingPath, detectionId } = req.body ?? {};

  if (!primePath || typeof primePath !== "string") {
    res.status(400).json({ error: "primePath (string) is required — absolute path to the Website Prime directory" });
    return;
  }
  if (!existingPath || typeof existingPath !== "string") {
    res.status(400).json({ error: "existingPath (string) is required — absolute path to the existing backend directory" });
    return;
  }

  const id = (typeof detectionId === "string" && detectionId.trim())
    ? detectionId.trim()
    : randomUUID();

  try {
    const bundle = await runSemanticMergePlanner({ detectionId: id, primePath, existingPath });
    const p = bundle.semanticMergePlan;
    const r = bundle.mergeRiskReport;

    res.status(200).json({
      detectionId:               bundle.detectionId,
      generatedAt:               bundle.generatedAt,
      r2Keys:                    bundle.r2Keys,
      overallClassification:     p.overallClassification,
      mergeRiskScore:            p.mergeRiskScore,
      mergeRiskLabel:            p.mergeRiskLabel,
      isMergeSafe:               p.isMergeSafe,
      totalConflicts:            p.totalConflicts,
      blocked:                   p.blocked,
      review:                    p.review,
      safe:                      p.safe,
      estimatedResolutionHours:  p.estimatedResolutionHours,
      mergeStepsCount:           p.mergeSteps.length,
      checklistPassCount:        r.mergeReadinessChecklist.filter(c => c.status === "pass").length,
      checklistFailCount:        r.mergeReadinessChecklist.filter(c => c.status === "fail").length,
      topRecommendations:        r.topRecommendations,
      executiveSummary:          p.executiveSummary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("does not exist") || msg.includes("not a directory")) {
      res.status(400).json({ error: msg });
      return;
    }
    req.log.error({ err }, "D2: semantic merge analysis failed");
    res.status(500).json({ error: "Semantic merge analysis failed", detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /semantic-merge
// ---------------------------------------------------------------------------
router.get("/semantic-merge", (_req, res): void => {
  res.status(200).json(listD2Bundles());
});

// ---------------------------------------------------------------------------
// GET /semantic-merge/:detectionId — full bundle
// ---------------------------------------------------------------------------
router.get("/semantic-merge/:detectionId", (req, res): void => {
  const bundle = getD2Bundle(req.params.detectionId!);
  if (!bundle) { res.status(404).json({ error: `No D2 analysis found for id "${req.params.detectionId}"` }); return; }
  res.status(200).json(bundle);
});

// ---------------------------------------------------------------------------
// GET /semantic-merge/:detectionId/merge-plan
// ---------------------------------------------------------------------------
router.get("/semantic-merge/:detectionId/merge-plan", (req, res): void => {
  const bundle = getD2Bundle(req.params.detectionId!);
  if (!bundle) { res.status(404).json({ error: `No D2 analysis found for id "${req.params.detectionId}"` }); return; }
  res.status(200).json(bundle.semanticMergePlan);
});

// ---------------------------------------------------------------------------
// GET /semantic-merge/:detectionId/conflict-map
// ---------------------------------------------------------------------------
router.get("/semantic-merge/:detectionId/conflict-map", (req, res): void => {
  const bundle = getD2Bundle(req.params.detectionId!);
  if (!bundle) { res.status(404).json({ error: `No D2 analysis found for id "${req.params.detectionId}"` }); return; }
  res.status(200).json(bundle.conflictMap);
});

// ---------------------------------------------------------------------------
// GET /semantic-merge/:detectionId/risk-report
// ---------------------------------------------------------------------------
router.get("/semantic-merge/:detectionId/risk-report", (req, res): void => {
  const bundle = getD2Bundle(req.params.detectionId!);
  if (!bundle) { res.status(404).json({ error: `No D2 analysis found for id "${req.params.detectionId}"` }); return; }
  res.status(200).json(bundle.mergeRiskReport);
});

// ---------------------------------------------------------------------------
// GET /semantic-merge/:detectionId/conflicts/blocked
// ---------------------------------------------------------------------------
router.get("/semantic-merge/:detectionId/conflicts/blocked", (req, res): void => {
  const bundle = getD2Bundle(req.params.detectionId!);
  if (!bundle) { res.status(404).json({ error: `No D2 analysis found for id "${req.params.detectionId}"` }); return; }
  const { blocked } = bundle.conflictMap;
  res.status(200).json({ detectionId: bundle.detectionId, count: blocked.length, conflicts: blocked });
});

// ---------------------------------------------------------------------------
// GET /semantic-merge/:detectionId/conflicts/review
// ---------------------------------------------------------------------------
router.get("/semantic-merge/:detectionId/conflicts/review", (req, res): void => {
  const bundle = getD2Bundle(req.params.detectionId!);
  if (!bundle) { res.status(404).json({ error: `No D2 analysis found for id "${req.params.detectionId}"` }); return; }
  const { review } = bundle.conflictMap;
  res.status(200).json({ detectionId: bundle.detectionId, count: review.length, conflicts: review });
});

// ---------------------------------------------------------------------------
// GET /semantic-merge/:detectionId/checklist
// ---------------------------------------------------------------------------
router.get("/semantic-merge/:detectionId/checklist", (req, res): void => {
  const bundle = getD2Bundle(req.params.detectionId!);
  if (!bundle) { res.status(404).json({ error: `No D2 analysis found for id "${req.params.detectionId}"` }); return; }
  const { mergeReadinessChecklist, mergeRiskScore, mergeRiskLabel, isMergeSafe } = bundle.mergeRiskReport;
  const pass = mergeReadinessChecklist.filter(c => c.status === "pass").length;
  const warn = mergeReadinessChecklist.filter(c => c.status === "warn").length;
  const fail = mergeReadinessChecklist.filter(c => c.status === "fail").length;
  res.status(200).json({
    detectionId: bundle.detectionId,
    mergeRiskScore, mergeRiskLabel, isMergeSafe,
    summary: { pass, warn, fail, total: mergeReadinessChecklist.length },
    checklist: mergeReadinessChecklist,
  });
});

export default router;
