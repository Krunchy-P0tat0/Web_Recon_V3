/**
 * disaster-recovery-e4.ts — Phase E4 Routes
 *
 * POST /disaster-recovery/run                            — run all 7 scenarios
 * POST /disaster-recovery/run/:scenarioId               — run single scenario
 * GET  /disaster-recovery                               — list all runs
 * GET  /disaster-recovery/:recoveryId                   — full E4 bundle
 * GET  /disaster-recovery/:recoveryId/report            — disaster-recovery-report.json
 * GET  /disaster-recovery/:recoveryId/validation        — recovery-validation.json
 * GET  /disaster-recovery/:recoveryId/resilience        — system-resilience-report.json
 * GET  /disaster-recovery/:recoveryId/score             — score + grade + RTO/RPO
 * GET  /disaster-recovery/:recoveryId/scenarios         — all scenario results
 * GET  /disaster-recovery/:recoveryId/scenarios/:id     — single scenario deep-dive
 * GET  /disaster-recovery/:recoveryId/failures          — failed scenarios only
 * GET  /disaster-recovery/:recoveryId/recommendations   — consolidated action list
 */

import { Router, type IRouter } from "express";
import { randomUUID }            from "crypto";
import {
  runDisasterRecovery,
  getE4Bundle,
  listE4Bundles,
  type ScenarioId,
} from "../lib/disaster-recovery-engine-e4.js";

const router: IRouter = Router();

const VALID_SCENARIOS: ScenarioId[] = ["SC-01","SC-02","SC-03","SC-04","SC-05","SC-06","SC-07"];

// ---------------------------------------------------------------------------
// POST /disaster-recovery/run
// ---------------------------------------------------------------------------
router.post("/disaster-recovery/run", async (req, res): Promise<void> => {
  const { recoveryId, scenarios, dryRun, force } = req.body ?? {};

  const id = typeof recoveryId === "string" && recoveryId.trim()
    ? recoveryId.trim()
    : `e4-${randomUUID()}`;

  const requestedScenarios: ScenarioId[] | undefined = Array.isArray(scenarios)
    ? scenarios.filter((s): s is ScenarioId => VALID_SCENARIOS.includes(s as ScenarioId))
    : undefined;

  try {
    const bundle = await runDisasterRecovery({
      recoveryId: id,
      scenarios:  requestedScenarios,
      dryRun:     dryRun !== false,
      force:      !!force,
    });

    const dr = bundle.disasterRecoveryReport;
    const rv = bundle.recoveryValidation;
    const sr = bundle.systemResilienceReport;

    res.status(200).json({
      recoveryId:            bundle.recoveryId,
      generatedAt:           bundle.generatedAt,
      durationMs:            bundle.durationMs,
      r2Keys:                bundle.r2Keys,
      overallScore:          bundle.overallScore,
      resilienceGrade:       bundle.resilienceGrade,
      totalScenarios:        dr.totalScenarios,
      passed:                dr.passed,
      partial:               dr.partial,
      failed:                dr.failed,
      worstScenario:         dr.worstScenario,
      avgRecoveryMs:         dr.avgRecoveryMs,
      avgDetectionMs:        dr.avgDetectionMs,
      autoRecoveryRate:      dr.autoRecoveryRate,
      checkpointResumeRate:  dr.checkpointResumeRate,
      dataLossRate:          dr.dataLossRate,
      validationPassed:      rv.validationPassed,
      criticalFailed:        rv.criticalFailed,
      rtoSeconds:            sr.rtoSeconds,
      actualRtoSeconds:      sr.actualRtoSeconds,
      rtoMet:                sr.rtoMet,
      rpoSeconds:            sr.rpoSeconds,
      actualRpoSeconds:      sr.actualRpoSeconds,
      rpoMet:                sr.rpoMet,
      productionReadiness:   sr.productionReadiness,
      strengthAreas:         sr.strengthAreas,
      vulnerableAreas:       sr.vulnerableAreas,
      scenarioSummary:       dr.scenarios.map(s => ({
        scenarioId:       s.scenarioId,
        name:             s.name,
        status:           s.status,
        resilienceScore:  s.resilienceScore,
        recoveryTimeMs:   s.recoveryTimeMs,
        autoRecovery:     s.autoRecovery,
        dataLoss:         s.dataLossOccurred,
        recoveryMethod:   s.recoveryMethod,
      })),
      summary:         dr.summary,
      recommendations: dr.recommendations,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "E4: disaster recovery run failed");
    res.status(500).json({ error: "Disaster recovery simulation failed", detail: msg });
  }
});

// ---------------------------------------------------------------------------
// POST /disaster-recovery/run/:scenarioId
// ---------------------------------------------------------------------------
router.post("/disaster-recovery/run/:scenarioId", async (req, res): Promise<void> => {
  const scenarioId = req.params.scenarioId as ScenarioId;
  if (!VALID_SCENARIOS.includes(scenarioId)) {
    res.status(400).json({ error: `Invalid scenario "${scenarioId}". Valid: ${VALID_SCENARIOS.join(", ")}` });
    return;
  }

  const { dryRun } = req.body ?? {};
  const id = `e4-${randomUUID()}`;

  try {
    const bundle = await runDisasterRecovery({
      recoveryId: id,
      scenarios:  [scenarioId],
      dryRun:     dryRun !== false,
    });

    const scenario = bundle.disasterRecoveryReport.scenarios[0];
    res.status(200).json({
      recoveryId:      bundle.recoveryId,
      generatedAt:     bundle.generatedAt,
      scenarioId:      scenario?.scenarioId,
      name:            scenario?.name,
      status:          scenario?.status,
      resilienceScore: scenario?.resilienceScore,
      recoveryMethod:  scenario?.recoveryMethod,
      detectionTimeMs: scenario?.detectionTimeMs,
      recoveryTimeMs:  scenario?.recoveryTimeMs,
      checkpointResumed: scenario?.checkpointResumed,
      rollbackTriggered: scenario?.rollbackTriggered,
      dataLossOccurred: scenario?.dataLossOccurred,
      autoRecovery:    scenario?.autoRecovery,
      steps:           scenario?.steps,
      issues:          scenario?.issues,
      recommendations: scenario?.recommendations,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err, scenarioId }, "E4: single scenario run failed");
    res.status(500).json({ error: `Scenario ${scenarioId} failed`, detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /disaster-recovery
// ---------------------------------------------------------------------------
router.get("/disaster-recovery", (_req, res): void => {
  res.status(200).json(listE4Bundles());
});

// ---------------------------------------------------------------------------
// GET /disaster-recovery/:recoveryId
// ---------------------------------------------------------------------------
router.get("/disaster-recovery/:recoveryId", (req, res): void => {
  const bundle = getE4Bundle(req.params.recoveryId!);
  if (!bundle) {
    res.status(404).json({ error: `No E4 run found for id "${req.params.recoveryId}"` });
    return;
  }
  res.status(200).json(bundle);
});

// ---------------------------------------------------------------------------
// GET /disaster-recovery/:recoveryId/report
// ---------------------------------------------------------------------------
router.get("/disaster-recovery/:recoveryId/report", (req, res): void => {
  const bundle = getE4Bundle(req.params.recoveryId!);
  if (!bundle) { res.status(404).json({ error: `No E4 run found for id "${req.params.recoveryId}"` }); return; }
  res.status(200).json(bundle.disasterRecoveryReport);
});

// ---------------------------------------------------------------------------
// GET /disaster-recovery/:recoveryId/validation
// ---------------------------------------------------------------------------
router.get("/disaster-recovery/:recoveryId/validation", (req, res): void => {
  const bundle = getE4Bundle(req.params.recoveryId!);
  if (!bundle) { res.status(404).json({ error: `No E4 run found for id "${req.params.recoveryId}"` }); return; }
  res.status(200).json(bundle.recoveryValidation);
});

// ---------------------------------------------------------------------------
// GET /disaster-recovery/:recoveryId/resilience
// ---------------------------------------------------------------------------
router.get("/disaster-recovery/:recoveryId/resilience", (req, res): void => {
  const bundle = getE4Bundle(req.params.recoveryId!);
  if (!bundle) { res.status(404).json({ error: `No E4 run found for id "${req.params.recoveryId}"` }); return; }
  res.status(200).json(bundle.systemResilienceReport);
});

// ---------------------------------------------------------------------------
// GET /disaster-recovery/:recoveryId/score
// ---------------------------------------------------------------------------
router.get("/disaster-recovery/:recoveryId/score", (req, res): void => {
  const bundle = getE4Bundle(req.params.recoveryId!);
  if (!bundle) { res.status(404).json({ error: `No E4 run found for id "${req.params.recoveryId}"` }); return; }
  const sr = bundle.systemResilienceReport;
  const dr = bundle.disasterRecoveryReport;
  res.status(200).json({
    recoveryId:          bundle.recoveryId,
    generatedAt:         bundle.generatedAt,
    overallScore:        bundle.overallScore,
    resilienceGrade:     bundle.resilienceGrade,
    rtoMet:              sr.rtoMet,
    rpoMet:              sr.rpoMet,
    actualRtoSeconds:    sr.actualRtoSeconds,
    actualRpoSeconds:    sr.actualRpoSeconds,
    productionReadiness: sr.productionReadiness,
    autoRecoveryRate:    dr.autoRecoveryRate,
    checkpointResumeRate: dr.checkpointResumeRate,
    dataLossRate:        dr.dataLossRate,
    validationPassed:    bundle.recoveryValidation.validationPassed,
  });
});

// ---------------------------------------------------------------------------
// GET /disaster-recovery/:recoveryId/scenarios
// ---------------------------------------------------------------------------
router.get("/disaster-recovery/:recoveryId/scenarios", (req, res): void => {
  const bundle = getE4Bundle(req.params.recoveryId!);
  if (!bundle) { res.status(404).json({ error: `No E4 run found for id "${req.params.recoveryId}"` }); return; }
  res.status(200).json({
    recoveryId:      bundle.recoveryId,
    overallScore:    bundle.overallScore,
    resilienceGrade: bundle.resilienceGrade,
    scenarios:       bundle.disasterRecoveryReport.scenarios,
  });
});

// ---------------------------------------------------------------------------
// GET /disaster-recovery/:recoveryId/scenarios/:scenarioId
// ---------------------------------------------------------------------------
router.get("/disaster-recovery/:recoveryId/scenarios/:scenarioId", (req, res): void => {
  const bundle = getE4Bundle(req.params.recoveryId!);
  if (!bundle) { res.status(404).json({ error: `No E4 run found for id "${req.params.recoveryId}"` }); return; }
  const scenario = bundle.disasterRecoveryReport.scenarios.find(s => s.scenarioId === req.params.scenarioId);
  if (!scenario) {
    const available = bundle.disasterRecoveryReport.scenarios.map(s => s.scenarioId).join(", ");
    res.status(404).json({ error: `Scenario "${req.params.scenarioId}" not found in this run. Available: ${available}` });
    return;
  }
  res.status(200).json(scenario);
});

// ---------------------------------------------------------------------------
// GET /disaster-recovery/:recoveryId/failures
// ---------------------------------------------------------------------------
router.get("/disaster-recovery/:recoveryId/failures", (req, res): void => {
  const bundle = getE4Bundle(req.params.recoveryId!);
  if (!bundle) { res.status(404).json({ error: `No E4 run found for id "${req.params.recoveryId}"` }); return; }
  const failures = bundle.disasterRecoveryReport.scenarios.filter(s => s.status === "FAIL" || s.status === "PARTIAL");
  res.status(200).json({
    recoveryId:    bundle.recoveryId,
    totalFailures: failures.length,
    scenarios:     failures,
  });
});

// ---------------------------------------------------------------------------
// GET /disaster-recovery/:recoveryId/recommendations
// ---------------------------------------------------------------------------
router.get("/disaster-recovery/:recoveryId/recommendations", (req, res): void => {
  const bundle = getE4Bundle(req.params.recoveryId!);
  if (!bundle) { res.status(404).json({ error: `No E4 run found for id "${req.params.recoveryId}"` }); return; }
  const dr = bundle.disasterRecoveryReport;
  const sr = bundle.systemResilienceReport;
  res.status(200).json({
    recoveryId:          bundle.recoveryId,
    resilienceGrade:     bundle.resilienceGrade,
    productionReadiness: sr.productionReadiness,
    architectureGaps:    sr.architectureGaps,
    vulnerableAreas:     sr.vulnerableAreas,
    recommendations:     dr.recommendations,
    perScenario:         dr.scenarios.map(s => ({
      scenarioId:      s.scenarioId,
      name:            s.name,
      status:          s.status,
      recommendations: s.recommendations,
    })),
  });
});

export default router;
