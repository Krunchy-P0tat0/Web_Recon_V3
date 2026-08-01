/**
 * differential-execution-planner-types.ts — Phase D4.3 Intelligent Differential Execution Planner
 *
 * Types for the execution planner that inspects Website Memory and determines
 * the minimum required work before every pipeline run.
 *
 * Depends on: website-memory-types.ts (KnowledgeModule, WebsiteMemory, PipelineStageKey)
 */

import type { PipelineStageKey } from "./website-memory-types.js";

// ---------------------------------------------------------------------------
// Knowledge Module Status
// ---------------------------------------------------------------------------

/**
 * Status of a knowledge module relative to the system's current requirements.
 *
 *   missing   — module has never been generated (no memory entry)
 *   outdated  — module exists but its generatorVersion is behind the current engine version
 *   current   — module is present and up-to-date
 */
export type KnowledgeModuleStatus = "missing" | "outdated" | "current";

// ---------------------------------------------------------------------------
// Execution Mode
// ---------------------------------------------------------------------------

/**
 * The five supported execution modes for a pipeline run.
 *
 *   fresh                    — ignore all previous knowledge, perform complete analysis
 *   differential             — compare existing memory, execute only required work
 *   resume                   — restore persisted state, continue from last successful checkpoint
 *   upgrade                  — upgrade outdated knowledge modules without re-crawling
 *   regenerate-website-prime — generate final outputs without unnecessary crawling
 */
export type ExecutionMode =
  | "fresh"
  | "differential"
  | "resume"
  | "upgrade"
  | "regenerate-website-prime";

// ---------------------------------------------------------------------------
// Website Change Summary
// ---------------------------------------------------------------------------

export interface WebsiteUrlChangeSummary {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
}

export interface WebsiteAssetChangeSummary {
  added: string[];
  changed: string[];
  unchanged: string[];
}

export interface WebsiteChangeSummary {
  detected: boolean;
  urls: WebsiteUrlChangeSummary;
  assets: WebsiteAssetChangeSummary;
  /**
   * The baseline job ID used for comparison, if any.
   */
  baselineJobId: string | null;
  /**
   * ISO-8601 timestamp of the comparison.
   */
  computedAt: string;
}

// ---------------------------------------------------------------------------
// Module Dependency Graph
// ---------------------------------------------------------------------------

/**
 * Defines the explicit dependency graph for pipeline stages.
 * Each entry lists the stages that depend on it.
 */
export type ModuleDependencyGraph = Record<PipelineStageKey, PipelineStageKey[]>;

/**
 * The canonical module dependency graph.
 *
 * Rules:
 *   - If a module is outdated, it must be regenerated.
 *   - All modules that depend on the outdated module must also be re-evaluated
 *     (they become stale and may need regeneration).
 *   - Modules with no dependency relationship to the outdated module are
 *     skipped entirely.
 */
export const MODULE_DEPENDENCY_GRAPH: ModuleDependencyGraph = {
  "crawl":              ["manifest"],
  "manifest":           ["diff", "intelligence", "design-dna", "visual-dna"],
  "diff":               ["intelligence"],
  "intelligence":       ["design-dna", "visual-dna"],
  "design-dna":         ["stencil", "visual-dna"],
  "visual-dna":         ["stencil", "website-prime"],
  "stencil":            ["website-prime"],
  "website-prime":      ["merge", "certification"],
  "merge":              ["deployment-plan"],
  "deployment-plan":    ["deploy"],
  "deploy":             ["certification"],
  "certification":      [],
};

// ---------------------------------------------------------------------------
// Generator Version Registry
// ---------------------------------------------------------------------------

/**
 * Maps each pipeline stage to the minimum generator version required by the
 * current system. Used to determine whether a stored knowledge module is
 * outdated.
 *
 * When an engine is upgraded, bump its version here. The planner compares
 * stored module.generatorVersion against these values.
 */
export const REQUIRED_GENERATOR_VERSIONS: Record<PipelineStageKey, string> = {
  "crawl":              "3.0.0",
  "manifest":           "1.0.0",
  "diff":               "1.0.0",
  "intelligence":       "1.0.0",
  "design-dna":         "BrandDNA-v1",
  "visual-dna":         "VisualDNA-v1",
  "stencil":            "1.0.0",
  "website-prime":      "1.0.0",
  "merge":              "1.0.0",
  "deployment-plan":    "1.0.0",
  "deploy":             "1.0.0",
  "certification":      "Certification-v1",
};

// ---------------------------------------------------------------------------
// Knowledge Status Report
// ---------------------------------------------------------------------------

export interface ModuleStatusDetail {
  stage: PipelineStageKey;
  status: KnowledgeModuleStatus;
  storedVersion: number | null;
  requiredVersion: string;
  storedGeneratorVersion: string | null;
  health: string | null;
  completed: boolean;
  generatedAt: string | null;
  checksum: string | null;
}

export interface KnowledgeStatusReport {
  modules: ModuleStatusDetail[];
  missingModules: PipelineStageKey[];
  outdatedModules: PipelineStageKey[];
  currentModules: PipelineStageKey[];
}

// ---------------------------------------------------------------------------
// Execution Plan
// ---------------------------------------------------------------------------

export interface ExecutionPlan {
  /**
   * Target website domain.
   */
  website: string;

  /**
   * ISO-8601 timestamp of plan creation.
   */
  plannedAt: string;

  /**
   * The execution mode selected by the planner.
   */
  executionMode: ExecutionMode;

  /**
   * Overall memory status summary.
   */
  memoryStatus: {
    exists: boolean;
    websiteId: string | null;
    state: string | null;
    jobId: string | null;
    lastCrawlAt: string | null;
    lastSuccessfulPipeline: string | null;
  };

  /**
   * Detailed knowledge status across all modules.
   */
  knowledgeStatus: KnowledgeStatusReport;

  /**
   * Website change detection results (null if no baseline to compare against).
   */
  websiteChangeSummary: WebsiteChangeSummary | null;

  /**
   * Pipeline stages that are missing (never generated).
   */
  missingModules: PipelineStageKey[];

  /**
   * Pipeline stages that exist but are outdated.
   */
  outdatedModules: PipelineStageKey[];

  /**
   * Modules that depend on missing or outdated modules and therefore need
   * re-evaluation or regeneration.
   */
  affectedDownstreamModules: PipelineStageKey[];

  /**
   * The recommended pipeline stages to run, in execution order.
   */
  recommendedStages: PipelineStageKey[];

  /**
   * Estimated work description.
   */
  estimatedWork: {
    totalStages: number;
    stagesToRun: number;
    description: string;
  };

  /**
   * Artifacts that can be reused from previous runs.
   */
  reusableArtifacts: string[];

  /**
   * Artifacts that are not available and need to be generated.
   */
  unavailableArtifacts: string[];

  /**
   * Recovery options if the pipeline was interrupted.
   */
  recoveryOptions: {
    canResume: boolean;
    lastCheckpointStage: string | null;
    checkpointJobId: string | null;
    resumeInstructions: string | null;
  };

  /**
   * Human-readable reasoning for the plan.
   */
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Planner Options
// ---------------------------------------------------------------------------

export interface PlannerOptions {
  /**
   * The target website URL or domain.
   */
  url: string;

  /**
   * Optional explicit baseline job ID for differential comparison.
   * If omitted, the planner auto-detects the latest completed job.
   */
  baseJobId?: string;

  /**
   * Optional preferred execution mode.
   * If omitted, the planner auto-selects the best mode based on memory state.
   */
  preferredMode?: ExecutionMode;
}

// ---------------------------------------------------------------------------
// Named version constants for engines
// ---------------------------------------------------------------------------

export const VISUAL_DNA_ENGINE_VERSION = "VisualDNA-v1";
export const CERTIFICATION_ENGINE_VERSION = "Certification-v1";
export const DIFF_ENGINE_VERSION = "1.0.0";
export const MANIFEST_ENGINE_VERSION = "1.0.0";
export const INTELLIGENCE_ENGINE_VERSION = "1.0.0";
export const STENCIL_ENGINE_VERSION = "1.0.0";
export const WEBSITE_PRIME_ENGINE_VERSION = "1.0.0";
export const MERGE_ENGINE_VERSION = "1.0.0";
export const DEPLOYMENT_PLAN_ENGINE_VERSION = "1.0.0";
export const DEPLOY_ENGINE_VERSION = "1.0.0";
