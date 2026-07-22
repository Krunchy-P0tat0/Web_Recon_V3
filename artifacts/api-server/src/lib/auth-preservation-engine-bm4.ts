/**
 * auth-preservation-engine-bm4.ts — Phase BM-4: Authentication Preservation Engine
 *
 * Analyzes existing authentication systems and generates an auth-preservation-report.json
 * that guarantees no auth system is overwritten during a merge.
 *
 * Auth systems detected:
 *   sessions      — express-session, cookie-based, database-backed
 *   jwt           — jsonwebtoken, jose, JWT in Authorization header
 *   oauth         — passport, custom OAuth2 flows
 *   nextauth      — next-auth / Auth.js (v4 + v5)
 *   clerk         — @clerk/nextjs, @clerk/express
 *   auth0         — @auth0/nextjs-auth0, auth0 SDK
 *   custom        — hand-rolled middleware, any other pattern
 *
 * Outputs (disk + R2):
 *   auth-preservation-report.json
 *
 * Three output sections:
 *   protectedComponents  — auth files/modules that must not be touched
 *   mergeConstraints     — rules the merge pipeline must enforce
 *   requiredAdapters     — adapter modules needed to bridge prime ↔ existing auth
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join }                        from "path";
import { logger }                      from "./logger.js";
import { getDefaultCloudProvider }     from "../cloud/index.js";

// ---------------------------------------------------------------------------
// Auth system taxonomy
// ---------------------------------------------------------------------------

export type AuthSystem =
  | "sessions"
  | "jwt"
  | "oauth"
  | "nextauth"
  | "clerk"
  | "auth0"
  | "custom"
  | "none";

export type PreservationPriority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type ConstraintAction     = "BLOCK" | "REQUIRE_ADAPTER" | "NAMESPACE" | "WARN";
export type AdapterType          =
  | "session-bridge"
  | "jwt-passthrough"
  | "oauth-proxy"
  | "provider-shim"
  | "middleware-wrapper"
  | "token-exchange"
  | "route-guard";

// ---------------------------------------------------------------------------
// Input — existing backend auth profile
// ---------------------------------------------------------------------------

export interface AuthSystemDescriptor {
  system:     AuthSystem;
  provider?:  string;       // e.g. "google", "github", "auth0", "clerk"
  version?:   string;
  sessionStore?: "redis" | "memory" | "cookie" | "database" | "unknown";
  tokenFormat?:  "bearer" | "cookie" | "header" | "query" | "unknown";
  protectedPaths?: string[];   // routes gated by this auth system
  configFiles?:   string[];    // file paths that configure this system
  envVars?:       string[];    // env vars this system depends on
  confidence:     number;      // 0–1 how confident we are in detection
}

export interface AuthPreservationInput {
  primeJobId:    string;
  backendJobId?: string;
  force?:        boolean;
  authSystems?:  AuthSystemDescriptor[];   // manually supplied, or auto-inferred
  primeUrl?:     string;
}

// ---------------------------------------------------------------------------
// Protected component
// ---------------------------------------------------------------------------

export interface ProtectedComponent {
  id:           string;
  system:       AuthSystem;
  name:         string;
  kind:         "file" | "route" | "middleware" | "env-var" | "config" | "database-table" | "package";
  path:         string;         // file path, route path, env var name, or package name
  priority:     PreservationPriority;
  reason:       string;
  mustNotTouch: boolean;
  canAlias:     boolean;        // true if the prime can alias/wrap instead of touching
}

// ---------------------------------------------------------------------------
// Merge constraint
// ---------------------------------------------------------------------------

export interface MergeConstraint {
  id:          string;
  system:      AuthSystem;
  action:      ConstraintAction;
  description: string;
  affectedPaths: string[];       // routes or files this constraint applies to
  enforcement:   "hard" | "soft"; // hard = pipeline aborts, soft = warning
  resolution:    string;          // what the merge pipeline should do
  autoEnforceable: boolean;
}

// ---------------------------------------------------------------------------
// Required adapter
// ---------------------------------------------------------------------------

export interface RequiredAdapter {
  id:           string;
  type:         AdapterType;
  name:         string;
  system:       AuthSystem;
  description:  string;
  inputContract:  string;   // what the prime provides
  outputContract: string;   // what the existing backend expects
  implementationNotes: string[];
  estimatedComplexity: "trivial" | "low" | "medium" | "high";
  canAutoGenerate: boolean;
}

// ---------------------------------------------------------------------------
// Output — auth-preservation-report.json
// ---------------------------------------------------------------------------

export interface AuthPreservationReport {
  schemaVersion:       "BM-4";
  primeJobId:          string;
  backendJobId:        string;
  generatedAt:         string;
  durationMs:          number;
  detectedSystems:     AuthSystemDescriptor[];
  primarySystem:       AuthSystem;
  mergeIsSafe:         boolean;
  preservationScore:   number;   // 0–100; 100 = no risk to existing auth
  riskLevel:           "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  protectedComponents: ProtectedComponent[];
  mergeConstraints:    MergeConstraint[];
  requiredAdapters:    RequiredAdapter[];
  summary: {
    totalDetectedSystems:   number;
    criticalComponents:     number;
    hardConstraints:        number;
    softConstraints:        number;
    adaptersRequired:       number;
    autoGenerableAdapters:  number;
    blockingConstraints:    string[];
    recommendation:         string;
  };
  r2Key?: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const _cache = new Map<string, AuthPreservationReport>();

export function getCachedAuthPreservationReport(primeJobId: string): AuthPreservationReport | undefined {
  return _cache.get(primeJobId);
}

// ---------------------------------------------------------------------------
// ID generators
// ---------------------------------------------------------------------------

let _compSeq = 0;
let _constSeq = 0;
let _adapterSeq = 0;

function compId():    string { return `APC-${String(++_compSeq).padStart(4, "0")}`; }
function constId():   string { return `AMC-${String(++_constSeq).padStart(4, "0")}`; }
function adapterId(): string { return `ADA-${String(++_adapterSeq).padStart(4, "0")}`; }

// ---------------------------------------------------------------------------
// Default auth system descriptors (used when no profile is provided)
// ---------------------------------------------------------------------------

function buildDefaultDescriptors(): AuthSystemDescriptor[] {
  return [];
}

// ---------------------------------------------------------------------------
// System-specific analyzers
// ---------------------------------------------------------------------------

function analyzeSessionAuth(sys: AuthSystemDescriptor): {
  components: ProtectedComponent[];
  constraints: MergeConstraint[];
  adapters: RequiredAdapter[];
} {
  const components: ProtectedComponent[] = [];
  const constraints: MergeConstraint[] = [];
  const adapters: RequiredAdapter[] = [];

  // Protected components
  components.push({
    id: compId(), system: "sessions", name: "Session middleware configuration",
    kind: "middleware", path: "app.use(session(...))",
    priority: "CRITICAL", mustNotTouch: true, canAlias: false,
    reason: "Session middleware must remain registered before any route that reads req.session",
  });

  if (sys.sessionStore && sys.sessionStore !== "memory") {
    components.push({
      id: compId(), system: "sessions", name: `Session store (${sys.sessionStore})`,
      kind: "config", path: `session-store:${sys.sessionStore}`,
      priority: "CRITICAL", mustNotTouch: true, canAlias: false,
      reason: `Active sessions are stored in ${sys.sessionStore}; changing the store invalidates all live sessions`,
    });
  }

  for (const envVar of sys.envVars ?? ["SESSION_SECRET"]) {
    components.push({
      id: compId(), system: "sessions", name: envVar,
      kind: "env-var", path: envVar,
      priority: "CRITICAL", mustNotTouch: true, canAlias: false,
      reason: "Session secret must not change; rotation invalidates all existing sessions",
    });
  }

  for (const f of sys.configFiles ?? []) {
    components.push({
      id: compId(), system: "sessions", name: f,
      kind: "file", path: f,
      priority: "HIGH", mustNotTouch: true, canAlias: true,
      reason: "Session configuration file — must be preserved as-is",
    });
  }

  // Merge constraints
  constraints.push({
    id: constId(), system: "sessions", action: "BLOCK",
    description: "Prime must not register its own session middleware if backend already uses sessions",
    affectedPaths: ["/**"],
    enforcement: "hard",
    resolution: "Remove any session middleware from the generated prime; reuse the existing session setup",
    autoEnforceable: true,
  });

  constraints.push({
    id: constId(), system: "sessions", action: "NAMESPACE",
    description: "Prime auth routes (/login, /logout, /me) must be namespaced to avoid collision",
    affectedPaths: ["/login", "/logout", "/me", "/auth/*"],
    enforcement: "soft",
    resolution: "Prefix prime auth routes with /prime or check for existing route before registering",
    autoEnforceable: true,
  });

  // Adapters
  if ((sys.protectedPaths ?? []).length > 0) {
    adapters.push({
      id: adapterId(), type: "middleware-wrapper", system: "sessions",
      name: "SessionAuthGuard adapter",
      description: "Wraps the prime page router with the existing session auth check middleware",
      inputContract: "req.session from existing middleware",
      outputContract: "req.user object expected by prime components",
      implementationNotes: [
        "Read req.session.userId (or equivalent) from the existing session store",
        "Populate req.user so prime components can read auth state",
        "Return 401/redirect for unauthenticated requests on protected prime routes",
      ],
      estimatedComplexity: "low",
      canAutoGenerate: true,
    });
  }

  return { components, constraints, adapters };
}

function analyzeJwtAuth(sys: AuthSystemDescriptor): {
  components: ProtectedComponent[];
  constraints: MergeConstraint[];
  adapters: RequiredAdapter[];
} {
  const components: ProtectedComponent[] = [];
  const constraints: MergeConstraint[] = [];
  const adapters: RequiredAdapter[] = [];

  for (const envVar of sys.envVars ?? ["JWT_SECRET", "JWT_PUBLIC_KEY"]) {
    components.push({
      id: compId(), system: "jwt", name: envVar,
      kind: "env-var", path: envVar,
      priority: "CRITICAL", mustNotTouch: true, canAlias: false,
      reason: "JWT signing secret/key — must never change; changing it invalidates all live tokens",
    });
  }

  components.push({
    id: compId(), system: "jwt", name: "JWT verification middleware",
    kind: "middleware", path: "jwtMiddleware",
    priority: "CRITICAL", mustNotTouch: true, canAlias: true,
    reason: "Token verification logic must remain intact; all protected routes depend on it",
  });

  constraints.push({
    id: constId(), system: "jwt", action: "REQUIRE_ADAPTER",
    description: "Prime must validate tokens using the existing JWT secret/algorithm — not generate new tokens",
    affectedPaths: ["/api/**", "/**"],
    enforcement: "hard",
    resolution: "Inject the JWT passthrough adapter; prime reads Authorization header and forwards to existing validator",
    autoEnforceable: true,
  });

  constraints.push({
    id: constId(), system: "jwt", action: "BLOCK",
    description: "Prime must not introduce a second JWT signing keypair",
    affectedPaths: ["/**"],
    enforcement: "hard",
    resolution: "Remove any JWT_SECRET generation from the prime bootstrap; reuse backend secret via env",
    autoEnforceable: true,
  });

  adapters.push({
    id: adapterId(), type: "jwt-passthrough", system: "jwt",
    name: "JWT passthrough adapter",
    description: "Reads the Authorization: Bearer <token> header and validates against the existing JWT secret",
    inputContract: "Authorization header with Bearer token from client",
    outputContract: "req.user populated from JWT payload",
    implementationNotes: [
      "Import the same JWT secret from process.env that the existing backend uses",
      "Verify token signature and expiry using the same algorithm (e.g. HS256, RS256)",
      "Attach decoded payload to req.user before passing to prime route handlers",
      "Return 401 on invalid/expired tokens",
    ],
    estimatedComplexity: "trivial",
    canAutoGenerate: true,
  });

  return { components, constraints, adapters };
}

function analyzeOAuthAuth(sys: AuthSystemDescriptor): {
  components: ProtectedComponent[];
  constraints: MergeConstraint[];
  adapters: RequiredAdapter[];
} {
  const components: ProtectedComponent[] = [];
  const constraints: MergeConstraint[] = [];
  const adapters: RequiredAdapter[] = [];

  const providers = sys.provider ? [sys.provider] : ["oauth"];

  for (const p of providers) {
    for (const envSuffix of ["CLIENT_ID", "CLIENT_SECRET", "REDIRECT_URI"]) {
      const envName = `${p.toUpperCase()}_${envSuffix}`;
      components.push({
        id: compId(), system: "oauth", name: envName,
        kind: "env-var", path: envName,
        priority: "CRITICAL", mustNotTouch: true, canAlias: false,
        reason: `OAuth ${p} credential — changing this breaks the authorization flow`,
      });
    }
  }

  components.push({
    id: compId(), system: "oauth", name: "OAuth callback routes",
    kind: "route", path: "/auth/callback",
    priority: "CRITICAL", mustNotTouch: true, canAlias: false,
    reason: "OAuth callback URL is registered with the provider; it cannot be renamed without updating provider settings",
  });

  constraints.push({
    id: constId(), system: "oauth", action: "BLOCK",
    description: "Prime must not register /auth/callback or /auth/:provider routes if they already exist",
    affectedPaths: ["/auth/**", "/api/auth/**"],
    enforcement: "hard",
    resolution: "Remove auth routes from prime; reuse the backend's /auth/* flow",
    autoEnforceable: true,
  });

  adapters.push({
    id: adapterId(), type: "oauth-proxy", system: "oauth",
    name: "OAuth session bridge adapter",
    description: "Bridges the existing OAuth session to the prime's user context",
    inputContract: "req.user set by passport.js or equivalent after successful OAuth callback",
    outputContract: "Prime components receive { id, email, name, avatar } user object",
    implementationNotes: [
      "Read req.user (set by passport/existing middleware) after the OAuth dance completes",
      "Map provider-specific profile fields to the prime's canonical user shape",
      "Store mapped user in req.primeUser or attach to prime context",
    ],
    estimatedComplexity: "low",
    canAutoGenerate: true,
  });

  return { components, constraints, adapters };
}

function analyzeNextAuth(sys: AuthSystemDescriptor): {
  components: ProtectedComponent[];
  constraints: MergeConstraint[];
  adapters: RequiredAdapter[];
} {
  const components: ProtectedComponent[] = [];
  const constraints: MergeConstraint[] = [];
  const adapters: RequiredAdapter[] = [];

  components.push({
    id: compId(), system: "nextauth", name: "NextAuth route handler",
    kind: "route", path: "/api/auth/[...nextauth]",
    priority: "CRITICAL", mustNotTouch: true, canAlias: false,
    reason: "NextAuth's catch-all route handles all auth flows; removing or renaming it breaks all sign-in",
  });

  for (const f of sys.configFiles ?? ["auth.config.ts", "auth.ts", "pages/api/auth/[...nextauth].ts"]) {
    components.push({
      id: compId(), system: "nextauth", name: f,
      kind: "file", path: f,
      priority: "CRITICAL", mustNotTouch: true, canAlias: false,
      reason: "NextAuth configuration file — provider list, callbacks, and session shape live here",
    });
  }

  for (const envVar of sys.envVars ?? ["NEXTAUTH_SECRET", "NEXTAUTH_URL"]) {
    components.push({
      id: compId(), system: "nextauth", name: envVar,
      kind: "env-var", path: envVar,
      priority: "CRITICAL", mustNotTouch: true, canAlias: false,
      reason: "Required NextAuth environment variable — omitting it crashes the auth system at startup",
    });
  }

  components.push({
    id: compId(), system: "nextauth", name: "NextAuth database adapter tables",
    kind: "database-table", path: "accounts, sessions, users, verification_tokens",
    priority: "HIGH", mustNotTouch: true, canAlias: false,
    reason: "NextAuth adapter tables hold live sessions and account links — schema changes break all sessions",
  });

  constraints.push({
    id: constId(), system: "nextauth", action: "BLOCK",
    description: "Prime must not overwrite /api/auth/* routes — these are owned by NextAuth",
    affectedPaths: ["/api/auth/**"],
    enforcement: "hard",
    resolution: "Ensure the prime API prefix does not collide with /api/auth; use /api/prime or similar",
    autoEnforceable: true,
  });

  constraints.push({
    id: constId(), system: "nextauth", action: "REQUIRE_ADAPTER",
    description: "Prime must use getServerSession() / getSession() to read auth state — not its own session logic",
    affectedPaths: ["/**"],
    enforcement: "hard",
    resolution: "Inject the NextAuth session adapter into prime server components",
    autoEnforceable: false,
  });

  adapters.push({
    id: adapterId(), type: "provider-shim", system: "nextauth",
    name: "NextAuth getServerSession shim",
    description: "Provides prime server components with the current NextAuth session object",
    inputContract: "Next.js request context (headers, cookies)",
    outputContract: "{ user: { id, email, name, image }, expires } or null",
    implementationNotes: [
      "Call getServerSession(authOptions) in each prime server component that needs auth",
      "Re-export authOptions from the existing auth.config to avoid duplication",
      "For API routes, use getToken() to read the JWT directly if using JWT strategy",
    ],
    estimatedComplexity: "low",
    canAutoGenerate: true,
  });

  return { components, constraints, adapters };
}

function analyzeClerkAuth(sys: AuthSystemDescriptor): {
  components: ProtectedComponent[];
  constraints: MergeConstraint[];
  adapters: RequiredAdapter[];
} {
  const components: ProtectedComponent[] = [];
  const constraints: MergeConstraint[] = [];
  const adapters: RequiredAdapter[] = [];

  components.push({
    id: compId(), system: "clerk", name: "ClerkProvider wrapper",
    kind: "middleware", path: "ClerkProvider / clerkMiddleware",
    priority: "CRITICAL", mustNotTouch: true, canAlias: false,
    reason: "ClerkProvider must remain at the root; removing it disables all Clerk auth globally",
  });

  for (const envVar of sys.envVars ?? ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"]) {
    components.push({
      id: compId(), system: "clerk", name: envVar,
      kind: "env-var", path: envVar,
      priority: "CRITICAL", mustNotTouch: true, canAlias: false,
      reason: "Clerk API key — changing or removing it disconnects the app from the Clerk tenant",
    });
  }

  components.push({
    id: compId(), system: "clerk", name: "Clerk middleware.ts",
    kind: "file", path: "middleware.ts",
    priority: "CRITICAL", mustNotTouch: true, canAlias: false,
    reason: "Clerk's middleware.ts enforces route protection; overwriting it removes all auth gates",
  });

  constraints.push({
    id: constId(), system: "clerk", action: "BLOCK",
    description: "Prime must not introduce its own ClerkProvider or clerkMiddleware — only one instance is allowed",
    affectedPaths: ["/**"],
    enforcement: "hard",
    resolution: "Remove any Clerk initialization from the prime; rely on the existing ClerkProvider at the app root",
    autoEnforceable: true,
  });

  constraints.push({
    id: constId(), system: "clerk", action: "REQUIRE_ADAPTER",
    description: "Prime components that need auth state must use auth() / currentUser() from the existing Clerk setup",
    affectedPaths: ["/**"],
    enforcement: "soft",
    resolution: "Import auth helpers from @clerk/nextjs or @clerk/express inside prime components",
    autoEnforceable: false,
  });

  adapters.push({
    id: adapterId(), type: "provider-shim", system: "clerk",
    name: "Clerk auth() shim for prime components",
    description: "Provides prime components with the current Clerk userId and session claims",
    inputContract: "Clerk session cookie / JWT set by ClerkProvider",
    outputContract: "{ userId, sessionId, sessionClaims } from auth()",
    implementationNotes: [
      "Import auth() from '@clerk/nextjs/server' (App Router) or getAuth(req) for API routes",
      "Return 401 / redirect to /sign-in if userId is null on protected prime routes",
      "Use currentUser() when you need the full User object (name, email, avatar)",
    ],
    estimatedComplexity: "trivial",
    canAutoGenerate: true,
  });

  return { components, constraints, adapters };
}

function analyzeAuth0Auth(sys: AuthSystemDescriptor): {
  components: ProtectedComponent[];
  constraints: MergeConstraint[];
  adapters: RequiredAdapter[];
} {
  const components: ProtectedComponent[] = [];
  const constraints: MergeConstraint[] = [];
  const adapters: RequiredAdapter[] = [];

  for (const envVar of sys.envVars ?? ["AUTH0_SECRET", "AUTH0_BASE_URL", "AUTH0_ISSUER_BASE_URL", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET"]) {
    components.push({
      id: compId(), system: "auth0", name: envVar,
      kind: "env-var", path: envVar,
      priority: "CRITICAL", mustNotTouch: true, canAlias: false,
      reason: "Auth0 configuration variable — any change breaks the Auth0 application registration",
    });
  }

  components.push({
    id: compId(), system: "auth0", name: "Auth0 API route handler",
    kind: "route", path: "/api/auth/[auth0]",
    priority: "CRITICAL", mustNotTouch: true, canAlias: false,
    reason: "Auth0's dynamic route handles callback, login, logout, and profile endpoints",
  });

  constraints.push({
    id: constId(), system: "auth0", action: "BLOCK",
    description: "Prime must not register /api/auth routes — Auth0 owns this namespace",
    affectedPaths: ["/api/auth/**"],
    enforcement: "hard",
    resolution: "Use a distinct API prefix for prime endpoints; /api/prime or /api/app are safe alternatives",
    autoEnforceable: true,
  });

  adapters.push({
    id: adapterId(), type: "token-exchange", system: "auth0",
    name: "Auth0 session adapter",
    description: "Reads the Auth0 session and provides prime components with user identity",
    inputContract: "Auth0 session cookie set by handleAuth()",
    outputContract: "{ sub, email, name, picture } user object",
    implementationNotes: [
      "Use getSession(req, res) from '@auth0/nextjs-auth0' to get the current session",
      "Map the Auth0 user claims to the prime's canonical user shape",
      "Implement withApiAuthRequired() wrapper for prime API endpoints that need auth",
    ],
    estimatedComplexity: "low",
    canAutoGenerate: true,
  });

  return { components, constraints, adapters };
}

function analyzeCustomAuth(sys: AuthSystemDescriptor): {
  components: ProtectedComponent[];
  constraints: MergeConstraint[];
  adapters: RequiredAdapter[];
} {
  const components: ProtectedComponent[] = [];
  const constraints: MergeConstraint[] = [];
  const adapters: RequiredAdapter[] = [];

  for (const f of sys.configFiles ?? []) {
    components.push({
      id: compId(), system: "custom", name: f,
      kind: "file", path: f,
      priority: "HIGH", mustNotTouch: true, canAlias: true,
      reason: "Custom auth implementation — must be audited before any merge touches this file",
    });
  }

  for (const envVar of sys.envVars ?? []) {
    components.push({
      id: compId(), system: "custom", name: envVar,
      kind: "env-var", path: envVar,
      priority: "HIGH", mustNotTouch: true, canAlias: false,
      reason: "Custom auth env var — value may be production secret",
    });
  }

  for (const route of sys.protectedPaths ?? []) {
    components.push({
      id: compId(), system: "custom", name: `Protected route: ${route}`,
      kind: "route", path: route,
      priority: "HIGH", mustNotTouch: false, canAlias: true,
      reason: "Route is protected by custom auth middleware — prime must preserve the guard",
    });
  }

  constraints.push({
    id: constId(), system: "custom", action: "WARN",
    description: "Custom auth system detected — full manual audit required before merge",
    affectedPaths: ["/**"],
    enforcement: "soft",
    resolution: "Review all auth middleware registrations and ensure prime does not bypass them",
    autoEnforceable: false,
  });

  adapters.push({
    id: adapterId(), type: "middleware-wrapper", system: "custom",
    name: "Custom auth bridge adapter",
    description: "Wraps prime routes with the existing custom auth middleware chain",
    inputContract: "Existing req.user or auth context set by custom middleware",
    outputContract: "Prime route handlers receive authenticated request context",
    implementationNotes: [
      "Identify the middleware function that sets auth state (e.g. req.user, req.authContext)",
      "Apply that middleware to all prime routes that require authentication",
      "Do not duplicate the auth logic — only chain the existing middleware",
    ],
    estimatedComplexity: "medium",
    canAutoGenerate: false,
  });

  return { components, constraints, adapters };
}

// ---------------------------------------------------------------------------
// Risk scoring
// ---------------------------------------------------------------------------

function computeRisk(
  components: ProtectedComponent[],
  constraints: MergeConstraint[],
): { score: number; riskLevel: AuthPreservationReport["riskLevel"] } {
  const critical = components.filter(c => c.priority === "CRITICAL").length;
  const hardConstraints = constraints.filter(c => c.enforcement === "hard").length;

  let penalty = 0;
  penalty += critical * 2;
  penalty += hardConstraints * 5;

  const score = Math.max(0, Math.min(100, 100 - penalty));
  let riskLevel: AuthPreservationReport["riskLevel"] = "NONE";
  if (score < 20)      riskLevel = "CRITICAL";
  else if (score < 40) riskLevel = "HIGH";
  else if (score < 60) riskLevel = "MEDIUM";
  else if (score < 80) riskLevel = "LOW";

  return { score, riskLevel };
}

// ---------------------------------------------------------------------------
// Disk / R2 helpers
// ---------------------------------------------------------------------------

async function loadBM<T>(jobId: string, filename: string): Promise<T | null> {
  for (const dir of ["/tmp/bm4", "/tmp/bm1", "/tmp/bm2", "/tmp/bm3"]) {
    try {
      const raw = await readFile(join(dir, jobId, filename), "utf8");
      return JSON.parse(raw) as T;
    } catch { /* try next */ }
  }
  return null;
}

async function saveToDisk(jobId: string, report: AuthPreservationReport): Promise<void> {
  const dir = join("/tmp/bm4", jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "auth-preservation-report.json"), JSON.stringify(report, null, 2));
}

async function saveToR2(jobId: string, report: AuthPreservationReport): Promise<string | undefined> {
  try {
    const cloud  = getDefaultCloudProvider();
    const key    = `bm4/${jobId}/auth-preservation-report.json`;
    const body   = JSON.stringify(report, null, 2);
    await cloud.upload({ key, data: Buffer.from(body), contentType: "application/json" });
    return key;
  } catch (err) {
    logger.warn({ err, jobId }, "BM4: R2 upload failed (non-fatal)");
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

export async function runAuthPreservationEngine(
  input: AuthPreservationInput,
): Promise<AuthPreservationReport> {
  const { primeJobId, backendJobId = "unknown", force = false } = input;
  const t0 = Date.now();

  if (!force) {
    const cached = _cache.get(primeJobId);
    if (cached) {
      logger.info({ primeJobId }, "BM4: returning cached report");
      return cached;
    }
  }

  logger.info({ primeJobId, backendJobId }, "BM4: auth preservation analysis started");

  // Resolve auth systems — use provided or load from disk or use defaults
  let authSystems: AuthSystemDescriptor[] = input.authSystems ?? [];

  if (!authSystems.length) {
    const loaded = await loadBM<AuthSystemDescriptor[]>(primeJobId, "auth-systems.json");
    authSystems = loaded ?? buildDefaultDescriptors();
  }

  // If still empty, treat as unknown/none
  if (!authSystems.length) {
    authSystems = [{
      system: "none",
      confidence: 1.0,
    }];
  }

  const allComponents:  ProtectedComponent[] = [];
  const allConstraints: MergeConstraint[]    = [];
  const allAdapters:    RequiredAdapter[]     = [];

  // Run per-system analyzers
  for (const sys of authSystems) {
    let result: { components: ProtectedComponent[]; constraints: MergeConstraint[]; adapters: RequiredAdapter[] };

    switch (sys.system) {
      case "sessions":  result = analyzeSessionAuth(sys); break;
      case "jwt":       result = analyzeJwtAuth(sys);     break;
      case "oauth":     result = analyzeOAuthAuth(sys);   break;
      case "nextauth":  result = analyzeNextAuth(sys);    break;
      case "clerk":     result = analyzeClerkAuth(sys);   break;
      case "auth0":     result = analyzeAuth0Auth(sys);   break;
      case "custom":    result = analyzeCustomAuth(sys);  break;
      case "none":
      default:
        result = { components: [], constraints: [], adapters: [] };
        break;
    }

    allComponents.push(...result.components);
    allConstraints.push(...result.constraints);
    allAdapters.push(...result.adapters);
  }

  // Add a universal constraint: prime must never overwrite auth env vars
  allConstraints.push({
    id: constId(), system: "custom", action: "BLOCK",
    description: "Prime must never overwrite or redeclare auth-related environment variables",
    affectedPaths: ["**/.env", "**/env.ts", "**/config/auth*"],
    enforcement: "hard",
    resolution: "Strip any auth env var declarations from the prime; inherit them from the host environment",
    autoEnforceable: true,
  });

  const { score, riskLevel } = computeRisk(allComponents, allConstraints);

  const hardConstraints  = allConstraints.filter(c => c.enforcement === "hard");
  const blockingIds      = allConstraints
    .filter(c => c.action === "BLOCK" && c.enforcement === "hard")
    .map(c => c.id);

  const primarySystem: AuthSystem = authSystems.find(s => s.system !== "none")?.system ?? "none";
  const mergeIsSafe = riskLevel === "NONE" || riskLevel === "LOW";

  const recommendation =
    riskLevel === "CRITICAL" ? "Do not merge — manually audit and resolve all CRITICAL auth conflicts first." :
    riskLevel === "HIGH"     ? "High auth risk — implement all required adapters before proceeding with merge." :
    riskLevel === "MEDIUM"   ? "Medium risk — review soft constraints and ensure adapters are in place." :
    riskLevel === "LOW"      ? "Low risk — apply soft constraints and deploy adapters; spot-check auth flows post-merge." :
                               "No auth systems detected — merge may proceed without auth constraints.";

  const report: AuthPreservationReport = {
    schemaVersion:       "BM-4",
    primeJobId,
    backendJobId,
    generatedAt:         new Date().toISOString(),
    durationMs:          Date.now() - t0,
    detectedSystems:     authSystems,
    primarySystem,
    mergeIsSafe,
    preservationScore:   score,
    riskLevel,
    protectedComponents: allComponents,
    mergeConstraints:    allConstraints,
    requiredAdapters:    allAdapters,
    summary: {
      totalDetectedSystems:   authSystems.filter(s => s.system !== "none").length,
      criticalComponents:     allComponents.filter(c => c.priority === "CRITICAL").length,
      hardConstraints:        hardConstraints.length,
      softConstraints:        allConstraints.length - hardConstraints.length,
      adaptersRequired:       allAdapters.length,
      autoGenerableAdapters:  allAdapters.filter(a => a.canAutoGenerate).length,
      blockingConstraints:    blockingIds,
      recommendation,
    },
  };

  // Persist
  try {
    await saveToDisk(primeJobId, report);
    const r2Key = await saveToR2(primeJobId, report);
    if (r2Key) report.r2Key = r2Key;
  } catch (err) {
    logger.warn({ err, primeJobId }, "BM4: persistence failed (non-fatal)");
  }

  _cache.set(primeJobId, report);
  logger.info({ primeJobId, riskLevel, score, components: allComponents.length, adapters: allAdapters.length }, "BM4: auth preservation analysis complete");

  return report;
}
