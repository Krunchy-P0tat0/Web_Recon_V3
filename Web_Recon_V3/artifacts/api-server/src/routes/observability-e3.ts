/**
 * observability-e3.ts — Phase E3 Routes
 *
 * POST /observability/run                              — run full observability collection
 * GET  /observability                                  — list all observability runs
 * GET  /observability/live                             — live system snapshot (no store)
 * GET  /observability/:obsId                           — full E3 bundle
 * GET  /observability/:obsId/telemetry                 — telemetry-report.json
 * GET  /observability/:obsId/dashboard                 — metrics-dashboard.json
 * GET  /observability/:obsId/health                    — health-summary.json
 * GET  /observability/:obsId/score                     — health score + grade
 * GET  /observability/:obsId/metrics                   — raw metric points
 * GET  /observability/:obsId/subsystems                — per-subsystem health
 * GET  /observability/:obsId/subsystems/:name          — single subsystem
 * GET  /observability/:obsId/alerts                    — active alerts
 * GET  /observability/:obsId/pipeline                  — pipeline metrics
 * GET  /observability/:obsId/coverage                  — phase coverage
 * GET  /observability/:obsId/failures                  — failure analysis
 */

import { Router, type IRouter } from "express";
import { randomUUID }            from "crypto";
import * as os                   from "os";
import { performance }           from "perf_hooks";
import {
  runObservability,
  getE3Bundle,
  listE3Bundles,
  recordMetricSnapshot,
} from "../lib/observability-engine-e3.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /observability/run
// ---------------------------------------------------------------------------
router.post("/observability/run", async (req, res): Promise<void> => {
  const { observabilityId, force, includeDb, snapshotWindowMs } = req.body ?? {};

  const id = typeof observabilityId === "string" && observabilityId.trim()
    ? observabilityId.trim()
    : `e3-${randomUUID()}`;

  try {
    const bundle = await runObservability({
      observabilityId:   id,
      force:             !!force,
      includeDb:         includeDb !== false,
      snapshotWindowMs:  typeof snapshotWindowMs === "number" ? snapshotWindowMs : undefined,
    });

    const d = bundle.metricsDashboard;
    const h = bundle.healthSummary;
    const t = bundle.telemetryReport;

    res.status(200).json({
      observabilityId:  bundle.observabilityId,
      generatedAt:      bundle.generatedAt,
      durationMs:       bundle.durationMs,
      r2Keys:           bundle.r2Keys,
      healthScore:      bundle.healthScore,
      obsGrade:         bundle.obsGrade,
      overallHealth:    d.overallHealth,
      alertCount:       d.alertCount,
      alerts:           d.alerts,
      uptime:           h.uptime,
      uptimeMs:         h.uptimeMs,
      memoryOk:         h.memoryOk,
      cpuOk:            h.cpuOk,
      pipelineOk:       h.pipelineOk,
      deploymentOk:     h.deploymentOk,
      criticalIssues:   h.criticalIssues,
      warnings:         h.warnings,
      nextActions:      h.nextActions,
      executiveSummary: h.executiveSummary,
      subsystemStatus:  h.subsystemStatus,
      pipelineSummary: {
        totalJobs:        t.pipeline.totalJobsEver,
        activeJobs:       t.pipeline.activeJobs,
        failureRate:      t.pipeline.failureRate,
        throughputPerHour: t.pipeline.throughputPerHour,
        bottleneckStage:  t.pipeline.bottleneckStage,
      },
      memorySummary: {
        heapUsedMb:    t.memory.heapUsedMb,
        heapUsagePct:  t.memory.heapUsagePct,
        rssMb:         t.memory.rssMb,
        gcPressure:    t.memory.gcPressure,
        trend:         t.memory.trend,
      },
      cpuSummary: {
        utilizationPct:  t.cpu.utilizationPct,
        loadAvg1:        t.cpu.loadAvg1,
        loadNormalised:  t.cpu.loadNormalised,
        eventLoopLagMs:  t.cpu.eventLoopLagMs,
        eventLoopStatus: t.cpu.eventLoopStatus,
      },
      coveragePct:   t.coverage.coveragePct,
      mergeSummary: {
        total:         t.merge.totalMerges,
        successRate:   t.merge.mergeSuccessRate,
        avgScore:      t.merge.avgMergeScore,
        conflictRate:  t.merge.conflictRate,
      },
      deploymentSummary: {
        total:         t.deployment.totalDeployments,
        successRate:   t.deployment.deploySuccessRate,
        lastStatus:    t.deployment.lastDeployStatus,
        rollbacks:     t.deployment.rolledBackDeploys,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "E3: observability run failed");
    res.status(500).json({ error: "Observability run failed", detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /observability/live — instant live system snapshot without storing
// ---------------------------------------------------------------------------
router.get("/observability/live", async (_req, res): Promise<void> => {
  try {
    recordMetricSnapshot();

    const mem      = process.memoryUsage();
    const cpu      = process.cpuUsage();
    const loads    = os.loadavg() as [number, number, number];
    const cores    = os.cpus().length;
    const uptimeSec = process.uptime();

    // Brief CPU sample (100ms)
    const before    = process.cpuUsage();
    const wallStart = performance.now();
    await new Promise(r => setTimeout(r, 100));
    const after   = process.cpuUsage(before);
    const wallMs  = performance.now() - wallStart;
    const cpuPct  = Math.min(100, ((after.user + after.system) / 1000 / wallMs) * 100);

    res.status(200).json({
      ts:             new Date().toISOString(),
      uptime:         `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${Math.round(uptimeSec % 60)}s`,
      uptimeSec,
      memory: {
        heapUsedMb:    mem.heapUsed  / 1024 / 1024,
        heapTotalMb:   mem.heapTotal / 1024 / 1024,
        heapUsagePct:  (mem.heapUsed / mem.heapTotal) * 100,
        rssMb:         mem.rss       / 1024 / 1024,
        externalMb:    mem.external  / 1024 / 1024,
        freeSystemMb:  os.freemem()  / 1024 / 1024,
        totalSystemMb: os.totalmem() / 1024 / 1024,
      },
      cpu: {
        utilizationPct: cpuPct,
        userUs:         cpu.user,
        systemUs:       cpu.system,
        loadAvg1:       loads[0],
        loadAvg5:       loads[1],
        loadAvg15:      loads[2],
        coreCount:      cores,
        loadNormalised: loads[0] / cores,
      },
      process: {
        pid:        process.pid,
        nodeVersion: process.version,
        platform:   process.platform,
        arch:       process.arch,
        env:        process.env["NODE_ENV"] ?? "development",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Live snapshot failed", detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /observability
// ---------------------------------------------------------------------------
router.get("/observability", (_req, res): void => {
  res.status(200).json(listE3Bundles());
});

// ---------------------------------------------------------------------------
// GET /observability/:obsId — full bundle
// ---------------------------------------------------------------------------
router.get("/observability/:obsId", (req, res): void => {
  const bundle = getE3Bundle(req.params.obsId!);
  if (!bundle) {
    res.status(404).json({ error: `No E3 observability run found for id "${req.params.obsId}"` });
    return;
  }
  res.status(200).json(bundle);
});

// ---------------------------------------------------------------------------
// GET /observability/:obsId/telemetry
// ---------------------------------------------------------------------------
router.get("/observability/:obsId/telemetry", (req, res): void => {
  const bundle = getE3Bundle(req.params.obsId!);
  if (!bundle) { res.status(404).json({ error: `No E3 run found for id "${req.params.obsId}"` }); return; }
  res.status(200).json(bundle.telemetryReport);
});

// ---------------------------------------------------------------------------
// GET /observability/:obsId/dashboard
// ---------------------------------------------------------------------------
router.get("/observability/:obsId/dashboard", (req, res): void => {
  const bundle = getE3Bundle(req.params.obsId!);
  if (!bundle) { res.status(404).json({ error: `No E3 run found for id "${req.params.obsId}"` }); return; }
  res.status(200).json(bundle.metricsDashboard);
});

// ---------------------------------------------------------------------------
// GET /observability/:obsId/health
// ---------------------------------------------------------------------------
router.get("/observability/:obsId/health", (req, res): void => {
  const bundle = getE3Bundle(req.params.obsId!);
  if (!bundle) { res.status(404).json({ error: `No E3 run found for id "${req.params.obsId}"` }); return; }
  res.status(200).json(bundle.healthSummary);
});

// ---------------------------------------------------------------------------
// GET /observability/:obsId/score
// ---------------------------------------------------------------------------
router.get("/observability/:obsId/score", (req, res): void => {
  const bundle = getE3Bundle(req.params.obsId!);
  if (!bundle) { res.status(404).json({ error: `No E3 run found for id "${req.params.obsId}"` }); return; }
  const d = bundle.metricsDashboard;
  res.status(200).json({
    observabilityId: bundle.observabilityId,
    generatedAt:     bundle.generatedAt,
    healthScore:     bundle.healthScore,
    obsGrade:        bundle.obsGrade,
    overallHealth:   d.overallHealth,
    alertCount:      d.alertCount,
    uptime:          bundle.healthSummary.uptime,
    memoryOk:        bundle.healthSummary.memoryOk,
    cpuOk:           bundle.healthSummary.cpuOk,
    pipelineOk:      bundle.healthSummary.pipelineOk,
    deploymentOk:    bundle.healthSummary.deploymentOk,
  });
});

// ---------------------------------------------------------------------------
// GET /observability/:obsId/metrics
// ---------------------------------------------------------------------------
router.get("/observability/:obsId/metrics", (req, res): void => {
  const bundle = getE3Bundle(req.params.obsId!);
  if (!bundle) { res.status(404).json({ error: `No E3 run found for id "${req.params.obsId}"` }); return; }
  const name = req.query["name"] as string | undefined;
  const metrics = name
    ? bundle.telemetryReport.rawMetrics.filter(m => m.name.includes(name))
    : bundle.telemetryReport.rawMetrics;
  res.status(200).json({ observabilityId: bundle.observabilityId, count: metrics.length, metrics });
});

// ---------------------------------------------------------------------------
// GET /observability/:obsId/subsystems
// ---------------------------------------------------------------------------
router.get("/observability/:obsId/subsystems", (req, res): void => {
  const bundle = getE3Bundle(req.params.obsId!);
  if (!bundle) { res.status(404).json({ error: `No E3 run found for id "${req.params.obsId}"` }); return; }
  res.status(200).json({
    observabilityId: bundle.observabilityId,
    healthScore:     bundle.healthScore,
    subsystems:      bundle.metricsDashboard.subsystems,
  });
});

// ---------------------------------------------------------------------------
// GET /observability/:obsId/subsystems/:name
// ---------------------------------------------------------------------------
router.get("/observability/:obsId/subsystems/:name", (req, res): void => {
  const bundle = getE3Bundle(req.params.obsId!);
  if (!bundle) { res.status(404).json({ error: `No E3 run found for id "${req.params.obsId}"` }); return; }
  const ss = bundle.metricsDashboard.subsystems.find(
    s => s.subsystem.toLowerCase() === (req.params.name ?? "").toLowerCase()
  );
  if (!ss) {
    const available = bundle.metricsDashboard.subsystems.map(s => s.subsystem.toLowerCase()).join(", ");
    res.status(404).json({ error: `Subsystem "${req.params.name}" not found. Available: ${available}` });
    return;
  }
  res.status(200).json(ss);
});

// ---------------------------------------------------------------------------
// GET /observability/:obsId/alerts
// ---------------------------------------------------------------------------
router.get("/observability/:obsId/alerts", (req, res): void => {
  const bundle = getE3Bundle(req.params.obsId!);
  if (!bundle) { res.status(404).json({ error: `No E3 run found for id "${req.params.obsId}"` }); return; }
  const sev = req.query["severity"] as string | undefined;
  let alerts = bundle.metricsDashboard.alerts;
  if (sev) alerts = alerts.filter(a => a.severity === sev.toUpperCase());
  res.status(200).json({
    observabilityId: bundle.observabilityId,
    total:           bundle.metricsDashboard.alerts.length,
    filtered:        alerts.length,
    alerts,
  });
});

// ---------------------------------------------------------------------------
// GET /observability/:obsId/pipeline
// ---------------------------------------------------------------------------
router.get("/observability/:obsId/pipeline", (req, res): void => {
  const bundle = getE3Bundle(req.params.obsId!);
  if (!bundle) { res.status(404).json({ error: `No E3 run found for id "${req.params.obsId}"` }); return; }
  res.status(200).json(bundle.telemetryReport.pipeline);
});

// ---------------------------------------------------------------------------
// GET /observability/:obsId/coverage
// ---------------------------------------------------------------------------
router.get("/observability/:obsId/coverage", (req, res): void => {
  const bundle = getE3Bundle(req.params.obsId!);
  if (!bundle) { res.status(404).json({ error: `No E3 run found for id "${req.params.obsId}"` }); return; }
  res.status(200).json(bundle.telemetryReport.coverage);
});

// ---------------------------------------------------------------------------
// GET /observability/:obsId/failures
// ---------------------------------------------------------------------------
router.get("/observability/:obsId/failures", (req, res): void => {
  const bundle = getE3Bundle(req.params.obsId!);
  if (!bundle) { res.status(404).json({ error: `No E3 run found for id "${req.params.obsId}"` }); return; }
  res.status(200).json({
    failures: bundle.telemetryReport.failures,
    retries:  bundle.telemetryReport.retries,
    recovery: bundle.telemetryReport.recovery,
  });
});

export default router;
