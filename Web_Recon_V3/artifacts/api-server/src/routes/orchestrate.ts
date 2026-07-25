import { Router, type IRouter } from "express";
import { createJob, runPipeline, getJob, listJobs } from "../lib/master-orchestrator.js";
import {
  findResumableJobs,
  buildResumeJob,
} from "../lib/pipeline-resume.js";
import {
  normalizeDomain,
  lookupWebsiteMemory,
  deleteWebsiteMemory,
} from "../lib/website-memory.js";
import { getDefaultCloudProvider } from "../cloud/index.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /orchestrate — start a new pipeline job
// ---------------------------------------------------------------------------
router.post("/orchestrate", async (req, res, next) => {
  try {
    const { url, baseJobId, coverageThreshold } = req.body as Record<string, unknown>;

    if (typeof url !== "string" || !url.startsWith("http")) {
      res.status(400).json({ error: "url is required and must be a valid HTTP/S URL" });
      return;
    }

    const threshold = typeof coverageThreshold === "number"
      ? coverageThreshold
      : typeof coverageThreshold === "string"
        ? parseInt(coverageThreshold, 10)
        : 96;

    if (isNaN(threshold) || threshold < 0 || threshold > 100) {
      res.status(400).json({ error: "coverageThreshold must be a number between 0 and 100" });
      return;
    }

    const job = createJob({
      url:               url,
      baseJobId:         typeof baseJobId === "string" ? baseJobId : null,
      coverageThreshold: threshold,
    });

    res.status(202).json({
      jobId:             job.id,
      url:               job.url,
      coverageThreshold: job.coverageThreshold,
      status:            job.status,
      startedAt:         job.startedAt,
    });

    runPipeline(job).catch((err: unknown) => {
      req.log.error({ err, jobId: job.id }, "orchestrate: unhandled pipeline error");
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /orchestrate/:jobId/resume — resume from last checkpoint
// ---------------------------------------------------------------------------
router.post("/orchestrate/:jobId/resume", async (req, res, next) => {
  try {
    const { jobId } = req.params;

    const existing = getJob(jobId);
    if (existing && (existing.status === "running")) {
      res.status(409).json({ error: "Job is currently running — cannot resume a live job" });
      return;
    }

    const { job, resumeFromStage } = await buildResumeJob(jobId);

    if (!resumeFromStage) {
      res.status(200).json({
        jobId,
        message: "All stages already complete — nothing to resume",
        completedStages: job.completedStages,
      });
      return;
    }

    res.status(202).json({
      jobId,
      url:             job.url,
      status:          "resuming",
      resumeFromStage,
      completedStages: job.completedStages,
      skippedStages:   job.skippedStages,
    });

    runPipeline(job).catch((err: unknown) => {
      req.log.error({ err, jobId }, "orchestrate/resume: unhandled pipeline error");
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /orchestrate/:jobId/restart — force a completely fresh crawl
// ---------------------------------------------------------------------------
router.post("/orchestrate/:jobId/restart", async (req, res, next) => {
  try {
    const sourceJob = getJob(req.params.jobId);
    if (!sourceJob) {
      res.status(404).json({ error: "Source job not found" });
      return;
    }

    if (sourceJob.status === "running") {
      res.status(409).json({ error: "Source job is still running — cancel it first" });
      return;
    }

    // Create a completely fresh job for the same URL
    const newJob = createJob({
      url:               sourceJob.url,
      baseJobId:         null,
      coverageThreshold: sourceJob.coverageThreshold,
    });

    res.status(202).json({
      jobId:        newJob.id,
      sourceJobId:  sourceJob.id,
      url:          newJob.url,
      status:       newJob.status,
      startedAt:    newJob.startedAt,
      message:      "Fresh crawl started — no stages will be skipped",
    });

    runPipeline(newJob).catch((err: unknown) => {
      req.log.error({ err, jobId: newJob.id }, "orchestrate/restart: unhandled pipeline error");
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /orchestrate/resumable — list jobs that can be resumed
// ---------------------------------------------------------------------------
router.get("/orchestrate/resumable", async (req, res, next) => {
  try {
    const jobs = await findResumableJobs();
    res.json({ total: jobs.length, jobs });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /orchestrate/memory/:domain — look up website memory
// ---------------------------------------------------------------------------
router.get("/orchestrate/memory/:domain", async (req, res, next) => {
  try {
    const cloud  = getDefaultCloudProvider();
    const domain = decodeURIComponent(req.params.domain);
    // Accept either a raw domain or a full URL
    const normalized = domain.startsWith("http") ? normalizeDomain(domain) : domain;

    const memory = await lookupWebsiteMemory(
      `https://${normalized}`,
      cloud
    );

    if (!memory) {
      res.status(404).json({ found: false, domain: normalized, message: "No website memory found" });
      return;
    }

    res.json({ found: true, domain: normalized, memory });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /orchestrate/memory/:domain — delete website memory (force fresh)
// ---------------------------------------------------------------------------
router.delete("/orchestrate/memory/:domain", async (req, res, next) => {
  try {
    const cloud  = getDefaultCloudProvider();
    const domain = decodeURIComponent(req.params.domain);
    const normalized = domain.startsWith("http") ? normalizeDomain(domain) : domain;

    const result = await deleteWebsiteMemory(normalized, cloud);
    res.json({ ...result, message: result.deleted ? "Website memory deleted — next crawl will start fresh" : "Nothing to delete" });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /orchestrate/:jobId
// ---------------------------------------------------------------------------
router.get("/orchestrate/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(job);
});

// ---------------------------------------------------------------------------
// GET /orchestrate
// ---------------------------------------------------------------------------
router.get("/orchestrate", (_req, res) => {
  res.json(listJobs());
});

export default router;
