/**
 * http-framework-fingerprinter.ts — Phase D1 Framework Detection
 *
 * Detects: React, Next.js, Astro, Express, Laravel, WordPress
 * Method:  HTTP-signal fingerprinting from live URLs (headers, HTML, cookies,
 *          script paths, known-path probes, meta tags).
 *
 * Returns FrameworkDetectionResult (same type as the source-code detector).
 */

import axios from "axios";
import type { FrameworkDetectionResult, Framework, FrameworkFeature } from "@workspace/site-discovery";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HttpSignals {
  headers: Record<string, string>;
  cookies: string[];
  scriptSrcs: string[];
  linkHrefs: string[];
  metaTags: Record<string, string>;
  htmlPatterns: string[];
  bodySnippet: string;
  probedPaths: Record<string, number>; // path → HTTP status code
}

export interface ScoreEntry {
  framework: Framework;
  score: number;
  signals: string[];
}

export interface FrameworkReport {
  version: "1.0";
  generatedAt: string;
  url: string;
  normalizedUrl: string;
  detection: FrameworkDetectionResult;
  signals: HttpSignals;
  scoreBreakdown: ScoreEntry[];
  durationMs: number;
}

// ─── HTTP Fetcher ─────────────────────────────────────────────────────────────

const USER_AGENT =
  "Mozilla/5.0 (compatible; FrameworkDetector/1.0; +https://github.com)";

async function fetchPage(url: string): Promise<{
  html: string;
  headers: Record<string, string>;
  status: number;
}> {
  const resp = await axios.get(url, {
    timeout: 15_000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
    responseType: "text",
  });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(resp.headers)) {
    if (typeof v === "string") headers[k.toLowerCase()] = v;
    else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
  }
  let html = String(resp.data ?? "");

  // Follow HTML-level meta-refresh redirects (axios only follows HTTP 3xx redirects)
  const metaRefresh = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"';]+)/i)
    ?? html.match(/<meta[^>]+content=["'][^"']*url=([^"';]+)[^"']*["'][^>]+http-equiv=["']?refresh["']?/i);
  if (metaRefresh?.[1]) {
    try {
      const redirectUrl = new URL(metaRefresh[1].trim(), url).href;
      const r2 = await axios.get(redirectUrl, {
        timeout: 15_000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
        responseType: "text",
      });
      html = String(r2.data ?? "");
      // Merge headers (keep original for cookies, overlay with redirect page headers)
      for (const [k, v] of Object.entries(r2.headers)) {
        const key = k.toLowerCase();
        if (key !== "set-cookie") {
          if (typeof v === "string") headers[key] = v;
          else if (Array.isArray(v)) headers[key] = v.join(", ");
        }
      }
    } catch {
      // If redirect fetch fails, keep the original response
    }
  }

  return { html, headers, status: resp.status };
}

async function probePath(base: string, pathname: string): Promise<number> {
  try {
    const resp = await axios.head(new URL(pathname, base).href, {
      timeout: 6_000,
      maxRedirects: 3,
      validateStatus: () => true,
      headers: { "User-Agent": USER_AGENT },
    });
    return resp.status;
  } catch {
    return 0;
  }
}

/** Probe WordPress login page and verify it's genuinely WordPress by checking body content */
async function probeWordPressLogin(base: string): Promise<boolean> {
  try {
    const url = new URL("/wp-login.php", base).href;
    const resp = await axios.get(url, {
      timeout: 8_000,
      maxRedirects: 3,
      validateStatus: () => true,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      responseType: "text",
    });
    if (resp.status !== 200 && resp.status !== 302) return false;
    const body = String(resp.data ?? "").slice(0, 4000);
    // Real WordPress login contains these identifiers
    return (
      body.includes("user_login") ||
      body.includes("wp-submit") ||
      body.includes("wordpress") ||
      body.includes("WordPress")
    );
  } catch {
    return false;
  }
}

/** Probe wp-json API and verify it's genuinely WordPress REST API */
async function probeWordPressJson(base: string): Promise<boolean> {
  try {
    const url = new URL("/wp-json/wp/v2/", base).href;
    const resp = await axios.get(url, {
      timeout: 8_000,
      maxRedirects: 3,
      validateStatus: () => true,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      responseType: "text",
    });
    if (resp.status !== 200) return false;
    const body = String(resp.data ?? "").slice(0, 2000);
    // Real WP REST API returns JSON with "namespace" or "_links" or "routes" fields
    return (
      body.includes('"namespace"') ||
      body.includes('"wp/v2"') ||
      body.includes('"_links"') ||
      body.includes("application/json")
    );
  } catch {
    return false;
  }
}

// ─── HTML parsers ─────────────────────────────────────────────────────────────

function extractScriptSrcs(html: string): string[] {
  const srcs: string[] = [];
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    srcs.push(m[1]!);
  }
  return srcs;
}

function extractLinkHrefs(html: string): string[] {
  const hrefs: string[] = [];
  for (const m of html.matchAll(/<link[^>]+href=["']([^"']+)["']/gi)) {
    hrefs.push(m[1]!);
  }
  return hrefs;
}

function extractMetaTags(html: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const m of html.matchAll(/<meta[^>]+>/gi)) {
    const tag = m[0]!;
    const nameM = tag.match(/name=["']([^"']+)["']/i);
    const contentM = tag.match(/content=["']([^"']+)["']/i);
    if (nameM && contentM) tags[nameM[1]!.toLowerCase()] = contentM[1]!;
  }
  return tags;
}

function parseCookies(setCookieHeader: string): string[] {
  // Split on commas that are followed by a new cookie name=value (not date commas like "Thu, 18 Jun")
  // A new cookie segment starts with a token (no spaces) immediately after the comma
  return setCookieHeader
    .split(/,(?=\s*[A-Za-z0-9_\-]+=)/)
    .map((c) => c.trim().split(";")[0]!.trim())
    .filter((c) => c.includes("=") && !/^\d/.test(c));
}

function detectHtmlPatterns(html: string): string[] {
  const found: string[] = [];
  const checks: [RegExp | string, string][] = [
    ["__NEXT_DATA__", "next-data-script"],
    [/_next\/static\//i, "next-static-path"],
    [/<astro-island/i, "astro-island-element"],
    [/_astro\//i, "astro-static-path"],
    ["data-reactroot", "react-root-attr"],
    [/data-react-/i, "react-data-attr"],
    [/wp-content\//i, "wp-content-path"],
    [/wp-includes\//i, "wp-includes-path"],
    [/\?ver=\d/i, "wp-version-param"],
    [/laravel_session/i, "laravel-session"],
    [/<meta[^>]+csrf-token/i, "csrf-meta-token"],
    [/window\.__next/i, "next-window-global"],
    [/data-astro-/i, "astro-data-attr"],
    [/__webpack_require__/i, "webpack-runtime"],
    [/react-dom/i, "react-dom-ref"],
    [/\/_next\/image/i, "next-image-path"],
    [/next-router/i, "next-router-ref"],
    [/XSRF-TOKEN/i, "xsrf-token"],
  ];
  for (const [pat, label] of checks) {
    if (typeof pat === "string" ? html.includes(pat) : pat.test(html)) {
      found.push(label);
    }
  }
  return found;
}

// ─── Framework scorers ────────────────────────────────────────────────────────

function scoreWordPress(signals: HttpSignals): ScoreEntry {
  let score = 0;
  const hits: string[] = [];

  const gen = signals.metaTags["generator"] ?? "";
  if (/wordpress/i.test(gen)) {
    score += 90;
    hits.push(`generator-meta: "${gen}"`);
  }
  if (signals.htmlPatterns.includes("wp-content-path")) {
    score += 65;
    hits.push("wp-content/ in HTML");
  }
  if (signals.htmlPatterns.includes("wp-includes-path")) {
    score += 40;
    hits.push("wp-includes/ in HTML");
  }
  if (signals.htmlPatterns.includes("wp-version-param")) {
    score += 20;
    hits.push("?ver= script params");
  }
  if (signals.scriptSrcs.some((s) => /\/wp-content\//i.test(s))) {
    score += 30;
    hits.push("wp-content/ in script src");
  }
  if (signals.cookies.some((c) => /wordpress_|wp-settings/i.test(c))) {
    score += 40;
    hits.push("WordPress cookies");
  }
  const wpLogin = signals.probedPaths["/wp-login.php"];
  if (wpLogin === 200 || wpLogin === 302) {
    score += 50;
    hits.push(`/wp-login.php → ${wpLogin}`);
  }
  const wpJson = signals.probedPaths["/wp-json/wp/v2/"];
  if (wpJson === 200) {
    score += 60;
    hits.push("/wp-json/wp/v2/ → 200");
  }
  if (/x-powered-by/i.test(signals.headers["x-powered-by"] ?? "") &&
      /wordpress/i.test(signals.headers["x-powered-by"] ?? "")) {
    score += 50;
    hits.push("X-Powered-By: WordPress header");
  }

  return { framework: "wordpress", score, signals: hits };
}

function scoreNextjs(signals: HttpSignals): ScoreEntry {
  let score = 0;
  const hits: string[] = [];

  if (signals.htmlPatterns.includes("next-data-script")) {
    score += 85;
    hits.push("__NEXT_DATA__ script in HTML");
  }
  if (signals.htmlPatterns.includes("next-static-path")) {
    score += 65;
    hits.push("/_next/static/ path in HTML");
  }
  if (signals.htmlPatterns.includes("next-image-path")) {
    score += 30;
    hits.push("/_next/image in HTML");
  }
  if (signals.htmlPatterns.includes("next-window-global")) {
    score += 40;
    hits.push("window.__next global");
  }
  if (signals.htmlPatterns.includes("next-router-ref")) {
    score += 25;
    hits.push("next-router ref in HTML");
  }
  if (signals.scriptSrcs.some((s) => /\/_next\//.test(s))) {
    score += 60;
    hits.push("/_next/ in script src");
  }
  if (Object.keys(signals.headers).some((h) => h.startsWith("x-next"))) {
    score += 35;
    hits.push("x-next-* response header");
  }
  const gen = signals.metaTags["generator"] ?? "";
  if (/next\.js/i.test(gen)) {
    score += 50;
    hits.push(`generator-meta: "${gen}"`);
  }

  return { framework: "nextjs", score, signals: hits };
}

function scoreAstro(signals: HttpSignals): ScoreEntry {
  let score = 0;
  const hits: string[] = [];

  if (signals.htmlPatterns.includes("astro-island-element")) {
    score += 90;
    hits.push("<astro-island> element");
  }
  if (signals.htmlPatterns.includes("astro-static-path")) {
    score += 65;
    hits.push("/_astro/ path in HTML");
  }
  if (signals.htmlPatterns.includes("astro-data-attr")) {
    score += 30;
    hits.push("data-astro-* attribute");
  }
  if (signals.scriptSrcs.some((s) => /\/_astro\//.test(s))) {
    score += 60;
    hits.push("/_astro/ in script src");
  }
  const gen = signals.metaTags["generator"] ?? "";
  if (/astro/i.test(gen)) {
    score += 90;
    hits.push(`generator-meta: "${gen}"`);
  }
  if (signals.linkHrefs.some((h) => /\/_astro\//.test(h))) {
    score += 40;
    hits.push("/_astro/ in link href");
  }

  return { framework: "astro", score, signals: hits };
}

function scoreReact(signals: HttpSignals, nextScore: number, astroScore: number): ScoreEntry {
  let score = 0;
  const hits: string[] = [];

  if (signals.htmlPatterns.includes("react-root-attr")) {
    score += 55;
    hits.push("data-reactroot attribute");
  }
  if (signals.htmlPatterns.includes("react-data-attr")) {
    score += 30;
    hits.push("data-react-* attribute");
  }
  if (signals.htmlPatterns.includes("react-dom-ref")) {
    score += 20;
    hits.push("react-dom reference in HTML");
  }
  if (signals.htmlPatterns.includes("webpack-runtime")) {
    score += 15;
    hits.push("__webpack_require__ (bundled React)");
  }
  if (signals.scriptSrcs.some((s) => /\/static\/js\/main\.\w+\.js/.test(s))) {
    score += 35;
    hits.push("CRA bundle pattern in script src");
  }
  if (signals.scriptSrcs.some((s) => /\/assets\/index-\w+\.js/.test(s))) {
    score += 30;
    hits.push("Vite React bundle pattern in script src");
  }

  // Penalize if Next.js or Astro is stronger — React is their base
  if (nextScore >= 60) score = Math.floor(score * 0.3);
  if (astroScore >= 60) score = Math.floor(score * 0.3);

  return { framework: "react", score, signals: hits };
}

function scoreExpress(signals: HttpSignals): ScoreEntry {
  let score = 0;
  const hits: string[] = [];

  const xpb = signals.headers["x-powered-by"] ?? "";
  if (/express/i.test(xpb)) {
    score += 90;
    hits.push(`X-Powered-By: ${xpb}`);
  }

  return { framework: "express", score, signals: hits };
}

function scoreLaravel(signals: HttpSignals): ScoreEntry {
  let score = 0;
  const hits: string[] = [];

  // laravel_session or laravelXXX_session or any *laravel*session* cookie
  const hasLaravelSession = signals.cookies.some((c) => /laravel.*session/i.test(c));
  if (hasLaravelSession) {
    score += 85;
    hits.push("laravel*session cookie");
  }
  if (signals.htmlPatterns.includes("laravel-session")) {
    score += 50;
    hits.push("laravel_session in HTML");
  }
  if (signals.htmlPatterns.includes("csrf-meta-token")) {
    score += 30;
    hits.push("<meta name=csrf-token> (Laravel Blade)");
  }
  // XSRF-TOKEN is set by Laravel; combined with any laravel-named cookie = strong
  const hasXsrf = signals.cookies.some((c) => /^XSRF-TOKEN/i.test(c));
  const hasLaravelCookie = signals.cookies.some((c) => /laravel/i.test(c));
  if (hasXsrf && hasLaravelCookie) {
    score += 30;
    hits.push("XSRF-TOKEN + laravel cookies");
  }
  // Inertia.js is almost exclusively used with Laravel
  const vary = signals.headers["vary"] ?? "";
  if (/x-inertia/i.test(vary)) {
    score += 45;
    hits.push("Vary: X-Inertia (Inertia.js = Laravel signal)");
  }
  // X-Powered-By: PHP is a weak corroborating signal
  const xpb = signals.headers["x-powered-by"] ?? "";
  if (/php/i.test(xpb) && score > 0) {
    score += 15;
    hits.push(`X-Powered-By: ${xpb} (PHP corroboration)`);
  }

  return { framework: "laravel", score, signals: hits };
}

// ─── Feature inference from HTTP signals ──────────────────────────────────────

function inferFeatures(
  primary: Framework,
  signals: HttpSignals
): FrameworkFeature[] {
  const f: FrameworkFeature[] = [];

  if (primary === "nextjs") {
    f.push("ssr", "file-system-routing");
    const body = signals.bodySnippet;
    if (body.includes("app-router") || signals.htmlPatterns.includes("next-data-script")) {
      f.push("ssg");
    }
    if (signals.htmlPatterns.includes("next-data-script")) {
      f.push("pages-router");
    }
  }

  if (primary === "astro") {
    f.push("ssg", "file-system-routing");
    if (signals.htmlPatterns.includes("astro-island-element")) {
      f.push("ssr");
    }
  }

  if (primary === "express") {
    f.push("rest-api");
  }

  if (primary === "laravel") {
    f.push("php-routing", "blade-templates", "rest-api");
    if (signals.probedPaths["/api/"] === 200) f.push("api-routes");
  }

  if (primary === "wordpress") {
    f.push("wp-hooks", "wp-rest-api");
  }

  return [...new Set(f)];
}

// ─── Version extraction ───────────────────────────────────────────────────────

function extractVersion(primary: Framework, signals: HttpSignals): string | null {
  const gen = signals.metaTags["generator"] ?? "";

  if (primary === "wordpress") {
    const m = gen.match(/WordPress\s+([\d.]+)/i);
    if (m) return m[1]!;
  }
  if (primary === "astro") {
    const m = gen.match(/Astro\s+v?([\d.]+)/i);
    if (m) return m[1]!;
  }
  if (primary === "nextjs") {
    const m = gen.match(/Next\.js\s+v?([\d.]+)/i);
    if (m) return m[1]!;
  }

  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fingerprintFramework(url: string): Promise<FrameworkReport> {
  const startMs = Date.now();
  const normalizedUrl = url.endsWith("/") ? url.slice(0, -1) : url;

  // 1. Fetch main page
  const { html, headers } = await fetchPage(normalizedUrl);

  // 2. Parse cookies
  const rawCookies = headers["set-cookie"] ?? "";
  const cookies = rawCookies ? parseCookies(rawCookies) : [];

  // 3. Extract HTML signals
  const scriptSrcs = extractScriptSrcs(html);
  const linkHrefs = extractLinkHrefs(html);
  const metaTags = extractMetaTags(html);
  const htmlPatterns = detectHtmlPatterns(html);
  const bodySnippet = html.slice(0, 8000);

  // 4. Probe well-known paths in parallel
  const [wpLoginVerified, wpJsonVerified, robotsStatus, apiStatus] = await Promise.all([
    probeWordPressLogin(normalizedUrl),
    probeWordPressJson(normalizedUrl),
    probePath(normalizedUrl, "/robots.txt"),
    probePath(normalizedUrl, "/api/"),
  ]);
  const probedPaths: Record<string, number> = {
    "/wp-login.php": wpLoginVerified ? 200 : 0,
    "/wp-json/wp/v2/": wpJsonVerified ? 200 : 0,
    "/robots.txt": robotsStatus,
    "/api/": apiStatus,
  };

  const signals: HttpSignals = {
    headers,
    cookies,
    scriptSrcs,
    linkHrefs,
    metaTags,
    htmlPatterns,
    bodySnippet,
    probedPaths,
  };

  // 5. Score each framework
  const wpEntry = scoreWordPress(signals);
  const nextEntry = scoreNextjs(signals);
  const astroEntry = scoreAstro(signals);
  const reactEntry = scoreReact(signals, nextEntry.score, astroEntry.score);
  const expressEntry = scoreExpress(signals);
  const laravelEntry = scoreLaravel(signals);

  const scoreBreakdown: ScoreEntry[] = [
    wpEntry, nextEntry, astroEntry, reactEntry, expressEntry, laravelEntry,
  ].sort((a, b) => b.score - a.score);

  // 6. Determine winner
  const top = scoreBreakdown[0]!;
  const CONFIDENCE_THRESHOLD = 30;
  const primary: Framework = top.score >= CONFIDENCE_THRESHOLD ? top.framework : "unknown";

  const secondary = scoreBreakdown
    .slice(1)
    .filter((s) => s.score >= CONFIDENCE_THRESHOLD && s.framework !== primary)
    .map((s) => s.framework);

  const maxPossible: Record<Framework, number> = {
    wordpress: 395,
    nextjs: 335,
    astro: 335,
    react: 165,
    express: 90,
    laravel: 255,
    unknown: 1,
  };

  const confidence =
    primary === "unknown"
      ? 0
      : parseFloat(Math.min(1, top.score / (maxPossible[primary] ?? 200)).toFixed(3));

  const version = extractVersion(primary, signals);
  const features = inferFeatures(primary, signals);

  const detection: FrameworkDetectionResult = {
    primary,
    secondary,
    confidence,
    version,
    features,
    isMonorepo: false,
    packageManager: "unknown",
  };

  const durationMs = Date.now() - startMs;

  return {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    url,
    normalizedUrl,
    detection,
    signals,
    scoreBreakdown,
    durationMs,
  };
}
