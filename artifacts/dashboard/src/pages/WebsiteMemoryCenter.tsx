/**
 * WebsiteMemoryCenter.tsx — Phase D4.4 Persistent Memory & Differential UX
 *
 * Exposes D4.1 Website Memory and D4.3 Intelligent Differential Execution
 * Planner through Mission Control. Enter a URL to inspect existing knowledge,
 * then choose an execution mode before launching the pipeline.
 */

import { useState, useCallback } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchExecutionPlan,
  orchestrateWithMode,
  type ExecutionPlan,
  type ExecutionMode,
  type PipelineStageKey,
  type ModuleStatusDetail,
} from "@/lib/planner-api";
import { useEventStreamCallback } from "@/hooks/useEventStream";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTs(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "—";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ---------------------------------------------------------------------------
// Stage metadata
// ---------------------------------------------------------------------------

const STAGE_META: Record<PipelineStageKey, { icon: string; label: string }> = {
  "crawl":           { icon: "🌐", label: "Crawl" },
  "manifest":        { icon: "📋", label: "Manifest" },
  "diff":            { icon: "🔀", label: "Diff" },
  "intelligence":    { icon: "🧠", label: "Intelligence" },
  "design-dna":      { icon: "🎨", label: "Design DNA" },
  "visual-dna":      { icon: "👁️", label: "Visual DNA" },
  "stencil":         { icon: "🖼️", label: "Stencil" },
  "website-prime":   { icon: "⚡", label: "Website Prime" },
  "merge":           { icon: "🔧", label: "Merge" },
  "deployment-plan": { icon: "📐", label: "Deployment Plan" },
  "deploy":          { icon: "🚀", label: "Deploy" },
  "certification":   { icon: "✅", label: "Certification" },
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse bg-muted rounded-md ${className}`} />;
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</p>
      <p className={`text-base font-bold mt-0.5 truncate ${accent ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}

type ModuleStatusBadgeProps = { status: string };
function ModuleStatusBadge({ status }: ModuleStatusBadgeProps) {
  const map: Record<string, string> = {
    current:  "bg-accent/15 text-accent border-accent/40",
    outdated: "bg-yellow-500/15 text-yellow-400 border-yellow-500/40",
    missing:  "bg-destructive/15 text-destructive border-destructive/40",
  };
  const label: Record<string, string> = { current: "✓ Current", outdated: "⚠ Outdated", missing: "✗ Missing" };
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border flex-shrink-0 ${map[status] ?? "bg-muted text-muted-foreground border-border"}`}>
      {label[status] ?? status}
    </span>
  );
}

function SectionHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-bold text-foreground">{title}</h2>
      {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Knowledge Modules Grid
// ---------------------------------------------------------------------------

function KnowledgeModulesGrid({ modules }: { modules: ModuleStatusDetail[] }) {
  return (
    <div className="space-y-2">
      {modules.map((m) => {
        const meta = STAGE_META[m.stage] ?? { icon: "•", label: m.stage };
        return (
          <div
            key={m.stage}
            className="bg-card border border-border rounded-xl p-3 flex items-center gap-3"
          >
            <span className="text-lg w-7 text-center flex-shrink-0">{meta.icon}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">{meta.label}</span>
                <ModuleStatusBadge status={m.status} />
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5 flex gap-3 flex-wrap">
                {m.generatedAt && <span>Generated {formatRelative(m.generatedAt)}</span>}
                {m.storedGeneratorVersion && <span>Engine: {m.storedGeneratorVersion}</span>}
                {m.health && m.health !== "missing" && <span>Health: {m.health}</span>}
              </div>
            </div>
            <div className="flex-shrink-0 text-right">
              {m.completed ? (
                <span className="text-[10px] text-accent font-semibold">COMPLETE</span>
              ) : (
                <span className="text-[10px] text-muted-foreground">NOT RUN</span>
              )}
              {m.storedVersion != null && (
                <div className="text-[10px] text-muted-foreground">v{m.storedVersion}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Execution Plan Preview
// ---------------------------------------------------------------------------

const ALL_STAGES: PipelineStageKey[] = [
  "crawl", "manifest", "diff", "intelligence", "design-dna",
  "visual-dna", "stencil", "website-prime", "merge",
  "deployment-plan", "deploy", "certification",
];

function ExecutionPlanPreview({ plan }: { plan: ExecutionPlan }) {
  const willRun = new Set(plan.recommendedStages);
  return (
    <div className="space-y-3">
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h3 className="text-sm font-semibold">Stage-by-Stage Plan</h3>
          <span className="text-[11px] text-muted-foreground">
            {plan.estimatedWork.stagesToRun} / {plan.estimatedWork.totalStages} stages will run
          </span>
        </div>
        <div className="space-y-1.5">
          {ALL_STAGES.map((stage) => {
            const meta = STAGE_META[stage] ?? { icon: "•", label: stage };
            const runs = willRun.has(stage);
            const isMissing = plan.missingModules.includes(stage);
            const isOutdated = plan.outdatedModules.includes(stage);
            const isDownstream = plan.affectedDownstreamModules.includes(stage);
            const isReusable = plan.reusableArtifacts.includes(stage);
            let badge = "";
            let badgeCls = "";
            if (!runs) { badge = "SKIP"; badgeCls = "text-muted-foreground"; }
            else if (isMissing) { badge = "MISSING"; badgeCls = "text-destructive"; }
            else if (isOutdated) { badge = "UPGRADE"; badgeCls = "text-yellow-400"; }
            else if (isDownstream) { badge = "REBUILD"; badgeCls = "text-primary"; }
            else { badge = "RUN"; badgeCls = "text-accent"; }
            return (
              <div
                key={stage}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-[12px] transition-colors ${runs ? "bg-primary/5 border border-primary/15" : "opacity-50"}`}
              >
                <span>{meta.icon}</span>
                <span className="flex-1 font-medium">{meta.label}</span>
                {isReusable && !runs && (
                  <span className="text-[10px] text-accent/70">♻ reuse</span>
                )}
                <span className={`font-bold text-[10px] uppercase ${badgeCls}`}>{badge}</span>
                {runs ? (
                  <span className="w-3 h-3 rounded-full bg-accent/20 border border-accent/50 flex-shrink-0" />
                ) : (
                  <span className="w-3 h-3 rounded-full bg-muted border border-border flex-shrink-0" />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {plan.reasoning && (
        <div className="bg-card border border-border rounded-xl p-4">
          <h3 className="text-sm font-semibold mb-2">Planner Reasoning</h3>
          <p className="text-[12px] text-muted-foreground leading-relaxed">{plan.reasoning}</p>
        </div>
      )}

      {plan.reusableArtifacts.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-4">
          <h3 className="text-sm font-semibold mb-2">Reusable Artifacts ({plan.reusableArtifacts.length})</h3>
          <div className="flex flex-wrap gap-1.5">
            {plan.reusableArtifacts.map((a) => (
              <span key={a} className="px-2 py-0.5 bg-accent/10 text-accent border border-accent/30 rounded-full text-[10px] font-semibold">
                {a}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action buttons
// ---------------------------------------------------------------------------

interface ActionButtonProps {
  label: string;
  description: string;
  mode: ExecutionMode;
  icon: string;
  disabled?: boolean;
  recommended?: boolean;
  onClick: (mode: ExecutionMode) => void;
  loading?: boolean;
}

function ActionButton({ label, description, mode, icon, disabled, recommended, onClick, loading }: ActionButtonProps) {
  return (
    <button
      disabled={disabled || loading}
      onClick={() => onClick(mode)}
      className={`relative w-full text-left p-4 rounded-xl border transition-all duration-200 ${
        disabled
          ? "opacity-40 cursor-not-allowed border-border bg-card"
          : recommended
          ? "border-primary/50 bg-primary/5 hover:bg-primary/10 cursor-pointer"
          : "border-border bg-card hover:bg-muted/30 cursor-pointer"
      }`}
    >
      {recommended && (
        <span className="absolute top-2 right-2 px-1.5 py-0.5 bg-primary text-primary-foreground rounded-full text-[9px] font-bold uppercase tracking-wide">
          Recommended
        </span>
      )}
      <div className="flex items-start gap-3">
        <span className="text-xl mt-0.5">{icon}</span>
        <div>
          <div className="text-sm font-semibold">{label}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">{description}</div>
        </div>
        {loading && (
          <div className="ml-auto w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin flex-shrink-0 mt-1" />
        )}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Website Change Summary
// ---------------------------------------------------------------------------

function WebsiteChangeSummaryPanel({ summary }: { summary: NonNullable<ExecutionPlan["websiteChangeSummary"]> }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Website Changes</h3>
        {summary.detected ? (
          <span className="px-2 py-0.5 bg-primary/15 text-primary border border-primary/40 rounded-full text-[10px] font-bold">CHANGES DETECTED</span>
        ) : (
          <span className="px-2 py-0.5 bg-accent/15 text-accent border border-accent/40 rounded-full text-[10px] font-bold">NO CHANGES</span>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Added URLs" value={String(summary.urls.added.length)} accent="text-accent" />
        <Stat label="Removed URLs" value={String(summary.urls.removed.length)} accent="text-destructive" />
        <Stat label="Changed URLs" value={String(summary.urls.changed.length)} accent="text-primary" />
        <Stat label="Unchanged" value={String(summary.urls.unchanged.length)} />
      </div>
      {summary.baselineJobId && (
        <p className="text-[11px] text-muted-foreground">
          Compared against job <span className="font-mono">{truncate(summary.baselineJobId, 20)}</span>
          {" · "}compared at {formatTs(summary.computedAt)}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recovery Panel
// ---------------------------------------------------------------------------

function RecoveryPanel({ recovery }: { recovery: ExecutionPlan["recoveryOptions"] }) {
  if (!recovery.canResume) return null;
  return (
    <div className="bg-yellow-500/5 border border-yellow-500/30 rounded-xl p-4 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-base">⏸</span>
        <h3 className="text-sm font-semibold text-yellow-400">Interrupted Pipeline Detected</h3>
      </div>
      <div className="text-[12px] text-muted-foreground space-y-1">
        {recovery.lastCheckpointStage && (
          <p>Last checkpoint: <span className="font-semibold text-foreground">{recovery.lastCheckpointStage}</span></p>
        )}
        {recovery.checkpointJobId && (
          <p>Checkpoint job: <span className="font-mono text-foreground">{truncate(recovery.checkpointJobId, 24)}</span></p>
        )}
        {recovery.resumeInstructions && (
          <p className="text-yellow-400/80">{recovery.resumeInstructions}</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function WebsiteMemoryCenter() {
  const [inputUrl, setInputUrl] = useState("");
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [launchingMode, setLaunchingMode] = useState<ExecutionMode | null>(null);
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  // Refresh plan when a pipeline SSE event arrives for this domain
  useEventStreamCallback(
    { subsystem: "pipeline" },
    useCallback(() => {
      if (activeUrl) {
        void qc.invalidateQueries({ queryKey: ["execution-plan", activeUrl] });
      }
    }, [qc, activeUrl]),
  );

  const { data: plan, isLoading, error, isFetching } = useQuery<ExecutionPlan>({
    queryKey: ["execution-plan", activeUrl],
    queryFn: () => fetchExecutionPlan(activeUrl!),
    enabled: !!activeUrl,
    staleTime: 15_000,
    retry: false,
  });

  const launchMutation = useMutation({
    mutationFn: ({ mode }: { mode: ExecutionMode }) =>
      orchestrateWithMode(activeUrl!, mode),
    onSuccess: (data) => {
      setLaunchingMode(null);
      void qc.invalidateQueries({ queryKey: ["execution-plan", activeUrl] });
      // Navigate to the new job
      navigate(`/jobs/${data.jobId}`);
    },
    onError: () => setLaunchingMode(null),
  });

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = inputUrl.trim();
    if (!trimmed) return;
    const url = trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
    setActiveUrl(url);
  }

  function handleLaunch(mode: ExecutionMode) {
    if (!activeUrl) return;
    setLaunchingMode(mode);
    launchMutation.mutate({ mode });
  }

  const memExists = plan?.memoryStatus.exists ?? false;
  const recMode = plan?.executionMode;

  // Determine which actions are available
  const canResume = plan?.recoveryOptions.canResume ?? false;
  const hasDiff = memExists && (plan?.memoryStatus.lastCrawlAt ?? null) !== null;
  const hasMemory = memExists;

  return (
    <div className="min-h-full bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card/50 px-6 py-4">
        <h1 className="text-lg font-bold tracking-tight">Website Memory Center</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Inspect persistent knowledge and launch an intelligent pipeline run
        </p>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">

        {/* URL Search */}
        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            placeholder="https://example.com"
            className="flex-1 bg-card border border-border rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors placeholder:text-muted-foreground/50"
          />
          <button
            type="submit"
            disabled={!inputUrl.trim() || isLoading || isFetching}
            className="px-5 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {(isLoading || isFetching) && (
              <div className="w-3.5 h-3.5 rounded-full border-2 border-primary-foreground border-t-transparent animate-spin" />
            )}
            Analyse
          </button>
        </form>

        {/* Error state */}
        {error && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-xl p-4 text-sm text-destructive">
            {(error as Error).message}
          </div>
        )}

        {/* Loading skeleton */}
        {isLoading && (
          <div className="space-y-4">
            <div className="bg-card border border-border rounded-xl p-4 space-y-3">
              <Skeleton className="h-5 w-48" />
              <div className="grid grid-cols-3 gap-2">
                {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-xl" />)}
              </div>
            </div>
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-xl" />)}
            </div>
          </div>
        )}

        {/* Results */}
        {plan && !isLoading && (
          <>
            {/* Memory Status */}
            <div>
              <SectionHeader
                title={memExists ? "Website Found in Memory" : "No Memory Found"}
                sub={memExists
                  ? `Knowledge accumulated across ${plan.knowledgeStatus.currentModules.length} of 12 pipeline stages`
                  : "This website has not been crawled before. Start a fresh crawl to build knowledge."
                }
              />
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <Stat
                  label="Memory Status"
                  value={memExists ? "Found" : "Not Found"}
                  accent={memExists ? "text-accent" : "text-muted-foreground"}
                />
                <Stat label="Last Crawl" value={formatRelative(plan.memoryStatus.lastCrawlAt)} />
                <Stat label="Last Pipeline" value={formatRelative(plan.memoryStatus.lastSuccessfulPipeline)} />
                <Stat
                  label="Knowledge Complete"
                  value={memExists ? `${plan.knowledgeStatus.currentModules.length}/12` : "0/12"}
                  accent={plan.knowledgeStatus.currentModules.length === 12 ? "text-accent" : undefined}
                />
                <Stat label="Pipeline State" value={plan.memoryStatus.state ?? "—"} />
                <Stat
                  label="Recommended Mode"
                  value={recMode ?? "fresh"}
                  accent="text-primary"
                />
              </div>
            </div>

            {/* Recovery alert */}
            {canResume && <RecoveryPanel recovery={plan.recoveryOptions} />}

            {/* Website change summary */}
            {plan.websiteChangeSummary && (
              <WebsiteChangeSummaryPanel summary={plan.websiteChangeSummary} />
            )}

            {/* Available Actions */}
            <div>
              <SectionHeader
                title="Available Actions"
                sub="Select an execution mode to launch the pipeline"
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <ActionButton
                  label="Start Fresh Crawl"
                  description="Ignore all previous knowledge and perform a complete analysis from scratch."
                  mode="fresh"
                  icon="🌐"
                  recommended={recMode === "fresh"}
                  onClick={handleLaunch}
                  loading={launchingMode === "fresh"}
                />
                <ActionButton
                  label="Run Differential Crawl"
                  description="Compare existing memory, execute only the work needed for detected changes."
                  mode="differential"
                  icon="🔀"
                  disabled={!hasDiff}
                  recommended={recMode === "differential"}
                  onClick={handleLaunch}
                  loading={launchingMode === "differential"}
                />
                <ActionButton
                  label="Resume Interrupted Crawl"
                  description="Restore the last checkpoint and continue from where the pipeline stopped."
                  mode="resume"
                  icon="⏭"
                  disabled={!canResume}
                  recommended={recMode === "resume"}
                  onClick={handleLaunch}
                  loading={launchingMode === "resume"}
                />
                <ActionButton
                  label="Upgrade Knowledge"
                  description="Upgrade outdated knowledge modules without re-crawling the entire site."
                  mode="upgrade"
                  icon="⬆"
                  disabled={!hasMemory || plan.outdatedModules.length === 0}
                  recommended={recMode === "upgrade"}
                  onClick={handleLaunch}
                  loading={launchingMode === "upgrade"}
                />
                <ActionButton
                  label="Generate Website Prime"
                  description="Generate final blueprint outputs using existing knowledge, skipping the crawl."
                  mode="regenerate-website-prime"
                  icon="⚡"
                  disabled={!hasMemory}
                  recommended={recMode === "regenerate-website-prime"}
                  onClick={handleLaunch}
                  loading={launchingMode === "regenerate-website-prime"}
                />
              </div>
            </div>

            {/* Execution Plan Preview */}
            <div>
              <SectionHeader
                title="Execution Plan Preview"
                sub={plan.estimatedWork.description}
              />
              <ExecutionPlanPreview plan={plan} />
            </div>

            {/* Knowledge Modules */}
            {memExists && (
              <div>
                <SectionHeader
                  title="Knowledge Modules"
                  sub={`${plan.knowledgeStatus.currentModules.length} current · ${plan.knowledgeStatus.outdatedModules.length} outdated · ${plan.knowledgeStatus.missingModules.length} missing`}
                />
                <KnowledgeModulesGrid modules={plan.knowledgeStatus.modules} />
              </div>
            )}
          </>
        )}

        {/* Empty state */}
        {!activeUrl && !plan && !isLoading && (
          <div className="text-center py-16 text-muted-foreground">
            <p className="text-4xl mb-4">🧠</p>
            <p className="text-base font-semibold">Enter a URL to inspect website memory</p>
            <p className="text-sm mt-1">
              The planner will check existing knowledge and recommend the optimal execution strategy.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
