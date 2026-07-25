import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  bigint,
} from "drizzle-orm/pg-core";

export const scrapeJobsTable = pgTable("scrape_jobs", {
  jobId: text("job_id").primaryKey(),
  seedUrl: text("seed_url").notNull(),
  status: text("status").notNull().default("queued"),
  totalArticles: integer("total_articles").notNull().default(0),
  completedArticles: integer("completed_articles").notNull().default(0),
  includeImages: boolean("include_images").notNull().default(false),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(3),
  errorMessage: text("error_message"),
  currentArticle: text("current_article"),
  zipPath: text("zip_path"),
  downloadUrl: text("download_url"),
  articlesJson: text("articles_json").notNull().default("[]"),
  claimedBy: text("claimed_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  claimedAt: timestamp("claimed_at"),
  completedAt: timestamp("completed_at"),
  /** When true, this job was submitted as a differential crawl against a baseline job. */
  diffMode: boolean("diff_mode").notNull().default(false),
  /** jobId of the baseline job this diff was computed against (null for full crawls). */
  baseJobId: text("base_job_id"),
  /** When true, the worker runs a full-site BFS crawl before scraping (crawlAllPages=true). */
  crawlAllPages: boolean("crawl_all_pages").notNull().default(false),
  /** Minimum coverage ratio (0–1) required before stencil/rebuild phase. 0 = no gate. */
  coverageThreshold: integer("coverage_threshold").notNull().default(0),
});

export const manifestSnapshotsTable = pgTable("manifest_snapshots", {
  jobId: text("job_id")
    .primaryKey()
    .references(() => scrapeJobsTable.jobId, { onDelete: "cascade" }),
  manifestJson: text("manifest_json").notNull(),
  schemaVersion: text("schema_version").notNull().default("1.0"),
  renderSource: text("render_source"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ScrapeJobRecord = typeof scrapeJobsTable.$inferSelect;
export type InsertScrapeJob = typeof scrapeJobsTable.$inferInsert;

// ---------------------------------------------------------------------------
// differential_history — one row per completed differential crawl run
// ---------------------------------------------------------------------------

export const differentialHistoryTable = pgTable("differential_history", {
  id: text("id").primaryKey(),
  jobId: text("job_id")
    .notNull()
    .references(() => scrapeJobsTable.jobId, { onDelete: "cascade" }),
  baseJobId: text("base_job_id"),
  seedUrl: text("seed_url").notNull(),
  computedAt: timestamp("computed_at").notNull(),
  pagesScanned: integer("pages_scanned").notNull().default(0),
  newCount: integer("new_count").notNull().default(0),
  changedCount: integer("changed_count").notNull().default(0),
  unchangedCount: integer("unchanged_count").notNull().default(0),
  deletedCount: integer("deleted_count").notNull().default(0),
  bandwidthSavedBytes: bigint("bandwidth_saved_bytes", { mode: "number" }).notNull().default(0),
  storageSavedBytes: bigint("storage_saved_bytes", { mode: "number" }).notNull().default(0),
  processingTimeSavedMs: bigint("processing_time_saved_ms", { mode: "number" }).notNull().default(0),
  skipRatePercent: integer("skip_rate_percent").notNull().default(0),
  /** Compact JSON: Array<{url, classification, changeReasons}> — used for hotspot analysis */
  changedUrlsJson: text("changed_urls_json").notNull().default("[]"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type DiffHistoryRecord = typeof differentialHistoryTable.$inferSelect;
export type InsertDiffHistory = typeof differentialHistoryTable.$inferInsert;
