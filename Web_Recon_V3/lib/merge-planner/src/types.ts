// ─── Core action enum ─────────────────────────────────────────────────────────

/**
 * CREATE  — entity exists in scraped content but no matching route/component
 *           exists in the codebase. Must be created from scratch.
 * UPDATE  — entity exists in both graphs; the codebase version needs to be
 *           modified to accommodate the scraped content.
 * EXTEND  — scraped content fits an existing dynamic route/component; the
 *           existing structure can handle it without structural change.
 * ARCHIVE — entity exists in the codebase but no scraped content maps to it;
 *           candidate for removal or archival.
 * IGNORE  — no action required; both sides are compatible with no changes.
 */
export type MergeAction = "CREATE" | "UPDATE" | "EXTEND" | "ARCHIVE" | "IGNORE";

export type MergeEntityKind =
  | "route"
  | "layout"
  | "component"
  | "api"
  | "datasource";

// ─── Entity references ────────────────────────────────────────────────────────

export type GraphSide = "discovery" | "manifest";

export interface EntityRef {
  id: string;
  path?: string;
  name?: string;
  graph: GraphSide;
}

// ─── Conflicts ────────────────────────────────────────────────────────────────

export type ConflictKind =
  | "route-collision"          // same URL path, incompatible types
  | "method-collision"         // same API path, overlapping HTTP methods
  | "component-collision"      // same component name, incompatible signatures
  | "layout-mismatch"          // layout type incompatible with content type
  | "schema-collision"         // same datasource, different schema
  | "naming-conflict"          // name would collide in target namespace
  | "duplicate-route-match"    // multiple scraped pages map to same dynamic route
  | "orphan-route";            // codebase route has zero scraped content

export type ConflictSeverity = "error" | "warning" | "info";

export interface MergeConflict {
  id: string;
  kind: ConflictKind;
  severity: ConflictSeverity;
  description: string;
  sourceRef: EntityRef | null;
  targetRef: EntityRef | null;
  resolution: string;
  isBlocker: boolean;
}

// ─── Decisions ────────────────────────────────────────────────────────────────

export interface MergeDecision {
  id: string;
  action: MergeAction;
  entityKind: MergeEntityKind;
  reason: string;
  confidence: number;
  /** Scraped/manifest side — what we want to bring in */
  source: EntityRef | null;
  /** Codebase/discovery side — what already exists */
  target: EntityRef | null;
  conflicts: MergeConflict[];
  metadata: Record<string, unknown>;
}

// ─── Statistics ───────────────────────────────────────────────────────────────

export interface MergePlanStats {
  totalDecisions: number;
  byAction: Record<MergeAction, number>;
  byEntityKind: Record<MergeEntityKind, number>;
  conflictCount: number;
  errorConflictCount: number;
  warningConflictCount: number;
  planningTimeMs: number;
  overallConfidence: number;
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export interface MergeSummary {
  creates: number;
  updates: number;
  extends: number;
  archives: number;
  ignores: number;
  blockers: MergeConflict[];
  readyForMerge: boolean;
  recommendation: string;
}

// ─── Root output ──────────────────────────────────────────────────────────────

export interface MergePlan {
  version: "1.0";
  generatedAt: string;
  stats: MergePlanStats;
  decisions: MergeDecision[];
  conflicts: MergeConflict[];
  summary: MergeSummary;
}
