/**
 * differential-execution-planner.ts — Phase D4.3 Intelligent Differential Execution Planner
 *
 * Inspects Website Memory before every pipeline run and determines the minimum
 * required work. Supports five execution modes, knowledge module version
 * comparison, dependency graph traversal, and website change detection.
 *
 * Depends on:
 *   - website-memory-types.ts (KnowledgeModule, WebsiteMemory)
 *   - website-memory-service.ts (WebsiteMemoryService)
 *   - diff-engine.ts (DiffReport, computeDiff, computeContentHash)
 *   - checkpoint-engine.ts (loadCheckpoint, computeResumeList)
 *   - manifest-store.ts (loadManifest)
 */

import { logger } from "./logger.js";
import { getWebsiteMemoryService, WebsiteMemoryNotFoundError } from "./website-memory-service.js";
import type { WebsiteMemory, KnowledgeModule, PipelineStageKey } from "./website-memory-types.js";
import { PIPELINE_STAGE_KEYS } from "./website-memory-types.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import { loadBaselineManifest, computeDiff } from "./diff-engine.js";
import { loadManifest } from "./manifest-store.js";
import { loadCheckpoint } from "./checkpoint-engine.js";
import { findLatestBaselineJobId } from "./diff-engine.js";
import type { ListJobsFn } from "./diff-engine.js";
import {
  MODULE_DEPENDENCY_GRAPH,
  REQUIRED_GENERATOR_VERSIONS,
} from "./differential-execution-planner-types.js";
import type {
  ExecutionPlan,
  ExecutionMode,
  KnowledgeModuleStatus,
  KnowledgeStatusReport,
  ModuleStatusDetail,
  WebsiteChangeSummary,
  PlannerOptions,
} from "./differential-execution-planner-types.js";

// ---------------------------------------------------------------------------
// IntelligentDifferentialExecutionPlanner
// ---------------------------------------------------------------------------

export class IntelligentDifferentialExecutionPlanner {
  private readonly memoryService = getWebsiteMemoryService();
  private readonly cloud = getDefaultCloudProvider();

  /**
   * Creates an execution plan for the given website URL.
   *
   * 1. Loads (or attempts to load) Website Memory for the target domain.
   * 2. Evaluates every knowledge module against current required versions.
   * 3. Traverses the dependency graph to find affected downstream modules.
   * 4. Detects website changes if a baseline manifest is available.
   * 5. Selects the optimal execution mode.
   * 6. Produces a full ExecutionPlan with recommended stages, reusable
   *    artifacts, and recovery options.
   */
  async createExecutionPlan(opts: PlannerOptions): Promise<ExecutionPlan> {
    const t0 = Date.now();
    const { url, baseJobId: explicitBaseJobId, preferredMode } = opts;

    logger.info({ url, preferredMode }, "PLANNER: creating execution plan");

    // ── 1. Load website memory ──────────────────────────────────────────────
    let memory: WebsiteMemory | null = null;
    let memoryExists = false;
    try {
      memory = await this.memoryService.loadWebsiteMemory(url);
      memoryExists = true;
    } catch (err) {
      if (err instanceof WebsiteMemoryNotFoundError) {
        logger.info({ url }, "PLANNER: no existing Website Memory — fresh crawl required");
      } else {
        logger.warn({ url, err }, "PLANNER: error loading Website Memory — treating as fresh");
      }
    }

    // ── 2. Evaluate knowledge modules ────────────────────────────────────────
    const knowledgeStatus = this.evaluateKnowledgeModules(memory);

    // ── 3. Find downstream dependencies ──────────────────────────────────────
    const affectedDownstream = this.findAffectedDownstreamModules(
      [...knowledgeStatus.missingModules, ...knowledgeStatus.outdatedModules],
    );

    // ── 4. Detect website changes ────────────────────────────────────────────
    const websiteChangeSummary = await this.detectWebsiteChanges(
      url,
      memory,
      explicitBaseJobId,
    );

    // ── 5. Select execution mode ─────────────────────────────────────────────
    const executionMode = this.selectExecutionMode(
      memoryExists,
      knowledgeStatus,
      websiteChangeSummary,
      preferredMode,
    );

    // ── 6. Determine reusable / unavailable artifacts ────────────────────────
    const { reusableArtifacts, unavailableArtifacts } = this.classifyArtifacts(
      knowledgeStatus,
    );

    // ── 7. Recommended stages ────────────────────────────────────────────────
    const recommendedStages = this.computeRecommendedStages(
      executionMode,
      knowledgeStatus,
      memory,
    );

    // ── 8. Checkpoint / recovery status ──────────────────────────────────────
    const recoveryOptions = await this.evaluateRecoveryOptions(
      url,
      memory,
    );

    // ── 9. Assemble plan ─────────────────────────────────────────────────────
    const totalStages = PIPELINE_STAGE_KEYS.length;
    const plan: ExecutionPlan = {
      website: memory?.canonicalDomain ?? url,
      plannedAt: new Date().toISOString(),
      executionMode,
      memoryStatus: {
        exists: memoryExists,
        websiteId: memory?.websiteId ?? null,
        state: memory?.currentPipelineState ?? null,
        jobId: memory?.currentJobId ?? null,
        lastCrawlAt: memory?.lastCrawlAt ?? null,
        lastSuccessfulPipeline: memory?.lastSuccessfulPipeline ?? null,
      },
      knowledgeStatus,
      websiteChangeSummary,
      missingModules: knowledgeStatus.missingModules,
      outdatedModules: knowledgeStatus.outdatedModules,
      affectedDownstreamModules: affectedDownstream,
      recommendedStages,
      estimatedWork: {
        totalStages,
        stagesToRun: recommendedStages.length,
        description: this.describeEstimatedWork(executionMode, recommendedStages, knowledgeStatus),
      },
      reusableArtifacts,
      unavailableArtifacts,
      recoveryOptions,
      reasoning: this.buildReasoning(
        executionMode,
        memoryExists,
        knowledgeStatus,
        websiteChangeSummary,
        affectedDownstream,
        recommendedStages,
      ),
    };

    const durationMs = Date.now() - t0;
    logger.info(
      {
        url,
        executionMode,
        stagesToRun: recommendedStages.length,
        missing: knowledgeStatus.missingModules.length,
        outdated: knowledgeStatus.outdatedModules.length,
        affected: affectedDownstream.length,
        durationMs,
      },
      "PLANNER: execution plan created",
    );

    return plan;
  }

  // -------------------------------------------------------------------------
  // Knowledge Module Evaluation
  // -------------------------------------------------------------------------

  /**
   * Evaluates every pipeline stage's knowledge module against the current
   * required generator versions. Returns MISSING / OUTDATED / CURRENT for
   * each module, plus grouped lists.
   */
  evaluateKnowledgeModules(memory: WebsiteMemory | null): KnowledgeStatusReport {
    const modules: ModuleStatusDetail[] = [];
    const missingModules: PipelineStageKey[] = [];
    const outdatedModules: PipelineStageKey[] = [];
    const currentModules: PipelineStageKey[] = [];

    for (const stage of PIPELINE_STAGE_KEYS) {
      const requiredVer = REQUIRED_GENERATOR_VERSIONS[stage];
      const stored: KnowledgeModule | undefined = memory?.knowledgeModules?.[stage];

      let status: KnowledgeModuleStatus;
      let storedVer: number | null = null;
      let storedGenVer: string | null = null;

      if (!stored || !stored.completed) {
        status = "missing";
        missingModules.push(stage);
      } else {
        storedVer = stored.version;
        storedGenVer = stored.generatorVersion ?? null;

        // Compare stored generatorVersion against required version
        if (this.isGeneratorOutdated(stored.generatorVersion, requiredVer)) {
          status = "outdated";
          outdatedModules.push(stage);
        } else {
          status = "current";
          currentModules.push(stage);
        }
      }

      modules.push({
        stage,
        status,
        storedVersion: storedVer,
        requiredVersion: requiredVer,
        storedGeneratorVersion: storedGenVer,
        health: stored?.health ?? null,
        completed: stored?.completed ?? false,
        generatedAt: stored?.generatedAt ?? null,
        checksum: stored?.checksum ?? null,
      });
    }

    return { modules, missingModules, outdatedModules, currentModules };
  }

  // -------------------------------------------------------------------------
  // Dependency Graph Traversal
  // -------------------------------------------------------------------------

  /**
   * Given a set of changed/outdated/missing stages, finds all downstream
   * modules that depend on them and would need re-evaluation.
   */
  findAffectedDownstreamModules(changedStages: PipelineStageKey[]): PipelineStageKey[] {
    const affected = new Set<PipelineStageKey>();

    // Build reverse dependency map: module → what it depends on
    const reverseDeps: Record<PipelineStageKey, PipelineStageKey[]> = {} as Record<PipelineStageKey, PipelineStageKey[]>;
    for (const stage of PIPELINE_STAGE_KEYS) {
      reverseDeps[stage] = [];
    }
    for (const [stage, deps] of Object.entries(MODULE_DEPENDENCY_GRAPH)) {
      for (const dep of deps) {
        reverseDeps[dep].push(stage as PipelineStageKey);
      }
    }

    // BFS from changed stages
    const queue = [...changedStages];
    const visited = new Set<string>(changedStages);

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const downstream of reverseDeps[current] ?? []) {
        if (!visited.has(downstream)) {
          visited.add(downstream);
          affected.add(downstream);
          queue.push(downstream);
        }
      }
    }

    return PIPELINE_STAGE_KEYS.filter((s) => affected.has(s));
  }

  // -------------------------------------------------------------------------
  // Website Change Detection
  // -------------------------------------------------------------------------

  /**
   * Detects URL and asset changes by comparing the latest crawl manifest
   * against a baseline manifest.
   */
  async detectWebsiteChanges(
    url: string,
    memory: WebsiteMemory | null,
    explicitBaseJobId?: string,
  ): Promise<WebsiteChangeSummary | null> {
    // Need a baseline and a current manifest to diff
    if (!memory) return null;
    if (!memory.currentJobId && !explicitBaseJobId) return null;

    const baseJobId = explicitBaseJobId ?? memory.currentJobId;
    if (!baseJobId) return null;

    try {
      // Load the new manifest (current job's crawl output)
      const newManifest = await loadManifest(baseJobId);
      if (!newManifest) return null;

      // Auto-detect baseline: find the most recent completed job before this one
      const baselineJobId = await findLatestBaselineJobId(url, baseJobId, async () => {
        // Use in-memory job list from master-orchestrator
        // In a full implementation this would query the DB
        const { listJobs } = await import("./master-orchestrator.js");
        const jobs = listJobs();
        return jobs.map((j) => ({
          jobId: j.id,
          seedUrl: j.url,
          status: j.status === "complete" ? "done" : j.status,
          createdAt: j.startedAt,
        }));
      });

      if (!baselineJobId) return null;

      const baselineManifest = await loadBaselineManifest(this.cloud, baselineJobId);
      if (!baselineManifest) return null;

      const diffReport = computeDiff(baselineManifest, newManifest, baselineJobId, baseJobId);

      return {
        detected: diffReport.summary.new > 0 || diffReport.summary.changed > 0 || diffReport.summary.deleted > 0,
        urls: {
          added: diffReport.newNodes.map((n) => n.url),
          removed: diffReport.deletedNodes.map((n) => n.url),
          changed: diffReport.changedNodes.map((n) => n.url),
          unchanged: diffReport.unchangedNodes.map((n) => n.url),
        },
        assets: {
          added: [],
          changed: [],
          unchanged: [],
        },
        baselineJobId,
        computedAt: new Date().toISOString(),
      };
    } catch (err) {
      logger.warn({ url, baseJobId, err }, "PLANNER: website change detection failed");
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Execution Mode Selection
  // -------------------------------------------------------------------------

  /**
   * Selects the optimal execution mode based on the current memory state,
   * knowledge status, and any detected website changes.
   */
  selectExecutionMode(
    memoryExists: boolean,
    knowledgeStatus: KnowledgeStatusReport,
    websiteChange: WebsiteChangeSummary | null,
    preferredMode?: ExecutionMode,
  ): ExecutionMode {
    // Honor explicit preference
    if (preferredMode) return preferredMode;

    // No memory → fresh crawl
    if (!memoryExists) return "fresh";

    // All modules current and no website changes → regenerate website prime
    if (
      knowledgeStatus.missingModules.length === 0 &&
      knowledgeStatus.outdatedModules.length === 0 &&
      (!websiteChange || !websiteChange.detected)
    ) {
      // Check if website prime is needed
      return "regenerate-website-prime";
    }

    // Only outdated modules and no website changes → upgrade knowledge
    if (
      knowledgeStatus.missingModules.length === 0 &&
      knowledgeStatus.outdatedModules.length > 0 &&
      (!websiteChange || !websiteChange.detected)
    ) {
      return "upgrade";
    }

    // Website changed or modules missing → differential crawl
    return "differential";
  }

  // -------------------------------------------------------------------------
  // Artifact Classification
  // -------------------------------------------------------------------------

  classifyArtifacts(knowledgeStatus: KnowledgeStatusReport): {
    reusableArtifacts: string[];
    unavailableArtifacts: string[];
  } {
    const reusable: string[] = [];
    const unavailable: string[] = [];

    for (const mod of knowledgeStatus.modules) {
      if (mod.status === "current" && mod.completed && mod.checksum) {
        reusable.push(`${mod.stage} (v${mod.storedVersion}, checksum ${mod.checksum.slice(0, 12)}…)`);
      } else if (mod.status === "missing" || mod.status === "outdated") {
        unavailable.push(mod.stage);
      }
    }

    return { reusableArtifacts: reusable, unavailableArtifacts: unavailable };
  }

  // -------------------------------------------------------------------------
  // Recommended Stages
  // -------------------------------------------------------------------------

  /**
   * Computes the ordered list of pipeline stages that need to run,
   * based on the selected execution mode and knowledge state.
   */
  computeRecommendedStages(
    mode: ExecutionMode,
    knowledgeStatus: KnowledgeStatusReport,
    _memory: WebsiteMemory | null,
  ): PipelineStageKey[] {
    const stagesToRun = new Set<PipelineStageKey>();
    const { missingModules, outdatedModules, currentModules } = knowledgeStatus;

    switch (mode) {
      case "fresh": {
        // All stages
        for (const s of PIPELINE_STAGE_KEYS) stagesToRun.add(s);
        break;
      }

      case "differential": {
        // Missing + outdated + their downstream deps
        const changed = [...missingModules, ...outdatedModules];
        for (const s of changed) stagesToRun.add(s);
        // Add all downstream deps of changed modules
        for (const s of this.findAffectedDownstreamModules(changed)) {
          stagesToRun.add(s);
        }
        // If crawl is not needed but website prime is, add dependencies
        if (!stagesToRun.has("crawl") && missingModules.includes("website-prime")) {
          // Ensure prerequisites for website-prime are included
          for (const s of ["manifest", "visual-dna", "design-dna", "stencil"] as PipelineStageKey[]) {
            if (!currentModules.includes(s)) stagesToRun.add(s);
          }
        }
        break;
      }

      case "resume": {
        // Resume from last checkpoint — all stages from the interrupted one onward
        // We include all stages since the checkpoint may be at any point
        for (const s of PIPELINE_STAGE_KEYS) stagesToRun.add(s);
        break;
      }

      case "upgrade": {
        // Only outdated modules + their downstream deps
        for (const s of outdatedModules) stagesToRun.add(s);
        for (const s of this.findAffectedDownstreamModules(outdatedModules)) {
          stagesToRun.add(s);
        }
        break;
      }

      case "regenerate-website-prime": {
        // Only generate final outputs from existing knowledge
        // Website-prime and its downstream deps
        for (const s of ["website-prime", "merge", "deployment-plan", "deploy", "certification"] as PipelineStageKey[]) {
          stagesToRun.add(s);
        }
        break;
      }
    }

    // Return stages in pipeline execution order
    return PIPELINE_STAGE_KEYS.filter((s) => stagesToRun.has(s));
  }

  // -------------------------------------------------------------------------
  // Recovery Options
  // -------------------------------------------------------------------------

  async evaluateRecoveryOptions(
    url: string,
    memory: WebsiteMemory | null,
  ): Promise<ExecutionPlan["recoveryOptions"]> {
    if (!memory) {
      return {
        canResume: false,
        lastCheckpointStage: null,
        checkpointJobId: null,
        resumeInstructions: null,
      };
    }

    // Check if there's a checkpoint file for the current/last job
    const checkpointJobId = memory.currentJobId;
    if (!checkpointJobId) {
      return {
        canResume: false,
        lastCheckpointStage: null,
        checkpointJobId: null,
        resumeInstructions: "No checkpoint job ID found in memory. Start a fresh crawl.",
      };
    }

    try {
      const checkpoint = await loadCheckpoint(checkpointJobId);
      if (!checkpoint) {
        return {
          canResume: false,
          lastCheckpointStage: null,
          checkpointJobId,
          resumeInstructions: `Checkpoint file not found for job ${checkpointJobId}. The pipeline may need a fresh start or the checkpoint was not persisted.`,
        };
      }

      // Determine the last completed stage from the checkpoint
      const lastStage = checkpoint.stage ?? null;

      return {
        canResume: true,
        lastCheckpointStage: lastStage,
        checkpointJobId,
        resumeInstructions: lastStage
          ? `Checkpoint found at stage "${lastStage}". Resume from after this stage. ${checkpoint.completedUrls?.length ?? 0} URLs already crawled.`
          : "Checkpoint found but stage unknown. Resume recommended with full pipeline verification.",
      };
    } catch (err) {
      logger.warn({ checkpointJobId, err }, "PLANNER: checkpoint load failed");
      return {
        canResume: false,
        lastCheckpointStage: null,
        checkpointJobId,
        resumeInstructions: `Checkpoint could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Compares a stored generator version against the currently required version.
   * Returns true if the stored version is outdated.
   *
   * Currently uses exact string comparison. Will be upgraded to semver-aware
   * comparison in a future phase.
   */
  private isGeneratorOutdated(storedVersion: string, requiredVersion: string): boolean {
    if (!storedVersion) return true;
    return storedVersion !== requiredVersion;
  }

  private describeEstimatedWork(
    mode: ExecutionMode,
    recommendedStages: PipelineStageKey[],
    knowledgeStatus: KnowledgeStatusReport,
  ): string {
    if (recommendedStages.length === 0) return "No work required — all knowledge is current.";

    const parts: string[] = [];

    if (mode === "fresh") {
      parts.push("Complete pipeline: all 12 stages required (no existing knowledge).");
    } else {
      const missing = knowledgeStatus.missingModules;
      const outdated = knowledgeStatus.outdatedModules;
      if (missing.length > 0) parts.push(`${missing.length} missing module(s): ${missing.join(", ")}.`);
      if (outdated.length > 0) parts.push(`${outdated.length} outdated module(s): ${outdated.join(", ")}.`);
    }

    parts.push(`${recommendedStages.length} of ${PIPELINE_STAGE_KEYS.length} stages scheduled.`);

    return parts.join(" ");
  }

  private buildReasoning(
    mode: ExecutionMode,
    memoryExists: boolean,
    knowledgeStatus: KnowledgeStatusReport,
    websiteChange: WebsiteChangeSummary | null,
    affectedDownstream: PipelineStageKey[],
    recommendedStages: PipelineStageKey[],
  ): string {
    const lines: string[] = [];

    if (!memoryExists) {
      lines.push("No existing Website Memory found. A full fresh crawl is required.");
      return lines.join(" ");
    }

    if (knowledgeStatus.missingModules.length > 0) {
      lines.push(
        `Missing modules detected: ${knowledgeStatus.missingModules.join(", ")}. ` +
        `These have never been generated and must be produced.`,
      );
    }

    if (knowledgeStatus.outdatedModules.length > 0) {
      lines.push(
        `Outdated modules detected: ${knowledgeStatus.outdatedModules.join(", ")}. ` +
        `The stored generator versions do not match current system requirements.`,
      );
    }

    if (affectedDownstream.length > 0) {
      lines.push(
        `Downstream modules affected: ${affectedDownstream.join(", ")}. ` +
        `These depend on missing or outdated modules and will need re-evaluation.`,
      );
    }

    if (websiteChange?.detected) {
      const urlChanges = websiteChange.urls;
      lines.push(
        `Website changes detected: ${urlChanges.added.length} new URL(s), ` +
        `${urlChanges.changed.length} changed, ${urlChanges.removed.length} removed.`,
      );
    } else if (websiteChange && !websiteChange.detected) {
      lines.push("No significant website changes detected since the last crawl.");
    }

    const modeDescriptions: Record<ExecutionMode, string> = {
      fresh: "Selected mode: fresh — complete pipeline execution ignoring prior knowledge.",
      differential: "Selected mode: differential — executing only required and affected work.",
      resume: "Selected mode: resume — continuing from last persisted checkpoint.",
      upgrade: "Selected mode: upgrade — updating outdated knowledge modules only.",
      "regenerate-website-prime": "Selected mode: regenerate-website-prime — generating final outputs from existing knowledge without re-crawling.",
    };
    lines.push(modeDescriptions[mode]);

    if (recommendedStages.length > 0) {
      lines.push(`Recommended stages (${recommendedStages.length}): ${recommendedStages.join(" → ")}.`);
    }

    return lines.join(" ");
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _plannerSingleton: IntelligentDifferentialExecutionPlanner | null = null;

export function getExecutionPlanner(): IntelligentDifferentialExecutionPlanner {
  if (!_plannerSingleton) {
    _plannerSingleton = new IntelligentDifferentialExecutionPlanner();
  }
  return _plannerSingleton;
}
