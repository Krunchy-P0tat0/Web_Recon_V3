/**
 * JobMissionControl.tsx — Phase D3.4: Surgical Job View
 *
 * Dedicated per-job interface. Route: /jobs/:jobId
 * Sections: Overview, Child Jobs, Current Stage, Pipeline, Checkpoints,
 *           Recovery, Manifest, Differential, Website Prime, Certification
 */

import { useState, useCallback, useMemo } from "react";
import { useParams, Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useListPipelineJobs,
  useGetPipelineJob,
  useGetScrapeProgress,
  getGetPipelineJobQueryKey,
} from "@workspace/api-client-react";
import type { PipelineJob } from "@workspace/api-client-react";
import {
  fetchJobDetail,
  fetchJobLogs,
  fetchJobSets,
  fetchSystemResources,
  pauseJobApi,
  resumeJobApi,
  retryJobApi,
  cancelJobApi,
  cloneJobApi,
  runDiffApi,
  generateWebsitePrimeApi,
  manifestDownloadUrl,
  type JobDetail,
  type ControlResult,
} from "@/lib/jobs-api";
import {
  fetchJobCheckpoint,
  fetchManifestSummary,
  fetchJobDiffRun,
  fetchPrimeIndexNav,
  runProductionCertification,
  fetchCertReport,
  fetchJobRecoveryTimeline,
  triggerJobRecovery,
  fetchGenerationStatus,
  flushCheckpoints,
} from "@/lib/mission-api";
import { useEventStreamCallback, useEventStreamStatus } from "@/hooks/useEventStream";

// ── Types ─────────────────────────────────────────────────────────────────────

type StageStatus = "pending" | "running" | "complete" | "failed" | "skipped" | "retrying";

interface StageInfo {
  id: string;
  icon: string;
  label: string;
  desc: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STAGES: StageInfo[] = [
  { id: "crawl",           icon: "🌐", label: "Crawl",           desc: "BFS discovery + full-site scraping" },
  { id: "manifest",        icon: "📋", label: "Manifest",         desc: "Verify content manifest & 96% coverage gate" },
  { id: "diff",            icon: "🔀", label: "Diff",             desc: "Detect changes vs baseline" },
  { id: "intelligence",    icon: "🧠", label: "Intelligence",     desc: "Deployment environment analysis" },
  { id: "design-dna",      icon: "🎨", label: "Design DNA",       desc: "Archetype & brand classification" },
  { id: "visual-dna",      icon: "👁️", label: "Visual DNA",       desc: "Layout & colour extraction" },
  { id: "stencil",         icon: "🖼️", label: "Stencil",          desc: "Select & assemble stencil" },
  { id: "website-prime",   icon: "⚡", label: "Website Prime",    desc: "Generate site blueprint" },
  { id: "merge",           icon: "🔧", label: "Merge",            desc: "Compile merge plan" },
  { id: "deployment-plan", icon: "📐", label: "Deployment Plan",  desc: "Multi-framework deployment plan" },
  { id: "deploy",          icon: "🚀", label: "Deploy",           desc: "Execute & verify deployment" },
  { id: "certification",   icon: "✅", label: "Certification",    desc: "Production readiness gate" },
];

type TabId =
  | "overview" | "pipeline" | "children"
  | "checkpoints" | "recovery" | "manifest"
  | "differential" | "prime" | "certification";

const TABS: { id: TabId; label: string }[] = [
  { id: "overview",      label: "Overview" },
  { id: "pipeline",      label: "Pipeline" },
  { id: "children",      label: "Child Jobs" },
  { id: "checkpoints",   label: "Checkpoints" },
  { id: "recovery",      label: "Recovery" },
  { id: "manifest",      label: "Manifest" },
  { id: "differential",  label: "Differential" },
  { id: "prime",         label: "Website Prime" },
  { id: "certification", label: "Certification" },
];

// ── Formatting ────────────────────────────────────────────────────────────────

function fmt(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function fmtBytes(b: number | null | undefined): string {
  if (!b) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = b, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  return new Date(s).toLocaleString();
}

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "—";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ── Shared UI atoms ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    running:    "bg-primary/15 text-primary border-primary/40",
    pending:    "bg-primary/10 text-primary/70 border-primary/20",
    complete:   "bg-accent/15 text-accent border-accent/40",
    done:       "bg-accent/15 text-accent border-accent/40",
    failed:     "bg-destructive/15 text-destructive border-destructive/40",
    dead_letter:"bg-destructive/20 text-destructive border-destructive/50",
    paused:     "bg-yellow-500/15 text-yellow-500 border-yellow-500/40",
    queued:     "bg-muted text-muted-foreground border-border",
    retrying:   "bg-orange-500/15 text-orange-400 border-orange-400/40",
    skipped:    "bg-muted text-muted-foreground/60 border-border",
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${styles[status] ?? "bg-muted text-muted-foreground border-border"}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className="text-sm font-medium">{value ?? "—"}</span>
    </div>
  );
}

function SectionCard({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-bold tracking-tight">{title}</h3>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Btn({
  label, onClick, disabled, variant = "default", size = "sm",
}: { label: string; onClick: () => void; disabled?: boolean; variant?: "default" | "danger" | "primary"; size?: "sm" | "xs" }) {
  const base = "font-semibold border transition-colors disabled:opacity-40 disabled:cursor-not-allowed rounded-lg";
  const sz = size === "xs" ? "px-2 py-1 text-[10px]" : "px-3 py-1.5 text-xs";
  const col =
    variant === "primary" ? "border-primary/40 text-primary hover:bg-primary/10" :
    variant === "danger"  ? "border-destructive/40 text-destructive hover:bg-destructive/10" :
                            "border-border text-foreground hover:bg-muted";
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${sz} ${col}`}>
      {label}
    </button>
  );
}

function Spinner({ size = 3 }: { size?: number }) {
  return <div className={`w-${size} h-${size} rounded-full border-2 border-primary border-t-transparent animate-spin`} />;
}

function EmptyState({ msg }: { msg: string }) {
  return <p className="text-sm text-muted-foreground py-4 text-center">{msg}</p>;
}

// ── Stage status icons ────────────────────────────────────────────────────────

function StageIcon({ status }: { status: StageStatus }) {
  if (status === "running")  return <Spinner size={3} />;
  if (status === "complete") return <span className="text-accent text-xs font-bold">✓</span>;
  if (status === "failed")   return <span className="text-destructive text-xs font-bold">✗</span>;
  if (status === "retrying") return <span className="text-orange-400 text-xs">↺</span>;
  if (status === "skipped")  return <span className="text-muted-foreground text-xs">—</span>;
  return <span className="text-muted-foreground/40 text-xs">·</span>;
}

function stageBorder(status: StageStatus): string {
  if (status === "running")  return "border-primary/60 shadow-[0_0_0_1px_hsl(var(--primary)/0.2)]";
  if (status === "complete") return "border-accent/40";
  if (status === "failed")   return "border-destructive/50";
  if (status === "retrying") return "border-orange-400/50";
  return "border-border";
}

// ── Expandable Pipeline Stage ────────────────────────────────────────────────

interface PipelineStagePanelProps {
  meta: StageInfo;
  pipelineJob: PipelineJob | undefined;
  scrapeJob: JobDetail | undefined;
  logs: LogEntry[];
  sysRes: SysRes | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onAction: (action: () => Promise<any>, label: string) => void;
}

type LogEntry = { id: string; timestamp: string; event: string; severity: string; subsystem: string; payload: Record<string, unknown> };
type SysRes = { memory: { rssBytes: number; heapUsedBytes: number; systemTotalBytes: number }; cpu: { loadAvg1m: number; cpuCount: number } };

function PipelineStagePanel({ meta, pipelineJob, scrapeJob, logs, sysRes, onAction }: PipelineStagePanelProps) {
  const [expanded, setExpanded] = useState(false);

  const stg = pipelineJob?.stages?.find((s) => s.id === meta.id);
  const status: StageStatus = (stg?.status as StageStatus) ?? "pending";
  const isCurrent = pipelineJob?.currentStage === meta.id;

  // Filter logs for this stage
  const stageLogs = useMemo(() =>
    logs.filter((l) =>
      l.subsystem?.toLowerCase().includes(meta.id.replace("-", "")) ||
      l.event?.toLowerCase().includes(meta.id.replace("-", "")) ||
      (l.payload && JSON.stringify(l.payload).includes(meta.id))
    ).slice(-30),
    [logs, meta.id]
  );

  // Crawl-specific scrape progress
  // underlyingJobId is returned by the backend but not in the slim generated type
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scrapeJobId = (pipelineJob as any)?.underlyingJobId ?? "";
  const crawlRunning = meta.id === "crawl" && status === "running";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: scrapeProgress } = useGetScrapeProgress(scrapeJobId, { query: { enabled: !!scrapeJobId && crawlRunning, refetchInterval: crawlRunning ? 2000 : false } as any });

  const metadata = stg?.metadata as Record<string, unknown> | null | undefined;

  return (
    <div className={`border rounded-xl overflow-hidden transition-all duration-200 ${stageBorder(status)} ${isCurrent ? "ring-1 ring-primary/30" : ""}`}>
      {/* Stage header — always visible */}
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-base w-6 text-center flex-shrink-0">{meta.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold">{meta.label}</span>
            {isCurrent && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-primary/20 text-primary uppercase tracking-wide">Active</span>}
            <StatusBadge status={status} />
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{meta.desc}</p>

          {/* Crawl progress bar inline */}
          {crawlRunning && scrapeProgress && (scrapeProgress as { totalArticles?: number }).totalArticles ? (
            <div className="mt-1.5 flex items-center gap-2">
              <div className="flex-1 h-1 bg-border rounded-full overflow-hidden">
                <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${(scrapeProgress as { coveragePct?: number }).coveragePct ?? 0}%` }} />
              </div>
              <span className="text-[10px] text-muted-foreground flex-shrink-0">
                {(scrapeProgress as { completedArticles?: number }).completedArticles}/{(scrapeProgress as { totalArticles?: number }).totalArticles}
              </span>
            </div>
          ) : null}
        </div>

        <div className="flex-shrink-0 flex flex-col items-end gap-1">
          <StageIcon status={status} />
          {stg?.durationMs != null && (
            <span className="text-[10px] text-muted-foreground">{fmt(stg.durationMs)}</span>
          )}
          <span className="text-[10px] text-muted-foreground">{expanded ? "▲" : "▼"}</span>
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-border px-4 py-4 space-y-4 bg-background/40">

          {/* Error */}
          {stg?.error && (
            <div className="bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2 text-xs text-destructive break-words">
              <span className="font-bold">Error: </span>{stg.error}
            </div>
          )}

          {/* Metrics row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Kv label="Duration"    value={fmt(stg?.durationMs)} />
            <Kv label="Status"      value={<StatusBadge status={status} />} />
            <Kv label="Retries"     value={scrapeJob ? `${scrapeJob.retryCount}/${scrapeJob.maxRetries}` : "—"} />
            <Kv label="CPU (1m)"    value={sysRes ? `${sysRes.cpu.loadAvg1m.toFixed(2)} / ${sysRes.cpu.cpuCount} cores` : "—"} />
            <Kv label="Memory RSS"  value={sysRes ? fmtBytes(sysRes.memory.rssBytes) : "—"} />
            <Kv label="Heap Used"   value={sysRes ? fmtBytes(sysRes.memory.heapUsedBytes) : "—"} />
          </div>

          {/* Outputs / metadata */}
          {metadata && Object.keys(metadata).length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Outputs</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {Object.entries(metadata).map(([k, v]) => (
                  <div key={k} className="bg-muted/30 rounded-lg px-3 py-2">
                    <span className="text-[10px] text-muted-foreground block">{k}</span>
                    <span className="text-xs font-mono font-medium break-all">{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Crawl details */}
          {meta.id === "crawl" && scrapeJob && (
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Generated Files</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-muted/30 rounded-lg px-3 py-2">
                  <span className="text-muted-foreground block">ZIP Archive</span>
                  <span className="font-mono">{scrapeJob.zipPath ? truncate(scrapeJob.zipPath, 40) : "Pending"}</span>
                </div>
                <div className="bg-muted/30 rounded-lg px-3 py-2">
                  <span className="text-muted-foreground block">Download</span>
                  {scrapeJob.downloadUrl
                    ? <a href={scrapeJob.downloadUrl} className="text-primary underline font-mono" target="_blank" rel="noreferrer">Ready ↗</a>
                    : <span className="font-mono">Pending</span>
                  }
                </div>
                <div className="bg-muted/30 rounded-lg px-3 py-2">
                  <span className="text-muted-foreground block">Articles scraped</span>
                  <span className="font-mono">{scrapeJob.completedArticles}/{scrapeJob.totalArticles}</span>
                </div>
                <div className="bg-muted/30 rounded-lg px-3 py-2">
                  <span className="text-muted-foreground block">Coverage</span>
                  <span className="font-mono">{scrapeJob.coveragePercent}%</span>
                </div>
              </div>
            </div>
          )}

          {/* Logs */}
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              Logs {stageLogs.length > 0 ? `(${stageLogs.length} events)` : "(none for this stage)"}
            </p>
            <div className="bg-background border border-border rounded-lg p-3 max-h-48 overflow-y-auto font-mono text-[10px] space-y-1">
              {stageLogs.length === 0 ? (
                <span className="text-muted-foreground">No log events matched for this stage.</span>
              ) : stageLogs.map((l) => (
                <div key={l.id} className="flex gap-2 items-start">
                  <span className="text-muted-foreground flex-shrink-0">{new Date(l.timestamp).toLocaleTimeString()}</span>
                  <span className={`flex-shrink-0 font-bold uppercase ${l.severity === "error" || l.severity === "critical" ? "text-destructive" : l.severity === "warn" ? "text-yellow-500" : "text-primary"}`}>
                    {l.subsystem}
                  </span>
                  <span className="break-all text-foreground/80">{l.event}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Stage actions */}
          <div className="flex flex-wrap gap-2 pt-1 border-t border-border">
            <Btn
              label="↺ Retry Stage"
              variant="default"
              onClick={() => onAction(() => retryJobApi(scrapeJob?.jobId ?? ""), "Retry")}
              disabled={!scrapeJob || status === "running"}
            />
            <Btn
              label="▶ Resume"
              variant="primary"
              onClick={() => onAction(() => resumeJobApi(scrapeJob?.jobId ?? ""), "Resume")}
              disabled={!scrapeJob || scrapeJob.status !== "paused"}
            />
            <Btn
              label="📍 Generate Checkpoint"
              onClick={() => onAction(async () => { await flushCheckpoints(); }, "Flush Checkpoint")}
              disabled={status !== "running" && status !== "retrying"}
            />
            <Btn
              label="📄 View Full Logs"
              onClick={() => onAction(async () => { window.open(`/api/jobs/${encodeURIComponent(scrapeJob?.jobId ?? "")}/logs`, "_blank"); }, "View Logs")}
              disabled={!scrapeJob}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tab: Overview ─────────────────────────────────────────────────────────────

function OverviewTab({ job, pipelineJob, sysRes, onAction }: {
  job: JobDetail;
  pipelineJob: PipelineJob | undefined;
  sysRes: SysRes | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onAction: (action: () => Promise<any>, label: string) => void;
}) {
  const isTerminal = job.status === "done" || job.status === "dead_letter";
  const completedCount = pipelineJob?.completedStages?.length ?? 0;
  const pct = Math.round((completedCount / STAGES.length) * 100);

  return (
    <div className="space-y-4">
      <SectionCard title="Job Details">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Kv label="Job ID"       value={<span className="font-mono text-xs">{job.jobId}</span>} />
          <Kv label="Status"       value={<StatusBadge status={job.status} />} />
          <Kv label="Health"       value={job.healthStatus ?? "—"} />
          <Kv label="Created"      value={fmtDate(job.createdAt)} />
          <Kv label="Claimed"      value={fmtDate(job.claimedAt)} />
          <Kv label="Completed"    value={fmtDate(job.completedAt)} />
          <Kv label="Worker"       value={job.resourceUsage.workerId ?? "—"} />
          <Kv label="Retries"      value={`${job.retryCount} / ${job.maxRetries}`} />
          <Kv label="Mode"         value={job.diffMode ? "Differential" : "Full crawl"} />
          {job.baseJobId && <Kv label="Base Job" value={<span className="font-mono text-xs">{truncate(job.baseJobId, 16)}</span>} />}
        </div>
      </SectionCard>

      <SectionCard title="Progress">
        <div className="space-y-3">
          <div>
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>Articles</span>
              <span>{job.completedArticles} / {job.totalArticles} — {job.progressPercent}%</span>
            </div>
            <div className="h-2 bg-border rounded-full overflow-hidden">
              <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${job.progressPercent}%` }} />
            </div>
          </div>
          <div>
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>Coverage</span>
              <span>{job.coveragePercent}%</span>
            </div>
            <div className="h-2 bg-border rounded-full overflow-hidden">
              <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${job.coveragePercent}%` }} />
            </div>
          </div>
          {pipelineJob && (
            <div>
              <div className="flex justify-between text-xs text-muted-foreground mb-1">
                <span>Pipeline stages</span>
                <span>{completedCount} / {STAGES.length} — {pct}%</span>
              </div>
              <div className="h-2 bg-border rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-primary to-accent rounded-full transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Resource Snapshot">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Kv label="Throughput"    value={job.resourceUsage.articlesPerMinute ? `${job.resourceUsage.articlesPerMinute.toFixed(1)}/min` : "—"} />
          <Kv label="Data processed" value={fmtBytes(job.resourceUsage.estimatedBytesProcessed)} />
          <Kv label="Server RSS"    value={sysRes ? fmtBytes(sysRes.memory.rssBytes) : "—"} />
          <Kv label="Heap used"     value={sysRes ? fmtBytes(sysRes.memory.heapUsedBytes) : "—"} />
          <Kv label="CPU load (1m)" value={sysRes ? `${sysRes.cpu.loadAvg1m.toFixed(2)}` : "—"} />
          <Kv label="CPU cores"     value={sysRes ? String(sysRes.cpu.cpuCount) : "—"} />
        </div>
      </SectionCard>

      {job.errorMessage && (
        <div className="bg-destructive/10 border border-destructive/40 rounded-xl px-4 py-3 text-sm text-destructive break-words">
          ⚠️ {job.errorMessage}
        </div>
      )}

      <SectionCard title="Actions">
        <div className="flex flex-wrap gap-2">
          {job.status === "running" && (
            <Btn label="⏸ Pause"    onClick={() => onAction(() => pauseJobApi(job.jobId), "Pause")} />
          )}
          {job.status === "paused" && (
            <Btn label="▶ Resume"   variant="primary" onClick={() => onAction(() => resumeJobApi(job.jobId), "Resume")} />
          )}
          {(job.status === "failed" || job.status === "dead_letter" || job.status === "paused") && (
            <Btn label="↺ Retry"    variant="primary" onClick={() => onAction(() => retryJobApi(job.jobId), "Retry")} />
          )}
          <Btn label="⊕ Clone"      onClick={() => onAction(() => cloneJobApi(job.jobId), "Clone")} />
          {!isTerminal && (
            <Btn label="✕ Cancel"   variant="danger" onClick={() => onAction(() => cancelJobApi(job.jobId), "Cancel")} />
          )}
          {job.status === "done" && (
            <>
              <Btn label="🔀 Run Diff"        onClick={() => onAction(() => runDiffApi(job.jobId), "Run Diff")} />
              <Btn label="⚡ Website Prime"   onClick={() => onAction(() => generateWebsitePrimeApi(job.jobId), "Website Prime")} />
            </>
          )}
          <a
            href={manifestDownloadUrl(job.jobId)}
            download
            className="px-3 py-1.5 text-xs font-semibold border border-border rounded-lg hover:bg-muted transition-colors"
          >
            ↓ Export Manifest
          </a>
        </div>
      </SectionCard>
    </div>
  );
}

// ── Tab: Pipeline ─────────────────────────────────────────────────────────────

function PipelineTab({ job, pipelineJob, logs, sysRes, onAction }: {
  job: JobDetail;
  pipelineJob: PipelineJob | undefined;
  logs: LogEntry[];
  sysRes: SysRes | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onAction: (action: () => Promise<any>, label: string) => void;
}) {
  const currentStage = pipelineJob?.currentStage;

  return (
    <div className="space-y-3">
      {currentStage && (
        <div className="bg-primary/10 border border-primary/30 rounded-xl px-4 py-3 flex items-center gap-3">
          <Spinner />
          <div>
            <p className="text-xs font-semibold text-primary">Currently running</p>
            <p className="text-sm font-bold">{STAGES.find((s) => s.id === currentStage)?.label ?? currentStage}</p>
          </div>
        </div>
      )}
      {!pipelineJob && (
        <div className="bg-muted/30 border border-border rounded-xl px-4 py-3 text-sm text-muted-foreground">
          No live pipeline job found for this scrape job. Stage data appears once the orchestrator picks up the job.
        </div>
      )}
      <div className="space-y-2">
        {STAGES.map((meta) => (
          <PipelineStagePanel
            key={meta.id}
            meta={meta}
            pipelineJob={pipelineJob}
            scrapeJob={job}
            logs={logs}
            sysRes={sysRes}
            onAction={onAction}
          />
        ))}
      </div>
    </div>
  );
}

// ── Tab: Child Jobs ───────────────────────────────────────────────────────────

function ChildJobsTab({ jobSet, onAction }: {
  jobSet: { childJobs: JobDetail[] } | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onAction: (action: () => Promise<any>, label: string) => void;
}) {
  if (!jobSet) return <EmptyState msg="Job set data loading…" />;
  if (jobSet.childJobs.length === 0) return <EmptyState msg="No child jobs for this job set." />;

  return (
    <div className="space-y-3">
      {jobSet.childJobs.map((child) => (
        <div key={child.jobId} className="bg-card border border-border rounded-xl p-4 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <Link href={`/jobs/${encodeURIComponent(child.jobId)}`} className="text-sm font-semibold text-primary hover:underline break-all">
                {truncate(child.seedUrl, 60)}
              </Link>
              <p className="text-[11px] font-mono text-muted-foreground mt-0.5">{child.jobId}</p>
            </div>
            <StatusBadge status={child.status} />
          </div>
          <div className="h-1.5 bg-border rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full" style={{ width: `${child.progressPercent}%` }} />
          </div>
          <div className="grid grid-cols-3 gap-3 text-[11px]">
            <div><span className="text-muted-foreground">Articles </span><span className="font-medium">{child.completedArticles}/{child.totalArticles}</span></div>
            <div><span className="text-muted-foreground">Coverage </span><span className="font-medium">{child.coveragePercent}%</span></div>
            <div><span className="text-muted-foreground">Retries </span><span className="font-medium">{child.retryCount}/{child.maxRetries}</span></div>
          </div>
          <div className="flex gap-2">
            {child.status === "paused" && (
              <Btn size="xs" label="Resume"  variant="primary" onClick={() => onAction(() => resumeJobApi(child.jobId), "Resume")} />
            )}
            {(child.status === "failed" || child.status === "dead_letter") && (
              <Btn size="xs" label="Retry"   variant="primary" onClick={() => onAction(() => retryJobApi(child.jobId), "Retry")} />
            )}
            <Btn size="xs" label="Open"  onClick={() => { window.location.href = `/jobs/${encodeURIComponent(child.jobId)}`; }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Tab: Checkpoints ─────────────────────────────────────────────────────────

function CheckpointsTab({ jobId, onAction }: {
  jobId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onAction: (action: () => Promise<any>, label: string) => void;
}) {
  const { data: cp, isLoading, error } = useQuery({
    queryKey: ["job-checkpoint", jobId],
    queryFn: () => fetchJobCheckpoint(jobId),
    retry: 1,
  });

  if (isLoading) return <EmptyState msg="Loading checkpoint data…" />;
  if (error || !cp) return <EmptyState msg="No checkpoint data for this job yet." />;

  return (
    <div className="space-y-4">
      <SectionCard title={`Checkpoint v${cp.checkpointVersion}`} action={
        <div className="flex gap-2">
          <Btn size="xs" label="📍 Flush All"   onClick={() => onAction(async () => { await flushCheckpoints(); }, "Flush Checkpoint")} />
          <Btn size="xs" label="⟳ Reset"        variant="danger" onClick={() => onAction(async () => { await fetch(`/api/checkpoint/${encodeURIComponent(jobId)}/reset`, { method: "POST" }); }, "Reset Checkpoint")} />
        </div>
      }>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-4">
          <Kv label="Version"     value={`v${cp.checkpointVersion}`} />
          <Kv label="Valid"       value={cp.isValid ? "✓ Valid" : "✗ Invalid"} />
          <Kv label="Checkpointed" value={fmtDate(cp.checkpointedAt)} />
          <Kv label="Coverage"    value={`${cp.coverageState.coveragePercent}%`} />
          <Kv label="Completed"   value={String(cp.coverageState.completed)} />
          <Kv label="Failed"      value={String(cp.coverageState.failed)} />
        </div>
        <div className="h-2 bg-border rounded-full overflow-hidden mb-4">
          <div className="h-full bg-accent rounded-full" style={{ width: `${cp.coverageState.coveragePercent}%` }} />
        </div>
      </SectionCard>

      <SectionCard title="Manifest State">
        <div className="grid grid-cols-2 gap-4">
          <Kv label="Has Manifest" value={cp.manifestState.hasManifest ? "Yes" : "No"} />
          <Kv label="Node Count"   value={String(cp.manifestState.nodeCount)} />
          <Kv label="Last Saved"   value={fmtDate(cp.manifestState.lastSavedAt)} />
        </div>
      </SectionCard>

      <SectionCard title="Storage State">
        <div className="grid grid-cols-2 gap-4 mb-3">
          <Kv label="Uploaded"     value={`${cp.storageState.uploadedKeys.length} keys`} />
          <Kv label="Pending"      value={`${cp.storageState.pendingKeys.length} keys`} />
          <Kv label="Total bytes"  value={fmtBytes(cp.storageState.totalBytesUploaded)} />
        </div>
        {cp.storageState.uploadedKeys.length > 0 && (
          <div className="bg-muted/20 rounded-lg p-3 max-h-40 overflow-y-auto">
            {cp.storageState.uploadedKeys.map((k) => (
              <p key={k} className="text-[10px] font-mono text-muted-foreground">{k}</p>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="URL Lists">
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="bg-accent/10 border border-accent/20 rounded-lg p-3">
            <p className="text-2xl font-bold text-accent">{cp.completedUrls.length}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">Completed</p>
          </div>
          <div className="bg-primary/10 border border-primary/20 rounded-lg p-3">
            <p className="text-2xl font-bold text-primary">{cp.pendingUrls.length}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">Pending</p>
          </div>
          <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3">
            <p className="text-2xl font-bold text-destructive">{cp.failedUrls.length}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">Failed</p>
          </div>
        </div>
        {cp.failedUrls.length > 0 && (
          <div className="mt-3 bg-muted/20 rounded-lg p-3 max-h-32 overflow-y-auto">
            {cp.failedUrls.map((u) => (
              <p key={u} className="text-[10px] font-mono text-destructive/80">{u}</p>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ── Tab: Recovery ─────────────────────────────────────────────────────────────

function RecoveryTab({ job, onAction }: {
  job: JobDetail;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onAction: (action: () => Promise<any>, label: string) => void;
}) {
  const { data: timeline, isLoading } = useQuery({
    queryKey: ["job-recovery-timeline", job.jobId],
    queryFn: () => fetchJobRecoveryTimeline(job.jobId),
    retry: 1,
  });

  return (
    <div className="space-y-4">
      <SectionCard title="Recovery Controls" action={
        <Btn size="xs" label="🔁 Trigger Recovery" variant="primary"
          onClick={() => onAction(() => triggerJobRecovery(job.jobId), "Trigger Recovery")}
          disabled={job.status === "done" || job.status === "running"}
        />
      }>
        <p className="text-sm text-muted-foreground">
          Manually invoke the F3 autonomous recovery engine for this job. Available when job is failed or paused.
        </p>
        {(job.status === "done" || job.status === "running") && (
          <p className="text-xs text-muted-foreground mt-1">Recovery is only available for failed, paused, or dead-letter jobs.</p>
        )}
      </SectionCard>

      {job.failureHistory.length > 0 && (
        <SectionCard title="Failure History">
          <div className="space-y-2">
            {job.failureHistory.map((f, i) => (
              <div key={i} className="bg-destructive/5 border border-destructive/20 rounded-lg px-3 py-2">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-semibold text-destructive">{f.failureClass}</span>
                  <span className="text-muted-foreground">{fmtDate(f.classifiedAt)}</span>
                </div>
                <p className="text-xs text-foreground/80">{f.rootCause}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Recommendation: {f.retryRecommendation}</p>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {job.recoveryActions.length > 0 && (
        <SectionCard title="Recovery Actions">
          <div className="space-y-2">
            {job.recoveryActions.map((a, i) => (
              <div key={i} className="border border-border rounded-lg px-3 py-2">
                <div className="flex items-center justify-between text-xs mb-0.5">
                  <span className="font-semibold">{a.actionType}</span>
                  <span className={`font-bold ${a.outcome === "succeeded" ? "text-accent" : a.outcome === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
                    {a.outcome}
                  </span>
                </div>
                <p className="text-[10px] text-muted-foreground">{a.actionReason}</p>
                <p className="text-[10px] text-muted-foreground">{fmtDate(a.triggeredAt)}</p>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {isLoading && <EmptyState msg="Loading recovery timeline…" />}
      {timeline && (
        <SectionCard title="Recovery Timeline">
          {timeline.events.length === 0
            ? <EmptyState msg="No recovery events for this job." />
            : <div className="space-y-2">
                {timeline.events.map((e, i) => (
                  <div key={i} className="flex gap-3 items-start text-xs border-l-2 border-border pl-3">
                    <span className="text-muted-foreground flex-shrink-0">{fmtDate(e.at)}</span>
                    <span className="font-semibold">{e.type}</span>
                    {Object.keys(e.detail).length > 0 && (
                      <span className="text-muted-foreground font-mono">{JSON.stringify(e.detail)}</span>
                    )}
                  </div>
                ))}
              </div>
          }
        </SectionCard>
      )}

      {job.recoveryActions.length === 0 && job.failureHistory.length === 0 && !isLoading && (
        <EmptyState msg="No recovery or failure events for this job." />
      )}
    </div>
  );
}

// ── Tab: Manifest ─────────────────────────────────────────────────────────────

function ManifestTab({ job }: { job: JobDetail }) {
  const { data: summary, isLoading } = useQuery({
    queryKey: ["manifest-summary", job.jobId],
    queryFn: () => fetchManifestSummary(job.jobId),
    retry: 1,
  });

  if (isLoading) return <EmptyState msg="Loading manifest summary…" />;

  return (
    <div className="space-y-4">
      {summary ? (
        <>
          <SectionCard title="Manifest Summary">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-4">
              <Kv label="Total Nodes"  value={String(summary.totalNodes)} />
              <Kv label="Completed"    value={String(summary.completed)} />
              <Kv label="Coverage"     value={`${summary.coveragePct}%`} />
              <Kv label="Last Updated" value={fmtDate(summary.lastUpdated)} />
            </div>
            <div className="h-2 bg-border rounded-full overflow-hidden">
              <div className="h-full bg-accent rounded-full" style={{ width: `${summary.coveragePct}%` }} />
            </div>
          </SectionCard>
          <div className="flex gap-2">
            <a
              href={manifestDownloadUrl(job.jobId)}
              download
              className="px-3 py-1.5 text-xs font-semibold border border-border rounded-lg hover:bg-muted transition-colors"
            >
              ↓ Download Manifest JSON
            </a>
            <a
              href={`/api/jobs/${encodeURIComponent(job.jobId)}/manifest`}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1.5 text-xs font-semibold border border-border rounded-lg hover:bg-muted transition-colors"
            >
              ↗ View in Browser
            </a>
          </div>
        </>
      ) : (
        <EmptyState msg="No manifest available yet. Manifest is generated after the crawl stage completes." />
      )}
    </div>
  );
}

// ── Tab: Differential ────────────────────────────────────────────────────────

function DifferentialTab({ job }: { job: JobDetail }) {
  const { data: diff, isLoading } = useQuery({
    queryKey: ["diff-run", job.jobId],
    queryFn: () => fetchJobDiffRun(job.jobId),
    retry: 1,
  });

  if (!job.diffMode && !diff) return (
    <div className="space-y-3">
      <EmptyState msg="This is not a differential crawl job. Run Diff from the Overview tab to create one." />
    </div>
  );
  if (isLoading) return <EmptyState msg="Loading differential data…" />;
  if (!diff) return <EmptyState msg="No differential results yet for this job." />;

  return (
    <div className="space-y-4">
      <SectionCard title="Diff Summary">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
          <div className="bg-accent/10 border border-accent/20 rounded-lg p-3 text-center">
            <p className="text-2xl font-bold text-accent">{diff.unchangedCount}</p>
            <p className="text-[10px] text-muted-foreground">Unchanged</p>
          </div>
          <div className="bg-primary/10 border border-primary/20 rounded-lg p-3 text-center">
            <p className="text-2xl font-bold text-primary">{diff.newCount}</p>
            <p className="text-[10px] text-muted-foreground">New</p>
          </div>
          <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 text-center">
            <p className="text-2xl font-bold text-yellow-500">{diff.changedCount}</p>
            <p className="text-[10px] text-muted-foreground">Changed</p>
          </div>
          <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3 text-center">
            <p className="text-2xl font-bold text-destructive">{diff.deletedCount}</p>
            <p className="text-[10px] text-muted-foreground">Deleted</p>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Kv label="Skip Rate"         value={`${diff.skipRatePercent.toFixed(1)}%`} />
          <Kv label="Bandwidth Saved"   value={fmtBytes(diff.bandwidthSavedBytes)} />
          <Kv label="Computed At"       value={fmtDate(diff.computedAt)} />
        </div>
      </SectionCard>

      {diff.changedUrls.length > 0 && (
        <SectionCard title={`Changed URLs (${diff.changedUrls.length})`}>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {diff.changedUrls.map((u, i) => (
              <div key={i} className="flex items-center gap-3 text-xs border-b border-border/50 pb-1">
                <span className={`flex-shrink-0 font-bold px-1.5 py-0.5 rounded text-[9px] ${
                  u.classification === "new" ? "bg-primary/15 text-primary" :
                  u.classification === "changed" ? "bg-yellow-500/15 text-yellow-500" :
                  "bg-destructive/15 text-destructive"
                }`}>
                  {u.classification.toUpperCase()}
                </span>
                <span className="font-mono truncate text-muted-foreground">{u.url}</span>
              </div>
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

// ── Tab: Website Prime ───────────────────────────────────────────────────────

function WebsitePrimeTab({ job, onAction }: {
  job: JobDetail;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onAction: (action: () => Promise<any>, label: string) => void;
}) {
  const { data: nav, isLoading: navLoading } = useQuery({
    queryKey: ["prime-index-nav", job.jobId],
    queryFn: () => fetchPrimeIndexNav(job.jobId),
    retry: 1,
  });

  // Poll generation + construction pipeline status from the DB.
  // In TanStack Query v5, refetchInterval receives a Query object — access data via query.state.data.
  const { data: genStatus } = useQuery({
    queryKey: ["generation-status", job.jobId],
    queryFn: () => fetchGenerationStatus(job.jobId),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    refetchInterval: (query: any) => {
      const d = query?.state?.data as import("@/lib/mission-api").GenerationStatus | null | undefined;
      return d?.generationStatus === "pending" || d?.constructionStatus === "pending" ? 4000 : false;
    },
    retry: 1,
  });

  function GenStatusBadge({ status }: { status: string | null | undefined }) {
    if (!status) return <span className="text-muted-foreground text-[10px]">—</span>;
    const cls =
      status === "success" ? "text-accent" :
      status === "failed"  ? "text-destructive" :
      status === "pending" ? "text-primary animate-pulse" :
      "text-muted-foreground";
    return <span className={`text-[10px] font-bold uppercase ${cls}`}>{status}</span>;
  }

  return (
    <div className="space-y-4">
      {/* Generation pipeline status */}
      <SectionCard title="Website Prime" action={
        job.status === "done" ? (
          <Btn size="xs" label="⚡ Generate" variant="primary"
            onClick={() => onAction(() => generateWebsitePrimeApi(job.jobId), "Generate Website Prime")}
          />
        ) : undefined
      }>
        {genStatus ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Generation Phase</p>
                <GenStatusBadge status={genStatus.generationStatus} />
                {genStatus.generationError && (
                  <p className="text-[10px] text-destructive mt-1 break-words">{genStatus.generationError}</p>
                )}
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Construction Phase</p>
                <GenStatusBadge status={genStatus.constructionStatus} />
                {genStatus.constructionError && (
                  <p className="text-[10px] text-destructive mt-1">{genStatus.constructionError}</p>
                )}
              </div>
            </div>
            {genStatus.hasOutput && (
              <div className="bg-accent/10 border border-accent/30 rounded-lg px-4 py-3">
                <p className="text-xs font-semibold text-accent mb-2">Site archive built</p>
                <div className="flex gap-2 flex-wrap">
                  <a href={`/api/jobs/${encodeURIComponent(job.jobId)}/prime-index/nav`} target="_blank" rel="noreferrer"
                    className="px-2.5 py-1.5 text-[11px] font-semibold border border-accent/40 text-accent rounded-lg hover:bg-accent/10 transition-colors">
                    ↗ Prime Index Nav
                  </a>
                  <a href={`/api/jobs/${encodeURIComponent(job.jobId)}/prime-index/search`} target="_blank" rel="noreferrer"
                    className="px-2.5 py-1.5 text-[11px] font-semibold border border-border rounded-lg hover:bg-muted transition-colors">
                    ↗ Search Index
                  </a>
                  <a href={`/api/jobs/${encodeURIComponent(job.jobId)}/prime/audit`} target="_blank" rel="noreferrer"
                    className="px-2.5 py-1.5 text-[11px] font-semibold border border-border rounded-lg hover:bg-muted transition-colors">
                    ↗ Prime Audit
                  </a>
                </div>
              </div>
            )}
            {job.downloadUrl && (
              <div className="bg-muted/30 border border-border rounded-lg px-4 py-3">
                <p className="text-xs font-semibold text-foreground mb-1">Site ZIP</p>
                <a href={job.downloadUrl} target="_blank" rel="noreferrer" className="text-xs font-mono text-primary underline break-all">
                  {job.downloadUrl}
                </a>
              </div>
            )}
          </div>
        ) : job.downloadUrl ? (
          <div className="space-y-3">
            <div className="bg-accent/10 border border-accent/30 rounded-lg px-4 py-3">
              <p className="text-xs font-semibold text-accent mb-1">Site archive ready</p>
              <a href={job.downloadUrl} target="_blank" rel="noreferrer" className="text-xs font-mono text-primary underline break-all">
                {job.downloadUrl}
              </a>
            </div>
          </div>
        ) : (
          <EmptyState msg="No generation run yet. Click ⚡ Generate to start the Website Prime pipeline." />
        )}
      </SectionCard>

      {navLoading && <EmptyState msg="Loading prime index…" />}
      {nav && nav.totalPages > 0 && (
        <SectionCard title={`Prime Index — ${nav.totalPages} pages`}>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {nav.routes.slice(0, 100).map((r, i) => (
              <div key={i} className="flex items-center gap-3 text-xs border-b border-border/40 pb-1">
                <span className="text-muted-foreground font-mono flex-shrink-0 text-[10px] px-1.5 py-0.5 bg-muted/40 rounded">{r.type}</span>
                <span className="font-mono text-muted-foreground flex-shrink-0">{r.path}</span>
                <span className="truncate text-foreground">{r.title}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <a href={`/api/jobs/${encodeURIComponent(job.jobId)}/prime-index/nav`} target="_blank" rel="noreferrer"
              className="px-3 py-1.5 text-xs font-semibold border border-border rounded-lg hover:bg-muted transition-colors">
              ↗ Full Nav JSON
            </a>
            <a href={`/api/jobs/${encodeURIComponent(job.jobId)}/prime-index/search`} target="_blank" rel="noreferrer"
              className="px-3 py-1.5 text-xs font-semibold border border-border rounded-lg hover:bg-muted transition-colors">
              ↗ Search Index
            </a>
          </div>
        </SectionCard>
      )}
    </div>
  );
}

// ── Tab: Certification ────────────────────────────────────────────────────────

function CertificationTab({ job, onAction }: {
  job: JobDetail;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onAction: (action: () => Promise<any>, label: string) => void;
}) {
  const [certId, setCertId] = useState<string | null>(null);
  const { data: report, isLoading: reportLoading } = useQuery({
    queryKey: ["cert-report", certId],
    queryFn: () => fetchCertReport(certId!),
    enabled: !!certId,
    retry: 1,
  });

  return (
    <div className="space-y-4">
      <SectionCard title="Production Certification" action={
        <Btn size="xs" label="▶ Run Certification" variant="primary"
          onClick={() => onAction(async () => {
            const result = await runProductionCertification(job.jobId);
            if (result.certId) setCertId(result.certId);
          }, "Production Certification")}
          disabled={job.status !== "done"}
        />
      }>
        <p className="text-sm text-muted-foreground">
          Runs the full E5 Production Certification engine against this job's output artifacts.
          Job must be in <code className="text-xs bg-muted px-1 rounded">done</code> status.
        </p>
        {job.status !== "done" && (
          <div className="mt-2 text-xs text-yellow-500 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
            Job must complete before certification can run.
          </div>
        )}
      </SectionCard>

      {certId && reportLoading && <EmptyState msg="Running certification…" />}
      {report && (
        <SectionCard title={`Certification Report — ${report.certId}`}>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-4">
            <Kv label="Score"        value={`${report.score}%`} />
            <Kv label="Status"       value={<StatusBadge status={report.status} />} />
            <Kv label="Generated"    value={fmtDate(report.generatedAt)} />
          </div>
          <div className="h-2 bg-border rounded-full overflow-hidden mb-4">
            <div className={`h-full rounded-full ${report.score >= 80 ? "bg-accent" : report.score >= 60 ? "bg-yellow-500" : "bg-destructive"}`}
              style={{ width: `${report.score}%` }} />
          </div>
          {report.issues.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Issues ({report.issues.length})</p>
              {report.issues.map((iss, i) => (
                <div key={i} className={`rounded-lg px-3 py-2 text-xs border ${
                  iss.severity === "critical" ? "bg-destructive/10 border-destructive/30 text-destructive" :
                  iss.severity === "high" ? "bg-orange-500/10 border-orange-500/30 text-orange-400" :
                  "bg-muted/30 border-border"
                }`}>
                  <span className="font-bold uppercase text-[10px]">{iss.severity} · {iss.dimension}</span>
                  <p className="mt-0.5">{iss.message}</p>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}
    </div>
  );
}

// ── Logs panel overlay ────────────────────────────────────────────────────────

function LogsOverlay({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const { data: logs = [], isLoading } = useQuery({
    queryKey: ["job-logs", jobId],
    queryFn: () => fetchJobLogs(jobId),
    refetchInterval: 4000,
  });

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-sm font-semibold">Pipeline Logs — {truncate(jobId, 24)}</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>
        <div className="overflow-y-auto flex-1 p-3 space-y-1 font-mono text-[10px]">
          {isLoading && <p className="text-muted-foreground">Loading…</p>}
          {!isLoading && logs.length === 0 && <p className="text-muted-foreground">No log events yet.</p>}
          {logs.map((l) => (
            <div key={l.id} className="flex gap-2 items-start">
              <span className="text-muted-foreground flex-shrink-0">{new Date(l.timestamp).toLocaleTimeString()}</span>
              <span className={`flex-shrink-0 font-bold uppercase ${l.severity === "error" || l.severity === "critical" ? "text-destructive" : l.severity === "warn" ? "text-yellow-500" : "text-primary"}`}>
                {l.subsystem}
              </span>
              <span className="break-all">{l.event}{Object.keys(l.payload ?? {}).length > 0 ? ` — ${JSON.stringify(l.payload)}` : ""}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function JobMissionControl() {
  const { jobId } = useParams<{ jobId: string }>();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [showLogs, setShowLogs] = useState(false);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const { connected } = useEventStreamStatus();

  // Scrape job detail
  const { data: job, isLoading: jobLoading } = useQuery({
    queryKey: ["job-detail", jobId],
    queryFn: () => fetchJobDetail(jobId ?? ""),
    enabled: !!jobId,
    refetchInterval: 5000,
  });

  // Job set (for child jobs)
  const { data: jobSets = [] } = useQuery({
    queryKey: ["job-sets"],
    queryFn: fetchJobSets,
    refetchInterval: 10000,
  });
  const jobSet = useMemo(() =>
    jobSets.find((s) => s.rootJobId === jobId || s.parentJob.jobId === jobId),
    [jobSets, jobId]
  );

  // Logs
  const { data: logs = [] } = useQuery({
    queryKey: ["job-logs", jobId],
    queryFn: () => fetchJobLogs(jobId ?? ""),
    enabled: !!jobId,
    refetchInterval: job?.status === "running" ? 5000 : 15000,
  });

  // System resources
  const { data: sysRes } = useQuery({
    queryKey: ["system-resources"],
    queryFn: fetchSystemResources,
    refetchInterval: 8000,
  });

  // Pipeline job (orchestrator)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: pipelineJobs = [] } = useListPipelineJobs({ query: { refetchInterval: 6000 } as any });
  const pipelineJobRef = useMemo(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pipelineJobs.find((pj) => (pj as any).underlyingJobId === jobId || pj.url === job?.seedUrl),
    [pipelineJobs, jobId, job?.seedUrl]
  );

  // Live pipeline job data
  const pipelineJobId = pipelineJobRef?.id ?? "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: pipelineJob } = useGetPipelineJob(pipelineJobId, { query: { enabled: !!pipelineJobId, refetchInterval: (q: any) => { const s = q.state.data?.status; return s === "running" || s === "pending" ? 3000 : 10000; } } as any });

  // SSE live updates — typed routing per event category (SSE fix)
  useEventStreamCallback(
    { subsystem: "pipeline" },
    useCallback((evt) => {
      const STAGE_EVENTS = [
        "crawl-started", "crawl-complete", "manifest-generated", "diff-computed",
        "intelligence-complete", "design-dna-complete", "visual-dna-complete",
        "stencil-generated", "website-prime-complete", "merge-complete",
        "deployment-plan-ready", "deployment-complete", "certification-complete",
        "rollback-complete", "stage-retrying",
      ];
      const LIFECYCLE_EVENTS = ["job-started", "job-complete", "job-failed", "job-cancelled"];
      const CONTROL_EVENTS   = [
        "pipeline-paused", "pipeline-resumed",
        "approval-requested", "approval-granted", "approval-rejected",
        "decision-made",
      ];

      if (STAGE_EVENTS.includes(evt.event)) {
        // Stage events: only refresh the pipeline job (stage status changed)
        if (pipelineJobId) void qc.invalidateQueries({ queryKey: getGetPipelineJobQueryKey(pipelineJobId) });
      } else if (LIFECYCLE_EVENTS.includes(evt.event)) {
        // Lifecycle events: full refresh — job state, sets, pipeline
        void qc.invalidateQueries({ queryKey: ["job-detail", jobId] });
        void qc.invalidateQueries({ queryKey: ["job-sets"] });
        if (pipelineJobId) void qc.invalidateQueries({ queryKey: getGetPipelineJobQueryKey(pipelineJobId) });
      } else if (CONTROL_EVENTS.includes(evt.event)) {
        // Control/approval events: refresh job detail and pipeline job
        void qc.invalidateQueries({ queryKey: ["job-detail", jobId] });
        if (pipelineJobId) void qc.invalidateQueries({ queryKey: getGetPipelineJobQueryKey(pipelineJobId) });
      }
    }, [qc, jobId, pipelineJobId])
  );

  const handleAction = useCallback(async (
    action: () => Promise<ControlResult | { jobId: string } | void>,
    label: string,
  ) => {
    try {
      await action();
      setToast({ text: `${label}: done`, ok: true });
      void qc.invalidateQueries({ queryKey: ["job-detail", jobId] });
      void qc.invalidateQueries({ queryKey: ["job-sets"] });
    } catch (err) {
      setToast({ text: `${label} failed: ${err instanceof Error ? err.message : String(err)}`, ok: false });
    } finally {
      setTimeout(() => setToast(null), 4500);
    }
  }, [qc, jobId]);

  if (!jobId) return <div className="p-8 text-center text-muted-foreground">No job ID in URL.</div>;
  if (jobLoading) return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <Spinner size={5} />
    </div>
  );
  if (!job) return (
    <div className="min-h-screen bg-background p-8 text-center">
      <p className="text-muted-foreground">Job not found: <code className="font-mono text-xs">{jobId}</code></p>
      <Link href="/jobs" className="text-primary text-sm mt-2 inline-block hover:underline">← Back to Job Control</Link>
    </div>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-background/90 backdrop-blur border-b border-border px-4 py-3">
        <div className="flex items-center gap-3 mb-1">
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${connected ? "bg-accent animate-pulse" : "bg-muted-foreground"}`} />
          <Link href="/jobs" className="text-xs text-muted-foreground hover:text-foreground">← Job Control</Link>
          <span className="text-muted-foreground">/</span>
          <span className="text-xs font-mono text-muted-foreground">{truncate(jobId, 16)}</span>
          <div className="ml-auto flex items-center gap-2">
            <StatusBadge status={job.status} />
            <Btn size="xs" label="📄 Logs" onClick={() => setShowLogs(true)} />
          </div>
        </div>
        <h1 className="text-sm font-bold truncate text-foreground/90">{job.seedUrl}</h1>
      </header>

      {/* Tab bar */}
      <div className="sticky top-[73px] z-10 bg-background/90 backdrop-blur border-b border-border">
        <div className="flex overflow-x-auto scrollbar-hide px-4">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-shrink-0 px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 py-4">
        {activeTab === "overview"      && <OverviewTab     job={job} pipelineJob={pipelineJob} sysRes={sysRes as SysRes | undefined} onAction={handleAction} />}
        {activeTab === "pipeline"      && <PipelineTab     job={job} pipelineJob={pipelineJob} logs={logs} sysRes={sysRes as SysRes | undefined} onAction={handleAction} />}
        {activeTab === "children"      && <ChildJobsTab    jobSet={jobSet} onAction={handleAction} />}
        {activeTab === "checkpoints"   && <CheckpointsTab  jobId={jobId} onAction={handleAction} />}
        {activeTab === "recovery"      && <RecoveryTab     job={job} onAction={handleAction} />}
        {activeTab === "manifest"      && <ManifestTab     job={job} />}
        {activeTab === "differential"  && <DifferentialTab job={job} />}
        {activeTab === "prime"         && <WebsitePrimeTab job={job} onAction={handleAction} />}
        {activeTab === "certification" && <CertificationTab job={job} onAction={handleAction} />}
      </div>

      {showLogs && <LogsOverlay jobId={jobId} onClose={() => setShowLogs(false)} />}

      {toast && (
        <div className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl text-sm font-medium border shadow-lg transition-opacity ${
          toast.ok ? "bg-accent/15 text-accent border-accent/40" : "bg-destructive/15 text-destructive border-destructive/40"
        }`}>
          {toast.text}
        </div>
      )}
    </div>
  );
}
