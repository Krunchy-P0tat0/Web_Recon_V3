/**
 * renderer.ts — Renderer layer
 *
 * Responsibilities:
 *   - Generate HTML content for the ZIP archive from a completed or partial Manifest.
 *   - Write manifest.output to record what was produced (sole writer of that field).
 *
 * Hard invariants enforced by this module's isolation:
 *   - NEVER writes node.status, node.content, node.media, or node.relationships.
 *   - NEVER issues network requests.
 *   - NEVER re-parses HTML — uses node.content.cleanHtml directly as supplied.
 *   - NEVER recomputes storage paths — reads node.storage.localPath only.
 *   - Content-generation functions are pure: same inputs → same HTML output.
 *
 * The archive stream lifecycle (open / append / finalize) stays in scraper.ts
 * because it must span Phases 1–3. The Renderer generates content strings;
 * the Producer appends them to the open archive.
 */

import {
  getOrderedNodes,
  isManifestReady,
  type Manifest,
  type ManifestOutput,
} from "./manifest";
import type { ArticleLink } from "./scraper";

// ---------------------------------------------------------------------------
// HTML primitives
// ---------------------------------------------------------------------------

/** Escapes a string for safe insertion into HTML attribute values or text. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Formats an ISO-8601 date string into a human-readable date. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Article HTML renderer
// ---------------------------------------------------------------------------

/**
 * Wraps a scraped body fragment in a standalone article HTML document.
 *
 * Called by the Producer (scraper.ts) during Phase 1 so it can append the
 * document to the archive. The Producer provides the raw body fragment and
 * article metadata; this function owns ALL presentation decisions (CSS,
 * viewport meta, breadcrumb navigation, dateline, source footer).
 *
 * @param relRoot - relative path prefix to navigate back to the archive root
 *   (e.g. "../../../" for a node at content/page-001/slug/index.html).
 *   Computed by deriveRelativeRoot() in scraper.ts; never hardcoded here.
 *
 * Pure function — no side effects.
 */
export function buildArticleHtml(
  title: string,
  bodyHtml: string,
  article: ArticleLink,
  pageKey: string,
  relRoot: string = "../../"
): string {
  const breadcrumb = escapeHtml(
    article.pageLabel ?? pageKey.replace(/^page-0*/, "Page ")
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    body{font-family:Georgia,serif;max-width:860px;margin:2rem auto;padding:0 1.5rem;line-height:1.8;color:#222}
    img{max-width:100%;height:auto;border-radius:4px;margin:1rem 0}
    h1,h2,h3{line-height:1.3}a{color:#1a6aba}p{margin:1em 0}
    .breadcrumb{font-size:.85rem;color:#888;margin-bottom:2rem}
    .dateline{font-size:.9rem;color:#888;margin-bottom:1.5rem;font-style:italic}
    .source{font-size:.85rem;color:#888;margin-top:3rem;border-top:1px solid #eee;padding-top:1rem}
  </style>
</head>
<body>
<p class="breadcrumb"><a href="${relRoot}index.html">← All Articles</a> / ${breadcrumb}</p>
${article.publishedAt ? `<p class="dateline">Published ${fmtDate(article.publishedAt)}</p>` : ""}
${bodyHtml}
<p class="source">Source: <a href="${article.url}">${article.url}</a></p>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Index HTML renderer — Phase 3 entry point
// ---------------------------------------------------------------------------

export interface IndexRenderResult {
  /** Root index.html content, ready to append to the ZIP archive. */
  html: string;
  renderSource: "manifest" | "legacy" | "fallback";
  nodeCount: number;
  pathConsistencyCheck: boolean;
}

/**
 * Renders the root index.html for the ZIP archive.
 *
 * Strategy:
 *   - If the manifest is sufficiently populated (≥50% of expected articles
 *     scraped successfully), build a rich grouped index from node metadata.
 *   - Otherwise fall back to a flat link list from the original ArticleLink
 *     array so the archive is always usable even if scraping mostly failed.
 *
 * CONTRACT — read-only access to manifest:
 *   - NEVER mutates node.status, node.content, node.media, node.relationships.
 *   - NEVER mutates manifest.nodes, manifest.seenUrls, or manifest.stats.
 *   - Caller is responsible for writing manifest.output via writeManifestOutput().
 */
export function renderIndexHtml(
  manifest: Manifest,
  expectedCount: number,
  fallbackArticles: ArticleLink[]
): IndexRenderResult {
  const orderedNodes = getOrderedNodes(manifest).filter(
    (n) => n.nodeType !== "root"
  );

  const pathConsistencyCheck = orderedNodes.every(
    (n) => n.storage.localPath.length > 0
  );

  if (isManifestReady(manifest, expectedCount)) {
    const pageGroups = new Map<string | number, typeof orderedNodes>();
    for (const node of orderedNodes) {
      const key = node.relationships.paginationIndex ?? "articles";
      if (!pageGroups.has(key)) pageGroups.set(key, []);
      pageGroups.get(key)!.push(node);
    }

    const sortedGroupKeys = Array.from(pageGroups.keys()).sort((a, b) => {
      if (a === "articles" && b !== "articles") return 1;
      if (b === "articles" && a !== "articles") return -1;
      return Number(a) - Number(b);
    });

    const bodyRows = sortedGroupKeys
      .map((key) => {
        const groupNodes = pageGroups.get(key)!;
        const label = key === "articles" ? "Articles" : `Page ${key}`;
        const rows = groupNodes
          .map((node) => {
            const date = fmtDate(node.metadata.publishedAt);
            const href = node.storage.localPath;
            const dateSpan = date
              ? `<span style="color:#888;font-weight:normal;font-size:.9em"> — ${date}</span>`
              : "";
            return `<li><a href="${href}">${escapeHtml(node.metadata.title)}</a>${dateSpan}</li>`;
          })
          .join("\n");
        return `<section>\n<h2>${label} <span style="font-weight:normal;color:#888">(${groupNodes.length} articles)</span></h2>\n<ul>${rows}</ul>\n</section>`;
      })
      .join("\n");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Scraped Articles — ${orderedNodes.length} total</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1.5rem;line-height:1.7;color:#222}
    h1{font-size:1.6rem;border-bottom:2px solid #eee;padding-bottom:.5rem}
    h2{font-size:1rem;color:#444;margin-top:2rem;text-transform:uppercase;letter-spacing:.05em}
    ul{margin:.5rem 0;padding-left:1.5rem}li{margin:.3rem 0}a{color:#1a6aba}
  </style>
</head>
<body>
<h1>Scraped Articles — ${orderedNodes.length} total</h1>
${bodyRows}
</body></html>`;

    return {
      html,
      renderSource: "manifest",
      nodeCount: orderedNodes.length,
      pathConsistencyCheck,
    };
  }

  // Fallback: flat list from original ArticleLink array.
  // Used when the manifest is not sufficiently populated.
  const legacyRows = fallbackArticles
    .map((a) => `<li><a href="${a.url}">${escapeHtml(a.title)}</a></li>`)
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Scraped Articles — ${fallbackArticles.length} total</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1.5rem;line-height:1.7;color:#222}
    h1{font-size:1.6rem;border-bottom:2px solid #eee;padding-bottom:.5rem}
    h2{font-size:1rem;color:#444;margin-top:2rem;text-transform:uppercase;letter-spacing:.05em}
    ul{margin:.5rem 0;padding-left:1.5rem}li{margin:.3rem 0}a{color:#1a6aba}
  </style>
</head>
<body>
<h1>Scraped Articles — ${fallbackArticles.length} total</h1>
<ul>${legacyRows}</ul>
</body></html>`;

  return {
    html,
    renderSource: "fallback",
    nodeCount: orderedNodes.length,
    pathConsistencyCheck,
  };
}

// ---------------------------------------------------------------------------
// manifest.output writer — Single Write Rule enforcement
// ---------------------------------------------------------------------------

/**
 * Seals the rendering phase by recording what was produced in manifest.output.
 *
 * This is the ONLY function in the entire system that writes manifest.output.
 * It is called exactly once per job, after the ZIP archive has been finalized,
 * by the code that executes Phase 3 (currently scraper.ts runScrapeJob).
 *
 * Why here and not in scraper.ts?
 *   The archive lifecycle (stream open/append/finalize) must live in the
 *   Producer because it spans Phases 1–3. But the DECISION of what constitutes
 *   "rendered output" belongs to the Renderer. Keeping this function here
 *   makes that ownership explicit and grep-able: `manifest.output =` must
 *   never appear in scraper.ts or job-worker.ts.
 */
export function writeManifestOutput(
  manifest: Manifest,
  output: ManifestOutput
): void {
  manifest.output = output;
  manifest.updatedAt = new Date().toISOString();
}
