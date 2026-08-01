import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Phase F — Orchestration Job State Machine
//
// orchestration_jobs is the top-level record representing a user intent:
//   "Given this URL and goal, run the right pipeline automatically."
//
// The orchestrator is the single entry point. It decides which modules fire
// (crawl, diff, analyze, generate, merge, deploy) and drives them in order.
// ---------------------------------------------------------------------------

export type OrchestrationGoal =
  | "clone_site"          // crawl → analyze → generate → deploy
  | "merge_into_backend"  // crawl → diff → analyze → generate → merge → deploy
  | "update_existing";    // crawl → diff → analyze → generate → deploy

export type OrchestrationStatus =
  | "discovering"   // validating URL, planning execution
  | "crawling"      // submitting + waiting on scrape job
  | "diffing"       // running differential analysis vs base job
  | "analyzing"     // running intelligence + generation pipeline
  | "generating"    // running construction pipeline
  | "merging"       // running merge execution engine
  | "deploying"     // running deployment executor
  | "complete"      // all stages finished successfully
  | "failed";       // terminal failure

export type OrchestrationStageStatus = "pending" | "running" | "complete" | "skipped" | "failed";

export interface ExecutionStage {
  name: OrchestrationStatus;
  status: OrchestrationStageStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface ExecutionPlan {
  goal: OrchestrationGoal;
  stages: ExecutionStage[];
  reasoning: string;
}

export const orchestrationJobsTable = pgTable("orchestration_jobs", {
  orchestrationId: text("orchestration_id").primaryKey(),
  url: text("url").notNull(),
  goal: text("goal").notNull().$type<OrchestrationGoal>(),
  status: text("status").notNull().default("discovering").$type<OrchestrationStatus>(),

  executionPlan: jsonb("execution_plan").$type<ExecutionPlan>(),

  underlyingJobId: text("underlying_job_id"),
  baseJobId: text("base_job_id"),

  errorMessage: text("error_message"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

export type OrchestrationJobRecord = typeof orchestrationJobsTable.$inferSelect;
export type InsertOrchestrationJob = typeof orchestrationJobsTable.$inferInsert;
