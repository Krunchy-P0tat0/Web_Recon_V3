/**
 * resource-decision-engine-ri3.ts — Phase RI-3: Intelligent Resource Decision Engine
 *
 * The single authoritative decision-maker for every resource acquisition action.
 * No subsystem may decide to download, reference, defer, stream, cache, or skip
 * a resource without routing through this engine.
 *
 * Decision Inputs:
 *   · Resource Intelligence Score (RI-1)
 *   · Reconstruction Value Score  (RI-2)
 *   · Hardware / Storage / Memory / Bandwidth Budgets
 *   · Offline Mode
 *   · Reconstruction Goal
 *   · Website Type
 *   · Current Crawl Phase
 *
 * Decision Outputs:
 *   DOWNLOAD  — fetch and store locally
 *   REFERENCE — keep external URL, never store
 *   DEFER     — download after higher-priority resources
 *   STREAM    — access on-demand, do not persist
 *   CACHE     — store the response/URL for future pipeline reuse
 *   SKIP      — do not acquire in any form
 *
 * Every decision carries:
 *   reason · confidence · supportingEvidence · estimatedCost
 *   estimatedBenefit · riskAssessment · auditTrail
 *
 * Outputs (R2 + in-memory):
 *   resource-decision-report.json
 *   download-plan.json
 *   resource-budget-report.json
 *   decision-audit-report.json
 */

import { logger }              from "./logger.js";
import { loadManifest }        from "./manifest-store.js";
import { createCloudProvider } from "../cloud/index.js";
import {
  getCachedRiReports,
  evaluateSingleResource,
  type ResourceAnalysis,
  type ResourceType,
  type ResourceOrigin,
} from "./resource-intelligence-engine-ri1.js";
import {
  getCachedRi2Reports,
  scoreMinimalResource,
  type ReconstructionValueDimensions,
} from "./reconstruction-value-engine-ri2.js";

// ── Decision vocabulary ───────────────────────────────────────────────────────
export type ResourceDecision = "DOWNLOAD" | "REFERENCE" | "DEFER" | "STREAM" | "CACHE" | "SKIP";

// ── Context types ─────────────────────────────────────────────────────────────
export type ReconstructionGoal =
  | "clone_site"
  | "merge_into_backend"
  | "update_existing"
  | "visual_snapshot"
  | "design_extraction";

export type WebsiteType =
  | "blog" | "ecommerce" | "saas" | "portfolio"
  | "news" | "corporate" | "docs" | "unknown";

export type CrawlPhase =
  | "discovery" | "media" | "analysis" | "generation" | "deployment";

// ── Budget model ──────────────────────────────────────────────────────────────
export interface ResourceBudgets {
  hardwareMb:      number;    // total available hardware storage (0 = unlimited)
  storageMb:       number;    // storage budget for this crawl (0 = unlimited)
  memoryMb:        number;    // in-process memory limit (0 = unlimited)
  bandwidthMb:     number;    // network bandwidth cap (0 = unlimited)
  usedStorageMb:   number;    // consumed so far
  usedBandwidthMb: number;    // consumed so far
  usedMemoryMb:    number;    // consumed so far
}

const UNLIMITED_BUDGETS: ResourceBudgets = {
  hardwareMb: 0, storageMb: 0, memoryMb: 0, bandwidthMb: 0,
  usedStorageMb: 0, usedBandwidthMb: 0, usedMemoryMb: 0,
};

// ── Decision context ──────────────────────────────────────────────────────────
export interface DecisionContext {
  budgets:           ResourceBudgets;
  offlineMode:       boolean;
  reconstructionGoal:ReconstructionGoal;
  websiteType:       WebsiteType;
  crawlPhase:        CrawlPhase;
}

const DEFAULT_CONTEXT: DecisionContext = {
  budgets:            UNLIMITED_BUDGETS,
  offlineMode:        false,
  reconstructionGoal: "clone_site",
  websiteType:        "unknown",
  crawlPhase:         "media",
};

// ── Risk levels ───────────────────────────────────────────────────────────────
export type RiskLevel = "low" | "medium" | "high" | "critical";

// ── Full decision result ──────────────────────────────────────────────────────
export interface ResourceDecisionResult {
  id:                  string;
  url:                 string;
  resourceType:        ResourceType;
  label:               string;
  decision:            ResourceDecision;
  confidence:          number;            // 0–100
  reason:              string;
  supportingEvidence:  string[];
  estimatedCostMb:     number;            // storage footprint
  estimatedBandwidthMb:number;            // network transfer
  estimatedBenefit:    number;            // 0–100 reconstruction benefit
  riskAssessment: {
    level:   RiskLevel;
    score:   number;                      // 0–100
    factors: string[];
  };
  ri1Score:            number;            // composite RI-1 score
  ri2Overall:          number;            // RI-2 overall reconstruction value
  ri2Dimensions:       Partial<ReconstructionValueDimensions>;
  budgetImpact: {
    storageAfterMb:   number;
    bandwidthAfterMb: number;
    withinBudget:     boolean;
  };
  alternatives:        Array<{ decision: ResourceDecision; reason: string }>;
  auditTrail:          string[];          // step-by-step decision path
  decidedAt:           string;
}

// ── Budget report ─────────────────────────────────────────────────────────────
export interface ResourceBudgetReport {
  jobId:          string;
  generatedAt:    string;
  phase:          "RI-3";
  budgets:        ResourceBudgets;
  consumption: {
    downloadCount:   number;
    referenceCount:  number;
    deferCount:      number;
    streamCount:     number;
    cacheCount:      number;
    skipCount:       number;
    totalStorageMb:  number;
    totalBandwidthMb:number;
    savingsMb:       number;      // storage saved by SKIP+REFERENCE vs DOWNLOAD
  };
  budgetStatus: {
    storage:   "ok" | "warning" | "exceeded";
    bandwidth: "ok" | "warning" | "exceeded";
    memory:    "ok" | "warning" | "exceeded";
  };
  topCostResources:  Array<{ url: string; costMb: number; decision: ResourceDecision }>;
  summary:           string;
}

// ── Download plan ─────────────────────────────────────────────────────────────
export interface DownloadPlan {
  jobId:          string;
  generatedAt:    string;
  phase:          "RI-3";
  totalDownloads: number;
  totalDeferreds: number;
  totalStreams:   number;
  estimatedMb:    number;
  plan:           Array<{
    rank:              number;
    decision:          ResourceDecision;
    url:               string;
    resourceType:      ResourceType;
    estimatedCostMb:   number;
    ri2Overall:        number;
    confidence:        number;
    reason:            string;
    cumulativeMb:      number;
  }>;
}

// ── Decision audit report ─────────────────────────────────────────────────────
export interface DecisionAuditReport {
  jobId:              string;
  generatedAt:        string;
  phase:              "RI-3";
  context:            DecisionContext;
  totalDecisions:     number;
  byDecision:         Record<ResourceDecision, number>;
  skippedReasons:     Record<string, number>;
  confidenceAvg:      number;
  lowConfidenceCount: number;        // decisions with confidence < 50
  overrides:          Array<{
    url:      string;
    original: ResourceDecision;
    overridden:ResourceDecision;
    reason:   string;
  }>;
  ruleActivations:    Record<string, number>;  // how many times each rule fired
  decisions:          ResourceDecisionResult[];
}

// ── Full report ───────────────────────────────────────────────────────────────
export interface ResourceDecisionReport {
  jobId:          string;
  seedUrl:        string;
  generatedAt:    string;
  phase:          "RI-3";
  context:        DecisionContext;
  totalResources: number;
  byDecision:     Record<ResourceDecision, number>;
  decisions:      ResourceDecisionResult[];
  summary:        string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function humanLabel(url: string): string {
  const filename = url.split("?")[0]!.split("#")[0]!.split("/").pop() ?? url;
  const base = filename.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ").trim();
  return base.length > 40 ? base.slice(0, 40) + "…" : (base || url.slice(0, 40));
}

function estimateSizeMb(
  analysis: ResourceAnalysis,
  ri2Overall: number,
): number {
  if (analysis.estimatedBytes) return analysis.estimatedBytes / 1_048_576;
  // Type-based heuristics (MB)
  const heuristics: Partial<Record<ResourceType, number>> = {
    css: 0.05, javascript: 0.12, image: 0.18, font: 0.08,
    svg: 0.015, video: 4.0, audio: 1.5, json: 0.03,
    pdf: 0.8, document: 0.4, wasm: 0.25, html: 0.02,
    ico: 0.005, xml: 0.02, "api-endpoint": 0.01, "other-static": 0.05,
  };
  return heuristics[analysis.resourceType] ?? 0.05;
}

function budgetStatus(
  used: number,
  cap: number,
): "ok" | "warning" | "exceeded" {
  if (cap === 0) return "ok";
  const ratio = used / cap;
  if (ratio >= 1) return "exceeded";
  if (ratio >= 0.85) return "warning";
  return "ok";
}

function isExternalTracker(url: string, tags: string[]): boolean {
  const u = url.toLowerCase();
  return (
    tags.includes("analytics") ||
    tags.includes("advertising") ||
    /gtag|google-analytics|analytics\.js|segment\.io|mixpanel|amplitude|hotjar|heap\.io|clarity\.ms|fbq|facebook.*pixel|tiktok.*pixel|twitter.*pixel|doubleclick|adservice|adsystem|ad-click|pagead/.test(u)
  );
}

function isChatOrLiveWidget(url: string): boolean {
  const u = url.toLowerCase();
  return /intercom|drift\.com|livechat|zendesk.*chat|tawk\.to|freshchat|crisp\.chat|hubspot.*messages|purechat|olark|smartsupp/.test(u);
}

function isCookieBanner(url: string, tags: string[]): boolean {
  const u = url.toLowerCase();
  return /cookieconsent|onetrust|gdpr|ccpa|iubenda|cookiebot|tarteaucitron|quantcast|didomi/.test(u);
}

function isApiSchema(url: string): boolean {
  const u = url.toLowerCase();
  return /swagger|openapi|graphql.*schema|\.proto$|schema\.json/.test(u);
}

function isLargeVideo(analysis: ResourceAnalysis): boolean {
  if (analysis.resourceType !== "video") return false;
  // Videos are large by default. Only skip the large-video rules when we have
  // confirmed-observed byte data (mimeSource === "observed") showing the file
  // is genuinely small (< 2 MB). Heuristic estimates are not sufficient proof
  // of smallness — err on the side of treating unknown-size videos as large.
  const confirmedSmall =
    analysis.mimeSource === "observed" &&
    analysis.estimatedBytes !== null &&
    analysis.estimatedBytes < 2_000_000;
  return !confirmedSmall;
}

function isGoogleFont(url: string): boolean {
  return /fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url.toLowerCase());
}

function isExternalCdn(analysis: ResourceAnalysis): boolean {
  return analysis.origin === "cdn" || analysis.origin === "external";
}

// ── Rule evaluation ───────────────────────────────────────────────────────────
interface RuleResult {
  matched:    boolean;
  decision:   ResourceDecision;
  reason:     string;
  confidence: number;
  ruleName:   string;
  evidence:   string[];
}

function evaluateRules(
  analysis: ResourceAnalysis,
  ri2Overall: number,
  ri2Dims: Partial<ReconstructionValueDimensions>,
  ctx: DecisionContext,
  estimatedMb: number,
  ruleActivations: Record<string, number>,
): RuleResult {
  const tags  = analysis.tags ?? [];
  const url   = analysis.url;
  const rType = analysis.resourceType;
  const ri1   = analysis.scores.resourceIntelligenceScore;
  const origin: ResourceOrigin = analysis.origin;

  const fire = (
    name: string, decision: ResourceDecision, reason: string,
    confidence: number, evidence: string[],
  ): RuleResult => {
    ruleActivations[name] = (ruleActivations[name] ?? 0) + 1;
    return { matched: true, decision, reason, confidence, ruleName: name, evidence };
  };

  // ── R00: Hard skip — zero reconstruction value and zero RI-1 score ──────────
  if (ri2Overall <= 3 && ri1 <= 10) {
    return fire("R00:zero-value", "SKIP",
      "Zero reconstruction value (RI-2) and negligible resource intelligence score (RI-1)",
      99, [`RI-2 overall: ${ri2Overall}`, `RI-1 score: ${ri1}`]);
  }

  // ── R01: Analytics / advertising trackers ────────────────────────────────────
  if (isExternalTracker(url, tags)) {
    return fire("R01:tracker", "SKIP",
      "Analytics or advertising tracker — zero reconstruction contribution",
      99, ["Tagged as analytics/advertising", `URL pattern matches tracker: ${url.split("?")[0]!.slice(-60)}`]);
  }

  // ── R02: Chat / live-support widgets ────────────────────────────────────────
  if (rType === "javascript" && isChatOrLiveWidget(url)) {
    return fire("R02:chat-widget", "SKIP",
      "Third-party chat/live-support widget — runtime-only, not reconstructable",
      97, ["Widget URLs are session-authenticated", "Reconstruction value: negligible"]);
  }

  // ── R03: Cookie consent banners ─────────────────────────────────────────────
  if (isCookieBanner(url, tags)) {
    return fire("R03:cookie-banner", "SKIP",
      "Cookie consent banner — third-party compliance widget, not site-specific",
      96, [`RI-2 overall: ${ri2Overall}`, "Compliance widgets are vendor-managed"]);
  }

  // ── R04: API schema files → CACHE (high backend value, small footprint) ─────
  if (isApiSchema(url) || (rType === "json" && (ri2Dims.backend ?? 0) >= 85)) {
    return fire("R04:api-schema", "CACHE",
      "API schema or contract document — high backend reconstruction value, CACHE for pipeline reuse",
      90, [`RI-2 backend dimension: ${ri2Dims.backend ?? "N/A"}`, "API contracts enable backend reconstruction without repeated network calls"]);
  }

  // ── R05: Budget exhausted — hard cap ────────────────────────────────────────
  const { storageMb, bandwidthMb, usedStorageMb, usedBandwidthMb } = ctx.budgets;
  const storageExhausted   = storageMb   > 0 && (usedStorageMb   + estimatedMb) > storageMb;
  const bandwidthExhausted = bandwidthMb > 0 && (usedBandwidthMb + estimatedMb) > bandwidthMb;

  if (storageExhausted || bandwidthExhausted) {
    if (ri2Overall >= 85) {
      // Essential resource: downgrade to REFERENCE rather than SKIP
      return fire("R05:budget-exhausted-essential", "REFERENCE",
        "Budget exhausted but resource is essential — reference external URL instead of downloading",
        80, [
          storageExhausted   ? `Storage budget: ${storageMb} MB (used: ${usedStorageMb.toFixed(1)} MB, +${estimatedMb.toFixed(2)} MB would exceed)` : "",
          bandwidthExhausted ? `Bandwidth budget: ${bandwidthMb} MB (used: ${usedBandwidthMb.toFixed(1)} MB)` : "",
          `RI-2 overall: ${ri2Overall} (essential — cannot SKIP)`,
        ].filter(Boolean));
    }
    return fire("R05:budget-exhausted", "SKIP",
      "Storage or bandwidth budget exhausted — resource deferred to avoid budget overrun",
      85, [
        storageExhausted   ? `Storage budget exceeded: ${usedStorageMb.toFixed(1)}/${storageMb} MB` : "",
        bandwidthExhausted ? `Bandwidth budget exceeded: ${usedBandwidthMb.toFixed(1)}/${bandwidthMb} MB` : "",
      ].filter(Boolean));
  }

  // ── R06: Offline mode — maximize local acquisition ───────────────────────────
  if (ctx.offlineMode) {
    if (ri2Overall >= 40 && (origin === "same-domain" || origin === "subdomain")) {
      return fire("R06:offline-download", "DOWNLOAD",
        "Offline mode active — downloading same-domain resource for local availability",
        88, [`Offline mode: true`, `Origin: ${origin}`, `RI-2 overall: ${ri2Overall}`]);
    }
    if (ri2Overall >= 40 && origin === "cdn") {
      return fire("R06:offline-cdn-defer", "DEFER",
        "Offline mode active — CDN resource deferred (will attempt download at lower priority)",
        72, [`Offline mode: true`, `CDN origin requires network access`]);
    }
    if (ri2Overall < 20) {
      return fire("R06:offline-skip-low-value", "SKIP",
        "Offline mode active — low-value external resource skipped to conserve storage",
        90, [`RI-2 overall: ${ri2Overall}`, "Offline budget prioritises high-value resources"]);
    }
  }

  // ── R07: Google Fonts → REFERENCE (always available via CDN) ────────────────
  if (isGoogleFont(url)) {
    return fire("R07:google-fonts", "REFERENCE",
      "Google Fonts CDN — always available externally; reference original URL to reduce storage",
      92, ["Google Fonts URLs are permanent and globally cached", "Font face can be reconstructed from @font-face reference"]);
  }

  // ── R08: Large video files ────────────────────────────────────────────────────
  if (isLargeVideo(analysis)) {
    // Clone-site goal or medium-value+ video: defer to end of download plan
    if (ctx.reconstructionGoal === "clone_site" || ri2Overall >= 40) {
      return fire("R08:large-video-defer", "DEFER",
        "Large video asset — deferred to end of download plan to avoid blocking higher-priority resources",
        82, [
          `Estimated size: ${estimatedMb.toFixed(1)} MB`,
          `RI-2 overall: ${ri2Overall}`,
          `Goal: ${ctx.reconstructionGoal} — video acquired after essential assets`,
        ]);
    }
    // Non-clone goal with low reconstruction value: stream rather than store
    if (ri2Overall >= 20) {
      return fire("R08:large-video-stream", "STREAM",
        "Large video asset — stream from source to avoid local storage cost",
        75, [`Estimated size: ${estimatedMb.toFixed(1)} MB`, `Reconstruction goal: ${ctx.reconstructionGoal}`, `RI-2 overall: ${ri2Overall}`]);
    }
    return fire("R08:large-video-skip", "SKIP",
      "Large video with negligible reconstruction value — skipped to preserve bandwidth",
      85, [`Estimated size: ${estimatedMb.toFixed(1)} MB`, `RI-2 overall: ${ri2Overall} (below threshold for video acquisition)`]);
  }

  // ── R09: Essential resources (RI-2 ≥ 80) → DOWNLOAD ─────────────────────────
  if (ri2Overall >= 80) {
    if (origin === "same-domain" || origin === "subdomain" || origin === "data-uri") {
      return fire("R09:essential-same-domain", "DOWNLOAD",
        "Essential resource on same domain — download for full reconstruction fidelity",
        95, [`RI-2 overall: ${ri2Overall} (tier: essential)`, `Origin: ${origin}`, `RI-1 score: ${ri1}`]);
    }
    if (origin === "cdn") {
      return fire("R09:essential-cdn", "DOWNLOAD",
        "Essential CDN-hosted resource — downloading to ensure offline reconstruction capability",
        85, [`RI-2 overall: ${ri2Overall} (tier: essential)`, `CDN resource critical for reconstruction`]);
    }
    // External essential — reference
    return fire("R09:essential-external", "REFERENCE",
      "Essential resource on external domain — referencing to preserve URL without storing",
      78, [`RI-2 overall: ${ri2Overall}`, `External origin: ${origin}`]);
  }

  // ── R10: High-value resources (RI-2 60–79) ───────────────────────────────────
  if (ri2Overall >= 60) {
    if (origin === "same-domain" || origin === "subdomain") {
      return fire("R10:high-same-domain", "DOWNLOAD",
        "High reconstruction value — same-domain resource downloaded",
        88, [`RI-2 overall: ${ri2Overall} (tier: high)`, `Origin: ${origin}`]);
    }
    if (origin === "cdn" && (rType === "css" || rType === "font" || rType === "javascript")) {
      return fire("R10:high-cdn-download", "DOWNLOAD",
        "High-value CDN resource (CSS/font/JS) — downloading for offline reconstruction",
        80, [`RI-2 overall: ${ri2Overall}`, `CDN resource type: ${rType}`]);
    }
    return fire("R10:high-external-reference", "REFERENCE",
      "High-value external resource — reference preserves URL for reconstruction without storage cost",
      75, [`RI-2 overall: ${ri2Overall}`, `External origin: ${origin}`]);
  }

  // ── R11: Medium-value resources (RI-2 35–59) ─────────────────────────────────
  if (ri2Overall >= 35) {
    if (origin === "same-domain" || origin === "subdomain") {
      if (ctx.crawlPhase === "discovery") {
        return fire("R11:medium-discovery-defer", "DEFER",
          "Medium-value resource encountered during discovery phase — deferred to media phase",
          78, [`RI-2 overall: ${ri2Overall}`, `Crawl phase: ${ctx.crawlPhase}`]);
      }
      return fire("R11:medium-same-domain", "DOWNLOAD",
        "Medium reconstruction value — same-domain resource worth downloading",
        72, [`RI-2 overall: ${ri2Overall}`, `Origin: ${origin}`]);
    }
    return fire("R11:medium-external-defer", "DEFER",
      "Medium-value external resource — deferred for optional acquisition after priority resources",
      65, [`RI-2 overall: ${ri2Overall}`, `External resource — acquisition deprioritised`]);
  }

  // ── R12: Low-value (RI-2 12–34) ──────────────────────────────────────────────
  if (ri2Overall >= 12) {
    if (ctx.reconstructionGoal === "clone_site" && origin === "same-domain") {
      return fire("R12:low-clone-defer", "DEFER",
        "Low reconstruction value but full-clone goal requires completeness — deferred",
        60, [`RI-2 overall: ${ri2Overall}`, `Goal: clone_site`]);
    }
    return fire("R12:low-skip", "SKIP",
      "Low reconstruction value — resource not worth the acquisition cost",
      75, [`RI-2 overall: ${ri2Overall}`, "Acquisition cost exceeds reconstruction benefit"]);
  }

  // ── R13: Negligible — skip everything ────────────────────────────────────────
  return fire("R13:negligible", "SKIP",
    "Negligible reconstruction value — resource contributes nothing to reconstruction fidelity",
    98, [`RI-2 overall: ${ri2Overall}`, `RI-1 score: ${ri1}`, "Resource excluded from acquisition plan"]);
}

// ── Risk assessment ───────────────────────────────────────────────────────────
function assessRisk(
  analysis: ResourceAnalysis,
  decision: ResourceDecision,
  ri2Overall: number,
): { level: RiskLevel; score: number; factors: string[] } {
  const factors: string[] = [];
  let score = 0;

  const secRisk = analysis.scores.securityRisk ?? 0;
  const crawlRisk = analysis.scores.crawlRisk ?? 0;

  if (secRisk >= 70) { score += 40; factors.push(`High security risk score: ${secRisk}/100 — potential XSS/supply-chain vector`); }
  else if (secRisk >= 40) { score += 15; factors.push(`Moderate security risk: ${secRisk}/100`); }

  if (crawlRisk >= 70) { score += 20; factors.push(`High crawl risk: ${crawlRisk}/100 — may trigger rate limiting or bot detection`); }

  if (analysis.origin === "external" && decision === "DOWNLOAD") { score += 10; factors.push("Downloading from external domain — verify content integrity"); }

  if (analysis.resourceType === "javascript" && analysis.origin !== "same-domain") {
    score += 15;
    factors.push("Third-party JavaScript — supply-chain risk; verify with SRI hash");
  }

  if (decision === "SKIP" && ri2Overall >= 60) {
    score += 20;
    factors.push(`Skipping high-value resource (RI-2: ${ri2Overall}) — reconstruction fidelity may be reduced`);
  }

  const level: RiskLevel = score >= 60 ? "critical" : score >= 40 ? "high" : score >= 20 ? "medium" : "low";
  return { level, score: Math.min(100, score), factors: factors.length ? factors : ["No significant risk factors identified"] };
}

// ── Alternatives generator ────────────────────────────────────────────────────
function buildAlternatives(
  primary: ResourceDecision,
  ri2Overall: number,
  origin: ResourceOrigin,
): Array<{ decision: ResourceDecision; reason: string }> {
  const alts: Array<{ decision: ResourceDecision; reason: string }> = [];
  if (primary !== "SKIP" && ri2Overall < 40) {
    alts.push({ decision: "SKIP", reason: "If storage budget is constrained, skip this low-value resource" });
  }
  if (primary === "DOWNLOAD" && (origin === "cdn" || origin === "external")) {
    alts.push({ decision: "REFERENCE", reason: "Use external URL reference to reduce storage footprint" });
  }
  if (primary === "DOWNLOAD" && ri2Overall >= 60 && ri2Overall < 80) {
    alts.push({ decision: "DEFER", reason: "Defer until after essential resources are acquired" });
  }
  if (primary === "DEFER") {
    alts.push({ decision: "DOWNLOAD", reason: "Upgrade to immediate download if bandwidth allows" });
  }
  if (primary === "REFERENCE" && ri2Overall >= 75) {
    alts.push({ decision: "DOWNLOAD", reason: "Download for full offline reconstruction capability" });
  }
  return alts;
}

// ── Core per-resource decision function ──────────────────────────────────────
export function makeResourceDecision(
  analysis: ResourceAnalysis,
  ri2Overall: number,
  ri2Dims: Partial<ReconstructionValueDimensions>,
  ctx: DecisionContext,
  ruleActivations: Record<string, number>,
): ResourceDecisionResult {
  const estimatedMb = estimateSizeMb(analysis, ri2Overall);
  const { budgets } = ctx;

  const rule = evaluateRules(analysis, ri2Overall, ri2Dims, ctx, estimatedMb, ruleActivations);

  const storageAfter   = budgets.usedStorageMb   + (rule.decision === "DOWNLOAD" ? estimatedMb : 0);
  const bandwidthAfter = budgets.usedBandwidthMb + (rule.decision === "DOWNLOAD" || rule.decision === "DEFER" || rule.decision === "STREAM" ? estimatedMb : 0);
  const withinBudget   =
    (budgets.storageMb   === 0 || storageAfter   <= budgets.storageMb)   &&
    (budgets.bandwidthMb === 0 || bandwidthAfter <= budgets.bandwidthMb);

  const benefit = ri2Overall;

  const riskResult = assessRisk(analysis, rule.decision, ri2Overall);
  const alternatives = buildAlternatives(rule.decision, ri2Overall, analysis.origin);

  const auditTrail = [
    `RI-1 score: ${analysis.scores.resourceIntelligenceScore} | priority: ${analysis.priority}`,
    `RI-2 overall: ${ri2Overall} | visual: ${ri2Dims.visualReconstruction ?? "?"} | brand: ${ri2Dims.brandDna ?? "?"} | offline: ${ri2Dims.offlineReconstruction ?? "?"}`,
    `Origin: ${analysis.origin} | type: ${analysis.resourceType} | tags: [${analysis.tags.join(", ")}]`,
    `Context: goal=${ctx.reconstructionGoal}, phase=${ctx.crawlPhase}, offline=${ctx.offlineMode}`,
    `Budget: storage=${budgets.usedStorageMb.toFixed(1)}/${budgets.storageMb || "∞"} MB, bandwidth=${budgets.usedBandwidthMb.toFixed(1)}/${budgets.bandwidthMb || "∞"} MB`,
    `Estimated cost: ${estimatedMb.toFixed(3)} MB`,
    `Rule matched: ${rule.ruleName}`,
    `→ Decision: ${rule.decision} (confidence: ${rule.confidence}%)`,
  ];

  return {
    id:                  analysis.id,
    url:                 analysis.url,
    resourceType:        analysis.resourceType,
    label:               humanLabel(analysis.url),
    decision:            rule.decision,
    confidence:          rule.confidence,
    reason:              rule.reason,
    supportingEvidence:  [...rule.evidence, ...riskResult.factors.filter(f => !rule.evidence.includes(f))],
    estimatedCostMb:     estimatedMb,
    estimatedBandwidthMb:estimatedMb,
    estimatedBenefit:    benefit,
    riskAssessment:      riskResult,
    ri1Score:            analysis.scores.resourceIntelligenceScore,
    ri2Overall,
    ri2Dimensions:       ri2Dims,
    budgetImpact:        { storageAfterMb: storageAfter, bandwidthAfterMb: bandwidthAfter, withinBudget },
    alternatives,
    auditTrail,
    decidedAt:           new Date().toISOString(),
  };
}

// ── Report builders ───────────────────────────────────────────────────────────
function buildDecisionReport(
  jobId: string,
  seedUrl: string,
  ctx: DecisionContext,
  decisions: ResourceDecisionResult[],
): ResourceDecisionReport {
  const byDecision: Record<ResourceDecision, number> = {
    DOWNLOAD: 0, REFERENCE: 0, DEFER: 0, STREAM: 0, CACHE: 0, SKIP: 0,
  };
  for (const d of decisions) byDecision[d.decision]++;
  return {
    jobId,
    seedUrl,
    generatedAt: new Date().toISOString(),
    phase: "RI-3",
    context: ctx,
    totalResources: decisions.length,
    byDecision,
    decisions,
    summary: `RI-3 decided on ${decisions.length} resources: ` +
      `DOWNLOAD=${byDecision.DOWNLOAD}, REFERENCE=${byDecision.REFERENCE}, ` +
      `DEFER=${byDecision.DEFER}, STREAM=${byDecision.STREAM}, ` +
      `CACHE=${byDecision.CACHE}, SKIP=${byDecision.SKIP}.`,
  };
}

function buildDownloadPlan(
  jobId: string,
  decisions: ResourceDecisionResult[],
): DownloadPlan {
  const actionable = decisions
    .filter(d => d.decision === "DOWNLOAD" || d.decision === "DEFER" || d.decision === "STREAM")
    .sort((a, b) => {
      // DOWNLOAD first, sorted by RI-2 overall descending
      if (a.decision !== b.decision) {
        const order = { DOWNLOAD: 0, CACHE: 1, DEFER: 2, STREAM: 3, REFERENCE: 4, SKIP: 5 };
        return order[a.decision] - order[b.decision];
      }
      return b.ri2Overall - a.ri2Overall;
    });

  let cumulative = 0;
  const plan = actionable.map((d, i) => {
    cumulative += d.estimatedCostMb;
    return {
      rank:            i + 1,
      decision:        d.decision,
      url:             d.url,
      resourceType:    d.resourceType,
      estimatedCostMb: d.estimatedCostMb,
      ri2Overall:      d.ri2Overall,
      confidence:      d.confidence,
      reason:          d.reason,
      cumulativeMb:    parseFloat(cumulative.toFixed(3)),
    };
  });

  return {
    jobId,
    generatedAt: new Date().toISOString(),
    phase: "RI-3",
    totalDownloads: decisions.filter(d => d.decision === "DOWNLOAD").length,
    totalDeferreds: decisions.filter(d => d.decision === "DEFER").length,
    totalStreams:   decisions.filter(d => d.decision === "STREAM").length,
    estimatedMb:   parseFloat(cumulative.toFixed(3)),
    plan,
  };
}

function buildBudgetReport(
  jobId: string,
  ctx: DecisionContext,
  decisions: ResourceDecisionResult[],
): ResourceBudgetReport {
  const byDecision: Record<ResourceDecision, number> = {
    DOWNLOAD: 0, REFERENCE: 0, DEFER: 0, STREAM: 0, CACHE: 0, SKIP: 0,
  };
  let totalStorage = 0, totalBandwidth = 0, potentialStorage = 0;
  const topCost: Array<{ url: string; costMb: number; decision: ResourceDecision }> = [];

  for (const d of decisions) {
    byDecision[d.decision]++;
    if (d.decision === "DOWNLOAD") { totalStorage += d.estimatedCostMb; totalBandwidth += d.estimatedBandwidthMb; }
    if (d.decision === "DEFER" || d.decision === "STREAM") { totalBandwidth += d.estimatedBandwidthMb; }
    potentialStorage += d.estimatedCostMb;
    topCost.push({ url: d.url, costMb: d.estimatedCostMb, decision: d.decision });
  }

  topCost.sort((a, b) => b.costMb - a.costMb);
  const savingsMb = potentialStorage - totalStorage;

  const { storageMb, bandwidthMb, memoryMb, usedStorageMb, usedBandwidthMb, usedMemoryMb } = ctx.budgets;

  return {
    jobId,
    generatedAt: new Date().toISOString(),
    phase: "RI-3",
    budgets: ctx.budgets,
    consumption: {
      downloadCount:    byDecision.DOWNLOAD,
      referenceCount:   byDecision.REFERENCE,
      deferCount:       byDecision.DEFER,
      streamCount:      byDecision.STREAM,
      cacheCount:       byDecision.CACHE,
      skipCount:        byDecision.SKIP,
      totalStorageMb:   parseFloat(totalStorage.toFixed(3)),
      totalBandwidthMb: parseFloat(totalBandwidth.toFixed(3)),
      savingsMb:        parseFloat(savingsMb.toFixed(3)),
    },
    budgetStatus: {
      storage:   budgetStatus(usedStorageMb + totalStorage, storageMb),
      bandwidth: budgetStatus(usedBandwidthMb + totalBandwidth, bandwidthMb),
      memory:    budgetStatus(usedMemoryMb, memoryMb),
    },
    topCostResources: topCost.slice(0, 20),
    summary: `Budget usage: ${(usedStorageMb + totalStorage).toFixed(1)}/${storageMb || "∞"} MB storage, ` +
      `${(usedBandwidthMb + totalBandwidth).toFixed(1)}/${bandwidthMb || "∞"} MB bandwidth. ` +
      `Saved ${savingsMb.toFixed(1)} MB by SKIP/REFERENCE decisions.`,
  };
}

function buildAuditReport(
  jobId: string,
  ctx: DecisionContext,
  decisions: ResourceDecisionResult[],
  ruleActivations: Record<string, number>,
): DecisionAuditReport {
  const byDecision: Record<ResourceDecision, number> = {
    DOWNLOAD: 0, REFERENCE: 0, DEFER: 0, STREAM: 0, CACHE: 0, SKIP: 0,
  };
  const skippedReasons: Record<string, number> = {};
  let totalConfidence = 0;
  let lowConfidenceCount = 0;

  for (const d of decisions) {
    byDecision[d.decision]++;
    totalConfidence += d.confidence;
    if (d.confidence < 50) lowConfidenceCount++;
    if (d.decision === "SKIP") {
      skippedReasons[d.reason] = (skippedReasons[d.reason] ?? 0) + 1;
    }
  }

  return {
    jobId,
    generatedAt: new Date().toISOString(),
    phase: "RI-3",
    context: ctx,
    totalDecisions: decisions.length,
    byDecision,
    skippedReasons,
    confidenceAvg: decisions.length ? Math.round(totalConfidence / decisions.length) : 0,
    lowConfidenceCount,
    overrides: [],
    ruleActivations,
    decisions,
  };
}

// ── R2 persistence ────────────────────────────────────────────────────────────
async function storeReport(jobId: string, filename: string, data: unknown): Promise<string | null> {
  const provider = createCloudProvider("r2");
  if (!provider.isConfigured()) return null;
  const key = `ri3/${jobId}/${filename}`;
  try {
    await provider.upload({
      key,
      data: Buffer.from(JSON.stringify(data, null, 2), "utf-8"),
      contentType: "application/json",
      checkDuplicate: false,
    });
    return key;
  } catch (err) {
    logger.warn({ jobId, key, err }, "RI-3: failed to store report to R2");
    return null;
  }
}

// ── In-memory cache ───────────────────────────────────────────────────────────
interface Ri3Cache {
  decisionReport: ResourceDecisionReport;
  downloadPlan:   DownloadPlan;
  budgetReport:   ResourceBudgetReport;
  auditReport:    DecisionAuditReport;
  r2Keys:         string[];
}

const cache = new Map<string, Ri3Cache>();

export function getCachedRi3Reports(jobId: string): Ri3Cache | null {
  return cache.get(jobId) ?? null;
}

// ── Main entry — full job analysis ────────────────────────────────────────────
export async function runResourceDecisionEngine(
  jobId: string,
  ctx: Partial<DecisionContext> = {},
): Promise<Ri3Cache> {
  const startMs = Date.now();
  const fullCtx: DecisionContext = { ...DEFAULT_CONTEXT, ...ctx, budgets: { ...UNLIMITED_BUDGETS, ...(ctx.budgets ?? {}) } };

  logger.info({ jobId, ctx: fullCtx }, "RI-3: starting intelligent resource decision analysis");

  // Load RI-1 resources
  const ri1 = getCachedRiReports(jobId);
  let ri1Resources: ResourceAnalysis[] = ri1?.intelligence.resources ?? [];

  // Fallback: load manifest resources
  if (ri1Resources.length === 0) {
    const manifest = await loadManifest(jobId);
    if (!manifest) throw new Error(`No RI-1 cache and no manifest found for job ${jobId}. Run RI-1 first.`);
    const nodes = manifest.nodes instanceof Map
      ? [...manifest.nodes.values()]
      : (Object.values(manifest.nodes ?? {}) as import("./manifest.js").PageNode[]);
    let idx = 0;
    const seen = new Set<string>();
    for (const node of nodes) {
      for (const img of node.media?.images ?? []) {
        if (seen.has(img.sourceUrl)) continue;
        seen.add(img.sourceUrl);
        ri1Resources.push(evaluateSingleResource(img.sourceUrl, manifest.seedUrl ?? "", img.mimeType ?? null, img.byteSize ?? null));
        idx++;
      }
    }
  }

  if (ri1Resources.length === 0) throw new Error(`No resources found for job ${jobId}.`);

  // Load RI-2 cache for reconstruction value lookups
  const ri2Cache = getCachedRi2Reports(jobId);
  const ri2Map = new Map<string, import("./reconstruction-value-engine-ri2.js").ResourceValueEntry>();
  if (ri2Cache) {
    for (const entry of ri2Cache.valueReport.resources) {
      ri2Map.set(entry.id, entry);
      ri2Map.set(entry.url, entry);
    }
  }

  const ruleActivations: Record<string, number> = {};
  const decisions: ResourceDecisionResult[] = [];
  const budgets = { ...fullCtx.budgets };

  for (const analysis of ri1Resources) {
    // Resolve RI-2 score for this resource
    const ri2Entry = ri2Map.get(analysis.id) ?? ri2Map.get(analysis.url);
    let ri2Overall = ri2Entry?.dimensions.overall ?? 0;
    let ri2Dims: Partial<ReconstructionValueDimensions> = ri2Entry?.dimensions ?? {};

    // Fallback: inline RI-2 scoring if cache miss
    if (!ri2Entry) {
      const scored = scoreMinimalResource({
        id:           analysis.id,
        url:          analysis.url,
        resourceType: analysis.resourceType,
        mimeType:     analysis.mimeType ?? undefined,
        byteSize:     analysis.estimatedBytes ?? undefined,
        tags:         analysis.tags,
        origin:       analysis.origin,
      });
      ri2Overall = scored.dimensions.overall;
      ri2Dims    = scored.dimensions;
    }

    // Make the decision (pass live budget state)
    const ctxWithBudget: DecisionContext = { ...fullCtx, budgets: { ...budgets } };
    const result = makeResourceDecision(analysis, ri2Overall, ri2Dims, ctxWithBudget, ruleActivations);
    decisions.push(result);

    // Update running budget consumption
    if (result.decision === "DOWNLOAD") {
      budgets.usedStorageMb   += result.estimatedCostMb;
      budgets.usedBandwidthMb += result.estimatedBandwidthMb;
    }
  }

  const seedUrl = ri1?.intelligence.seedUrl ?? jobId;
  const decisionReport = buildDecisionReport(jobId, seedUrl, fullCtx, decisions);
  const downloadPlan   = buildDownloadPlan(jobId, decisions);
  const budgetReport   = buildBudgetReport(jobId, { ...fullCtx, budgets }, decisions);
  const auditReport    = buildAuditReport(jobId, fullCtx, decisions, ruleActivations);

  const [k1, k2, k3, k4] = await Promise.all([
    storeReport(jobId, "resource-decision-report.json",  decisionReport),
    storeReport(jobId, "download-plan.json",             downloadPlan),
    storeReport(jobId, "resource-budget-report.json",    budgetReport),
    storeReport(jobId, "decision-audit-report.json",     auditReport),
  ]);
  const r2Keys = [k1, k2, k3, k4].filter(Boolean) as string[];

  const result: Ri3Cache = { decisionReport, downloadPlan, budgetReport, auditReport, r2Keys };
  cache.set(jobId, result);

  logger.info({
    jobId,
    totalResources: decisions.length,
    byDecision: decisionReport.byDecision,
    durationMs: Date.now() - startMs,
    r2Keys: r2Keys.length,
  }, "RI-3: resource decision engine complete");

  return result;
}

// ── Single-resource decision gate (replaces shouldDownloadResource) ───────────
// This is the unified gate used by the scraper and every other subsystem.

export interface Ri3GateResult {
  decision:        ResourceDecision;
  download:        boolean;   // convenience: true only when decision === "DOWNLOAD"
  confidence:      number;
  reason:          string;
  ri1Score:        number;
  ri2Overall:      number;
  estimatedCostMb: number;
  risk:            RiskLevel;
  auditTrail:      string[];
}

export function evaluateSingleDecision(
  url:         string,
  seedUrl:     string,
  mimeType?:   string | null,
  byteSize?:   number | null,
  tags?:       string[],
  ctx?:        Partial<DecisionContext>,
): Ri3GateResult {
  const analysis = evaluateSingleResource(url, seedUrl, mimeType ?? null, byteSize ?? null);
  if (tags?.length) analysis.tags = [...analysis.tags, ...tags];

  const scored = scoreMinimalResource({
    id:           analysis.id,
    url:          analysis.url,
    resourceType: analysis.resourceType,
    mimeType:     mimeType ?? undefined,
    byteSize:     byteSize ?? undefined,
    tags:         analysis.tags,
    origin:       analysis.origin,
  });

  const fullCtx: DecisionContext = { ...DEFAULT_CONTEXT, ...(ctx ?? {}), budgets: { ...UNLIMITED_BUDGETS, ...(ctx?.budgets ?? {}) } };
  const activations: Record<string, number> = {};
  const result = makeResourceDecision(analysis, scored.dimensions.overall, scored.dimensions, fullCtx, activations);

  return {
    decision:        result.decision,
    download:        result.decision === "DOWNLOAD",
    confidence:      result.confidence,
    reason:          result.reason,
    ri1Score:        result.ri1Score,
    ri2Overall:      result.ri2Overall,
    estimatedCostMb: result.estimatedCostMb,
    risk:            result.riskAssessment.level,
    auditTrail:      result.auditTrail,
  };
}

// ── Batch evaluation ──────────────────────────────────────────────────────────
export function evaluateBatchDecisions(
  resources: Array<{ url: string; seedUrl: string; mimeType?: string | null; byteSize?: number | null; tags?: string[] }>,
  ctx?: Partial<DecisionContext>,
): Ri3GateResult[] {
  return resources.map(r => evaluateSingleDecision(r.url, r.seedUrl, r.mimeType, r.byteSize, r.tags, ctx));
}

// ── Fire-and-forget trigger ───────────────────────────────────────────────────
export function triggerResourceDecisionAsync(jobId: string, ctx?: Partial<DecisionContext>): void {
  runResourceDecisionEngine(jobId, ctx).catch((err: unknown) => {
    logger.warn({ jobId, err }, "RI-3: background decision analysis failed (non-fatal)");
  });
}
