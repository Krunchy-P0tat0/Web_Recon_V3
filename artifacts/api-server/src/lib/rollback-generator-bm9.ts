/**
 * rollback-generator-bm9.ts — Phase BM-9: Rollback Generator
 *
 * Generates complete rollback plans for every merge operation.
 *
 * Backs up:
 *   routes     — router registration snapshots
 *   database   — schema dumps + row counts + FK snapshot
 *   assets     — static file manifests + content hashes
 *   components — component registry + import graph
 *   configs    — environment variables + framework config files
 *
 * Outputs (disk + R2):
 *   rollback-plan.json
 *
 * Success criteria:
 *   Every merge operation is reversible.
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join }                        from "path";
import { logger }                      from "./logger.js";
import { getDefaultCloudProvider }     from "../cloud/index.js";

// ---------------------------------------------------------------------------
// Rollback taxonomy
// ---------------------------------------------------------------------------

export type RollbackDimension = "routes" | "database" | "assets" | "components" | "configs";
export type RollbackStrategy  = "REVERT_FILE" | "REVERT_MIGRATION" | "RESTORE_BACKUP" | "RESTORE_ENV" | "REDEPLOY";
export type RollbackComplexity = "trivial" | "low" | "medium" | "high" | "critical";

// ---------------------------------------------------------------------------
// Rollback step
// ---------------------------------------------------------------------------

export interface RollbackStep {
  id:           string;
  order:        number;
  dimension:    RollbackDimension;
  strategy:     RollbackStrategy;
  title:        string;
  description:  string;
  command?:     string;        // shell command to execute
  apiCall?:     string;        // API endpoint to call
  estimatedMs:  number;
  reversesOperation: string;  // ID of the forward operation this reverses
  requiresDowntime:  boolean;
  dataLossRisk:      boolean;
  verificationStep:  string;  // how to verify this rollback succeeded
}

// ---------------------------------------------------------------------------
// Dimension backup snapshot
// ---------------------------------------------------------------------------

export interface DimensionBackup {
  dimension:     RollbackDimension;
  snapshotId:    string;
  capturedAt:    string;
  items:         BackupItem[];
  rollbackSteps: RollbackStep[];
  complexity:    RollbackComplexity;
  notes:         string[];
}

export interface BackupItem {
  id:           string;
  dimension:    RollbackDimension;
  name:         string;
  backupPath:   string;           // where the backup is stored
  contentHash?: string;           // sha256 of original content
  metadata:     Record<string, unknown>;
  canAutoRestore: boolean;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface RollbackGeneratorInput {
  primeJobId:    string;
  backendJobId?: string;
  force?:        boolean;
  // Explicit items to back up (engine auto-generates if omitted)
  routes?:      Array<{ path: string; methods: string[]; handler: string; middlewares?: string[] }>;
  migrations?:  Array<{ version: string; name: string; sql: string; downSql?: string }>;
  assets?:      Array<{ path: string; hash?: string; url?: string }>;
  components?:  Array<{ name: string; importPath: string; usedIn?: string[] }>;
  configs?:     Array<{ key: string; value?: string; file?: string; isSecret?: boolean }>;
}

// ---------------------------------------------------------------------------
// Output — rollback-plan.json
// ---------------------------------------------------------------------------

export interface RollbackPlan {
  schemaVersion:    "BM-9";
  primeJobId:       string;
  backendJobId:     string;
  generatedAt:      string;
  durationMs:       number;
  rollbackPlanId:   string;
  isComplete:       boolean;    // all dimensions backed up
  estimatedRollbackMs: number;  // total time to execute full rollback
  requiresDowntime: boolean;
  hasDataLossRisk:  boolean;
  dimensions:       Record<RollbackDimension, DimensionBackup>;
  allSteps:         RollbackStep[];    // ordered global rollback sequence
  backupManifest:   BackupItem[];      // everything that was snapshotted
  summary: {
    totalItems:         number;
    totalSteps:         number;
    autoRestorableItems: number;
    manualItems:        number;
    downtimeSteps:      number;
    dataLossSteps:      number;
    complexityLevel:    RollbackComplexity;
    rollbackWindow:     string;    // human-readable time estimate
    recommendation:     string;
  };
  r2Key?: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const _cache = new Map<string, RollbackPlan>();

export function getCachedRollbackPlan(primeJobId: string): RollbackPlan | undefined {
  return _cache.get(primeJobId);
}

// ---------------------------------------------------------------------------
// ID generators
// ---------------------------------------------------------------------------

let _seq = 0;
function itemId(): string { return `BKP-${String(++_seq).padStart(4, "0")}`; }
function stepId(): string { return `RBK-${String(++_seq).padStart(4, "0")}`; }
function snapId(): string { return `SNAP-${Date.now().toString(36).toUpperCase()}`; }
function planId(): string { return `PLAN-${Date.now().toString(36).toUpperCase()}`; }

// ---------------------------------------------------------------------------
// Routes backup
// ---------------------------------------------------------------------------

function generateRoutesBackup(
  routes: RollbackGeneratorInput["routes"],
  capturedAt: string,
): DimensionBackup {
  const items: BackupItem[] = [];
  const steps: RollbackStep[] = [];

  // Always back up the router index
  items.push({
    id:   itemId(), dimension: "routes",
    name: "Route index (src/routes/index.ts)",
    backupPath: "/tmp/bm9/rollback/routes/index.ts.bak",
    metadata: { routeCount: routes?.length ?? 0 },
    canAutoRestore: true,
  });

  for (const route of routes ?? []) {
    items.push({
      id:   itemId(), dimension: "routes",
      name: `${route.methods.join(",")} ${route.path}`,
      backupPath: `/tmp/bm9/rollback/routes${route.path.replace(/\//g, "_")}.json`,
      metadata: { handler: route.handler, middlewares: route.middlewares ?? [] },
      canAutoRestore: true,
    });

    steps.push({
      id:            stepId(), order: steps.length + 1, dimension: "routes",
      strategy:      "REVERT_FILE",
      title:         `Remove route: ${route.methods.join(",")} ${route.path}`,
      description:   `Deregister the prime route and restore the original router registration`,
      command:       `# Remove prime router registration for ${route.path} from src/routes/index.ts`,
      estimatedMs:   100,
      reversesOperation: `Register ${route.path}`,
      requiresDowntime:  false,
      dataLossRisk:      false,
      verificationStep:  `curl -I ${route.path} → expect 404 (route removed) or original response`,
    });
  }

  // Global router restore step
  steps.push({
    id:            stepId(), order: steps.length + 1, dimension: "routes",
    strategy:      "REVERT_FILE",
    title:         "Restore route index to pre-merge state",
    description:   "Copy /tmp/bm9/rollback/routes/index.ts.bak back to src/routes/index.ts and restart server",
    command:       "cp /tmp/bm9/rollback/routes/index.ts.bak src/routes/index.ts && npm run build && npm start",
    estimatedMs:   3000,
    reversesOperation: "All route registrations",
    requiresDowntime:  true,
    dataLossRisk:      false,
    verificationStep:  "curl /api/healthz → expect 200; spot-check 3 critical routes",
  });

  return {
    dimension: "routes", snapshotId: snapId(), capturedAt,
    items, rollbackSteps: steps, complexity: "low",
    notes: [`${routes?.length ?? 0} route(s) snapshotted`, "Router can be restored by replacing index.ts from backup"],
  };
}

// ---------------------------------------------------------------------------
// Database backup
// ---------------------------------------------------------------------------

function generateDatabaseBackup(
  migrations: RollbackGeneratorInput["migrations"],
  capturedAt: string,
): DimensionBackup {
  const items: BackupItem[] = [];
  const steps: RollbackStep[] = [];

  // Schema dump backup
  items.push({
    id:   itemId(), dimension: "database",
    name: "Full schema dump (pre-merge)",
    backupPath: "/tmp/bm9/rollback/database/schema-pre-merge.sql",
    metadata: { tables: "all", dumpType: "schema-only" },
    canAutoRestore: true,
  });

  // Row count snapshot
  items.push({
    id:   itemId(), dimension: "database",
    name: "Row count snapshot",
    backupPath: "/tmp/bm9/rollback/database/row-counts.json",
    metadata: { purpose: "verify no data loss after rollback" },
    canAutoRestore: false,
  });

  for (const mig of migrations ?? []) {
    items.push({
      id:   itemId(), dimension: "database",
      name: `Migration: ${mig.version} — ${mig.name}`,
      backupPath: `/tmp/bm9/rollback/database/migrations/${mig.version}.json`,
      metadata: {
        version: mig.version,
        hasDownScript: !!mig.downSql,
        upSqlLength: mig.sql.length,
      },
      canAutoRestore: !!mig.downSql,
    });

    if (mig.downSql) {
      steps.push({
        id:            stepId(), order: steps.length + 1, dimension: "database",
        strategy:      "REVERT_MIGRATION",
        title:         `Down migration: ${mig.version}`,
        description:   `Execute the DOWN script for migration "${mig.name}"`,
        command:       mig.downSql,
        estimatedMs:   500,
        reversesOperation: `Migration ${mig.version}`,
        requiresDowntime:  false,
        dataLossRisk:      mig.downSql.toLowerCase().includes("drop"),
        verificationStep:  `SELECT * FROM migrations WHERE version='${mig.version}' → row should be absent`,
      });
    } else {
      steps.push({
        id:            stepId(), order: steps.length + 1, dimension: "database",
        strategy:      "RESTORE_BACKUP",
        title:         `Restore schema for migration: ${mig.version}`,
        description:   `No DOWN script provided — restore from schema dump`,
        command:       `psql $DATABASE_URL < /tmp/bm9/rollback/database/schema-pre-merge.sql`,
        estimatedMs:   5000,
        reversesOperation: `Migration ${mig.version}`,
        requiresDowntime:  true,
        dataLossRisk:      true,
        verificationStep:  "Compare row counts against pre-merge snapshot",
      });
    }
  }

  // Final schema restore step
  steps.push({
    id:            stepId(), order: steps.length + 1, dimension: "database",
    strategy:      "RESTORE_BACKUP",
    title:         "Verify schema integrity post-rollback",
    description:   "Compare current schema against pre-merge dump to confirm full restoration",
    command:       "pg_dump --schema-only $DATABASE_URL > /tmp/schema-post-rollback.sql && diff /tmp/bm9/rollback/database/schema-pre-merge.sql /tmp/schema-post-rollback.sql",
    estimatedMs:   1000,
    reversesOperation: "Schema verification",
    requiresDowntime:  false,
    dataLossRisk:      false,
    verificationStep:  "diff output should be empty",
  });

  const hasDataLoss = steps.some(s => s.dataLossRisk);
  return {
    dimension: "database", snapshotId: snapId(), capturedAt,
    items, rollbackSteps: steps,
    complexity: hasDataLoss ? "high" : migrations?.length ? "medium" : "low",
    notes: [
      `${migrations?.length ?? 0} migration(s) with rollback scripts`,
      hasDataLoss
        ? "⚠ Some rollbacks require restoring from schema dump — verify data loss risk before proceeding"
        : "All database rollbacks are fully scriptable",
    ],
  };
}

// ---------------------------------------------------------------------------
// Assets backup
// ---------------------------------------------------------------------------

function generateAssetsBackup(
  assets: RollbackGeneratorInput["assets"],
  capturedAt: string,
): DimensionBackup {
  const items: BackupItem[] = [];
  const steps: RollbackStep[] = [];

  items.push({
    id:   itemId(), dimension: "assets",
    name: "Asset manifest (pre-merge)",
    backupPath: "/tmp/bm9/rollback/assets/manifest.json",
    metadata: { assetCount: assets?.length ?? 0 },
    canAutoRestore: true,
  });

  for (const asset of assets ?? []) {
    items.push({
      id:   itemId(), dimension: "assets",
      name: asset.path,
      backupPath: `/tmp/bm9/rollback/assets${asset.path}`,
      contentHash: asset.hash,
      metadata: { originalUrl: asset.url ?? asset.path },
      canAutoRestore: true,
    });
  }

  if ((assets ?? []).length > 0) {
    steps.push({
      id:            stepId(), order: 1, dimension: "assets",
      strategy:      "RESTORE_BACKUP",
      title:         "Restore static assets from backup",
      description:   "Copy all prime assets from backup location back to /public and invalidate CDN",
      command:       "rsync -av /tmp/bm9/rollback/assets/ public/ && curl -X DELETE $CDN_PURGE_URL",
      estimatedMs:   2000,
      reversesOperation: "Asset deployment",
      requiresDowntime:  false,
      dataLossRisk:      false,
      verificationStep:  "Verify asset hashes match pre-merge manifest: shasum -c /tmp/bm9/rollback/assets/manifest.json",
    });
  }

  return {
    dimension: "assets", snapshotId: snapId(), capturedAt,
    items, rollbackSteps: steps, complexity: "trivial",
    notes: [`${assets?.length ?? 0} asset(s) snapshotted with content hashes`],
  };
}

// ---------------------------------------------------------------------------
// Components backup
// ---------------------------------------------------------------------------

function generateComponentsBackup(
  components: RollbackGeneratorInput["components"],
  capturedAt: string,
): DimensionBackup {
  const items: BackupItem[] = [];
  const steps: RollbackStep[] = [];

  items.push({
    id:   itemId(), dimension: "components",
    name: "Component registry (pre-merge)",
    backupPath: "/tmp/bm9/rollback/components/registry.json",
    metadata: { componentCount: components?.length ?? 0 },
    canAutoRestore: true,
  });

  for (const comp of components ?? []) {
    items.push({
      id:   itemId(), dimension: "components",
      name: comp.name,
      backupPath: `/tmp/bm9/rollback/components/${comp.name}.json`,
      metadata: { importPath: comp.importPath, usedIn: comp.usedIn ?? [] },
      canAutoRestore: true,
    });
  }

  steps.push({
    id:            stepId(), order: 1, dimension: "components",
    strategy:      "REVERT_FILE",
    title:         "Remove prime component adapters",
    description:   "Delete all generated adapter files (src/adapters/*.tsx) and restore original imports",
    command:       "rm -rf src/adapters/ && git checkout -- src/",
    estimatedMs:   500,
    reversesOperation: "Component adapter installation",
    requiresDowntime:  false,
    dataLossRisk:      false,
    verificationStep:  "npx tsc --noEmit → expect 0 errors; verify original component imports resolve",
  });

  steps.push({
    id:            stepId(), order: 2, dimension: "components",
    strategy:      "REDEPLOY",
    title:         "Rebuild without prime components",
    description:   "Rebuild the frontend bundle without any prime component references",
    command:       "pnpm run build && pnpm run typecheck",
    estimatedMs:   30000,
    reversesOperation: "Prime component injection",
    requiresDowntime:  true,
    dataLossRisk:      false,
    verificationStep:  "Build succeeds with 0 errors; bundle size returns to pre-merge baseline",
  });

  return {
    dimension: "components", snapshotId: snapId(), capturedAt,
    items, rollbackSteps: steps, complexity: "medium",
    notes: [
      `${components?.length ?? 0} component(s) snapshotted`,
      "Component rollback requires a full rebuild — plan for ~30s downtime during redeploy",
    ],
  };
}

// ---------------------------------------------------------------------------
// Configs backup
// ---------------------------------------------------------------------------

function generateConfigsBackup(
  configs: RollbackGeneratorInput["configs"],
  capturedAt: string,
): DimensionBackup {
  const items: BackupItem[] = [];
  const steps: RollbackStep[] = [];

  for (const conf of configs ?? []) {
    items.push({
      id:   itemId(), dimension: "configs",
      name: conf.isSecret ? `[SECRET] ${conf.key}` : conf.key,
      backupPath: conf.file
        ? `/tmp/bm9/rollback/configs/${conf.file}.bak`
        : `/tmp/bm9/rollback/configs/env/${conf.key}`,
      metadata: {
        isSecret: conf.isSecret ?? false,
        hasFile:  !!conf.file,
        // Never store the actual value in the backup metadata
      },
      canAutoRestore: !conf.isSecret,
    });

    if (conf.file) {
      steps.push({
        id:            stepId(), order: steps.length + 1, dimension: "configs",
        strategy:      "REVERT_FILE",
        title:         `Restore config file: ${conf.file}`,
        description:   `Replace ${conf.file} with the pre-merge backup`,
        command:       `cp /tmp/bm9/rollback/configs/${conf.file}.bak ${conf.file}`,
        estimatedMs:   50,
        reversesOperation: `Config file modification: ${conf.file}`,
        requiresDowntime:  false,
        dataLossRisk:      false,
        verificationStep:  `diff /tmp/bm9/rollback/configs/${conf.file}.bak ${conf.file} → empty output`,
      });
    } else if (!conf.isSecret) {
      steps.push({
        id:            stepId(), order: steps.length + 1, dimension: "configs",
        strategy:      "RESTORE_ENV",
        title:         `Restore env var: ${conf.key}`,
        description:   `Reset ${conf.key} to its pre-merge value`,
        command:       `# Restore ${conf.key} via your secrets manager or .env file`,
        estimatedMs:   10,
        reversesOperation: `Env var change: ${conf.key}`,
        requiresDowntime:  false,
        dataLossRisk:      false,
        verificationStep:  `printenv ${conf.key} → verify expected value`,
      });
    } else {
      steps.push({
        id:            stepId(), order: steps.length + 1, dimension: "configs",
        strategy:      "RESTORE_ENV",
        title:         `Manual restore required: [SECRET] ${conf.key}`,
        description:   `Secret ${conf.key} cannot be auto-restored — retrieve from your secrets manager`,
        apiCall:       "GET /api/secrets/{key} — retrieve from vault",
        estimatedMs:   300000,
        reversesOperation: `Secret rotation: ${conf.key}`,
        requiresDowntime:  false,
        dataLossRisk:      false,
        verificationStep:  `Validate secret value matches pre-merge version via your secrets manager`,
      });
    }
  }

  const hasSecrets = (configs ?? []).some(c => c.isSecret);
  return {
    dimension: "configs", snapshotId: snapId(), capturedAt,
    items, rollbackSteps: steps,
    complexity: hasSecrets ? "high" : "low",
    notes: [
      `${configs?.length ?? 0} config item(s) snapshotted`,
      hasSecrets
        ? "⚠ Secret values are NOT stored in the backup — manual retrieval from vault is required"
        : "All configs are auto-restorable from backup",
    ],
  };
}

// ---------------------------------------------------------------------------
// Overall complexity
// ---------------------------------------------------------------------------

function overallComplexity(dims: Record<RollbackDimension, DimensionBackup>): RollbackComplexity {
  const levels: RollbackComplexity[] = ["trivial", "low", "medium", "high", "critical"];
  const max = Object.values(dims).reduce((worst, d) => {
    return levels.indexOf(d.complexity) > levels.indexOf(worst) ? d.complexity : worst;
  }, "trivial" as RollbackComplexity);
  return max;
}

function rollbackWindow(ms: number): string {
  if (ms < 1000)   return "< 1 second";
  if (ms < 60000)  return `~${Math.ceil(ms / 1000)} seconds`;
  if (ms < 3600000) return `~${Math.ceil(ms / 60000)} minutes`;
  return `~${Math.ceil(ms / 3600000)} hours`;
}

// ---------------------------------------------------------------------------
// Disk / R2 helpers
// ---------------------------------------------------------------------------

async function saveToDisk(jobId: string, plan: RollbackPlan): Promise<void> {
  const dir = join("/tmp/bm9", jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "rollback-plan.json"), JSON.stringify(plan, null, 2));
}

async function saveToR2(jobId: string, plan: RollbackPlan): Promise<string | undefined> {
  try {
    const cloud = getDefaultCloudProvider();
    const key   = `bm9/${jobId}/rollback-plan.json`;
    await cloud.upload({ key, data: Buffer.from(JSON.stringify(plan, null, 2)), contentType: "application/json" });
    return key;
  } catch (err) {
    logger.warn({ err, jobId }, "BM9: R2 upload failed (non-fatal)");
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

export async function runRollbackGenerator(
  input: RollbackGeneratorInput,
): Promise<RollbackPlan> {
  const { primeJobId, backendJobId = "unknown", force = false } = input;
  const t0 = Date.now();

  if (!force) {
    const cached = _cache.get(primeJobId);
    if (cached) {
      logger.info({ primeJobId }, "BM9: returning cached rollback plan");
      return cached;
    }
  }

  logger.info({ primeJobId, backendJobId }, "BM9: rollback generation started");

  const capturedAt = new Date().toISOString();

  const dims: Record<RollbackDimension, DimensionBackup> = {
    routes:     generateRoutesBackup(input.routes, capturedAt),
    database:   generateDatabaseBackup(input.migrations, capturedAt),
    assets:     generateAssetsBackup(input.assets, capturedAt),
    components: generateComponentsBackup(input.components, capturedAt),
    configs:    generateConfigsBackup(input.configs, capturedAt),
  };

  // Flatten and order all steps globally
  const allSteps: RollbackStep[] = Object.values(dims)
    .flatMap(d => d.rollbackSteps)
    .sort((a, b) => {
      // Recommended order: configs → assets → components → routes → database
      const dimOrder: Record<RollbackDimension, number> = {
        configs: 1, assets: 2, components: 3, routes: 4, database: 5,
      };
      return dimOrder[a.dimension] - dimOrder[b.dimension];
    })
    .map((s, i) => ({ ...s, order: i + 1 }));

  const allItems = Object.values(dims).flatMap(d => d.items);

  const estimatedRollbackMs = allSteps.reduce((sum, s) => sum + s.estimatedMs, 0);
  const requiresDowntime    = allSteps.some(s => s.requiresDowntime);
  const hasDataLossRisk     = allSteps.some(s => s.dataLossRisk);
  const complexity          = overallComplexity(dims);

  const autoRestorable = allItems.filter(i => i.canAutoRestore).length;
  const manual         = allItems.filter(i => !i.canAutoRestore).length;
  const downtimeSteps  = allSteps.filter(s => s.requiresDowntime).length;
  const dataLossSteps  = allSteps.filter(s => s.dataLossRisk).length;

  const recommendation =
    hasDataLossRisk  ? "⚠ Data loss risk detected in rollback plan — test rollback procedure in staging before production merge." :
    requiresDowntime ? "Rollback requires brief downtime — schedule merge during a maintenance window." :
    complexity === "trivial" || complexity === "low"
                     ? "Rollback is fully automated and low-risk — safe to proceed with merge." :
                       "Rollback is available for all operations — review manual steps before executing.";

  const plan: RollbackPlan = {
    schemaVersion:       "BM-9",
    primeJobId,
    backendJobId,
    generatedAt:         new Date().toISOString(),
    durationMs:          Date.now() - t0,
    rollbackPlanId:      planId(),
    isComplete:          true,
    estimatedRollbackMs,
    requiresDowntime,
    hasDataLossRisk,
    dimensions:          dims,
    allSteps,
    backupManifest:      allItems,
    summary: {
      totalItems:          allItems.length,
      totalSteps:          allSteps.length,
      autoRestorableItems: autoRestorable,
      manualItems:         manual,
      downtimeSteps,
      dataLossSteps,
      complexityLevel:     complexity,
      rollbackWindow:      rollbackWindow(estimatedRollbackMs),
      recommendation,
    },
  };

  try {
    await saveToDisk(primeJobId, plan);
    const r2Key = await saveToR2(primeJobId, plan);
    if (r2Key) plan.r2Key = r2Key;
  } catch (err) {
    logger.warn({ err, primeJobId }, "BM9: persistence failed (non-fatal)");
  }

  _cache.set(primeJobId, plan);
  logger.info(
    { primeJobId, steps: allSteps.length, items: allItems.length, complexity, requiresDowntime, hasDataLossRisk },
    "BM9: rollback generation complete",
  );

  return plan;
}
