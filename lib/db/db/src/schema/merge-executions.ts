import {
  pgTable,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Phase D3 — Merge Execution Persistence
//
// One row per runMergeExecution() call (real or dry-run).
// The full bundle (all 3 JSON reports) lives in R2 under d3/{executionId}/.
// This table is the index: list/lookup without re-fetching R2.
// ---------------------------------------------------------------------------

export const mergeExecutionsTable = pgTable("merge_executions", {
  executionId:     text("execution_id").primaryKey(),
  primePath:       text("prime_path").notNull(),
  targetPath:      text("target_path").notNull(),
  d2DetectionId:   text("d2_detection_id"),
  dryRun:          boolean("dry_run").notNull().default(false),

  // Outcome flags
  isMergeComplete: boolean("is_merge_complete").notNull().default(false),
  wasRolledBack:   boolean("was_rolled_back").notNull().default(false),
  validationPassed: boolean("validation_passed").notNull().default(false),
  rollbackReason:  text("rollback_reason"),

  // Counters
  totalOperations: integer("total_operations").notNull().default(0),
  succeeded:       integer("succeeded").notNull().default(0),
  skipped:         integer("skipped").notNull().default(0),
  failed:          integer("failed").notNull().default(0),
  totalBytesWritten: integer("total_bytes_written").notNull().default(0),
  totalDurationMs:   integer("total_duration_ms").notNull().default(0),

  // R2 keys for the 3 JSON reports
  r2Keys: jsonb("r2_keys").$type<{
    mergeExecutionReport: string;
    rollbackPackage: string;
    mergedProjectSummary: string;
  }>(),

  // Backup location (for manual rollback after restart)
  backupPath: text("backup_path"),

  createdAt:   timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

export type MergeExecutionRecord    = typeof mergeExecutionsTable.$inferSelect;
export type InsertMergeExecution    = typeof mergeExecutionsTable.$inferInsert;
