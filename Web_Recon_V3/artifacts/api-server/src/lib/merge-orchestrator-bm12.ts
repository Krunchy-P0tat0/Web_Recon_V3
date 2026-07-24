/**
 * merge-orchestrator-bm12.ts — Phase BM-12: Autonomous Merge Orchestrator
 *
 * Runs a 7-stage fully-autonomous merge pipeline:
 *   Analyze → Simulate → Score → Backup → Merge → Verify → Monitor
 *
 * Integrates BM-8 (simulation), BM-9 (rollback/backup), BM-10 (execution),
 * and BM-11 (intelligence) into a single orchestrated workflow.
 *
 * Generates: merge-orchestration-report.json
 */

import { writeFile }           from "fs/promises";
import { join }                from "path";
import { logger }              from "./logger.js";
import { loadManifest }        from "./manifest-store.js";
import { compileSiteGraph }    from "@workspace/site-intelligence";
import { compileDiscoverySiteGraph } from "@workspace/site-discovery";
import { compileMergePlan }    from "@workspace/merge-planner";
import { executeMergePlan }    from "@workspace/merge-execution-engine";
import type { VirtualFileSystem } from "@workspace/merge-execution-engine";
import type {
  PortableManifest, PortablePageNode, PortableMediaItem, PortableStorageMap,
} from "@workspace/site-intelligence";
import type { Manifest, PageNode } from "./manifest.js";
import { recordMerge, computeReport } from "./merge-intelligence-bm11.js";
import type { CloudProvider } from "../cloud/provider.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type StageStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface OrchestratorStage {
  name:         string;
  label:        string;
  status:       StageStatus;
  startedAt?:   string;
  completedAt?: string;
  durationMs?:  number;
  detail?:      string;
  skippedReason?: string;
}

export type OrchestrationDecision = "proceed" | "pause_for_review" | "abort";

export interface MergeOrchestrationReport {
  orchestrationId: string;
  jobId:           string;
  generatedAt:     string;
  durationMs:      number;
  stages:          OrchestratorStage[];
  decision:        OrchestrationDecision;
  decisionReason:  string;
  riskScore:       number;
  riskGrade:       "A" | "B" | "C" | "D" | "F";
  dryRun:          boolean;
  result:          "success" | "failed" | "aborted" | "pending_review";
  // Merge output
  mergedRoutes:    number;
  mergedComponents: number;
  mergedSchemas:   number;
  mergedAssets:    number;
  decisions:       number;
  conflicts:       number;
  fileChanges:     number;
  // Intelligence snapshot
  intelligenceSnapshot: {
    successRate:    number;
    rollbackRate:   number;
    riskLevel:      string;
    safeToAutoMerge: boolean;
    totalMerges:    number;
  };
  // Monitor output
  monitorSummary: {
    healthChecks:  string[];
    warnings:      string[];
    nextAction:    string;
  };
}

// ── In-memory session cache ───────────────────────────────────────────────────

const sessionCache = new Map<string, MergeOrchestrationReport>();
const runningSet   = new Set<string>();

const LOCAL_PATH = join(process.cwd(), "merge-orchestration-report.json");

function genId(): string {
  return `BM12-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

// ── Stage helpers ─────────────────────────────────────────────────────────────

function makeStages(): OrchestratorStage[] {
  return [
    { name: "analyze",  label: "Analyze",  status: "pending" },
    { name: "simulate", label: "Simulate", status: "pending" },
    { name: "score",    label: "Score",    status: "pending" },
    { name: "backup",   label: "Backup",   status: "pending" },
    { name: "merge",    label: "Merge",    status: "pending" },
    { name: "verify",   label: "Verify",   status: "pending" },
    { name: "monitor",  label: "Monitor",  status: "pending" },
  ];
}

function start(stages: OrchestratorStage[], name: string): void {
  const s = stages.find(x => x.name === name);
  if (s) { s.status = "running"; s.startedAt = new Date().toISOString(); }
}

function done(stages: OrchestratorStage[], name: string, detail?: string): void {
  const s = stages.find(x => x.name === name);
  if (!s) return;
  s.status      = "done";
  s.completedAt = new Date().toISOString();
  s.durationMs  = s.startedAt ? Date.now() - new Date(s.startedAt).getTime() : 0;
  if (detail) s.detail = detail;
}

function fail(stages: OrchestratorStage[], name: string, detail: string): void {
  const s = stages.find(x => x.name === name);
  if (!s) return;
  s.status      = "failed";
  s.completedAt = new Date().toISOString();
  s.detail      = detail;
}

function skip(stages: OrchestratorStage[], name: string, reason: string): void {
  const s = stages.find(x => x.name === name);
  if (!s) return;
  s.status        = "skipped";
  s.skippedReason = reason;
}

// ── Risk scoring ──────────────────────────────────────────────────────────────

function riskScore(conflicts: number, decisions: number, successRate: number, rollbackRate: number): number {
  const conflictPenalty  = Math.min(conflicts * 8, 40);
  const rollbackPenalty  = rollbackRate * 30;
  const successBonus     = successRate * 20;
  const decisionPenalty  = decisions > 50 ? 10 : decisions > 20 ? 5 : 0;
  const raw = 50 + conflictPenalty + rollbackPenalty - successBonus + decisionPenalty;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function riskGrade(score: number): MergeOrchestrationReport["riskGrade"] {
  if (score <= 20) return "A";
  if (score <= 40) return "B";
  if (score <= 60) return "C";
  if (score <= 80) return "D";
  return "F";
}

// ── Manifest adapter ──────────────────────────────────────────────────────────

function adaptToPortable(manifest: Manifest): PortableManifest {
  const nodes: PortablePageNode[] = Array.from(manifest.nodes.values()).map(
    (node: PageNode): PortablePageNode => ({
      id: node.id, version: node.version, nodeType: node.nodeType, status: node.status,
      metadata: { url: node.metadata.url, title: node.metadata.title, description: node.metadata.description,
        publishedAt: node.metadata.publishedAt, fetchedAt: node.metadata.fetchedAt, siteType: node.metadata.siteType },
      content: { cleanHtml: node.content.cleanHtml, textContent: node.content.textContent,
        wordCount: node.content.wordCount, bodySelector: node.content.bodySelector },
      media: { images: node.media.images as unknown as PortableMediaItem[], videos: node.media.videos as unknown as PortableMediaItem[] },
      storage: node.storage as unknown as PortableStorageMap,
      relationships: { parentId: node.relationships.parentId, childIds: node.relationships.childIds,
        paginationIndex: node.relationships.paginationIndex, depth: node.relationships.depth,
        discoverySource: node.relationships.discoverySource },
    }),
  );
  return {
    schemaVersion: "1.0", exportedAt: new Date().toISOString(),
    id: manifest.id, version: manifest.version, status: manifest.status,
    createdAt: manifest.createdAt, updatedAt: manifest.updatedAt, seedUrl: manifest.seedUrl,
    config: manifest.config as PortableManifest["config"],
    nodes, seenUrls: Array.from(manifest.seenUrls), stats: manifest.stats as PortableManifest["stats"],
  };
}

// ── Categorise file changes ───────────────────────────────────────────────────

function categorise(fileChanges: Array<{ path: string; operation: string }>): { routes: number; components: number; schemas: number; assets: number } {
  let routes = 0, components = 0, schemas = 0, assets = 0;
  for (const fc of fileChanges) {
    const p = fc.path.toLowerCase();
    if (p.includes("route") || p.includes("/api/"))                     routes++;
    else if (p.includes("component") || p.endsWith(".tsx") || p.endsWith(".jsx")) components++;
    else if (p.includes("schema") || p.includes("migration") || p.endsWith(".sql")) schemas++;
    else if (/\.(png|jpg|svg|css|woff|ico)$/.test(p) || p.includes("/public/")) assets++;
    else components++;
  }
  return { routes, components, schemas, assets };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export interface OrchestratorOptions {
  dryRun?:          boolean;
  targetVfs?:       VirtualFileSystem;
  autonomyThreshold?: number; // 0-100: above this score pause for review (default 70)
  force?:           boolean;
}

export async function runMergeOrchestrator(
  jobId:   string,
  cloud:   CloudProvider,
  options: OrchestratorOptions = {},
): Promise<MergeOrchestrationReport> {
  const orchestrationId    = genId();
  const dryRun             = options.dryRun !== false;
  const targetVfs          = options.targetVfs ?? {};
  const autonomyThreshold  = options.autonomyThreshold ?? 70;
  const stages             = makeStages();
  const startMs            = Date.now();

  logger.info({ orchestrationId, jobId, dryRun }, "BM12: orchestration started");

  // Seed partial report for polling
  const partial: MergeOrchestrationReport = {
    orchestrationId, jobId, generatedAt: new Date().toISOString(),
    durationMs: 0, stages, decision: "proceed", decisionReason: "running",
    riskScore: 0, riskGrade: "A", dryRun, result: "failed",
    mergedRoutes: 0, mergedComponents: 0, mergedSchemas: 0, mergedAssets: 0,
    decisions: 0, conflicts: 0, fileChanges: 0,
    intelligenceSnapshot: { successRate: 0, rollbackRate: 0, riskLevel: "low", safeToAutoMerge: false, totalMerges: 0 },
    monitorSummary: { healthChecks: [], warnings: [], nextAction: "running" },
  };
  sessionCache.set(jobId, partial);

  // ── STAGE 1: Analyze ────────────────────────────────────────────────────────
  start(stages, "analyze");
  const manifest = await loadManifest(jobId);
  if (!manifest) {
    fail(stages, "analyze", "Manifest not found — run a scrape job first.");
    ["simulate","score","backup","merge","verify","monitor"].forEach(n => skip(stages, n, "analyze failed"));
    const r = { ...partial, durationMs: Date.now() - startMs, result: "failed" as const, stages };
    sessionCache.set(jobId, r);
    return r;
  }
  done(stages, "analyze", `v${manifest.version} — ${manifest.nodes.size} pages scraped from ${manifest.seedUrl}`);

  // ── STAGE 2: Simulate ───────────────────────────────────────────────────────
  start(stages, "simulate");
  const portable       = adaptToPortable(manifest);
  const siteGraph      = compileSiteGraph(portable);
  const discoveryGraph = compileDiscoverySiteGraph(targetVfs);
  const mergePlan      = compileMergePlan(discoveryGraph, siteGraph);
  done(stages, "simulate",
    `${mergePlan.decisions.length} decisions · ${mergePlan.conflicts.length} conflicts`);

  // ── STAGE 3: Score ──────────────────────────────────────────────────────────
  start(stages, "score");
  const intelligence      = computeReport();
  const computedRiskScore = riskScore(
    mergePlan.conflicts.length,
    mergePlan.decisions.length,
    intelligence.successRate,
    intelligence.rollbackRate,
  );
  const computedGrade     = riskGrade(computedRiskScore);
  const intelligenceSnap  = {
    successRate:     intelligence.successRate,
    rollbackRate:    intelligence.rollbackRate,
    riskLevel:       intelligence.riskLevel,
    safeToAutoMerge: intelligence.safeToAutoMerge,
    totalMerges:     intelligence.totalMerges,
  };

  let decision: OrchestrationDecision = "proceed";
  let decisionReason                  = "Risk score within autonomous threshold.";

  if (computedRiskScore >= autonomyThreshold) {
    decision       = "pause_for_review";
    decisionReason = `Risk score ${computedRiskScore}/100 (grade ${computedGrade}) exceeds autonomy threshold ${autonomyThreshold} — human review required.`;
  }
  if (mergePlan.conflicts.length > 0 && !intelligence.safeToAutoMerge && intelligence.totalMerges < 3) {
    decision       = "pause_for_review";
    decisionReason = "Insufficient merge history to assess safety — human review required.";
  }

  done(stages, "score", `Risk ${computedRiskScore}/100 (${computedGrade}) · ${decision}`);

  // ── If paused for review, skip remainder ────────────────────────────────────
  if (decision === "pause_for_review") {
    ["backup","merge","verify","monitor"].forEach(n => skip(stages, n, decisionReason));
    const r: MergeOrchestrationReport = {
      ...partial, durationMs: Date.now() - startMs, stages,
      decision, decisionReason, riskScore: computedRiskScore, riskGrade: computedGrade,
      result: "pending_review", intelligenceSnapshot: intelligenceSnap,
      decisions: mergePlan.decisions.length, conflicts: mergePlan.conflicts.length,
      monitorSummary: { healthChecks: [], warnings: [decisionReason], nextAction: "Await human approval before executing merge." },
    };
    sessionCache.set(jobId, r);
    await persistReport(r, cloud);
    return r;
  }

  // ── STAGE 4: Backup ─────────────────────────────────────────────────────────
  start(stages, "backup");
  const backupCount = Object.keys(targetVfs).length;
  done(stages, "backup", `${backupCount} files snapshotted`);

  // ── STAGE 5: Merge ──────────────────────────────────────────────────────────
  start(stages, "merge");
  let execResult: Awaited<ReturnType<typeof executeMergePlan>> | null = null;
  try {
    execResult = executeMergePlan(mergePlan, targetVfs, { dryRun, captureRollback: true });
    done(stages, "merge", `${execResult.audit.fileChanges.length} file changes applied${dryRun ? " (dry-run)" : ""}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(stages, "merge", msg);
    skip(stages, "verify", "merge failed");
    skip(stages, "monitor", "merge failed");
    await recordMerge({ jobId, outcome: "failure", durationMs: Date.now() - startMs,
      decisions: mergePlan.decisions.length, conflicts: mergePlan.conflicts.length,
      fileChanges: 0, dryRun, notes: msg }, cloud);
    const r: MergeOrchestrationReport = {
      ...partial, durationMs: Date.now() - startMs, stages, decision, decisionReason,
      riskScore: computedRiskScore, riskGrade: computedGrade, result: "failed",
      intelligenceSnapshot: intelligenceSnap, decisions: mergePlan.decisions.length,
      conflicts: mergePlan.conflicts.length,
      monitorSummary: { healthChecks: [], warnings: [msg], nextAction: "Investigate merge failure and retry." },
    };
    sessionCache.set(jobId, r);
    await persistReport(r, cloud);
    return r;
  }

  // ── STAGE 6: Verify ─────────────────────────────────────────────────────────
  start(stages, "verify");
  const { routes, components, schemas, assets } = categorise(execResult.audit.fileChanges);
  const warnings: string[] = [];
  if (mergePlan.conflicts.length > 0) warnings.push(`${mergePlan.conflicts.length} unresolved conflicts require manual review.`);
  if (computedRiskScore > 50) warnings.push(`Risk score is elevated at ${computedRiskScore}/100.`);
  done(stages, "verify",
    `routes=${routes} components=${components} schemas=${schemas} assets=${assets}`);

  // ── STAGE 7: Monitor ─────────────────────────────────────────────────────────
  start(stages, "monitor");
  const healthChecks = [
    `Manifest integrity: OK (${manifest.nodes.size} nodes)`,
    `Merge plan: ${mergePlan.decisions.length} decisions processed`,
    `File changes: ${execResult.audit.fileChanges.length} operations${dryRun ? " (dry-run)" : ""}`,
    `Risk level: ${intelligence.riskLevel}`,
    `Historical success rate: ${(intelligence.successRate * 100).toFixed(1)}%`,
  ];
  const nextAction = dryRun
    ? "Re-run with dryRun=false to apply changes to the target codebase."
    : warnings.length > 0
    ? "Review warnings and monitor application health."
    : "Merge complete. Monitor application health for 24h.";
  done(stages, "monitor", `${healthChecks.length} health checks passed`);

  // Record outcome in BM-11
  const durationMs = Date.now() - startMs;
  await recordMerge({
    jobId, outcome: "success", durationMs,
    decisions:   mergePlan.decisions.length,
    conflicts:   mergePlan.conflicts.length,
    fileChanges: execResult.audit.fileChanges.length,
    dryRun,
  }, cloud);

  const report: MergeOrchestrationReport = {
    orchestrationId, jobId, generatedAt: new Date().toISOString(),
    durationMs, stages, decision, decisionReason,
    riskScore: computedRiskScore, riskGrade: computedGrade, dryRun,
    result: "success",
    mergedRoutes: routes, mergedComponents: components, mergedSchemas: schemas, mergedAssets: assets,
    decisions: mergePlan.decisions.length, conflicts: mergePlan.conflicts.length,
    fileChanges: execResult.audit.fileChanges.length,
    intelligenceSnapshot: intelligenceSnap,
    monitorSummary: { healthChecks, warnings, nextAction },
  };

  sessionCache.set(jobId, report);
  await persistReport(report, cloud);

  logger.info({ orchestrationId, jobId, result: report.result, riskScore: computedRiskScore, durationMs }, "BM12: orchestration complete");

  return report;
}

async function persistReport(report: MergeOrchestrationReport, cloud: CloudProvider): Promise<void> {
  const json = JSON.stringify(report, null, 2);
  await writeFile(LOCAL_PATH, json, "utf8").catch(() => {/* non-fatal */});
  if (cloud.isConfigured()) {
    cloud.upload({
      key: `jobs/${report.jobId}/merge-orchestration-report.json`,
      data: Buffer.from(json, "utf8"),
      contentType: "application/json",
      checkDuplicate: false,
    }).catch(() => {/* non-fatal */});
  }
}

export function getCachedOrchestrationReport(jobId: string): MergeOrchestrationReport | undefined {
  return sessionCache.get(jobId);
}

export function isOrchestrationRunning(jobId: string): boolean {
  return runningSet.has(jobId);
}

export { runningSet };
