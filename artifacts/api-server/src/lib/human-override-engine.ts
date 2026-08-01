/**
 * human-override-engine.ts — Phase 7.4: Human Override Engine
 *
 * Manages approval checkpoints across three execution modes:
 *   AUTO       — platform decides, no human gate
 *   SEMI_AUTO  — platform decides but notifies; human can override within TTL
 *   MANUAL     — platform waits for explicit human approval before proceeding
 *
 * Checkpoints:
 *   before-merge       — before executing a backend merge
 *   before-deployment  — before executing a deployment
 *   before-deletion    — before deleting files / artefacts
 *   before-rollback    — before rolling back a deployment
 *
 * Generates override-policy.json locally + uploads to R2.
 */

import { randomUUID }          from "crypto";
import { writeFile, readFile } from "fs/promises";
import { join }                from "path";
import { logger }              from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OverrideMode = "AUTO" | "SEMI_AUTO" | "MANUAL";

export type CheckpointId =
  | "before-merge"
  | "before-deployment"
  | "before-deletion"
  | "before-rollback";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "auto-approved";

export interface CheckpointPolicy {
  checkpointId:  CheckpointId;
  label:         string;
  description:   string;
  mode:          OverrideMode;
  defaultMode:   OverrideMode;
  ttlSeconds:    number;       // how long to wait for approval in MANUAL/SEMI_AUTO
  notifyOnAuto:  boolean;      // emit a notification even in AUTO mode
  updatedAt:     string;
}

export interface ApprovalRequest {
  id:            string;
  checkpointId:  CheckpointId;
  pipelineJobId: string | null;
  context:       Record<string, unknown>;
  status:        ApprovalStatus;
  mode:          OverrideMode;
  requestedAt:   string;
  expiresAt:     string;
  resolvedAt:    string | null;
  resolvedBy:    string | null;
  rejectReason:  string | null;
  note:          string | null;
}

export interface OverridePolicyDocument {
  version:     string;
  phase:       string;
  generatedAt: string;
  globalMode:  OverrideMode;
  checkpoints: CheckpointPolicy[];
}

// ---------------------------------------------------------------------------
// Default policies
// ---------------------------------------------------------------------------

const DEFAULT_POLICIES: Record<CheckpointId, Omit<CheckpointPolicy, "updatedAt">> = {
  "before-merge": {
    checkpointId: "before-merge",
    label:        "Before Merge",
    description:  "Approval required before merging reconstructed files into the backend codebase.",
    mode:         "SEMI_AUTO",
    defaultMode:  "SEMI_AUTO",
    ttlSeconds:   300,
    notifyOnAuto: true,
  },
  "before-deployment": {
    checkpointId: "before-deployment",
    label:        "Before Deployment",
    description:  "Approval required before pushing files to the production hosting target.",
    mode:         "SEMI_AUTO",
    defaultMode:  "SEMI_AUTO",
    ttlSeconds:   300,
    notifyOnAuto: true,
  },
  "before-deletion": {
    checkpointId: "before-deletion",
    label:        "Before Deletion",
    description:  "Approval required before permanently deleting files or artefacts.",
    mode:         "MANUAL",
    defaultMode:  "MANUAL",
    ttlSeconds:   600,
    notifyOnAuto: true,
  },
  "before-rollback": {
    checkpointId: "before-rollback",
    label:        "Before Rollback",
    description:  "Approval required before rolling back a deployment to a previous version.",
    mode:         "MANUAL",
    defaultMode:  "MANUAL",
    ttlSeconds:   180,
    notifyOnAuto: true,
  },
};

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const _policies  = new Map<CheckpointId, CheckpointPolicy>();
let   _globalMode: OverrideMode = "SEMI_AUTO";

// Approval request store
const _requests  = new Map<string, ApprovalRequest>();

// Initialise defaults
function init(): void {
  const now = new Date().toISOString();
  for (const [id, policy] of Object.entries(DEFAULT_POLICIES)) {
    _policies.set(id as CheckpointId, { ...policy, updatedAt: now });
  }
}
init();

// ---------------------------------------------------------------------------
// Policy management
// ---------------------------------------------------------------------------

export function getPolicy(checkpointId: CheckpointId): CheckpointPolicy | undefined {
  return _policies.get(checkpointId);
}

export function getAllPolicies(): CheckpointPolicy[] {
  return Array.from(_policies.values());
}

export function getGlobalMode(): OverrideMode {
  return _globalMode;
}

export function setGlobalMode(mode: OverrideMode): void {
  _globalMode = mode;
  logger.info({ mode }, "OVERRIDE: global mode changed");
  void persistPolicy().catch(() => {});
}

export function updatePolicy(
  checkpointId: CheckpointId,
  patch: Partial<Pick<CheckpointPolicy, "mode" | "ttlSeconds" | "notifyOnAuto">>,
): CheckpointPolicy {
  const existing = _policies.get(checkpointId);
  if (!existing) throw new Error(`Unknown checkpoint: ${checkpointId}`);

  const updated: CheckpointPolicy = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  _policies.set(checkpointId, updated);
  logger.info({ checkpointId, patch }, "OVERRIDE: policy updated");
  void persistPolicy().catch(() => {});
  return updated;
}

export function resetPolicy(checkpointId: CheckpointId): CheckpointPolicy {
  const defaults = DEFAULT_POLICIES[checkpointId];
  if (!defaults) throw new Error(`Unknown checkpoint: ${checkpointId}`);
  const reset = { ...defaults, updatedAt: new Date().toISOString() };
  _policies.set(checkpointId, reset);
  void persistPolicy().catch(() => {});
  return reset;
}

// ---------------------------------------------------------------------------
// Approval lifecycle
// ---------------------------------------------------------------------------

export function createApprovalRequest(opts: {
  checkpointId:  CheckpointId;
  pipelineJobId: string | null;
  context:       Record<string, unknown>;
}): ApprovalRequest {
  const policy   = _policies.get(opts.checkpointId);
  if (!policy) throw new Error(`Unknown checkpoint: ${opts.checkpointId}`);

  // Resolve effective mode — global mode can force everything to AUTO/MANUAL
  const effectiveMode: OverrideMode =
    _globalMode === "AUTO"   ? "AUTO" :
    _globalMode === "MANUAL" ? "MANUAL" :
    policy.mode;

  const now       = new Date();
  const expiresAt = new Date(now.getTime() + policy.ttlSeconds * 1000);
  const id        = randomUUID();

  const req: ApprovalRequest = {
    id,
    checkpointId:  opts.checkpointId,
    pipelineJobId: opts.pipelineJobId ?? null,
    context:       opts.context,
    status:        effectiveMode === "AUTO" ? "auto-approved" : "pending",
    mode:          effectiveMode,
    requestedAt:   now.toISOString(),
    expiresAt:     expiresAt.toISOString(),
    resolvedAt:    effectiveMode === "AUTO" ? now.toISOString() : null,
    resolvedBy:    effectiveMode === "AUTO" ? "system" : null,
    rejectReason:  null,
    note:          null,
  };

  _requests.set(id, req);
  logger.info({ id, checkpointId: opts.checkpointId, mode: effectiveMode, status: req.status }, "OVERRIDE: approval request created");
  return req;
}

export function getApprovalRequest(id: string): ApprovalRequest | undefined {
  const req = _requests.get(id);
  if (!req) return undefined;

  // Check expiry
  if (req.status === "pending" && new Date() > new Date(req.expiresAt)) {
    req.status    = "expired";
    req.resolvedAt = new Date().toISOString();
    _requests.set(id, req);
  }
  return req;
}

export function listApprovalRequests(opts?: {
  checkpointId?: CheckpointId;
  status?: ApprovalStatus;
}): ApprovalRequest[] {
  let list = Array.from(_requests.values());
  if (opts?.checkpointId) list = list.filter((r) => r.checkpointId === opts.checkpointId);
  if (opts?.status)       list = list.filter((r) => r.status === opts.status);
  return list.sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime());
}

export function approve(id: string, opts?: { approvedBy?: string; note?: string }): ApprovalRequest {
  const req = _requests.get(id);
  if (!req) throw new Error(`Approval request ${id} not found`);
  if (req.status !== "pending") throw new Error(`Request is already ${req.status}`);

  req.status     = "approved";
  req.resolvedAt = new Date().toISOString();
  req.resolvedBy = opts?.approvedBy ?? "operator";
  req.note       = opts?.note ?? null;

  _requests.set(id, req);
  logger.info({ id, resolvedBy: req.resolvedBy }, "OVERRIDE: request approved");
  return req;
}

export function reject(id: string, opts?: { rejectedBy?: string; reason?: string }): ApprovalRequest {
  const req = _requests.get(id);
  if (!req) throw new Error(`Approval request ${id} not found`);
  if (req.status !== "pending") throw new Error(`Request is already ${req.status}`);

  req.status       = "rejected";
  req.resolvedAt   = new Date().toISOString();
  req.resolvedBy   = opts?.rejectedBy ?? "operator";
  req.rejectReason = opts?.reason ?? "Rejected by operator";

  _requests.set(id, req);
  logger.info({ id, reason: req.rejectReason }, "OVERRIDE: request rejected");
  return req;
}

// ---------------------------------------------------------------------------
// Gate function — called by pipeline stages before critical actions
// Resolves immediately for AUTO, polls for MANUAL/SEMI_AUTO
// ---------------------------------------------------------------------------

export async function waitForApproval(
  checkpointId:  CheckpointId,
  pipelineJobId: string | null,
  context:       Record<string, unknown>,
): Promise<ApprovalRequest> {
  const req = createApprovalRequest({ checkpointId, pipelineJobId, context });

  // AUTO or already approved — return immediately
  if (req.status === "auto-approved") return req;

  const POLL_MS = 500;
  logger.info(
    { id: req.id, checkpointId, mode: req.mode, expiresAt: req.expiresAt },
    "OVERRIDE: waiting for human approval"
  );

  while (true) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const current = getApprovalRequest(req.id)!;

    if (current.status === "approved")      return current;
    if (current.status === "rejected")      throw new Error(`Action rejected at checkpoint "${checkpointId}": ${current.rejectReason}`);
    if (current.status === "expired") {
      // SEMI_AUTO: auto-approve on TTL expiry; MANUAL: reject on TTL expiry
      if (req.mode === "SEMI_AUTO") {
        current.status    = "auto-approved";
        current.resolvedAt = new Date().toISOString();
        current.resolvedBy = "system:ttl-expired";
        current.note       = "Auto-approved after TTL expiry (SEMI_AUTO mode)";
        _requests.set(req.id, current);
        logger.info({ id: req.id, checkpointId }, "OVERRIDE: SEMI_AUTO auto-approved after TTL");
        return current;
      }
      throw new Error(`Approval for checkpoint "${checkpointId}" expired without a response`);
    }
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const POLICY_PATH       = join(process.cwd(), "override-policy.json");
const POLICY_PATH_UP    = join(process.cwd(), "..", "..", "override-policy.json");

export async function persistPolicy(): Promise<void> {
  const doc: OverridePolicyDocument = {
    version:     "1.0",
    phase:       "7.4",
    generatedAt: new Date().toISOString(),
    globalMode:  _globalMode,
    checkpoints: getAllPolicies(),
  };
  const json  = JSON.stringify(doc, null, 2);
  const cloud = getDefaultCloudProvider();

  await Promise.allSettled([
    writeFile(POLICY_PATH,    json, "utf8"),
    writeFile(POLICY_PATH_UP, json, "utf8"),
    ...(cloud.isConfigured() ? [
      cloud.upload({
        key:            "orchestration/override-policy.json",
        data:           Buffer.from(json, "utf8"),
        contentType:    "application/json",
        checkDuplicate: false,
      }),
    ] : []),
  ]);
}

export async function loadPolicyFromDisk(): Promise<OverridePolicyDocument | null> {
  for (const p of [POLICY_PATH, POLICY_PATH_UP]) {
    try { return JSON.parse(await readFile(p, "utf8")) as OverridePolicyDocument; } catch { /* skip */ }
  }
  return null;
}

// Eagerly write default policy on module load
persistPolicy().catch(() => {});

// ---------------------------------------------------------------------------
// Convenience: resolve pending requests whose TTL has expired
// ---------------------------------------------------------------------------

export function expireStaleRequests(): number {
  const now = new Date();
  let count = 0;
  for (const [id, req] of _requests) {
    if (req.status === "pending" && now > new Date(req.expiresAt)) {
      req.status    = "expired";
      req.resolvedAt = now.toISOString();
      _requests.set(id, req);
      count++;
    }
  }
  return count;
}
