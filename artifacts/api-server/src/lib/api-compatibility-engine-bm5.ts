/**
 * api-compatibility-engine-bm5.ts — Phase BM-5: API Compatibility Engine
 *
 * Analyzes existing backend APIs and classifies each endpoint so the
 * generated frontend (Website Prime) can consume them without breaking behavior.
 *
 * Detects:
 *   REST endpoints   — GET/POST/PUT/PATCH/DELETE/HEAD
 *   GraphQL          — /graphql endpoint, schema introspection
 *   RPC              — tRPC routers, gRPC services, JSON-RPC
 *   Webhooks         — inbound webhook receivers (/webhooks/*, /hooks/*)
 *
 * Classifies each endpoint as:
 *   KEEP     — prime can call this endpoint exactly as-is
 *   EXTEND   — endpoint works but prime needs to add query params / headers
 *   REPLACE  — endpoint is incompatible; prime needs its own implementation
 *   BLOCK    — endpoint must NOT be called by the prime (breaks behavior)
 *
 * Outputs (disk + R2):
 *   api-compatibility-report.json
 *
 * Success criteria:
 *   Generated frontend can consume existing APIs without breaking behavior.
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join }                        from "path";
import { logger }                      from "./logger.js";
import { getDefaultCloudProvider }     from "../cloud/index.js";

// ---------------------------------------------------------------------------
// API protocol taxonomy
// ---------------------------------------------------------------------------

export type ApiProtocol = "rest" | "graphql" | "trpc" | "grpc" | "jsonrpc" | "webhook" | "unknown";
export type ApiClassification = "KEEP" | "EXTEND" | "REPLACE" | "BLOCK";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "ANY";
export type BreakingRisk = "none" | "low" | "medium" | "high" | "critical";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ApiEndpointDescriptor {
  id?:            string;
  protocol:       ApiProtocol;
  path:           string;
  methods:        HttpMethod[];
  description?:   string;
  auth?:          boolean;
  authScheme?:    string;        // bearer, basic, api-key, cookie, none
  requestSchema?: Record<string, unknown>;
  responseSchema?: Record<string, unknown>;
  deprecated?:    boolean;
  version?:       string;
  tags?:          string[];
  rateLimit?:     number;
  sideEffects?:   boolean;      // true if POST/PUT/DELETE that mutates state
  webhookSource?: string;       // for webhooks: "stripe", "github", etc.
}

export interface ApiCompatibilityInput {
  primeJobId:    string;
  backendJobId?: string;
  force?:        boolean;
  endpoints?:    ApiEndpointDescriptor[];
  primeUrl?:     string;
  backendUrl?:   string;
}

// ---------------------------------------------------------------------------
// Endpoint assessment
// ---------------------------------------------------------------------------

export interface EndpointAssessment {
  id:               string;
  endpoint:         ApiEndpointDescriptor;
  classification:   ApiClassification;
  protocol:         ApiProtocol;
  breakingRisk:     BreakingRisk;
  calledByPrime:    boolean;
  primeAccessPattern?: string;   // how the prime should call this endpoint
  issues:           string[];
  recommendations:  string[];
  adapterRequired:  boolean;
  adapterNote?:     string;
  corsRequired:     boolean;
  rateLimitRisk:    boolean;
  authRequired:     boolean;
}

// ---------------------------------------------------------------------------
// Protocol summary
// ---------------------------------------------------------------------------

export interface ProtocolSummary {
  protocol:     ApiProtocol;
  totalCount:   number;
  keepCount:    number;
  extendCount:  number;
  replaceCount: number;
  blockCount:   number;
  endpoints:    EndpointAssessment[];
  compatible:   boolean;
  notes:        string[];
}

// ---------------------------------------------------------------------------
// Output — api-compatibility-report.json
// ---------------------------------------------------------------------------

export interface ApiCompatibilityReport {
  schemaVersion:    "BM-5";
  primeJobId:       string;
  backendJobId:     string;
  generatedAt:      string;
  durationMs:       number;
  totalEndpoints:   number;
  compatibilityScore: number;    // 0–100; 100 = all endpoints KEEP
  grade:            "A" | "B" | "C" | "D" | "F";
  frontendCanConsume: boolean;   // true when no BLOCK items exist
  protocols:        Record<ApiProtocol, ProtocolSummary>;
  assessments:      EndpointAssessment[];
  // Flattened views
  keep:             EndpointAssessment[];
  extend:           EndpointAssessment[];
  replace:          EndpointAssessment[];
  block:            EndpointAssessment[];
  summary: {
    keepCount:        number;
    extendCount:      number;
    replaceCount:     number;
    blockCount:       number;
    adaptersNeeded:   number;
    corsIssues:       number;
    authGatedCount:   number;
    webhookCount:     number;
    deprecatedCount:  number;
    criticalBlocks:   string[];
    recommendation:   string;
  };
  r2Key?: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const _cache = new Map<string, ApiCompatibilityReport>();

export function getCachedApiCompatibilityReport(primeJobId: string): ApiCompatibilityReport | undefined {
  return _cache.get(primeJobId);
}

// ---------------------------------------------------------------------------
// ID generator
// ---------------------------------------------------------------------------

let _seq = 0;
function nextId(): string { return `API-${String(++_seq).padStart(4, "0")}`; }

// ---------------------------------------------------------------------------
// Classification rules
// ---------------------------------------------------------------------------

function classifyRestEndpoint(ep: ApiEndpointDescriptor): ApiClassification {
  // Webhooks that receive inbound events must never be called by the prime
  if (ep.path.match(/\/(webhooks?|hooks?|events?)\//) || ep.webhookSource) return "BLOCK";

  // Deprecated endpoints → REPLACE (build a new call to a non-deprecated version)
  if (ep.deprecated) return "REPLACE";

  // Write endpoints that mutate state → KEEP if safe, EXTEND if needs extra headers
  if (ep.sideEffects && ep.auth && ep.authScheme === "bearer") return "KEEP";

  // Auth-gated reads → KEEP (prime should pass the auth token through)
  if (ep.auth && ep.methods.some(m => m === "GET" || m === "HEAD")) return "KEEP";

  // Public reads → KEEP unconditionally
  if (!ep.auth && ep.methods.includes("GET")) return "KEEP";

  // Versioned endpoints where prime is on a different version → EXTEND
  if (ep.version && !ep.path.includes(ep.version)) return "EXTEND";

  // Internal-only or admin routes → BLOCK
  if (ep.path.match(/\/(internal|admin|management|_internal)\//)) return "BLOCK";

  // Everything else → EXTEND (assume minor adjustments needed)
  return "EXTEND";
}

function classifyGraphQLEndpoint(ep: ApiEndpointDescriptor): ApiClassification {
  // Mutations with side effects → KEEP (prime can send the mutation)
  if (ep.sideEffects) return "KEEP";

  // Subscription endpoints → REPLACE (prime may not support WS)
  if (ep.path.includes("subscription") || (ep.tags ?? []).includes("subscription")) return "REPLACE";

  // Standard queries → KEEP
  return "KEEP";
}

function classifyRpcEndpoint(ep: ApiEndpointDescriptor): ApiClassification {
  // tRPC / gRPC procedures: if they have auth requirements the prime can satisfy → KEEP
  if (ep.auth && ep.authScheme === "bearer") return "KEEP";
  if (ep.auth) return "EXTEND";    // prime may need to add auth headers

  // Internal gRPC services → BLOCK (not callable from browser)
  if (ep.protocol === "grpc") return "BLOCK";

  return "KEEP";
}

function classifyWebhook(ep: ApiEndpointDescriptor): ApiClassification {
  // Inbound webhooks are receivers; prime should NEVER call them directly
  return "BLOCK";
}

function classifyEndpoint(ep: ApiEndpointDescriptor): ApiClassification {
  switch (ep.protocol) {
    case "rest":     return classifyRestEndpoint(ep);
    case "graphql":  return classifyGraphQLEndpoint(ep);
    case "trpc":     return classifyRpcEndpoint(ep);
    case "grpc":     return classifyRpcEndpoint(ep);
    case "jsonrpc":  return classifyRpcEndpoint(ep);
    case "webhook":  return classifyWebhook(ep);
    default:         return "EXTEND";
  }
}

// ---------------------------------------------------------------------------
// Breaking risk assessment
// ---------------------------------------------------------------------------

function assessBreakingRisk(ep: ApiEndpointDescriptor, cls: ApiClassification): BreakingRisk {
  if (cls === "BLOCK")   return "critical";
  if (cls === "REPLACE") return ep.sideEffects ? "high" : "medium";
  if (cls === "EXTEND")  return ep.auth ? "medium" : "low";
  return "none";
}

// ---------------------------------------------------------------------------
// Issues & recommendations
// ---------------------------------------------------------------------------

function buildIssues(ep: ApiEndpointDescriptor, cls: ApiClassification): string[] {
  const issues: string[] = [];
  if (ep.deprecated)    issues.push(`Endpoint is deprecated${ep.version ? ` (version: ${ep.version})` : ""}`);
  if (ep.webhookSource) issues.push(`Inbound webhook from ${ep.webhookSource} — must not be called by prime`);
  if (ep.path.match(/\/(internal|admin|management|_internal)\//)) {
    issues.push("Internal/admin route — prime must not expose or call this endpoint");
  }
  if (ep.auth && !ep.authScheme) {
    issues.push("Auth-gated endpoint with unknown auth scheme — prime may not be able to authenticate");
  }
  if (ep.protocol === "grpc") {
    issues.push("gRPC endpoint — browser cannot call gRPC directly without a transcoding layer (e.g. grpc-web)");
  }
  if (ep.rateLimit && ep.rateLimit < 10) {
    issues.push(`Aggressive rate limit (${ep.rateLimit} req/min) — prime must implement client-side throttling`);
  }
  if (cls === "REPLACE") {
    issues.push("Endpoint is incompatible with the prime's access pattern — a replacement implementation is needed");
  }
  return issues;
}

function buildRecommendations(ep: ApiEndpointDescriptor, cls: ApiClassification): string[] {
  const recs: string[] = [];
  switch (cls) {
    case "KEEP":
      recs.push(`Call ${ep.methods[0]} ${ep.path} directly from prime components`);
      if (ep.auth) recs.push(`Pass ${ep.authScheme ?? "auth"} credentials via request header`);
      break;
    case "EXTEND":
      recs.push(`Call ${ep.path} but add the following before the request:`);
      if (ep.version) recs.push(`  — Include version header: X-API-Version: ${ep.version}`);
      if (ep.auth)    recs.push(`  — Add auth header: Authorization: ${ep.authScheme ?? "Bearer"} <token>`);
      recs.push(`  — Verify CORS headers allow the prime's origin`);
      break;
    case "REPLACE":
      if (ep.deprecated) {
        recs.push(`Find the non-deprecated replacement for ${ep.path} and update prime to use it`);
      } else {
        recs.push(`Implement a prime-side equivalent for the functionality provided by ${ep.path}`);
      }
      break;
    case "BLOCK":
      if (ep.webhookSource || ep.path.match(/\/(webhooks?|hooks?)\//)) {
        recs.push(`Never call ${ep.path} from prime — it is an inbound webhook receiver`);
        recs.push("Remove any generated client calls to this endpoint");
      } else {
        recs.push(`Do not expose or call ${ep.path} — it is an internal/privileged endpoint`);
      }
      break;
  }
  return recs;
}

// ---------------------------------------------------------------------------
// Build assessment
// ---------------------------------------------------------------------------

function buildAssessment(ep: ApiEndpointDescriptor): EndpointAssessment {
  const cls      = classifyEndpoint(ep);
  const risk     = assessBreakingRisk(ep, cls);
  const issues   = buildIssues(ep, cls);
  const recs     = buildRecommendations(ep, cls);

  const adapterRequired = cls === "EXTEND" || ep.protocol === "grpc";
  let adapterNote: string | undefined;
  if (adapterRequired) {
    if (ep.protocol === "grpc") {
      adapterNote = "grpc-web proxy or Envoy transcoder required between prime and gRPC service";
    } else if (cls === "EXTEND") {
      adapterNote = "HTTP interceptor / wrapper function to inject required headers/params before calling";
    }
  }

  const primeAccessPattern =
    cls === "KEEP"    ? `${ep.methods[0]} ${ep.path}${ep.auth ? " [with auth]" : ""}` :
    cls === "EXTEND"  ? `${ep.methods[0]} ${ep.path} [with adapter]` :
    cls === "REPLACE" ? `[implement locally — do not call ${ep.path}]` :
                        `[BLOCKED — do not call]`;

  return {
    id:               ep.id ?? nextId(),
    endpoint:         ep,
    classification:   cls,
    protocol:         ep.protocol,
    breakingRisk:     risk,
    calledByPrime:    cls !== "BLOCK",
    primeAccessPattern,
    issues,
    recommendations:  recs,
    adapterRequired,
    adapterNote,
    corsRequired:     cls !== "BLOCK",
    rateLimitRisk:    !!ep.rateLimit && ep.rateLimit < 60,
    authRequired:     !!ep.auth,
  };
}

// ---------------------------------------------------------------------------
// Protocol summary builder
// ---------------------------------------------------------------------------

function buildProtocolSummary(
  protocol: ApiProtocol,
  assessments: EndpointAssessment[],
): ProtocolSummary {
  const eps   = assessments.filter(a => a.protocol === protocol);
  const notes: string[] = [];

  if (protocol === "graphql" && eps.length > 0) {
    notes.push("GraphQL endpoint detected — prime should use generated typed hooks (e.g. from GraphQL codegen)");
  }
  if (protocol === "grpc" && eps.length > 0) {
    notes.push("gRPC endpoints are browser-incompatible — a grpc-web transcoding layer is required");
  }
  if (protocol === "webhook" && eps.length > 0) {
    notes.push(`${eps.length} inbound webhook endpoint(s) detected — BLOCKED from prime calls`);
  }

  return {
    protocol,
    totalCount:   eps.length,
    keepCount:    eps.filter(a => a.classification === "KEEP").length,
    extendCount:  eps.filter(a => a.classification === "EXTEND").length,
    replaceCount: eps.filter(a => a.classification === "REPLACE").length,
    blockCount:   eps.filter(a => a.classification === "BLOCK").length,
    endpoints:    eps,
    compatible:   !eps.some(a => a.classification === "BLOCK"),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function computeScore(assessments: EndpointAssessment[]): number {
  if (!assessments.length) return 100;
  const total = assessments.length;
  const score = assessments.reduce((sum, a) => {
    const pts =
      a.classification === "KEEP"    ? 100 :
      a.classification === "EXTEND"  ?  75 :
      a.classification === "REPLACE" ?  40 :
      /* BLOCK */                        0;
    return sum + pts;
  }, 0);
  return Math.round(score / total);
}

function grade(score: number): ApiCompatibilityReport["grade"] {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

// ---------------------------------------------------------------------------
// Default endpoint list (used when nothing is provided)
// ---------------------------------------------------------------------------

function buildDefaultEndpoints(): ApiEndpointDescriptor[] {
  return [];
}

// ---------------------------------------------------------------------------
// Disk / R2 helpers
// ---------------------------------------------------------------------------

async function loadFromDisk<T>(jobId: string, filename: string): Promise<T | null> {
  for (const dir of ["/tmp/bm5", "/tmp/bm4", "/tmp/bm1"]) {
    try {
      const raw = await readFile(join(dir, jobId, filename), "utf8");
      return JSON.parse(raw) as T;
    } catch { /* next */ }
  }
  return null;
}

async function saveToDisk(jobId: string, report: ApiCompatibilityReport): Promise<void> {
  const dir = join("/tmp/bm5", jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "api-compatibility-report.json"), JSON.stringify(report, null, 2));
}

async function saveToR2(jobId: string, report: ApiCompatibilityReport): Promise<string | undefined> {
  try {
    const cloud = getDefaultCloudProvider();
    const key   = `bm5/${jobId}/api-compatibility-report.json`;
    await cloud.upload({ key, data: Buffer.from(JSON.stringify(report, null, 2)), contentType: "application/json" });
    return key;
  } catch (err) {
    logger.warn({ err, jobId }, "BM5: R2 upload failed (non-fatal)");
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

export async function runApiCompatibilityEngine(
  input: ApiCompatibilityInput,
): Promise<ApiCompatibilityReport> {
  const { primeJobId, backendJobId = "unknown", force = false } = input;
  const t0 = Date.now();

  if (!force) {
    const cached = _cache.get(primeJobId);
    if (cached) {
      logger.info({ primeJobId }, "BM5: returning cached report");
      return cached;
    }
  }

  logger.info({ primeJobId, backendJobId }, "BM5: API compatibility analysis started");

  // Resolve endpoints
  let endpoints: ApiEndpointDescriptor[] = input.endpoints ?? [];
  if (!endpoints.length) {
    const loaded = await loadFromDisk<ApiEndpointDescriptor[]>(primeJobId, "endpoints.json");
    endpoints = loaded ?? buildDefaultEndpoints();
  }

  // Assign IDs if missing
  endpoints = endpoints.map((ep, i) => ({ ...ep, id: ep.id ?? `API-${String(i + 1).padStart(4, "0")}` }));

  // Build assessments
  const assessments = endpoints.map(buildAssessment);

  // Protocol summaries
  const allProtocols: ApiProtocol[] = ["rest", "graphql", "trpc", "grpc", "jsonrpc", "webhook", "unknown"];
  const protocols = Object.fromEntries(
    allProtocols.map(p => [p, buildProtocolSummary(p, assessments)])
  ) as Record<ApiProtocol, ProtocolSummary>;

  // Classify views
  const keep    = assessments.filter(a => a.classification === "KEEP");
  const extend  = assessments.filter(a => a.classification === "EXTEND");
  const replace = assessments.filter(a => a.classification === "REPLACE");
  const block   = assessments.filter(a => a.classification === "BLOCK");

  const compatibilityScore = computeScore(assessments);
  const frontendCanConsume  = block.length === 0;

  const criticalBlocks = block
    .filter(a => a.breakingRisk === "critical")
    .map(a => a.id);

  const recommendation =
    !frontendCanConsume ? `${block.length} BLOCKED endpoint(s) detected — prime must not call them. Review and remove before deployment.` :
    replace.length > 0  ? `${replace.length} endpoint(s) need replacement implementations in the prime.` :
    extend.length  > 0  ? `${extend.length} endpoint(s) require adapters or additional headers — implement before release.` :
                          "All endpoints are KEEP-compatible. Prime can consume existing APIs without changes.";

  const report: ApiCompatibilityReport = {
    schemaVersion:      "BM-5",
    primeJobId,
    backendJobId,
    generatedAt:        new Date().toISOString(),
    durationMs:         Date.now() - t0,
    totalEndpoints:     assessments.length,
    compatibilityScore,
    grade:              grade(compatibilityScore),
    frontendCanConsume,
    protocols,
    assessments,
    keep,
    extend,
    replace,
    block,
    summary: {
      keepCount:        keep.length,
      extendCount:      extend.length,
      replaceCount:     replace.length,
      blockCount:       block.length,
      adaptersNeeded:   assessments.filter(a => a.adapterRequired).length,
      corsIssues:       assessments.filter(a => a.corsRequired && a.classification !== "BLOCK").length,
      authGatedCount:   assessments.filter(a => a.authRequired).length,
      webhookCount:     assessments.filter(a => a.protocol === "webhook").length,
      deprecatedCount:  endpoints.filter(ep => ep.deprecated).length,
      criticalBlocks,
      recommendation,
    },
  };

  // Persist
  try {
    await saveToDisk(primeJobId, report);
    const r2Key = await saveToR2(primeJobId, report);
    if (r2Key) report.r2Key = r2Key;
  } catch (err) {
    logger.warn({ err, primeJobId }, "BM5: persistence failed (non-fatal)");
  }

  _cache.set(primeJobId, report);
  logger.info(
    { primeJobId, score: compatibilityScore, keep: keep.length, extend: extend.length, replace: replace.length, block: block.length },
    "BM5: API compatibility analysis complete",
  );

  return report;
}
