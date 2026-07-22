import { db, generationReportsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { runGenerationPipeline } from "@workspace/generation-pipeline";
import { placeContent } from "@workspace/content-placement";
import { buildNavigation } from "@workspace/navigation-intelligence";
import { generateWebsitePrime } from "@workspace/website-prime-generator";
import { resolveStencilById } from "@workspace/stencil-library";
import { compileSiteGraph } from "@workspace/site-intelligence";
import type {
  PortableManifest,
  PortablePageNode,
  PortableMediaItem,
  PortableStorageMap,
} from "@workspace/site-intelligence";
import type { GenerationReportRecord } from "@workspace/db";
import { loadManifest } from "./manifest-store";
import type { Manifest, PageNode } from "./manifest";
import { logger } from "./logger";
import type { CloudProvider } from "../cloud/provider";
import type { RuleAdjustment } from "./rule-adjustment-contract.js";
import { buildContractManifest } from "./rule-adjustment-contract.js";

// ---------------------------------------------------------------------------
// Manifest adapter — converts internal Manifest → PortableManifest
// Both types are structurally identical; this bridges Map<string,PageNode>
// to PageNode[] and Set<string> to string[].
// ---------------------------------------------------------------------------

function adaptToPortable(manifest: Manifest): PortableManifest {
  const nodes: PortablePageNode[] = Array.from(manifest.nodes.values()).map(
    (node: PageNode): PortablePageNode => ({
      id: node.id,
      version: node.version,
      nodeType: node.nodeType,
      status: node.status,
      metadata: {
        url: node.metadata.url,
        title: node.metadata.title,
        description: node.metadata.description,
        publishedAt: node.metadata.publishedAt,
        fetchedAt: node.metadata.fetchedAt,
        siteType: node.metadata.siteType,
      },
      content: {
        cleanHtml: node.content.cleanHtml,
        textContent: node.content.textContent,
        wordCount: node.content.wordCount,
        bodySelector: node.content.bodySelector,
      },
      media: {
        images: node.media.images as unknown as PortableMediaItem[],
        videos: node.media.videos as unknown as PortableMediaItem[],
      },
      storage: node.storage as unknown as PortableStorageMap,
      relationships: {
        parentId: node.relationships.parentId,
        childIds: node.relationships.childIds,
        paginationIndex: node.relationships.paginationIndex,
        depth: node.relationships.depth,
        discoverySource: node.relationships.discoverySource,
      },
    })
  );

  return {
    schemaVersion: "1.0",
    exportedAt: new Date().toISOString(),
    id: manifest.id,
    version: manifest.version,
    status: manifest.status,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    seedUrl: manifest.seedUrl,
    config: manifest.config as PortableManifest["config"],
    nodes,
    seenUrls: Array.from(manifest.seenUrls),
    stats: manifest.stats as PortableManifest["stats"],
  };
}

// ---------------------------------------------------------------------------
// runAndStoreGenerationPipeline
// Called by the job worker automatically after every successful job.
// Non-fatal — errors are caught and logged by the caller.
// ---------------------------------------------------------------------------

export async function runAndStoreGenerationPipeline(
  jobId: string,
  cloudProvider: CloudProvider,
  options: { adjustments?: RuleAdjustment[] } = {},
): Promise<void> {
  const { adjustments = [] } = options;
  logger.info({ jobId, adjustmentCount: adjustments.length }, "GENERATION: starting pipeline");
  const startMs = Date.now();

  // Mark pending so the API can return 202 while the pipeline runs
  await db
    .insert(generationReportsTable)
    .values({
      jobId,
      reportJson: "{}",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: generationReportsTable.jobId,
      set: { status: "pending", updatedAt: new Date() },
    });

  // Load the manifest from the DB
  const manifest = await loadManifest(jobId);
  if (!manifest) {
    const errMsg = "Manifest not found in DB — cannot run generation pipeline";
    await db
      .update(generationReportsTable)
      .set({ status: "failed", errorMessage: errMsg, updatedAt: new Date() })
      .where(eq(generationReportsTable.jobId, jobId));
    logger.warn({ jobId }, `GENERATION: ${errMsg}`);
    return;
  }

  // Convert and run the pure pipeline
  const portable = adaptToPortable(manifest);
  const report = runGenerationPipeline({
    manifest: portable,
    jobId,
    seedUrl: manifest.seedUrl,
  });

  // ── Phase 2.5C: Visual Reconstruction ─────────────────────────────────────
  // Applies Visual DNA overlay (real colors + fonts) to the design system tokens
  // so Website Prime renders with the source site's actual visual identity.
  // Non-fatal: runs only when Visual DNA artifacts exist in R2.
  let reconAudit: { overlayApplied: boolean; fidelityScore: number; grade: string } | null = null;
  if (report.pipeline.status === "success") {
    try {
      const { runVisualReconstruction } = await import("./visual-reconstruction-engine");
      reconAudit = await runVisualReconstruction(jobId, report);
      logger.info(
        { jobId, ...reconAudit },
        "PHASE2.5C: visual reconstruction complete"
      );
    } catch (reconErr) {
      logger.warn({ jobId, err: reconErr }, "PHASE2.5C: visual reconstruction failed — continuing with baseline report");
    }
  }

  // ── Phase 4.6: Content Placement Intelligence ─────────────────────────────
  // Assigns every manifest node to a stencil route slot (deterministic rules).
  // Generates category/tag index assignments and promotes featured pages.
  // Non-fatal: silently skips if pipeline failed or stencil is unknown.
  let placementReportJson: string | null = null;
  let placementReport: ReturnType<typeof placeContent> | null = null;
  if (report.pipeline.status === "success" && report.stencilSelection) {
    try {
      const stencilId = report.stencilSelection.selectedStencilId;
      const blueprint = resolveStencilById(stencilId as Parameters<typeof resolveStencilById>[0]);
      const siteGraph = compileSiteGraph(portable);

      placementReport = placeContent({
        jobId,
        seedUrl: manifest.seedUrl,
        stencilId,
        manifest: portable,
        siteGraph,
        blueprint,
      });

      placementReportJson = JSON.stringify(placementReport, null, 2);

      logger.info(
        {
          jobId,
          stencilId,
          totalAssignments: placementReport.stats.totalAssignments,
          featuredCount:    placementReport.stats.featuredCount,
          categoryCount:    placementReport.stats.categoryAssignmentCount,
          tagCount:         placementReport.stats.tagAssignmentCount,
          avgConfidence:    placementReport.stats.averageConfidence,
        },
        "PHASE4.6: content placement complete"
      );
    } catch (placementErr) {
      logger.warn({ jobId, err: placementErr }, "PHASE4.6: content placement failed — continuing without placement report");
    }
  }

  // ── Phase 4.7: Navigation Intelligence ────────────────────────────────────
  // Generates NavigationBlueprint: top-nav, mega-menu, sidebar, footer-nav,
  // and per-page breadcrumb trails. Non-fatal like all post-pipeline phases.
  let navigationReportJson: string | null = null;
  let navigationReport: ReturnType<typeof buildNavigation> | null = null;
  if (report.pipeline.status === "success" && report.stencilSelection) {
    try {
      const stencilId = report.stencilSelection.selectedStencilId;
      const blueprint = resolveStencilById(stencilId as Parameters<typeof resolveStencilById>[0]);
      const siteGraph = compileSiteGraph(portable);

      navigationReport = buildNavigation({
        jobId,
        seedUrl: manifest.seedUrl,
        stencilId,
        siteGraph,
        blueprint,
      });

      navigationReportJson = JSON.stringify(navigationReport, null, 2);

      logger.info(
        {
          jobId,
          stencilId,
          topNavItems:     navigationReport.stats.topNavItemCount,
          megaMenuSections: navigationReport.stats.megaMenuSectionCount,
          sidebarItems:    navigationReport.stats.sidebarTotalItems,
          footerGroups:    navigationReport.stats.footerGroupCount,
          breadcrumbPages: navigationReport.stats.breadcrumbPageCount,
          hasMegaMenu:     navigationReport.stats.hasMegaMenu,
          hasSidebar:      navigationReport.stats.hasSidebar,
        },
        "PHASE4.7: navigation intelligence complete"
      );
    } catch (navErr) {
      logger.warn({ jobId, err: navErr }, "PHASE4.7: navigation intelligence failed — continuing without navigation report");
    }
  }

  // ── Phase 5.1: Website Prime Generator ────────────────────────────────────
  // Generates a complete Vite+React SPA (routes, pages, components, theme).
  // Zips all generated files and uploads to R2 as website-prime.zip.
  // Non-fatal: skips if pipeline failed, no navigation report, or no stencil.
  let websitePrimeReportJson: string | null = null;
  if (
    report.pipeline.status === "success" &&
    report.stencilSelection &&
    report.generation &&
    navigationReport
  ) {
    try {
      const stencilId = report.stencilSelection.selectedStencilId;
      const blueprint = resolveStencilById(stencilId as Parameters<typeof resolveStencilById>[0]);

      const primeOutput = generateWebsitePrime({
        jobId,
        seedUrl: manifest.seedUrl,
        stencilId,
        report,
        navigationReport,
        placementReport: placementReport!,
        blueprint,
      });

      websitePrimeReportJson = JSON.stringify(
        { ...primeOutput.manifest, stats: primeOutput.stats },
        null,
        2,
      );

      // Zip all generated files and upload to R2
      if (cloudProvider.isConfigured()) {
        const AdmZip = (await import("adm-zip")).default;
        const zip = new AdmZip();
        for (const f of primeOutput.files) {
          zip.addFile(f.path, Buffer.from(f.content, "utf8"));
        }
        const zipBuffer = zip.toBuffer();

        await cloudProvider
          .upload({
            key: `jobs/${jobId}/website-prime.zip`,
            data: zipBuffer,
            contentType: "application/zip",
            checkDuplicate: false,
          })
          .catch((err) => {
            logger.warn({ err, jobId }, "PHASE5.1: R2 upload of website-prime.zip failed (non-fatal)");
          });

        await cloudProvider
          .upload({
            key: `jobs/${jobId}/website-prime-manifest.json`,
            data: Buffer.from(JSON.stringify(primeOutput.manifest, null, 2), "utf8"),
            contentType: "application/json",
            checkDuplicate: false,
          })
          .catch((err) => {
            logger.warn({ err, jobId }, "PHASE5.1: R2 upload of website-prime-manifest.json failed (non-fatal)");
          });
      }

      logger.info(
        {
          jobId,
          stencilId,
          totalFiles:    primeOutput.stats.totalFiles,
          components:    primeOutput.stats.componentCount,
          pages:         primeOutput.stats.pageCount,
          routes:        primeOutput.stats.routeCount,
          cssVars:       primeOutput.stats.cssVariableCount,
          linesOfCode:   primeOutput.stats.totalLinesOfCode,
        },
        "PHASE5.1: Website Prime generated"
      );

      // ── P0-2: Auto-trigger VR-1…VR-8 pipeline (fire-and-forget) ───────────
      // Runs asynchronously — does not block the generation response.
      setImmediate(() => {
        import("./visual-pipeline-orchestrator.js").then(({ runVisualPipeline }) => {
          runVisualPipeline(jobId, manifest).catch((err) => {
            logger.warn({ jobId, err }, "VISUAL-PIPELINE: auto-run failed (non-fatal)");
          });
        }).catch(() => {});
      });

    } catch (primeErr) {
      logger.warn({ jobId, err: primeErr }, "PHASE5.1: Website Prime generation failed — continuing without prime output");
    }
  }

  // ── P0-1: Store generation-adjustment-report.json ────────────────────────
  // Records which RuleAdjustments were applied in this generation pass.
  if (adjustments.length > 0) {
    try {
      const adjustmentReport = {
        version:     "1.0.0",
        generatedAt: new Date().toISOString(),
        jobId,
        contract:    buildContractManifest(),
        appliedAdjustments: adjustments,
        summary: {
          total:    adjustments.length,
          byType:   adjustments.reduce<Record<string, number>>((acc, a) => {
            acc[a.adjustmentType] = (acc[a.adjustmentType] ?? 0) + 1;
            return acc;
          }, {}),
          avgConfidence: adjustments.reduce((s, a) => s + a.confidence, 0) / adjustments.length,
          engines: [...new Set(adjustments.map((a) => a.originatingEngine))],
        },
      };

      const adjustmentReportJson = JSON.stringify(adjustmentReport, null, 2);

      if (cloudProvider.isConfigured()) {
        await cloudProvider.upload({
          key: `jobs/${jobId}/generation-adjustment-report.json`,
          data: Buffer.from(adjustmentReportJson, "utf8"),
          contentType: "application/json",
          checkDuplicate: false,
        }).catch(() => {});
      }

      logger.info(
        { jobId, adjustmentCount: adjustments.length, byType: adjustmentReport.summary.byType },
        "P0-1: generation-adjustment-report.json stored",
      );
    } catch (adjErr) {
      logger.warn({ jobId, err: adjErr }, "P0-1: failed to store adjustment report (non-fatal)");
    }
  }

  // Serialise after overlay (report is mutated in-place by the reconstruction engine)
  const reportJson = JSON.stringify(report, null, 2);
  const durationMs = Date.now() - startMs;
  const status = report.pipeline.status === "success" ? "success" : "failed";

  // Persist result to DB
  await db
    .update(generationReportsTable)
    .set({
      reportJson,
      status,
      generatedAt: new Date(),
      durationMs,
      stencilId: report.stencilSelection?.selectedStencilId ?? null,
      errorMessage: report.pipeline.error ?? null,
      updatedAt: new Date(),
    })
    .where(eq(generationReportsTable.jobId, jobId));

  // Upload generation-report.json + placement-report.json to R2
  if (cloudProvider.isConfigured()) {
    // Upload placement-report.json (non-fatal)
    if (placementReportJson) {
      await cloudProvider
        .upload({
          key: `jobs/${jobId}/placement-report.json`,
          data: Buffer.from(placementReportJson, "utf8"),
          contentType: "application/json",
          checkDuplicate: false,
        })
        .catch((err) => {
          logger.warn({ err, jobId }, "PHASE4.6: R2 upload of placement-report.json failed (non-fatal)");
        });
    }

    // Upload navigation-report.json (non-fatal)
    if (navigationReportJson) {
      await cloudProvider
        .upload({
          key: `jobs/${jobId}/navigation-report.json`,
          data: Buffer.from(navigationReportJson, "utf8"),
          contentType: "application/json",
          checkDuplicate: false,
        })
        .catch((err) => {
          logger.warn({ err, jobId }, "PHASE4.7: R2 upload of navigation-report.json failed (non-fatal)");
        });
    }

    await cloudProvider
      .upload({
        key: `jobs/${jobId}/generation-report.json`,
        data: Buffer.from(reportJson, "utf8"),
        contentType: "application/json",
        checkDuplicate: false,
      })
      .catch((err) => {
        logger.warn(
          { err, jobId },
          "GENERATION: R2 upload of generation-report.json failed (non-fatal)"
        );
      });
  }

  logger.info(
    {
      jobId,
      status,
      durationMs,
      stencilId: report.stencilSelection?.selectedStencilId,
      pageCount: report.generation?.stats.pageCount,
      routeCount: report.generation?.stats.routeCount,
      error: report.pipeline.error,
      fidelityScore: reconAudit?.fidelityScore ?? null,
      reconGrade: reconAudit?.grade ?? null,
    },
    "GENERATION: pipeline complete"
  );
}

// ---------------------------------------------------------------------------
// loadGenerationReport — retrieves the persisted report from DB
// ---------------------------------------------------------------------------

export async function loadGenerationReport(
  jobId: string
): Promise<GenerationReportRecord | null> {
  const rows = await db
    .select()
    .from(generationReportsTable)
    .where(eq(generationReportsTable.jobId, jobId))
    .limit(1);
  return rows[0] ?? null;
}
