import type { ConstructedSite, ConstructionInput, ConstructionIssue, SiteFile } from "./types.js";
import { generateCSS } from "./css-generator.js";
import { buildAssetMap } from "./asset-mapper.js";
import { renderPage, getCssRelPath } from "./page-renderer.js";
import { generateSitemap, generateSearchIndex } from "./sitemap-generator.js";
import { buildAudit } from "./audit-builder.js";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// constructSite
//
// Phase C3 — Autonomous Site Construction
// Input:  GenerationReport + PortableManifest
// Output: ConstructedSite (HTML pages, CSS, sitemap, search index, audit)
//
// Pipeline:
//   1. Extract pipeline outputs (SiteAssembly, DesignSystem, AssetGraph)
//   2. Build asset URL map (sourceUrl → resolved URL)
//   3. Generate shared styles.css from DesignSystem tokens
//   4. Render each AssemblyPage to a standalone HTML file
//   5. Generate sitemap.xml
//   6. Generate search-index.json
//   7. Generate construction-audit.json
// ---------------------------------------------------------------------------

export function constructSite(input: ConstructionInput): ConstructedSite {
  const { report, manifest } = input;
  const constructionStart = Date.now();
  const allIssues: ConstructionIssue[] = [];
  const files: SiteFile[] = [];

  // ── Guard: pipeline must have succeeded ──────────────────────────────────
  if (!report.generation) {
    const fallbackAudit = buildAudit({
      report,
      site: {
        id: randomUUID(),
        version: "1.0",
        constructedAt: new Date().toISOString(),
        jobId: report.jobId,
        seedUrl: report.seedUrl,
        files: [],
        sitemap: [],
        searchIndex: [],
      },
      issues: [
        {
          severity: "error",
          code: "PIPELINE_FAILED",
          message: `Generation pipeline did not produce output: ${report.pipeline.error ?? "unknown error"}`,
        },
      ],
      constructionDurationMs: Date.now() - constructionStart,
    });

    return {
      id: randomUUID(),
      version: "1.0",
      constructedAt: new Date().toISOString(),
      jobId: report.jobId,
      seedUrl: report.seedUrl,
      files: [],
      sitemap: [],
      searchIndex: [],
      audit: fallbackAudit,
    };
  }

  const { siteAssembly, designSystem } = report.generation;

  // Build node lookup map: id → node
  const nodeMap = new Map(manifest.nodes.map((n) => [n.id, n]));

  // Build asset URL map
  const assetGraph = (designSystem as unknown as { assetGraph?: import("@workspace/site-intelligence").AssetGraph })
    .assetGraph;
  const assetMap = assetGraph ? buildAssetMap(assetGraph) : new Map<string, string>();

  // ── Step 1: Generate CSS ─────────────────────────────────────────────────
  const cssContent = generateCSS(designSystem);
  files.push({
    path: "styles.css",
    content: cssContent,
    encoding: "utf-8",
    sizeBytes: Buffer.byteLength(cssContent, "utf8"),
    fileType: "css",
    pageId: null,
  });

  // ── Step 2: Render pages ─────────────────────────────────────────────────
  // Extract site title from manifest seed URL
  const siteTitle = extractSiteTitle(report.seedUrl);

  const allPages = [
    ...siteAssembly.landingPages,
    ...siteAssembly.articlePages,
    ...siteAssembly.categoryPages,
    // Include any pages not already in the above lists
    ...siteAssembly.pages.filter(
      (p) =>
        !siteAssembly.landingPages.some((lp) => lp.id === p.id) &&
        !siteAssembly.articlePages.some((ap) => ap.id === p.id) &&
        !siteAssembly.categoryPages.some((cp) => cp.id === p.id)
    ),
  ];

  // De-duplicate by id
  const seen = new Set<string>();
  const uniquePages = allPages.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  for (const page of uniquePages) {
    try {
      const node = page.sourceNodeId ? (nodeMap.get(page.sourceNodeId) ?? null) : null;
      const cssRelPath = getCssRelPath(page.route);

      const result = renderPage({
        page,
        node,
        nav: siteAssembly.navigation,
        designSystem,
        assetGraph: assetGraph ?? { assets: [], assetIndex: {}, orphanAssets: [], duplicateGroups: [], missingAssets: [], totalAssets: 0, totalBytes: 0, assetsByType: { image: 0, video: 0, embed: 0, document: 0, unknown: 0 }, bindingReport: { totalBindings: 0, resolvedBindings: 0, unresolvedBindings: 0, unreferencedNodes: [] } },
        assetMap,
        siteTitle,
        cssRelPath,
      });

      files.push(result.file);
      allIssues.push(...result.issues);
    } catch (err) {
      allIssues.push({
        severity: "error",
        code: "PAGE_RENDER_FAILED",
        message: `Failed to render page "${page.route}": ${err instanceof Error ? err.message : String(err)}`,
        pageId: page.id,
        route: page.route,
      });
    }
  }

  // ── Step 3: Sitemap ──────────────────────────────────────────────────────
  const { entries: sitemapEntries, file: sitemapFile } = generateSitemap(
    uniquePages,
    report.seedUrl
  );
  files.push(sitemapFile);

  // ── Step 4: Search index ─────────────────────────────────────────────────
  const { index: searchIndex, file: searchFile } = generateSearchIndex(uniquePages, manifest);
  files.push(searchFile);

  // ── Step 5: Audit ────────────────────────────────────────────────────────
  const constructionDurationMs = Date.now() - constructionStart;

  const partialSite = {
    id: randomUUID(),
    version: "1.0" as const,
    constructedAt: new Date().toISOString(),
    jobId: report.jobId,
    seedUrl: report.seedUrl,
    files,
    sitemap: sitemapEntries,
    searchIndex,
  };

  const audit = buildAudit({
    report,
    site: partialSite,
    issues: allIssues,
    constructionDurationMs,
  });

  // Add audit file
  const auditJson = JSON.stringify(audit, null, 2);
  files.push({
    path: "construction-audit.json",
    content: auditJson,
    encoding: "utf-8",
    sizeBytes: Buffer.byteLength(auditJson, "utf8"),
    fileType: "json",
    pageId: null,
  });

  return {
    ...partialSite,
    audit,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSiteTitle(seedUrl: string): string {
  try {
    const { hostname } = new URL(seedUrl);
    return hostname
      .replace(/^www\./, "")
      .split(".")
      .slice(0, -1)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(" ");
  } catch {
    return "Site";
  }
}
