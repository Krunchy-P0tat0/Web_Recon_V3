/**
 * production-readiness.ts — Phase 6.6 Production Readiness Validator routes
 *
 * Endpoints:
 *   POST /deploy/readiness          — Run a full production readiness check
 *   GET  /deploy/readiness          — Retrieve the latest report from disk
 *   GET  /deploy/readiness/latest   — Return the latest cached in-memory report
 *   GET  /deploy/readiness/score    — Quick score + classification (lightweight)
 */

import { Router, type IRouter }      from "express";
import { runProductionReadinessCheck } from "../lib/production-readiness-engine.js";
import { getDefaultCloudProvider }    from "../cloud/index.js";
import { readFile }                   from "fs/promises";
import { join }                       from "path";

const router: IRouter = Router();

// In-memory cache — one report per (jobId | "global")
const _reportCache = new Map<string, Awaited<ReturnType<typeof runProductionReadinessCheck>>>();

// ---------------------------------------------------------------------------
// POST /deploy/readiness — run full check
// ---------------------------------------------------------------------------

router.post("/deploy/readiness", async (req, res): Promise<void> => {
  const {
    jobId         = null,
    deploymentUrl = null,
    baseUrl,
  } = (req.body ?? {}) as {
    jobId?:         string | null;
    deploymentUrl?: string | null;
    baseUrl?:       string;
  };

  const internalBase =
    baseUrl ??
    `http://localhost:${process.env["PORT"] ?? 8080}`;

  req.log.info({ jobId, deploymentUrl, baseUrl: internalBase }, "READINESS: starting check via API");

  try {
    const cloud  = getDefaultCloudProvider();
    const report = await runProductionReadinessCheck({
      jobId,
      deploymentUrl,
      baseUrl: internalBase,
      cloudProvider: cloud,
    });

    const cacheKey = jobId ?? "global";
    _reportCache.set(cacheKey, report);

    const statusCode = report.deploymentAllowed ? 200 : 422;
    res.status(statusCode).json({ report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "READINESS: check failed");
    res.status(500).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /deploy/readiness — read from disk
// ---------------------------------------------------------------------------

router.get("/deploy/readiness", async (_req, res): Promise<void> => {
  const filePath = join(process.cwd(), "..", "..", "production-readiness-report.json");
  try {
    const raw    = await readFile(filePath, "utf8");
    const report = JSON.parse(raw);
    res.json({ report });
  } catch {
    // Fall back to in-memory cache
    const cached = Array.from(_reportCache.values()).sort(
      (a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime()
    )[0];

    if (cached) {
      res.json({ report: cached, source: "memory" });
      return;
    }

    res.status(404).json({
      error:  "No production-readiness-report.json found.",
      hint:   "POST /api/deploy/readiness to generate one.",
    });
  }
});

// ---------------------------------------------------------------------------
// GET /deploy/readiness/latest — latest cached report
// ---------------------------------------------------------------------------

router.get("/deploy/readiness/latest", (_req, res): void => {
  const reports = Array.from(_reportCache.values()).sort(
    (a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime()
  );

  if (reports.length === 0) {
    res.status(404).json({
      error: "No readiness report in memory. POST /api/deploy/readiness to generate one.",
    });
    return;
  }

  res.json({ report: reports[0] });
});

// ---------------------------------------------------------------------------
// GET /deploy/readiness/score — quick score snapshot
// ---------------------------------------------------------------------------

router.get("/deploy/readiness/score", async (_req, res): Promise<void> => {
  // Try memory first
  const cached = Array.from(_reportCache.values()).sort(
    (a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime()
  )[0];

  if (cached) {
    res.json({
      score:             cached.score,
      maxScore:          cached.maxScore,
      classification:    cached.classification,
      deploymentAllowed: cached.deploymentAllowed,
      generatedAt:       cached.generatedAt,
      blockerCount:      cached.blockers.length,
      warningCount:      cached.warnings.length,
    });
    return;
  }

  // Try disk
  const filePath = join(process.cwd(), "..", "..", "production-readiness-report.json");
  try {
    const raw  = await readFile(filePath, "utf8");
    const r    = JSON.parse(raw) as Awaited<ReturnType<typeof runProductionReadinessCheck>>;
    res.json({
      score:             r.score,
      maxScore:          r.maxScore,
      classification:    r.classification,
      deploymentAllowed: r.deploymentAllowed,
      generatedAt:       r.generatedAt,
      blockerCount:      r.blockers.length,
      warningCount:      r.warnings.length,
    });
  } catch {
    res.status(404).json({
      error: "No readiness score available. POST /api/deploy/readiness to generate.",
    });
  }
});

// ---------------------------------------------------------------------------
// GET /deploy/readiness/history — all cached reports
// ---------------------------------------------------------------------------

router.get("/deploy/readiness/history", (_req, res): void => {
  const reports = Array.from(_reportCache.values()).sort(
    (a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime()
  );
  res.json({
    total:   reports.length,
    reports: reports.map((r) => ({
      jobId:             r.jobId,
      score:             r.score,
      classification:    r.classification,
      deploymentAllowed: r.deploymentAllowed,
      generatedAt:       r.generatedAt,
    })),
  });
});

export default router;
