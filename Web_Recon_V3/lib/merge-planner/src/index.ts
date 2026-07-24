export { compileMergePlan } from "./compiler.js";

export type {
  MergeAction,
  MergeConflict,
  MergeDecision,
  MergeEntityKind,
  MergePlan,
  MergePlanStats,
  MergeSummary,
  EntityRef,
  GraphSide,
  ConflictKind,
  ConflictSeverity,
} from "./types.js";

export { matchRoutes } from "./route-matcher.js";
export { matchLayouts } from "./layout-matcher.js";
export { matchComponents } from "./component-matcher.js";
export { matchApis } from "./api-matcher.js";
export { matchDataSources } from "./datasource-matcher.js";
export {
  detectNamingConflicts,
  detectNavigationGaps,
  detectRouteWithoutLayout,
  detectManifestDuplicates,
  detectContentLayoutMismatches,
} from "./conflict-detector.js";
export {
  computeStats,
  computeSummary,
  deduplicateDecisions,
  deduplicateConflicts,
} from "./decision-engine.js";
