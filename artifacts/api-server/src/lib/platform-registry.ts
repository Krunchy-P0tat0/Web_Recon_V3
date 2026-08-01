/**
 * platform-registry.ts — Backend Exposure Layer
 *
 * Single source of truth for every subsystem in the Website Intelligence Platform.
 * Scanned and catalogued from:
 *   - artifacts/api-server/src/routes/   (Express routes)
 *   - artifacts/api-server/src/lib/      (engines, workers, services)
 *   - artifacts/api-server/src/index.ts  (startup loop — workers/schedulers)
 *   - lib/db/src/schema/                 (database models)
 *   - event-bus.ts PipelineEventType     (event catalogue)
 *
 * Frontend dashboards must consume these registries instead of hardcoding features.
 * Nothing is hidden simply because nobody wired a button.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type FeatureCategory =
  | "orchestration"
  | "scraping"
  | "intelligence"
  | "generation"
  | "merge"
  | "deployment"
  | "recovery"
  | "monitoring"
  | "storage"
  | "compatibility"
  | "visual"
  | "certification"
  | "platform";

export type FeatureStatus = "active" | "background" | "on-demand" | "deprecated";

export type WidgetType =
  | "status-badge"
  | "progress-bar"
  | "timeline"
  | "log-stream"
  | "sse-stream"
  | "metric-card"
  | "table"
  | "control-panel"
  | "chart"
  | "diff-view"
  | "none";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface FeatureEntry {
  /** Unique machine-readable identifier */
  id: string;
  /** Human-readable name */
  featureName: string;
  /** Logical grouping */
  category: FeatureCategory;
  /** What this feature does */
  description: string;
  /** Primary HTTP route (if exposed over REST) */
  route?: string;
  /** HTTP method for the primary route */
  method?: HttpMethod;
  /** Access permissions required */
  permissions: string[];
  /** Emits real-time updates via SSE or WebSocket */
  supportsLiveUpdates: boolean;
  /** Accepts commands / control actions */
  supportsControls: boolean;
  /** Recommended dashboard widget type */
  dashboardWidgetType: WidgetType;
  /** Current operational status */
  status: FeatureStatus;
  /** Feature IDs this depends on */
  dependencies: string[];
  /** Source file(s) implementing this feature */
  sourceFiles: string[];
}

export interface RouteEntry {
  method: HttpMethod;
  path: string;
  featureId: string;
  description: string;
  supportsSSE: boolean;
  requestBody?: string;
  responseShape?: string;
}

export interface WorkerEntry {
  id: string;
  workerName: string;
  description: string;
  intervalSeconds?: number;
  warmupMs?: number;
  triggerMode: "interval" | "event" | "polling" | "on-demand";
  status: FeatureStatus;
  sourceFile: string;
  exportedFunction: string;
  generates: string[];
}

export interface ServiceEntry {
  id: string;
  serviceName: string;
  category: FeatureCategory;
  description: string;
  singleton: boolean;
  status: FeatureStatus;
  sourceFile: string;
  exposedVia: string[];
  dependencies: string[];
}

export interface EventEntry {
  type: string;
  description: string;
  category: FeatureCategory;
  producedBy: string[];
  consumedBy: string[];
  payloadShape: string;
  supportsFiltering: boolean;
}

export interface DatabaseModelEntry {
  tableName: string;
  description: string;
  primaryKey: string;
  keyColumns: string[];
  featureIds: string[];
  sourceFile: string;
}

export interface WidgetEntry {
  id: string;
  widgetType: WidgetType;
  title: string;
  description: string;
  featureId: string;
  dataSource: string;
  refreshMode: "poll" | "sse" | "static";
  refreshIntervalMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature Registry
// ─────────────────────────────────────────────────────────────────────────────

export const FEATURE_REGISTRY: FeatureEntry[] = [

  // ── Platform ─────────────────────────────────────────────────────────────

  {
    id: "health-check",
    featureName: "Health Check",
    category: "platform",
    description: "Liveness probe confirming the API server is up and the Zod schema is loaded.",
    route: "/api/healthz",
    method: "GET",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "status-badge",
    status: "active",
    dependencies: [],
    sourceFiles: ["artifacts/api-server/src/routes/health.ts"],
  },
  {
    id: "platform-features",
    featureName: "Platform Feature Registry",
    category: "platform",
    description: "Exposes the complete Feature Registry so frontends can discover all platform capabilities dynamically.",
    route: "/api/platform/features",
    method: "GET",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "table",
    status: "active",
    dependencies: [],
    sourceFiles: ["artifacts/api-server/src/lib/platform-registry.ts", "artifacts/api-server/src/routes/platform.ts"],
  },
  {
    id: "platform-routes",
    featureName: "Platform Route Catalogue",
    category: "platform",
    description: "Lists every HTTP route registered in the API server with method, path, and metadata.",
    route: "/api/platform/routes",
    method: "GET",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "table",
    status: "active",
    dependencies: [],
    sourceFiles: ["artifacts/api-server/src/lib/platform-registry.ts"],
  },
  {
    id: "platform-workers",
    featureName: "Platform Worker Catalogue",
    category: "platform",
    description: "Lists every background worker and scheduler running in the process, with intervals and trigger modes.",
    route: "/api/platform/workers",
    method: "GET",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "table",
    status: "active",
    dependencies: [],
    sourceFiles: ["artifacts/api-server/src/lib/platform-registry.ts"],
  },
  {
    id: "platform-services",
    featureName: "Platform Service Catalogue",
    category: "platform",
    description: "Lists every internal service and engine, singleton status, and what it depends on.",
    route: "/api/platform/services",
    method: "GET",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "table",
    status: "active",
    dependencies: [],
    sourceFiles: ["artifacts/api-server/src/lib/platform-registry.ts"],
  },
  {
    id: "platform-events",
    featureName: "Platform Event Catalogue",
    category: "platform",
    description: "Lists every event type emitted by the Pipeline Event Bus with producer/consumer metadata.",
    route: "/api/platform/events",
    method: "GET",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "table",
    status: "active",
    dependencies: ["event-bus"],
    sourceFiles: ["artifacts/api-server/src/lib/platform-registry.ts"],
  },
  {
    id: "platform-widgets",
    featureName: "Platform Widget Catalogue",
    category: "platform",
    description: "Lists every recommended dashboard widget with data source and refresh strategy — the frontend build list.",
    route: "/api/platform/widgets",
    method: "GET",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "table",
    status: "active",
    dependencies: [],
    sourceFiles: ["artifacts/api-server/src/lib/platform-registry.ts"],
  },

  // ── Orchestration ─────────────────────────────────────────────────────────

  {
    id: "pipeline-orchestrator",
    featureName: "Pipeline Orchestrator",
    category: "orchestration",
    description: "Master controller that accepts a target URL, creates a job, and drives the full crawl → analyze → generate → merge → deploy pipeline.",
    route: "/api/orchestrate",
    method: "POST",
    permissions: [],
    supportsLiveUpdates: true,
    supportsControls: true,
    dashboardWidgetType: "control-panel",
    status: "active",
    dependencies: ["job-worker", "event-bus", "crawl-frontier", "scraper"],
    sourceFiles: [
      "artifacts/api-server/src/lib/master-orchestrator.ts",
      "artifacts/api-server/src/routes/orchestrate.ts",
    ],
  },
  {
    id: "job-list",
    featureName: "Job List",
    category: "orchestration",
    description: "Returns all in-memory pipeline jobs with current status and stage metadata.",
    route: "/api/orchestrate",
    method: "GET",
    permissions: [],
    supportsLiveUpdates: true,
    supportsControls: false,
    dashboardWidgetType: "table",
    status: "active",
    dependencies: ["pipeline-orchestrator"],
    sourceFiles: ["artifacts/api-server/src/routes/orchestrate.ts"],
  },
  {
    id: "job-detail",
    featureName: "Job Detail",
    category: "orchestration",
    description: "Returns full state of a single pipeline job including all stages and metadata.",
    route: "/api/orchestrate/:jobId",
    method: "GET",
    permissions: [],
    supportsLiveUpdates: true,
    supportsControls: false,
    dashboardWidgetType: "timeline",
    status: "active",
    dependencies: ["pipeline-orchestrator"],
    sourceFiles: ["artifacts/api-server/src/routes/orchestrate.ts"],
  },
  {
    id: "pipeline-dashboard-html",
    featureName: "Pipeline HTML Dashboard",
    category: "orchestration",
    description: "Self-contained HTML dashboard page for real-time pipeline monitoring — no frontend framework required.",
    route: "/api/progress",
    method: "GET",
    permissions: [],
    supportsLiveUpdates: true,
    supportsControls: false,
    dashboardWidgetType: "none",
    status: "active",
    dependencies: ["pipeline-sse-global"],
    sourceFiles: ["artifacts/api-server/src/routes/progress.ts"],
  },

  // ── Scraping ──────────────────────────────────────────────────────────────

  {
    id: "scrape-progress",
    featureName: "Scrape Job Progress",
    category: "scraping",
    description: "Returns live progress for an individual scrape job from the database — articles scraped, completion %, current article.",
    route: "/api/scrape-progress/:scrapeJobId",
    method: "GET",
    permissions: [],
    supportsLiveUpdates: true,
    supportsControls: false,
    dashboardWidgetType: "progress-bar",
    status: "active",
    dependencies: ["job-worker", "scrape-jobs-model"],
    sourceFiles: ["artifacts/api-server/src/routes/progress.ts"],
  },
  {
    id: "crawl-frontier",
    featureName: "Crawl Frontier",
    category: "scraping",
    description: "BFS URL discovery engine — manages visited/queued URL sets and site-coverage enforcement.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: [],
    sourceFiles: ["artifacts/api-server/src/lib/crawl-frontier.ts"],
  },
  {
    id: "scraper",
    featureName: "Headless Scraper",
    category: "scraping",
    description: "Puppeteer + Cheerio scraping engine — fetches pages, extracts links, media, and structured content.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "log-stream",
    status: "active",
    dependencies: ["crawl-frontier", "cloud-storage"],
    sourceFiles: [
      "artifacts/api-server/src/lib/scraper.ts",
      "artifacts/api-server/src/lib/headless-fetcher.ts",
    ],
  },
  {
    id: "resource-intelligence-ri1",
    featureName: "Resource Intelligence Engine (RI-1)",
    category: "scraping",
    description: "Decides which resources to acquire during crawl — evaluates URL patterns, MIME types, size estimates, and domain rules.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: [],
    sourceFiles: ["artifacts/api-server/src/lib/resource-intelligence-engine-ri1.ts"],
  },
  {
    id: "reconstruction-value-ri2",
    featureName: "Reconstruction Value Engine (RI-2)",
    category: "scraping",
    description: "Scores every resource across 9 value dimensions to compute its reconstruction priority before download decisions.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "chart",
    status: "active",
    dependencies: ["resource-intelligence-ri1"],
    sourceFiles: ["artifacts/api-server/src/lib/reconstruction-value-engine-ri2.ts"],
  },
  {
    id: "resource-decision-ri3",
    featureName: "Resource Decision Engine (RI-3)",
    category: "scraping",
    description: "Single authoritative gate for all resource acquisition — 14 ordered rules replacing per-engine heuristics. All videos large-by-default unless observed-small.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: ["reconstruction-value-ri2"],
    sourceFiles: ["artifacts/api-server/src/lib/resource-decision-engine-ri3.ts"],
  },

  // ── Intelligence ──────────────────────────────────────────────────────────

  {
    id: "brand-dna-engine",
    featureName: "Brand DNA Engine",
    category: "intelligence",
    description: "Extracts brand identity signals — colour palette, typography, spacing rhythm, and logo fingerprint — from scraped HTML+CSS.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: ["scraper"],
    sourceFiles: ["artifacts/api-server/src/lib/brand-dna-engine.ts"],
  },
  {
    id: "visual-dna-engine",
    featureName: "Visual DNA Engine",
    category: "intelligence",
    description: "Captures visual fingerprint of each page — layout grid, component density, whitespace ratios, and visual hierarchy.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: ["screenshot-capture"],
    sourceFiles: [
      "artifacts/api-server/src/lib/visual-dna-engine.ts",
      "artifacts/api-server/src/lib/screenshot-visual-dna-engine.ts",
    ],
  },
  {
    id: "backend-detection-d1",
    featureName: "Backend Detection Engine (D1)",
    category: "intelligence",
    description: "Fingerprints the target site's backend stack — framework, CMS, database type, API layer — from HTTP headers and response patterns.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: ["scraper", "http-framework-fingerprinter"],
    sourceFiles: [
      "artifacts/api-server/src/lib/backend-detection-engine-d1.ts",
      "artifacts/api-server/src/lib/http-framework-fingerprinter.ts",
    ],
  },
  {
    id: "asset-intelligence-c2",
    featureName: "Asset Intelligence Engine (C2)",
    category: "intelligence",
    description: "Analyses every scraped asset — image dimensions, font subsets, script bundles — to build a complete asset dependency graph.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "table",
    status: "active",
    dependencies: ["scraper"],
    sourceFiles: ["artifacts/api-server/src/lib/asset-intelligence-engine-c2.ts"],
  },
  {
    id: "component-extraction",
    featureName: "Component Extraction Engine",
    category: "intelligence",
    description: "Identifies and extracts reusable UI components (nav, hero, card, footer, etc.) from scraped HTML for stencil generation.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "table",
    status: "active",
    dependencies: ["brand-dna-engine"],
    sourceFiles: [
      "artifacts/api-server/src/lib/component-extraction-engine.ts",
      "artifacts/api-server/src/lib/embed-extractor.ts",
      "artifacts/api-server/src/lib/image-extractor.ts",
    ],
  },
  {
    id: "visual-layout-mapper",
    featureName: "Visual Layout Mapper Engine",
    category: "intelligence",
    description: "Maps the spatial layout of every page — grid columns, section boundaries, and element positions — into a normalised layout schema.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "diff-view",
    status: "active",
    dependencies: ["visual-dna-engine"],
    sourceFiles: ["artifacts/api-server/src/lib/visual-layout-mapper-engine.ts"],
  },
  {
    id: "seo-intelligence-c4",
    featureName: "SEO Intelligence Engine (C4)",
    category: "intelligence",
    description: "Extracts SEO signals — title tags, meta descriptions, canonical URLs, schema.org markup, sitemap presence — from each page.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: ["scraper"],
    sourceFiles: ["artifacts/api-server/src/lib/seo-intelligence-engine-c4.ts"],
  },
  {
    id: "screenshot-capture",
    featureName: "Screenshot Capture Engine",
    category: "intelligence",
    description: "Takes full-page screenshots at desktop and mobile viewports for visual DNA extraction and regression baselines.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: ["scraper"],
    sourceFiles: [
      "artifacts/api-server/src/lib/screenshot-capture-engine.ts",
      "artifacts/api-server/src/lib/visual-capture-engine.ts",
    ],
  },
  {
    id: "diff-intelligence",
    featureName: "Diff Intelligence Engine",
    category: "intelligence",
    description: "Analyses the diff between two crawl manifests — classifies changes as new, modified, deleted, or unchanged and estimates bandwidth savings.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "diff-view",
    status: "active",
    dependencies: ["diff-engine"],
    sourceFiles: [
      "artifacts/api-server/src/lib/diff-intelligence.ts",
      "artifacts/api-server/src/lib/diff-engine.ts",
      "artifacts/api-server/src/lib/diff-zip.ts",
    ],
  },
  {
    id: "reconstruction-scorer",
    featureName: "Reconstruction Scorer",
    category: "intelligence",
    description: "Produces a composite reconstruction quality score from visual, structural, SEO, and compatibility sub-scores.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: ["visual-fidelity", "certification-c6"],
    sourceFiles: ["artifacts/api-server/src/lib/reconstruction-scorer.ts"],
  },

  // ── Generation ────────────────────────────────────────────────────────────

  {
    id: "stencil-selection",
    featureName: "Stencil Selection Engine",
    category: "generation",
    description: "Matches site intelligence to the closest stencil template in the registry — scores candidates across layout, palette, and component overlap.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: ["brand-dna-engine", "component-extraction"],
    sourceFiles: [
      "artifacts/api-server/src/lib/stencil-selection-engine.ts",
      "artifacts/api-server/src/lib/stencil-selection-runner.ts",
    ],
  },
  {
    id: "stencil-assembly",
    featureName: "Stencil Assembly Runner",
    category: "generation",
    description: "Assembles the selected stencil with extracted content, brand tokens, and page-specific layout — outputs a renderable site package.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "progress-bar",
    status: "active",
    dependencies: ["stencil-selection", "generation-runner"],
    sourceFiles: ["artifacts/api-server/src/lib/stencil-assembly-runner.ts"],
  },
  {
    id: "generation-runner",
    featureName: "Generation Pipeline Runner",
    category: "generation",
    description: "Orchestrates the full C1 → C6 construction pipeline: content placement, component generation, routing, theming, and audit.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "timeline",
    status: "active",
    dependencies: ["stencil-assembly", "canonical-pipeline"],
    sourceFiles: ["artifacts/api-server/src/lib/generation-runner.ts"],
  },
  {
    id: "canonical-pipeline",
    featureName: "Canonical Pipeline Engine",
    category: "generation",
    description: "Enforces the canonical stage ordering and dependency graph for the generation pipeline — prevents out-of-order execution.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "timeline",
    status: "active",
    dependencies: [],
    sourceFiles: ["artifacts/api-server/src/lib/canonical-pipeline-engine.ts"],
  },
  {
    id: "construction-runner",
    featureName: "Construction Runner",
    category: "generation",
    description: "Runs the physical construction phase — writes generated files to disk, applies theme tokens, and produces a site ZIP.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "progress-bar",
    status: "active",
    dependencies: ["generation-runner"],
    sourceFiles: ["artifacts/api-server/src/lib/construction-runner.ts"],
  },
  {
    id: "website-prime-indexer",
    featureName: "Website Prime Indexer",
    category: "generation",
    description: "Post-generation indexer that registers the newly constructed Website Prime in the stencil registry and cloud storage.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: ["construction-runner", "cloud-storage"],
    sourceFiles: [
      "artifacts/api-server/src/lib/website-prime-indexer.ts",
      "artifacts/api-server/src/lib/website-prime-phase57.ts",
    ],
  },
  {
    id: "runtime-performance-c3",
    featureName: "Runtime Performance Engine (C3)",
    category: "generation",
    description: "Analyses and optimises generated site bundle — code splitting, lazy loading, critical CSS extraction.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: ["construction-runner"],
    sourceFiles: ["artifacts/api-server/src/lib/runtime-performance-engine-c3.ts"],
  },
  {
    id: "runtime-optimizer-c5",
    featureName: "Runtime Optimiser Engine (C5)",
    category: "generation",
    description: "Post-build optimisation pass — image compression, font subsetting, tree shaking, and cache-header recommendations.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: ["runtime-performance-c3"],
    sourceFiles: ["artifacts/api-server/src/lib/runtime-optimizer-engine-c5.ts"],
  },
  {
    id: "incremental-regen-c1",
    featureName: "Incremental Regeneration Engine (C1)",
    category: "generation",
    description: "Regenerates only the changed pages from a differential crawl, skipping unchanged pages to minimise build time.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "progress-bar",
    status: "active",
    dependencies: ["diff-intelligence", "generation-runner"],
    sourceFiles: ["artifacts/api-server/src/lib/incremental-regeneration-engine-c1.ts"],
  },
  {
    id: "media-pipeline",
    featureName: "Media Pipeline",
    category: "generation",
    description: "Processes all scraped media — transcodes images, strips EXIF, generates WebP variants, and buffers for cloud upload.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: ["scraper", "cloud-storage"],
    sourceFiles: ["artifacts/api-server/src/lib/media-pipeline.ts"],
  },

  // ── Merge ─────────────────────────────────────────────────────────────────

  {
    id: "semantic-merge-planner-d2",
    featureName: "Semantic Merge Planner (D2)",
    category: "merge",
    description: "Analyses the Website Prime and target codebase to produce a semantic merge plan — maps prime components to target equivalents.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "diff-view",
    status: "active",
    dependencies: ["backend-detection-d1"],
    sourceFiles: ["artifacts/api-server/src/lib/semantic-merge-planner-d2.ts"],
  },
  {
    id: "merge-execution-d3",
    featureName: "Merge Execution Engine (D3)",
    category: "merge",
    description: "Executes the merge plan atomically — writes files, creates rollback packages, and persists execution records to the database.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: true,
    dashboardWidgetType: "timeline",
    status: "active",
    dependencies: ["semantic-merge-planner-d2", "merge-executions-model"],
    sourceFiles: ["artifacts/api-server/src/lib/merge-execution-engine-d3.ts"],
  },
  {
    id: "api-contract-validation-d4",
    featureName: "API Contract Validation Engine (D4)",
    category: "merge",
    description: "Validates the merged codebase against the original API contract — catches breaking changes before deployment.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "status-badge",
    status: "active",
    dependencies: ["merge-execution-d3"],
    sourceFiles: ["artifacts/api-server/src/lib/api-contract-validation-engine-d4.ts"],
  },
  {
    id: "merge-certification-d5",
    featureName: "Merge Certification Engine (D5)",
    category: "merge",
    description: "Issues a merge certification after passing D4 validation, compatibility checks, and rollback verification.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "status-badge",
    status: "active",
    dependencies: ["api-contract-validation-d4"],
    sourceFiles: ["artifacts/api-server/src/lib/merge-certification-engine-d5.ts"],
  },
  {
    id: "compatibility-bm1",
    featureName: "Compatibility Engine (BM-1)",
    category: "compatibility",
    description: "Master compatibility analyser — checks route, database, auth, API, and component compatibility before merge.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "table",
    status: "active",
    dependencies: [],
    sourceFiles: ["artifacts/api-server/src/lib/compatibility-engine-bm1.ts"],
  },
  {
    id: "route-collision-bm2",
    featureName: "Route Collision Engine (BM-2)",
    category: "compatibility",
    description: "Detects route collisions between the Website Prime and the target app — flags conflicts and suggests resolutions.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "table",
    status: "active",
    dependencies: ["compatibility-bm1"],
    sourceFiles: ["artifacts/api-server/src/lib/route-collision-engine-bm2.ts"],
  },
  {
    id: "database-compatibility-bm3",
    featureName: "Database Compatibility Engine (BM-3)",
    category: "compatibility",
    description: "Analyses schema compatibility — detects conflicting table names, column type mismatches, and migration requirements.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "table",
    status: "active",
    dependencies: ["compatibility-bm1"],
    sourceFiles: ["artifacts/api-server/src/lib/database-compatibility-engine-bm3.ts"],
  },
  {
    id: "auth-preservation-bm4",
    featureName: "Auth Preservation Engine (BM-4)",
    category: "compatibility",
    description: "Ensures authentication flows, session stores, and auth middleware are preserved and not overwritten during merge.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "status-badge",
    status: "active",
    dependencies: ["compatibility-bm1"],
    sourceFiles: ["artifacts/api-server/src/lib/auth-preservation-engine-bm4.ts"],
  },
  {
    id: "api-compatibility-bm5",
    featureName: "API Compatibility Engine (BM-5)",
    category: "compatibility",
    description: "Checks API endpoint compatibility between prime and target — validates request/response shapes and versioning.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "table",
    status: "active",
    dependencies: ["compatibility-bm1"],
    sourceFiles: ["artifacts/api-server/src/lib/api-compatibility-engine-bm5.ts"],
  },
  {
    id: "component-merge-bm6",
    featureName: "Component Merge Engine (BM-6)",
    category: "merge",
    description: "Merges UI components from the prime into the target's component library — deduplicates, reconciles prop interfaces.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "diff-view",
    status: "active",
    dependencies: ["merge-execution-d3"],
    sourceFiles: ["artifacts/api-server/src/lib/component-merge-engine-bm6.ts"],
  },
  {
    id: "data-binding-bm7",
    featureName: "Data Binding Engine (BM-7)",
    category: "merge",
    description: "Reconnects data-binding hooks — API calls, state management, and form handlers — after component merge.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: ["component-merge-bm6"],
    sourceFiles: ["artifacts/api-server/src/lib/data-binding-engine-bm7.ts"],
  },
  {
    id: "merge-simulation-bm8",
    featureName: "Merge Simulation Engine (BM-8)",
    category: "merge",
    description: "Dry-runs the full merge in an isolated sandbox and reports predicted conflicts, coverage, and rollback risk before committing.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: true,
    dashboardWidgetType: "diff-view",
    status: "active",
    dependencies: ["merge-execution-d3"],
    sourceFiles: ["artifacts/api-server/src/lib/merge-simulation-engine-bm8.ts"],
  },
  {
    id: "rollback-generator-bm9",
    featureName: "Rollback Generator (BM-9)",
    category: "merge",
    description: "Generates a complete rollback package — snapshot of target files before merge — enabling one-click revert.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: true,
    dashboardWidgetType: "control-panel",
    status: "active",
    dependencies: ["merge-execution-d3"],
    sourceFiles: [
      "artifacts/api-server/src/lib/rollback-generator-bm9.ts",
      "artifacts/api-server/src/lib/rollback-plan-engine.ts",
    ],
  },
  {
    id: "merge-runner",
    featureName: "Merge Runner",
    category: "merge",
    description: "Top-level merge coordinator that sequences D2 → D3 → BM-1 through BM-9 and gates each stage on the previous.",
    permissions: [],
    supportsLiveUpdates: true,
    supportsControls: false,
    dashboardWidgetType: "timeline",
    status: "active",
    dependencies: ["merge-execution-d3", "compatibility-bm1"],
    sourceFiles: ["artifacts/api-server/src/lib/merge-runner.ts"],
  },

  // ── Visual ────────────────────────────────────────────────────────────────

  {
    id: "visual-fidelity",
    featureName: "Visual Fidelity Engine",
    category: "visual",
    description: "Compares pixel-level screenshots of the original and reconstructed site — produces a fidelity score and diff heatmap.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: ["screenshot-capture", "pixel-comparison"],
    sourceFiles: [
      "artifacts/api-server/src/lib/visual-fidelity-engine.ts",
      "artifacts/api-server/src/lib/visual-fidelity-scoring-engine-vr7.ts",
    ],
  },
  {
    id: "pixel-comparison",
    featureName: "Pixel Comparison Engine",
    category: "visual",
    description: "Low-level pixel differ — computes changed pixel count, bounding boxes of diff regions, and perceptual hash distance.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "diff-view",
    status: "active",
    dependencies: ["screenshot-capture"],
    sourceFiles: ["artifacts/api-server/src/lib/pixel-comparison-engine.ts"],
  },
  {
    id: "visual-regression",
    featureName: "Visual Regression Engine",
    category: "visual",
    description: "Automated visual regression suite — compares against stored baselines and fails if fidelity drops below threshold.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "table",
    status: "active",
    dependencies: ["visual-fidelity", "pixel-comparison"],
    sourceFiles: ["artifacts/api-server/src/lib/visual-regression-engine.ts"],
  },
  {
    id: "visual-certification-b8",
    featureName: "Visual Certification Engine (B8)",
    category: "visual",
    description: "Issues a visual certification after passing fidelity scoring, regression suite, and multi-page consistency checks.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "status-badge",
    status: "active",
    dependencies: ["visual-regression", "consistency-vr6"],
    sourceFiles: ["artifacts/api-server/src/lib/visual-certification-engine-b8.ts"],
  },
  {
    id: "consistency-vr6",
    featureName: "Consistency Engine (VR-6)",
    category: "visual",
    description: "Validates cross-page consistency — checks that nav, footer, typography, and brand colours are uniform across all generated pages.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "table",
    status: "active",
    dependencies: ["visual-fidelity"],
    sourceFiles: [
      "artifacts/api-server/src/lib/consistency-engine-vr6.ts",
      "artifacts/api-server/src/lib/multi-page-consistency-engine.ts",
    ],
  },
  {
    id: "visual-optimizer",
    featureName: "Visual Optimiser",
    category: "visual",
    description: "Iterative visual correction loop — identifies low-fidelity regions and triggers targeted re-generation passes.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: ["visual-regression"],
    sourceFiles: [
      "artifacts/api-server/src/lib/visual-optimizer.ts",
      "artifacts/api-server/src/lib/visual-optimization-loop-engine.ts",
    ],
  },
  {
    id: "reconstruction-loop-vr8",
    featureName: "Reconstruction Loop Engine (VR-8)",
    category: "visual",
    description: "Outer reconstruction retry loop — re-runs generation with adjusted parameters until the VR-7 fidelity score passes or max iterations are reached.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "progress-bar",
    status: "active",
    dependencies: ["visual-optimizer", "generation-runner"],
    sourceFiles: [
      "artifacts/api-server/src/lib/reconstruction-loop-engine-vr8.ts",
      "artifacts/api-server/src/lib/vr8-review-integration.ts",
    ],
  },
  {
    id: "typography-fidelity",
    featureName: "Typography Fidelity Engine",
    category: "visual",
    description: "Verifies that reconstructed pages match the original site's font families, sizes, weights, and line-height ratios.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: ["brand-dna-engine"],
    sourceFiles: ["artifacts/api-server/src/lib/typography-fidelity-engine.ts"],
  },

  // ── Certification ─────────────────────────────────────────────────────────

  {
    id: "certification-c6",
    featureName: "Certification Engine (C6)",
    category: "certification",
    description: "Issues a construction certification after all C1–C5 stages pass — gates deployment on quality.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "status-badge",
    status: "active",
    dependencies: ["construction-runner", "runtime-optimizer-c5"],
    sourceFiles: ["artifacts/api-server/src/lib/certification-engine-c6.ts"],
  },
  {
    id: "platform-certification",
    featureName: "Platform Certification Engine",
    category: "certification",
    description: "End-to-end platform certification — aggregates all sub-certifications (visual, merge, construction) into a single pass/fail gate.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "status-badge",
    status: "active",
    dependencies: ["certification-c6", "visual-certification-b8", "merge-certification-d5"],
    sourceFiles: [
      "artifacts/api-server/src/lib/platform-certification-engine.ts",
      "artifacts/api-server/src/lib/platform-validation-engine.ts",
    ],
  },
  {
    id: "production-certification-e5",
    featureName: "Production Certification Engine (E5)",
    category: "certification",
    description: "Final production readiness gate — load tests, security scan, accessibility audit, and SLA compliance check before any deployment.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "status-badge",
    status: "active",
    dependencies: ["platform-certification", "load-test-e1", "security-hardening-e2"],
    sourceFiles: [
      "artifacts/api-server/src/lib/production-certification-engine-e5.ts",
      "artifacts/api-server/src/lib/production-readiness-engine.ts",
    ],
  },

  // ── Deployment ────────────────────────────────────────────────────────────

  {
    id: "deployment-executor",
    featureName: "Deployment Executor",
    category: "deployment",
    description: "Executes the deployment plan — writes artefacts to cloud storage, updates CDN, and runs post-deploy health checks.",
    permissions: [],
    supportsLiveUpdates: true,
    supportsControls: true,
    dashboardWidgetType: "timeline",
    status: "active",
    dependencies: ["production-certification-e5", "cloud-storage"],
    sourceFiles: [
      "artifacts/api-server/src/lib/deployment-executor.ts",
      "artifacts/api-server/src/lib/deployment-plan-runner.ts",
    ],
  },
  {
    id: "deployment-intelligence",
    featureName: "Deployment Intelligence",
    category: "deployment",
    description: "Analyses deployment history, environment parity, and infrastructure constraints to produce an optimised deployment plan.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: [],
    sourceFiles: [
      "artifacts/api-server/src/lib/deployment-intelligence.ts",
      "artifacts/api-server/src/lib/deployment-audit-store.ts",
    ],
  },
  {
    id: "one-click-reconstruction",
    featureName: "One-Click Reconstruction",
    category: "deployment",
    description: "Single-button pipeline: URL in → deployed site out. Orchestrates the full pipeline end-to-end with minimal configuration.",
    permissions: [],
    supportsLiveUpdates: true,
    supportsControls: true,
    dashboardWidgetType: "control-panel",
    status: "active",
    dependencies: ["pipeline-orchestrator", "deployment-executor"],
    sourceFiles: ["artifacts/api-server/src/lib/one-click-reconstruction.ts"],
  },

  // ── Recovery ──────────────────────────────────────────────────────────────

  {
    id: "job-supervisor",
    featureName: "Job Supervisor (F1)",
    category: "recovery",
    description: "Monitors every active job set and child job — detects stalls, heartbeat loss, excessive retries, and worker crashes. Generates supervisor, health, and worker-status reports.",
    route: "/api/supervisor/report",
    method: "GET",
    permissions: [],
    supportsLiveUpdates: true,
    supportsControls: true,
    dashboardWidgetType: "control-panel",
    status: "active",
    dependencies: ["job-worker", "failure-classifier"],
    sourceFiles: ["artifacts/api-server/src/lib/job-supervisor.ts"],
  },
  {
    id: "failure-classifier",
    featureName: "Failure Classifier (F2)",
    category: "recovery",
    description: "Classifies why a job failed — timeout, crash, resource starvation, network error, etc. — and recommends retry strategy.",
    route: "/api/supervisor/failures",
    method: "GET",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "table",
    status: "active",
    dependencies: ["job-supervisor"],
    sourceFiles: ["artifacts/api-server/src/lib/failure-classifier.ts"],
  },
  {
    id: "autonomous-recovery",
    featureName: "Autonomous Recovery Engine (F3)",
    category: "recovery",
    description: "Decides how to recover each failed job — retry immediately, retry with backoff, split the job, or escalate. Executes recoveries without human intervention.",
    route: "/api/recovery/report",
    method: "GET",
    permissions: [],
    supportsLiveUpdates: true,
    supportsControls: true,
    dashboardWidgetType: "control-panel",
    status: "active",
    dependencies: ["failure-classifier"],
    sourceFiles: ["artifacts/api-server/src/lib/autonomous-recovery-engine.ts"],
  },
  {
    id: "checkpoint-engine",
    featureName: "Checkpoint Resume Engine (F4)",
    category: "recovery",
    description: "Saves job execution state at each pipeline stage — enables mid-pipeline recovery without restarting from scratch.",
    route: "/api/checkpoint",
    method: "GET",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: true,
    dashboardWidgetType: "table",
    status: "active",
    dependencies: [],
    sourceFiles: ["artifacts/api-server/src/lib/checkpoint-engine.ts"],
  },
  {
    id: "job-dashboard-api",
    featureName: "Job Dashboard API (F5)",
    category: "recovery",
    description: "Exposes full job control surface — pause, split, retry, cancel — over REST. Powers any frontend job management UI.",
    route: "/api/supervisor/workers",
    method: "GET",
    permissions: [],
    supportsLiveUpdates: true,
    supportsControls: true,
    dashboardWidgetType: "control-panel",
    status: "active",
    dependencies: ["job-supervisor", "failure-classifier"],
    sourceFiles: ["artifacts/api-server/src/lib/job-dashboard.ts"],
  },
  {
    id: "self-healing-orchestrator",
    featureName: "Self-Healing Orchestrator (F6)",
    category: "recovery",
    description: "Top-level autonomous coordinator — watches supervisor reports, triggers recovery engine, rebalances workers, and keeps the pipeline running indefinitely.",
    permissions: [],
    supportsLiveUpdates: true,
    supportsControls: false,
    dashboardWidgetType: "status-badge",
    status: "background",
    dependencies: ["job-supervisor", "autonomous-recovery", "checkpoint-engine"],
    sourceFiles: ["artifacts/api-server/src/lib/self-healing-orchestrator.ts"],
  },
  {
    id: "e2-recovery",
    featureName: "E2 Security Recovery Engine",
    category: "recovery",
    description: "Recovers from security-related failures — permission errors, CORS violations, CSP breaches — and applies hardening patches.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: [],
    sourceFiles: [
      "artifacts/api-server/src/lib/e2-recovery-engine.ts",
      "artifacts/api-server/src/lib/e2-recovery-runner.ts",
    ],
  },
  {
    id: "e3-repair-planner",
    featureName: "E3 Repair Planner",
    category: "recovery",
    description: "Generates a structured repair plan for a failed pipeline run — lists broken stages, root causes, and ordered remediation steps.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "timeline",
    status: "active",
    dependencies: ["failure-classifier"],
    sourceFiles: ["artifacts/api-server/src/lib/e3-repair-planner.ts"],
  },
  {
    id: "disaster-recovery-e4",
    featureName: "Disaster Recovery Engine (E4)",
    category: "recovery",
    description: "Handles catastrophic pipeline failures — corrupt state, cloud outages, DB connection loss — with full workspace reset and state restoration.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: true,
    dashboardWidgetType: "control-panel",
    status: "active",
    dependencies: ["autonomous-recovery", "cloud-storage"],
    sourceFiles: ["artifacts/api-server/src/lib/disaster-recovery-engine-e4.ts"],
  },
  {
    id: "human-override",
    featureName: "Human Override Engine",
    category: "recovery",
    description: "Exposes manual override controls — pause pipeline, force-skip a stage, inject a custom value — for operator intervention.",
    permissions: ["operator"],
    supportsLiveUpdates: false,
    supportsControls: true,
    dashboardWidgetType: "control-panel",
    status: "active",
    dependencies: ["pipeline-orchestrator"],
    sourceFiles: [
      "artifacts/api-server/src/lib/human-override-engine.ts",
      "artifacts/api-server/src/lib/human-review-gate-engine.ts",
    ],
  },

  // ── Monitoring ────────────────────────────────────────────────────────────

  {
    id: "system-monitor",
    featureName: "System Health Monitor (E1)",
    category: "monitoring",
    description: "Background worker running every 60s — checks API responsiveness, memory, disk, DB connectivity, and R2 availability. Writes health-report.json.",
    permissions: [],
    supportsLiveUpdates: true,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "background",
    dependencies: [],
    sourceFiles: [
      "artifacts/api-server/src/lib/monitoring-runner.ts",
      "artifacts/api-server/src/lib/monitoring-engine.ts",
    ],
  },
  {
    id: "pipeline-health-runner",
    featureName: "Pipeline Health Runner (Phase 6.2)",
    category: "monitoring",
    description: "Background worker running every 30s — checks each pipeline stage for health and triggers auto-repair on failures.",
    permissions: [],
    supportsLiveUpdates: true,
    supportsControls: false,
    dashboardWidgetType: "status-badge",
    status: "background",
    dependencies: ["pipeline-repair"],
    sourceFiles: [
      "artifacts/api-server/src/lib/pipeline-health-runner.ts",
      "artifacts/api-server/src/lib/pipeline-health-engine.ts",
    ],
  },
  {
    id: "pipeline-repair",
    featureName: "Pipeline Repair Engine",
    category: "monitoring",
    description: "Auto-repairs failing pipeline stages — restarts stalled workers, clears locked state, and re-queues stuck jobs.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "log-stream",
    status: "active",
    dependencies: ["job-supervisor"],
    sourceFiles: ["artifacts/api-server/src/lib/pipeline-repair-engine.ts"],
  },
  {
    id: "pipeline-monitoring-interceptor",
    featureName: "Pipeline Monitoring Interceptor (PH-2)",
    category: "monitoring",
    description: "Captures stage-by-stage snapshots during every pipeline run — builds a full execution trace for post-run analysis.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "timeline",
    status: "background",
    dependencies: ["event-bus"],
    sourceFiles: ["artifacts/api-server/src/lib/pipeline-monitoring-interceptor.ts"],
  },
  {
    id: "regression-runner",
    featureName: "Post-Build Regression Runner (PH-3)",
    category: "monitoring",
    description: "Runs automated visual and functional regression tests after every Website Prime build — stores results and fails on score drop.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "table",
    status: "background",
    dependencies: ["visual-regression"],
    sourceFiles: ["artifacts/api-server/src/lib/post-build-regression-runner.ts"],
  },
  {
    id: "monitoring-persistence",
    featureName: "Monitoring Persistence Service (PH-5)",
    category: "monitoring",
    description: "Flushes all in-process QA-3 monitoring snapshots to R2 every 5 minutes — ensures monitoring state survives server restarts.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "background",
    dependencies: ["cloud-storage"],
    sourceFiles: ["artifacts/api-server/src/lib/monitoring-persistence-service.ts"],
  },
  {
    id: "quality-monitoring",
    featureName: "Quality Monitoring Engine",
    category: "monitoring",
    description: "Tracks long-run quality trends — fidelity scores, coverage percentages, and build durations — across all pipeline runs.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "chart",
    status: "active",
    dependencies: ["visual-fidelity"],
    sourceFiles: ["artifacts/api-server/src/lib/quality-monitoring-engine.ts"],
  },
  {
    id: "observability-e3",
    featureName: "Observability Engine (E3)",
    category: "monitoring",
    description: "Distributed tracing and structured telemetry — spans, events, and metrics for every pipeline operation.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "timeline",
    status: "active",
    dependencies: ["event-bus"],
    sourceFiles: ["artifacts/api-server/src/lib/observability-engine-e3.ts"],
  },
  {
    id: "load-test-e1",
    featureName: "Load Test Engine (E1)",
    category: "monitoring",
    description: "Runs synthetic load against the generated site — simulates concurrent users and measures P50/P95/P99 latencies.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: true,
    dashboardWidgetType: "chart",
    status: "on-demand",
    dependencies: [],
    sourceFiles: ["artifacts/api-server/src/lib/load-test-engine-e1.ts"],
  },
  {
    id: "security-hardening-e2",
    featureName: "Security Hardening Engine (E2)",
    category: "monitoring",
    description: "Scans the generated site for common vulnerabilities — XSS vectors, insecure headers, exposed secrets, CORS misconfigs.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "table",
    status: "on-demand",
    dependencies: [],
    sourceFiles: ["artifacts/api-server/src/lib/security-hardening-engine-e2.ts"],
  },
  {
    id: "learning-loop-validator",
    featureName: "Learning Loop Validator",
    category: "monitoring",
    description: "Validates that each pipeline run improved over the previous — detects regressions in coverage, fidelity, or speed.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "chart",
    status: "active",
    dependencies: ["quality-monitoring"],
    sourceFiles: ["artifacts/api-server/src/lib/learning-loop-validator.ts"],
  },

  // ── Storage ───────────────────────────────────────────────────────────────

  {
    id: "cloud-storage",
    featureName: "Cloud Storage (R2 / Local)",
    category: "storage",
    description: "Provider-abstracted cloud storage — Cloudflare R2 in production, local filesystem in dev. Swap via CLOUD_PROVIDER env var.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: [],
    sourceFiles: [
      "artifacts/api-server/src/cloud/r2.provider.ts",
      "artifacts/api-server/src/cloud/local.provider.ts",
      "artifacts/api-server/src/cloud/provider.ts",
      "artifacts/api-server/src/lib/cloud-storage.ts",
      "artifacts/api-server/src/lib/r2-executor.ts",
    ],
  },
  {
    id: "manifest-store",
    featureName: "Manifest Store",
    category: "storage",
    description: "Persists and retrieves crawl manifests — the structured representation of every page scraped. Used for diff and incremental builds.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "metric-card",
    status: "active",
    dependencies: ["cloud-storage"],
    sourceFiles: [
      "artifacts/api-server/src/lib/manifest-store.ts",
      "artifacts/api-server/src/lib/manifest.ts",
      "artifacts/api-server/src/lib/manifest-verifier.ts",
      "artifacts/api-server/src/lib/manifest-export.ts",
    ],
  },
  {
    id: "audit-logger",
    featureName: "Audit Logger",
    category: "storage",
    description: "Append-only structured audit log — records every significant system action with timestamp, actor, and outcome for compliance and debugging.",
    permissions: [],
    supportsLiveUpdates: false,
    supportsControls: false,
    dashboardWidgetType: "log-stream",
    status: "active",
    dependencies: ["cloud-storage"],
    sourceFiles: ["artifacts/api-server/src/lib/audit-logger.ts"],
  },

  // ── Event Bus ─────────────────────────────────────────────────────────────

  {
    id: "event-bus",
    featureName: "Pipeline Event Bus",
    category: "orchestration",
    description: "Singleton EventEmitter with a 500-event ring buffer. All pipeline stages publish typed events; SSE routes and report writers subscribe.",
    permissions: [],
    supportsLiveUpdates: true,
    supportsControls: false,
    dashboardWidgetType: "log-stream",
    status: "active",
    dependencies: [],
    sourceFiles: ["artifacts/api-server/src/lib/event-bus.ts"],
  },
  {
    id: "pipeline-sse-job",
    featureName: "Pipeline SSE Stream (per-job)",
    category: "orchestration",
    description: "Server-Sent Events stream for a single job — replays buffered events then streams live. Sends heartbeat snapshots every 15s.",
    route: "/api/pipeline-sse/:jobId",
    method: "GET",
    permissions: [],
    supportsLiveUpdates: true,
    supportsControls: false,
    dashboardWidgetType: "sse-stream",
    status: "active",
    dependencies: ["event-bus", "pipeline-orchestrator"],
    sourceFiles: ["artifacts/api-server/src/routes/progress.ts"],
  },
  {
    id: "pipeline-sse-global",
    featureName: "Pipeline SSE Stream (global)",
    category: "orchestration",
    description: "Server-Sent Events stream for all jobs — replays last 50 buffered events then streams every pipeline event. Sends jobs-list every 10s.",
    route: "/api/pipeline-sse",
    method: "GET",
    permissions: [],
    supportsLiveUpdates: true,
    supportsControls: false,
    dashboardWidgetType: "sse-stream",
    status: "active",
    dependencies: ["event-bus"],
    sourceFiles: ["artifacts/api-server/src/routes/progress.ts"],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Route Catalogue
// ─────────────────────────────────────────────────────────────────────────────

export const ROUTE_CATALOGUE: RouteEntry[] = [
  // Platform
  { method: "GET",  path: "/api/healthz",                         featureId: "health-check",            description: "Liveness probe",                                supportsSSE: false },
  { method: "GET",  path: "/api/platform/features",               featureId: "platform-features",       description: "Complete Feature Registry",                     supportsSSE: false },
  { method: "GET",  path: "/api/platform/routes",                 featureId: "platform-routes",         description: "All registered HTTP routes",                    supportsSSE: false },
  { method: "GET",  path: "/api/platform/workers",                featureId: "platform-workers",        description: "All background workers and schedulers",         supportsSSE: false },
  { method: "GET",  path: "/api/platform/services",               featureId: "platform-services",       description: "All internal services and engines",             supportsSSE: false },
  { method: "GET",  path: "/api/platform/events",                 featureId: "platform-events",         description: "All pipeline event types",                      supportsSSE: false },
  { method: "GET",  path: "/api/platform/widgets",                featureId: "platform-widgets",        description: "All recommended dashboard widgets",             supportsSSE: false },
  // Orchestration
  { method: "POST", path: "/api/orchestrate",                     featureId: "pipeline-orchestrator",   description: "Start a new pipeline job",                      supportsSSE: false, requestBody: "{ url, baseJobId?, coverageThreshold? }", responseShape: "{ jobId, url, status, startedAt }" },
  { method: "GET",  path: "/api/orchestrate",                     featureId: "job-list",                description: "List all in-memory pipeline jobs",              supportsSSE: false },
  { method: "GET",  path: "/api/orchestrate/:jobId",              featureId: "job-detail",              description: "Get a single pipeline job by ID",               supportsSSE: false },
  // Progress / SSE
  { method: "GET",  path: "/api/progress",                        featureId: "pipeline-dashboard-html", description: "Self-contained HTML dashboard",                 supportsSSE: false },
  { method: "GET",  path: "/api/pipeline-sse",                    featureId: "pipeline-sse-global",     description: "Global SSE stream — all pipeline events",       supportsSSE: true  },
  { method: "GET",  path: "/api/pipeline-sse/:jobId",             featureId: "pipeline-sse-job",        description: "Per-job SSE stream with event replay",          supportsSSE: true  },
  { method: "GET",  path: "/api/scrape-progress/:scrapeJobId",    featureId: "scrape-progress",         description: "Live scrape job progress from DB",              supportsSSE: false },
  // Supervisor
  { method: "GET",  path: "/api/supervisor/report",               featureId: "job-supervisor",          description: "Full supervisor state report",                  supportsSSE: false },
  { method: "GET",  path: "/api/supervisor/health",               featureId: "job-supervisor",          description: "Supervisor health summary",                     supportsSSE: false },
  { method: "GET",  path: "/api/supervisor/workers",              featureId: "job-dashboard-api",       description: "All tracked workers and their states",          supportsSSE: false },
  { method: "POST", path: "/api/supervisor/cycle",                featureId: "job-supervisor",          description: "Trigger a manual supervisor cycle",             supportsSSE: false },
  { method: "GET",  path: "/api/supervisor/failures",             featureId: "failure-classifier",      description: "All failure classifications",                   supportsSSE: false },
  { method: "GET",  path: "/api/supervisor/failures/roots",       featureId: "failure-classifier",      description: "Root cause analysis for all failures",          supportsSSE: false },
  { method: "GET",  path: "/api/supervisor/failures/retry",       featureId: "failure-classifier",      description: "Retry recommendations per job",                 supportsSSE: false },
  { method: "POST", path: "/api/supervisor/failures/flush",       featureId: "failure-classifier",      description: "Flush failure reports to disk",                 supportsSSE: false },
  // Recovery
  { method: "GET",  path: "/api/recovery/report",                 featureId: "autonomous-recovery",     description: "Full recovery report",                          supportsSSE: false },
  { method: "GET",  path: "/api/recovery/retry-history",          featureId: "autonomous-recovery",     description: "All retry history entries",                     supportsSSE: false },
  { method: "GET",  path: "/api/recovery/automatic-report",       featureId: "autonomous-recovery",     description: "Automatic recovery chains report",              supportsSSE: false },
  { method: "POST", path: "/api/recovery/trigger/:jobId",         featureId: "autonomous-recovery",     description: "Manually trigger recovery for a job",           supportsSSE: false },
  { method: "POST", path: "/api/recovery/cancel-retry/:jobId",    featureId: "autonomous-recovery",     description: "Cancel a pending delayed retry",                supportsSSE: false },
  { method: "POST", path: "/api/recovery/flush",                  featureId: "autonomous-recovery",     description: "Flush all recovery reports to disk",            supportsSSE: false },
  // Checkpoint
  { method: "GET",  path: "/api/checkpoint",                      featureId: "checkpoint-engine",       description: "All active checkpoint snapshots",               supportsSSE: false },
  { method: "GET",  path: "/api/checkpoint/report",               featureId: "checkpoint-engine",       description: "Full checkpoint resume report",                 supportsSSE: false },
  { method: "GET",  path: "/api/checkpoint/validation",           featureId: "checkpoint-engine",       description: "Resume validation report",                      supportsSSE: false },
  { method: "GET",  path: "/api/checkpoint/integrity",            featureId: "checkpoint-engine",       description: "Checkpoint integrity report",                   supportsSSE: false },
  { method: "GET",  path: "/api/checkpoint/:jobId",               featureId: "checkpoint-engine",       description: "Single job checkpoint snapshot",                supportsSSE: false },
  { method: "POST", path: "/api/checkpoint/:jobId/reset",         featureId: "checkpoint-engine",       description: "Reset a job checkpoint to restart from zero",   supportsSSE: false },
  { method: "POST", path: "/api/checkpoint/flush",                featureId: "checkpoint-engine",       description: "Flush all checkpoint reports to disk",          supportsSSE: false },
];

// ─────────────────────────────────────────────────────────────────────────────
// Worker Catalogue
// ─────────────────────────────────────────────────────────────────────────────

export const WORKER_CATALOGUE: WorkerEntry[] = [
  {
    id: "worker-job-poller",
    workerName: "Job Worker Loop",
    description: "Polls the scrape_jobs DB table for queued jobs, claims them, and drives the full crawl pipeline. Uses setTimeout for polling and setInterval for DB sync.",
    intervalSeconds: undefined,
    warmupMs: 0,
    triggerMode: "polling",
    status: "active",
    sourceFile: "artifacts/api-server/src/lib/job-worker.ts",
    exportedFunction: "startWorkerLoop",
    generates: ["scrape_jobs records", "manifest files", "R2 zip uploads"],
  },
  {
    id: "worker-system-monitor",
    workerName: "System Health Monitor",
    description: "Recurring health check — API ping, memory, disk, DB, R2. Writes health-report.json locally and to R2.",
    intervalSeconds: 60,
    warmupMs: 5000,
    triggerMode: "interval",
    status: "background",
    sourceFile: "artifacts/api-server/src/lib/monitoring-runner.ts",
    exportedFunction: "startMonitoringLoop",
    generates: ["health-report.json", "monitoring/health-report.json (R2)"],
  },
  {
    id: "worker-pipeline-health",
    workerName: "Pipeline Health Runner",
    description: "Checks each pipeline stage for stalls and failures every 30s — triggers auto-repair via pipeline-repair-engine.",
    intervalSeconds: 30,
    warmupMs: 8000,
    triggerMode: "interval",
    status: "background",
    sourceFile: "artifacts/api-server/src/lib/pipeline-health-runner.ts",
    exportedFunction: "startPipelineHealthLoop",
    generates: ["pipeline-health.json", "pipeline-repair.json"],
  },
  {
    id: "worker-pipeline-interceptor",
    workerName: "Pipeline Monitoring Interceptor",
    description: "Event-driven stage snapshot collector — subscribes to pipeline events and records a snapshot after each stage completes.",
    triggerMode: "event",
    status: "background",
    sourceFile: "artifacts/api-server/src/lib/pipeline-monitoring-interceptor.ts",
    exportedFunction: "startPipelineMonitoring",
    generates: ["Stage snapshots (in-memory)", "Execution traces"],
  },
  {
    id: "worker-regression-runner",
    workerName: "Post-Build Regression Runner",
    description: "After every Website Prime build, runs the full visual + functional regression suite against stored baselines.",
    triggerMode: "event",
    status: "background",
    sourceFile: "artifacts/api-server/src/lib/post-build-regression-runner.ts",
    exportedFunction: "startRegressionRunner",
    generates: ["Regression history entries", "Visual fidelity history"],
  },
  {
    id: "worker-monitoring-persistence",
    workerName: "Monitoring Persistence Service",
    description: "Flushes all in-process QA-3 monitoring data to R2 every 5 minutes. Also flushes immediately after each stage snapshot (event-driven).",
    intervalSeconds: 300,
    triggerMode: "interval",
    status: "background",
    sourceFile: "artifacts/api-server/src/lib/monitoring-persistence-service.ts",
    exportedFunction: "startMonitoringPersistence",
    generates: ["projects/{projectId}/monitoring/*.json (R2)"],
  },
  {
    id: "worker-job-supervisor",
    workerName: "Job Supervisor Cycle",
    description: "Recursive setTimeout loop — runs supervisor analysis, updates tracked jobs, detects anomalies, and writes supervisor reports.",
    triggerMode: "polling",
    status: "background",
    sourceFile: "artifacts/api-server/src/lib/job-supervisor.ts",
    exportedFunction: "startJobSupervisor",
    generates: ["job-supervisor-report.json", "job-health-report.json", "worker-status-report.json"],
  },
  {
    id: "worker-self-healing",
    workerName: "Self-Healing Orchestrator Cycle",
    description: "Recursive setTimeout loop — reads supervisor and recovery reports, decides orchestration actions, executes them autonomously.",
    triggerMode: "polling",
    status: "background",
    sourceFile: "artifacts/api-server/src/lib/self-healing-orchestrator.ts",
    exportedFunction: "startSelfHealingOrchestrator",
    generates: ["self-healing-orchestration-report.json", "orchestration-health-report.json"],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Service Catalogue
// ─────────────────────────────────────────────────────────────────────────────

export const SERVICE_CATALOGUE: ServiceEntry[] = [
  { id: "svc-event-bus",          serviceName: "Pipeline Event Bus",           category: "orchestration", description: "Singleton EventEmitter with 500-event ring buffer. Single pub/sub backbone for the entire pipeline.", singleton: true,  status: "active", sourceFile: "artifacts/api-server/src/lib/event-bus.ts",                   exposedVia: ["/api/pipeline-sse", "/api/pipeline-sse/:jobId"],                        dependencies: [] },
  { id: "svc-master-orchestrator",serviceName: "Master Orchestrator",          category: "orchestration", description: "In-memory job registry + pipeline driver. createJob() + runPipeline() are the two public entry points.", singleton: true, status: "active", sourceFile: "artifacts/api-server/src/lib/master-orchestrator.ts",         exposedVia: ["/api/orchestrate"],                                                     dependencies: ["svc-event-bus"] },
  { id: "svc-crawl-frontier",     serviceName: "Crawl Frontier",               category: "scraping",      description: "BFS URL discovery with visited-set deduplication and coverage enforcement.",                           singleton: false, status: "active", sourceFile: "artifacts/api-server/src/lib/crawl-frontier.ts",             exposedVia: [],                                                                       dependencies: [] },
  { id: "svc-scraper",            serviceName: "Headless Scraper",             category: "scraping",      description: "Puppeteer + Cheerio — full-page fetch, link extraction, media extraction.",                            singleton: false, status: "active", sourceFile: "artifacts/api-server/src/lib/scraper.ts",                    exposedVia: [],                                                                       dependencies: ["svc-crawl-frontier"] },
  { id: "svc-db-queue",           serviceName: "DB Job Queue",                 category: "orchestration", description: "PostgreSQL-backed job queue — claim, progress, done, fail, recover interrupted jobs.",                  singleton: true,  status: "active", sourceFile: "artifacts/api-server/src/lib/db-queue.ts",                   exposedVia: [],                                                                       dependencies: [] },
  { id: "svc-cloud-storage",      serviceName: "Cloud Storage Provider",       category: "storage",       description: "Provider-abstracted object storage. R2 in prod, local FS in dev. Controlled by CLOUD_PROVIDER env var.", singleton: true, status: "active", sourceFile: "artifacts/api-server/src/cloud/index.ts",                    exposedVia: [],                                                                       dependencies: [] },
  { id: "svc-manifest-store",     serviceName: "Manifest Store",               category: "storage",       description: "Persists and retrieves crawl manifests. Used for diff baseline and incremental builds.",               singleton: false, status: "active", sourceFile: "artifacts/api-server/src/lib/manifest-store.ts",             exposedVia: [],                                                                       dependencies: ["svc-cloud-storage"] },
  { id: "svc-audit-logger",       serviceName: "Audit Logger",                 category: "storage",       description: "Append-only structured audit log. Records every significant action for compliance and debugging.",      singleton: true,  status: "active", sourceFile: "artifacts/api-server/src/lib/audit-logger.ts",               exposedVia: [],                                                                       dependencies: ["svc-cloud-storage"] },
  { id: "svc-job-supervisor",     serviceName: "Job Supervisor",               category: "recovery",      description: "Tracks all active jobs, detects anomalies, generates health + supervisor reports.",                    singleton: true,  status: "active", sourceFile: "artifacts/api-server/src/lib/job-supervisor.ts",             exposedVia: ["/api/supervisor/report", "/api/supervisor/health", "/api/supervisor/workers"], dependencies: [] },
  { id: "svc-failure-classifier", serviceName: "Failure Classifier",           category: "recovery",      description: "Classifies job failures by type and recommends retry strategy.",                                       singleton: true,  status: "active", sourceFile: "artifacts/api-server/src/lib/failure-classifier.ts",         exposedVia: ["/api/supervisor/failures"],                                             dependencies: ["svc-job-supervisor"] },
  { id: "svc-autonomous-recovery",serviceName: "Autonomous Recovery Engine",   category: "recovery",      description: "Executes recovery actions without human intervention — retry, split, or escalate.",                    singleton: true,  status: "active", sourceFile: "artifacts/api-server/src/lib/autonomous-recovery-engine.ts", exposedVia: ["/api/recovery/report"],                                                 dependencies: ["svc-failure-classifier"] },
  { id: "svc-checkpoint-engine",  serviceName: "Checkpoint Engine",            category: "recovery",      description: "Saves and restores per-job pipeline state — enables mid-pipeline resume.",                            singleton: true,  status: "active", sourceFile: "artifacts/api-server/src/lib/checkpoint-engine.ts",          exposedVia: ["/api/checkpoint"],                                                      dependencies: [] },
  { id: "svc-job-dashboard",      serviceName: "Job Dashboard",                category: "recovery",      description: "REST control surface — pause, split, retry, cancel jobs.",                                             singleton: true,  status: "active", sourceFile: "artifacts/api-server/src/lib/job-dashboard.ts",              exposedVia: ["/api/supervisor/workers"],                                              dependencies: ["svc-job-supervisor"] },
  { id: "svc-self-healing",       serviceName: "Self-Healing Orchestrator",    category: "recovery",      description: "Autonomous top-level coordinator — acts on supervisor reports to keep the pipeline running.",           singleton: true,  status: "background", sourceFile: "artifacts/api-server/src/lib/self-healing-orchestrator.ts", exposedVia: [],                                                                      dependencies: ["svc-job-supervisor", "svc-autonomous-recovery"] },
  { id: "svc-monitoring-engine",  serviceName: "Monitoring Engine",            category: "monitoring",    description: "Runs all health checks and aggregates results into a HealthReport.",                                    singleton: false, status: "active", sourceFile: "artifacts/api-server/src/lib/monitoring-engine.ts",          exposedVia: [],                                                                       dependencies: [] },
  { id: "svc-pipeline-health",    serviceName: "Pipeline Health Engine",       category: "monitoring",    description: "Checks each pipeline stage and produces a PipelineHealthReport.",                                       singleton: false, status: "active", sourceFile: "artifacts/api-server/src/lib/pipeline-health-engine.ts",     exposedVia: [],                                                                       dependencies: [] },
  { id: "svc-pipeline-repair",    serviceName: "Pipeline Repair Engine",       category: "monitoring",    description: "Auto-repairs failing stages — restarts workers, clears locks, re-queues stuck jobs.",                   singleton: false, status: "active", sourceFile: "artifacts/api-server/src/lib/pipeline-repair-engine.ts",     exposedVia: [],                                                                       dependencies: ["svc-job-supervisor"] },
  { id: "svc-renderer",           serviceName: "Renderer",                     category: "generation",    description: "Renders stencil templates with injected content and brand tokens into static HTML.",                    singleton: false, status: "active", sourceFile: "artifacts/api-server/src/lib/renderer.ts",                   exposedVia: [],                                                                       dependencies: [] },
  { id: "svc-report-generator",   serviceName: "Report Generator",             category: "monitoring",    description: "Generates structured JSON reports for all pipeline phases and stores them locally and to R2.",          singleton: false, status: "active", sourceFile: "artifacts/api-server/src/lib/report-generator.ts",           exposedVia: [],                                                                       dependencies: ["svc-cloud-storage"] },
];

// ─────────────────────────────────────────────────────────────────────────────
// Event Catalogue
// ─────────────────────────────────────────────────────────────────────────────

export const EVENT_CATALOGUE: EventEntry[] = [
  { type: "job-started",           description: "A new pipeline job was created and execution has begun.",                                       category: "orchestration", producedBy: ["master-orchestrator"],               consumedBy: ["pipeline-sse", "job-supervisor"],      payloadShape: "{ jobId, url, goal }",                           supportsFiltering: true  },
  { type: "crawl-started",         description: "The crawl frontier has been initialised and BFS crawling has begun.",                           category: "scraping",      producedBy: ["job-worker", "crawl-frontier"],       consumedBy: ["pipeline-sse"],                        payloadShape: "{ jobId, seedUrl, estimatedPages }",             supportsFiltering: true  },
  { type: "crawl-complete",        description: "All pages have been crawled and the manifest is ready.",                                        category: "scraping",      producedBy: ["job-worker"],                         consumedBy: ["pipeline-sse", "diff-intelligence"],   payloadShape: "{ jobId, pagesScraped, manifestPath }",          supportsFiltering: true  },
  { type: "manifest-generated",    description: "A full crawl manifest has been written to storage.",                                           category: "intelligence",  producedBy: ["manifest-store"],                    consumedBy: ["pipeline-sse"],                        payloadShape: "{ jobId, manifestPath, pageCount }",             supportsFiltering: true  },
  { type: "diff-computed",         description: "A differential comparison against a baseline manifest has been computed.",                      category: "intelligence",  producedBy: ["diff-engine"],                       consumedBy: ["pipeline-sse"],                        payloadShape: "{ jobId, newCount, changedCount, savedBytes }",  supportsFiltering: true  },
  { type: "intelligence-complete", description: "The full intelligence layer (brand, visual, asset, SEO) has finished for this job.",           category: "intelligence",  producedBy: ["diff-intelligence"],                 consumedBy: ["pipeline-sse"],                        payloadShape: "{ jobId, scores }",                              supportsFiltering: true  },
  { type: "design-dna-complete",   description: "Brand DNA and design tokens have been extracted from the scraped site.",                       category: "intelligence",  producedBy: ["brand-dna-engine"],                  consumedBy: ["pipeline-sse", "stencil-selection"],   payloadShape: "{ jobId, palette, typography, spacing }",        supportsFiltering: true  },
  { type: "visual-dna-complete",   description: "Visual DNA (layout fingerprint, density map) has been extracted.",                             category: "intelligence",  producedBy: ["visual-dna-engine"],                 consumedBy: ["pipeline-sse"],                        payloadShape: "{ jobId, layoutHash, densityScore }",            supportsFiltering: true  },
  { type: "stencil-generated",     description: "A stencil template has been selected, assembled, and written to output.",                      category: "generation",    producedBy: ["stencil-assembly-runner"],           consumedBy: ["pipeline-sse"],                        payloadShape: "{ jobId, stencilId, stencilPath }",              supportsFiltering: true  },
  { type: "website-prime-complete",description: "The full Website Prime (generated static site) is ready.",                                     category: "generation",    producedBy: ["website-prime-indexer"],             consumedBy: ["pipeline-sse", "regression-runner"],   payloadShape: "{ jobId, primePath, pageCount, zipPath }",       supportsFiltering: true  },
  { type: "merge-complete",        description: "The D3 merge execution has finished — all files written, rollback package created.",           category: "merge",         producedBy: ["merge-execution-d3"],                consumedBy: ["pipeline-sse"],                        payloadShape: "{ jobId, executionId, mergedFiles, rollbackKey }",supportsFiltering: true  },
  { type: "deployment-plan-ready", description: "The deployment plan has been computed and is awaiting execution approval.",                     category: "deployment",    producedBy: ["deployment-intelligence"],           consumedBy: ["pipeline-sse", "human-override"],      payloadShape: "{ jobId, planId, targets, estimatedDuration }",  supportsFiltering: true  },
  { type: "deployment-complete",   description: "The site has been fully deployed to the configured cloud target.",                             category: "deployment",    producedBy: ["deployment-executor"],               consumedBy: ["pipeline-sse"],                        payloadShape: "{ jobId, deployedUrl, cdnKey, durationMs }",    supportsFiltering: true  },
  { type: "rollback-complete",     description: "A rollback has been executed — the target codebase has been restored from the backup package.",category: "deployment",    producedBy: ["rollback-generator-bm9"],            consumedBy: ["pipeline-sse"],                        payloadShape: "{ jobId, executionId, restoredFiles }",          supportsFiltering: true  },
  { type: "job-complete",          description: "The entire pipeline for this job has finished successfully.",                                   category: "orchestration", producedBy: ["master-orchestrator"],               consumedBy: ["pipeline-sse", "job-supervisor"],      payloadShape: "{ jobId, totalDurationMs, coveragePercent }",   supportsFiltering: true  },
  { type: "job-failed",            description: "The pipeline has terminated in a failure state.",                                              category: "orchestration", producedBy: ["master-orchestrator", "job-worker"], consumedBy: ["pipeline-sse", "failure-classifier"],  payloadShape: "{ jobId, stage, errorMessage, retryCount }",    supportsFiltering: true  },
  { type: "job-cancelled",         description: "The job was cancelled by operator action.",                                                    category: "orchestration", producedBy: ["human-override-engine"],             consumedBy: ["pipeline-sse", "job-supervisor"],      payloadShape: "{ jobId, cancelledBy, reason }",                 supportsFiltering: true  },
  { type: "stage-retrying",        description: "A pipeline stage has failed and is being retried.",                                            category: "recovery",      producedBy: ["autonomous-recovery-engine"],        consumedBy: ["pipeline-sse"],                        payloadShape: "{ jobId, stageId, retryCount, backoffMs }",     supportsFiltering: true  },
  { type: "pipeline-paused",       description: "The pipeline has been paused — either by operator override or by the self-healing orchestrator.", category: "orchestration", producedBy: ["human-override-engine", "self-healing-orchestrator"], consumedBy: ["pipeline-sse"], payloadShape: "{ jobId, pausedBy, reason }",              supportsFiltering: true  },
  { type: "pipeline-resumed",      description: "A paused pipeline has been resumed.",                                                          category: "orchestration", producedBy: ["human-override-engine"],             consumedBy: ["pipeline-sse"],                        payloadShape: "{ jobId, resumedBy }",                           supportsFiltering: true  },
  { type: "approval-requested",    description: "A human-review gate is waiting for operator approval before proceeding.",                      category: "orchestration", producedBy: ["human-review-gate-engine"],          consumedBy: ["pipeline-sse"],                        payloadShape: "{ jobId, stageId, reason, deadline }",           supportsFiltering: true  },
  { type: "approval-granted",      description: "An operator has approved a human-review gate — pipeline will proceed.",                        category: "orchestration", producedBy: ["human-review-gate-engine"],          consumedBy: ["pipeline-sse"],                        payloadShape: "{ jobId, stageId, approvedBy }",                 supportsFiltering: true  },
  { type: "approval-rejected",     description: "An operator has rejected a human-review gate — pipeline will halt.",                           category: "orchestration", producedBy: ["human-review-gate-engine"],          consumedBy: ["pipeline-sse"],                        payloadShape: "{ jobId, stageId, rejectedBy, reason }",         supportsFiltering: true  },
  { type: "decision-made",         description: "The decision engine has resolved an ambiguous pipeline branch point.",                         category: "orchestration", producedBy: ["decision-engine"],                   consumedBy: ["pipeline-sse"],                        payloadShape: "{ jobId, decisionPoint, choice, confidence }",   supportsFiltering: true  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Database Model Catalogue
// ─────────────────────────────────────────────────────────────────────────────

export const DB_MODEL_CATALOGUE: DatabaseModelEntry[] = [
  { tableName: "scrape_jobs",          description: "One row per crawl/scrape job — status, progress, URLs, retry state, and output paths.", primaryKey: "job_id",          keyColumns: ["status", "seed_url", "claimed_by", "created_at"],    featureIds: ["scraper", "job-worker", "scrape-progress"], sourceFile: "lib/db/src/schema/scrape-jobs.ts" },
  { tableName: "manifest_snapshots",   description: "One row per completed scrape job — stores the full crawl manifest JSON for diff/rebuild.", primaryKey: "job_id",        keyColumns: ["schema_version", "updated_at"],                       featureIds: ["manifest-store", "diff-intelligence"],      sourceFile: "lib/db/src/schema/scrape-jobs.ts" },
  { tableName: "differential_history", description: "One row per differential crawl run — stores change counts, bandwidth savings, and hotspot data.", primaryKey: "id",       keyColumns: ["job_id", "base_job_id", "computed_at"],              featureIds: ["diff-intelligence", "incremental-regen-c1"],sourceFile: "lib/db/src/schema/scrape-jobs.ts" },
  { tableName: "generation_reports",   description: "One row per generation pipeline run — stores the full C1 construction report JSON.", primaryKey: "job_id",              keyColumns: ["status", "stencil_id", "generated_at"],              featureIds: ["generation-runner", "stencil-assembly"],    sourceFile: "lib/db/src/schema/generation-reports.ts" },
  { tableName: "construction_reports", description: "One row per Phase C3 construction run — stores audit JSON, page counts, and site ZIP cloud path.", primaryKey: "job_id", keyColumns: ["status", "completeness_score", "constructed_at"],   featureIds: ["construction-runner", "certification-c6"],  sourceFile: "lib/db/src/schema/construction-reports.ts" },
  { tableName: "orchestration_jobs",   description: "One row per orchestration intent — goal, execution plan (JSONB), and stage progression.", primaryKey: "orchestration_id", keyColumns: ["url", "goal", "status", "created_at"],              featureIds: ["pipeline-orchestrator"],                    sourceFile: "lib/db/src/schema/orchestration-jobs.ts" },
  { tableName: "merge_executions",     description: "One row per D3 merge execution — outcome flags, operation counts, and R2 keys for the 3 merge JSON reports.", primaryKey: "execution_id", keyColumns: ["prime_path", "target_path", "is_merge_complete", "created_at"], featureIds: ["merge-execution-d3", "rollback-generator-bm9"], sourceFile: "lib/db/src/schema/merge-executions.ts" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Widget Catalogue
// ─────────────────────────────────────────────────────────────────────────────

export const WIDGET_CATALOGUE: WidgetEntry[] = [
  { id: "widget-health-badge",           widgetType: "status-badge",   title: "API Health",                  description: "Green/red badge — polls /api/healthz every 30s.",                           featureId: "health-check",             dataSource: "/api/healthz",                     refreshMode: "poll",  refreshIntervalMs: 30_000  },
  { id: "widget-job-table",              widgetType: "table",          title: "Active Jobs",                 description: "Table of all pipeline jobs with status, URL, stage, and elapsed time.",      featureId: "job-list",                 dataSource: "/api/orchestrate",                 refreshMode: "sse",   refreshIntervalMs: undefined },
  { id: "widget-job-timeline",           widgetType: "timeline",       title: "Job Stage Timeline",          description: "Per-job stage progression — click any job row to expand.",                    featureId: "job-detail",               dataSource: "/api/orchestrate/:jobId",          refreshMode: "sse"   },
  { id: "widget-start-job",             widgetType: "control-panel",  title: "Start New Reconstruction",    description: "URL input + submit — POST /api/orchestrate and stream progress.",              featureId: "pipeline-orchestrator",    dataSource: "/api/orchestrate",                 refreshMode: "sse"   },
  { id: "widget-global-sse",            widgetType: "sse-stream",     title: "Live Event Stream",           description: "All pipeline events in real time — filterable by type and jobId.",             featureId: "pipeline-sse-global",      dataSource: "/api/pipeline-sse",                refreshMode: "sse"   },
  { id: "widget-scrape-progress",       widgetType: "progress-bar",   title: "Scrape Progress",             description: "Articles scraped / total with % complete bar — auto-refreshes.",              featureId: "scrape-progress",          dataSource: "/api/scrape-progress/:scrapeJobId", refreshMode: "poll", refreshIntervalMs: 3_000 },
  { id: "widget-supervisor-report",     widgetType: "control-panel",  title: "Job Supervisor",              description: "Live supervisor state — tracked jobs, anomalies, cycle controls.",             featureId: "job-supervisor",           dataSource: "/api/supervisor/report",           refreshMode: "poll",  refreshIntervalMs: 10_000 },
  { id: "widget-worker-list",           widgetType: "table",          title: "Worker Status",               description: "All tracked workers and their state — pause/resume controls.",                 featureId: "job-dashboard-api",        dataSource: "/api/supervisor/workers",          refreshMode: "poll",  refreshIntervalMs: 10_000 },
  { id: "widget-failure-table",         widgetType: "table",          title: "Failure Classifications",     description: "All classified failures with type, retry recommendation, and retry count.",   featureId: "failure-classifier",       dataSource: "/api/supervisor/failures",         refreshMode: "poll",  refreshIntervalMs: 15_000 },
  { id: "widget-retry-recommendations", widgetType: "metric-card",    title: "Retry Recommendations",       description: "Counts of retry-immediately, retry-with-backoff, do-not-retry.",              featureId: "failure-classifier",       dataSource: "/api/supervisor/failures/retry",   refreshMode: "poll",  refreshIntervalMs: 15_000 },
  { id: "widget-recovery-report",       widgetType: "control-panel",  title: "Recovery Engine",             description: "Recovery report with manual trigger and cancel-retry controls.",               featureId: "autonomous-recovery",      dataSource: "/api/recovery/report",             refreshMode: "poll",  refreshIntervalMs: 15_000 },
  { id: "widget-checkpoint-table",      widgetType: "table",          title: "Active Checkpoints",          description: "All in-flight checkpoints — stage, last saved, reset control.",               featureId: "checkpoint-engine",        dataSource: "/api/checkpoint",                  refreshMode: "poll",  refreshIntervalMs: 20_000 },
  { id: "widget-feature-registry",      widgetType: "table",          title: "Feature Registry",            description: "Complete platform capability catalogue — searchable and filterable.",         featureId: "platform-features",        dataSource: "/api/platform/features",           refreshMode: "static" },
  { id: "widget-route-catalogue",       widgetType: "table",          title: "API Routes",                  description: "All API routes with method, path, SSE flag, and feature link.",               featureId: "platform-routes",          dataSource: "/api/platform/routes",             refreshMode: "static" },
  { id: "widget-worker-catalogue",      widgetType: "table",          title: "Background Workers",          description: "All registered workers with trigger mode, interval, and output artefacts.",    featureId: "platform-workers",         dataSource: "/api/platform/workers",            refreshMode: "static" },
  { id: "widget-event-catalogue",       widgetType: "table",          title: "Event Catalogue",             description: "All 24 pipeline event types with producers, consumers, and payload shapes.",   featureId: "platform-events",          dataSource: "/api/platform/events",             refreshMode: "static" },
  { id: "widget-service-catalogue",     widgetType: "table",          title: "Service Catalogue",           description: "All internal services — singleton status, source file, and dependencies.",   featureId: "platform-services",        dataSource: "/api/platform/services",           refreshMode: "static" },
  { id: "widget-widget-catalogue",      widgetType: "table",          title: "Widget Catalogue",            description: "All dashboard widgets — type, data source, and refresh strategy.",           featureId: "platform-widgets",         dataSource: "/api/platform/widgets",            refreshMode: "static" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Registry summary (for the overview response)
// ─────────────────────────────────────────────────────────────────────────────

export function getRegistrySummary() {
  const byCategory: Record<string, number> = {};
  for (const f of FEATURE_REGISTRY) {
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
  }

  const byStatus: Record<string, number> = {};
  for (const f of FEATURE_REGISTRY) {
    byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
  }

  return {
    generatedAt:    new Date().toISOString(),
    totalFeatures:  FEATURE_REGISTRY.length,
    totalRoutes:    ROUTE_CATALOGUE.length,
    totalWorkers:   WORKER_CATALOGUE.length,
    totalServices:  SERVICE_CATALOGUE.length,
    totalEvents:    EVENT_CATALOGUE.length,
    totalDbModels:  DB_MODEL_CATALOGUE.length,
    totalWidgets:   WIDGET_CATALOGUE.length,
    byCategory,
    byStatus,
    sseRoutes:      ROUTE_CATALOGUE.filter((r) => r.supportsSSE).map((r) => r.path),
    controlFeatures: FEATURE_REGISTRY.filter((f) => f.supportsControls).map((f) => f.id),
    liveFeatures:   FEATURE_REGISTRY.filter((f) => f.supportsLiveUpdates).map((f) => f.id),
  };
}
