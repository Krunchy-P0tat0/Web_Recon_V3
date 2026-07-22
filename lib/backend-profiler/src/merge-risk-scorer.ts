import type { MergeConflict } from "@workspace/merge-planner";
import type { BackendProfile, MergeRiskFactor, MergeRiskResult, MergeRiskScore } from "./types.js";

/**
 * scoreMergeRisk — compute a mergeRiskScore (LOW | MEDIUM | HIGH) from
 * the set of merge conflicts and the incoming BackendProfile.
 */
export function scoreMergeRisk(
  conflicts:      MergeConflict[],
  backendProfile: BackendProfile | null,
  createCount:    number,
  updateCount:    number,
  archiveCount:   number,
): MergeRiskResult {
  let score = 0;
  const factors: MergeRiskFactor[] = [];

  const blockerCount  = conflicts.filter(c => c.isBlocker).length;
  const errorCount    = conflicts.filter(c => c.severity === "error" && !c.isBlocker).length;
  const warningCount  = conflicts.filter(c => c.severity === "warning").length;

  if (blockerCount > 0) {
    score += blockerCount * 20;
    factors.push({
      factor: "Blocking conflicts",
      impact: "high",
      detail: `${blockerCount} blocker(s) must be resolved before merge can proceed`,
    });
  }

  if (errorCount > 0) {
    score += errorCount * 10;
    factors.push({
      factor: "Error-level conflicts",
      impact: "high",
      detail: `${errorCount} error conflict(s) will cause merge failures if unresolved`,
    });
  }

  if (warningCount > 0) {
    score += warningCount * 3;
    factors.push({
      factor: "Warning conflicts",
      impact: "medium",
      detail: `${warningCount} warning(s) should be reviewed before deploying`,
    });
  }

  if (createCount > 20) {
    score += 15;
    factors.push({ factor: "High new-page count", impact: "medium", detail: `${createCount} new pages to create — large surface area` });
  } else if (createCount > 10) {
    score += 8;
    factors.push({ factor: "Moderate new-page count", impact: "low", detail: `${createCount} new pages to create` });
  }

  if (updateCount > 10) {
    score += 12;
    factors.push({ factor: "High update count", impact: "medium", detail: `${updateCount} existing pages need modification` });
  } else if (updateCount > 0) {
    score += updateCount * 2;
    factors.push({ factor: "Pages needing update", impact: "low", detail: `${updateCount} existing page(s) require changes` });
  }

  if (archiveCount > 5) {
    score += 10;
    factors.push({ factor: "Routes to archive", impact: "medium", detail: `${archiveCount} existing routes marked for archival — data-loss risk if not reviewed` });
  } else if (archiveCount > 0) {
    score += archiveCount * 2;
    factors.push({ factor: "Archivable routes", impact: "low", detail: `${archiveCount} route(s) have no matching scraped content` });
  }

  if (backendProfile) {
    const { authentication, databaseSchema, cms, storage } = backendProfile;

    if (authentication.strategy !== "none" && authentication.strategy !== "unknown") {
      score += 8;
      factors.push({
        factor: "Authentication layer",
        impact: "medium",
        detail: `Backend uses ${authentication.strategy} auth${authentication.provider ? ` (${authentication.provider})` : ""} — new pages must be evaluated for access control`,
      });
    }

    if (databaseSchema.tables.length > 15) {
      score += 12;
      factors.push({ factor: "Complex database schema", impact: "high", detail: `${databaseSchema.tables.length} tables — schema changes need careful migration planning` });
    } else if (databaseSchema.tables.length > 5) {
      score += 6;
      factors.push({ factor: "Moderate database schema", impact: "medium", detail: `${databaseSchema.tables.length} tables detected` });
    }

    if (cms) {
      score += 5;
      factors.push({ factor: "CMS integration", impact: "low", detail: `CMS (${cms.provider ?? cms.type}) must be kept in sync with new pages` });
    }

    if (storage && storage.provider !== "none") {
      score += 3;
      factors.push({ factor: "Storage integration", impact: "low", detail: `${storage.provider} storage — media uploads must be routed correctly` });
    }
  }

  const clampedScore = Math.min(score, 100);
  const mergeRiskScore: MergeRiskScore =
    clampedScore >= 60 ? "HIGH" : clampedScore >= 25 ? "MEDIUM" : "LOW";

  return { mergeRiskScore, score: clampedScore, factors, blockerCount, errorCount, warningCount };
}
