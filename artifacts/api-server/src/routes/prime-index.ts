/**
 * prime-index.ts — Website Prime Indexing Engine API routes
 *
 * Phase 5.6 endpoints (existing):
 *   POST /api/jobs/:jobId/prime-index          — Build all 4 base indexes
 *   GET  /api/jobs/:jobId/prime-index          — Master websitePrimeIndex.json
 *   GET  /api/jobs/:jobId/prime-index/routes   — routeIndex.json
 *   GET  /api/jobs/:jobId/prime-index/search   — searchIndex.json [?q=]
 *   GET  /api/jobs/:jobId/prime-index/content  — contentIndex.json [?category=]
 *   GET  /api/jobs/:jobId/prime-index/nav      — navigationTree only
 *
 * Phase 5.7 endpoints (new — Website Prime Completion):
 *   POST /api/jobs/:jobId/prime/phase57               — Run full Phase 5.7 generation
 *   GET  /api/jobs/:jobId/prime/starter-index         — Starter index (page+route+category+nav inventories)
 *   GET  /api/jobs/:jobId/prime/starter-index/pages   — Page inventory only
 *   GET  /api/jobs/:jobId/prime/starter-index/routes  — Route inventory only
 *   GET  /api/jobs/:jobId/prime/starter-index/categories — Category inventory only
 *   GET  /api/jobs/:jobId/prime/starter-index/nav     — Navigation inventory only
 *   GET  /api/jobs/:jobId/prime/related-content       — Cross-link intelligence [?route=]
 *   GET  /api/jobs/:jobId/prime/search-index          — Enhanced search index [?q=]
 *   GET  /api/jobs/:jobId/prime/audit                 — Route validation report
 */

import { Router, type IRouter } from "express";
import { runWebsitePrimeIndexer } from "../lib/website-prime-indexer.js";
import type { WebsitePrimeIndex, RouteIndex, SearchIndex, ContentIndex, PageCategory } from "../lib/website-prime-indexer.js";
import { runPhase57 } from "../lib/website-prime-phase57.js";
import type { StarterIndex, RelatedContentIndex, EnhancedSearchIndex, WebsitePrimeAudit } from "../lib/website-prime-phase57.js";

const router: IRouter = Router();

// ── R2 fetch helper ───────────────────────────────────────────────────────────

async function fetchR2Json<T>(key: string): Promise<T | null> {
  if (!process.env.R2_BUCKET_NAME || !process.env.R2_ENDPOINT) return null;
  try {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      region: "auto", endpoint: process.env.R2_ENDPOINT!,
      credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID     ?? "",
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
      },
    });
    const resp = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: key }));
    const chunks: Buffer[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const ch of (resp.Body as any)) chunks.push(Buffer.from(ch));
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    return null;
  }
}

function primeIndexKey(jobId: string)   { return `jobs/${jobId}/prime-index/websitePrimeIndex.json`; }
function routeIndexKey(jobId: string)   { return `jobs/${jobId}/prime-index/routeIndex.json`; }
function searchIndexKey(jobId: string)  { return `jobs/${jobId}/prime-index/searchIndex.json`; }
function contentIndexKey(jobId: string) { return `jobs/${jobId}/prime-index/contentIndex.json`; }

// ── POST /api/jobs/:jobId/prime-index ────────────────────────────────────────

router.post("/jobs/:jobId/prime-index", async (req, res): Promise<void> => {
  const jobId = req.params["jobId"] ?? "";
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  req.log.info({ jobId }, "PRIME-INDEX: run requested");
  try {
    const output = await runWebsitePrimeIndexer({ jobId });
    res.status(200).json({
      message:     "Website Prime Index built successfully.",
      jobId,
      stats:       output.websitePrimeIndex.stats,
      r2Keys:      output.r2Keys,
      uploadedAll: output.uploadedAll,
      primeIndex:  output.websitePrimeIndex,
    });
  } catch (err) {
    req.log.error({ err, jobId }, "PRIME-INDEX: run failed");
    res.status(500).json({
      error:  "Website Prime Indexing failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── GET /api/jobs/:jobId/prime-index/nav ─────────────────────────────────────
// (Must be registered before the /:jobId catch-all GET)

router.get("/jobs/:jobId/prime-index/nav", async (req, res): Promise<void> => {
  const jobId = req.params["jobId"] ?? "";
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  const content = await fetchR2Json<ContentIndex>(contentIndexKey(jobId));
  if (!content) {
    res.status(404).json({
      error: "Prime index not found.",
      hint:  `Run POST /api/jobs/${jobId}/prime-index to build it first.`,
    }); return;
  }
  res.status(200).json({
    jobId,
    generatedAt:    content.generatedAt,
    navigationTree: content.navigationTree,
  });
});

// ── GET /api/jobs/:jobId/prime-index/routes ───────────────────────────────────

router.get("/jobs/:jobId/prime-index/routes", async (req, res): Promise<void> => {
  const jobId = req.params["jobId"] ?? "";
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  const index = await fetchR2Json<RouteIndex>(routeIndexKey(jobId));
  if (!index) {
    res.status(404).json({
      error: "Route index not found.",
      hint:  `Run POST /api/jobs/${jobId}/prime-index to build it first.`,
    }); return;
  }
  res.status(200).json(index);
});

// ── GET /api/jobs/:jobId/prime-index/search[?q=] ─────────────────────────────

router.get("/jobs/:jobId/prime-index/search", async (req, res): Promise<void> => {
  const jobId = req.params["jobId"] ?? "";
  const q     = (req.query["q"] as string ?? "").toLowerCase().trim();
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  const index = await fetchR2Json<SearchIndex>(searchIndexKey(jobId));
  if (!index) {
    res.status(404).json({
      error: "Search index not found.",
      hint:  `Run POST /api/jobs/${jobId}/prime-index to build it first.`,
    }); return;
  }

  const results = q
    ? index.documents.filter(d => d.text.toLowerCase().includes(q))
    : index.documents;

  res.status(200).json({
    jobId,
    generatedAt: index.generatedAt,
    query:       q || null,
    totalDocs:   index.totalDocs,
    matched:     results.length,
    documents:   results,
  });
});

// ── GET /api/jobs/:jobId/prime-index/content[?category=] ─────────────────────

router.get("/jobs/:jobId/prime-index/content", async (req, res): Promise<void> => {
  const jobId    = req.params["jobId"] ?? "";
  const category = req.query["category"] as PageCategory | undefined;
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  const index = await fetchR2Json<ContentIndex>(contentIndexKey(jobId));
  if (!index) {
    res.status(404).json({
      error: "Content index not found.",
      hint:  `Run POST /api/jobs/${jobId}/prime-index to build it first.`,
    }); return;
  }

  const validCategories: PageCategory[] = ["homepage", "article", "listing", "feature", "navigation", "unknown"];
  if (category && !validCategories.includes(category)) {
    res.status(400).json({ error: `Invalid category. Must be one of: ${validCategories.join(", ")}` }); return;
  }

  res.status(200).json({
    jobId,
    generatedAt:    index.generatedAt,
    filter:         { category: category ?? null },
    byCategory:     category ? { [category]: index.byCategory[category] } : index.byCategory,
    sections:       index.sections,
    navigationTree: index.navigationTree,
  });
});

// ── GET /api/jobs/:jobId/prime-index ─────────────────────────────────────────

router.get("/jobs/:jobId/prime-index", async (req, res): Promise<void> => {
  const jobId = req.params["jobId"] ?? "";
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  const index = await fetchR2Json<WebsitePrimeIndex>(primeIndexKey(jobId));
  if (!index) {
    res.status(404).json({
      error: "Website Prime Index not found for this job.",
      hint:  `Run POST /api/jobs/${jobId}/prime-index to build it.`,
    }); return;
  }
  res.status(200).json(index);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 5.7 — Website Prime Completion
// ═══════════════════════════════════════════════════════════════════════════════

// ── R2 keys for Phase 5.7 artifacts ──────────────────────────────────────────
function starterIndexKey(jid: string)   { return `jobs/${jid}/prime-index/starter-index.json`; }
function relatedContentKey(jid: string) { return `jobs/${jid}/prime-index/related-content.json`; }
function p57SearchIndexKey(jid: string) { return `jobs/${jid}/prime-index/search-index.json`; }
function auditKey(jid: string)          { return `jobs/${jid}/prime-index/website-prime-audit.json`; }

/**
 * POST /api/jobs/:jobId/prime/phase57
 *
 * Runs full Phase 5.7 generation:
 *   1. Loads routeIndex + contentIndex from R2 (from Phase 5.6 run)
 *   2. Optionally loads SiteGraph, Blueprint, Manifest for enriched output
 *   3. Generates starter-index.json, related-content.json, search-index.json,
 *      website-prime-audit.json
 *   4. Uploads all to R2
 */
router.post("/jobs/:jobId/prime/phase57", async (req, res): Promise<void> => {
  const jobId = req.params["jobId"] ?? "";
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  const { seedUrl } = (req.body ?? {}) as { seedUrl?: string };
  req.log.info({ jobId, seedUrl }, "PHASE57: run requested");

  try {
    const output = await runPhase57({ jobId, seedUrl });
    res.status(200).json({
      message:     "Phase 5.7 Website Prime Completion: success.",
      jobId,
      sources:     output.sources,
      uploadedAll: output.uploadedAll,
      r2Keys:      output.r2Keys,
      summary: {
        starterIndex: {
          totalPages:      output.starterIndex.stats.totalPages,
          totalRoutes:     output.starterIndex.stats.totalRoutes,
          totalCategories: output.starterIndex.stats.totalCategories,
          totalNavItems:   output.starterIndex.stats.totalNavItems,
          maxDepth:        output.starterIndex.stats.maxDepth,
        },
        relatedContent: {
          totalPages:    output.relatedContent.totalPages,
          pagesWithLinks: output.relatedContent.entries.filter(e => e.relatedPages.length > 0).length,
        },
        searchIndex: {
          totalDocs: output.searchIndex.totalDocs,
        },
        audit: {
          grade:     output.audit.grade,
          summary:   output.audit.summary,
          issues:    output.audit.issues.length,
          orphans:   output.audit.stats.orphanRoutes,
          broken:    output.audit.stats.brokenRoutes,
          duplicates: output.audit.stats.duplicateRoutes,
        },
      },
    });
  } catch (err) {
    req.log.error({ err, jobId }, "PHASE57: run failed");
    res.status(500).json({
      error:  "Phase 5.7 generation failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── GET /api/jobs/:jobId/prime/starter-index ──────────────────────────────────

router.get("/jobs/:jobId/prime/starter-index", async (req, res): Promise<void> => {
  const jobId = req.params["jobId"] ?? "";
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  const index = await fetchR2Json<StarterIndex>(starterIndexKey(jobId));
  if (!index) {
    res.status(404).json({
      error: "Starter index not found.",
      hint:  `Run POST /api/jobs/${jobId}/prime/phase57 first.`,
    }); return;
  }
  res.status(200).json(index);
});

// ── GET /api/jobs/:jobId/prime/starter-index/pages ───────────────────────────

router.get("/jobs/:jobId/prime/starter-index/pages", async (req, res): Promise<void> => {
  const jobId    = req.params["jobId"] ?? "";
  const category = (req.query["category"] as string | undefined)?.toLowerCase();
  const depth    = req.query["depth"] !== undefined ? parseInt(String(req.query["depth"]), 10) : undefined;
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  const index = await fetchR2Json<StarterIndex>(starterIndexKey(jobId));
  if (!index) {
    res.status(404).json({ error: "Starter index not found.", hint: `Run POST /api/jobs/${jobId}/prime/phase57 first.` }); return;
  }

  let pages = index.pageInventory;
  if (category) pages = pages.filter(p => p.category === category);
  if (depth !== undefined && !isNaN(depth)) pages = pages.filter(p => p.depth === depth);

  res.status(200).json({
    jobId, generatedAt: index.generatedAt,
    filter: { category: category ?? null, depth: depth ?? null },
    total: pages.length,
    pages,
  });
});

// ── GET /api/jobs/:jobId/prime/starter-index/routes ──────────────────────────

router.get("/jobs/:jobId/prime/starter-index/routes", async (req, res): Promise<void> => {
  const jobId  = req.params["jobId"] ?? "";
  const status = req.query["status"] as string | undefined;
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  const index = await fetchR2Json<StarterIndex>(starterIndexKey(jobId));
  if (!index) {
    res.status(404).json({ error: "Starter index not found.", hint: `Run POST /api/jobs/${jobId}/prime/phase57 first.` }); return;
  }

  let routes = index.routeInventory;
  if (status) routes = routes.filter(r => r.status === status);

  res.status(200).json({
    jobId, generatedAt: index.generatedAt,
    filter: { status: status ?? null },
    total: routes.length,
    routes,
  });
});

// ── GET /api/jobs/:jobId/prime/starter-index/categories ──────────────────────

router.get("/jobs/:jobId/prime/starter-index/categories", async (req, res): Promise<void> => {
  const jobId = req.params["jobId"] ?? "";
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  const index = await fetchR2Json<StarterIndex>(starterIndexKey(jobId));
  if (!index) {
    res.status(404).json({ error: "Starter index not found.", hint: `Run POST /api/jobs/${jobId}/prime/phase57 first.` }); return;
  }
  res.status(200).json({
    jobId, generatedAt: index.generatedAt,
    total: index.categoryInventory.length,
    categories: index.categoryInventory,
  });
});

// ── GET /api/jobs/:jobId/prime/starter-index/nav ─────────────────────────────

router.get("/jobs/:jobId/prime/starter-index/nav", async (req, res): Promise<void> => {
  const jobId  = req.params["jobId"] ?? "";
  const level  = req.query["level"] as string | undefined;
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  const index = await fetchR2Json<StarterIndex>(starterIndexKey(jobId));
  if (!index) {
    res.status(404).json({ error: "Starter index not found.", hint: `Run POST /api/jobs/${jobId}/prime/phase57 first.` }); return;
  }

  let items = index.navigationInventory;
  if (level) items = items.filter(i => i.level === level);

  res.status(200).json({
    jobId, generatedAt: index.generatedAt,
    filter: { level: level ?? null },
    total: items.length,
    navigationInventory: items,
  });
});

// ── GET /api/jobs/:jobId/prime/related-content[?route=] ──────────────────────

router.get("/jobs/:jobId/prime/related-content", async (req, res): Promise<void> => {
  const jobId = req.params["jobId"] ?? "";
  const route = req.query["route"] as string | undefined;
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  const index = await fetchR2Json<RelatedContentIndex>(relatedContentKey(jobId));
  if (!index) {
    res.status(404).json({ error: "Related content index not found.", hint: `Run POST /api/jobs/${jobId}/prime/phase57 first.` }); return;
  }

  if (route) {
    const entry = index.entries.find(e => e.pageRoute === route);
    if (!entry) {
      res.status(404).json({ error: `No related content entry for route '${route}'.` }); return;
    }
    res.status(200).json({ jobId, generatedAt: index.generatedAt, entry });
    return;
  }

  res.status(200).json(index);
});

// ── GET /api/jobs/:jobId/prime/search-index[?q=] ─────────────────────────────

router.get("/jobs/:jobId/prime/search-index", async (req, res): Promise<void> => {
  const jobId = req.params["jobId"] ?? "";
  const q     = (req.query["q"] as string ?? "").toLowerCase().trim();
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  const index = await fetchR2Json<EnhancedSearchIndex>(p57SearchIndexKey(jobId));
  if (!index) {
    res.status(404).json({ error: "Phase 5.7 search index not found.", hint: `Run POST /api/jobs/${jobId}/prime/phase57 first.` }); return;
  }

  const results = q
    ? index.documents.filter(d =>
        d.title.toLowerCase().includes(q) ||
        d.snippet.toLowerCase().includes(q) ||
        d.keywords.some(k => k.includes(q)) ||
        d.tags.some(t => t.includes(q))
      )
    : index.documents;

  res.status(200).json({
    jobId,
    generatedAt: index.generatedAt,
    query:    q || null,
    totalDocs: index.totalDocs,
    matched:  results.length,
    documents: results,
  });
});

// ── GET /api/jobs/:jobId/prime/audit ─────────────────────────────────────────

router.get("/jobs/:jobId/prime/audit", async (req, res): Promise<void> => {
  const jobId     = req.params["jobId"] ?? "";
  const severity  = req.query["severity"] as string | undefined;
  const issueType = req.query["type"] as string | undefined;
  if (!jobId) { res.status(400).json({ error: "jobId is required" }); return; }

  const audit = await fetchR2Json<WebsitePrimeAudit>(auditKey(jobId));
  if (!audit) {
    res.status(404).json({ error: "Audit report not found.", hint: `Run POST /api/jobs/${jobId}/prime/phase57 first.` }); return;
  }

  let issues = audit.issues;
  if (severity) issues = issues.filter(i => i.severity === severity);
  if (issueType) issues = issues.filter(i => i.type === issueType);

  res.status(200).json({
    ...audit,
    issues,
    ...(severity || issueType ? { filter: { severity: severity ?? null, type: issueType ?? null }, filteredCount: issues.length } : {}),
  });
});

export default router;
