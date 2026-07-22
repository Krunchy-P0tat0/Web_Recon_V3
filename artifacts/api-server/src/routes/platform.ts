/**
 * routes/platform.ts — Backend Exposure Layer
 *
 * Exposes the complete Feature Registry and all sub-catalogues over HTTP.
 * These endpoints are the single source of truth for every frontend dashboard.
 *
 * GET /api/platform/features  — full Feature Registry
 * GET /api/platform/routes    — all registered HTTP routes
 * GET /api/platform/workers   — all background workers and schedulers
 * GET /api/platform/services  — all internal services and engines
 * GET /api/platform/events    — all pipeline event types
 * GET /api/platform/widgets   — all recommended dashboard widgets
 *
 * Optional query filters on /features:
 *   ?category=<category>    — filter by FeatureCategory
 *   ?status=<status>        — filter by FeatureStatus
 *   ?live=true              — only features with supportsLiveUpdates
 *   ?controls=true          — only features with supportsControls
 *   ?q=<text>               — free-text search across name + description
 */

import { Router, type Request, type Response } from "express";
import {
  FEATURE_REGISTRY,
  ROUTE_CATALOGUE,
  WORKER_CATALOGUE,
  SERVICE_CATALOGUE,
  EVENT_CATALOGUE,
  DB_MODEL_CATALOGUE,
  WIDGET_CATALOGUE,
  getRegistrySummary,
  type FeatureCategory,
  type FeatureStatus,
} from "../lib/platform-registry.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/platform/features
// ─────────────────────────────────────────────────────────────────────────────

router.get("/platform/features", (req: Request, res: Response) => {
  let features = [...FEATURE_REGISTRY];

  const { category, status, live, controls, q } = req.query;

  if (typeof category === "string" && category) {
    features = features.filter((f) => f.category === (category as FeatureCategory));
  }

  if (typeof status === "string" && status) {
    features = features.filter((f) => f.status === (status as FeatureStatus));
  }

  if (live === "true") {
    features = features.filter((f) => f.supportsLiveUpdates);
  }

  if (controls === "true") {
    features = features.filter((f) => f.supportsControls);
  }

  if (typeof q === "string" && q.trim()) {
    const needle = q.trim().toLowerCase();
    features = features.filter(
      (f) =>
        f.featureName.toLowerCase().includes(needle) ||
        f.description.toLowerCase().includes(needle) ||
        f.id.toLowerCase().includes(needle) ||
        f.category.toLowerCase().includes(needle),
    );
  }

  // Group by category for easier frontend consumption
  const byCategory: Record<string, typeof features> = {};
  for (const f of features) {
    if (!byCategory[f.category]) byCategory[f.category] = [];
    byCategory[f.category]!.push(f);
  }

  res.json({
    meta: {
      generatedAt:   new Date().toISOString(),
      total:         features.length,
      filtered:      features.length < FEATURE_REGISTRY.length,
      appliedFilters: { category, status, live, controls, q },
    },
    summary: getRegistrySummary(),
    byCategory,
    features,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/platform/routes
// ─────────────────────────────────────────────────────────────────────────────

router.get("/platform/routes", (req: Request, res: Response) => {
  const { method, sse, featureId } = req.query;

  let routes = [...ROUTE_CATALOGUE];

  if (typeof method === "string" && method) {
    routes = routes.filter((r) => r.method === method.toUpperCase());
  }

  if (sse === "true") {
    routes = routes.filter((r) => r.supportsSSE);
  }

  if (typeof featureId === "string" && featureId) {
    routes = routes.filter((r) => r.featureId === featureId);
  }

  // Group by HTTP method
  const byMethod: Record<string, typeof routes> = {};
  for (const r of routes) {
    if (!byMethod[r.method]) byMethod[r.method] = [];
    byMethod[r.method]!.push(r);
  }

  res.json({
    meta: {
      generatedAt: new Date().toISOString(),
      total:       routes.length,
      sseRoutes:   routes.filter((r) => r.supportsSSE).length,
    },
    byMethod,
    routes,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/platform/workers
// ─────────────────────────────────────────────────────────────────────────────

router.get("/platform/workers", (_req: Request, res: Response) => {
  const byTriggerMode: Record<string, typeof WORKER_CATALOGUE> = {};
  for (const w of WORKER_CATALOGUE) {
    if (!byTriggerMode[w.triggerMode]) byTriggerMode[w.triggerMode] = [];
    byTriggerMode[w.triggerMode]!.push(w);
  }

  res.json({
    meta: {
      generatedAt: new Date().toISOString(),
      total:       WORKER_CATALOGUE.length,
    },
    byTriggerMode,
    workers: WORKER_CATALOGUE,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/platform/services
// ─────────────────────────────────────────────────────────────────────────────

router.get("/platform/services", (req: Request, res: Response) => {
  const { category } = req.query;

  let services = [...SERVICE_CATALOGUE];

  if (typeof category === "string" && category) {
    services = services.filter((s) => s.category === category);
  }

  const byCategory: Record<string, typeof services> = {};
  for (const s of services) {
    if (!byCategory[s.category]) byCategory[s.category] = [];
    byCategory[s.category]!.push(s);
  }

  res.json({
    meta: {
      generatedAt: new Date().toISOString(),
      total:       services.length,
      singletons:  services.filter((s) => s.singleton).length,
    },
    byCategory,
    services,
    // Also expose the DB model catalogue here since it completes the "data layer" picture
    dbModels: DB_MODEL_CATALOGUE,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/platform/events
// ─────────────────────────────────────────────────────────────────────────────

router.get("/platform/events", (req: Request, res: Response) => {
  const { category } = req.query;

  let events = [...EVENT_CATALOGUE];

  if (typeof category === "string" && category) {
    events = events.filter((e) => e.category === category);
  }

  const byCategory: Record<string, typeof events> = {};
  for (const e of events) {
    if (!byCategory[e.category]) byCategory[e.category] = [];
    byCategory[e.category]!.push(e);
  }

  // Unique producers and consumers across all events
  const allProducers = [...new Set(events.flatMap((e) => e.producedBy))].sort();
  const allConsumers = [...new Set(events.flatMap((e) => e.consumedBy))].sort();

  res.json({
    meta: {
      generatedAt:    new Date().toISOString(),
      total:          events.length,
      uniqueProducers: allProducers.length,
      uniqueConsumers: allConsumers.length,
    },
    producers: allProducers,
    consumers: allConsumers,
    byCategory,
    events,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/platform/widgets
// ─────────────────────────────────────────────────────────────────────────────

router.get("/platform/widgets", (req: Request, res: Response) => {
  const { widgetType, refreshMode, featureId } = req.query;

  let widgets = [...WIDGET_CATALOGUE];

  if (typeof widgetType === "string" && widgetType) {
    widgets = widgets.filter((w) => w.widgetType === widgetType);
  }

  if (typeof refreshMode === "string" && refreshMode) {
    widgets = widgets.filter((w) => w.refreshMode === refreshMode);
  }

  if (typeof featureId === "string" && featureId) {
    widgets = widgets.filter((w) => w.featureId === featureId);
  }

  const byWidgetType: Record<string, typeof widgets> = {};
  for (const w of widgets) {
    if (!byWidgetType[w.widgetType]) byWidgetType[w.widgetType] = [];
    byWidgetType[w.widgetType]!.push(w);
  }

  res.json({
    meta: {
      generatedAt: new Date().toISOString(),
      total:       widgets.length,
      sseWidgets:  widgets.filter((w) => w.refreshMode === "sse").length,
      pollWidgets: widgets.filter((w) => w.refreshMode === "poll").length,
    },
    byWidgetType,
    widgets,
  });
});

export default router;
