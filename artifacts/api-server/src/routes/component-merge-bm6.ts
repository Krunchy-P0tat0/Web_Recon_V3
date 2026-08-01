/**
 * component-merge-bm6.ts — Phase BM-6: Component Merge Engine Routes
 *
 * POST /api/component-merge-bm6/:primeJobId/analyze
 *   Run component merge analysis.
 *   Body:
 *   {
 *     backendJobId?:   string,
 *     force?:          boolean,
 *     components?:     ComponentDescriptor[],
 *     primeComponents?: ComponentDescriptor[],
 *     designSystem?:   string,
 *     framework?:      string,
 *   }
 *   Returns: full ComponentMergeReport
 *
 * GET  /api/component-merge-bm6/:primeJobId/report
 *   Full component-merge-report.json
 *
 * GET  /api/component-merge-bm6/:primeJobId/score
 *   Quick summary: { mergeScore, grade, reuseRate, reuseCount, wrapCount,
 *     replaceCount, skipCount, recommendation }
 *
 * GET  /api/component-merge-bm6/:primeJobId/reuse
 *   All REUSE decisions — existing components the prime can import directly.
 *   Query: ?kind=ui-component|layout|page|design-token|icon|asset|hook|provider|utility
 *
 * GET  /api/component-merge-bm6/:primeJobId/wrap
 *   All WRAP decisions — components that need an adapter wrapper.
 *   Query: ?kind=
 *
 * GET  /api/component-merge-bm6/:primeJobId/replace
 *   All REPLACE decisions — prime component supersedes the existing one.
 *
 * GET  /api/component-merge-bm6/:primeJobId/skip
 *   All SKIP decisions — components excluded from the merged output.
 *
 * GET  /api/component-merge-bm6/:primeJobId/design-system
 *   Design system compatibility analysis and merge strategy.
 *
 * GET  /api/component-merge-bm6/:primeJobId/decisions
 *   All decisions, filterable by classification, kind, effort, breakingChange.
 *   Query: ?classification=REUSE|WRAP|REPLACE|SKIP
 *          ?kind=<ComponentKind>
 *          ?effort=none|trivial|low|medium|high
 *          ?breaking=true|false
 *
 * GET  /api/component-merge-bm6/:primeJobId/decisions/:id
 *   Single decision by ID (e.g. CMP-0001).
 *
 * GET  /api/component-merge-bm6/:primeJobId/by-kind
 *   Per-kind breakdown: ui-component, layout, page, design-token, …
 *
 * GET  /api/component-merge-bm6/:primeJobId/by-kind/:kind
 *   Full detail for one kind.
 */

import { Router, type IRouter } from "express";
import {
  runComponentMergeEngine,
  getCachedComponentMergeReport,
  type ComponentMergeReport,
  type MergeClassification,
  type ComponentKind,
  type ComponentDescriptor,
} from "../lib/component-merge-engine-bm6.js";

const router: IRouter = Router();

const VALID_CLASSIFICATIONS = new Set<MergeClassification>(["REUSE", "WRAP", "REPLACE", "SKIP"]);
const VALID_KINDS = new Set<ComponentKind>([
  "ui-component", "layout", "page", "design-token", "icon",
  "asset", "hook", "provider", "utility", "unknown",
]);
const VALID_EFFORTS = new Set(["none", "trivial", "low", "medium", "high"]);

// ── Helper ────────────────────────────────────────────────────────────────────

function requireReport(
  primeJobId: string,
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): ComponentMergeReport | null {
  const report = getCachedComponentMergeReport(primeJobId);
  if (!report) {
    res.status(404).json({
      error: "No BM-6 component merge report found for this primeJobId.",
      hint:  `POST /api/component-merge-bm6/${primeJobId}/analyze to run Phase BM-6.`,
    });
    return null;
  }
  return report;
}

// ── POST /api/component-merge-bm6/:primeJobId/analyze ────────────────────────

router.post("/component-merge-bm6/:primeJobId/analyze", async (req, res): Promise<void> => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  if (!primeJobId) { res.status(400).json({ error: "primeJobId is required" }); return; }

  const body           = (req.body ?? {}) as Record<string, unknown>;
  const backendJobId   = typeof body["backendJobId"] === "string" ? body["backendJobId"].trim() : undefined;
  const force          = body["force"] === true;
  const components     = Array.isArray(body["components"])     ? body["components"] as ComponentDescriptor[] : undefined;
  const primeComponents = Array.isArray(body["primeComponents"]) ? body["primeComponents"] as ComponentDescriptor[] : undefined;
  const designSystem   = typeof body["designSystem"] === "string" ? body["designSystem"].trim() : undefined;
  const framework      = typeof body["framework"]    === "string" ? body["framework"].trim()    : undefined;

  // Validate components if provided
  if (components) {
    for (const c of components) {
      if (typeof c.name !== "string" || typeof c.kind !== "string") {
        res.status(400).json({ error: `Each component must have { name: string, kind: string, hasPrimeMatch: boolean }` });
        return;
      }
      if (!VALID_KINDS.has(c.kind as ComponentKind)) {
        res.status(400).json({ error: `Component "${c.name}" has invalid kind "${c.kind}"`, valid: [...VALID_KINDS] });
        return;
      }
    }
  }

  req.log.info(
    { primeJobId, backendJobId, force, componentCount: components?.length ?? 0, designSystem, framework },
    "BM6: analyze requested",
  );

  try {
    const report = await runComponentMergeEngine({
      primeJobId, backendJobId, force, components, primeComponents,
      designSystem: designSystem as any, framework,
    });
    res.status(200).json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err, primeJobId }, "BM6: analyze failed");
    res.status(500).json({ error: "BM-6 component merge analysis failed", detail: message });
  }
});

// ── GET /api/component-merge-bm6/:primeJobId/report ──────────────────────────

router.get("/component-merge-bm6/:primeJobId/report", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (report) res.status(200).json(report);
});

// ── GET /api/component-merge-bm6/:primeJobId/score ───────────────────────────

router.get("/component-merge-bm6/:primeJobId/score", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  res.status(200).json({
    primeJobId,
    backendJobId:     report.backendJobId,
    generatedAt:      report.generatedAt,
    framework:        report.framework,
    totalComponents:  report.totalComponents,
    mergeScore:       report.mergeScore,
    grade:            report.grade,
    reuseRate:        report.reuseRate,
    reuseCount:       report.summary.reuseCount,
    wrapCount:        report.summary.wrapCount,
    replaceCount:     report.summary.replaceCount,
    skipCount:        report.summary.skipCount,
    wrappersToCreate: report.summary.wrappersToCreate,
    breakingChanges:  report.summary.breakingChanges,
    highEffortItems:  report.summary.highEffortItems,
    recommendation:   report.summary.recommendation,
  });
});

// ── GET /api/component-merge-bm6/:primeJobId/reuse ───────────────────────────

router.get("/component-merge-bm6/:primeJobId/reuse", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const kind = req.query["kind"] as string | undefined;
  const items = kind ? report.reuse.filter(d => d.component.kind === kind) : report.reuse;

  res.status(200).json({
    primeJobId,
    total:    report.reuse.length,
    filtered: items.length,
    filter:   { kind: kind ?? null },
    decisions: items.map(d => ({
      id:             d.id,
      name:           d.component.name,
      kind:           d.component.kind,
      reuseImportPath: d.reuseImportPath,
      reason:         d.reason,
      mergeAction:    d.mergeAction,
      effort:         d.effort,
    })),
  });
});

// ── GET /api/component-merge-bm6/:primeJobId/wrap ────────────────────────────

router.get("/component-merge-bm6/:primeJobId/wrap", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const kind = req.query["kind"] as string | undefined;
  const items = kind ? report.wrap.filter(d => d.component.kind === kind) : report.wrap;

  res.status(200).json({
    primeJobId,
    total:    report.wrap.length,
    filtered: items.length,
    filter:   { kind: kind ?? null },
    decisions: items.map(d => ({
      id:          d.id,
      name:        d.component.name,
      kind:        d.component.kind,
      wrapperSpec: d.wrapperSpec,
      reason:      d.reason,
      mergeAction: d.mergeAction,
      effort:      d.effort,
    })),
  });
});

// ── GET /api/component-merge-bm6/:primeJobId/replace ─────────────────────────

router.get("/component-merge-bm6/:primeJobId/replace", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  res.status(200).json({
    primeJobId,
    total:    report.replace.length,
    breaking: report.replace.filter(d => d.breakingChange).length,
    decisions: report.replace.map(d => ({
      id:          d.id,
      name:        d.component.name,
      kind:        d.component.kind,
      replacedBy:  d.replacedBy,
      reason:      d.reason,
      mergeAction: d.mergeAction,
      effort:      d.effort,
      breaking:    d.breakingChange,
      usedInPages: d.component.usedInPages ?? [],
    })),
  });
});

// ── GET /api/component-merge-bm6/:primeJobId/skip ────────────────────────────

router.get("/component-merge-bm6/:primeJobId/skip", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  res.status(200).json({
    primeJobId,
    total: report.skip.length,
    decisions: report.skip.map(d => ({
      id:            d.id,
      name:          d.component.name,
      kind:          d.component.kind,
      skippedReason: d.skippedReason,
      mergeAction:   d.mergeAction,
    })),
  });
});

// ── GET /api/component-merge-bm6/:primeJobId/design-system ───────────────────

router.get("/component-merge-bm6/:primeJobId/design-system", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  res.status(200).json({
    primeJobId,
    ...report.designSystemAnalysis,
  });
});

// ── GET /api/component-merge-bm6/:primeJobId/decisions ───────────────────────

router.get("/component-merge-bm6/:primeJobId/decisions", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const clsFilter      = req.query["classification"] as string | undefined;
  const kindFilter     = req.query["kind"]           as string | undefined;
  const effortFilter   = req.query["effort"]         as string | undefined;
  const breakingFilter = req.query["breaking"]       as string | undefined;

  if (clsFilter && !VALID_CLASSIFICATIONS.has(clsFilter as MergeClassification)) {
    res.status(400).json({ error: `Invalid classification "${clsFilter}"`, valid: [...VALID_CLASSIFICATIONS] });
    return;
  }
  if (kindFilter && !VALID_KINDS.has(kindFilter as ComponentKind)) {
    res.status(400).json({ error: `Invalid kind "${kindFilter}"`, valid: [...VALID_KINDS] });
    return;
  }
  if (effortFilter && !VALID_EFFORTS.has(effortFilter)) {
    res.status(400).json({ error: `Invalid effort "${effortFilter}"`, valid: [...VALID_EFFORTS] });
    return;
  }

  let items = report.decisions;
  if (clsFilter)              items = items.filter(d => d.classification === clsFilter);
  if (kindFilter)             items = items.filter(d => d.component.kind === kindFilter);
  if (effortFilter)           items = items.filter(d => d.effort === effortFilter);
  if (breakingFilter === "true")  items = items.filter(d =>  d.breakingChange);
  if (breakingFilter === "false") items = items.filter(d => !d.breakingChange);

  res.status(200).json({
    primeJobId,
    total:    report.decisions.length,
    filtered: items.length,
    filters:  { classification: clsFilter ?? null, kind: kindFilter ?? null, effort: effortFilter ?? null, breaking: breakingFilter ?? null },
    decisions: items,
  });
});

// ── GET /api/component-merge-bm6/:primeJobId/decisions/:id ───────────────────

router.get("/component-merge-bm6/:primeJobId/decisions/:id", (req, res): void => {
  const p          = req.params as Record<string, string>;
  const primeJobId = p["primeJobId"] ?? "";
  const id         = p["id"]         ?? "";

  const report = requireReport(primeJobId, res);
  if (!report) return;

  const decision = report.decisions.find(d => d.id === id);
  if (!decision) {
    res.status(404).json({
      error:        `Decision "${id}" not found`,
      availableIds: report.decisions.map(d => d.id),
    });
    return;
  }

  res.status(200).json({ primeJobId, ...decision });
});

// ── GET /api/component-merge-bm6/:primeJobId/by-kind ─────────────────────────

router.get("/component-merge-bm6/:primeJobId/by-kind", (req, res): void => {
  const primeJobId = (req.params as Record<string, string>)["primeJobId"] ?? "";
  const report     = requireReport(primeJobId, res);
  if (!report) return;

  const summaries = Object.values(report.byKind)
    .filter(k => k.total > 0)
    .map(k => ({
      kind:        k.kind,
      total:       k.total,
      reuseCount:  k.reuseCount,
      wrapCount:   k.wrapCount,
      replaceCount:k.replaceCount,
      skipCount:   k.skipCount,
    }));

  res.status(200).json({ primeJobId, totalComponents: report.totalComponents, byKind: summaries });
});

// ── GET /api/component-merge-bm6/:primeJobId/by-kind/:kind ───────────────────

router.get("/component-merge-bm6/:primeJobId/by-kind/:kind", (req, res): void => {
  const p          = req.params as Record<string, string>;
  const primeJobId = p["primeJobId"] ?? "";
  const kind       = p["kind"]       ?? "";

  if (!VALID_KINDS.has(kind as ComponentKind)) {
    res.status(400).json({ error: `Invalid kind "${kind}"`, valid: [...VALID_KINDS] });
    return;
  }

  const report = requireReport(primeJobId, res);
  if (!report) return;

  res.status(200).json({ primeJobId, ...report.byKind[kind as ComponentKind] });
});

export default router;
