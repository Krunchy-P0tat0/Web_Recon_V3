import type {
  MergePlan,
  MergeAction,
  DecisionResult,
  AuditEntry,
  FileChange,
  MergeAudit,
  MergeAuditSummary,
  VFSSnapshot,
  ExecutionOptions,
} from "./types.js";

/**
 * Build the final MergeAudit from a plan and its per-decision results.
 * Pure and synchronous.
 */
export function buildAudit(
  plan: MergePlan,
  results: DecisionResult[],
  startedAt: string,
  durationMs: number,
  rollbackSnapshot: VFSSnapshot | null,
  options: ExecutionOptions,
  abortedEarly: boolean
): MergeAudit {
  const resultMap = new Map(results.map((r) => [r.decisionId, r]));

  // Build lookup for plan decisions
  const decisionMap = new Map(plan.decisions.map((d) => [d.id, d]));

  const created: AuditEntry[] = [];
  const updated: AuditEntry[] = [];
  const extended: AuditEntry[] = [];
  const archived: AuditEntry[] = [];
  const ignored: AuditEntry[] = [];
  const failed: AuditEntry[] = [];
  const allFileChanges: FileChange[] = [];

  for (const result of results) {
    const decision = decisionMap.get(result.decisionId);
    const entry: AuditEntry = {
      decisionId: result.decisionId,
      action: result.action,
      entityKind: result.entityKind,
      sourcePath: decision?.source?.path ?? null,
      targetPath: decision?.target?.path ?? null,
      reason: decision?.reason ?? "",
      confidence: decision?.confidence ?? 0,
      fileChanges: result.fileChanges,
      durationMs: result.durationMs,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };

    allFileChanges.push(...result.fileChanges);

    if (result.status === "failed") {
      failed.push(entry);
    } else {
      switch (result.action as MergeAction) {
        case "CREATE":  created.push(entry);  break;
        case "UPDATE":  updated.push(entry);  break;
        case "EXTEND":  extended.push(entry); break;
        case "ARCHIVE": archived.push(entry); break;
        case "IGNORE":  ignored.push(entry);  break;
      }
    }
  }

  const summary: MergeAuditSummary = {
    total: results.length,
    created: created.length,
    updated: updated.length,
    extended: extended.length,
    archived: archived.length,
    ignored: ignored.length,
    failed: failed.length,
    filesCreated: allFileChanges.filter((c) => c.operation === "create").length,
    filesUpdated: allFileChanges.filter((c) => c.operation === "update").length,
    filesDeleted: allFileChanges.filter((c) => c.operation === "delete").length,
    filesMoved: allFileChanges.filter((c) => c.operation === "move").length,
    dryRun: options.dryRun === true,
    hadBlockers: plan.summary.blockers.length > 0,
    abortedEarly,
  };

  return {
    version: "1.0",
    executedAt: startedAt,
    durationMs,
    planVersion: plan.version,
    planGeneratedAt: plan.generatedAt,
    dryRun: options.dryRun === true,
    summary,
    created,
    updated,
    extended,
    archived,
    ignored,
    failed,
    fileChanges: allFileChanges,
    rollbackSnapshot,
  };
}
