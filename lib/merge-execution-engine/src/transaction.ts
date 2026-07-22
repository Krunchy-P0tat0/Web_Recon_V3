import type { VirtualFileSystem, VFSSnapshot } from "./types.js";

/**
 * Capture a full copy of the VFS so it can be restored later.
 * This is an O(n) clone — only enable for small-to-medium codebases.
 */
export function snapshotVfs(vfs: VirtualFileSystem): VFSSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    files: { ...vfs },
  };
}

/**
 * Restore a VFS to a previously captured snapshot.
 * Returns a fresh object; the original snapshot is not mutated.
 */
export function rollbackVfs(snapshot: VFSSnapshot): VirtualFileSystem {
  return { ...snapshot.files };
}

/**
 * Apply a set of file mutations atomically inside a try/catch.
 * On success, the mutations are written to `vfs` in place.
 * On failure, no changes are applied and the error is re-thrown.
 *
 * @param vfs   The VFS to mutate (modified in-place on success)
 * @param apply A function that returns a map of path → new content to write.
 *              Returning undefined for a path deletes it.
 */
export function atomicWrite(
  vfs: VirtualFileSystem,
  apply: () => Record<string, string | undefined>
): void {
  const changes = apply();

  for (const [path, content] of Object.entries(changes)) {
    if (content === undefined) {
      delete vfs[path];
    } else {
      vfs[path] = content;
    }
  }
}
