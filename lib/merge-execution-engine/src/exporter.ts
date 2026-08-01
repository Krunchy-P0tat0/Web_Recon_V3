import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type {
  ExecuteMergePlanResult,
  ExportMergeResult,
  ExportPaths,
} from "./types.js";

/**
 * Write execution results to disk:
 *
 *  1. `<outputDir>/merge-audit.json`   — the full audit trail
 *  2. `<outputDir>/merged/<path>`       — every file created or updated by the
 *                                         execution (as written to the VFS)
 *
 * This is the only I/O step in the library. All other functions are pure.
 *
 * @param result    Return value of executeMergePlan()
 * @param outputDir Absolute or relative path to the output directory
 */
export async function exportMergeAudit(
  result: ExecuteMergePlanResult,
  outputDir: string
): Promise<ExportMergeResult> {
  const errors: string[] = [];
  let bytesWritten = 0;
  let fileCount = 0;

  const auditPath = join(outputDir, "merge-audit.json");
  const mergedFilesBase = join(outputDir, "merged");
  const mergedFiles: Record<string, string> = {};

  // ── 1. Write merge-audit.json ──────────────────────────────────────────────
  try {
    await mkdir(outputDir, { recursive: true });
    const auditJson = JSON.stringify(result.audit, null, 2);
    await writeFile(auditPath, auditJson, "utf8");
    bytesWritten += Buffer.byteLength(auditJson, "utf8");
    fileCount++;
  } catch (err) {
    errors.push(
      `Failed to write merge-audit.json: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // ── 2. Write merged VFS files ─────────────────────────────────────────────
  // Only write files that were touched during execution (created, updated, or
  // the destination of a move). Ignored and failed decisions produce no output.

  const touchedPaths = new Set(
    result.audit.fileChanges
      .filter((c) => c.operation !== "delete")
      .map((c) => c.path)
  );

  for (const relativePath of touchedPaths) {
    const content = result.vfs[relativePath];
    if (content === undefined) continue;

    const absPath = join(mergedFilesBase, relativePath);
    try {
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      bytesWritten += bytes;
      fileCount++;
      mergedFiles[relativePath] = absPath;
    } catch (err) {
      errors.push(
        `Failed to write merged file ${relativePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const paths: ExportPaths = {
    auditJson: auditPath,
    mergedFiles,
  };

  return {
    success: errors.length === 0,
    paths,
    bytesWritten,
    fileCount,
    errors,
  };
}
