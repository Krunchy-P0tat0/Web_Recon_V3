/**
 * backend-detection-d1.ts — Phase D1 Routes
 *
 * POST /backend-detection/analyze                             — run D1 on a source path
 * GET  /backend-detection                                     — list all detections
 * GET  /backend-detection/:detectionId                        — full D1 bundle
 * GET  /backend-detection/:detectionId/backend-profile        — backend-profile.json
 * GET  /backend-detection/:detectionId/framework-detection-report — framework-detection-report.json
 * GET  /backend-detection/:detectionId/technology-stack       — technology-stack.json
 * GET  /backend-detection/:detectionId/dependency-map         — dependency-map.json
 */

import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import {
  runBackendDetection,
  getD1Bundle,
  listD1Bundles,
} from "../lib/backend-detection-engine-d1.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /backend-detection/analyze
// ---------------------------------------------------------------------------
router.post("/backend-detection/analyze", async (req, res): Promise<void> => {
  const { sourcePath, detectionId, projectName } = req.body ?? {};

  if (!sourcePath || typeof sourcePath !== "string") {
    res.status(400).json({ error: "sourcePath (string) is required — absolute or relative path to the project directory" });
    return;
  }

  const id = (typeof detectionId === "string" && detectionId.trim())
    ? detectionId.trim()
    : randomUUID();

  try {
    const bundle = await runBackendDetection({
      detectionId: id,
      sourcePath,
      projectName: typeof projectName === "string" ? projectName : undefined,
    });

    const p  = bundle.backendProfile;
    const ts = bundle.technologyStack;

    res.status(200).json({
      detectionId:            bundle.detectionId,
      generatedAt:            bundle.generatedAt,
      r2Keys:                 bundle.r2Keys,
      backendConfidenceScore: p.backendConfidenceScore,
      framework:              { value: p.framework.value, confidence: p.framework.confidence },
      language:               { value: p.language.value,  confidence: p.language.confidence },
      databases:              p.databases.map(d => ({ value: d.value, confidence: d.confidence })),
      orm:                    p.orm.value,
      auth:                   p.auth.value,
      apiStyle:               p.apiStyle.value,
      routingStyle:           p.routingStyle.value,
      deploymentTargets:      p.deploymentTargets.map(d => d.value),
      packageManager:         p.packageManager,
      totalFilesScanned:      p.totalFilesScanned,
      modernityScore:         ts.modernityScore,
      maturityScore:          ts.maturityScore,
      developerExperienceScore: ts.developerExperienceScore,
      stackName:              ts.stackName,
      summary:                p.summary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("does not exist") || msg.includes("not a directory")) {
      res.status(400).json({ error: msg });
      return;
    }
    req.log.error({ err, sourcePath }, "D1: backend detection failed");
    res.status(500).json({ error: "Backend detection failed", detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /backend-detection
// ---------------------------------------------------------------------------
router.get("/backend-detection", (_req, res): void => {
  res.status(200).json(listD1Bundles());
});

// ---------------------------------------------------------------------------
// GET /backend-detection/:detectionId — full bundle
// ---------------------------------------------------------------------------
router.get("/backend-detection/:detectionId", (req, res): void => {
  const bundle = getD1Bundle(req.params.detectionId!);
  if (!bundle) { res.status(404).json({ error: `No D1 detection found for id "${req.params.detectionId}"` }); return; }
  res.status(200).json(bundle);
});

// ---------------------------------------------------------------------------
// GET /backend-detection/:detectionId/backend-profile
// ---------------------------------------------------------------------------
router.get("/backend-detection/:detectionId/backend-profile", (req, res): void => {
  const bundle = getD1Bundle(req.params.detectionId!);
  if (!bundle) { res.status(404).json({ error: `No D1 detection found for id "${req.params.detectionId}"` }); return; }
  res.status(200).json(bundle.backendProfile);
});

// ---------------------------------------------------------------------------
// GET /backend-detection/:detectionId/framework-detection-report
// ---------------------------------------------------------------------------
router.get("/backend-detection/:detectionId/framework-detection-report", (req, res): void => {
  const bundle = getD1Bundle(req.params.detectionId!);
  if (!bundle) { res.status(404).json({ error: `No D1 detection found for id "${req.params.detectionId}"` }); return; }
  res.status(200).json(bundle.frameworkDetectionReport);
});

// ---------------------------------------------------------------------------
// GET /backend-detection/:detectionId/technology-stack
// ---------------------------------------------------------------------------
router.get("/backend-detection/:detectionId/technology-stack", (req, res): void => {
  const bundle = getD1Bundle(req.params.detectionId!);
  if (!bundle) { res.status(404).json({ error: `No D1 detection found for id "${req.params.detectionId}"` }); return; }
  res.status(200).json(bundle.technologyStack);
});

// ---------------------------------------------------------------------------
// GET /backend-detection/:detectionId/dependency-map
// ---------------------------------------------------------------------------
router.get("/backend-detection/:detectionId/dependency-map", (req, res): void => {
  const bundle = getD1Bundle(req.params.detectionId!);
  if (!bundle) { res.status(404).json({ error: `No D1 detection found for id "${req.params.detectionId}"` }); return; }
  res.status(200).json(bundle.dependencyMap);
});

export default router;
