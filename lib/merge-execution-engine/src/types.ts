import type { MergePlan, MergeDecision, MergeAction, MergeEntityKind } from "@workspace/merge-planner";

export type { MergePlan, MergeDecision, MergeAction, MergeEntityKind };

// ─── Virtual File System ──────────────────────────────────────────────────────

/**
 * A flat map of file paths → file content strings.
 * Paths are always relative to project root (e.g. "src/pages/about.tsx").
 * An absent key means the file does not exist; setting a key to "" marks deletion.
 */
export type VirtualFileSystem = Record<string, string>;

// ─── File-level changes ───────────────────────────────────────────────────────

export type FileOperation = "create" | "update" | "delete" | "move";

export interface FileChange {
  /** File path after the operation (for moves, this is the destination) */
  path: string;
  operation: FileOperation;
  /** Original path before a move */
  previousPath?: string;
  bytesBefore: number;
  bytesAfter: number;
  /** ID of the MergeDecision that caused this change */
  decisionId: string;
}

// ─── Per-decision result ──────────────────────────────────────────────────────

export type ExecutionStatus = "success" | "failed" | "skipped";

export interface DecisionResult {
  decisionId: string;
  action: MergeAction;
  entityKind: MergeEntityKind;
  status: ExecutionStatus;
  fileChanges: FileChange[];
  durationMs: number;
  error?: string;
}

// ─── Audit entry (written to merge-audit.json) ────────────────────────────────

export interface AuditEntry {
  decisionId: string;
  action: MergeAction;
  entityKind: MergeEntityKind;
  sourcePath: string | null;
  targetPath: string | null;
  reason: string;
  confidence: number;
  fileChanges: FileChange[];
  durationMs: number;
  error?: string;
}

// ─── VFS snapshot (for rollback) ─────────────────────────────────────────────

export interface VFSSnapshot {
  capturedAt: string;
  /** Full copy of VFS state before execution began */
  files: VirtualFileSystem;
}

// ─── Execution options ────────────────────────────────────────────────────────

export interface ExecutionOptions {
  /**
   * When true, simulate execution and build the audit without modifying the VFS.
   * The returned VFS is a copy of the input unchanged.
   */
  dryRun?: boolean;
  /**
   * When true, skip any decision that has one or more blocker conflicts instead
   * of aborting the entire run. Skipped decisions appear in `failed` with a
   * "skipped-blocker" error string.
   */
  skipBlockers?: boolean;
  /**
   * Directory path (relative to project root) where archived files are moved.
   * Defaults to "_archive".
   */
  archiveDir?: string;
  /**
   * When true, capture a full VFS snapshot before execution so rollback is
   * possible. Costs one full VFS clone. Defaults to true.
   */
  captureRollback?: boolean;
  /**
   * Abort execution after this many failed decisions. Defaults to Infinity.
   */
  maxFailures?: number;
  /**
   * Framework hint used by stub generators when no framework metadata is
   * present on a decision. Defaults to "react".
   */
  defaultFramework?: string;
}

// ─── Audit summary ────────────────────────────────────────────────────────────

export interface MergeAuditSummary {
  total: number;
  created: number;
  updated: number;
  extended: number;
  archived: number;
  ignored: number;
  failed: number;
  filesCreated: number;
  filesUpdated: number;
  filesDeleted: number;
  filesMoved: number;
  dryRun: boolean;
  hadBlockers: boolean;
  abortedEarly: boolean;
}

// ─── Root audit output (merge-audit.json) ─────────────────────────────────────

export interface MergeAudit {
  version: "1.0";
  executedAt: string;
  durationMs: number;
  planVersion: string;
  planGeneratedAt: string;
  dryRun: boolean;
  summary: MergeAuditSummary;
  /** Successfully executed CREATE decisions */
  created: AuditEntry[];
  /** Successfully executed UPDATE decisions */
  updated: AuditEntry[];
  /** Successfully executed EXTEND decisions */
  extended: AuditEntry[];
  /** Successfully executed ARCHIVE decisions */
  archived: AuditEntry[];
  /** IGNORE decisions (no file changes) */
  ignored: AuditEntry[];
  /** Decisions that threw errors or were skipped due to blockers */
  failed: AuditEntry[];
  /** Flat list of every file-level change across all decisions */
  fileChanges: FileChange[];
  /** Pre-execution VFS snapshot, present when captureRollback was true */
  rollbackSnapshot: VFSSnapshot | null;
}

// ─── Primary return type ──────────────────────────────────────────────────────

export interface ExecuteMergePlanResult {
  /** The VFS after applying all decisions (identical to input when dryRun=true) */
  vfs: VirtualFileSystem;
  audit: MergeAudit;
  /** Available when captureRollback=true; pass to rollbackVfs() to undo */
  rollbackSnapshot: VFSSnapshot | null;
}

// ─── Export result ────────────────────────────────────────────────────────────

export interface ExportPaths {
  /** Absolute path of the written merge-audit.json */
  auditJson: string;
  /** Map of relative path → absolute path for each merged file written to disk */
  mergedFiles: Record<string, string>;
}

export interface ExportMergeResult {
  success: boolean;
  paths: ExportPaths;
  bytesWritten: number;
  fileCount: number;
  errors: string[];
}
