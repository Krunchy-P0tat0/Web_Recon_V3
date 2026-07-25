/**
 * production-certification-e5.ts — Phase E5 Routes
 *
 * POST /certification/run                               — full 14-subsystem audit
 * GET  /certification                                   — list all certification runs
 * GET  /certification/:certId                           — full E5 bundle
 * GET  /certification/:certId/report                   — production-certification.json
 * GET  /certification/:certId/health                   — system-health-report.json
 * GET  /certification/:certId/enterprise               — enterprise-readiness-report.json
 * GET  /certification/:certId/score                    — score + grade + readiness declaration
 * GET  /certification/:certId/subsystems               — all 14 subsystem grades
 * GET  /certification/:certId/subsystems/:id           — single subsystem deep-dive
 * GET  /certification/:certId/issues                   — all issues (filterable ?level=)
 * GET  /certification/:certId/issues/critical          — critical issues only
 * GET  /certification/:certId/issues/medium            — medium issues only
 * GET  /certification/:certId/issues/low               — low issues only
 * GET  /certification/:certId/pillars                  — enterprise readiness pillars
 * GET  /certification/:certId/recommendations          — remediation action list
 */

import { Router, type IRouter } from "express";
import {
  runProductionCertification,
  getE5Bundle,
  listE5Bundles,
  type SubsystemId,
  type IssueLevel,
} from "../lib/production-certification-engine-e5.js";

const router: IRouter = Router();

const SUBSYSTEM_IDS: SubsystemId[] = [
  "discovery", "coverage", "scheduling", "scraping",
  "visual-reconstruction", "website-prime", "backend-merge",
  "deployment", "monitoring", "recovery", "self-healing",
  "security", "scalability", "performance",
];

const ISSUE_LEVELS: IssueLevel[] = ["CRITICAL", "MEDIUM", "LOW"];

// ---------------------------------------------------------------------------
// POST /certification/run
// ---------------------------------------------------------------------------
router.post("/production-certification/run", async (req, res): Promise<void> => {
  const { certId, dryRun } = req.body ?? {};

  const id = typeof certId === "string" && certId.trim() ? certId.trim() : undefined;

  try {
    const bundle = await runProductionCertification({ certId: id, dryRun: dryRun !== false });

    const cert = bundle.productionCertification;
    const health = bundle.systemHealthReport;
    const enterprise = bundle.enterpriseReadinessReport;

    res.status(200).json({
      certId:                bundle.certId,
      generatedAt:           bundle.generatedAt,
      durationMs:            bundle.durationMs,
      r2Keys:                bundle.r2Keys,
      overallScore:          bundle.overallScore,
      overallGrade:          bundle.overallGrade,
      readinessLevel:        bundle.readinessLevel,
      totalSubsystems:       cert.subsystems.length,
      certifiedSubsystems:   cert.certifiedSubsystems,
      conditionalSubsystems: cert.conditionalSubsystems,
      failedSubsystems:      cert.failedSubsystems,
      totalIssues:           cert.totalIssues,
      criticalIssues:        cert.criticalIssues.length,
      mediumIssues:          cert.mediumIssues.length,
      lowIssues:             cert.lowIssues.length,
      signature:             cert.signature,
      signedBy:              cert.signedBy,
      overallHealth:         health.overallHealth,
      healthScore:           health.healthScore,
      allSlaMet:             health.allSlaMet,
      enterpriseCertified:   enterprise.enterpriseCertified,
      criticalBlockers:      enterprise.criticalBlockers,
      pillarsReady:          enterprise.pillars.filter(p => p.status === "READY").length,
      totalPillars:          enterprise.pillars.length,
      certificationExpiry:   enterprise.certificationExpiry,
      subsystemGrades:       cert.subsystems.map(s => ({
        id:     s.id,
        name:   s.name,
        score:  s.score,
        grade:  s.grade,
        status: s.status,
        issues: s.issues.length,
      })),
      summary: cert.summary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "E5: production certification run failed");
    res.status(500).json({ error: "Production certification failed", detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /certification
// ---------------------------------------------------------------------------
router.get("/production-certification", (_req, res): void => {
  res.status(200).json(listE5Bundles());
});

// ---------------------------------------------------------------------------
// GET /certification/:certId
// ---------------------------------------------------------------------------
router.get("/production-certification/:certId", (req, res): void => {
  const bundle = getE5Bundle(req.params.certId!);
  if (!bundle) {
    res.status(404).json({ error: `No certification found for id "${req.params.certId}"` });
    return;
  }
  res.status(200).json(bundle);
});

// ---------------------------------------------------------------------------
// GET /certification/:certId/report
// ---------------------------------------------------------------------------
router.get("/production-certification/:certId/report", (req, res): void => {
  const bundle = getE5Bundle(req.params.certId!);
  if (!bundle) { res.status(404).json({ error: `Not found: ${req.params.certId}` }); return; }
  res.status(200).json(bundle.productionCertification);
});

// ---------------------------------------------------------------------------
// GET /certification/:certId/health
// ---------------------------------------------------------------------------
router.get("/production-certification/:certId/health", (req, res): void => {
  const bundle = getE5Bundle(req.params.certId!);
  if (!bundle) { res.status(404).json({ error: `Not found: ${req.params.certId}` }); return; }
  res.status(200).json(bundle.systemHealthReport);
});

// ---------------------------------------------------------------------------
// GET /certification/:certId/enterprise
// ---------------------------------------------------------------------------
router.get("/production-certification/:certId/enterprise", (req, res): void => {
  const bundle = getE5Bundle(req.params.certId!);
  if (!bundle) { res.status(404).json({ error: `Not found: ${req.params.certId}` }); return; }
  res.status(200).json(bundle.enterpriseReadinessReport);
});

// ---------------------------------------------------------------------------
// GET /certification/:certId/score
// ---------------------------------------------------------------------------
router.get("/production-certification/:certId/score", (req, res): void => {
  const bundle = getE5Bundle(req.params.certId!);
  if (!bundle) { res.status(404).json({ error: `Not found: ${req.params.certId}` }); return; }
  const cert = bundle.productionCertification;
  const er   = bundle.enterpriseReadinessReport;
  res.status(200).json({
    certId:              bundle.certId,
    generatedAt:         bundle.generatedAt,
    overallScore:        bundle.overallScore,
    overallGrade:        bundle.overallGrade,
    readinessLevel:      bundle.readinessLevel,
    criticalIssues:      cert.criticalIssues.length,
    mediumIssues:        cert.mediumIssues.length,
    lowIssues:           cert.lowIssues.length,
    certifiedSubsystems: cert.certifiedSubsystems,
    totalSubsystems:     cert.subsystems.length,
    signature:           cert.signature,
    enterpriseCertified: er.enterpriseCertified,
    criticalBlockers:    er.criticalBlockers.length,
    certificationExpiry: er.certificationExpiry,
  });
});

// ---------------------------------------------------------------------------
// GET /certification/:certId/subsystems
// ---------------------------------------------------------------------------
router.get("/production-certification/:certId/subsystems", (req, res): void => {
  const bundle = getE5Bundle(req.params.certId!);
  if (!bundle) { res.status(404).json({ error: `Not found: ${req.params.certId}` }); return; }
  res.status(200).json({
    certId:       bundle.certId,
    overallScore: bundle.overallScore,
    overallGrade: bundle.overallGrade,
    subsystems:   bundle.productionCertification.subsystems.map(s => ({
      id:        s.id,
      name:      s.name,
      phase:     s.phase,
      score:     s.score,
      grade:     s.grade,
      status:    s.status,
      checks:    s.checks.length,
      issues:    s.issues.length,
      strengths: s.strengths,
      weaknesses: s.weaknesses,
      notes:     s.notes,
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /certification/:certId/subsystems/:id
// ---------------------------------------------------------------------------
router.get("/production-certification/:certId/subsystems/:subsystemId", (req, res): void => {
  const bundle = getE5Bundle(req.params.certId!);
  if (!bundle) { res.status(404).json({ error: `Not found: ${req.params.certId}` }); return; }
  const sub = bundle.productionCertification.subsystems.find(s => s.id === req.params.subsystemId);
  if (!sub) {
    res.status(404).json({
      error: `Subsystem "${req.params.subsystemId}" not found. Valid: ${SUBSYSTEM_IDS.join(", ")}`,
    });
    return;
  }
  res.status(200).json(sub);
});

// ---------------------------------------------------------------------------
// GET /certification/:certId/issues
// ---------------------------------------------------------------------------
router.get("/production-certification/:certId/issues", (req, res): void => {
  const bundle = getE5Bundle(req.params.certId!);
  if (!bundle) { res.status(404).json({ error: `Not found: ${req.params.certId}` }); return; }
  const cert   = bundle.productionCertification;
  const level  = req.query["level"] as string | undefined;

  const all    = [...cert.criticalIssues, ...cert.mediumIssues, ...cert.lowIssues];
  const issues = level && ISSUE_LEVELS.includes(level.toUpperCase() as IssueLevel)
    ? all.filter(i => i.level === level.toUpperCase())
    : all;

  res.status(200).json({
    certId:   bundle.certId,
    total:    issues.length,
    critical: cert.criticalIssues.length,
    medium:   cert.mediumIssues.length,
    low:      cert.lowIssues.length,
    issues,
  });
});

// ---------------------------------------------------------------------------
// GET /certification/:certId/issues/critical|medium|low
// ---------------------------------------------------------------------------
for (const level of ISSUE_LEVELS) {
  router.get(`/certification/:certId/issues/${level.toLowerCase()}`, (req, res): void => {
    const bundle = getE5Bundle(req.params.certId!);
    if (!bundle) { res.status(404).json({ error: `Not found: ${req.params.certId}` }); return; }
    const cert   = bundle.productionCertification;
    const issues = level === "CRITICAL" ? cert.criticalIssues : level === "MEDIUM" ? cert.mediumIssues : cert.lowIssues;
    res.status(200).json({ certId: bundle.certId, level, count: issues.length, issues });
  });
}

// ---------------------------------------------------------------------------
// GET /certification/:certId/pillars
// ---------------------------------------------------------------------------
router.get("/production-certification/:certId/pillars", (req, res): void => {
  const bundle = getE5Bundle(req.params.certId!);
  if (!bundle) { res.status(404).json({ error: `Not found: ${req.params.certId}` }); return; }
  const er = bundle.enterpriseReadinessReport;
  res.status(200).json({
    certId:              bundle.certId,
    readinessLevel:      er.readinessLevel,
    enterpriseCertified: er.enterpriseCertified,
    criticalBlockers:    er.criticalBlockers,
    pillars:             er.pillars,
  });
});

// ---------------------------------------------------------------------------
// GET /certification/:certId/recommendations
// ---------------------------------------------------------------------------
router.get("/production-certification/:certId/recommendations", (req, res): void => {
  const bundle = getE5Bundle(req.params.certId!);
  if (!bundle) { res.status(404).json({ error: `Not found: ${req.params.certId}` }); return; }
  const cert = bundle.productionCertification;
  const er   = bundle.enterpriseReadinessReport;

  const byPriority = [
    ...cert.criticalIssues.map(i => ({ priority: 1, level: i.level, subsystem: i.subsystem, title: i.title, remediation: i.remediation, blocking: i.blocking })),
    ...cert.mediumIssues.map(i => ({ priority: 2, level: i.level, subsystem: i.subsystem, title: i.title, remediation: i.remediation, blocking: i.blocking })),
    ...cert.lowIssues.map(i => ({ priority: 3, level: i.level, subsystem: i.subsystem, title: i.title, remediation: i.remediation, blocking: i.blocking })),
  ];

  res.status(200).json({
    certId:          bundle.certId,
    readinessLevel:  er.readinessLevel,
    readinessScore:  bundle.overallScore,
    blockingCount:   byPriority.filter(r => r.blocking).length,
    nonBlockingCount: byPriority.filter(r => !r.blocking).length,
    architectureGaps: er.criticalBlockers,
    recommendations: byPriority,
    pathToEnterprise: er.enterpriseCertified
      ? "Platform is ENTERPRISE READY — all requirements met."
      : `Complete ${er.criticalBlockers.length} blocking requirement(s) to achieve ENTERPRISE READY status.`,
  });
});

export default router;
