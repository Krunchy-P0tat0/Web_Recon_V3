/**
 * reconstruction-value-ri2.ts — Phase RI-2: Reconstruction Value Engine routes
 *
 * POST /reconstruction-value/analyze/:jobId   — score all resources for a job
 * POST /reconstruction-value/evaluate         — score a single resource
 * POST /reconstruction-value/batch            — score a batch of resources
 * GET  /reconstruction-value/:jobId/report    — reconstruction-value-report.json
 * GET  /reconstruction-value/:jobId/ranking   — resource-value-ranking.json
 * GET  /reconstruction-value/:jobId/prime     — website-prime-value-report.json
 * GET  /reconstruction-value/:jobId/summary   — lightweight summary
 * GET  /reconstruction-value/:jobId/top       — top N resources by overall score
 * GET  /reconstruction-value/:jobId/by-tier   — resources grouped by value tier
 * GET  /reconstruction-value/:jobId/dimensions/:resourceId — single resource dimensions
 */

import { Router } from "express";
import {
  runReconstructionValueEngine,
  evaluateSingleResourceValue,
  evaluateResourceValueBatch,
  getCachedRi2Reports,
  type MinimalResource,
} from "../lib/reconstruction-value-engine-ri2.js";
import type { ResourceType } from "../lib/resource-intelligence-engine-ri1.js";

const router = Router();

// ── POST /reconstruction-value/analyze/:jobId ────────────────────────────────
router.post("/reconstruction-value/analyze/:jobId", async (req, res): Promise<void> => {
  const { jobId } = req.params;
  if (!jobId) { res.status(400).json({ error: "jobId required" }); return; }

  try {
    const result = await runReconstructionValueEngine(jobId);
    const { valueReport: vr, ranking: rk, primeReport: pr, r2Keys } = result;
    res.json({
      jobId,
      phase:              "RI-2",
      totalResources:     vr.totalResources,
      averageOverallScore:vr.averageOverallScore,
      byTier:             vr.byTier,
      websitePrimeScore:  pr.websitePrimeScore,
      primeCompleteness:  pr.primeCompleteness,
      topResources:       vr.topResources.slice(0, 10).map(e => ({
        rank:    e.rank,
        url:     e.url,
        label:   e.label,
        overall: e.dimensions.overall,
        tier:    e.tier,
        topDimension: e.topDimension,
        topScore:     e.topScore,
      })),
      rankingTotal:       rk.total,
      r2Keys,
      summary:            vr.summary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── POST /reconstruction-value/evaluate ──────────────────────────────────────
router.post("/reconstruction-value/evaluate", (req, res): void => {
  const body = req.body as Record<string, unknown>;
  const url          = typeof body["url"]          === "string" ? body["url"]          : null;
  const resourceType = typeof body["resourceType"] === "string" ? body["resourceType"] : null;
  if (!url)          { res.status(400).json({ error: "url is required" }); return; }
  if (!resourceType) { res.status(400).json({ error: "resourceType is required (e.g. css, javascript, image, font, svg, …)" }); return; }

  try {
    const resource: MinimalResource = {
      url,
      resourceType: resourceType as ResourceType,
      mimeType:    typeof body["mimeType"]   === "string" ? body["mimeType"]   : undefined,
      byteSize:    typeof body["byteSize"]   === "number" ? body["byteSize"]   : undefined,
      origin:      typeof body["origin"]     === "string" ? body["origin"] as MinimalResource["origin"] : undefined,
      occurrences: typeof body["occurrences"]=== "number" ? body["occurrences"] : undefined,
      tags:        Array.isArray(body["tags"]) ? body["tags"] as string[] : undefined,
    };
    const entry = evaluateSingleResourceValue(resource);
    res.json(entry);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── POST /reconstruction-value/batch ─────────────────────────────────────────
router.post("/reconstruction-value/batch", (req, res): void => {
  const body = req.body as Record<string, unknown>;
  const rawResources = Array.isArray(body["resources"]) ? body["resources"] as unknown[] : null;
  if (!rawResources || rawResources.length === 0) {
    res.status(400).json({ error: "resources array required (each needs url and resourceType)" });
    return;
  }
  if (rawResources.length > 5000) {
    res.status(400).json({ error: "resources array exceeds max of 5000" });
    return;
  }

  const valid = rawResources.filter(
    (r): r is Record<string, unknown> =>
      typeof r === "object" && r !== null &&
      typeof (r as Record<string, unknown>)["url"] === "string" &&
      typeof (r as Record<string, unknown>)["resourceType"] === "string",
  );
  if (valid.length === 0) {
    res.status(400).json({ error: "No valid resources — each must have url (string) and resourceType (string)" });
    return;
  }

  try {
    const resources: MinimalResource[] = valid.map(r => ({
      url:          r["url"] as string,
      resourceType: r["resourceType"] as ResourceType,
      mimeType:     typeof r["mimeType"]   === "string" ? r["mimeType"]   : undefined,
      byteSize:     typeof r["byteSize"]   === "number" ? r["byteSize"]   : undefined,
      origin:       typeof r["origin"]     === "string" ? r["origin"] as MinimalResource["origin"] : undefined,
      occurrences:  typeof r["occurrences"]=== "number" ? r["occurrences"] : undefined,
      tags:         Array.isArray(r["tags"]) ? r["tags"] as string[] : undefined,
    }));

    const entries = evaluateResourceValueBatch(resources);
    const byTier = {
      essential:  entries.filter(e => e.tier === "essential").length,
      high:       entries.filter(e => e.tier === "high").length,
      medium:     entries.filter(e => e.tier === "medium").length,
      low:        entries.filter(e => e.tier === "low").length,
      negligible: entries.filter(e => e.tier === "negligible").length,
    };
    res.json({ total: entries.length, byTier, results: entries });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── GET /reconstruction-value/:jobId/report ───────────────────────────────────
router.get("/reconstruction-value/:jobId/report", (req, res): void => {
  const cached = getCachedRi2Reports(req.params.jobId!);
  if (!cached) {
    res.status(404).json({ error: "No RI-2 report found. Run POST /reconstruction-value/analyze/:jobId first." });
    return;
  }
  res.json(cached.valueReport);
});

// ── GET /reconstruction-value/:jobId/ranking ──────────────────────────────────
router.get("/reconstruction-value/:jobId/ranking", (req, res): void => {
  const cached = getCachedRi2Reports(req.params.jobId!);
  if (!cached) {
    res.status(404).json({ error: "No RI-2 ranking found. Run POST /reconstruction-value/analyze/:jobId first." });
    return;
  }
  // Support ?limit= and ?tier= query filters
  const limit = Math.min(parseInt(String(req.query["limit"] ?? "500"), 10), 5000);
  const tierFilter = typeof req.query["tier"] === "string" ? req.query["tier"] : null;
  let ranked = cached.ranking.ranked;
  if (tierFilter) ranked = ranked.filter(r => r.tier === tierFilter);
  res.json({ ...cached.ranking, ranked: ranked.slice(0, limit), returned: Math.min(ranked.length, limit) });
});

// ── GET /reconstruction-value/:jobId/prime ────────────────────────────────────
router.get("/reconstruction-value/:jobId/prime", (req, res): void => {
  const cached = getCachedRi2Reports(req.params.jobId!);
  if (!cached) {
    res.status(404).json({ error: "No RI-2 prime report found. Run POST /reconstruction-value/analyze/:jobId first." });
    return;
  }
  res.json(cached.primeReport);
});

// ── GET /reconstruction-value/:jobId/summary ──────────────────────────────────
router.get("/reconstruction-value/:jobId/summary", (req, res): void => {
  const cached = getCachedRi2Reports(req.params.jobId!);
  if (!cached) {
    res.status(404).json({ error: "No RI-2 summary found. Run POST /reconstruction-value/analyze/:jobId first." });
    return;
  }
  const { valueReport: vr, ranking: rk, primeReport: pr, r2Keys } = cached;
  res.json({
    jobId:              vr.jobId,
    seedUrl:            vr.seedUrl,
    generatedAt:        vr.generatedAt,
    phase:              "RI-2",
    totalResources:     vr.totalResources,
    averageOverallScore:vr.averageOverallScore,
    byTier:             vr.byTier,
    websitePrimeScore:  pr.websitePrimeScore,
    primeCompleteness:  pr.primeCompleteness,
    missingCritical:    pr.missingCritical,
    topResources:       vr.topResources.slice(0, 5).map(e => ({
      rank: e.rank, url: e.url, label: e.label,
      overall: e.dimensions.overall, tier: e.tier,
    })),
    rankingTotal: rk.total,
    r2Keys,
    summary: vr.summary,
  });
});

// ── GET /reconstruction-value/:jobId/top ──────────────────────────────────────
router.get("/reconstruction-value/:jobId/top", (req, res): void => {
  const cached = getCachedRi2Reports(req.params.jobId!);
  if (!cached) {
    res.status(404).json({ error: "No RI-2 data found. Run POST /reconstruction-value/analyze/:jobId first." });
    return;
  }
  const n = Math.min(parseInt(String(req.query["n"] ?? "20"), 10), 200);
  res.json({
    jobId:   cached.valueReport.jobId,
    n,
    results: cached.valueReport.resources.slice(0, n),
  });
});

// ── GET /reconstruction-value/:jobId/by-tier ──────────────────────────────────
router.get("/reconstruction-value/:jobId/by-tier", (req, res): void => {
  const cached = getCachedRi2Reports(req.params.jobId!);
  if (!cached) {
    res.status(404).json({ error: "No RI-2 data found. Run POST /reconstruction-value/analyze/:jobId first." });
    return;
  }
  const resources = cached.valueReport.resources;
  res.json({
    jobId: cached.valueReport.jobId,
    generatedAt: cached.valueReport.generatedAt,
    essential:   resources.filter(r => r.tier === "essential"),
    high:        resources.filter(r => r.tier === "high"),
    medium:      resources.filter(r => r.tier === "medium"),
    low:         resources.filter(r => r.tier === "low"),
    negligible:  resources.filter(r => r.tier === "negligible"),
  });
});

// ── GET /reconstruction-value/:jobId/dimensions/:resourceId ──────────────────
router.get("/reconstruction-value/:jobId/dimensions/:resourceId", (req, res): void => {
  const cached = getCachedRi2Reports(req.params.jobId!);
  if (!cached) {
    res.status(404).json({ error: "No RI-2 data found. Run POST /reconstruction-value/analyze/:jobId first." });
    return;
  }
  const entry = cached.valueReport.resources.find(r => r.id === req.params.resourceId);
  if (!entry) {
    res.status(404).json({ error: `Resource ${req.params.resourceId} not found in RI-2 report.` });
    return;
  }
  res.json({
    id:           entry.id,
    url:          entry.url,
    label:        entry.label,
    resourceType: entry.resourceType,
    rank:         entry.rank,
    tier:         entry.tier,
    dimensions: {
      visualReconstruction:  { score: entry.dimensions.visualReconstruction,  weight: 0.28, contribution: Math.round(entry.dimensions.visualReconstruction  * 0.28) },
      designDna:             { score: entry.dimensions.designDna,             weight: 0.10, contribution: Math.round(entry.dimensions.designDna             * 0.10) },
      brandDna:              { score: entry.dimensions.brandDna,              weight: 0.12, contribution: Math.round(entry.dimensions.brandDna              * 0.12) },
      websitePrime:          { score: entry.dimensions.websitePrime,          weight: 0.16, contribution: Math.round(entry.dimensions.websitePrime          * 0.16) },
      backend:               { score: entry.dimensions.backend,               weight: 0.05, contribution: Math.round(entry.dimensions.backend               * 0.05) },
      offlineReconstruction: { score: entry.dimensions.offlineReconstruction, weight: 0.14, contribution: Math.round(entry.dimensions.offlineReconstruction * 0.14) },
      runtimeDependency:     { score: entry.dimensions.runtimeDependency,     weight: 0.07, contribution: Math.round(entry.dimensions.runtimeDependency     * 0.07) },
      historicalReusability: { score: entry.dimensions.historicalReusability, weight: 0.05, contribution: Math.round(entry.dimensions.historicalReusability * 0.05) },
      futureReconstruction:  { score: entry.dimensions.futureReconstruction,  weight: 0.03, contribution: Math.round(entry.dimensions.futureReconstruction  * 0.03) },
      overall:               { score: entry.dimensions.overall, weight: 1.00, contribution: entry.dimensions.overall },
    },
    rationale:    entry.rationale,
    topDimension: entry.topDimension,
    topScore:     entry.topScore,
  });
});

export default router;
