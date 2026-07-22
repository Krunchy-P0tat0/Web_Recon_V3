/**
 * routes/storage.ts — Cloud Storage HTTP endpoints.
 * Ported from V2, adapted for V1's cloud abstraction (no feature-registry
 * or metrics-engine dependency — those are V2-specific modules).
 *
 * GET    /storage/status          — provider name + configured flag
 * GET    /storage/metrics         — basic usage stats (provider + configured)
 * GET    /storage/objects         — list stored objects (if provider supports it)
 * POST   /storage/upload          — upload a file (base64-encoded body)
 * GET    /storage/*key            — download a file
 * DELETE /storage/*key            — delete a file
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { logger } from "../lib/logger.js";

// V1 uses getDefaultCloudProvider from the cloud abstraction layer
let getProvider: (() => {
  providerName: string;
  isConfigured: () => boolean;
  upload?: (params: { key: string; data: Buffer; contentType?: string }) => Promise<{ key: string; bytesUploaded: number; attempts: number; url?: string }>;
  download?: (key: string) => Promise<Buffer | null>;
  delete?: (key: string) => Promise<void>;
  list?: () => Promise<Array<{ key: string; size?: number; lastModified?: string }>>;
}) | null = null;

// Lazy-load cloud provider to avoid boot-time crashes if env vars are missing
function getCloudProvider() {
  if (!getProvider) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const cloud = require("../cloud/index.js") as { getDefaultCloudProvider: typeof getProvider };
      getProvider = cloud.getDefaultCloudProvider;
    } catch {
      // Cloud module not available — return a no-op provider
      getProvider = () => ({
        providerName: "none",
        isConfigured: () => false,
      });
    }
  }
  return getProvider!();
}

const router: IRouter = Router();

const UploadBody = z.object({
  key: z.string().min(1),
  contentBase64: z.string().min(1),
  contentType: z.string().optional(),
});

// ── GET /storage/status ───────────────────────────────────────────────────────

router.get("/storage/status", (_req: Request, res: Response) => {
  try {
    const provider = getCloudProvider();
    res.json({
      provider: provider.providerName,
      configured: provider.isConfigured(),
    });
  } catch (err) {
    logger.error({ err }, "ROUTE: /storage/status failed");
    res.status(500).json({ provider: "error", configured: false });
  }
});

// ── GET /storage/metrics ──────────────────────────────────────────────────────

router.get("/storage/metrics", (_req: Request, res: Response) => {
  try {
    const provider = getCloudProvider();
    res.json({
      provider: provider.providerName,
      configured: provider.isConfigured(),
      storageUsedBytes: 0,
      objectCount: 0,
    });
  } catch (err) {
    logger.error({ err }, "ROUTE: /storage/metrics failed");
    res.status(500).json({ error: "metrics_unavailable" });
  }
});

// ── GET /storage/objects ──────────────────────────────────────────────────────

router.get("/storage/objects", async (_req: Request, res: Response) => {
  try {
    const provider = getCloudProvider();
    if (!provider.isConfigured() || !provider.list) {
      res.json([]);
      return;
    }
    const objects = await provider.list();
    res.json(
      objects
        .slice()
        .sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""))
    );
  } catch (err) {
    logger.error({ err }, "ROUTE: /storage/objects failed");
    res.status(502).json({ error: "list_failed" });
  }
});

// ── POST /storage/upload ──────────────────────────────────────────────────────

router.post("/storage/upload", async (req: Request, res: Response) => {
  const parsed = UploadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }

  const provider = getCloudProvider();
  if (!provider.isConfigured() || !provider.upload) {
    res.status(503).json({ error: "storage_not_configured" });
    return;
  }

  const { key, contentBase64, contentType } = parsed.data;
  const data = Buffer.from(contentBase64, "base64");

  try {
    const result = await provider.upload({ key, data, contentType });
    res.json(result);
  } catch (err) {
    logger.error({ err }, "ROUTE: /storage/upload failed");
    res.status(502).json({ error: "upload_failed" });
  }
});

// ── GET /storage/*key — download ──────────────────────────────────────────────

router.get("/storage/*key", async (req: Request, res: Response) => {
  const provider = getCloudProvider();
  if (!provider.isConfigured() || !provider.download) {
    res.status(503).json({ error: "storage_not_configured" });
    return;
  }

  const key = Array.isArray(req.params["key"])
    ? (req.params["key"] as string[]).join("/")
    : String(req.params["key"] ?? "");

  try {
    const data = await provider.download(key);
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.send(data);
  } catch (err) {
    logger.error({ err, key }, "ROUTE: /storage/download failed");
    res.status(502).json({ error: "download_failed" });
  }
});

// ── DELETE /storage/*key ──────────────────────────────────────────────────────

router.delete("/storage/*key", async (req: Request, res: Response) => {
  const provider = getCloudProvider();
  if (!provider.isConfigured()) {
    res.status(503).json({ error: "storage_not_configured" });
    return;
  }
  if (!provider.delete) {
    res.status(501).json({ error: "delete_not_supported" });
    return;
  }

  const key = Array.isArray(req.params["key"])
    ? (req.params["key"] as string[]).join("/")
    : String(req.params["key"] ?? "");

  try {
    await provider.delete(key);
    res.status(204).end();
  } catch (err) {
    logger.error({ err, key }, "ROUTE: /storage/delete failed");
    res.status(502).json({ error: "delete_failed" });
  }
});

export default router;
