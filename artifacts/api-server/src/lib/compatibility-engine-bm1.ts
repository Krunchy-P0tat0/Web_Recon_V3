/**
 * compatibility-engine-bm1.ts — Phase BM-1: Compatibility Engine
 *
 * Determines whether a generated Website Prime can safely merge into an
 * existing backend by analyzing seven independent dimensions.
 *
 * Seven dimensions (each scored 0–100 individually):
 *   routes           — path/method overlaps between prime and backend
 *   database         — schema, ORM, and driver compatibility
 *   authentication   — auth strategy, token format, session store
 *   storage          — file storage provider and bucket configuration
 *   cms              — headless CMS platform and content model
 *   apiLayer         — API protocol, version, and contract shape
 *   frontendFramework— UI framework, SSR strategy, and build tooling
 *
 * Each merge candidate is classified:
 *   SAFE    — can proceed directly, no manual intervention required
 *   WARNING — merge possible but requires adjustments / manual review
 *   BLOCKED — hard incompatibility; blocked until resolved
 *
 * Overall compatibilityScore (0–100) is a weighted average:
 *   routes 20% · database 20% · auth 15% · apiLayer 15% · frontend 15%
 *   storage 10% · cms 5%
 *
 * Outputs (disk + R2):
 *   compatibility-report.json — full report with all dimensions and candidates
 *
 * Data sources (all optional, engine degrades gracefully):
 *   - VR-3 LayoutMapBundle   → page routes
 *   - VR-4 ComponentLibrary  → frontend component hints
 *   - VR-6 ConsistencyRules  → framework/typography hints
 *   - HTTP framework fingerprint (lib/http-framework-fingerprinter.ts output)
 *   - Backend profile (passed directly or loaded from disk)
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join }                        from "path";
import { logger }                      from "./logger.js";
import { getDefaultCloudProvider }     from "../cloud/index.js";
import type { LayoutMapBundle }        from "./visual-layout-mapper-engine.js";
import type { ComponentLibrary }       from "./component-extraction-engine.js";
import type { ConsistencyRules }       from "./consistency-engine-vr6.js";

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type MergeClassification = "SAFE" | "WARNING" | "BLOCKED";

export type CompatibilityDimension =
  | "routes"
  | "database"
  | "authentication"
  | "storage"
  | "cms"
  | "apiLayer"
  | "frontendFramework";

// ---------------------------------------------------------------------------
// Merge candidate
// ---------------------------------------------------------------------------

export interface MergeCandidate {
  id:             string;
  dimension:      CompatibilityDimension;
  classification: MergeClassification;
  name:           string;       // what is being merged (e.g. "GET /api/users")
  description:    string;       // why this classification was assigned
  primeValue:     string;       // what the generated prime provides
  backendValue:   string;       // what the existing backend provides
  resolution:     string;       // recommended action
  severity:       "critical" | "high" | "medium" | "low" | "none";
  autoResolvable: boolean;      // can the pipeline handle this without manual work?
}

// ---------------------------------------------------------------------------
// Per-dimension result
// ---------------------------------------------------------------------------

export interface DimensionResult {
  dimension:      CompatibilityDimension;
  score:          number;                // 0–100
  classification: MergeClassification;  // worst classification in this dimension
  candidates:     MergeCandidate[];
  safe:           MergeCandidate[];
  risky:          MergeCandidate[];
  blocked:        MergeCandidate[];
  confidence:     number;               // how confident we are in this score (0–1)
  notes:          string[];
}

// ---------------------------------------------------------------------------
// Backend profile (input) — what the existing backend looks like
// ---------------------------------------------------------------------------

export interface RouteDescriptor {
  path:    string;
  methods: string[];   // GET, POST, etc.
  auth?:   boolean;
  type?:   "page" | "api" | "static" | "webhook";
}

export interface DatabaseProfile {
  engine:  string;   // postgres, mysql, sqlite, mongodb, dynamodb, supabase, firebase, none
  orm?:    string;   // drizzle, prisma, sequelize, typeorm, mongoose, none
  driver?: string;
  version?: string;
}

export interface AuthProfile {
  strategy: string[];  // jwt, session, oauth2, api-key, basic, clerk, replit, none
  providers?: string[];
  sessionStore?: string;  // redis, memory, cookie, database
}

export interface StorageProfile {
  provider: string;   // s3, r2, gcs, azure-blob, local, supabase-storage, none
  bucket?:  string;
  region?:  string;
}

export interface CmsProfile {
  platform: string;  // contentful, sanity, strapi, wordpress, ghost, custom, none
  version?: string;
  headless?: boolean;
}

export interface ApiProfile {
  protocol:  string;   // rest, graphql, trpc, grpc, soap, none
  version?:  string;   // v1, v2, etc.
  prefix?:   string;   // /api, /graphql
  authScheme?: string; // bearer, basic, api-key
}

export interface FrontendProfile {
  framework:  string;   // react, vue, angular, svelte, nextjs, nuxt, gatsby, vanilla, none
  ssr?:       boolean;
  buildTool?: string;   // vite, webpack, parcel, esbuild, none
  typescript?: boolean;
}

export interface ExistingBackendProfile {
  backendJobId?:   string;
  backendUrl?:     string;
  detectedAt?:     string;
  routes:          RouteDescriptor[];
  database:        DatabaseProfile;
  auth:            AuthProfile;
  storage:         StorageProfile;
  cms:             CmsProfile;
  api:             ApiProfile;
  frontend:        FrontendProfile;
  confidence:      number;
}

// ---------------------------------------------------------------------------
// Website Prime profile (generated output being assessed)
// ---------------------------------------------------------------------------

export interface WebsitePrimeProfile {
  primeJobId:      string;
  seedUrl?:        string;
  routes:          RouteDescriptor[];
  database:        DatabaseProfile;
  auth:            AuthProfile;
  storage:         StorageProfile;
  cms:             CmsProfile;
  api:             ApiProfile;
  frontend:        FrontendProfile;
  pageCount:       number;
  componentTypes:  string[];
}

// ---------------------------------------------------------------------------
// Output — compatibility-report.json
// ---------------------------------------------------------------------------

export interface CompatibilityReport {
  schemaVersion:     "BM-1";
  primeJobId:        string;
  backendJobId:      string;
  seedUrl:           string;
  generatedAt:       string;
  durationMs:        number;
  compatibilityScore: number;   // 0–100 weighted average
  grade:             "A" | "B" | "C" | "D" | "F";
  overallClassification: MergeClassification;
  dimensions:        Record<CompatibilityDimension, DimensionResult>;
  // Flattened views (as specified in the task)
  conflicts:         MergeCandidate[];   // WARNING + BLOCKED
  safeMerges:        MergeCandidate[];   // SAFE
  riskyMerges:       MergeCandidate[];   // WARNING
  blockedMerges:     MergeCandidate[];   // BLOCKED
  summary: {
    totalCandidates: number;
    safeCount:       number;
    warningCount:    number;
    blockedCount:    number;
    autoResolvable:  number;
    requiresManual:  number;
    criticalBlocks:  string[];
    readyToMerge:    boolean;   // true only when no BLOCKED items
  };
  primeProfile:      WebsitePrimeProfile;
  backendProfile:    ExistingBackendProfile;
  r2Key?:            string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const _cache = new Map<string, CompatibilityReport>();

export function getCachedCompatibilityReport(primeJobId: string): CompatibilityReport | undefined {
  return _cache.get(primeJobId);
}

// ---------------------------------------------------------------------------
// Disk loader helpers
// ---------------------------------------------------------------------------

async function loadVR<T>(jobId: string, filename: string): Promise<T | null> {
  const dirs = ["vr6", "vr5", "vr4", "vr3", "vr2", "vr7", "vr8"];
  for (const d of dirs) {
    try {
      const raw = await readFile(join(`/tmp/${d}`, jobId, filename), "utf8");
      return JSON.parse(raw) as T;
    } catch { /* next */ }
  }
  return null;
}

async function loadBM<T>(jobId: string, filename: string): Promise<T | null> {
  try {
    const raw = await readFile(join("/tmp/bm1", jobId, filename), "utf8");
    return JSON.parse(raw) as T;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Prime profile derivation (from VR pipeline outputs)
// ---------------------------------------------------------------------------

async function derivePrimeProfile(
  primeJobId: string,
  layoutMap:  LayoutMapBundle | null,
  components: ComponentLibrary | null,
  rules:      ConsistencyRules | null,
): Promise<WebsitePrimeProfile> {
  // Routes from VR-3 page URLs
  const routes: RouteDescriptor[] = (layoutMap?.pages ?? []).map(p => {
    let path = "/";
    try { path = new URL(p.url, "http://x").pathname; } catch { path = p.url; }
    return { path, methods: ["GET"], type: "page" };
  });
  if (!routes.length) routes.push({ path: "/", methods: ["GET"], type: "page" });

  // Component types from VR-4
  const componentTypes = components?.components.map(c => c.type) ?? [];

  // Frontend framework hints from VR-6 typography (font stacks often reveal framework)
  const families = rules?.typography.families ?? [];
  const isTailwind = families.some(f => f.toLowerCase().includes("inter") || f.toLowerCase().includes("dm sans"));
  const framework = isTailwind ? "react" : "vanilla";

  // Page count
  const pageCount = layoutMap?.pages.length ?? 1;

  return {
    primeJobId,
    routes,
    pageCount,
    componentTypes,
    database:  { engine: "none" },
    auth:      { strategy: ["none"] },
    storage:   { provider: "r2" },
    cms:       { platform: "none" },
    api:       { protocol: "rest", prefix: "/api" },
    frontend:  { framework, buildTool: "vite", typescript: true },
  };
}

// ---------------------------------------------------------------------------
// Candidate ID generator
// ---------------------------------------------------------------------------

let _candidateSeq = 0;
function candidateId(dim: CompatibilityDimension): string {
  return `${dim.slice(0, 3).toUpperCase()}-${String(++_candidateSeq).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

function clamp(v: number): number { return Math.max(0, Math.min(100, Math.round(v))); }

function worstClassification(candidates: MergeCandidate[]): MergeClassification {
  if (candidates.some(c => c.classification === "BLOCKED"))  return "BLOCKED";
  if (candidates.some(c => c.classification === "WARNING"))  return "WARNING";
  return "SAFE";
}

function dimensionScore(candidates: MergeCandidate[]): number {
  if (!candidates.length) return 90;
  const penalty = candidates.reduce((sum, c) => {
    if (c.classification === "BLOCKED")  return sum + (c.severity === "critical" ? 40 : 25);
    if (c.classification === "WARNING")  return sum + (c.severity === "high" ? 15 : 8);
    return sum;
  }, 0);
  return clamp(100 - penalty);
}

function grade(score: number): CompatibilityReport["grade"] {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

function buildDimension(
  dimension: CompatibilityDimension,
  candidates: MergeCandidate[],
  notes: string[],
  confidence: number,
): DimensionResult {
  const safe    = candidates.filter(c => c.classification === "SAFE");
  const risky   = candidates.filter(c => c.classification === "WARNING");
  const blocked = candidates.filter(c => c.classification === "BLOCKED");
  const score   = dimensionScore(candidates);
  return {
    dimension,
    score,
    classification: worstClassification(candidates),
    candidates,
    safe,
    risky,
    blocked,
    confidence,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Dimension analyzers
// ---------------------------------------------------------------------------

// ── ROUTES ─────────────────────────────────────────────────────────────────

function analyzeRoutes(
  prime:   WebsitePrimeProfile,
  backend: ExistingBackendProfile,
): DimensionResult {
  const candidates: MergeCandidate[] = [];
  const notes: string[] = [];

  const backendPaths = new Set(backend.routes.map(r => r.path));
  const backendApiPaths = new Set(
    backend.routes.filter(r => r.type === "api").map(r => r.path)
  );

  for (const pr of prime.routes) {
    const existsInBackend = backendPaths.has(pr.path);
    const isApi = pr.type === "api";

    if (existsInBackend) {
      const br = backend.routes.find(r => r.path === pr.path);
      const methodConflict = br && pr.methods.some(m => !br.methods.includes(m) && br.methods.length > 0);

      if (methodConflict) {
        candidates.push({
          id: candidateId("routes"), dimension: "routes", classification: "WARNING",
          name:         `${pr.methods.join(",")} ${pr.path}`,
          description:  `Route exists in backend with different method set`,
          primeValue:   pr.methods.join(", "),
          backendValue: br!.methods.join(", "),
          resolution:   "Align route method declarations or configure method fallthrough",
          severity:     "medium",
          autoResolvable: false,
        });
      } else if (isApi) {
        candidates.push({
          id: candidateId("routes"), dimension: "routes", classification: "BLOCKED",
          name:         pr.path,
          description:  `API route conflict — both prime and backend define this endpoint`,
          primeValue:   "prime defines " + pr.path,
          backendValue: "backend already handles " + pr.path,
          resolution:   "Namespace the prime API under a distinct prefix (e.g. /prime/api) or remove the duplicate",
          severity:     "high",
          autoResolvable: false,
        });
      } else {
        candidates.push({
          id: candidateId("routes"), dimension: "routes", classification: "WARNING",
          name:         pr.path,
          description:  `Page route collision — both prime and backend serve this path`,
          primeValue:   "prime page",
          backendValue: "existing backend page",
          resolution:   "Redirect the backend route or rename the prime page path",
          severity:     "medium",
          autoResolvable: true,
        });
      }
    } else {
      candidates.push({
        id: candidateId("routes"), dimension: "routes", classification: "SAFE",
        name:         pr.path,
        description:  `Route is new — no conflict with existing backend`,
        primeValue:   pr.methods.join(", ") + " " + pr.path,
        backendValue: "not present",
        resolution:   "Register route in backend router",
        severity:     "none",
        autoResolvable: true,
      });
    }
  }

  // Check if backend has auth-protected routes the prime might need
  const authProtected = backend.routes.filter(r => r.auth).map(r => r.path);
  if (authProtected.length > 0 && prime.auth.strategy.includes("none")) {
    notes.push(`Backend has ${authProtected.length} auth-protected routes; prime has no auth strategy defined`);
  }

  const newRoutes    = candidates.filter(c => c.classification === "SAFE").length;
  const conflicting  = candidates.filter(c => c.classification !== "SAFE").length;
  notes.push(`${newRoutes} new route(s) to add, ${conflicting} conflict(s) detected`);

  return buildDimension("routes", candidates, notes, backend.routes.length > 0 ? 0.90 : 0.50);
}

// ── DATABASE ───────────────────────────────────────────────────────────────

function analyzeDatabase(
  prime:   WebsitePrimeProfile,
  backend: ExistingBackendProfile,
): DimensionResult {
  const candidates: MergeCandidate[] = [];
  const notes: string[] = [];

  const primeEngine   = prime.database.engine;
  const backendEngine = backend.database.engine;

  // Engine compatibility
  if (primeEngine === "none" || primeEngine === backendEngine) {
    candidates.push({
      id: candidateId("database"), dimension: "database", classification: "SAFE",
      name:         "Database engine",
      description:  primeEngine === "none"
        ? "Prime requires no database — no conflict"
        : `Both prime and backend use ${backendEngine}`,
      primeValue:   primeEngine,
      backendValue: backendEngine,
      resolution:   "No action required",
      severity:     "none",
      autoResolvable: true,
    });
  } else if (
    (primeEngine === "postgres" && backendEngine === "supabase") ||
    (primeEngine === "supabase" && backendEngine === "postgres") ||
    (primeEngine === "mysql"    && backendEngine === "mariadb") ||
    (primeEngine === "mariadb"  && backendEngine === "mysql")
  ) {
    candidates.push({
      id: candidateId("database"), dimension: "database", classification: "WARNING",
      name:         "Database engine compatibility",
      description:  `Engines are compatible but not identical`,
      primeValue:   primeEngine,
      backendValue: backendEngine,
      resolution:   "Verify connection strings and driver configs; test a staging deployment",
      severity:     "medium",
      autoResolvable: false,
    });
    notes.push(`Engine near-match: ${primeEngine} ↔ ${backendEngine} — minor config adjustment needed`);
  } else if (primeEngine !== "none" && backendEngine !== "none" && primeEngine !== backendEngine) {
    candidates.push({
      id: candidateId("database"), dimension: "database", classification: "BLOCKED",
      name:         "Database engine mismatch",
      description:  `Prime expects ${primeEngine} but backend runs ${backendEngine}`,
      primeValue:   primeEngine,
      backendValue: backendEngine,
      resolution:   "Migrate the prime to use the backend's database engine, or deploy a separate DB instance",
      severity:     "critical",
      autoResolvable: false,
    });
  }

  // ORM compatibility
  if (prime.database.orm && backend.database.orm && prime.database.orm !== backend.database.orm) {
    candidates.push({
      id: candidateId("database"), dimension: "database", classification: "WARNING",
      name:         "ORM mismatch",
      description:  `Prime uses ${prime.database.orm} but backend uses ${backend.database.orm}`,
      primeValue:   prime.database.orm,
      backendValue: backend.database.orm,
      resolution:   "Standardise on one ORM, or keep isolated data access layers",
      severity:     "medium",
      autoResolvable: false,
    });
  }

  if (!candidates.length) {
    candidates.push({
      id: candidateId("database"), dimension: "database", classification: "SAFE",
      name: "Database", description: "No database conflicts detected",
      primeValue: primeEngine, backendValue: backendEngine,
      resolution: "No action required", severity: "none", autoResolvable: true,
    });
  }

  return buildDimension("database", candidates, notes, 0.85);
}

// ── AUTHENTICATION ─────────────────────────────────────────────────────────

function analyzeAuthentication(
  prime:   WebsitePrimeProfile,
  backend: ExistingBackendProfile,
): DimensionResult {
  const candidates: MergeCandidate[] = [];
  const notes: string[] = [];

  const primeStrats   = prime.auth.strategy.filter(s => s !== "none");
  const backendStrats = backend.auth.strategy.filter(s => s !== "none");

  if (!primeStrats.length) {
    candidates.push({
      id: candidateId("authentication"), dimension: "authentication", classification: "SAFE",
      name:         "Authentication strategy",
      description:  "Prime requires no authentication — safe to merge",
      primeValue:   "none",
      backendValue: backendStrats.join(", ") || "none",
      resolution:   "No action required",
      severity:     "none",
      autoResolvable: true,
    });
  } else if (!backendStrats.length) {
    candidates.push({
      id: candidateId("authentication"), dimension: "authentication", classification: "WARNING",
      name:         "Auth strategy missing in backend",
      description:  `Prime requires ${primeStrats.join(", ")} but backend has no auth configured`,
      primeValue:   primeStrats.join(", "),
      backendValue: "none",
      resolution:   "Implement the required auth strategy in the backend before merging",
      severity:     "high",
      autoResolvable: false,
    });
  } else {
    // Check strategy compatibility
    const overlap = primeStrats.filter(s => backendStrats.includes(s));
    if (overlap.length > 0) {
      candidates.push({
        id: candidateId("authentication"), dimension: "authentication", classification: "SAFE",
        name:         "Auth strategy",
        description:  `Compatible strategies: ${overlap.join(", ")}`,
        primeValue:   primeStrats.join(", "),
        backendValue: backendStrats.join(", "),
        resolution:   "No action required",
        severity:     "none",
        autoResolvable: true,
      });
    } else {
      const isCompatiblePair = (a: string, b: string) => {
        const pairs: Array<[string, string]> = [
          ["jwt", "bearer"], ["clerk", "jwt"], ["replit", "oauth2"],
          ["session", "cookie"], ["api-key", "bearer"],
        ];
        return pairs.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
      };
      const anyCompatible = primeStrats.some(ps => backendStrats.some(bs => isCompatiblePair(ps, bs)));
      candidates.push({
        id: candidateId("authentication"), dimension: "authentication",
        classification: anyCompatible ? "WARNING" : "BLOCKED",
        name:         "Auth strategy mismatch",
        description:  `Prime uses ${primeStrats.join(", ")} which is incompatible with backend ${backendStrats.join(", ")}`,
        primeValue:   primeStrats.join(", "),
        backendValue: backendStrats.join(", "),
        resolution:   anyCompatible
          ? "Adapt the prime's auth middleware to conform to the backend's strategy"
          : "Refactor prime authentication to match the backend strategy or adopt a shared auth provider",
        severity:     anyCompatible ? "medium" : "critical",
        autoResolvable: false,
      });
    }
  }

  // Session store check
  if (prime.auth.sessionStore && backend.auth.sessionStore &&
      prime.auth.sessionStore !== backend.auth.sessionStore) {
    candidates.push({
      id: candidateId("authentication"), dimension: "authentication", classification: "WARNING",
      name:         "Session store mismatch",
      description:  `Prime uses ${prime.auth.sessionStore} sessions vs backend's ${backend.auth.sessionStore}`,
      primeValue:   prime.auth.sessionStore,
      backendValue: backend.auth.sessionStore,
      resolution:   "Standardise session storage or configure prime to use the backend's store",
      severity:     "medium",
      autoResolvable: false,
    });
  }

  return buildDimension("authentication", candidates, notes, 0.88);
}

// ── STORAGE ────────────────────────────────────────────────────────────────

function analyzeStorage(
  prime:   WebsitePrimeProfile,
  backend: ExistingBackendProfile,
): DimensionResult {
  const candidates: MergeCandidate[] = [];
  const notes: string[] = [];

  const primeProv   = prime.storage.provider;
  const backendProv = backend.storage.provider;

  if (primeProv === "none" || primeProv === backendProv) {
    candidates.push({
      id: candidateId("storage"), dimension: "storage", classification: "SAFE",
      name:         "Storage provider",
      description:  primeProv === "none" ? "Prime uses no file storage" : `Both use ${backendProv}`,
      primeValue:   primeProv,
      backendValue: backendProv,
      resolution:   "No action required",
      severity:     "none",
      autoResolvable: true,
    });
  } else {
    // R2 and S3 are API-compatible
    const s3Compatible = ["s3", "r2", "minio", "wasabi", "backblaze-b2"];
    if (s3Compatible.includes(primeProv) && s3Compatible.includes(backendProv)) {
      candidates.push({
        id: candidateId("storage"), dimension: "storage", classification: "WARNING",
        name:         "Storage provider (S3-compatible)",
        description:  `Both providers are S3-compatible but have different configurations`,
        primeValue:   primeProv,
        backendValue: backendProv,
        resolution:   "Update prime storage credentials and endpoint to point to the backend's provider",
        severity:     "low",
        autoResolvable: true,
      });
    } else {
      candidates.push({
        id: candidateId("storage"), dimension: "storage", classification: "BLOCKED",
        name:         "Storage provider incompatibility",
        description:  `Prime uses ${primeProv} which is not compatible with backend's ${backendProv}`,
        primeValue:   primeProv,
        backendValue: backendProv,
        resolution:   "Migrate prime file storage to use the backend's provider, or set up a storage adapter layer",
        severity:     "high",
        autoResolvable: false,
      });
    }
  }

  if (prime.storage.bucket && backend.storage.bucket &&
      prime.storage.bucket !== backend.storage.bucket) {
    notes.push(`Different buckets: prime="${prime.storage.bucket}", backend="${backend.storage.bucket}"`);
    candidates.push({
      id: candidateId("storage"), dimension: "storage", classification: "WARNING",
      name:         "Storage bucket mismatch",
      description:  `Prime targets a different bucket`,
      primeValue:   prime.storage.bucket,
      backendValue: backend.storage.bucket,
      resolution:   "Configure prime to use the backend's bucket, or create separate prefixes in the same bucket",
      severity:     "low",
      autoResolvable: true,
    });
  }

  return buildDimension("storage", candidates, notes, backendProv !== "none" ? 0.90 : 0.60);
}

// ── CMS ────────────────────────────────────────────────────────────────────

function analyzeCms(
  prime:   WebsitePrimeProfile,
  backend: ExistingBackendProfile,
): DimensionResult {
  const candidates: MergeCandidate[] = [];
  const notes: string[] = [];

  const primePlat   = prime.cms.platform;
  const backendPlat = backend.cms.platform;

  if (primePlat === "none") {
    candidates.push({
      id: candidateId("cms"), dimension: "cms", classification: "SAFE",
      name:         "CMS",
      description:  "Prime has no CMS dependency — no conflict",
      primeValue:   "none",
      backendValue: backendPlat,
      resolution:   "No action required",
      severity:     "none",
      autoResolvable: true,
    });
  } else if (primePlat === backendPlat) {
    candidates.push({
      id: candidateId("cms"), dimension: "cms", classification: "SAFE",
      name:         "CMS platform",
      description:  `Both use ${backendPlat}`,
      primeValue:   primePlat,
      backendValue: backendPlat,
      resolution:   "Merge content models — ensure there are no field name conflicts",
      severity:     "low",
      autoResolvable: false,
    });
  } else if (backendPlat === "none") {
    candidates.push({
      id: candidateId("cms"), dimension: "cms", classification: "WARNING",
      name:         "CMS platform not in backend",
      description:  `Prime requires ${primePlat} but backend has no CMS`,
      primeValue:   primePlat,
      backendValue: "none",
      resolution:   "Set up the required CMS integration in the backend, or remove CMS dependency from prime",
      severity:     "high",
      autoResolvable: false,
    });
  } else {
    candidates.push({
      id: candidateId("cms"), dimension: "cms", classification: "BLOCKED",
      name:         "CMS platform mismatch",
      description:  `Prime uses ${primePlat} but backend uses ${backendPlat}`,
      primeValue:   primePlat,
      backendValue: backendPlat,
      resolution:   "Migrate the prime to use the backend's CMS platform, or add a CMS adapter layer",
      severity:     "high",
      autoResolvable: false,
    });
  }

  return buildDimension("cms", candidates, notes, 0.80);
}

// ── API LAYER ──────────────────────────────────────────────────────────────

function analyzeApiLayer(
  prime:   WebsitePrimeProfile,
  backend: ExistingBackendProfile,
): DimensionResult {
  const candidates: MergeCandidate[] = [];
  const notes: string[] = [];

  const primeProto   = prime.api.protocol;
  const backendProto = backend.api.protocol;

  // Protocol compatibility
  if (primeProto === backendProto || primeProto === "none" || backendProto === "none") {
    candidates.push({
      id: candidateId("apiLayer"), dimension: "apiLayer", classification: "SAFE",
      name:         "API protocol",
      description:  primeProto === "none" ? "Prime exposes no API" : `Both use ${backendProto}`,
      primeValue:   primeProto,
      backendValue: backendProto,
      resolution:   "No action required",
      severity:     "none",
      autoResolvable: true,
    });
  } else if (
    (primeProto === "rest" && backendProto === "rest") ||
    (primeProto === "graphql" && backendProto === "graphql")
  ) {
    candidates.push({
      id: candidateId("apiLayer"), dimension: "apiLayer", classification: "SAFE",
      name:         "API protocol", description: `Both use ${primeProto}`,
      primeValue:   primeProto, backendValue: backendProto,
      resolution:   "No action required", severity: "none", autoResolvable: true,
    });
  } else {
    candidates.push({
      id: candidateId("apiLayer"), dimension: "apiLayer", classification: "BLOCKED",
      name:         "API protocol mismatch",
      description:  `Prime uses ${primeProto} but backend exposes ${backendProto}`,
      primeValue:   primeProto,
      backendValue: backendProto,
      resolution:   "Add a protocol adapter or migrate one side to use a compatible protocol",
      severity:     "critical",
      autoResolvable: false,
    });
  }

  // API prefix conflict
  if (prime.api.prefix && backend.api.prefix && prime.api.prefix !== backend.api.prefix) {
    notes.push(`API prefix mismatch: prime="${prime.api.prefix}", backend="${backend.api.prefix}"`);
    candidates.push({
      id: candidateId("apiLayer"), dimension: "apiLayer", classification: "WARNING",
      name:         "API prefix mismatch",
      description:  `Prime serves API at ${prime.api.prefix}, backend at ${backend.api.prefix}`,
      primeValue:   prime.api.prefix,
      backendValue: backend.api.prefix,
      resolution:   "Align API prefixes via proxy rewrite rules or update the prime's router base path",
      severity:     "medium",
      autoResolvable: true,
    });
  }

  // Version mismatch
  if (prime.api.version && backend.api.version && prime.api.version !== backend.api.version) {
    candidates.push({
      id: candidateId("apiLayer"), dimension: "apiLayer", classification: "WARNING",
      name:         "API version mismatch",
      description:  `Prime targets API ${prime.api.version}, backend exposes ${backend.api.version}`,
      primeValue:   prime.api.version,
      backendValue: backend.api.version,
      resolution:   "Add versioning middleware or update prime to target the backend's API version",
      severity:     "medium",
      autoResolvable: false,
    });
  }

  return buildDimension("apiLayer", candidates, notes, 0.85);
}

// ── FRONTEND FRAMEWORK ─────────────────────────────────────────────────────

function analyzeFrontendFramework(
  prime:   WebsitePrimeProfile,
  backend: ExistingBackendProfile,
): DimensionResult {
  const candidates: MergeCandidate[] = [];
  const notes: string[] = [];

  const primeFramework   = prime.frontend.framework;
  const backendFramework = backend.frontend.framework;

  // Framework compatibility matrix
  const compatiblePairs: Array<[string, string]> = [
    ["react",  "nextjs"],
    ["react",  "gatsby"],
    ["react",  "vite"],
    ["vue",    "nuxt"],
    ["svelte", "sveltekit"],
    ["vanilla","none"],
  ];

  const isCompatible = (a: string, b: string) =>
    a === b || compatiblePairs.some(([x, y]) => (a === x && b === y) || (a === y && b === x));

  if (primeFramework === "none" || primeFramework === backendFramework) {
    candidates.push({
      id: candidateId("frontendFramework"), dimension: "frontendFramework", classification: "SAFE",
      name:         "Frontend framework",
      description:  primeFramework === "none" ? "Prime has no frontend framework requirement" : `Both use ${backendFramework}`,
      primeValue:   primeFramework,
      backendValue: backendFramework,
      resolution:   "No action required",
      severity:     "none",
      autoResolvable: true,
    });
  } else if (isCompatible(primeFramework, backendFramework)) {
    candidates.push({
      id: candidateId("frontendFramework"), dimension: "frontendFramework", classification: "WARNING",
      name:         "Frontend framework (compatible variant)",
      description:  `${primeFramework} and ${backendFramework} are compatible but require configuration alignment`,
      primeValue:   primeFramework,
      backendValue: backendFramework,
      resolution:   "Verify build pipeline compatibility; check that the prime's components render correctly in the backend's framework wrapper",
      severity:     "low",
      autoResolvable: false,
    });
  } else {
    candidates.push({
      id: candidateId("frontendFramework"), dimension: "frontendFramework", classification: "BLOCKED",
      name:         "Frontend framework incompatibility",
      description:  `Prime uses ${primeFramework} which cannot be merged into a ${backendFramework} application`,
      primeValue:   primeFramework,
      backendValue: backendFramework,
      resolution:   "Rebuild the prime's frontend layer using the backend's framework, or serve the prime as a microfrontend on a separate path",
      severity:     "critical",
      autoResolvable: false,
    });
  }

  // Build tool compatibility
  if (prime.frontend.buildTool && backend.frontend.buildTool &&
      prime.frontend.buildTool !== backend.frontend.buildTool &&
      prime.frontend.buildTool !== "none" && backend.frontend.buildTool !== "none") {
    candidates.push({
      id: candidateId("frontendFramework"), dimension: "frontendFramework", classification: "WARNING",
      name:         "Build tool mismatch",
      description:  `Prime builds with ${prime.frontend.buildTool}, backend uses ${backend.frontend.buildTool}`,
      primeValue:   prime.frontend.buildTool,
      backendValue: backend.frontend.buildTool,
      resolution:   "Standardise on one build tool or configure monorepo workspace builds",
      severity:     "medium",
      autoResolvable: false,
    });
    notes.push(`Build tool mismatch may require CI/CD pipeline adjustment`);
  }

  // TypeScript mismatch
  if (prime.frontend.typescript === true && backend.frontend.typescript === false) {
    candidates.push({
      id: candidateId("frontendFramework"), dimension: "frontendFramework", classification: "WARNING",
      name:         "TypeScript / JavaScript mismatch",
      description:  "Prime is TypeScript but backend frontend is plain JavaScript",
      primeValue:   "TypeScript",
      backendValue: "JavaScript",
      resolution:   "Configure allowJs in the backend tsconfig, or gradually migrate the backend to TypeScript",
      severity:     "low",
      autoResolvable: true,
    });
  }

  return buildDimension("frontendFramework", candidates, notes, 0.85);
}

// ---------------------------------------------------------------------------
// Overall score (weighted)
// ---------------------------------------------------------------------------

const DIMENSION_WEIGHTS: Record<CompatibilityDimension, number> = {
  routes:           0.20,
  database:         0.20,
  authentication:   0.15,
  apiLayer:         0.15,
  frontendFramework:0.15,
  storage:          0.10,
  cms:              0.05,
};

function weightedScore(dims: Record<CompatibilityDimension, DimensionResult>): number {
  return clamp(
    Object.entries(DIMENSION_WEIGHTS).reduce(
      (sum, [dim, weight]) => sum + (dims[dim as CompatibilityDimension].score * weight),
      0
    )
  );
}

// ---------------------------------------------------------------------------
// R2 persistence
// ---------------------------------------------------------------------------

async function persistJSON(key: string, data: unknown): Promise<string | null> {
  const cloud = getDefaultCloudProvider();
  if (!cloud.isConfigured()) return null;
  const body = Buffer.from(JSON.stringify(data, null, 2), "utf8");
  try {
    await cloud.upload({ key, data: body, contentType: "application/json", checkDuplicate: false });
    return key;
  } catch (err) {
    logger.warn({ err, key }, "BM1: R2 upload failed");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BM1Input {
  primeJobId:       string;
  backendJobId?:    string;
  force?:           boolean;
  // Caller-supplied profiles (take priority over disk-derived)
  primeProfile?:    Partial<WebsitePrimeProfile>;
  backendProfile?:  ExistingBackendProfile;
}

export async function runCompatibilityEngine(input: BM1Input): Promise<CompatibilityReport> {
  const { primeJobId } = input;
  const startMs        = Date.now();

  // Return cached unless forced
  if (!input.force) {
    const cached = _cache.get(primeJobId);
    if (cached) return cached;
  }

  logger.info({ primeJobId, backendJobId: input.backendJobId }, "BM1: compatibility analysis started");

  // ── Load VR pipeline data for the prime ────────────────────────────────────
  const layoutMap  = await loadVR<LayoutMapBundle>(primeJobId, "layout-map.json");
  const components = await loadVR<ComponentLibrary>(primeJobId, "component-library.json");
  const rules      = await loadVR<ConsistencyRules>(primeJobId, "consistency-rules.json");

  // ── Derive prime profile ───────────────────────────────────────────────────
  const derivedPrime = await derivePrimeProfile(primeJobId, layoutMap, components, rules);
  const primeProfile: WebsitePrimeProfile = input.primeProfile
    ? { ...derivedPrime, ...input.primeProfile }
    : derivedPrime;

  // ── Load / default backend profile ────────────────────────────────────────
  let backendProfile: ExistingBackendProfile;
  if (input.backendProfile) {
    backendProfile = input.backendProfile;
  } else {
    // Try loading from disk (a previous BM-1 run or manually written profile)
    const diskProfile = await loadBM<ExistingBackendProfile>(primeJobId, "backend-profile.json");
    backendProfile = diskProfile ?? {
      backendJobId:  input.backendJobId,
      routes:        [],
      database:      { engine: "none" },
      auth:          { strategy: ["none"] },
      storage:       { provider: "none" },
      cms:           { platform: "none" },
      api:           { protocol: "rest", prefix: "/api" },
      frontend:      { framework: "none" },
      confidence:    0.40,
    };
  }

  // ── Run all seven dimension analyzers ──────────────────────────────────────
  const dims: Record<CompatibilityDimension, DimensionResult> = {
    routes:            analyzeRoutes(primeProfile, backendProfile),
    database:          analyzeDatabase(primeProfile, backendProfile),
    authentication:    analyzeAuthentication(primeProfile, backendProfile),
    storage:           analyzeStorage(primeProfile, backendProfile),
    cms:               analyzeCms(primeProfile, backendProfile),
    apiLayer:          analyzeApiLayer(primeProfile, backendProfile),
    frontendFramework: analyzeFrontendFramework(primeProfile, backendProfile),
  };

  // ── Flatten candidates ─────────────────────────────────────────────────────
  const allCandidates = Object.values(dims).flatMap(d => d.candidates);
  const safeMerges    = allCandidates.filter(c => c.classification === "SAFE");
  const riskyMerges   = allCandidates.filter(c => c.classification === "WARNING");
  const blockedMerges = allCandidates.filter(c => c.classification === "BLOCKED");
  const conflicts     = [...riskyMerges, ...blockedMerges];

  // ── Compute overall score ──────────────────────────────────────────────────
  const compatibilityScore   = weightedScore(dims);
  const overallClassification = blockedMerges.length > 0 ? "BLOCKED"
    : riskyMerges.length > 0 ? "WARNING" : "SAFE";

  // Critical blocks (BLOCKED severity=critical)
  const criticalBlocks = blockedMerges
    .filter(c => c.severity === "critical")
    .map(c => `[${c.dimension}] ${c.name}: ${c.description}`);

  const report: CompatibilityReport = {
    schemaVersion:     "BM-1",
    primeJobId,
    backendJobId:      input.backendJobId ?? backendProfile.backendJobId ?? "",
    seedUrl:           rules?.jobId ?? "",
    generatedAt:       new Date().toISOString(),
    durationMs:        Date.now() - startMs,
    compatibilityScore,
    grade:             grade(compatibilityScore),
    overallClassification,
    dimensions:        dims,
    conflicts,
    safeMerges,
    riskyMerges,
    blockedMerges,
    summary: {
      totalCandidates: allCandidates.length,
      safeCount:       safeMerges.length,
      warningCount:    riskyMerges.length,
      blockedCount:    blockedMerges.length,
      autoResolvable:  allCandidates.filter(c => c.autoResolvable).length,
      requiresManual:  allCandidates.filter(c => !c.autoResolvable && c.classification !== "SAFE").length,
      criticalBlocks,
      readyToMerge:    blockedMerges.length === 0,
    },
    primeProfile,
    backendProfile,
  };

  // ── Persist ────────────────────────────────────────────────────────────────
  const dir = join("/tmp/bm1", primeJobId);
  try { await mkdir(dir, { recursive: true }); } catch { /* ok */ }
  try { await writeFile(join(dir, "compatibility-report.json"), JSON.stringify(report, null, 2)); } catch { /* ok */ }

  const r2Key = await persistJSON(
    `jobs/${primeJobId}/bm1/compatibility-report.json`,
    report,
  );
  if (r2Key) report.r2Key = r2Key;

  _cache.set(primeJobId, report);

  logger.info({
    primeJobId,
    compatibilityScore,
    grade: report.grade,
    overallClassification,
    safe:    safeMerges.length,
    warning: riskyMerges.length,
    blocked: blockedMerges.length,
    durationMs: report.durationMs,
  }, "BM1: compatibility analysis complete");

  return report;
}
