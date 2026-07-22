/**
 * routes/visual-diff-localizer.ts  — PF-2
 *
 * POST /api/visual-diff/:sourceJobId/:generatedJobId          — run localizer
 * GET  /api/visual-diff/:sourceJobId/:generatedJobId/map      — visual-diff-map.json
 * GET  /api/visual-diff/:sourceJobId/:generatedJobId/heatmap  — difference-heatmap.json
 * GET  /api/visual-diff/:sourceJobId/:generatedJobId/errors   — component-error-report.json
 */

import { Router }   from "express";
import { readFile } from "fs/promises";
import { join }     from "path";
import {
  runVisualDiffLocalizer,
  type LocalizerOptions,
} from "../lib/visual-diff-localizer.js";

const router  = Router();
const OUT_DIR = process.cwd();

// ── POST /api/visual-diff/:sourceJobId/:generatedJobId ────────────────────
router.post(
  "/visual-diff/:sourceJobId/:generatedJobId",
  async (req, res): Promise<void> => {
    const { sourceJobId, generatedJobId } =
      req.params as { sourceJobId: string; generatedJobId: string };
    const { sourceKey, generatedKey, gridCols, gridRows, failThreshold } =
      req.body as Partial<LocalizerOptions>;

    req.log.info({ sourceJobId, generatedJobId }, "POST /visual-diff");

    try {
      const { diffMap, heatmap, componentErrors } = await runVisualDiffLocalizer({
        sourceJobId,
        generatedJobId,
        sourceKey,
        generatedKey,
        gridCols,
        gridRows,
        failThreshold,
      });

      res.json({
        ok:              true,
        sourceJobId,
        generatedJobId,
        totalIssues:     diffMap.totalIssues,
        issuesBySeverity: diffMap.issuesBySeverity,
        issuesByType:    diffMap.issuesByType,
        durationMs:      diffMap.durationMs,
        imageSize:       diffMap.imageSize,
        grid:            diffMap.grid,
        r2Keys:          diffMap.r2Keys,
        topIssues:       diffMap.issues.slice(0, 5).map((i) => ({
          id:         i.id,
          type:       i.type,
          severity:   i.severity,
          confidence: i.confidence,
          description: i.description,
          location:   i.location,
        })),
      });
    } catch (err) {
      req.log.error({ err, sourceJobId, generatedJobId }, "visual-diff: unexpected error");
      res.status(500).json({ ok: false, error: "Visual diff localization failed", detail: String(err) });
    }
  },
);

// ── GET /api/visual-diff/:sourceJobId/:generatedJobId/map ─────────────────
router.get(
  "/visual-diff/:sourceJobId/:generatedJobId/map",
  async (req, res): Promise<void> => {
    req.log.info(req.params, "GET /visual-diff/.../map");
    try {
      const raw = await readFile(join(OUT_DIR, "visual-diff-map.json"), "utf8");
      res.type("application/json").send(raw);
    } catch {
      res.status(404).json({ ok: false, error: "visual-diff-map.json not yet generated" });
    }
  },
);

// ── GET /api/visual-diff/:sourceJobId/:generatedJobId/heatmap ─────────────
router.get(
  "/visual-diff/:sourceJobId/:generatedJobId/heatmap",
  async (req, res): Promise<void> => {
    req.log.info(req.params, "GET /visual-diff/.../heatmap");
    try {
      const raw = await readFile(join(OUT_DIR, "difference-heatmap.json"), "utf8");
      res.type("application/json").send(raw);
    } catch {
      res.status(404).json({ ok: false, error: "difference-heatmap.json not yet generated" });
    }
  },
);

// ── GET /api/visual-diff/:sourceJobId/:generatedJobId/errors ──────────────
router.get(
  "/visual-diff/:sourceJobId/:generatedJobId/errors",
  async (req, res): Promise<void> => {
    req.log.info(req.params, "GET /visual-diff/.../errors");
    try {
      const raw = await readFile(join(OUT_DIR, "component-error-report.json"), "utf8");
      res.type("application/json").send(raw);
    } catch {
      res.status(404).json({ ok: false, error: "component-error-report.json not yet generated" });
    }
  },
);

export default router;
