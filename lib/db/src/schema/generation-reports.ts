import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { scrapeJobsTable } from "./scrape-jobs";

// ---------------------------------------------------------------------------
// generation_reports — one row per job, created when the generation pipeline
// runs automatically after a scrape job completes (Phase C1).
// ---------------------------------------------------------------------------

export const generationReportsTable = pgTable("generation_reports", {
  jobId: text("job_id")
    .primaryKey()
    .references(() => scrapeJobsTable.jobId, { onDelete: "cascade" }),
  reportJson: text("report_json").notNull(),
  status: text("status").notNull().default("pending"),
  generatedAt: timestamp("generated_at"),
  durationMs: integer("duration_ms"),
  stencilId: text("stencil_id"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type GenerationReportRecord = typeof generationReportsTable.$inferSelect;
export type InsertGenerationReport = typeof generationReportsTable.$inferInsert;
