import type {
  MergePlan,
  MergeDecision,
  VirtualFileSystem,
  DecisionResult,
  ExecutionOptions,
  ExecuteMergePlanResult,
  VFSSnapshot,
} from "./types.js";
import { snapshotVfs } from "./transaction.js";
import { buildAudit } from "./audit-builder.js";
import { executeCreate } from "./create-executor.js";
import { executeUpdate } from "./update-executor.js";
import { executeExtend } from "./extend-executor.js";
import { executeArchive } from "./archive-executor.js";
import { executeIgnore } from "./ignore-executor.js";

const DEFAULT_OPTIONS: Required<ExecutionOptions> = {
  dryRun: false,
  skipBlockers: false,
  archiveDir: "_archive",
  captureRollback: true,
  maxFailures: Infinity,
  defaultFramework: "react",
};

/**
 * Execute a MergePlan against a VirtualFileSystem.
 *
 * Decisions are executed in plan order (which is already sorted by the
 * merge-planner: blockers first, then CREATE → UPDATE → EXTEND → ARCHIVE → IGNORE).
 *
 * Each decision is executed atomically per-file. If a decision fails, its
 * error is recorded in the audit and execution continues unless maxFailures
 * is exceeded.
 *
 * When captureRollback=true, a full VFS snapshot is taken before execution
 * begins. Pass it to rollbackVfs() to undo all changes.
 *
 * @param plan    MergePlan produced by @workspace/merge-planner
 * @param vfs     Current state of the target website (modified in place unless dryRun)
 * @param options Execution knobs
 */
export function executeMergePlan(
  plan: MergePlan,
  vfs: VirtualFileSystem,
  options: ExecutionOptions = {}
): ExecuteMergePlanResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // ── Capture rollback snapshot before any mutations ────────────────────────
  const rollbackSnapshot: VFSSnapshot | null = opts.captureRollback
    ? snapshotVfs(vfs)
    : null;

  // ── Working VFS (real or dry-run shadow) ──────────────────────────────────
  // In dryRun mode we still mutate a clone so executors can read their own
  // writes (e.g. EXTEND after CREATE on the same data file), but the caller's
  // original VFS is never touched.
  const workingVfs: VirtualFileSystem = opts.dryRun ? { ...vfs } : vfs;

  const results: DecisionResult[] = [];
  let failureCount = 0;
  let abortedEarly = false;

  // ── Execute each decision ─────────────────────────────────────────────────
  for (const decision of plan.decisions) {
    if (failureCount >= opts.maxFailures) {
      abortedEarly = true;
      break;
    }

    // Skip blocker decisions when requested
    if (
      !opts.skipBlockers &&
      decision.conflicts.some((c) => c.isBlocker)
    ) {
      results.push(makeSkippedResult(decision, "decision has one or more blocker conflicts"));
      continue;
    }

    if (opts.skipBlockers && decision.conflicts.some((c) => c.isBlocker)) {
      results.push(makeSkippedResult(decision, "skipped-blocker"));
      failureCount++;
      continue;
    }

    const result = dispatchDecision(decision, workingVfs, opts);
    results.push(result);

    if (result.status === "failed") {
      failureCount++;
    }
  }

  // ── Build audit trail ─────────────────────────────────────────────────────
  const durationMs = Date.now() - startMs;
  const audit = buildAudit(
    plan,
    results,
    startedAt,
    durationMs,
    rollbackSnapshot,
    opts,
    abortedEarly
  );

  // In dryRun the caller's vfs is untouched; return the original reference.
  return {
    vfs: opts.dryRun ? vfs : workingVfs,
    audit,
    rollbackSnapshot,
  };
}

// ─── Action dispatch ──────────────────────────────────────────────────────────

function dispatchDecision(
  decision: MergeDecision,
  vfs: VirtualFileSystem,
  opts: Required<ExecutionOptions>
): DecisionResult {
  switch (decision.action) {
    case "CREATE":
      return executeCreate(decision, vfs, opts.dryRun, opts.defaultFramework);
    case "UPDATE":
      return executeUpdate(decision, vfs, opts.dryRun, opts.defaultFramework);
    case "EXTEND":
      return executeExtend(decision, vfs, opts.dryRun, opts.defaultFramework);
    case "ARCHIVE":
      return executeArchive(decision, vfs, opts.dryRun, opts.archiveDir, opts.defaultFramework);
    case "IGNORE":
      return executeIgnore(decision);
    default: {
      const unknown = (decision as MergeDecision).action;
      return {
        decisionId: decision.id,
        action: decision.action,
        entityKind: decision.entityKind,
        status: "failed",
        fileChanges: [],
        durationMs: 0,
        error: `Unknown action: ${String(unknown)}`,
      };
    }
  }
}

function makeSkippedResult(
  decision: MergeDecision,
  reason: string
): DecisionResult {
  return {
    decisionId: decision.id,
    action: decision.action,
    entityKind: decision.entityKind,
    status: "failed",
    fileChanges: [],
    durationMs: 0,
    error: reason,
  };
}
