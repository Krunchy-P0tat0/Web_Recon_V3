import type { MergeDecision, VirtualFileSystem, DecisionResult, FileChange } from "./types.js";
import { generateCreateStub, deriveFilePath } from "./stubs.js";

/**
 * CREATE executor — entity exists in scraped content but not in the codebase.
 * Generates a new stub file at the appropriate path and writes it to the VFS.
 */
export function executeCreate(
  decision: MergeDecision,
  vfs: VirtualFileSystem,
  dryRun: boolean,
  defaultFramework: string
): DecisionResult {
  const startMs = Date.now();

  try {
    const name = decision.source?.name ?? decision.source?.id ?? "unknown";
    const path = decision.source?.path ?? `/${name}`;
    const framework = String(decision.metadata["framework"] ?? defaultFramework);

    const ctx = {
      name,
      path,
      framework,
      entityKind: decision.entityKind,
      metadata: {
        ...decision.metadata,
        decisionId: decision.id,
        reason: decision.reason,
      },
    };

    const { content, ext } = generateCreateStub(ctx);
    const filePath = deriveFilePath(ctx, ext);

    const fileChange: FileChange = {
      path: filePath,
      operation: "create",
      bytesBefore: 0,
      bytesAfter: Buffer.byteLength(content, "utf8"),
      decisionId: decision.id,
    };

    if (!dryRun) {
      vfs[filePath] = content;
    }

    return {
      decisionId: decision.id,
      action: "CREATE",
      entityKind: decision.entityKind,
      status: "success",
      fileChanges: [fileChange],
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    return {
      decisionId: decision.id,
      action: "CREATE",
      entityKind: decision.entityKind,
      status: "failed",
      fileChanges: [],
      durationMs: Date.now() - startMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
