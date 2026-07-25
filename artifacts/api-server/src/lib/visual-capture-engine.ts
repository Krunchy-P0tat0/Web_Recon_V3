/**
 * visual-capture-engine.ts — Phase 2.5A Visual Capture Engine
 *
 * For every successfully crawled page, captures:
 *   1. Desktop screenshot  → jobs/{jobId}/visual/{nodeId}/desktop.png
 *   2. Mobile screenshot   → jobs/{jobId}/visual/{nodeId}/mobile.png
 *   3. DOM snapshot        → jobs/{jobId}/visual/{nodeId}/dom.html
 *   4. CSS snapshot        → jobs/{jobId}/visual/{nodeId}/styles.css
 *   5. Layout metadata     → jobs/{jobId}/visual/{nodeId}/layout-metadata.json
 *
 * Pipeline placement: normalization → visual_capture → manifest_generation
 *
 * Design:
 *   - Puppeteer browser is lazy-initialized and shared across all node captures.
 *   - Concurrency is bounded (default 3) to avoid OOM under large manifests.
 *   - All capture failures are non-fatal: the node's visualAssets will be
 *     partially populated; the pipeline continues regardless.
 *   - R2 uploads use @aws-sdk/client-s3 PutObjectCommand directly (buffer upload).
 */

import { logger } from "./logger";
import type { Manifest, PageNode } from "./manifest";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LayoutMetadata {
  pageHeight: number;
  pageWidth: number;
  sectionCount: number;
  imageCount: number;
  videoCount: number;
  headingStructure: Record<string, number>;
  hasNavigation: boolean;
  hasFooter: boolean;
}

export interface VisualAssets {
  desktopScreenshot?: string;
  mobileScreenshot?: string;
  domSnapshot?: string;
  cssSnapshot?: string;
  layoutMetadata?: LayoutMetadata;
}

export interface VisualCaptureAudit {
  pagesCaptured: number;
  desktopScreenshots: number;
  mobileScreenshots: number;
  domSnapshots: number;
  cssSnapshots: number;
  skipped: number;
  errors: number;
}

// ── R2 upload helper ──────────────────────────────────────────────────────────

async function uploadToR2(
  buffer: Buffer,
  key: string,
  contentType: string
): Promise<string | null> {
  const accessKeyId     = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint        = process.env.R2_ENDPOINT;
  const bucket          = process.env.R2_BUCKET_NAME;

  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) {
    return null;
  }

  try {
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      })
    );

    const publicBase = process.env.R2_PUBLIC_BASE_URL;
    return publicBase ? `${publicBase}/${key}` : key;
  } catch (err) {
    logger.warn({ err, key }, "VISUAL: R2 upload failed");
    return null;
  }
}

// ── Puppeteer browser singleton ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let capturesBrowser: any | null = null;

async function getCapturesBrowser(): Promise<unknown> {
  if (capturesBrowser) return capturesBrowser;
  const puppeteer = await import("puppeteer");
  capturesBrowser = await puppeteer.default.launch({
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
  logger.info("VISUAL: Chromium launched for visual capture");
  return capturesBrowser;
}

export async function shutdownVisualBrowser(): Promise<void> {
  if (capturesBrowser) {
    try {
      await (capturesBrowser as { close(): Promise<void> }).close();
    } catch { /* already closed */ }
    capturesBrowser = null;
  }
}

// ── Layout metadata extraction ────────────────────────────────────────────────
// Passed as a string so the Node.js TypeScript compiler never sees browser globals.

const LAYOUT_METADATA_FN = `() => {
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
  const navSelectors = ["nav",'[role="navigation"]',"header nav",".nav","#nav",".navbar",".menu"];
  const hasNavigation = navSelectors.some(s => document.querySelector(s) !== null);
  const footerSelectors = ["footer",'[role="contentinfo"]',".footer","#footer"];
  const hasFooter = footerSelectors.some(s => document.querySelector(s) !== null);
  return { pageHeight, pageWidth, sectionCount, imageCount, videoCount, headingStructure, hasNavigation, hasFooter };
}`;

const CSS_EXTRACT_FN = `() => {
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

async function extractLayoutMetadata(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any
): Promise<LayoutMetadata> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return page.evaluate(new Function(`return (${LAYOUT_METADATA_FN})()`)) as Promise<LayoutMetadata>;
}

async function extractAllCSS(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return page.evaluate(new Function(`return (${CSS_EXTRACT_FN})()`)) as Promise<string>;
}

// ── Single node capture ───────────────────────────────────────────────────────

async function captureNode(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  browser: any,
  node: PageNode,
  jobId: string
): Promise<{ assets: VisualAssets; desktopOk: boolean; mobileOk: boolean; domOk: boolean; cssOk: boolean }> {
  const url = node.metadata.url;
  const nodeId = node.id;
  const prefix = `jobs/${jobId}/visual/${nodeId}`;
  const assets: VisualAssets = {};

  let page: unknown = null;
  const result = { assets, desktopOk: false, mobileOk: false, domOk: false, cssOk: false };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page = await (browser as any).newPage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = page as any;

    // Desktop viewport
    await p.setViewport({ width: 1280, height: 800 });
    await p.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });

    // ── Desktop screenshot ──────────────────────────────────────────────────
    try {
      const desktopBuf = await p.screenshot({ type: "png", fullPage: true }) as Buffer;
      const path = await uploadToR2(desktopBuf, `${prefix}/desktop.png`, "image/png");
      if (path) { assets.desktopScreenshot = path; result.desktopOk = true; }
    } catch (e) {
      logger.debug({ nodeId, err: e }, "VISUAL: desktop screenshot failed");
    }

    // ── Layout metadata (while still at desktop viewport) ──────────────────
    try {
      const meta = await extractLayoutMetadata(p);
      assets.layoutMetadata = meta;
    } catch (e) {
      logger.debug({ nodeId, err: e }, "VISUAL: layout metadata extraction failed");
    }

    // ── CSS snapshot ────────────────────────────────────────────────────────
    try {
      const css = await extractAllCSS(p);
      if (css.trim()) {
        const cssBuf = Buffer.from(css, "utf8");
        const path = await uploadToR2(cssBuf, `${prefix}/styles.css`, "text/css");
        if (path) { assets.cssSnapshot = path; result.cssOk = true; }
      }
    } catch (e) {
      logger.debug({ nodeId, err: e }, "VISUAL: CSS snapshot failed");
    }

    // ── DOM snapshot ────────────────────────────────────────────────────────
    try {
      const dom = await p.content() as string;
      const domBuf = Buffer.from(dom, "utf8");
      const path = await uploadToR2(domBuf, `${prefix}/dom.html`, "text/html");
      if (path) { assets.domSnapshot = path; result.domOk = true; }
    } catch (e) {
      logger.debug({ nodeId, err: e }, "VISUAL: DOM snapshot failed");
    }

    // ── Mobile screenshot ───────────────────────────────────────────────────
    try {
      await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
      const mobileBuf = await p.screenshot({ type: "png", fullPage: true }) as Buffer;
      const path = await uploadToR2(mobileBuf, `${prefix}/mobile.png`, "image/png");
      if (path) { assets.mobileScreenshot = path; result.mobileOk = true; }
    } catch (e) {
      logger.debug({ nodeId, err: e }, "VISUAL: mobile screenshot failed");
    }

    // ── Layout metadata JSON upload ─────────────────────────────────────────
    if (assets.layoutMetadata) {
      try {
        const metaBuf = Buffer.from(JSON.stringify(assets.layoutMetadata, null, 2), "utf8");
        await uploadToR2(metaBuf, `${prefix}/layout-metadata.json`, "application/json");
      } catch { /* non-fatal */ }
    }

  } catch (err) {
    logger.warn({ nodeId, url, err }, "VISUAL: failed to load page for capture");
  } finally {
    if (page) {
      try { await (page as { close(): Promise<void> }).close(); } catch { /* ignore */ }
    }
  }

  return result;
}

// ── Pool helper ───────────────────────────────────────────────────────────────

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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * runVisualCapture — Phase 2.5A entry point.
 *
 * Iterates over all complete nodes in the manifest, captures visual artifacts
 * for each, uploads to R2, and attaches visualAssets to each PageNode.
 *
 * @param jobId     Job identifier — used as R2 path prefix.
 * @param manifest  Live manifest containing all crawled nodes.
 * @param options   concurrency: max parallel page captures (default 3).
 *                  maxPages: cap total pages captured (default 200).
 */
export async function runVisualCapture(
  jobId: string,
  manifest: Manifest,
  options: { concurrency?: number; maxPages?: number } = {}
): Promise<VisualCaptureAudit> {
  const concurrency = options.concurrency ?? 3;
  const maxPages    = options.maxPages ?? 200;

  const audit: VisualCaptureAudit = {
    pagesCaptured: 0,
    desktopScreenshots: 0,
    mobileScreenshots: 0,
    domSnapshots: 0,
    cssSnapshots: 0,
    skipped: 0,
    errors: 0,
  };

  // Only capture nodes that completed successfully and have a URL
  const eligible = Array.from(manifest.nodes.values()).filter(
    (n) => n.status === "complete" && n.metadata.url
  );

  if (eligible.length === 0) {
    logger.info({ jobId }, "VISUAL: no eligible nodes — skipping visual capture");
    return audit;
  }

  const nodes = eligible.slice(0, maxPages);
  audit.skipped = eligible.length - nodes.length;

  let browser: unknown;
  try {
    browser = await getCapturesBrowser();
  } catch (err) {
    logger.error({ jobId, err }, "VISUAL: failed to launch Chromium — visual capture skipped");
    audit.errors = nodes.length;
    return audit;
  }

  logger.info(
    { jobId, nodeCount: nodes.length, concurrency },
    "VISUAL: starting visual capture"
  );

  const tasks = nodes.map((node) => async () => {
    try {
      const { assets, desktopOk, mobileOk, domOk, cssOk } =
        await captureNode(browser, node, jobId);

      // Attach to node
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node as any).visualAssets = assets;

      audit.pagesCaptured++;
      if (desktopOk) audit.desktopScreenshots++;
      if (mobileOk)  audit.mobileScreenshots++;
      if (domOk)     audit.domSnapshots++;
      if (cssOk)     audit.cssSnapshots++;

      logger.debug(
        { jobId, nodeId: node.id, desktopOk, mobileOk, domOk, cssOk },
        "VISUAL: node captured"
      );
    } catch (err) {
      audit.errors++;
      logger.warn({ jobId, nodeId: node.id, err }, "VISUAL: node capture failed");
    }
  });

  await pooled(tasks, concurrency);

  logger.info(
    { jobId, ...audit },
    "VISUAL: visual capture complete"
  );

  return audit;
}
