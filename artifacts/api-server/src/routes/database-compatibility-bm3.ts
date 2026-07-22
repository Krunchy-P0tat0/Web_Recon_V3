/**
 * database-compatibility-bm3.ts — Phase BM-3: Database Compatibility Engine Routes
 *
 * POST /api/database-compatibility-bm3/:primeJobId/analyze
 *   Run schema compatibility analysis.
 *   Body: { primeSchema: DatabaseSchema, backendSchema: DatabaseSchema,
 *           backendJobId?: string, force?: boolean }
 *   Returns: full DatabaseCompatibilityReport
 *
 * GET  /api/database-compatibility-bm3/:primeJobId/report
 *   Full database-compatibility-report.json
 *
 * GET  /api/database-compatibility-bm3/:primeJobId/summary
 *   Engine info, table counts, collision counts, approval requirements
 *
 * GET  /api/database-compatibility-bm3/:primeJobId/approval
 *   All items requiring explicit approval before schema mutation
 *   (MUTATE + BLOCK + data-loss-risk items)
 *
 * GET  /api/database-compatibility-bm3/:primeJobId/tables
 *   Per-table assessment: exists? resolution? collision count?
 *
 * GET  /api/database-compatibility-bm3/:primeJobId/tables/:tableName
 *   Full assessment for one table
 *
 * GET  /api/database-compatibility-bm3/:primeJobId/collisions
 *   All detected collisions, filterable by kind and resolution
 *   Query: ?kind=table|column|index|constraint
 *          ?resolution=SAFE|ADDITIVE|RENAME|MERGE|MUTATE|BLOCK
 *          ?dataLossRisk=true
 *
 * GET  /api/database-compatibility-bm3/:primeJobId/collisions/:id
 *   Single collision by ID (e.g. DB-0001)
 */

import { Router, type IRouter } from "express";
import {
  runDatabaseCompatibilityEngine,
  getCachedDatabaseCompatibilityReport,
  type DatabaseCompatibilityReport,
  type DatabaseSchema,
  type DbCollisionKind,
  type DbResolution,
} from "../lib/database-compatibility-engine-bm3.js";

const router: IRouter = Router();

const VALID_KINDS:        Set<DbCollisionKind> = new Set(["table", "column", "index", "constraint"]);
const VALID_RESOLUTIONS:  Set<DbResolution>     = new Set(["SAFE", "ADDITIVE", "RENAME", "MERGE", "MUTATE", "BLOCK"]);

// ── Helper ───────────────────────────────────────────────────────────────────

function requireReport(
  primeJobId: string,
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): DatabaseCompatibilityReport | null {
  const report = getCachedDatabaseCompatibilityReport(primeJobId);
  if (!report) {
    res.status(404).json({
      error: "No BM-3 database compatibility report found for this primeJobId.",
      hint:  `POST /api/database-compatibility-bm3/${primeJobId}/analyze to run Phase BM-3.`,
    });
    return null;
  }
  return report;
}

function validateSchema(schema: unknown, label: string): schema is DatabaseSchema {
  if (typeof schema !== "object" || schema === null) return false;
  const s = schema as Record<string, unknown>;
  return typeof s["engine"] === "string" && Array.isArray(s["tables"]);
}

// ── POST /api/database-compatibility-bm3/:primeJobId/analyze ─────────────────

router.post("/database-compatibility-bm3/:primeJobId/analyze", async (req, res): Promise<void> => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  if (!primeJobId) { res.status(400).json({ error: "primeJobId is required" }); return; }

  const body          = (req.body ?? {}) as Record<string, unknown>;
  const primeSchema   = body["primeSchema"];
  const backendSchema = body["backendSchema"];
  const backendJobId  = typeof body["backendJobId"] === "string" ? body["backendJobId"].trim() : undefined;
  const force         = body["force"] === true;

  if (!validateSchema(primeSchema, "primeSchema")) {
    res.status(400).json({ error: "primeSchema is required: { engine: string, tables: TableDefinition[] }" });
    return;
  }
  if (!validateSchema(backendSchema, "backendSchema")) {
    res.status(400).json({ error: "backendSchema is required: { engine: string, tables: TableDefinition[] }" });
    return;
  }

  req.log.info({
    primeJobId, backendJobId,
    primeTables:   primeSchema.tables.length,
    backendTables: backendSchema.tables.length,
  }, "BM3: analyze requested");

  try {
    const report = await runDatabaseCompatibilityEngine({
      primeJobId, backendJobId, primeSchema, backendSchema, force,
    });
    res.status(200).json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err, primeJobId }, "BM3: analyze failed");
    res.status(500).json({ error: "BM-3 database compatibility analysis failed", detail: message });
  }
});

// ── GET /api/database-compatibility-bm3/:primeJobId/report ───────────────────

router.get("/database-compatibility-bm3/:primeJobId/report", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (report) res.status(200).json(report);
});

// ── GET /api/database-compatibility-bm3/:primeJobId/summary ──────────────────

router.get("/database-compatibility-bm3/:primeJobId/summary", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  res.status(200).json({
    primeJobId,
    backendJobId:          report.backendJobId,
    generatedAt:           report.generatedAt,
    primeEngine:           report.primeEngine,
    backendEngine:         report.backendEngine,
    engineCompatible:      report.engineCompatible,
    totalPrimeTables:      report.totalPrimeTables,
    totalBackendTables:    report.totalBackendTables,
    newTables:             report.newTables,
    collisionTables:       report.collisionTables,
    safeCount:             report.safeCount,
    additiveCount:         report.additiveCount,
    renameCount:           report.renameCount,
    mergeCount:            report.mergeCount,
    mutateCount:           report.mutateCount,
    blockCount:            report.blockCount,
    requiresApprovalCount: report.requiresApprovalCount,
    dataLossRiskCount:     report.dataLossRiskCount,
    clearToProceed:        report.blockCount === 0 && !report.engineCompatible === false,
    totalCollisions:       report.allCollisions.length,
  });
});

// ── GET /api/database-compatibility-bm3/:primeJobId/approval ─────────────────

router.get("/database-compatibility-bm3/:primeJobId/approval", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  res.status(200).json({
    primeJobId,
    requiresApprovalCount: report.requiresApprovalCount,
    dataLossRiskCount:     report.dataLossRiskCount,
    approvalItems:         report.approvalItems,
    dataLossItems:         report.allCollisions.filter(c => c.dataLossRisk),
    criticalItems:         report.allCollisions.filter(c => c.severity === "critical"),
    warning:               report.requiresApprovalCount > 0
      ? `${report.requiresApprovalCount} schema change(s) require explicit approval before execution. No schema mutation will occur without it.`
      : "No explicit approval required — all changes are additive or safe.",
  });
});

// ── GET /api/database-compatibility-bm3/:primeJobId/tables ───────────────────

router.get("/database-compatibility-bm3/:primeJobId/tables", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  res.status(200).json({
    primeJobId,
    totalPrimeTables:  report.totalPrimeTables,
    totalBackendTables: report.totalBackendTables,
    tables: report.tableAssessments.map(a => ({
      table:           a.table,
      exists:          a.exists,
      resolution:      a.resolution,
      collisionCount:  a.collisions.length,
      notes:           a.notes,
    })),
  });
});

// ── GET /api/database-compatibility-bm3/:primeJobId/tables/:tableName ─────────

router.get("/database-compatibility-bm3/:primeJobId/tables/:tableName", (req, res): void => {
  const p          = req.params as Record<string, string>;
  const primeJobId = p["primeJobId"] ?? "";
  const tableName  = p["tableName"]  ?? "";

  const report = requireReport(primeJobId, res);
  if (!report) return;

  const assessment = report.tableAssessments.find(
    a => a.table.toLowerCase() === tableName.toLowerCase()
  );
  if (!assessment) {
    res.status(404).json({
      error:           `Table "${tableName}" not found in prime schema`,
      availableTables: report.tableAssessments.map(a => a.table),
    });
    return;
  }

  res.status(200).json({ primeJobId, ...assessment });
});

// ── GET /api/database-compatibility-bm3/:primeJobId/collisions ───────────────

router.get("/database-compatibility-bm3/:primeJobId/collisions", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const kindFilter       = req.query["kind"]         as string | undefined;
  const resolutionFilter = req.query["resolution"]   as string | undefined;
  const dataLossOnly     = req.query["dataLossRisk"] === "true";

  if (kindFilter && !VALID_KINDS.has(kindFilter as DbCollisionKind)) {
    res.status(400).json({ error: `Invalid kind "${kindFilter}"`, valid: [...VALID_KINDS] });
    return;
  }
  if (resolutionFilter && !VALID_RESOLUTIONS.has(resolutionFilter as DbResolution)) {
    res.status(400).json({ error: `Invalid resolution "${resolutionFilter}"`, valid: [...VALID_RESOLUTIONS] });
    return;
  }

  let collisions = report.allCollisions;
  if (kindFilter)       collisions = collisions.filter(c => c.kind       === kindFilter);
  if (resolutionFilter) collisions = collisions.filter(c => c.resolution === resolutionFilter);
  if (dataLossOnly)     collisions = collisions.filter(c => c.dataLossRisk);

  res.status(200).json({
    primeJobId,
    total:    report.allCollisions.length,
    filtered: collisions.length,
    filters:  { kind: kindFilter ?? null, resolution: resolutionFilter ?? null, dataLossRisk: dataLossOnly },
    collisions,
  });
});

// ── GET /api/database-compatibility-bm3/:primeJobId/collisions/:id ───────────

router.get("/database-compatibility-bm3/:primeJobId/collisions/:id", (req, res): void => {
  const p          = req.params as Record<string, string>;
  const primeJobId = p["primeJobId"] ?? "";
  const id         = p["id"]         ?? "";

  const report = requireReport(primeJobId, res);
  if (!report) return;

  const collision = report.allCollisions.find(c => c.id === id);
  if (!collision) {
    res.status(404).json({ error: `Collision "${id}" not found`, availableIds: report.allCollisions.map(c => c.id) });
    return;
  }

  res.status(200).json({ primeJobId, ...collision });
});

export default router;
