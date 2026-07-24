/**
 * route-collision-engine-bm2.ts — Phase BM-2: Route Collision Engine
 *
 * Detects all route conflicts between a generated Website Prime and an
 * existing backend before any merge execution occurs.
 *
 * Collision types detected:
 *   exact      — identical path + at least one shared HTTP method
 *   wildcard   — one route uses a wildcard (*) that captures the other
 *   parameter  — structurally identical paths with different param names
 *   api        — same path + same method on an API-typed route (strictest check)
 *
 * Resolution classifications:
 *   SAFE   — no collision; route can be added directly
 *   RENAME — collision resolvable by renaming the prime route path
 *   MERGE  — routes can be merged (compatible methods, no semantic clash)
 *   BLOCK  — hard collision requiring manual resolution before merge
 *
 * Output:  route-collision-report.json
 *
 * Success criterion: no route overwrite can occur silently.
 */

import { writeFile, mkdir } from "fs/promises";
import { join }              from "path";
import { logger }            from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";

// ---------------------------------------------------------------------------
// Types — Route descriptors
// ---------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "ANY";
export type RouteType  = "page" | "api" | "static" | "webhook" | "unknown";

export interface RouteEntry {
  path:        string;
  methods:     HttpMethod[];
  type:        RouteType;
  auth?:       boolean;
  middleware?: string[];
  source?:     "prime" | "backend";
}

// ---------------------------------------------------------------------------
// Collision types
// ---------------------------------------------------------------------------

export type CollisionKind        = "exact" | "wildcard" | "parameter" | "api";
export type CollisionResolution  = "SAFE" | "RENAME" | "MERGE" | "BLOCK";

export interface RouteCollision {
  id:              string;
  kind:            CollisionKind;
  resolution:      CollisionResolution;

  primeRoute:      RouteEntry;
  backendRoute:    RouteEntry;

  conflictingMethods: HttpMethod[];
  mergeableMethods:   HttpMethod[];   // prime methods not in backend (safe to add)

  description:     string;
  resolution_note: string;            // how to resolve
  autoResolvable:  boolean;
  severity:        "critical" | "high" | "medium" | "low";

  // For RENAME: suggested safe path
  suggestedPath?:  string;
}

// ---------------------------------------------------------------------------
// Per-route result (for every prime route)
// ---------------------------------------------------------------------------

export interface RouteAssessment {
  primeRoute:    RouteEntry;
  resolution:    CollisionResolution;
  collision?:    RouteCollision;
  notes:         string[];
}

// ---------------------------------------------------------------------------
// Output report
// ---------------------------------------------------------------------------

export interface RouteCollisionReport {
  schemaVersion:  "BM-2";
  primeJobId:     string;
  backendJobId:   string;
  generatedAt:    string;
  durationMs:     number;

  // Summary
  totalPrimeRoutes:    number;
  totalBackendRoutes:  number;
  safeCount:           number;
  renameCount:         number;
  mergeCount:          number;
  blockCount:          number;
  silentOverwriteRisk: number;   // routes that WOULD have silently overwritten

  // All collisions (non-SAFE)
  collisions:     RouteCollision[];

  // Per-route assessments
  assessments:    RouteAssessment[];

  // Grouped views
  safe:           RouteAssessment[];
  rename:         RouteAssessment[];
  merge:          RouteAssessment[];
  block:          RouteAssessment[];

  primeRoutes:    RouteEntry[];
  backendRoutes:  RouteEntry[];

  r2Key?:         string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const _cache = new Map<string, RouteCollisionReport>();

export function getCachedRouteCollisionReport(primeJobId: string): RouteCollisionReport | undefined {
  return _cache.get(primeJobId);
}

// ---------------------------------------------------------------------------
// Route parsing helpers
// ---------------------------------------------------------------------------

/** Normalise a path: ensure leading slash, lowercase, trim trailing slash */
function normalisePath(p: string): string {
  const s = p.trim().toLowerCase();
  const withSlash = s.startsWith("/") ? s : "/" + s;
  return withSlash.length > 1 ? withSlash.replace(/\/$/, "") : withSlash;
}

/**
 * Split a path into segments and classify each as:
 *   literal   — "users", "api"
 *   param     — ":id", ":userId"    (Express style)
 *   wildcard  — "*", "**"
 */
type SegKind = "literal" | "param" | "wildcard";
interface Segment { raw: string; kind: SegKind; name?: string; }

function parseSegments(path: string): Segment[] {
  return normalisePath(path).split("/").filter(Boolean).map(raw => {
    if (raw === "*" || raw === "**") return { raw, kind: "wildcard" };
    if (raw.startsWith(":"))        return { raw, kind: "param", name: raw.slice(1) };
    return { raw, kind: "literal" };
  });
}

/**
 * Returns true if pathA structurally matches pathB
 * (segments of the same depth, each segment compatible).
 */
function structuralMatch(a: Segment[], b: Segment[]): boolean {
  if (a.length !== b.length) {
    // Wildcard at end can absorb different lengths
    if (a[a.length - 1]?.kind === "wildcard" && b.length >= a.length - 1) return true;
    if (b[b.length - 1]?.kind === "wildcard" && a.length >= b.length - 1) return true;
    return false;
  }
  return a.every((segA, i) => {
    const segB = b[i];
    if (!segB) return false;
    if (segA.kind === "wildcard" || segB.kind === "wildcard") return true;
    if (segA.kind === "param"    || segB.kind === "param")    return true;
    return segA.raw === segB.raw;
  });
}

/** Returns true if pathA is a wildcard that would capture pathB */
function wildcardCaptures(wildcardPath: string, targetPath: string): boolean {
  const wSegs = parseSegments(wildcardPath);
  const tSegs = parseSegments(targetPath);
  let wi = 0, ti = 0;
  while (wi < wSegs.length && ti < tSegs.length) {
    const ws = wSegs[wi];
    if (!ws) break;
    if (ws.kind === "wildcard") {
      // ** absorbs everything
      if (ws.raw === "**") return true;
      // * absorbs one segment
      ti++; wi++;
    } else if (ws.kind === "param") {
      ti++; wi++;
    } else {
      const ts = tSegs[ti];
      if (!ts || ts.raw !== ws.raw) return false;
      ti++; wi++;
    }
  }
  return wi === wSegs.length && ti === tSegs.length;
}

function sharedMethods(a: HttpMethod[], b: HttpMethod[]): HttpMethod[] {
  return a.filter(m => b.includes(m) || m === "ANY" || b.includes("ANY"));
}

function onlyInPrime(prime: HttpMethod[], backend: HttpMethod[]): HttpMethod[] {
  return prime.filter(m => !backend.includes(m) && m !== "ANY" && !backend.includes("ANY"));
}

/** Suggest a renamed path to avoid collision */
function suggestRename(primePath: string, existingPaths: Set<string>): string {
  const base = primePath.replace(/\/$/, "");
  let suffix = "-prime";
  let candidate = base + suffix;
  let i = 2;
  while (existingPaths.has(candidate)) { candidate = base + suffix + "-" + i++; }
  return candidate;
}

// ---------------------------------------------------------------------------
// Collision detector — main logic
// ---------------------------------------------------------------------------

let _idSeq = 0;
function colId(): string { return `COL-${String(++_idSeq).padStart(4, "0")}`; }

function detectCollisions(
  primeRoutes:   RouteEntry[],
  backendRoutes: RouteEntry[],
): RouteAssessment[] {
  const backendPaths = new Set(backendRoutes.map(r => normalisePath(r.path)));
  const assessments: RouteAssessment[] = [];

  for (const pr of primeRoutes) {
    const normPrime = normalisePath(pr.path);
    const primeSegs = parseSegments(normPrime);
    const notes: string[] = [];
    let collision: RouteCollision | undefined;

    for (const br of backendRoutes) {
      const normBack = normalisePath(br.path);
      const backSegs = parseSegments(normBack);

      // ── 1. EXACT collision ──────────────────────────────────────────────
      if (normPrime === normBack) {
        const shared   = sharedMethods(pr.methods, br.methods);
        const mergeable = onlyInPrime(pr.methods, br.methods);
        const isApi    = pr.type === "api" || br.type === "api";

        if (shared.length > 0) {
          const resolution: CollisionResolution = isApi ? "BLOCK" : (
            mergeable.length === pr.methods.length ? "RENAME" : "MERGE"
          );
          collision = {
            id: colId(), kind: "exact", resolution,
            primeRoute: pr, backendRoute: br,
            conflictingMethods: shared,
            mergeableMethods:   mergeable,
            description:  `Exact path collision on "${normPrime}" with shared methods [${shared.join(", ")}]`,
            resolution_note: isApi
              ? "API route conflict — namespace the prime API or remove the duplicate endpoint"
              : shared.length === pr.methods.length
                ? `Rename the prime route to "${suggestRename(normPrime, backendPaths)}"`
                : `Merge: add prime-only methods [${mergeable.join(", ")}] to the existing route`,
            suggestedPath: resolution === "RENAME" ? suggestRename(normPrime, backendPaths) : undefined,
            autoResolvable: resolution === "RENAME" || resolution === "MERGE",
            severity:       isApi ? "critical" : (shared.length === pr.methods.length ? "high" : "medium"),
          };
          break;
        } else if (mergeable.length > 0) {
          // Same path, completely different methods — a MERGE candidate
          collision = {
            id: colId(), kind: "exact", resolution: "MERGE",
            primeRoute: pr, backendRoute: br,
            conflictingMethods: [],
            mergeableMethods:   mergeable,
            description:  `Same path "${normPrime}" but disjoint methods — merge candidate`,
            resolution_note: `Register prime methods [${mergeable.join(", ")}] on the existing route handler`,
            autoResolvable: true,
            severity: "low",
          };
          break;
        }
        continue;
      }

      // ── 2. WILDCARD collision ──────────────────────────────────────────
      const primeHasWild = primeSegs.some(s => s.kind === "wildcard");
      const backHasWild  = backSegs.some(s => s.kind === "wildcard");

      if (primeHasWild && wildcardCaptures(normPrime, normBack)) {
        collision = {
          id: colId(), kind: "wildcard", resolution: "BLOCK",
          primeRoute: pr, backendRoute: br,
          conflictingMethods: sharedMethods(pr.methods, br.methods),
          mergeableMethods:   [],
          description:  `Prime wildcard "${normPrime}" would intercept backend route "${normBack}"`,
          resolution_note: "Narrow the prime wildcard scope or register the backend route before the prime handler",
          autoResolvable: false,
          severity: "high",
        };
        break;
      }
      if (backHasWild && wildcardCaptures(normBack, normPrime)) {
        collision = {
          id: colId(), kind: "wildcard", resolution: "RENAME",
          primeRoute: pr, backendRoute: br,
          conflictingMethods: sharedMethods(pr.methods, br.methods),
          mergeableMethods:   onlyInPrime(pr.methods, br.methods),
          description:  `Backend wildcard "${normBack}" captures prime route "${normPrime}"`,
          resolution_note: `Register prime route "${normPrime}" before the backend's wildcard handler, or give it a distinct prefix`,
          suggestedPath: suggestRename(normPrime, backendPaths),
          autoResolvable: true,
          severity: "medium",
        };
        break;
      }

      // ── 3. PARAMETER collision ─────────────────────────────────────────
      if (
        primeSegs.length === backSegs.length &&
        structuralMatch(primeSegs, backSegs) &&
        normPrime !== normBack
      ) {
        const shared   = sharedMethods(pr.methods, br.methods);
        const mergeable = onlyInPrime(pr.methods, br.methods);

        if (shared.length > 0 || mergeable.length > 0) {
          collision = {
            id: colId(), kind: "parameter", resolution: shared.length > 0 ? "BLOCK" : "MERGE",
            primeRoute: pr, backendRoute: br,
            conflictingMethods: shared,
            mergeableMethods:   mergeable,
            description:  `Structural parameter collision: prime "${normPrime}" ↔ backend "${normBack}" — same route shape with different param names`,
            resolution_note: shared.length > 0
              ? "Consolidate into one parameterised route with unified parameter name"
              : "Merge method handlers into the existing parameterised route",
            autoResolvable: mergeable.length > 0 && shared.length === 0,
            severity: shared.length > 0 ? "high" : "low",
          };
          break;
        }
      }
    }

    // ── 4. API-specific collision (stricter — same path, same method, API type) ──
    if (!collision) {
      const apiConflict = backendRoutes.find(br =>
        br.type === "api" &&
        pr.type === "api" &&
        normalisePath(br.path) !== normalisePath(pr.path) &&
        // Same functional namespace (e.g. /api/users vs /api/users/list — same prefix depth)
        normalisePath(br.path).startsWith(normalisePath(pr.path) + "/") &&
        sharedMethods(pr.methods, br.methods).length > 0
      );
      if (apiConflict) {
        const shared = sharedMethods(pr.methods, apiConflict.methods);
        collision = {
          id: colId(), kind: "api", resolution: "RENAME",
          primeRoute: pr, backendRoute: apiConflict,
          conflictingMethods: shared,
          mergeableMethods: onlyInPrime(pr.methods, apiConflict.methods),
          description:  `API namespace overlap: prime "${normalisePath(pr.path)}" is a prefix of backend API "${normalisePath(apiConflict.path)}"`,
          resolution_note: `Give the prime API a distinct namespace (e.g. /prime${normalisePath(pr.path)}) to avoid shadowing deeper backend routes`,
          suggestedPath: `/prime${normalisePath(pr.path)}`,
          autoResolvable: true,
          severity: "medium",
        };
        notes.push(`Prime API route would shadow backend sub-routes under "${normalisePath(pr.path)}"`);
      }
    }

    // Build assessment
    if (!collision) {
      assessments.push({
        primeRoute:  pr,
        resolution:  "SAFE",
        notes:       [`Route "${normPrime}" is clear — not present in backend`],
      });
    } else {
      assessments.push({ primeRoute: pr, resolution: collision.resolution, collision, notes });
    }
  }

  return assessments;
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
    logger.warn({ err, key }, "BM2: R2 upload failed");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface BM2Input {
  primeJobId:    string;
  backendJobId?: string;
  primeRoutes:   RouteEntry[];
  backendRoutes: RouteEntry[];
  force?:        boolean;
}

export async function runRouteCollisionEngine(input: BM2Input): Promise<RouteCollisionReport> {
  const { primeJobId } = input;
  const startMs        = Date.now();

  if (!input.force) {
    const cached = _cache.get(primeJobId);
    if (cached) return cached;
  }

  logger.info({ primeJobId, backendJobId: input.backendJobId, primeRouteCount: input.primeRoutes.length, backendRouteCount: input.backendRoutes.length }, "BM2: route collision analysis started");

  // Tag routes with source
  const primeRoutes:   RouteEntry[] = input.primeRoutes.map(r => ({ ...r, source: "prime" as const }));
  const backendRoutes: RouteEntry[] = input.backendRoutes.map(r => ({ ...r, source: "backend" as const }));

  const assessments = detectCollisions(primeRoutes, backendRoutes);

  const safe   = assessments.filter(a => a.resolution === "SAFE");
  const rename = assessments.filter(a => a.resolution === "RENAME");
  const merge  = assessments.filter(a => a.resolution === "MERGE");
  const block  = assessments.filter(a => a.resolution === "BLOCK");
  const collisions = assessments.filter(a => a.collision).map(a => a.collision!);

  // Silent overwrite risk = routes that would have matched exactly with no guard
  const silentRisk = block.filter(a =>
    a.collision?.kind === "exact" && a.collision?.conflictingMethods.length > 0
  ).length;

  const report: RouteCollisionReport = {
    schemaVersion:       "BM-2",
    primeJobId,
    backendJobId:        input.backendJobId ?? "",
    generatedAt:         new Date().toISOString(),
    durationMs:          Date.now() - startMs,
    totalPrimeRoutes:    primeRoutes.length,
    totalBackendRoutes:  backendRoutes.length,
    safeCount:           safe.length,
    renameCount:         rename.length,
    mergeCount:          merge.length,
    blockCount:          block.length,
    silentOverwriteRisk: silentRisk,
    collisions,
    assessments,
    safe,
    rename,
    merge,
    block,
    primeRoutes,
    backendRoutes,
  };

  // Persist
  const dir = join("/tmp/bm2", primeJobId);
  try { await mkdir(dir, { recursive: true }); } catch { /* ok */ }
  try { await writeFile(join(dir, "route-collision-report.json"), JSON.stringify(report, null, 2)); } catch { /* ok */ }

  const r2Key = await persistJSON(`jobs/${primeJobId}/bm2/route-collision-report.json`, report);
  if (r2Key) report.r2Key = r2Key;

  _cache.set(primeJobId, report);

  logger.info({
    primeJobId, safe: safe.length, rename: rename.length,
    merge: merge.length, block: block.length, silentRisk, durationMs: report.durationMs,
  }, "BM2: route collision analysis complete");

  return report;
}
