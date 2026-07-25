/**
 * routes/visual-optimizer.ts  — PF-3
 *
 * POST /api/visual-optimizer/:sourceJobId/:generatedJobId          — run optimizer
 * GET  /api/visual-optimizer/:sourceJobId/:generatedJobId/plan     — optimization-plan.json
 * GET  /api/visual-optimizer/:sourceJobId/:generatedJobId/gain     — expected-fidelity-gain.json
 * GET  /api/visual-optimizer/:sourceJobId/:generatedJobId/adjustments — updated-adjustments.json
 *
 * The POST body can include a pre-loaded componentErrors object (from PF-2) OR the
 * route will attempt to load it from disk (component-error-report.json).
 */

import { Router }   from "express";
import { readFile } from "fs/promises";
import { join }     from "path";
import {
  runVisualOptimizer,
  type OptimizerOptions,
} from "../lib/visual-optimizer.js";
import type { ComponentErrorReport } from "../lib/visual-diff-localizer.js";
import type { RuleAdjustment }       from "../lib/rule-adjustment-contract.js";

const router  = Router();
const OUT_DIR = process.cwd();

// ── POST /api/visual-optimizer/:sourceJobId/:generatedJobId ───────────────
router.post(
  "/visual-optimizer/:sourceJobId/:generatedJobId",
  async (req, res): Promise<void> => {
    const { sourceJobId, generatedJobId } =
      req.params as { sourceJobId: string; generatedJobId: string };

    req.log.info({ sourceJobId, generatedJobId }, "POST /visual-optimizer");

    const {
      baselineSsim,
      maxAdjustments,
      existingAdjustments,
      componentErrors: inlineErrors,
    } = req.body as Partial<OptimizerOptions & { componentErrors: ComponentErrorReport }>;

    try {
      // Load PF-2 component-error-report from disk if not provided inline
      let componentErrors: ComponentErrorReport | undefined = inlineErrors;
      if (!componentErrors) {
        try {
          const raw   = await readFile(join(OUT_DIR, "component-error-report.json"), "utf8");
          componentErrors = JSON.parse(raw) as ComponentErrorReport;
        } catch {
          res.status(400).json({
            ok: false,
            error: "componentErrors not provided and component-error-report.json not found on disk. Run PF-2 first.",
          });
          return;
        }
      }

      const { plan, expectedGain, updatedAdjustments } = await runVisualOptimizer({
        sourceJobId,
        generatedJobId,
        componentErrors,
        baselineSsim,
        maxAdjustments,
        existingAdjustments: existingAdjustments as RuleAdjustment[] | undefined,
      });

      res.json({
        ok:                    true,
        sourceJobId,
        generatedJobId,
        totalItems:            plan.totalItems,
        estimatedOverallGain:  plan.estimatedOverallGain,
        baselineSsim:          expectedGain.baselineSsim,
        projectedSsim:         expectedGain.projectedSsim,
        updatedAdjustmentsCount: updatedAdjustments.length,
        topItems:              plan.items.slice(0, 5).map((i) => ({
          rank:              i.rank,
          adjustmentType:    i.adjustmentType,
          expectedSsimGain:  i.expectedSsimGain,
          priorityScore:     i.priorityScore,
          confidence:        i.confidence,
          description:       i.description,
        })),
        r2Keys:                plan.r2Keys,
      });
    } catch (err) {
      req.log.error({ err, sourceJobId, generatedJobId }, "visual-optimizer: unexpected error");
      res.status(500).json({ ok: false, error: "Visual optimizer failed", detail: String(err) });
    }
  },
);

// ── GET /api/visual-optimizer/:sourceJobId/:generatedJobId/plan ───────────
router.get(
  "/visual-optimizer/:sourceJobId/:generatedJobId/plan",
  async (req, res): Promise<void> => {
    req.log.info(req.params, "GET /visual-optimizer/.../plan");
    try {
      const raw = await readFile(join(OUT_DIR, "optimization-plan.json"), "utf8");
      res.type("application/json").send(raw);
    } catch {
      res.status(404).json({ ok: false, error: "optimization-plan.json not yet generated" });
    }
  },
);

// ── GET /api/visual-optimizer/:sourceJobId/:generatedJobId/gain ───────────
router.get(
  "/visual-optimizer/:sourceJobId/:generatedJobId/gain",
  async (req, res): Promise<void> => {
    req.log.info(req.params, "GET /visual-optimizer/.../gain");
    try {
      const raw = await readFile(join(OUT_DIR, "expected-fidelity-gain.json"), "utf8");
      res.type("application/json").send(raw);
    } catch {
      res.status(404).json({ ok: false, error: "expected-fidelity-gain.json not yet generated" });
    }
  },
);

// ── GET /api/visual-optimizer/:sourceJobId/:generatedJobId/adjustments ────
router.get(
  "/visual-optimizer/:sourceJobId/:generatedJobId/adjustments",
  async (req, res): Promise<void> => {
    req.log.info(req.params, "GET /visual-optimizer/.../adjustments");
    try {
      const raw = await readFile(join(OUT_DIR, "updated-adjustments.json"), "utf8");
      res.type("application/json").send(raw);
    } catch {
      res.status(404).json({ ok: false, error: "updated-adjustments.json not yet generated" });
    }
  },
);

export default router;
