/**
 * headless-fetcher.ts — Puppeteer-based fallback fetcher for JS-rendered or
 * rate-limited pages that return empty / unreachable content via plain axios.
 *
 * Design:
 *  - Single shared Browser instance (lazy-initialized, reused across the job).
 *  - Each fetch opens a new Page and closes it on completion.
 *  - waitUntil: "networkidle2" ensures deferred JS content is loaded.
 *  - Hard timeout of 45s (3× the axios default).
 *  - Caller should import fetchWithHeadless() and call shutdownHeadlessBrowser()
 *    at end-of-job to release the Chromium process.
 */

import { logger } from "./logger.js";

// ── Lazy browser singleton ───────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let browser: any | null = null;
let browserStarting = false;
const pendingBrowserWaiters: Array<(b: unknown) => void> = [];

async function getBrowser(): Promise<unknown> {
  if (browser) return browser;

  if (browserStarting) {
    return new Promise((resolve) => pendingBrowserWaiters.push(resolve));
  }

  browserStarting = true;
  try {
    // Dynamic import — avoids crashing the server if puppeteer is missing
    const puppeteer = await import("puppeteer");
    browser = await puppeteer.default.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ?? undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-background-networking",
        "--disable-extensions",
        "--disable-sync",
        "--no-first-run",
        "--mute-audio",
      ],
    });
    logger.info({ pid: (browser as { process?: () => { pid: number } }).process?.()?.pid }, "headless-fetcher: Chromium launched");
  } catch (err) {
    browserStarting = false;
    throw err;
  }

  browserStarting = false;
  for (const resolve of pendingBrowserWaiters) resolve(browser);
  pendingBrowserWaiters.length = 0;

  return browser;
}

// ── Exported: shutdown ───────────────────────────────────────────────────────

export async function shutdownHeadlessBrowser(): Promise<void> {
  if (browser) {
    try {
      await (browser as { close(): Promise<void> }).close();
      logger.info("headless-fetcher: Chromium shut down");
    } catch {
      /* already closed */
    }
    browser = null;
    browserStarting = false;
  }
}

// ── Exported: fetch ──────────────────────────────────────────────────────────

export async function fetchWithHeadless(
  url: string,
  timeoutMs = 45000
): Promise<string> {
  const b = await getBrowser();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page = await (b as any).newPage();

  try {
    // Mimic a real Chrome browser
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    });

    // Block images/fonts/stylesheets — we only need HTML
    await page.setRequestInterception(true);
    page.on("request", (req: { resourceType(): string; abort(): void; continue(): void }) => {
      const type = req.resourceType();
      if (["image", "font", "stylesheet", "media"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const response = await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: timeoutMs,
    });

    const status: number = response?.status() ?? 0;
    if (status >= 400) {
      throw new Error(`headless-fetch HTTP ${status}`);
    }

    const html: string = await page.content();
    logger.info({ url, status, htmlLen: html.length }, "headless-fetcher: page fetched");
    return html;
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Exported: availability check ────────────────────────────────────────────

let _headlessAvailable: boolean | null = null;

export async function isHeadlessAvailable(): Promise<boolean> {
  if (_headlessAvailable !== null) return _headlessAvailable;
  try {
    await getBrowser();
    _headlessAvailable = true;
  } catch {
    _headlessAvailable = false;
    logger.warn("headless-fetcher: Puppeteer/Chromium not available — headless fallback disabled");
  }
  return _headlessAvailable;
}
