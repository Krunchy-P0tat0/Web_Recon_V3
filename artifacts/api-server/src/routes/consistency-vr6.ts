/**
 * consistency-vr6.ts — Phase VR-6: Multi-Page Consistency Engine Routes
 *
 * POST /api/consistency-vr6/:jobId/analyze
 *   Runs the full VR-6 consistency analysis.
 *   Loads VR-2/3/4/5 outputs automatically; all are optional.
 *   Body (optional): { force?: boolean, seedUrl?: string }
 *   Returns: { rules, report }
 *
 * GET  /api/consistency-vr6/:jobId/report
 *   Full consistency-report.json (4 metrics + per-page scores + issues).
 *
 * GET  /api/consistency-vr6/:jobId/rules
 *   Full consistency-rules.json (nav, footer, spacing, typography, layout, theme rules).
 *
 * GET  /api/consistency-vr6/:jobId/metrics
 *   Just the four headline metrics (componentConsistency, spacingConsistency,
 *   layoutConsistency, themeConsistency, overallConsistency).
 *
 * GET  /api/consistency-vr6/:jobId/rules/navigation
 *   Navigation rule only (shared?, placement, componentId, coverage).
 *
 * GET  /api/consistency-vr6/:jobId/rules/footer
 *   Footer rule only.
 *
 * GET  /api/consistency-vr6/:jobId/rules/spacing
 *   Spacing rules (canonical scale, section gap, density).
 *
 * GET  /api/consistency-vr6/:jobId/rules/typography
 *   Typography rules (families, size scale, weight scale).
 *
 * GET  /api/consistency-vr6/:jobId/rules/layout
 *   Layout rules (canonical section order, grid columns, max width, placements).
 *
 * GET  /api/consistency-vr6/:jobId/rules/theme
 *   Theme rules (primary, background, text, accent colors).
 *
 * GET  /api/consistency-vr6/:jobId/issues
 *   All detected consistency issues.
 *   Query params: ?severity=info|warning|error  ?kind=<IssueKind>
 *
 * GET  /api/consistency-vr6/:jobId/pages
 *   Per-page consistency scores.
 *
 * GET  /api/consistency-vr6/report
 *   Latest cached report across all jobs.
 */

import { Router, type IRouter } from "express";
import {
  runConsistencyEngineVR6,
  getCachedRules,
  getCachedConsistencyReport,
  type ConsistencyReport,
} from "../lib/consistency-engine-vr6.js";

const router: IRouter = Router();

// ── Latest-report cache ───────────────────────────────────────────────────────

let _lastReport: ConsistencyReport | null = null;

// ── Helper: require cached report ────────────────────────────────────────────

function requireReport(
  jobId: string,
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): ConsistencyReport | null {
  const report = getCachedConsistencyReport(jobId);
  if (!report) {
    res.status(404).json({
      error: "No VR-6 consistency report found for this job.",
      hint:  `POST /api/consistency-vr6/${jobId}/analyze to run Phase VR-6.`,
    });
    return null;
  }
  return report;
}

// ── POST /api/consistency-vr6/:jobId/analyze ─────────────────────────────────

router.post("/consistency-vr6/:jobId/analyze", async (req, res): Promise<void> => {
  const jobId = (req.params as Record<string, string>)["jobId"] ?? "";
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  const body    = (req.body ?? {}) as Record<string, unknown>;
  const force   = body["force"]   === true;
  const seedUrl = typeof body["seedUrl"] === "string" ? body["seedUrl"] : undefined;

  // Return cached result unless forced
  if (!force) {
    const cached = getCachedConsistencyReport(jobId);
    if (cached) {
      res.status(200).json({ rules: getCachedRules(jobId), report: cached, cached: true });
      return;
    }
  }

  req.log.info({ jobId, force }, "VR6: analyze requested");

  try {
    const { rules, report } = await runConsistencyEngineVR6({ jobId, seedUrl });
    _lastReport = report;
    res.status(200).json({ rules, report });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err, jobId }, "VR6: analyze failed");
    res.status(500).json({ error: "VR-6 consistency analysis failed", detail: message });
  }
});

// ── GET /api/consistency-vr6/:jobId/report ────────────────────────────────────

router.get("/consistency-vr6/:jobId/report", (req, res): void => {
  const jobId  = (req.params as Record<string, string>)["jobId"] ?? "";
  const report = requireReport(jobId, res);
  if (report) res.status(200).json(report);
});

// ── GET /api/consistency-vr6/:jobId/rules ────────────────────────────────────

router.get("/consistency-vr6/:jobId/rules", (req, res): void => {
  const jobId = (req.params as Record<string, string>)["jobId"] ?? "";
  const rules = getCachedRules(jobId);
  if (!rules) {
    res.status(404).json({
      error: "No VR-6 rules found.",
      hint:  `POST /api/consistency-vr6/${jobId}/analyze first.`,
    });
    return;
  }
  res.status(200).json(rules);
});

// ── GET /api/consistency-vr6/:jobId/metrics ──────────────────────────────────

router.get("/consistency-vr6/:jobId/metrics", (req, res): void => {
  const jobId  = (req.params as Record<string, string>)["jobId"] ?? "";
  const report = requireReport(jobId, res);
  if (!report) return;
  res.status(200).json({
    jobId,
    generatedAt:   report.generatedAt,
    metrics:       report.metrics,
    inputsUsed:    report.inputsUsed,
    summary: {
      totalPages:        report.summary.totalPages,
      consistentPages:   report.summary.consistentPages,
      inconsistentPages: report.summary.inconsistentPages,
    },
  });
});

// ── GET /api/consistency-vr6/:jobId/rules/navigation ─────────────────────────

router.get("/consistency-vr6/:jobId/rules/navigation", (req, res): void => {
  const jobId = (req.params as Record<string, string>)["jobId"] ?? "";
  const rules = getCachedRules(jobId);
  if (!rules) {
    res.status(404).json({ error: "No VR-6 rules found.", hint: `POST /api/consistency-vr6/${jobId}/analyze first.` });
    return;
  }
  res.status(200).json({ jobId, navigation: rules.navigation });
});

// ── GET /api/consistency-vr6/:jobId/rules/footer ─────────────────────────────

router.get("/consistency-vr6/:jobId/rules/footer", (req, res): void => {
  const jobId = (req.params as Record<string, string>)["jobId"] ?? "";
  const rules = getCachedRules(jobId);
  if (!rules) {
    res.status(404).json({ error: "No VR-6 rules found.", hint: `POST /api/consistency-vr6/${jobId}/analyze first.` });
    return;
  }
  res.status(200).json({ jobId, footer: rules.footer });
});

// ── GET /api/consistency-vr6/:jobId/rules/spacing ────────────────────────────

router.get("/consistency-vr6/:jobId/rules/spacing", (req, res): void => {
  const jobId = (req.params as Record<string, string>)["jobId"] ?? "";
  const rules = getCachedRules(jobId);
  if (!rules) {
    res.status(404).json({ error: "No VR-6 rules found.", hint: `POST /api/consistency-vr6/${jobId}/analyze first.` });
    return;
  }
  res.status(200).json({ jobId, spacing: rules.spacing });
});

// ── GET /api/consistency-vr6/:jobId/rules/typography ─────────────────────────

router.get("/consistency-vr6/:jobId/rules/typography", (req, res): void => {
  const jobId = (req.params as Record<string, string>)["jobId"] ?? "";
  const rules = getCachedRules(jobId);
  if (!rules) {
    res.status(404).json({ error: "No VR-6 rules found.", hint: `POST /api/consistency-vr6/${jobId}/analyze first.` });
    return;
  }
  res.status(200).json({ jobId, typography: rules.typography });
});

// ── GET /api/consistency-vr6/:jobId/rules/layout ─────────────────────────────

router.get("/consistency-vr6/:jobId/rules/layout", (req, res): void => {
  const jobId = (req.params as Record<string, string>)["jobId"] ?? "";
  const rules = getCachedRules(jobId);
  if (!rules) {
    res.status(404).json({ error: "No VR-6 rules found.", hint: `POST /api/consistency-vr6/${jobId}/analyze first.` });
    return;
  }
  res.status(200).json({ jobId, layout: rules.layout });
});

// ── GET /api/consistency-vr6/:jobId/rules/theme ──────────────────────────────

router.get("/consistency-vr6/:jobId/rules/theme", (req, res): void => {
  const jobId = (req.params as Record<string, string>)["jobId"] ?? "";
  const rules = getCachedRules(jobId);
  if (!rules) {
    res.status(404).json({ error: "No VR-6 rules found.", hint: `POST /api/consistency-vr6/${jobId}/analyze first.` });
    return;
  }
  res.status(200).json({ jobId, theme: rules.theme });
});

// ── GET /api/consistency-vr6/:jobId/issues ───────────────────────────────────

router.get("/consistency-vr6/:jobId/issues", (req, res): void => {
  const jobId    = (req.params as Record<string, string>)["jobId"] ?? "";
  const severity = req.query["severity"] as string | undefined;
  const kind     = req.query["kind"]     as string | undefined;

  const report = requireReport(jobId, res);
  if (!report) return;

  let issues = report.issues;
  if (severity) issues = issues.filter(i => i.severity === severity);
  if (kind)     issues = issues.filter(i => i.kind === kind);

  res.status(200).json({
    jobId,
    totalIssues:    report.issues.length,
    filteredIssues: issues.length,
    filters:        { severity: severity ?? null, kind: kind ?? null },
    issues,
    issueBySeverity: report.summary.issueBySeverity,
  });
});

// ── GET /api/consistency-vr6/:jobId/pages ────────────────────────────────────

router.get("/consistency-vr6/:jobId/pages", (req, res): void => {
  const jobId  = (req.params as Record<string, string>)["jobId"] ?? "";
  const report = requireReport(jobId, res);
  if (!report) return;

  // Lightweight summary — strip per-page issue detail for brevity
  const pages = report.pages.map(p => ({
    pageId:            p.pageId,
    url:               p.url,
    stencilType:       p.stencilType,
    componentScore:    p.componentScore,
    spacingScore:      p.spacingScore,
    layoutScore:       p.layoutScore,
    themeScore:        p.themeScore,
    overallScore:      p.overallScore,
    issueCount:        p.issues.length,
  }));

  res.status(200).json({
    jobId,
    pageCount: pages.length,
    metrics:   report.metrics,
    pages,
  });
});

// ── GET /api/consistency-vr6/report ──────────────────────────────────────────

router.get("/consistency-vr6/report", (_req, res): void => {
  if (!_lastReport) {
    res.status(404).json({
      error: "No VR-6 consistency report generated yet.",
      hint:  "POST /api/consistency-vr6/:jobId/analyze to run Phase VR-6.",
    });
    return;
  }
  res.status(200).json(_lastReport);
});

export default router;
