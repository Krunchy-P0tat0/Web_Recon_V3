import type { MergeDecision, VirtualFileSystem, DecisionResult, FileChange } from "./types.js";
import { buildArchiveHeader } from "./stubs.js";

/**
 * ARCHIVE executor — entity exists in the codebase but no scraped content
 * maps to it; candidate for archival.
 *
 * Strategy:
 *  1. Read the target file content from the VFS.
 *  2. Prepend an archive header documenting why and when it was archived.
 *  3. Write the annotated content to `<archiveDir>/<datestamp>_<basename>`.
 *  4. Delete the original file from the VFS.
 *
 * This is non-destructive: the original content survives in the archive.
 * Developers can recover archived files from source control at any time.
 */
export function executeArchive(
  decision: MergeDecision,
  vfs: VirtualFileSystem,
  dryRun: boolean,
  archiveDir: string,
  defaultFramework: string
): DecisionResult {
  const startMs = Date.now();

  try {
    const targetPath = decision.target?.path;
    if (!targetPath) {
      throw new Error(
        `ARCHIVE decision ${decision.id} is missing target.path — cannot locate file to archive`
      );
    }

    const originalContent = vfs[targetPath] ?? "";
    const framework = String(decision.metadata["framework"] ?? defaultFramework);
    const ctx = {
      name: decision.target?.name ?? targetPath.split("/").pop() ?? "unknown",
      path: targetPath,
      framework,
      entityKind: decision.entityKind,
      metadata: {
        ...decision.metadata,
        decisionId: decision.id,
        reason: decision.reason,
      },
    };

    const annotatedContent = buildArchiveHeader(originalContent, ctx);
    const archivePath = buildArchivePath(archiveDir, targetPath);

    const bytesBefore = Buffer.byteLength(originalContent, "utf8");
    const bytesAfter = Buffer.byteLength(annotatedContent, "utf8");

    const moveChange: FileChange = {
      path: archivePath,
      operation: "move",
      previousPath: targetPath,
      bytesBefore,
      bytesAfter,
      decisionId: decision.id,
    };

    if (!dryRun) {
      vfs[archivePath] = annotatedContent;
      delete vfs[targetPath];
    }

    return {
      decisionId: decision.id,
      action: "ARCHIVE",
      entityKind: decision.entityKind,
      status: "success",
      fileChanges: [moveChange],
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    return {
      decisionId: decision.id,
      action: "ARCHIVE",
      entityKind: decision.entityKind,
      status: "failed",
      fileChanges: [],
      durationMs: Date.now() - startMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build the archive destination path.
 * "src/pages/old-page.tsx" with archiveDir "_archive" and date "20260617"
 * → "_archive/20260617_src_pages_old-page.tsx"
 */
function buildArchivePath(archiveDir: string, originalPath: string): string {
  const datestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const flat = originalPath.replace(/\//g, "_");
  return `${archiveDir}/${datestamp}_${flat}`;
}
