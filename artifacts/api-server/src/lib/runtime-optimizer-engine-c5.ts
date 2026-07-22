/**
 * runtime-optimizer-engine-c5.ts — Phase C5: Website Prime Runtime Optimizer
 *
 * Analyzes the manifest to recommend optimal runtime architecture for production.
 * Pure static analysis — no Puppeteer, no external network calls.
 *
 * Classifies every route as:
 *   static       — pre-render at build time, serve from CDN
 *   incremental  — ISR: revalidate on a schedule
 *   dynamic      — SSR: render per request
 *   hybrid       — static shell + client-side dynamic islands
 *
 * Produces (stored in R2 + in-memory):
 *   runtime-optimization-report.json
 *   rendering-strategy.json
 *   prefetch-plan.json
 *   runtime-health.json
 */

import * as cheerio from "cheerio";
import { logger } from "./logger.js";
import { loadManifest } from "./manifest-store.js";
import { createCloudProvider } from "../cloud/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeR2Key(jobId: string, filename: string): string {
  return `c5/${jobId}/${filename}`;
}

async function storeJsonToR2(jobId: string, filename: string, data: unknown): Promise<string> {
  const key = makeR2Key(jobId, filename);
  const provider = createCloudProvider("r2");
  if (!provider.isConfigured()) {
    logger.warn({ jobId, filename }, "C5: R2 not configured — skipping upload");
    return key;
  }
  const buf = Buffer.from(JSON.stringify(data, null, 2), "utf-8");
  await provider.upload({ key, data: buf, contentType: "application/json", checkDuplicate: false });
  logger.info({ jobId, key }, "C5: report stored to R2");
  return key;
}

// ── Route-pattern classification signals ─────────────────────────────────────

const DYNAMIC_PATH_PATTERNS = [
  /\/(dashboard|account|profile|settings|admin|portal|app)\b/i,
  /\/(cart|checkout|payment|order|invoice)\b/i,
  /\/(login|logout|signup|register|auth|oauth)\b/i,
  /\/(search|results)\b/i,
  /\/api\//i,
  /\?\w+=/,               // query string → likely dynamic
];

const INCREMENTAL_PATH_PATTERNS = [
  /\/(blog|post|article|news|press|story|case-study)\b/i,
  /\/(product|shop|store|item|listing)\b/i,
  /\/(event|webinar|podcast)\b/i,
  /\/\d{4}\/\d{2}\//,    // dated archives
];

const STATIC_PATH_PATTERNS = [
  /^\/?$/,                // root / homepage
  /\/(about|team|mission|vision|values)\b/i,
  /\/(contact|support|help|faq)\b/i,
  /\/(pricing|plans|features)\b/i,
  /\/(terms|privacy|legal|cookies)\b/i,
  /\/(careers|jobs|culture)\b/i,
  /\/(press|media|brand)\b/i,
];

type RenderingStrategy = "static" | "incremental" | "dynamic" | "hybrid";

// ── HTML content signals ──────────────────────────────────────────────────────

interface ContentSignals {
  hasReactRoot: boolean;
  hasNextData: boolean;
  hasVueApp: boolean;
  hasAngularApp: boolean;
  hasSvelteKit: boolean;
  hasAstro: boolean;
  hasNuxt: boolean;
  hasRemixRoot: boolean;
  jsScriptCount: number;
  cssLinkCount: number;
  hasAuthForm: boolean;
  hasSearchForm: boolean;
  hasCartSignals: boolean;
  hasPersonalization: boolean;
  hasDynamicDataAttrs: boolean;
  hasInlineJson: boolean;
  formCount: number;
  imageCount: number;
  linkCount: number;
  hasHydrationMarkers: boolean;
  hydrationSignal: "full" | "partial" | "islands" | "none";
}

function extractContentSignals(html: string): ContentSignals {
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html, { xml: false });
  } catch {
    return defaultSignals();
  }

  const bodyHtml = $("body").html() ?? html;
  const headHtml = $("head").html() ?? "";

  const hasReactRoot    = !!$('[data-reactroot],[data-reactid],#__next,#root').length || bodyHtml.includes("__reactFiber");
  const hasNextData     = bodyHtml.includes("__NEXT_DATA__") || !!$('#__next').length;
  const hasVueApp       = !!$('#app,[data-v-app]').length || bodyHtml.includes("__vue_app__");
  const hasAngularApp   = !!$('[ng-version],[_nghost],[_ngcontent]').length;
  const hasSvelteKit    = bodyHtml.includes("__sveltekit") || !!$('[data-sveltekit-preload]').length;
  const hasAstro        = headHtml.includes("astro:") || bodyHtml.includes("astro-island");
  const hasNuxt         = bodyHtml.includes("__NUXT__") || !!$('#__nuxt,#__layout').length;
  const hasRemixRoot    = !!$('#root[data-remix]').length || bodyHtml.includes("__remixContext");

  const jsScriptCount  = $("script[src]").length;
  const cssLinkCount   = $('link[rel="stylesheet"]').length;

  const hasAuthForm       = !!$('input[type="password"],form[action*="login"],form[action*="signin"]').length;
  const hasSearchForm     = !!$('input[type="search"],form[role="search"],[class*="search-form"]').length;
  const hasCartSignals    = !!$('[class*="cart"],[class*="basket"],[data-cart],[href*="/cart"]').length;
  const hasPersonalization = !!$('[data-user],[data-session],[class*="personalized"]').length;
  const hasDynamicDataAttrs = !!$('[data-dynamic],[data-live],[data-realtime]').length;
  const hasInlineJson     = !!$('script[type="application/json"]:not([type="application/ld+json"])').length;
  const formCount         = $("form").length;
  const imageCount        = $("img,picture,source").length;
  const linkCount         = $("a[href]").length;

  const hasHydrationMarkers =
    hasReactRoot || hasNextData || hasVueApp || hasAngularApp || hasSvelteKit || hasAstro || hasNuxt || hasRemixRoot;

  let hydrationSignal: ContentSignals["hydrationSignal"] = "none";
  if (hasAstro) hydrationSignal = "islands";
  else if (hasNextData || hasNuxt) hydrationSignal = "partial";
  else if (hasReactRoot || hasVueApp || hasAngularApp || hasSvelteKit || hasRemixRoot) hydrationSignal = "full";

  return {
    hasReactRoot, hasNextData, hasVueApp, hasAngularApp, hasSvelteKit, hasAstro, hasNuxt, hasRemixRoot,
    jsScriptCount, cssLinkCount,
    hasAuthForm, hasSearchForm, hasCartSignals, hasPersonalization, hasDynamicDataAttrs, hasInlineJson,
    formCount, imageCount, linkCount,
    hasHydrationMarkers, hydrationSignal,
  };
}

function defaultSignals(): ContentSignals {
  return {
    hasReactRoot: false, hasNextData: false, hasVueApp: false, hasAngularApp: false,
    hasSvelteKit: false, hasAstro: false, hasNuxt: false, hasRemixRoot: false,
    jsScriptCount: 0, cssLinkCount: 0,
    hasAuthForm: false, hasSearchForm: false, hasCartSignals: false, hasPersonalization: false,
    hasDynamicDataAttrs: false, hasInlineJson: false,
    formCount: 0, imageCount: 0, linkCount: 0,
    hasHydrationMarkers: false, hydrationSignal: "none",
  };
}

// ── Route classification ──────────────────────────────────────────────────────

interface RouteClassification {
  url: string;
  strategy: RenderingStrategy;
  confidence: "high" | "medium" | "low";
  reasons: string[];
  revalidateSeconds: number | null;  // null = no revalidation needed (static) or per-request (dynamic)
  signals: {
    pathPattern: string;
    wordCount: number;
    jsScripts: number;
    forms: number;
    hydration: ContentSignals["hydrationSignal"];
    isDynamic: boolean;
    isIncremental: boolean;
    isStatic: boolean;
    framework: string;
  };
  optimizations: RouteOptimization[];
}

interface RouteOptimization {
  type: "code-splitting" | "prerender" | "lazy-hydration" | "streaming-ssr" | "partial-prerendering" | "edge-rendering" | "isr" | "prefetch" | "component-cache";
  priority: "critical" | "high" | "medium" | "low";
  description: string;
  estimatedGain: string;
}

function detectFramework(signals: ContentSignals): string {
  if (signals.hasNextData)  return "Next.js";
  if (signals.hasNuxt)      return "Nuxt";
  if (signals.hasRemixRoot) return "Remix";
  if (signals.hasSvelteKit) return "SvelteKit";
  if (signals.hasAstro)     return "Astro";
  if (signals.hasVueApp)    return "Vue/Nuxt";
  if (signals.hasAngularApp) return "Angular";
  if (signals.hasReactRoot)  return "React";
  return "Unknown";
}

function classifyRoute(
  url: string,
  wordCount: number,
  signals: ContentSignals,
): RouteClassification {
  const reasons: string[] = [];
  const optimizations: RouteOptimization[] = [];
  let strategy: RenderingStrategy = "static";
  let confidence: RouteClassification["confidence"] = "medium";
  let revalidateSeconds: number | null = null;

  const path = (() => { try { return new URL(url).pathname; } catch { return url; } })();

  // ── Signals that push toward Dynamic ──────────────────────────────────────
  const isDynamic =
    DYNAMIC_PATH_PATTERNS.some(p => p.test(path)) ||
    signals.hasAuthForm ||
    signals.hasPersonalization ||
    signals.hasDynamicDataAttrs ||
    signals.hasCartSignals;

  // ── Signals that push toward Incremental ──────────────────────────────────
  const isIncremental =
    !isDynamic && (
      INCREMENTAL_PATH_PATTERNS.some(p => p.test(path)) ||
      wordCount > 1000  // content-heavy pages → likely updated occasionally
    );

  // ── Signals that push toward Static ───────────────────────────────────────
  const isStatic =
    !isDynamic && !isIncremental && (
      STATIC_PATH_PATTERNS.some(p => p.test(path)) ||
      wordCount < 100
    );

  // ── Hydration signals → Hybrid consideration ──────────────────────────────
  const isHybrid =
    !isDynamic && (
      signals.hydrationSignal === "islands" ||
      (signals.hasSearchForm && !isDynamic) ||
      (signals.hasInlineJson && !isDynamic)
    );

  // ── Strategy decision ─────────────────────────────────────────────────────
  if (isDynamic) {
    strategy = "dynamic";
    confidence = signals.hasAuthForm || signals.hasPersonalization ? "high" : "medium";
    revalidateSeconds = null; // per-request

    if (signals.hasAuthForm) reasons.push("Page contains authentication form — must render per request");
    if (signals.hasPersonalization) reasons.push("Personalization data attributes detected — user-specific content");
    if (signals.hasCartSignals) reasons.push("Cart/commerce signals — cart state is session-specific");
    if (signals.hasDynamicDataAttrs) reasons.push("data-dynamic/data-live attributes — real-time content");
    if (DYNAMIC_PATH_PATTERNS.some(p => p.test(path))) reasons.push(`URL path matches dynamic pattern (${path})`);

    // Dynamic optimizations
    if (signals.hasReactRoot || signals.hasNextData) {
      optimizations.push({
        type: "streaming-ssr",
        priority: "high",
        description: "Use React 18 Suspense boundaries with streaming SSR to progressively send HTML as data resolves.",
        estimatedGain: "Reduces TTFB by 200–600ms on data-heavy pages by sending the shell immediately.",
      });
    }
    optimizations.push({
      type: "edge-rendering",
      priority: "medium",
      description: "Deploy dynamic rendering at the edge (Vercel Edge Functions, Cloudflare Workers) to minimize geographic latency.",
      estimatedGain: "Reduces TTFB to <100ms globally vs. 300–800ms from a single origin.",
    });
    optimizations.push({
      type: "component-cache",
      priority: "medium",
      description: "Cache stable sub-components (nav, footer, sidebar) independently with React Server Components or fragment caching.",
      estimatedGain: "Saves 20–40% of server render time on pages with stable surrounding chrome.",
    });

  } else if (isHybrid) {
    strategy = "hybrid";
    confidence = "medium";
    revalidateSeconds = 3600; // hourly revalidation for the static shell

    if (signals.hydrationSignal === "islands") reasons.push("Astro islands detected — static HTML with selective hydration");
    if (signals.hasSearchForm) reasons.push("Search form present — static page with dynamic search island");
    if (signals.hasInlineJson) reasons.push("Inline JSON data blocks — static shell with data-driven islands");

    optimizations.push({
      type: "lazy-hydration",
      priority: "high",
      description: "Hydrate interactive islands lazily (on idle, on visible, on interaction) to minimize TTI.",
      estimatedGain: "Reduces initial JS parse by 30–60% depending on island count.",
    });
    optimizations.push({
      type: "partial-prerendering",
      priority: "high",
      description: "Pre-render the static shell at build time, stream dynamic islands from the edge.",
      estimatedGain: "Achieves near-static FCP while maintaining dynamic content freshness.",
    });

  } else if (isIncremental) {
    strategy = "incremental";
    confidence = wordCount > 2000 ? "high" : "medium";
    revalidateSeconds = wordCount > 2000 ? 3600 : 86400; // 1h for long content, 24h for medium

    if (INCREMENTAL_PATH_PATTERNS.some(p => p.test(path))) reasons.push(`URL matches content/commerce pattern (${path})`);
    if (wordCount > 1000) reasons.push(`High word count (${wordCount}) — content-heavy page updated periodically`);

    optimizations.push({
      type: "isr",
      priority: "critical",
      description: `Configure ISR with revalidate: ${revalidateSeconds}s — serve from cache, regenerate in background.`,
      estimatedGain: "First request on stale page regenerates in background; CDN serves cached version instantly.",
    });
    optimizations.push({
      type: "prerender",
      priority: "high",
      description: "Pre-render at build time and populate CDN cache immediately.",
      estimatedGain: "Subsequent requests served from CDN at ~1ms, no server involvement.",
    });

  } else {
    strategy = "static";
    confidence = STATIC_PATH_PATTERNS.some(p => p.test(path)) ? "high" : "medium";
    revalidateSeconds = null; // never — fully static

    if (STATIC_PATH_PATTERNS.some(p => p.test(path))) reasons.push(`URL matches static content pattern (${path})`);
    if (wordCount < 100) reasons.push(`Low word count (${wordCount}) — likely a layout/shell page`);
    if (!isDynamic && !isIncremental) reasons.push("No dynamic signals detected — content appears stable");

    optimizations.push({
      type: "prerender",
      priority: "critical",
      description: "Pre-render at build time and serve with immutable Cache-Control headers from a CDN.",
      estimatedGain: "CDN cache hit serves in <5ms globally with zero server compute.",
    });
    optimizations.push({
      type: "prefetch",
      priority: "high",
      description: "Add <link rel=prefetch> or <link rel=prerender> from the homepage to high-traffic static pages.",
      estimatedGain: "Near-instant navigation for prefetched pages (< 50ms perceived).",
    });
  }

  // ── Universal optimizations ───────────────────────────────────────────────
  if (signals.jsScriptCount > 5) {
    optimizations.push({
      type: "code-splitting",
      priority: "high",
      description: `${signals.jsScriptCount} JS files detected — split by route and load only what's needed.`,
      estimatedGain: "Reduces initial JS parse by 20–40% per route.",
    });
  }
  if (signals.hydrationSignal === "full" && strategy !== "dynamic") {
    optimizations.push({
      type: "lazy-hydration",
      priority: "medium",
      description: "Full-page hydration detected on a non-dynamic page — defer hydration of below-fold components.",
      estimatedGain: "Reduces TTI by 15–30% by deferring non-interactive hydration.",
    });
  }

  const framework = detectFramework(signals);

  return {
    url,
    strategy,
    confidence,
    reasons: reasons.length > 0 ? reasons : ["Default classification — no strong signals detected"],
    revalidateSeconds,
    signals: {
      pathPattern: path,
      wordCount,
      jsScripts: signals.jsScriptCount,
      forms: signals.formCount,
      hydration: signals.hydrationSignal,
      isDynamic,
      isIncremental,
      isStatic,
      framework,
    },
    optimizations,
  };
}

// ── Prefetch plan ─────────────────────────────────────────────────────────────

export interface PrefetchEntry {
  sourceUrl: string;
  targetUrl: string;
  targetStrategy: RenderingStrategy;
  prefetchType: "link-prefetch" | "link-prerender" | "dns-prefetch" | "none";
  reason: string;
  priority: "critical" | "high" | "medium" | "low";
  htmlHint: string;
}

export interface PrefetchPlan {
  jobId: string;
  generatedAt: string;
  totalEntries: number;
  entries: PrefetchEntry[];
  globalStrategy: {
    linkPrefetchCount: number;
    linkPrerenderCount: number;
    dnsPrefetchCount: number;
    skippedDynamicCount: number;
  };
  implementation: string;
}

function buildPrefetchPlan(
  jobId: string,
  routes: RouteClassification[],
  linkGraph: Map<string, string[]>,
  now: string,
): PrefetchPlan {
  const entries: PrefetchEntry[] = [];
  const strategyMap = new Map(routes.map(r => [r.url, r.strategy]));

  for (const route of routes) {
    const targets = linkGraph.get(route.url) ?? [];
    for (const target of targets.slice(0, 10)) { // max 10 prefetch targets per page
      const targetStrategy = strategyMap.get(target) ?? "static";

      // Don't prefetch dynamic pages — they contain user-specific data
      if (targetStrategy === "dynamic") {
        entries.push({
          sourceUrl: route.url, targetUrl: target, targetStrategy,
          prefetchType: "none",
          reason: "Target is dynamic — content is user-specific, prefetching would waste bandwidth",
          priority: "low",
          htmlHint: `<!-- ${target}: skip prefetch (dynamic) -->`,
        });
        continue;
      }

      const prefetchType: PrefetchEntry["prefetchType"] =
        targetStrategy === "static" ? "link-prerender" : "link-prefetch";
      const priority: PrefetchEntry["priority"] =
        targetStrategy === "static" ? "high" : "medium";

      entries.push({
        sourceUrl: route.url,
        targetUrl: target,
        targetStrategy,
        prefetchType,
        priority,
        reason: `Target is ${targetStrategy} — safe to ${prefetchType === "link-prerender" ? "prerender" : "prefetch"}`,
        htmlHint: prefetchType === "link-prerender"
          ? `<link rel="prerender" href="${target}">`
          : `<link rel="prefetch" href="${target}" as="document">`,
      });
    }
  }

  const linkPrefetchCount  = entries.filter(e => e.prefetchType === "link-prefetch").length;
  const linkPrerenderCount = entries.filter(e => e.prefetchType === "link-prerender").length;
  const dnsPrefetchCount   = entries.filter(e => e.prefetchType === "dns-prefetch").length;
  const skippedDynamicCount = entries.filter(e => e.prefetchType === "none").length;

  return {
    jobId, generatedAt: now,
    totalEntries: entries.length,
    entries,
    globalStrategy: { linkPrefetchCount, linkPrerenderCount, dnsPrefetchCount, skippedDynamicCount },
    implementation: [
      "1. Add the <link> hints from each entry's htmlHint field into the page <head>.",
      "2. For Next.js: use <Link prefetch={true}> for static targets; set prefetch={false} for dynamic.",
      "3. For Astro: use <link rel='prefetch'> via the @astrojs/prefetch integration.",
      "4. For React Router / Remix: use <Link prefetch='intent'> to prefetch on hover.",
      "5. Monitor prefetch hit rate via web-vitals LCP improvement and reduce targets if bandwidth is constrained.",
    ].join("\n"),
  };
}

// ── Runtime health ────────────────────────────────────────────────────────────

export interface RuntimeHealthIssue {
  code: string;
  severity: "critical" | "warning" | "info";
  message: string;
  affectedUrls: string[];
  fix: string;
}

export interface RuntimeHealthReport {
  jobId: string;
  generatedAt: string;
  overallScore: number;       // 0–100
  overallRating: "excellent" | "good" | "needs-improvement" | "poor";
  issues: RuntimeHealthIssue[];
  framework: string;
  hydrationStrategy: ContentSignals["hydrationSignal"];
  staticPageCount: number;
  incrementalPageCount: number;
  dynamicPageCount: number;
  hybridPageCount: number;
  totalPageCount: number;
  optimizationOpportunities: number;
}

// ── Rendering strategy report ─────────────────────────────────────────────────

export interface RenderingStrategyReport {
  jobId: string;
  generatedAt: string;
  framework: string;
  detectedHydration: ContentSignals["hydrationSignal"];
  routes: RouteClassification[];
  summary: {
    static: number;
    incremental: number;
    dynamic: number;
    hybrid: number;
    total: number;
    staticPct: number;
    incrementalPct: number;
    dynamicPct: number;
    hybridPct: number;
  };
  frameworkRecommendation: string;
}

// ── Runtime optimization report ───────────────────────────────────────────────

export interface RuntimeOptimizationReport {
  jobId: string;
  generatedAt: string;
  executiveSummary: string;
  framework: string;
  hydrationStrategy: ContentSignals["hydrationSignal"];
  pagesAnalyzed: number;
  routeSummary: {
    static: number;
    incremental: number;
    dynamic: number;
    hybrid: number;
  };
  topOptimizations: RouteOptimization[];
  componentReuseOpportunities: ComponentReuseOpportunity[];
  dataFetchingRecommendations: DataFetchingRecommendation[];
  reactRenderingRecommendations: ReactRenderingRecommendation[];
}

interface ComponentReuseOpportunity {
  component: string;
  occurrencesAcrossPages: number;
  recommendation: string;
  estimatedSaving: string;
}

interface DataFetchingRecommendation {
  pattern: "waterfall" | "parallel" | "streaming" | "static-props" | "server-component";
  applicable: boolean;
  description: string;
  implementation: string;
}

interface ReactRenderingRecommendation {
  category: "server-components" | "suspense" | "concurrent" | "memoization" | "virtualization";
  priority: "critical" | "high" | "medium" | "low";
  description: string;
  implementation: string;
  applicableStrategies: RenderingStrategy[];
}

// ── Report builders ───────────────────────────────────────────────────────────

function buildRenderingStrategyReport(
  jobId: string,
  routes: RouteClassification[],
  framework: string,
  hydration: ContentSignals["hydrationSignal"],
  now: string,
): RenderingStrategyReport {
  const s = routes.filter(r => r.strategy === "static").length;
  const i = routes.filter(r => r.strategy === "incremental").length;
  const d = routes.filter(r => r.strategy === "dynamic").length;
  const h = routes.filter(r => r.strategy === "hybrid").length;
  const total = routes.length || 1;

  const frameworkRecommendation = (() => {
    if (framework === "Next.js") {
      if (d > s + i) return "Your site has many dynamic pages. Use Next.js App Router with React Server Components and streaming to minimise client JS and TTFB.";
      if (i > d) return "Content-heavy site detected. Use Next.js ISR (revalidate) for content pages and static generation for marketing pages.";
      return "Good mix. Use Next.js static generation for marketing pages, ISR for content, and dynamic rendering only for authenticated/personalized pages.";
    }
    if (framework === "Nuxt") return "Use Nuxt's hybrid rendering config to set per-route rendering rules (static, isr, dynamic).";
    if (framework === "SvelteKit") return "Use SvelteKit prerender for static routes, load functions for dynamic data, and edge deployment for low-latency SSR.";
    if (framework === "Remix") return "Use Remix loaders for data fetching, defer() for non-critical data, and cache headers to approximate ISR behavior.";
    if (framework === "Astro") return "Excellent choice for this content profile. Use Astro's islands architecture — static HTML by default, hydrate only interactive components.";
    if (d > total * 0.5) return "Over half of pages are dynamic. Consider adopting Next.js App Router or Remix for built-in data fetching, streaming, and edge deployment.";
    return "Consider adopting a meta-framework (Next.js, Nuxt, Astro, SvelteKit) to unlock fine-grained rendering strategy control per route.";
  })();

  return {
    jobId, generatedAt: now,
    framework, detectedHydration: hydration,
    routes,
    summary: {
      static: s, incremental: i, dynamic: d, hybrid: h, total,
      staticPct: Math.round(s / total * 100),
      incrementalPct: Math.round(i / total * 100),
      dynamicPct: Math.round(d / total * 100),
      hybridPct: Math.round(h / total * 100),
    },
    frameworkRecommendation,
  };
}

function buildRuntimeHealthReport(
  jobId: string,
  routes: RouteClassification[],
  framework: string,
  hydration: ContentSignals["hydrationSignal"],
  now: string,
): RuntimeHealthReport {
  const issues: RuntimeHealthIssue[] = [];
  const total = routes.length;

  // Check for over-dynamism
  const dynamicRoutes = routes.filter(r => r.strategy === "dynamic");
  const staticRoutes  = routes.filter(r => r.strategy === "static");
  const hybridRoutes  = routes.filter(r => r.strategy === "hybrid");

  if (dynamicRoutes.length > total * 0.7) {
    issues.push({
      code: "OVER_DYNAMIC",
      severity: "critical",
      message: `${dynamicRoutes.length}/${total} pages classified as dynamic — most pages are being server-rendered per request, eliminating CDN cacheability.`,
      affectedUrls: dynamicRoutes.map(r => r.url),
      fix: "Audit each dynamic route — move stable content to ISR or static. Only truly user-specific pages (auth, cart, dashboard) should be dynamic.",
    });
  }

  // Check for full hydration on static pages
  const fullHydrationStatic = routes.filter(r => r.strategy === "static" && r.signals.hydration === "full");
  if (fullHydrationStatic.length > 0) {
    issues.push({
      code: "UNNECESSARY_FULL_HYDRATION",
      severity: "warning",
      message: `${fullHydrationStatic.length} static page(s) ship full React/Vue/Angular hydration when the content is static.`,
      affectedUrls: fullHydrationStatic.map(r => r.url),
      fix: "Use Astro, Qwik, or server components to render static HTML with zero client JS. Or use React's renderToStaticMarkup for purely informational pages.",
    });
  }

  // Check for no framework detection
  if (framework === "Unknown" && total > 0) {
    issues.push({
      code: "NO_FRAMEWORK_DETECTED",
      severity: "info",
      message: "No modern framework signals detected — the site may be a classic MPA or use a non-standard setup.",
      affectedUrls: [],
      fix: "Consider adopting Next.js, Nuxt, Astro, or SvelteKit to unlock rendering strategy control per route.",
    });
  }

  // Check for heavy JS on static pages
  const heavyJsStatic = routes.filter(r => r.strategy === "static" && r.signals.jsScripts > 8);
  if (heavyJsStatic.length > 0) {
    issues.push({
      code: "HEAVY_JS_ON_STATIC",
      severity: "warning",
      message: `${heavyJsStatic.length} static page(s) load more than 8 JS files despite being classifiable as static.`,
      affectedUrls: heavyJsStatic.map(r => r.url),
      fix: "Audit JS files — remove unused scripts. Use dynamic import() to defer non-critical modules. Consider moving to a static HTML approach for these pages.",
    });
  }

  // Check for missing prerender on static pages
  const staticWithNoPrerender = staticRoutes.filter(r => !r.optimizations.some(o => o.type === "prerender"));
  if (staticWithNoPrerender.length > 0) {
    issues.push({
      code: "STATIC_NOT_PRERENDERED",
      severity: "info",
      message: `${staticWithNoPrerender.length} pages classified as static but no prerender configuration detected.`,
      affectedUrls: staticWithNoPrerender.map(r => r.url),
      fix: "Configure build-time pre-rendering for these pages. All static pages should be served from a CDN with immutable cache headers.",
    });
  }

  // Scoring
  const criticalCount = issues.filter(i => i.severity === "critical").length;
  const warningCount  = issues.filter(i => i.severity === "warning").length;
  const staticRatio   = staticRoutes.length / (total || 1);

  const baseScore = 100 - criticalCount * 20 - warningCount * 8;
  const staticBonus = Math.round(staticRatio * 15); // more static = healthier
  const overallScore = Math.min(100, Math.max(0, baseScore + staticBonus));

  let overallRating: RuntimeHealthReport["overallRating"] = "poor";
  if (overallScore >= 90) overallRating = "excellent";
  else if (overallScore >= 70) overallRating = "good";
  else if (overallScore >= 50) overallRating = "needs-improvement";

  const allOptimizations = routes.flatMap(r => r.optimizations);

  return {
    jobId, generatedAt: now, overallScore, overallRating,
    issues, framework, hydrationStrategy: hydration,
    staticPageCount:      staticRoutes.length,
    incrementalPageCount: routes.filter(r => r.strategy === "incremental").length,
    dynamicPageCount:     dynamicRoutes.length,
    hybridPageCount:      hybridRoutes.length,
    totalPageCount:       total,
    optimizationOpportunities: allOptimizations.length,
  };
}

function buildOptimizationReport(
  jobId: string,
  routes: RouteClassification[],
  framework: string,
  hydration: ContentSignals["hydrationSignal"],
  now: string,
): RuntimeOptimizationReport {
  const total = routes.length;
  const staticCount      = routes.filter(r => r.strategy === "static").length;
  const incrementalCount = routes.filter(r => r.strategy === "incremental").length;
  const dynamicCount     = routes.filter(r => r.strategy === "dynamic").length;
  const hybridCount      = routes.filter(r => r.strategy === "hybrid").length;

  // Top optimizations by priority (deduplicated by type)
  const allOpts = routes.flatMap(r => r.optimizations);
  const seen = new Set<string>();
  const topOptimizations: RouteOptimization[] = [];
  const priorities = ["critical", "high", "medium", "low"] as const;
  for (const priority of priorities) {
    for (const opt of allOpts.filter(o => o.priority === priority)) {
      if (!seen.has(opt.type)) {
        seen.add(opt.type);
        topOptimizations.push(opt);
      }
    }
  }

  // Component reuse — detect pages sharing similar structure
  const componentReuseOpportunities: ComponentReuseOpportunity[] = [];
  if (total > 3) {
    componentReuseOpportunities.push({
      component: "Navigation / Header",
      occurrencesAcrossPages: total,
      recommendation: "Extract as a shared server component cached independently of page content.",
      estimatedSaving: "Eliminates redundant nav render cost across all pages.",
    });
    componentReuseOpportunities.push({
      component: "Footer",
      occurrencesAcrossPages: total,
      recommendation: "Render footer as a fully static fragment — embed as a server component or include via edge-side includes.",
      estimatedSaving: "Near-zero render cost for a component present on every page.",
    });
    if (routes.some(r => r.signals.jsScripts > 3)) {
      componentReuseOpportunities.push({
        component: "Shared JS bundles",
        occurrencesAcrossPages: routes.filter(r => r.signals.jsScripts > 3).length,
        recommendation: "Extract common code into a shared chunk via bundler splitChunks config.",
        estimatedSaving: "Shared chunk cached across navigations — eliminates re-parse on page transitions.",
      });
    }
  }

  // Data fetching recommendations
  const dataFetchingRecommendations: DataFetchingRecommendation[] = [
    {
      pattern: "parallel",
      applicable: dynamicCount > 0,
      description: "Fetch independent data sources in parallel using Promise.all() rather than sequentially.",
      implementation: "Replace sequential awaits with const [a, b] = await Promise.all([fetchA(), fetchB()]).",
    },
    {
      pattern: "streaming",
      applicable: dynamicCount > 0 && (framework === "Next.js" || framework === "Remix"),
      description: "Stream data-dependent UI sections as they resolve rather than waiting for all data.",
      implementation: framework === "Next.js"
        ? "Wrap slow data-fetching components in <Suspense fallback={<Skeleton />}>."
        : "Use Remix defer() + Await component for non-critical data.",
    },
    {
      pattern: "static-props",
      applicable: staticCount + incrementalCount > 0,
      description: "Fetch all static page data at build time — eliminates runtime data fetching for most users.",
      implementation: framework === "Next.js"
        ? "Use getStaticProps (Pages Router) or async Server Components that run at build time (App Router)."
        : "Fetch data during the build step and serialize into the page HTML.",
    },
    {
      pattern: "server-component",
      applicable: framework === "Next.js" || framework === "Remix",
      description: "Move data fetching to server components — eliminates API round-trips from the client.",
      implementation: "Mark components as async Server Components. Fetch directly in the component body — no useEffect, no fetch hooks.",
    },
    {
      pattern: "waterfall",
      applicable: dynamicCount > 0,
      description: "Eliminate request waterfalls — where component B only fetches after component A renders.",
      implementation: "Move data fetching to the route level (loader, getServerSideProps, Server Component) and pass as props.",
    },
  ];

  // React rendering recommendations
  const reactRenderingRecommendations: ReactRenderingRecommendation[] = [];

  if (framework === "Next.js" || framework === "React" || framework === "Remix") {
    reactRenderingRecommendations.push({
      category: "server-components",
      priority: "critical",
      description: "Convert data-fetching components to React Server Components — they run on the server and send zero client JS.",
      implementation: "Add 'use server' or remove 'use client' directive. Async components with direct DB/API calls are automatically Server Components in Next.js App Router.",
      applicableStrategies: ["static", "incremental", "dynamic"],
    });
    reactRenderingRecommendations.push({
      category: "suspense",
      priority: "high",
      description: "Wrap async data-fetching boundaries in Suspense to enable streaming and prevent full-page loading states.",
      implementation: "import { Suspense } from 'react'; wrap <DataComponent /> in <Suspense fallback={<Skeleton />}>",
      applicableStrategies: ["dynamic", "hybrid"],
    });
    reactRenderingRecommendations.push({
      category: "concurrent",
      priority: "high",
      description: "Adopt React 18 concurrent features — useTransition, useDeferredValue — to keep UI responsive during heavy renders.",
      implementation: "Replace setState directly with startTransition(() => setState(val)) for non-urgent updates. Use useDeferredValue for search input filtering.",
      applicableStrategies: ["dynamic", "hybrid"],
    });
  }

  reactRenderingRecommendations.push({
    category: "memoization",
    priority: "medium",
    description: "Prevent unnecessary re-renders by memoizing stable components and callbacks.",
    implementation: "Use React.memo() on pure presentational components. Use useCallback for event handlers passed as props. Use useMemo for expensive derived values.",
    applicableStrategies: ["dynamic", "hybrid", "static"],
  });

  if (total > 5) {
    reactRenderingRecommendations.push({
      category: "virtualization",
      priority: "medium",
      description: "Virtualize long lists (products, posts, tables) — render only visible rows in the viewport.",
      implementation: "Use @tanstack/react-virtual or react-window. Replace <ul>{items.map(...)}</ul> with <VirtualList items={items} />.",
      applicableStrategies: ["dynamic", "hybrid", "incremental"],
    });
  }

  const executiveSummary = [
    `Analyzed ${total} pages: ${staticCount} Static, ${incrementalCount} Incremental, ${dynamicCount} Dynamic, ${hybridCount} Hybrid.`,
    framework !== "Unknown" ? `Framework detected: ${framework} (hydration: ${hydration}).` : "No framework detected.",
    staticCount + incrementalCount > dynamicCount
      ? "Majority of pages can be served statically or via ISR — excellent for performance and cost."
      : "Majority of pages require dynamic rendering — focus on streaming SSR and edge deployment.",
    `${topOptimizations.filter(o => o.priority === "critical" || o.priority === "high").length} high-priority optimization opportunities identified.`,
  ].join(" ");

  return {
    jobId, generatedAt: now, executiveSummary, framework, hydrationStrategy: hydration,
    pagesAnalyzed: total,
    routeSummary: { static: staticCount, incremental: incrementalCount, dynamic: dynamicCount, hybrid: hybridCount },
    topOptimizations,
    componentReuseOpportunities,
    dataFetchingRecommendations,
    reactRenderingRecommendations,
  };
}

// ── Report bundle ─────────────────────────────────────────────────────────────

export interface C5Bundle {
  jobId: string;
  generatedAt: string;
  runtimeOptimizationReport: RuntimeOptimizationReport;
  renderingStrategy: RenderingStrategyReport;
  prefetchPlan: PrefetchPlan;
  runtimeHealth: RuntimeHealthReport;
  r2Keys: {
    runtimeOptimizationReport: string;
    renderingStrategy: string;
    prefetchPlan: string;
    runtimeHealth: string;
  };
}

const _store = new Map<string, C5Bundle>();

export function getC5Bundle(jobId: string): C5Bundle | undefined { return _store.get(jobId); }
export function listC5Bundles(): Array<{ jobId: string; generatedAt: string }> {
  return [..._store.values()].map(b => ({ jobId: b.jobId, generatedAt: b.generatedAt }));
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface C5Options {
  jobId: string;
}

export async function runRuntimeOptimizer(options: C5Options): Promise<C5Bundle> {
  const { jobId } = options;
  const now = new Date().toISOString();

  logger.info({ jobId }, "C5: starting runtime optimization analysis");

  const manifest = await loadManifest(jobId);
  if (!manifest) throw new Error(`C5: manifest not found for jobId "${jobId}"`);

  const nodes = [...manifest.nodes.values()];
  if (nodes.length === 0) throw new Error(`C5: manifest for "${jobId}" has no page nodes`);

  logger.info({ jobId, pageCount: nodes.length }, "C5: classifying routes");

  // Build link graph for prefetch plan
  const linkGraph = new Map<string, string[]>();
  const seedDomain = (() => { try { return new URL(manifest.seedUrl).hostname; } catch { return ""; } })();

  // Extract content signals + classify routes
  const routes: RouteClassification[] = [];
  let dominantFramework = "Unknown";
  let dominantHydration: ContentSignals["hydrationSignal"] = "none";

  for (const node of nodes) {
    const url = node.metadata.url || node.id;
    const html = node.content.cleanHtml ?? "";
    const wordCount = node.content.wordCount ?? 0;
    const signals = extractContentSignals(html);

    // Update dominant framework (first strong signal wins)
    if (dominantFramework === "Unknown") {
      const fw = detectFramework(signals);
      if (fw !== "Unknown") { dominantFramework = fw; dominantHydration = signals.hydrationSignal; }
    }

    // Build internal link graph for prefetch planning
    try {
      const $ = cheerio.load(html, { xml: false });
      const internalLinks: string[] = [];
      $("a[href]").each((_, el) => {
        const href = $(el).attr("href");
        if (!href || href.startsWith("#") || href.startsWith("mailto:")) return;
        try {
          const resolved = new URL(href, url).href;
          if (new URL(resolved).hostname === seedDomain) internalLinks.push(resolved);
        } catch { /* skip */ }
      });
      if (internalLinks.length > 0) linkGraph.set(url, [...new Set(internalLinks)]);
    } catch { /* skip */ }

    routes.push(classifyRoute(url, wordCount, signals));
  }

  logger.info({ jobId, framework: dominantFramework, hydration: dominantHydration }, "C5: building reports");

  const renderingStrategy      = buildRenderingStrategyReport(jobId, routes, dominantFramework, dominantHydration, now);
  const runtimeOptimizationReport = buildOptimizationReport(jobId, routes, dominantFramework, dominantHydration, now);
  const prefetchPlan           = buildPrefetchPlan(jobId, routes, linkGraph, now);
  const runtimeHealth          = buildRuntimeHealthReport(jobId, routes, dominantFramework, dominantHydration, now);

  logger.info({ jobId }, "C5: storing reports to R2");

  const [r2Opt, r2Strategy, r2Prefetch, r2Health] = await Promise.all([
    storeJsonToR2(jobId, "runtime-optimization-report.json", runtimeOptimizationReport),
    storeJsonToR2(jobId, "rendering-strategy.json",          renderingStrategy),
    storeJsonToR2(jobId, "prefetch-plan.json",               prefetchPlan),
    storeJsonToR2(jobId, "runtime-health.json",              runtimeHealth),
  ]);

  const bundle: C5Bundle = {
    jobId, generatedAt: now,
    runtimeOptimizationReport,
    renderingStrategy,
    prefetchPlan,
    runtimeHealth,
    r2Keys: {
      runtimeOptimizationReport: r2Opt!,
      renderingStrategy:          r2Strategy!,
      prefetchPlan:               r2Prefetch!,
      runtimeHealth:              r2Health!,
    },
  };

  _store.set(jobId, bundle);
  logger.info({ jobId, score: runtimeHealth.overallScore, framework: dominantFramework }, "C5: runtime optimizer complete");
  return bundle;
}
