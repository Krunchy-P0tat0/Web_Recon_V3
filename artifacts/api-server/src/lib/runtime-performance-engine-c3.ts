/**
 * runtime-performance-engine-c3.ts — Phase C3: Runtime Performance Engine
 *
 * Measures real runtime performance of Website Prime URLs via Puppeteer and
 * combines that with static asset analysis from the manifest.
 *
 * Measures:
 *   First Contentful Paint (FCP)     LCP     TTI     TBT     CLS
 *   Hydration Time     JS bundle size     CSS size     Image load timing
 *
 * Produces (stored in R2 + in-memory):
 *   runtime-performance-report.json
 *   performance-recommendations.json
 *   core-web-vitals-report.json
 *   bundle-analysis.json
 *
 * Target: production-grade Core Web Vitals (Google "Good" thresholds).
 */

import { logger } from "./logger.js";
import { loadManifest } from "./manifest-store.js";
import { createCloudProvider } from "../cloud/index.js";

// ── CWV thresholds (Google "Good" / "Needs Improvement" / "Poor") ────────────

export const CWV_THRESHOLDS = {
  fcp: { good: 1800,  needsImprovement: 3000  },   // ms
  lcp: { good: 2500,  needsImprovement: 4000  },   // ms
  tti: { good: 3800,  needsImprovement: 7300  },   // ms
  tbt: { good: 200,   needsImprovement: 600   },   // ms
  cls: { good: 0.1,   needsImprovement: 0.25  },   // unitless score
  fid: { good: 100,   needsImprovement: 300   },   // ms (proxy: TBT)
  inp: { good: 200,   needsImprovement: 500   },   // ms
};

type CwvRating = "good" | "needs-improvement" | "poor" | "unknown";

function rateFcp(ms: number | null): CwvRating {
  if (ms === null) return "unknown";
  if (ms <= CWV_THRESHOLDS.fcp.good) return "good";
  if (ms <= CWV_THRESHOLDS.fcp.needsImprovement) return "needs-improvement";
  return "poor";
}
function rateLcp(ms: number | null): CwvRating {
  if (ms === null) return "unknown";
  if (ms <= CWV_THRESHOLDS.lcp.good) return "good";
  if (ms <= CWV_THRESHOLDS.lcp.needsImprovement) return "needs-improvement";
  return "poor";
}
function rateTti(ms: number | null): CwvRating {
  if (ms === null) return "unknown";
  if (ms <= CWV_THRESHOLDS.tti.good) return "good";
  if (ms <= CWV_THRESHOLDS.tti.needsImprovement) return "needs-improvement";
  return "poor";
}
function rateTbt(ms: number | null): CwvRating {
  if (ms === null) return "unknown";
  if (ms <= CWV_THRESHOLDS.tbt.good) return "good";
  if (ms <= CWV_THRESHOLDS.tbt.needsImprovement) return "needs-improvement";
  return "poor";
}
function rateCls(score: number | null): CwvRating {
  if (score === null) return "unknown";
  if (score <= CWV_THRESHOLDS.cls.good) return "good";
  if (score <= CWV_THRESHOLDS.cls.needsImprovement) return "needs-improvement";
  return "poor";
}

// ── Browser singleton (shared with other engines) ────────────────────────────

let _browser: unknown = null;

async function getBrowser(): Promise<unknown> {
  if (_browser) return _browser;
  const puppeteer = await import("puppeteer");
  _browser = await puppeteer.default.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
    ],
  });
  logger.info("C3-PERF: Chromium launched");
  return _browser;
}

export async function shutdownC3Browser(): Promise<void> {
  if (_browser) {
    try { await (_browser as { close(): Promise<void> }).close(); } catch { /* already closed */ }
    _browser = null;
  }
}

// ── In-browser performance collection script ─────────────────────────────────

const PERF_SCRIPT = `
(async function collectMetrics() {
  const result = {
    fcp: null, lcp: null, cls: null, tbt: null, tti: null,
    domContentLoaded: null, domComplete: null, ttfb: null,
    transferSize: 0, encodedBodySize: 0,
    resources: [],
    longTasks: [],
    hydrationTime: null,
  };

  // Navigation timing
  const navEntries = performance.getEntriesByType('navigation');
  if (navEntries.length > 0) {
    const nav = navEntries[0];
    result.domContentLoaded = nav.domContentLoadedEventEnd - nav.startTime;
    result.domComplete = nav.domComplete - nav.startTime;
    result.ttfb = nav.responseStart - nav.requestStart;
  }

  // Paint timing
  const paintEntries = performance.getEntriesByType('paint');
  for (const p of paintEntries) {
    if (p.name === 'first-contentful-paint') result.fcp = p.startTime;
  }

  // LCP (from PerformanceObserver buffered)
  await new Promise(resolve => {
    try {
      const obs = new PerformanceObserver(list => {
        const entries = list.getEntries();
        if (entries.length > 0) {
          result.lcp = entries[entries.length - 1].startTime;
        }
      });
      obs.observe({ type: 'largest-contentful-paint', buffered: true });
      setTimeout(() => { try { obs.disconnect(); } catch{} resolve(); }, 800);
    } catch { resolve(); }
  });

  // CLS (from layout-shift entries)
  await new Promise(resolve => {
    let clsScore = 0;
    let sessionValue = 0;
    let sessionEntries = [];
    let lastEntryTime = 0;
    try {
      const obs = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            const firstSessionEntry = sessionEntries[0];
            const lastSessionEntry = sessionEntries[sessionEntries.length - 1];
            if (sessionValue && entry.startTime - lastSessionEntry.startTime < 1000 &&
                entry.startTime - firstSessionEntry.startTime < 5000) {
              sessionValue += entry.value;
              sessionEntries.push(entry);
            } else {
              sessionValue = entry.value;
              sessionEntries = [entry];
            }
            if (sessionValue > clsScore) clsScore = sessionValue;
          }
        }
        result.cls = Math.round(clsScore * 1000) / 1000;
      });
      obs.observe({ type: 'layout-shift', buffered: true });
      setTimeout(() => { try { obs.disconnect(); } catch{} resolve(); }, 600);
    } catch { resolve(); }
  });

  // Long tasks → TBT proxy
  await new Promise(resolve => {
    let tbt = 0;
    try {
      const obs = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          tbt += Math.max(0, entry.duration - 50);
          result.longTasks.push({ start: Math.round(entry.startTime), duration: Math.round(entry.duration) });
        }
        result.tbt = Math.round(tbt);
      });
      obs.observe({ type: 'longtask', buffered: true });
      setTimeout(() => { try { obs.disconnect(); } catch{} resolve(); }, 600);
    } catch { resolve(); }
  });

  // Resource timing
  const resources = performance.getEntriesByType('resource');
  result.resources = resources.map(r => ({
    name: r.name,
    initiatorType: r.initiatorType,
    transferSize: r.transferSize || 0,
    encodedBodySize: r.encodedBodySize || 0,
    duration: Math.round(r.duration),
    startTime: Math.round(r.startTime),
  }));
  result.transferSize = result.resources.reduce((s, r) => s + r.transferSize, 0);

  // TTI heuristic: domContentLoaded + max long-task end
  if (result.domContentLoaded !== null) {
    const lastLongTask = result.longTasks.length > 0
      ? Math.max(...result.longTasks.map(t => t.start + t.duration))
      : 0;
    result.tti = Math.max(result.domContentLoaded, lastLongTask);
  }

  // Hydration detection (React/Next/Vue/Nuxt markers)
  const hydrationMark = performance.getEntriesByName('hydration-complete')[0]
    ?? performance.getEntriesByName('next-hydration-complete')[0]
    ?? performance.getEntriesByName('nuxt-hydration-complete')[0];
  if (hydrationMark) result.hydrationTime = hydrationMark.startTime;

  return result;
})();
`;

// ── Report shapes ─────────────────────────────────────────────────────────────

export interface ResourceTiming {
  name: string;
  initiatorType: string;
  transferSize: number;
  encodedBodySize: number;
  duration: number;
  startTime: number;
}

export interface PagePerformanceMetrics {
  url: string;
  measuredAt: string;
  fcp: number | null;           // ms
  lcp: number | null;           // ms
  tti: number | null;           // ms
  tbt: number | null;           // ms
  cls: number | null;           // score
  ttfb: number | null;          // ms
  hydrationTime: number | null; // ms
  domContentLoaded: number | null;
  domComplete: number | null;
  transferSizeBytes: number;
  resources: ResourceTiming[];
  longTasks: Array<{ start: number; duration: number }>;
  measurementSource: "puppeteer" | "static-estimate";
}

export interface RuntimePerformanceReport {
  jobId: string;
  generatedAt: string;
  pagesAnalyzed: number;
  pages: PagePerformanceMetrics[];
  aggregates: {
    medianFcp: number | null;
    medianLcp: number | null;
    medianTti: number | null;
    medianTbt: number | null;
    medianCls: number | null;
    medianTtfb: number | null;
    worstPage: string | null;
    bestPage: string | null;
  };
}

export interface CwvPageScore {
  url: string;
  fcp: { value: number | null; rating: CwvRating };
  lcp: { value: number | null; rating: CwvRating };
  tti: { value: number | null; rating: CwvRating };
  tbt: { value: number | null; rating: CwvRating };
  cls: { value: number | null; rating: CwvRating };
  overallRating: CwvRating;
  passesAllGoodThresholds: boolean;
}

export interface CoreWebVitalsReport {
  jobId: string;
  generatedAt: string;
  thresholds: typeof CWV_THRESHOLDS;
  pages: CwvPageScore[];
  summary: {
    totalPages: number;
    passGood: number;
    needsImprovement: number;
    poor: number;
    overallRating: CwvRating;
  };
}

export interface BundleEntry {
  url: string;
  type: "js" | "css" | "image" | "font" | "other";
  transferSize: number;
  encodedBodySize: number;
  duration: number;
  startTime: number;
  isRenderBlocking: boolean;
  isAsync: boolean;
}

export interface BundleAnalysis {
  jobId: string;
  generatedAt: string;
  pages: Array<{
    url: string;
    totalTransferBytes: number;
    totalJsBytes: number;
    totalCssBytes: number;
    totalImageBytes: number;
    totalFontBytes: number;
    totalOtherBytes: number;
    renderBlockingCount: number;
    entries: BundleEntry[];
  }>;
  aggregates: {
    totalUniqueJsUrls: number;
    totalUniqueCssUrls: number;
    heaviestJsUrl: string | null;
    heaviestCssUrl: string | null;
    estimatedTotalJsBytes: number;
    estimatedTotalCssBytes: number;
  };
}

export interface PerformanceRecommendation {
  category: "code-splitting" | "lazy-loading" | "critical-css" | "image-optimization" | "bundle-reduction" | "caching" | "server" | "rendering";
  priority: "critical" | "high" | "medium" | "low";
  title: string;
  description: string;
  affectedUrls: string[];
  estimatedImpact: string;
  implementation: string;
}

export interface PerformanceRecommendationsReport {
  jobId: string;
  generatedAt: string;
  recommendations: PerformanceRecommendation[];
  summary: {
    total: number;
    byCategory: Record<string, number>;
    byPriority: Record<string, number>;
  };
}

export interface C3Bundle {
  jobId: string;
  generatedAt: string;
  runtimePerformanceReport: RuntimePerformanceReport;
  coreWebVitalsReport: CoreWebVitalsReport;
  bundleAnalysis: BundleAnalysis;
  performanceRecommendations: PerformanceRecommendationsReport;
  r2Keys: {
    runtimePerformanceReport: string;
    coreWebVitalsReport: string;
    bundleAnalysis: string;
    performanceRecommendations: string;
  };
}

// ── In-memory store ───────────────────────────────────────────────────────────

const _store = new Map<string, C3Bundle>();

export function getC3Bundle(jobId: string): C3Bundle | undefined {
  return _store.get(jobId);
}

export function listC3Bundles(): Array<{ jobId: string; generatedAt: string }> {
  return [..._store.values()].map(b => ({ jobId: b.jobId, generatedAt: b.generatedAt }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function median(values: number[]): number | null {
  const sorted = values.filter(v => v !== null && isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? (sorted[mid] ?? null) : ((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function extOf(url: string): string {
  try {
    const p = new URL(url).pathname;
    return p.slice(p.lastIndexOf(".") + 1).toLowerCase().split("?")[0] ?? "";
  } catch {
    return url.slice(url.lastIndexOf(".") + 1).toLowerCase().split("?")[0] ?? "";
  }
}

function resourceType(r: ResourceTiming): BundleEntry["type"] {
  const t = r.initiatorType;
  const ext = extOf(r.name);
  if (t === "script" || ["js","mjs"].includes(ext)) return "js";
  if (t === "link" || ext === "css") return "css";
  if (t === "img" || ["jpg","jpeg","png","gif","webp","avif","svg"].includes(ext)) return "image";
  if (["woff","woff2","ttf","otf"].includes(ext)) return "font";
  return "other";
}

function makeR2Key(jobId: string, filename: string): string {
  return `c3/${jobId}/${filename}`;
}

async function storeJsonToR2(jobId: string, filename: string, data: unknown): Promise<string> {
  const key = makeR2Key(jobId, filename);
  const provider = createCloudProvider("r2");
  if (!provider.isConfigured()) {
    logger.warn({ jobId, filename }, "C3: R2 not configured — skipping upload");
    return key;
  }
  const buf = Buffer.from(JSON.stringify(data, null, 2), "utf-8");
  await provider.upload({ key, data: buf, contentType: "application/json", checkDuplicate: false });
  logger.info({ jobId, key }, "C3: report stored to R2");
  return key;
}

// ── Puppeteer measurement ────────────────────────────────────────────────────

interface RawPerfData {
  fcp: number | null;
  lcp: number | null;
  cls: number | null;
  tbt: number | null;
  tti: number | null;
  ttfb: number | null;
  hydrationTime: number | null;
  domContentLoaded: number | null;
  domComplete: number | null;
  transferSize: number;
  resources: Array<{
    name: string;
    initiatorType: string;
    transferSize: number;
    encodedBodySize: number;
    duration: number;
    startTime: number;
  }>;
  longTasks: Array<{ start: number; duration: number }>;
}

async function measureUrl(url: string): Promise<PagePerformanceMetrics> {
  const measuredAt = new Date().toISOString();
  logger.info({ url }, "C3: measuring page performance");

  let browser: unknown;
  let page: unknown;

  try {
    browser = await getBrowser();
    page = await (browser as { newPage(): Promise<unknown> }).newPage();

    const p = page as {
      setUserAgent(ua: string): Promise<void>;
      goto(url: string, opts: object): Promise<unknown>;
      evaluate<T>(fn: string): Promise<T>;
      close(): Promise<void>;
    };

    await p.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );

    await p.goto(url, { waitUntil: "networkidle2", timeout: 45_000 });

    // Small settle time for late LCP/CLS entries
    await new Promise(r => setTimeout(r, 1500));

    const raw = await p.evaluate<RawPerfData>(PERF_SCRIPT);

    const resources: ResourceTiming[] = (raw.resources ?? []).map(r => ({
      name: r.name,
      initiatorType: r.initiatorType,
      transferSize: r.transferSize ?? 0,
      encodedBodySize: r.encodedBodySize ?? 0,
      duration: r.duration ?? 0,
      startTime: r.startTime ?? 0,
    }));

    return {
      url,
      measuredAt,
      fcp:              raw.fcp  !== undefined ? raw.fcp  : null,
      lcp:              raw.lcp  !== undefined ? raw.lcp  : null,
      tti:              raw.tti  !== undefined ? raw.tti  : null,
      tbt:              raw.tbt  !== undefined ? raw.tbt  : null,
      cls:              raw.cls  !== undefined ? raw.cls  : null,
      ttfb:             raw.ttfb !== undefined ? raw.ttfb : null,
      hydrationTime:    raw.hydrationTime ?? null,
      domContentLoaded: raw.domContentLoaded ?? null,
      domComplete:      raw.domComplete ?? null,
      transferSizeBytes: raw.transferSize ?? 0,
      resources,
      longTasks: raw.longTasks ?? [],
      measurementSource: "puppeteer",
    };
  } catch (err) {
    logger.warn({ url, err: (err as Error).message }, "C3: puppeteer measurement failed — falling back to static estimate");
    return staticEstimate(url);
  } finally {
    if (page) {
      try { await (page as { close(): Promise<void> }).close(); } catch { /* ignore */ }
    }
  }
}

// ── Static estimation (when Puppeteer can't reach the URL) ───────────────────

function staticEstimate(url: string): PagePerformanceMetrics {
  return {
    url,
    measuredAt: new Date().toISOString(),
    fcp: null, lcp: null, tti: null, tbt: null, cls: null,
    ttfb: null, hydrationTime: null, domContentLoaded: null, domComplete: null,
    transferSizeBytes: 0, resources: [], longTasks: [],
    measurementSource: "static-estimate",
  };
}

// ── Report builders ───────────────────────────────────────────────────────────

function buildCwvReport(jobId: string, pages: PagePerformanceMetrics[], now: string): CoreWebVitalsReport {
  const scored: CwvPageScore[] = pages.map(p => {
    const fcpR = rateFcp(p.fcp);
    const lcpR = rateLcp(p.lcp);
    const ttiR = rateTti(p.tti);
    const tbtR = rateTbt(p.tbt);
    const clsR = rateCls(p.cls);

    const ratings = [fcpR, lcpR, ttiR, tbtR, clsR].filter(r => r !== "unknown");
    let overall: CwvRating = "unknown";
    if (ratings.length > 0) {
      if (ratings.some(r => r === "poor")) overall = "poor";
      else if (ratings.some(r => r === "needs-improvement")) overall = "needs-improvement";
      else overall = "good";
    }

    return {
      url: p.url,
      fcp: { value: p.fcp, rating: fcpR },
      lcp: { value: p.lcp, rating: lcpR },
      tti: { value: p.tti, rating: ttiR },
      tbt: { value: p.tbt, rating: tbtR },
      cls: { value: p.cls, rating: clsR },
      overallRating: overall,
      passesAllGoodThresholds: overall === "good",
    };
  });

  const passGood = scored.filter(s => s.overallRating === "good").length;
  const ni       = scored.filter(s => s.overallRating === "needs-improvement").length;
  const poor     = scored.filter(s => s.overallRating === "poor").length;

  let overallRating: CwvRating = "unknown";
  if (scored.length > 0) {
    if (poor > 0) overallRating = "poor";
    else if (ni > 0) overallRating = "needs-improvement";
    else if (passGood === scored.length) overallRating = "good";
  }

  return {
    jobId,
    generatedAt: now,
    thresholds: CWV_THRESHOLDS,
    pages: scored,
    summary: {
      totalPages: scored.length,
      passGood,
      needsImprovement: ni,
      poor,
      overallRating,
    },
  };
}

function buildBundleAnalysis(jobId: string, pages: PagePerformanceMetrics[], now: string): BundleAnalysis {
  const allJsUrls  = new Map<string, number>();
  const allCssUrls = new Map<string, number>();

  const analyzed = pages.map(p => {
    let totalJs = 0, totalCss = 0, totalImg = 0, totalFont = 0, totalOther = 0;
    let renderBlockingCount = 0;

    const entries: BundleEntry[] = p.resources.map(r => {
      const type = resourceType(r);
      // Render-blocking: sync CSS and sync JS in <head> (heuristic: loaded very early)
      const isRenderBlocking = (type === "css" || type === "js") && r.startTime < 500;
      const isAsync = type === "js" && r.startTime >= 500;

      if (type === "js")    { totalJs    += r.transferSize; allJsUrls.set(r.name,  r.transferSize); }
      if (type === "css")   { totalCss   += r.transferSize; allCssUrls.set(r.name, r.transferSize); }
      if (type === "image") totalImg  += r.transferSize;
      if (type === "font")  totalFont += r.transferSize;
      if (type === "other") totalOther += r.transferSize;
      if (isRenderBlocking) renderBlockingCount++;

      return { url: r.name, type, transferSize: r.transferSize, encodedBodySize: r.encodedBodySize,
               duration: r.duration, startTime: r.startTime, isRenderBlocking, isAsync };
    });

    return {
      url: p.url,
      totalTransferBytes: p.transferSizeBytes,
      totalJsBytes: totalJs, totalCssBytes: totalCss, totalImageBytes: totalImg,
      totalFontBytes: totalFont, totalOtherBytes: totalOther,
      renderBlockingCount,
      entries,
    };
  });

  const heaviestJs  = [...allJsUrls.entries()].sort((a,b) => b[1]-a[1])[0];
  const heaviestCss = [...allCssUrls.entries()].sort((a,b) => b[1]-a[1])[0];

  return {
    jobId,
    generatedAt: now,
    pages: analyzed,
    aggregates: {
      totalUniqueJsUrls:   allJsUrls.size,
      totalUniqueCssUrls:  allCssUrls.size,
      heaviestJsUrl:  heaviestJs?.[0]  ?? null,
      heaviestCssUrl: heaviestCss?.[0] ?? null,
      estimatedTotalJsBytes:  [...allJsUrls.values()].reduce((s,v) => s+v, 0),
      estimatedTotalCssBytes: [...allCssUrls.values()].reduce((s,v) => s+v, 0),
    },
  };
}

function buildRecommendations(
  jobId: string,
  pages: PagePerformanceMetrics[],
  bundle: BundleAnalysis,
  cwv: CoreWebVitalsReport,
  now: string,
): PerformanceRecommendationsReport {
  const recs: PerformanceRecommendation[] = [];

  // ── TTFB ──────────────────────────────────────────────────────────────────
  const slowTtfb = pages.filter(p => p.ttfb !== null && p.ttfb > 800);
  if (slowTtfb.length > 0) {
    recs.push({
      category: "server",
      priority: "high",
      title: "High Time to First Byte (TTFB)",
      description: `${slowTtfb.length} page(s) have TTFB > 800ms, directly delaying all paint metrics.`,
      affectedUrls: slowTtfb.map(p => p.url),
      estimatedImpact: "Reducing TTFB by 500ms typically improves FCP and LCP by the same amount.",
      implementation: "Enable edge caching (CDN), optimize server-side rendering, add HTTP/2 push for critical resources, or move to a closer geographic region.",
    });
  }

  // ── FCP ──────────────────────────────────────────────────────────────────
  const poorFcp = cwv.pages.filter(p => p.fcp.rating === "poor" || p.fcp.rating === "needs-improvement");
  if (poorFcp.length > 0) {
    recs.push({
      category: "critical-css",
      priority: poorFcp.some(p => p.fcp.rating === "poor") ? "critical" : "high",
      title: "Slow First Contentful Paint (FCP)",
      description: `${poorFcp.length} page(s) fail the FCP "Good" threshold of ${CWV_THRESHOLDS.fcp.good}ms.`,
      affectedUrls: poorFcp.map(p => p.url),
      estimatedImpact: "Critical CSS inlining can reduce FCP by 300-800ms by eliminating render-blocking stylesheet requests.",
      implementation: "Extract above-the-fold CSS (~14KB) and inline it in <head>. Defer the full stylesheet with <link rel=preload as=style>. Remove unused CSS with PurgeCSS.",
    });
  }

  // ── LCP ──────────────────────────────────────────────────────────────────
  const poorLcp = cwv.pages.filter(p => p.lcp.rating === "poor" || p.lcp.rating === "needs-improvement");
  if (poorLcp.length > 0) {
    const lcpVals = poorLcp.map(p => p.lcp.value).filter(Boolean) as number[];
    const worstLcp = lcpVals.length > 0 ? Math.max(...lcpVals) : null;
    recs.push({
      category: "image-optimization",
      priority: poorLcp.some(p => p.lcp.rating === "poor") ? "critical" : "high",
      title: "Slow Largest Contentful Paint (LCP)",
      description: `${poorLcp.length} page(s) fail LCP "Good" threshold of ${CWV_THRESHOLDS.lcp.good}ms.${worstLcp ? ` Worst: ${worstLcp.toFixed(0)}ms.` : ""}`,
      affectedUrls: poorLcp.map(p => p.url),
      estimatedImpact: "Optimizing the LCP element (often a hero image) can reduce LCP by 1-2 seconds.",
      implementation: "Add <link rel=preload> for the LCP image. Serve it in WebP/AVIF. Use fetchpriority='high' on the LCP <img>. Eliminate any render-blocking resources above it.",
    });
  }

  // ── TBT / TTI ────────────────────────────────────────────────────────────
  const poorTbt = cwv.pages.filter(p => p.tbt.rating === "poor" || p.tbt.rating === "needs-improvement");
  if (poorTbt.length > 0) {
    recs.push({
      category: "code-splitting",
      priority: poorTbt.some(p => p.tbt.rating === "poor") ? "critical" : "high",
      title: "Excessive Total Blocking Time (TBT) / Slow TTI",
      description: `${poorTbt.length} page(s) exceed TBT "Good" threshold of ${CWV_THRESHOLDS.tbt.good}ms — main thread blocked by long JS tasks.`,
      affectedUrls: poorTbt.map(p => p.url),
      estimatedImpact: "Code-splitting a 300KB bundle into route-level chunks can cut TBT by 200-400ms.",
      implementation: "Split JS by route using dynamic import(). Defer non-critical scripts with defer/async. Move analytics and chat widgets to web workers. Remove polyfills for modern browsers.",
    });
  }

  // ── CLS ──────────────────────────────────────────────────────────────────
  const poorCls = cwv.pages.filter(p => p.cls.rating === "poor" || p.cls.rating === "needs-improvement");
  if (poorCls.length > 0) {
    recs.push({
      category: "rendering",
      priority: poorCls.some(p => p.cls.rating === "poor") ? "high" : "medium",
      title: "Cumulative Layout Shift (CLS) detected",
      description: `${poorCls.length} page(s) have CLS > ${CWV_THRESHOLDS.cls.good}. Layout shifts hurt UX and SEO.`,
      affectedUrls: poorCls.map(p => p.url),
      estimatedImpact: "Eliminating layout shifts achieves CLS < 0.1 (Good) which improves Google ranking signals.",
      implementation: "Reserve space for images, ads, and embeds with explicit width/height or aspect-ratio CSS. Avoid inserting DOM above existing content. Use font-display: optional to prevent font-induced shifts.",
    });
  }

  // ── Render-blocking resources ─────────────────────────────────────────────
  const renderBlockingPages = bundle.pages.filter(p => p.renderBlockingCount > 2);
  if (renderBlockingPages.length > 0) {
    recs.push({
      category: "critical-css",
      priority: "high",
      title: "Multiple render-blocking resources",
      description: `${renderBlockingPages.length} page(s) load ${renderBlockingPages.map(p => p.renderBlockingCount).join(", ")} synchronous CSS/JS files before first paint.`,
      affectedUrls: renderBlockingPages.map(p => p.url),
      estimatedImpact: "Each render-blocking resource adds 100-500ms to FCP. Eliminating them reduces paint times proportionally.",
      implementation: "Inline critical CSS. Load non-critical CSS with media='print' onload trick. Add async or defer to non-essential scripts.",
    });
  }

  // ── Heavy JS bundles ──────────────────────────────────────────────────────
  const JS_BUDGET = 300_000; // 300KB transfer
  const heavyJsPages = bundle.pages.filter(p => p.totalJsBytes > JS_BUDGET);
  if (heavyJsPages.length > 0 || bundle.aggregates.estimatedTotalJsBytes > JS_BUDGET) {
    recs.push({
      category: "bundle-reduction",
      priority: "high",
      title: "JavaScript bundle exceeds performance budget",
      description: `Total JS transfer: ${(bundle.aggregates.estimatedTotalJsBytes / 1024).toFixed(0)} KB (budget: ${(JS_BUDGET / 1024).toFixed(0)} KB).`,
      affectedUrls: heavyJsPages.map(p => p.url),
      estimatedImpact: "Reducing JS by 30% cuts parse + execution time and TBT significantly on mobile.",
      implementation: "Run webpack-bundle-analyzer or vite-bundle-visualizer. Tree-shake unused exports. Replace heavy libraries with lighter alternatives (e.g. date-fns vs moment, preact vs react for static pages). Split by route.",
    });
  }

  // ── Heavy CSS ─────────────────────────────────────────────────────────────
  const CSS_BUDGET = 100_000; // 100KB transfer
  if (bundle.aggregates.estimatedTotalCssBytes > CSS_BUDGET) {
    recs.push({
      category: "bundle-reduction",
      priority: "medium",
      title: "CSS payload exceeds performance budget",
      description: `Total CSS transfer: ${(bundle.aggregates.estimatedTotalCssBytes / 1024).toFixed(0)} KB (budget: ${(CSS_BUDGET / 1024).toFixed(0)} KB).`,
      affectedUrls: bundle.pages.map(p => p.url),
      estimatedImpact: "Removing unused CSS with PurgeCSS typically reduces stylesheet size by 60-90% for utility-class frameworks.",
      implementation: "Run PurgeCSS / UnCSS in the build pipeline. Extract critical CSS (~14KB) for the initial render. Lazy-load the rest.",
    });
  }

  // ── Component lazy loading ────────────────────────────────────────────────
  const highTti = pages.filter(p => p.tti !== null && p.tti > CWV_THRESHOLDS.tti.needsImprovement);
  if (highTti.length > 0) {
    recs.push({
      category: "lazy-loading",
      priority: "high",
      title: "Below-fold components loaded eagerly",
      description: `${highTti.length} page(s) have TTI > ${CWV_THRESHOLDS.tti.needsImprovement}ms, indicating non-critical components block interactivity.`,
      affectedUrls: highTti.map(p => p.url),
      estimatedImpact: "Lazy-loading below-fold components can reduce initial JS parse time by 20-40%.",
      implementation: "Use React.lazy() + Suspense, or Next.js dynamic(). IntersectionObserver for charts, maps, carousels. Skeleton loaders for perceived performance.",
    });
  }

  // ── Hydration ─────────────────────────────────────────────────────────────
  const slowHydration = pages.filter(p => p.hydrationTime !== null && p.hydrationTime > 3000);
  if (slowHydration.length > 0) {
    recs.push({
      category: "rendering",
      priority: "medium",
      title: "Slow framework hydration",
      description: `${slowHydration.length} page(s) show hydration completing after 3s, delaying interactivity.`,
      affectedUrls: slowHydration.map(p => p.url),
      estimatedImpact: "Partial hydration (islands architecture) can reduce hydration overhead by 50-80%.",
      implementation: "Use Astro islands, React Server Components, or Vue's selective hydration. Pre-render static sections. Defer hydration for below-fold components.",
    });
  }

  // ── Large images served without sizing ───────────────────────────────────
  const imageHeavyPages = bundle.pages.filter(p => p.totalImageBytes > 1_000_000);
  if (imageHeavyPages.length > 0) {
    recs.push({
      category: "image-optimization",
      priority: "medium",
      title: "Image payload exceeds 1 MB per page",
      description: `${imageHeavyPages.length} page(s) transfer > 1 MB in images, directly increasing LCP.`,
      affectedUrls: imageHeavyPages.map(p => p.url),
      estimatedImpact: "Converting to WebP/AVIF + responsive srcset typically cuts image payload by 50-70%.",
      implementation: "Use <img srcset> with multiple sizes. Serve WebP/AVIF via Accept header negotiation. Set explicit width and height to prevent CLS.",
    });
  }

  // ── Caching headers ───────────────────────────────────────────────────────
  const totalJsFiles = bundle.aggregates.totalUniqueJsUrls;
  if (totalJsFiles > 5) {
    recs.push({
      category: "caching",
      priority: "low",
      title: "High number of JS files — leverage immutable caching",
      description: `${totalJsFiles} unique JS files detected. Without immutable caching, every deploy re-downloads all JS.`,
      affectedUrls: [],
      estimatedImpact: "Immutable cache headers (max-age=31536000, immutable) eliminate repeat visitor JS download cost entirely.",
      implementation: "Ensure bundler emits content-hashed filenames ([hash].bundle.js). Set Cache-Control: public, max-age=31536000, immutable on all JS/CSS/font assets.",
    });
  }

  const byCategory: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  for (const r of recs) {
    byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
    byPriority[r.priority] = (byPriority[r.priority] ?? 0) + 1;
  }

  return {
    jobId,
    generatedAt: now,
    recommendations: recs,
    summary: { total: recs.length, byCategory, byPriority },
  };
}

function buildRuntimeReport(
  jobId: string,
  pages: PagePerformanceMetrics[],
  now: string,
): RuntimePerformanceReport {
  const fcpVals = pages.map(p => p.fcp).filter((v): v is number => v !== null);
  const lcpVals = pages.map(p => p.lcp).filter((v): v is number => v !== null);
  const ttiVals = pages.map(p => p.tti).filter((v): v is number => v !== null);
  const tbtVals = pages.map(p => p.tbt).filter((v): v is number => v !== null);
  const clsVals = pages.map(p => p.cls).filter((v): v is number => v !== null);
  const ttfbVals = pages.map(p => p.ttfb).filter((v): v is number => v !== null);

  const scored = pages.map(p => ({
    score: (p.fcp ?? 9999) + (p.lcp ?? 9999) + (p.tbt ?? 999),
    url: p.url,
  }));
  const sorted = [...scored].sort((a,b) => a.score - b.score);

  return {
    jobId,
    generatedAt: now,
    pagesAnalyzed: pages.length,
    pages,
    aggregates: {
      medianFcp:  median(fcpVals),
      medianLcp:  median(lcpVals),
      medianTti:  median(ttiVals),
      medianTbt:  median(tbtVals),
      medianCls:  median(clsVals),
      medianTtfb: median(ttfbVals),
      bestPage:  sorted[0]?.url ?? null,
      worstPage: sorted[sorted.length - 1]?.url ?? null,
    },
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface C3Options {
  jobId: string;
  /** URLs to measure. If omitted, page URLs are derived from the manifest. */
  urls?: string[];
  /** Maximum pages to measure with Puppeteer (default: 5). */
  maxPages?: number;
}

export async function runRuntimePerformance(options: C3Options): Promise<C3Bundle> {
  const { jobId, maxPages = 5 } = options;
  const now = new Date().toISOString();

  logger.info({ jobId }, "C3: starting runtime performance analysis");

  let urlsToMeasure: string[] = options.urls ?? [];

  // Derive URLs from manifest if not explicitly provided
  if (urlsToMeasure.length === 0) {
    const manifest = await loadManifest(jobId);
    if (!manifest) {
      throw new Error(`C3: manifest not found for jobId "${jobId}"`);
    }
    const nodes = [...manifest.nodes.values()];
    if (nodes.length === 0) {
      throw new Error(`C3: manifest for "${jobId}" has no page nodes`);
    }
    // Use node IDs (URLs) — filter to those that look like real HTTP URLs
    urlsToMeasure = nodes
      .map(n => n.id)
      .filter(id => id.startsWith("http"))
      .slice(0, maxPages);

    if (urlsToMeasure.length === 0) {
      // Fall back to seed URL from manifest
      urlsToMeasure = [manifest.seedUrl].filter(Boolean);
    }
  }

  if (urlsToMeasure.length === 0) {
    throw new Error(`C3: no URLs to measure for jobId "${jobId}"`);
  }

  logger.info({ jobId, count: urlsToMeasure.length }, "C3: measuring pages");

  // Measure each URL (sequentially to avoid memory pressure)
  const pages: PagePerformanceMetrics[] = [];
  for (const url of urlsToMeasure) {
    const result = await measureUrl(url);
    pages.push(result);
  }

  logger.info({ jobId, measured: pages.length }, "C3: measurements complete — building reports");

  const runtimePerformanceReport  = buildRuntimeReport(jobId, pages, now);
  const coreWebVitalsReport        = buildCwvReport(jobId, pages, now);
  const bundleAnalysis             = buildBundleAnalysis(jobId, pages, now);
  const performanceRecommendations = buildRecommendations(jobId, pages, bundleAnalysis, coreWebVitalsReport, now);

  logger.info({ jobId }, "C3: all 4 reports generated — storing to R2");

  const [r2Runtime, r2Cwv, r2Bundle, r2Recs] = await Promise.all([
    storeJsonToR2(jobId, "runtime-performance-report.json",  runtimePerformanceReport),
    storeJsonToR2(jobId, "core-web-vitals-report.json",      coreWebVitalsReport),
    storeJsonToR2(jobId, "bundle-analysis.json",             bundleAnalysis),
    storeJsonToR2(jobId, "performance-recommendations.json", performanceRecommendations),
  ]);

  const bundle: C3Bundle = {
    jobId,
    generatedAt: now,
    runtimePerformanceReport,
    coreWebVitalsReport,
    bundleAnalysis,
    performanceRecommendations,
    r2Keys: {
      runtimePerformanceReport:  r2Runtime,
      coreWebVitalsReport:       r2Cwv,
      bundleAnalysis:            r2Bundle,
      performanceRecommendations: r2Recs,
    },
  };

  _store.set(jobId, bundle);
  logger.info({ jobId, overallCwv: coreWebVitalsReport.summary.overallRating }, "C3: runtime performance complete");
  return bundle;
}
