/**
 * recovery-api.ts — thin fetch layer for the Recovery & Checkpoints Center.
 *
 * Mirrors differential-api.ts: root-relative "/api/..." URLs resolved by the
 * Replit proxy. Wraps the pre-existing engines — no recovery/checkpoint logic
 * lives here, only reads of what the pipeline already computed:
 *   - F2 failure-classifier.ts     (Failure Classification)
 *   - F3 autonomous-recovery-engine.ts (Recovery Attempts, Batch State)
 *   - F4 checkpoint-engine.ts      (Checkpoint Reports, Storage Upload Status)
 *   - E2 e2-recovery-engine.ts     (System Recovery Report)
 *   - E3 e3-repair-planner.ts      (Recovery Plan Inspector)
 */

const API_BASE = "/api";

function url(path: string): string {
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function request<T>(path: string): Promise<T> {
  const res = await fetch(url(path));
  const body = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !body.ok) {
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return body.data as T;
}

// ── F2 Failure Classification ────────────────────────────────────────────────

export type FailureClass =
  | "OOM" | "NetworkTimeout" | "DNSFailure" | "HTTPFailure" | "429RateLimit"
  | "5xxServerError" | "BrowserCrash" | "ParserFailure" | "StorageFailure"
  | "CheckpointFailure" | "ManifestFailure" | "UnexpectedException" | "Unknown";

export type RetryRecommendation = "retry_immediately" | "retry_with_backoff" | "retry_after_fix" | "do_not_retry";
export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface FailureClassification {
  jobId: string;
  classifiedAt: string;
  failureClass: FailureClass;
  confidence: number;
  rootCause: string;
  retryRecommendation: RetryRecommendation;
  recoveryRecommendation: string;
  riskLevel: RiskLevel;
  errorMessage: string;
  errorStack: string | null;
  retryCount: number;
  maxRetries: number;
  seedUrl: string;
}

export interface ClassifierPatternSummary {
  failureClass: FailureClass;
  confidence: number;
  rootCause: string;
  retryRecommendation: RetryRecommendation;
  recoveryRecommendation: string;
  riskLevel: RiskLevel;
  patternCount: number;
}

export function fetchClassifications(): Promise<FailureClassification[]> {
  return request<FailureClassification[]>("/recovery/classifications");
}

export function fetchClassifierPatterns(): Promise<ClassifierPatternSummary[]> {
  return request<ClassifierPatternSummary[]>("/recovery/classifications/patterns");
}

// ── F3 Recovery Attempts + Batch State ───────────────────────────────────────

export type RecoveryActionType = "auto_retry" | "delayed_retry" | "checkpoint_resume" | "batch_split" | "worker_migration" | "safe_abort";
export type RecoveryOutcome = "succeeded" | "failed" | "scheduled" | "aborted";

export interface RecoveryAction {
  actionId: string;
  jobId: string;
  seedUrl: string;
  triggeredAt: string;
  completedAt: string | null;
  failureClass: FailureClass;
  retryCount: number;
  maxRetries: number;
  actionType: RecoveryActionType;
  actionReason: string;
  delayMs: number | null;
  childJobIds: string[];
  originalBatchSize: number | null;
  newBatchSize: number | null;
  outcome: RecoveryOutcome;
  outcomeDetail: string | null;
}

export interface RecoveryReport {
  generatedAt: string;
  totalActionsTriggered: number;
  totalSucceeded: number;
  totalFailed: number;
  totalScheduled: number;
  totalAborted: number;
  byActionType: Partial<Record<RecoveryActionType, number>>;
  byFailureClass: Partial<Record<FailureClass, number>>;
  actions: RecoveryAction[];
}

export interface RetryHistoryEntry {
  entryId: string;
  jobId: string;
  seedUrl: string;
  failureClass: FailureClass;
  retryCount: number;
  actionType: RecoveryActionType;
  attemptedAt: string;
  outcome: RecoveryOutcome;
  notes: string;
}

export interface AutomaticRecoveryReport {
  generatedAt: string;
  summary: {
    jobsAutoRecovered: number;
    jobsAborted: number;
    childJobsSpawned: number;
    totalDelayMsAccumulated: number;
    averageRecoveryDelayMs: number;
  };
  recoveryChains: Array<{
    jobId: string;
    seedUrl: string;
    failureClass: FailureClass;
    recoveryChain: Array<{ actionType: RecoveryActionType; outcome: RecoveryOutcome; triggeredAt: string }>;
    finalOutcome: "recovered" | "aborted";
  }>;
}

export interface BatchStateView {
  generatedAt: string;
  totalBatchSplits: number;
  totalChildJobsSpawned: number;
  splits: Array<{
    jobId: string;
    seedUrl: string;
    triggeredAt: string;
    completedAt: string | null;
    failureClass: FailureClass;
    originalBatchSize: number | null;
    newBatchSize: number | null;
    childJobIds: string[];
    outcome: RecoveryOutcome;
    outcomeDetail: string | null;
  }>;
}

export function fetchRecoveryReport(): Promise<RecoveryReport> {
  return request<RecoveryReport>("/recovery/report");
}

export function fetchRetryHistory(): Promise<{ generatedAt: string; entries: RetryHistoryEntry[] }> {
  return request("/recovery/retry-history");
}

export function fetchAutomaticRecoveryReport(): Promise<AutomaticRecoveryReport> {
  return request<AutomaticRecoveryReport>("/recovery/automatic-report");
}

export function fetchBatchState(): Promise<BatchStateView> {
  return request<BatchStateView>("/recovery/batch-state");
}

// ── Recovery Timeline (F2 + F3 merged) ───────────────────────────────────────

export interface TimelineEvent {
  type: "classified" | "recovery_triggered" | "recovery_completed";
  at: string;
  detail: Record<string, unknown>;
}

export interface JobTimeline {
  jobId: string;
  seedUrl: string;
  failureClass: FailureClass | null;
  currentStatus: string;
  events: TimelineEvent[];
}

export function fetchRecoveryTimeline(): Promise<{ generatedAt: string; totalJobs: number; timelines: JobTimeline[] }> {
  return request("/recovery/timeline");
}

// ── F4 Checkpoint Reports ────────────────────────────────────────────────────

export interface CoverageState { total: number; completed: number; failed: number; skipped: number; coveragePercent: number; }
export interface ManifestState { hasManifest: boolean; manifestKey: string | null; nodeCount: number; lastSavedAt: string | null; }
export interface DifferentialState { diffMode: boolean; baseJobId: string | null; savedBytes: number; pagesSkipped: number; }
export interface StorageState { uploadedKeys: string[]; totalBytesUploaded: number; lastUploadedAt: string | null; pendingKeys: string[]; }

export interface ArticleLinkRef { url: string; title?: string; [key: string]: unknown }

export interface JobCheckpoint {
  jobId: string;
  seedUrl: string;
  checkpointVersion: number;
  checkpointedAt: string;
  allArticles: ArticleLinkRef[];
  completedUrls: string[];
  visitedUrls: string[];
  failedUrls: string[];
  pendingUrls: string[];
  coverageState: CoverageState;
  manifestState: ManifestState;
  differentialState: DifferentialState;
  storageState: StorageState;
  checksum: string;
  isValid: boolean;
}

export interface CheckpointResumeReport {
  generatedAt: string;
  totalCheckpoints: number;
  totalResumed: number;
  totalFresh: number;
  totalCompleted: number;
  resumes: Array<{
    jobId: string; seedUrl: string; resumedAt: string; checkpointVersion: number;
    urlsSkipped: number; urlsRemaining: number; coverageAtResume: number;
  }>;
}

export interface ResumeValidationReport {
  generatedAt: string;
  totalValidated: number;
  totalValid: number;
  totalInvalid: number;
  totalMissing: number;
  validations: Array<{
    jobId: string; valid: boolean; reason: string;
    checkpointVersion: number | null; checkpointedAt: string | null; checksumMatch: boolean | null;
  }>;
}

export interface CheckpointIntegrityReport {
  generatedAt: string;
  totalChecked: number;
  totalHealthy: number;
  totalCorrupted: number;
  totalMissing: number;
  integrityChecks: Array<{
    jobId: string; status: "healthy" | "corrupted" | "missing";
    checkpointVersion: number | null; checkpointedAt: string | null;
    urlsCheckpointed: number | null; checksumValid: boolean | null; detail: string;
  }>;
}

export function fetchCheckpointResumeReport(): Promise<CheckpointResumeReport> {
  return request<CheckpointResumeReport>("/checkpoint/report");
}

export function fetchResumeValidationReport(): Promise<ResumeValidationReport> {
  return request<ResumeValidationReport>("/checkpoint/validation");
}

export function fetchCheckpointIntegrityReport(): Promise<CheckpointIntegrityReport> {
  return request<CheckpointIntegrityReport>("/checkpoint/integrity");
}

export function fetchAllCheckpointsFull(): Promise<{ count: number; checkpoints: JobCheckpoint[] }> {
  return request("/checkpoint?full=true");
}

export interface StorageStatusView {
  generatedAt: string;
  totalJobs: number;
  totalBytesUploaded: number;
  totalPendingUploads: number;
  jobs: Array<{
    jobId: string; seedUrl: string; uploadedCount: number; totalBytesUploaded: number;
    lastUploadedAt: string | null; pendingCount: number; uploadedKeys: string[]; pendingKeys: string[];
  }>;
}

export function fetchStorageStatus(): Promise<StorageStatusView> {
  return request<StorageStatusView>("/recovery/storage-status");
}

export async function resetCheckpointForJob(jobId: string): Promise<void> {
  const res = await fetch(url(`/checkpoint/${encodeURIComponent(jobId)}/reset`), { method: "POST" });
  const body = (await res.json()) as ApiEnvelope<unknown>;
  if (!res.ok || !body.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
}

// ── E2 System Recovery + E3 Repair Plan (infra-level, distinct from F2-F4) ──

export type RootCauseCategory = "connectivity" | "data_loss" | "state_corruption" | "deployment_failure" | "transient" | "configuration" | "performance" | "healthy";
export type RepairPriority = "critical" | "high" | "medium" | "low" | "info";
export type RepairStatus = "auto_executed" | "pending_manual" | "not_applicable" | "skipped";

export interface RepairAction {
  id: string;
  dimension: "routes" | "assets" | "manifests" | "deployments";
  type: string;
  target: string;
  outcome: "repaired" | "failed" | "skipped" | "diagnosed";
  detail: string;
  durationMs: number;
  autoExecuted: boolean;
}

export interface SystemRecoveryReport {
  version: "1.0";
  generatedAt: string;
  durationMs: number;
  basedOnHealthReport: string | null;
  totalActionsAttempted: number;
  totalActionsSucceeded: number;
  totalActionsFailed: number;
  findings: {
    routes: { brokenCount: number; diagnosedCount: number; broken: unknown[]; repairActions: RepairAction[] };
    assets: { cloudConfigured: boolean; scannedJobs: number; missingCount: number; repairedCount: number; failedCount: number; missing: unknown[]; repairActions: RepairAction[] };
    manifests: { scannedSnapshots: number; staleRunningJobs: number; repairedStaleJobs: number; schemaAnomalies: unknown[]; staleJobs: unknown[]; repairActions: RepairAction[] };
    deployments: { totalExecutions: number; stuckCount: number; failedCount: number; rollbacksTriggered: number; stuckExecutions: unknown[]; repairActions: RepairAction[] };
  };
}

export interface RootCause {
  id: string;
  category: RootCauseCategory;
  priority: RepairPriority;
  title: string;
  description: string;
  evidence: string[];
  affectedDimension: "routes" | "assets" | "manifests" | "deployments" | "system";
}

export interface PlannedRepair {
  id: string;
  rootCauseId: string;
  priority: RepairPriority;
  title: string;
  description: string;
  autoExecutable: boolean;
  status: RepairStatus;
  executionDetail?: string;
  estimatedImpact: string;
}

export interface RepairPlan {
  version: "1.0";
  generatedAt: string;
  durationMs: number;
  basedOnHealthReport: string;
  basedOnRecoveryReport: string;
  rootCauses: RootCause[];
  repairs: PlannedRepair[];
  summary: {
    totalRootCauses: number;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    autoExecutedCount: number;
    pendingManualCount: number;
    systemStatus: "self_healed" | "partially_healed" | "action_required" | "healthy";
  };
}

export function fetchSystemRecoveryReport(): Promise<SystemRecoveryReport | null> {
  return request<SystemRecoveryReport | null>("/recovery/system-report");
}

export function fetchRepairPlan(): Promise<RepairPlan | null> {
  return request<RepairPlan | null>("/recovery/repair-plan");
}

// ── Queue State ───────────────────────────────────────────────────────────────

export interface QueueState {
  generatedAt: string;
  queued: number;
  running: number;
  failed: number;
  dead: number;
  done: number;
}

export function fetchQueueState(): Promise<QueueState> {
  return request<QueueState>("/recovery/queue-state");
}
