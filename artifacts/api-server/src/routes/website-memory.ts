/**
 * website-memory.ts — Phase D4.4 Website Memory API
 *
 * Exposes the Persistent Website Intelligence Memory (PWIM) through a
 * lightweight REST endpoint so Mission Control can query memory status
 * for a given URL without running the full execution planner.
 *
 * GET  /website-memory?url=<url>  — returns WebsiteMemorySummary or { exists: false }
 */

import { Router, type IRouter } from "express";
import { WebsiteMemoryService, WebsiteMemoryNotFoundError } from "../lib/website-memory-service.js";

const router: IRouter = Router();

/**
 * GET /website-memory?url=<url>
 *
 * Returns a lightweight summary of the stored website memory for the given URL.
 * If no memory exists, returns { exists: false }.
 *
 * Query params:
 *   url — required, the target website URL or canonical domain
 *
 * Returns:
 *   200 with { exists: true, ...WebsiteMemorySummary } when memory is found
 *   200 with { exists: false }                         when no memory found
 *   400 if url is missing or invalid
 *   500 on unexpected errors
 */
router.get("/website-memory", async (req, res, next) => {
  try {
    const { url } = req.query as Record<string, unknown>;

    if (typeof url !== "string" || url.trim() === "") {
      res.status(400).json({ error: "url query parameter is required" });
      return;
    }

    const svc = new WebsiteMemoryService();

    const exists = await svc.websiteMemoryExists(url);
    if (!exists) {
      res.json({ exists: false });
      return;
    }

    const summary = await svc.getWebsiteMemorySummary(url);
    res.json({ exists: true, ...summary });
  } catch (err) {
    if (err instanceof WebsiteMemoryNotFoundError) {
      res.json({ exists: false });
      return;
    }
    next(err);
  }
});

export default router;
