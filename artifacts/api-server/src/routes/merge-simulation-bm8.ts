/**
 * merge-simulation-bm8.ts — Phase BM-8: Merge Simulation Engine Routes
 *
 * POST /api/merge-simulation-bm8/:primeJobId/simulate
 *   Run the merge simulation.
 *   Body:
 *   {
 *     backendJobId?: string,
 *     force?:        boolean,
 *     routes?:       Array<{path,methods,source:"prime"|"backend"}>,
 *     schemas?:      Array<{table,columns,source:"prime"|"backend"}>,
 *     assets?:       Array<{path,size?,source:"prime"|"backend"}>,
 *     components?:   Array<{name,kind,classification?}>,
 *     endpoints?:    Array<{path,methods,classification?}>,
 *   }
 *   Returns: full MergeSimulationReport
 *
 * GET  /api/merge-simulation-bm8/:primeJobId/report
 *   Full merge-simulation-report.json
 *
 * GET  /api/merge-simulation-bm8/:primeJobId/score
 *   Quick summary: { riskScore, riskGrade, canProceed, conflictCount,
 *     warningCount, safeCount, recommendation }
 *
 * GET  /api/merge-simulation-bm8/:primeJobId/conflicts
 *   All simulation conflicts, filterable by dimension and severity.
 *   Query: ?dimension=routes|database|assets|components|apis
 *          ?severity=critical|high|medium|low
 *          ?blocking=true|false
 *
 * GET  /api/merge-simulation-bm8/:primeJobId/warnings
 *   All simulation warnings, filterable by dimension and severity.
 *
 * GET  /api/merge-simulation-bm8/:primeJobId/safe
 *   All safe operations, filterable by dimension.
 *
 * GET  /api/merge-simulation-bm8/:primeJobId/dimensions
 *   Per-dimension breakdown: status, risk, counts.
 *
 * GET  /api/merge-simulation-bm8/:primeJobId/dimensions/:dimension
 *   Full detail for one dimension.
 *
 * GET  /api/merge-simulation-bm8/:primeJobId/execution-order
 *   Recommended safe execution order and estimated duration.
 */

import { Router, type IRouter } from "express";
import {
  runMergeSimulationEngine,
  getCachedMergeSimulationReport,
  type MergeSimulationReport,
  type SimulationDimension,
  type SimulationSeverity,
} from "../lib/merge-simulation-engine-bm8.js";

const router: IRouter = Router();

const VALID_DIMENSIONS: Set<SimulationDimension> = new Set(["routes", "database", "assets", "components", "apis"]);
const VALID_SEVERITIES: Set<SimulationSeverity>  = new Set(["critical", "high", "medium", "low"]);

// ── Helper ────────────────────────────────────────────────────────────────────

function requireReport(
  primeJobId: string,
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): MergeSimulationReport | null {
  const report = getCachedMergeSimulationReport(primeJobId);
  if (!report) {
    res.status(404).json({
      error: "No BM-8 simulation report found for this primeJobId.",
      hint:  `POST /api/merge-simulation-bm8/${primeJobId}/simulate to run Phase BM-8.`,
    });
    return null;
  }
  return report;
}

// ── POST /api/merge-simulation-bm8/:primeJobId/simulate ──────────────────────

router.post("/merge-simulation-bm8/:primeJobId/simulate", async (req, res): Promise<void> => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  if (!primeJobId) { res.status(400).json({ error: "primeJobId is required" }); return; }

  const body        = (req.body ?? {}) as Record<string, unknown>;
  const backendJobId = typeof body["backendJobId"] === "string" ? body["backendJobId"].trim() : undefined;
  const force        = body["force"] === true;

  req.log.info({ primeJobId, backendJobId, force }, "BM8: simulate requested");

  try {
    const report = await runMergeSimulationEngine({
      primeJobId,
      backendJobId,
      force,
      routes:     Array.isArray(body["routes"])     ? body["routes"]     as any : undefined,
      schemas:    Array.isArray(body["schemas"])    ? body["schemas"]    as any : undefined,
      assets:     Array.isArray(body["assets"])     ? body["assets"]     as any : undefined,
      components: Array.isArray(body["components"]) ? body["components"] as any : undefined,
      endpoints:  Array.isArray(body["endpoints"])  ? body["endpoints"]  as any : undefined,
    });
    res.status(200).json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err, primeJobId }, "BM8: simulate failed");
    res.status(500).json({ error: "BM-8 merge simulation failed", detail: message });
  }
});

// ── GET /api/merge-simulation-bm8/:primeJobId/report ─────────────────────────

router.get("/merge-simulation-bm8/:primeJobId/report", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (report) res.status(200).json(report);
});

// ── GET /api/merge-simulation-bm8/:primeJobId/score ──────────────────────────

router.get("/merge-simulation-bm8/:primeJobId/score", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  res.status(200).json({
    primeJobId,
    simulationId:     report.simulationId,
    generatedAt:      report.generatedAt,
    riskScore:        report.riskScore,
    riskGrade:        report.riskGrade,
    canProceed:       report.canProceed,
    conflictCount:    report.summary.conflictCount,
    warningCount:     report.summary.warningCount,
    safeCount:        report.summary.safeCount,
    autoResolvable:   report.summary.autoResolvable,
    requiresManual:   report.summary.requiresManual,
    blockingConflicts: report.summary.blockingConflicts,
    criticalConflicts: report.summary.criticalConflicts,
    estimatedMergeMs: report.estimatedMergeMs,
    recommendation:   report.summary.recommendation,
  });
});

// ── GET /api/merge-simulation-bm8/:primeJobId/conflicts ──────────────────────

router.get("/merge-simulation-bm8/:primeJobId/conflicts", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const dimFilter      = req.query["dimension"] as string | undefined;
  const sevFilter      = req.query["severity"]  as string | undefined;
  const blockingFilter = req.query["blocking"]  as string | undefined;

  if (dimFilter && !VALID_DIMENSIONS.has(dimFilter as SimulationDimension)) {
    res.status(400).json({ error: `Invalid dimension "${dimFilter}"`, valid: [...VALID_DIMENSIONS] });
    return;
  }
  if (sevFilter && !VALID_SEVERITIES.has(sevFilter as SimulationSeverity)) {
    res.status(400).json({ error: `Invalid severity "${sevFilter}"`, valid: [...VALID_SEVERITIES] });
    return;
  }

  let items = report.conflicts;
  if (dimFilter)              items = items.filter(c => c.dimension === dimFilter);
  if (sevFilter)              items = items.filter(c => c.severity  === sevFilter);
  if (blockingFilter === "true")  items = items.filter(c =>  c.blocksExecution);
  if (blockingFilter === "false") items = items.filter(c => !c.blocksExecution);

  res.status(200).json({
    primeJobId,
    total:     report.conflicts.length,
    filtered:  items.length,
    filters:   { dimension: dimFilter ?? null, severity: sevFilter ?? null, blocking: blockingFilter ?? null },
    canProceed: report.canProceed,
    conflicts:  items,
  });
});

// ── GET /api/merge-simulation-bm8/:primeJobId/warnings ───────────────────────

router.get("/merge-simulation-bm8/:primeJobId/warnings", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const dimFilter = req.query["dimension"] as string | undefined;
  const sevFilter = req.query["severity"]  as string | undefined;

  if (dimFilter && !VALID_DIMENSIONS.has(dimFilter as SimulationDimension)) {
    res.status(400).json({ error: `Invalid dimension "${dimFilter}"`, valid: [...VALID_DIMENSIONS] });
    return;
  }

  let items = report.warnings;
  if (dimFilter) items = items.filter(w => w.dimension === dimFilter);
  if (sevFilter) items = items.filter(w => w.severity  === sevFilter);

  res.status(200).json({
    primeJobId,
    total:    report.warnings.length,
    filtered: items.length,
    filters:  { dimension: dimFilter ?? null, severity: sevFilter ?? null },
    requiresManualReview: items.filter(w => w.requiresManualReview).length,
    warnings: items,
  });
});

// ── GET /api/merge-simulation-bm8/:primeJobId/safe ───────────────────────────

router.get("/merge-simulation-bm8/:primeJobId/safe", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const dimFilter = req.query["dimension"] as string | undefined;
  const items     = dimFilter
    ? report.safeOperations.filter(op => op.dimension === dimFilter)
    : report.safeOperations;

  res.status(200).json({
    primeJobId,
    total:            report.safeOperations.length,
    filtered:         items.length,
    filter:           { dimension: dimFilter ?? null },
    estimatedTotalMs: items.reduce((s, op) => s + op.estimatedMs, 0),
    operations:       items,
  });
});

// ── GET /api/merge-simulation-bm8/:primeJobId/dimensions ─────────────────────

router.get("/merge-simulation-bm8/:primeJobId/dimensions", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const summary = Object.entries(report.dimensions).map(([dim, d]) => ({
    dimension:     dim,
    status:        d.status,
    dimensionRisk: d.dimensionRisk,
    conflictCount: d.conflicts.length,
    warningCount:  d.warnings.length,
    safeCount:     d.safeOperations.length,
    notes:         d.simulationNotes,
  }));

  res.status(200).json({
    primeJobId,
    riskScore:  report.riskScore,
    canProceed: report.canProceed,
    dimensions: summary,
  });
});

// ── GET /api/merge-simulation-bm8/:primeJobId/dimensions/:dimension ───────────

router.get("/merge-simulation-bm8/:primeJobId/dimensions/:dimension", (req, res): void => {
  const p          = req.params as Record<string, string>;
  const primeJobId = p["primeJobId"] ?? "";
  const dim        = p["dimension"]  ?? "";

  if (!VALID_DIMENSIONS.has(dim as SimulationDimension)) {
    res.status(400).json({ error: `Invalid dimension "${dim}"`, valid: [...VALID_DIMENSIONS] });
    return;
  }

  const report = requireReport(primeJobId, res);
  if (!report) return;

  res.status(200).json({ primeJobId, ...report.dimensions[dim as SimulationDimension] });
});

// ── GET /api/merge-simulation-bm8/:primeJobId/execution-order ────────────────

router.get("/merge-simulation-bm8/:primeJobId/execution-order", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  res.status(200).json({
    primeJobId,
    canProceed:       report.canProceed,
    riskScore:        report.riskScore,
    estimatedMergeMs: report.estimatedMergeMs,
    executionOrder:   report.executionOrder,
    safeOperations:   report.safeOperations,
  });
});

export default router;
