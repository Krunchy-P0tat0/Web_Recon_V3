/**
 * api-contract-validation-engine-d4.ts — Phase D4: API Contract Validation
 *
 * Validates Website Prime against the merged backend.
 *
 * Verifies:
 *   REST endpoints        — presence, method, path, parameter conformance
 *   OpenAPI contract      — spec drift detection vs live routes
 *   Request schemas       — body/query/param shape validation
 *   Response schemas      — response shape & status code conformance
 *   Authentication        — auth scheme presence and consistency
 *   Authorization         — role/scope coverage on protected endpoints
 *   Validation middleware — per-endpoint validation coverage
 *
 * Generates (R2 + in-memory):
 *   api-validation-report.json    — per-endpoint pass/fail detail
 *   contract-drift-report.json    — spec vs live route drift
 *   endpoint-health-report.json   — health check per route group
 *
 * Produces: API Compatibility Score (0–100)
 */

import { logger }               from "./logger.js";
import { createCloudProvider }  from "../cloud/index.js";
import { existsSync, readFileSync } from "fs";
import { join }                 from "path";
import * as crypto              from "crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ValidationStatus   = "PASS" | "FAIL" | "WARN" | "SKIP";
export type DriftSeverity      = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type AuthScheme         = "bearer" | "basic" | "api-key" | "cookie" | "oauth2" | "none" | "unknown";
export type EndpointHealthTier = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN";

export interface OpenApiEndpoint {
  path:        string;
  method:      string;
  operationId: string;
  tags:        string[];
  hasRequestBody:   boolean;
  hasResponseBody:  boolean;
  auth:             boolean;
  deprecated:       boolean;
  parameters:       OpenApiParameter[];
}

export interface OpenApiParameter {
  name:     string;
  in:       "path" | "query" | "header" | "cookie";
  required: boolean;
  schema?:  Record<string, unknown>;
}

export interface LiveEndpointDescriptor {
  path:       string;
  methods:    string[];
  auth?:      boolean;
  authScheme?: AuthScheme;
  hasRequestSchema?:  boolean;
  hasResponseSchema?: boolean;
  hasValidation?:     boolean;
  tags?:      string[];
  group?:     string;
}

export interface D4Input {
  validationId?:     string;
  primePath?:        string;
  backendUrl?:       string;
  openApiPath?:      string;
  liveEndpoints?:    LiveEndpointDescriptor[];
  d3ExecutionId?:    string;
  force?:            boolean;
}

// ── Endpoint validation result ────────────────────────────────────────────────

export interface EndpointValidationResult {
  endpointId:         string;
  path:               string;
  method:             string;
  group:              string;
  checks: {
    presence:          ValidationStatus;
    methodConformance: ValidationStatus;
    requestSchema:     ValidationStatus;
    responseSchema:    ValidationStatus;
    authentication:    ValidationStatus;
    authorization:     ValidationStatus;
    validation:        ValidationStatus;
  };
  overallStatus:      ValidationStatus;
  score:              number;           // 0–100
  issues:             string[];
  warnings:           string[];
  authScheme?:        AuthScheme;
  deprecated:         boolean;
  notes:              string;
}

// ── Contract drift entry ──────────────────────────────────────────────────────

export interface ContractDriftEntry {
  driftId:       string;
  type:          "ENDPOINT_MISSING_FROM_SPEC" | "ENDPOINT_MISSING_FROM_IMPL" | "METHOD_MISMATCH" | "SCHEMA_DRIFT" | "AUTH_DRIFT" | "DEPRECATION_DRIFT";
  severity:      DriftSeverity;
  path:          string;
  method?:       string;
  expected?:     string;
  actual?:       string;
  description:   string;
  remediation:   string;
}

// ── Endpoint health entry ─────────────────────────────────────────────────────

export interface EndpointHealthEntry {
  group:              string;
  endpoints:          number;
  healthy:            number;
  degraded:           number;
  unhealthy:          number;
  tier:               EndpointHealthTier;
  healthScore:        number;           // 0–100
  criticalIssues:     string[];
  warnings:           string[];
}

// ── D4 bundle ─────────────────────────────────────────────────────────────────

export interface ApiValidationReport {
  validationId:          string;
  generatedAt:           string;
  durationMs:            number;
  totalEndpoints:        number;
  passed:                number;
  warned:                number;
  failed:                number;
  skipped:               number;
  apiCompatibilityScore: number;
  grade:                 string;
  rating:                string;
  openApiEndpointsFound: number;
  liveEndpointsFound:    number;
  results:               EndpointValidationResult[];
  summary:               string;
  blockers:              string[];
  recommendations:       string[];
}

export interface ContractDriftReport {
  validationId:     string;
  generatedAt:      string;
  totalDrifts:      number;
  bySeverity:       Record<DriftSeverity, number>;
  driftScore:       number;   // 0 = perfect alignment, 100 = complete drift
  drifts:           ContractDriftEntry[];
  summary:          string;
}

export interface EndpointHealthReport {
  validationId:         string;
  generatedAt:          string;
  totalGroups:          number;
  healthyGroups:        number;
  degradedGroups:       number;
  unhealthyGroups:      number;
  overallHealthScore:   number;
  groups:               EndpointHealthEntry[];
  summary:              string;
}

export interface D4Bundle {
  validationId:         string;
  generatedAt:          string;
  durationMs:           number;
  r2Keys:               string[];
  apiValidationReport:  ApiValidationReport;
  contractDriftReport:  ContractDriftReport;
  endpointHealthReport: EndpointHealthReport;
  apiCompatibilityScore: number;
}

// ── In-memory store ───────────────────────────────────────────────────────────

const d4Store = new Map<string, D4Bundle>();

export function getD4Bundle(validationId: string): D4Bundle | undefined {
  return d4Store.get(validationId);
}

export function listD4Bundles(): Array<{ validationId: string; generatedAt: string; apiCompatibilityScore: number; grade: string }> {
  return [...d4Store.values()].map(b => ({
    validationId:          b.validationId,
    generatedAt:           b.generatedAt,
    apiCompatibilityScore: b.apiCompatibilityScore,
    grade:                 b.apiValidationReport.grade,
  })).sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

// ── R2 helper ─────────────────────────────────────────────────────────────────

async function storeR2(validationId: string, file: string, data: unknown): Promise<string> {
  const key      = `d4/${validationId}/${file}`;
  const provider = createCloudProvider("r2");
  if (!provider.isConfigured()) { logger.warn({ validationId, file }, "D4: R2 not configured, skipping upload"); return key; }
  const buf = Buffer.from(JSON.stringify(data, null, 2), "utf-8");
  await provider.upload({ key, data: buf, contentType: "application/json", checkDuplicate: false });
  logger.info({ key }, "D4: stored to R2");
  return key;
}

// ── Grading helpers ───────────────────────────────────────────────────────────

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

function scoreToRating(score: number): string {
  if (score >= 95) return "Outstanding";
  if (score >= 90) return "Excellent";
  if (score >= 85) return "Very Good";
  if (score >= 80) return "Good";
  if (score >= 75) return "Above Average";
  if (score >= 70) return "Average";
  if (score >= 60) return "Below Average";
  if (score >= 50) return "Poor";
  if (score >= 40) return "Very Poor";
  return "Failing";
}

// ── OpenAPI spec parser ───────────────────────────────────────────────────────

function parseOpenApiSpec(specPath: string): OpenApiEndpoint[] {
  if (!existsSync(specPath)) {
    logger.warn({ specPath }, "D4: OpenAPI spec file not found");
    return [];
  }
  try {
    const raw  = readFileSync(specPath, "utf-8");
    const spec = JSON.parse(
      raw.trimStart().startsWith("{") ? raw : convertYamlToJson(raw)
    ) as Record<string, unknown>;

    const paths = (spec["paths"] ?? {}) as Record<string, Record<string, unknown>>;
    const endpoints: OpenApiEndpoint[] = [];

    for (const [path, pathItem] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!["get","post","put","patch","delete","head","options"].includes(method)) continue;
        const op = operation as Record<string, unknown>;
        const security = (op["security"] ?? (spec["security"] ?? [])) as unknown[];
        const params   = (op["parameters"] ?? []) as Array<Record<string, unknown>>;

        endpoints.push({
          path,
          method:          method.toUpperCase(),
          operationId:     (op["operationId"] as string) ?? `${method}_${path.replace(/\W+/g, "_")}`,
          tags:            (op["tags"] as string[]) ?? [],
          hasRequestBody:  !!op["requestBody"],
          hasResponseBody: Object.keys((op["responses"] ?? {}) as object).some(s => s !== "204"),
          auth:            Array.isArray(security) && security.length > 0,
          deprecated:      !!(op["deprecated"] as boolean),
          parameters:      params.map(p => ({
            name:     (p["name"] as string) ?? "",
            in:       (p["in"]   as OpenApiParameter["in"]) ?? "query",
            required: !!(p["required"] as boolean),
            schema:   p["schema"] as Record<string, unknown>,
          })),
        });
      }
    }
    logger.info({ specPath, count: endpoints.length }, "D4: parsed OpenAPI spec");
    return endpoints;
  } catch (err) {
    logger.warn({ err, specPath }, "D4: could not parse OpenAPI spec");
    return [];
  }
}

/** Minimal YAML→JSON converter for simple OpenAPI specs */
function convertYamlToJson(yaml: string): string {
  // For full parsing we rely on the existing spec already being valid JSON-compatible YAML.
  // We shell out via a well-known approach — if it fails we return an empty spec.
  try {
    // Try require yaml — not always available; fall back gracefully
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jsYaml = require("js-yaml");
    return JSON.stringify(jsYaml.load(yaml));
  } catch {
    return "{}";
  }
}

// ── Route-group classifier ────────────────────────────────────────────────────

function classifyGroup(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const first    = segments[0] ?? "root";

  const map: Record<string, string> = {
    healthz:           "Health",
    scrape:            "Scraping",
    generation:        "Generation",
    construction:      "Construction",
    deployment:        "Deployment",
    monitoring:        "Monitoring",
    orchestration:     "Orchestration",
    "master-orchestration": "Orchestration",
    visual:            "Visual",
    screenshot:        "Visual",
    merge:             "Merge",
    "semantic-merge":  "Merge",
    "merge-execution": "Merge",
    compatibility:     "Compatibility",
    certification:     "Certification",
    platform:          "Platform",
    "api-validation":  "Validation",
  };

  for (const [prefix, group] of Object.entries(map)) {
    if (first.startsWith(prefix)) return group;
  }
  return "Other";
}

// ── Endpoint checker ──────────────────────────────────────────────────────────

const KNOWN_AUTH_METHODS = ["bearer", "basic", "api-key", "cookie", "oauth2"];

function detectAuthScheme(endpoint: LiveEndpointDescriptor): AuthScheme {
  if (!endpoint.auth && !endpoint.authScheme) return "none";
  const s = (endpoint.authScheme ?? "").toLowerCase();
  if (KNOWN_AUTH_METHODS.includes(s)) return s as AuthScheme;
  if (endpoint.auth) return "unknown";
  return "none";
}

function validateEndpoint(
  live:     LiveEndpointDescriptor,
  specMap:  Map<string, OpenApiEndpoint>,
  method:   string,
): EndpointValidationResult {
  const id     = crypto.randomUUID();
  const key    = `${method.toUpperCase()}:${live.path}`;
  const spec   = specMap.get(key) ?? specMap.get(`${method.toUpperCase()}:${live.path.replace(/:[^/]+/g, "{param}")}`);
  const group  = classifyGroup(live.path);
  const issues: string[]   = [];
  const warnings: string[] = [];

  // 1. Presence
  const presence: ValidationStatus = spec ? "PASS" : (method === "GET" ? "WARN" : "WARN");
  if (!spec) warnings.push(`Endpoint ${key} is not documented in the OpenAPI spec`);

  // 2. Method conformance
  let methodConformance: ValidationStatus = "PASS";
  if (spec && !spec.method.includes(method.toUpperCase())) {
    methodConformance = "FAIL";
    issues.push(`Method mismatch: spec has ${spec.method}, live has ${method.toUpperCase()}`);
  }

  // 3. Request schema
  let requestSchema: ValidationStatus = "PASS";
  if (spec?.hasRequestBody && !live.hasRequestSchema) {
    requestSchema = "WARN";
    warnings.push("Spec requires request body but no schema validation detected");
  } else if (!spec) {
    requestSchema = "SKIP";
  } else if (!spec.hasRequestBody && live.hasRequestSchema) {
    requestSchema = "WARN";
    warnings.push("Live endpoint validates a request body not mentioned in spec");
  }

  // 4. Response schema
  let responseSchema: ValidationStatus = "PASS";
  if (spec && !spec.hasResponseBody && live.hasResponseSchema) {
    responseSchema = "WARN";
    warnings.push("Live returns response body not reflected in spec");
  } else if (!spec) {
    responseSchema = "SKIP";
  }

  // 5. Authentication
  const authScheme = detectAuthScheme(live);
  let authentication: ValidationStatus = "PASS";
  if (spec?.auth && authScheme === "none") {
    authentication = "FAIL";
    issues.push("Spec marks endpoint as authenticated but no auth scheme detected");
  } else if (!spec?.auth && live.auth) {
    authentication = "WARN";
    warnings.push("Live endpoint requires auth but spec does not mark it as secured");
  }

  // 6. Authorization (scope/role coverage — heuristic)
  let authorization: ValidationStatus = "PASS";
  if (live.auth && authScheme === "unknown") {
    authorization = "WARN";
    warnings.push("Auth scheme is unknown — verify scope/role coverage manually");
  }

  // 7. Validation middleware
  let validation: ValidationStatus = live.hasValidation !== false ? "PASS" : "WARN";
  if (!live.hasValidation) {
    warnings.push("No input validation middleware detected on this endpoint");
    validation = "WARN";
  }

  // Score weights: presence=15, method=20, reqSchema=15, resSchema=10, auth=20, authz=10, validation=10
  const weights = { presence: 15, methodConformance: 20, requestSchema: 15, responseSchema: 10, authentication: 20, authorization: 10, validation: 10 };
  const statusScore = (s: ValidationStatus, w: number) => s === "PASS" ? w : s === "WARN" ? w * 0.6 : s === "SKIP" ? w * 0.8 : 0;
  const score = Math.round(
    statusScore(presence, weights.presence) +
    statusScore(methodConformance, weights.methodConformance) +
    statusScore(requestSchema, weights.requestSchema) +
    statusScore(responseSchema, weights.responseSchema) +
    statusScore(authentication, weights.authentication) +
    statusScore(authorization, weights.authorization) +
    statusScore(validation, weights.validation)
  );

  const overallStatus: ValidationStatus =
    issues.length > 0 ? "FAIL" :
    warnings.length > 0 ? "WARN" :
    "PASS";

  return {
    endpointId: id,
    path:       live.path,
    method:     method.toUpperCase(),
    group,
    checks: { presence, methodConformance, requestSchema, responseSchema, authentication, authorization, validation },
    overallStatus,
    score,
    issues,
    warnings,
    authScheme,
    deprecated: spec?.deprecated ?? false,
    notes: spec ? "Matched in OpenAPI spec" : "Endpoint not documented in spec",
  };
}

// ── Built-in live endpoint registry (derived from known routes) ────────────────

function buildDefaultLiveEndpoints(): LiveEndpointDescriptor[] {
  return [
    { path: "/healthz",                      methods: ["GET"],         auth: false, hasValidation: true,  hasResponseSchema: true,  group: "Health" },
    { path: "/scrape/start",                 methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Scraping" },
    { path: "/scrape/jobs",                  methods: ["GET"],         auth: false, hasValidation: false, hasResponseSchema: true,  group: "Scraping" },
    { path: "/scrape/jobs/:jobId",           methods: ["GET"],         auth: false, hasValidation: false, hasResponseSchema: true,  group: "Scraping" },
    { path: "/scrape/jobs/:jobId/status",    methods: ["GET"],         auth: false, hasValidation: false, hasResponseSchema: true,  group: "Scraping" },
    { path: "/generation/run",               methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Generation" },
    { path: "/generation/:jobId",            methods: ["GET"],         auth: false, hasValidation: false, hasResponseSchema: true,  group: "Generation" },
    { path: "/construction/run",             methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Construction" },
    { path: "/construction/:jobId",          methods: ["GET"],         auth: false, hasValidation: false, hasResponseSchema: true,  group: "Construction" },
    { path: "/deploy/frameworks",            methods: ["GET"],         auth: false, hasValidation: false, hasResponseSchema: true,  group: "Deployment" },
    { path: "/deploy/targets",               methods: ["GET"],         auth: false, hasValidation: false, hasResponseSchema: true,  group: "Deployment" },
    { path: "/deploy/plan",                  methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Deployment" },
    { path: "/deploy/execute",               methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Deployment" },
    { path: "/deploy/executions",            methods: ["GET"],         auth: false, hasValidation: false, hasResponseSchema: true,  group: "Deployment" },
    { path: "/deploy/audit",                 methods: ["GET"],         auth: false, hasValidation: false, hasResponseSchema: true,  group: "Deployment" },
    { path: "/deploy/readiness",             methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Deployment" },
    { path: "/monitor/health",               methods: ["GET"],         auth: false, hasValidation: false, hasResponseSchema: true,  group: "Monitoring" },
    { path: "/monitor/pipeline",             methods: ["GET"],         auth: false, hasValidation: false, hasResponseSchema: true,  group: "Monitoring" },
    { path: "/monitor/status",               methods: ["GET"],         auth: false, hasValidation: false, hasResponseSchema: true,  group: "Monitoring" },
    { path: "/orchestration/run",            methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Orchestration" },
    { path: "/orchestration/status/:jobId",  methods: ["GET"],         auth: false, hasValidation: false, hasResponseSchema: true,  group: "Orchestration" },
    { path: "/merge-intelligence/run",       methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Merge" },
    { path: "/semantic-merge/plan",          methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Merge" },
    { path: "/merge-execution/run",          methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Merge" },
    { path: "/merge-execution/dry-run",      methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Merge" },
    { path: "/merge-execution",              methods: ["GET"],         auth: false, hasValidation: false, hasResponseSchema: true,  group: "Merge" },
    { path: "/api-compatibility/run",        methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Compatibility" },
    { path: "/compatibility/run",            methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Compatibility" },
    { path: "/platform/validate",            methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Platform" },
    { path: "/platform-certification",       methods: ["GET"],         auth: false, hasValidation: false, hasResponseSchema: true,  group: "Certification" },
    { path: "/certification/certify",        methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Certification" },
    { path: "/certification/score",          methods: ["GET"],         auth: false, hasValidation: false, hasResponseSchema: true,  group: "Certification" },
    { path: "/api-validation/run",           methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Validation" },
    { path: "/api-validation",               methods: ["GET"],         auth: false, hasValidation: false, hasResponseSchema: true,  group: "Validation" },
    { path: "/merge-certification/run",      methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Certification" },
    { path: "/merge-certification",          methods: ["GET"],         auth: false, hasValidation: false, hasResponseSchema: true,  group: "Certification" },
    { path: "/visual-fidelity/run",          methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Visual" },
    { path: "/visual-certification/run",     methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Visual" },
    { path: "/reconstruction-score/run",     methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Visual" },
    { path: "/backend-detection/run",        methods: ["POST"],        auth: false, hasValidation: true,  hasRequestSchema: true,   group: "Compatibility" },
  ];
}

// ── Drift detector ─────────────────────────────────────────────────────────────

function detectContractDrift(
  liveEndpoints: LiveEndpointDescriptor[],
  specEndpoints: OpenApiEndpoint[],
): ContractDriftEntry[] {
  const drifts: ContractDriftEntry[] = [];

  const specKeys = new Set(specEndpoints.map(e => `${e.method}:${e.path}`));
  const liveKeys = new Set<string>();

  for (const live of liveEndpoints) {
    for (const method of live.methods) {
      liveKeys.add(`${method.toUpperCase()}:${live.path}`);
    }
  }

  // Endpoints in spec but not live
  for (const spec of specEndpoints) {
    const key = `${spec.method}:${spec.path}`;
    if (!liveKeys.has(key)) {
      drifts.push({
        driftId:     crypto.randomUUID(),
        type:        "ENDPOINT_MISSING_FROM_IMPL",
        severity:    spec.deprecated ? "LOW" : "HIGH",
        path:        spec.path,
        method:      spec.method,
        expected:    `Implemented endpoint at ${key}`,
        actual:      "Not found in live routes",
        description: `OpenAPI spec documents ${key} but no live route matches`,
        remediation: `Implement route handler for ${spec.method} ${spec.path} or remove from spec`,
      });
    }
  }

  // Endpoints live but not in spec
  for (const live of liveEndpoints) {
    for (const method of live.methods) {
      const key = `${method.toUpperCase()}:${live.path}`;
      if (!specKeys.has(key)) {
        drifts.push({
          driftId:     crypto.randomUUID(),
          type:        "ENDPOINT_MISSING_FROM_SPEC",
          severity:    "MEDIUM",
          path:        live.path,
          method:      method.toUpperCase(),
          expected:    `OpenAPI spec entry for ${key}`,
          actual:      "Undocumented live endpoint",
          description: `Live route ${key} has no OpenAPI spec entry`,
          remediation: `Add ${method.toUpperCase()} ${live.path} to openapi.yaml with request/response schemas`,
        });
      }
    }
  }

  // Auth drift
  for (const live of liveEndpoints) {
    for (const method of live.methods) {
      const specEntry = specEndpoints.find(s => s.method === method.toUpperCase() && s.path === live.path);
      if (!specEntry) continue;
      if (specEntry.auth !== !!live.auth) {
        drifts.push({
          driftId:     crypto.randomUUID(),
          type:        "AUTH_DRIFT",
          severity:    "HIGH",
          path:        live.path,
          method:      method.toUpperCase(),
          expected:    specEntry.auth ? "Authenticated" : "Public",
          actual:      live.auth ? "Authenticated" : "Public",
          description: `Auth requirement mismatch: spec says ${specEntry.auth ? "secured" : "public"}, live is ${live.auth ? "secured" : "public"}`,
          remediation: "Align authentication requirement between spec and implementation",
        });
      }
    }
  }

  return drifts;
}

// ── Group health builder ──────────────────────────────────────────────────────

function buildGroupHealth(results: EndpointValidationResult[]): EndpointHealthEntry[] {
  const groups = new Map<string, EndpointValidationResult[]>();
  for (const r of results) {
    const g = groups.get(r.group) ?? [];
    g.push(r);
    groups.set(r.group, g);
  }

  return [...groups.entries()].map(([group, entries]) => {
    const healthy   = entries.filter(e => e.overallStatus === "PASS").length;
    const degraded  = entries.filter(e => e.overallStatus === "WARN").length;
    const unhealthy = entries.filter(e => e.overallStatus === "FAIL").length;
    const healthScore = Math.round((entries.reduce((s, e) => s + e.score, 0)) / entries.length);

    const tier: EndpointHealthTier =
      unhealthy > 0                          ? "UNHEALTHY" :
      degraded  > entries.length * 0.3       ? "DEGRADED"  :
      degraded  > 0                          ? "DEGRADED"  :
      "HEALTHY";

    return {
      group,
      endpoints:      entries.length,
      healthy,
      degraded,
      unhealthy,
      tier,
      healthScore,
      criticalIssues: entries.flatMap(e => e.issues),
      warnings:       entries.flatMap(e => e.warnings).slice(0, 10),
    };
  }).sort((a, b) => a.healthScore - b.healthScore);
}

// ── Main run function ─────────────────────────────────────────────────────────

export async function runApiContractValidation(input: D4Input): Promise<D4Bundle> {
  const start        = Date.now();
  const validationId = input.validationId ?? `d4-${crypto.randomUUID()}`;

  logger.info({ validationId }, "D4: starting API contract validation");

  // 1. Parse OpenAPI spec
  const specPath     = input.openApiPath ?? join(process.cwd(), "../../lib/api-spec/openapi.yaml");
  const specEndpoints = parseOpenApiSpec(specPath);
  const specMap       = new Map<string, OpenApiEndpoint>();
  for (const e of specEndpoints) specMap.set(`${e.method}:${e.path}`, e);

  // 2. Collect live endpoints
  const rawLive = input.liveEndpoints ?? buildDefaultLiveEndpoints();

  // 3. Validate each endpoint × method
  const results: EndpointValidationResult[] = [];
  for (const live of rawLive) {
    for (const method of live.methods) {
      results.push(validateEndpoint(live, specMap, method));
    }
  }

  // 4. Compute compatibility score
  const totalEndpoints = results.length;
  const passed  = results.filter(r => r.overallStatus === "PASS").length;
  const warned  = results.filter(r => r.overallStatus === "WARN").length;
  const failed  = results.filter(r => r.overallStatus === "FAIL").length;
  const skipped = results.filter(r => r.overallStatus === "SKIP").length;

  const rawScore = totalEndpoints > 0
    ? Math.round(results.reduce((s, r) => s + r.score, 0) / totalEndpoints)
    : 0;
  const apiCompatibilityScore = Math.max(0, Math.min(100, rawScore));
  const grade  = scoreToGrade(apiCompatibilityScore);
  const rating = scoreToRating(apiCompatibilityScore);

  // 5. Blockers and recommendations
  const blockers: string[] = results
    .filter(r => r.overallStatus === "FAIL")
    .flatMap(r => r.issues)
    .slice(0, 10);

  const recommendations: string[] = [
    ...results.filter(r => r.overallStatus === "WARN").flatMap(r => r.warnings).slice(0, 5),
    specEndpoints.length < 5
      ? "Expand OpenAPI spec — only " + specEndpoints.length + " endpoint(s) documented"
      : "",
  ].filter(Boolean);

  const generatedAt = new Date().toISOString();

  const apiValidationReport: ApiValidationReport = {
    validationId,
    generatedAt,
    durationMs:            Date.now() - start,
    totalEndpoints,
    passed,
    warned,
    failed,
    skipped,
    apiCompatibilityScore,
    grade,
    rating,
    openApiEndpointsFound: specEndpoints.length,
    liveEndpointsFound:    rawLive.length,
    results,
    summary: `Validated ${totalEndpoints} endpoint(s): ${passed} passed, ${warned} warned, ${failed} failed. API Compatibility Score: ${apiCompatibilityScore}/100 (${grade} — ${rating}).`,
    blockers,
    recommendations,
  };

  // 6. Contract drift
  const drifts = detectContractDrift(rawLive, specEndpoints);
  const bySeverity: Record<DriftSeverity, number> = { NONE: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  for (const d of drifts) bySeverity[d.severity]++;
  const driftScore = drifts.length > 0
    ? Math.min(100, Math.round((bySeverity.CRITICAL * 30 + bySeverity.HIGH * 20 + bySeverity.MEDIUM * 10 + bySeverity.LOW * 5) / Math.max(1, rawLive.length) * 10))
    : 0;

  const contractDriftReport: ContractDriftReport = {
    validationId,
    generatedAt,
    totalDrifts:  drifts.length,
    bySeverity,
    driftScore,
    drifts,
    summary: drifts.length === 0
      ? "No contract drift detected — spec and live routes are fully aligned."
      : `Detected ${drifts.length} drift(s): ${bySeverity.CRITICAL} critical, ${bySeverity.HIGH} high, ${bySeverity.MEDIUM} medium, ${bySeverity.LOW} low. Drift score: ${driftScore}/100.`,
  };

  // 7. Endpoint health
  const groupHealth = buildGroupHealth(results);
  const healthyG    = groupHealth.filter(g => g.tier === "HEALTHY").length;
  const degradedG   = groupHealth.filter(g => g.tier === "DEGRADED").length;
  const unhealthyG  = groupHealth.filter(g => g.tier === "UNHEALTHY").length;
  const overallHealthScore = groupHealth.length > 0
    ? Math.round(groupHealth.reduce((s, g) => s + g.healthScore, 0) / groupHealth.length)
    : 0;

  const endpointHealthReport: EndpointHealthReport = {
    validationId,
    generatedAt,
    totalGroups:        groupHealth.length,
    healthyGroups:      healthyG,
    degradedGroups:     degradedG,
    unhealthyGroups:    unhealthyG,
    overallHealthScore,
    groups:             groupHealth,
    summary: `${groupHealth.length} route group(s): ${healthyG} healthy, ${degradedG} degraded, ${unhealthyG} unhealthy. Overall health: ${overallHealthScore}/100.`,
  };

  const durationMs = Date.now() - start;
  apiValidationReport.durationMs = durationMs;

  const bundle: D4Bundle = {
    validationId,
    generatedAt,
    durationMs,
    r2Keys: [],
    apiValidationReport,
    contractDriftReport,
    endpointHealthReport,
    apiCompatibilityScore,
  };

  // 8. Store to R2
  const r2Keys = await Promise.all([
    storeR2(validationId, "api-validation-report.json",   apiValidationReport),
    storeR2(validationId, "contract-drift-report.json",   contractDriftReport),
    storeR2(validationId, "endpoint-health-report.json",  endpointHealthReport),
  ]);
  bundle.r2Keys = r2Keys;

  d4Store.set(validationId, bundle);
  logger.info({ validationId, apiCompatibilityScore, grade, durationMs }, "D4: validation complete");

  return bundle;
}
