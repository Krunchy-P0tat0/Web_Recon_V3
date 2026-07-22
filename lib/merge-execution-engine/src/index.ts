/**
 * index.ts — Public API for @workspace/merge-execution-engine
 *
 * Phase A3: Merge Execution Engine
 *
 * Three-step pipeline:
 *
 *   1. executeMergePlan(plan, vfs, options?)
 *      Takes a MergePlan from @workspace/merge-planner and a VirtualFileSystem
 *      representing the target website. Executes each decision transactionally,
 *      building an audit trail. Pure synchronous core (I/O only via the VFS
 *      abstraction). Returns { vfs, audit, rollbackSnapshot }.
 *
 *   2. rollbackVfs(snapshot)
 *      Restore the VFS to its pre-execution state using the rollbackSnapshot
 *      captured by executeMergePlan (when captureRollback=true).
 *
 *   3. exportMergeAudit(result, outputDir)
 *      Write merge-audit.json and all merged files to disk.
 *      Async (I/O only at this step).
 *
 * Decision semantics:
 *   CREATE  → generate stub file for new entity (no codebase match)
 *   UPDATE  → append merge block to existing file (both sides present)
 *   EXTEND  → append data entry to companion data file (dynamic route match)
 *   ARCHIVE → move file to _archive/ with annotated header (no content match)
 *   IGNORE  → no-op; recorded in audit only
 */

export { executeMergePlan } from "./executor.js";
export { rollbackVfs } from "./transaction.js";
export { exportMergeAudit } from "./exporter.js";

export type {
  // Primary I/O types
  VirtualFileSystem,
  ExecutionOptions,
  ExecuteMergePlanResult,

  // Audit types
  MergeAudit,
  MergeAuditSummary,
  AuditEntry,
  FileChange,
  FileOperation,

  // Per-decision result
  DecisionResult,
  ExecutionStatus,

  // Rollback
  VFSSnapshot,

  // Export
  ExportMergeResult,
  ExportPaths,

  // Re-exports from merge-planner (convenience)
  MergePlan,
  MergeDecision,
  MergeAction,
  MergeEntityKind,
} from "./types.js";
