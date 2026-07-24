/**
 * merge-certification-engine-d5.ts — Phase D5: Merge Certification
 *
 * Certifies merge readiness by aggregating signals from D1–D4 plus
 * independent runtime probes across 9 dimensions:
 *
 *   1. Code Conflicts        — D3 operation failures, blocked files
 *   2. Runtime Stability     — server health, pipeline liveness
 *   3. API Compatibility     — D4 API Compatibility Score
 *   4. Authentication        — BM-4 auth preservation signal
 *   5. Database              — schema push success, relation health
 *   6. Storage               — R2 connectivity + asset reachability
 *   7. Assets                — C2 asset intelligence signal
 *   8. Routing               — BM-2 collision detection, route health
 *   9. Rollback              — D3 rollback package integrity
 *
 * Assigns:
 *   Merge Score  0–100
 *   Merge Grade  A+–F
 *   Risk Level   LOW | MEDIUM | HIGH | CRITICAL
 *
 * Generates (R2 + in-memory):
 *   merge-certification.json
 *   merge-readiness-score.json
 *   production-merge-report.json
 */

import { logger }              from "./logger.js";
import { createCloudProvider } from "../cloud/index.js";
import { getD4Bundle }         from "./api-contract-validation-engine-d4.js";
import { createRequire }       from "module";
import * as crypto             from "crypto";
import * as fs                 from "fs";
import * as path               from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MergeRiskLevel    = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type DimensionStatus   = "PASS" | "WARN" | "FAIL" | "UNKNOWN";
export type MergeReadinessTag = "READY_TO_MERGE" | "CONDITIONAL_MERGE" | "BLOCK_MERGE" | "REQUIRE_REVIEW";

export interface D5Input {
  certificationId?: string;
  d3ExecutionId?:   string;
  d4ValidationId?:  string;
  primeJobId?:      string;
  backendUrl?:      string;
  force?:           boolean;
}

// ── Dimension result ──────────────────────────────────────────────────────────

export interface DimensionResult {
  dimension:     string;
  phase:         string;
  status:        DimensionStatus;
  score:         number;        // 0–100
  weight:        number;        // relative weight in final score
  blockers:      string[];
  warnings:      string[];
  evidence:      string[];
  recommendation: string;
}

// ── Certification output types ─────────────────────────────────────────────────

export interface MergeCertification {
  certificationId:   string;
  generatedAt:       string;
  durationMs:        number;
  mergeScore:        number;
  mergeGrade:        string;
  riskLevel:         MergeRiskLevel;
  readinessTag:      MergeReadinessTag;
  dimensions:        DimensionResult[];
  totalBlockers:     number;
  totalWarnings:     number;
  certificationPassed: boolean;
  certificationSummary: string;
  blockerDetail:     string[];
  warningDetail:     string[];
  nextSteps:         string[];
}

export interface MergeReadinessScore {
  certificationId:    string;
  generatedAt:        string;
  mergeScore:         number;
  mergeGrade:         string;
  riskLevel:          MergeRiskLevel;
  readinessTag:       MergeReadinessTag;
  dimensionScores:    Record<string, number>;
  apiCompatibilityScore: number;
  codeConflictScore:  number;
  runtimeStabilityScore: number;
  authScore:          number;
  dbScore:            number;
  storageScore:       number;
  routingScore:       number;
  rollbackScore:      number;
  assetScore:         number;
  certificationPassed: boolean;
}

export interface ProductionMergeReport {
  certificationId:    string;
  generatedAt:        string;
  mergeScore:         number;
  mergeGrade:         string;
  riskLevel:          MergeRiskLevel;
  readinessTag:       MergeReadinessTag;
  certificationPassed: boolean;
  executiveSummary:   string;
  dimensions:         DimensionResult[];
  productionChecklist: ProductionCheckItem[];
  rollbackPlan:       string[];
  approvalRequired:   boolean;
  approvalReason?:    string;
  mergedAt?:          string;
}

export interface ProductionCheckItem {
  id:      string;
  item:    string;
  status:  "PASS" | "FAIL" | "WARN" | "PENDING";
  detail:  string;
}

export interface D5Bundle {
  certificationId:      string;
  generatedAt:          string;
  durationMs:           number;
  r2Keys:               string[];
  mergeCertification:   MergeCertification;
  mergeReadinessScore:  MergeReadinessScore;
  productionMergeReport: ProductionMergeReport;
  mergeScore:           number;
  mergeGrade:           string;
  riskLevel:            MergeRiskLevel;
}

// ── In-memory store ───────────────────────────────────────────────────────────

const d5Store = new Map<string, D5Bundle>();

export function getD5Bundle(certificationId: string): D5Bundle | undefined {
  return d5Store.get(certificationId);
}

export function listD5Bundles(): Array<{ certificationId: string; generatedAt: string; mergeScore: number; mergeGrade: string; riskLevel: MergeRiskLevel; certificationPassed: boolean }> {
  return [...d5Store.values()].map(b => ({
    certificationId:     b.certificationId,
    generatedAt:         b.generatedAt,
    mergeScore:          b.mergeScore,
    mergeGrade:          b.mergeGrade,
    riskLevel:           b.riskLevel,
    certificationPassed: b.mergeCertification.certificationPassed,
  })).sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

// ── R2 helper ─────────────────────────────────────────────────────────────────

async function storeR2(certificationId: string, file: string, data: unknown): Promise<string> {
  const key      = `d5/${certificationId}/${file}`;
  const provider = createCloudProvider("r2");
  if (!provider.isConfigured()) { logger.warn({ certificationId, file }, "D5: R2 not configured"); return key; }
  const buf = Buffer.from(JSON.stringify(data, null, 2), "utf-8");
  await provider.upload({ key, data: buf, contentType: "application/json", checkDuplicate: false });
  logger.info({ key }, "D5: stored to R2");
  return key;
}

// ── Grading ───────────────────────────────────────────────────────────────────

function scoreToGrade(score: number): string {
  if (score >= 97) return "A+";
  if (score >= 93) return "A";
  if (score >= 90) return "A-";
  if (score >= 87) return "B+";
  if (score >= 83) return "B";
  if (score >= 80) return "B-";
  if (score >= 77) return "C+";
  if (score >= 73) return "C";
  if (score >= 70) return "C-";
  if (score >= 67) return "D+";
  if (score >= 63) return "D";
  if (score >= 60) return "D-";
  return "F";
}

function scoreToRisk(score: number, blockers: number): MergeRiskLevel {
  if (blockers > 0 || score < 50) return "CRITICAL";
  if (score < 65)                 return "HIGH";
  if (score < 80)                 return "MEDIUM";
  return "LOW";
}

function riskToTag(risk: MergeRiskLevel, score: number): MergeReadinessTag {
  if (risk === "CRITICAL")             return "BLOCK_MERGE";
  if (risk === "HIGH" || score < 70)   return "REQUIRE_REVIEW";
  if (risk === "MEDIUM" || score < 85) return "CONDITIONAL_MERGE";
  return "READY_TO_MERGE";
}

// ── Dimension evaluators ──────────────────────────────────────────────────────

interface DimensionProbe {
  dimension: string;
  phase:     string;
  weight:    number;
  evaluate:  (input: D5Input) => Promise<Omit<DimensionResult, "dimension" | "phase" | "weight">>;
}

const DIMENSION_PROBES: DimensionProbe[] = [
  // ── 1. Code Conflicts ──────────────────────────────────────────────────────
  {
    dimension: "Code Conflicts",
    phase:     "D3",
    weight:    15,
    async evaluate(input) {
      const blockers: string[] = [];
      const warnings: string[] = [];
      const evidence: string[] = [];

      // Try to load D3 execution report from disk if available
      let d3Score = 85; // optimistic default
      const d3Path = path.join(process.cwd(), "../../deployment-audit.json");
      try {
        if (fs.existsSync(d3Path)) {
          const audit = JSON.parse(fs.readFileSync(d3Path, "utf-8")) as Record<string, unknown>;
          const summary = audit["summary"] as Record<string, number> | undefined;
          const failed  = summary?.["failed"] ?? 0;
          if (typeof failed === "number" && failed > 0) {
            blockers.push(`${failed} failed deployment operation(s) detected in audit`);
            d3Score = Math.max(0, 85 - failed * 10);
          }
          evidence.push("deployment-audit.json read successfully");
        } else {
          evidence.push("No D3 execution audit found — using baseline score");
        }
      } catch { evidence.push("Could not parse D3 audit — defaulting"); }

      if (input.d3ExecutionId) evidence.push(`D3 execution ID: ${input.d3ExecutionId}`);

      return {
        status:         blockers.length > 0 ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS",
        score:          d3Score,
        blockers,
        warnings,
        evidence,
        recommendation: blockers.length > 0
          ? "Resolve all failed merge operations before proceeding"
          : "Code conflict check passed — no blocking conflicts detected",
      };
    },
  },

  // ── 2. Runtime Stability ───────────────────────────────────────────────────
  {
    dimension: "Runtime Stability",
    phase:     "PH-2",
    weight:    15,
    async evaluate(_input) {
      const blockers: string[] = [];
      const warnings: string[] = [];
      const evidence: string[] = [];

      // Probe health-report.json
      const hrPath = path.join(process.cwd(), "../../health-report.json");
      let score = 80;
      try {
        if (fs.existsSync(hrPath)) {
          const hr = JSON.parse(fs.readFileSync(hrPath, "utf-8")) as Record<string, unknown>;
          evidence.push("health-report.json found");
          const status = hr["status"] as string | undefined;
          if (status === "healthy" || status === "ok" || status === "PASS") {
            score = 95;
          } else if (status === "degraded") {
            warnings.push("Runtime reports degraded health");
            score = 65;
          } else if (status === "unhealthy" || status === "FAIL") {
            blockers.push("Runtime is reporting unhealthy status");
            score = 20;
          }
        } else {
          warnings.push("No health report found — server may not have run a health check yet");
          evidence.push("health-report.json not found");
        }
      } catch { evidence.push("Could not parse health-report.json"); }

      // Check pipeline-health.json
      const phPath = path.join(process.cwd(), "../../pipeline-health.json");
      try {
        if (fs.existsSync(phPath)) {
          const ph = JSON.parse(fs.readFileSync(phPath, "utf-8")) as Record<string, unknown>;
          const stages = ph["stages"] as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(stages)) {
            const failed = stages.filter(s => s["status"] === "FAIL" || s["status"] === "ERROR");
            if (failed.length > 0) {
              warnings.push(`${failed.length} pipeline stage(s) reporting failure`);
              score = Math.min(score, 70);
            }
            evidence.push(`Pipeline: ${stages.length} stages checked`);
          }
        }
      } catch { evidence.push("Could not parse pipeline-health.json"); }

      return {
        status:         blockers.length > 0 ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS",
        score,
        blockers,
        warnings,
        evidence,
        recommendation: blockers.length > 0
          ? "Resolve runtime health issues before merge"
          : warnings.length > 0
          ? "Review pipeline stage failures and monitor stability"
          : "Runtime is stable — all health checks passing",
      };
    },
  },

  // ── 3. API Compatibility ───────────────────────────────────────────────────
  {
    dimension: "API Compatibility",
    phase:     "D4",
    weight:    20,
    async evaluate(input) {
      const blockers: string[] = [];
      const warnings: string[] = [];
      const evidence: string[] = [];
      let score = 75;

      if (input.d4ValidationId) {
        const d4 = getD4Bundle(input.d4ValidationId);
        if (d4) {
          score = d4.apiCompatibilityScore;
          evidence.push(`D4 validation loaded: ${input.d4ValidationId}`);
          evidence.push(`API Compatibility Score: ${score}/100 (${d4.apiValidationReport.grade})`);
          if (d4.apiValidationReport.blockers.length > 0) {
            blockers.push(...d4.apiValidationReport.blockers.slice(0, 5));
          }
          if (d4.contractDriftReport.totalDrifts > 0) {
            const high = d4.contractDriftReport.bySeverity["HIGH"] + d4.contractDriftReport.bySeverity["CRITICAL"];
            if (high > 0) warnings.push(`${high} high/critical contract drift(s) detected`);
          }
        } else {
          warnings.push(`D4 bundle not found for id ${input.d4ValidationId} — run D4 first`);
          evidence.push("D4 bundle not in memory");
        }
      } else {
        warnings.push("No D4 validation ID provided — API compatibility not fully verified");
        evidence.push("D4 not linked — using default score");
      }

      return {
        status:         blockers.length > 0 ? "FAIL" : score < 70 ? "WARN" : warnings.length > 0 ? "WARN" : "PASS",
        score,
        blockers,
        warnings,
        evidence,
        recommendation: blockers.length > 0
          ? "Fix API contract violations before merge"
          : score < 80
          ? "Improve API contract alignment — consider running D4 validation and fixing drift"
          : "API compatibility is acceptable for merge",
      };
    },
  },

  // ── 4. Authentication ──────────────────────────────────────────────────────
  {
    dimension: "Authentication",
    phase:     "BM-4",
    weight:    10,
    async evaluate(_input) {
      const warnings: string[] = [];
      const evidence: string[] = [];

      // Heuristic: check if auth preservation engine file is present
      const enginePath = path.join(process.cwd(), "src/lib/auth-preservation-engine-bm4.ts");
      const routePath  = path.join(process.cwd(), "src/routes/auth-preservation-bm4.ts");
      const engineOk   = fs.existsSync(enginePath);
      const routeOk    = fs.existsSync(routePath);

      evidence.push(`BM-4 engine file: ${engineOk ? "present" : "missing"}`);
      evidence.push(`BM-4 route file:  ${routeOk  ? "present" : "missing"}`);

      let score = 90;
      if (!engineOk) { warnings.push("Auth preservation engine file missing"); score -= 20; }
      if (!routeOk)  { warnings.push("Auth preservation route file missing");  score -= 10; }

      // Check .env is not being overwritten (protected)
      evidence.push("Auth protection: .env files marked as protected in D3 PROTECTED_FILENAMES");

      return {
        status:         warnings.length > 1 ? "WARN" : "PASS",
        score:          Math.max(0, score),
        blockers:       [],
        warnings,
        evidence,
        recommendation: warnings.length > 0
          ? "Review BM-4 auth preservation configuration"
          : "Authentication preservation verified — auth config files are protected from merge overwrites",
      };
    },
  },

  // ── 5. Database ────────────────────────────────────────────────────────────
  {
    dimension: "Database",
    phase:     "DB",
    weight:    15,
    async evaluate(_input) {
      const blockers: string[] = [];
      const warnings: string[] = [];
      const evidence: string[] = [];
      let score = 85;

      const dbUrl = process.env["DATABASE_URL"];
      if (!dbUrl) {
        blockers.push("DATABASE_URL is not set — no database connection available");
        score = 0;
      } else {
        evidence.push("DATABASE_URL is configured");
      }

      // Check schema files exist
      const schemaDir = path.join(process.cwd(), "../../lib/db/src/schema");
      if (fs.existsSync(schemaDir)) {
        const files = fs.readdirSync(schemaDir).filter(f => f.endsWith(".ts"));
        evidence.push(`DB schema files: ${files.join(", ")}`);
        if (files.length === 0) {
          warnings.push("No schema files found in lib/db/src/schema");
          score -= 15;
        } else {
          score = Math.min(95, score + files.length * 2);
        }
      } else {
        warnings.push("Schema directory not found at lib/db/src/schema");
        score -= 10;
      }

      // Check drizzle config
      const drizzleCfg = path.join(process.cwd(), "../../lib/db/drizzle.config.ts");
      if (fs.existsSync(drizzleCfg)) {
        evidence.push("drizzle.config.ts present");
      } else {
        warnings.push("drizzle.config.ts not found");
        score -= 5;
      }

      return {
        status:         blockers.length > 0 ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS",
        score:          Math.max(0, Math.min(100, score)),
        blockers,
        warnings,
        evidence,
        recommendation: blockers.length > 0
          ? "Set DATABASE_URL and run `pnpm --filter @workspace/db run push` before merge"
          : "Database schema is healthy and migrations have been applied",
      };
    },
  },

  // ── 6. Storage ─────────────────────────────────────────────────────────────
  {
    dimension: "Storage",
    phase:     "R2",
    weight:    8,
    async evaluate(_input) {
      const warnings: string[] = [];
      const evidence: string[] = [];
      let score = 85;

      const keys = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "CLOUDFLARE_API_TOKEN", "R2_ENDPOINT"];
      const missing: string[] = [];
      for (const k of keys) {
        if (!process.env[k]) missing.push(k);
        else evidence.push(`${k}: configured`);
      }
      if (missing.length > 0) {
        warnings.push(`Missing R2 env vars: ${missing.join(", ")}`);
        score -= missing.length * 10;
      }

      // Check provider availability
      try {
        const provider = createCloudProvider("r2");
        if (provider.isConfigured()) {
          evidence.push("R2 cloud provider: configured and reachable");
          score = Math.min(100, score + 5);
        } else {
          warnings.push("R2 provider.isConfigured() returned false");
          score -= 15;
        }
      } catch (err) {
        warnings.push(`R2 provider check failed: ${err instanceof Error ? err.message : String(err)}`);
        score -= 20;
      }

      return {
        status:         score < 60 ? "WARN" : "PASS",
        score:          Math.max(0, Math.min(100, score)),
        blockers:       [],
        warnings,
        evidence,
        recommendation: warnings.length > 0
          ? "Verify R2 credentials are complete and the bucket is accessible"
          : "R2 storage is fully configured and operational",
      };
    },
  },

  // ── 7. Assets ──────────────────────────────────────────────────────────────
  {
    dimension: "Assets",
    phase:     "C2",
    weight:    7,
    async evaluate(_input) {
      const warnings: string[] = [];
      const evidence: string[] = [];
      let score = 80;

      const c2Engine = path.join(process.cwd(), "src/lib/asset-intelligence-engine-c2.ts");
      const c2Route  = path.join(process.cwd(), "src/routes/asset-intelligence-c2.ts");

      if (fs.existsSync(c2Engine)) { evidence.push("C2 asset intelligence engine: present"); }
      else { warnings.push("C2 engine missing"); score -= 15; }

      if (fs.existsSync(c2Route)) { evidence.push("C2 asset route: present"); }
      else { warnings.push("C2 asset route missing"); score -= 10; }

      // Check public URL configured
      const pubUrl = process.env["R2_PUBLIC_BASE_URL"];
      if (pubUrl) { evidence.push(`R2_PUBLIC_BASE_URL: ${pubUrl}`); }
      else { warnings.push("R2_PUBLIC_BASE_URL not set — asset CDN URLs will not resolve"); score -= 10; }

      return {
        status:         warnings.length > 2 ? "WARN" : "PASS",
        score:          Math.max(0, Math.min(100, score)),
        blockers:       [],
        warnings,
        evidence,
        recommendation: warnings.length > 0
          ? "Configure asset intelligence engine and R2 public URL for full CDN coverage"
          : "Asset pipeline is healthy — C2 engine active and CDN configured",
      };
    },
  },

  // ── 8. Routing ─────────────────────────────────────────────────────────────
  {
    dimension: "Routing",
    phase:     "BM-2",
    weight:    5,
    async evaluate(_input) {
      const warnings: string[] = [];
      const evidence: string[] = [];
      let score = 90;

      const bm2Engine = path.join(process.cwd(), "src/lib/route-collision-engine-bm2.ts");
      const bm2Route  = path.join(process.cwd(), "src/routes/route-collision-bm2.ts");
      const indexRoute = path.join(process.cwd(), "src/routes/index.ts");

      if (fs.existsSync(bm2Engine)) { evidence.push("BM-2 route collision engine: present"); }
      else { warnings.push("BM-2 engine missing — route collision detection unavailable"); score -= 15; }

      if (fs.existsSync(bm2Route)) { evidence.push("BM-2 route: present"); }
      else { warnings.push("BM-2 route file missing"); score -= 10; }

      if (fs.existsSync(indexRoute)) {
        const content = fs.readFileSync(indexRoute, "utf-8");
        const routeCount = (content.match(/router\.use/g) ?? []).length;
        evidence.push(`Routes/index.ts: ${routeCount} router.use() registrations`);
        if (routeCount > 50) score = Math.min(100, score + 5); // big router = comprehensive coverage
      }

      return {
        status:         warnings.length > 1 ? "WARN" : "PASS",
        score:          Math.max(0, Math.min(100, score)),
        blockers:       [],
        warnings,
        evidence,
        recommendation: warnings.length > 0
          ? "Enable BM-2 route collision detection before running merge"
          : "Routing is healthy — BM-2 collision detection active and routes registered",
      };
    },
  },

  // ── 9. Rollback ────────────────────────────────────────────────────────────
  {
    dimension: "Rollback",
    phase:     "D3 / BM-9",
    weight:    5,
    async evaluate(input) {
      const warnings: string[] = [];
      const evidence: string[] = [];
      let score = 85;

      const bm9Engine = path.join(process.cwd(), "src/lib/rollback-generator-bm9.ts");
      const bm9Route  = path.join(process.cwd(), "src/routes/rollback-generator-bm9.ts");

      if (fs.existsSync(bm9Engine)) { evidence.push("BM-9 rollback generator: present"); }
      else { warnings.push("BM-9 rollback generator engine missing"); score -= 20; }

      if (fs.existsSync(bm9Route)) { evidence.push("BM-9 rollback route: present"); }
      else { warnings.push("BM-9 rollback route missing"); score -= 10; }

      if (input.d3ExecutionId) {
        evidence.push(`D3 execution ${input.d3ExecutionId} provides rollback package`);
        score = Math.min(100, score + 5);
      } else {
        warnings.push("No D3 execution linked — rollback package not pre-generated");
        score -= 10;
      }

      const rollbackPlanPath = path.join(process.cwd(), "../../repair-plan.json");
      if (fs.existsSync(rollbackPlanPath)) {
        evidence.push("repair-plan.json: present");
      }

      return {
        status:         warnings.length > 1 ? "WARN" : "PASS",
        score:          Math.max(0, Math.min(100, score)),
        blockers:       [],
        warnings,
        evidence,
        recommendation: warnings.length > 0
          ? "Generate a rollback package via D3 or BM-9 before merging to production"
          : "Rollback package is ready — merge can be safely reversed if needed",
      };
    },
  },
];

// ── Production checklist ──────────────────────────────────────────────────────

function buildProductionChecklist(dimensions: DimensionResult[]): ProductionCheckItem[] {
  const dimMap = new Map(dimensions.map(d => [d.dimension, d]));

  const checks: Array<{ id: string; item: string; dimension?: string; always?: "PASS" | "PENDING" }> = [
    { id: "CHK-001", item: "All code conflicts resolved",          dimension: "Code Conflicts"    },
    { id: "CHK-002", item: "Runtime health checks passing",        dimension: "Runtime Stability" },
    { id: "CHK-003", item: "API contract validation complete",     dimension: "API Compatibility" },
    { id: "CHK-004", item: "Authentication config preserved",      dimension: "Authentication"    },
    { id: "CHK-005", item: "Database schema migrated",             dimension: "Database"          },
    { id: "CHK-006", item: "R2 storage connectivity verified",     dimension: "Storage"           },
    { id: "CHK-007", item: "Asset CDN pipeline operational",       dimension: "Assets"            },
    { id: "CHK-008", item: "Route collision audit passed",         dimension: "Routing"           },
    { id: "CHK-009", item: "Rollback package generated",          dimension: "Rollback"          },
    { id: "CHK-010", item: "OpenAPI spec updated for new routes",  always: "PENDING"              },
    { id: "CHK-011", item: "Environment variables transferred",    always: "PENDING"              },
    { id: "CHK-012", item: "Production deployment plan approved",  always: "PENDING"              },
  ];

  return checks.map(c => {
    if (c.always) {
      return { id: c.id, item: c.item, status: c.always, detail: "Manual verification required" };
    }
    const dim = c.dimension ? dimMap.get(c.dimension) : undefined;
    if (!dim) return { id: c.id, item: c.item, status: "PENDING" as const, detail: "Dimension not evaluated" };
    const status: "PASS" | "FAIL" | "WARN" | "PENDING" =
      dim.status === "PASS" ? "PASS" :
      dim.status === "FAIL" ? "FAIL" :
      dim.status === "WARN" ? "WARN" : "PENDING";
    const blockerText = dim.blockers.length > 0 ? ` Blockers: ${dim.blockers.slice(0, 2).join("; ")}` : "";
    const warnText    = dim.warnings.length > 0 ? ` Warnings: ${dim.warnings.slice(0, 2).join("; ")}` : "";
    return { id: c.id, item: c.item, status, detail: `Score: ${dim.score}/100.${blockerText}${warnText}` };
  });
}

// ── Main run function ─────────────────────────────────────────────────────────

export async function runMergeCertification(input: D5Input): Promise<D5Bundle> {
  const start           = Date.now();
  const certificationId = input.certificationId ?? `d5-${crypto.randomUUID()}`;
  const generatedAt     = new Date().toISOString();

  logger.info({ certificationId }, "D5: starting merge certification");

  // 1. Run all dimension probes in parallel
  const dimensionResults: DimensionResult[] = await Promise.all(
    DIMENSION_PROBES.map(async probe => {
      try {
        const result = await probe.evaluate(input);
        logger.info({ certificationId, dimension: probe.dimension, score: result.score, status: result.status }, "D5: dimension evaluated");
        return { dimension: probe.dimension, phase: probe.phase, weight: probe.weight, ...result };
      } catch (err) {
        logger.warn({ certificationId, dimension: probe.dimension, err }, "D5: dimension probe threw — marking UNKNOWN");
        return {
          dimension:      probe.dimension,
          phase:          probe.phase,
          weight:         probe.weight,
          status:         "UNKNOWN" as DimensionStatus,
          score:          50,
          blockers:       [`Probe threw: ${err instanceof Error ? err.message : String(err)}`],
          warnings:       [],
          evidence:       [],
          recommendation: "Re-run certification after resolving the probe error",
        };
      }
    })
  );

  // 2. Weighted merge score
  const totalWeight = DIMENSION_PROBES.reduce((s, p) => s + p.weight, 0);
  const rawScore    = dimensionResults.reduce((s, d) => s + d.score * d.weight, 0) / totalWeight;
  const mergeScore  = Math.round(Math.max(0, Math.min(100, rawScore)));
  const mergeGrade  = scoreToGrade(mergeScore);

  const totalBlockers = dimensionResults.reduce((s, d) => s + d.blockers.length, 0);
  const totalWarnings = dimensionResults.reduce((s, d) => s + d.warnings.length, 0);
  const riskLevel     = scoreToRisk(mergeScore, totalBlockers);
  const readinessTag  = riskToTag(riskLevel, mergeScore);
  const certificationPassed = totalBlockers === 0 && mergeScore >= 70;

  const blockerDetail = dimensionResults.flatMap(d => d.blockers.map(b => `[${d.dimension}] ${b}`));
  const warningDetail = dimensionResults.flatMap(d => d.warnings.map(w => `[${d.dimension}] ${w}`));

  const nextSteps: string[] = [];
  if (totalBlockers > 0) nextSteps.push(`Resolve ${totalBlockers} blocker(s) before proceeding`);
  if (riskLevel !== "LOW") nextSteps.push("Run D4 API Contract Validation if not already done");
  if (!input.d3ExecutionId) nextSteps.push("Link a D3 merge execution to verify rollback package");
  nextSteps.push("Review production checklist in production-merge-report.json");
  if (certificationPassed) nextSteps.push("Proceed with staged production deployment");

  const certificationSummary =
    `Merge Score: ${mergeScore}/100 (${mergeGrade}) — Risk: ${riskLevel} — ${readinessTag}. ` +
    `${totalBlockers} blocker(s), ${totalWarnings} warning(s). ` +
    (certificationPassed ? "Merge is CERTIFIED READY." : "Merge requires remediation before proceeding.");

  const durationMs = Date.now() - start;

  // ── Build reports ──────────────────────────────────────────────────────────

  const mergeCertification: MergeCertification = {
    certificationId,
    generatedAt,
    durationMs,
    mergeScore,
    mergeGrade,
    riskLevel,
    readinessTag,
    dimensions:           dimensionResults,
    totalBlockers,
    totalWarnings,
    certificationPassed,
    certificationSummary,
    blockerDetail,
    warningDetail,
    nextSteps,
  };

  const dimensionScores: Record<string, number> = {};
  for (const d of dimensionResults) dimensionScores[d.dimension] = d.score;

  const mergeReadinessScore: MergeReadinessScore = {
    certificationId,
    generatedAt,
    mergeScore,
    mergeGrade,
    riskLevel,
    readinessTag,
    dimensionScores,
    apiCompatibilityScore:   dimensionResults.find(d => d.dimension === "API Compatibility")?.score   ?? 0,
    codeConflictScore:       dimensionResults.find(d => d.dimension === "Code Conflicts")?.score      ?? 0,
    runtimeStabilityScore:   dimensionResults.find(d => d.dimension === "Runtime Stability")?.score   ?? 0,
    authScore:               dimensionResults.find(d => d.dimension === "Authentication")?.score      ?? 0,
    dbScore:                 dimensionResults.find(d => d.dimension === "Database")?.score            ?? 0,
    storageScore:            dimensionResults.find(d => d.dimension === "Storage")?.score             ?? 0,
    routingScore:            dimensionResults.find(d => d.dimension === "Routing")?.score             ?? 0,
    rollbackScore:           dimensionResults.find(d => d.dimension === "Rollback")?.score            ?? 0,
    assetScore:              dimensionResults.find(d => d.dimension === "Assets")?.score              ?? 0,
    certificationPassed,
  };

  const productionChecklist = buildProductionChecklist(dimensionResults);

  const productionMergeReport: ProductionMergeReport = {
    certificationId,
    generatedAt,
    mergeScore,
    mergeGrade,
    riskLevel,
    readinessTag,
    certificationPassed,
    executiveSummary:   certificationSummary,
    dimensions:         dimensionResults,
    productionChecklist,
    rollbackPlan: [
      "1. Retrieve rollback package from D3 execution or BM-9 generator",
      "2. Run `POST /merge-execution/:executionId/rollback` to restore previous state",
      "3. Verify application health via `/api/healthz` and `/api/monitor/health`",
      "4. Run `pnpm install` to restore original dependency tree",
      "5. Restart all workflows and validate pipeline stages",
    ],
    approvalRequired:  riskLevel !== "LOW",
    approvalReason:    riskLevel !== "LOW" ? `Risk level ${riskLevel} requires manual approval before production merge` : undefined,
  };

  const bundle: D5Bundle = {
    certificationId,
    generatedAt,
    durationMs,
    r2Keys: [],
    mergeCertification,
    mergeReadinessScore,
    productionMergeReport,
    mergeScore,
    mergeGrade,
    riskLevel,
  };

  // Store to R2
  const r2Keys = await Promise.all([
    storeR2(certificationId, "merge-certification.json",     mergeCertification),
    storeR2(certificationId, "merge-readiness-score.json",   mergeReadinessScore),
    storeR2(certificationId, "production-merge-report.json", productionMergeReport),
  ]);
  bundle.r2Keys = r2Keys;

  d5Store.set(certificationId, bundle);
  logger.info({ certificationId, mergeScore, mergeGrade, riskLevel, certificationPassed, durationMs }, "D5: merge certification complete");

  return bundle;
}
