import type { MergeAction, MergeConflict, MergeDecision, MergeEntityKind, MergePlanStats, MergeSummary } from "./types.js";

// ─── Statistics ───────────────────────────────────────────────────────────────

export function computeStats(
  decisions: MergeDecision[],
  conflicts: MergeConflict[],
  planningTimeMs: number
): MergePlanStats {
  const byAction: Record<MergeAction, number> = {
    CREATE: 0, UPDATE: 0, EXTEND: 0, ARCHIVE: 0, IGNORE: 0,
  };
  const byEntityKind: Record<MergeEntityKind, number> = {
    route: 0, layout: 0, component: 0, api: 0, datasource: 0,
  };

  for (const dec of decisions) {
    byAction[dec.action] = (byAction[dec.action] ?? 0) + 1;
    byEntityKind[dec.entityKind] = (byEntityKind[dec.entityKind] ?? 0) + 1;
  }

  const errorCount = conflicts.filter((c) => c.severity === "error").length;
  const warnCount = conflicts.filter((c) => c.severity === "warning").length;

  // Overall confidence = weighted average of individual decision confidences,
  // penalised by error conflicts
  const totalConf = decisions.reduce((s, d) => s + d.confidence, 0);
  const rawConf = decisions.length > 0 ? totalConf / decisions.length : 1;
  const penalty = Math.min(0.4, errorCount * 0.1 + warnCount * 0.02);
  const overallConfidence = parseFloat(Math.max(0, rawConf - penalty).toFixed(3));

  return {
    totalDecisions: decisions.length,
    byAction,
    byEntityKind,
    conflictCount: conflicts.length,
    errorConflictCount: errorCount,
    warningConflictCount: warnCount,
    planningTimeMs,
    overallConfidence,
  };
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export function computeSummary(
  decisions: MergeDecision[],
  conflicts: MergeConflict[]
): MergeSummary {
  const creates = decisions.filter((d) => d.action === "CREATE").length;
  const updates = decisions.filter((d) => d.action === "UPDATE").length;
  const extends_ = decisions.filter((d) => d.action === "EXTEND").length;
  const archives = decisions.filter((d) => d.action === "ARCHIVE").length;
  const ignores = decisions.filter((d) => d.action === "IGNORE").length;

  const blockers = conflicts.filter((c) => c.isBlocker);
  const readyForMerge = blockers.length === 0;

  let recommendation: string;
  if (blockers.length > 0) {
    recommendation =
      `⛔ Merge is BLOCKED by ${blockers.length} error-level conflict(s). ` +
      `Resolve the following before proceeding: ${blockers.map((b) => b.description.slice(0, 80)).join("; ")}.`;
  } else if (creates > 10) {
    recommendation =
      `⚠️ Large merge: ${creates} new entities to create. ` +
      `Consider batching the merge in phases (routes first, then components, then data).`;
  } else if (creates + updates + extends_ === 0) {
    recommendation =
      `✅ Site is fully compatible. No structural changes required — only content updates needed.`;
  } else {
    recommendation =
      `✅ Merge plan is ready. ${creates} create(s), ${updates} update(s), ` +
      `${extends_} extend(s). ${archives} archive candidate(s). ` +
      `${conflicts.filter((c) => c.severity === "warning").length} warning(s) to review.`;
  }

  return {
    creates,
    updates,
    extends: extends_,
    archives,
    ignores,
    blockers,
    readyForMerge,
    recommendation,
  };
}

// ─── Decision deduplication ───────────────────────────────────────────────────
//
// Same (source.id, target.id, entityKind) tuple may appear from multiple matchers.
// Merge duplicates by taking the highest-confidence decision.

export function deduplicateDecisions(decisions: MergeDecision[]): MergeDecision[] {
  const seen = new Map<string, MergeDecision>();

  for (const dec of decisions) {
    const key = `${dec.entityKind}::${dec.source?.id ?? "_"}::${dec.target?.id ?? "_"}`;
    const existing = seen.get(key);
    if (!existing || dec.confidence > existing.confidence) {
      seen.set(key, dec);
    }
  }

  return [...seen.values()];
}

// ─── Conflict deduplication ───────────────────────────────────────────────────

export function deduplicateConflicts(conflicts: MergeConflict[]): MergeConflict[] {
  const seen = new Map<string, MergeConflict>();

  for (const c of conflicts) {
    const key = `${c.kind}::${c.sourceRef?.id ?? "_"}::${c.targetRef?.id ?? "_"}`;
    if (!seen.has(key)) seen.set(key, c);
  }

  return [...seen.values()];
}
