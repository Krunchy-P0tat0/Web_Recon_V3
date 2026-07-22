/**
 * decision-engine.ts — Phase 7.3: Autonomous Decision Engine
 *
 * Makes 5 fully-explained decisions from available pipeline inputs:
 *   1. Which stencil?           (DesignDNA + VisualDNA + SiteGraph)
 *   2. Which deployment target? (BackendProfile / intelligence)
 *   3. Which merge strategy?    (BackendProfile + SiteGraph)
 *   4. Which crawl strategy?    (SiteGraph + URL shape)
 *   5. Which restoration strategy? (all inputs combined)
 *
 * Every decision carries:  { decision, reason, confidence, inputs, alternatives }
 *
 * Generates decision-engine-report.json locally + uploads to R2.
 * Runs stand-alone for any jobId, or can take pre-loaded inputs.
 */

import { readFile, writeFile } from "fs/promises";
import { join }                from "path";
import { logger }              from "./logger.js";
import { loadManifest }        from "./manifest-store.js";
import { getDefaultCloudProvider } from "../cloud/index.js";

// ---------------------------------------------------------------------------
// Decision types
// ---------------------------------------------------------------------------

export type ConfidenceLevel = "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";

export interface Decision {
  id:           string;
  category:     string;
  decision:     string;
  reason:       string;
  confidence:   number;           // 0–100
  confidenceLevel: ConfidenceLevel;
  inputs:       string[];         // which inputs drove this decision
  alternatives: Alternative[];
  decidedAt:    string;
}

interface Alternative {
  option:     string;
  reason:     string;
  confidence: number;
}

export interface DecisionEngineReport {
  version:      string;
  phase:        string;
  generatedAt:  string;
  jobId:        string | null;
  url:          string | null;
  inputsUsed:   string[];
  decisions:    Decision[];
  summary: {
    totalDecisions:  number;
    avgConfidence:   number;
    highConfidence:  number;
    lowConfidence:   number;
    inputCoverage:   number;   // % of 5 possible inputs that were available
  };
}

// ---------------------------------------------------------------------------
// Confidence helpers
// ---------------------------------------------------------------------------

function confidenceLevel(score: number): ConfidenceLevel {
  if (score >= 85) return "VERY_HIGH";
  if (score >= 65) return "HIGH";
  if (score >= 40) return "MEDIUM";
  return "LOW";
}

function makeDecision(opts: {
  id:           string;
  category:     string;
  decision:     string;
  reason:       string;
  confidence:   number;
  inputs:       string[];
  alternatives: Alternative[];
}): Decision {
  return {
    ...opts,
    confidenceLevel: confidenceLevel(opts.confidence),
    decidedAt:       new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Input loaders — each returns null if not available
// ---------------------------------------------------------------------------

const LOCAL_PATHS: Record<string, string> = {
  designDna:    join(process.cwd(), "design-classification-report.json"),
  stencil:      join(process.cwd(), "stencil-selection-report.json"),
  intelligence: join(process.cwd(), "deployment-intelligence-report.json"),
  visualDna:    join(process.cwd(), "visual-dna-report.json"),
  mergeplan:    join(process.cwd(), "merge-plan.json"),
};

async function tryLoad(key: string): Promise<unknown> {
  try {
    const raw = await readFile(LOCAL_PATHS[key]!, "utf8");
    return JSON.parse(raw);
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Decision makers (one per category)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decideStencil(designDna: any, stencilReport: any, manifest: any): Decision {
  const archetype        = designDna?.profile?.archetype as string | undefined;
  const stencilChosen    = stencilReport?.selection?.selectedStencil as string | undefined;
  const confidence       = stencilReport?.selection?.confidence as number | undefined;
  const pageCount        = manifest?.stats?.totalNodes as number | undefined;

  const inputs: string[] = [];
  if (designDna)      inputs.push("DesignDNA");
  if (stencilReport)  inputs.push("StencilReport");
  if (manifest)       inputs.push("SiteGraph");

  if (stencilChosen && confidence !== undefined) {
    return makeDecision({
      id:         "stencil",
      category:   "Stencil Selection",
      decision:   stencilChosen,
      reason:     `Design archetype "${archetype ?? "unknown"}" with confidence ${confidence}% matched stencil type "${stencilChosen}". Site has ${pageCount ?? "unknown"} pages.`,
      confidence: Math.min(confidence ?? 70, 95),
      inputs,
      alternatives: stencilReport?.selection?.alternatives ?? [],
    });
  }

  // Fall back to heuristic
  const chosen     = archetype === "editorial" ? "magazine"
                   : archetype === "portfolio"  ? "portfolio"
                   : archetype === "commerce"   ? "product-catalogue"
                   : archetype === "blog"        ? "blog"
                   : "generic-multi-page";
  const altConfidence = designDna ? 52 : 30;

  return makeDecision({
    id:         "stencil",
    category:   "Stencil Selection",
    decision:   chosen,
    reason:     designDna
      ? `Heuristic from archetype "${archetype ?? "unknown"}". Run full stencil selection for higher confidence.`
      : "No DesignDNA or stencil report available — defaulted to generic-multi-page.",
    confidence: altConfidence,
    inputs,
    alternatives: [
      { option: "blog",              reason: "Suitable for content-heavy sites", confidence: 45 },
      { option: "landing-page",      reason: "Suitable for minimal single-page sites", confidence: 30 },
      { option: "generic-multi-page",reason: "Safe fallback for unknown archetypes", confidence: 60 },
    ],
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decideDeploymentTarget(intelligence: any): Decision {
  const inputs: string[] = [];
  if (intelligence) inputs.push("BackendProfile");

  const recommended    = intelligence?.recommended as string | undefined;
  const risk           = intelligence?.risk?.deploymentRisk as string | undefined;
  const compatibility  = intelligence?.risk?.compatibilityScore as number | undefined;
  const hosting        = intelligence?.environment?.detectedHosting as string | undefined;

  if (recommended) {
    const conf = risk === "LOW" ? 90 : risk === "MEDIUM" ? 72 : 55;
    return makeDecision({
      id:         "deployment-target",
      category:   "Deployment Target",
      decision:   recommended,
      reason:     `Intelligence engine recommended "${recommended}" based on detected hosting "${hosting ?? "unknown"}" and deployment risk "${risk ?? "unknown"}" (compatibility: ${compatibility ?? "?"}%).`,
      confidence: conf,
      inputs,
      alternatives: [
        { option: "r2-static",   reason: "Fastest for static sites, lowest cost", confidence: 80 },
        { option: "vercel",      reason: "Best for Next.js / SSR workloads",      confidence: 60 },
        { option: "cloudflare-pages", reason: "Edge-first, global CDN",           confidence: 65 },
      ],
    });
  }

  return makeDecision({
    id:         "deployment-target",
    category:   "Deployment Target",
    decision:   "r2-static",
    reason:     "No intelligence report available — defaulting to R2 static (configured cloud provider).",
    confidence: 45,
    inputs,
    alternatives: [
      { option: "vercel",           reason: "Better for SSR/dynamic sites",   confidence: 50 },
      { option: "cloudflare-pages", reason: "Alternative edge CDN",           confidence: 45 },
    ],
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decideMergeStrategy(intelligence: any, manifest: any, mergePlan: any): Decision {
  const inputs: string[] = [];
  if (intelligence) inputs.push("BackendProfile");
  if (manifest)     inputs.push("SiteGraph");
  if (mergePlan)    inputs.push("MergePlan");

  const hosting        = intelligence?.environment?.detectedHosting as string | undefined;
  const framework      = intelligence?.environment?.detectedFramework as string | undefined;
  const pageCount      = (manifest?.stats?.totalNodes ?? 0) as number;
  const mergeActions   = mergePlan?.plan?.actions?.length as number | undefined;

  let strategy: string;
  let reason:   string;
  let confidence: number;

  if (framework === "next" || framework === "nuxt") {
    strategy   = "framework-aware-merge";
    reason     = `Detected ${framework} framework — using framework-aware merge to preserve routing, API routes, and server components.`;
    confidence = 88;
  } else if (hosting === "static" || (!framework && pageCount < 20)) {
    strategy   = "static-file-overlay";
    reason     = `Static hosting detected with ${pageCount} pages — overlay strategy avoids build pipeline disruption.`;
    confidence = 82;
  } else if (mergeActions && mergeActions > 50) {
    strategy   = "incremental-patch";
    reason     = `Merge plan has ${mergeActions} file actions — incremental patch minimises conflict surface.`;
    confidence = 75;
  } else {
    strategy   = "clean-replace";
    reason     = `No framework or large merge plan detected — clean replace is safest for unknown environments.`;
    confidence = 55;
  }

  return makeDecision({
    id:         "merge-strategy",
    category:   "Merge Strategy",
    decision:   strategy,
    reason,
    confidence,
    inputs,
    alternatives: [
      { option: "framework-aware-merge", reason: "Best for Next.js/Nuxt sites",         confidence: 80 },
      { option: "static-file-overlay",   reason: "Safe for pure static output",         confidence: 75 },
      { option: "incremental-patch",     reason: "Good for large file counts",           confidence: 65 },
      { option: "clean-replace",         reason: "Safest fallback, no conflict risk",    confidence: 50 },
    ],
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decideCrawlStrategy(manifest: any): Decision {
  const inputs: string[] = [];
  if (manifest) inputs.push("SiteGraph");

  const pageCount   = (manifest?.stats?.totalNodes    ?? 0) as number;
  const depth       = (manifest?.stats?.maxDepth       ?? 0) as number;
  const mediaCount  = (manifest?.stats?.totalMedia     ?? 0) as number;
  const seedUrl     = (manifest?.seedUrl               ?? "") as string;

  const isPaginated = seedUrl.includes("page") || (pageCount > 100);
  const hasMedia    = mediaCount > 20;

  let strategy:   string;
  let reason:     string;
  let confidence: number;

  if (pageCount === 0) {
    strategy   = "full-crawl";
    reason     = "No manifest available — defaulting to full crawl of all reachable pages.";
    confidence = 40;
  } else if (isPaginated && pageCount > 100) {
    strategy   = "paginated-deep-crawl";
    reason     = `Site has ${pageCount} pages with pagination patterns — deep paginated crawl captures all content pages.`;
    confidence = 85;
  } else if (hasMedia && depth <= 3) {
    strategy   = "media-aware-crawl";
    reason     = `${mediaCount} media items found at depth ≤${depth} — media-aware crawl captures images and videos alongside content.`;
    confidence = 80;
  } else if (pageCount <= 20 && depth <= 2) {
    strategy   = "shallow-crawl";
    reason     = `Small site: ${pageCount} pages, depth ${depth} — shallow crawl is fast and sufficient.`;
    confidence = 90;
  } else {
    strategy   = "full-crawl";
    reason     = `${pageCount} pages at depth ${depth} — full crawl ensures complete coverage.`;
    confidence = 75;
  }

  return makeDecision({
    id:         "crawl-strategy",
    category:   "Crawl Strategy",
    decision:   strategy,
    reason,
    confidence,
    inputs,
    alternatives: [
      { option: "shallow-crawl",        reason: "Fastest, good for small sites",               confidence: 70 },
      { option: "full-crawl",           reason: "Complete coverage, slower",                   confidence: 65 },
      { option: "paginated-deep-crawl", reason: "Required for pagination-heavy sites",         confidence: 60 },
      { option: "media-aware-crawl",    reason: "Captures images/video alongside text",        confidence: 55 },
      { option: "incremental-crawl",    reason: "Only crawl changed pages (requires baseline)",confidence: 50 },
    ],
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decideRestorationStrategy(intelligence: any, stencilReport: any, visualDna: any, manifest: any): Decision {
  const inputs: string[] = [];
  if (intelligence)  inputs.push("BackendProfile");
  if (stencilReport) inputs.push("StencilReport");
  if (visualDna)     inputs.push("VisualDNA");
  if (manifest)      inputs.push("SiteGraph");

  const risk          = intelligence?.risk?.deploymentRisk as string | undefined;
  const archetype     = stencilReport?.profile?.archetype   as string | undefined;
  const pageCount     = (manifest?.stats?.totalNodes ?? 0)  as number;
  const hasVisualDna  = !!visualDna;

  let strategy:   string;
  let reason:     string;
  let confidence: number;

  if (risk === "HIGH" || risk === "CRITICAL") {
    strategy   = "snapshot-restore";
    reason     = `Deployment risk is "${risk}" — snapshot restore guarantees full rollback to last known-good state.`;
    confidence = 92;
  } else if (hasVisualDna && archetype) {
    strategy   = "visual-fidelity-restore";
    reason     = `VisualDNA + DesignDNA available — visual-fidelity restore re-runs the reconstruction pipeline from stored DNA, preserving design intent.`;
    confidence = 85;
  } else if (pageCount > 0 && intelligence) {
    strategy   = "manifest-replay";
    reason     = `${pageCount}-page manifest and intelligence report available — manifest replay re-deploys from the stored content graph.`;
    confidence = 75;
  } else {
    strategy   = "redeploy-from-source";
    reason     = `Limited inputs available — redeploy from source URL triggers a fresh crawl and reconstruction.`;
    confidence = 50;
  }

  return makeDecision({
    id:         "restoration-strategy",
    category:   "Restoration Strategy",
    decision:   strategy,
    reason,
    confidence,
    inputs,
    alternatives: [
      { option: "snapshot-restore",       reason: "Fastest, requires stored snapshot",          confidence: 90 },
      { option: "visual-fidelity-restore",reason: "Reuses DNA — no re-crawl needed",            confidence: 80 },
      { option: "manifest-replay",        reason: "Replays last manifest — moderate speed",      confidence: 70 },
      { option: "redeploy-from-source",   reason: "Full re-crawl — slowest but always works",   confidence: 55 },
    ],
  });
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runDecisionEngine(
  jobId:  string | null = null,
  url:    string | null = null,
): Promise<DecisionEngineReport> {
  const t0 = Date.now();
  logger.info({ jobId, url }, "DECISION-ENGINE: starting autonomous decision run");

  // Load all available inputs in parallel
  const manifest = jobId ? await loadManifest(jobId) : null;

  const [designDna, stencilReport, intelligence, visualDna, mergePlan] =
    await Promise.all([
      tryLoad("designDna"),
      tryLoad("stencil"),
      tryLoad("intelligence"),
      tryLoad("visualDna"),
      tryLoad("mergeplan"),
    ]);

  const inputsUsed: string[] = [];
  if (manifest)      inputsUsed.push("SiteGraph");
  if (designDna)     inputsUsed.push("DesignDNA");
  if (stencilReport) inputsUsed.push("StencilReport");
  if (intelligence)  inputsUsed.push("BackendProfile");
  if (visualDna)     inputsUsed.push("VisualDNA");
  if (mergePlan)     inputsUsed.push("MergePlan");

  logger.info({ jobId, inputsUsed }, "DECISION-ENGINE: inputs loaded");

  // Make all 5 decisions
  const decisions: Decision[] = [
    decideStencil(designDna, stencilReport, manifest),
    decideDeploymentTarget(intelligence),
    decideMergeStrategy(intelligence, manifest, mergePlan),
    decideCrawlStrategy(manifest),
    decideRestorationStrategy(intelligence, stencilReport, visualDna, manifest),
  ];

  const avgConfidence  = Math.round(decisions.reduce((s, d) => s + d.confidence, 0) / decisions.length);
  const inputCoverage  = Math.round((inputsUsed.length / 6) * 100);

  const report: DecisionEngineReport = {
    version:     "1.0",
    phase:       "7.3",
    generatedAt: new Date().toISOString(),
    jobId,
    url,
    inputsUsed,
    decisions,
    summary: {
      totalDecisions:  decisions.length,
      avgConfidence,
      highConfidence:  decisions.filter((d) => d.confidence >= 70).length,
      lowConfidence:   decisions.filter((d) => d.confidence < 50).length,
      inputCoverage,
    },
  };

  logger.info(
    { jobId, avgConfidence, inputCoverage, durationMs: Date.now() - t0 },
    "DECISION-ENGINE: all decisions made"
  );

  await persistReport(report, jobId);
  return report;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const REPORT_PATH       = join(process.cwd(), "decision-engine-report.json");
const REPORT_PATH_UP    = join(process.cwd(), "..", "..", "decision-engine-report.json");

async function persistReport(report: DecisionEngineReport, jobId: string | null): Promise<void> {
  const json  = JSON.stringify(report, null, 2);
  const cloud = getDefaultCloudProvider();

  await Promise.allSettled([
    writeFile(REPORT_PATH,    json, "utf8"),
    writeFile(REPORT_PATH_UP, json, "utf8"),
    ...(cloud.isConfigured() ? [
      cloud.upload({
        key:            jobId ? `jobs/${jobId}/decision-engine-report.json` : "orchestration/decision-engine-report.json",
        data:           Buffer.from(json, "utf8"),
        contentType:    "application/json",
        checkDuplicate: false,
      }),
    ] : []),
  ]);
}

export async function loadReport(): Promise<DecisionEngineReport | null> {
  for (const p of [REPORT_PATH, REPORT_PATH_UP]) {
    try { return JSON.parse(await readFile(p, "utf8")) as DecisionEngineReport; } catch { /* skip */ }
  }
  return null;
}
