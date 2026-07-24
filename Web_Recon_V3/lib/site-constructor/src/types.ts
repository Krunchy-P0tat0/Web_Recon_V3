import type { GenerationReport } from "@workspace/generation-pipeline";
import type { PortableManifest } from "@workspace/site-intelligence";

export type SiteFileEncoding = "utf-8" | "binary";
export type SiteFileType = "html" | "css" | "json" | "xml" | "js";

export interface SiteFile {
  path: string;
  content: string;
  encoding: SiteFileEncoding;
  sizeBytes: number;
  fileType: SiteFileType;
  pageId: string | null;
}

export interface SitemapEntry {
  route: string;
  url: string;
  priority: number;
  changeFreq: string;
  lastMod: string;
}

export interface SearchIndexEntry {
  id: string;
  title: string;
  url: string;
  route: string;
  excerpt: string;
  contentType: string | null;
  publishedAt: string | null;
  wordCount: number;
  tags: string[];
}

export type ConstructionIssueSeverity = "error" | "warning" | "info";

export interface ConstructionIssue {
  severity: ConstructionIssueSeverity;
  code: string;
  message: string;
  pageId?: string;
  assetId?: string;
  route?: string;
}

export interface ConstructionAuditFiles {
  total: number;
  htmlFiles: number;
  cssFiles: number;
  jsonFiles: number;
  xmlFiles: number;
  totalBytes: number;
}

export interface ConstructionAuditPages {
  total: number;
  rendered: number;
  failed: number;
  skipped: number;
  byLayout: Record<string, number>;
  byPageType: Record<string, number>;
}

export interface ConstructionAuditAssets {
  total: number;
  resolved: number;
  unresolved: number;
  missing: number;
}

export interface ConstructionAuditNavigation {
  primaryItems: number;
  maxDepth: number;
  breadcrumbsEnabled: boolean;
  footerGroups: number;
}

export interface ConstructionAuditDesign {
  siteType: string;
  designStrategy: string;
  layoutStrategy: string;
  headingFont: string;
  bodyFont: string;
  primaryColor: string;
}

export interface ConstructionAuditPipelineStage {
  name: string;
  status: "success" | "failed" | "skipped";
  durationMs: number;
  error?: string;
}

export interface ConstructionAudit {
  version: "1.0";
  constructedAt: string;
  manifestId: string;
  jobId: string;
  seedUrl: string;
  stencilId: string;
  stencilDisplayName: string;
  pipeline: {
    stages: ConstructionAuditPipelineStage[];
    durationMs: number;
    status: "success" | "partial" | "failed";
  };
  construction: {
    durationMs: number;
    status: "success" | "partial" | "failed";
  };
  pages: ConstructionAuditPages;
  assets: ConstructionAuditAssets;
  navigation: ConstructionAuditNavigation;
  routes: { static: number; dynamic: number; total: number };
  design: ConstructionAuditDesign;
  files: ConstructionAuditFiles;
  issues: ConstructionIssue[];
  isComplete: boolean;
  completenessScore: number;
  summary: string;
}

export interface ConstructedSite {
  id: string;
  version: "1.0";
  constructedAt: string;
  jobId: string;
  seedUrl: string;
  files: SiteFile[];
  sitemap: SitemapEntry[];
  searchIndex: SearchIndexEntry[];
  audit: ConstructionAudit;
}

export interface ConstructionInput {
  report: GenerationReport;
  manifest: PortableManifest;
}
