/**
 * load-test-e1.ts — Phase E1 Routes
 *
 * POST /load-test/run                          — run full load test (all tiers)
 * POST /load-test/run/:tier                    — run a single tier
 * GET  /load-test                              — list all load test runs
 * GET  /load-test/:loadTestId                  — full E1 bundle
 * GET  /load-test/:loadTestId/report           — load-test-report.json
 * GET  /load-test/:loadTestId/history          — performance-history.json
 * GET  /load-test/:loadTestId/scalability      — scalability-report.json
 * GET  /load-test/:loadTestId/score            — score + grade summary
 * GET  /load-test/:loadTestId/bottleneck       — bottleneck analysis
 * GET  /load-test/:loadTestId/tiers            — per-tier breakdown
 * GET  /load-test/:loadTestId/tiers/:tier      — single tier metrics
 */

import { Router, type IRouter } from "express";
import { randomUUID }            from "crypto";
import {
  runLoadTest,
  getE1Bundle,
  listE1Bundles,
  type TierName,
} from "../lib/load-test-engine-e1.js";

const router: IRouter = Router();

const VALID_TIERS: TierName[] = ["warmup", "low", "medium", "high", "peak"];

// ---------------------------------------------------------------------------
// POST /load-test/run — run full load test
// ---------------------------------------------------------------------------
router.post("/load-test/run", async (req, res): Promise<void> => {
  const { loadTestId, serverBaseUrl, includeTiers, force } = req.body ?? {};

  const id = typeof loadTestId === "string" && loadTestId.trim()
    ? loadTestId.trim()
    : `e1-${randomUUID()}`;

  const tiers: TierName[] | undefined = Array.isArray(includeTiers)
    ? includeTiers.filter((t): t is TierName => VALID_TIERS.includes(t as TierName))
    : undefined;

  try {
    const bundle = await runLoadTest({
      loadTestId:    id,
      serverBaseUrl: typeof serverBaseUrl === "string" ? serverBaseUrl : "http://localhost:8080",
      includeTiers:  tiers,
      force:         !!force,
    });

    const r = bundle.loadTestReport;
    const s = bundle.scalabilityReport;

    res.status(200).json({
      loadTestId:                 bundle.loadTestId,
      generatedAt:                bundle.generatedAt,
      durationMs:                 bundle.durationMs,
      r2Keys:                     bundle.r2Keys,
      overallScore:               bundle.overallScore,
      loadGrade:                  bundle.loadGrade,
      maxSustainableConcurrency:  r.maxSustainableConcurrency,
      bottleneck:                 r.bottleneck,
      tiersRun:                   r.tiers.length,
      tierSummary:                r.tiers.map(t => ({
        tier: t.tier, concurrency: t.concurrency, mode: t.mode,
        score: t.score, throughputRps: t.throughputRps,
        p95Ms: t.latency.p95, cpuPct: t.cpu.utilizationPct,
        bottleneck: t.bottleneck,
      })),
      scalingMode:                s.scalingMode,
      recommendedMaxConcurrency:  s.recommendedMaxConcurrency,
      cliffConcurrency:           s.cliffConcurrency,
      summary:                    r.summary,
      recommendations:            r.recommendations,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "E1: load test failed");
    res.status(500).json({ error: "Load test failed", detail: msg });
  }
});

// ---------------------------------------------------------------------------
// POST /load-test/run/:tier — run a single tier
// ---------------------------------------------------------------------------
router.post("/load-test/run/:tier", async (req, res): Promise<void> => {
  const tier = req.params.tier as TierName;
  if (!VALID_TIERS.includes(tier)) {
    res.status(400).json({ error: `Invalid tier "${tier}". Valid: ${VALID_TIERS.join(", ")}` });
    return;
  }

  const { loadTestId, serverBaseUrl } = req.body ?? {};
  const id = typeof loadTestId === "string" && loadTestId.trim()
    ? loadTestId.trim()
    : `e1-${randomUUID()}`;

  try {
    const bundle = await runLoadTest({
      loadTestId:   id,
      serverBaseUrl: typeof serverBaseUrl === "string" ? serverBaseUrl : "http://localhost:8080",
      includeTiers: [tier],
    });

    const tierMetrics = bundle.loadTestReport.tiers[0];
    res.status(200).json({
      loadTestId: bundle.loadTestId,
      generatedAt: bundle.generatedAt,
      tier: tierMetrics?.tier,
      concurrency: tierMetrics?.concurrency,
      mode: tierMetrics?.mode,
      score: tierMetrics?.score,
      throughputRps: tierMetrics?.throughputRps,
      latency: tierMetrics?.latency,
      cpu: tierMetrics?.cpu,
      ram: tierMetrics?.ram,
      bottleneck: tierMetrics?.bottleneck,
      bottleneckDetail: tierMetrics?.bottleneckDetail,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err, tier }, "E1: single-tier test failed");
    res.status(500).json({ error: `Load test tier ${tier} failed`, detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /load-test
// ---------------------------------------------------------------------------
router.get("/load-test", (_req, res): void => {
  res.status(200).json(listE1Bundles());
});

// ---------------------------------------------------------------------------
// GET /load-test/:loadTestId — full bundle
// ---------------------------------------------------------------------------
router.get("/load-test/:loadTestId", (req, res): void => {
  const bundle = getE1Bundle(req.params.loadTestId!);
  if (!bundle) {
    res.status(404).json({ error: `No E1 load test found for id "${req.params.loadTestId}"` });
    return;
  }
  res.status(200).json(bundle);
});

// ---------------------------------------------------------------------------
// GET /load-test/:loadTestId/report — load-test-report.json
// ---------------------------------------------------------------------------
router.get("/load-test/:loadTestId/report", (req, res): void => {
  const bundle = getE1Bundle(req.params.loadTestId!);
  if (!bundle) { res.status(404).json({ error: `No E1 load test found for id "${req.params.loadTestId}"` }); return; }
  res.status(200).json(bundle.loadTestReport);
});

// ---------------------------------------------------------------------------
// GET /load-test/:loadTestId/history — performance-history.json
// ---------------------------------------------------------------------------
router.get("/load-test/:loadTestId/history", (req, res): void => {
  const bundle = getE1Bundle(req.params.loadTestId!);
  if (!bundle) { res.status(404).json({ error: `No E1 load test found for id "${req.params.loadTestId}"` }); return; }
  res.status(200).json(bundle.performanceHistory);
});

// ---------------------------------------------------------------------------
// GET /load-test/:loadTestId/scalability — scalability-report.json
// ---------------------------------------------------------------------------
router.get("/load-test/:loadTestId/scalability", (req, res): void => {
  const bundle = getE1Bundle(req.params.loadTestId!);
  if (!bundle) { res.status(404).json({ error: `No E1 load test found for id "${req.params.loadTestId}"` }); return; }
  res.status(200).json(bundle.scalabilityReport);
});

// ---------------------------------------------------------------------------
// GET /load-test/:loadTestId/score — score card
// ---------------------------------------------------------------------------
router.get("/load-test/:loadTestId/score", (req, res): void => {
  const bundle = getE1Bundle(req.params.loadTestId!);
  if (!bundle) { res.status(404).json({ error: `No E1 load test found for id "${req.params.loadTestId}"` }); return; }
  const r = bundle.loadTestReport;
  res.status(200).json({
    loadTestId:                bundle.loadTestId,
    generatedAt:               bundle.generatedAt,
    overallScore:              bundle.overallScore,
    loadGrade:                 bundle.loadGrade,
    maxSustainableConcurrency: r.maxSustainableConcurrency,
    scalingMode:               bundle.scalabilityReport.scalingMode,
    recommendedMaxConcurrency: bundle.scalabilityReport.recommendedMaxConcurrency,
    cliffConcurrency:          bundle.scalabilityReport.cliffConcurrency,
  });
});

// ---------------------------------------------------------------------------
// GET /load-test/:loadTestId/bottleneck
// ---------------------------------------------------------------------------
router.get("/load-test/:loadTestId/bottleneck", (req, res): void => {
  const bundle = getE1Bundle(req.params.loadTestId!);
  if (!bundle) { res.status(404).json({ error: `No E1 load test found for id "${req.params.loadTestId}"` }); return; }
  res.status(200).json({
    loadTestId:  bundle.loadTestId,
    generatedAt: bundle.generatedAt,
    bottleneck:  bundle.loadTestReport.bottleneck,
    recommendations: bundle.loadTestReport.recommendations,
  });
});

// ---------------------------------------------------------------------------
// GET /load-test/:loadTestId/tiers — all tiers
// ---------------------------------------------------------------------------
router.get("/load-test/:loadTestId/tiers", (req, res): void => {
  const bundle = getE1Bundle(req.params.loadTestId!);
  if (!bundle) { res.status(404).json({ error: `No E1 load test found for id "${req.params.loadTestId}"` }); return; }
  res.status(200).json({
    loadTestId: bundle.loadTestId,
    tiers:      bundle.loadTestReport.tiers,
  });
});

// ---------------------------------------------------------------------------
// GET /load-test/:loadTestId/tiers/:tier — single tier metrics
// ---------------------------------------------------------------------------
router.get("/load-test/:loadTestId/tiers/:tier", (req, res): void => {
  const bundle = getE1Bundle(req.params.loadTestId!);
  if (!bundle) { res.status(404).json({ error: `No E1 load test found for id "${req.params.loadTestId}"` }); return; }
  const tierMetrics = bundle.loadTestReport.tiers.find(t => t.tier === req.params.tier);
  if (!tierMetrics) {
    res.status(404).json({ error: `Tier "${req.params.tier}" not found in this load test run` });
    return;
  }
  res.status(200).json(tierMetrics);
});

export default router;
