/**
 * screenshot-visual-dna.ts — Phase VR-2 HTTP Routes
 *
 * POST /api/visual-dna/:jobId/extract    — run full DNA extraction from screenshots+CSS
 * GET  /api/visual-dna/:jobId            — get visual-dna.json for a job
 * GET  /api/visual-dna/:jobId/report     — full visual-dna-report.json
 * GET  /api/visual-dna/:jobId/colors     — color palette only
 * GET  /api/visual-dna/:jobId/typography — typography tokens only
 * GET  /api/visual-dna/:jobId/spacing    — spacing scale only
 * GET  /api/visual-dna/:jobId/layout     — layout tokens only
 * GET  /api/visual-dna/report            — latest cached report (any job)
 */

import { Router, type IRouter } from "express";
import {
  extractVisualDNA,
  loadDNA,
  loadReport,
  listReports,
  getReport,
  storeReport,
} from "../lib/screenshot-visual-dna-engine.js";
import { loadManifest } from "../lib/manifest-store.js";

const router: IRouter = Router();

// Static routes before /:jobId

router.get("/visual-dna/report", async (_req, res): Promise<void> => {
  try {
    const cached = await loadReport();
    if (cached) { res.json(cached); return; }
    const all = listReports();
    if (all.length > 0) { res.json(all[0]); return; }
    res.status(404).json({
      error: "No visual-dna-report found.",
      hint:  "POST /api/visual-dna/:jobId/extract to generate one.",
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /visual-dna/:jobId/extract
router.post("/visual-dna/:jobId/extract", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };

  try {
    const manifest = await loadManifest(jobId);
    if (!manifest) {
      res.status(404).json({ error: `No manifest found for jobId "${jobId}". Run a crawl + screenshot capture first.` });
      return;
    }

    const report = await extractVisualDNA(jobId, manifest);
    storeReport(report);

    res.json({
      jobId,
      extracted: true,
      durationMs:        report.durationMs,
      overallConfidence: report.summary.overallConfidence,
      htmlFree:          report.summary.htmlFree,
      colorsExtracted:   report.summary.colorsExtracted,
      fontsDetected:     report.summary.fontsDetected,
      spacingSteps:      report.summary.spacingSteps,
      containerWidths:   report.summary.containerWidths,
      links: {
        dna:        `/api/visual-dna/${jobId}`,
        report:     `/api/visual-dna/${jobId}/report`,
        colors:     `/api/visual-dna/${jobId}/colors`,
        typography: `/api/visual-dna/${jobId}/typography`,
        spacing:    `/api/visual-dna/${jobId}/spacing`,
        layout:     `/api/visual-dna/${jobId}/layout`,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /visual-dna/:jobId
router.get("/visual-dna/:jobId", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };
  try {
    const inMem = getReport(jobId)?.dna;
    if (inMem) { res.json(inMem); return; }
    const cached = await loadDNA();
    if (cached && cached.jobId === jobId) { res.json(cached); return; }
    res.status(404).json({ error: `No visual DNA for jobId "${jobId}". POST /api/visual-dna/${jobId}/extract first.` });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /visual-dna/:jobId/report
router.get("/visual-dna/:jobId/report", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };
  try {
    const inMem = getReport(jobId);
    if (inMem) { res.json(inMem); return; }
    const cached = await loadReport();
    if (cached && cached.jobId === jobId) { res.json(cached); return; }
    res.status(404).json({ error: `No visual DNA report for jobId "${jobId}".` });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /visual-dna/:jobId/colors
router.get("/visual-dna/:jobId/colors", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };
  try {
    const dna = getReport(jobId)?.dna ?? (await loadDNA());
    if (!dna || dna.jobId !== jobId) {
      res.status(404).json({ error: `No color data for jobId "${jobId}".` });
      return;
    }
    res.json({ jobId, colors: dna.colors });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /visual-dna/:jobId/typography
router.get("/visual-dna/:jobId/typography", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };
  try {
    const dna = getReport(jobId)?.dna ?? (await loadDNA());
    if (!dna || dna.jobId !== jobId) {
      res.status(404).json({ error: `No typography data for jobId "${jobId}".` });
      return;
    }
    res.json({ jobId, typography: dna.typography });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /visual-dna/:jobId/spacing
router.get("/visual-dna/:jobId/spacing", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };
  try {
    const dna = getReport(jobId)?.dna ?? (await loadDNA());
    if (!dna || dna.jobId !== jobId) {
      res.status(404).json({ error: `No spacing data for jobId "${jobId}".` });
      return;
    }
    res.json({ jobId, spacing: dna.spacing, layout: { containerWidths: dna.layout.containerWidths } });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /visual-dna/:jobId/layout
router.get("/visual-dna/:jobId/layout", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };
  try {
    const dna = getReport(jobId)?.dna ?? (await loadDNA());
    if (!dna || dna.jobId !== jobId) {
      res.status(404).json({ error: `No layout data for jobId "${jobId}".` });
      return;
    }
    res.json({ jobId, layout: dna.layout, hierarchy: dna.hierarchy, borders: dna.borders });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
