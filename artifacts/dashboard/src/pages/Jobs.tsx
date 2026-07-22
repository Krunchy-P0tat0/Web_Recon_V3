import { useCallback, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchJobSets,
  fetchJobLogs,
  fetchSystemResources,
  pauseJobApi,
  resumeJobApi,
  retryJobApi,
  cancelJobApi,
  cloneJobApi,
  runDiffApi,
  generateWebsitePrimeApi,
  triggerRecoveryApi,
  manifestDownloadUrl,
  flattenJobSets,
  jobMatchesCategory,
  estimateEtaMs,
  type JobDetail,
  type JobCategory,
  type ControlResult,
} from "@/lib/jobs-api";
import { useEventStreamCallback, useEventStreamStatus } from "@/hooks/useEventStream";

// ── Formatting helpers ───────────────────────────────────────────────────────

function formatMs(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "—";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function runtimeMs(job: JobDetail): number | null {
  if (job.resourceUsage.uptimeMs != null) return job.resourceUsage.uptimeMs;
  const start = job.claimedAt ?? job.createdAt;
  if (!start) return null;
  const end = job.completedAt ? new Date(job.completedAt).getTime() : Date.now();
  return end - new Date(start).getTime();
}

const CATEGORIES: { id: JobCategory; label: string }[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "queued", label: "Queued" },
  { id: "completed", label: "Completed" },
  { id: "failed", label: "Failed" },
  { id: "paused", label: "Paused" },
  { id: "recovered", label: "Recovered" },
  { id: "retry", label: "Retry" },
  { id: "diff", label: "Diff" },
];

const STATUS_STYLES: Record<string, string> = {
  running: "bg-primary/15 text-primary border-primary/40",
  queued: "bg-primary/10 text-primary/70 border-primary/20",
  done: "bg-accent/15 text-accent border-accent/40",
  paused: "bg-yellow-500/15 text-yellow-500 border-yellow-500/40",
  failed: "bg-destructive/15 text-destructive border-destructive/40",
  dead_letter: "bg-destructive/20 text-destructive border-destructive/50",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${STATUS_STYLES[status] ?? "bg-muted text-muted-foreground border-border"}`}>
      {status.replace("_", " ")}
    </span>
  );
}

// ── Action button ─────────────────────────────────────────────────────────────

function ActionButton({
  label, onClick, disabled, variant = "default",
}: { label: string; onClick: () => void; disabled?: boolean; variant?: "default" | "danger" }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        variant === "danger"
          ? "border-destructive/40 text-destructive hover:bg-destructive/10"
          : "border-border text-foreground hover:bg-card"
      }`}
    >
      {label}
    </button>
  );
}

// ── Logs drawer ───────────────────────────────────────────────────────────────

function LogsPanel({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const { data: logs, isLoading } = useQuery({
    queryKey: ["job-logs", jobId],
    queryFn: () => fetchJobLogs(jobId),
    refetchInterval: 4000,
  });

  return (
    <div className="fixed inset-0 z-30 bg-background/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-6" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full sm:max-w-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-sm font-semibold">Logs — {truncate(jobId, 24)}</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm">✕</button>
        </div>
        <div className="overflow-y-auto flex-1 p-3 space-y-1.5 font-mono text-[11px]">
          {isLoading && <p className="text-muted-foreground">Loading…</p>}
          {!isLoading && (!logs || logs.length === 0) && (
            <p className="text-muted-foreground">No buffered events for this job yet. Events appear here as the pipeline emits them.</p>
          )}
          {logs?.map((e) => (
            <div key={e.id} className="flex gap-2 items-start">
              <span className="text-muted-foreground flex-shrink-0">{new Date(e.timestamp).toLocaleTimeString()}</span>
              <span
                className={`flex-shrink-0 uppercase font-bold ${
                  e.severity === "critical" || e.severity === "error"
                    ? "text-destructive"
                    : e.severity === "warn"
                    ? "text-yellow-500"
                    : "text-primary"
                }`}
              >
                {e.subsystem}
              </span>
              <span className="break-all">{e.event}{Object.keys(e.payload ?? {}).length > 0 ? ` — ${JSON.stringify(e.payload)}` : ""}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Job card ──────────────────────────────────────────────────────────────────

function JobCard({ job, onAction, onViewLogs, loadingJobId }: {
  job: JobDetail;
  onAction: (jobId: string, action: () => Promise<ControlResult | { jobId: string }>, label: string) => void;
  onViewLogs: (jobId: string) => void;
  loadingJobId?: string | null;
}) {
  const eta = estimateEtaMs(job);
  const runtime = runtimeMs(job);
  const isTerminal = job.status === "done" || job.status === "dead_letter";
  const isActing = loadingJobId === job.jobId;

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={`/jobs/${encodeURIComponent(job.jobId)}`}
            className="text-sm font-semibold break-all text-foreground hover:text-primary transition-colors"
          >
            {job.seedUrl}
          </Link>
          <p className="text-[11px] text-muted-foreground font-mono mt-0.5">{job.jobId}</p>
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <StatusBadge status={job.status} />
          {job.diffMode && (
            <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase border border-purple-400/40 text-purple-400 bg-purple-400/10">Diff</span>
          )}
        </div>
      </div>

      {/* Progress + coverage bars */}
      <div className="space-y-2">
        <div>
          <div className="flex justify-between text-[11px] text-muted-foreground mb-1">
            <span>Progress</span>
            <span>{job.completedArticles}/{job.totalArticles} — {job.progressPercent}%</span>
          </div>
          <div className="h-1.5 bg-border rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${job.progressPercent}%` }} />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-[11px] text-muted-foreground mb-1">
            <span>Coverage</span>
            <span>{job.coveragePercent}%</span>
          </div>
          <div className="h-1.5 bg-border rounded-full overflow-hidden">
            <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${job.coveragePercent}%` }} />
          </div>
        </div>
        {job.currentArticle && job.status === "running" && (
          <p className="text-[11px] text-muted-foreground truncate">Current stage: {truncate(job.currentArticle, 60)}</p>
        )}
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1.5 text-[11px]">
        <Metric label="Workers" value={job.resourceUsage.workerId ?? "—"} />
        <Metric label="Runtime" value={formatMs(runtime)} />
        <Metric label="ETA" value={isTerminal ? "—" : eta != null ? formatMs(eta) : "—"} />
        <Metric label="Retries" value={`${job.retryCount}/${job.maxRetries}`} />
        <Metric label="Checkpoint" value={job.checkpoint ? `v${job.checkpoint.checkpointVersion} · ${job.checkpoint.coveragePercent}%` : "None"} />
        <Metric label="Downloads" value={job.downloadUrl ? "Ready" : "—"} />
        <Metric label="Data processed" value={formatBytes(job.resourceUsage.estimatedBytesProcessed)} />
        <Metric label="Throughput" value={job.resourceUsage.articlesPerMinute ? `${job.resourceUsage.articlesPerMinute.toFixed(1)}/min` : "—"} />
        <Metric label="Health" value={job.healthStatus ?? "—"} />
      </div>

      {job.errorMessage && (
        <div className="bg-destructive/10 border border-destructive/40 rounded-lg px-3 py-2 text-[11px] text-destructive break-words">
          ⚠️ {job.errorMessage}
        </div>
      )}

      {/* Actions */}
      {isActing && (
        <div className="flex items-center gap-2 text-[11px] text-primary animate-pulse">
          <span className="w-1.5 h-1.5 rounded-full bg-primary inline-block" />
          Working…
        </div>
      )}
      <div className="flex flex-wrap gap-1.5 pt-1">
        {job.status === "running" && (
          <ActionButton label="Pause" disabled={isActing} onClick={() => onAction(job.jobId, () => pauseJobApi(job.jobId), "Pause")} />
        )}
        {job.status === "paused" && (
          <ActionButton label="Resume" disabled={isActing} onClick={() => onAction(job.jobId, () => resumeJobApi(job.jobId), "Resume")} />
        )}
        {(job.status === "failed" || job.status === "dead_letter" || job.status === "paused") && (
          <ActionButton label="Retry" disabled={isActing} onClick={() => onAction(job.jobId, () => retryJobApi(job.jobId), "Retry")} />
        )}
        {(job.status === "failed" || job.status === "dead_letter") && (
          <ActionButton label="🔁 Trigger Recovery" disabled={isActing} onClick={() => onAction(job.jobId, () => triggerRecoveryApi(job.jobId), "Trigger Recovery")} />
        )}
        <ActionButton label="Clone" disabled={isActing} onClick={() => onAction(job.jobId, () => cloneJobApi(job.jobId), "Clone")} />
        {!isTerminal && (
          <ActionButton
            label="Cancel"
            variant="danger"
            disabled={isActing}
            onClick={() => onAction(job.jobId, () => cancelJobApi(job.jobId), "Cancel")}
          />
        )}
        {job.status === "done" && (
          <>
            <ActionButton label="Run Diff" disabled={isActing} onClick={() => onAction(job.jobId, () => runDiffApi(job.jobId), "Run Diff")} />
            <ActionButton
              label="⚡ Generate Website Prime"
              disabled={isActing}
              onClick={() => onAction(job.jobId, () => generateWebsitePrimeApi(job.jobId), "Generate Website Prime")}
            />
          </>
        )}
        <ActionButton label="View Logs" onClick={() => onViewLogs(job.jobId)} />
        <a
          href={manifestDownloadUrl(job.jobId)}
          download
          className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-border text-foreground hover:bg-background transition-colors"
        >
          Export Manifest
        </a>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium truncate">{value}</span>
    </div>
  );
}

// ── System resources strip ───────────────────────────────────────────────────

function SystemResourcesStrip() {
  const { data } = useQuery({
    queryKey: ["system-resources"],
    queryFn: fetchSystemResources,
    refetchInterval: 5000,
  });
  if (!data) return null;

  const memPct = Math.round((data.memory.rssBytes / data.memory.systemTotalBytes) * 100);

  return (
    <div className="bg-card border border-border rounded-xl px-4 py-2.5 flex flex-wrap items-center gap-x-6 gap-y-1 text-[11px] text-muted-foreground">
      <span className="font-semibold text-foreground uppercase tracking-wide text-[10px]">Server resources</span>
      <span>Memory: <span className="text-foreground font-medium">{formatBytes(data.memory.rssBytes)}</span> ({memPct}% of host)</span>
      <span>CPU load (1m): <span className="text-foreground font-medium">{data.cpu.loadAvg1m.toFixed(2)}</span> / {data.cpu.cpuCount} cores</span>
      <span className="italic">{data.scope}</span>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Jobs() {
  const qc = useQueryClient();
  const { connected } = useEventStreamStatus();
  const [category, setCategory] = useState<JobCategory>("all");
  const [logsJobId, setLogsJobId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const [loadingJobId, setLoadingJobId] = useState<string | null>(null);

  const { data: jobSets = [], isLoading } = useQuery({
    queryKey: ["job-sets"],
    queryFn: fetchJobSets,
    refetchInterval: 6000,
  });

  const allJobs = useMemo(() => flattenJobSets(jobSets), [jobSets]);

  const counts = useMemo(() => {
    const c: Record<JobCategory, number> = {
      all: allJobs.length, running: 0, queued: 0, completed: 0, failed: 0, paused: 0, recovered: 0, retry: 0, diff: 0,
    };
    for (const cat of CATEGORIES) {
      if (cat.id === "all") continue;
      c[cat.id] = allJobs.filter((j) => jobMatchesCategory(j, cat.id)).length;
    }
    return c;
  }, [allJobs]);

  const filtered = useMemo(
    () => allJobs.filter((j) => jobMatchesCategory(j, category)).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [allJobs, category],
  );

  // Typed SSE routing — refresh job list only on lifecycle transitions (SSE fix)
  useEventStreamCallback(
    { subsystem: "pipeline" },
    useCallback((evt) => {
      if (["job-started", "job-complete", "job-failed", "job-cancelled", "stage-retrying"].includes(evt.event)) {
        void qc.invalidateQueries({ queryKey: ["job-sets"] });
      }
    }, [qc]),
  );

  const handleAction = useCallback(
    async (jobId: string, action: () => Promise<ControlResult | { jobId: string }>, label: string) => {
      setLoadingJobId(jobId);
      try {
        const result = await action();
        const success = "success" in result ? result.success : true;
        const detail =
          "detail" in result && (result as { detail?: string }).detail
            ? (result as { detail: string }).detail
            : "jobId" in result
            ? `New job ${(result as { jobId: string }).jobId.slice(0, 8)} started`
            : "";
        setToast({ text: `${label}: ${success ? (detail || "done") : (detail || "failed")}`, ok: success });
        void qc.invalidateQueries({ queryKey: ["job-sets"] });
      } catch (err) {
        setToast({ text: `${label} failed: ${err instanceof Error ? err.message : String(err)}`, ok: false });
      } finally {
        setLoadingJobId(null);
        setTimeout(() => setToast(null), 6000);
      }
    },
    [qc],
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 bg-background/90 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-3">
        <div className={`w-2 h-2 rounded-full flex-shrink-0 animate-pulse-dot ${connected ? "bg-accent" : "bg-muted-foreground"}`} />
        <h1 className="text-base font-bold tracking-tight">Job Control Center</h1>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <Link href="/differential" className="text-muted-foreground hover:text-foreground">Differential</Link>
          <Link href="/manifest" className="text-muted-foreground hover:text-foreground">Manifest</Link>
          <Link href="/recovery" className="text-muted-foreground hover:text-foreground">Recovery</Link>
          <Link href="/" className="text-muted-foreground hover:text-foreground">← Pipeline</Link>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-4 space-y-4">
        <SystemResourcesStrip />

        {/* Category tabs */}
        <div className="flex flex-wrap gap-1.5">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => setCategory(c.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                category === c.id
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card text-muted-foreground border-border hover:text-foreground"
              }`}
            >
              {c.label} <span className="opacity-70">{counts[c.id]}</span>
            </button>
          ))}
        </div>

        {isLoading && <p className="text-sm text-muted-foreground text-center py-10">Loading jobs…</p>}

        {!isLoading && filtered.length === 0 && (
          <div className="text-center py-16 text-muted-foreground text-sm space-y-2">
            <div className="text-4xl">📭</div>
            <p>No jobs in this category.</p>
          </div>
        )}

        <div className="space-y-3">
          {filtered.map((job) => (
            <JobCard key={job.jobId} job={job} onAction={handleAction} onViewLogs={setLogsJobId} loadingJobId={loadingJobId} />
          ))}
        </div>
      </div>

      {logsJobId && <LogsPanel jobId={logsJobId} onClose={() => setLogsJobId(null)} />}

      {toast && (
        <div
          className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-40 px-4 py-2.5 rounded-xl text-sm font-medium border shadow-lg ${
            toast.ok ? "bg-accent/15 text-accent border-accent/40" : "bg-destructive/15 text-destructive border-destructive/40"
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
