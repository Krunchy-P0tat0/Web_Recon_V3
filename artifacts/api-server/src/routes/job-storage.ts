/**
 * routes/job-storage.ts — Phase D3.4 R2 Memory Layer endpoints
 *
 * GET /api/storage/overview          — bucket-level stats (file count, bytes, health)
 * GET /api/storage/jobs              — list all job-level storage summaries
 * GET /api/storage/jobs/:jobId/manifest   — full job storage manifest
 * GET /api/storage/jobs/:jobId/artifacts  — per-artifact health for a job
 */

import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";
import { getDefaultCloudProvider } from "../cloud/index.js";
import { R2Keys, jobIdFromKey } from "../cloud/r2-key-registry.js";
import {
  loadManifestFromR2,
  getCachedManifest,
  getAllCachedManifests,
} from "../lib/job-storage-manifest.js";
import { listJobs as listOrchestrationJobs } from "../lib/master-orchestrator.js";

const router = Router();

// ---------------------------------------------------------------------------
// Helper: list R2 objects (returns [] when R2 not configured or list unsupported)
// ---------------------------------------------------------------------------

async function safeList(prefix?: string) {
  try {
    const cloud = getDefaultCloudProvider() as {
      isConfigured(): boolean;
      list?(p?: string): Promise<Array<{ key: string; size: number; lastModified: string }>>;
      bucketName?: string;
    };
    if (!cloud.isConfigured() || !cloud.list) return [];
    return await cloud.list(prefix);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// GET /api/storage/overview
// ---------------------------------------------------------------------------

router.get("/storage/overview", async (_req: Request, res: Response) => {
  try {
    const cloud = getDefaultCloudProvider() as {
      isConfigured(): boolean;
      providerName: string;
      bucketName?: string;
      list?(p?: string): Promise<Array<{ key: string; size: number; lastModified: string }>>;
    };

    if (!cloud.isConfigured()) {
      res.json({
        provider:           cloud.providerName,
        configured:         false,
        bucketName:         "",
        totalFiles:         0,
        totalBytes:         0,
        jobCount:           0,
        artifactsGenerated: 0,
        storageHealth:      "unconfigured",
        lastActivity:       null,
      });
      return;
    }

    // List everything under job-set-* (cap at 5000 objects for perf)
    const objects = await safeList("job-set-");
    const totalFiles = objects.length;
    const totalBytes = objects.reduce((s, o) => s + (o.size ?? 0), 0);

    // Count unique jobIds
    const jobIds = new Set<string>();
    for (const obj of objects) {
      const jid = jobIdFromKey(obj.key);
      if (jid) jobIds.add(jid);
    }

    // Count generated artifacts (manifest + website-prime + certification)
    let artifactsGenerated = 0;
    for (const jid of jobIds) {
      if (objects.some((o) => o.key === R2Keys.manifest.index(jid)))      artifactsGenerated++;
      if (objects.some((o) => o.key === R2Keys.websitePrime.zip(jid)))    artifactsGenerated++;
      if (objects.some((o) => o.key === R2Keys.certification.report(jid)))artifactsGenerated++;
    }

    const lastActivity = objects.length > 0
      ? objects.reduce((latest, o) =>
          o.lastModified > latest ? o.lastModified : latest,
          objects[0]!.lastModified
        )
      : null;

    const storageHealth: "healthy" | "degraded" =
      totalFiles > 0 ? "healthy" : "degraded";

    res.json({
      provider:           cloud.providerName,
      configured:         true,
      bucketName:         cloud.bucketName ?? "",
      totalFiles,
      totalBytes,
      jobCount:           jobIds.size,
      artifactsGenerated,
      storageHealth,
      lastActivity,
    });
  } catch (err) {
    logger.error({ err }, "ROUTE: /storage/overview failed");
    res.status(500).json({ error: "overview_failed" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/storage/jobs
// ---------------------------------------------------------------------------

router.get("/storage/jobs", async (_req: Request, res: Response) => {
  try {
    const cloud = getDefaultCloudProvider() as {
      isConfigured(): boolean;
      list?(p?: string): Promise<Array<{ key: string; size: number; lastModified: string }>>;
    };

    // Merge orchestration job list with R2 storage data
    const orchJobs = listOrchestrationJobs();

    if (!cloud.isConfigured() || !cloud.list) {
      // No R2 — return orchestration jobs with zero storage stats
      const summaries = orchJobs.map((j) => ({
        jobId:                j.id,
        seedUrl:              j.url,
        fileCount:            0,
        totalBytes:           0,
        manifestPresent:      false,
        websitePrimePresent:  false,
        certificationPresent: false,
        differentialPresent:  false,
        visualDnaPresent:     false,
        brandDnaPresent:      false,
        checkpointCount:      0,
        hasDifferential:      j.includeDiff,
        pipelineStatus:       j.status,
        lastActivity:         j.completedAt ?? j.startedAt,
      }));
      res.json(summaries);
      return;
    }

    // Build per-job summaries from R2 object list
    const allObjects = await safeList("job-set-");

    // Group by jobId
    const byJob = new Map<string, Array<{ key: string; size: number; lastModified: string }>>();
    for (const obj of allObjects) {
      const jid = jobIdFromKey(obj.key);
      if (!jid) continue;
      if (!byJob.has(jid)) byJob.set(jid, []);
      byJob.get(jid)!.push(obj);
    }

    // Merge with orchestration jobs (known jobs take precedence)
    const knownIds = new Set(orchJobs.map((j) => j.id));
    const r2OnlyIds = [...byJob.keys()].filter((id) => !knownIds.has(id));

    const summaries = [
      ...orchJobs.map((j) => {
        const objs = byJob.get(j.id) ?? [];
        const keys  = new Set(objs.map((o) => o.key));
        return {
          jobId:                j.id,
          seedUrl:              j.url,
          fileCount:            objs.length,
          totalBytes:           objs.reduce((s, o) => s + o.size, 0),
          manifestPresent:      keys.has(R2Keys.manifest.index(j.id)),
          websitePrimePresent:  keys.has(R2Keys.websitePrime.zip(j.id)),
          certificationPresent: keys.has(R2Keys.certification.report(j.id)),
          differentialPresent:  keys.has(R2Keys.differential.changed(j.id)),
          visualDnaPresent:     keys.has(R2Keys.visualDna.layouts(j.id)),
          brandDnaPresent:      keys.has(R2Keys.brandDna.branding(j.id)),
          checkpointCount:      objs.filter((o) => o.key.includes("/checkpoints/checkpoint-")).length,
          hasDifferential:      j.includeDiff,
          pipelineStatus:       j.status,
          lastActivity:         j.completedAt ?? j.startedAt,
        };
      }),
      // R2-only jobs (server restarted, not in memory)
      ...r2OnlyIds.map((jid) => {
        const objs = byJob.get(jid) ?? [];
        const keys  = new Set(objs.map((o) => o.key));
        const latest = objs.length > 0
          ? objs.reduce((l, o) => (o.lastModified > l ? o.lastModified : l), objs[0]!.lastModified)
          : null;
        return {
          jobId:                jid,
          seedUrl:              "(recovered from R2)",
          fileCount:            objs.length,
          totalBytes:           objs.reduce((s, o) => s + o.size, 0),
          manifestPresent:      keys.has(R2Keys.manifest.index(jid)),
          websitePrimePresent:  keys.has(R2Keys.websitePrime.zip(jid)),
          certificationPresent: keys.has(R2Keys.certification.report(jid)),
          differentialPresent:  keys.has(R2Keys.differential.changed(jid)),
          visualDnaPresent:     keys.has(R2Keys.visualDna.layouts(jid)),
          brandDnaPresent:      keys.has(R2Keys.brandDna.branding(jid)),
          checkpointCount:      objs.filter((o) => o.key.includes("/checkpoints/checkpoint-")).length,
          hasDifferential:      false,
          pipelineStatus:       "recovered",
          lastActivity:         latest,
        };
      }),
    ];

    res.json(summaries);
  } catch (err) {
    logger.error({ err }, "ROUTE: /storage/jobs failed");
    res.status(500).json({ error: "list_failed" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/storage/jobs/:jobId/manifest
// ---------------------------------------------------------------------------

router.get("/storage/jobs/:jobId/manifest", async (req: Request, res: Response) => {
  const { jobId } = req.params as { jobId: string };
  try {
    const cloud = getDefaultCloudProvider();
    let manifest = getCachedManifest(jobId);
    if (!manifest) {
      manifest = await loadManifestFromR2(jobId, cloud);
    }
    if (!manifest) {
      res.status(404).json({ error: "manifest_not_found" });
      return;
    }
    res.json(manifest);
  } catch (err) {
    logger.error({ err, jobId }, "ROUTE: /storage/jobs/:jobId/manifest failed");
    res.status(500).json({ error: "manifest_fetch_failed" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/storage/jobs/:jobId/artifacts
// ---------------------------------------------------------------------------

router.get("/storage/jobs/:jobId/artifacts", async (req: Request, res: Response) => {
  const { jobId } = req.params as { jobId: string };
  try {
    const cloud = getDefaultCloudProvider() as {
      isConfigured(): boolean;
      getPublicUrl(k: string): string;
      verify(k: string): Promise<boolean>;
      list?(p?: string): Promise<Array<{ key: string; size: number; lastModified: string }>>;
    };

    if (!cloud.isConfigured()) {
      res.status(503).json({ error: "storage_not_configured" });
      return;
    }

    // List all objects for this job
    const objects = cloud.list
      ? await cloud.list(R2Keys.jobPrefix(jobId))
      : [];

    const keySet = new Set(objects.map((o) => o.key));
    const sizeOf = (key: string) => objects.find((o) => o.key === key)?.size ?? null;

    const checks = [
      { name: "manifest",      key: R2Keys.manifest.index(jobId) },
      { name: "website-prime", key: R2Keys.websitePrime.zip(jobId) },
      { name: "site-zip",      key: R2Keys.websitePrime.siteZip(jobId) },
      { name: "certification", key: R2Keys.certification.report(jobId) },
      { name: "differential",  key: R2Keys.differential.changed(jobId) },
      { name: "visual-dna",    key: R2Keys.visualDna.layouts(jobId) },
      { name: "brand-dna",     key: R2Keys.brandDna.branding(jobId) },
      { name: "exec-summary",  key: R2Keys.reports.executionSummary(jobId) },
      { name: "pipeline-log",  key: R2Keys.logs.pipeline(jobId) },
    ];

    const health = checks.map(({ name, key }) => ({
      name,
      key,
      present:   keySet.has(key),
      url:       keySet.has(key) ? cloud.getPublicUrl(key) : null,
      sizeBytes: sizeOf(key),
      lastChecked: new Date().toISOString(),
    }));

    const checkpointObjects = objects.filter((o) => o.key.includes("/checkpoints/checkpoint-"));
    const stageObjects      = objects.filter((o) => o.key.includes("/stages/"));

    res.json({
      jobId,
      checkedAt:       new Date().toISOString(),
      totalFiles:      objects.length,
      totalBytes:      objects.reduce((s, o) => s + o.size, 0),
      artifactHealth:  health,
      checkpointCount: checkpointObjects.length,
      stageResultKeys: stageObjects.map((o) => o.key),
      allKeys:         objects.map((o) => ({ key: o.key, size: o.size, lastModified: o.lastModified })),
    });
  } catch (err) {
    logger.error({ err, jobId }, "ROUTE: /storage/jobs/:jobId/artifacts failed");
    res.status(500).json({ error: "artifacts_fetch_failed" });
  }
});

export default router;
