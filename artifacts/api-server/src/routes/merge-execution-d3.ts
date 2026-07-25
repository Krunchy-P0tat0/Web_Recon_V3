/**
 * merge-execution-d3.ts — Phase D3 Routes
 *
 * POST /merge-execution/run                               — execute an approved merge plan
 * POST /merge-execution/dry-run                          — plan operations without writing
 * GET  /merge-execution                                   — list all executions
 * GET  /merge-execution/:executionId                      — full D3 bundle
 * GET  /merge-execution/:executionId/execution-report    — merge-execution-report.json
 * GET  /merge-execution/:executionId/rollback-package    — rollback-package.json
 * GET  /merge-execution/:executionId/summary             — merged-project-summary.json
 * GET  /merge-execution/:executionId/operations          — paginated operation log
 * GET  /merge-execution/:executionId/operations/failed   — failed operations only
 * GET  /merge-execution/:executionId/validation          — validation results
 * POST /merge-execution/:executionId/rollback            — manually trigger rollback
 */

import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  runMergeExecution,
  getD3Bundle,
  listD3Bundles,
} from "../lib/merge-execution-engine-d3.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /merge-execution/run  — execute the merge plan
// ---------------------------------------------------------------------------
router.post("/merge-execution/run", async (req, res): Promise<void> => {
  const { primePath, targetPath, executionId, d2DetectionId, approvedOperations } = req.body ?? {};

  if (!primePath || typeof primePath !== "string") {
    res.status(400).json({ error: "primePath (string) is required — path to the Website Prime directory" });
    return;
  }
  if (!targetPath || typeof targetPath !== "string") {
    res.status(400).json({ error: "targetPath (string) is required — path to the existing backend to merge into" });
    return;
  }

  const id = (typeof executionId === "string" && executionId.trim()) ? executionId.trim() : randomUUID();

  try {
    const bundle = await runMergeExecution({
      executionId: id, primePath, targetPath, dryRun: false,
      d2DetectionId: typeof d2DetectionId === "string" ? d2DetectionId : undefined,
      approvedOperations: Array.isArray(approvedOperations) ? approvedOperations as string[] : [],
    });

    const r = bundle.mergeExecutionReport;
    const s = bundle.mergedProjectSummary;

    res.status(200).json({
      executionId:        bundle.executionId,
      generatedAt:        bundle.generatedAt,
      r2Keys:             bundle.r2Keys,
      isMergeComplete:    s.isMergeComplete,
      wasRolledBack:      r.rolledBack,
      rollbackReason:     r.rollbackReason,
      totalOperations:    r.totalOperations,
      succeeded:          r.succeeded,
      skipped:            r.skipped,
      failed:             r.failed,
      validationPassed:   r.validationPassed,
      totalBytesWritten:  r.totalBytesWritten,
      totalDurationMs:    r.totalDurationMs,
      backupPath:         r.backupPath,
      newFilesAdded:      s.newFilesAdded.length,
      filesBlocked:       s.filesBlocked.length,
      filesSkipped:       s.filesSkipped.length,
      envVarsAdded:       s.envVarsAdded,
      schemaModelsAppended: s.schemaModelsAppended,
      nextSteps:          s.nextSteps,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("does not exist") || msg.includes("not a directory")) {
      res.status(400).json({ error: msg });
      return;
    }
    req.log.error({ err }, "D3: merge execution failed");
    res.status(500).json({ error: "Merge execution failed", detail: msg });
  }
});

// ---------------------------------------------------------------------------
// POST /merge-execution/dry-run  — plan without writing
// ---------------------------------------------------------------------------
router.post("/merge-execution/dry-run", async (req, res): Promise<void> => {
  const { primePath, targetPath, executionId, d2DetectionId, approvedOperations } = req.body ?? {};

  if (!primePath || typeof primePath !== "string") {
    res.status(400).json({ error: "primePath (string) is required" });
    return;
  }
  if (!targetPath || typeof targetPath !== "string") {
    res.status(400).json({ error: "targetPath (string) is required" });
    return;
  }

  const id = (typeof executionId === "string" && executionId.trim()) ? executionId.trim() : `dry-${randomUUID()}`;

  try {
    const bundle = await runMergeExecution({
      executionId: id, primePath, targetPath, dryRun: true,
      d2DetectionId: typeof d2DetectionId === "string" ? d2DetectionId : undefined,
      approvedOperations: Array.isArray(approvedOperations) ? approvedOperations as string[] : [],
    });

    const r = bundle.mergeExecutionReport;
    const s = bundle.mergedProjectSummary;

    const byType: Record<string, number> = {};
    for (const op of r.operations) {
      byType[op.type] = (byType[op.type] ?? 0) + 1;
    }

    res.status(200).json({
      executionId:     bundle.executionId,
      generatedAt:     bundle.generatedAt,
      dryRun:          true,
      totalOperations: r.totalOperations,
      wouldSucceed:    r.succeeded,
      wouldSkip:       r.skipped,
      byType,
      filesBlocked:    s.filesBlocked,
      filesProtected:  s.filesProtected,
      newFilesAdded:   s.newFilesAdded.length,
      nextSteps:       s.nextSteps,
      operations:      r.operations.map(o => ({ opId: o.opId, type: o.type, sourceFile: o.sourceFile, protected: o.protected, detail: o.detail })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("does not exist") || msg.includes("not a directory")) {
      res.status(400).json({ error: msg });
      return;
    }
    req.log.error({ err }, "D3: dry-run failed");
    res.status(500).json({ error: "Dry-run failed", detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /merge-execution
// ---------------------------------------------------------------------------
router.get("/merge-execution", async (_req, res): Promise<void> => {
  const list = await listD3Bundles();
  res.status(200).json(list);
});

// ---------------------------------------------------------------------------
// GET /merge-execution/:executionId — full bundle
// ---------------------------------------------------------------------------
router.get("/merge-execution/:executionId", (req, res): void => {
  const bundle = getD3Bundle(req.params.executionId!);
  if (!bundle) { res.status(404).json({ error: `No D3 execution found for id "${req.params.executionId}"` }); return; }
  res.status(200).json(bundle);
});

// ---------------------------------------------------------------------------
// GET /merge-execution/:executionId/execution-report
// ---------------------------------------------------------------------------
router.get("/merge-execution/:executionId/execution-report", (req, res): void => {
  const bundle = getD3Bundle(req.params.executionId!);
  if (!bundle) { res.status(404).json({ error: `No D3 execution found for id "${req.params.executionId}"` }); return; }
  res.status(200).json(bundle.mergeExecutionReport);
});

// ---------------------------------------------------------------------------
// GET /merge-execution/:executionId/rollback-package
// ---------------------------------------------------------------------------
router.get("/merge-execution/:executionId/rollback-package", (req, res): void => {
  const bundle = getD3Bundle(req.params.executionId!);
  if (!bundle) { res.status(404).json({ error: `No D3 execution found for id "${req.params.executionId}"` }); return; }
  res.status(200).json(bundle.rollbackPackage);
});

// ---------------------------------------------------------------------------
// GET /merge-execution/:executionId/summary
// ---------------------------------------------------------------------------
router.get("/merge-execution/:executionId/summary", (req, res): void => {
  const bundle = getD3Bundle(req.params.executionId!);
  if (!bundle) { res.status(404).json({ error: `No D3 execution found for id "${req.params.executionId}"` }); return; }
  res.status(200).json(bundle.mergedProjectSummary);
});

// ---------------------------------------------------------------------------
// GET /merge-execution/:executionId/operations?page=1&limit=50
// ---------------------------------------------------------------------------
router.get("/merge-execution/:executionId/operations", (req, res): void => {
  const bundle = getD3Bundle(req.params.executionId!);
  if (!bundle) { res.status(404).json({ error: `No D3 execution found for id "${req.params.executionId}"` }); return; }

  const page  = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10)));
  const ops   = bundle.mergeExecutionReport.operations;
  const start = (page - 1) * limit;

  res.status(200).json({
    executionId: bundle.executionId,
    total: ops.length,
    page, limit,
    totalPages: Math.ceil(ops.length / limit),
    operations: ops.slice(start, start + limit),
  });
});

// ---------------------------------------------------------------------------
// GET /merge-execution/:executionId/operations/failed
// ---------------------------------------------------------------------------
router.get("/merge-execution/:executionId/operations/failed", (req, res): void => {
  const bundle = getD3Bundle(req.params.executionId!);
  if (!bundle) { res.status(404).json({ error: `No D3 execution found for id "${req.params.executionId}"` }); return; }
  const failed = bundle.mergeExecutionReport.operations.filter(o => o.status === "failed" || o.status === "rolled_back");
  res.status(200).json({ executionId: bundle.executionId, count: failed.length, operations: failed });
});

// ---------------------------------------------------------------------------
// GET /merge-execution/:executionId/validation
// ---------------------------------------------------------------------------
router.get("/merge-execution/:executionId/validation", (req, res): void => {
  const bundle = getD3Bundle(req.params.executionId!);
  if (!bundle) { res.status(404).json({ error: `No D3 execution found for id "${req.params.executionId}"` }); return; }
  const { validationResults, validationPassed, rolledBack } = bundle.mergeExecutionReport;
  const pass = validationResults.filter(v => v.passed).length;
  const fail = validationResults.filter(v => !v.passed).length;
  res.status(200).json({
    executionId: bundle.executionId,
    validationPassed, rolledBack,
    summary: { pass, fail, total: validationResults.length },
    results: validationResults,
  });
});

// ---------------------------------------------------------------------------
// POST /merge-execution/:executionId/rollback — manual rollback trigger
// ---------------------------------------------------------------------------
router.post("/merge-execution/:executionId/rollback", async (req, res): Promise<void> => {
  const bundle = getD3Bundle(req.params.executionId!);
  if (!bundle) { res.status(404).json({ error: `No D3 execution found for id "${req.params.executionId}"` }); return; }

  const { backupPath, targetPath, wasRolledBack } = bundle.rollbackPackage;

  if (wasRolledBack) {
    res.status(409).json({ error: "This execution has already been rolled back.", rollbackPackage: bundle.rollbackPackage });
    return;
  }

  if (!backupPath || backupPath === "(dry-run — no backup created)") {
    res.status(400).json({ error: "No backup available for this execution (was this a dry-run?)." });
    return;
  }

  if (!fs.existsSync(backupPath)) {
    res.status(400).json({ error: `Backup directory not found at ${backupPath}. Manual restoration required.` });
    return;
  }

  try {
    // Restore
    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === ".webrecon-d3-backups") continue;
      fs.rmSync(path.join(targetPath, e.name), { recursive: true, force: true });
    }
    fs.cpSync(backupPath, targetPath, { recursive: true, errorOnExist: false });

    bundle.rollbackPackage.wasRolledBack   = true;
    bundle.rollbackPackage.rolledBackAt    = new Date().toISOString();
    bundle.mergeExecutionReport.rolledBack = true;
    bundle.mergedProjectSummary.wasRolledBack = true;

    req.log.info({ executionId: bundle.executionId, backupPath }, "D3: manual rollback executed");
    res.status(200).json({
      message:      "Rollback completed successfully.",
      executionId:  bundle.executionId,
      targetPath,
      backupPath,
      rolledBackAt: bundle.rollbackPackage.rolledBackAt,
      nextSteps: [
        "Run `pnpm install` to restore original dependencies.",
        "Restart all services.",
        "Verify application health before re-attempting the merge.",
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err, executionId: bundle.executionId }, "D3: manual rollback failed");
    res.status(500).json({ error: "Rollback failed — manual restoration required.", detail: msg, backupPath, rollbackCommand: bundle.rollbackPackage.rollbackCommand });
  }
});

export default router;
