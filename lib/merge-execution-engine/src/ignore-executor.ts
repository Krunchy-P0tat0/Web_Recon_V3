import type { MergeDecision, DecisionResult } from "./types.js";

/**
 * IGNORE executor — no action required; both sides are compatible.
 * Records the decision in the audit trail without touching the VFS.
 */
export function executeIgnore(decision: MergeDecision): DecisionResult {
  return {
    decisionId: decision.id,
    action: "IGNORE",
    entityKind: decision.entityKind,
    status: "success",
    fileChanges: [],
    durationMs: 0,
  };
}
