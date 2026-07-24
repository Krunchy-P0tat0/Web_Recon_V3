/**
 * reconstruction-loop-engine-vr8.ts — Phase VR-8: Autonomous Visual Reconstruction Loop
 *
 * Self-improving reconstruction system that iterates until it reaches a fidelity
 * target or exhausts the iteration budget.
 *
 * Pipeline per iteration:
 *   1. Call the generation endpoint → receive generatedJobId
 *   2. Run VR-7 fidelity scoring (source vs generated)
 *   3. Check stopping conditions
 *   4. Derive rule adjustments from VR-7 issues (AdjustmentEngine)
 *   5. Store iteration record
 *   6. Pass adjustments to next generation call
 *   7. Repeat
 *
 * Adjustment engine translates VR-7 issues into typed rule patches:
 *   ColorAdjustment    — override palette tokens with source colours
 *   LayoutAdjustment   — reorder sections to match canonical sequence
 *   ComponentAdjustment— add/prioritise missing global components
 *   SpacingAdjustment  — override spacing scale / section gap
 *   TypographyAdjustment— override font families / size scale
 *
 * Stopping conditions:
 *   - fidelityScore >= targetScore        → "target_reached"
 *   - iterationNumber >= maxIterations    → "max_iterations"
 *   - score did not improve for N rounds  → "plateau"
 *   - generation call fails fatally       → "generation_error"
 *   - manual stop requested               → "manual_stop"
 *
 * Outputs (disk + R2):
 *   reconstruction-iterations.json  — per-iteration records
 *   reconstruction-report.json      — final summary report
 *
 * The loop runs fully asynchronously in the background.
 * Callers poll GET /status to observe progress.
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join }                        from "path";
import { logger }                      from "./logger.js";
import { getDefaultCloudProvider }     from "../cloud/index.js";
import {
  runFidelityScoringVR7,
  getCachedFidelityReport,
  type FidelityReport,
  type FidelityIssueVR7,
}                                      from "./visual-fidelity-scoring-engine-vr7.js";

// ---------------------------------------------------------------------------
// Adjustment types
// ---------------------------------------------------------------------------

export interface ColorAdjustment {
  kind:          "color";
  action:        "override_palette";
  field:         "primary" | "background" | "text" | "accent";
  sourceColors:  string[];
  confidence:    number;
  priority:      number;
}

export interface LayoutAdjustment {
  kind:             "layout";
  action:           "reorder_sections" | "fix_nav_placement" | "fix_footer_placement" | "adjust_grid";
  canonicalOrder:   string[];
  gridColumns?:     number;
  navPlacement?:    string;
  footerPlacement?: string;
  confidence:       number;
  priority:         number;
}

export interface ComponentAdjustment {
  kind:       "component";
  action:     "add_global" | "remove_extra" | "fix_variant";
  component:  string;
  pageIds:    string[];
  confidence: number;
  priority:   number;
}

export interface SpacingAdjustment {
  kind:        "spacing";
  action:      "override_scale" | "override_section_gap" | "override_density";
  scale?:      string[];
  sectionGap?: string;
  density?:    "compact" | "normal" | "spacious";
  confidence:  number;
  priority:    number;
}

export interface TypographyAdjustment {
  kind:        "typography";
  action:      "override_families" | "override_size_scale" | "override_weights";
  families?:   string[];
  sizeScale?:  string[];
  weights?:    string[];
  confidence:  number;
  priority:    number;
}

export type RuleAdjustment =
  | ColorAdjustment
  | LayoutAdjustment
  | ComponentAdjustment
  | SpacingAdjustment
  | TypographyAdjustment;

// ---------------------------------------------------------------------------
// Iteration record — reconstruction-iterations.json entry
// ---------------------------------------------------------------------------

export interface IterationRecord {
  iterationNumber:     number;
  generatedJobId:      string;
  scoreBefore:         number;
  scoreAfter:          number;
  delta:               number;
  grade:               string;
  improvementsApplied: string[];   // human-readable descriptions
  adjustments:         RuleAdjustment[];
  issuesBefore:        number;
  issuesAfter:         number;
  durationMs:          number;
  timestamp:           string;
  fidelityDimensions: {
    layout:     number;
    color:      number;
    spacing:    number;
    typography: number;
    component:  number;
  };
}

// ---------------------------------------------------------------------------
// Loop state (in-memory)
// ---------------------------------------------------------------------------

export type LoopStatus =
  | "idle"
  | "running"
  | "stopping"
  | "completed"
  | "failed";

export type StoppingCondition =
  | "target_reached"
  | "max_iterations"
  | "plateau"
  | "generation_error"
  | "manual_stop"
  | null;

export interface LoopState {
  sourceJobId:       string;
  status:            LoopStatus;
  currentIteration:  number;
  targetScore:       number;
  maxIterations:     number;
  plateauRounds:     number;    // consecutive rounds without improvement
  maxPlateauRounds:  number;
  stoppingCondition: StoppingCondition;
  startedAt:         string;
  completedAt:       string | null;
  currentScore:      number;
  bestScore:         number;
  bestIteration:     number;
  iterations:        IterationRecord[];
  currentAdjustments: RuleAdjustment[];
  generationEndpoint: string;
  lastError:         string | null;
}

// ---------------------------------------------------------------------------
// Final report — reconstruction-report.json
// ---------------------------------------------------------------------------

export interface ReconstructionReport {
  schemaVersion:     "VR-8";
  sourceJobId:       string;
  generatedAt:       string;
  durationMs:        number;
  status:            LoopStatus;
  stoppingCondition: StoppingCondition;
  config: {
    targetScore:      number;
    maxIterations:    number;
    maxPlateauRounds: number;
    generationEndpoint: string;
  };
  result: {
    iterationsRun:   number;
    initialScore:    number;
    finalScore:      number;
    bestScore:       number;
    bestIteration:   number;
    totalDelta:      number;
    targetReached:   boolean;
    grade:           string;
  };
  iterations:        IterationRecord[];
  adjustmentSummary: {
    totalApplied:    number;
    byKind: Record<RuleAdjustment["kind"], number>;
    mostImpactful:   string[];
  };
  r2IterationsKey?:  string;
  r2ReportKey?:      string;
}

// ---------------------------------------------------------------------------
// In-memory store (one loop per sourceJobId)
// ---------------------------------------------------------------------------

const _loops  = new Map<string, LoopState>();
const _reports = new Map<string, ReconstructionReport>();
const _stopFlags = new Set<string>();   // sourceJobIds requested to stop

export function getLoopState(sourceJobId: string): LoopState | undefined {
  return _loops.get(sourceJobId);
}
export function getReconstructionReport(sourceJobId: string): ReconstructionReport | undefined {
  return _reports.get(sourceJobId);
}
export function requestStop(sourceJobId: string): void {
  _stopFlags.add(sourceJobId);
  const state = _loops.get(sourceJobId);
  if (state && state.status === "running") state.status = "stopping";
}

// ---------------------------------------------------------------------------
// Adjustment engine
// ---------------------------------------------------------------------------

/**
 * Derive rule adjustments from VR-7 issues.
 * Higher-confidence adjustments address issues that fired on more pages.
 */
export function deriveAdjustments(
  report: FidelityReport,
  iteration: number,
): RuleAdjustment[] {
  const adjustments: RuleAdjustment[] = [];
  const issueFreq = new Map<string, number>();

  for (const issue of report.issues) {
    const k = issue.dimension;
    issueFreq.set(k, (issueFreq.get(k) ?? 0) + 1);
  }

  // ── Color ──────────────────────────────────────────────────────────────────
  const colorIssues = report.issues.filter(i => i.dimension === "color");
  if (colorIssues.length > 0) {
    const highSeverityColor = colorIssues.filter(i => i.severity === "high");
    if (highSeverityColor.length > 0 && report.global.colorScore < 80) {
      // Extract what fields are mismatched
      const fields: Array<"primary" | "background" | "text" | "accent"> =
        ["primary", "background", "text", "accent"];
      for (const field of fields) {
        const fieldIssue = colorIssues.find(i => i.description.toLowerCase().includes(field));
        if (fieldIssue) {
          // Source palette is in sourceValue (comma-sep hex list)
          const sourceColors = fieldIssue.sourceValue.split(",").map(s => s.trim()).filter(s => s.startsWith("#"));
          if (sourceColors.length > 0) {
            adjustments.push({
              kind: "color",
              action: "override_palette",
              field,
              sourceColors,
              confidence: 0.90,
              priority: field === "primary" ? 10 : field === "background" ? 8 : 6,
            });
          }
        }
      }
    }
  }

  // ── Layout ─────────────────────────────────────────────────────────────────
  const layoutIssues = report.issues.filter(i => i.dimension === "layout");
  if (layoutIssues.length > 0 && report.global.layoutScore < 85) {
    const orderIssue = layoutIssues.find(i => i.description.includes("section order") || i.description.includes("region sequence"));
    if (orderIssue) {
      const canonicalOrder = orderIssue.sourceValue.split(" → ").map(s => s.trim()).filter(Boolean);
      if (canonicalOrder.length > 0) {
        adjustments.push({
          kind: "layout",
          action: "reorder_sections",
          canonicalOrder,
          confidence: 0.85,
          priority: 9,
        });
      }
    }

    const navIssue = layoutIssues.find(i => i.description.toLowerCase().includes("nav placement"));
    if (navIssue) {
      adjustments.push({
        kind: "layout",
        action: "fix_nav_placement",
        canonicalOrder: [],
        navPlacement: navIssue.sourceValue,
        confidence: 0.88,
        priority: 8,
      });
    }

    const gridIssue = layoutIssues.find(i => i.description.toLowerCase().includes("grid column"));
    if (gridIssue) {
      const cols = parseInt(gridIssue.sourceValue, 10);
      if (!isNaN(cols)) {
        adjustments.push({
          kind: "layout",
          action: "adjust_grid",
          canonicalOrder: [],
          gridColumns: cols,
          confidence: 0.80,
          priority: 5,
        });
      }
    }
  }

  // ── Components ─────────────────────────────────────────────────────────────
  const compIssues = report.issues.filter(i => i.dimension === "component");
  for (const issue of compIssues) {
    if (issue.severity === "high") {
      // Extract component type from description: 'Global component "nav_bar" present in source...'
      const match = issue.description.match(/"([^"]+)"/);
      if (match) {
        const affectedPages = issue.pageId === "global"
          ? report.pages.filter(p => p.componentScore < 70).map(p => p.pageId)
          : [issue.pageId];
        adjustments.push({
          kind: "component",
          action: "add_global",
          component: match[1]!,
          pageIds: affectedPages,
          confidence: 0.92,
          priority: 10,
        });
      }
    }
  }

  // ── Spacing ────────────────────────────────────────────────────────────────
  const spacingIssues = report.issues.filter(i => i.dimension === "spacing");
  if (spacingIssues.length > 0 && report.global.spacingScore < 80) {
    const gapIssue = spacingIssues.find(i => i.description.includes("Section gap"));
    if (gapIssue) {
      adjustments.push({
        kind: "spacing",
        action: "override_section_gap",
        sectionGap: gapIssue.sourceValue,
        confidence: 0.82,
        priority: 6,
      });
    }
    const scaleIssue = spacingIssues.find(i => i.description.includes("Spacing scale"));
    if (scaleIssue) {
      const scale = scaleIssue.sourceValue.split(",").map(s => s.trim()).filter(Boolean);
      if (scale.length > 0) {
        adjustments.push({
          kind: "spacing",
          action: "override_scale",
          scale,
          confidence: 0.78,
          priority: 5,
        });
      }
    }
  }

  // ── Typography ─────────────────────────────────────────────────────────────
  const typoIssues = report.issues.filter(i => i.dimension === "typography");
  if (typoIssues.length > 0 && report.global.typographyScore < 80) {
    const familyIssue = typoIssues.find(i => i.description.toLowerCase().includes("font famil"));
    if (familyIssue) {
      const families = familyIssue.sourceValue.split(",").map(s => s.trim()).filter(Boolean);
      if (families.length > 0) {
        adjustments.push({
          kind: "typography",
          action: "override_families",
          families,
          confidence: 0.88,
          priority: 7,
        });
      }
    }
    const sizeIssue = typoIssues.find(i => i.description.toLowerCase().includes("size scale"));
    if (sizeIssue) {
      const sizeScale = sizeIssue.sourceValue.split(",").map(s => s.trim()).filter(Boolean);
      if (sizeScale.length > 0) {
        adjustments.push({
          kind: "typography",
          action: "override_size_scale",
          sizeScale,
          confidence: 0.75,
          priority: 4,
        });
      }
    }
  }

  // ── Decay confidence over iterations (to avoid thrashing) ─────────────────
  const decayFactor = Math.max(0.60, 1 - (iteration - 1) * 0.08);
  for (const adj of adjustments) {
    adj.confidence = Math.round(adj.confidence * decayFactor * 100) / 100;
  }

  // Sort by priority descending
  return adjustments.sort((a, b) => b.priority - a.priority);
}

/** Human-readable descriptions for the iteration record */
function describeAdjustments(adjustments: RuleAdjustment[]): string[] {
  return adjustments.map(adj => {
    switch (adj.kind) {
      case "color":
        return `Override ${adj.field} palette with ${adj.sourceColors.slice(0, 3).join(", ")} (conf ${Math.round(adj.confidence * 100)}%)`;
      case "layout":
        if (adj.action === "reorder_sections") return `Reorder sections: ${adj.canonicalOrder.slice(0, 5).join(" → ")} (conf ${Math.round(adj.confidence * 100)}%)`;
        if (adj.action === "fix_nav_placement") return `Fix nav placement → ${adj.navPlacement ?? "top-static"} (conf ${Math.round(adj.confidence * 100)}%)`;
        if (adj.action === "adjust_grid") return `Set grid columns to ${adj.gridColumns ?? 3} (conf ${Math.round(adj.confidence * 100)}%)`;
        return `Layout adjustment: ${adj.action}`;
      case "component":
        return `${adj.action === "add_global" ? "Add" : "Fix"} global component "${adj.component}" on ${adj.pageIds.length} page(s) (conf ${Math.round(adj.confidence * 100)}%)`;
      case "spacing":
        if (adj.action === "override_section_gap") return `Set section gap to ${adj.sectionGap ?? "32px"} (conf ${Math.round(adj.confidence * 100)}%)`;
        return `Override spacing scale (${(adj.scale ?? []).slice(0, 4).join(", ")}) (conf ${Math.round(adj.confidence * 100)}%)`;
      case "typography":
        if (adj.action === "override_families") return `Set fonts to ${(adj.families ?? []).slice(0, 2).join(", ")} (conf ${Math.round(adj.confidence * 100)}%)`;
        return `Override ${adj.action.replace("override_", "")} (conf ${Math.round(adj.confidence * 100)}%)`;
    }
  });
}

// ---------------------------------------------------------------------------
// Grade helper
// ---------------------------------------------------------------------------

function gradeScore(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

// ---------------------------------------------------------------------------
// R2 persistence helpers
// ---------------------------------------------------------------------------

async function persistJSON(key: string, data: unknown): Promise<string | null> {
  const cloud = getDefaultCloudProvider();
  if (!cloud.isConfigured()) return null;
  const body = Buffer.from(JSON.stringify(data, null, 2), "utf8");
  try {
    await cloud.upload({ key, data: body, contentType: "application/json", checkDuplicate: false });
    return key;
  } catch (err) {
    logger.warn({ err, key }, "VR8: R2 upload failed");
    return null;
  }
}

async function writeDisk(dir: string, filename: string, data: unknown): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), JSON.stringify(data, null, 2));
  } catch (err) {
    logger.warn({ err, dir, filename }, "VR8: disk write failed");
  }
}

// ---------------------------------------------------------------------------
// Generation step — POST to generationEndpoint
// ---------------------------------------------------------------------------

interface GenerationResponse {
  generatedJobId: string;
  [key: string]: unknown;
}

async function callGenerationEndpoint(
  endpoint: string,
  payload: Record<string, unknown>,
): Promise<GenerationResponse> {
  const { default: http }  = await import("http");
  const { default: https } = await import("https");

  return new Promise<GenerationResponse>((resolve, reject) => {
    let url: URL;
    try { url = new URL(endpoint); } catch {
      reject(new Error(`Invalid generation endpoint URL: ${endpoint}`));
      return;
    }

    const body = JSON.stringify(payload);
    const options = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === "https:" ? 443 : 80),
      path:     url.pathname + url.search,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout:  120_000,
    };

    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Generation endpoint returned ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(data) as GenerationResponse;
          if (!parsed.generatedJobId) {
            reject(new Error(`Generation response missing generatedJobId: ${data.slice(0, 200)}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Generation response not valid JSON: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on("timeout", () => { req.destroy(); reject(new Error("Generation endpoint timed out")); });
    req.on("error", (err: Error) => reject(err));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Score a generated job (VR-7 fidelity)
// ---------------------------------------------------------------------------

async function scoreFidelity(
  sourceJobId: string,
  generatedJobId: string,
  force = false,
): Promise<FidelityReport> {
  // Use cached if available
  const cached = getCachedFidelityReport(sourceJobId, generatedJobId);
  if (cached && !force) return cached;
  return runFidelityScoringVR7({ sourceJobId, generatedJobId, force });
}

// ---------------------------------------------------------------------------
// Persist intermediate state to disk after each iteration
// ---------------------------------------------------------------------------

async function persistLoopState(state: LoopState): Promise<void> {
  const dir = join("/tmp/vr8", state.sourceJobId);
  await writeDisk(dir, "reconstruction-iterations.json", state.iterations);
  await writeDisk(dir, "loop-state.json", {
    sourceJobId:       state.sourceJobId,
    status:            state.status,
    currentIteration:  state.currentIteration,
    targetScore:       state.targetScore,
    maxIterations:     state.maxIterations,
    currentScore:      state.currentScore,
    bestScore:         state.bestScore,
    bestIteration:     state.bestIteration,
    stoppingCondition: state.stoppingCondition,
    startedAt:         state.startedAt,
    completedAt:       state.completedAt,
  });
}

// ---------------------------------------------------------------------------
// Build final report
// ---------------------------------------------------------------------------

async function buildFinalReport(state: LoopState, startMs: number): Promise<ReconstructionReport> {
  const initialScore = state.iterations[0]?.scoreBefore ?? state.currentScore;
  const finalScore   = state.currentScore;

  // Tally adjustments
  const byKind: Record<RuleAdjustment["kind"], number> = {
    color: 0, layout: 0, component: 0, spacing: 0, typography: 0,
  };
  const allDescriptions: string[] = [];
  for (const iter of state.iterations) {
    for (const adj of iter.adjustments) byKind[adj.kind]++;
    allDescriptions.push(...iter.improvementsApplied);
  }

  // Most impactful = improvements from the iteration with the biggest delta
  const bestIter = state.iterations.reduce(
    (best, cur) => cur.delta > (best?.delta ?? -Infinity) ? cur : best,
    state.iterations[0]!,
  );
  const mostImpactful = bestIter?.improvementsApplied.slice(0, 3) ?? [];

  const report: ReconstructionReport = {
    schemaVersion: "VR-8",
    sourceJobId:   state.sourceJobId,
    generatedAt:   new Date().toISOString(),
    durationMs:    Date.now() - startMs,
    status:        state.status,
    stoppingCondition: state.stoppingCondition,
    config: {
      targetScore:       state.targetScore,
      maxIterations:     state.maxIterations,
      maxPlateauRounds:  state.maxPlateauRounds,
      generationEndpoint: state.generationEndpoint,
    },
    result: {
      iterationsRun: state.iterations.length,
      initialScore,
      finalScore,
      bestScore:     state.bestScore,
      bestIteration: state.bestIteration,
      totalDelta:    finalScore - initialScore,
      targetReached: finalScore >= state.targetScore,
      grade:         gradeScore(finalScore),
    },
    iterations: state.iterations,
    adjustmentSummary: {
      totalApplied:  state.iterations.reduce((s, it) => s + it.adjustments.length, 0),
      byKind,
      mostImpactful,
    },
  };

  // Persist
  const dir = join("/tmp/vr8", state.sourceJobId);
  await writeDisk(dir, "reconstruction-report.json", report);

  const base = `jobs/${state.sourceJobId}/reconstruction-loop`;
  const [iterKey, reportKey] = await Promise.all([
    persistJSON(`${base}/reconstruction-iterations.json`, state.iterations),
    persistJSON(`${base}/reconstruction-report.json`,     report),
  ]);
  if (iterKey)   report.r2IterationsKey = iterKey;
  if (reportKey) report.r2ReportKey     = reportKey;

  return report;
}

// ---------------------------------------------------------------------------
// Main loop (runs async in background)
// ---------------------------------------------------------------------------

async function runLoop(state: LoopState, startMs: number): Promise<void> {
  const { sourceJobId } = state;

  logger.info({ sourceJobId, targetScore: state.targetScore, maxIterations: state.maxIterations },
    "VR8: loop started");

  // ── Iteration 0 — score the baseline generation if generatedJobId already provided ──
  // (The first call will be iteration 1 — we measure scoreBefore from initialScore param)

  let consecutivePlateau = 0;

  while (true) {
    // ── Check stop flag ──────────────────────────────────────────────────────
    if (_stopFlags.has(sourceJobId)) {
      _stopFlags.delete(sourceJobId);
      state.status            = "completed";
      state.stoppingCondition = "manual_stop";
      state.completedAt       = new Date().toISOString();
      logger.info({ sourceJobId, iteration: state.currentIteration }, "VR8: manual stop requested");
      break;
    }

    // ── Check max iterations ─────────────────────────────────────────────────
    if (state.currentIteration > state.maxIterations) {
      state.status            = "completed";
      state.stoppingCondition = "max_iterations";
      state.completedAt       = new Date().toISOString();
      logger.info({ sourceJobId }, "VR8: max iterations reached");
      break;
    }

    // ── Check if target already met ──────────────────────────────────────────
    if (state.currentScore >= state.targetScore && state.currentIteration > 1) {
      state.status            = "completed";
      state.stoppingCondition = "target_reached";
      state.completedAt       = new Date().toISOString();
      logger.info({ sourceJobId, score: state.currentScore }, "VR8: target score reached");
      break;
    }

    const iterStart    = Date.now();
    const scoreBefore  = state.currentScore;
    const iterNum      = state.currentIteration;

    logger.info({ sourceJobId, iteration: iterNum, scoreBefore }, "VR8: starting iteration");

    // ── Step 1: Call generation endpoint ────────────────────────────────────
    let generatedJobId: string;
    try {
      const payload: Record<string, unknown> = {
        sourceJobId,
        iterationNumber:    iterNum,
        adjustments:        state.currentAdjustments,
        targetScore:        state.targetScore,
        currentScore:       scoreBefore,
      };
      const genResp = await callGenerationEndpoint(state.generationEndpoint, payload);
      generatedJobId = genResp.generatedJobId;
      logger.info({ sourceJobId, iterNum, generatedJobId }, "VR8: generation complete");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ sourceJobId, iterNum, err }, "VR8: generation failed");
      state.status            = "failed";
      state.stoppingCondition = "generation_error";
      state.lastError         = msg;
      state.completedAt       = new Date().toISOString();
      break;
    }

    // ── Step 2: Run VR-7 fidelity scoring ───────────────────────────────────
    let fidelity: FidelityReport;
    try {
      fidelity = await scoreFidelity(sourceJobId, generatedJobId, true);
    } catch (err) {
      logger.error({ sourceJobId, iterNum, err }, "VR8: fidelity scoring failed — treating as plateau");
      fidelity = await scoreFidelity(sourceJobId, generatedJobId, false).catch(() => ({
        global: { totalScore: scoreBefore, layoutScore: 0, colorScore: 0, spacingScore: 0, typographyScore: 0, componentScore: 0, grade: "F" as const },
        issues: [],
        pages:  [],
        scoreFile: [],
      } as unknown as FidelityReport));
    }

    const scoreAfter = fidelity.global.totalScore;
    const delta      = scoreAfter - scoreBefore;

    // ── Step 3: Update best score ────────────────────────────────────────────
    if (scoreAfter > state.bestScore) {
      state.bestScore     = scoreAfter;
      state.bestIteration = iterNum;
    }
    state.currentScore = scoreAfter;

    // ── Step 4: Check plateau ────────────────────────────────────────────────
    if (delta <= 0) {
      consecutivePlateau++;
    } else {
      consecutivePlateau = 0;
    }

    // ── Step 5: Derive adjustments for next iteration ────────────────────────
    const adjustments         = deriveAdjustments(fidelity, iterNum);
    state.currentAdjustments  = adjustments;

    // ── Step 6: Build iteration record ──────────────────────────────────────
    const record: IterationRecord = {
      iterationNumber:     iterNum,
      generatedJobId,
      scoreBefore,
      scoreAfter,
      delta,
      grade:               fidelity.global.grade ?? gradeScore(scoreAfter),
      improvementsApplied: describeAdjustments(adjustments),
      adjustments,
      issuesBefore:        state.iterations[state.iterations.length - 1]?.issuesAfter ?? fidelity.issues.length + 5,
      issuesAfter:         fidelity.issues.length,
      durationMs:          Date.now() - iterStart,
      timestamp:           new Date().toISOString(),
      fidelityDimensions: {
        layout:     fidelity.global.layoutScore,
        color:      fidelity.global.colorScore,
        spacing:    fidelity.global.spacingScore,
        typography: fidelity.global.typographyScore,
        component:  fidelity.global.componentScore,
      },
    };

    state.iterations.push(record);
    state.currentIteration++;

    logger.info({
      sourceJobId, iterNum, scoreBefore, scoreAfter, delta,
      grade: record.grade, adjustmentsGenerated: adjustments.length,
    }, "VR8: iteration complete");

    // ── Persist state after each iteration ───────────────────────────────────
    await persistLoopState(state);

    // ── Check plateau stop ───────────────────────────────────────────────────
    if (consecutivePlateau >= state.maxPlateauRounds) {
      state.status            = "completed";
      state.stoppingCondition = "plateau";
      state.completedAt       = new Date().toISOString();
      logger.info({ sourceJobId, consecutivePlateau }, "VR8: plateau detected — stopping");
      break;
    }

    // ── Check target met after scoring ───────────────────────────────────────
    if (scoreAfter >= state.targetScore) {
      state.status            = "completed";
      state.stoppingCondition = "target_reached";
      state.completedAt       = new Date().toISOString();
      logger.info({ sourceJobId, scoreAfter, targetScore: state.targetScore }, "VR8: target reached");
      break;
    }
  }

  // ── Finalize ───────────────────────────────────────────────────────────────
  if (!state.completedAt) {
    state.status      = "completed";
    state.completedAt = new Date().toISOString();
  }

  try {
    const report = await buildFinalReport(state, startMs);
    _reports.set(sourceJobId, report);
    logger.info({
      sourceJobId,
      stoppingCondition: state.stoppingCondition,
      finalScore:        state.currentScore,
      iterationsRun:     state.iterations.length,
    }, "VR8: loop complete");
  } catch (err) {
    logger.error({ sourceJobId, err }, "VR8: final report build failed");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface VR8StartInput {
  sourceJobId:         string;
  generationEndpoint:  string;
  targetScore?:        number;   // default 75
  maxIterations?:      number;   // default 5
  maxPlateauRounds?:   number;   // default 2
  initialScore?:       number;   // seed score (from previous VR-7 run)
  initialGeneratedJobId?: string; // if first comparison already done
}

export function startReconstructionLoop(input: VR8StartInput): LoopState {
  const {
    sourceJobId,
    generationEndpoint,
    targetScore     = 75,
    maxIterations   = 5,
    maxPlateauRounds = 2,
    initialScore    = 0,
  } = input;

  // Only one active loop per sourceJobId
  const existing = _loops.get(sourceJobId);
  if (existing && existing.status === "running") {
    return existing;
  }

  const state: LoopState = {
    sourceJobId,
    status:            "running",
    currentIteration:  1,
    targetScore,
    maxIterations,
    plateauRounds:     0,
    maxPlateauRounds,
    stoppingCondition: null,
    startedAt:         new Date().toISOString(),
    completedAt:       null,
    currentScore:      initialScore,
    bestScore:         initialScore,
    bestIteration:     0,
    iterations:        [],
    currentAdjustments: [],
    generationEndpoint,
    lastError:         null,
  };

  _loops.set(sourceJobId, state);
  _stopFlags.delete(sourceJobId);

  // Start background loop (do not await)
  const startMs = Date.now();
  void runLoop(state, startMs).catch(err => {
    logger.error({ sourceJobId, err }, "VR8: unhandled loop error");
    state.status    = "failed";
    state.lastError = err instanceof Error ? err.message : String(err);
    state.completedAt = new Date().toISOString();
  });

  return state;
}

// ---------------------------------------------------------------------------
// Reload from disk (for server restarts)
// ---------------------------------------------------------------------------

export async function loadLoopStateFromDisk(sourceJobId: string): Promise<LoopState | null> {
  const dir = join("/tmp/vr8", sourceJobId);
  try {
    const raw = await readFile(join(dir, "loop-state.json"), "utf8");
    const saved = JSON.parse(raw) as Partial<LoopState>;
    const itersRaw = await readFile(join(dir, "reconstruction-iterations.json"), "utf8").catch(() => "[]");
    const iterations = JSON.parse(itersRaw) as IterationRecord[];
    const state: LoopState = {
      sourceJobId,
      status:            (saved.status as LoopStatus) ?? "completed",
      currentIteration:  saved.currentIteration ?? iterations.length + 1,
      targetScore:       saved.targetScore ?? 75,
      maxIterations:     saved.maxIterations ?? 5,
      plateauRounds:     0,
      maxPlateauRounds:  saved.maxPlateauRounds ?? 2,
      stoppingCondition: (saved.stoppingCondition as StoppingCondition) ?? null,
      startedAt:         saved.startedAt ?? new Date().toISOString(),
      completedAt:       saved.completedAt ?? null,
      currentScore:      saved.currentScore ?? 0,
      bestScore:         saved.bestScore ?? 0,
      bestIteration:     saved.bestIteration ?? 0,
      iterations,
      currentAdjustments: [],
      generationEndpoint: saved.generationEndpoint ?? "",
      lastError:          saved.lastError ?? null,
    };
    _loops.set(sourceJobId, state);
    return state;
  } catch {
    return null;
  }
}
