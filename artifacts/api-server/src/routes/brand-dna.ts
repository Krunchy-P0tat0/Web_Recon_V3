/**
 * brand-dna.ts — QA-1: Brand DNA REST Routes
 *
 *   GET  /api/brand-dna/report               — latest cached report (any job)
 *   POST /api/brand-dna/:jobId/extract        — run brand DNA extraction
 *   GET  /api/brand-dna/:jobId               — full CanonicalBrandDNA document
 *   GET  /api/brand-dna/:jobId/report         — full BrandDNAReport
 *   GET  /api/brand-dna/:jobId/identity       — identity sub-document
 *   GET  /api/brand-dna/:jobId/voice          — voice sub-document
 *   GET  /api/brand-dna/:jobId/palette        — palette sub-document
 *   GET  /api/brand-dna/:jobId/motion         — motion sub-document
 */

import { Router, type IRouter } from "express";
import {
  extractBrandDNA,
  getCachedReport,
  listReports,
} from "../lib/brand-dna-engine.js";

const router: IRouter = Router();

// GET /brand-dna/report  — latest cached (any job)
router.get("/brand-dna/report", async (_req, res): Promise<void> => {
  const all = listReports();
  if (all.length > 0) {
    res.json(all[0]);
    return;
  }
  res.status(404).json({
    error: "No brand-dna report found.",
    hint:  "POST /api/brand-dna/:jobId/extract to generate one.",
  });
});

// POST /brand-dna/:jobId/extract  { seedUrl }
router.post("/brand-dna/:jobId/extract", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };
  const seedUrl: string = req.body?.seedUrl ?? `https://unknown-${jobId}.example.com`;

  try {
    const report = await extractBrandDNA(jobId, seedUrl);
    res.status(201).json(report);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /brand-dna/:jobId
router.get("/brand-dna/:jobId", (req, res): void => {
  const { jobId } = req.params as { jobId: string };
  const report = getCachedReport(jobId);
  if (!report) {
    res.status(404).json({
      error: `No brand DNA found for jobId "${jobId}".`,
      hint:  `POST /api/brand-dna/${jobId}/extract to generate one.`,
    });
    return;
  }
  res.json(report.brandDna);
});

// GET /brand-dna/:jobId/report
router.get("/brand-dna/:jobId/report", (req, res): void => {
  const { jobId } = req.params as { jobId: string };
  const report = getCachedReport(jobId);
  if (!report) {
    res.status(404).json({
      error: `No brand-dna report found for jobId "${jobId}".`,
      hint:  `POST /api/brand-dna/${jobId}/extract to generate one.`,
    });
    return;
  }
  res.json(report);
});

// GET /brand-dna/:jobId/identity
router.get("/brand-dna/:jobId/identity", (req, res): void => {
  const { jobId } = req.params as { jobId: string };
  const report = getCachedReport(jobId);
  if (!report) {
    res.status(404).json({ error: `No brand DNA found for jobId "${jobId}".` });
    return;
  }
  res.json({ jobId, identity: report.brandDna.identity });
});

// GET /brand-dna/:jobId/voice
router.get("/brand-dna/:jobId/voice", (req, res): void => {
  const { jobId } = req.params as { jobId: string };
  const report = getCachedReport(jobId);
  if (!report) {
    res.status(404).json({ error: `No brand DNA found for jobId "${jobId}".` });
    return;
  }
  res.json({ jobId, voice: report.brandDna.voice });
});

// GET /brand-dna/:jobId/palette
router.get("/brand-dna/:jobId/palette", (req, res): void => {
  const { jobId } = req.params as { jobId: string };
  const report = getCachedReport(jobId);
  if (!report) {
    res.status(404).json({ error: `No brand DNA found for jobId "${jobId}".` });
    return;
  }
  res.json({ jobId, palette: report.brandDna.palette });
});

// GET /brand-dna/:jobId/motion
router.get("/brand-dna/:jobId/motion", (req, res): void => {
  const { jobId } = req.params as { jobId: string };
  const report = getCachedReport(jobId);
  if (!report) {
    res.status(404).json({ error: `No brand DNA found for jobId "${jobId}".` });
    return;
  }
  res.json({ jobId, motion: report.brandDna.motion });
});

export default router;
