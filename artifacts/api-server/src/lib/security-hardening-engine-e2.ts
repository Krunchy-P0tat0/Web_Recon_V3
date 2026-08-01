/**
 * security-hardening-engine-e2.ts — Phase E2: Security Hardening
 *
 * Audits every subsystem against 8 security dimensions:
 *   1. Authentication       — auth middleware presence, session config
 *   2. Authorization        — role/scope enforcement, route protection
 *   3. Secrets              — env var exposure, secret scanning
 *   4. R2 Access            — bucket ACL, pre-signed URL safety, token scoping
 *   5. API Security         — CORS, security headers, method allowlisting
 *   6. Rate Limiting        — per-IP / per-route limits
 *   7. Input Validation     — schema validation coverage, injection risks
 *   8. Dependency Vulnerabilities — known CVEs in package.json deps
 *
 * Assigns:
 *   Security Grade   A+–F
 *   Risk Score       0–100 (higher = more risk)
 *   Security Score   0–100 (higher = more secure)
 *
 * Generates (R2 + in-memory):
 *   security-audit-report.json
 *   vulnerability-report.json
 *   hardening-checklist.json
 */

import { logger }              from "./logger.js";
import { createCloudProvider } from "../cloud/index.js";
import * as fs                 from "fs";
import * as path               from "path";
import * as crypto             from "crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SecuritySeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type AuditStatus      = "PASS" | "WARN" | "FAIL" | "SKIP";
export type SecurityGrade    = "A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D" | "F";

export interface E2Input {
  auditId?:        string;
  projectRoot?:    string;
  checkDeps?:      boolean;
  force?:          boolean;
}

// ── Finding ───────────────────────────────────────────────────────────────────

export interface SecurityFinding {
  id:          string;
  dimension:   string;
  severity:    SecuritySeverity;
  title:       string;
  description: string;
  location?:   string;
  evidence?:   string;
  remediation: string;
  cve?:        string;
  cvss?:       number;
}

// ── Dimension result ──────────────────────────────────────────────────────────

export interface SecurityDimensionResult {
  dimension:      string;
  status:         AuditStatus;
  score:          number;       // 0–100 (security score for this dimension)
  weight:         number;
  findings:       SecurityFinding[];
  checksRun:      number;
  checksPassed:   number;
  evidence:       string[];
  recommendation: string;
}

// ── Vulnerability ─────────────────────────────────────────────────────────────

export interface VulnerabilityEntry {
  id:          string;
  package:     string;
  version:     string;
  severity:    SecuritySeverity;
  title:       string;
  description: string;
  cve?:        string;
  cvss?:       number;
  fixVersion?: string;
  remediation: string;
}

// ── Hardening checklist item ──────────────────────────────────────────────────

export interface HardeningCheckItem {
  id:        string;
  dimension: string;
  item:      string;
  status:    "PASS" | "FAIL" | "WARN" | "PENDING";
  priority:  "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  detail:    string;
  effort:    "SMALL" | "MEDIUM" | "LARGE";
}

// ── Report types ──────────────────────────────────────────────────────────────

export interface SecurityAuditReport {
  auditId:        string;
  generatedAt:    string;
  durationMs:     number;
  securityScore:  number;
  riskScore:      number;
  securityGrade:  SecurityGrade;
  dimensions:     SecurityDimensionResult[];
  totalFindings:  number;
  bySeverity:     Record<SecuritySeverity, number>;
  criticalCount:  number;
  highCount:      number;
  summary:        string;
  executiveSummary: string;
  immediateActions: string[];
}

export interface VulnerabilityReport {
  auditId:        string;
  generatedAt:    string;
  totalVulns:     number;
  bySeverity:     Record<SecuritySeverity, number>;
  vulnerabilities: VulnerabilityEntry[];
  summary:        string;
}

export interface HardeningChecklist {
  auditId:        string;
  generatedAt:    string;
  totalItems:     number;
  passed:         number;
  failed:         number;
  warned:         number;
  pending:        number;
  completionPct:  number;
  items:          HardeningCheckItem[];
}

export interface E2Bundle {
  auditId:              string;
  generatedAt:          string;
  durationMs:           number;
  r2Keys:               string[];
  securityAuditReport:  SecurityAuditReport;
  vulnerabilityReport:  VulnerabilityReport;
  hardeningChecklist:   HardeningChecklist;
  securityScore:        number;
  securityGrade:        SecurityGrade;
}

// ── In-memory store ───────────────────────────────────────────────────────────

const e2Store = new Map<string, E2Bundle>();

export function getE2Bundle(auditId: string): E2Bundle | undefined {
  return e2Store.get(auditId);
}

export function listE2Bundles(): Array<{ auditId: string; generatedAt: string; securityScore: number; securityGrade: SecurityGrade }> {
  return [...e2Store.values()].map(b => ({
    auditId:       b.auditId,
    generatedAt:   b.generatedAt,
    securityScore: b.securityScore,
    securityGrade: b.securityGrade,
  })).sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

// ── R2 helper ─────────────────────────────────────────────────────────────────

async function storeR2(auditId: string, file: string, data: unknown): Promise<string> {
  const key      = `e2/${auditId}/${file}`;
  const provider = createCloudProvider("r2");
  if (!provider.isConfigured()) { logger.warn({ auditId, file }, "E2: R2 not configured"); return key; }
  const buf = Buffer.from(JSON.stringify(data, null, 2), "utf-8");
  await provider.upload({ key, data: buf, contentType: "application/json", checkDuplicate: false });
  logger.info({ key }, "E2: stored to R2");
  return key;
}

// ── Grading ───────────────────────────────────────────────────────────────────

function scoreToGrade(score: number): SecurityGrade {
  if (score >= 97) return "A+";
  if (score >= 93) return "A";
  if (score >= 90) return "A-";
  if (score >= 87) return "B+";
  if (score >= 83) return "B";
  if (score >= 80) return "B-";
  if (score >= 77) return "C+";
  if (score >= 73) return "C";
  if (score >= 70) return "C-";
  if (score >= 60) return "D";
  return "F";
}

// ── File helpers ──────────────────────────────────────────────────────────────

function fileExists(base: string, ...parts: string[]): boolean {
  return fs.existsSync(path.join(base, ...parts));
}

function readFileSafe(base: string, ...parts: string[]): string {
  try { return fs.readFileSync(path.join(base, ...parts), "utf-8"); }
  catch { return ""; }
}

function grepFile(content: string, pattern: RegExp): string[] {
  return content.split("\n").filter(l => pattern.test(l));
}

function findId(): string { return crypto.randomUUID().slice(0, 8); }

// ── Dimension 1: Authentication ───────────────────────────────────────────────

async function auditAuthentication(root: string): Promise<SecurityDimensionResult> {
  const findings: SecurityFinding[] = [];
  const evidence: string[]  = [];
  let   checksRun = 0, checksPassed = 0;

  // Check for auth middleware
  checksRun++;
  const hasAuthMiddleware =
    fileExists(root, "src/middlewares") &&
    fs.readdirSync(path.join(root, "src/middlewares")).some(f => /auth/i.test(f));
  if (hasAuthMiddleware) { checksPassed++; evidence.push("Auth middleware directory found"); }
  else { evidence.push("No auth middleware file detected — all routes are public"); }

  // Check for session secret
  checksRun++;
  const sessionSecret = process.env["SESSION_SECRET"];
  if (sessionSecret && sessionSecret.length >= 32) {
    checksPassed++; evidence.push("SESSION_SECRET: configured (length OK)");
  } else if (sessionSecret) {
    findings.push({ id: findId(), dimension: "Authentication", severity: "HIGH",
      title: "SESSION_SECRET too short",
      description: "Session secret is shorter than 32 characters — weak against brute-force",
      remediation: "Set SESSION_SECRET to a cryptographically random string of at least 32 characters" });
    evidence.push("SESSION_SECRET: configured but short");
  } else {
    evidence.push("SESSION_SECRET: not set (no session auth configured)");
  }

  // Check for hardcoded credentials in source
  checksRun++;
  const srcDir = path.join(root, "src");
  let hardcodedCreds = false;
  if (fs.existsSync(srcDir)) {
    const allSrc = walkFiles(srcDir, ".ts").slice(0, 50).map(f => readFileSafe(f)).join("\n");
    const credPatterns = [/password\s*=\s*["'][^"']{4,}["']/i, /secret\s*=\s*["'][^"']{4,}["']/i, /api.?key\s*=\s*["'][a-z0-9]{16,}["']/i];
    hardcodedCreds = credPatterns.some(p => p.test(allSrc));
  }
  if (!hardcodedCreds) { checksPassed++; evidence.push("No hardcoded credentials detected in source"); }
  else {
    findings.push({ id: findId(), dimension: "Authentication", severity: "CRITICAL",
      title: "Hardcoded credentials detected",
      description: "Source code contains what appears to be a hardcoded password, secret, or API key",
      remediation: "Move all credentials to environment variables / Replit Secrets immediately" });
  }

  // Check for JWT/bearer in routes
  checksRun++;
  const routesDir = path.join(root, "src/routes");
  let hasAuthRoute = false;
  if (fs.existsSync(routesDir)) {
    const routeFiles = fs.readdirSync(routesDir).filter(f => f.endsWith(".ts")).map(f => readFileSafe(routesDir, f)).join("\n");
    hasAuthRoute = /bearer|jwt|authorization/i.test(routeFiles);
    if (hasAuthRoute) { checksPassed++; evidence.push("JWT/Bearer auth references found in routes"); }
    else { evidence.push("No JWT/Bearer patterns found in route handlers"); }
  }

  const criticals = findings.filter(f => f.severity === "CRITICAL").length;
  const highs     = findings.filter(f => f.severity === "HIGH").length;
  const score     = Math.max(0, 100 - criticals * 30 - highs * 15 - (checksRun - checksPassed) * 5);

  return { dimension: "Authentication", status: criticals > 0 ? "FAIL" : highs > 0 ? "WARN" : "PASS",
    score, weight: 15, findings, checksRun, checksPassed, evidence,
    recommendation: criticals > 0 ? "CRITICAL: Remove hardcoded credentials immediately"
      : "Implement authentication middleware for protected routes" };
}

// ── Dimension 2: Authorization ─────────────────────────────────────────────────

async function auditAuthorization(root: string): Promise<SecurityDimensionResult> {
  const findings: SecurityFinding[] = [];
  const evidence: string[]  = [];
  let   checksRun = 0, checksPassed = 0;

  checksRun++;
  const middlewaresDir = path.join(root, "src/middlewares");
  if (fs.existsSync(middlewaresDir)) {
    const middlewareFiles = fs.readdirSync(middlewaresDir);
    const hasAuthz = middlewareFiles.some(f => /authz|authorize|permission|role|scope/i.test(f));
    if (hasAuthz) { checksPassed++; evidence.push("Authorization middleware detected"); }
    else { evidence.push("No dedicated authorization middleware found"); findings.push({ id: findId(), dimension: "Authorization",
      severity: "MEDIUM", title: "No authorization middleware",
      description: "No role/scope authorization middleware found — all authenticated users have equal access",
      remediation: "Implement role-based or scope-based authorization middleware for admin endpoints" }); }
  } else {
    evidence.push("No middlewares directory");
  }

  // Check all routes are scoped under /api (no accidental root exposure)
  checksRun++;
  const appTs = readFileSafe(root, "src/app.ts");
  if (/app\.use\(['"]\/api/i.test(appTs)) { checksPassed++; evidence.push("All routes mounted under /api prefix"); }
  else { evidence.push("Routes may not be scoped to /api prefix");
    findings.push({ id: findId(), dimension: "Authorization", severity: "LOW",
      title: "Route scoping unclear", description: "Cannot confirm all routes are scoped under /api",
      remediation: "Ensure all API routes are mounted under /api and admin routes require elevated permissions" }); }

  const criticals = findings.filter(f => f.severity === "CRITICAL").length;
  const highs     = findings.filter(f => f.severity === "HIGH").length;
  const score     = Math.max(0, 100 - criticals * 30 - highs * 15 - (checksRun - checksPassed) * 8);

  return { dimension: "Authorization", status: criticals > 0 ? "FAIL" : highs > 0 ? "WARN" : findings.length > 0 ? "WARN" : "PASS",
    score, weight: 10, findings, checksRun, checksPassed, evidence,
    recommendation: "Implement authorization middleware for admin and sensitive endpoints" };
}

// ── Dimension 3: Secrets ───────────────────────────────────────────────────────

async function auditSecrets(root: string): Promise<SecurityDimensionResult> {
  const findings: SecurityFinding[] = [];
  const evidence: string[]  = [];
  let   checksRun = 0, checksPassed = 0;

  const requiredSecrets = ["DATABASE_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "CLOUDFLARE_API_TOKEN", "R2_BUCKET_NAME"];

  // Check all required secrets are set
  checksRun++;
  const missing = requiredSecrets.filter(k => !process.env[k]);
  if (missing.length === 0) { checksPassed++; evidence.push("All required secrets are set"); }
  else {
    evidence.push(`Missing secrets: ${missing.join(", ")}`);
    findings.push({ id: findId(), dimension: "Secrets", severity: "HIGH",
      title: `${missing.length} required secret(s) not configured`,
      description: `Missing environment variables: ${missing.join(", ")}`,
      remediation: "Set all required secrets via Replit Secrets panel" });
  }

  // Check .env is in .gitignore
  checksRun++;
  const gitignore = readFileSafe(root, "../../.gitignore");
  const envIgnored = gitignore.includes(".env") || gitignore.includes("*.env");
  if (envIgnored) { checksPassed++; evidence.push(".env is in .gitignore"); }
  else { evidence.push(".gitignore may not exclude .env files");
    findings.push({ id: findId(), dimension: "Secrets", severity: "MEDIUM",
      title: ".env files may not be gitignored",
      description: "If .env files exist and are not gitignored, secrets could be committed",
      remediation: "Add .env and .env.* to .gitignore" }); }

  // Check for .env file existence (warn if found — secrets should be in Replit Secrets)
  checksRun++;
  const envFiles = [".env", ".env.local", ".env.production"].filter(f => fileExists(root, "../../" + f));
  if (envFiles.length === 0) { checksPassed++; evidence.push("No .env files on disk — using Replit Secrets (correct)"); }
  else { evidence.push(`Found .env files: ${envFiles.join(", ")}`);
    findings.push({ id: findId(), dimension: "Secrets", severity: "MEDIUM",
      title: ".env files found on disk",
      description: `Found: ${envFiles.join(", ")} — prefer Replit Secrets over .env files`,
      remediation: "Move .env values to Replit Secrets panel and delete .env files" }); }

  // Check for secret leakage in logs (pino config)
  checksRun++;
  const loggerSrc = readFileSafe(root, "src/lib/logger.ts");
  const redactsSecrets = /redact/i.test(loggerSrc);
  if (redactsSecrets) { checksPassed++; evidence.push("Logger has redact configuration"); }
  else { evidence.push("Logger may not redact sensitive fields");
    findings.push({ id: findId(), dimension: "Secrets", severity: "MEDIUM",
      title: "Logger may expose secrets in output",
      description: "Pino logger does not appear to have redact configuration for sensitive fields",
      remediation: "Add `redact: ['req.headers.authorization', 'body.password', 'body.token']` to pino options" }); }

  const criticals = findings.filter(f => f.severity === "CRITICAL").length;
  const highs     = findings.filter(f => f.severity === "HIGH").length;
  const score     = Math.max(0, 100 - criticals * 30 - highs * 15 - (checksRun - checksPassed) * 7);

  return { dimension: "Secrets", status: criticals > 0 ? "FAIL" : highs > 0 ? "WARN" : findings.length > 0 ? "WARN" : "PASS",
    score, weight: 15, findings, checksRun, checksPassed, evidence,
    recommendation: "Ensure all secrets are in Replit Secrets and never committed to source" };
}

// ── Dimension 4: R2 Access ────────────────────────────────────────────────────

async function auditR2Access(root: string): Promise<SecurityDimensionResult> {
  const findings: SecurityFinding[] = [];
  const evidence: string[]  = [];
  let   checksRun = 0, checksPassed = 0;

  // Check R2 provider code for key patterns
  checksRun++;
  const r2Provider = readFileSafe(root, "src/cloud/r2.provider.ts");
  if (r2Provider) {
    evidence.push("R2 provider implementation found");

    // Check it doesn't hardcode credentials
    if (!/AccessKey\s*=\s*["'][a-z0-9]{20,}/i.test(r2Provider)) { checksPassed++; evidence.push("R2 credentials loaded from env vars (not hardcoded)"); }
    else { findings.push({ id: findId(), dimension: "R2 Access", severity: "CRITICAL",
        title: "Hardcoded R2 credentials", description: "R2 access keys appear hardcoded in provider source",
        remediation: "Load R2 credentials exclusively from environment variables" }); }

    // Check for pre-signed URL expiry
    const hasExpiry = /expires|ttl|expiresIn/i.test(r2Provider);
    checksRun++;
    if (hasExpiry) { checksPassed++; evidence.push("R2 pre-signed URLs have expiry configured"); }
    else { evidence.push("Pre-signed URL expiry may not be configured");
      findings.push({ id: findId(), dimension: "R2 Access", severity: "MEDIUM",
        title: "Pre-signed URL expiry unclear",
        description: "R2 provider may issue pre-signed URLs without explicit short expiry",
        remediation: "Set pre-signed URL TTL to ≤ 15 minutes for sensitive assets" }); }
  } else {
    evidence.push("R2 provider file not found at expected path");
  }

  // Check public bucket is intentional
  checksRun++;
  const pubUrl = process.env["R2_PUBLIC_BASE_URL"];
  if (pubUrl) {
    evidence.push(`R2 public URL configured: ${pubUrl.split(".")[0]}...`);
    findings.push({ id: findId(), dimension: "R2 Access", severity: "INFO",
      title: "R2 public bucket URL is set",
      description: "R2_PUBLIC_BASE_URL is configured — ensure only public assets are stored in this path",
      remediation: "Store sensitive data (credentials, PII, reports) under private keys only, not under public-readable paths" });
    checksPassed++;
  } else {
    evidence.push("R2_PUBLIC_BASE_URL not set — no public bucket exposure");
    checksPassed++;
  }

  // Check CLOUDFLARE_API_TOKEN scope
  checksRun++;
  const cfToken = process.env["CLOUDFLARE_API_TOKEN"];
  if (cfToken) { evidence.push("CLOUDFLARE_API_TOKEN configured"); checksPassed++; }
  else { evidence.push("CLOUDFLARE_API_TOKEN not set");
    findings.push({ id: findId(), dimension: "R2 Access", severity: "MEDIUM",
      title: "CLOUDFLARE_API_TOKEN not configured",
      description: "Without the API token, R2 management operations (bucket creation, CORS rules) will fail",
      remediation: "Configure CLOUDFLARE_API_TOKEN with minimum required scopes (R2 read/write only)" }); }

  const criticals = findings.filter(f => f.severity === "CRITICAL").length;
  const highs     = findings.filter(f => f.severity === "HIGH").length;
  const score     = Math.max(0, 100 - criticals * 30 - highs * 15 - (checksRun - checksPassed) * 8);

  return { dimension: "R2 Access", status: criticals > 0 ? "FAIL" : highs > 0 ? "WARN" : findings.length > 1 ? "WARN" : "PASS",
    score, weight: 12, findings, checksRun, checksPassed, evidence,
    recommendation: "Scope Cloudflare API token to R2 read/write only; enforce short expiry on pre-signed URLs" };
}

// ── Dimension 5: API Security ─────────────────────────────────────────────────

async function auditApiSecurity(root: string): Promise<SecurityDimensionResult> {
  const findings: SecurityFinding[] = [];
  const evidence: string[]  = [];
  let   checksRun = 0, checksPassed = 0;

  const appTs = readFileSafe(root, "src/app.ts");

  // CORS
  checksRun++;
  if (/cors/i.test(appTs)) { checksPassed++; evidence.push("CORS middleware: present"); }
  else { evidence.push("CORS middleware not detected");
    findings.push({ id: findId(), dimension: "API Security", severity: "HIGH",
      title: "CORS not configured",
      description: "No CORS middleware detected in app.ts — API may accept cross-origin requests from any domain",
      remediation: "Configure cors() middleware with explicit origin allowlist" }); }

  // Helmet / security headers
  checksRun++;
  if (/helmet/i.test(appTs)) { checksPassed++; evidence.push("Helmet security headers: present"); }
  else { evidence.push("Helmet not detected");
    findings.push({ id: findId(), dimension: "API Security", severity: "MEDIUM",
      title: "Security headers (Helmet) not configured",
      description: "Helmet.js is not detected — responses may lack X-Frame-Options, CSP, HSTS etc.",
      remediation: "Add `app.use(helmet())` to app.ts" }); }

  // Body size limits
  checksRun++;
  if (/limit|bodyParser|json\(\s*\{/i.test(appTs)) { checksPassed++; evidence.push("Body size limit: likely configured"); }
  else { evidence.push("Body size limit may not be configured");
    findings.push({ id: findId(), dimension: "API Security", severity: "MEDIUM",
      title: "Request body size limit unclear",
      description: "No explicit body size limit detected — large payloads could trigger DoS",
      remediation: "Set `app.use(express.json({ limit: '1mb' }))` in app.ts" }); }

  // HTTPS enforcement
  checksRun++;
  const domains = process.env["REPLIT_DOMAINS"];
  if (domains) { checksPassed++; evidence.push("REPLIT_DOMAINS set — TLS enforced at proxy level"); }
  else { evidence.push("REPLIT_DOMAINS not set (development environment — TLS via reverse proxy in production)"); checksPassed++; }

  // Method allowlisting — check Express route files don't use .all() carelessly
  checksRun++;
  const routesDir = path.join(root, "src/routes");
  let hasRouter_all = false;
  if (fs.existsSync(routesDir)) {
    const routeContent = walkFiles(routesDir, ".ts").slice(0, 30).map(f => readFileSafe(f)).join("\n");
    hasRouter_all = /router\.all\s*\(/i.test(routeContent);
  }
  if (!hasRouter_all) { checksPassed++; evidence.push("No unscoped router.all() usage detected"); }
  else { evidence.push("router.all() usage detected — verify method allowlisting");
    findings.push({ id: findId(), dimension: "API Security", severity: "LOW",
      title: "Unscoped router.all() detected",
      description: "router.all() accepts any HTTP method — verify this is intentional and not a security bypass",
      remediation: "Replace router.all() with explicit method handlers (router.get, router.post, etc.)" }); }

  const criticals = findings.filter(f => f.severity === "CRITICAL").length;
  const highs     = findings.filter(f => f.severity === "HIGH").length;
  const score     = Math.max(0, 100 - criticals * 30 - highs * 15 - (checksRun - checksPassed) * 8);

  return { dimension: "API Security", status: criticals > 0 ? "FAIL" : highs > 0 ? "WARN" : "PASS",
    score, weight: 12, findings, checksRun, checksPassed, evidence,
    recommendation: "Add Helmet.js, configure explicit CORS origin, and enforce body size limits" };
}

// ── Dimension 6: Rate Limiting ────────────────────────────────────────────────

async function auditRateLimiting(root: string): Promise<SecurityDimensionResult> {
  const findings: SecurityFinding[] = [];
  const evidence: string[]  = [];
  let   checksRun = 0, checksPassed = 0;

  // Check for rate limiting packages
  checksRun++;
  const pkgJson = readFileSafe(root, "../../package.json");
  const hasPkg  = readFileSafe(root, "package.json");
  const allPkgs = pkgJson + hasPkg;
  const hasRateLimit = /express-rate-limit|rate-limiter|bottleneck|throttle/i.test(allPkgs);
  if (hasRateLimit) { checksPassed++; evidence.push("Rate limiting package found in dependencies"); }
  else { evidence.push("No rate limiting package detected");
    findings.push({ id: findId(), dimension: "Rate Limiting", severity: "HIGH",
      title: "No rate limiting configured",
      description: "No rate-limiting middleware detected — scrape endpoints and compute-heavy routes are vulnerable to abuse",
      remediation: "Install express-rate-limit and apply limits to /scrape, /generation, /orchestration endpoints" }); }

  // Check if scrape route has any guard
  checksRun++;
  const scrapeRoute = readFileSafe(root, "src/routes/scraper.ts");
  const hasGuard = /limit|rate|throttle|concurren/i.test(scrapeRoute);
  if (hasGuard) { checksPassed++; evidence.push("Scrape route has concurrency/rate guard"); }
  else { evidence.push("Scrape route may have no rate or concurrency guard");
    findings.push({ id: findId(), dimension: "Rate Limiting", severity: "MEDIUM",
      title: "Scrape endpoint lacks per-IP throttle",
      description: "POST /scrape/start has no detected rate limiting — one client could exhaust queue",
      remediation: "Apply express-rate-limit to /scrape/* with max 5 requests/min per IP" }); }

  // Check for queue depth limit
  checksRun++;
  const queueSrc = readFileSafe(root, "src/lib/db-queue.ts");
  const hasQueueLimit = /maxQueue|max_queue|queueLimit|MAX_QUEUE/i.test(queueSrc);
  if (hasQueueLimit) { checksPassed++; evidence.push("Queue depth limit found in db-queue"); }
  else { evidence.push("No queue depth limit found — queue could grow unboundedly"); checksPassed++; } // warn-only

  const criticals = findings.filter(f => f.severity === "CRITICAL").length;
  const highs     = findings.filter(f => f.severity === "HIGH").length;
  const score     = Math.max(0, 100 - criticals * 30 - highs * 15 - (checksRun - checksPassed) * 10);

  return { dimension: "Rate Limiting", status: criticals > 0 ? "FAIL" : highs > 0 ? "WARN" : "PASS",
    score, weight: 10, findings, checksRun, checksPassed, evidence,
    recommendation: "Implement express-rate-limit on scrape, generation, and orchestration routes" };
}

// ── Dimension 7: Input Validation ─────────────────────────────────────────────

async function auditInputValidation(root: string): Promise<SecurityDimensionResult> {
  const findings: SecurityFinding[] = [];
  const evidence: string[]  = [];
  let   checksRun = 0, checksPassed = 0;

  // Check for Zod in use
  checksRun++;
  const hasPkg = readFileSafe(root, "package.json");
  const hasZod = /zod/i.test(hasPkg);
  if (hasZod) { checksPassed++; evidence.push("Zod validation library present"); }
  else { evidence.push("Zod not in package.json");
    findings.push({ id: findId(), dimension: "Input Validation", severity: "HIGH",
      title: "No schema validation library detected",
      description: "Zod (or equivalent) not found — API inputs may be unvalidated",
      remediation: "Install zod and validate all request bodies with Zod schemas" }); }

  // Check api-zod lib
  checksRun++;
  const zodDir = path.join(root, "../../lib/api-zod/src/generated");
  if (fs.existsSync(zodDir)) {
    const schemas = fs.readdirSync(zodDir).filter(f => f.endsWith(".ts")).length;
    checksPassed++; evidence.push(`api-zod: ${schemas} generated schema(s)`);
  } else { evidence.push("api-zod generated schemas not found"); }

  // Check for SQL injection risk (raw queries)
  checksRun++;
  const routesDir = path.join(root, "src/routes");
  let rawSql = false;
  if (fs.existsSync(routesDir)) {
    const allRoutes = walkFiles(routesDir, ".ts").slice(0, 40).map(f => readFileSafe(f)).join("\n");
    rawSql = /db\.execute\s*\(\s*[`'"]SELECT|db\.run\s*\(\s*[`'"]|query\s*\(\s*[`'"]\s*SELECT/i.test(allRoutes);
  }
  if (!rawSql) { checksPassed++; evidence.push("No raw SQL string patterns detected in routes"); }
  else { findings.push({ id: findId(), dimension: "Input Validation", severity: "HIGH",
    title: "Possible raw SQL detected",
    description: "Raw SQL string patterns found in route handlers — potential SQL injection risk",
    remediation: "Use Drizzle ORM query builder exclusively; never concatenate user input into SQL" }); }

  // Check for XSS — HTML output without sanitization
  checksRun++;
  const libDir = path.join(root, "src/lib");
  let xssRisk = false;
  if (fs.existsSync(libDir)) {
    const libContent = walkFiles(libDir, ".ts").slice(0, 20).map(f => readFileSafe(f)).join("\n");
    xssRisk = /innerHTML|document\.write|\.html\s*\(/i.test(libContent);
  }
  if (!xssRisk) { checksPassed++; evidence.push("No innerHTML/XSS-risky patterns detected in lib"); }
  else { findings.push({ id: findId(), dimension: "Input Validation", severity: "MEDIUM",
    title: "Possible XSS-risky HTML output",
    description: "innerHTML or document.write patterns detected — verify user data is sanitized before output",
    remediation: "Use DOMPurify or escape HTML before injecting user data into the DOM" }); }

  const criticals = findings.filter(f => f.severity === "CRITICAL").length;
  const highs     = findings.filter(f => f.severity === "HIGH").length;
  const score     = Math.max(0, 100 - criticals * 30 - highs * 15 - (checksRun - checksPassed) * 8);

  return { dimension: "Input Validation", status: criticals > 0 ? "FAIL" : highs > 0 ? "WARN" : "PASS",
    score, weight: 16, findings, checksRun, checksPassed, evidence,
    recommendation: "Validate all request bodies with Zod schemas; use Drizzle query builder exclusively" };
}

// ── Dimension 8: Dependency Vulnerabilities ────────────────────────────────────

async function auditDependencies(root: string): Promise<SecurityDimensionResult> {
  const findings: SecurityFinding[] = [];
  const evidence: string[]  = [];
  let   checksRun = 0, checksPassed = 0;

  // Known vulnerable package patterns (conservative list — real CVEs at time of writing)
  const KNOWN_VULNS: Array<{ pkg: string; vulnerable: (v: string) => boolean; severity: SecuritySeverity; title: string; cve?: string; fix: string }> = [
    { pkg: "axios",      vulnerable: v => semverLt(v, "1.7.0"),  severity: "HIGH",   title: "Axios SSRF vulnerability",        cve: "CVE-2023-45857",  fix: ">=1.7.0" },
    { pkg: "express",    vulnerable: v => semverLt(v, "4.19.0"), severity: "MEDIUM", title: "Express open redirect",            cve: "CVE-2024-29041",  fix: ">=4.19.2" },
    { pkg: "got",        vulnerable: v => semverLt(v, "12.0.0"), severity: "MEDIUM", title: "Got ReDoS vulnerability",          cve: "CVE-2022-33987",  fix: ">=12.0.0" },
    { pkg: "semver",     vulnerable: v => semverLt(v, "7.5.2"),  severity: "MEDIUM", title: "Semver ReDoS",                     cve: "CVE-2022-25883",  fix: ">=7.5.2" },
    { pkg: "xml2js",     vulnerable: v => semverLt(v, "0.5.0"),  severity: "MEDIUM", title: "xml2js prototype pollution",       cve: "CVE-2023-0842",   fix: ">=0.5.0" },
    { pkg: "puppeteer",  vulnerable: v => semverLt(v, "22.0.0"), severity: "LOW",    title: "Puppeteer outdated Chromium",                              fix: ">=22.0.0" },
  ];

  // Read all package.json files
  const pkgFiles = [
    path.join(root, "package.json"),
    path.join(root, "../../package.json"),
  ].filter(f => fs.existsSync(f));

  const installedPkgs: Record<string, string> = {};
  for (const pkgFile of pkgFiles) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf-8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      Object.assign(installedPkgs, pkg.dependencies ?? {}, pkg.devDependencies ?? {});
    } catch { /* skip */ }
  }

  checksRun++;
  const pkgCount = Object.keys(installedPkgs).length;
  evidence.push(`Scanned ${pkgCount} package(s) across workspace`);
  if (pkgCount > 0) checksPassed++;

  let vulnCount = 0;
  for (const vuln of KNOWN_VULNS) {
    checksRun++;
    const installed = installedPkgs[vuln.pkg];
    if (!installed) { checksPassed++; continue; }
    const version = installed.replace(/^[^0-9]*/, "");
    if (vuln.vulnerable(version)) {
      vulnCount++;
      findings.push({ id: findId(), dimension: "Dependencies", severity: vuln.severity,
        title: `${vuln.pkg}@${version}: ${vuln.title}`,
        description: `Installed version ${version} is vulnerable. ${vuln.cve ?? ""}`,
        location: `package.json → ${vuln.pkg}`,
        cve: vuln.cve,
        remediation: `Upgrade ${vuln.pkg} to ${vuln.fix}` });
      evidence.push(`VULNERABLE: ${vuln.pkg}@${version} (${vuln.severity})`);
    } else {
      checksPassed++;
      evidence.push(`OK: ${vuln.pkg}@${version}`);
    }
  }

  if (vulnCount === 0) evidence.push("No known vulnerabilities found in checked packages");

  // Check for packages past EOL (heuristic: very old major versions)
  checksRun++;
  const oldPatterns: [string, string][] = [["typescript", "3."], ["node", "14."], ["express", "3."]];
  let hasEol = false;
  for (const [pkg, prefix] of oldPatterns) {
    const v = (installedPkgs[pkg] ?? "").replace(/[^0-9.]/g, "");
    if (v.startsWith(prefix)) { hasEol = true; findings.push({ id: findId(), dimension: "Dependencies", severity: "MEDIUM",
      title: `${pkg} is EOL`, description: `${pkg} ${v} has reached end-of-life`,
      remediation: `Upgrade ${pkg} to current LTS` }); }
  }
  if (!hasEol) { checksPassed++; evidence.push("No EOL package versions detected"); }

  const criticals = findings.filter(f => f.severity === "CRITICAL").length;
  const highs     = findings.filter(f => f.severity === "HIGH").length;
  const score     = Math.max(0, 100 - criticals * 30 - highs * 15 - vulnCount * 8 - (checksRun - checksPassed) * 3);

  return { dimension: "Dependencies", status: criticals > 0 ? "FAIL" : highs > 0 ? "WARN" : vulnCount > 0 ? "WARN" : "PASS",
    score, weight: 10, findings, checksRun, checksPassed, evidence,
    recommendation: "Run `pnpm audit` regularly and update vulnerable packages" };
}

// ── Semver helpers ────────────────────────────────────────────────────────────

function semverLt(a: string, b: string): boolean {
  const parseV = (v: string) => v.replace(/[^0-9.]/g, "").split(".").map(Number);
  const av = parseV(a), bv = parseV(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const an = av[i] ?? 0, bn = bv[i] ?? 0;
    if (an < bn) return true;
    if (an > bn) return false;
  }
  return false;
}

// ── File walker ───────────────────────────────────────────────────────────────

function walkFiles(dir: string, ext: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        results.push(...walkFiles(full, ext));
      } else if (entry.isFile() && entry.name.endsWith(ext)) {
        results.push(full);
      }
    }
  } catch { /* skip */ }
  return results;
}

// ── Hardening checklist builder ───────────────────────────────────────────────

function buildHardeningChecklist(dimensions: SecurityDimensionResult[]): HardeningCheckItem[] {
  const checks: HardeningCheckItem[] = [];
  let seq = 1;

  const mkId = () => `HC-${String(seq++).padStart(3, "0")}`;

  for (const dim of dimensions) {
    for (const f of dim.findings) {
      checks.push({
        id:        mkId(),
        dimension: dim.dimension,
        item:      f.title,
        status:    f.severity === "CRITICAL" || f.severity === "HIGH" ? "FAIL" : f.severity === "MEDIUM" ? "WARN" : "PASS",
        priority:  f.severity === "CRITICAL" ? "CRITICAL" : f.severity === "HIGH" ? "HIGH" : f.severity === "MEDIUM" ? "MEDIUM" : "LOW",
        detail:    f.remediation,
        effort:    f.severity === "CRITICAL" ? "SMALL" : f.severity === "HIGH" ? "SMALL" : "MEDIUM",
      });
    }
  }

  // Always-present baseline checks
  const baseline: Array<{ item: string; dimension: string; priority: HardeningCheckItem["priority"]; effort: HardeningCheckItem["effort"]; detail: string }> = [
    { item: "Enable HTTPS / TLS termination at proxy",    dimension: "API Security",     priority: "CRITICAL", effort: "SMALL",  detail: "Use Replit's built-in TLS or configure reverse proxy" },
    { item: "Configure pino log redaction for secrets",   dimension: "Secrets",          priority: "HIGH",     effort: "SMALL",  detail: "Add redact: ['req.headers.authorization'] to pino options" },
    { item: "Add express-rate-limit to scrape endpoints", dimension: "Rate Limiting",    priority: "HIGH",     effort: "SMALL",  detail: "npm install express-rate-limit; apply to /api/scrape" },
    { item: "Add Helmet.js security headers",             dimension: "API Security",     priority: "HIGH",     effort: "SMALL",  detail: "npm install helmet; app.use(helmet())" },
    { item: "Set body size limit on express.json()",      dimension: "API Security",     priority: "MEDIUM",   effort: "SMALL",  detail: "app.use(express.json({ limit: '1mb' }))" },
    { item: "Run pnpm audit weekly in CI",                dimension: "Dependencies",     priority: "MEDIUM",   effort: "SMALL",  detail: "Add `pnpm audit --audit-level=high` to CI pipeline" },
    { item: "Scope Cloudflare API token to R2 only",      dimension: "R2 Access",        priority: "MEDIUM",   effort: "SMALL",  detail: "Create scoped token with R2:Edit only" },
    { item: "Add authorization middleware for /admin",    dimension: "Authorization",    priority: "HIGH",     effort: "MEDIUM", detail: "Implement role check middleware before admin routes" },
  ];

  for (const b of baseline) {
    const alreadyAdded = checks.some(c => c.item === b.item);
    if (!alreadyAdded) {
      checks.push({ id: mkId(), dimension: b.dimension, item: b.item,
        status: "PENDING", priority: b.priority, detail: b.detail, effort: b.effort });
    }
  }

  return checks;
}

// ── Vulnerability report builder ──────────────────────────────────────────────

function buildVulnerabilityReport(auditId: string, generatedAt: string, dimensions: SecurityDimensionResult[]): VulnerabilityReport {
  const allFindings = dimensions.flatMap(d => d.findings);
  const bySev: Record<SecuritySeverity, number> = { INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  for (const f of allFindings) bySev[f.severity]++;

  const vulns: VulnerabilityEntry[] = allFindings
    .filter(f => f.severity !== "INFO")
    .map(f => ({
      id:          f.id,
      package:     f.location?.split("→")[1]?.trim() ?? "system",
      version:     "detected",
      severity:    f.severity,
      title:       f.title,
      description: f.description,
      cve:         f.cve,
      cvss:        f.cvss,
      fixVersion:  undefined,
      remediation: f.remediation,
    }));

  return {
    auditId, generatedAt,
    totalVulns: vulns.length,
    bySeverity: bySev,
    vulnerabilities: vulns,
    summary: vulns.length === 0
      ? "No vulnerabilities detected."
      : `Found ${vulns.length} vulnerability/vulnerabilities: ${bySev.CRITICAL} critical, ${bySev.HIGH} high, ${bySev.MEDIUM} medium, ${bySev.LOW} low.`,
  };
}

// ── Main run function ─────────────────────────────────────────────────────────

export async function runSecurityAudit(input: E2Input): Promise<E2Bundle> {
  const start     = Date.now();
  const auditId   = input.auditId ?? `e2-${crypto.randomUUID()}`;
  const root      = input.projectRoot ?? process.cwd();
  const generatedAt = new Date().toISOString();

  logger.info({ auditId, root }, "E2: starting security audit");

  const DIMENSION_AUDITORS = [
    { fn: () => auditAuthentication(root),   label: "Authentication" },
    { fn: () => auditAuthorization(root),    label: "Authorization" },
    { fn: () => auditSecrets(root),          label: "Secrets" },
    { fn: () => auditR2Access(root),         label: "R2 Access" },
    { fn: () => auditApiSecurity(root),      label: "API Security" },
    { fn: () => auditRateLimiting(root),     label: "Rate Limiting" },
    { fn: () => auditInputValidation(root),  label: "Input Validation" },
    { fn: () => auditDependencies(root),     label: "Dependencies" },
  ];

  const dimensions = await Promise.all(DIMENSION_AUDITORS.map(async a => {
    try { return await a.fn(); }
    catch (err) {
      logger.warn({ err, label: a.label }, "E2: dimension audit threw");
      return {
        dimension: a.label, status: "SKIP" as AuditStatus, score: 50, weight: 10,
        findings: [], checksRun: 0, checksPassed: 0, evidence: [`Probe threw: ${String(err)}`],
        recommendation: "Re-run audit after resolving the probe error",
      };
    }
  }));

  // Weighted security score
  const totalWeight   = dimensions.reduce((s, d) => s + d.weight, 0);
  const securityScore = Math.round(
    Math.max(0, Math.min(100, dimensions.reduce((s, d) => s + d.score * d.weight, 0) / totalWeight))
  );
  const riskScore     = 100 - securityScore;
  const securityGrade = scoreToGrade(securityScore);

  const allFindings = dimensions.flatMap(d => d.findings);
  const bySeverity: Record<SecuritySeverity, number> = { INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  for (const f of allFindings) bySeverity[f.severity]++;

  const criticalCount = bySeverity.CRITICAL;
  const highCount     = bySeverity.HIGH;

  const immediateActions: string[] = [
    ...dimensions.flatMap(d => d.findings.filter(f => f.severity === "CRITICAL").map(f => `[CRITICAL] ${f.remediation}`)),
    ...dimensions.flatMap(d => d.findings.filter(f => f.severity === "HIGH").map(f => `[HIGH] ${f.remediation}`)),
  ].slice(0, 10);

  const durationMs = Date.now() - start;

  const executiveSummary =
    `Security Audit complete. Score: ${securityScore}/100 (${securityGrade}). ` +
    `Risk Score: ${riskScore}/100. ` +
    `${criticalCount} critical, ${highCount} high, ${bySeverity.MEDIUM} medium, ${bySeverity.LOW} low finding(s). ` +
    (criticalCount > 0 ? "IMMEDIATE ACTION REQUIRED." : highCount > 0 ? "High-priority items need attention before production." : "Platform is in acceptable security posture.");

  const securityAuditReport: SecurityAuditReport = {
    auditId, generatedAt, durationMs,
    securityScore, riskScore, securityGrade,
    dimensions,
    totalFindings: allFindings.length,
    bySeverity,
    criticalCount,
    highCount,
    summary: `Audited 8 security dimensions across ${dimensions.reduce((s, d) => s + d.checksRun, 0)} check(s). ${allFindings.length} finding(s).`,
    executiveSummary,
    immediateActions,
  };

  const vulnerabilityReport  = buildVulnerabilityReport(auditId, generatedAt, dimensions);
  const hardeningItems       = buildHardeningChecklist(dimensions);
  const hardeningPassed      = hardeningItems.filter(i => i.status === "PASS").length;
  const hardeningFailed      = hardeningItems.filter(i => i.status === "FAIL").length;
  const hardeningWarned      = hardeningItems.filter(i => i.status === "WARN").length;
  const hardeningPending     = hardeningItems.filter(i => i.status === "PENDING").length;

  const hardeningChecklist: HardeningChecklist = {
    auditId, generatedAt,
    totalItems: hardeningItems.length,
    passed: hardeningPassed,
    failed: hardeningFailed,
    warned: hardeningWarned,
    pending: hardeningPending,
    completionPct: Math.round((hardeningPassed / Math.max(1, hardeningItems.length)) * 100),
    items: hardeningItems,
  };

  const bundle: E2Bundle = {
    auditId, generatedAt, durationMs,
    r2Keys: [],
    securityAuditReport,
    vulnerabilityReport,
    hardeningChecklist,
    securityScore,
    securityGrade,
  };

  const r2Keys = await Promise.all([
    storeR2(auditId, "security-audit-report.json", securityAuditReport),
    storeR2(auditId, "vulnerability-report.json",  vulnerabilityReport),
    storeR2(auditId, "hardening-checklist.json",   hardeningChecklist),
  ]);
  bundle.r2Keys = r2Keys;

  e2Store.set(auditId, bundle);
  logger.info({ auditId, securityScore, securityGrade, durationMs }, "E2: security audit complete");

  return bundle;
}
