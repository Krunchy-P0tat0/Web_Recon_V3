import { useMemo, useState, useCallback, type ReactNode } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEventStreamStatus, useEventStreamCallback } from "@/hooks/useEventStream";
import {
  fetchClassifications,
  fetchClassifierPatterns,
  fetchRecoveryReport,
  fetchRetryHistory,
  fetchAutomaticRecoveryReport,
  fetchBatchState,
  fetchRecoveryTimeline,
  fetchCheckpointResumeReport,
  fetchResumeValidationReport,
  fetchCheckpointIntegrityReport,
  fetchAllCheckpointsFull,
  fetchStorageStatus,
  fetchSystemRecoveryReport,
  fetchRepairPlan,
  fetchQueueState,
  type FailureClassification,
  type RecoveryAction,
  type JobCheckpoint,
  type JobTimeline,
  type RootCause,
  type PlannedRepair,
  type RepairAction,
} from "@/lib/recovery-api";
import { fetchDiffSummary } from "@/lib/differential-api";

// ── Formatting helpers ───────────────────────────────────────────────────────

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "—";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

// ── Shared primitives ─────────────────────────────────────────────────────────

function SectionHeader({ title, subtitle, count }: { title: string; subtitle?: string; count?: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2 mb-2">
      <h2 className="text-sm font-bold tracking-tight">{title}</h2>
      <div className="flex items-center gap-2">
        {subtitle && <span className="text-[11px] text-muted-foreground">{subtitle}</span>}
        {count !== undefined && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">{count}</span>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</p>
      <p className={`text-lg font-bold mt-0.5 ${accent ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}

const RISK_STYLES: Record<string, string> = {
  low: "bg-accent/15 text-accent border-accent/40",
  medium: "bg-yellow-500/15 text-yellow-500 border-yellow-500/40",
  high: "bg-orange-500/15 text-orange-500 border-orange-500/40",
  critical: "bg-destructive/15 text-destructive border-destructive/40",
};

const PRIORITY_STYLES: Record<string, string> = {
  info: "bg-muted text-muted-foreground border-border",
  low: "bg-accent/15 text-accent border-accent/40",
  medium: "bg-yellow-500/15 text-yellow-500 border-yellow-500/40",
  high: "bg-orange-500/15 text-orange-500 border-orange-500/40",
  critical: "bg-destructive/15 text-destructive border-destructive/40",
};

const OUTCOME_STYLES: Record<string, string> = {
  succeeded: "bg-accent/15 text-accent border-accent/40",
  repaired: "bg-accent/15 text-accent border-accent/40",
  recovered: "bg-accent/15 text-accent border-accent/40",
  healthy: "bg-accent/15 text-accent border-accent/40",
  scheduled: "bg-primary/15 text-primary border-primary/40",
  diagnosed: "bg-primary/15 text-primary border-primary/40",
  failed: "bg-destructive/15 text-destructive border-destructive/40",
  aborted: "bg-destructive/15 text-destructive border-destructive/40",
  corrupted: "bg-destructive/15 text-destructive border-destructive/40",
  skipped: "bg-muted text-muted-foreground border-border",
};

function Badge({ text, styles }: { text: string; styles?: Record<string, string> }) {
  const cls = (styles ?? {})[text] ?? "bg-muted text-muted-foreground border-border";
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border flex-shrink-0 ${cls}`}>
      {text.replace(/_/g, " ")}
    </span>
  );
}

/** Every entry in the Recovery & Checkpoints Center must be independently
 * expandable — this is the shared row primitive that guarantees that. */
function Expandable({
  summary,
  badges,
  children,
  defaultOpen = false,
}: {
  summary: ReactNode;
  badges?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-background hover:bg-card/60 transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1 text-[11px]">
          <span className="text-muted-foreground flex-shrink-0 w-3">{open ? "▾" : "▸"}</span>
          <div className="min-w-0 flex-1 truncate">{summary}</div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">{badges}</div>
      </button>
      {open && <div className="px-3 py-3 border-t border-border bg-card/40 text-[11px] space-y-2">{children}</div>}
    </div>
  );
}

function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-0.5">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right font-medium break-all">{v}</span>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="text-xs text-muted-foreground py-6 text-center">{text}</p>;
}

// ── Failure Classification section ───────────────────────────────────────────

function FailureClassificationSection() {
  const { data: classifications = [], isLoading } = useQuery({ queryKey: ["rc-classifications"], queryFn: fetchClassifications, refetchInterval: 10000 });
  const { data: patterns = [] } = useQuery({ queryKey: ["rc-patterns"], queryFn: fetchClassifierPatterns });
  const [showPatterns, setShowPatterns] = useState(false);

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <SectionHeader title="Failure Classification" subtitle="Phase F2 — why each job failed" count={classifications.length} />
        <button
          onClick={() => setShowPatterns((s) => !s)}
          className="text-[11px] px-2 py-1 rounded-lg border border-border text-muted-foreground hover:text-foreground flex-shrink-0"
        >
          {showPatterns ? "Hide" : "Show"} pattern reference
        </button>
      </div>

      {showPatterns && (
        <div className="space-y-1.5 pb-2 border-b border-border">
          {patterns.map((p) => (
            <Expandable
              key={p.failureClass}
              summary={<span className="font-mono">{p.failureClass}</span>}
              badges={<Badge text={p.riskLevel} styles={RISK_STYLES} />}
            >
              <KV k="Confidence" v={`${p.confidence}%`} />
              <KV k="Retry recommendation" v={p.retryRecommendation.replace(/_/g, " ")} />
              <KV k="Regex patterns" v={p.patternCount} />
              <p className="pt-1 text-muted-foreground">{p.rootCause}</p>
              <p className="pt-1 text-foreground">{p.recoveryRecommendation}</p>
            </Expandable>
          ))}
        </div>
      )}

      {isLoading && <EmptyState text="Loading classifications…" />}
      {!isLoading && classifications.length === 0 && (
        <EmptyState text="No failures classified yet. This fills in automatically the first time a job fails." />
      )}
      <div className="space-y-1.5 max-h-96 overflow-y-auto">
        {classifications.map((c: FailureClassification) => (
          <Expandable
            key={`${c.jobId}-${c.classifiedAt}`}
            summary={
              <span>
                <span className="font-mono">{truncate(c.jobId, 16)}</span>
                <span className="text-muted-foreground"> · {truncate(c.seedUrl, 30)}</span>
              </span>
            }
            badges={
              <>
                <Badge text={c.riskLevel} styles={RISK_STYLES} />
                <span className="font-mono text-[10px] text-muted-foreground">{c.failureClass}</span>
              </>
            }
          >
            <KV k="Classified at" v={fmtTime(c.classifiedAt)} />
            <KV k="Confidence" v={`${c.confidence}%`} />
            <KV k="Retry recommendation" v={c.retryRecommendation.replace(/_/g, " ")} />
            <KV k="Retry count" v={`${c.retryCount} / ${c.maxRetries}`} />
            <div className="pt-1 border-t border-border/60">
              <p className="text-muted-foreground">Root cause</p>
              <p>{c.rootCause}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Recovery recommendation</p>
              <p>{c.recoveryRecommendation}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Error message</p>
              <p className="font-mono break-all">{c.errorMessage}</p>
            </div>
            {c.errorStack && (
              <div>
                <p className="text-muted-foreground">Stack</p>
                <pre className="font-mono text-[10px] whitespace-pre-wrap break-all max-h-40 overflow-y-auto">{c.errorStack}</pre>
              </div>
            )}
          </Expandable>
        ))}
      </div>
    </div>
  );
}

// ── Recovery Attempts section ────────────────────────────────────────────────

function RecoveryAttemptsSection() {
  const { data: report, isLoading } = useQuery({ queryKey: ["rc-recovery-report"], queryFn: fetchRecoveryReport, refetchInterval: 10000 });
  const { data: retryHistory } = useQuery({ queryKey: ["rc-retry-history"], queryFn: fetchRetryHistory, refetchInterval: 10000 });
  const [showHistory, setShowHistory] = useState(false);

  const actions = report?.actions ?? [];

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <SectionHeader title="Recovery Attempts" subtitle="Phase F3 — autonomous recovery actions" count={actions.length} />
        <button
          onClick={() => setShowHistory((s) => !s)}
          className="text-[11px] px-2 py-1 rounded-lg border border-border text-muted-foreground hover:text-foreground flex-shrink-0"
        >
          {showHistory ? "Hide" : "Show"} retry history
        </button>
      </div>

      {report && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          <Stat label="Triggered" value={String(report.totalActionsTriggered)} />
          <Stat label="Succeeded" value={String(report.totalSucceeded)} accent="text-accent" />
          <Stat label="Scheduled" value={String(report.totalScheduled)} accent="text-primary" />
          <Stat label="Failed" value={String(report.totalFailed)} accent="text-destructive" />
          <Stat label="Aborted" value={String(report.totalAborted)} accent="text-destructive" />
        </div>
      )}

      {showHistory && (
        <div className="space-y-1.5 pb-2 border-b border-border max-h-64 overflow-y-auto">
          {(retryHistory?.entries ?? []).length === 0 && <EmptyState text="No retry history entries yet." />}
          {retryHistory?.entries.map((e) => (
            <Expandable
              key={e.entryId}
              summary={<span className="font-mono">{truncate(e.jobId, 16)} · {e.actionType}</span>}
              badges={<Badge text={e.outcome} styles={OUTCOME_STYLES} />}
            >
              <KV k="Attempted at" v={fmtTime(e.attemptedAt)} />
              <KV k="Failure class" v={e.failureClass} />
              <KV k="Retry count" v={e.retryCount} />
              <p className="pt-1 text-muted-foreground">{e.notes}</p>
            </Expandable>
          ))}
        </div>
      )}

      {isLoading && <EmptyState text="Loading recovery attempts…" />}
      {!isLoading && actions.length === 0 && <EmptyState text="No recovery actions have run yet." />}
      <div className="space-y-1.5 max-h-96 overflow-y-auto">
        {actions.map((a: RecoveryAction) => (
          <Expandable
            key={a.actionId}
            summary={<span className="font-mono">{truncate(a.jobId, 16)}</span>}
            badges={
              <>
                <Badge text={a.outcome} styles={OUTCOME_STYLES} />
                <span className="font-mono text-[10px] text-muted-foreground">{a.actionType}</span>
              </>
            }
          >
            <KV k="Seed URL" v={truncate(a.seedUrl, 40)} />
            <KV k="Triggered at" v={fmtTime(a.triggeredAt)} />
            <KV k="Completed at" v={fmtTime(a.completedAt)} />
            <KV k="Failure class" v={a.failureClass} />
            <KV k="Retry count" v={`${a.retryCount} / ${a.maxRetries}`} />
            {a.delayMs !== null && <KV k="Delay" v={formatMs(a.delayMs)} />}
            {a.originalBatchSize !== null && (
              <>
                <KV k="Original batch size" v={a.originalBatchSize} />
                <KV k="New batch size" v={a.newBatchSize} />
                <KV k="Child jobs" v={a.childJobIds.join(", ") || "—"} />
              </>
            )}
            <p className="pt-1 text-muted-foreground">{a.actionReason}</p>
            {a.outcomeDetail && <p>{a.outcomeDetail}</p>}
          </Expandable>
        ))}
      </div>
    </div>
  );
}

// ── Recovery Timeline section ────────────────────────────────────────────────

const EVENT_LABEL: Record<string, string> = {
  classified: "Classified",
  recovery_triggered: "Recovery triggered",
  recovery_completed: "Recovery completed",
};

function RecoveryTimelineSection() {
  const { data, isLoading } = useQuery({ queryKey: ["rc-timeline"], queryFn: fetchRecoveryTimeline, refetchInterval: 10000 });
  const timelines = data?.timelines ?? [];

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <SectionHeader title="Recovery Timeline" subtitle="Classification → recovery → outcome, per job" count={timelines.length} />
      {isLoading && <EmptyState text="Loading timeline…" />}
      {!isLoading && timelines.length === 0 && <EmptyState text="No classified or recovered jobs yet." />}
      <div className="space-y-1.5 max-h-[32rem] overflow-y-auto">
        {timelines.map((t: JobTimeline) => (
          <Expandable
            key={t.jobId}
            summary={<span className="font-mono">{truncate(t.jobId, 16)} · {truncate(t.seedUrl, 26)}</span>}
            badges={
              <>
                {t.failureClass && <span className="font-mono text-[10px] text-muted-foreground">{t.failureClass}</span>}
                <Badge text={t.currentStatus} styles={OUTCOME_STYLES} />
              </>
            }
          >
            <ol className="space-y-2">
              {t.events.map((e, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-muted-foreground flex-shrink-0 w-16 font-mono text-[10px]">{new Date(e.at).toLocaleTimeString()}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{EVENT_LABEL[e.type] ?? e.type}</p>
                    <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap break-all">{JSON.stringify(e.detail, null, 1)}</pre>
                  </div>
                </li>
              ))}
            </ol>
          </Expandable>
        ))}
      </div>
    </div>
  );
}

// ── Batch State section ───────────────────────────────────────────────────────

function BatchStateSection() {
  const { data, isLoading } = useQuery({ queryKey: ["rc-batch-state"], queryFn: fetchBatchState, refetchInterval: 10000 });
  const splits = data?.splits ?? [];

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <SectionHeader title="Batch State" subtitle="Jobs split into child batches under memory/failure pressure" count={splits.length} />
      {data && (
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Batch splits" value={String(data.totalBatchSplits)} />
          <Stat label="Child jobs spawned" value={String(data.totalChildJobsSpawned)} accent="text-primary" />
        </div>
      )}
      {isLoading && <EmptyState text="Loading batch state…" />}
      {!isLoading && splits.length === 0 && <EmptyState text="No batch splits have occurred." />}
      <div className="space-y-1.5">
        {splits.map((s, i) => (
          <Expandable
            key={`${s.jobId}-${i}`}
            summary={<span className="font-mono">{truncate(s.jobId, 16)}</span>}
            badges={<Badge text={s.outcome} styles={OUTCOME_STYLES} />}
          >
            <KV k="Seed URL" v={truncate(s.seedUrl, 40)} />
            <KV k="Triggered at" v={fmtTime(s.triggeredAt)} />
            <KV k="Original batch size" v={s.originalBatchSize ?? "—"} />
            <KV k="New batch size" v={s.newBatchSize ?? "—"} />
            <KV k="Child job IDs" v={s.childJobIds.join(", ") || "—"} />
            {s.outcomeDetail && <p className="pt-1 text-muted-foreground">{s.outcomeDetail}</p>}
          </Expandable>
        ))}
      </div>
    </div>
  );
}

// ── Checkpoint Reports + Checkpoints list ────────────────────────────────────

function CheckpointReportsSection() {
  const { data: resume } = useQuery({ queryKey: ["rc-cp-resume"], queryFn: fetchCheckpointResumeReport, refetchInterval: 10000 });
  const { data: validation } = useQuery({ queryKey: ["rc-cp-validation"], queryFn: fetchResumeValidationReport, refetchInterval: 10000 });
  const { data: integrity } = useQuery({ queryKey: ["rc-cp-integrity"], queryFn: fetchCheckpointIntegrityReport, refetchInterval: 10000 });

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <SectionHeader title="Checkpoint Reports" subtitle="Phase F4 — resume, validation & integrity" />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Active checkpoints" value={String(resume?.totalCheckpoints ?? 0)} />
        <Stat label="Resume events" value={String(resume?.totalResumed ?? 0)} />
        <Stat label="Valid" value={String(validation?.totalValid ?? 0)} accent="text-accent" />
        <Stat label="Healthy" value={String(integrity?.totalHealthy ?? 0)} accent="text-accent" />
      </div>

      <div>
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">Resume events</p>
        {(resume?.resumes.length ?? 0) === 0 && <EmptyState text="No resumes recorded yet." />}
        <div className="space-y-1.5 max-h-56 overflow-y-auto">
          {resume?.resumes.map((r, i) => (
            <Expandable
              key={`${r.jobId}-${i}`}
              summary={<span className="font-mono">{truncate(r.jobId, 16)} · {truncate(r.seedUrl, 24)}</span>}
              badges={<span className="text-[10px] font-bold">{r.coverageAtResume}% coverage</span>}
            >
              <KV k="Resumed at" v={fmtTime(r.resumedAt)} />
              <KV k="Checkpoint version" v={r.checkpointVersion} />
              <KV k="URLs skipped" v={r.urlsSkipped} />
              <KV k="URLs remaining" v={r.urlsRemaining} />
            </Expandable>
          ))}
        </div>
      </div>

      <div>
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">Validation</p>
        {(validation?.validations.length ?? 0) === 0 && <EmptyState text="No checkpoints to validate." />}
        <div className="space-y-1.5 max-h-56 overflow-y-auto">
          {validation?.validations.map((v) => (
            <Expandable
              key={v.jobId}
              summary={<span className="font-mono">{truncate(v.jobId, 16)}</span>}
              badges={<Badge text={v.valid ? "healthy" : "corrupted"} styles={OUTCOME_STYLES} />}
            >
              <KV k="Reason" v={v.reason} />
              <KV k="Checkpoint version" v={v.checkpointVersion ?? "—"} />
              <KV k="Checkpointed at" v={fmtTime(v.checkpointedAt)} />
              <KV k="Checksum match" v={v.checksumMatch === null ? "—" : v.checksumMatch ? "yes" : "no"} />
            </Expandable>
          ))}
        </div>
      </div>

      <div>
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">Integrity checks</p>
        {(integrity?.integrityChecks.length ?? 0) === 0 && <EmptyState text="No integrity checks recorded." />}
        <div className="space-y-1.5 max-h-56 overflow-y-auto">
          {integrity?.integrityChecks.map((c) => (
            <Expandable
              key={c.jobId}
              summary={<span className="font-mono">{truncate(c.jobId, 16)}</span>}
              badges={<Badge text={c.status} styles={OUTCOME_STYLES} />}
            >
              <KV k="Checkpoint version" v={c.checkpointVersion ?? "—"} />
              <KV k="Checkpointed at" v={fmtTime(c.checkpointedAt)} />
              <KV k="URLs checkpointed" v={c.urlsCheckpointed ?? "—"} />
              <KV k="Checksum valid" v={c.checksumValid === null ? "—" : c.checksumValid ? "yes" : "no"} />
              <p className="pt-1 text-muted-foreground">{c.detail}</p>
            </Expandable>
          ))}
        </div>
      </div>
    </div>
  );
}

function CheckpointStateSection() {
  const { data, isLoading } = useQuery({ queryKey: ["rc-checkpoints-full"], queryFn: fetchAllCheckpointsFull, refetchInterval: 10000 });
  const checkpoints = data?.checkpoints ?? [];

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <SectionHeader title="Checkpoints — full state" subtitle="Every sub-state the engine tracks per job" count={checkpoints.length} />
      {isLoading && <EmptyState text="Loading checkpoints…" />}
      {!isLoading && checkpoints.length === 0 && <EmptyState text="No active checkpoints. Checkpoints appear here while a job is running." />}
      <div className="space-y-1.5 max-h-[36rem] overflow-y-auto">
        {checkpoints.map((cp: JobCheckpoint) => (
          <Expandable
            key={cp.jobId}
            summary={<span className="font-mono">{truncate(cp.jobId, 16)} · {truncate(cp.seedUrl, 26)}</span>}
            badges={
              <>
                <Badge text={cp.isValid ? "healthy" : "corrupted"} styles={OUTCOME_STYLES} />
                <span className="text-[10px] font-bold">{cp.coverageState.coveragePercent}%</span>
              </>
            }
          >
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-muted-foreground font-semibold mb-1">Queue state</p>
                <KV k="Version" v={cp.checkpointVersion} />
                <KV k="Checkpointed at" v={fmtTime(cp.checkpointedAt)} />
                <KV k="All articles" v={cp.allArticles.length} />
                <KV k="Completed" v={cp.completedUrls.length} />
                <KV k="Visited" v={cp.visitedUrls.length} />
                <KV k="Failed" v={cp.failedUrls.length} />
                <KV k="Pending" v={cp.pendingUrls.length} />
                <KV k="Checksum" v={<span className="font-mono">{cp.checksum}</span>} />
              </div>
              <div>
                <p className="text-muted-foreground font-semibold mb-1">Coverage</p>
                <KV k="Total" v={cp.coverageState.total} />
                <KV k="Completed" v={cp.coverageState.completed} />
                <KV k="Failed" v={cp.coverageState.failed} />
                <KV k="Skipped" v={cp.coverageState.skipped} />
                <KV k="Coverage %" v={`${cp.coverageState.coveragePercent}%`} />
              </div>
              <div>
                <p className="text-muted-foreground font-semibold mb-1">Manifest state</p>
                <KV k="Has manifest" v={cp.manifestState.hasManifest ? "yes" : "no"} />
                <KV k="Manifest key" v={cp.manifestState.manifestKey ?? "—"} />
                <KV k="Node count" v={cp.manifestState.nodeCount} />
                <KV k="Last saved" v={fmtTime(cp.manifestState.lastSavedAt)} />
              </div>
              <div>
                <p className="text-muted-foreground font-semibold mb-1">Differential state</p>
                <KV k="Diff mode" v={cp.differentialState.diffMode ? "yes" : "no"} />
                <KV k="Base job" v={truncate(cp.differentialState.baseJobId, 16)} />
                <KV k="Bytes saved" v={formatBytes(cp.differentialState.savedBytes)} />
                <KV k="Pages skipped" v={cp.differentialState.pagesSkipped} />
              </div>
            </div>
            <div className="pt-1 border-t border-border/60">
              <p className="text-muted-foreground font-semibold mb-1">Storage state</p>
              <KV k="Uploaded keys" v={cp.storageState.uploadedKeys.length} />
              <KV k="Bytes uploaded" v={formatBytes(cp.storageState.totalBytesUploaded)} />
              <KV k="Last uploaded" v={fmtTime(cp.storageState.lastUploadedAt)} />
              <KV k="Pending keys" v={cp.storageState.pendingKeys.length} />
            </div>
          </Expandable>
        ))}
      </div>
    </div>
  );
}

// ── Storage Upload Status section ────────────────────────────────────────────

function StorageStatusSection() {
  const { data, isLoading } = useQuery({ queryKey: ["rc-storage-status"], queryFn: fetchStorageStatus, refetchInterval: 10000 });
  const jobs = data?.jobs ?? [];

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <SectionHeader title="Storage Upload Status" subtitle="R2 upload progress per active checkpoint" count={jobs.length} />
      {data && (
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Total uploaded" value={formatBytes(data.totalBytesUploaded)} />
          <Stat label="Pending uploads" value={String(data.totalPendingUploads)} accent={data.totalPendingUploads > 0 ? "text-orange-500" : undefined} />
        </div>
      )}
      {isLoading && <EmptyState text="Loading storage status…" />}
      {!isLoading && jobs.length === 0 && <EmptyState text="No active checkpoints to report on." />}
      <div className="space-y-1.5 max-h-72 overflow-y-auto">
        {jobs.map((j) => (
          <Expandable
            key={j.jobId}
            summary={<span className="font-mono">{truncate(j.jobId, 16)} · {truncate(j.seedUrl, 26)}</span>}
            badges={<span className="text-[10px] font-bold">{formatBytes(j.totalBytesUploaded)}</span>}
          >
            <KV k="Uploaded keys" v={j.uploadedCount} />
            <KV k="Pending keys" v={j.pendingCount} />
            <KV k="Last uploaded" v={fmtTime(j.lastUploadedAt)} />
            {j.uploadedKeys.length > 0 && (
              <div>
                <p className="text-muted-foreground pt-1">Uploaded</p>
                <p className="font-mono text-[10px] break-all">{j.uploadedKeys.join(", ")}</p>
              </div>
            )}
            {j.pendingKeys.length > 0 && (
              <div>
                <p className="text-muted-foreground pt-1">Pending</p>
                <p className="font-mono text-[10px] break-all">{j.pendingKeys.join(", ")}</p>
              </div>
            )}
          </Expandable>
        ))}
      </div>
    </div>
  );
}

// ── Recovery Plan Inspector (E2 system report + E3 repair plan) ─────────────

function RepairActionRow({ a }: { a: RepairAction }) {
  return (
    <Expandable
      summary={<span className="font-mono">{a.dimension} · {a.type}</span>}
      badges={<Badge text={a.outcome} styles={OUTCOME_STYLES} />}
    >
      <KV k="Target" v={a.target} />
      <KV k="Auto-executed" v={a.autoExecuted ? "yes" : "no"} />
      <KV k="Duration" v={formatMs(a.durationMs)} />
      <p className="pt-1 text-muted-foreground">{a.detail}</p>
    </Expandable>
  );
}

function RecoveryPlanInspectorSection() {
  const { data: systemReport, isLoading: sLoading } = useQuery({ queryKey: ["rc-system-report"], queryFn: fetchSystemRecoveryReport, refetchInterval: 15000 });
  const { data: plan, isLoading: pLoading } = useQuery({ queryKey: ["rc-repair-plan"], queryFn: fetchRepairPlan, refetchInterval: 15000 });

  const notYetRun = !sLoading && !pLoading && !systemReport && !plan;

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-4">
      <SectionHeader title="Recovery Plan Inspector" subtitle="Phase E2/E3 — system-level (routes/assets/manifests/deployments), not job-level" />

      {notYetRun && (
        <EmptyState text="System recovery hasn't run yet — it runs automatically after each monitoring cycle. Nothing to inspect until then." />
      )}

      {plan && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="System status" value={plan.summary.systemStatus.replace(/_/g, " ")} accent={plan.summary.systemStatus === "healthy" || plan.summary.systemStatus === "self_healed" ? "text-accent" : "text-orange-500"} />
            <Stat label="Root causes" value={String(plan.summary.totalRootCauses)} />
            <Stat label="Auto-executed" value={String(plan.summary.autoExecutedCount)} accent="text-accent" />
            <Stat label="Pending manual" value={String(plan.summary.pendingManualCount)} accent={plan.summary.pendingManualCount > 0 ? "text-orange-500" : undefined} />
          </div>

          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">Root causes</p>
            {plan.rootCauses.length === 0 && <EmptyState text="No root causes identified — system is healthy." />}
            <div className="space-y-1.5">
              {plan.rootCauses.map((rc: RootCause) => (
                <Expandable
                  key={rc.id}
                  summary={<span>{rc.title}</span>}
                  badges={<Badge text={rc.priority} styles={PRIORITY_STYLES} />}
                >
                  <KV k="Category" v={rc.category.replace(/_/g, " ")} />
                  <KV k="Affected" v={rc.affectedDimension} />
                  <p className="pt-1">{rc.description}</p>
                  {rc.evidence.length > 0 && (
                    <div>
                      <p className="text-muted-foreground pt-1">Evidence</p>
                      <ul className="list-disc list-inside space-y-0.5">
                        {rc.evidence.map((e, i) => <li key={i} className="break-all">{e}</li>)}
                      </ul>
                    </div>
                  )}
                </Expandable>
              ))}
            </div>
          </div>

          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">Planned repairs</p>
            {plan.repairs.length === 0 && <EmptyState text="No repairs planned." />}
            <div className="space-y-1.5">
              {plan.repairs.map((r: PlannedRepair) => (
                <Expandable
                  key={r.id}
                  summary={<span>{r.title}</span>}
                  badges={
                    <>
                      <Badge text={r.status} styles={OUTCOME_STYLES} />
                      <Badge text={r.priority} styles={PRIORITY_STYLES} />
                    </>
                  }
                >
                  <KV k="Auto-executable" v={r.autoExecutable ? "yes" : "no"} />
                  <p className="pt-1">{r.description}</p>
                  {r.executionDetail && <p className="text-accent">{r.executionDetail}</p>}
                  <p className="text-muted-foreground pt-1">Estimated impact: {r.estimatedImpact}</p>
                </Expandable>
              ))}
            </div>
          </div>
        </>
      )}

      {systemReport && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">System recovery findings (E2)</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
            <Stat label="Attempted" value={String(systemReport.totalActionsAttempted)} />
            <Stat label="Succeeded" value={String(systemReport.totalActionsSucceeded)} accent="text-accent" />
            <Stat label="Failed" value={String(systemReport.totalActionsFailed)} accent="text-destructive" />
            <Stat label="Duration" value={formatMs(systemReport.durationMs)} />
          </div>
          <div className="space-y-1.5">
            {[...systemReport.findings.routes.repairActions, ...systemReport.findings.assets.repairActions, ...systemReport.findings.manifests.repairActions, ...systemReport.findings.deployments.repairActions].map((a, i) => (
              <RepairActionRow key={`${a.id}-${i}`} a={a} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Queue State + Diff State (compact side-by-side) ──────────────────────────

function QueueAndDiffStateSection() {
  const { data: queue } = useQuery({ queryKey: ["rc-queue-state"], queryFn: fetchQueueState, refetchInterval: 5000 });
  const { data: diffSummary } = useQuery({ queryKey: ["rc-diff-summary"], queryFn: fetchDiffSummary, refetchInterval: 10000 });

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <SectionHeader title="Queue State" subtitle="Live scrape_jobs breakdown" />
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
          <Stat label="Queued" value={String(queue?.queued ?? 0)} />
          <Stat label="Running" value={String(queue?.running ?? 0)} accent="text-primary" />
          <Stat label="Failed" value={String(queue?.failed ?? 0)} accent="text-destructive" />
          <Stat label="Dead" value={String(queue?.dead ?? 0)} accent="text-destructive" />
          <Stat label="Done" value={String(queue?.done ?? 0)} accent="text-accent" />
        </div>
      </div>
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-baseline justify-between">
          <SectionHeader title="Diff State" subtitle="See Differential Center for detail" />
          <Link href="/differential" className="text-[11px] text-primary hover:text-primary/80 font-semibold flex-shrink-0">Open →</Link>
        </div>
        {diffSummary ? (
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Diff runs" value={String(diffSummary.totalDiffRuns)} />
            <Stat label="Avg skip rate" value={`${diffSummary.averageSkipRatePercent}%`} />
          </div>
        ) : (
          <EmptyState text="No differential runs recorded yet." />
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function RecoveryCenter() {
  const { connected } = useEventStreamStatus();
  const qc = useQueryClient();

  // SSE: refresh recovery data on recovery + pipeline lifecycle events (SSE fix)
  useEventStreamCallback(
    { subsystem: "recovery" },
    useCallback(() => {
      void qc.invalidateQueries({ queryKey: ["rc-recovery-report"] });
      void qc.invalidateQueries({ queryKey: ["rc-retry-history"] });
      void qc.invalidateQueries({ queryKey: ["rc-timeline"] });
      void qc.invalidateQueries({ queryKey: ["rc-repair-plan"] });
    }, [qc]),
  );
  useEventStreamCallback(
    { subsystem: "checkpoints" },
    useCallback(() => {
      void qc.invalidateQueries({ queryKey: ["rc-cp-resume"] });
      void qc.invalidateQueries({ queryKey: ["rc-cp-validation"] });
      void qc.invalidateQueries({ queryKey: ["rc-cp-integrity"] });
      void qc.invalidateQueries({ queryKey: ["rc-checkpoints-full"] });
    }, [qc]),
  );
  useEventStreamCallback(
    { subsystem: "pipeline", event: ["job-complete", "job-failed", "rollback-complete"] },
    useCallback(() => {
      void qc.invalidateQueries({ queryKey: ["rc-system-report"] });
      void qc.invalidateQueries({ queryKey: ["rc-queue-state"] });
    }, [qc]),
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 bg-background/90 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-3">
        <div className={`w-2 h-2 rounded-full flex-shrink-0 animate-pulse-dot ${connected ? "bg-accent" : "bg-muted-foreground"}`} />
        <h1 className="text-base font-bold tracking-tight">Recovery &amp; Checkpoints Center</h1>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <Link href="/differential" className="text-muted-foreground hover:text-foreground">Differential</Link>
          <Link href="/manifest" className="text-muted-foreground hover:text-foreground">Manifest</Link>
          <Link href="/jobs" className="text-muted-foreground hover:text-foreground">Job Control</Link>
          <Link href="/" className="text-muted-foreground hover:text-foreground">← Pipeline</Link>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 py-4 space-y-4">
        <QueueAndDiffStateSection />
        <RecoveryPlanInspectorSection />
        <FailureClassificationSection />
        <RecoveryAttemptsSection />
        <RecoveryTimelineSection />
        <BatchStateSection />
        <CheckpointReportsSection />
        <CheckpointStateSection />
        <StorageStatusSection />
      </div>
    </div>
  );
}
