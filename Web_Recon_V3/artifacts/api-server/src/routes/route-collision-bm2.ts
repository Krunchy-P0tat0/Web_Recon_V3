/**
 * route-collision-bm2.ts — Phase BM-2: Route Collision Engine Routes
 *
 * POST /api/route-collision-bm2/:primeJobId/analyze
 *   Run route collision detection.
 *   Body: { primeRoutes: RouteEntry[], backendRoutes: RouteEntry[],
 *           backendJobId?: string, force?: boolean }
 *   Returns: full RouteCollisionReport
 *
 * GET  /api/route-collision-bm2/:primeJobId/report
 *   Full route-collision-report.json
 *
 * GET  /api/route-collision-bm2/:primeJobId/summary
 *   Counts only: safe, rename, merge, block, silentOverwriteRisk
 *
 * GET  /api/route-collision-bm2/:primeJobId/safe
 *   All SAFE route assessments
 *
 * GET  /api/route-collision-bm2/:primeJobId/rename
 *   All RENAME assessments (including suggestedPath)
 *
 * GET  /api/route-collision-bm2/:primeJobId/merge
 *   All MERGE assessments
 *
 * GET  /api/route-collision-bm2/:primeJobId/block
 *   All BLOCK assessments — hard collisions that prevent merge
 *
 * GET  /api/route-collision-bm2/:primeJobId/collisions
 *   All detected collisions (non-SAFE), filterable by kind and resolution
 *   Query: ?kind=exact|wildcard|parameter|api
 *          ?resolution=RENAME|MERGE|BLOCK
 *
 * GET  /api/route-collision-bm2/:primeJobId/collisions/:id
 *   Single collision by ID (e.g. COL-0001)
 */

import { Router, type IRouter } from "express";
import {
  runRouteCollisionEngine,
  getCachedRouteCollisionReport,
  type RouteCollisionReport,
  type RouteEntry,
  type CollisionKind,
  type CollisionResolution,
} from "../lib/route-collision-engine-bm2.js";

const router: IRouter = Router();

const VALID_KINDS:        Set<CollisionKind>       = new Set(["exact", "wildcard", "parameter", "api"]);
const VALID_RESOLUTIONS:  Set<CollisionResolution>  = new Set(["SAFE", "RENAME", "MERGE", "BLOCK"]);

// ── Helper ───────────────────────────────────────────────────────────────────

function requireReport(
  primeJobId: string,
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): RouteCollisionReport | null {
  const report = getCachedRouteCollisionReport(primeJobId);
  if (!report) {
    res.status(404).json({
      error: "No BM-2 route collision report found for this primeJobId.",
      hint:  `POST /api/route-collision-bm2/${primeJobId}/analyze to run Phase BM-2.`,
    });
    return null;
  }
  return report;
}

// ── POST /api/route-collision-bm2/:primeJobId/analyze ────────────────────────

router.post("/route-collision-bm2/:primeJobId/analyze", async (req, res): Promise<void> => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  if (!primeJobId) { res.status(400).json({ error: "primeJobId is required" }); return; }

  const body         = (req.body ?? {}) as Record<string, unknown>;
  const primeRoutes  = body["primeRoutes"]  as RouteEntry[] | undefined;
  const backendRoutes = body["backendRoutes"] as RouteEntry[] | undefined;
  const backendJobId = typeof body["backendJobId"] === "string" ? body["backendJobId"].trim() : undefined;
  const force        = body["force"] === true;

  if (!Array.isArray(primeRoutes)) {
    res.status(400).json({ error: "primeRoutes is required and must be an array of RouteEntry objects" });
    return;
  }
  if (!Array.isArray(backendRoutes)) {
    res.status(400).json({ error: "backendRoutes is required and must be an array of RouteEntry objects" });
    return;
  }

  // Validate each route entry has at least path + methods
  for (const r of primeRoutes) {
    if (typeof r.path !== "string" || !Array.isArray(r.methods)) {
      res.status(400).json({ error: "Each primeRoute must have { path: string, methods: string[] }" });
      return;
    }
  }
  for (const r of backendRoutes) {
    if (typeof r.path !== "string" || !Array.isArray(r.methods)) {
      res.status(400).json({ error: "Each backendRoute must have { path: string, methods: string[] }" });
      return;
    }
  }

  req.log.info({ primeJobId, backendJobId, primeCount: primeRoutes.length, backendCount: backendRoutes.length }, "BM2: analyze requested");

  try {
    const report = await runRouteCollisionEngine({ primeJobId, backendJobId, primeRoutes, backendRoutes, force });
    res.status(200).json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err, primeJobId }, "BM2: analyze failed");
    res.status(500).json({ error: "BM-2 route collision analysis failed", detail: message });
  }
});

// ── GET /api/route-collision-bm2/:primeJobId/report ──────────────────────────

router.get("/route-collision-bm2/:primeJobId/report", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (report) res.status(200).json(report);
});

// ── GET /api/route-collision-bm2/:primeJobId/summary ─────────────────────────

router.get("/route-collision-bm2/:primeJobId/summary", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  res.status(200).json({
    primeJobId,
    backendJobId:        report.backendJobId,
    generatedAt:         report.generatedAt,
    totalPrimeRoutes:    report.totalPrimeRoutes,
    totalBackendRoutes:  report.totalBackendRoutes,
    safeCount:           report.safeCount,
    renameCount:         report.renameCount,
    mergeCount:          report.mergeCount,
    blockCount:          report.blockCount,
    silentOverwriteRisk: report.silentOverwriteRisk,
    clearToProceed:      report.blockCount === 0,
    collisionCount:      report.collisions.length,
  });
});

// ── GET /api/route-collision-bm2/:primeJobId/safe ────────────────────────────

router.get("/route-collision-bm2/:primeJobId/safe", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;
  res.status(200).json({
    primeJobId, count: report.safeCount, routes: report.safe,
  });
});

// ── GET /api/route-collision-bm2/:primeJobId/rename ──────────────────────────

router.get("/route-collision-bm2/:primeJobId/rename", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;
  res.status(200).json({
    primeJobId,
    count:       report.renameCount,
    assessments: report.rename,
    suggestions: report.rename.map(a => ({
      from:        a.primeRoute.path,
      to:          a.collision?.suggestedPath ?? null,
      reason:      a.collision?.description ?? "",
    })),
  });
});

// ── GET /api/route-collision-bm2/:primeJobId/merge ───────────────────────────

router.get("/route-collision-bm2/:primeJobId/merge", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;
  res.status(200).json({
    primeJobId,
    count:       report.mergeCount,
    assessments: report.merge,
    mergeActions: report.merge.map(a => ({
      path:            a.primeRoute.path,
      addMethods:      a.collision?.mergeableMethods ?? [],
      existingMethods: a.collision?.backendRoute.methods ?? [],
      note:            a.collision?.resolution_note ?? "",
    })),
  });
});

// ── GET /api/route-collision-bm2/:primeJobId/block ───────────────────────────

router.get("/route-collision-bm2/:primeJobId/block", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;
  res.status(200).json({
    primeJobId,
    clearToProceed:      report.blockCount === 0,
    silentOverwriteRisk: report.silentOverwriteRisk,
    blockCount:          report.blockCount,
    assessments:         report.block,
    blockedPaths:        report.block.map(a => ({
      path:     a.primeRoute.path,
      kind:     a.collision?.kind ?? "unknown",
      severity: a.collision?.severity ?? "unknown",
      reason:   a.collision?.description ?? "",
      fix:      a.collision?.resolution_note ?? "",
    })),
  });
});

// ── GET /api/route-collision-bm2/:primeJobId/collisions ──────────────────────

router.get("/route-collision-bm2/:primeJobId/collisions", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const kindFilter       = req.query["kind"]       as string | undefined;
  const resolutionFilter = req.query["resolution"] as string | undefined;

  if (kindFilter && !VALID_KINDS.has(kindFilter as CollisionKind)) {
    res.status(400).json({ error: `Invalid kind "${kindFilter}"`, valid: [...VALID_KINDS] });
    return;
  }
  if (resolutionFilter && !VALID_RESOLUTIONS.has(resolutionFilter as CollisionResolution)) {
    res.status(400).json({ error: `Invalid resolution "${resolutionFilter}"`, valid: [...VALID_RESOLUTIONS] });
    return;
  }

  let collisions = report.collisions;
  if (kindFilter)       collisions = collisions.filter(c => c.kind       === kindFilter);
  if (resolutionFilter) collisions = collisions.filter(c => c.resolution === resolutionFilter);

  res.status(200).json({
    primeJobId,
    total:     report.collisions.length,
    filtered:  collisions.length,
    filters:   { kind: kindFilter ?? null, resolution: resolutionFilter ?? null },
    collisions,
  });
});

// ── GET /api/route-collision-bm2/:primeJobId/collisions/:id ──────────────────

router.get("/route-collision-bm2/:primeJobId/collisions/:id", (req, res): void => {
  const p          = req.params as Record<string, string>;
  const primeJobId = p["primeJobId"] ?? "";
  const id         = p["id"]         ?? "";

  const report = requireReport(primeJobId, res);
  if (!report) return;

  const collision = report.collisions.find(c => c.id === id);
  if (!collision) {
    res.status(404).json({ error: `Collision "${id}" not found`, availableIds: report.collisions.map(c => c.id) });
    return;
  }

  res.status(200).json({ primeJobId, ...collision });
});

export default router;
