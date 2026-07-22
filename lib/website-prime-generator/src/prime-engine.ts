/**
 * prime-engine.ts — Phase 5.1
 *
 * Orchestrates all Website Prime generators into a single WebsitePrimeOutput.
 *
 * Call:
 *   generateWebsitePrime({ jobId, seedUrl, stencilId, report, navigationReport, placementReport, blueprint })
 *     → WebsitePrimeOutput
 *
 * Returns PrimeFile[] (paths + content as strings).
 * The API server is responsible for zipping + uploading to R2.
 *
 * Non-fatal per section: each generator is wrapped in try/catch.
 * A failed section logs a warning and contributes zero files.
 */

import type { GenerationReport } from "@workspace/generation-pipeline";
import type { NavigationReport } from "@workspace/navigation-intelligence";
import type { PlacementReport } from "@workspace/content-placement";
import type { StencilBlueprint } from "@workspace/stencil-library";
import { generateThemeFiles } from "./theme-generator.js";
import { generateProjectScaffold } from "./project-scaffolder.js";
import { generateComponents } from "./component-generator.js";
import { generatePages } from "./page-generator.js";
import { generateRouter } from "./router-generator.js";
import type {
  PrimeFile,
  WebsitePrimeManifest,
  WebsitePrimeOutput,
  WebsitePrimeStats,
  PrimeRouteEntry,
  PrimeComponentEntry,
} from "./types.js";

// ── Input ─────────────────────────────────────────────────────────────────────

export interface GenerateWebsitePrimeInput {
  jobId: string;
  seedUrl: string;
  stencilId: string;
  report: GenerationReport;
  navigationReport: NavigationReport;
  placementReport: PlacementReport;
  blueprint: StencilBlueprint;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safe<T>(fn: () => T, fallback: T, label: string): T {
  try {
    return fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[website-prime-generator] ${label} failed: ${msg}`);
    return fallback;
  }
}

function countLines(files: PrimeFile[]): number {
  return files.reduce((n, f) => n + f.content.split("\n").length, 0);
}

function inferSiteName(seedUrl: string): string {
  try {
    const hostname = new URL(seedUrl).hostname.replace(/^www\./, "");
    return hostname.split(".")[0].charAt(0).toUpperCase() + hostname.split(".")[0].slice(1);
  } catch {
    return "Website Prime";
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function generateWebsitePrime(input: GenerateWebsitePrimeInput): WebsitePrimeOutput {
  const { jobId, seedUrl, stencilId, report, navigationReport, placementReport, blueprint } = input;

  const generation = report.generation;
  if (!generation) {
    throw new Error("GenerationReport.generation is null — cannot produce Website Prime without pipeline output");
  }

  const { siteAssembly, designSystem } = generation;
  const tokens = designSystem.tokens;
  const hasSidebar = navigationReport.blueprint.sidebar.isEnabled;
  const primaryColor = tokens.colors.primary[600] ?? "#2563eb";
  const siteName = inferSiteName(seedUrl);

  const allFiles: PrimeFile[] = [];

  // ── 1. Project scaffold ──────────────────────────────────────────────────
  const scaffoldFiles = safe(
    () => generateProjectScaffold({ siteName, seedUrl, stencilId, jobId, hasSidebar, primaryColor }),
    [],
    "project-scaffold",
  );
  allFiles.push(...scaffoldFiles);

  // ── 2. Theme (CSS tokens + global) ───────────────────────────────────────
  const themeFiles = safe(
    () => generateThemeFiles(tokens),
    [],
    "theme-generator",
  );
  allFiles.push(...themeFiles);

  // ── 3. Components ────────────────────────────────────────────────────────
  const componentFiles = safe(
    () => generateComponents(navigationReport, blueprint),
    [],
    "component-generator",
  );
  allFiles.push(...componentFiles);

  // ── 4. Pages ─────────────────────────────────────────────────────────────
  const { files: pageFiles, pageTypes } = safe(
    () => generatePages(siteAssembly, blueprint),
    { files: [], pageTypes: [] },
    "page-generator",
  );
  allFiles.push(...pageFiles);

  // ── 5. Router ────────────────────────────────────────────────────────────
  const { file: routerFile, routes } = safe(
    () => generateRouter(siteAssembly),
    {
      file: { path: "src/router.tsx", content: "export const routes: any[] = [];", kind: "tsx" as const },
      routes: [] as PrimeRouteEntry[],
    },
    "router-generator",
  );
  allFiles.push(routerFile);

  // ── Build manifest ───────────────────────────────────────────────────────
  const componentEntries: PrimeComponentEntry[] = componentFiles.map((f) => ({
    name: f.path.split("/").pop()!.replace(".tsx", ""),
    file: f.path,
    description: "",
  }));

  const manifest: WebsitePrimeManifest = {
    version: "1.0",
    jobId,
    seedUrl,
    stencilId,
    generatedAt: new Date().toISOString(),
    files: allFiles.map((f) => f.path),
    routes,
    components: componentEntries,
    pages: pageFiles.map((f) => f.path),
    themeFiles: themeFiles.map((f) => f.path),
    framework: "react+vite",
    reactVersion: "18",
    routerVersion: "6",
  };

  // ── Stats ─────────────────────────────────────────────────────────────────
  const cssVarCount = themeFiles.reduce(
    (n, f) => n + (f.content.match(/--[a-z]/g)?.length ?? 0),
    0,
  );

  const stats: WebsitePrimeStats = {
    totalFiles: allFiles.length,
    componentCount: componentFiles.length,
    pageCount: pageFiles.length,
    routeCount: routes.length,
    themeTokenCount: cssVarCount,
    cssVariableCount: cssVarCount,
    totalLinesOfCode: countLines(allFiles),
  };

  return { files: allFiles, manifest, stats };
}
