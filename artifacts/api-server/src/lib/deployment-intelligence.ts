/**
 * deployment-intelligence.ts — Phase 5.9
 *
 * Orchestrates autonomous deployment planning:
 *   1. Detects environment (hosting, DB, storage, env vars)
 *   2. Generates target plans for all 4 targets: replit, vercel, cloudflare, docker
 *   3. Picks the recommended target with reasoning
 *   4. Scores deploymentRisk (LOW | MEDIUM | HIGH) and compatibilityScore (0-100)
 *   5. Builds a unified deployment checklist
 *   6. Writes deployment-intelligence-report.json + deployment-checklist.json locally + to R2
 *
 * Entry point: runDeploymentIntelligence(sourceUrl, jobId?, cloudProvider?, detectedFramework?)
 */

import { writeFile } from "fs/promises";
import { join }      from "path";
import {
  detectEnvironment,
  generateAllTargetPlans,
  pickRecommendedTarget,
  scoreDeploymentRisk,
  buildDeploymentChecklist,
} from "@workspace/deployment-adapters";
import type { DeploymentIntelligenceReport } from "@workspace/deployment-adapters";
import type { DeploymentChecklist }           from "@workspace/deployment-adapters";
import { logger }    from "./logger.js";
import type { CloudProvider } from "../cloud/provider.js";

// Write to both the server CWD and the monorepo workspace root
const LOCAL_INTEL_PATH      = join(process.cwd(), "deployment-intelligence-report.json");
const LOCAL_CHECKLIST_PATH  = join(process.cwd(), "deployment-checklist.json");
const WORKSPACE_INTEL_PATH  = join(process.cwd(), "..", "..", "deployment-intelligence-report.json");
const WORKSPACE_CHECK_PATH  = join(process.cwd(), "..", "..", "deployment-checklist.json");

export async function runDeploymentIntelligence(
  sourceUrl:         string,
  jobId:             string | null = null,
  cloudProvider?:    CloudProvider,
  detectedFramework?: string
): Promise<DeploymentIntelligenceReport> {
  const t0 = Date.now();
  logger.info({ sourceUrl, jobId, detectedFramework }, "DEPLOY-INTEL: starting environment detection");

  // ── Core analysis ────────────────────────────────────────────────────────────
  const env     = detectEnvironment();
  const targets = generateAllTargetPlans(sourceUrl, env);
  const { target: recommended, reasoning } = pickRecommendedTarget(targets, env);

  // ── Phase 5.9: Risk + compatibility scoring ───────────────────────────────────
  const risk = scoreDeploymentRisk(env, targets, recommended, detectedFramework);

  // ── Phase 5.9: Unified deployment checklist ───────────────────────────────────
  const checklist = buildDeploymentChecklist(sourceUrl, recommended, targets, risk, env);

  const report: DeploymentIntelligenceReport = {
    version:     "1.0",
    phase:       "5.9",
    generatedAt: new Date().toISOString(),
    sourceUrl,
    jobId,
    environment: env,
    targets,
    recommended,
    reasoning,
    risk,
    outputFiles: {
      intelligenceReport: "deployment-intelligence-report.json",
      checklist:          "deployment-checklist.json",
    },
  };

  const durationMs = Date.now() - t0;
  logger.info(
    {
      sourceUrl, jobId, recommended, durationMs,
      hosting:          env.detectedHosting,
      deploymentRisk:   risk.deploymentRisk,
      compatibilityScore: risk.compatibilityScore,
      checklistItems:   checklist.totalItems,
      criticalItems:    checklist.criticalItems,
    },
    "DEPLOY-INTEL: report generated"
  );

  // ── Persist files ─────────────────────────────────────────────────────────────
  const reportJson    = JSON.stringify(report,    null, 2);
  const checklistJson = JSON.stringify(checklist, null, 2);

  const writes: Promise<void>[] = [
    writeFile(LOCAL_INTEL_PATH,      reportJson,    "utf8").catch(err => logger.warn({ err }, "DEPLOY-INTEL: local intel write failed")),
    writeFile(LOCAL_CHECKLIST_PATH,  checklistJson, "utf8").catch(err => logger.warn({ err }, "DEPLOY-INTEL: local checklist write failed")),
    writeFile(WORKSPACE_INTEL_PATH,  reportJson,    "utf8").catch(err => logger.warn({ err }, "DEPLOY-INTEL: workspace intel write failed")),
    writeFile(WORKSPACE_CHECK_PATH,  checklistJson, "utf8").catch(err => logger.warn({ err }, "DEPLOY-INTEL: workspace checklist write failed")),
  ];

  if (jobId && cloudProvider?.isConfigured()) {
    const r2base = `jobs/${jobId}`;
    writes.push(
      cloudProvider.upload({
        key:         `${r2base}/deployment-intelligence-report.json`,
        data:        Buffer.from(reportJson,    "utf8"),
        contentType: "application/json",
        checkDuplicate: false,
      })
      .then(() => logger.info({ jobId }, "DEPLOY-INTEL: intelligence report uploaded to R2"))
      .catch(err  => logger.warn({ err, jobId }, "DEPLOY-INTEL: R2 intel upload failed (non-fatal)"))
    );

    writes.push(
      cloudProvider.upload({
        key:         `${r2base}/deployment-checklist.json`,
        data:        Buffer.from(checklistJson, "utf8"),
        contentType: "application/json",
        checkDuplicate: false,
      })
      .then(() => logger.info({ jobId }, "DEPLOY-INTEL: checklist uploaded to R2"))
      .catch(err  => logger.warn({ err, jobId }, "DEPLOY-INTEL: R2 checklist upload failed (non-fatal)"))
    );
  }

  await Promise.allSettled(writes);

  // Attach the checklist to the return value (not in the type, but callers can access it)
  (report as typeof report & { _checklist: DeploymentChecklist })._checklist = checklist;

  return report;
}
