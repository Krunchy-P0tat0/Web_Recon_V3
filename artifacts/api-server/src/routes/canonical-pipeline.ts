/**
 * canonical-pipeline.ts — CP-1 / CP-3 routes
 *
 *   GET  /api/canonical-pipeline/manifest       — full stage registry + deprecated list
 *   GET  /api/canonical-pipeline/stages         — canonical stages only
 *   GET  /api/canonical-pipeline/deprecated     — deprecated component list
 *   POST /api/canonical-pipeline/run            — execute canonical pipeline for a job
 *   GET  /api/canonical-pipeline/graph          — topological stage graph (JSON)
 *   GET  /api/canonical-pipeline/verify         — static + live pipeline verification (CP-3)
 *   GET  /api/canonical-pipeline/call-graph     — function call graph across all engines
 *   GET  /api/canonical-pipeline/dependency-report — DAG depth + consumer analysis
 */

import { Router, type IRouter } from "express";
import {
  getCanonicalPipelineManifest,
  buildStageGraph,
  topologicalSort,
  runCanonicalPipeline,
  CANONICAL_STAGES,
  DEPRECATED_COMPONENTS,
} from "../lib/canonical-pipeline-engine.js";
import {
  runPipelineVerification,
  buildCallGraph,
  buildDependencyReport,
} from "../lib/pipeline-verification-engine.js";

const router: IRouter = Router();

// GET /canonical-pipeline/manifest
router.get("/canonical-pipeline/manifest", async (_req, res): Promise<void> => {
  const manifest = await getCanonicalPipelineManifest();
  res.json({
    schemaVersion: "CP-1",
    generatedAt:   new Date().toISOString(),
    ...manifest,
  });
});

// GET /canonical-pipeline/stages
router.get("/canonical-pipeline/stages", (_req, res): void => {
  res.json({
    version:     "CP-1",
    generatedAt: new Date().toISOString(),
    count:       CANONICAL_STAGES.length,
    stages:      CANONICAL_STAGES,
  });
});

// GET /canonical-pipeline/deprecated
router.get("/canonical-pipeline/deprecated", (_req, res): void => {
  res.json({
    version:       "CP-1",
    generatedAt:   new Date().toISOString(),
    count:         DEPRECATED_COMPONENTS.length,
    deprecated:    DEPRECATED_COMPONENTS,
  });
});

// GET /canonical-pipeline/graph
router.get("/canonical-pipeline/graph", (req, res): void => {
  const includeOptional = req.query?.optional !== "false";
  const stages   = buildStageGraph(!includeOptional);
  const ordered  = topologicalSort(stages);
  const edges    = ordered.flatMap(s =>
    s.dependsOn.map(dep => ({ from: dep, to: s.id }))
  );
  res.json({
    version:     "CP-1",
    generatedAt: new Date().toISOString(),
    nodes:       ordered.map(s => ({
      id:       s.id,
      name:     s.name,
      phase:    s.phase,
      engine:   s.engine,
      optional: s.optional,
    })),
    edges,
  });
});

// POST /canonical-pipeline/run  { sourceJobId, skipOptional?, targetFidelity?, maxIterations? }
router.post("/canonical-pipeline/run", async (req, res): Promise<void> => {
  const { sourceJobId, skipOptional, targetFidelity, maxIterations } = req.body ?? {};

  if (!sourceJobId || typeof sourceJobId !== "string") {
    res.status(400).json({ error: "sourceJobId (string) is required" });
    return;
  }

  const report = await runCanonicalPipeline({
    sourceJobId,
    skipOptional:   skipOptional  === true,
    targetFidelity: typeof targetFidelity === "number" ? targetFidelity : undefined,
    maxIterations:  typeof maxIterations  === "number" ? maxIterations  : undefined,
  });

  res.status(report.failedCount > 0 ? 207 : 200).json(report);
});

// GET /canonical-pipeline/verify  — CP-3 pipeline verification (static + live probe)
router.get("/canonical-pipeline/verify", async (_req, res): Promise<void> => {
  try {
    const report = await runPipelineVerification();
    const httpStatus = report.overallStatus === "FAIL" ? 207 : 200;
    res.status(httpStatus).json(report);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /canonical-pipeline/call-graph
router.get("/canonical-pipeline/call-graph", (_req, res): void => {
  res.json(buildCallGraph());
});

// GET /canonical-pipeline/dependency-report
router.get("/canonical-pipeline/dependency-report", (_req, res): void => {
  res.json(buildDependencyReport());
});

export default router;
