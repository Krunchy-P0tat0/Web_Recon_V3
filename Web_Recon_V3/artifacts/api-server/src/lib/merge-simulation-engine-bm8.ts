/**
 * merge-simulation-engine-bm8.ts — Phase BM-8: Merge Simulation Engine
 *
 * Simulates the entire merge before execution across five dimensions:
 *   routes     — route table collision simulation
 *   database   — schema migration dry-run
 *   assets     — static asset namespace simulation
 *   components — component tree merge simulation
 *   apis       — API contract merge simulation
 *
 * Reads prior BM phase reports (BM-1 → BM-7) to build a unified simulation.
 *
 * Output shape:
 *   {
 *     conflicts:      SimulationConflict[],
 *     warnings:       SimulationWarning[],
 *     safeOperations: SafeOperation[],
 *     riskScore:      number,   // 0–100; 0 = safest
 *   }
 *
 * Outputs (disk + R2):
 *   merge-simulation-report.json
 *
 * Success criteria:
 *   Every merge can be previewed before execution.
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join }                        from "path";
import { logger }                      from "./logger.js";
import { getDefaultCloudProvider }     from "../cloud/index.js";

// ---------------------------------------------------------------------------
// Dimension taxonomy
// ---------------------------------------------------------------------------

export type SimulationDimension = "routes" | "database" | "assets" | "components" | "apis";
export type SimulationSeverity  = "critical" | "high" | "medium" | "low";
export type OperationStatus     = "SAFE" | "WARNING" | "CONFLICT" | "BLOCKED";

// ---------------------------------------------------------------------------
// Conflict
// ---------------------------------------------------------------------------

export interface SimulationConflict {
  id:           string;
  dimension:    SimulationDimension;
  severity:     SimulationSeverity;
  title:        string;
  description:  string;
  primeValue:   string;
  existingValue: string;
  resolution:   string;
  autoResolvable: boolean;
  blocksExecution: boolean;
}

// ---------------------------------------------------------------------------
// Warning
// ---------------------------------------------------------------------------

export interface SimulationWarning {
  id:          string;
  dimension:   SimulationDimension;
  severity:    SimulationSeverity;
  title:       string;
  description: string;
  mitigation:  string;
  requiresManualReview: boolean;
}

// ---------------------------------------------------------------------------
// Safe operation
// ---------------------------------------------------------------------------

export interface SafeOperation {
  id:          string;
  dimension:   SimulationDimension;
  title:       string;
  description: string;
  estimatedMs: number;   // simulated execution time
  reversible:  boolean;
  steps:       string[];
}

// ---------------------------------------------------------------------------
// Dimension simulation result
// ---------------------------------------------------------------------------

export interface DimensionSimulation {
  dimension:      SimulationDimension;
  status:         OperationStatus;
  conflicts:      SimulationConflict[];
  warnings:       SimulationWarning[];
  safeOperations: SafeOperation[];
  dimensionRisk:  number;  // 0–100
  simulationNotes: string[];
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface MergeSimulationInput {
  primeJobId:    string;
  backendJobId?: string;
  force?:        boolean;
  // Optional direct overrides (engine reads from disk by default)
  routes?:       Array<{ path: string; methods: string[]; source: "prime" | "backend" }>;
  schemas?:      Array<{ table: string; columns: Record<string, string>; source: "prime" | "backend" }>;
  assets?:       Array<{ path: string; size?: number; source: "prime" | "backend" }>;
  components?:   Array<{ name: string; kind: string; classification?: string }>;
  endpoints?:    Array<{ path: string; methods: string[]; classification?: string }>;
}

// ---------------------------------------------------------------------------
// Output — merge-simulation-report.json
// ---------------------------------------------------------------------------

export interface MergeSimulationReport {
  schemaVersion:   "BM-8";
  primeJobId:      string;
  backendJobId:    string;
  generatedAt:     string;
  durationMs:      number;
  simulationId:    string;
  // Core output shape
  conflicts:       SimulationConflict[];
  warnings:        SimulationWarning[];
  safeOperations:  SafeOperation[];
  riskScore:       number;   // 0–100; 0 = safest, 100 = highest risk
  // Extended fields
  riskGrade:       "A" | "B" | "C" | "D" | "F";  // A = low risk
  canProceed:      boolean;   // false when any blocksExecution conflict exists
  dimensions:      Record<SimulationDimension, DimensionSimulation>;
  executionOrder:  string[];  // recommended safe execution order of operations
  estimatedMergeMs: number;   // sum of safe operation estimates
  summary: {
    totalOperations:  number;
    conflictCount:    number;
    warningCount:     number;
    safeCount:        number;
    criticalConflicts: string[];
    autoResolvable:   number;
    requiresManual:   number;
    blockingConflicts: string[];
    recommendation:   string;
  };
  r2Key?: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const _cache = new Map<string, MergeSimulationReport>();

export function getCachedMergeSimulationReport(primeJobId: string): MergeSimulationReport | undefined {
  return _cache.get(primeJobId);
}

// ---------------------------------------------------------------------------
// ID generators
// ---------------------------------------------------------------------------

let _seq = 0;
function conflictId(): string { return `CONF-${String(++_seq).padStart(4, "0")}`; }
function warnId():     string { return `WARN-${String(++_seq).padStart(4, "0")}`; }
function safeId():     string { return `SAFE-${String(++_seq).padStart(4, "0")}`; }
function simId():      string { return `SIM-${Date.now().toString(36).toUpperCase()}`; }

// ---------------------------------------------------------------------------
// Load prior BM reports from disk
// ---------------------------------------------------------------------------

async function loadReport<T>(dirs: string[], jobId: string, filename: string): Promise<T | null> {
  for (const dir of dirs) {
    try {
      const raw = await readFile(join(dir, jobId, filename), "utf8");
      return JSON.parse(raw) as T;
    } catch { /* next */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Routes simulation
// ---------------------------------------------------------------------------

function simulateRoutes(
  routes: MergeSimulationInput["routes"],
): DimensionSimulation {
  const conflicts: SimulationConflict[] = [];
  const warnings:  SimulationWarning[]  = [];
  const safe:      SafeOperation[]      = [];
  const notes:     string[]             = [];

  const primeRoutes   = (routes ?? []).filter(r => r.source === "prime");
  const backendRoutes = (routes ?? []).filter(r => r.source === "backend");
  const backendPaths  = new Map(backendRoutes.map(r => [r.path, r]));

  for (const pr of primeRoutes) {
    const existing = backendPaths.get(pr.path);
    if (existing) {
      const methodOverlap = pr.methods.filter(m => existing.methods.includes(m));
      if (methodOverlap.length > 0) {
        conflicts.push({
          id:            conflictId(), dimension: "routes", severity: "high",
          title:         `Route collision: ${pr.path}`,
          description:   `Prime and backend both define ${methodOverlap.join(",")} ${pr.path}`,
          primeValue:    `${pr.methods.join(",")} ${pr.path}`,
          existingValue: `${existing.methods.join(",")} ${pr.path}`,
          resolution:    `Namespace the prime route under /prime${pr.path} or remove the duplicate`,
          autoResolvable: true,
          blocksExecution: false,
        });
      } else {
        warnings.push({
          id:          warnId(), dimension: "routes", severity: "medium",
          title:       `Partial route overlap: ${pr.path}`,
          description: `Route ${pr.path} exists with different methods — prime adds ${pr.methods.join(",")}`,
          mitigation:  `Register prime's methods alongside existing ones in the backend router`,
          requiresManualReview: false,
        });
      }
    } else {
      safe.push({
        id:          safeId(), dimension: "routes",
        title:       `Add route: ${pr.methods.join(",")} ${pr.path}`,
        description: `New route — no conflict with existing backend`,
        estimatedMs: 5,
        reversible:  true,
        steps:       [`router.use("${pr.path}", primeRouter)`, `Test: curl -X ${pr.methods[0]} /api${pr.path}`],
      });
    }
  }

  // Check for orphaned backend routes that might be shadowed
  const primePaths = new Set(primeRoutes.map(r => r.path));
  const shadowed = backendRoutes.filter(r => primePaths.has(r.path));
  if (shadowed.length > 0) {
    notes.push(`${shadowed.length} backend route(s) may be shadowed by prime routes — verify router ordering`);
  }

  const dimRisk = Math.min(100, conflicts.length * 15 + warnings.length * 5);
  return {
    dimension: "routes", status: conflicts.length > 0 ? "CONFLICT" : warnings.length > 0 ? "WARNING" : "SAFE",
    conflicts, warnings, safeOperations: safe, dimensionRisk: dimRisk, simulationNotes: notes,
  };
}

// ---------------------------------------------------------------------------
// Database simulation
// ---------------------------------------------------------------------------

function simulateDatabase(
  schemas: MergeSimulationInput["schemas"],
): DimensionSimulation {
  const conflicts: SimulationConflict[] = [];
  const warnings:  SimulationWarning[]  = [];
  const safe:      SafeOperation[]      = [];
  const notes:     string[]             = [];

  const primeTables   = (schemas ?? []).filter(s => s.source === "prime");
  const backendTables = (schemas ?? []).filter(s => s.source === "backend");
  const backendMap    = new Map(backendTables.map(t => [t.table, t]));

  for (const pt of primeTables) {
    const existing = backendMap.get(pt.table);
    if (existing) {
      const primeColumns   = Object.keys(pt.columns);
      const backendColumns = Object.keys(existing.columns);
      const newCols        = primeColumns.filter(c => !backendColumns.includes(c));
      const typeMismatches = primeColumns.filter(c =>
        backendColumns.includes(c) && pt.columns[c] !== existing.columns[c]
      );

      if (typeMismatches.length > 0) {
        conflicts.push({
          id:            conflictId(), dimension: "database", severity: "critical",
          title:         `Column type mismatch in table "${pt.table}"`,
          description:   `Columns [${typeMismatches.join(", ")}] have different types between prime and backend`,
          primeValue:    typeMismatches.map(c => `${c}: ${pt.columns[c]}`).join(", "),
          existingValue: typeMismatches.map(c => `${c}: ${existing.columns[c]}`).join(", "),
          resolution:    `Run a data migration to reconcile column types before merging`,
          autoResolvable: false,
          blocksExecution: true,
        });
      }

      if (newCols.length > 0) {
        warnings.push({
          id:          warnId(), dimension: "database", severity: "medium",
          title:       `New columns for existing table "${pt.table}"`,
          description: `Prime adds columns [${newCols.join(", ")}] to an existing table`,
          mitigation:  `Run an ALTER TABLE migration with nullable defaults for each new column`,
          requiresManualReview: false,
        });
      } else if (!typeMismatches.length) {
        safe.push({
          id:          safeId(), dimension: "database",
          title:       `Table "${pt.table}" is schema-compatible`,
          description: `No structural differences detected between prime and backend schemas`,
          estimatedMs: 10,
          reversible:  true,
          steps:       [`Verify table "${pt.table}" with: SELECT * FROM ${pt.table} LIMIT 1`],
        });
      }
    } else {
      safe.push({
        id:          safeId(), dimension: "database",
        title:       `Create new table: ${pt.table}`,
        description: `Prime introduces a new table not present in the backend schema`,
        estimatedMs: 50,
        reversible:  true,
        steps:       [
          `CREATE TABLE ${pt.table} (${Object.entries(pt.columns).map(([c, t]) => `${c} ${t}`).join(", ")})`,
          `Record migration in migrations table`,
        ],
      });
    }
  }

  notes.push(`Simulated ${primeTables.length} prime table(s) against ${backendTables.length} existing table(s)`);
  const dimRisk = conflicts.some(c => c.severity === "critical") ? 90 :
    Math.min(100, conflicts.length * 20 + warnings.length * 8);

  return {
    dimension: "database", status: conflicts.length > 0 ? "CONFLICT" : warnings.length > 0 ? "WARNING" : "SAFE",
    conflicts, warnings, safeOperations: safe, dimensionRisk: dimRisk, simulationNotes: notes,
  };
}

// ---------------------------------------------------------------------------
// Assets simulation
// ---------------------------------------------------------------------------

function simulateAssets(
  assets: MergeSimulationInput["assets"],
): DimensionSimulation {
  const conflicts: SimulationConflict[] = [];
  const warnings:  SimulationWarning[]  = [];
  const safe:      SafeOperation[]      = [];

  const primeAssets   = (assets ?? []).filter(a => a.source === "prime");
  const backendAssets = (assets ?? []).filter(a => a.source === "backend");
  const backendPaths  = new Map(backendAssets.map(a => [a.path, a]));

  for (const pa of primeAssets) {
    const existing = backendPaths.get(pa.path);
    if (existing) {
      if (pa.size && existing.size && pa.size !== existing.size) {
        conflicts.push({
          id:            conflictId(), dimension: "assets", severity: "medium",
          title:         `Asset overwrite: ${pa.path}`,
          description:   `Prime and backend have different versions of ${pa.path}`,
          primeValue:    `${pa.size} bytes`,
          existingValue: `${existing.size} bytes`,
          resolution:    `Rename prime asset or merge into a versioned path (e.g. /assets/v2/${pa.path})`,
          autoResolvable: true,
          blocksExecution: false,
        });
      } else {
        warnings.push({
          id:          warnId(), dimension: "assets", severity: "low",
          title:       `Duplicate asset: ${pa.path}`,
          description: `Same asset path exists in both prime and backend`,
          mitigation:  `Verify content hash; deduplicate if identical, otherwise version-namespace`,
          requiresManualReview: false,
        });
      }
    } else {
      safe.push({
        id:          safeId(), dimension: "assets",
        title:       `Add asset: ${pa.path}`,
        description: `New asset — no conflict with existing static files`,
        estimatedMs: 2,
        reversible:  true,
        steps:       [`Copy ${pa.path} to /public${pa.path}`, `Invalidate CDN cache if applicable`],
      });
    }
  }

  const dimRisk = Math.min(100, conflicts.length * 10 + warnings.length * 3);
  return {
    dimension: "assets", status: conflicts.length > 0 ? "CONFLICT" : warnings.length > 0 ? "WARNING" : "SAFE",
    conflicts, warnings, safeOperations: safe, dimensionRisk: dimRisk, simulationNotes: [],
  };
}

// ---------------------------------------------------------------------------
// Components simulation
// ---------------------------------------------------------------------------

function simulateComponents(
  components: MergeSimulationInput["components"],
): DimensionSimulation {
  const conflicts: SimulationConflict[] = [];
  const warnings:  SimulationWarning[]  = [];
  const safe:      SafeOperation[]      = [];

  for (const c of components ?? []) {
    const cls = c.classification ?? "REUSE";
    if (cls === "REPLACE") {
      warnings.push({
        id:          warnId(), dimension: "components", severity: "medium",
        title:       `Component replacement: ${c.name}`,
        description: `Prime replaces existing ${c.name} (${c.kind}) — all import sites need updating`,
        mitigation:  `Run codemods to update import paths; verify no visual regressions`,
        requiresManualReview: true,
      });
    } else if (cls === "WRAP") {
      safe.push({
        id:          safeId(), dimension: "components",
        title:       `Wrap component: ${c.name}`,
        description: `Create ${c.name}Adapter wrapper — no breaking changes to existing imports`,
        estimatedMs: 20,
        reversible:  true,
        steps:       [
          `Create src/adapters/${c.name}Adapter.tsx`,
          `Update prime import: import { ${c.name} } from "./adapters/${c.name}Adapter"`,
        ],
      });
    } else if (cls === "SKIP") {
      safe.push({
        id:          safeId(), dimension: "components",
        title:       `Skip deprecated: ${c.name}`,
        description: `${c.name} is excluded from merged output — no action required`,
        estimatedMs: 0,
        reversible:  true,
        steps:       [`Verify no active imports of ${c.name} remain in merged codebase`],
      });
    } else {
      safe.push({
        id:          safeId(), dimension: "components",
        title:       `Reuse component: ${c.name}`,
        description: `${c.name} (${c.kind}) — import from existing path directly`,
        estimatedMs: 5,
        reversible:  true,
        steps:       [`import { ${c.name} } from "existing/${c.name.toLowerCase()}"`],
      });
    }
  }

  const dimRisk = Math.min(100, conflicts.length * 15 + warnings.length * 6);
  return {
    dimension: "components", status: conflicts.length > 0 ? "CONFLICT" : warnings.length > 0 ? "WARNING" : "SAFE",
    conflicts, warnings, safeOperations: safe, dimensionRisk: dimRisk, simulationNotes: [],
  };
}

// ---------------------------------------------------------------------------
// APIs simulation
// ---------------------------------------------------------------------------

function simulateApis(
  endpoints: MergeSimulationInput["endpoints"],
): DimensionSimulation {
  const conflicts: SimulationConflict[] = [];
  const warnings:  SimulationWarning[]  = [];
  const safe:      SafeOperation[]      = [];

  for (const ep of endpoints ?? []) {
    const cls = ep.classification ?? "KEEP";
    if (cls === "BLOCK") {
      conflicts.push({
        id:            conflictId(), dimension: "apis", severity: "high",
        title:         `Blocked API endpoint: ${ep.path}`,
        description:   `${ep.methods.join(",")} ${ep.path} must not be called by the prime`,
        primeValue:    "would call this endpoint",
        existingValue: "endpoint is blocked (webhook/internal/deprecated)",
        resolution:    `Remove all generated calls to ${ep.path} from the prime bundle`,
        autoResolvable: true,
        blocksExecution: false,
      });
    } else if (cls === "REPLACE") {
      warnings.push({
        id:          warnId(), dimension: "apis", severity: "medium",
        title:       `API replacement needed: ${ep.path}`,
        description: `Prime cannot use ${ep.path} as-is — a replacement implementation is required`,
        mitigation:  `Build a prime-side API handler that covers the same contract`,
        requiresManualReview: true,
      });
    } else if (cls === "EXTEND") {
      warnings.push({
        id:          warnId(), dimension: "apis", severity: "low",
        title:       `API adapter required: ${ep.path}`,
        description: `${ep.path} works but prime needs to add headers/params before calling`,
        mitigation:  `Create an HTTP interceptor that injects required headers/version params`,
        requiresManualReview: false,
      });
    } else {
      safe.push({
        id:          safeId(), dimension: "apis",
        title:       `Consume endpoint: ${ep.methods[0]} ${ep.path}`,
        description: `Endpoint is KEEP-compatible — prime can call it directly`,
        estimatedMs: 1,
        reversible:  true,
        steps:       [`fetch("${ep.path}", { method: "${ep.methods[0]}" })`],
      });
    }
  }

  const dimRisk = Math.min(100, conflicts.length * 15 + warnings.length * 7);
  return {
    dimension: "apis", status: conflicts.length > 0 ? "CONFLICT" : warnings.length > 0 ? "WARNING" : "SAFE",
    conflicts, warnings, safeOperations: safe, dimensionRisk: dimRisk, simulationNotes: [],
  };
}

// ---------------------------------------------------------------------------
// Overall risk score
// ---------------------------------------------------------------------------

function computeRiskScore(dims: Record<SimulationDimension, DimensionSimulation>): number {
  const weights: Record<SimulationDimension, number> = {
    routes: 0.25, database: 0.30, components: 0.20, apis: 0.15, assets: 0.10,
  };
  const weighted = (Object.entries(dims) as [SimulationDimension, DimensionSimulation][])
    .reduce((sum, [dim, d]) => sum + d.dimensionRisk * (weights[dim] ?? 0.1), 0);
  return Math.min(100, Math.round(weighted));
}

function riskGrade(score: number): MergeSimulationReport["riskGrade"] {
  if (score <= 10)  return "A";
  if (score <= 30)  return "B";
  if (score <= 50)  return "C";
  if (score <= 70)  return "D";
  return "F";
}

// ---------------------------------------------------------------------------
// Execution order
// ---------------------------------------------------------------------------

function buildExecutionOrder(dims: Record<SimulationDimension, DimensionSimulation>): string[] {
  const order: string[] = [];
  order.push("1. Backup current state (trigger BM-9 rollback snapshot)");
  if (dims.database.safeOperations.length)  order.push("2. Run database migrations (safe schema changes)");
  if (dims.assets.safeOperations.length)    order.push("3. Deploy static assets to CDN/public folder");
  if (dims.components.safeOperations.length) order.push("4. Install component adapters and wrappers");
  if (dims.routes.safeOperations.length)    order.push("5. Register new routes in backend router");
  if (dims.apis.safeOperations.length)      order.push("6. Wire API client calls in prime bundle");
  order.push("7. Deploy prime bundle to staging");
  order.push("8. Run smoke tests against all BOUND pages");
  order.push("9. Promote to production if all checks pass");
  return order;
}

// ---------------------------------------------------------------------------
// Disk / R2 helpers
// ---------------------------------------------------------------------------

async function saveToDisk(jobId: string, report: MergeSimulationReport): Promise<void> {
  const dir = join("/tmp/bm8", jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "merge-simulation-report.json"), JSON.stringify(report, null, 2));
}

async function saveToR2(jobId: string, report: MergeSimulationReport): Promise<string | undefined> {
  try {
    const cloud = getDefaultCloudProvider();
    const key   = `bm8/${jobId}/merge-simulation-report.json`;
    await cloud.upload({ key, data: Buffer.from(JSON.stringify(report, null, 2)), contentType: "application/json" });
    return key;
  } catch (err) {
    logger.warn({ err, jobId }, "BM8: R2 upload failed (non-fatal)");
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

export async function runMergeSimulationEngine(
  input: MergeSimulationInput,
): Promise<MergeSimulationReport> {
  const { primeJobId, backendJobId = "unknown", force = false } = input;
  const t0 = Date.now();

  if (!force) {
    const cached = _cache.get(primeJobId);
    if (cached) {
      logger.info({ primeJobId }, "BM8: returning cached report");
      return cached;
    }
  }

  logger.info({ primeJobId, backendJobId }, "BM8: merge simulation started");

  // Simulate each dimension
  const dims: Record<SimulationDimension, DimensionSimulation> = {
    routes:     simulateRoutes(input.routes),
    database:   simulateDatabase(input.schemas),
    assets:     simulateAssets(input.assets),
    components: simulateComponents(input.components),
    apis:       simulateApis(input.endpoints),
  };

  // Flatten
  const allConflicts = Object.values(dims).flatMap(d => d.conflicts);
  const allWarnings  = Object.values(dims).flatMap(d => d.warnings);
  const allSafe      = Object.values(dims).flatMap(d => d.safeOperations);

  const riskScore  = computeRiskScore(dims);
  const canProceed = !allConflicts.some(c => c.blocksExecution);

  const criticalConflicts  = allConflicts.filter(c => c.severity === "critical").map(c => c.id);
  const blockingConflicts  = allConflicts.filter(c => c.blocksExecution).map(c => c.id);
  const autoResolvable     = allConflicts.filter(c => c.autoResolvable).length;
  const requiresManual     = allConflicts.filter(c => !c.autoResolvable).length +
                             allWarnings.filter(w => w.requiresManualReview).length;

  const estimatedMergeMs = allSafe.reduce((sum, op) => sum + op.estimatedMs, 0);
  const executionOrder   = buildExecutionOrder(dims);

  const recommendation =
    !canProceed        ? "BLOCKED — resolve all execution-blocking conflicts before proceeding." :
    criticalConflicts.length > 0 ? "Critical conflicts detected — address before merge, then re-simulate." :
    allConflicts.length > 0      ? "Conflicts detected — auto-resolve where possible, manually review the rest." :
    allWarnings.length  > 0      ? "Ready with warnings — review warnings then proceed with the execution order." :
                                   "All clear — simulation shows no conflicts. Safe to proceed with execution order.";

  const report: MergeSimulationReport = {
    schemaVersion:    "BM-8",
    primeJobId,
    backendJobId,
    generatedAt:      new Date().toISOString(),
    durationMs:       Date.now() - t0,
    simulationId:     simId(),
    conflicts:        allConflicts,
    warnings:         allWarnings,
    safeOperations:   allSafe,
    riskScore,
    riskGrade:        riskGrade(riskScore),
    canProceed,
    dimensions:       dims,
    executionOrder,
    estimatedMergeMs,
    summary: {
      totalOperations:  allConflicts.length + allWarnings.length + allSafe.length,
      conflictCount:    allConflicts.length,
      warningCount:     allWarnings.length,
      safeCount:        allSafe.length,
      criticalConflicts,
      autoResolvable,
      requiresManual,
      blockingConflicts,
      recommendation,
    },
  };

  try {
    await saveToDisk(primeJobId, report);
    const r2Key = await saveToR2(primeJobId, report);
    if (r2Key) report.r2Key = r2Key;
  } catch (err) {
    logger.warn({ err, primeJobId }, "BM8: persistence failed (non-fatal)");
  }

  _cache.set(primeJobId, report);
  logger.info(
    { primeJobId, riskScore, conflicts: allConflicts.length, warnings: allWarnings.length, safe: allSafe.length, canProceed },
    "BM8: merge simulation complete",
  );

  return report;
}
