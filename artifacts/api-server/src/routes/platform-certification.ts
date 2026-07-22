/**
 * platform-certification.ts — PS-3: Final Platform Certification Routes
 *
 *   GET  /api/platform-certification              — run + return full certification
 *   GET  /api/platform-certification/scores       — production/fidelity/overall scores only
 *   GET  /api/platform-certification/subsystems   — per-subsystem status table
 *   GET  /api/platform-certification/remaining    — remaining work items only
 *   GET  /api/platform-certification/:subsystem   — single subsystem detail
 */

import { Router, type IRouter } from "express";
import { runCertification } from "../lib/platform-certification-engine.js";

const router: IRouter = Router();

// Cache the result for the process lifetime to avoid redundant re-runs
let _cached: ReturnType<typeof runCertification> | null = null;

function getCert() {
  if (!_cached) _cached = runCertification();
  return _cached;
}

// GET /platform-certification
router.get("/platform-certification", (_req, res): void => {
  // Allow ?refresh=true to re-run
  if (_req.query["refresh"] === "true") _cached = null;
  res.json(getCert());
});

// GET /platform-certification/scores
router.get("/platform-certification/scores", (_req, res): void => {
  const c = getCert();
  res.json({
    version:                  c.version,
    certifiedAt:              c.certifiedAt,
    overallStatus:            c.overallStatus,
    productionReadinessScore: c.productionReadinessScore,
    visualFidelityScore:      c.visualFidelityScore,
    overallPlatformScore:     c.overallPlatformScore,
    grade:                    c.grade,
    certificationSummary:     c.certificationSummary,
  });
});

// GET /platform-certification/subsystems
router.get("/platform-certification/subsystems", (_req, res): void => {
  const c = getCert();
  res.json({
    totalSubsystems: c.totalSubsystems,
    completeCount:   c.completeCount,
    partialCount:    c.partialCount,
    brokenCount:     c.brokenCount,
    subsystems:      c.subsystems.map(s => ({
      subsystem:      s.subsystem,
      phase:          s.phase,
      status:         s.status,
      score:          s.score,
      routesPresent:  s.routesPresent,
      routesMissing:  s.routesMissing.length,
      enginesPresent: s.enginesPresent,
      enginesMissing: s.enginesMissing.length,
      notes:          s.notes,
    })),
  });
});

// GET /platform-certification/remaining
router.get("/platform-certification/remaining", (_req, res): void => {
  const c = getCert();
  res.json({
    totalItems: c.remainingWork.length,
    highCount:  c.remainingWork.filter(r => r.priority === "HIGH").length,
    mediumCount:c.remainingWork.filter(r => r.priority === "MEDIUM").length,
    lowCount:   c.remainingWork.filter(r => r.priority === "LOW").length,
    items:      c.remainingWork,
  });
});

// GET /platform-certification/:subsystem  (slug match)
router.get("/platform-certification/:subsystem", (req, res): void => {
  const slug = req.params["subsystem"]?.toLowerCase().replace(/-/g, " ") ?? "";
  const c    = getCert();
  const sub  = c.subsystems.find(
    s => s.subsystem.toLowerCase() === slug ||
         s.subsystem.toLowerCase().replace(/\s+/g, "-") === req.params["subsystem"]?.toLowerCase(),
  );
  if (!sub) {
    res.status(404).json({
      error: `Subsystem "${req.params["subsystem"]}" not found.`,
      available: c.subsystems.map(s => s.subsystem.toLowerCase().replace(/\s+/g, "-")),
    });
    return;
  }
  res.json(sub);
});

export default router;
