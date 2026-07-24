/**
 * merge-intelligence.ts — Phase 5.8 Backend Merge Intelligence routes
 *
 *   POST /merge/intelligence          — Run full Phase 5.8 merge analysis for a job
 *   GET  /merge/intelligence/:jobId   — Retrieve latest analysis report for a job
 *   GET  /merge/plan                  — Latest merge-plan.json (workspace root)
 *   GET  /merge/analysis              — Latest merge-analysis-report.json (workspace root)
 *   GET  /merge/risk/:jobId           — Risk score only
 */

import { readFile }   from "fs/promises";
import { join }       from "path";
import { existsSync } from "fs";
import { Router, type IRouter } from "express";
import { R2Provider }            from "../cloud/r2.provider.js";
import { runMergeIntelligence }  from "../lib/merge-intelligence.js";
import type { MergeIntelligenceReport } from "../lib/merge-intelligence.js";
import type { BackendProfile }   from "@workspace/backend-profiler";

const router: IRouter = Router();

const WORKSPACE_ROOT  = join(process.cwd(), "..", "..");
const WS_ANALYSIS     = join(WORKSPACE_ROOT, "merge-analysis-report.json");
const WS_PLAN         = join(WORKSPACE_ROOT, "merge-plan.json");

// In-memory cache keyed by jobId
const reportCache = new Map<string, MergeIntelligenceReport>();

// ── POST /merge/intelligence ──────────────────────────────────────────────────
// Body: { jobId: string, backendProfile?: BackendProfile }

router.post("/merge/intelligence", async (req, res): Promise<void> => {
  const { jobId, backendProfile } = req.body as {
    jobId?:          string;
    backendProfile?: BackendProfile;
  };

  if (!jobId || typeof jobId !== "string") {
    res.status(400).json({ error: "jobId (string) is required in the request body" });
    return;
  }

  const cloudProvider = new R2Provider();

  try {
    const report = await runMergeIntelligence(jobId, cloudProvider, backendProfile);
    reportCache.set(jobId, report);

    res.status(200).json({
      ok:             true,
      jobId,
      mergeRiskScore: report.risk.mergeRiskScore,
      summary:        report.summary,
      outputFiles:    report.outputFiles,
      durationMs:     report.durationMs,
    });
  } catch (err) {
    req.log.error({ err, jobId }, "MERGE-INTEL route: failed");
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ── GET /merge/intelligence/:jobId ────────────────────────────────────────────

router.get("/merge/intelligence/:jobId", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };

  const cached = reportCache.get(jobId);
  if (cached) {
    res.status(200).json(cached);
    return;
  }

  res.status(404).json({
    error: `No merge intelligence report for job ${jobId}. Run POST /api/merge/intelligence first.`,
  });
});

// ── GET /merge/analysis ───────────────────────────────────────────────────────

router.get("/merge/analysis", async (_req, res): Promise<void> => {
  if (!existsSync(WS_ANALYSIS)) {
    res.status(404).json({ error: "No merge-analysis-report.json found. Run POST /api/merge/intelligence first." });
    return;
  }
  try {
    const raw  = await readFile(WS_ANALYSIS, "utf8");
    const data = JSON.parse(raw) as unknown;
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to read merge-analysis-report.json" });
  }
});

// ── GET /merge/plan ───────────────────────────────────────────────────────────

router.get("/merge/plan", async (_req, res): Promise<void> => {
  if (!existsSync(WS_PLAN)) {
    res.status(404).json({ error: "No merge-plan.json found. Run POST /api/merge/intelligence first." });
    return;
  }
  try {
    const raw  = await readFile(WS_PLAN, "utf8");
    const data = JSON.parse(raw) as unknown;
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to read merge-plan.json" });
  }
});

// ── GET /merge/risk/:jobId ────────────────────────────────────────────────────

router.get("/merge/risk/:jobId", (req, res): void => {
  const { jobId } = req.params as { jobId: string };
  const cached = reportCache.get(jobId);

  if (!cached) {
    res.status(404).json({
      error: `No report for job ${jobId}. Run POST /api/merge/intelligence first.`,
    });
    return;
  }

  res.status(200).json({
    jobId,
    mergeRiskScore: cached.risk.mergeRiskScore,
    score:          cached.risk.score,
    factors:        cached.risk.factors,
    blockerCount:   cached.risk.blockerCount,
    errorCount:     cached.risk.errorCount,
    warningCount:   cached.risk.warningCount,
    summary:        cached.summary,
  });
});

export default router;
