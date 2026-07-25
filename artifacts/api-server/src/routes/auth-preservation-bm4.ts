/**
 * auth-preservation-bm4.ts — Phase BM-4: Authentication Preservation Engine Routes
 *
 * POST /api/auth-preservation-bm4/:primeJobId/analyze
 *   Run the auth preservation analysis.
 *   Body (all optional):
 *   {
 *     backendJobId?:  string,
 *     force?:         boolean,
 *     authSystems?:   AuthSystemDescriptor[],  // full auth profile override
 *     primeUrl?:      string,
 *   }
 *   Returns: full AuthPreservationReport
 *
 * GET  /api/auth-preservation-bm4/:primeJobId/report
 *   Full auth-preservation-report.json
 *
 * GET  /api/auth-preservation-bm4/:primeJobId/score
 *   Quick summary: { preservationScore, riskLevel, mergeIsSafe, primarySystem,
 *     criticalComponents, hardConstraints, adaptersRequired }
 *
 * GET  /api/auth-preservation-bm4/:primeJobId/protected
 *   All protected components (files, routes, env-vars, middleware, tables).
 *   Query: ?system=sessions|jwt|oauth|nextauth|clerk|auth0|custom
 *          ?priority=CRITICAL|HIGH|MEDIUM|LOW
 *          ?kind=file|route|middleware|env-var|config|database-table|package
 *
 * GET  /api/auth-preservation-bm4/:primeJobId/constraints
 *   All merge constraints.
 *   Query: ?system=  ?enforcement=hard|soft  ?action=BLOCK|REQUIRE_ADAPTER|NAMESPACE|WARN
 *
 * GET  /api/auth-preservation-bm4/:primeJobId/adapters
 *   All required adapters.
 *   Query: ?system=  ?type=  ?auto=true|false
 *
 * GET  /api/auth-preservation-bm4/:primeJobId/systems
 *   Detected auth systems with confidence scores.
 */

import { Router, type IRouter } from "express";
import {
  runAuthPreservationEngine,
  getCachedAuthPreservationReport,
  type AuthPreservationReport,
  type AuthSystem,
  type AuthSystemDescriptor,
} from "../lib/auth-preservation-engine-bm4.js";

const router: IRouter = Router();

const VALID_SYSTEMS = new Set<AuthSystem>([
  "sessions", "jwt", "oauth", "nextauth", "clerk", "auth0", "custom", "none",
]);

// ── Helper ────────────────────────────────────────────────────────────────────

function requireReport(
  primeJobId: string,
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): AuthPreservationReport | null {
  const report = getCachedAuthPreservationReport(primeJobId);
  if (!report) {
    res.status(404).json({
      error: "No BM-4 auth preservation report found for this primeJobId.",
      hint:  `POST /api/auth-preservation-bm4/${primeJobId}/analyze to run Phase BM-4.`,
    });
    return null;
  }
  return report;
}

// ── POST /api/auth-preservation-bm4/:primeJobId/analyze ──────────────────────

router.post("/auth-preservation-bm4/:primeJobId/analyze", async (req, res): Promise<void> => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  if (!primeJobId) { res.status(400).json({ error: "primeJobId is required" }); return; }

  const body        = (req.body ?? {}) as Record<string, unknown>;
  const backendJobId = typeof body["backendJobId"] === "string" ? body["backendJobId"].trim() : undefined;
  const force        = body["force"] === true;
  const authSystems  = Array.isArray(body["authSystems"])
    ? body["authSystems"] as AuthSystemDescriptor[]
    : undefined;
  const primeUrl = typeof body["primeUrl"] === "string" ? body["primeUrl"].trim() : undefined;

  // Validate auth systems if provided
  if (authSystems) {
    for (const sys of authSystems) {
      if (!sys.system || !VALID_SYSTEMS.has(sys.system as AuthSystem)) {
        res.status(400).json({
          error:  `Invalid auth system "${sys.system}"`,
          valid:  [...VALID_SYSTEMS],
        });
        return;
      }
    }
  }

  req.log.info({ primeJobId, backendJobId, force, systems: authSystems?.map(s => s.system) }, "BM4: analyze requested");

  try {
    const report = await runAuthPreservationEngine({ primeJobId, backendJobId, force, authSystems, primeUrl });
    res.status(200).json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err, primeJobId }, "BM4: analyze failed");
    res.status(500).json({ error: "BM-4 auth preservation analysis failed", detail: message });
  }
});

// ── GET /api/auth-preservation-bm4/:primeJobId/report ────────────────────────

router.get("/auth-preservation-bm4/:primeJobId/report", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (report) res.status(200).json(report);
});

// ── GET /api/auth-preservation-bm4/:primeJobId/score ─────────────────────────

router.get("/auth-preservation-bm4/:primeJobId/score", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  res.status(200).json({
    primeJobId,
    backendJobId:         report.backendJobId,
    generatedAt:          report.generatedAt,
    primarySystem:        report.primarySystem,
    detectedSystemCount:  report.summary.totalDetectedSystems,
    preservationScore:    report.preservationScore,
    riskLevel:            report.riskLevel,
    mergeIsSafe:          report.mergeIsSafe,
    criticalComponents:   report.summary.criticalComponents,
    hardConstraints:      report.summary.hardConstraints,
    softConstraints:      report.summary.softConstraints,
    adaptersRequired:     report.summary.adaptersRequired,
    autoGenerableAdapters: report.summary.autoGenerableAdapters,
    blockingConstraints:  report.summary.blockingConstraints,
    recommendation:       report.summary.recommendation,
  });
});

// ── GET /api/auth-preservation-bm4/:primeJobId/protected ─────────────────────

router.get("/auth-preservation-bm4/:primeJobId/protected", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const systemFilter   = req.query["system"]   as string | undefined;
  const priorityFilter = req.query["priority"] as string | undefined;
  const kindFilter     = req.query["kind"]     as string | undefined;

  if (systemFilter && !VALID_SYSTEMS.has(systemFilter as AuthSystem)) {
    res.status(400).json({ error: `Invalid system "${systemFilter}"`, valid: [...VALID_SYSTEMS] });
    return;
  }

  let components = report.protectedComponents;
  if (systemFilter)   components = components.filter(c => c.system   === systemFilter);
  if (priorityFilter) components = components.filter(c => c.priority === priorityFilter);
  if (kindFilter)     components = components.filter(c => c.kind     === kindFilter);

  res.status(200).json({
    primeJobId,
    total:      report.protectedComponents.length,
    filtered:   components.length,
    filters:    { system: systemFilter ?? null, priority: priorityFilter ?? null, kind: kindFilter ?? null },
    critical:   components.filter(c => c.priority === "CRITICAL").length,
    mustNotTouch: components.filter(c => c.mustNotTouch).length,
    components,
  });
});

// ── GET /api/auth-preservation-bm4/:primeJobId/constraints ───────────────────

router.get("/auth-preservation-bm4/:primeJobId/constraints", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const systemFilter      = req.query["system"]      as string | undefined;
  const enforcementFilter = req.query["enforcement"] as string | undefined;
  const actionFilter      = req.query["action"]      as string | undefined;

  let constraints = report.mergeConstraints;
  if (systemFilter)      constraints = constraints.filter(c => c.system      === systemFilter);
  if (enforcementFilter) constraints = constraints.filter(c => c.enforcement === enforcementFilter);
  if (actionFilter)      constraints = constraints.filter(c => c.action      === actionFilter);

  res.status(200).json({
    primeJobId,
    total:              report.mergeConstraints.length,
    filtered:           constraints.length,
    filters:            { system: systemFilter ?? null, enforcement: enforcementFilter ?? null, action: actionFilter ?? null },
    hardCount:          constraints.filter(c => c.enforcement === "hard").length,
    softCount:          constraints.filter(c => c.enforcement === "soft").length,
    autoEnforceable:    constraints.filter(c => c.autoEnforceable).length,
    constraints,
  });
});

// ── GET /api/auth-preservation-bm4/:primeJobId/adapters ──────────────────────

router.get("/auth-preservation-bm4/:primeJobId/adapters", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const systemFilter = req.query["system"] as string | undefined;
  const typeFilter   = req.query["type"]   as string | undefined;
  const autoFilter   = req.query["auto"]   as string | undefined;

  let adapters = report.requiredAdapters;
  if (systemFilter) adapters = adapters.filter(a => a.system === systemFilter);
  if (typeFilter)   adapters = adapters.filter(a => a.type   === typeFilter);
  if (autoFilter === "true")  adapters = adapters.filter(a =>  a.canAutoGenerate);
  if (autoFilter === "false") adapters = adapters.filter(a => !a.canAutoGenerate);

  res.status(200).json({
    primeJobId,
    total:              report.requiredAdapters.length,
    filtered:           adapters.length,
    filters:            { system: systemFilter ?? null, type: typeFilter ?? null, auto: autoFilter ?? null },
    autoGenerableCount: adapters.filter(a => a.canAutoGenerate).length,
    manualCount:        adapters.filter(a => !a.canAutoGenerate).length,
    adapters,
  });
});

// ── GET /api/auth-preservation-bm4/:primeJobId/systems ───────────────────────

router.get("/auth-preservation-bm4/:primeJobId/systems", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  res.status(200).json({
    primeJobId,
    primarySystem:      report.primarySystem,
    totalDetected:      report.summary.totalDetectedSystems,
    detectedSystems:    report.detectedSystems,
    mergeIsSafe:        report.mergeIsSafe,
    riskLevel:          report.riskLevel,
    preservationScore:  report.preservationScore,
  });
});

export default router;
