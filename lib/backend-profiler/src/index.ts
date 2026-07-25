export { detectBackendProfile } from "./analyzer.js";
export { profileToDiscoverySiteGraph } from "./profile-to-discovery.js";
export { scoreMergeRisk } from "./merge-risk-scorer.js";

export type {
  BackendProfile,
  BackendRouteEntry,
  BackendApiEntry,
  DatabaseSchema,
  DatabaseTable,
  DatabaseColumn,
  DbDialect,
  DbOrm,
  AuthProfile,
  AuthStrategy,
  CmsProfile,
  StorageProfile,
  StorageProvider,
  MergeActionPhase58,
  MergeRiskScore,
  MergeRiskFactor,
  MergeRiskResult,
} from "./types.js";
