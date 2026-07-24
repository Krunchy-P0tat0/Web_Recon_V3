import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { StencilRegistry, ExportRegistryResult } from "./types.js";

/**
 * Write the StencilRegistry to disk as `stencil-registry.json`.
 *
 * This is the only I/O step in the library.
 * All other functions in this package are pure and synchronous.
 *
 * @param registry  Output of buildStencilRegistry()
 * @param outputDir Directory where the file is written
 *                  (created recursively if absent)
 */
export async function exportStencilRegistry(
  registry: StencilRegistry,
  outputDir: string
): Promise<ExportRegistryResult> {
  const outputPath = join(outputDir, "stencil-registry.json");
  const errors: string[] = [];
  let bytesWritten = 0;

  try {
    await mkdir(dirname(outputPath), { recursive: true });
    const json = JSON.stringify(registry, null, 2);
    await writeFile(outputPath, json, "utf8");
    bytesWritten = Buffer.byteLength(json, "utf8");
  } catch (err) {
    errors.push(
      `Failed to write stencil-registry.json: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  return {
    success: errors.length === 0,
    outputPath,
    bytesWritten,
    errors,
  };
}
