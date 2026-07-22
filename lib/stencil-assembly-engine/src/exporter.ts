import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { SiteAssembly, ExportAssemblyResult } from "./types.js";

/**
 * Write the SiteAssembly to disk as `site-assembly.json`.
 *
 * This is the only I/O step in the library.
 * All other functions in this package are pure and synchronous.
 *
 * @param assembly  Output of assembleStencil()
 * @param outputDir Directory where the file is written
 *                  (created recursively if absent)
 */
export async function exportSiteAssembly(
  assembly: SiteAssembly,
  outputDir: string
): Promise<ExportAssemblyResult> {
  const outputPath = join(outputDir, "site-assembly.json");
  const errors: string[] = [];
  let bytesWritten = 0;

  try {
    await mkdir(dirname(outputPath), { recursive: true });
    const json = JSON.stringify(assembly, null, 2);
    await writeFile(outputPath, json, "utf8");
    bytesWritten = Buffer.byteLength(json, "utf8");
  } catch (err) {
    errors.push(
      `Failed to write site-assembly.json: ${
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
