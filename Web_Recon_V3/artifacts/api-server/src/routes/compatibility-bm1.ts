/**
 * compatibility-bm1.ts — Phase BM-1: Compatibility Engine Routes
 *
 * POST /api/compatibility-bm1/:primeJobId/analyze
 *   Run the compatibility analysis.
 *   Body (all optional except when providing a full backendProfile):
 *   {
 *     backendJobId?:    string,
 *     force?:           boolean,
 *     backendProfile?:  ExistingBackendProfile,   // full profile override
 *     primeProfile?:    Partial<WebsitePrimeProfile>, // partial prime override
 *   }
 *   Returns: full CompatibilityReport
 *
 * GET  /api/compatibility-bm1/:primeJobId/report
 *   Full compatibility-report.json with all dimensions and candidates.
 *
 * GET  /api/compatibility-bm1/:primeJobId/score
 *   Quick summary: { compatibilityScore, grade, overallClassification,
 *     readyToMerge, safeCount, warningCount, blockedCount }
 *
 * GET  /api/compatibility-bm1/:primeJobId/conflicts
 *   All WARNING + BLOCKED merge candidates.
 *   Query: ?dimension=routes|database|authentication|storage|cms|apiLayer|frontendFramework
 *          ?severity=critical|high|medium|low
 *
 * GET  /api/compatibility-bm1/:primeJobId/safe
 *   All SAFE merge candidates.
 *
 * GET  /api/compatibility-bm1/:primeJobId/risky
 *   All WARNING merge candidates.
 *
 * GET  /api/compatibility-bm1/:primeJobId/blocked
 *   All BLOCKED merge candidates (the ones that prevent merging).
 *
 * GET  /api/compatibility-bm1/:primeJobId/dimensions
 *   Per-dimension breakdown: score, classification, candidate counts, notes.
 *
 * GET  /api/compatibility-bm1/:primeJobId/dimensions/:dimension
 *   Full detail for one dimension (routes|database|authentication|storage|
 *   cms|apiLayer|frontendFramework).
 */

import { Router, type IRouter } from "express";
import {
  runCompatibilityEngine,
  getCachedCompatibilityReport,
  type CompatibilityReport,
  type CompatibilityDimension,
  type ExistingBackendProfile,
  type WebsitePrimeProfile,
} from "../lib/compatibility-engine-bm1.js";

const router: IRouter = Router();

const VALID_DIMENSIONS = new Set<CompatibilityDimension>([
  "routes", "database", "authentication", "storage",
  "cms", "apiLayer", "frontendFramework",
]);

// ── Helper ───────────────────────────────────────────────────────────────────

function requireReport(
  primeJobId: string,
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): CompatibilityReport | null {
  const report = getCachedCompatibilityReport(primeJobId);
  if (!report) {
    res.status(404).json({
      error: "No BM-1 compatibility report found for this primeJobId.",
      hint:  `POST /api/compatibility-bm1/${primeJobId}/analyze to run Phase BM-1.`,
    });
    return null;
  }
  return report;
}

// ── POST /api/compatibility-bm1/:primeJobId/analyze ──────────────────────────

router.post("/compatibility-bm1/:primeJobId/analyze", async (req, res): Promise<void> => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  if (!primeJobId) { res.status(400).json({ error: "primeJobId is required" }); return; }

  const body           = (req.body ?? {}) as Record<string, unknown>;
  const backendJobId   = typeof body["backendJobId"] === "string" ? body["backendJobId"].trim() : undefined;
  const force          = body["force"] === true;
  const backendProfile = body["backendProfile"] as ExistingBackendProfile | undefined;
  const primeOverride  = body["primeProfile"]  as Partial<WebsitePrimeProfile> | undefined;

  req.log.info({ primeJobId, backendJobId, force }, "BM1: analyze requested");

  try {
    const report = await runCompatibilityEngine({
      primeJobId,
      backendJobId,
      force,
      backendProfile,
      primeProfile: primeOverride,
    });
    res.status(200).json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err, primeJobId }, "BM1: analyze failed");
    res.status(500).json({ error: "BM-1 compatibility analysis failed", detail: message });
  }
});

// ── GET /api/compatibility-bm1/:primeJobId/report ────────────────────────────

router.get("/compatibility-bm1/:primeJobId/report", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (report) res.status(200).json(report);
});

// ── GET /api/compatibility-bm1/:primeJobId/score ─────────────────────────────

router.get("/compatibility-bm1/:primeJobId/score", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  res.status(200).json({
    primeJobId,
    backendJobId:          report.backendJobId,
    generatedAt:           report.generatedAt,
    compatibilityScore:    report.compatibilityScore,
    grade:                 report.grade,
    overallClassification: report.overallClassification,
    readyToMerge:          report.summary.readyToMerge,
    safeCount:             report.summary.safeCount,
    warningCount:          report.summary.warningCount,
    blockedCount:          report.summary.blockedCount,
    autoResolvable:        report.summary.autoResolvable,
    requiresManual:        report.summary.requiresManual,
    criticalBlocks:        report.summary.criticalBlocks,
  });
});

// ── GET /api/compatibility-bm1/:primeJobId/conflicts ─────────────────────────

router.get("/compatibility-bm1/:primeJobId/conflicts", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const dim      = req.query["dimension"] as string | undefined;
  const severity = req.query["severity"]  as string | undefined;

  let conflicts = report.conflicts;
  if (dim)      conflicts = conflicts.filter(c => c.dimension === dim);
  if (severity) conflicts = conflicts.filter(c => c.severity  === severity);

  res.status(200).json({
    primeJobId,
    totalConflicts:    report.conflicts.length,
    filteredConflicts: conflicts.length,
    filters:           { dimension: dim ?? null, severity: severity ?? null },
    overallClassification: report.overallClassification,
    readyToMerge:      report.summary.readyToMerge,
    conflicts,
  });
});

// ── GET /api/compatibility-bm1/:primeJobId/safe ───────────────────────────────

router.get("/compatibility-bm1/:primeJobId/safe", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const dim = req.query["dimension"] as string | undefined;
  const safe = dim ? report.safeMerges.filter(c => c.dimension === dim) : report.safeMerges;

  res.status(200).json({
    primeJobId,
    totalSafe:    report.safeMerges.length,
    filtered:     safe.length,
    filter:       { dimension: dim ?? null },
    safeMerges:   safe,
  });
});

// ── GET /api/compatibility-bm1/:primeJobId/risky ──────────────────────────────

router.get("/compatibility-bm1/:primeJobId/risky", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const dim   = req.query["dimension"] as string | undefined;
  const risky = dim ? report.riskyMerges.filter(c => c.dimension === dim) : report.riskyMerges;

  res.status(200).json({
    primeJobId,
    totalRisky:   report.riskyMerges.length,
    filtered:     risky.length,
    filter:       { dimension: dim ?? null },
    riskyMerges:  risky,
  });
});

// ── GET /api/compatibility-bm1/:primeJobId/blocked ───────────────────────────

router.get("/compatibility-bm1/:primeJobId/blocked", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const dim     = req.query["dimension"] as string | undefined;
  const blocked = dim ? report.blockedMerges.filter(c => c.dimension === dim) : report.blockedMerges;

  res.status(200).json({
    primeJobId,
    readyToMerge:   report.summary.readyToMerge,
    totalBlocked:   report.blockedMerges.length,
    filtered:       blocked.length,
    filter:         { dimension: dim ?? null },
    criticalBlocks: report.summary.criticalBlocks,
    blockedMerges:  blocked,
  });
});

// ── GET /api/compatibility-bm1/:primeJobId/dimensions ────────────────────────

router.get("/compatibility-bm1/:primeJobId/dimensions", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const summary = Object.entries(report.dimensions).map(([dim, d]) => ({
    dimension:      dim,
    score:          d.score,
    classification: d.classification,
    safeCount:      d.safe.length,
    warningCount:   d.risky.length,
    blockedCount:   d.blocked.length,
    totalCandidates: d.candidates.length,
    confidence:     d.confidence,
    notes:          d.notes,
  }));

  res.status(200).json({
    primeJobId,
    compatibilityScore:    report.compatibilityScore,
    overallClassification: report.overallClassification,
    readyToMerge:          report.summary.readyToMerge,
    dimensions:            summary,
  });
});

// ── GET /api/compatibility-bm1/:primeJobId/dimensions/:dimension ─────────────

router.get("/compatibility-bm1/:primeJobId/dimensions/:dimension", (req, res): void => {
  const p          = req.params as Record<string, string>;
  const primeJobId = p["primeJobId"] ?? "";
  const dim        = p["dimension"]  ?? "";

  if (!VALID_DIMENSIONS.has(dim as CompatibilityDimension)) {
    res.status(400).json({
      error:  `Invalid dimension "${dim}"`,
      valid:  [...VALID_DIMENSIONS],
    });
    return;
  }

  const report = requireReport(primeJobId, res);
  if (!report) return;

  const result = report.dimensions[dim as CompatibilityDimension];
  res.status(200).json({
    primeJobId,
    ...result,
  });
});

export default router;
