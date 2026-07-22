/**
 * deployment-plan-runner.ts — Phase D2 Deployment Plan runner (deploying stage)
 *
 * Generates deployment plans for all supported frameworks from the crawled URL,
 * uploads to R2 as jobs/{jobId}/deployment-plan.json, and writes a local copy.
 *
 * Pure / sync at core — the only I/O is the R2 upload and local file write.
 */

import { writeFile } from "fs/promises";
import { join } from "path";
import { generateAllDeploymentPlans } from "@workspace/deployment-adapters";
import { loadManifest } from "./manifest-store";
import { logger } from "./logger";
import type { CloudProvider } from "../cloud/provider";

const LOCAL_REPORT_PATH = join(process.cwd(), "deployment-plan.json");

export async function runAndStoreDeploymentPlan(
  jobId: string,
  cloudProvider: CloudProvider,
): Promise<void> {
  logger.info({ jobId }, "DEPLOY-PLAN: generating deployment plans");
  const startMs = Date.now();

  const manifest = await loadManifest(jobId);
  if (!manifest) {
    logger.warn({ jobId }, "DEPLOY-PLAN: manifest not found — skipping");
    return;
  }

  // generateAllDeploymentPlans is pure + sync — no I/O
  const plans = generateAllDeploymentPlans(manifest.seedUrl);
  const durationMs = Date.now() - startMs;

  const reportJson = JSON.stringify(
    {
      meta: {
        jobId,
        url:         manifest.seedUrl,
        generatedAt: new Date().toISOString(),
        phase:       "D2",
        durationMs,
        frameworkCount: Object.keys(plans).length,
      },
      plans,
    },
    null,
    2,
  );

  logger.info(
    { jobId, frameworks: Object.keys(plans), durationMs },
    "DEPLOY-PLAN: all deployment plans generated",
  );

  // Upload to R2
  if (cloudProvider.isConfigured()) {
    await cloudProvider
      .upload({
        key:            `jobs/${jobId}/deployment-plan.json`,
        data:           Buffer.from(reportJson, "utf8"),
        contentType:    "application/json",
        checkDuplicate: false,
      })
      .catch((err) =>
        logger.warn({ err, jobId }, "DEPLOY-PLAN: R2 upload failed (non-fatal)"),
      );
  }

  // Write local last-run sample
  await writeFile(LOCAL_REPORT_PATH, reportJson, "utf8").catch((err) =>
    logger.warn({ err }, "DEPLOY-PLAN: local write failed (non-fatal)"),
  );
}
