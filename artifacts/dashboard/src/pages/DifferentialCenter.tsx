import { useMemo, useState, useCallback } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJobSets, flattenJobSets, type JobDetail } from "@/lib/jobs-api";
import {
  fetchDiffSummary,
  fetchDiffHistory,
  fetchDiffRun,
  fetchDiffAuditReport,
  type ChangedUrlEntry,
} from "@/lib/differential-api";
import { useEventStreamStatus, useDifferentialEvents, useEventStreamCallback } from "@/hooks/useEventStream";

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

// ── Stat tile ─────────────────────────────────────────────────────────────────

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</p>
      <p className={`text-lg font-bold mt-0.5 ${accent ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}

const CLASS_STYLES: Record<string, string> = {
  new: "bg-accent/15 text-accent border-accent/40",
  changed: "bg-primary/15 text-primary border-primary/40",
  deleted: "bg-destructive/15 text-destructive border-destructive/40",
};

function ClassBadge({ classification }: { classification: string }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border flex-shrink-0 ${CLASS_STYLES[classification] ?? "bg-muted text-muted-foreground border-border"}`}>
      {classification}
    </span>
  );
}

// ── Changed URL viewer ────────────────────────────────────────────────────────

function ChangedUrlViewer({ urls }: { urls: ChangedUrlEntry[] }) {
  const [filter, setFilter] = useState<"all" | "new" | "changed" | "deleted">("all");
  const filtered = useMemo(
    () => (filter === "all" ? urls : urls.filter((u) => u.classification === filter)),
    [urls, filter],
  );

  const counts = useMemo(() => {
    const c = { all: urls.length, new: 0, changed: 0, deleted: 0 };
    for (const u of urls) c[u.classification]++;
    return c;
  }, [urls]);

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Changed URL Viewer</h3>
        <div className="flex gap-1.5">
          {(["all", "new", "changed", "deleted"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors ${
                filter === f ? "bg-primary text-primary-foreground border-primary" : "bg-background text-muted-foreground border-border hover:text-foreground"
              }`}
            >
              {f} <span className="opacity-70">{counts[f]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="max-h-96 overflow-y-auto space-y-1.5">
        {filtered.length === 0 && <p className="text-xs text-muted-foreground py-6 text-center">No URLs in this category.</p>}
        {filtered.map((u, i) => (
          <div key={`${u.url}-${i}`} className="flex items-start gap-2 text-[11px] py-1.5 border-b border-border last:border-0">
            <ClassBadge classification={u.classification} />
            <div className="min-w-0 flex-1">
              <p className="break-all">{u.url}</p>
              {u.changeReasons.length > 0 && (
                <p className="text-muted-foreground mt-0.5">{u.changeReasons.join(", ")}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Run detail panel ──────────────────────────────────────────────────────────

function RunDetail({ jobId }: { jobId: string }) {
  const { data: run, isLoading, error } = useQuery({
    queryKey: ["diff-run", jobId],
    queryFn: () => fetchDiffRun(jobId),
  });
  const { data: audit } = useQuery({
    queryKey: ["diff-audit", jobId],
    queryFn: () => fetchDiffAuditReport(jobId),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground text-center py-10">Loading diff run…</p>;
  if (error || !run) {
    return (
      <div className="text-center py-10 text-muted-foreground text-sm space-y-1">
        <p>No differential run recorded for this job yet.</p>
        <p className="text-xs">Run a diff crawl from the Job Control Center against a completed job.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-xl p-4 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold break-all">{run.seedUrl}</p>
          <span className="text-[10px] text-muted-foreground">{new Date(run.computedAt).toLocaleString()}</span>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground pt-1">
          <span>Diff job: <span className="text-foreground font-mono">{truncate(run.jobId, 20)}</span></span>
          <span>Base job: <span className="text-foreground font-mono">{truncate(run.baseJobId, 20)}</span></span>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="New" value={String(run.newCount)} accent="text-accent" />
        <Stat label="Changed" value={String(run.changedCount)} accent="text-primary" />
        <Stat label="Unchanged" value={String(run.unchangedCount)} />
        <Stat label="Deleted" value={String(run.deletedCount)} accent="text-destructive" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Skip rate" value={`${run.skipRatePercent}%`} />
        <Stat label="Bandwidth saved" value={formatBytes(run.bandwidthSavedBytes)} />
        <Stat label="Storage saved" value={formatBytes(run.storageSavedBytes)} />
        <Stat label="Time saved" value={formatMs(run.processingTimeSavedMs)} />
      </div>

      {audit && (
        <div className="bg-card border border-border rounded-xl p-4 space-y-2">
          <h3 className="text-sm font-semibold">Intelligence layer</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-[11px]">
            <span className="text-muted-foreground">Stability score</span>
            <span className="text-right sm:text-left font-medium">{audit.velocity.stabilityScore}</span>
            <span className="text-muted-foreground">Trend</span>
            <span className="text-right sm:text-left font-medium">{audit.velocity.trend}</span>
            <span className="text-muted-foreground">Diff generation</span>
            <span className="text-right sm:text-left font-medium">#{audit.diffGeneration}</span>
            <span className="text-muted-foreground">Total diff runs</span>
            <span className="text-right sm:text-left font-medium">{audit.timeline.totalRuns}</span>
            <span className="text-muted-foreground">Cumulative bandwidth</span>
            <span className="text-right sm:text-left font-medium">{formatBytes(audit.cumulativeSavings.bandwidthSavedBytes)}</span>
            <span className="text-muted-foreground">Restoration</span>
            <span className="text-right sm:text-left font-medium">{audit.restorationCompatibility.status}</span>
          </div>
          {audit.hotspots.topVolatileUrls.length > 0 && (
            <div className="pt-2 border-t border-border">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">Volatility hotspots</p>
              <div className="space-y-1">
                {audit.hotspots.topVolatileUrls.slice(0, 5).map((h) => (
                  <div key={h.url} className="flex justify-between text-[11px] gap-2">
                    <span className="truncate">{h.url}</span>
                    <span className="text-muted-foreground flex-shrink-0">{h.changeCount} changes</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <ChangedUrlViewer urls={run.changedUrls} />
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DifferentialCenter() {
  const { connected } = useEventStreamStatus();
  const qc = useQueryClient();

  // SSE: refresh differential data when a diff run completes (SSE fix)
  useEventStreamCallback(
    { subsystem: "differential" },
    useCallback(() => {
      void qc.invalidateQueries({ queryKey: ["diff-summary"] });
      void qc.invalidateQueries({ queryKey: ["diff-history"] });
    }, [qc]),
  );
  useEventStreamCallback(
    { subsystem: "pipeline", event: "diff-computed" },
    useCallback(() => {
      void qc.invalidateQueries({ queryKey: ["diff-summary"] });
      void qc.invalidateQueries({ queryKey: ["diff-history"] });
    }, [qc]),
  );
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const { data: summary } = useQuery({ queryKey: ["diff-summary"], queryFn: fetchDiffSummary, refetchInterval: 10000 });
  const { data: history = [] } = useQuery({ queryKey: ["diff-history"], queryFn: () => fetchDiffHistory(50), refetchInterval: 10000 });
  const { data: jobSets = [] } = useQuery({ queryKey: ["job-sets"], queryFn: fetchJobSets, refetchInterval: 10000 });

  // Live differential events just nudge the lists to refetch via react-query's default staleTime.
  useDifferentialEvents(undefined, 5);

  const diffJobs: JobDetail[] = useMemo(
    () => flattenJobSets(jobSets).filter((j) => j.diffMode),
    [jobSets],
  );

  const effectiveJobId = selectedJobId ?? history[0]?.jobId ?? diffJobs[0]?.jobId ?? null;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 bg-background/90 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-3">
        <div className={`w-2 h-2 rounded-full flex-shrink-0 animate-pulse-dot ${connected ? "bg-accent" : "bg-muted-foreground"}`} />
        <h1 className="text-base font-bold tracking-tight">Differential Center</h1>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <Link href="/manifest" className="text-muted-foreground hover:text-foreground">Manifest Center</Link>
          <Link href="/recovery" className="text-muted-foreground hover:text-foreground">Recovery</Link>
          <Link href="/jobs" className="text-muted-foreground hover:text-foreground">Job Control</Link>
          <Link href="/" className="text-muted-foreground hover:text-foreground">← Pipeline</Link>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-4 space-y-4">
        {/* Global savings summary */}
        {summary && (
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-2">All-time savings across {summary.uniqueSeedUrls} site{summary.uniqueSeedUrls === 1 ? "" : "s"}</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <p className="text-[11px] text-muted-foreground">Diff runs</p>
                <p className="text-base font-bold">{summary.totalDiffRuns}</p>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground">Bandwidth saved</p>
                <p className="text-base font-bold">{formatBytes(summary.totalBandwidthSavedBytes)}</p>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground">Storage saved</p>
                <p className="text-base font-bold">{formatBytes(summary.totalStorageSavedBytes)}</p>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground">Avg skip rate</p>
                <p className="text-base font-bold">{summary.averageSkipRatePercent}%</p>
              </div>
            </div>
          </div>
        )}

        {/* Job / run selector */}
        <div className="bg-card border border-border rounded-xl p-3">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">Select diff run</p>
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">No differential crawls have completed yet. Start one from a completed job in the Job Control Center.</p>
          ) : (
            <select
              value={effectiveJobId ?? ""}
              onChange={(e) => setSelectedJobId(e.target.value || null)}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-primary transition-colors"
            >
              {history.map((h) => (
                <option key={h.jobId} value={h.jobId}>
                  {truncate(h.seedUrl, 40)} — {new Date(h.computedAt).toLocaleString()} ({h.changedCount + h.newCount + h.deletedCount} changes)
                </option>
              ))}
            </select>
          )}
        </div>

        {effectiveJobId && <RunDetail jobId={effectiveJobId} />}
      </div>
    </div>
  );
}
