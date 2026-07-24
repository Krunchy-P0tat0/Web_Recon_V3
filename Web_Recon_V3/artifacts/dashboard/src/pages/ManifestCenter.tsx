import { useMemo, useState, useCallback } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJobSets, flattenJobSets } from "@/lib/jobs-api";
import { fetchManifestSummary, fetchManifestJson, manifestDownloadUrl } from "@/lib/manifest-api";
import { useEventStreamStatus, useEventStreamCallback } from "@/hooks/useEventStream";

// ── Formatting helpers ───────────────────────────────────────────────────────

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "—";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</p>
      <p className={`text-lg font-bold mt-0.5 ${accent ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}

// ── JSON tree explorer ────────────────────────────────────────────────────────

function JsonNode({ label, value, depth }: { label: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const isObj = value !== null && typeof value === "object";
  const isArr = Array.isArray(value);

  if (!isObj) {
    const display =
      typeof value === "string"
        ? `"${value.length > 120 ? value.slice(0, 120) + "…" : value}"`
        : String(value);
    return (
      <div className="flex gap-1.5 text-[11px] font-mono py-0.5" style={{ paddingLeft: depth * 14 }}>
        <span className="text-primary flex-shrink-0">{label}:</span>
        <span className="text-muted-foreground break-all">{display}</span>
      </div>
    );
  }

  const entries = isArr ? (value as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  const summary = isArr ? `Array(${entries.length})` : `Object(${entries.length})`;

  return (
    <div style={{ paddingLeft: depth * 14 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[11px] font-mono py-0.5 hover:text-foreground text-left w-full"
      >
        <span className="text-muted-foreground w-3 flex-shrink-0">{open ? "▾" : "▸"}</span>
        <span className="text-primary">{label}:</span>
        <span className="text-muted-foreground">{summary}</span>
      </button>
      {open && (
        <div>
          {entries.slice(0, 200).map(([k, v]) => (
            <JsonNode key={k} label={k} value={v} depth={depth + 1} />
          ))}
          {entries.length > 200 && (
            <p className="text-[10px] text-muted-foreground italic" style={{ paddingLeft: (depth + 1) * 14 }}>
              …{entries.length - 200} more
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ManifestExplorer({ jobId }: { jobId: string }) {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["manifest-json", jobId],
    queryFn: () => fetchManifestJson(jobId),
    enabled: expanded,
  });

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Manifest JSON Explorer</h3>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="px-2.5 py-1 rounded-lg text-[11px] font-semibold border border-border hover:bg-background transition-colors"
        >
          {expanded ? "Collapse" : "Load & Explore"}
        </button>
      </div>
      {expanded && (
        <div className="max-h-96 overflow-y-auto bg-background rounded-lg p-2 border border-border">
          {isLoading && <p className="text-xs text-muted-foreground p-2">Loading manifest…</p>}
          {error && <p className="text-xs text-destructive p-2">Failed to load manifest JSON.</p>}
          {data != null && <JsonNode label="manifest" value={data} depth={0} />}
        </div>
      )}
    </div>
  );
}

// ── Manifest detail panel ─────────────────────────────────────────────────────

function ManifestDetail({ jobId }: { jobId: string }) {
  const { data: summary, isLoading, error } = useQuery({
    queryKey: ["manifest-summary", jobId],
    queryFn: () => fetchManifestSummary(jobId),
    refetchInterval: 8000,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground text-center py-10">Loading manifest…</p>;
  if (error || !summary) {
    return (
      <div className="text-center py-10 text-muted-foreground text-sm">
        <p>No manifest snapshot found for this job yet.</p>
      </div>
    );
  }

  const validationPassed = summary.pathConsistencyCheck === true;
  const validationKnown = summary.pathConsistencyCheck !== null;

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-xl p-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold break-all">{summary.seedUrl}</p>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{summary.manifestStatus}</span>
        </div>
        <div>
          <div className="flex justify-between text-[11px] text-muted-foreground mb-1">
            <span>Manifest progress</span>
            <span>{summary.completedNodes}/{summary.totalNodes} nodes — {summary.progressPercent}%</span>
          </div>
          <div className="h-1.5 bg-border rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${summary.progressPercent}%` }} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Node count" value={String(summary.totalNodes)} />
        <Stat label="Completed nodes" value={String(summary.completedNodes)} accent="text-accent" />
        <Stat label="Schema version" value={summary.schemaVersion} />
        <Stat label="Render source" value={summary.renderSource ?? "—"} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Images" value={String(summary.totalImages)} />
        <Stat label="Videos" value={String(summary.totalVideos)} />
        <Stat
          label="Validation status"
          value={validationKnown ? (validationPassed ? "Passed" : "Failed") : "Unknown"}
          accent={validationKnown ? (validationPassed ? "text-accent" : "text-destructive") : "text-muted-foreground"}
        />
        <Stat label="Last updated" value={new Date(summary.updatedAt).toLocaleTimeString()} />
      </div>

      <div className="bg-card border border-border rounded-xl p-4 space-y-2">
        <h3 className="text-sm font-semibold">Node status breakdown</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
          {Object.entries(summary.byStatus).map(([status, count]) => (
            <div key={status} className="flex justify-between bg-background rounded-lg px-2.5 py-1.5 border border-border">
              <span className="text-muted-foreground capitalize">{status.replace("_", " ")}</span>
              <span className="font-semibold">{count}</span>
            </div>
          ))}
        </div>
        <h3 className="text-sm font-semibold pt-2">Node type breakdown</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
          {Object.entries(summary.byType).map(([type, count]) => (
            <div key={type} className="flex justify-between bg-background rounded-lg px-2.5 py-1.5 border border-border">
              <span className="text-muted-foreground capitalize">{type}</span>
              <span className="font-semibold">{count}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-4 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Export manifest</h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">Download the full portable manifest JSON for this job.</p>
        </div>
        <a
          href={manifestDownloadUrl(jobId)}
          download
          className="px-3 py-2 rounded-lg text-[11px] font-semibold border border-border text-foreground hover:bg-background transition-colors flex-shrink-0"
        >
          Export JSON
        </a>
      </div>

      <ManifestExplorer jobId={jobId} />
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ManifestCenter() {
  const { connected } = useEventStreamStatus();
  const qc = useQueryClient();

  // SSE: refresh manifest data when a manifest is generated (SSE fix)
  useEventStreamCallback(
    { subsystem: "pipeline", event: "manifest-generated" },
    useCallback(() => {
      void qc.invalidateQueries({ queryKey: ["job-sets"] });
    }, [qc]),
  );
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const { data: jobSets = [] } = useQuery({ queryKey: ["job-sets"], queryFn: fetchJobSets, refetchInterval: 10000 });
  const jobs = useMemo(
    () => flattenJobSets(jobSets).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [jobSets],
  );

  const effectiveJobId = selectedJobId ?? jobs[0]?.jobId ?? null;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 bg-background/90 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-3">
        <div className={`w-2 h-2 rounded-full flex-shrink-0 animate-pulse-dot ${connected ? "bg-accent" : "bg-muted-foreground"}`} />
        <h1 className="text-base font-bold tracking-tight">Manifest Center</h1>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <Link href="/differential" className="text-muted-foreground hover:text-foreground">Differential Center</Link>
          <Link href="/recovery" className="text-muted-foreground hover:text-foreground">Recovery</Link>
          <Link href="/jobs" className="text-muted-foreground hover:text-foreground">Job Control</Link>
          <Link href="/" className="text-muted-foreground hover:text-foreground">← Pipeline</Link>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-4 space-y-4">
        <div className="bg-card border border-border rounded-xl p-3">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">Select job</p>
          {jobs.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">No jobs yet. Start a pipeline run first.</p>
          ) : (
            <select
              value={effectiveJobId ?? ""}
              onChange={(e) => setSelectedJobId(e.target.value || null)}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-primary transition-colors"
            >
              {jobs.map((j) => (
                <option key={j.jobId} value={j.jobId}>
                  {truncate(j.seedUrl, 40)} — {j.status} · {j.jobId.slice(0, 8)}
                </option>
              ))}
            </select>
          )}
        </div>

        {effectiveJobId && <ManifestDetail key={effectiveJobId} jobId={effectiveJobId} />}
      </div>
    </div>
  );
}
