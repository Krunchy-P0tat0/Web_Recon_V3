/**
 * data-binding-bm7.ts — Phase BM-7: Data Binding Engine Routes
 *
 * POST /api/data-binding-bm7/:primeJobId/analyze
 *   Run data binding analysis.
 *   Body:
 *   {
 *     backendJobId?: string,
 *     force?:        boolean,
 *     pages?:        PageDescriptor[],
 *     endpoints?:    ApiEndpointRef[],
 *     models?:       DatabaseModelRef[],
 *     framework?:    string,
 *     renderMode?:   "ssr"|"csr"|"ssg"|"isr"|"hybrid",
 *   }
 *   Returns: full BindingMap
 *
 * GET  /api/data-binding-bm7/:primeJobId/report
 *   Full binding-map.json
 *
 * GET  /api/data-binding-bm7/:primeJobId/score
 *   Quick summary: { livePageRate, boundCount, partialCount, unboundCount,
 *     blockedCount, dynamicPages, recommendation }
 *
 * GET  /api/data-binding-bm7/:primeJobId/bindings
 *   All binding entries, filterable by status, type, auth, realtime.
 *   Query: ?status=BOUND|PARTIAL|UNBOUND|BLOCKED
 *          ?type=static|server-fetch|client-fetch|real-time|form-submit|
 *                file-upload|auth-gated|paginated|search|mutation
 *          ?auth=true|false
 *
 * GET  /api/data-binding-bm7/:primeJobId/bindings/:id
 *   Single binding entry by ID (e.g. BND-0001).
 *
 * GET  /api/data-binding-bm7/:primeJobId/bound
 *   All BOUND bindings — fully resolved page ↔ endpoint ↔ model.
 *
 * GET  /api/data-binding-bm7/:primeJobId/partial
 *   All PARTIAL bindings — endpoint found but model unknown.
 *
 * GET  /api/data-binding-bm7/:primeJobId/unbound
 *   All UNBOUND bindings — no endpoint found; page remains static.
 *
 * GET  /api/data-binding-bm7/:primeJobId/blocked
 *   All BLOCKED bindings — endpoint unsafe or deprecated.
 *
 * GET  /api/data-binding-bm7/:primeJobId/endpoints
 *   Endpoint usage map: which endpoints are used by which pages.
 *
 * GET  /api/data-binding-bm7/:primeJobId/models
 *   Model usage map: which DB models are needed and by which pages.
 *
 * GET  /api/data-binding-bm7/:primeJobId/by-type
 *   Bindings grouped by binding type.
 *
 * GET  /api/data-binding-bm7/:primeJobId/by-type/:type
 *   All bindings of a specific type.
 */

import { Router, type IRouter } from "express";
import {
  runDataBindingEngine,
  getCachedBindingMap,
  type BindingMap,
  type BindingStatus,
  type BindingType,
  type PageDescriptor,
  type ApiEndpointRef,
  type DatabaseModelRef,
} from "../lib/data-binding-engine-bm7.js";

const router: IRouter = Router();

const VALID_STATUSES: Set<BindingStatus> = new Set(["BOUND", "PARTIAL", "UNBOUND", "BLOCKED"]);
const VALID_TYPES: Set<BindingType>      = new Set([
  "static", "server-fetch", "client-fetch", "real-time",
  "form-submit", "file-upload", "auth-gated", "paginated", "search", "mutation",
]);
const VALID_RENDER_MODES = new Set(["ssr", "csr", "ssg", "isr", "hybrid"]);

// ── Helper ────────────────────────────────────────────────────────────────────

function requireMap(
  primeJobId: string,
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): BindingMap | null {
  const map = getCachedBindingMap(primeJobId);
  if (!map) {
    res.status(404).json({
      error: "No BM-7 binding map found for this primeJobId.",
      hint:  `POST /api/data-binding-bm7/${primeJobId}/analyze to run Phase BM-7.`,
    });
    return null;
  }
  return map;
}

// ── POST /api/data-binding-bm7/:primeJobId/analyze ───────────────────────────

router.post("/data-binding-bm7/:primeJobId/analyze", async (req, res): Promise<void> => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  if (!primeJobId) { res.status(400).json({ error: "primeJobId is required" }); return; }

  const body        = (req.body ?? {}) as Record<string, unknown>;
  const backendJobId = typeof body["backendJobId"] === "string" ? body["backendJobId"].trim() : undefined;
  const force        = body["force"] === true;
  const pages        = Array.isArray(body["pages"])     ? body["pages"]     as PageDescriptor[]     : undefined;
  const endpoints    = Array.isArray(body["endpoints"]) ? body["endpoints"] as ApiEndpointRef[]     : undefined;
  const models       = Array.isArray(body["models"])    ? body["models"]    as DatabaseModelRef[]   : undefined;
  const framework    = typeof body["framework"]   === "string" ? body["framework"].trim()   : undefined;
  const renderMode   = typeof body["renderMode"]  === "string" ? body["renderMode"].trim()  : undefined;

  // Validate pages
  if (pages) {
    for (const p of pages) {
      if (typeof p.path !== "string") {
        res.status(400).json({ error: "Each page must have { path: string }" });
        return;
      }
    }
  }

  // Validate render mode
  if (renderMode && !VALID_RENDER_MODES.has(renderMode)) {
    res.status(400).json({ error: `Invalid renderMode "${renderMode}"`, valid: [...VALID_RENDER_MODES] });
    return;
  }

  req.log.info(
    {
      primeJobId, backendJobId, force,
      pageCount: pages?.length ?? 0,
      endpointCount: endpoints?.length ?? 0,
      modelCount: models?.length ?? 0,
    },
    "BM7: analyze requested",
  );

  try {
    const map = await runDataBindingEngine({ primeJobId, backendJobId, force, pages, endpoints, models, framework, renderMode: renderMode as any });
    res.status(200).json(map);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err, primeJobId }, "BM7: analyze failed");
    res.status(500).json({ error: "BM-7 data binding analysis failed", detail: message });
  }
});

// ── GET /api/data-binding-bm7/:primeJobId/report ─────────────────────────────

router.get("/data-binding-bm7/:primeJobId/report", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const map        = requireMap(primeJobId, res);
  if (map) res.status(200).json(map);
});

// ── GET /api/data-binding-bm7/:primeJobId/score ──────────────────────────────

router.get("/data-binding-bm7/:primeJobId/score", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const map        = requireMap(primeJobId, res);
  if (!map) return;

  res.status(200).json({
    primeJobId,
    backendJobId:        map.backendJobId,
    generatedAt:         map.generatedAt,
    framework:           map.framework,
    renderMode:          map.renderMode,
    totalPages:          map.totalPages,
    boundCount:          map.boundCount,
    partialCount:        map.partialCount,
    unboundCount:        map.unboundCount,
    blockedCount:        map.blockedCount,
    livePageRate:        map.livePageRate,
    dynamicPages:        map.summary.dynamicPages,
    staticPages:         map.summary.staticPages,
    authGatedPages:      map.summary.authGatedPages,
    realtimePages:       map.summary.realtimePages,
    totalEndpointsUsed:  map.summary.totalEndpointsUsed,
    totalModelsUsed:     map.summary.totalModelsUsed,
    unboundWarnings:     map.summary.unboundWarnings,
    recommendation:      map.summary.recommendation,
  });
});

// ── GET /api/data-binding-bm7/:primeJobId/bindings ───────────────────────────

router.get("/data-binding-bm7/:primeJobId/bindings", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const map        = requireMap(primeJobId, res);
  if (!map) return;

  const statusFilter = req.query["status"] as string | undefined;
  const typeFilter   = req.query["type"]   as string | undefined;
  const authFilter   = req.query["auth"]   as string | undefined;

  if (statusFilter && !VALID_STATUSES.has(statusFilter as BindingStatus)) {
    res.status(400).json({ error: `Invalid status "${statusFilter}"`, valid: [...VALID_STATUSES] });
    return;
  }
  if (typeFilter && !VALID_TYPES.has(typeFilter as BindingType)) {
    res.status(400).json({ error: `Invalid type "${typeFilter}"`, valid: [...VALID_TYPES] });
    return;
  }

  let items = map.bindings;
  if (statusFilter) items = items.filter(b => b.status      === statusFilter);
  if (typeFilter)   items = items.filter(b => b.bindingType === typeFilter);
  if (authFilter === "true")  items = items.filter(b => b.authRequired);
  if (authFilter === "false") items = items.filter(b => !b.authRequired);

  res.status(200).json({
    primeJobId,
    total:    map.bindings.length,
    filtered: items.length,
    filters:  { status: statusFilter ?? null, type: typeFilter ?? null, auth: authFilter ?? null },
    bindings: items,
  });
});

// ── GET /api/data-binding-bm7/:primeJobId/bindings/:id ───────────────────────

router.get("/data-binding-bm7/:primeJobId/bindings/:id", (req, res): void => {
  const p          = req.params as Record<string, string>;
  const primeJobId = p["primeJobId"] ?? "";
  const id         = p["id"]         ?? "";

  const map = requireMap(primeJobId, res);
  if (!map) return;

  const binding = map.bindings.find(b => b.id === id);
  if (!binding) {
    res.status(404).json({
      error:        `Binding "${id}" not found`,
      availableIds: map.bindings.map(b => b.id),
    });
    return;
  }

  res.status(200).json({ primeJobId, ...binding });
});

// ── GET /api/data-binding-bm7/:primeJobId/bound ──────────────────────────────

router.get("/data-binding-bm7/:primeJobId/bound", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const map        = requireMap(primeJobId, res);
  if (!map) return;

  res.status(200).json({
    primeJobId,
    total:    map.boundCount,
    bindings: map.bound.map(b => ({
      id:          b.id,
      page:        b.page.path,
      endpoint:    b.endpoint?.path,
      model:       b.model?.name,
      bindingType: b.bindingType,
      renderHint:  b.renderHint,
      queryKey:    b.queryKey,
    })),
  });
});

// ── GET /api/data-binding-bm7/:primeJobId/partial ────────────────────────────

router.get("/data-binding-bm7/:primeJobId/partial", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const map        = requireMap(primeJobId, res);
  if (!map) return;

  res.status(200).json({
    primeJobId,
    total:    map.partialCount,
    note:     "Endpoint found but model is unknown — add DatabaseModelRef to complete the binding",
    bindings: map.partial.map(b => ({
      id:          b.id,
      page:        b.page.path,
      endpoint:    b.endpoint?.path,
      bindingType: b.bindingType,
      renderHint:  b.renderHint,
      notes:       b.notes,
    })),
  });
});

// ── GET /api/data-binding-bm7/:primeJobId/unbound ────────────────────────────

router.get("/data-binding-bm7/:primeJobId/unbound", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const map        = requireMap(primeJobId, res);
  if (!map) return;

  res.status(200).json({
    primeJobId,
    total:    map.unboundCount,
    note:     "These pages have no matching API endpoint — they will render as static pages",
    warnings: map.summary.unboundWarnings,
    bindings: map.unbound.map(b => ({
      id:         b.id,
      page:       b.page.path,
      dataHints:  b.page.dataHints ?? [],
      notes:      b.notes,
    })),
  });
});

// ── GET /api/data-binding-bm7/:primeJobId/blocked ────────────────────────────

router.get("/data-binding-bm7/:primeJobId/blocked", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const map        = requireMap(primeJobId, res);
  if (!map) return;

  res.status(200).json({
    primeJobId,
    total:    map.blockedCount,
    note:     "These pages matched a deprecated or unsafe endpoint — resolve before binding",
    bindings: map.blocked.map(b => ({
      id:       b.id,
      page:     b.page.path,
      endpoint: b.endpoint?.path,
      reason:   b.notes[0] ?? "Blocked endpoint",
      notes:    b.notes,
    })),
  });
});

// ── GET /api/data-binding-bm7/:primeJobId/endpoints ──────────────────────────

router.get("/data-binding-bm7/:primeJobId/endpoints", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const map        = requireMap(primeJobId, res);
  if (!map) return;

  res.status(200).json({
    primeJobId,
    totalEndpointsUsed: map.summary.totalEndpointsUsed,
    usage:              map.endpointUsage,
  });
});

// ── GET /api/data-binding-bm7/:primeJobId/models ─────────────────────────────

router.get("/data-binding-bm7/:primeJobId/models", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const map        = requireMap(primeJobId, res);
  if (!map) return;

  res.status(200).json({
    primeJobId,
    totalModelsUsed: map.summary.totalModelsUsed,
    usage:           map.modelUsage,
  });
});

// ── GET /api/data-binding-bm7/:primeJobId/by-type ────────────────────────────

router.get("/data-binding-bm7/:primeJobId/by-type", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const map        = requireMap(primeJobId, res);
  if (!map) return;

  const summary = Object.entries(map.byType)
    .filter(([, bindings]) => (bindings as any[]).length > 0)
    .map(([type, bindings]) => ({
      type,
      count:    (bindings as any[]).length,
      pages:    (bindings as any[]).map((b: any) => b.page.path),
    }));

  res.status(200).json({
    primeJobId,
    totalPages: map.totalPages,
    livePageRate: map.livePageRate,
    byType: summary,
  });
});

// ── GET /api/data-binding-bm7/:primeJobId/by-type/:type ──────────────────────

router.get("/data-binding-bm7/:primeJobId/by-type/:type", (req, res): void => {
  const p          = req.params as Record<string, string>;
  const primeJobId = p["primeJobId"] ?? "";
  const type       = p["type"]       ?? "";

  if (!VALID_TYPES.has(type as BindingType)) {
    res.status(400).json({ error: `Invalid binding type "${type}"`, valid: [...VALID_TYPES] });
    return;
  }

  const map = requireMap(primeJobId, res);
  if (!map) return;

  const bindings = map.byType[type as BindingType] ?? [];
  res.status(200).json({ primeJobId, type, count: bindings.length, bindings });
});

export default router;
