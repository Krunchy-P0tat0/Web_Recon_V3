/**
 * deployment-audit-store.ts — Phase D3 Deployment Audit Store
 *
 * Maintains an in-memory log of all DeploymentExecution records and generates
 * the deployment-audit.json file on demand.
 *
 * The audit file is written to the project root (deployment-audit.json) so it
 * is inspectable outside the API process.
 */

import { promises as fs } from "fs";
import path from "path";
import { logger } from "./logger.js";
import type { DeploymentExecution } from "./deployment-executor.js";

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const _store = new Map<string, DeploymentExecution>();

export function recordExecution(execution: DeploymentExecution): void {
  _store.set(execution.id, execution);
}

export function updateExecution(execution: DeploymentExecution): void {
  _store.set(execution.id, execution);
}

export function getExecution(id: string): DeploymentExecution | undefined {
  return _store.get(id);
}

export function listExecutions(): DeploymentExecution[] {
  return Array.from(_store.values()).sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
}

/** Returns the most recent successful execution for the given jobId, if any. */
export function getLatestSuccessfulForJob(
  jobId: string
): DeploymentExecution | undefined {
  return listExecutions().find(
    (e) => e.jobId === jobId && e.status === "success"
  );
}

/** Returns the second-most-recent successful execution (the one to rollback to). */
export function getPreviousSuccessfulForJob(
  jobId: string,
  currentId: string
): DeploymentExecution | undefined {
  return listExecutions().find(
    (e) => e.jobId === jobId && e.status === "success" && e.id !== currentId
  );
}

// ---------------------------------------------------------------------------
// Audit JSON generation
// ---------------------------------------------------------------------------

export interface DeploymentAuditSummary {
  total: number;
  success: number;
  failed: number;
  rolledBack: number;
  running: number;
  avgDurationMs: number | null;
  firstDeployedAt: string | null;
  lastDeployedAt: string | null;
}

export interface DeploymentAuditFile {
  version: "1.0";
  generatedAt: string;
  summary: DeploymentAuditSummary;
  executions: DeploymentExecution[];
}

export function generateAuditJson(): DeploymentAuditFile {
  const all = listExecutions();
  const done = all.filter((e) => e.durationMs !== null);

  const summary: DeploymentAuditSummary = {
    total: all.length,
    success: all.filter((e) => e.status === "success").length,
    failed: all.filter((e) => e.status === "failed").length,
    rolledBack: all.filter((e) => e.status === "rolled_back").length,
    running: all.filter((e) => e.status === "running" || e.status === "pending").length,
    avgDurationMs:
      done.length > 0
        ? Math.round(done.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) / done.length)
        : null,
    firstDeployedAt: all.length > 0 ? all[all.length - 1]!.startedAt : null,
    lastDeployedAt: all.length > 0 ? all[0]!.startedAt : null,
  };

  return {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    summary,
    executions: all,
  };
}

// ---------------------------------------------------------------------------
// Disk persistence
// ---------------------------------------------------------------------------

// pnpm sets cwd to the package directory (artifacts/api-server) when running scripts.
// Walk up two levels: artifacts/api-server → artifacts → workspace root.
const AUDIT_PATH = path.resolve(process.cwd(), "../../deployment-audit.json");

export async function saveAuditToDisk(): Promise<string> {
  const audit = generateAuditJson();
  await fs.writeFile(AUDIT_PATH, JSON.stringify(audit, null, 2), "utf8");
  logger.debug({ path: AUDIT_PATH }, "AUDIT-STORE: deployment-audit.json written");
  return AUDIT_PATH;
}

export async function loadAuditFromDisk(): Promise<void> {
  try {
    const raw = await fs.readFile(AUDIT_PATH, "utf8");
    const parsed = JSON.parse(raw) as DeploymentAuditFile;
    if (parsed.executions) {
      for (const e of parsed.executions) {
        _store.set(e.id, e);
      }
      logger.info(
        { count: parsed.executions.length, path: AUDIT_PATH },
        "AUDIT-STORE: restored executions from disk"
      );
    }
  } catch {
    // File doesn't exist yet — normal on first startup
  }
}
