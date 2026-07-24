/**
 * Storage.tsx — Phase D3.4 R2 Memory Layer Dashboard
 *
 * Displays the permanent knowledge store status:
 * provider health, per-bucket metrics, and per-job artifact inventory.
 */
import { useState } from "react";
import {
  useStorageOverview,
  useJobStorageList,
  useJobManifest,
  formatBytes,
  type JobStorageSummary,
} from "@/hooks/use-job-storage";
import { useStorageStatus } from "@/hooks/use-storage";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Database, HardDrive, FileJson, Layers, RefreshCw,
  CheckCircle2, XCircle, AlertCircle, Clock, ChevronDown,
  ChevronRight, Archive, Cpu, Eye, Award, GitCompare,
  Palette, Type, Activity,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Helper: status badge
// ---------------------------------------------------------------------------

function ArtifactBadge({ present, label }: { present: boolean; label: string }) {
  return present ? (
    <span className="inline-flex items-center gap-1 text-xs font-mono text-green-400">
      <CheckCircle2 className="h-3 w-3" /> {label}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs font-mono text-muted-foreground/50">
      <XCircle className="h-3 w-3" /> {label}
    </span>
  );
}

function HealthBadge({ health }: { health: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    healthy:      { label: "HEALTHY",      cls: "border-green-500/40 text-green-400" },
    degraded:     { label: "DEGRADED",     cls: "border-yellow-500/40 text-yellow-400" },
    unconfigured: { label: "UNCONFIGURED", cls: "border-muted text-muted-foreground" },
  };
  const v = map[health] ?? map.unconfigured!;
  return (
    <Badge variant="outline" className={`font-mono text-xs ${v.cls}`}>
      {v.label}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  accent = false,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <Card className="bg-card/60 border-border/60">
      <CardContent className="pt-4 pb-3">
        <div className="flex items-start gap-3">
          <div className={`p-1.5 rounded ${accent ? "bg-primary/10" : "bg-muted/30"}`}>
            <Icon className={`h-4 w-4 ${accent ? "text-primary" : "text-muted-foreground"}`} />
          </div>
          <div>
            <p className="text-xs font-mono text-muted-foreground">{label}</p>
            <p className="text-lg font-bold font-mono leading-tight">{value}</p>
            {sub && <p className="text-xs text-muted-foreground/70 mt-0.5">{sub}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Manifest detail panel
// ---------------------------------------------------------------------------

function ManifestPanel({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const { data: manifest, isLoading } = useJobManifest(jobId);

  if (isLoading) {
    return (
      <div className="col-span-full bg-card/80 border border-border rounded-lg p-4">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <RefreshCw className="h-4 w-4 animate-spin" /> Loading manifest…
        </div>
      </div>
    );
  }

  if (!manifest) {
    return (
      <div className="col-span-full bg-card/80 border border-border rounded-lg p-4">
        <p className="text-sm text-muted-foreground font-mono">No manifest found in R2 for this job.</p>
        <Button variant="ghost" size="sm" className="mt-2" onClick={onClose}>Close</Button>
      </div>
    );
  }

  const stages = Object.values(manifest.stages);

  return (
    <div className="col-span-full bg-card/80 border border-border/60 rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-mono text-muted-foreground">JOB_MANIFEST · {manifest.jobId.slice(0, 8)}…</p>
          <p className="text-sm font-mono font-medium truncate max-w-lg">{manifest.seedUrl}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>

      {/* Artifact flags */}
      <div className="flex flex-wrap gap-3">
        <ArtifactBadge present={manifest.artifacts.manifest      === "present"} label="Manifest" />
        <ArtifactBadge present={manifest.artifacts.websitePrime  === "present"} label="Website Prime" />
        <ArtifactBadge present={manifest.artifacts.siteZip       === "present"} label="Site ZIP" />
        <ArtifactBadge present={manifest.artifacts.certification  === "present"} label="Certification" />
        <ArtifactBadge present={manifest.artifacts.differential  === "present"} label="Differential" />
        <ArtifactBadge present={manifest.artifacts.visualDna     === "present"} label="Visual DNA" />
        <ArtifactBadge present={manifest.artifacts.brandDna      === "present"} label="Brand DNA" />
        {manifest.artifacts.checkpoints > 0 && (
          <span className="inline-flex items-center gap-1 text-xs font-mono text-blue-400">
            <Archive className="h-3 w-3" /> {manifest.artifacts.checkpoints} checkpoint{manifest.artifacts.checkpoints !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Stage grid */}
      {stages.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
          {stages.map((s) => (
            <div key={s.stageId} className="bg-muted/20 rounded p-2 text-xs font-mono">
              <div className="flex items-center gap-1 mb-1">
                {s.status === "complete" ? (
                  <CheckCircle2 className="h-3 w-3 text-green-400" />
                ) : s.status === "failed" ? (
                  <XCircle className="h-3 w-3 text-destructive" />
                ) : s.status === "skipped" ? (
                  <Clock className="h-3 w-3 text-muted-foreground" />
                ) : (
                  <Activity className="h-3 w-3 text-yellow-400" />
                )}
                <span className="truncate">{s.stageId}</span>
              </div>
              {s.durationMs != null && (
                <p className="text-muted-foreground">{(s.durationMs / 1000).toFixed(1)}s</p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="text-xs text-muted-foreground font-mono">
        Schema {manifest.schemaVersion} · Updated {new Date(manifest.updatedAt).toLocaleString()}
        {" · "}~{manifest.storageStats.estimatedFileCount} files · {formatBytes(manifest.storageStats.estimatedBytes)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Job row
// ---------------------------------------------------------------------------

function JobRow({
  job,
  isExpanded,
  onToggle,
}: {
  job: JobStorageSummary;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const statusColor: Record<string, string> = {
    complete:  "text-green-400",
    failed:    "text-destructive",
    running:   "text-yellow-400",
    recovered: "text-blue-400",
  };

  return (
    <tr
      className="border-b border-border/30 hover:bg-muted/10 cursor-pointer transition-colors"
      onClick={onToggle}
    >
      <td className="py-2 px-3">
        {isExpanded
          ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        }
      </td>
      <td className="py-2 px-2 font-mono text-xs text-muted-foreground">
        {job.jobId.slice(0, 8)}…
      </td>
      <td className="py-2 px-2 text-xs font-mono max-w-[200px] truncate">
        {job.seedUrl}
      </td>
      <td className="py-2 px-2 text-xs font-mono text-right">{job.fileCount}</td>
      <td className="py-2 px-2 text-xs font-mono text-right">{formatBytes(job.totalBytes)}</td>
      <td className="py-2 px-3 text-center">
        {job.manifestPresent
          ? <CheckCircle2 className="h-3.5 w-3.5 text-green-400 inline" />
          : <XCircle     className="h-3.5 w-3.5 text-muted-foreground/40 inline" />}
      </td>
      <td className="py-2 px-3 text-center">
        {job.websitePrimePresent
          ? <CheckCircle2 className="h-3.5 w-3.5 text-green-400 inline" />
          : <XCircle     className="h-3.5 w-3.5 text-muted-foreground/40 inline" />}
      </td>
      <td className="py-2 px-3 text-center">
        {job.certificationPresent
          ? <CheckCircle2 className="h-3.5 w-3.5 text-green-400 inline" />
          : <XCircle     className="h-3.5 w-3.5 text-muted-foreground/40 inline" />}
      </td>
      <td className="py-2 px-3 text-center">
        {job.differentialPresent
          ? <CheckCircle2 className="h-3.5 w-3.5 text-green-400 inline" />
          : <XCircle     className="h-3.5 w-3.5 text-muted-foreground/40 inline" />}
      </td>
      <td className="py-2 px-3 text-center">
        {job.visualDnaPresent
          ? <CheckCircle2 className="h-3.5 w-3.5 text-green-400 inline" />
          : <XCircle     className="h-3.5 w-3.5 text-muted-foreground/40 inline" />}
      </td>
      <td className="py-2 px-2 text-xs font-mono text-center">
        {job.checkpointCount > 0
          ? <span className="text-blue-400">{job.checkpointCount}</span>
          : <span className="text-muted-foreground/40">—</span>}
      </td>
      <td className={`py-2 px-2 text-xs font-mono ${statusColor[job.pipelineStatus] ?? "text-muted-foreground"}`}>
        {job.pipelineStatus}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Storage() {
  const { data: overview, isLoading: overviewLoading, refetch: refetchOverview } = useStorageOverview();
  const { data: jobs = [], isLoading: jobsLoading, refetch: refetchJobs } = useJobStorageList();
  const { data: status } = useStorageStatus();
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);

  const isRefreshing = overviewLoading || jobsLoading;

  function toggleJob(jobId: string) {
    setExpandedJobId((prev) => (prev === jobId ? null : jobId));
  }

  function handleRefresh() {
    void refetchOverview();
    void refetchJobs();
  }

  const configured = overview?.configured ?? status?.configured ?? false;

  return (
    <div className="space-y-6 max-w-6xl mx-auto">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight font-mono text-primary flex items-center gap-2">
            <HardDrive className="h-6 w-6" /> R2_MEMORY_LAYER
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Permanent knowledge store · Every crawl leaves a complete reusable artifact package
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* ── Provider status ─────────────────────────────────────────────────── */}
      <Card className="border-l-4 border-l-primary bg-card/50">
        <CardContent className="pt-4 pb-3">
          {overviewLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <RefreshCw className="h-4 w-4 animate-spin" /> Querying storage provider…
            </div>
          ) : configured ? (
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-primary" />
                <div>
                  <p className="text-sm font-mono font-medium text-primary">PROVIDER READY</p>
                  <p className="text-xs text-muted-foreground">
                    {overview?.provider?.toUpperCase() ?? "R2"} · bucket: <span className="font-mono">{overview?.bucketName ?? "—"}</span>
                  </p>
                </div>
              </div>
              <div className="ml-auto flex items-center gap-3">
                <HealthBadge health={overview?.storageHealth ?? "unconfigured"} />
                {overview?.lastActivity && (
                  <span className="text-xs font-mono text-muted-foreground">
                    last write: {new Date(overview.lastActivity).toLocaleString()}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <AlertCircle className="h-5 w-5 text-yellow-500" />
              <div>
                <p className="text-sm font-mono font-medium text-yellow-500">STORAGE NOT CONFIGURED</p>
                <p className="text-xs text-muted-foreground">
                  Set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_ACCOUNT_ID, and R2_PUBLIC_BASE_URL to enable persistent storage.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Overview stats ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={Database}
          label="FILES_STORED"
          value={overview?.totalFiles?.toLocaleString() ?? "—"}
          sub="objects in bucket"
          accent
        />
        <StatCard
          icon={HardDrive}
          label="TOTAL_STORAGE"
          value={overview ? formatBytes(overview.totalBytes) : "—"}
          sub="across all job-sets"
        />
        <StatCard
          icon={Layers}
          label="ARTIFACTS_GENERATED"
          value={overview?.artifactsGenerated?.toLocaleString() ?? "—"}
          sub="manifests + primes + certs"
        />
        <StatCard
          icon={Archive}
          label="JOB_SETS"
          value={overview?.jobCount?.toLocaleString() ?? "—"}
          sub="unique crawl packages"
        />
      </div>

      {/* ── Storage hierarchy legend ─────────────────────────────────────────── */}
      <Card className="bg-card/40 border-border/40">
        <CardHeader className="pb-2 pt-4">
          <CardTitle className="text-xs font-mono text-muted-foreground flex items-center gap-2">
            <FileJson className="h-3.5 w-3.5" /> STORAGE_HIERARCHY
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs font-mono text-muted-foreground">
            {[
              { icon: Layers,      label: "raw/",          desc: "HTML · headers · URLs" },
              { icon: FileJson,    label: "normalized/",   desc: "DOM · CSS · JS JSON" },
              { icon: FileJson,    label: "manifest/",     desc: "artifact index" },
              { icon: GitCompare,  label: "differential/", desc: "changed · deleted · new" },
              { icon: Eye,         label: "visual-dna/",   desc: "layouts · tokens · colors" },
              { icon: Type,        label: "brand-dna/",    desc: "typography · spacing" },
              { icon: Cpu,         label: "website-prime/",desc: "site.zip · preview" },
              { icon: Award,       label: "certification/",desc: "readiness report" },
              { icon: Archive,     label: "checkpoints/",  desc: "resume state" },
              { icon: Activity,    label: "logs/",         desc: "pipeline · recovery" },
              { icon: FileJson,    label: "reports/",      desc: "execution summary" },
              { icon: Palette,     label: "stages/",       desc: "per-stage snapshots" },
            ].map(({ icon: Icon, label, desc }) => (
              <div key={label} className="flex items-center gap-1.5">
                <Icon className="h-3 w-3 text-primary/60 shrink-0" />
                <span className="text-primary/80">{label}</span>
                <span className="text-muted-foreground/60 truncate">{desc}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Job-level storage table ──────────────────────────────────────────── */}
      <Card className="bg-card/50 border-border/60">
        <CardHeader className="pb-2 pt-4">
          <CardTitle className="text-xs font-mono text-muted-foreground flex items-center gap-2">
            <Database className="h-3.5 w-3.5" /> JOB_STORAGE_INDEX
            {jobsLoading && <RefreshCw className="h-3 w-3 animate-spin ml-1" />}
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-3 overflow-x-auto">
          {jobs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm font-mono">
              {jobsLoading ? "Loading job index…" : "No job artifacts found in R2. Run a crawl to populate the memory layer."}
            </div>
          ) : (
            <table className="w-full text-left">
              <thead>
                <tr className="text-xs font-mono text-muted-foreground/60 border-b border-border/40">
                  <th className="py-1.5 px-3 w-6" />
                  <th className="py-1.5 px-2">JOB_ID</th>
                  <th className="py-1.5 px-2">URL</th>
                  <th className="py-1.5 px-2 text-right">FILES</th>
                  <th className="py-1.5 px-2 text-right">SIZE</th>
                  <th className="py-1.5 px-3 text-center">MNFST</th>
                  <th className="py-1.5 px-3 text-center">PRIME</th>
                  <th className="py-1.5 px-3 text-center">CERT</th>
                  <th className="py-1.5 px-3 text-center">DIFF</th>
                  <th className="py-1.5 px-3 text-center">VIS</th>
                  <th className="py-1.5 px-2 text-center">CHKPT</th>
                  <th className="py-1.5 px-2">STATUS</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <>
                    <JobRow
                      key={job.jobId}
                      job={job}
                      isExpanded={expandedJobId === job.jobId}
                      onToggle={() => toggleJob(job.jobId)}
                    />
                    {expandedJobId === job.jobId && (
                      <tr key={`${job.jobId}-detail`}>
                        <td colSpan={12} className="px-3 pb-2">
                          <ManifestPanel
                            jobId={job.jobId}
                            onClose={() => setExpandedJobId(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* ── Crash recovery note ──────────────────────────────────────────────── */}
      <Card className="bg-muted/10 border-border/30">
        <CardContent className="pt-4 pb-3">
          <div className="flex gap-3">
            <Activity className="h-4 w-4 text-primary shrink-0 mt-0.5" />
            <div className="text-xs text-muted-foreground space-y-1">
              <p className="font-mono font-medium text-foreground/70">CRASH_RECOVERY_PROTOCOL</p>
              <p>On API restart: active jobs are recovered from the database. Completed pipeline stages are recovered from R2 under each <span className="font-mono text-primary/70">job-set-{"{jobId}"}/</span> prefix. The pipeline resumes from the latest checkpoint without repeating completed work.</p>
              <p>Website Prime regeneration, differential reruns, and certification re-evaluation can all be triggered directly from stored R2 artifacts — no fresh crawl required.</p>
            </div>
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
