/**
 * api-contract-validation-d4.ts — Phase D4 Routes
 *
 * POST /api-validation/run                          — run full D4 contract validation
 * GET  /api-validation                              — list all validation runs
 * GET  /api-validation/:validationId                — full D4 bundle
 * GET  /api-validation/:validationId/report         — api-validation-report.json
 * GET  /api-validation/:validationId/drift          — contract-drift-report.json
 * GET  /api-validation/:validationId/health         — endpoint-health-report.json
 * GET  /api-validation/:validationId/score          — compatibility score + grade
 * GET  /api-validation/:validationId/endpoints      — paginated endpoint results
 * GET  /api-validation/:validationId/endpoints/failed — failed endpoints only
 */

import { Router, type IRouter } from "express";
import { randomUUID }            from "crypto";
import {
  runApiContractValidation,
  getD4Bundle,
  listD4Bundles,
} from "../lib/api-contract-validation-engine-d4.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /api-validation/run
// ---------------------------------------------------------------------------
router.post("/api-validation/run", async (req, res): Promise<void> => {
  const {
    validationId,
    primePath,
    backendUrl,
    openApiPath,
    liveEndpoints,
    d3ExecutionId,
    force,
  } = req.body ?? {};

  const id = typeof validationId === "string" && validationId.trim()
    ? validationId.trim()
    : `d4-${randomUUID()}`;

  try {
    const bundle = await runApiContractValidation({
      validationId: id,
      primePath:    typeof primePath   === "string" ? primePath   : undefined,
      backendUrl:   typeof backendUrl  === "string" ? backendUrl  : undefined,
      openApiPath:  typeof openApiPath === "string" ? openApiPath : undefined,
      liveEndpoints: Array.isArray(liveEndpoints) ? liveEndpoints : undefined,
      d3ExecutionId: typeof d3ExecutionId === "string" ? d3ExecutionId : undefined,
      force:         !!force,
    });

    const r = bundle.apiValidationReport;
    const d = bundle.contractDriftReport;
    const h = bundle.endpointHealthReport;

    res.status(200).json({
      validationId:          bundle.validationId,
      generatedAt:           bundle.generatedAt,
      durationMs:            bundle.durationMs,
      r2Keys:                bundle.r2Keys,
      apiCompatibilityScore: bundle.apiCompatibilityScore,
      grade:                 r.grade,
      rating:                r.rating,
      totalEndpoints:        r.totalEndpoints,
      passed:                r.passed,
      warned:                r.warned,
      failed:                r.failed,
      skipped:               r.skipped,
      openApiEndpointsFound: r.openApiEndpointsFound,
      liveEndpointsFound:    r.liveEndpointsFound,
      totalDrifts:           d.totalDrifts,
      driftScore:            d.driftScore,
      overallHealthScore:    h.overallHealthScore,
      totalGroups:           h.totalGroups,
      healthyGroups:         h.healthyGroups,
      degradedGroups:        h.degradedGroups,
      unhealthyGroups:       h.unhealthyGroups,
      blockers:              r.blockers,
      recommendations:       r.recommendations,
      summary:               r.summary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "D4: validation run failed");
    res.status(500).json({ error: "API contract validation failed", detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /api-validation
// ---------------------------------------------------------------------------
router.get("/api-validation", (_req, res): void => {
  res.status(200).json(listD4Bundles());
});

// ---------------------------------------------------------------------------
// GET /api-validation/:validationId — full bundle
// ---------------------------------------------------------------------------
router.get("/api-validation/:validationId", (req, res): void => {
  const bundle = getD4Bundle(req.params.validationId!);
  if (!bundle) {
    res.status(404).json({ error: `No D4 validation found for id "${req.params.validationId}"` });
    return;
  }
  res.status(200).json(bundle);
});

// ---------------------------------------------------------------------------
// GET /api-validation/:validationId/report — api-validation-report.json
// ---------------------------------------------------------------------------
router.get("/api-validation/:validationId/report", (req, res): void => {
  const bundle = getD4Bundle(req.params.validationId!);
  if (!bundle) {
    res.status(404).json({ error: `No D4 validation found for id "${req.params.validationId}"` });
    return;
  }
  res.status(200).json(bundle.apiValidationReport);
});

// ---------------------------------------------------------------------------
// GET /api-validation/:validationId/drift — contract-drift-report.json
// ---------------------------------------------------------------------------
router.get("/api-validation/:validationId/drift", (req, res): void => {
  const bundle = getD4Bundle(req.params.validationId!);
  if (!bundle) {
    res.status(404).json({ error: `No D4 validation found for id "${req.params.validationId}"` });
    return;
  }
  res.status(200).json(bundle.contractDriftReport);
});

// ---------------------------------------------------------------------------
// GET /api-validation/:validationId/health — endpoint-health-report.json
// ---------------------------------------------------------------------------
router.get("/api-validation/:validationId/health", (req, res): void => {
  const bundle = getD4Bundle(req.params.validationId!);
  if (!bundle) {
    res.status(404).json({ error: `No D4 validation found for id "${req.params.validationId}"` });
    return;
  }
  res.status(200).json(bundle.endpointHealthReport);
});

// ---------------------------------------------------------------------------
// GET /api-validation/:validationId/score — compatibility score summary
// ---------------------------------------------------------------------------
router.get("/api-validation/:validationId/score", (req, res): void => {
  const bundle = getD4Bundle(req.params.validationId!);
  if (!bundle) {
    res.status(404).json({ error: `No D4 validation found for id "${req.params.validationId}"` });
    return;
  }
  const r = bundle.apiValidationReport;
  res.status(200).json({
    validationId:          bundle.validationId,
    generatedAt:           bundle.generatedAt,
    apiCompatibilityScore: bundle.apiCompatibilityScore,
    grade:                 r.grade,
    rating:                r.rating,
    passed:                r.passed,
    warned:                r.warned,
    failed:                r.failed,
    totalEndpoints:        r.totalEndpoints,
    driftScore:            bundle.contractDriftReport.driftScore,
    overallHealthScore:    bundle.endpointHealthReport.overallHealthScore,
  });
});

// ---------------------------------------------------------------------------
// GET /api-validation/:validationId/endpoints?page=1&limit=50
// ---------------------------------------------------------------------------
router.get("/api-validation/:validationId/endpoints", (req, res): void => {
  const bundle = getD4Bundle(req.params.validationId!);
  if (!bundle) {
    res.status(404).json({ error: `No D4 validation found for id "${req.params.validationId}"` });
    return;
  }

  const page    = Math.max(1, parseInt(String(req.query["page"]  ?? "1"),  10));
  const limit   = Math.min(200, Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10)));
  const results = bundle.apiValidationReport.results;
  const start   = (page - 1) * limit;

  res.status(200).json({
    validationId: bundle.validationId,
    total:        results.length,
    page, limit,
    totalPages:   Math.ceil(results.length / limit),
    results:      results.slice(start, start + limit),
  });
});

// ---------------------------------------------------------------------------
// GET /api-validation/:validationId/endpoints/failed
// ---------------------------------------------------------------------------
router.get("/api-validation/:validationId/endpoints/failed", (req, res): void => {
  const bundle = getD4Bundle(req.params.validationId!);
  if (!bundle) {
    res.status(404).json({ error: `No D4 validation found for id "${req.params.validationId}"` });
    return;
  }
  const failed = bundle.apiValidationReport.results.filter(r => r.overallStatus === "FAIL");
  res.status(200).json({
    validationId: bundle.validationId,
    count:        failed.length,
    results:      failed,
  });
});

export default router;
