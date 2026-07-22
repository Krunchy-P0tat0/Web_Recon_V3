import { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPipelineJobs,
  useGetPipelineJob,
  useStartPipelineJob,
  useGetScrapeProgress,
  getListPipelineJobsQueryKey,
  getGetPipelineJobQueryKey,
} from "@workspace/api-client-react";
import type { PipelineJob } from "@workspace/api-client-react";
import {
  useEventStreamCallback,
  useEventStreamStatus,
} from "@/hooks/useEventStream";

// ── Stage metadata ────────────────────────────────────────────────────────────
const STAGES = [
  { id: "crawl",            icon: "🌐", label: "Crawl",            desc: "BFS discovery + full-site scraping" },
  { id: "manifest",         icon: "📋", label: "Manifest",          desc: "Verify content manifest & 96% coverage gate" },
  { id: "diff",             icon: "🔀", label: "Diff",              desc: "Detect changes vs baseline" },
  { id: "intelligence",     icon: "🧠", label: "Intelligence",      desc: "Deployment environment analysis" },
  { id: "design-dna",       icon: "🎨", label: "Design DNA",        desc: "Archetype & brand classification" },
  { id: "visual-dna",       icon: "👁️", label: "Visual DNA",        desc: "Layout & colour extraction" },
  { id: "stencil",          icon: "🖼️", label: "Stencil",           desc: "Select & assemble stencil" },
  { id: "website-prime",    icon: "⚡", label: "Website Prime",     desc: "Generate site blueprint" },
  { id: "merge",            icon: "🔧", label: "Merge",             desc: "Compile merge plan" },
  { id: "deployment-plan",  icon: "📐", label: "Deployment Plan",   desc: "Multi-framework deployment plan" },
  { id: "deploy",           icon: "🚀", label: "Deploy",            desc: "Execute & verify deployment" },
  { id: "certification",    icon: "✅", label: "Certification",     desc: "Production readiness gate" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "—";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function elapsed(startedAt: string | null | undefined, totalMs: number | null | undefined): string {
  if (totalMs) return formatMs(totalMs);
  if (!startedAt) return "—";
  return formatMs(Date.now() - new Date(startedAt).getTime());
}

// ── Status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    running:  "bg-primary/15 text-primary border border-primary/40",
    pending:  "bg-primary/10 text-primary/70 border border-primary/20",
    complete: "bg-accent/15 text-accent border border-accent/40",
    failed:   "bg-destructive/15 text-destructive border border-destructive/40",
  };
  return (
    <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${cls[status] ?? "bg-muted text-muted-foreground border border-border"}`}>
      {status}
    </span>
  );
}

// ── Spinner ───────────────────────────────────────────────────────────────────
function Spinner() {
  return (
    <div className="w-3 h-3 rounded-full border-2 border-primary border-t-transparent animate-spin-slow" />
  );
}

// ── Stage row ─────────────────────────────────────────────────────────────────
type ScrapeSnap = { totalArticles: number; completedArticles: number; currentArticle?: string; coveragePct: number };

function StageRow({
  meta,
  job,
  scrapeData,
}: {
  meta: (typeof STAGES)[0];
  job: PipelineJob;
  scrapeData?: ScrapeSnap;
}) {
  const stg = job.stages.find((s) => s.id === meta.id);
  const status = stg?.status ?? "pending";
  const isCrawling = meta.id === "crawl" && status === "running";

  const borderCls =
    status === "running"
      ? "border-primary/60 stage-glow-running"
      : status === "complete"
      ? "border-accent/40 stage-glow-complete"
      : status === "failed"
      ? "border-destructive/50"
      : "border-border";

  const statusLabel: Record<string, string> = {
    pending: "WAITING",
    running: "RUNNING",
    complete: "✓ DONE",
    failed: "✗ FAILED",
    skipped: "SKIPPED",
    retrying: "RETRY…",
  };

  return (
    <div className={`bg-card border rounded-xl p-3 flex gap-3 items-start transition-all duration-300 ${borderCls}`}>
      <div className="text-xl w-7 text-center flex-shrink-0 mt-0.5">{meta.icon}</div>

      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold">{meta.label}</div>
        <div className="text-xs text-muted-foreground mt-0.5 truncate">{meta.desc}</div>

        {/* Crawl: article progress */}
        {isCrawling && scrapeData && (
          <div className="mt-2 space-y-1">
            {scrapeData.totalArticles === 0 ? (
              <p className="text-xs text-muted-foreground">Discovering pages…</p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground truncate">
                  Scraping: {truncate(scrapeData.currentArticle, 42)}
                </p>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all duration-500"
                      style={{ width: `${scrapeData.coveragePct}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-muted-foreground flex-shrink-0">
                    {scrapeData.completedArticles}/{scrapeData.totalArticles} — {scrapeData.coveragePct}%
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {/* Manifest: coverage info */}
        {meta.id === "manifest" && stg?.metadata && (stg.metadata as Record<string, unknown>)["coveragePct"] != null && (() => {
          const md = stg.metadata as Record<string, unknown>;
          return (
            <div className="mt-1 text-xs" style={{ color: "hsl(var(--accent))" }}>
              {String(md["coveragePct"])}% coverage ({String(md["completed"])}/{String(md["totalNodes"])})
            </div>
          );
        })()}

        {/* Error */}
        {status === "failed" && stg?.error && (
          <div className="mt-1 text-xs text-destructive truncate">{stg.error}</div>
        )}
      </div>

      <div className="flex-shrink-0 flex flex-col items-end gap-1 pt-0.5">
        {status === "running" ? (
          <Spinner />
        ) : (
          <span
            className={`text-[10px] font-bold uppercase tracking-wide ${
              status === "complete"
                ? "text-accent"
                : status === "failed"
                ? "text-destructive"
                : "text-muted-foreground"
            }`}
          >
            {statusLabel[status] ?? status}
          </span>
        )}
        {stg?.durationMs != null && (
          <span className="text-[10px] text-muted-foreground">{formatMs(stg.durationMs)}</span>
        )}
      </div>
    </div>
  );
}

// ── Job detail panel ──────────────────────────────────────────────────────────
function JobPanel({ jobId }: { jobId: string }) {
  const qc = useQueryClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: job } = useGetPipelineJob(jobId, { query: { refetchInterval: (q: any) => { const s = q.state.data?.status; return s === "running" || s === "pending" ? 3000 : false; } } as any });

  // Scrape progress — only when crawl is running
  const scrapeJobId = job?.underlyingJobId ?? "";
  const crawlRunning = job?.currentStage === "crawl";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: scrapeRaw } = useGetScrapeProgress(scrapeJobId, { query: { enabled: !!scrapeJobId && crawlRunning, refetchInterval: crawlRunning ? 2000 : false } as any });
  const scrapeData = scrapeRaw as { totalArticles: number; completedArticles: number; currentArticle?: string; coveragePct: number } | undefined;

  // Live updates via shared EventStream — typed routing per event (SSE fix)
  useEventStreamCallback(
    { jobId },
    useCallback(
      (evt) => {
        // Stage transitions and lifecycle events → refresh this pipeline job
        void qc.invalidateQueries({ queryKey: getGetPipelineJobQueryKey(jobId) });
        // Lifecycle events also invalidate the jobs list
        if (["job-started", "job-complete", "job-failed", "job-cancelled"].includes(evt.event)) {
          void qc.invalidateQueries({ queryKey: getListPipelineJobsQueryKey() });
        }
      },
      [jobId, qc],
    ),
  );

  if (!job) {
    return (
      <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }

  const completedCount = job.completedStages.length;
  const totalCount = STAGES.length;
  const pct = Math.round((completedCount / totalCount) * 100);
  const elapsedStr = elapsed(job.startedAt, job.totalDurationMs);

  return (
    <div className="space-y-3">
      {/* Summary card */}
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-semibold break-all">{job.url}</span>
          <StatusBadge status={job.status} />
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <span className="text-muted-foreground">Stage</span>
          <span className="text-right font-medium">
            {job.currentStage ?? (job.status === "complete" ? "All done ✅" : "—")}
          </span>
          <span className="text-muted-foreground">Elapsed</span>
          <span className="text-right">{elapsedStr}</span>
          <span className="text-muted-foreground">Coverage gate</span>
          <span className="text-right">{job.coverageThreshold}%</span>
        </div>

        {/* Progress bar */}
        <div>
          <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
            <span>Pipeline progress</span>
            <span>{completedCount}/{totalCount} stages</span>
          </div>
          <div className="h-2 bg-border rounded-full overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-primary to-accent transition-all duration-700"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>

      {/* Error */}
      {job.error && (
        <div className="bg-destructive/10 border border-destructive/40 rounded-xl px-4 py-3 text-sm text-destructive break-words">
          ⚠️ {job.error}
        </div>
      )}

      {/* Stages */}
      <div className="space-y-2">
        {STAGES.map((meta) => (
          <StageRow
            key={meta.id}
            meta={meta}
            job={job}
            scrapeData={scrapeData}
          />
        ))}
      </div>
    </div>
  );
}

// ── New job form ──────────────────────────────────────────────────────────────
function NewJobForm({ onStarted }: { onStarted: (id: string) => void }) {
  const [url, setUrl] = useState("");
  const { mutate, isPending } = useStartPipelineJob();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed.startsWith("http")) return;
    mutate(
      { data: { url: trimmed, coverageThreshold: 96 } },
      {
        onSuccess: (res) => {
          setUrl("");
          onStarted(res.jobId);
        },
      }
    );
  }

  return (
    <form onSubmit={submit} className="flex gap-2 mt-2">
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://example.com"
        className="flex-1 bg-card border border-border rounded-xl px-3 py-2.5 text-sm placeholder:text-muted-foreground outline-none focus:border-primary transition-colors"
      />
      <button
        type="submit"
        disabled={isPending || !url.startsWith("http")}
        className="bg-primary text-primary-foreground rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50 transition-opacity flex-shrink-0"
      >
        {isPending ? "…" : "▶ Run"}
      </button>
    </form>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const qc = useQueryClient();
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const { connected } = useEventStreamStatus();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: jobs = [] } = useListPipelineJobs({ query: { refetchInterval: 8000 } as any });

  // Auto-select running job on first load
  const didAutoSelect = useRef(false);
  useEffect(() => {
    if (didAutoSelect.current || jobs.length === 0) return;
    didAutoSelect.current = true;
    const running = jobs.find((j) => j.status === "running" || j.status === "pending");
    setSelectedJobId((running ?? jobs[0]).id);
  }, [jobs]);

  // Live pipeline events → invalidate jobs list only on lifecycle events (SSE fix)
  useEventStreamCallback(
    { subsystem: "pipeline" },
    useCallback(
      (evt) => {
        if (["job-started", "job-complete", "job-failed", "job-cancelled"].includes(evt.event)) {
          void qc.invalidateQueries({ queryKey: getListPipelineJobsQueryKey() });
        }
      },
      [qc],
    ),
  );

  const handleStarted = useCallback((id: string) => {
    setSelectedJobId(id);
    void qc.invalidateQueries({ queryKey: getListPipelineJobsQueryKey() });
  }, [qc]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-background/90 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-3">
        <div
          className={`w-2 h-2 rounded-full flex-shrink-0 animate-pulse-dot ${
            connected ? "bg-accent" : "bg-muted-foreground"
          }`}
        />
        <h1 className="text-base font-bold tracking-tight">Web Recon Pipeline</h1>
        <div className="ml-auto flex items-center gap-3">
          <Link href="/differential" className="text-xs text-muted-foreground hover:text-foreground">Differential</Link>
          <Link href="/manifest" className="text-xs text-muted-foreground hover:text-foreground">Manifest</Link>
          <Link href="/recovery" className="text-xs text-muted-foreground hover:text-foreground">Recovery</Link>
          <Link href="/jobs" className="text-xs text-primary hover:text-primary/80 font-semibold">Job Control Center →</Link>
        </div>
        <span className="text-xs text-muted-foreground">
          {connected ? "Live" : "Connecting…"}
        </span>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-4 space-y-4">
        {/* Start new job */}
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Start new pipeline</p>
          <NewJobForm onStarted={handleStarted} />
        </div>

        {/* Job selector */}
        {jobs.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Select job</p>
            <select
              value={selectedJobId ?? ""}
              onChange={(e) => setSelectedJobId(e.target.value || null)}
              className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary transition-colors"
            >
              <option value="">— select a job —</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {truncate(j.url, 38)} — {j.status} · {j.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Job panel */}
        {selectedJobId ? (
          <JobPanel key={selectedJobId} jobId={selectedJobId} />
        ) : (
          <div className="text-center py-16 text-muted-foreground text-sm space-y-2">
            <div className="text-4xl">🌐</div>
            <p>Enter a URL above to start a full-site reconstruction pipeline.</p>
          </div>
        )}
      </div>
    </div>
  );
}
