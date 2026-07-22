/**
 * deployment-executor.ts — Phase D3 Deployment Execution Engine
 *
 * Executes deployment plans for generated websites:
 *   1. Reads the ZIP from local storage or R2 (jobs/{jobId}/site.zip)
 *   2. Extracts all files in memory
 *   3. Uploads each file to R2 under deployments/{executionId}/
 *   4. Verifies deployment (index.html reachable)
 *   5. Records every step with precise timing for the audit
 *
 * Supports rollback: previous deployments stay live in R2 — rollback just
 * redirects to the previous execution's URL.
 */

import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import AdmZip from "adm-zip";
import { R2Provider } from "../cloud/r2.provider.js";
import { getJobRecord } from "./db-queue.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExecutionStatus = "pending" | "running" | "success" | "failed" | "rolled_back";
export type ExecutionTarget = "r2-static";

export interface AuditStep {
  name: string;
  status: "success" | "failed" | "skipped";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  message: string | null;
  metadata: Record<string, unknown>;
}

export interface DeploymentExecution {
  id: string;
  jobId: string | null;
  framework: string | null;
  target: ExecutionTarget;
  status: ExecutionStatus;
  deploymentUrl: string | null;
  rollbackToUrl: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
  steps: AuditStep[];
  filesDeployed: number;
  bytesDeployed: number;
}

export interface ExecutionRequest {
  jobId: string;
  target?: ExecutionTarget;
  framework?: string | null;
  /** URL of a currently live deployment to rollback to (used internally for rollback ops) */
  rollbackToUrl?: string | null;
}

// ---------------------------------------------------------------------------
// Step builder
// ---------------------------------------------------------------------------

interface StepCtx {
  steps: AuditStep[];
}

async function runStep<T>(
  ctx: StepCtx,
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  try {
    const result = await fn();
    ctx.steps.push({
      name,
      status: "success",
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      message: null,
      metadata: {},
    });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.steps.push({
      name,
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      message: msg,
      metadata: {},
    });
    throw err;
  }
}

function skipStep(ctx: StepCtx, name: string, reason: string): void {
  const now = new Date().toISOString();
  ctx.steps.push({
    name,
    status: "skipped",
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    message: reason,
    metadata: {},
  });
}

// ---------------------------------------------------------------------------
// ZIP acquisition helpers
// ---------------------------------------------------------------------------

async function getZipBuffer(jobId: string, r2: R2Provider): Promise<Buffer> {
  // 1. Try DB record → local zipPath
  const job = await getJobRecord(jobId);
  if (job?.zipPath) {
    try {
      const buf = await fs.readFile(job.zipPath);
      logger.debug({ jobId, zipPath: job.zipPath }, "EXECUTOR: ZIP read from local path");
      return buf;
    } catch {
      // fall through to R2
    }
  }

  // 2. Try R2 at jobs/{jobId}/site.zip
  if (r2.isConfigured()) {
    const key = `jobs/${jobId}/site.zip`;
    const buf = await r2.download(key);
    if (buf) {
      logger.debug({ jobId, key }, "EXECUTOR: ZIP downloaded from R2");
      return buf;
    }
  }

  throw new Error(
    `ZIP not found for job '${jobId}'. Checked local zipPath and R2 at jobs/${jobId}/site.zip.`
  );
}

// ---------------------------------------------------------------------------
// Content-type helper (mirrors R2Provider's private function)
// ---------------------------------------------------------------------------

const EXT_CT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

function contentType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return EXT_CT[filename.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Main execution entry point
// ---------------------------------------------------------------------------

export async function executeDeployment(
  req: ExecutionRequest
): Promise<DeploymentExecution> {
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const ctx: StepCtx = { steps: [] };

  const execution: DeploymentExecution = {
    id,
    jobId: req.jobId,
    framework: req.framework ?? null,
    target: req.target ?? "r2-static",
    status: "running",
    deploymentUrl: null,
    rollbackToUrl: req.rollbackToUrl ?? null,
    startedAt,
    completedAt: null,
    durationMs: null,
    error: null,
    steps: ctx.steps,
    filesDeployed: 0,
    bytesDeployed: 0,
  };

  logger.info({ executionId: id, jobId: req.jobId }, "EXECUTOR: starting deployment");

  const r2 = new R2Provider();

  try {
    // ── Step 1: Validate R2 configuration ──────────────────────────────────
    await runStep(ctx, "validate_configuration", async () => {
      if (!r2.isConfigured()) {
        throw new Error("R2 storage is not configured — required for deployment. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL.");
      }
    });

    // ── Step 2: Acquire ZIP ─────────────────────────────────────────────────
    let zipBuffer!: Buffer;
    await runStep(ctx, "acquire_zip", async () => {
      zipBuffer = await getZipBuffer(req.jobId, r2);
    });

    // ── Step 3: Extract files ───────────────────────────────────────────────
    interface FileEntry { name: string; data: Buffer }
    let files!: FileEntry[];
    await runStep(ctx, "extract_files", async () => {
      const zip = new AdmZip(zipBuffer);
      const entries = zip.getEntries();
      files = entries
        .filter((e) => !e.isDirectory && e.entryName !== "")
        .map((e) => ({
          name: e.entryName.replace(/^\//, ""),
          data: e.getData(),
        }));
      if (files.length === 0) throw new Error("ZIP is empty — no files to deploy.");
      logger.debug({ executionId: id, fileCount: files.length }, "EXECUTOR: extracted files");
    });

    // ── Step 4: Upload files to R2 ──────────────────────────────────────────
    const prefix = `deployments/${id}`;
    let totalBytes = 0;
    await runStep(ctx, "upload_files", async () => {
      for (const file of files) {
        const key = `${prefix}/${file.name}`;
        await r2.upload({
          key,
          data: file.data,
          contentType: contentType(file.name),
          checkDuplicate: false,
        });
        totalBytes += file.data.length;
      }
      execution.filesDeployed = files.length;
      execution.bytesDeployed = totalBytes;
    });

    // ── Step 5: Verify deployment (check index.html exists) ────────────────
    let deploymentUrl!: string;
    await runStep(ctx, "verify_deployment", async () => {
      const indexKey = `${prefix}/index.html`;
      const exists = await r2.verify(indexKey);
      if (!exists) {
        // Not all sites have index.html at root — look for any HTML file
        const htmlFile = files.find((f) => f.name.endsWith(".html"));
        if (!htmlFile) throw new Error("No HTML file found in the deployed assets.");
        deploymentUrl = r2.getPublicUrl(`${prefix}/${htmlFile.name}`);
      } else {
        deploymentUrl = r2.getPublicUrl(indexKey);
      }
    });

    // ── Step 6: Record manifest ─────────────────────────────────────────────
    await runStep(ctx, "write_manifest", async () => {
      const manifest = {
        executionId: id,
        jobId: req.jobId,
        deployedAt: new Date().toISOString(),
        filesDeployed: execution.filesDeployed,
        bytesDeployed: execution.bytesDeployed,
        deploymentUrl,
        files: files.map((f) => ({
          name: f.name,
          bytes: f.data.length,
          url: r2.getPublicUrl(`${prefix}/${f.name}`),
        })),
      };
      await r2.upload({
        key: `${prefix}/_deployment-manifest.json`,
        data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
        contentType: "application/json",
        checkDuplicate: false,
      });
    });

    execution.status = "success";
    execution.deploymentUrl = deploymentUrl;
    logger.info(
      { executionId: id, deploymentUrl, filesDeployed: execution.filesDeployed },
      "EXECUTOR: deployment succeeded"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    execution.status = "failed";
    execution.error = msg;
    logger.error({ executionId: id, err }, "EXECUTOR: deployment failed");
  }

  execution.completedAt = new Date().toISOString();
  execution.durationMs = Date.now() - t0;
  return execution;
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Rolls back `failedExecution` to `previousExecution`.
 *
 * Since previous deployments stay live in R2, rollback is instant:
 *   1. Mark the failed execution as rolled_back
 *   2. Return the previous execution's URL as the active URL
 */
export function rollbackExecution(
  failedExecution: DeploymentExecution,
  previousExecution: DeploymentExecution
): DeploymentExecution {
  if (!previousExecution.deploymentUrl) {
    throw new Error("Previous execution has no deployment URL to rollback to.");
  }
  return {
    ...failedExecution,
    status: "rolled_back",
    completedAt: new Date().toISOString(),
    rollbackToUrl: previousExecution.deploymentUrl,
    steps: [
      ...failedExecution.steps,
      {
        name: "rollback",
        status: "success",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 0,
        message: `Rolled back to deployment ${previousExecution.id} (${previousExecution.deploymentUrl})`,
        metadata: { rolledBackToId: previousExecution.id },
      },
    ],
  };
}
