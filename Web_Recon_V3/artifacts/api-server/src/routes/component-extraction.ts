/**
 * component-extraction.ts — Phase VR-4 HTTP Routes
 *
 * POST /api/components/:jobId/extract    — run component extraction from layout map
 * GET  /api/components/:jobId            — get full component library
 * GET  /api/components/:jobId/report     — full component-analysis-report
 * GET  /api/components/:jobId/type/:type — components filtered by type
 * GET  /api/components/:jobId/global     — globally reused components only
 * GET  /api/components/report            — latest cached report (any job)
 */

import { Router, type IRouter } from "express";
import {
  runComponentExtraction,
  getLibrary,
  getReport,
  listReports,
  storeReport,
  loadReport,
  loadLibrary,
  type ComponentType,
} from "../lib/component-extraction-engine.js";
import {
  getBundle,
  loadBundle,
} from "../lib/visual-layout-mapper-engine.js";

const router: IRouter = Router();

// Static routes before /:jobId

router.get("/components/report", async (_req, res): Promise<void> => {
  try {
    const cached = await loadReport();
    if (cached) { res.json(cached); return; }
    const all = listReports();
    if (all.length > 0) { res.json(all[0]); return; }
    res.status(404).json({
      error: "No component-analysis-report found.",
      hint:  "POST /api/components/:jobId/extract to generate one.",
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /components/:jobId/extract — run extraction
router.post("/components/:jobId/extract", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };

  try {
    // Load layout bundle (VR-3 output)
    const bundle = getBundle(jobId) ?? await loadBundle();
    if (!bundle || bundle.jobId !== jobId) {
      res.status(404).json({
        error: `No layout map found for jobId "${jobId}".`,
        hint:  `POST /api/layout-map/${jobId}/map first (Phase VR-3).`,
      });
      return;
    }

    const report = await runComponentExtraction(jobId, bundle);
    storeReport(report);

    res.json({
      jobId,
      extracted:        true,
      totalComponents:  report.totalComponents,
      globalComponents: report.globalComponents,
      localComponents:  report.localComponents,
      totalPages:       report.totalPages,
      durationMs:       report.durationMs,
      clusterStats:     report.clusterStats,
      links: {
        library: `/api/components/${jobId}`,
        report:  `/api/components/${jobId}/report`,
        global:  `/api/components/${jobId}/global`,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /components/:jobId — full library
router.get("/components/:jobId", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };
  try {
    const inMem = getLibrary(jobId);
    if (inMem) { res.json(inMem); return; }
    const cached = await loadLibrary();
    if (cached && cached.jobId === jobId) { res.json(cached); return; }
    res.status(404).json({
      error: `No component library for jobId "${jobId}".`,
      hint:  `POST /api/components/${jobId}/extract to generate.`,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /components/:jobId/report — full analysis report
router.get("/components/:jobId/report", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };
  try {
    const inMem = getReport(jobId);
    if (inMem) { res.json(inMem); return; }
    const cached = await loadReport();
    if (cached && cached.jobId === jobId) { res.json(cached); return; }
    res.status(404).json({ error: `No component analysis report for jobId "${jobId}".` });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /components/:jobId/type/:type — filter by component type
router.get("/components/:jobId/type/:type", async (req, res): Promise<void> => {
  const { jobId, type } = req.params as { jobId: string; type: string };
  try {
    const lib = getLibrary(jobId) ?? await loadLibrary();
    if (!lib || lib.jobId !== jobId) {
      res.status(404).json({ error: `No component library for jobId "${jobId}".` });
      return;
    }
    const components = lib.components.filter((c) => c.type === (type as ComponentType));
    res.json({
      jobId,
      type,
      count: components.length,
      components,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /components/:jobId/global — globally reused components only
router.get("/components/:jobId/global", async (req, res): Promise<void> => {
  const { jobId } = req.params as { jobId: string };
  try {
    const lib = getLibrary(jobId) ?? await loadLibrary();
    if (!lib || lib.jobId !== jobId) {
      res.status(404).json({ error: `No component library for jobId "${jobId}".` });
      return;
    }
    const globalComponents = lib.components.filter((c) => c.isGlobal);
    res.json({
      jobId,
      totalComponents: lib.totalComponents,
      globalCount:     globalComponents.length,
      components:      globalComponents,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
