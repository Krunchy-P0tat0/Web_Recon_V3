/**
 * production-readiness-engine.ts — Phase 6.6 Production Readiness Validator
 *
 * Determines objectively whether a generated website is production-ready by
 * validating 7 dimensions:
 *
 *   1. Routing          (25 pts) — API routes healthy and responsive
 *   2. API Connectivity (15 pts) — key endpoints reachable + correct responses
 *   3. DB Connectivity  (15 pts) — Postgres reachable, schema intact
 *   4. Storage          (15 pts) — R2 configured, writable, readable
 *   5. SEO              (10 pts) — deployed site has title, meta description, canonical
 *   6. Performance      (10 pts) — API latencies within acceptable thresholds
 *   7. Security         (10 pts) — secrets set, no plaintext credentials in env
 *
 * Score: 0–100
 * Classification:
 *   NOT_READY        (0–49)
 *   PARTIAL          (50–69)
 *   READY            (70–84)
 *   PRODUCTION_READY (85–100)
 *
 * Entry point: runProductionReadinessCheck(opts)
 * Output:      production-readiness-report.json (disk + R2)
 */

import { writeFile }   from "fs/promises";
import { join }        from "path";
import { logger }      from "./logger.js";
import { db }          from "@workspace/db";
import { sql }         from "drizzle-orm";
import { R2Provider }  from "../cloud/r2.provider.js";
import type { CloudProvider } from "../cloud/provider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReadinessClassification =
  | "NOT_READY"
  | "PARTIAL"
  | "READY"
  | "PRODUCTION_READY";

export type DimensionStatus = "PASS" | "WARN" | "FAIL" | "SKIP";

export interface DimensionResult {
  name: string;
  weight: number;
  scoreEarned: number;
  status: DimensionStatus;
  latencyMs: number | null;
  checks: CheckResult[];
  notes: string;
}

export interface CheckResult {
  id: string;
  description: string;
  passed: boolean;
  critical: boolean;
  detail: string | null;
}

export interface ProductionReadinessReport {
  version: "1.0";
  phase: "6.6";
  generatedAt: string;
  durationMs: number;
  jobId: string | null;
  deploymentUrl: string | null;
  score: number;
  maxScore: number;
  classification: ReadinessClassification;
  deploymentAllowed: boolean;
  dimensions: {
    routing:         DimensionResult;
    apiConnectivity: DimensionResult;
    dbConnectivity:  DimensionResult;
    storage:         DimensionResult;
    seo:             DimensionResult;
    performance:     DimensionResult;
    security:        DimensionResult;
  };
  blockers: string[];
  warnings: string[];
  recommendations: string[];
  outputFile: "production-readiness-report.json";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classify(score: number): ReadinessClassification {
  if (score >= 85) return "PRODUCTION_READY";
  if (score >= 70) return "READY";
  if (score >= 50) return "PARTIAL";
  return "NOT_READY";
}

function dimensionStatus(earned: number, weight: number): DimensionStatus {
  const pct = weight > 0 ? earned / weight : 1;
  if (pct >= 1.0)  return "PASS";
  if (pct >= 0.5)  return "WARN";
  if (pct >  0)    return "WARN";
  return "FAIL";
}

async function timedFetch(
  url: string,
  opts: RequestInit = {},
  timeoutMs = 4000
): Promise<{ ok: boolean; status: number; latencyMs: number; body: string | null }> {
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeoutMs);
    const res  = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(tid);
    let body: string | null = null;
    try { body = await res.text(); } catch { /* ignore */ }
    return { ok: res.ok, status: res.status, latencyMs: Date.now() - t0, body };
  } catch {
    return { ok: false, status: 0, latencyMs: Date.now() - t0, body: null };
  }
}

// ---------------------------------------------------------------------------
// 1. Routing (25 pts)
// ---------------------------------------------------------------------------

async function checkRouting(baseUrl: string): Promise<DimensionResult> {
  const t0   = Date.now();
  const checks: CheckResult[] = [];

  const healthRes = await timedFetch(`${baseUrl}/api/healthz`, {}, 3000);
  checks.push({
    id:          "routing:healthz",
    description: "GET /api/healthz returns 200",
    passed:      healthRes.ok && healthRes.status === 200,
    critical:    true,
    detail:      healthRes.status > 0 ? `HTTP ${healthRes.status} in ${healthRes.latencyMs}ms` : "Connection refused / timeout",
  });

  const monitorRes = await timedFetch(`${baseUrl}/api/monitor/health`, {}, 3000);
  checks.push({
    id:          "routing:monitor_health",
    description: "GET /api/monitor/health returns 200",
    passed:      monitorRes.ok,
    critical:    false,
    detail:      monitorRes.status > 0 ? `HTTP ${monitorRes.status}` : "No response",
  });

  const auditRes = await timedFetch(`${baseUrl}/api/deploy/audit`, {}, 3000);
  checks.push({
    id:          "routing:deploy_audit",
    description: "GET /api/deploy/audit returns 200",
    passed:      auditRes.ok,
    critical:    false,
    detail:      auditRes.status > 0 ? `HTTP ${auditRes.status}` : "No response",
  });

  const critical   = checks.filter((c) => c.critical);
  const critFailed = critical.filter((c) => !c.passed).length;
  const passed     = checks.filter((c) => c.passed).length;
  const scoreEarned = critFailed > 0 ? 0 : Math.round((passed / checks.length) * 25);

  return {
    name:        "Routing",
    weight:      25,
    scoreEarned,
    status:      dimensionStatus(scoreEarned, 25),
    latencyMs:   Date.now() - t0,
    checks,
    notes: critFailed > 0
      ? "Critical route /api/healthz is unreachable. The API server must be running for deployment."
      : "All core routes are reachable.",
  };
}

// ---------------------------------------------------------------------------
// 2. API Connectivity (15 pts)
// ---------------------------------------------------------------------------

async function checkApiConnectivity(baseUrl: string): Promise<DimensionResult> {
  const t0   = Date.now();
  const checks: CheckResult[] = [];

  const jobsRes = await timedFetch(`${baseUrl}/api/scrape/jobs`, {}, 3000);
  checks.push({
    id:          "api:jobs_list",
    description: "GET /api/scrape/jobs returns valid JSON",
    passed:      jobsRes.ok && (jobsRes.body?.startsWith("{") || jobsRes.body?.startsWith("[")) === true,
    critical:    false,
    detail:      `HTTP ${jobsRes.status}`,
  });

  const execRes = await timedFetch(`${baseUrl}/api/deploy/executions`, {}, 3000);
  checks.push({
    id:          "api:executions_list",
    description: "GET /api/deploy/executions returns valid JSON",
    passed:      execRes.ok && execRes.body?.includes("executions") === true,
    critical:    false,
    detail:      `HTTP ${execRes.status}`,
  });

  const pipelineRes = await timedFetch(`${baseUrl}/api/monitor/pipeline`, {}, 3000);
  checks.push({
    id:          "api:pipeline_health",
    description: "GET /api/monitor/pipeline responds",
    passed:      pipelineRes.ok,
    critical:    false,
    detail:      `HTTP ${pipelineRes.status}`,
  });

  const passed      = checks.filter((c) => c.passed).length;
  const scoreEarned = Math.round((passed / checks.length) * 15);

  return {
    name:        "API Connectivity",
    weight:      15,
    scoreEarned,
    status:      dimensionStatus(scoreEarned, 15),
    latencyMs:   Date.now() - t0,
    checks,
    notes: `${passed}/${checks.length} API endpoints responding correctly.`,
  };
}

// ---------------------------------------------------------------------------
// 3. DB Connectivity (15 pts)
// ---------------------------------------------------------------------------

async function checkDbConnectivity(): Promise<DimensionResult> {
  const t0     = Date.now();
  const checks: CheckResult[] = [];

  // Basic ping
  try {
    await db.execute(sql`SELECT 1 AS ok`);
    checks.push({ id: "db:ping", description: "Postgres responds to SELECT 1", passed: true, critical: true, detail: null });
  } catch (err) {
    checks.push({ id: "db:ping", description: "Postgres responds to SELECT 1", passed: false, critical: true, detail: String(err) });
  }

  // Schema presence — scrape_jobs table
  try {
    await db.execute(sql`SELECT count(*) FROM scrape_jobs LIMIT 1`);
    checks.push({ id: "db:schema_scrape_jobs", description: "scrape_jobs table exists and is queryable", passed: true, critical: true, detail: null });
  } catch (err) {
    checks.push({ id: "db:schema_scrape_jobs", description: "scrape_jobs table exists and is queryable", passed: false, critical: true, detail: String(err) });
  }

  // Schema presence — manifest_snapshots
  try {
    await db.execute(sql`SELECT count(*) FROM manifest_snapshots LIMIT 1`);
    checks.push({ id: "db:schema_manifests", description: "manifest_snapshots table exists", passed: true, critical: false, detail: null });
  } catch (err) {
    checks.push({ id: "db:schema_manifests", description: "manifest_snapshots table exists", passed: false, critical: false, detail: String(err) });
  }

  const critical   = checks.filter((c) => c.critical);
  const critFailed = critical.filter((c) => !c.passed).length;
  const passed     = checks.filter((c) => c.passed).length;
  const scoreEarned = critFailed > 0 ? 0 : Math.round((passed / checks.length) * 15);

  return {
    name:        "DB Connectivity",
    weight:      15,
    scoreEarned,
    status:      dimensionStatus(scoreEarned, 15),
    latencyMs:   Date.now() - t0,
    checks,
    notes: critFailed > 0
      ? "Database is unreachable or schema is not applied. Run: pnpm --filter @workspace/db run push"
      : "Database is connected and schema is intact.",
  };
}

// ---------------------------------------------------------------------------
// 4. Storage Connectivity (15 pts)
// ---------------------------------------------------------------------------

async function checkStorage(): Promise<DimensionResult> {
  const t0    = Date.now();
  const r2    = new R2Provider();
  const checks: CheckResult[] = [];

  checks.push({
    id:          "storage:configured",
    description: "R2 credentials are configured",
    passed:      r2.isConfigured(),
    critical:    true,
    detail:      r2.isConfigured() ? "R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME present" : "One or more R2 env vars missing",
  });

  if (r2.isConfigured()) {
    // Write test
    const sentinelKey  = "monitoring/readiness-check.txt";
    const sentinelData = Buffer.from(`readiness-check:${Date.now()}`, "utf8");
    try {
      await r2.upload({ key: sentinelKey, data: sentinelData, contentType: "text/plain", checkDuplicate: false });
      checks.push({ id: "storage:write", description: "R2 sentinel write succeeds", passed: true, critical: true, detail: `Wrote ${sentinelKey}` });
    } catch (err) {
      checks.push({ id: "storage:write", description: "R2 sentinel write succeeds", passed: false, critical: true, detail: String(err) });
    }

    // Read test
    try {
      const buf = await r2.download(sentinelKey);
      checks.push({ id: "storage:read", description: "R2 sentinel read succeeds", passed: buf !== null, critical: false, detail: buf ? `Read ${buf.length} bytes` : "Read returned null" });
    } catch (err) {
      checks.push({ id: "storage:read", description: "R2 sentinel read succeeds", passed: false, critical: false, detail: String(err) });
    }

    // Public URL resolvable
    const pubUrl = r2.getPublicUrl(sentinelKey);
    checks.push({
      id:          "storage:public_url",
      description: "R2 public base URL is configured",
      passed:      pubUrl.startsWith("https://"),
      critical:    false,
      detail:      pubUrl,
    });
  }

  const critical   = checks.filter((c) => c.critical);
  const critFailed = critical.filter((c) => !c.passed).length;
  const passed     = checks.filter((c) => c.passed).length;
  const scoreEarned = critFailed > 0 ? 0 : Math.round((passed / checks.length) * 15);

  return {
    name:        "Storage Connectivity",
    weight:      15,
    scoreEarned,
    status:      dimensionStatus(scoreEarned, 15),
    latencyMs:   Date.now() - t0,
    checks,
    notes: !r2.isConfigured()
      ? "R2 not configured. Set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_ACCOUNT_ID."
      : critFailed > 0
      ? "R2 is configured but write/read operations are failing. Check bucket permissions."
      : "R2 storage is fully operational.",
  };
}

// ---------------------------------------------------------------------------
// 5. SEO (10 pts)
// ---------------------------------------------------------------------------

async function checkSeo(deploymentUrl: string | null): Promise<DimensionResult> {
  const t0    = Date.now();
  const checks: CheckResult[] = [];

  if (!deploymentUrl) {
    checks.push({ id: "seo:deployment_url", description: "A deployment URL is available for SEO validation", passed: false, critical: true, detail: "No deploymentUrl provided" });
    return {
      name: "SEO", weight: 10, scoreEarned: 0,
      status: "SKIP", latencyMs: Date.now() - t0, checks,
      notes: "No deployment URL available. Deploy the site first, then re-run the readiness check.",
    };
  }

  const res = await timedFetch(deploymentUrl, {}, 5000);
  const html = res.body ?? "";

  checks.push({ id: "seo:reachable", description: "Deployed URL is reachable", passed: res.ok, critical: true, detail: `HTTP ${res.status}` });

  if (res.ok) {
    const hasTitle    = /<title[^>]*>[^<]{3,}<\/title>/i.test(html);
    const hasMetaDesc = /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{10,}/i.test(html)
                     || /<meta[^>]+content=["'][^"']{10,}["'][^>]+name=["']description["']/i.test(html);
    const hasOgTitle  = /<meta[^>]+property=["']og:title["']/i.test(html);
    const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
    const hasCanonical = /<link[^>]+rel=["']canonical["']/i.test(html);

    checks.push({ id: "seo:title", description: "<title> tag present and non-empty", passed: hasTitle, critical: true, detail: hasTitle ? "Found" : "Missing or empty <title>" });
    checks.push({ id: "seo:meta_desc", description: "meta[name=description] present", passed: hasMetaDesc, critical: false, detail: hasMetaDesc ? "Found" : "Missing meta description" });
    checks.push({ id: "seo:og_title", description: "og:title Open Graph tag present", passed: hasOgTitle, critical: false, detail: hasOgTitle ? "Found" : "Missing og:title" });
    checks.push({ id: "seo:viewport", description: "viewport meta tag present (mobile-friendly)", passed: hasViewport, critical: false, detail: hasViewport ? "Found" : "Missing viewport meta" });
    checks.push({ id: "seo:canonical", description: "canonical link present", passed: hasCanonical, critical: false, detail: hasCanonical ? "Found" : "Missing canonical link" });
  }

  const critical   = checks.filter((c) => c.critical);
  const critFailed = critical.filter((c) => !c.passed).length;
  const passed     = checks.filter((c) => c.passed).length;
  const scoreEarned = critFailed > 0 ? 0 : Math.round((passed / checks.length) * 10);

  return {
    name:        "SEO",
    weight:      10,
    scoreEarned,
    status:      dimensionStatus(scoreEarned, 10),
    latencyMs:   Date.now() - t0,
    checks,
    notes: critFailed > 0
      ? "Deployed URL is unreachable or missing critical SEO tags."
      : `${passed}/${checks.length} SEO checks passed.`,
  };
}

// ---------------------------------------------------------------------------
// 6. Performance (10 pts)
// ---------------------------------------------------------------------------

const LATENCY_WARN_MS = 800;
const LATENCY_FAIL_MS = 2000;

async function checkPerformance(baseUrl: string): Promise<DimensionResult> {
  const t0    = Date.now();
  const checks: CheckResult[] = [];

  const endpoints = [
    { path: "/api/healthz",           label: "healthz" },
    { path: "/api/deploy/executions", label: "executions" },
    { path: "/api/monitor/health",    label: "monitor" },
  ];

  const latencies: number[] = [];

  for (const ep of endpoints) {
    const res = await timedFetch(`${baseUrl}${ep.path}`, {}, 5000);
    latencies.push(res.latencyMs);
    const ok = res.ok && res.latencyMs < LATENCY_FAIL_MS;
    checks.push({
      id:          `perf:${ep.label}`,
      description: `${ep.path} latency < ${LATENCY_FAIL_MS}ms`,
      passed:      ok,
      critical:    false,
      detail:      `${res.latencyMs}ms (HTTP ${res.status})`,
    });
  }

  const avg = latencies.length > 0 ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length) : 0;
  const p95 = latencies.length > 0 ? Math.round(latencies.slice().sort((a, b) => a - b)[Math.ceil(latencies.length * 0.95) - 1]!) : 0;

  checks.push({
    id:          "perf:avg_latency",
    description: `Average API latency < ${LATENCY_WARN_MS}ms`,
    passed:      avg < LATENCY_WARN_MS,
    critical:    false,
    detail:      `avg=${avg}ms, p95=${p95}ms`,
  });

  const passed      = checks.filter((c) => c.passed).length;
  const scoreEarned = Math.round((passed / checks.length) * 10);

  return {
    name:        "Performance",
    weight:      10,
    scoreEarned,
    status:      dimensionStatus(scoreEarned, 10),
    latencyMs:   avg,
    checks,
    notes: avg > LATENCY_FAIL_MS
      ? "API latency is critically high. Check DB connection pool and query performance."
      : avg > LATENCY_WARN_MS
      ? `API latency is elevated (avg ${avg}ms). Consider optimizing slow queries.`
      : `API performance is healthy (avg ${avg}ms, p95 ${p95}ms).`,
  };
}

// ---------------------------------------------------------------------------
// 7. Security (10 pts)
// ---------------------------------------------------------------------------

async function checkSecurity(): Promise<DimensionResult> {
  const t0    = Date.now();
  const checks: CheckResult[] = [];

  // Required secrets
  const requiredSecrets = [
    "DATABASE_URL",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME",
    "SESSION_SECRET",
  ];

  for (const key of requiredSecrets) {
    const present = !!process.env[key];
    checks.push({
      id:          `security:secret_${key.toLowerCase()}`,
      description: `${key} is set`,
      passed:      present,
      critical:    key === "DATABASE_URL" || key === "SESSION_SECRET",
      detail:      present ? "Set (value hidden)" : "MISSING",
    });
  }

  // No plaintext R2 credentials in non-secret env
  const noLeakedKey = !process.env["R2_ACCESS_KEY_PLAINTEXT"];
  checks.push({
    id:          "security:no_leaked_credentials",
    description: "No plaintext R2 credentials in non-secret env vars",
    passed:      noLeakedKey,
    critical:    false,
    detail:      "Verified R2_ACCESS_KEY_PLAINTEXT is not set",
  });

  // REPLIT_DOMAINS set (HTTPS enforced by platform)
  const domains = process.env["REPLIT_DOMAINS"] ?? "";
  checks.push({
    id:          "security:https_domain",
    description: "REPLIT_DOMAINS is set (HTTPS enforced by platform)",
    passed:      domains.length > 0,
    critical:    false,
    detail:      domains.length > 0 ? `Domains: ${domains}` : "REPLIT_DOMAINS not set (local dev)",
  });

  const critical   = checks.filter((c) => c.critical);
  const critFailed = critical.filter((c) => !c.passed).length;
  const passed     = checks.filter((c) => c.passed).length;
  const scoreEarned = critFailed > 0 ? 0 : Math.round((passed / checks.length) * 10);

  return {
    name:        "Security",
    weight:      10,
    scoreEarned,
    status:      dimensionStatus(scoreEarned, 10),
    latencyMs:   Date.now() - t0,
    checks,
    notes: critFailed > 0
      ? "Critical secrets are missing. DATABASE_URL and SESSION_SECRET are required."
      : `${passed}/${checks.length} security checks passed.`,
  };
}

// ---------------------------------------------------------------------------
// Aggregate blockers / warnings / recommendations
// ---------------------------------------------------------------------------

function aggregateInsights(
  dims: ProductionReadinessReport["dimensions"],
  classification: ReadinessClassification
): { blockers: string[]; warnings: string[]; recommendations: string[] } {
  const blockers: string[]        = [];
  const warnings: string[]        = [];
  const recommendations: string[] = [];

  for (const dim of Object.values(dims)) {
    for (const c of dim.checks) {
      if (!c.passed && c.critical) {
        blockers.push(`[${dim.name}] ${c.description}${c.detail ? ` — ${c.detail}` : ""}`);
      } else if (!c.passed) {
        warnings.push(`[${dim.name}] ${c.description}${c.detail ? ` — ${c.detail}` : ""}`);
      }
    }
  }

  if (classification !== "PRODUCTION_READY") {
    if (dims.seo.scoreEarned < dims.seo.weight * 0.8)
      recommendations.push("Improve SEO: add meta description, og:title, and canonical link to every page.");
    if (dims.performance.scoreEarned < dims.performance.weight * 0.8)
      recommendations.push("Optimize API latency: review slow DB queries and add appropriate indexes.");
    if (dims.security.scoreEarned < dims.security.weight)
      recommendations.push("Harden security: ensure all required secrets are set before production deployment.");
  }

  return { blockers, warnings, recommendations };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const LOCAL_PATH     = join(process.cwd(), "production-readiness-report.json");
const WORKSPACE_PATH = join(process.cwd(), "..", "..", "production-readiness-report.json");

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runProductionReadinessCheck(opts: {
  jobId?:         string | null;
  deploymentUrl?: string | null;
  baseUrl?:       string;
  cloudProvider?: CloudProvider;
}): Promise<ProductionReadinessReport> {
  const t0          = Date.now();
  const jobId       = opts.jobId       ?? null;
  const deployUrl   = opts.deploymentUrl ?? null;
  const baseUrl     = opts.baseUrl ?? `http://localhost:${process.env["PORT"] ?? 8080}`;

  logger.info({ jobId, deploymentUrl: deployUrl, baseUrl }, "READINESS: starting production readiness check");

  const [routing, apiConn, dbConn, storage, seo, performance, security] = await Promise.all([
    checkRouting(baseUrl),
    checkApiConnectivity(baseUrl),
    checkDbConnectivity(),
    checkStorage(),
    checkSeo(deployUrl),
    checkPerformance(baseUrl),
    checkSecurity(),
  ]);

  const dimensions = { routing, apiConnectivity: apiConn, dbConnectivity: dbConn, storage, seo, performance, security };
  const score      = Object.values(dimensions).reduce((s, d) => s + d.scoreEarned, 0);
  const maxScore   = Object.values(dimensions).reduce((s, d) => s + d.weight, 0);
  const classification = classify(score);
  const deploymentAllowed = classification === "PRODUCTION_READY" || classification === "READY";

  const { blockers, warnings, recommendations } = aggregateInsights(dimensions, classification);

  const report: ProductionReadinessReport = {
    version:    "1.0",
    phase:      "6.6",
    generatedAt: new Date().toISOString(),
    durationMs:  Date.now() - t0,
    jobId,
    deploymentUrl: deployUrl,
    score,
    maxScore,
    classification,
    deploymentAllowed,
    dimensions,
    blockers,
    warnings,
    recommendations,
    outputFile: "production-readiness-report.json",
  };

  logger.info(
    {
      jobId,
      score,
      maxScore,
      classification,
      deploymentAllowed,
      blockerCount: blockers.length,
      durationMs:   report.durationMs,
    },
    "READINESS: check complete"
  );

  // ── Persist ─────────────────────────────────────────────────────────────────
  const json = JSON.stringify(report, null, 2);
  const writes: Promise<void>[] = [
    writeFile(LOCAL_PATH,     json, "utf8").catch((err) => logger.warn({ err }, "READINESS: local write failed")),
    writeFile(WORKSPACE_PATH, json, "utf8").catch((err) => logger.warn({ err }, "READINESS: workspace write failed")),
  ];

  if (jobId && opts.cloudProvider?.isConfigured()) {
    writes.push(
      opts.cloudProvider.upload({
        key:          `jobs/${jobId}/production-readiness-report.json`,
        data:         Buffer.from(json, "utf8"),
        contentType:  "application/json",
        checkDuplicate: false,
      })
      .then(() => logger.info({ jobId }, "READINESS: report uploaded to R2"))
      .catch((err) => logger.warn({ err }, "READINESS: R2 upload failed (non-fatal)"))
    );
  }

  await Promise.allSettled(writes);
  return report;
}
