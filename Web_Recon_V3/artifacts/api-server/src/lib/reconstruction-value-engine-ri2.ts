/**
 * reconstruction-value-engine-ri2.ts — Phase RI-2: Reconstruction Value Engine
 *
 * Estimates how much each discovered resource contributes to faithfully
 * rebuilding a website. Operates independently of download cost.
 *
 * Computes per resource (0-100 each):
 *   1. Visual Reconstruction Value   — visual fidelity contribution
 *   2. Design DNA Value              — design-token extraction potential
 *   3. Brand DNA Value               — brand-identity embodiment
 *   4. Website Prime Value           — contribution to the generated prime site
 *   5. Backend Value                 — backend/API reconstruction value
 *   6. Offline Reconstruction Value  — reconstructable without network
 *   7. Runtime Dependency Value      — required at page runtime
 *   8. Historical Reusability        — reusable across future reconstructions
 *   9. Future Reconstruction Value   — value for future site versions
 *  10. Overall Reconstruction Value  — weighted composite (0-100)
 *
 * Outputs (R2 + in-memory cache):
 *   reconstruction-value-report.json
 *   resource-value-ranking.json
 *   website-prime-value-report.json
 */

import { logger }              from "./logger.js";
import { loadManifest }        from "./manifest-store.js";
import { createCloudProvider } from "../cloud/index.js";
import {
  getCachedRiReports,
  type ResourceAnalysis,
  type ResourceType,
} from "./resource-intelligence-engine-ri1.js";
import type { PageNode } from "./manifest.js";

// ── Dimension weights (must sum to 1.0) ───────────────────────────────────────
const W = {
  visualReconstruction:   0.28,
  designDna:              0.10,
  brandDna:               0.12,
  websitePrime:           0.16,
  backend:                0.05,
  offlineReconstruction:  0.14,
  runtimeDependency:      0.07,
  historicalReusability:  0.05,
  futureReconstruction:   0.03,
} as const;

// ── Value tiers ───────────────────────────────────────────────────────────────
export type ValueTier = "essential" | "high" | "medium" | "low" | "negligible";

function scoreTier(overall: number): ValueTier {
  if (overall >= 80) return "essential";
  if (overall >= 60) return "high";
  if (overall >= 35) return "medium";
  if (overall >= 12) return "low";
  return "negligible";
}

// ── Dimension set ─────────────────────────────────────────────────────────────
export interface ReconstructionValueDimensions {
  visualReconstruction:  number;
  designDna:             number;
  brandDna:              number;
  websitePrime:          number;
  backend:               number;
  offlineReconstruction: number;
  runtimeDependency:     number;
  historicalReusability: number;
  futureReconstruction:  number;
  overall:               number;
}

// ── Per-resource value entry ──────────────────────────────────────────────────
export interface ResourceValueEntry {
  id:             string;
  url:            string;
  resourceType:   ResourceType;
  label:          string;
  dimensions:     ReconstructionValueDimensions;
  rank:           number;
  tier:           ValueTier;
  rationale:      string;
  topDimension:   string;
  topScore:       number;
}

// ── Report shapes ─────────────────────────────────────────────────────────────
export interface ReconstructionValueReport {
  jobId:              string;
  seedUrl:            string;
  generatedAt:        string;
  phase:              "RI-2";
  totalResources:     number;
  averageOverallScore:number;
  byTier:             Record<ValueTier, number>;
  topResources:       ResourceValueEntry[];
  resources:          ResourceValueEntry[];
  summary:            string;
}

export interface ResourceValueRanking {
  jobId:       string;
  generatedAt: string;
  phase:       "RI-2";
  total:       number;
  ranked:      Array<{
    rank:              number;
    id:                string;
    url:               string;
    resourceType:      ResourceType;
    label:             string;
    overall:           number;
    tier:              ValueTier;
    topDimension:      string;
    topScore:          number;
    visualReconstruction:  number;
    brandDna:              number;
    offlineReconstruction: number;
  }>;
}

export interface WebsitePrimeValueReport {
  jobId:               string;
  generatedAt:         string;
  phase:               "RI-2";
  websitePrimeScore:   number;
  primeCompleteness:   number;
  essentialForPrime:   ResourceValueEntry[];
  supportingForPrime:  ResourceValueEntry[];
  optionalForPrime:    ResourceValueEntry[];
  missingCritical:     string[];
  summary:             string;
}

// ── Scoring configuration per resource type ───────────────────────────────────
// Base scores before URL / tag modifiers are applied.

interface BaseDimScores {
  visualReconstruction:  number;
  designDna:             number;
  brandDna:              number;
  websitePrime:          number;
  backend:               number;
  offlineReconstruction: number;
  runtimeDependency:     number;
  historicalReusability: number;
  futureReconstruction:  number;
}

const BASE_SCORES: Record<string, BaseDimScores> = {
  // CSS ──────────────────────────────────────────────────────────────────────
  css_theme: {
    visualReconstruction:  100, designDna: 100, brandDna: 85,
    websitePrime: 98,  backend: 20,  offlineReconstruction: 100,
    runtimeDependency: 72, historicalReusability: 88, futureReconstruction: 90,
  },
  css_component: {
    visualReconstruction:  85, designDna: 78, brandDna: 55,
    websitePrime: 82,  backend: 15,  offlineReconstruction: 92,
    runtimeDependency: 62, historicalReusability: 72, futureReconstruction: 75,
  },
  css_framework: {
    visualReconstruction:  88, designDna: 82, brandDna: 28,
    websitePrime: 90,  backend: 12,  offlineReconstruction: 88,
    runtimeDependency: 65, historicalReusability: 90, futureReconstruction: 85,
  },
  css_generic: {
    visualReconstruction:  78, designDna: 70, brandDna: 45,
    websitePrime: 75,  backend: 12,  offlineReconstruction: 88,
    runtimeDependency: 58, historicalReusability: 65, futureReconstruction: 68,
  },
  // JavaScript ───────────────────────────────────────────────────────────────
  js_framework: {
    visualReconstruction:  68, designDna: 12, brandDna: 5,
    websitePrime: 95,  backend: 42,  offlineReconstruction: 85,
    runtimeDependency: 95, historicalReusability: 80, futureReconstruction: 80,
  },
  js_analytics: {
    visualReconstruction:   0, designDna:  0, brandDna:  0,
    websitePrime:  5,  backend:  5,  offlineReconstruction:  0,
    runtimeDependency: 32, historicalReusability:  5, futureReconstruction: 5,
  },
  js_cookie_banner: {
    visualReconstruction:   5, designDna:  0, brandDna:  5,
    websitePrime: 10,  backend: 10,  offlineReconstruction:  5,
    runtimeDependency: 25, historicalReusability: 10, futureReconstruction: 5,
  },
  js_animation: {
    visualReconstruction:  65, designDna: 18, brandDna: 22,
    websitePrime: 55,  backend:  5,  offlineReconstruction: 72,
    runtimeDependency: 60, historicalReusability: 55, futureReconstruction: 58,
  },
  js_utility: {
    visualReconstruction:  10, designDna:  5, brandDna:  0,
    websitePrime: 62,  backend: 32,  offlineReconstruction: 75,
    runtimeDependency: 70, historicalReusability: 60, futureReconstruction: 55,
  },
  js_auth: {
    visualReconstruction:   8, designDna:  5, brandDna:  8,
    websitePrime: 55,  backend: 72,  offlineReconstruction: 55,
    runtimeDependency: 65, historicalReusability: 40, futureReconstruction: 45,
  },
  js_generic: {
    visualReconstruction:  25, designDna:  8, brandDna:  5,
    websitePrime: 45,  backend: 18,  offlineReconstruction: 60,
    runtimeDependency: 50, historicalReusability: 35, futureReconstruction: 38,
  },
  // Images ───────────────────────────────────────────────────────────────────
  image_hero: {
    visualReconstruction:  95, designDna: 65, brandDna: 90,
    websitePrime: 88,  backend: 10,  offlineReconstruction: 95,
    runtimeDependency: 15, historicalReusability: 62, futureReconstruction: 72,
  },
  image_logo: {
    visualReconstruction:  90, designDna: 68, brandDna: 100,
    websitePrime: 92,  backend: 10,  offlineReconstruction: 98,
    runtimeDependency: 12, historicalReusability: 78, futureReconstruction: 82,
  },
  image_background: {
    visualReconstruction:  78, designDna: 55, brandDna: 62,
    websitePrime: 68,  backend:  5,  offlineReconstruction: 80,
    runtimeDependency: 10, historicalReusability: 42, futureReconstruction: 52,
  },
  image_product: {
    visualReconstruction:  70, designDna: 40, brandDna: 45,
    websitePrime: 62,  backend: 15,  offlineReconstruction: 75,
    runtimeDependency: 10, historicalReusability: 35, futureReconstruction: 42,
  },
  image_icon: {
    visualReconstruction:  60, designDna: 32, brandDna: 52,
    websitePrime: 58,  backend:  5,  offlineReconstruction: 88,
    runtimeDependency: 10, historicalReusability: 72, futureReconstruction: 65,
  },
  image_generic: {
    visualReconstruction:  60, designDna: 38, brandDna: 38,
    websitePrime: 55,  backend:  8,  offlineReconstruction: 72,
    runtimeDependency: 10, historicalReusability: 32, futureReconstruction: 40,
  },
  // Fonts ────────────────────────────────────────────────────────────────────
  font_custom: {
    visualReconstruction:  78, designDna: 92, brandDna: 88,
    websitePrime: 82,  backend:  5,  offlineReconstruction: 92,
    runtimeDependency: 52, historicalReusability: 78, futureReconstruction: 72,
  },
  font_generic: {
    visualReconstruction:  42, designDna: 62, brandDna: 32,
    websitePrime: 58,  backend:  5,  offlineReconstruction: 78,
    runtimeDependency: 38, historicalReusability: 62, futureReconstruction: 58,
  },
  // SVG ──────────────────────────────────────────────────────────────────────
  svg_logo: {
    visualReconstruction:  92, designDna: 72, brandDna: 100,
    websitePrime: 92,  backend: 10,  offlineReconstruction: 100,
    runtimeDependency: 12, historicalReusability: 82, futureReconstruction: 85,
  },
  svg_icon: {
    visualReconstruction:  65, designDna: 38, brandDna: 48,
    websitePrime: 65,  backend:  5,  offlineReconstruction: 98,
    runtimeDependency: 10, historicalReusability: 78, futureReconstruction: 72,
  },
  svg_illustration: {
    visualReconstruction:  75, designDna: 58, brandDna: 65,
    websitePrime: 62,  backend:  5,  offlineReconstruction: 95,
    runtimeDependency: 10, historicalReusability: 52, futureReconstruction: 58,
  },
  svg_generic: {
    visualReconstruction:  68, designDna: 48, brandDna: 52,
    websitePrime: 58,  backend:  5,  offlineReconstruction: 95,
    runtimeDependency: 10, historicalReusability: 58, futureReconstruction: 60,
  },
  // Fonts via CSS @import ────────────────────────────────────────────────────
  // Videos & Audio ──────────────────────────────────────────────────────────
  video: {
    visualReconstruction:  65, designDna: 32, brandDna: 58,
    websitePrime: 52,  backend: 10,  offlineReconstruction: 62,
    runtimeDependency: 30, historicalReusability: 35, futureReconstruction: 40,
  },
  audio: {
    visualReconstruction:   5, designDna:  5, brandDna: 22,
    websitePrime: 25,  backend:  5,  offlineReconstruction: 55,
    runtimeDependency: 25, historicalReusability: 20, futureReconstruction: 20,
  },
  // Data & API ───────────────────────────────────────────────────────────────
  json_api: {
    visualReconstruction:  15, designDna: 12, brandDna:  5,
    websitePrime: 82,  backend: 95,  offlineReconstruction: 72,
    runtimeDependency: 85, historicalReusability: 65, futureReconstruction: 75,
  },
  json_config: {
    visualReconstruction:   5, designDna: 22, brandDna:  5,
    websitePrime: 62,  backend: 72,  offlineReconstruction: 68,
    runtimeDependency: 52, historicalReusability: 72, futureReconstruction: 68,
  },
  json_design_tokens: {
    visualReconstruction:  90, designDna: 100, brandDna: 85,
    websitePrime: 95,  backend: 15,  offlineReconstruction: 100,
    runtimeDependency: 60, historicalReusability: 95, futureReconstruction: 95,
  },
  // WASM, Docs, Others ───────────────────────────────────────────────────────
  wasm: {
    visualReconstruction:  10, designDna:  0, brandDna:  0,
    websitePrime: 65,  backend: 42,  offlineReconstruction: 72,
    runtimeDependency: 82, historicalReusability: 55, futureReconstruction: 60,
  },
  document: {
    visualReconstruction:  22, designDna: 32, brandDna: 38,
    websitePrime: 32,  backend: 25,  offlineReconstruction: 70,
    runtimeDependency: 10, historicalReusability: 42, futureReconstruction: 38,
  },
  xml: {
    visualReconstruction:   5, designDna:  8, brandDna:  5,
    websitePrime: 35,  backend: 48,  offlineReconstruction: 65,
    runtimeDependency: 30, historicalReusability: 45, futureReconstruction: 42,
  },
  html: {
    visualReconstruction:  45, designDna: 25, brandDna: 20,
    websitePrime: 55,  backend: 38,  offlineReconstruction: 68,
    runtimeDependency: 40, historicalReusability: 35, futureReconstruction: 38,
  },
  ico: {
    visualReconstruction:  55, designDna: 35, brandDna: 85,
    websitePrime: 60,  backend:  5,  offlineReconstruction: 95,
    runtimeDependency:  8, historicalReusability: 65, futureReconstruction: 62,
  },
  api_endpoint: {
    visualReconstruction:  10, designDna:  5, brandDna:  5,
    websitePrime: 78,  backend: 95,  offlineReconstruction: 55,
    runtimeDependency: 88, historicalReusability: 68, futureReconstruction: 75,
  },
  other: {
    visualReconstruction:  20, designDna: 10, brandDna: 10,
    websitePrime: 30,  backend: 15,  offlineReconstruction: 50,
    runtimeDependency: 20, historicalReusability: 25, futureReconstruction: 25,
  },
};

// ── URL-based category detection ──────────────────────────────────────────────
function detectCategory(url: string, rType: ResourceType, tags: string[]): string {
  const u = url.toLowerCase();
  const filename = u.split("?")[0]!.split("#")[0]!.split("/").pop() ?? "";
  const hasTag = (t: string) => tags.includes(t);

  // CSS categories
  if (rType === "css") {
    if (/theme|global|base|root|main|app|styles?|design-token|token|variable|custom-prop/.test(u)) return "css_theme";
    if (/tailwind|bootstrap|bulma|foundation|materialize|semantic-ui|uikit/.test(u)) return "css_framework";
    if (/component|module|layout|grid|util|helper|atom/.test(u)) return "css_component";
    return "css_generic";
  }

  // JavaScript categories
  if (rType === "javascript") {
    if (/gtag|google-analytics|ga\.js|analytics|segment|mixpanel|amplitude|hotjar|heap|clarity|fbq|facebook.*pixel|twitter.*pixel|tiktok.*pixel/.test(u)) return "js_analytics";
    if (/cookieconsent|cookie.*banner|onetrust|gdpr|ccpa|tarteaucitron|quantcast|didomi|iubenda|cookiebot/.test(u)) return "js_cookie_banner";
    if (/react|vue|angular|svelte|next|nuxt|remix|solid|ember|backbone|alpine/.test(u)) return "js_framework";
    if (/gsap|framer.*motion|lottie|anime\.js|velocity|scrollmagic|motion\.js/.test(u)) return "js_animation";
    if (/auth|oauth|login|jwt|session|keycloak|auth0|clerk|firebase.*auth/.test(u)) return "js_auth";
    if (/lodash|underscore|moment|dayjs|axios|ky|got|fetch.*polyfill|core-js|polyfill/.test(u)) return "js_utility";
    if (hasTag("render-blocking")) return "js_framework";
    return "js_generic";
  }

  // Image categories
  if (rType === "image") {
    if (/logo|brand/.test(filename) || /\/logo\/|\/brand\/|\/identity\//.test(u)) return "image_logo";
    if (/hero|banner|header-bg|cover|splash|above.*fold|jumbotron/.test(u)) return "image_hero";
    if (/bg|background|backdrop|texture|pattern/.test(filename) || /\/bg\/|\/background\//.test(u)) return "image_background";
    if (/product|item|sku|catalog|shop/.test(u)) return "image_product";
    if (/icon|ico|sprite|favicon/.test(filename) && rType === "image") return "image_icon";
    return "image_generic";
  }

  // SVG categories
  if (rType === "svg") {
    if (/logo|brand/.test(filename) || /\/logo\/|\/brand\//.test(u)) return "svg_logo";
    if (/icon|ico|sprite|symbol/.test(filename) || /\/icons\/|\/sprites\//.test(u)) return "svg_icon";
    if (/illustration|graphic|artwork|drawing/.test(u)) return "svg_illustration";
    return "svg_generic";
  }

  // Font categories
  if (rType === "font") {
    if (/google.*font|fonts\.google|typekit|adobe.*font|cloud\.typography|fonts\.com/.test(u)) return "font_generic";
    return "font_custom";
  }

  // Video / audio
  if (rType === "video") return "video";
  if (rType === "audio") return "audio";

  // JSON / data
  if (rType === "json") {
    if (/design.*token|token.*design|theme\.json|style.*guide/.test(u)) return "json_design_tokens";
    if (/api\/|\.api\.|endpoint|data|feed|rest|graphql/.test(u)) return "json_api";
    return "json_config";
  }

  // Others
  if (rType === "api-endpoint") return "api_endpoint";
  if (rType === "wasm") return "wasm";
  if (rType === "pdf" || rType === "document") return "document";
  if (rType === "xml") return "xml";
  if (rType === "html") return "html";
  if (rType === "ico") return "ico";
  if (rType === "other-static") return "other";

  return "other";
}

// ── Modifier signals ──────────────────────────────────────────────────────────
function applyModifiers(
  base: BaseDimScores,
  analysis: ResourceAnalysis,
): BaseDimScores {
  const tags = analysis.tags;
  const scores = { ...base };

  // External (CDN/third-party) reduces offline and reusability
  if (analysis.origin === "external" || analysis.origin === "cdn") {
    scores.offlineReconstruction = Math.max(0, scores.offlineReconstruction - 20);
    scores.historicalReusability = Math.max(0, scores.historicalReusability - 10);
  }

  // Render-blocking boosts visual and runtime
  if (tags.includes("render-blocking")) {
    scores.visualReconstruction = Math.min(100, scores.visualReconstruction + 8);
    scores.runtimeDependency    = Math.min(100, scores.runtimeDependency + 10);
  }

  // Above-fold boosts visual and brand
  if (tags.includes("above-fold")) {
    scores.visualReconstruction = Math.min(100, scores.visualReconstruction + 6);
    scores.brandDna             = Math.min(100, scores.brandDna + 5);
  }

  // Analytics tag zeros out most value dimensions
  if (tags.includes("analytics")) {
    scores.visualReconstruction = 0;
    scores.designDna            = 0;
    scores.brandDna             = 0;
    scores.offlineReconstruction = 0;
    scores.historicalReusability = Math.min(scores.historicalReusability, 8);
  }

  // Appears on many pages → higher prime and historical value
  const occurrences = analysis.occurrences ?? 1;
  if (occurrences > 5) {
    scores.websitePrime         = Math.min(100, scores.websitePrime + 8);
    scores.historicalReusability = Math.min(100, scores.historicalReusability + 5);
  }

  // Large assets: reduce offline a bit (cost to store)
  if ((analysis.estimatedBytes ?? 0) > 2_000_000) {
    scores.offlineReconstruction = Math.max(0, scores.offlineReconstruction - 8);
  }

  return scores;
}

// ── Weighted overall computation ──────────────────────────────────────────────
function computeOverall(d: BaseDimScores): number {
  const raw =
    d.visualReconstruction  * W.visualReconstruction  +
    d.designDna             * W.designDna             +
    d.brandDna              * W.brandDna              +
    d.websitePrime          * W.websitePrime          +
    d.backend               * W.backend               +
    d.offlineReconstruction * W.offlineReconstruction +
    d.runtimeDependency     * W.runtimeDependency     +
    d.historicalReusability * W.historicalReusability +
    d.futureReconstruction  * W.futureReconstruction;
  return Math.round(Math.min(100, Math.max(0, raw)));
}

// ── Human-readable label for a resource ──────────────────────────────────────
function makeLabel(url: string, rType: ResourceType): string {
  const filename = url.split("?")[0]!.split("#")[0]!.split("/").pop() ?? url;
  const ext = filename.includes(".") ? filename.split(".").pop()!.toUpperCase() : "";
  const base = filename.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ").trim();
  const display = base.length > 32 ? base.slice(0, 32) + "…" : base;
  return ext ? `${display} (${ext})` : (display || rType);
}

// ── Top dimension name ────────────────────────────────────────────────────────
function topDimension(dims: ReconstructionValueDimensions): { name: string; score: number } {
  const entries: Array<[string, number]> = [
    ["Visual Reconstruction",   dims.visualReconstruction],
    ["Design DNA",              dims.designDna],
    ["Brand DNA",               dims.brandDna],
    ["Website Prime",           dims.websitePrime],
    ["Backend",                 dims.backend],
    ["Offline Reconstruction",  dims.offlineReconstruction],
    ["Runtime Dependency",      dims.runtimeDependency],
    ["Historical Reusability",  dims.historicalReusability],
    ["Future Reconstruction",   dims.futureReconstruction],
  ];
  const [name, score] = entries.reduce((a, b) => (b[1] > a[1] ? b : a), ["", 0])!;
  return { name: name ?? "Overall", score: score ?? 0 };
}

// ── Rationale generator ───────────────────────────────────────────────────────
function makeRationale(
  rType: ResourceType,
  category: string,
  dims: ReconstructionValueDimensions,
): string {
  const tier = scoreTier(dims.overall);
  const top  = topDimension(dims);

  const typeDesc: Partial<Record<string, string>> = {
    css_theme:        "theme / global CSS — encodes the complete visual language of the site",
    css_framework:    "CSS framework — provides layout primitives used across every page",
    css_component:    "component-scoped CSS — scoped visual rules for a specific UI component",
    css_generic:      "CSS stylesheet",
    js_framework:     "JS framework bundle — required to render and hydrate any page",
    js_analytics:     "analytics / telemetry script — tracking only, zero reconstruction value",
    js_cookie_banner: "cookie-consent banner — third-party compliance widget, not site-specific",
    js_animation:     "animation library — visual motion layer, no structural reconstruction value",
    js_auth:          "authentication script — backend-critical but not visually contributing",
    js_utility:       "utility library — generic helpers with moderate reconstruction value",
    js_generic:       "JavaScript file",
    image_logo:       "brand logo — highest brand-identity signal in the resource set",
    image_hero:       "hero / banner image — dominant above-fold visual element",
    image_background: "background image — contributes to visual mood and color palette",
    image_product:    "product / content image — specific to page content",
    image_icon:       "icon image — small visual element, high reuse potential",
    image_generic:    "image asset",
    svg_logo:         "SVG logo — scalable brand mark, fully offline-reproducible",
    svg_icon:         "SVG icon — vector icon, infinitely scalable and highly reusable",
    svg_illustration: "SVG illustration — decorative vector artwork",
    svg_generic:      "SVG asset",
    font_custom:      "custom typeface — encodes brand typography DNA",
    font_generic:     "web font — typography contribution to visual fidelity",
    video:            "video asset — high brand value but large offline footprint",
    audio:            "audio file — limited reconstruction value",
    json_api:         "API / data endpoint — high backend and runtime value",
    json_design_tokens:"design token file — definitive source of design-system values",
    json_config:      "configuration JSON — backend structure encoded in data",
    api_endpoint:     "API endpoint — critical backend contract",
    wasm:             "WebAssembly module — runtime-critical binary logic",
    document:         "document / PDF — reference content with moderate reuse",
    xml:              "XML / feed — structured data for backend or SEO",
    html:             "HTML fragment — structural reconstruction signal",
    ico:              "favicon — compact brand identity marker",
    other:            "static asset",
  };

  const desc = typeDesc[category] ?? `${rType} resource`;
  return `${tier.toUpperCase()} tier — ${desc}. Strongest dimension: ${top.name} (${top.score}). Overall reconstruction value: ${dims.overall}/100.`;
}

// ── Score a single RI-1 analysis entry ───────────────────────────────────────
export function scoreResource(analysis: ResourceAnalysis): ResourceValueEntry {
  const category = detectCategory(analysis.url, analysis.resourceType, analysis.tags);
  const base     = BASE_SCORES[category] ?? BASE_SCORES["other"]!;
  const modified = applyModifiers(base, analysis);
  const overall  = computeOverall(modified);
  const dims: ReconstructionValueDimensions = { ...modified, overall };
  const top      = topDimension(dims);

  return {
    id:           analysis.id,
    url:          analysis.url,
    resourceType: analysis.resourceType,
    label:        makeLabel(analysis.url, analysis.resourceType),
    dimensions:   dims,
    rank:         0,
    tier:         scoreTier(overall),
    rationale:    makeRationale(analysis.resourceType, category, dims),
    topDimension: top.name,
    topScore:     top.score,
  };
}

// ── Score a minimal URL-only resource (for standalone evaluation) ─────────────
export interface MinimalResource {
  id?:          string;
  url:          string;
  resourceType: ResourceType;
  mimeType?:    string | null;
  byteSize?:    number | null;
  tags?:        string[];
  origin?:      "same-domain" | "subdomain" | "external" | "cdn" | "data-uri";
  occurrences?: number;
}

export function scoreMinimalResource(r: MinimalResource): ResourceValueEntry {
  const fakeAnalysis: ResourceAnalysis = {
    id:                      r.id ?? `ri2-${Math.random().toString(36).slice(2)}`,
    url:                     r.url,
    normalizedUrl:            r.url,
    resourceType:             r.resourceType,
    origin:                   r.origin ?? "same-domain",
    sameDomain:               (r.origin ?? "same-domain") === "same-domain",
    externalDomain:           null,
    mimeType:                 r.mimeType ?? null,
    mimeSource:               "inferred",
    estimatedBytes:           r.byteSize ?? null,
    estimatedDownloadCostMs:  null,
    estimatedStorageCostKb:   null,
    scores: {
      reconstructionImportance:   50,
      runtimeImportance:          50,
      visualImportance:           50,
      backendImportance:          50,
      securityRisk:               0,
      crawlRisk:                  0,
      resourceIntelligenceScore:  50,
    },
    priority:                 "MEDIUM",
    downloadRecommendation:   "DOWNLOAD",
    referenceRecommendation:  "EXTERNAL-LINK",
    skipRecommendation:       false,
    skipReason:               null,
    discoveredOn:             [],
    occurrences:              r.occurrences ?? 1,
    tags:                     r.tags ?? [],
    remediations:             [],
  };
  return scoreResource(fakeAnalysis);
}

// ── Build reconstruction-value-report.json ────────────────────────────────────
function buildValueReport(
  jobId: string,
  seedUrl: string,
  entries: ResourceValueEntry[],
): ReconstructionValueReport {
  const byTier: Record<ValueTier, number> = {
    essential: 0, high: 0, medium: 0, low: 0, negligible: 0,
  };
  let totalScore = 0;
  for (const e of entries) {
    byTier[e.tier]++;
    totalScore += e.dimensions.overall;
  }
  const avg = entries.length ? Math.round(totalScore / entries.length) : 0;

  return {
    jobId,
    seedUrl,
    generatedAt: new Date().toISOString(),
    phase: "RI-2",
    totalResources: entries.length,
    averageOverallScore: avg,
    byTier,
    topResources: entries.slice(0, 20),
    resources: entries,
    summary: `Reconstruction Value Engine scored ${entries.length} resources. ` +
      `Average overall score: ${avg}/100. ` +
      `Essential: ${byTier.essential}, High: ${byTier.high}, Medium: ${byTier.medium}, ` +
      `Low: ${byTier.low}, Negligible: ${byTier.negligible}.`,
  };
}

// ── Build resource-value-ranking.json ─────────────────────────────────────────
function buildValueRanking(
  jobId: string,
  entries: ResourceValueEntry[],
): ResourceValueRanking {
  return {
    jobId,
    generatedAt: new Date().toISOString(),
    phase: "RI-2",
    total: entries.length,
    ranked: entries.map((e) => ({
      rank:                  e.rank,
      id:                    e.id,
      url:                   e.url,
      resourceType:          e.resourceType,
      label:                 e.label,
      overall:               e.dimensions.overall,
      tier:                  e.tier,
      topDimension:          e.topDimension,
      topScore:              e.topScore,
      visualReconstruction:  e.dimensions.visualReconstruction,
      brandDna:              e.dimensions.brandDna,
      offlineReconstruction: e.dimensions.offlineReconstruction,
    })),
  };
}

// ── Build website-prime-value-report.json ─────────────────────────────────────
function buildPrimeValueReport(
  jobId: string,
  entries: ResourceValueEntry[],
): WebsitePrimeValueReport {
  const essential  = entries.filter(e => e.dimensions.websitePrime >= 80);
  const supporting = entries.filter(e => e.dimensions.websitePrime >= 40 && e.dimensions.websitePrime < 80);
  const optional   = entries.filter(e => e.dimensions.websitePrime < 40);

  const primeScores = entries.map(e => e.dimensions.websitePrime);
  const websitePrimeScore = primeScores.length
    ? Math.round(primeScores.reduce((a, b) => a + b, 0) / primeScores.length)
    : 0;

  // Detect missing critical types
  const presentTypes = new Set(essential.map(e => e.resourceType));
  const missingCritical: string[] = [];
  if (!presentTypes.has("css"))   missingCritical.push("CSS stylesheets (visual reconstruction impossible without them)");
  if (!presentTypes.has("javascript")) missingCritical.push("JavaScript bundles (interactivity cannot be reconstructed)");
  if (!presentTypes.has("font"))  missingCritical.push("Custom fonts (typography fidelity will be degraded)");

  const primeCompleteness = Math.min(100, Math.round(
    (essential.length / Math.max(1, entries.length)) * 60 +
    (supporting.length / Math.max(1, entries.length)) * 30 +
    (missingCritical.length === 0 ? 10 : 0),
  ));

  return {
    jobId,
    generatedAt: new Date().toISOString(),
    phase: "RI-2",
    websitePrimeScore,
    primeCompleteness,
    essentialForPrime:  essential.slice(0, 50),
    supportingForPrime: supporting.slice(0, 50),
    optionalForPrime:   optional.slice(0, 50),
    missingCritical,
    summary: `Website Prime value analysis: ${essential.length} essential resources (score ≥80), ` +
      `${supporting.length} supporting (40-79), ${optional.length} optional (<40). ` +
      `Prime completeness: ${primeCompleteness}%. ` +
      (missingCritical.length ? `⚠ Missing: ${missingCritical.join("; ")}` : "All critical resource types present."),
  };
}

// ── R2 storage ────────────────────────────────────────────────────────────────
async function storeReport(jobId: string, filename: string, data: unknown): Promise<string | null> {
  const provider = createCloudProvider("r2");
  if (!provider.isConfigured()) return null;
  const key = `ri2/${jobId}/${filename}`;
  try {
    await provider.upload({
      key,
      data: Buffer.from(JSON.stringify(data, null, 2), "utf-8"),
      contentType: "application/json",
      checkDuplicate: false,
    });
    return key;
  } catch (err) {
    logger.warn({ jobId, key, err }, "RI-2: failed to store report to R2");
    return null;
  }
}

// ── In-memory cache ───────────────────────────────────────────────────────────
interface Ri2Cache {
  valueReport:  ReconstructionValueReport;
  ranking:      ResourceValueRanking;
  primeReport:  WebsitePrimeValueReport;
  r2Keys:       string[];
}

const cache = new Map<string, Ri2Cache>();

export function getCachedRi2Reports(jobId: string): Ri2Cache | null {
  return cache.get(jobId) ?? null;
}

// ── Main entry: run full engine for a job ─────────────────────────────────────
export async function runReconstructionValueEngine(jobId: string): Promise<Ri2Cache> {
  const startMs = Date.now();
  logger.info({ jobId }, "RI-2: starting reconstruction value analysis");

  // Try to get resources from the RI-1 cache (preferred — already deduped)
  const ri1 = getCachedRiReports(jobId);
  let resources: ResourceAnalysis[] = ri1?.intelligence.resources ?? [];

  // Fallback: load from manifest directly
  if (resources.length === 0) {
    const manifest = await loadManifest(jobId);
    if (!manifest) throw new Error(`No manifest and no RI-1 cache found for job ${jobId}. Run RI-1 first or provide a valid jobId.`);

    const nodes: PageNode[] = manifest.nodes instanceof Map
      ? [...manifest.nodes.values()]
      : (Object.values(manifest.nodes ?? {}) as PageNode[]);

    let idx = 0;
    const seen = new Set<string>();
    for (const node of nodes) {
      const pageUrl = node.metadata?.url ?? "";
      for (const img of node.media?.images ?? []) {
        if (seen.has(img.sourceUrl)) continue;
        seen.add(img.sourceUrl);
        resources.push({
          id: `ri2-fallback-${idx++}`,
          url: img.sourceUrl,
          normalizedUrl: img.sourceUrl,
          resourceType: "image",
          origin: "same-domain",
          sameDomain: true,
          externalDomain: null,
          mimeType: img.mimeType ?? null,
          mimeSource: "observed",
          estimatedBytes: img.byteSize ?? null,
          estimatedDownloadCostMs: null,
          estimatedStorageCostKb: null,
          scores: { reconstructionImportance: 50, runtimeImportance: 10, visualImportance: 70, backendImportance: 5, securityRisk: 0, crawlRisk: 0, resourceIntelligenceScore: 50 },
          priority: "MEDIUM",
          downloadRecommendation: "DOWNLOAD",
          referenceRecommendation: "EXTERNAL-LINK",
          skipRecommendation: false,
          skipReason: null,
          discoveredOn: [pageUrl],
          occurrences: 1,
          tags: [],
          remediations: [],
        });
      }
    }
    logger.info({ jobId, resourceCount: resources.length }, "RI-2: using manifest fallback for resources");
  }

  if (resources.length === 0) {
    throw new Error(`No resources found for job ${jobId}. Run the scraper and RI-1 first.`);
  }

  logger.info({ jobId, resourceCount: resources.length }, "RI-2: scoring resources");

  // Score every resource
  const scored = resources.map(r => scoreResource(r));

  // Sort by overall descending and assign ranks
  scored.sort((a, b) => b.dimensions.overall - a.dimensions.overall);
  scored.forEach((e, i) => { e.rank = i + 1; });

  const valueReport = buildValueReport(jobId, ri1?.intelligence.seedUrl ?? jobId, scored);
  const ranking     = buildValueRanking(jobId, scored);
  const primeReport = buildPrimeValueReport(jobId, scored);

  // Persist to R2
  const [k1, k2, k3] = await Promise.all([
    storeReport(jobId, "reconstruction-value-report.json",  valueReport),
    storeReport(jobId, "resource-value-ranking.json",       ranking),
    storeReport(jobId, "website-prime-value-report.json",   primeReport),
  ]);
  const r2Keys = [k1, k2, k3].filter(Boolean) as string[];

  const result: Ri2Cache = { valueReport, ranking, primeReport, r2Keys };
  cache.set(jobId, result);

  logger.info({
    jobId,
    totalResources: scored.length,
    durationMs: Date.now() - startMs,
    averageScore: valueReport.averageOverallScore,
    r2Keys: r2Keys.length,
  }, "RI-2: reconstruction value engine complete");

  return result;
}

// ── Single-resource evaluation (reusable API gate) ────────────────────────────
export function evaluateSingleResourceValue(r: MinimalResource): ResourceValueEntry {
  const entry = scoreMinimalResource(r);
  entry.rank  = 1;
  return entry;
}

// ── Batch evaluation (reusable API for downstream pipelines) ──────────────────
export function evaluateResourceValueBatch(
  resources: MinimalResource[],
): ResourceValueEntry[] {
  const scored = resources.map(r => scoreMinimalResource(r));
  scored.sort((a, b) => b.dimensions.overall - a.dimensions.overall);
  scored.forEach((e, i) => { e.rank = i + 1; });
  return scored;
}

// ── Fire-and-forget trigger (called by RI-1 completion) ───────────────────────
export function triggerReconstructionValueAsync(jobId: string): void {
  runReconstructionValueEngine(jobId).catch((err: unknown) => {
    logger.warn({ jobId, err }, "RI-2: background analysis failed (non-fatal)");
  });
}
