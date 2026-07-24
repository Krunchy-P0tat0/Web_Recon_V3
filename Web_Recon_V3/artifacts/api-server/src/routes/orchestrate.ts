import { Router, type IRouter } from "express";
import { createJob, runPipeline, getJob, listJobs } from "../lib/master-orchestrator.js";

const router: IRouter = Router();

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

router.get("/orchestrate/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(job);
});

router.get("/orchestrate", (_req, res) => {
  res.json(listJobs());
});

export default router;
