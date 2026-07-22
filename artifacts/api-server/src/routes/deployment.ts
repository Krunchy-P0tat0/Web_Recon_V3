/**
 * deployment.ts — Phase D2 + Phase 5.9 Deployment Intelligence routes
 *
 * Phase D2 endpoints (framework adapters):
 *   POST /deploy/plan               — Detect framework from URL, generate build plan
 *   POST /deploy/plan/all           — Generate plans for all 6 frameworks
 *   GET  /deploy/plan               — List / retrieve cached framework plans
 *   GET  /deploy/frameworks         — List all supported framework adapters
 *
 * Phase 5.9 endpoints (autonomous deployment planning):
 *   POST /deploy/intelligence       — Full intelligence: env + risk + checklist
 *   GET  /deploy/intelligence       — Latest cached intelligence report
 *   GET  /deploy/intelligence/risk  — Risk assessment only (deploymentRisk + compatibilityScore)
 *   GET  /deploy/intelligence/checklist — Latest deployment checklist
 *   GET  /deploy/targets            — List all supported deployment targets
 */

import { readFile }   from "fs/promises";
import { join }       from "path";
import { existsSync } from "fs";
import { Router, type IRouter } from "express";
import {
  generateDeploymentPlan,
  generateAllDeploymentPlans,
  getSupportedFrameworks,
  hasAdapter,
  getSupportedTargets,
  type FrameworkId,
  type DeploymentPlan,
  type DeploymentIntelligenceReport,
} from "@workspace/deployment-adapters";
import type { DeploymentChecklist } from "@workspace/deployment-adapters";
import { fingerprintFramework }      from "../lib/http-framework-fingerprinter.js";
import { runDeploymentIntelligence } from "../lib/deployment-intelligence.js";
import { R2Provider }                from "../cloud/r2.provider.js";

const router: IRouter = Router();

// ── File paths for generated artifacts ────────────────────────────────────────
const WORKSPACE_ROOT    = join(process.cwd(), "..", "..");
const INTEL_REPORT_PATH = join(WORKSPACE_ROOT, "deployment-intelligence-report.json");
const CHECKLIST_PATH    = join(WORKSPACE_ROOT, "deployment-checklist.json");

// ── In-memory caches ──────────────────────────────────────────────────────────
const planCache = new Map<string, DeploymentPlan>();
const MAX_CACHE = 50;

let latestIntelligenceReport: DeploymentIntelligenceReport | null = null;
let latestChecklist: DeploymentChecklist | null = null;

// ── Phase D2: Framework adapters ──────────────────────────────────────────────

router.get("/deploy/frameworks", (_req, res): void => {
  res.json({
    supported: getSupportedFrameworks(),
    total:     getSupportedFrameworks().length,
  });
});

router.post("/deploy/plan", async (req, res): Promise<void> => {
  const body = req.body as { url?: unknown };
  if (typeof body.url !== "string" || !body.url) {
    res.status(400).json({ error: "url (string) is required" });
    return;
  }
  const url = body.url;
  const normalizedUrl = url.trim().replace(/\/$/, "");

  req.log.info({ url }, "DEPLOY-PLAN: starting framework detection");

  try {
    const report    = await fingerprintFramework(url);
    const framework = report.detection.primary as FrameworkId;

    if (!hasAdapter(framework)) {
      res.status(422).json({
        error:     `No deployment adapter available for detected framework '${framework}'`,
        detection: report.detection,
        supported: getSupportedFrameworks(),
      });
      return;
    }

    const plan = generateDeploymentPlan({
      framework,
      version:   report.detection.version,
      features:  report.detection.features,
      sourceUrl: normalizedUrl,
    });

    if (planCache.size >= MAX_CACHE) {
      const firstKey = planCache.keys().next().value;
      if (firstKey) planCache.delete(firstKey);
    }
    planCache.set(normalizedUrl, plan);

    req.log.info({ url, framework, confidence: report.detection.confidence }, "DEPLOY-PLAN: plan generated");
    res.json({ plan, detection: report.detection });
  } catch (err) {
    req.log.error({ url, err }, "DEPLOY-PLAN: failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/deploy/plan/all", (req, res): void => {
  const { url = "https://example.com" } = (req.body ?? {}) as { url?: string };
  const plans = generateAllDeploymentPlans(url);
  res.json({ frameworks: getSupportedFrameworks(), plans });
});

router.get("/deploy/plan", (req, res): void => {
  const urlParam = req.query["url"] as string | undefined;

  if (urlParam) {
    const key  = urlParam.trim().replace(/\/$/, "");
    const plan = planCache.get(key);
    if (!plan) {
      res.status(404).json({ error: "No cached plan for that URL" });
      return;
    }
    res.json(plan);
    return;
  }

  res.json({ total: planCache.size, plans: Array.from(planCache.values()) });
});

// ── Phase 5.9: Deployment Target Intelligence ─────────────────────────────────

router.get("/deploy/targets", (_req, res): void => {
  res.json({
    supported:   getSupportedTargets(),
    total:       getSupportedTargets().length,
    description: "Deployment targets: infrastructure where the generated site can be deployed",
  });
});

/**
 * POST /deploy/intelligence
 *
 * Body (all optional):
 *   { url?: string, jobId?: string, framework?: string }
 *
 * 1. Detects current hosting environment, database, storage config
 * 2. Generates deployment plans for all 4 targets (replit, vercel, cloudflare, docker)
 * 3. Picks the recommended target with reasoning
 * 4. Scores deploymentRisk (LOW | MEDIUM | HIGH) + compatibilityScore (0-100)
 * 5. Builds a unified deployment checklist
 * 6. Writes deployment-intelligence-report.json + deployment-checklist.json
 */
router.post("/deploy/intelligence", async (req, res): Promise<void> => {
  const { url, jobId, framework } = (req.body ?? {}) as {
    url?:       string;
    jobId?:     string;
    framework?: string;
  };
  const sourceUrl = (url ?? "https://generated-site.example.com").trim().replace(/\/$/, "");

  req.log.info({ sourceUrl, jobId, framework }, "DEPLOY-INTEL: starting intelligence report");

  try {
    const r2     = new R2Provider();
    const report = await runDeploymentIntelligence(sourceUrl, jobId ?? null, r2, framework);

    latestIntelligenceReport = report;

    // Extract checklist from the internal property set by runDeploymentIntelligence
    const checklist = (report as typeof report & { _checklist?: DeploymentChecklist })._checklist;
    if (checklist) latestChecklist = checklist;

    req.log.info(
      {
        recommended:        report.recommended,
        deploymentRisk:     report.risk.deploymentRisk,
        compatibilityScore: report.risk.compatibilityScore,
        hosting:            report.environment.detectedHosting,
        database:           report.environment.database.kind,
        storage:            report.environment.storage.kind,
        checklistItems:     checklist?.totalItems ?? 0,
      },
      "DEPLOY-INTEL: complete"
    );

    res.json({
      report,
      checklist: checklist ?? null,
      summary: {
        recommended:        report.recommended,
        reasoning:          report.reasoning,
        deploymentRisk:     report.risk.deploymentRisk,
        compatibilityScore: report.risk.compatibilityScore,
        riskSummary:        report.risk.summary,
        hosting:            report.environment.detectedHosting,
        database:           report.environment.database.kind,
        storage:            report.environment.storage.kind,
        nodeVersion:        report.environment.nodeVersion,
        targets:            getSupportedTargets(),
        checklistItems:     checklist?.totalItems ?? 0,
        criticalItems:      checklist?.criticalItems ?? 0,
        outputFiles:        report.outputFiles,
        r2Uploaded:         Boolean(jobId && r2.isConfigured()),
      },
    });
  } catch (err) {
    req.log.error({ sourceUrl, jobId, err }, "DEPLOY-INTEL: failed");
    res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /deploy/intelligence — retrieve the latest cached intelligence report
 */
router.get("/deploy/intelligence", (_req, res): void => {
  if (!latestIntelligenceReport) {
    res.status(404).json({
      error: "No intelligence report generated yet. POST /api/deploy/intelligence first.",
    });
    return;
  }
  res.json({ report: latestIntelligenceReport });
});

/**
 * GET /deploy/intelligence/risk — risk assessment + compatibility score only
 */
router.get("/deploy/intelligence/risk", async (_req, res): Promise<void> => {
  // Try in-memory first
  if (latestIntelligenceReport) {
    const { risk, recommended, generatedAt } = latestIntelligenceReport;
    res.json({
      deploymentRisk:     risk.deploymentRisk,
      compatibilityScore: risk.compatibilityScore,
      summary:            risk.summary,
      riskFactors:        risk.riskFactors,
      compatibilityNotes: risk.compatibilityNotes,
      recommended,
      generatedAt,
    });
    return;
  }

  // Try reading from disk
  if (existsSync(INTEL_REPORT_PATH)) {
    try {
      const raw    = await readFile(INTEL_REPORT_PATH, "utf8");
      const report = JSON.parse(raw) as DeploymentIntelligenceReport;
      const { risk, recommended, generatedAt } = report;
      res.json({
        deploymentRisk:     risk.deploymentRisk,
        compatibilityScore: risk.compatibilityScore,
        summary:            risk.summary,
        riskFactors:        risk.riskFactors,
        compatibilityNotes: risk.compatibilityNotes,
        recommended,
        generatedAt,
      });
      return;
    } catch {
      // fall through to 404
    }
  }

  res.status(404).json({
    error: "No risk assessment available. POST /api/deploy/intelligence first.",
  });
});

/**
 * GET /deploy/intelligence/checklist — unified deployment checklist
 */
router.get("/deploy/intelligence/checklist", async (_req, res): Promise<void> => {
  const priority = _req.query["priority"] as string | undefined;

  // Try in-memory first
  let checklist: DeploymentChecklist | null = latestChecklist;

  // Try reading from disk if not in memory
  if (!checklist && existsSync(CHECKLIST_PATH)) {
    try {
      const raw = await readFile(CHECKLIST_PATH, "utf8");
      checklist = JSON.parse(raw) as DeploymentChecklist;
      latestChecklist = checklist;
    } catch {
      // fall through to 404
    }
  }

  if (!checklist) {
    res.status(404).json({
      error: "No checklist generated yet. POST /api/deploy/intelligence first.",
    });
    return;
  }

  const items = priority
    ? checklist.items.filter(i => i.priority === priority)
    : checklist.items;

  res.json({
    ...checklist,
    items,
    ...(priority ? { filtered: { priority, count: items.length } } : {}),
  });
});

export default router;
