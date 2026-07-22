/**
 * resource-decision-ri3.ts — Phase RI-3: Intelligent Resource Decision Engine routes
 *
 * POST /resource-decision/analyze/:jobId   — run full decision pass on a job's resources
 * POST /resource-decision/evaluate         — single-resource decision (no jobId required)
 * POST /resource-decision/batch            — batch of up to 5 000 resources
 * GET  /resource-decision/:jobId/report    — resource-decision-report.json
 * GET  /resource-decision/:jobId/download-plan — download-plan.json
 * GET  /resource-decision/:jobId/budget    — resource-budget-report.json
 * GET  /resource-decision/:jobId/audit     — decision-audit-report.json
 * GET  /resource-decision/:jobId/summary   — lightweight counts + top decisions
 * GET  /resource-decision/:jobId/downloads — all DOWNLOAD decisions, priority-ordered
 * GET  /resource-decision/:jobId/skipped   — all SKIP decisions with reasons
 * GET  /resource-decision/dimensions       — describe all decision dimensions and rules
 */

import { Router } from "express";
import {
  runResourceDecisionEngine,
  evaluateSingleDecision,
  evaluateBatchDecisions,
  getCachedRi3Reports,
  type DecisionContext,
  type ResourceBudgets,
  type ReconstructionGoal,
  type WebsiteType,
  type CrawlPhase,
} from "../lib/resource-decision-engine-ri3.js";

const router = Router();

// ── POST /resource-decision/analyze/:jobId ────────────────────────────────────

router.post("/resource-decision/analyze/:jobId", async (req, res): Promise<void> => {
  const { jobId } = req.params;
  if (!jobId) { res.status(400).json({ error: "jobId required" }); return; }

  try {
    const ctx = parseContext(req.body ?? {});
    const result = await runResourceDecisionEngine(jobId, ctx);
    const report = result.decisionReport;

    res.json({
      jobId,
      phase: "RI-3",
      totalResources:   report.totalResources,
      byDecision:       report.byDecision,
      estimatedDownloadMb: result.downloadPlan.estimatedMb,
      totalDownloads:   result.downloadPlan.totalDownloads,
      totalDeferreds:   result.downloadPlan.totalDeferreds,
      budgetStatus:     result.budgetReport.budgetStatus,
      confidenceAvg:    result.auditReport.confidenceAvg,
      ruleActivations:  result.auditReport.ruleActivations,
      r2Keys:           result.r2Keys,
      summary:          report.summary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── POST /resource-decision/evaluate ─────────────────────────────────────────

router.post("/resource-decision/evaluate", (req, res): void => {
  const { url, seedUrl, mimeType, byteSize, tags, context } = req.body ?? {};

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url (string) is required" });
    return;
  }
  if (!seedUrl || typeof seedUrl !== "string") {
    res.status(400).json({ error: "seedUrl (string) is required" });
    return;
  }

  try {
    const ctx = context ? parseContext(context) : undefined;
    const result = evaluateSingleDecision(
      url,
      seedUrl,
      mimeType ?? null,
      typeof byteSize === "number" ? byteSize : null,
      Array.isArray(tags) ? tags : [],
      ctx,
    );
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── POST /resource-decision/batch ─────────────────────────────────────────────

router.post("/resource-decision/batch", (req, res): void => {
  const { resources, context } = req.body ?? {};

  if (!Array.isArray(resources) || resources.length === 0) {
    res.status(400).json({ error: "resources (non-empty array) is required" });
    return;
  }
  if (resources.length > 5_000) {
    res.status(400).json({ error: "Batch limited to 5 000 resources per call" });
    return;
  }

  const invalid = resources.findIndex(
    (r) => typeof r.url !== "string" || typeof r.seedUrl !== "string",
  );
  if (invalid !== -1) {
    res.status(400).json({ error: `resources[${invalid}] must have url and seedUrl strings` });
    return;
  }

  try {
    const ctx = context ? parseContext(context) : undefined;
    const results = evaluateBatchDecisions(resources, ctx);

    const byDecision: Record<string, number> = {};
    let totalCostMb = 0;
    for (const r of results) {
      byDecision[r.decision] = (byDecision[r.decision] ?? 0) + 1;
      if (r.decision === "DOWNLOAD") totalCostMb += r.estimatedCostMb;
    }

    res.json({
      total: results.length,
      byDecision,
      estimatedDownloadMb: parseFloat(totalCostMb.toFixed(3)),
      results: results.map((r, i) => ({
        rank: i + 1,
        url: resources[i].url,
        decision: r.decision,
        confidence: r.confidence,
        reason: r.reason,
        ri1Score: r.ri1Score,
        ri2Overall: r.ri2Overall,
        estimatedCostMb: r.estimatedCostMb,
        risk: r.risk,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── GET /resource-decision/:jobId/report ──────────────────────────────────────

router.get("/resource-decision/:jobId/report", (req, res): void => {
  const cached = getCachedRi3Reports(req.params.jobId!);
  if (!cached) { res.status(404).json({ error: "No RI-3 report for this job. Run /analyze/:jobId first." }); return; }
  res.json(cached.decisionReport);
});

// ── GET /resource-decision/:jobId/download-plan ───────────────────────────────

router.get("/resource-decision/:jobId/download-plan", (req, res): void => {
  const cached = getCachedRi3Reports(req.params.jobId!);
  if (!cached) { res.status(404).json({ error: "No RI-3 report found. Run /analyze/:jobId first." }); return; }
  res.json(cached.downloadPlan);
});

// ── GET /resource-decision/:jobId/budget ──────────────────────────────────────

router.get("/resource-decision/:jobId/budget", (req, res): void => {
  const cached = getCachedRi3Reports(req.params.jobId!);
  if (!cached) { res.status(404).json({ error: "No RI-3 report found. Run /analyze/:jobId first." }); return; }
  res.json(cached.budgetReport);
});

// ── GET /resource-decision/:jobId/audit ──────────────────────────────────────

router.get("/resource-decision/:jobId/audit", (req, res): void => {
  const cached = getCachedRi3Reports(req.params.jobId!);
  if (!cached) { res.status(404).json({ error: "No RI-3 report found. Run /analyze/:jobId first." }); return; }
  res.json(cached.auditReport);
});

// ── GET /resource-decision/:jobId/summary ────────────────────────────────────

router.get("/resource-decision/:jobId/summary", (req, res): void => {
  const cached = getCachedRi3Reports(req.params.jobId!);
  if (!cached) { res.status(404).json({ error: "No RI-3 report found. Run /analyze/:jobId first." }); return; }

  const r = cached.decisionReport;
  const top10 = [...r.decisions]
    .sort((a, b) => b.ri2Overall - a.ri2Overall)
    .slice(0, 10)
    .map(d => ({
      url: d.url, label: d.label, decision: d.decision,
      confidence: d.confidence, ri2Overall: d.ri2Overall, reason: d.reason,
    }));

  res.json({
    jobId: r.jobId,
    phase: "RI-3",
    totalResources: r.totalResources,
    byDecision: r.byDecision,
    estimatedDownloadMb: cached.downloadPlan.estimatedMb,
    budgetStatus: cached.budgetReport.budgetStatus,
    confidenceAvg: cached.auditReport.confidenceAvg,
    lowConfidenceCount: cached.auditReport.lowConfidenceCount,
    topRuleActivations: Object.entries(cached.auditReport.ruleActivations)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([rule, count]) => ({ rule, count })),
    top10ByValue: top10,
    summary: r.summary,
  });
});

// ── GET /resource-decision/:jobId/downloads ───────────────────────────────────

router.get("/resource-decision/:jobId/downloads", (req, res): void => {
  const cached = getCachedRi3Reports(req.params.jobId!);
  if (!cached) { res.status(404).json({ error: "No RI-3 report found. Run /analyze/:jobId first." }); return; }

  const downloads = cached.decisionReport.decisions
    .filter(d => d.decision === "DOWNLOAD")
    .sort((a, b) => b.ri2Overall - a.ri2Overall)
    .map((d, i) => ({
      rank: i + 1,
      url: d.url, label: d.label, resourceType: d.resourceType,
      confidence: d.confidence, ri2Overall: d.ri2Overall,
      estimatedCostMb: d.estimatedCostMb, reason: d.reason,
      riskLevel: d.riskAssessment.level,
    }));

  res.json({
    jobId: cached.decisionReport.jobId,
    totalDownloads: downloads.length,
    estimatedMb: cached.downloadPlan.estimatedMb,
    downloads,
  });
});

// ── GET /resource-decision/:jobId/skipped ────────────────────────────────────

router.get("/resource-decision/:jobId/skipped", (req, res): void => {
  const cached = getCachedRi3Reports(req.params.jobId!);
  if (!cached) { res.status(404).json({ error: "No RI-3 report found. Run /analyze/:jobId first." }); return; }

  const skipped = cached.decisionReport.decisions
    .filter(d => d.decision === "SKIP")
    .map(d => ({
      url: d.url, label: d.label, resourceType: d.resourceType,
      reason: d.reason, ri1Score: d.ri1Score, ri2Overall: d.ri2Overall,
      confidence: d.confidence,
    }));

  const reasonBreakdown: Record<string, number> = {};
  for (const s of skipped) reasonBreakdown[s.reason] = (reasonBreakdown[s.reason] ?? 0) + 1;

  res.json({
    jobId: cached.decisionReport.jobId,
    totalSkipped: skipped.length,
    reasonBreakdown,
    resources: skipped,
  });
});

// ── GET /resource-decision/dimensions ────────────────────────────────────────

router.get("/resource-decision/dimensions", (_req, res): void => {
  res.json({
    phase: "RI-3",
    description: "Intelligent Resource Decision Engine — decision rules and dimensions",
    decisions: {
      DOWNLOAD:  "Fetch resource and store locally in the reconstruction archive",
      REFERENCE: "Keep the external URL as-is; do not download or store",
      DEFER:     "Download after all higher-priority resources have been acquired",
      STREAM:    "Access on-demand from origin; do not persist to local storage",
      CACHE:     "Store the response or URL reference for pipeline reuse (e.g. API schemas)",
      SKIP:      "Do not acquire in any form — resource excluded from reconstruction",
    },
    inputs: {
      ri1Score:          "Resource Intelligence Score (RI-1) — composite 0-100",
      ri2Overall:        "Reconstruction Value Score (RI-2) — overall 0-100",
      budgets: {
        hardwareMb:      "Total available hardware storage (0 = unlimited)",
        storageMb:       "Storage budget for this crawl (0 = unlimited)",
        memoryMb:        "In-process memory limit (0 = unlimited)",
        bandwidthMb:     "Network bandwidth cap (0 = unlimited)",
        usedStorageMb:   "Storage consumed so far",
        usedBandwidthMb: "Bandwidth consumed so far",
        usedMemoryMb:    "Memory consumed so far",
      },
      offlineMode:        "When true, prioritises local acquisition over external references",
      reconstructionGoal: "clone_site | merge_into_backend | update_existing | visual_snapshot | design_extraction",
      websiteType:        "blog | ecommerce | saas | portfolio | news | corporate | docs | unknown",
      crawlPhase:         "discovery | media | analysis | generation | deployment",
    },
    ruleOrder: [
      "R00: Zero-value guard — RI-2 ≤ 3 and RI-1 ≤ 10 → SKIP",
      "R01: Analytics/advertising tracker → SKIP",
      "R02: Chat/live-support widget (JS) → SKIP",
      "R03: Cookie consent banner → SKIP",
      "R04: API schema / contract document → CACHE",
      "R05: Budget exhausted — SKIP (or REFERENCE for essential resources)",
      "R06: Offline mode overrides — maximise local acquisition",
      "R07: Google Fonts CDN → REFERENCE",
      "R08: Large video — DEFER / STREAM / SKIP based on goal",
      "R09: Essential (RI-2 ≥ 80) → DOWNLOAD same-domain | REFERENCE external",
      "R10: High value (RI-2 60-79) → DOWNLOAD same-domain/CDN | REFERENCE external",
      "R11: Medium value (RI-2 35-59) → DOWNLOAD same-domain | DEFER external",
      "R12: Low value (RI-2 12-34) → DEFER if clone_site else SKIP",
      "R13: Negligible (RI-2 < 12) → SKIP",
    ],
    outputs: [
      "resource-decision-report.json   — every resource decision with full metadata",
      "download-plan.json              — priority-ordered acquisition sequence",
      "resource-budget-report.json     — budget consumption and status",
      "decision-audit-report.json      — complete audit trail with rule activations",
    ],
  });
});

// ── Context parsing helper ────────────────────────────────────────────────────

function parseContext(body: Record<string, unknown>): Partial<DecisionContext> {
  const ctx: Partial<DecisionContext> = {};

  if (typeof body.offlineMode === "boolean")           ctx.offlineMode        = body.offlineMode;
  if (typeof body.reconstructionGoal === "string")     ctx.reconstructionGoal = body.reconstructionGoal as ReconstructionGoal;
  if (typeof body.websiteType === "string")            ctx.websiteType        = body.websiteType as WebsiteType;
  if (typeof body.crawlPhase === "string")             ctx.crawlPhase         = body.crawlPhase as CrawlPhase;

  if (body.budgets && typeof body.budgets === "object") {
    const b = body.budgets as Record<string, unknown>;
    const budgets: Partial<ResourceBudgets> = {};
    for (const key of ["hardwareMb","storageMb","memoryMb","bandwidthMb","usedStorageMb","usedBandwidthMb","usedMemoryMb"] as const) {
      if (typeof b[key] === "number") (budgets as Record<string, number>)[key] = b[key] as number;
    }
    ctx.budgets = budgets as ResourceBudgets;
  }

  return ctx;
}

export default router;
