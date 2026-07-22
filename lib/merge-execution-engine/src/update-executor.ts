import type { MergeDecision, VirtualFileSystem, DecisionResult, FileChange } from "./types.js";
import { buildUpdateBlock } from "./stubs.js";

/**
 * UPDATE executor — entity exists in both graphs; codebase version needs
 * modification to accommodate the scraped content.
 *
 * Strategy: append a clearly-delimited merge block to the end of the
 * existing file. This is the safest non-destructive update: it preserves
 * all original code while giving developers clear merge instructions.
 */
export function executeUpdate(
  decision: MergeDecision,
  vfs: VirtualFileSystem,
  dryRun: boolean,
  defaultFramework: string
): DecisionResult {
  const startMs = Date.now();

  try {
    const targetPath = decision.target?.path;
    if (!targetPath) {
      throw new Error(
        `UPDATE decision ${decision.id} is missing target.path — cannot locate file to update`
      );
    }

    const existingContent = vfs[targetPath] ?? "";
    const framework = String(decision.metadata["framework"] ?? defaultFramework);
    const sourceName = decision.source?.name ?? decision.source?.id ?? "unknown";
    const sourcePath = decision.source?.path ?? "";

    const ctx = {
      name: sourceName,
      path: sourcePath,
      framework,
      entityKind: decision.entityKind,
      metadata: {
        ...decision.metadata,
        decisionId: decision.id,
        reason: decision.reason,
      },
    };

    const updatedContent = buildUpdateBlock(existingContent, ctx);
    const bytesBefore = Buffer.byteLength(existingContent, "utf8");
    const bytesAfter = Buffer.byteLength(updatedContent, "utf8");

    const fileChange: FileChange = {
      path: targetPath,
      operation: "update",
      bytesBefore,
      bytesAfter,
      decisionId: decision.id,
    };

    if (!dryRun) {
      vfs[targetPath] = updatedContent;
    }

    return {
      decisionId: decision.id,
      action: "UPDATE",
      entityKind: decision.entityKind,
      status: "success",
      fileChanges: [fileChange],
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    return {
      decisionId: decision.id,
      action: "UPDATE",
      entityKind: decision.entityKind,
      status: "failed",
      fileChanges: [],
      durationMs: Date.now() - startMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
