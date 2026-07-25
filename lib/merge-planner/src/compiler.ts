import type { DiscoverySiteGraph } from "@workspace/site-discovery";
import type { SiteGraph } from "@workspace/site-intelligence";
import { matchRoutes } from "./route-matcher.js";
import { matchLayouts } from "./layout-matcher.js";
import { matchComponents } from "./component-matcher.js";
import { matchApis } from "./api-matcher.js";
import { matchDataSources } from "./datasource-matcher.js";
import {
  detectNamingConflicts,
  detectNavigationGaps,
  detectRouteWithoutLayout,
  detectManifestDuplicates,
  detectContentLayoutMismatches,
} from "./conflict-detector.js";
import {
  computeStats,
  computeSummary,
  deduplicateDecisions,
  deduplicateConflicts,
} from "./decision-engine.js";
import type { MergePlan } from "./types.js";

export function compileMergePlan(
  discoveryGraph: DiscoverySiteGraph,
  siteGraph: SiteGraph
): MergePlan {
  const startMs = Date.now();

  // ── Phase 1: Run all domain matchers ─────────────────────────────────────

  const routeResult = matchRoutes(discoveryGraph, siteGraph.routeMap.routes);

  const layoutResult = matchLayouts(
    discoveryGraph.layouts,
    siteGraph.layoutAssignments
  );

  const componentResult = matchComponents(
    discoveryGraph.components,
    siteGraph.layoutAssignments
  );

  const apiResult = matchApis(
    discoveryGraph.apis,
    siteGraph.routeMap.routes
  );

  const datasourceResult = matchDataSources(
    discoveryGraph.dataSources,
    siteGraph
  );

  // ── Phase 2: Collect all decisions & conflicts ────────────────────────────

  const allDecisions = [
    ...routeResult.decisions,
    ...layoutResult.decisions,
    ...componentResult.decisions,
    ...apiResult.decisions,
    ...datasourceResult.decisions,
  ];

  const allConflicts = [
    ...routeResult.conflicts,
    ...layoutResult.conflicts,
    ...componentResult.conflicts,
    ...apiResult.conflicts,
    ...datasourceResult.conflicts,
  ];

  // ── Phase 3: Cross-entity conflict detection ──────────────────────────────

  allConflicts.push(...detectNamingConflicts(allDecisions));
  allConflicts.push(...detectNavigationGaps(discoveryGraph, allDecisions));
  allConflicts.push(...detectRouteWithoutLayout(allDecisions));
  allConflicts.push(...detectManifestDuplicates(siteGraph));
  allConflicts.push(...detectContentLayoutMismatches(siteGraph, allDecisions));

  // ── Phase 4: Deduplicate ──────────────────────────────────────────────────

  const decisions = deduplicateDecisions(allDecisions);
  const conflicts = deduplicateConflicts(allConflicts);

  // ── Phase 5: Sort decisions for readability ───────────────────────────────
  //
  // Blockers first, then by action priority: CREATE > UPDATE > EXTEND > ARCHIVE > IGNORE

  const ACTION_ORDER: Record<string, number> = {
    CREATE: 0, UPDATE: 1, EXTEND: 2, ARCHIVE: 3, IGNORE: 4,
  };

  decisions.sort((a, b) => {
    const aHasBlocker = a.conflicts.some((c) => c.isBlocker) ? 0 : 1;
    const bHasBlocker = b.conflicts.some((c) => c.isBlocker) ? 0 : 1;
    if (aHasBlocker !== bHasBlocker) return aHasBlocker - bHasBlocker;
    return (ACTION_ORDER[a.action] ?? 99) - (ACTION_ORDER[b.action] ?? 99);
  });

  // ── Phase 6: Compute final stats & summary ────────────────────────────────

  const planningTimeMs = Date.now() - startMs;
  const stats = computeStats(decisions, conflicts, planningTimeMs);
  const summary = computeSummary(decisions, conflicts);

  return {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    stats,
    decisions,
    conflicts,
    summary,
  };
}
