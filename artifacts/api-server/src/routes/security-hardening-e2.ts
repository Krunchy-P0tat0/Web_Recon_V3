/**
 * security-hardening-e2.ts — Phase E2 Routes
 *
 * POST /security-audit/run                              — run full security audit
 * GET  /security-audit                                  — list all audit runs
 * GET  /security-audit/:auditId                         — full E2 bundle
 * GET  /security-audit/:auditId/report                  — security-audit-report.json
 * GET  /security-audit/:auditId/vulnerabilities         — vulnerability-report.json
 * GET  /security-audit/:auditId/checklist               — hardening-checklist.json
 * GET  /security-audit/:auditId/score                   — security score + grade
 * GET  /security-audit/:auditId/dimensions              — per-dimension breakdown
 * GET  /security-audit/:auditId/findings                — all findings (paginated)
 * GET  /security-audit/:auditId/findings/critical       — critical findings only
 * GET  /security-audit/:auditId/immediate-actions       — immediate action list
 */

import { Router, type IRouter } from "express";
import { randomUUID }            from "crypto";
import {
  runSecurityAudit,
  getE2Bundle,
  listE2Bundles,
} from "../lib/security-hardening-engine-e2.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /security-audit/run
// ---------------------------------------------------------------------------
router.post("/security-audit/run", async (req, res): Promise<void> => {
  const { auditId, projectRoot, checkDeps, force } = req.body ?? {};

  const id = typeof auditId === "string" && auditId.trim()
    ? auditId.trim()
    : `e2-${randomUUID()}`;

  try {
    const bundle = await runSecurityAudit({
      auditId:     id,
      projectRoot: typeof projectRoot === "string" ? projectRoot : undefined,
      checkDeps:   checkDeps !== false,
      force:       !!force,
    });

    const r = bundle.securityAuditReport;
    const v = bundle.vulnerabilityReport;
    const c = bundle.hardeningChecklist;

    res.status(200).json({
      auditId:          bundle.auditId,
      generatedAt:      bundle.generatedAt,
      durationMs:       bundle.durationMs,
      r2Keys:           bundle.r2Keys,
      securityScore:    bundle.securityScore,
      securityGrade:    bundle.securityGrade,
      riskScore:        r.riskScore,
      totalFindings:    r.totalFindings,
      bySeverity:       r.bySeverity,
      criticalCount:    r.criticalCount,
      highCount:        r.highCount,
      totalVulns:       v.totalVulns,
      checklistTotal:   c.totalItems,
      checklistPassed:  c.passed,
      checklistFailed:  c.failed,
      completionPct:    c.completionPct,
      executiveSummary: r.executiveSummary,
      immediateActions: r.immediateActions,
      dimensionSummary: r.dimensions.map(d => ({
        dimension: d.dimension,
        status:    d.status,
        score:     d.score,
        findings:  d.findings.length,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "E2: security audit failed");
    res.status(500).json({ error: "Security audit failed", detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /security-audit
// ---------------------------------------------------------------------------
router.get("/security-audit", (_req, res): void => {
  res.status(200).json(listE2Bundles());
});

// ---------------------------------------------------------------------------
// GET /security-audit/:auditId — full bundle
// ---------------------------------------------------------------------------
router.get("/security-audit/:auditId", (req, res): void => {
  const bundle = getE2Bundle(req.params.auditId!);
  if (!bundle) {
    res.status(404).json({ error: `No E2 audit found for id "${req.params.auditId}"` });
    return;
  }
  res.status(200).json(bundle);
});

// ---------------------------------------------------------------------------
// GET /security-audit/:auditId/report — security-audit-report.json
// ---------------------------------------------------------------------------
router.get("/security-audit/:auditId/report", (req, res): void => {
  const bundle = getE2Bundle(req.params.auditId!);
  if (!bundle) { res.status(404).json({ error: `No E2 audit found for id "${req.params.auditId}"` }); return; }
  res.status(200).json(bundle.securityAuditReport);
});

// ---------------------------------------------------------------------------
// GET /security-audit/:auditId/vulnerabilities — vulnerability-report.json
// ---------------------------------------------------------------------------
router.get("/security-audit/:auditId/vulnerabilities", (req, res): void => {
  const bundle = getE2Bundle(req.params.auditId!);
  if (!bundle) { res.status(404).json({ error: `No E2 audit found for id "${req.params.auditId}"` }); return; }
  res.status(200).json(bundle.vulnerabilityReport);
});

// ---------------------------------------------------------------------------
// GET /security-audit/:auditId/checklist — hardening-checklist.json
// ---------------------------------------------------------------------------
router.get("/security-audit/:auditId/checklist", (req, res): void => {
  const bundle = getE2Bundle(req.params.auditId!);
  if (!bundle) { res.status(404).json({ error: `No E2 audit found for id "${req.params.auditId}"` }); return; }
  res.status(200).json(bundle.hardeningChecklist);
});

// ---------------------------------------------------------------------------
// GET /security-audit/:auditId/score
// ---------------------------------------------------------------------------
router.get("/security-audit/:auditId/score", (req, res): void => {
  const bundle = getE2Bundle(req.params.auditId!);
  if (!bundle) { res.status(404).json({ error: `No E2 audit found for id "${req.params.auditId}"` }); return; }
  const r = bundle.securityAuditReport;
  res.status(200).json({
    auditId:       bundle.auditId,
    generatedAt:   bundle.generatedAt,
    securityScore: bundle.securityScore,
    securityGrade: bundle.securityGrade,
    riskScore:     r.riskScore,
    criticalCount: r.criticalCount,
    highCount:     r.highCount,
    totalFindings: r.totalFindings,
    bySeverity:    r.bySeverity,
  });
});

// ---------------------------------------------------------------------------
// GET /security-audit/:auditId/dimensions
// ---------------------------------------------------------------------------
router.get("/security-audit/:auditId/dimensions", (req, res): void => {
  const bundle = getE2Bundle(req.params.auditId!);
  if (!bundle) { res.status(404).json({ error: `No E2 audit found for id "${req.params.auditId}"` }); return; }
  res.status(200).json({
    auditId:    bundle.auditId,
    securityScore: bundle.securityScore,
    dimensions: bundle.securityAuditReport.dimensions,
  });
});

// ---------------------------------------------------------------------------
// GET /security-audit/:auditId/findings?page=1&limit=50&severity=HIGH
// ---------------------------------------------------------------------------
router.get("/security-audit/:auditId/findings", (req, res): void => {
  const bundle = getE2Bundle(req.params.auditId!);
  if (!bundle) { res.status(404).json({ error: `No E2 audit found for id "${req.params.auditId}"` }); return; }

  const page     = Math.max(1, parseInt(String(req.query["page"]  ?? "1"),  10));
  const limit    = Math.min(200, Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10)));
  const severity = req.query["severity"] as string | undefined;

  let findings = bundle.securityAuditReport.dimensions.flatMap(d => d.findings);
  if (severity) findings = findings.filter(f => f.severity === severity.toUpperCase());

  const start = (page - 1) * limit;
  res.status(200).json({
    auditId:    bundle.auditId,
    total:      findings.length,
    page, limit,
    totalPages: Math.ceil(findings.length / limit),
    findings:   findings.slice(start, start + limit),
  });
});

// ---------------------------------------------------------------------------
// GET /security-audit/:auditId/findings/critical
// ---------------------------------------------------------------------------
router.get("/security-audit/:auditId/findings/critical", (req, res): void => {
  const bundle = getE2Bundle(req.params.auditId!);
  if (!bundle) { res.status(404).json({ error: `No E2 audit found for id "${req.params.auditId}"` }); return; }
  const critical = bundle.securityAuditReport.dimensions
    .flatMap(d => d.findings)
    .filter(f => f.severity === "CRITICAL" || f.severity === "HIGH");
  res.status(200).json({
    auditId: bundle.auditId,
    count:   critical.length,
    findings: critical,
  });
});

// ---------------------------------------------------------------------------
// GET /security-audit/:auditId/immediate-actions
// ---------------------------------------------------------------------------
router.get("/security-audit/:auditId/immediate-actions", (req, res): void => {
  const bundle = getE2Bundle(req.params.auditId!);
  if (!bundle) { res.status(404).json({ error: `No E2 audit found for id "${req.params.auditId}"` }); return; }
  const r = bundle.securityAuditReport;
  res.status(200).json({
    auditId:          bundle.auditId,
    securityGrade:    bundle.securityGrade,
    criticalCount:    r.criticalCount,
    highCount:        r.highCount,
    immediateActions: r.immediateActions,
    executiveSummary: r.executiveSummary,
  });
});

export default router;
