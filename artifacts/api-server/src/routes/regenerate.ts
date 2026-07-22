/**
 * routes/regenerate.ts — Phase H: IS-001 ZIP regeneration endpoint
 *
 * Provides on-demand ZIP regeneration for jobs whose R2 artifacts became
 * orphaned or incomplete (e.g. partial upload, bucket event lost).
 *
 * POST /scrape/regenerate/:jobId
 *   Regenerates and re-uploads the ZIP + index.html for the given job.
 *   Safe to call multiple times — uses checkDuplicate: false to force overwrite.
 *
 * GET  /scrape/regenerate/:jobId/status
 *   Returns the current R2 artifact status (verified or missing) for a job.
 */

import { Router } from "express";
import { logger } from "../lib/logger.js";
import { getJobRecord } from "../lib/db-queue.js";
import { R2Provider } from "../cloud/r2.provider.js";
import { loadManifest } from "../lib/manifest-store.js";
import AdmZip from "adm-zip";
import { promises as fs } from "fs";

const router = Router();

// ── Helpers ─────────────────────────────────────────────────────────────────

const EXT_CT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm":  "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt":  "text/plain; charset=utf-8",
  ".xml":  "application/xml",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico":  "image/x-icon",
};

function contentType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return EXT_CT[filename.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

async function getZipBuffer(jobId: string, r2: R2Provider): Promise<Buffer> {
  const job = await getJobRecord(jobId);
  if (job?.zipPath) {
    try {
      return await fs.readFile(job.zipPath);
    } catch {
      // fall through to R2
    }
  }
  if (r2.isConfigured()) {
    const buf = await r2.download(`jobs/${jobId}/site.zip`);
    if (buf) return buf;
  }
  throw new Error(`No ZIP found for job '${jobId}'. Checked local zipPath and R2 jobs/${jobId}/site.zip.`);
}

// ── POST /scrape/regenerate/:jobId ───────────────────────────────────────────

router.post("/scrape/regenerate/:jobId", async (req, res) => {
  const { jobId } = req.params;

  req.log.info({ jobId }, "REGENERATE: starting artifact regeneration");

  const r2 = new R2Provider();
  if (!r2.isConfigured()) {
    res.status(503).json({
      ok: false,
      error: "R2 storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL.",
    });
    return;
  }

  const steps: Array<{ name: string; status: "success" | "failed" | "skipped"; detail: string }> = [];

  try {
    // Step 1: Verify job exists
    const job = await getJobRecord(jobId);
    if (!job) {
      res.status(404).json({ ok: false, error: `Job '${jobId}' not found in the database.` });
      return;
    }
    steps.push({ name: "verify_job", status: "success", detail: `Job found: status=${job.status}` });

    // Step 2: Acquire ZIP
    let zipBuffer: Buffer;
    try {
      zipBuffer = await getZipBuffer(jobId, r2);
      steps.push({ name: "acquire_zip", status: "success", detail: `ZIP acquired (${(zipBuffer.length / 1024).toFixed(1)} KB)` });
    } catch (err) {
      steps.push({ name: "acquire_zip", status: "failed", detail: err instanceof Error ? err.message : String(err) });
      res.status(422).json({ ok: false, error: "Could not locate ZIP for this job.", steps });
      return;
    }

    // Step 3: Extract files
    const zip = new AdmZip(zipBuffer);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries: any[] = zip.getEntries();
    const files: Array<{ name: string; data: Buffer }> = entries
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((e: any) => !e.isDirectory && e.entryName !== "")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((e: any) => ({ name: (e.entryName as string).replace(/^\//, ""), data: e.getData() as Buffer }));

    if (files.length === 0) {
      steps.push({ name: "extract_files", status: "failed", detail: "ZIP is empty" });
      res.status(422).json({ ok: false, error: "ZIP is empty — nothing to regenerate.", steps });
      return;
    }
    steps.push({ name: "extract_files", status: "success", detail: `${files.length} file(s) extracted` });

    // Step 4: Re-upload ZIP itself under jobs/{jobId}/site.zip (force overwrite)
    await r2.upload({ key: `jobs/${jobId}/site.zip`, data: zipBuffer, contentType: "application/zip", checkDuplicate: false });
    steps.push({ name: "upload_zip", status: "success", detail: `Uploaded jobs/${jobId}/site.zip` });

    // Step 5: Re-upload extracted files under jobs/{jobId}/site/
    let totalBytes = 0;
    let uploadedCount = 0;
    for (const file of files) {
      try {
        await r2.upload({ key: `jobs/${jobId}/site/${file.name}`, data: file.data, contentType: contentType(file.name), checkDuplicate: false });
        totalBytes += file.data.length;
        uploadedCount++;
      } catch (err) {
        req.log.warn({ jobId, file: file.name, err }, "REGENERATE: file upload failed (non-fatal)");
      }
    }
    steps.push({ name: "upload_files", status: "success", detail: `${uploadedCount}/${files.length} files uploaded (${(totalBytes / 1024).toFixed(1)} KB)` });

    // Step 6: Upload/update index.html at top-level jobs/{jobId}/index.html
    const indexFile = files.find(f => f.name === "index.html" || f.name.endsWith("/index.html"));
    if (indexFile) {
      await r2.upload({ key: `jobs/${jobId}/index.html`, data: indexFile.data, contentType: "text/html; charset=utf-8", checkDuplicate: false });
      steps.push({ name: "upload_index", status: "success", detail: `index.html uploaded to jobs/${jobId}/index.html` });
    } else {
      steps.push({ name: "upload_index", status: "skipped", detail: "No index.html found in ZIP" });
    }

    // Step 7: Verify
    const verified = await r2.verify(`jobs/${jobId}/site.zip`);
    steps.push({ name: "verify", status: verified ? "success" : "failed", detail: verified ? "R2 key verified" : "Verification HEAD failed" });

    const manifest = await loadManifest(jobId);

    req.log.info({ jobId, uploadedCount, totalBytes }, "REGENERATE: artifact regeneration complete");

    res.json({
      ok: true,
      data: {
        jobId,
        regeneratedAt: new Date().toISOString(),
        filesUploaded: uploadedCount,
        bytesUploaded: totalBytes,
        zipUrl: r2.getPublicUrl(`jobs/${jobId}/site.zip`),
        indexUrl: indexFile ? r2.getPublicUrl(`jobs/${jobId}/index.html`) : null,
        pagesInManifest: manifest ? manifest.nodes.size : null,
        steps,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, jobId }, "REGENERATE: unexpected error");
    res.status(500).json({ ok: false, error: msg, steps });
  }
});

// ── GET /scrape/regenerate/:jobId/status ─────────────────────────────────────

router.get("/scrape/regenerate/:jobId/status", async (req, res) => {
  const { jobId } = req.params;

  const r2 = new R2Provider();
  if (!r2.isConfigured()) {
    res.json({ ok: true, data: { jobId, r2Configured: false, zipPresent: null, indexPresent: null } });
    return;
  }

  try {
    const [zipPresent, indexPresent] = await Promise.all([
      r2.verify(`jobs/${jobId}/site.zip`),
      r2.verify(`jobs/${jobId}/index.html`),
    ]);

    res.json({
      ok: true,
      data: {
        jobId,
        r2Configured: true,
        zipPresent,
        indexPresent,
        zipUrl: zipPresent ? r2.getPublicUrl(`jobs/${jobId}/site.zip`) : null,
        indexUrl: indexPresent ? r2.getPublicUrl(`jobs/${jobId}/index.html`) : null,
        checkedAt: new Date().toISOString(),
        recommendation: !zipPresent
          ? `Run POST /api/scrape/regenerate/${jobId} to regenerate the missing artifact.`
          : "Artifact appears healthy.",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err, jobId }, "REGENERATE: status check failed");
    res.status(500).json({ ok: false, error: msg });
  }
});

export default router;
