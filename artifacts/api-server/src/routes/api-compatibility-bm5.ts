/**
 * api-compatibility-bm5.ts — Phase BM-5: API Compatibility Engine Routes
 *
 * POST /api/api-compatibility-bm5/:primeJobId/analyze
 *   Run the API compatibility analysis.
 *   Body:
 *   {
 *     backendJobId?: string,
 *     force?:        boolean,
 *     endpoints?:    ApiEndpointDescriptor[],
 *     primeUrl?:     string,
 *     backendUrl?:   string,
 *   }
 *   Returns: full ApiCompatibilityReport
 *
 * GET  /api/api-compatibility-bm5/:primeJobId/report
 *   Full api-compatibility-report.json
 *
 * GET  /api/api-compatibility-bm5/:primeJobId/score
 *   Quick summary: { compatibilityScore, grade, frontendCanConsume,
 *     keepCount, extendCount, replaceCount, blockCount }
 *
 * GET  /api/api-compatibility-bm5/:primeJobId/keep
 *   All KEEP-classified endpoints (prime can call as-is).
 *
 * GET  /api/api-compatibility-bm5/:primeJobId/extend
 *   All EXTEND-classified endpoints (prime needs adapters/headers).
 *
 * GET  /api/api-compatibility-bm5/:primeJobId/replace
 *   All REPLACE-classified endpoints (prime must build its own impl).
 *
 * GET  /api/api-compatibility-bm5/:primeJobId/block
 *   All BLOCK-classified endpoints (prime must never call these).
 *
 * GET  /api/api-compatibility-bm5/:primeJobId/endpoints
 *   All endpoint assessments, filterable by classification, protocol,
 *   breakingRisk, auth, tags.
 *   Query: ?classification=KEEP|EXTEND|REPLACE|BLOCK
 *          ?protocol=rest|graphql|trpc|grpc|jsonrpc|webhook
 *          ?risk=none|low|medium|high|critical
 *          ?auth=true|false
 *
 * GET  /api/api-compatibility-bm5/:primeJobId/endpoints/:id
 *   Single endpoint assessment by ID (e.g. API-0001).
 *
 * GET  /api/api-compatibility-bm5/:primeJobId/protocols
 *   Per-protocol breakdown: counts, compatibility status, notes.
 *
 * GET  /api/api-compatibility-bm5/:primeJobId/protocols/:protocol
 *   Full protocol detail (rest|graphql|trpc|grpc|jsonrpc|webhook).
 */

import { Router, type IRouter } from "express";
import {
  runApiCompatibilityEngine,
  getCachedApiCompatibilityReport,
  type ApiCompatibilityReport,
  type ApiProtocol,
  type ApiClassification,
  type BreakingRisk,
  type ApiEndpointDescriptor,
} from "../lib/api-compatibility-engine-bm5.js";

const router: IRouter = Router();

const VALID_CLASSIFICATIONS = new Set<ApiClassification>(["KEEP", "EXTEND", "REPLACE", "BLOCK"]);
const VALID_PROTOCOLS       = new Set<ApiProtocol>(["rest", "graphql", "trpc", "grpc", "jsonrpc", "webhook", "unknown"]);
const VALID_RISKS           = new Set<BreakingRisk>(["none", "low", "medium", "high", "critical"]);

// ── Helper ────────────────────────────────────────────────────────────────────

function requireReport(
  primeJobId: string,
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): ApiCompatibilityReport | null {
  const report = getCachedApiCompatibilityReport(primeJobId);
  if (!report) {
    res.status(404).json({
      error: "No BM-5 API compatibility report found for this primeJobId.",
      hint:  `POST /api/api-compatibility-bm5/${primeJobId}/analyze to run Phase BM-5.`,
    });
    return null;
  }
  return report;
}

// ── POST /api/api-compatibility-bm5/:primeJobId/analyze ──────────────────────

router.post("/api-compatibility-bm5/:primeJobId/analyze", async (req, res): Promise<void> => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  if (!primeJobId) { res.status(400).json({ error: "primeJobId is required" }); return; }

  const body        = (req.body ?? {}) as Record<string, unknown>;
  const backendJobId = typeof body["backendJobId"] === "string" ? body["backendJobId"].trim() : undefined;
  const force        = body["force"] === true;
  const endpoints    = Array.isArray(body["endpoints"])
    ? body["endpoints"] as ApiEndpointDescriptor[]
    : undefined;
  const primeUrl   = typeof body["primeUrl"]   === "string" ? body["primeUrl"].trim()   : undefined;
  const backendUrl = typeof body["backendUrl"] === "string" ? body["backendUrl"].trim() : undefined;

  // Validate endpoints if provided
  if (endpoints) {
    for (const ep of endpoints) {
      if (typeof ep.path !== "string") {
        res.status(400).json({ error: "Each endpoint must have { path: string, methods: string[], protocol: string }" });
        return;
      }
      if (!Array.isArray(ep.methods)) {
        res.status(400).json({ error: `Endpoint "${ep.path}" must have a methods array` });
        return;
      }
      if (!VALID_PROTOCOLS.has(ep.protocol as ApiProtocol)) {
        res.status(400).json({
          error: `Endpoint "${ep.path}" has invalid protocol "${ep.protocol}"`,
          valid: [...VALID_PROTOCOLS],
        });
        return;
      }
    }
  }

  req.log.info({ primeJobId, backendJobId, force, endpointCount: endpoints?.length ?? 0 }, "BM5: analyze requested");

  try {
    const report = await runApiCompatibilityEngine({ primeJobId, backendJobId, force, endpoints, primeUrl, backendUrl });
    res.status(200).json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err, primeJobId }, "BM5: analyze failed");
    res.status(500).json({ error: "BM-5 API compatibility analysis failed", detail: message });
  }
});

// ── GET /api/api-compatibility-bm5/:primeJobId/report ────────────────────────

router.get("/api-compatibility-bm5/:primeJobId/report", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (report) res.status(200).json(report);
});

// ── GET /api/api-compatibility-bm5/:primeJobId/score ─────────────────────────

router.get("/api-compatibility-bm5/:primeJobId/score", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  res.status(200).json({
    primeJobId,
    backendJobId:       report.backendJobId,
    generatedAt:        report.generatedAt,
    totalEndpoints:     report.totalEndpoints,
    compatibilityScore: report.compatibilityScore,
    grade:              report.grade,
    frontendCanConsume: report.frontendCanConsume,
    keepCount:          report.summary.keepCount,
    extendCount:        report.summary.extendCount,
    replaceCount:       report.summary.replaceCount,
    blockCount:         report.summary.blockCount,
    adaptersNeeded:     report.summary.adaptersNeeded,
    webhookCount:       report.summary.webhookCount,
    deprecatedCount:    report.summary.deprecatedCount,
    criticalBlocks:     report.summary.criticalBlocks,
    recommendation:     report.summary.recommendation,
  });
});

// ── GET /api/api-compatibility-bm5/:primeJobId/keep ──────────────────────────

router.get("/api-compatibility-bm5/:primeJobId/keep", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const proto = req.query["protocol"] as string | undefined;
  const items = proto ? report.keep.filter(a => a.protocol === proto) : report.keep;

  res.status(200).json({
    primeJobId,
    total:    report.keep.length,
    filtered: items.length,
    filter:   { protocol: proto ?? null },
    endpoints: items,
  });
});

// ── GET /api/api-compatibility-bm5/:primeJobId/extend ────────────────────────

router.get("/api-compatibility-bm5/:primeJobId/extend", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const proto = req.query["protocol"] as string | undefined;
  const items = proto ? report.extend.filter(a => a.protocol === proto) : report.extend;

  res.status(200).json({
    primeJobId,
    total:    report.extend.length,
    filtered: items.length,
    filter:   { protocol: proto ?? null },
    adaptersRequired: items.filter(a => a.adapterRequired).length,
    endpoints: items,
  });
});

// ── GET /api/api-compatibility-bm5/:primeJobId/replace ───────────────────────

router.get("/api-compatibility-bm5/:primeJobId/replace", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  res.status(200).json({
    primeJobId,
    total:     report.replace.length,
    deprecated: report.replace.filter(a => a.endpoint.deprecated).length,
    endpoints:  report.replace,
  });
});

// ── GET /api/api-compatibility-bm5/:primeJobId/block ─────────────────────────

router.get("/api-compatibility-bm5/:primeJobId/block", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  res.status(200).json({
    primeJobId,
    frontendCanConsume: report.frontendCanConsume,
    total:              report.block.length,
    criticalBlocks:     report.summary.criticalBlocks,
    webhooks:           report.block.filter(a => a.protocol === "webhook").length,
    endpoints:          report.block.map(a => ({
      id:           a.id,
      path:         a.endpoint.path,
      methods:      a.endpoint.methods,
      protocol:     a.protocol,
      breakingRisk: a.breakingRisk,
      reason:       a.issues[0] ?? "Blocked endpoint",
      action:       a.recommendations[0] ?? "Do not call this endpoint from the prime",
    })),
  });
});

// ── GET /api/api-compatibility-bm5/:primeJobId/endpoints ─────────────────────

router.get("/api-compatibility-bm5/:primeJobId/endpoints", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const clsFilter    = req.query["classification"] as string | undefined;
  const protoFilter  = req.query["protocol"]        as string | undefined;
  const riskFilter   = req.query["risk"]            as string | undefined;
  const authFilter   = req.query["auth"]            as string | undefined;

  if (clsFilter && !VALID_CLASSIFICATIONS.has(clsFilter as ApiClassification)) {
    res.status(400).json({ error: `Invalid classification "${clsFilter}"`, valid: [...VALID_CLASSIFICATIONS] });
    return;
  }
  if (protoFilter && !VALID_PROTOCOLS.has(protoFilter as ApiProtocol)) {
    res.status(400).json({ error: `Invalid protocol "${protoFilter}"`, valid: [...VALID_PROTOCOLS] });
    return;
  }
  if (riskFilter && !VALID_RISKS.has(riskFilter as BreakingRisk)) {
    res.status(400).json({ error: `Invalid risk "${riskFilter}"`, valid: [...VALID_RISKS] });
    return;
  }

  let items = report.assessments;
  if (clsFilter)  items = items.filter(a => a.classification === clsFilter);
  if (protoFilter) items = items.filter(a => a.protocol === protoFilter);
  if (riskFilter)  items = items.filter(a => a.breakingRisk === riskFilter);
  if (authFilter === "true")  items = items.filter(a =>  a.authRequired);
  if (authFilter === "false") items = items.filter(a => !a.authRequired);

  res.status(200).json({
    primeJobId,
    total:    report.assessments.length,
    filtered: items.length,
    filters:  { classification: clsFilter ?? null, protocol: protoFilter ?? null, risk: riskFilter ?? null, auth: authFilter ?? null },
    endpoints: items,
  });
});

// ── GET /api/api-compatibility-bm5/:primeJobId/endpoints/:id ─────────────────

router.get("/api-compatibility-bm5/:primeJobId/endpoints/:id", (req, res): void => {
  const p          = req.params as Record<string, string>;
  const primeJobId = p["primeJobId"] ?? "";
  const id         = p["id"]         ?? "";

  const report = requireReport(primeJobId, res);
  if (!report) return;

  const assessment = report.assessments.find(a => a.id === id);
  if (!assessment) {
    res.status(404).json({
      error:        `Endpoint "${id}" not found`,
      availableIds: report.assessments.map(a => a.id),
    });
    return;
  }

  res.status(200).json({ primeJobId, ...assessment });
});

// ── GET /api/api-compatibility-bm5/:primeJobId/protocols ─────────────────────

router.get("/api-compatibility-bm5/:primeJobId/protocols", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const summaries = Object.entries(report.protocols)
    .filter(([, p]) => p.totalCount > 0)
    .map(([proto, p]) => ({
      protocol:    proto,
      totalCount:  p.totalCount,
      keepCount:   p.keepCount,
      extendCount: p.extendCount,
      replaceCount:p.replaceCount,
      blockCount:  p.blockCount,
      compatible:  p.compatible,
      notes:       p.notes,
    }));

  res.status(200).json({
    primeJobId,
    totalEndpoints: report.totalEndpoints,
    frontendCanConsume: report.frontendCanConsume,
    protocols: summaries,
  });
});

// ── GET /api/api-compatibility-bm5/:primeJobId/protocols/:protocol ────────────

router.get("/api-compatibility-bm5/:primeJobId/protocols/:protocol", (req, res): void => {
  const p          = req.params as Record<string, string>;
  const primeJobId = p["primeJobId"] ?? "";
  const protocol   = p["protocol"]   ?? "";

  if (!VALID_PROTOCOLS.has(protocol as ApiProtocol)) {
    res.status(400).json({ error: `Invalid protocol "${protocol}"`, valid: [...VALID_PROTOCOLS] });
    return;
  }

  const report = requireReport(primeJobId, res);
  if (!report) return;

  const summary = report.protocols[protocol as ApiProtocol];
  res.status(200).json({ primeJobId, ...summary });
});

export default router;
