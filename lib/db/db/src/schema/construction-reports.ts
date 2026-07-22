import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { scrapeJobsTable } from "./scrape-jobs";

// ---------------------------------------------------------------------------
// construction_reports — one row per job, created when Phase C3 runs.
// Stores the full construction audit JSON and lightweight status fields.
// ---------------------------------------------------------------------------

export const constructionReportsTable = pgTable("construction_reports", {
  jobId: text("job_id")
    .primaryKey()
    .references(() => scrapeJobsTable.jobId, { onDelete: "cascade" }),
  auditJson: text("audit_json").notNull(),
  status: text("status").notNull().default("pending"),
  constructedAt: timestamp("constructed_at"),
  durationMs: integer("duration_ms"),
  stencilId: text("stencil_id"),
  completenessScore: integer("completeness_score"),
  totalPages: integer("total_pages"),
  renderedPages: integer("rendered_pages"),
  errorMessage: text("error_message"),
  siteZipCloudPath: text("site_zip_cloud_path"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ConstructionReportRecord = typeof constructionReportsTable.$inferSelect;
export type InsertConstructionReport = typeof constructionReportsTable.$inferInsert;
