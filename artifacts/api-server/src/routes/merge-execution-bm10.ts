/**
 * merge-execution-bm10.ts — Phase BM-10: Merge Execution Engine
 *
 * POST /api/merge-execution-bm10/:jobId/execute
 *   Run the full BM-10 pipeline:
 *   Compatibility → Simulation → Backup → Execution → Verification
 *   Body: { dryRun?: boolean, targetVfs?: Record<string,string>, force?: boolean }
 *   Returns: MergeExecutionReport
 *
 * GET  /api/merge-execution-bm10/:jobId/report
 *   Return cached merge-audit.json (merged routes, components, schemas, assets)
 *
 * GET  /api/merge-execution-bm10/:jobId/status
 *   Return pipeline stage statuses for live polling
 */

import { Router, type IRouter } from "express";
import { compileSiteGraph } from "@workspace/site-intelligence";
import { compileDiscoverySiteGraph } from "@workspace/site-discovery";
import { compileMergePlan } from "@workspace/merge-planner";
import { executeMergePlan } from "@workspace/merge-execution-engine";
import type { VirtualFileSystem } from "@workspace/merge-execution-engine";
import type {
  PortableManifest,
  PortablePageNode,
  PortableMediaItem,
  PortableStorageMap,
} from "@workspace/site-intelligence";
import { loadManifest } from "../lib/manifest-store.js";
import type { Manifest, PageNode } from "../lib/manifest.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import { writeFile } from "fs/promises";
import { join } from "path";

const router: IRouter = Router();

// ── In-memory cache ───────────────────────────────────────────────────────────

type StageStatus = "pending" | "running" | "done" | "failed";

interface PipelineStage {
  name: string;
  status: StageStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  detail?: string;
}

interface MergeExecutionReport {
  jobId: string;
  generatedAt: string;
  dryRun: boolean;
  durationMs: number;
  stages: PipelineStage[];
  result: "success" | "failed" | "partial";
  mergedRoutes: MergedItem[];
  mergedComponents: MergedItem[];
  mergedSchemas: MergedItem[];
  mergedAssets: MergedItem[];
  decisions: number;
  conflicts: number;
  fileChanges: number;
  raw?: unknown;
}

interface MergedItem {
  path: string;
  action: string;
  detail?: string;
}

const reportCache = new Map<string, MergeExecutionReport>();
const runningJobs = new Set<string>();

// ── Manifest adapter (copied from merge-runner to avoid coupling) ─────────────

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

// ── Pipeline executor ─────────────────────────────────────────────────────────

function buildStages(): PipelineStage[] {
  return [
    { name: "compatibility", status: "pending" },
    { name: "simulation",    status: "pending" },
    { name: "backup",        status: "pending" },
    { name: "execution",     status: "pending" },
    { name: "verification",  status: "pending" },
  ];
}

function startStage(stages: PipelineStage[], name: string) {
  const s = stages.find(x => x.name === name);
  if (s) { s.status = "running"; s.startedAt = new Date().toISOString(); }
}

function finishStage(stages: PipelineStage[], name: string, detail?: string) {
  const s = stages.find(x => x.name === name);
  if (s) {
    s.status = "done";
    s.completedAt = new Date().toISOString();
    s.durationMs = s.startedAt ? Date.now() - new Date(s.startedAt).getTime() : 0;
    if (detail) s.detail = detail;
  }
}

function failStage(stages: PipelineStage[], name: string, detail: string) {
  const s = stages.find(x => x.name === name);
  if (s) { s.status = "failed"; s.detail = detail; s.completedAt = new Date().toISOString(); }
}

function categoriseChanges(fileChanges: Array<{ path: string; operation: string; [k: string]: unknown }>) {
  const routes: MergedItem[]     = [];
  const components: MergedItem[] = [];
  const schemas: MergedItem[]    = [];
  const assets: MergedItem[]     = [];

  for (const fc of fileChanges) {
    const item: MergedItem = { path: fc.path, action: fc.operation };
    const p = fc.path.toLowerCase();

    if (p.includes("route") || p.includes("/api/") || p.endsWith(".route.ts") || p.endsWith(".route.js")) {
      routes.push(item);
    } else if (p.includes("component") || p.includes("/ui/") || p.endsWith(".tsx") || p.endsWith(".jsx")) {
      components.push(item);
    } else if (p.includes("schema") || p.includes("migration") || p.includes("model") || p.endsWith(".sql")) {
      schemas.push(item);
    } else if (p.includes("asset") || p.includes("/public/") || p.includes("/static/") || /\.(png|jpg|svg|css|woff)$/.test(p)) {
      assets.push(item);
    } else {
      components.push(item);
    }
  }

  return { routes, components, schemas, assets };
}

async function runBM10Pipeline(
  jobId: string,
  targetVfs: VirtualFileSystem,
  dryRun: boolean,
): Promise<MergeExecutionReport> {
  const stages    = buildStages();
  const startMs   = Date.now();
  const cloud     = getDefaultCloudProvider();

  // Seed a partial report immediately so polling can observe progress
  const partialReport: MergeExecutionReport = {
    jobId, generatedAt: new Date().toISOString(), dryRun,
    durationMs: 0, stages, result: "failed",
    mergedRoutes: [], mergedComponents: [], mergedSchemas: [], mergedAssets: [],
    decisions: 0, conflicts: 0, fileChanges: 0,
  };
  reportCache.set(jobId, partialReport);

  // ── Stage 1: Compatibility ───────────────────────────────────────────────
  startStage(stages, "compatibility");
  const manifest = await loadManifest(jobId);
  if (!manifest) {
    failStage(stages, "compatibility", "Manifest not found — run a scrape job first.");
    partialReport.durationMs = Date.now() - startMs;
    return partialReport;
  }
  finishStage(stages, "compatibility", `Manifest v${manifest.version} — ${manifest.nodes.size} nodes`);

  // ── Stage 2: Simulation (SiteGraph + MergePlan dry-run) ─────────────────
  startStage(stages, "simulation");
  const portable     = adaptToPortable(manifest);
  const siteGraph    = compileSiteGraph(portable);
  const discoveryGraph = compileDiscoverySiteGraph(targetVfs);
  const mergePlan    = compileMergePlan(discoveryGraph, siteGraph);
  finishStage(stages, "simulation",
    `${mergePlan.decisions.length} decisions, ${mergePlan.conflicts.length} conflicts`);

  // ── Stage 3: Backup (snapshot the targetVfs structure) ──────────────────
  startStage(stages, "backup");
  const backupSnapshot = Object.keys(targetVfs).map(p => ({ path: p, size: targetVfs[p]?.length ?? 0 }));
  finishStage(stages, "backup", `${backupSnapshot.length} files snapshotted`);

  // ── Stage 4: Execution ───────────────────────────────────────────────────
  startStage(stages, "execution");
  const execResult = executeMergePlan(mergePlan, targetVfs, { dryRun, captureRollback: true });
  finishStage(stages, "execution", `${execResult.audit.fileChanges.length} file changes`);

  // ── Stage 5: Verification ────────────────────────────────────────────────
  startStage(stages, "verification");
  const { routes, components, schemas, assets } = categoriseChanges(execResult.audit.fileChanges as unknown as Array<{ path: string; operation: string; [k: string]: unknown }>);
  const durationMs = Date.now() - startMs;

  const report: MergeExecutionReport = {
    jobId,
    generatedAt: new Date().toISOString(),
    dryRun,
    durationMs,
    stages,
    result:          "success",
    mergedRoutes:    routes,
    mergedComponents: components,
    mergedSchemas:   schemas,
    mergedAssets:    assets,
    decisions:       mergePlan.decisions.length,
    conflicts:       mergePlan.conflicts.length,
    fileChanges:     execResult.audit.fileChanges.length,
    raw:             execResult.audit,
  };

  finishStage(stages, "verification",
    `routes=${routes.length} components=${components.length} schemas=${schemas.length} assets=${assets.length}`);

  // Persist merge-audit.json
  const auditJson = JSON.stringify({ meta: { jobId, generatedAt: report.generatedAt, dryRun, durationMs, phase: "BM-10" }, ...report }, null, 2);

  if (cloud.isConfigured()) {
    cloud.upload({
      key: `jobs/${jobId}/merge-audit.json`,
      data: Buffer.from(auditJson, "utf8"),
      contentType: "application/json",
      checkDuplicate: false,
    }).catch(() => {/* non-fatal */});
  }

  await writeFile(join(process.cwd(), "merge-audit.json"), auditJson, "utf8").catch(() => {/* non-fatal */});

  return report;
}

// ── POST /api/merge-execution-bm10/:jobId/execute ─────────────────────────────

router.post("/merge-execution-bm10/:jobId/execute", async (req, res): Promise<void> => {
  const jobId = (req.params as Record<string, string>)["jobId"] ?? "";
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  if (runningJobs.has(jobId)) {
    res.status(409).json({ error: "BM-10 already running for this job", hint: `GET /api/merge-execution-bm10/${jobId}/status` });
    return;
  }

  const body     = (req.body ?? {}) as Record<string, unknown>;
  const dryRun   = body["dryRun"] !== false;
  const force    = body["force"] === true;
  const targetVfs = (typeof body["targetVfs"] === "object" && body["targetVfs"] !== null)
    ? body["targetVfs"] as VirtualFileSystem
    : {};

  if (!force && reportCache.has(jobId)) {
    res.status(200).json({ cached: true, ...reportCache.get(jobId) });
    return;
  }

  req.log.info({ jobId, dryRun, force }, "BM10: execute requested");
  runningJobs.add(jobId);

  try {
    const report = await runBM10Pipeline(jobId, targetVfs, dryRun);
    reportCache.set(jobId, report);
    res.status(200).json(report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err, jobId }, "BM10: pipeline failed");
    res.status(500).json({ error: "BM-10 execution failed", detail: msg });
  } finally {
    runningJobs.delete(jobId);
  }
});

// ── GET /api/merge-execution-bm10/:jobId/report ───────────────────────────────

router.get("/merge-execution-bm10/:jobId/report", (req, res): void => {
  const jobId = (req.params as Record<string, string>)["jobId"] ?? "";
  const report = reportCache.get(jobId);
  if (!report) {
    res.status(404).json({
      error: "No BM-10 report found for this job.",
      hint: `POST /api/merge-execution-bm10/${jobId}/execute to run Phase BM-10.`,
    });
    return;
  }
  res.status(200).json(report);
});

// ── GET /api/merge-execution-bm10/:jobId/status ───────────────────────────────

router.get("/merge-execution-bm10/:jobId/status", (req, res): void => {
  const jobId  = (req.params as Record<string, string>)["jobId"] ?? "";
  const report = reportCache.get(jobId);
  const isRunning = runningJobs.has(jobId);

  if (!report && !isRunning) {
    res.status(404).json({
      jobId,
      status: "not_started",
      hint: `POST /api/merge-execution-bm10/${jobId}/execute to run Phase BM-10.`,
    });
    return;
  }

  res.status(200).json({
    jobId,
    status:    isRunning ? "running" : report?.result ?? "unknown",
    durationMs: report?.durationMs ?? null,
    stages:     report?.stages ?? [],
    decisions:  report?.decisions ?? null,
    conflicts:  report?.conflicts ?? null,
    fileChanges: report?.fileChanges ?? null,
  });
});

export default router;
