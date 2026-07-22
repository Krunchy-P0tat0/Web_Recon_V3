import { db, constructionReportsTable, generationReportsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { constructSite } from "@workspace/site-constructor";
import { loadManifest } from "./manifest-store";
import { logger } from "./logger";
import { getDefaultCloudProvider } from "../cloud";
import AdmZip from "adm-zip";
import type { GenerationReport } from "@workspace/generation-pipeline";

// ---------------------------------------------------------------------------
// runAndStoreConstruction
//
// Phase C3 — Autonomous Site Construction.
// 1. Loads the manifest and existing GenerationReport
// 2. Calls constructSite() to produce all HTML/CSS/JSON/XML files
// 3. Packages everything into a site.zip
// 4. Uploads to cloud storage (non-fatal if cloud not configured)
// 5. Stores the construction audit in the DB
// ---------------------------------------------------------------------------

export async function runAndStoreConstruction(jobId: string): Promise<void> {
  logger.info({ jobId }, "CONSTRUCTION: starting Phase C3 site construction");
  const startMs = Date.now();
  const cloudProvider = getDefaultCloudProvider();

  // Mark as pending so polls can return 202
  await db
    .insert(constructionReportsTable)
    .values({
      jobId,
      auditJson: "{}",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: constructionReportsTable.jobId,
      set: { status: "pending", updatedAt: new Date() },
    });

  try {
    // ── Load manifest from DB ──────────────────────────────────────────────
    const manifest = await loadManifest(jobId);
    if (!manifest) {
      throw new Error(`Manifest not found for job ${jobId}`);
    }

    // ── Load generation report ─────────────────────────────────────────────
    const genRecord = await db.query.generationReportsTable.findFirst({
      where: eq(generationReportsTable.jobId, jobId),
    });

    if (!genRecord || genRecord.status !== "success") {
      throw new Error(
        `Generation report not available for job ${jobId}. Run generation pipeline first (it runs automatically after a scrape).`
      );
    }

    const generationReport = JSON.parse(genRecord.reportJson) as GenerationReport;

    // ── Adapt manifest to PortableManifest ────────────────────────────────
    const portableManifest = adaptManifestToPortable(manifest);

    // ── Construct site ────────────────────────────────────────────────────
    const pageCount = generationReport.generation?.siteAssembly.pages.length ?? 0;
    logger.info({ jobId, pageCount }, "CONSTRUCTION: rendering pages");

    const constructedSite = constructSite({
      report: generationReport,
      manifest: portableManifest,
    });

    logger.info(
      { jobId, files: constructedSite.files.length, score: constructedSite.audit.completenessScore },
      "CONSTRUCTION: site built — packaging ZIP"
    );

    // ── Package into ZIP ──────────────────────────────────────────────────
    const zip = new AdmZip();
    for (const file of constructedSite.files) {
      zip.addFile(file.path, Buffer.from(file.content, "utf8"));
    }
    const zipBuffer = zip.toBuffer();

    // ── Upload ZIP to cloud storage (non-fatal) ───────────────────────────
    let siteZipCloudPath: string | null = null;

    if (cloudProvider.isConfigured()) {
      try {
        await cloudProvider.upload({
          key: `jobs/${jobId}/site.zip`,
          data: zipBuffer,
          contentType: "application/zip",
          checkDuplicate: false,
        });
        siteZipCloudPath = cloudProvider.getPublicUrl(`jobs/${jobId}/site.zip`);
        logger.info(
          { jobId, siteZipCloudPath, sizeBytes: zipBuffer.length },
          "CONSTRUCTION: site.zip uploaded"
        );
      } catch (uploadErr) {
        logger.warn({ jobId, err: uploadErr }, "CONSTRUCTION: ZIP upload failed (non-fatal)");
      }
    }

    const durationMs = Date.now() - startMs;
    const audit = constructedSite.audit;

    // ── Persist to DB ─────────────────────────────────────────────────────
    await db
      .insert(constructionReportsTable)
      .values({
        jobId,
        auditJson: JSON.stringify(audit),
        status: "success",
        constructedAt: new Date(),
        durationMs,
        stencilId: audit.stencilId,
        completenessScore: audit.completenessScore,
        totalPages: audit.pages.total,
        renderedPages: audit.pages.rendered,
        siteZipCloudPath,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: constructionReportsTable.jobId,
        set: {
          auditJson: JSON.stringify(audit),
          status: "success",
          constructedAt: new Date(),
          durationMs,
          stencilId: audit.stencilId,
          completenessScore: audit.completenessScore,
          totalPages: audit.pages.total,
          renderedPages: audit.pages.rendered,
          siteZipCloudPath,
          updatedAt: new Date(),
        },
      });

    logger.info(
      { jobId, durationMs, score: audit.completenessScore, summary: audit.summary },
      "CONSTRUCTION: complete"
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ jobId, err }, "CONSTRUCTION: failed");

    await db
      .insert(constructionReportsTable)
      .values({
        jobId,
        auditJson: "{}",
        status: "failed",
        errorMessage,
        durationMs: Date.now() - startMs,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: constructionReportsTable.jobId,
        set: {
          status: "failed",
          errorMessage,
          durationMs: Date.now() - startMs,
          updatedAt: new Date(),
        },
      });
  }
}

// ---------------------------------------------------------------------------
// loadConstructionReport
// ---------------------------------------------------------------------------

export async function loadConstructionReport(jobId: string) {
  return db.query.constructionReportsTable.findFirst({
    where: eq(constructionReportsTable.jobId, jobId),
  });
}

// ---------------------------------------------------------------------------
// adaptManifestToPortable — mirrors generation-runner.ts pattern
// ---------------------------------------------------------------------------

type ManifestData = NonNullable<Awaited<ReturnType<typeof loadManifest>>>;

function adaptManifestToPortable(manifest: ManifestData) {
  const nodes = Array.from(manifest.nodes.values()).map((node) => ({
    id: node.id,
    version: node.version as "1.0",
    nodeType: node.nodeType,
    status: node.status,
    metadata: {
      url: node.metadata.url,
      title: node.metadata.title,
      description: node.metadata.description,
      publishedAt: node.metadata.publishedAt,
      fetchedAt: node.metadata.fetchedAt,
      siteType: node.metadata.siteType as "wordpress" | "cheerio" | "unknown",
    },
    content: {
      cleanHtml: node.content.cleanHtml,
      textContent: node.content.textContent,
      wordCount: node.content.wordCount,
      bodySelector: node.content.bodySelector,
    },
    media: {
      images: node.media.images as never,
      videos: node.media.videos as never,
    },
    storage: node.storage as never,
    relationships: {
      parentId: node.relationships.parentId,
      childIds: node.relationships.childIds,
      paginationIndex: node.relationships.paginationIndex,
      depth: node.relationships.depth,
      discoverySource: node.relationships.discoverySource,
    },
  }));

  return {
    schemaVersion: "1.0",
    exportedAt: new Date().toISOString(),
    id: manifest.id,
    version: manifest.version as "1.0",
    status: manifest.status as never,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    seedUrl: manifest.seedUrl,
    config: manifest.config as never,
    nodes,
    seenUrls: Array.from(manifest.seenUrls),
    stats: manifest.stats as never,
  };
}
