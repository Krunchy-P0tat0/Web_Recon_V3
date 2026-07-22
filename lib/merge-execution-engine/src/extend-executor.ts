import type { MergeDecision, VirtualFileSystem, DecisionResult, FileChange } from "./types.js";
import { buildExtendEntry } from "./stubs.js";

/**
 * EXTEND executor — scraped content fits an existing dynamic route/component;
 * the existing structure can handle it without structural change.
 *
 * Strategy: locate the target file and append a new data entry to it.
 * If the target file does not exist yet in the VFS, create it with the entry.
 * The entry is a well-commented export that developers can wire into their
 * data layer (CMS, database seed, static data file, etc.).
 */
export function executeExtend(
  decision: MergeDecision,
  vfs: VirtualFileSystem,
  dryRun: boolean,
  defaultFramework: string
): DecisionResult {
  const startMs = Date.now();

  try {
    const targetPath = decision.target?.path;
    const sourcePath = decision.source?.path ?? "";
    const sourceName = decision.source?.name ?? decision.source?.id ?? "entry";
    const framework = String(decision.metadata["framework"] ?? defaultFramework);

    // Derive the data file path. If the target file is known, use it.
    // Otherwise, infer a data file next to the target route.
    const dataFilePath = targetPath
      ? deriveDataFilePath(targetPath)
      : `src/data/${toSlug(sourceName)}.ts`;

    const existingContent = vfs[dataFilePath] ?? "";
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

    const entry = buildExtendEntry(ctx);
    const updatedContent = existingContent + entry;
    const bytesBefore = Buffer.byteLength(existingContent, "utf8");
    const bytesAfter = Buffer.byteLength(updatedContent, "utf8");

    const fileChange: FileChange = {
      path: dataFilePath,
      operation: existingContent === "" ? "create" : "update",
      bytesBefore,
      bytesAfter,
      decisionId: decision.id,
    };

    if (!dryRun) {
      vfs[dataFilePath] = updatedContent;
    }

    return {
      decisionId: decision.id,
      action: "EXTEND",
      entityKind: decision.entityKind,
      status: "success",
      fileChanges: [fileChange],
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    return {
      decisionId: decision.id,
      action: "EXTEND",
      entityKind: decision.entityKind,
      status: "failed",
      fileChanges: [],
      durationMs: Date.now() - startMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Derive a companion data file path from a route file path.
 * e.g. "src/pages/blog/[slug].tsx" → "src/data/blog.ts"
 */
function deriveDataFilePath(routePath: string): string {
  const dir = routePath.split("/").slice(0, -1).join("/");
  const segments = dir.split("/").filter(Boolean);
  const meaningful = segments.filter(
    (s) => s !== "src" && s !== "pages" && s !== "app" && s !== "routes"
  );
  const base = meaningful.length > 0 ? meaningful.join("-") : "entries";
  return `src/data/${base}.ts`;
}

function toSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s]+/g, "-");
}
