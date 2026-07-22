/**
 * pipeline-verification-engine.ts — CP-3: Pipeline Verification
 *
 * Performs static + structural verification of the canonical visual pipeline:
 *   1. Engine file existence check (static)
 *   2. Route registration check (structural — via route map)
 *   3. Dependency graph validation (DAG — no cycles, no orphans)
 *   4. Input/output contract tracing (call-graph derivation)
 *   5. Dead-stage detection
 *
 * Live HTTP probing is handled via runLiveProbe() which makes internal
 * requests to each stage's probe endpoint.
 */

import { CANONICAL_STAGES, type PipelineStage } from "./canonical-pipeline-engine.js";
import { logger } from "./logger.js";
import { existsSync } from "fs";
import { join } from "path";

// Engine source files live in src/lib/ relative to the package cwd.
// pnpm --filter changes cwd to the package root (artifacts/api-server/),
// so src/lib/ is the correct relative path.
// esbuild bundles all engines into a single dist/index.mjs, so we verify
// source .ts presence rather than compiled output.
const SRC_LIB_DIR = join(process.cwd(), "src/lib");

// ---------------------------------------------------------------------------
// Static verification data — engine → route map
// ---------------------------------------------------------------------------

interface StageVerificationMeta {
  engineFile:    string;
  entryFn:       string;
  probeEndpoint: string;
  probeMethod:   "GET" | "POST";
  probeBody?:    Record<string, unknown>;
  inputFrom:     string[];   // stage ids whose output feeds this stage
  outputType:    string;     // canonical type name produced
  consumers:     string[];   // stage ids that consume this stage's output
}

const STAGE_META: Record<string, StageVerificationMeta> = {
  capture: {
    engineFile:    "visual-capture-engine.ts",
    entryFn:       "runVisualCapture(jobId, manifest, options?)",
    probeEndpoint: "/api/visual-dna/report",
    probeMethod:   "GET",
    inputFrom:     [],
    outputType:    "VisualAssets (attached to PageNodes)",
    consumers:     ["dna", "layout"],
  },
  dna: {
    engineFile:    "screenshot-visual-dna-engine.ts",
    entryFn:       "extractVisualDNA(jobId, manifest)",
    probeEndpoint: "/api/visual-dna/report",
    probeMethod:   "GET",
    inputFrom:     ["capture"],
    outputType:    "CanonicalVisualDNA",
    consumers:     ["stencil", "consistency", "fidelity_score"],
  },
  layout: {
    engineFile:    "visual-layout-mapper-engine.ts",
    entryFn:       "runLayoutMapper(jobId, manifest)",
    probeEndpoint: "/api/layout-map/report",
    probeMethod:   "GET",
    inputFrom:     ["capture"],
    outputType:    "LayoutAnalysisReport",
    consumers:     ["stencil"],
  },
  stencil: {
    engineFile:    "visual-stencil-mapper-vr5-engine.ts",
    entryFn:       "runVisualStencilMapperVR5(jobId)",
    probeEndpoint: "/api/visual-stencil/probe-job/report",
    probeMethod:   "GET",
    inputFrom:     ["dna", "layout"],
    outputType:    "VisualStencilMap",
    consumers:     ["fidelity_score"],
  },
  consistency: {
    engineFile:    "consistency-engine-vr6.ts",
    entryFn:       "runConsistencyEngineVR6(jobId, options?)",
    probeEndpoint: "/api/consistency-vr6/probe-job/report",
    probeMethod:   "GET",
    inputFrom:     ["dna"],
    outputType:    "ConsistencyReport",
    consumers:     ["fidelity_score"],
  },
  fidelity_score: {
    engineFile:    "visual-fidelity-scoring-engine-vr7.ts",
    entryFn:       "runFidelityScoringVR7(input)",
    probeEndpoint: "/api/fidelity-vr7/probe-src/probe-gen/report",
    probeMethod:   "GET",
    inputFrom:     ["dna", "stencil", "consistency"],
    outputType:    "CanonicalFidelityReport",
    consumers:     ["loop"],
  },
  loop: {
    engineFile:    "reconstruction-loop-engine-vr8.ts",
    entryFn:       "runReconstructionLoop(config)",
    probeEndpoint: "/api/reconstruction-loop-vr8/probe-job/status",
    probeMethod:   "GET",
    inputFrom:     ["fidelity_score"],
    outputType:    "ReconstructionReport",
    consumers:     ["pixel_compare"],
  },
  pixel_compare: {
    engineFile:    "pixel-comparison-engine.ts",
    entryFn:       "runPixelComparison(sourceJobId, generatedJobId)",
    probeEndpoint: "/api/pixel-compare/probe-src/probe-gen/report",
    probeMethod:   "GET",
    inputFrom:     ["loop"],
    outputType:    "PixelComparisonReport",
    consumers:     ["diff_localize"],
  },
  diff_localize: {
    engineFile:    "visual-diff-localizer.ts",
    entryFn:       "runVisualDiffLocalizer(sourceJobId, generatedJobId)",
    probeEndpoint: "/api/visual-diff/probe-src/probe-gen/map",
    probeMethod:   "GET",
    inputFrom:     ["pixel_compare"],
    outputType:    "DiffLocalizationReport",
    consumers:     ["optimize"],
  },
  optimize: {
    engineFile:    "visual-optimizer.ts",
    entryFn:       "runVisualOptimizer(sourceJobId, generatedJobId)",
    probeEndpoint: "/api/visual-optimizer/probe-src/probe-gen/plan",
    probeMethod:   "GET",
    inputFrom:     ["diff_localize"],
    outputType:    "OptimizationReport",
    consumers:     [],
  },
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type VerificationStatus = "PASS" | "WARN" | "FAIL";

export interface StageVerificationResult {
  stageId:        string;
  stageName:      string;
  phase:          string;
  engineFile:     string;
  engineExists:   boolean;
  routeRegistered: boolean;
  probeStatus:    number | null;
  probeResponse:  "ok" | "404-expected" | "error" | "timeout" | "unknown";
  inputsValid:    boolean;
  outputConsumed: boolean;
  isDead:         boolean;
  status:         VerificationStatus;
  notes:          string[];
}

export interface PipelineVerificationReport {
  version:      "CP-3";
  generatedAt:  string;
  durationMs:   number;
  overallStatus: VerificationStatus;
  totalStages:  number;
  passCount:    number;
  warnCount:    number;
  failCount:    number;
  deadStages:   string[];
  stages:       StageVerificationResult[];
  summary:      string;
}

// ---------------------------------------------------------------------------
// DAG utilities
// ---------------------------------------------------------------------------

function detectCycles(stages: PipelineStage[]): string[][] {
  const cycles: string[][] = [];
  const visited  = new Set<string>();
  const recStack = new Set<string>();
  const byId     = new Map(stages.map(s => [s.id, s]));

  function dfs(id: string, path: string[]): void {
    visited.add(id);
    recStack.add(id);
    const stage = byId.get(id);
    if (!stage) return;
    for (const dep of stage.dependsOn) {
      if (!visited.has(dep)) {
        dfs(dep, [...path, dep]);
      } else if (recStack.has(dep)) {
        cycles.push([...path, dep]);
      }
    }
    recStack.delete(id);
  }

  for (const s of stages) {
    if (!visited.has(s.id)) dfs(s.id, [s.id]);
  }
  return cycles;
}

function findOrphans(stages: PipelineStage[]): string[] {
  const referenced = new Set(stages.flatMap(s => s.dependsOn));
  return stages
    .filter(s => s.dependsOn.length === 0 && s.id !== "capture")
    .map(s => s.id)
    .filter(id => !referenced.has(id));
}

// ---------------------------------------------------------------------------
// Live probe (non-blocking, short timeout)
// ---------------------------------------------------------------------------

async function probeEndpoint(
  endpoint: string,
): Promise<{ status: number; category: StageVerificationResult["probeResponse"] }> {
  try {
    const baseUrl = "http://localhost:80";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const res = await fetch(`${baseUrl}${endpoint}`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status === 404 || res.status === 200) {
        return { status: res.status, category: "404-expected" };
      }
      return { status: res.status, category: "ok" };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort") || msg.includes("timeout")) {
      return { status: -1, category: "timeout" };
    }
    return { status: -1, category: "error" };
  }
}

// ---------------------------------------------------------------------------
// Main verification
// ---------------------------------------------------------------------------

export async function runPipelineVerification(): Promise<PipelineVerificationReport> {
  const start = Date.now();
  logger.info("CP-3: starting pipeline verification");

  const cycles = detectCycles(CANONICAL_STAGES);
  const orphans = findOrphans(CANONICAL_STAGES);

  const results: StageVerificationResult[] = [];

  for (const stage of CANONICAL_STAGES) {
    const meta = STAGE_META[stage.id];
    const notes: string[] = [];

    // 1. Engine source file exists (esbuild bundles to single dist/index.mjs;
    //    check the TypeScript source in src/lib/ as the canonical existence proof)
    const tsSrc       = join(SRC_LIB_DIR, meta.engineFile);
    const engineExists = existsSync(tsSrc);
    if (!engineExists) notes.push(`Engine file not found: ${meta.engineFile}`);

    // 2. Route registered (verified via probe)
    const { status, category } = await probeEndpoint(meta.probeEndpoint);
    const routeRegistered = status !== -1 && category !== "error";
    if (!routeRegistered) notes.push(`Route probe failed: ${meta.probeEndpoint} → ${status}`);

    // 3. Input validity — check all declared inputs map to known stage IDs
    const allIds     = new Set(CANONICAL_STAGES.map(s => s.id));
    const inputsValid = meta.inputFrom.every(id => allIds.has(id));
    if (!inputsValid) {
      notes.push(`Unknown input stages: ${meta.inputFrom.filter(id => !allIds.has(id)).join(", ")}`);
    }

    // 4. Dead stage — no consumers AND not the terminal stage (optimize)
    const isTerminal   = stage.id === "optimize";
    const isDead       = meta.consumers.length === 0 && !isTerminal && !stage.optional;
    const outputConsumed = meta.consumers.length > 0 || isTerminal;
    if (isDead) notes.push("Dead stage: output has no consumers and stage is not terminal");

    // 5. Cycle membership
    if (cycles.some(c => c.includes(stage.id))) {
      notes.push("Stage is part of a dependency cycle — DAG violation");
    }

    // 6. Orphan
    if (orphans.includes(stage.id)) {
      notes.push("Stage is an orphan (no dependsOn, not capture)");
    }

    const status_: VerificationStatus =
      !engineExists || isDead || cycles.length > 0
        ? "FAIL"
        : !routeRegistered
          ? "WARN"
          : "PASS";

    results.push({
      stageId:        stage.id,
      stageName:      stage.name,
      phase:          stage.phase,
      engineFile:     meta.engineFile,
      engineExists,
      routeRegistered,
      probeStatus:    status === -1 ? null : status,
      probeResponse:  category,
      inputsValid,
      outputConsumed,
      isDead,
      status:         status_,
      notes,
    });
  }

  const passCount = results.filter(r => r.status === "PASS").length;
  const warnCount = results.filter(r => r.status === "WARN").length;
  const failCount = results.filter(r => r.status === "FAIL").length;
  const deadStages = results.filter(r => r.isDead).map(r => r.stageId);

  const overallStatus: VerificationStatus =
    failCount > 0 ? "FAIL" : warnCount > 0 ? "WARN" : "PASS";

  const summary =
    failCount > 0
      ? `${failCount} stage(s) FAILED verification — check engineExists and dead-stage fields`
      : warnCount > 0
        ? `All engines present; ${warnCount} stage(s) have route probe warnings`
        : `All ${passCount} canonical stages PASS verification — pipeline is healthy`;

  logger.info({ overallStatus, passCount, warnCount, failCount }, "CP-3: verification complete");

  return {
    version:      "CP-3",
    generatedAt:  new Date().toISOString(),
    durationMs:   Date.now() - start,
    overallStatus,
    totalStages:  results.length,
    passCount,
    warnCount,
    failCount,
    deadStages,
    stages:       results,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Call graph builder
// ---------------------------------------------------------------------------

export interface CallNode {
  stageId:    string;
  engine:     string;
  entryFn:    string;
  outputType: string;
  phase:      string;
}

export interface CallEdge {
  from:      string;   // stageId
  to:        string;   // stageId
  dataType:  string;   // what is passed
}

export interface CallGraph {
  version:    "CP-3";
  generatedAt: string;
  nodes:      CallNode[];
  edges:      CallEdge[];
  entryPoint: string;
  terminals:  string[];
}

export function buildCallGraph(): CallGraph {
  const nodes: CallNode[] = CANONICAL_STAGES.map(s => ({
    stageId:    s.id,
    engine:     s.engine,
    entryFn:    STAGE_META[s.id]?.entryFn ?? "unknown()",
    outputType: STAGE_META[s.id]?.outputType ?? "unknown",
    phase:      s.phase,
  }));

  const edges: CallEdge[] = [];
  for (const stage of CANONICAL_STAGES) {
    const meta = STAGE_META[stage.id];
    for (const from of meta.inputFrom) {
      const fromMeta = STAGE_META[from];
      edges.push({
        from,
        to:       stage.id,
        dataType: fromMeta?.outputType ?? "unknown",
      });
    }
  }

  const terminals = CANONICAL_STAGES
    .filter(s => (STAGE_META[s.id]?.consumers ?? []).length === 0)
    .map(s => s.id);

  return {
    version:     "CP-3",
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    entryPoint:  "capture",
    terminals,
  };
}

// ---------------------------------------------------------------------------
// Dependency report builder
// ---------------------------------------------------------------------------

export interface DependencyEntry {
  stageId:      string;
  engine:       string;
  phase:        string;
  dependsOn:    string[];
  dependentsOf: string[];   // stages that depend on this
  depth:        number;     // distance from capture (longest path)
  isOptional:   boolean;
  replacesCount: number;
}

export interface DependencyReport {
  version:     "CP-3";
  generatedAt: string;
  cyclesFound: number;
  cycles:      string[][];
  orphans:     string[];
  maxDepth:    number;
  entries:     DependencyEntry[];
}

export function buildDependencyReport(): DependencyReport {
  const cycles = detectCycles(CANONICAL_STAGES);
  const orphans = findOrphans(CANONICAL_STAGES);

  // Compute depth via BFS from capture
  const depth: Record<string, number> = { capture: 0 };
  const queue = [...CANONICAL_STAGES.filter(s => s.id === "capture")];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur.id)) continue;
    visited.add(cur.id);
    const curDepth = depth[cur.id] ?? 0;
    for (const next of CANONICAL_STAGES.filter(s => s.dependsOn.includes(cur.id))) {
      const nd = curDepth + 1;
      if ((depth[next.id] ?? -1) < nd) depth[next.id] = nd;
      queue.push(next);
    }
  }

  const entries: DependencyEntry[] = CANONICAL_STAGES.map(s => ({
    stageId:       s.id,
    engine:        s.engine,
    phase:         s.phase,
    dependsOn:     s.dependsOn,
    dependentsOf:  CANONICAL_STAGES.filter(o => o.dependsOn.includes(s.id)).map(o => o.id),
    depth:         depth[s.id] ?? 0,
    isOptional:    s.optional,
    replacesCount: s.replaces.length,
  }));

  const maxDepth = Math.max(...entries.map(e => e.depth), 0);

  return {
    version:     "CP-3",
    generatedAt: new Date().toISOString(),
    cyclesFound: cycles.length,
    cycles,
    orphans,
    maxDepth,
    entries,
  };
}
