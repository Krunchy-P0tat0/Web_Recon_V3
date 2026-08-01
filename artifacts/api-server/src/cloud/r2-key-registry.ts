/**
 * r2-key-registry.ts — Canonical R2 storage path registry (Phase D3.4)
 *
 * Every R2 object key used by the platform must originate here.
 * No module may construct R2 paths by string concatenation outside this file.
 *
 * Hierarchy:
 *   job-set-{jobId}/
 *     raw/              downloaded HTML, headers, metadata, discovered URLs
 *     assets/           CSS, JS, images, fonts, SVG, video
 *     normalized/       DOM JSON, CSS JSON, JS JSON, asset maps
 *     manifest/         manifest.json (authoritative artifact index)
 *     differential/     changed.json, unchanged.json, deleted.json, new.json
 *     visual-dna/       extracted layouts, design tokens, color systems
 *     brand-dna/        typography, spacing, branding
 *     website-prime/    website-prime.zip, site.zip, preview pages
 *     certification/    certification-report.json
 *     checkpoints/      checkpoint-NNN.json, latest.json
 *     logs/             pipeline.log, recovery.log, retry.log
 *     reports/          crawl-summary.json, execution-summary.json
 *     stages/           {stageId}.json — per-stage result snapshots
 */

export const R2Keys = {
  /** Root prefix for all artifacts belonging to a job. */
  jobPrefix: (jobId: string) => `job-set-${jobId}/`,

  raw: {
    prefix:        (jobId: string) => `job-set-${jobId}/raw/`,
    pages:         (jobId: string) => `job-set-${jobId}/raw/pages.json`,
    headers:       (jobId: string) => `job-set-${jobId}/raw/headers.json`,
    metadata:      (jobId: string) => `job-set-${jobId}/raw/metadata.json`,
    discoveredUrls:(jobId: string) => `job-set-${jobId}/raw/discovered-urls.json`,
  },

  assets: {
    prefix: (jobId: string) => `job-set-${jobId}/assets/`,
  },

  normalized: {
    prefix:   (jobId: string) => `job-set-${jobId}/normalized/`,
    domJson:  (jobId: string) => `job-set-${jobId}/normalized/dom.json`,
    cssJson:  (jobId: string) => `job-set-${jobId}/normalized/css.json`,
    jsJson:   (jobId: string) => `job-set-${jobId}/normalized/js.json`,
    assetMap: (jobId: string) => `job-set-${jobId}/normalized/asset-map.json`,
  },

  manifest: {
    index:  (jobId: string) => `job-set-${jobId}/manifest/manifest.json`,
    schema: (jobId: string) => `job-set-${jobId}/manifest/schema-version.json`,
  },

  differential: {
    prefix:    (jobId: string) => `job-set-${jobId}/differential/`,
    changed:   (jobId: string) => `job-set-${jobId}/differential/changed.json`,
    unchanged: (jobId: string) => `job-set-${jobId}/differential/unchanged.json`,
    deleted:   (jobId: string) => `job-set-${jobId}/differential/deleted.json`,
    new:       (jobId: string) => `job-set-${jobId}/differential/new.json`,
  },

  visualDna: {
    prefix:       (jobId: string) => `job-set-${jobId}/visual-dna/`,
    layouts:      (jobId: string) => `job-set-${jobId}/visual-dna/layouts.json`,
    designTokens: (jobId: string) => `job-set-${jobId}/visual-dna/design-tokens.json`,
    colorSystems: (jobId: string) => `job-set-${jobId}/visual-dna/color-systems.json`,
  },

  brandDna: {
    prefix:     (jobId: string) => `job-set-${jobId}/brand-dna/`,
    typography: (jobId: string) => `job-set-${jobId}/brand-dna/typography.json`,
    spacing:    (jobId: string) => `job-set-${jobId}/brand-dna/spacing.json`,
    branding:   (jobId: string) => `job-set-${jobId}/brand-dna/branding.json`,
  },

  websitePrime: {
    prefix:  (jobId: string) => `job-set-${jobId}/website-prime/`,
    zip:     (jobId: string) => `job-set-${jobId}/website-prime/website-prime.zip`,
    siteZip: (jobId: string) => `job-set-${jobId}/website-prime/site.zip`,
    preview: (jobId: string) => `job-set-${jobId}/website-prime/preview/`,
    index:   (jobId: string) => `job-set-${jobId}/website-prime/index.html`,
  },

  certification: {
    report: (jobId: string) => `job-set-${jobId}/certification/certification-report.json`,
  },

  checkpoints: {
    prefix:   (jobId: string) => `job-set-${jobId}/checkpoints/`,
    latest:   (jobId: string) => `job-set-${jobId}/checkpoints/latest.json`,
    numbered: (jobId: string, n: number) =>
      `job-set-${jobId}/checkpoints/checkpoint-${String(n).padStart(3, "0")}.json`,
  },

  logs: {
    prefix:   (jobId: string) => `job-set-${jobId}/logs/`,
    pipeline: (jobId: string) => `job-set-${jobId}/logs/pipeline.log`,
    recovery: (jobId: string) => `job-set-${jobId}/logs/recovery.log`,
    retry:    (jobId: string) => `job-set-${jobId}/logs/retry.log`,
  },

  reports: {
    prefix:          (jobId: string) => `job-set-${jobId}/reports/`,
    crawlSummary:    (jobId: string) => `job-set-${jobId}/reports/crawl-summary.json`,
    executionSummary:(jobId: string) => `job-set-${jobId}/reports/execution-summary.json`,
  },

  stages: {
    prefix: (jobId: string) => `job-set-${jobId}/stages/`,
    result: (jobId: string, stage: string) => `job-set-${jobId}/stages/${stage}.json`,
  },

  orchestration: {
    engine: "orchestration/orchestration-engine.json",
    audit:  "orchestration/orchestration-audit.json",
  },

  /**
   * Phase D4.1 — Persistent Website Intelligence Memory (PWIM)
   *
   * All website-scoped memory lives under websites/{canonicalDomain}/.
   * The canonicalDomain is the stripped hostname (no www., no protocol),
   * e.g. "colincowie.com". It contains only [a-z0-9.-] chars — all valid
   * in R2 / S3 object keys.
   *
   * Job-scoped artifacts (jobs/{jobId}/…) remain unchanged — the website
   * memory layer is an additive cross-job intelligence layer and does NOT
   * migrate or delete existing job-scoped keys.
   */
  websites: {
    /** Root prefix for all memory artifacts for a website. */
    prefix:      (domain: string) => `websites/${domain}/`,

    /** Canonical versioned memory manifest — the PWIM source of truth. */
    memory:      (domain: string) => `websites/${domain}/memory.json`,

    /** Per-stage pipeline output snapshots. */
    pipeline: {
      prefix:  (domain: string) => `websites/${domain}/pipeline/`,
      stage:   (domain: string, stageId: string) => `websites/${domain}/pipeline/${stageId}.json`,
    },

    /** Checkpoint files referenced by knowledgeModules[].checksum. */
    checkpoints: {
      prefix:  (domain: string) => `websites/${domain}/checkpoints/`,
      file:    (domain: string, name: string) => `websites/${domain}/checkpoints/${name}`,
    },

    /** Crawl manifests (page coverage, link graph). */
    manifests: {
      prefix:  (domain: string) => `websites/${domain}/manifests/`,
      file:    (domain: string, name: string) => `websites/${domain}/manifests/${name}`,
    },

    /** Asset cache (CSS, JS, images, fonts). */
    assets: {
      prefix:  (domain: string) => `websites/${domain}/assets/`,
    },

    /** Normalized DOM/CSS/JS JSON output. */
    normalized: {
      prefix:  (domain: string) => `websites/${domain}/normalized/`,
      file:    (domain: string, name: string) => `websites/${domain}/normalized/${name}`,
    },

    /** BFS crawl frontier state snapshots. */
    frontier: {
      prefix:  (domain: string) => `websites/${domain}/frontier/`,
      state:   (domain: string) => `websites/${domain}/frontier/state.json`,
    },

    /** Per-URL retry logs and failure records. */
    retries: {
      prefix:  (domain: string) => `websites/${domain}/retries/`,
      log:     (domain: string) => `websites/${domain}/retries/retry.log`,
    },

    /** Execution history snapshots (one per pipeline run). */
    history: {
      prefix:  (domain: string) => `websites/${domain}/history/`,
      run:     (domain: string, jobId: string) => `websites/${domain}/history/${jobId}.json`,
    },

    /** Quality and fidelity metrics over time. */
    metrics: {
      prefix:  (domain: string) => `websites/${domain}/metrics/`,
      latest:  (domain: string) => `websites/${domain}/metrics/latest.json`,
    },
  },
} as const;

/** Extract jobId from a job-set key, or null if not a job-set key. */
export function jobIdFromKey(key: string): string | null {
  const m = key.match(/^job-set-([^/]+)\//);
  return m ? (m[1] ?? null) : null;
}

/** Return true if the key is inside a given job's prefix. */
export function keyBelongsToJob(key: string, jobId: string): boolean {
  return key.startsWith(`job-set-${jobId}/`);
}
