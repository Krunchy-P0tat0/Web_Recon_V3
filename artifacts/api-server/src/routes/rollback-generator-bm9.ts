/**
 * rollback-generator-bm9.ts — Phase BM-9: Rollback Generator Routes
 *
 * POST /api/rollback-generator-bm9/:primeJobId/generate
 *   Generate the rollback plan.
 *   Body:
 *   {
 *     backendJobId?: string,
 *     force?:        boolean,
 *     routes?:       Array<{path,methods,handler,middlewares?}>,
 *     migrations?:   Array<{version,name,sql,downSql?}>,
 *     assets?:       Array<{path,hash?,url?}>,
 *     components?:   Array<{name,importPath,usedIn?}>,
 *     configs?:      Array<{key,value?,file?,isSecret?}>,
 *   }
 *   Returns: full RollbackPlan
 *
 * GET  /api/rollback-generator-bm9/:primeJobId/report
 *   Full rollback-plan.json
 *
 * GET  /api/rollback-generator-bm9/:primeJobId/summary
 *   Quick summary: { complexity, estimatedRollbackMs, rollbackWindow,
 *     requiresDowntime, hasDataLossRisk, totalSteps, recommendation }
 *
 * GET  /api/rollback-generator-bm9/:primeJobId/steps
 *   All rollback steps in execution order.
 *   Query: ?dimension=routes|database|assets|components|configs
 *          ?downtime=true|false
 *          ?dataloss=true|false
 *
 * GET  /api/rollback-generator-bm9/:primeJobId/steps/:id
 *   Single rollback step by ID (e.g. RBK-0001).
 *
 * GET  /api/rollback-generator-bm9/:primeJobId/manifest
 *   Full backup manifest — all snapshotted items.
 *   Query: ?dimension=  ?auto=true|false
 *
 * GET  /api/rollback-generator-bm9/:primeJobId/dimensions
 *   Per-dimension rollback summary.
 *
 * GET  /api/rollback-generator-bm9/:primeJobId/dimensions/:dimension
 *   Full detail for one dimension rollback.
 */

import { Router, type IRouter } from "express";
import {
  runRollbackGenerator,
  getCachedRollbackPlan,
  type RollbackPlan,
  type RollbackDimension,
} from "../lib/rollback-generator-bm9.js";

const router: IRouter = Router();

const VALID_DIMENSIONS: Set<RollbackDimension> = new Set([
  "routes", "database", "assets", "components", "configs",
]);

// ── Helper ────────────────────────────────────────────────────────────────────

function requirePlan(
  primeJobId: string,
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): RollbackPlan | null {
  const plan = getCachedRollbackPlan(primeJobId);
  if (!plan) {
    res.status(404).json({
      error: "No BM-9 rollback plan found for this primeJobId.",
      hint:  `POST /api/rollback-generator-bm9/${primeJobId}/generate to run Phase BM-9.`,
    });
    return null;
  }
  return plan;
}

// ── POST /api/rollback-generator-bm9/:primeJobId/generate ────────────────────

router.post("/rollback-generator-bm9/:primeJobId/generate", async (req, res): Promise<void> => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  if (!primeJobId) { res.status(400).json({ error: "primeJobId is required" }); return; }

  const body        = (req.body ?? {}) as Record<string, unknown>;
  const backendJobId = typeof body["backendJobId"] === "string" ? body["backendJobId"].trim() : undefined;
  const force        = body["force"] === true;

  req.log.info({ primeJobId, backendJobId, force }, "BM9: generate requested");

  try {
    const plan = await runRollbackGenerator({
      primeJobId,
      backendJobId,
      force,
      routes:     Array.isArray(body["routes"])     ? body["routes"]     as any : undefined,
      migrations: Array.isArray(body["migrations"]) ? body["migrations"] as any : undefined,
      assets:     Array.isArray(body["assets"])     ? body["assets"]     as any : undefined,
      components: Array.isArray(body["components"]) ? body["components"] as any : undefined,
      configs:    Array.isArray(body["configs"])    ? body["configs"]    as any : undefined,
    });
    res.status(200).json(plan);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err, primeJobId }, "BM9: generate failed");
    res.status(500).json({ error: "BM-9 rollback generation failed", detail: message });
  }
});

// ── GET /api/rollback-generator-bm9/:primeJobId/report ───────────────────────

router.get("/rollback-generator-bm9/:primeJobId/report", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const plan       = requirePlan(primeJobId, res);
  if (plan) res.status(200).json(plan);
});

// ── GET /api/rollback-generator-bm9/:primeJobId/summary ──────────────────────

router.get("/rollback-generator-bm9/:primeJobId/summary", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const plan       = requirePlan(primeJobId, res);
  if (!plan) return;

  res.status(200).json({
    primeJobId,
    rollbackPlanId:      plan.rollbackPlanId,
    generatedAt:         plan.generatedAt,
    isComplete:          plan.isComplete,
    complexityLevel:     plan.summary.complexityLevel,
    estimatedRollbackMs: plan.estimatedRollbackMs,
    rollbackWindow:      plan.summary.rollbackWindow,
    requiresDowntime:    plan.requiresDowntime,
    hasDataLossRisk:     plan.hasDataLossRisk,
    totalItems:          plan.summary.totalItems,
    totalSteps:          plan.summary.totalSteps,
    autoRestorableItems: plan.summary.autoRestorableItems,
    manualItems:         plan.summary.manualItems,
    downtimeSteps:       plan.summary.downtimeSteps,
    dataLossSteps:       plan.summary.dataLossSteps,
    recommendation:      plan.summary.recommendation,
  });
});

// ── GET /api/rollback-generator-bm9/:primeJobId/steps ────────────────────────

router.get("/rollback-generator-bm9/:primeJobId/steps", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const plan       = requirePlan(primeJobId, res);
  if (!plan) return;

  const dimFilter      = req.query["dimension"] as string | undefined;
  const downtimeFilter = req.query["downtime"]  as string | undefined;
  const dataLossFilter = req.query["dataloss"]  as string | undefined;

  if (dimFilter && !VALID_DIMENSIONS.has(dimFilter as RollbackDimension)) {
    res.status(400).json({ error: `Invalid dimension "${dimFilter}"`, valid: [...VALID_DIMENSIONS] });
    return;
  }

  let steps = plan.allSteps;
  if (dimFilter)               steps = steps.filter(s => s.dimension === dimFilter);
  if (downtimeFilter === "true")   steps = steps.filter(s =>  s.requiresDowntime);
  if (downtimeFilter === "false")  steps = steps.filter(s => !s.requiresDowntime);
  if (dataLossFilter === "true")   steps = steps.filter(s =>  s.dataLossRisk);
  if (dataLossFilter === "false")  steps = steps.filter(s => !s.dataLossRisk);

  res.status(200).json({
    primeJobId,
    total:            plan.allSteps.length,
    filtered:         steps.length,
    filters:          { dimension: dimFilter ?? null, downtime: downtimeFilter ?? null, dataloss: dataLossFilter ?? null },
    estimatedTotalMs: steps.reduce((s, step) => s + step.estimatedMs, 0),
    steps,
  });
});

// ── GET /api/rollback-generator-bm9/:primeJobId/steps/:id ────────────────────

router.get("/rollback-generator-bm9/:primeJobId/steps/:id", (req, res): void => {
  const p          = req.params as Record<string, string>;
  const primeJobId = p["primeJobId"] ?? "";
  const id         = p["id"]         ?? "";

  const plan = requirePlan(primeJobId, res);
  if (!plan) return;

  const step = plan.allSteps.find(s => s.id === id);
  if (!step) {
    res.status(404).json({ error: `Step "${id}" not found`, availableIds: plan.allSteps.map(s => s.id) });
    return;
  }

  res.status(200).json({ primeJobId, ...step });
});

// ── GET /api/rollback-generator-bm9/:primeJobId/manifest ─────────────────────

router.get("/rollback-generator-bm9/:primeJobId/manifest", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const plan       = requirePlan(primeJobId, res);
  if (!plan) return;

  const dimFilter  = req.query["dimension"] as string | undefined;
  const autoFilter = req.query["auto"]      as string | undefined;

  let items = plan.backupManifest;
  if (dimFilter)               items = items.filter(i => i.dimension === dimFilter);
  if (autoFilter === "true")   items = items.filter(i =>  i.canAutoRestore);
  if (autoFilter === "false")  items = items.filter(i => !i.canAutoRestore);

  res.status(200).json({
    primeJobId,
    total:              plan.backupManifest.length,
    filtered:           items.length,
    filters:            { dimension: dimFilter ?? null, auto: autoFilter ?? null },
    autoRestorable:     items.filter(i => i.canAutoRestore).length,
    manualItems:        items.filter(i => !i.canAutoRestore).length,
    items,
  });
});

// ── GET /api/rollback-generator-bm9/:primeJobId/dimensions ───────────────────

router.get("/rollback-generator-bm9/:primeJobId/dimensions", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const plan       = requirePlan(primeJobId, res);
  if (!plan) return;

  const summary = Object.entries(plan.dimensions).map(([dim, d]) => ({
    dimension:    dim,
    snapshotId:   d.snapshotId,
    complexity:   d.complexity,
    itemCount:    d.items.length,
    stepCount:    d.rollbackSteps.length,
    notes:        d.notes,
  }));

  res.status(200).json({
    primeJobId,
    rollbackPlanId:  plan.rollbackPlanId,
    isComplete:      plan.isComplete,
    requiresDowntime: plan.requiresDowntime,
    dimensions:      summary,
  });
});

// ── GET /api/rollback-generator-bm9/:primeJobId/dimensions/:dimension ─────────

router.get("/rollback-generator-bm9/:primeJobId/dimensions/:dimension", (req, res): void => {
  const p          = req.params as Record<string, string>;
  const primeJobId = p["primeJobId"] ?? "";
  const dim        = p["dimension"]  ?? "";

  if (!VALID_DIMENSIONS.has(dim as RollbackDimension)) {
    res.status(400).json({ error: `Invalid dimension "${dim}"`, valid: [...VALID_DIMENSIONS] });
    return;
  }

  const plan = requirePlan(primeJobId, res);
  if (!plan) return;

  res.status(200).json({ primeJobId, ...plan.dimensions[dim as RollbackDimension] });
});

export default router;
