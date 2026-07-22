/**
 * merge-intelligence.ts — Phase 5.8: Backend Merge Intelligence
 *
 * Orchestrates the full merge analysis pipeline:
 *   1. Load manifest (scraped "incoming" site)
 *   2. Build SiteGraph from manifest
 *   3. Build DiscoverySiteGraph from BackendProfile (or empty if no profile)
 *   4. Compile MergePlan (route / layout / component / API / datasource decisions)
 *   5. Categorize conflicts by domain (routeConflicts, apiConflicts, databaseConflicts, componentConflicts)
 *   6. Map merge actions to Phase 5.8 vocabulary (EXTEND → REUSE, IGNORE → SKIP)
 *   7. Compute mergeRiskScore (LOW | MEDIUM | HIGH)
 *   8. Write merge-analysis-report.json + merge-plan.json locally and to R2
 *
 * Entry: runMergeIntelligence(jobId, backendProfile?, cloudProvider)
 */

import { writeFile } from "fs/promises";
import { join }      from "path";

import { compileSiteGraph }          from "@workspace/site-intelligence";
import { compileDiscoverySiteGraph } from "@workspace/site-discovery";
import { compileMergePlan }          from "@workspace/merge-planner";
import type { MergePlan, MergeDecision, MergeConflict, MergeAction } from "@workspace/merge-planner";

import {
  detectBackendProfile,
  profileToDiscoverySiteGraph,
  scoreMergeRisk,
} from "@workspace/backend-profiler";
import type { BackendProfile, MergeRiskResult, MergeActionPhase58 } from "@workspace/backend-profiler";

import { loadManifest } from "./manifest-store.js";
import { logger }       from "./logger.js";
import type { CloudProvider } from "../cloud/provider.js";
import type {
  PortableManifest,
  PortablePageNode,
  PortableMediaItem,
  PortableStorageMap,
} from "@workspace/site-intelligence";
import type { Manifest, PageNode } from "./manifest.js";

const WORKSPACE_ROOT  = join(process.cwd(), "..", "..");
const LOCAL_ANALYSIS  = join(process.cwd(), "merge-analysis-report.json");
const LOCAL_PLAN      = join(process.cwd(), "merge-plan.json");
const WS_ANALYSIS     = join(WORKSPACE_ROOT, "merge-analysis-report.json");
const WS_PLAN         = join(WORKSPACE_ROOT, "merge-plan.json");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PageMergeDecision {
  pageId:    string;
  url:       string;
  title:     string;
  action:    MergeActionPhase58;
  reason:    string;
  confidence: number;
  conflicts: string[];
}

export interface MergeIntelligenceReport {
  version:     "1.0";
  phase:       "5.8";
  generatedAt: string;
  jobId:       string;
  sourceUrl:   string;
  durationMs:  number;

  backendProfile: BackendProfile;

  // Per-page decisions
  pageDecisions: PageMergeDecision[];

  // Categorized conflicts
  routeConflicts:     MergeConflict[];
  apiConflicts:       MergeConflict[];
  databaseConflicts:  MergeConflict[];
  componentConflicts: MergeConflict[];
  otherConflicts:     MergeConflict[];

  // Risk
  risk: MergeRiskResult;

  // Summary counts
  summary: {
    totalPages:  number;
    create:      number;
    update:      number;
    reuse:       number;
    skip:        number;
    archive:     number;
    totalConflicts: number;
    blockers:       number;
  };

  outputFiles: {
    analysisReport: string;
    mergePlan:      string;
  };
}

// ─── Manifest adapter ─────────────────────────────────────────────────────────

function adaptToPortable(manifest: Manifest): PortableManifest {
  const nodes: PortablePageNode[] = Array.from(manifest.nodes.values()).map(
    (node: PageNode): PortablePageNode => ({
      id:       node.id,
      version:  node.version,
      nodeType: node.nodeType,
      status:   node.status,
      metadata: {
        url:         node.metadata.url,
        title:       node.metadata.title,
        description: node.metadata.description,
        publishedAt: node.metadata.publishedAt,
        fetchedAt:   node.metadata.fetchedAt,
        siteType:    node.metadata.siteType,
      },
      content: {
        cleanHtml:    node.content.cleanHtml,
        textContent:  node.content.textContent,
        wordCount:    node.content.wordCount,
        bodySelector: node.content.bodySelector,
      },
      media: {
        images: node.media.images as unknown as PortableMediaItem[],
        videos: node.media.videos as unknown as PortableMediaItem[],
      },
      storage:       node.storage as unknown as PortableStorageMap,
      relationships: {
        parentId:        node.relationships.parentId,
        childIds:        node.relationships.childIds,
        paginationIndex: node.relationships.paginationIndex,
        depth:           node.relationships.depth,
        discoverySource: node.relationships.discoverySource,
      },
    }),
  );

  return {
    schemaVersion: "1.0",
    exportedAt:    new Date().toISOString(),
    id:            manifest.id,
    version:       manifest.version,
    status:        manifest.status,
    createdAt:     manifest.createdAt,
    updatedAt:     manifest.updatedAt,
    seedUrl:       manifest.seedUrl,
    config:        manifest.config as PortableManifest["config"],
    nodes,
    seenUrls:      Array.from(manifest.seenUrls),
    stats:         manifest.stats as PortableManifest["stats"],
  };
}

// ─── Action mapper ────────────────────────────────────────────────────────────

function toPhase58Action(action: MergeAction): MergeActionPhase58 {
  switch (action) {
    case "CREATE":  return "CREATE";
    case "UPDATE":  return "UPDATE";
    case "EXTEND":  return "REUSE";
    case "ARCHIVE": return "ARCHIVE";
    case "IGNORE":  return "SKIP";
    default:        return "SKIP";
  }
}

// ─── Conflict categorizer ─────────────────────────────────────────────────────

function categorizeConflicts(conflicts: MergeConflict[]) {
  const routeConflicts:     MergeConflict[] = [];
  const apiConflicts:       MergeConflict[] = [];
  const databaseConflicts:  MergeConflict[] = [];
  const componentConflicts: MergeConflict[] = [];
  const otherConflicts:     MergeConflict[] = [];

  for (const c of conflicts) {
    switch (c.kind) {
      case "route-collision":
      case "orphan-route":
      case "duplicate-route-match":
        routeConflicts.push(c);
        break;
      case "method-collision":
        apiConflicts.push(c);
        break;
      case "schema-collision":
        databaseConflicts.push(c);
        break;
      case "component-collision":
      case "layout-mismatch":
        componentConflicts.push(c);
        break;
      default:
        otherConflicts.push(c);
    }
  }

  return { routeConflicts, apiConflicts, databaseConflicts, componentConflicts, otherConflicts };
}

// ─── Page decision builder ────────────────────────────────────────────────────

function buildPageDecisions(
  decisions:  MergeDecision[],
  manifest:   Manifest,
): PageMergeDecision[] {
  const nodeMap = manifest.nodes;

  return decisions
    .filter(d => d.entityKind === "route")
    .map(d => {
      const nodeId  = d.source?.id ?? d.target?.id ?? "";
      const node    = nodeId ? nodeMap.get(nodeId) : undefined;
      const url     = node?.metadata.url ?? d.source?.path ?? d.target?.path ?? "";
      const title   = node?.metadata.title ?? url;
      return {
        pageId:     nodeId || d.id,
        url,
        title,
        action:     toPhase58Action(d.action),
        reason:     d.reason,
        confidence: d.confidence,
        conflicts:  d.conflicts.map((c: MergeConflict) => c.description),
      };
    });
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

export async function runMergeIntelligence(
  jobId:          string,
  cloudProvider:  CloudProvider,
  backendProfile?: BackendProfile,
): Promise<MergeIntelligenceReport> {
  const t0 = Date.now();
  logger.info({ jobId }, "MERGE-INTEL: starting Phase 5.8 backend merge intelligence");

  // 1. Load manifest
  const manifest = await loadManifest(jobId);
  if (!manifest) {
    throw new Error(`MERGE-INTEL: manifest not found for job ${jobId}`);
  }

  // 2. Resolve BackendProfile (caller-supplied > auto-detected)
  const profile = backendProfile ?? detectBackendProfile();
  logger.info(
    { jobId, framework: profile.framework, routes: profile.routes.length, tables: profile.databaseSchema.tables.length },
    "MERGE-INTEL: backend profile resolved",
  );

  // 3. Build SiteGraph from manifest (incoming scraped site)
  const portable  = adaptToPortable(manifest);
  const siteGraph = compileSiteGraph(portable);

  // 4. Build DiscoverySiteGraph from BackendProfile
  //    If the profile has routes/APIs, use them; otherwise fall back to empty VFS.
  const discoveryGraph = profile.routes.length > 0 || profile.apis.length > 0
    ? profileToDiscoverySiteGraph(profile)
    : compileDiscoverySiteGraph({});

  // 5. Compile MergePlan
  const mergePlan = compileMergePlan(discoveryGraph, siteGraph);

  logger.info(
    { jobId, decisions: mergePlan.decisions.length, conflicts: mergePlan.conflicts.length },
    "MERGE-INTEL: merge plan compiled",
  );

  // 6. Categorize conflicts
  const { routeConflicts, apiConflicts, databaseConflicts, componentConflicts, otherConflicts } =
    categorizeConflicts(mergePlan.conflicts);

  // 7. Build per-page decisions
  const pageDecisions = buildPageDecisions(mergePlan.decisions, manifest);

  // 8. Count action types for risk scoring
  const createCount  = pageDecisions.filter(d => d.action === "CREATE").length;
  const updateCount  = pageDecisions.filter(d => d.action === "UPDATE").length;
  const archiveCount = pageDecisions.filter(d => d.action === "ARCHIVE").length;

  const risk = scoreMergeRisk(mergePlan.conflicts, profile, createCount, updateCount, archiveCount);

  const durationMs = Date.now() - t0;

  const report: MergeIntelligenceReport = {
    version:     "1.0",
    phase:       "5.8",
    generatedAt: new Date().toISOString(),
    jobId,
    sourceUrl:   manifest.seedUrl,
    durationMs,
    backendProfile: profile,
    pageDecisions,
    routeConflicts,
    apiConflicts,
    databaseConflicts,
    componentConflicts,
    otherConflicts,
    risk,
    summary: {
      totalPages:     pageDecisions.length,
      create:         createCount,
      update:         updateCount,
      reuse:          pageDecisions.filter(d => d.action === "REUSE").length,
      skip:           pageDecisions.filter(d => d.action === "SKIP").length,
      archive:        archiveCount,
      totalConflicts: mergePlan.conflicts.length,
      blockers:       risk.blockerCount,
    },
    outputFiles: {
      analysisReport: "merge-analysis-report.json",
      mergePlan:      "merge-plan.json",
    },
  };

  logger.info(
    {
      jobId,
      mergeRiskScore: risk.mergeRiskScore,
      create: report.summary.create,
      update: report.summary.update,
      reuse:  report.summary.reuse,
      skip:   report.summary.skip,
      archive: report.summary.archive,
      conflicts: report.summary.totalConflicts,
      durationMs,
    },
    "MERGE-INTEL: report generated",
  );

  // 9. Persist files
  const analysisJson = JSON.stringify(report, null, 2);

  // merge-plan.json — serialized MergePlan (raw, for downstream tooling)
  const planOutput: MergePlan & { _phase58PageDecisions: PageMergeDecision[] } = {
    ...mergePlan,
    _phase58PageDecisions: pageDecisions,
  };
  const planJson = JSON.stringify(planOutput, null, 2);

  const writes: Promise<void>[] = [
    writeFile(LOCAL_ANALYSIS, analysisJson, "utf8").catch(e => logger.warn({ e }, "MERGE-INTEL: local analysis write failed")),
    writeFile(LOCAL_PLAN,     planJson,     "utf8").catch(e => logger.warn({ e }, "MERGE-INTEL: local plan write failed")),
    writeFile(WS_ANALYSIS,    analysisJson, "utf8").catch(e => logger.warn({ e }, "MERGE-INTEL: workspace analysis write failed")),
    writeFile(WS_PLAN,        planJson,     "utf8").catch(e => logger.warn({ e }, "MERGE-INTEL: workspace plan write failed")),
  ];

  if (cloudProvider.isConfigured()) {
    const base = `jobs/${jobId}`;
    writes.push(
      cloudProvider.upload({ key: `${base}/merge-analysis-report.json`, data: Buffer.from(analysisJson, "utf8"), contentType: "application/json", checkDuplicate: false })
        .then(() => logger.info({ jobId }, "MERGE-INTEL: analysis report uploaded to R2"))
        .catch(e  => logger.warn({ e, jobId }, "MERGE-INTEL: R2 analysis upload failed (non-fatal)")),
      cloudProvider.upload({ key: `${base}/merge-plan.json`, data: Buffer.from(planJson, "utf8"), contentType: "application/json", checkDuplicate: false })
        .then(() => logger.info({ jobId }, "MERGE-INTEL: merge plan uploaded to R2"))
        .catch(e  => logger.warn({ e, jobId }, "MERGE-INTEL: R2 plan upload failed (non-fatal)")),
    );
  }

  await Promise.allSettled(writes);
  return report;
}
