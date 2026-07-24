/**
 * classification-runner.ts — Phase 4.3 Design Classification runner
 *
 * Orchestrates:
 *   Manifest (from DB) → extractDesignDNA() → generateClassificationReport()
 *     → R2 upload (jobs/{jobId}/design-classification-report.json)
 *     → local design-classification-report.json (last-run sample)
 *
 * Non-fatal — errors are logged and swallowed so the orchestrator keeps going.
 */

import { writeFile } from "fs/promises";
import { join } from "path";
import {
  extractDesignDNA,
  generateClassificationReport,
} from "@workspace/design-dna";
import type { ExtractionInput } from "@workspace/design-dna";
import { loadManifest } from "./manifest-store";
import { logger } from "./logger";
import type { CloudProvider } from "../cloud/provider";

// ─────────────────────────────────────────────────────────────────────────────
// Local report path (last-run sample, always overwritten)
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL_REPORT_PATH = join(process.cwd(), "design-classification-report.json");

// ─────────────────────────────────────────────────────────────────────────────
// Manifest → ExtractionInput adapter
// ─────────────────────────────────────────────────────────────────────────────

function buildExtractionInput(
  manifest: Awaited<ReturnType<typeof loadManifest>>,
  jobId: string,
): ExtractionInput | null {
  if (!manifest) return null;

  const pages = Array.from(manifest.nodes.values())
    .filter((n) => n.content?.cleanHtml)
    .map((n) => ({
      url:      n.metadata.url,
      html:     n.content.cleanHtml ?? "",
      nodeType: n.nodeType ?? "article",
    }));

  if (pages.length === 0) return null;

  return {
    url:    manifest.seedUrl,
    jobId,
    pages,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run Phase 4.3 classification for a completed scrape job.
 *
 * Steps:
 *   1. Load manifest from DB
 *   2. Build ExtractionInput from page HTML
 *   3. extractDesignDNA → DesignDNA
 *   4. generateClassificationReport → ClassificationReport
 *   5. Upload to R2 as jobs/{jobId}/design-classification-report.json
 *   6. Write local design-classification-report.json (last-run sample)
 */
export async function runAndStoreClassification(
  jobId: string,
  cloudProvider: CloudProvider,
): Promise<void> {
  logger.info({ jobId }, "CLASSIFY: starting Phase 4.3 design classification");
  const startMs = Date.now();

  // 1. Load manifest
  const manifest = await loadManifest(jobId);
  if (!manifest) {
    logger.warn({ jobId }, "CLASSIFY: manifest not found — skipping classification");
    return;
  }

  // 2. Build extraction input
  const input = buildExtractionInput(manifest, jobId);
  if (!input) {
    logger.warn({ jobId }, "CLASSIFY: no HTML pages found in manifest — skipping");
    return;
  }

  // 3. Extract DesignDNA
  const dna = extractDesignDNA(input);

  // 4. Classify
  const report = generateClassificationReport(dna, {
    url:   manifest.seedUrl,
    jobId,
  });

  const reportJson = JSON.stringify(report, null, 2);
  const durationMs = Date.now() - startMs;

  logger.info(
    {
      jobId,
      archetype:   report.profile.archetype,
      confidence:  report.profile.confidence,
      confidenceLabel: report.profile.confidenceLabel,
      durationMs,
    },
    "CLASSIFY: classification complete",
  );

  // 5. Upload to R2
  if (cloudProvider.isConfigured()) {
    await cloudProvider
      .upload({
        key:          `jobs/${jobId}/design-classification-report.json`,
        data:         Buffer.from(reportJson, "utf8"),
        contentType:  "application/json",
        checkDuplicate: false,
      })
      .catch((err) => {
        logger.warn(
          { err, jobId },
          "CLASSIFY: R2 upload of design-classification-report.json failed (non-fatal)",
        );
      });
  }

  // 6. Write local sample
  await writeFile(LOCAL_REPORT_PATH, reportJson, "utf8").catch((err) => {
    logger.warn({ err }, "CLASSIFY: failed to write local design-classification-report.json (non-fatal)");
  });
}
