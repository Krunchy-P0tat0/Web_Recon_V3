/**
 * screenshot-capture-engine.ts — Phase VR-1: Screenshot Capture Engine
 *
 * For every successfully crawled page, captures three viewport screenshots:
 *
 *   Desktop  1920 × 1080  → jobs/{jobId}/screenshots/desktop/{nodeId}.png
 *   Tablet    768 × 1024  → jobs/{jobId}/screenshots/tablet/{nodeId}.png
 *   Mobile    390 ×  844  → jobs/{jobId}/screenshots/mobile/{nodeId}.png
 *
 * Also captures DOM snapshot and CSS snapshot (for VR-2 DNA extraction):
 *   DOM      → jobs/{jobId}/screenshots/dom/{nodeId}.html
 *   CSS      → jobs/{jobId}/screenshots/css/{nodeId}.css
 *   Metadata → jobs/{jobId}/screenshots/metadata/{nodeId}.json
 *
 * All assets uploaded to Cloudflare R2.
 *
 * Manifest enhancement:
 *   node.visualAssets.desktopScreenshot  (1920px)
 *   node.visualAssets.tabletScreenshot   (768px)   ← new
 *   node.visualAssets.mobileScreenshot   (390px)
 *   node.visualAssets.cssSnapshot
 *   node.visualAssets.domSnapshot
 *   node.visualAssets.layoutMetadata
 *
 * Generates screenshot-capture-report.json (disk + R2).
 *
 * Pipeline: page crawl → content extraction → screenshot capture → R2 upload → manifest update
 *
 * Success criterion: 100% screenshot coverage for all successfully crawled pages.
 */

import { writeFile, readFile } from "fs/promises";
import { join }               from "path";
import { logger }             from "./logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import type { Manifest, PageNode } from "./manifest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScreenshotAssets {
  desktopScreenshot?: string;
  tabletScreenshot?:  string;
  mobileScreenshot?:  string;
  domSnapshot?:       string;
  cssSnapshot?:       string;
  layoutMetadata?:    LayoutMetadata;
  storageBytes:       number;
}

export interface LayoutMetadata {
  pageHeight:       number;
  pageWidth:        number;
  sectionCount:     number;
  imageCount:       number;
  videoCount:       number;
  headingStructure: Record<string, number>;
  hasNavigation:    boolean;
  hasFooter:        boolean;
}

export interface PageCaptureResult {
  nodeId:        string;
  url:           string;
  success:       boolean;
  desktopOk:     boolean;
  tabletOk:      boolean;
  mobileOk:      boolean;
  domOk:         boolean;
  cssOk:         boolean;
  storageBytes:  number;
  durationMs:    number;
  error?:        string;
}

export interface ScreenshotCaptureAudit {
  jobId:              string;
  pagesCaptured:      number;
  captureFailures:    number;
  desktopScreenshots: number;
  tabletScreenshots:  number;
  mobileScreenshots:  number;
  domSnapshots:       number;
  cssSnapshots:       number;
  skipped:            number;
  storageUsed:        number;   // total bytes uploaded to R2
  captureDuration:    number;   // ms
  coveragePercent:    number;   // pagesCaptured / eligible × 100
  pageResults:        PageCaptureResult[];
}

export interface ScreenshotCaptureReport {
  version:       string;
  phase:         string;
  generatedAt:   string;
  jobId:         string;
  audit:         ScreenshotCaptureAudit;
  r2PathTemplate: string;
  viewports: {
    desktop: { width: number; height: number };
    tablet:  { width: number; height: number };
    mobile:  { width: number; height: number };
  };
}

// ---------------------------------------------------------------------------
// Viewports
// ---------------------------------------------------------------------------

const VIEWPORT_DESKTOP = { width: 1920, height: 1080 };
const VIEWPORT_TABLET  = { width: 768,  height: 1024 };
const VIEWPORT_MOBILE  = { width: 390,  height: 844  };

// ---------------------------------------------------------------------------
// Puppeteer browser singleton
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _browser: any | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getBrowser(): Promise<any> {
  if (_browser) return _browser;
  const puppeteer = await import("puppeteer");
  _browser = await puppeteer.default.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ?? undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-extensions",
      "--no-first-run",
      "--mute-audio",
    ],
  });
  logger.info("SCREENSHOT: Chromium launched");
  return _browser;
}

export async function shutdownScreenshotBrowser(): Promise<void> {
  if (_browser) {
    try { await (_browser as { close(): Promise<void> }).close(); } catch { /* already closed */ }
    _browser = null;
  }
}

// ---------------------------------------------------------------------------
// In-browser evaluation strings
// ---------------------------------------------------------------------------

const LAYOUT_FN = `() => {
  const body = document.body;
  const docEl = document.documentElement;
  const pageHeight = Math.max(body.scrollHeight, body.offsetHeight, docEl.clientHeight, docEl.scrollHeight, docEl.offsetHeight);
  const pageWidth  = Math.max(body.scrollWidth,  body.offsetWidth,  docEl.clientWidth,  docEl.scrollWidth,  docEl.offsetWidth);
  const sectionTags = ["section","article","main","aside","header","footer"];
  const sectionCount = sectionTags.reduce((sum, tag) => sum + document.querySelectorAll(tag).length, 0);
  const imageCount = document.querySelectorAll("img, picture, [style*='background-image']").length;
  const videoCount = document.querySelectorAll("video, iframe[src*='youtube'], iframe[src*='vimeo']").length;
  const headingStructure = {};
  for (const tag of ["h1","h2","h3","h4","h5","h6"]) {
    const count = document.querySelectorAll(tag).length;
    if (count > 0) headingStructure[tag] = count;
  }
  const navSels = ["nav",'[role="navigation"]',"header nav",".nav","#nav",".navbar",".menu"];
  const hasNavigation = navSels.some(s => document.querySelector(s) !== null);
  const footerSels = ["footer",'[role="contentinfo"]',".footer","#footer"];
  const hasFooter = footerSels.some(s => document.querySelector(s) !== null);
  return { pageHeight, pageWidth, sectionCount, imageCount, videoCount, headingStructure, hasNavigation, hasFooter };
}`;

const CSS_FN = `() => {
  const parts = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = Array.from(sheet.cssRules || []);
      parts.push(rules.map(r => r.cssText).join("\\n"));
    } catch (e) {
      if (sheet.href) parts.push("/* external: " + sheet.href + " */");
    }
  }
  return parts.join("\\n\\n");
}`;

// ---------------------------------------------------------------------------
// R2 upload
// ---------------------------------------------------------------------------

async function upload(buffer: Buffer, key: string, contentType: string): Promise<string | null> {
  try {
    const cloud = getDefaultCloudProvider();
    if (!cloud.isConfigured()) return null;
    const url = await cloud.upload({ key, data: buffer, contentType, checkDuplicate: false });
    return typeof url === "string" ? url : key;
  } catch (err) {
    logger.warn({ err, key }, "SCREENSHOT: R2 upload failed");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Single-page capture
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function capturePage(browser: any, node: PageNode, jobId: string): Promise<PageCaptureResult> {
  const t0    = Date.now();
  const url   = node.metadata.url;
  const id    = node.id;
  const pfx   = `jobs/${jobId}/screenshots`;

  const result: PageCaptureResult = {
    nodeId: id, url, success: false,
    desktopOk: false, tabletOk: false, mobileOk: false,
    domOk: false, cssOk: false,
    storageBytes: 0, durationMs: 0,
  };

  const assets: ScreenshotAssets = { storageBytes: 0 };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let page: any | null = null;

  try {
    page = await browser.newPage();

    // ── Desktop (1920 × 1080) ─────────────────────────────────────────────
    await page.setViewport(VIEWPORT_DESKTOP);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });

    try {
      const buf = await page.screenshot({ type: "png", fullPage: true }) as Buffer;
      const key = `${pfx}/desktop/${id}.png`;
      const r2  = await upload(buf, key, "image/png");
      if (r2) { assets.desktopScreenshot = r2; result.desktopOk = true; result.storageBytes += buf.length; }
    } catch (e) { logger.debug({ id, e }, "SCREENSHOT: desktop failed"); }

    // ── Layout metadata (desktop viewport) ────────────────────────────────
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      assets.layoutMetadata = await page.evaluate(new Function(`return (${LAYOUT_FN})()`)) as LayoutMetadata;
    } catch { /* non-fatal */ }

    // ── CSS snapshot ──────────────────────────────────────────────────────
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const css = await page.evaluate(new Function(`return (${CSS_FN})()`)) as string;
      if (css.trim()) {
        const buf = Buffer.from(css, "utf8");
        const key = `${pfx}/css/${id}.css`;
        const r2  = await upload(buf, key, "text/css");
        if (r2) { assets.cssSnapshot = r2; result.cssOk = true; result.storageBytes += buf.length; }
      }
    } catch (e) { logger.debug({ id, e }, "SCREENSHOT: CSS snapshot failed"); }

    // ── DOM snapshot ──────────────────────────────────────────────────────
    try {
      const dom = await page.content() as string;
      const buf = Buffer.from(dom, "utf8");
      const key = `${pfx}/dom/${id}.html`;
      const r2  = await upload(buf, key, "text/html");
      if (r2) { assets.domSnapshot = r2; result.domOk = true; result.storageBytes += buf.length; }
    } catch (e) { logger.debug({ id, e }, "SCREENSHOT: DOM snapshot failed"); }

    // ── Tablet (768 × 1024) ───────────────────────────────────────────────
    try {
      await page.setViewport(VIEWPORT_TABLET);
      const buf = await page.screenshot({ type: "png", fullPage: true }) as Buffer;
      const key = `${pfx}/tablet/${id}.png`;
      const r2  = await upload(buf, key, "image/png");
      if (r2) { assets.tabletScreenshot = r2; result.tabletOk = true; result.storageBytes += buf.length; }
    } catch (e) { logger.debug({ id, e }, "SCREENSHOT: tablet failed"); }

    // ── Mobile (390 × 844) ────────────────────────────────────────────────
    try {
      await page.setViewport({ ...VIEWPORT_MOBILE, isMobile: true, hasTouch: true });
      const buf = await page.screenshot({ type: "png", fullPage: true }) as Buffer;
      const key = `${pfx}/mobile/${id}.png`;
      const r2  = await upload(buf, key, "image/png");
      if (r2) { assets.mobileScreenshot = r2; result.mobileOk = true; result.storageBytes += buf.length; }
    } catch (e) { logger.debug({ id, e }, "SCREENSHOT: mobile failed"); }

    // ── Layout metadata JSON ───────────────────────────────────────────────
    if (assets.layoutMetadata) {
      try {
        const buf = Buffer.from(JSON.stringify(assets.layoutMetadata, null, 2), "utf8");
        const key = `${pfx}/metadata/${id}.json`;
        await upload(buf, key, "application/json");
        result.storageBytes += buf.length;
      } catch { /* non-fatal */ }
    }

    // Attach to node
    (node as { visualAssets?: ScreenshotAssets }).visualAssets = assets;
    result.success = result.desktopOk || result.tabletOk || result.mobileOk;

  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    logger.warn({ id, url, err }, "SCREENSHOT: page load failed");
  } finally {
    if (page) {
      try { await (page as { close(): Promise<void> }).close(); } catch { /* ignore */ }
    }
  }

  result.durationMs = Date.now() - t0;
  return result;
}

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------

async function pooled<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = [];
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const task = queue.shift();
      if (task) results.push(await task());
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runScreenshotCapture(
  jobId: string,
  manifest: Manifest,
  options: { concurrency?: number; maxPages?: number } = {},
): Promise<ScreenshotCaptureAudit> {
  const concurrency = options.concurrency ?? 3;
  const maxPages    = options.maxPages ?? 200;
  const t0          = Date.now();

  const eligible = Array.from(manifest.nodes.values()).filter(
    (n) => n.status === "complete" && n.metadata.url,
  );

  const audit: ScreenshotCaptureAudit = {
    jobId,
    pagesCaptured:      0,
    captureFailures:    0,
    desktopScreenshots: 0,
    tabletScreenshots:  0,
    mobileScreenshots:  0,
    domSnapshots:       0,
    cssSnapshots:       0,
    skipped:            0,
    storageUsed:        0,
    captureDuration:    0,
    coveragePercent:    0,
    pageResults:        [],
  };

  if (eligible.length === 0) {
    logger.info({ jobId }, "SCREENSHOT: no eligible nodes");
    audit.captureDuration = Date.now() - t0;
    return audit;
  }

  const nodes   = eligible.slice(0, maxPages);
  audit.skipped = eligible.length - nodes.length;

  let browser: unknown;
  try {
    browser = await getBrowser();
  } catch (err) {
    logger.error({ jobId, err }, "SCREENSHOT: Chromium launch failed — skipping");
    audit.captureFailures = nodes.length;
    audit.captureDuration = Date.now() - t0;
    audit.coveragePercent = 0;
    return audit;
  }

  logger.info({ jobId, nodeCount: nodes.length, concurrency }, "SCREENSHOT: starting capture");

  const tasks = nodes.map((node) => async () => {
    const r = await capturePage(browser, node, jobId);
    audit.pageResults.push(r);
    if (r.success) {
      audit.pagesCaptured++;
      if (r.desktopOk) audit.desktopScreenshots++;
      if (r.tabletOk)  audit.tabletScreenshots++;
      if (r.mobileOk)  audit.mobileScreenshots++;
      if (r.domOk)     audit.domSnapshots++;
      if (r.cssOk)     audit.cssSnapshots++;
      audit.storageUsed += r.storageBytes;
    } else {
      audit.captureFailures++;
    }
  });

  await pooled(tasks, concurrency);

  audit.captureDuration = Date.now() - t0;
  audit.coveragePercent = eligible.length > 0
    ? Math.round((audit.pagesCaptured / eligible.length) * 100)
    : 100;

  logger.info({ ...audit }, "SCREENSHOT: capture complete");

  await generateReport(jobId, audit);
  return audit;
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

const REPORT_PATH    = join(process.cwd(), "screenshot-capture-report.json");
const REPORT_PATH_UP = join(process.cwd(), "..", "..", "screenshot-capture-report.json");

export async function generateReport(jobId: string, audit: ScreenshotCaptureAudit): Promise<ScreenshotCaptureReport> {
  const report: ScreenshotCaptureReport = {
    version:       "1.0",
    phase:         "VR-1",
    generatedAt:   new Date().toISOString(),
    jobId,
    audit,
    r2PathTemplate: `jobs/${jobId}/screenshots/{desktop|tablet|mobile}/{nodeId}.png`,
    viewports: {
      desktop: VIEWPORT_DESKTOP,
      tablet:  VIEWPORT_TABLET,
      mobile:  VIEWPORT_MOBILE,
    },
  };

  const json  = JSON.stringify(report, null, 2);
  const cloud = getDefaultCloudProvider();

  await Promise.allSettled([
    writeFile(REPORT_PATH,    json, "utf8"),
    writeFile(REPORT_PATH_UP, json, "utf8"),
    ...(cloud.isConfigured() ? [
      cloud.upload({
        key:            `jobs/${jobId}/screenshot-capture-report.json`,
        data:           Buffer.from(json, "utf8"),
        contentType:    "application/json",
        checkDuplicate: false,
      }),
      cloud.upload({
        key:            "orchestration/screenshot-capture-report.json",
        data:           Buffer.from(json, "utf8"),
        contentType:    "application/json",
        checkDuplicate: false,
      }),
    ] : []),
  ]);

  return report;
}

export async function loadReport(): Promise<ScreenshotCaptureReport | null> {
  for (const p of [REPORT_PATH, REPORT_PATH_UP]) {
    try { return JSON.parse(await readFile(p, "utf8")) as ScreenshotCaptureReport; } catch { /* skip */ }
  }
  return null;
}

// In-memory store for multi-job tracking
const _reports = new Map<string, ScreenshotCaptureReport>();
export function storeReport(r: ScreenshotCaptureReport): void { _reports.set(r.jobId, r); }
export function getReport(jobId: string): ScreenshotCaptureReport | undefined { return _reports.get(jobId); }
export function listReports(): ScreenshotCaptureReport[] {
  return Array.from(_reports.values()).sort((a, b) =>
    new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime());
}
