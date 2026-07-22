/**
 * seo-intelligence-c4.ts — Phase C4 Routes
 *
 * POST /seo-intelligence/analyze                              — run C4 for a jobId
 * GET  /seo-intelligence                                      — list all C4 analyses
 * GET  /seo-intelligence/:jobId                               — full C4 bundle
 * GET  /seo-intelligence/:jobId/seo-report                    — seo-report.json
 * GET  /seo-intelligence/:jobId/structured-data-report        — structured-data-report.json
 * GET  /seo-intelligence/:jobId/metadata-report               — metadata-report.json
 * GET  /seo-intelligence/:jobId/search-readiness-report       — search-readiness-report.json
 * GET  /seo-intelligence/:jobId/sitemap.xml                   — sitemap.xml (raw XML)
 * GET  /seo-intelligence/:jobId/robots.txt                    — robots.txt (raw text)
 */

import { Router, type IRouter } from "express";
import {
  runSeoIntelligence,
  getC4Bundle,
  listC4Bundles,
} from "../lib/seo-intelligence-engine-c4.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /seo-intelligence/analyze
// ---------------------------------------------------------------------------
router.post("/seo-intelligence/analyze", async (req, res): Promise<void> => {
  const { jobId } = req.body ?? {};

  if (!jobId || typeof jobId !== "string") {
    res.status(400).json({ error: "jobId (string) is required in the request body" });
    return;
  }

  try {
    const bundle = await runSeoIntelligence({ jobId });
    res.status(200).json({
      jobId:            bundle.jobId,
      generatedAt:      bundle.generatedAt,
      r2Keys:           bundle.r2Keys,
      overallScore:     bundle.searchReadinessReport.overallScore,
      overallRating:    bundle.searchReadinessReport.overallRating,
      pagesAnalyzed:    bundle.seoReport.pagesAnalyzed,
      indexablePages:   bundle.seoReport.indexablePages,
      sitemapUrlCount:  bundle.searchReadinessReport.sitemap.urlCount,
      criticalIssues:   bundle.seoReport.issues.critical,
      warnings:         bundle.seoReport.issues.warning,
      coverage:         bundle.metadataReport.coverage,
      recommendations:  bundle.searchReadinessReport.recommendations.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("manifest not found") || msg.includes("no page nodes")) {
      res.status(404).json({ error: msg });
      return;
    }
    req.log.error({ err, jobId }, "C4: analysis failed");
    res.status(500).json({ error: "SEO intelligence analysis failed", detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /seo-intelligence
// ---------------------------------------------------------------------------
router.get("/seo-intelligence", (_req, res): void => {
  res.status(200).json(listC4Bundles());
});

// ---------------------------------------------------------------------------
// GET /seo-intelligence/:jobId — full bundle
// ---------------------------------------------------------------------------
router.get("/seo-intelligence/:jobId", (req, res): void => {
  const bundle = getC4Bundle(req.params.jobId!);
  if (!bundle) { res.status(404).json({ error: `No C4 analysis found for jobId "${req.params.jobId}"` }); return; }
  res.status(200).json(bundle);
});

// ---------------------------------------------------------------------------
// GET /seo-intelligence/:jobId/seo-report
// ---------------------------------------------------------------------------
router.get("/seo-intelligence/:jobId/seo-report", (req, res): void => {
  const bundle = getC4Bundle(req.params.jobId!);
  if (!bundle) { res.status(404).json({ error: `No C4 analysis found for jobId "${req.params.jobId}"` }); return; }
  res.status(200).json(bundle.seoReport);
});

// ---------------------------------------------------------------------------
// GET /seo-intelligence/:jobId/structured-data-report
// ---------------------------------------------------------------------------
router.get("/seo-intelligence/:jobId/structured-data-report", (req, res): void => {
  const bundle = getC4Bundle(req.params.jobId!);
  if (!bundle) { res.status(404).json({ error: `No C4 analysis found for jobId "${req.params.jobId}"` }); return; }
  res.status(200).json(bundle.structuredDataReport);
});

// ---------------------------------------------------------------------------
// GET /seo-intelligence/:jobId/metadata-report
// ---------------------------------------------------------------------------
router.get("/seo-intelligence/:jobId/metadata-report", (req, res): void => {
  const bundle = getC4Bundle(req.params.jobId!);
  if (!bundle) { res.status(404).json({ error: `No C4 analysis found for jobId "${req.params.jobId}"` }); return; }
  res.status(200).json(bundle.metadataReport);
});

// ---------------------------------------------------------------------------
// GET /seo-intelligence/:jobId/search-readiness-report
// ---------------------------------------------------------------------------
router.get("/seo-intelligence/:jobId/search-readiness-report", (req, res): void => {
  const bundle = getC4Bundle(req.params.jobId!);
  if (!bundle) { res.status(404).json({ error: `No C4 analysis found for jobId "${req.params.jobId}"` }); return; }
  res.status(200).json(bundle.searchReadinessReport);
});

// ---------------------------------------------------------------------------
// GET /seo-intelligence/:jobId/sitemap.xml — raw XML
// ---------------------------------------------------------------------------
router.get("/seo-intelligence/:jobId/sitemap.xml", (req, res): void => {
  const bundle = getC4Bundle(req.params.jobId!);
  if (!bundle) { res.status(404).json({ error: `No C4 analysis found for jobId "${req.params.jobId}"` }); return; }
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.status(200).send(bundle.searchReadinessReport.sitemap.xml);
});

// ---------------------------------------------------------------------------
// GET /seo-intelligence/:jobId/robots.txt — raw text
// ---------------------------------------------------------------------------
router.get("/seo-intelligence/:jobId/robots.txt", (req, res): void => {
  const bundle = getC4Bundle(req.params.jobId!);
  if (!bundle) { res.status(404).json({ error: `No C4 analysis found for jobId "${req.params.jobId}"` }); return; }
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.status(200).send(bundle.searchReadinessReport.robotsTxt.content);
});

export default router;
