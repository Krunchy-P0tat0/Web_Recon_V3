/**
 * database-compatibility-engine-bm3.ts — Phase BM-3: Database Compatibility Engine
 *
 * Analyzes schema compatibility between a Website Prime's database requirements
 * and an existing backend's database schema.
 *
 * Collision types detected:
 *   table      — both prime and backend define a table with the same name
 *   column     — same table, same column name, different type or constraints
 *   index      — duplicate index names (in same or different tables)
 *   constraint — conflicting FK, unique, check, or primary key constraints
 *
 * Success criterion: no schema mutation occurs without explicit approval.
 *
 * Output: database-compatibility-report.json
 */

import { writeFile, mkdir } from "fs/promises";
import { join }              from "path";
import { logger }            from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";

// ---------------------------------------------------------------------------
// Column / index / constraint definitions
// ---------------------------------------------------------------------------

export type ColumnType =
  | "text" | "varchar" | "char"
  | "int" | "bigint" | "smallint" | "serial" | "bigserial"
  | "float" | "double" | "decimal" | "numeric"
  | "boolean" | "bool"
  | "date" | "timestamp" | "timestamptz" | "datetime" | "time"
  | "json" | "jsonb" | "xml"
  | "uuid" | "bytea" | "blob"
  | "enum" | "array"
  | "unknown";

export interface ColumnDefinition {
  name:         string;
  type:         ColumnType;
  nullable:     boolean;
  defaultValue?: string;
  primaryKey?:  boolean;
  unique?:      boolean;
  length?:      number;
  precision?:   number;
  scale?:       number;
  enumValues?:  string[];
}

export type IndexType = "btree" | "hash" | "gin" | "gist" | "brin" | "unique" | "full-text";

export interface IndexDefinition {
  name:      string;
  table:     string;
  columns:   string[];
  type?:     IndexType;
  unique?:   boolean;
  partial?:  string;   // partial index condition
}

export type ConstraintType = "primary_key" | "foreign_key" | "unique" | "check" | "not_null" | "default";

export interface ConstraintDefinition {
  name:          string;
  type:          ConstraintType;
  table:         string;
  columns:       string[];
  references?:   { table: string; columns: string[] };
  checkExpr?:    string;
  onDelete?:     "cascade" | "set null" | "restrict" | "no action";
  onUpdate?:     "cascade" | "set null" | "restrict" | "no action";
}

export interface TableDefinition {
  name:        string;
  columns:     ColumnDefinition[];
  indexes:     IndexDefinition[];
  constraints: ConstraintDefinition[];
  engine?:     string;  // InnoDB, MyISAM, etc.
  charset?:    string;
  comment?:    string;
}

export interface DatabaseSchema {
  engine:  string;   // postgres, mysql, sqlite, etc.
  version?: string;
  tables:  TableDefinition[];
}

// ---------------------------------------------------------------------------
// Collision descriptors
// ---------------------------------------------------------------------------

export type DbCollisionKind = "table" | "column" | "index" | "constraint";

export type DbResolution =
  | "SAFE"      // no collision, safe to apply
  | "ADDITIVE"  // prime adds a new object not in backend — safe
  | "RENAME"    // can be resolved by renaming
  | "MERGE"     // schemas can be merged (compatible types)
  | "MUTATE"    // prime changes an existing object — requires approval
  | "BLOCK";    // hard incompatibility — cannot proceed without resolution

export interface DbCollision {
  id:          string;
  kind:        DbCollisionKind;
  resolution:  DbResolution;

  // Location
  table:       string;
  object?:     string;  // column / index / constraint name

  primeValue:   string;  // what the prime defines
  backendValue: string;  // what the backend currently has

  description:     string;
  resolution_note: string;
  requiresApproval: boolean;  // true for MUTATE and BLOCK
  autoResolvable:   boolean;
  severity:        "critical" | "high" | "medium" | "low" | "none";

  // Data loss risk
  dataLossRisk: boolean;
  dataLossNote?: string;
}

// ---------------------------------------------------------------------------
// Table assessment (one per prime table)
// ---------------------------------------------------------------------------

export interface TableAssessment {
  table:      string;
  exists:     boolean;   // true if backend already has this table
  resolution: DbResolution;
  collisions: DbCollision[];
  notes:      string[];
}

// ---------------------------------------------------------------------------
// Report output
// ---------------------------------------------------------------------------

export interface DatabaseCompatibilityReport {
  schemaVersion:  "BM-3";
  primeJobId:     string;
  backendJobId:   string;
  generatedAt:    string;
  durationMs:     number;

  // Engine summary
  primeEngine:    string;
  backendEngine:  string;
  engineCompatible: boolean;

  // Counts
  totalPrimeTables:    number;
  totalBackendTables:  number;
  newTables:           number;     // prime tables not in backend — additive, safe
  collisionTables:     number;     // prime tables that exist in backend

  // Collision breakdown
  tableCollisions:      DbCollision[];
  columnCollisions:     DbCollision[];
  indexCollisions:      DbCollision[];
  constraintCollisions: DbCollision[];

  // All collisions
  allCollisions: DbCollision[];

  // Resolution summary
  safeCount:    number;
  additiveCount:number;
  renameCount:  number;
  mergeCount:   number;
  mutateCount:  number;
  blockCount:   number;

  // Approval gating
  requiresApprovalCount: number;
  dataLossRiskCount:     number;
  approvalItems:         DbCollision[];  // all items that need explicit approval

  // Assessments per prime table
  tableAssessments: TableAssessment[];

  // Raw schemas
  primeSchema:   DatabaseSchema;
  backendSchema: DatabaseSchema;

  r2Key?: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const _cache = new Map<string, DatabaseCompatibilityReport>();

export function getCachedDatabaseCompatibilityReport(primeJobId: string): DatabaseCompatibilityReport | undefined {
  return _cache.get(primeJobId);
}

// ---------------------------------------------------------------------------
// Type compatibility helpers
// ---------------------------------------------------------------------------

/** Groups of column types that are considered compatible for lossless merge */
const TYPE_COMPAT_GROUPS: ColumnType[][] = [
  ["int", "bigint", "smallint", "serial", "bigserial"],
  ["text", "varchar", "char"],
  ["float", "double", "decimal", "numeric"],
  ["boolean", "bool"],
  ["timestamp", "timestamptz", "datetime"],
  ["json", "jsonb"],
];

function typesCompatible(a: ColumnType, b: ColumnType): boolean {
  if (a === b) return true;
  return TYPE_COMPAT_GROUPS.some(g => g.includes(a) && g.includes(b));
}

/** true when changing a → b could cause data loss */
function dataLossRisk(from: ColumnType, to: ColumnType): boolean {
  const widening: Array<[ColumnType, ColumnType]> = [
    ["bigint", "int"], ["bigint", "smallint"], ["int", "smallint"],
    ["text",   "varchar"], ["text", "char"], ["varchar", "char"],
    ["float",  "int"], ["double", "int"], ["decimal", "int"],
    ["jsonb",  "json"], ["timestamptz", "timestamp"],
  ];
  return widening.some(([f, t]) => f === from && t === to);
}

// ---------------------------------------------------------------------------
// Collision ID
// ---------------------------------------------------------------------------

let _idSeq = 0;
function colId(): string { return `DB-${String(++_idSeq).padStart(4, "0")}`; }

// ---------------------------------------------------------------------------
// Analyzers per collision kind
// ---------------------------------------------------------------------------

function analyzeTable(
  primeTable:   TableDefinition,
  backendTable: TableDefinition,
): DbCollision[] {
  // The table itself exists — note it
  const result: DbCollision[] = [];

  // Table-level engine mismatch (MySQL only)
  if (primeTable.engine && backendTable.engine && primeTable.engine !== backendTable.engine) {
    result.push({
      id: colId(), kind: "table", resolution: "MUTATE",
      table: primeTable.name,
      primeValue:   `engine=${primeTable.engine}`,
      backendValue: `engine=${backendTable.engine}`,
      description:  `Table engine mismatch: prime wants ${primeTable.engine}, backend uses ${backendTable.engine}`,
      resolution_note: `ALTER TABLE ${primeTable.name} ENGINE=${primeTable.engine} — data-safe but requires a full table rebuild`,
      requiresApproval: true,
      autoResolvable:   false,
      severity:         "medium",
      dataLossRisk:     false,
    });
  }

  return result;
}

function analyzeColumns(
  primeTable:   TableDefinition,
  backendTable: TableDefinition,
): DbCollision[] {
  const result: DbCollision[] = [];
  const backendCols = new Map(backendTable.columns.map(c => [c.name, c]));
  const primeCols   = new Map(primeTable.columns.map(c => [c.name, c]));

  for (const [name, pc] of primeCols) {
    const bc = backendCols.get(name);

    if (!bc) {
      // New column — additive, safe
      result.push({
        id: colId(), kind: "column", resolution: "ADDITIVE",
        table: primeTable.name, object: name,
        primeValue:   `${pc.type}${pc.nullable ? "" : " NOT NULL"}`,
        backendValue: "(not present)",
        description:  `New column "${primeTable.name}.${name}" — additive, no data risk`,
        resolution_note: pc.nullable || pc.defaultValue
          ? `ALTER TABLE ${primeTable.name} ADD COLUMN ${name} ${pc.type} — safe`
          : `Requires DEFAULT value or NULL to avoid locking existing rows`,
        requiresApproval: !pc.nullable && !pc.defaultValue,
        autoResolvable:   pc.nullable === true || !!pc.defaultValue,
        severity:         "none",
        dataLossRisk:     false,
      });
      continue;
    }

    // Column exists — check compatibility
    const typeOk      = typesCompatible(pc.type, bc.type);
    const nullConflict = !pc.nullable && bc.nullable;
    const lossRisk    = dataLossRisk(bc.type, pc.type);

    if (!typeOk) {
      result.push({
        id: colId(), kind: "column", resolution: lossRisk ? "BLOCK" : "MUTATE",
        table: primeTable.name, object: name,
        primeValue:   pc.type,
        backendValue: bc.type,
        description:  `Column type mismatch: "${primeTable.name}.${name}" — prime wants ${pc.type}, backend has ${bc.type}`,
        resolution_note: lossRisk
          ? `Data loss risk — cannot narrow ${bc.type} → ${pc.type} without migration. Manually migrate the column or adjust the prime schema.`
          : `ALTER TABLE ${primeTable.name} ALTER COLUMN ${name} TYPE ${pc.type} — verify data fits before applying`,
        requiresApproval: true,
        autoResolvable:   false,
        severity:         lossRisk ? "critical" : "high",
        dataLossRisk:     lossRisk,
        dataLossNote:     lossRisk ? `Narrowing ${bc.type} → ${pc.type} may truncate existing data` : undefined,
      });
    } else if (nullConflict) {
      result.push({
        id: colId(), kind: "column", resolution: "MUTATE",
        table: primeTable.name, object: name,
        primeValue:   "NOT NULL",
        backendValue: "NULLABLE",
        description:  `Nullability conflict: "${primeTable.name}.${name}" — prime requires NOT NULL, backend allows NULL`,
        resolution_note: `Ensure no NULLs exist, then: ALTER TABLE ${primeTable.name} ALTER COLUMN ${name} SET NOT NULL`,
        requiresApproval: true,
        autoResolvable:   false,
        severity:         "medium",
        dataLossRisk:     false,
      });
    } else if (pc.defaultValue !== bc.defaultValue && pc.defaultValue !== undefined) {
      result.push({
        id: colId(), kind: "column", resolution: "MERGE",
        table: primeTable.name, object: name,
        primeValue:   `DEFAULT ${pc.defaultValue}`,
        backendValue: bc.defaultValue ? `DEFAULT ${bc.defaultValue}` : "no default",
        description:  `Default value differs: "${primeTable.name}.${name}"`,
        resolution_note: "Keep the more conservative default (usually the backend's) or align both to the prime value",
        requiresApproval: false,
        autoResolvable:   true,
        severity:         "low",
        dataLossRisk:     false,
      });
    } else {
      // Fully compatible
      result.push({
        id: colId(), kind: "column", resolution: "SAFE",
        table: primeTable.name, object: name,
        primeValue:   pc.type,
        backendValue: bc.type,
        description:  `Column "${primeTable.name}.${name}" is compatible`,
        resolution_note: "No action required",
        requiresApproval: false,
        autoResolvable:   true,
        severity:         "none",
        dataLossRisk:     false,
      });
    }
  }

  return result;
}

function analyzeIndexes(
  primeTable:   TableDefinition,
  backendTable: TableDefinition,
): DbCollision[] {
  const result: DbCollision[] = [];
  const backendIdx = new Map(backendTable.indexes.map(i => [i.name, i]));

  for (const pi of primeTable.indexes) {
    const bi = backendIdx.get(pi.name);

    if (!bi) {
      result.push({
        id: colId(), kind: "index", resolution: "ADDITIVE",
        table: primeTable.name, object: pi.name,
        primeValue:   `${pi.name} ON (${pi.columns.join(", ")})`,
        backendValue: "(not present)",
        description:  `New index "${pi.name}" on "${primeTable.name}" — additive`,
        resolution_note: `CREATE INDEX ${pi.name} ON ${primeTable.name} (${pi.columns.join(", ")}) — safe on most engines`,
        requiresApproval: false,
        autoResolvable:   true,
        severity:         "none",
        dataLossRisk:     false,
      });
      continue;
    }

    // Index name collision
    const colsMatch   = JSON.stringify([...pi.columns].sort()) === JSON.stringify([...bi.columns].sort());
    const uniqueConf  = pi.unique && !bi.unique;

    if (!colsMatch) {
      result.push({
        id: colId(), kind: "index", resolution: "RENAME",
        table: primeTable.name, object: pi.name,
        primeValue:   `${pi.name} ON (${pi.columns.join(", ")})`,
        backendValue: `${bi.name} ON (${bi.columns.join(", ")})`,
        description:  `Index name collision "${pi.name}" on "${primeTable.name}" — different column sets`,
        resolution_note: `Rename the prime index to "${pi.name}_prime" to avoid collision`,
        requiresApproval: false,
        autoResolvable:   true,
        severity:         "medium",
        dataLossRisk:     false,
      });
    } else if (uniqueConf) {
      result.push({
        id: colId(), kind: "index", resolution: "BLOCK",
        table: primeTable.name, object: pi.name,
        primeValue:   `UNIQUE INDEX ${pi.name}`,
        backendValue: `NON-UNIQUE INDEX ${bi.name}`,
        description:  `Prime promotes "${pi.name}" to UNIQUE but backend index is non-unique — may fail if duplicates exist`,
        resolution_note: "Verify no duplicate values exist in the column(s) before adding the UNIQUE constraint",
        requiresApproval: true,
        autoResolvable:   false,
        severity:         "high",
        dataLossRisk:     false,
      });
    } else {
      result.push({
        id: colId(), kind: "index", resolution: "SAFE",
        table: primeTable.name, object: pi.name,
        primeValue:   pi.name,
        backendValue: bi.name,
        description:  `Index "${pi.name}" already exists with compatible definition`,
        resolution_note: "No action required",
        requiresApproval: false,
        autoResolvable:   true,
        severity:         "none",
        dataLossRisk:     false,
      });
    }
  }

  return result;
}

function analyzeConstraints(
  primeTable:   TableDefinition,
  backendTable: TableDefinition,
): DbCollision[] {
  const result: DbCollision[] = [];
  const backendConstraints = new Map(backendTable.constraints.map(c => [c.name, c]));

  for (const pc of primeTable.constraints) {
    const bc = backendConstraints.get(pc.name);

    if (!bc) {
      // New constraint
      const isStrictening = pc.type === "not_null" || pc.type === "unique" || pc.type === "check";
      result.push({
        id: colId(), kind: "constraint", resolution: isStrictening ? "MUTATE" : "ADDITIVE",
        table: primeTable.name, object: pc.name,
        primeValue:   `${pc.type} ON (${pc.columns.join(", ")})`,
        backendValue: "(not present)",
        description:  `New ${pc.type} constraint "${pc.name}" on "${primeTable.name}"`,
        resolution_note: isStrictening
          ? `Adding a ${pc.type} constraint may fail if existing data violates it — verify data first`
          : `Additive FK constraint — ensure referenced table exists`,
        requiresApproval: isStrictening,
        autoResolvable:   !isStrictening,
        severity:         isStrictening ? "medium" : "none",
        dataLossRisk:     false,
      });
      continue;
    }

    // Same constraint name — check conflict
    if (pc.type !== bc.type) {
      result.push({
        id: colId(), kind: "constraint", resolution: "BLOCK",
        table: primeTable.name, object: pc.name,
        primeValue:   pc.type,
        backendValue: bc.type,
        description:  `Constraint type mismatch: "${pc.name}" is ${pc.type} in prime but ${bc.type} in backend`,
        resolution_note: "Drop the old constraint and add the new one, or rename the prime constraint",
        requiresApproval: true,
        autoResolvable:   false,
        severity:         "high",
        dataLossRisk:     false,
      });
    } else if (
      pc.type === "foreign_key" &&
      bc.type === "foreign_key" &&
      (pc.references?.table !== bc.references?.table ||
       JSON.stringify(pc.references?.columns) !== JSON.stringify(bc.references?.columns))
    ) {
      result.push({
        id: colId(), kind: "constraint", resolution: "BLOCK",
        table: primeTable.name, object: pc.name,
        primeValue:   `FK → ${pc.references?.table}(${pc.references?.columns?.join(", ")})`,
        backendValue: `FK → ${bc.references?.table}(${bc.references?.columns?.join(", ")})`,
        description:  `FK constraint "${pc.name}" points to different table/columns`,
        resolution_note: "Drop and recreate the FK with the correct reference, or rename the prime's FK constraint",
        requiresApproval: true,
        autoResolvable:   false,
        severity:         "critical",
        dataLossRisk:     false,
      });
    } else {
      result.push({
        id: colId(), kind: "constraint", resolution: "SAFE",
        table: primeTable.name, object: pc.name,
        primeValue:   pc.type,
        backendValue: bc.type,
        description:  `Constraint "${pc.name}" matches backend definition`,
        resolution_note: "No action required",
        requiresApproval: false,
        autoResolvable:   true,
        severity:         "none",
        dataLossRisk:     false,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Engine compatibility check
// ---------------------------------------------------------------------------

const ENGINE_COMPAT: Record<string, string[]> = {
  postgres:  ["postgres", "supabase", "neon", "cockroachdb"],
  mysql:     ["mysql", "mariadb", "aurora-mysql", "planetscale"],
  sqlite:    ["sqlite", "libsql", "turso"],
  mongodb:   ["mongodb", "atlas", "documentdb"],
  none:      ["none"],
};

function enginesCompatible(a: string, b: string): boolean {
  const la = a.toLowerCase(), lb = b.toLowerCase();
  for (const [, group] of Object.entries(ENGINE_COMPAT)) {
    if (group.includes(la) && group.includes(lb)) return true;
  }
  return la === lb;
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

export interface BM3Input {
  primeJobId:    string;
  backendJobId?: string;
  primeSchema:   DatabaseSchema;
  backendSchema: DatabaseSchema;
  force?:        boolean;
}

async function persistJSON(key: string, data: unknown): Promise<string | null> {
  const cloud = getDefaultCloudProvider();
  if (!cloud.isConfigured()) return null;
  const body = Buffer.from(JSON.stringify(data, null, 2), "utf8");
  try {
    await cloud.upload({ key, data: body, contentType: "application/json", checkDuplicate: false });
    return key;
  } catch (err) {
    logger.warn({ err, key }, "BM3: R2 upload failed");
    return null;
  }
}

export async function runDatabaseCompatibilityEngine(input: BM3Input): Promise<DatabaseCompatibilityReport> {
  const { primeJobId } = input;
  const startMs        = Date.now();

  if (!input.force) {
    const cached = _cache.get(primeJobId);
    if (cached) return cached;
  }

  logger.info({
    primeJobId, backendJobId: input.backendJobId,
    primeTables: input.primeSchema.tables.length,
    backendTables: input.backendSchema.tables.length,
  }, "BM3: database compatibility analysis started");

  const { primeSchema, backendSchema } = input;
  const backendTableMap = new Map(backendSchema.tables.map(t => [t.name.toLowerCase(), t]));

  const engineCompat = enginesCompatible(primeSchema.engine, backendSchema.engine);

  // Per-table assessments
  const tableAssessments: TableAssessment[] = [];
  const allTableCollisions:      DbCollision[] = [];
  const allColumnCollisions:     DbCollision[] = [];
  const allIndexCollisions:      DbCollision[] = [];
  const allConstraintCollisions: DbCollision[] = [];

  for (const pt of primeSchema.tables) {
    const bt = backendTableMap.get(pt.name.toLowerCase());

    if (!bt) {
      // Entirely new table — ADDITIVE
      tableAssessments.push({
        table:      pt.name,
        exists:     false,
        resolution: "ADDITIVE",
        collisions: [],
        notes:      [`Table "${pt.name}" is new — CREATE TABLE can proceed`],
      });
      continue;
    }

    // Table exists — run all four analyzers
    const tableCols  = analyzeTable(pt, bt);
    const colCols    = analyzeColumns(pt, bt);
    const idxCols    = analyzeIndexes(pt, bt);
    const consCols   = analyzeConstraints(pt, bt);

    allTableCollisions.push(...tableCols);
    allColumnCollisions.push(...colCols);
    allIndexCollisions.push(...idxCols);
    allConstraintCollisions.push(...consCols);

    const allLocal = [...tableCols, ...colCols, ...idxCols, ...consCols];
    const worst = allLocal.reduce<DbResolution>((acc, c) => {
      const order: DbResolution[] = ["SAFE", "ADDITIVE", "MERGE", "RENAME", "MUTATE", "BLOCK"];
      return order.indexOf(c.resolution) > order.indexOf(acc) ? c.resolution : acc;
    }, "SAFE");

    tableAssessments.push({
      table:      pt.name,
      exists:     true,
      resolution: worst,
      collisions: allLocal.filter(c => c.resolution !== "SAFE" && c.resolution !== "ADDITIVE"),
      notes: [
        `Table "${pt.name}" exists in backend`,
        ...tableCols.filter(c => c.resolution !== "SAFE").map(c => c.description),
      ],
    });
  }

  const allCollisions = [
    ...allTableCollisions,
    ...allColumnCollisions,
    ...allIndexCollisions,
    ...allConstraintCollisions,
  ];

  const count = (res: DbResolution) => allCollisions.filter(c => c.resolution === res).length;

  const approvalItems = allCollisions.filter(c => c.requiresApproval);
  const dataLossItems = allCollisions.filter(c => c.dataLossRisk);

  const report: DatabaseCompatibilityReport = {
    schemaVersion:   "BM-3",
    primeJobId,
    backendJobId:    input.backendJobId ?? "",
    generatedAt:     new Date().toISOString(),
    durationMs:      Date.now() - startMs,

    primeEngine:     primeSchema.engine,
    backendEngine:   backendSchema.engine,
    engineCompatible: engineCompat,

    totalPrimeTables:   primeSchema.tables.length,
    totalBackendTables: backendSchema.tables.length,
    newTables:          tableAssessments.filter(a => !a.exists).length,
    collisionTables:    tableAssessments.filter(a => a.exists).length,

    tableCollisions:      allTableCollisions,
    columnCollisions:     allColumnCollisions,
    indexCollisions:      allIndexCollisions,
    constraintCollisions: allConstraintCollisions,

    allCollisions,

    safeCount:     count("SAFE"),
    additiveCount: count("ADDITIVE"),
    renameCount:   count("RENAME"),
    mergeCount:    count("MERGE"),
    mutateCount:   count("MUTATE"),
    blockCount:    count("BLOCK"),

    requiresApprovalCount: approvalItems.length,
    dataLossRiskCount:     dataLossItems.length,
    approvalItems,

    tableAssessments,
    primeSchema,
    backendSchema,
  };

  // Persist
  const dir = join("/tmp/bm3", primeJobId);
  try { await mkdir(dir, { recursive: true }); } catch { /* ok */ }
  try { await writeFile(join(dir, "database-compatibility-report.json"), JSON.stringify(report, null, 2)); } catch { /* ok */ }

  const r2Key = await persistJSON(`jobs/${primeJobId}/bm3/database-compatibility-report.json`, report);
  if (r2Key) report.r2Key = r2Key;

  _cache.set(primeJobId, report);

  logger.info({
    primeJobId, engineCompatible: engineCompat,
    newTables: report.newTables, collisionTables: report.collisionTables,
    approvalItems: approvalItems.length, dataLossRisk: dataLossItems.length,
    durationMs: report.durationMs,
  }, "BM3: database compatibility analysis complete");

  return report;
}
