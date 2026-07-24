import type { GenerationReport } from "@workspace/generation-pipeline";
import type { ConstructedSite, ConstructionAudit, ConstructionIssue, SiteFile } from "./types.js";

// ---------------------------------------------------------------------------
// buildAudit
// Computes the construction-audit.json from the constructed site data.
// ---------------------------------------------------------------------------

export interface AuditInput {
  report: GenerationReport;
  site: Omit<ConstructedSite, "audit">;
  issues: ConstructionIssue[];
  constructionDurationMs: number;
}

export function buildAudit(input: AuditInput): ConstructionAudit {
  const { report, site, issues, constructionDurationMs } = input;

  const gen = report.generation;
  const stencilId = report.stencilSelection?.selectedStencilId ?? "unknown";
  const stencilDisplayName = report.stencilSelection?.selectedStencilName ?? stencilId;

  // Pipeline stages
  const pipelineStages = report.pipeline.stages.map((s) => ({
    name: s.name,
    status: s.status,
    durationMs: s.durationMs,
    error: s.error,
  }));
  const pipelineStatus =
    report.pipeline.status === "success"
      ? ("success" as const)
      : pipelineStages.some((s) => s.status === "failed")
        ? ("failed" as const)
        : ("partial" as const);

  // File stats
  const fileStats = computeFileStats(site.files);

  // Page stats
  const allPages = gen?.siteAssembly.pages ?? [];
  const htmlFiles = site.files.filter((f) => f.fileType === "html");
  const renderedPageIds = new Set(htmlFiles.map((f) => f.pageId).filter(Boolean));
  const pagesByLayout: Record<string, number> = {};
  const pagesByType: Record<string, number> = {};
  for (const p of allPages) {
    pagesByLayout[p.layout] = (pagesByLayout[p.layout] ?? 0) + 1;
    pagesByType[p.pageType] = (pagesByType[p.pageType] ?? 0) + 1;
  }

  const failedPages = issues.filter(
    (i) => i.severity === "error" && i.pageId
  ).length;

  // Asset stats
  const assetGraph = gen?.siteAssembly ? null : null; // assetGraph is on siteGraph, not assembly
  const totalAssets = report.classification?.stats.totalAssets ?? 0;
  const resolvedAssets = totalAssets - (report.classification?.stats.missingAssetCount ?? 0);

  // Navigation stats
  const navPrimary = gen?.siteAssembly.navigation.primaryNav.length ?? 0;
  const navMaxDepth = 2;
  const footerGroups = gen?.siteAssembly.navigation.footerGroups.length ?? 0;

  // Routes
  const routeMap = gen?.siteAssembly.routes;
  const staticRoutes = routeMap?.static.length ?? 0;
  const dynamicRoutes = routeMap?.dynamic.length ?? 0;

  // Design
  const ds = gen?.designSystem;
  const designAudit = {
    siteType: ds?.classification.primary ?? "unknown",
    designStrategy: ds?.classification.designStrategy ?? "unknown",
    layoutStrategy: ds?.classification.layoutStrategy ?? "unknown",
    headingFont: ds?.typography.headingFont.family ?? "unknown",
    bodyFont: ds?.typography.bodyFont.family ?? "unknown",
    primaryColor: ds?.tokens.colors.primary[500] ?? "#000000",
  };

  // Construction status
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const constructionStatus: "success" | "partial" | "failed" =
    errorCount === 0
      ? "success"
      : failedPages > allPages.length * 0.5
        ? "failed"
        : "partial";

  // Completeness score (0-100)
  const completenessScore = computeCompletenessScore({
    totalPages: allPages.length,
    renderedPages: renderedPageIds.size,
    totalAssets,
    resolvedAssets,
    errorCount,
    hasSitemap: site.files.some((f) => f.path === "sitemap.xml"),
    hasSearchIndex: site.files.some((f) => f.path === "search-index.json"),
    hasStyles: site.files.some((f) => f.path === "styles.css"),
  });

  const summary = buildSummary({
    completenessScore,
    renderedPages: renderedPageIds.size,
    totalPages: allPages.length,
    stencilDisplayName,
    siteType: designAudit.siteType,
    issueCount: issues.length,
    errorCount,
  });

  return {
    version: "1.0",
    constructedAt: new Date().toISOString(),
    manifestId: report.jobId,
    jobId: report.jobId,
    seedUrl: report.seedUrl,
    stencilId,
    stencilDisplayName,
    pipeline: {
      stages: pipelineStages,
      durationMs: report.durationMs,
      status: pipelineStatus,
    },
    construction: {
      durationMs: constructionDurationMs,
      status: constructionStatus,
    },
    pages: {
      total: allPages.length,
      rendered: renderedPageIds.size,
      failed: failedPages,
      skipped: allPages.length - renderedPageIds.size - failedPages,
      byLayout: pagesByLayout,
      byPageType: pagesByType,
    },
    assets: {
      total: totalAssets,
      resolved: resolvedAssets,
      unresolved: totalAssets - resolvedAssets,
      missing: report.classification?.stats.missingAssetCount ?? 0,
    },
    navigation: {
      primaryItems: navPrimary,
      maxDepth: navMaxDepth,
      breadcrumbsEnabled: gen?.siteAssembly.navigation.breadcrumbs.enabled ?? false,
      footerGroups,
    },
    routes: {
      static: staticRoutes,
      dynamic: dynamicRoutes,
      total: staticRoutes + dynamicRoutes,
    },
    design: designAudit,
    files: fileStats,
    issues,
    isComplete: completenessScore >= 80,
    completenessScore,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function computeFileStats(files: SiteFile[]) {
  const html = files.filter((f) => f.fileType === "html").length;
  const css = files.filter((f) => f.fileType === "css").length;
  const json = files.filter((f) => f.fileType === "json").length;
  const xml = files.filter((f) => f.fileType === "xml").length;
  const totalBytes = files.reduce((acc, f) => acc + f.sizeBytes, 0);
  return { total: files.length, htmlFiles: html, cssFiles: css, jsonFiles: json, xmlFiles: xml, totalBytes };
}

interface ScoreInput {
  totalPages: number;
  renderedPages: number;
  totalAssets: number;
  resolvedAssets: number;
  errorCount: number;
  hasSitemap: boolean;
  hasSearchIndex: boolean;
  hasStyles: boolean;
}

function computeCompletenessScore(s: ScoreInput): number {
  if (s.totalPages === 0) return 0;

  let score = 0;
  score += (s.renderedPages / s.totalPages) * 50; // up to 50 pts: pages rendered
  score += s.hasStyles ? 15 : 0;
  score += s.hasSitemap ? 10 : 0;
  score += s.hasSearchIndex ? 10 : 0;
  if (s.totalAssets > 0) {
    score += (s.resolvedAssets / s.totalAssets) * 10; // up to 10 pts: assets resolved
  } else {
    score += 10;
  }
  score -= Math.min(s.errorCount * 2, 20); // deduct for errors, capped at -20

  return Math.max(0, Math.min(100, Math.round(score)));
}

function buildSummary(opts: {
  completenessScore: number;
  renderedPages: number;
  totalPages: number;
  stencilDisplayName: string;
  siteType: string;
  issueCount: number;
  errorCount: number;
}): string {
  const { completenessScore, renderedPages, totalPages, stencilDisplayName, siteType, issueCount, errorCount } = opts;
  const grade = completenessScore >= 90 ? "complete" : completenessScore >= 70 ? "mostly complete" : completenessScore >= 40 ? "partially complete" : "incomplete";
  const issueNote = issueCount > 0 ? ` ${issueCount} issue${issueCount > 1 ? "s" : ""} (${errorCount} error${errorCount !== 1 ? "s" : ""}) recorded.` : "";
  return `Site construction ${grade} (${completenessScore}%): ${renderedPages}/${totalPages} pages rendered using the ${stencilDisplayName} stencil for a ${siteType} site.${issueNote}`;
}
