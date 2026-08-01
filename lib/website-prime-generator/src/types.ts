/**
 * Phase 5.1 — Website Prime Generator
 *
 * A PrimeFile is a single generated file (path + content as a string).
 * The engine returns PrimeFile[] which the API server zips and uploads to R2.
 */

export interface PrimeFile {
  /** Path relative to the project root (e.g. "src/components/Navigation.tsx") */
  path: string;
  content: string;
  /** File type hint for the bundler */
  kind: "tsx" | "ts" | "css" | "html" | "json" | "config";
}

// ── Manifest ──────────────────────────────────────────────────────────────────

export interface PrimeRouteEntry {
  path: string;
  pageType: string;
  isDynamic: boolean;
  componentFile: string;
}

export interface PrimeComponentEntry {
  name: string;
  file: string;
  description: string;
}

export interface WebsitePrimeManifest {
  version: "1.0";
  jobId: string;
  seedUrl: string;
  stencilId: string;
  generatedAt: string;
  /** All generated file paths */
  files: string[];
  routes: PrimeRouteEntry[];
  components: PrimeComponentEntry[];
  pages: string[];
  themeFiles: string[];
  framework: "react+vite";
  reactVersion: "18";
  routerVersion: "6";
}

// ── Stats & Report ────────────────────────────────────────────────────────────

export interface WebsitePrimeStats {
  totalFiles: number;
  componentCount: number;
  pageCount: number;
  routeCount: number;
  themeTokenCount: number;
  cssVariableCount: number;
  totalLinesOfCode: number;
}

export interface WebsitePrimeOutput {
  files: PrimeFile[];
  manifest: WebsitePrimeManifest;
  stats: WebsitePrimeStats;
}

export interface WebsitePrimeReport {
  jobId: string;
  seedUrl: string;
  stencilId: string;
  generatedAt: string;
  manifest: WebsitePrimeManifest;
  stats: WebsitePrimeStats;
  r2Key: string;
  manifestR2Key: string;
}
