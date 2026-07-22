import app from "./app";
import { logger } from "./lib/logger";
import { startMonitoringLoop } from "./lib/monitoring-runner";
import { startPipelineHealthLoop } from "./lib/pipeline-health-runner";
import { startWorkerLoop } from "./lib/job-worker";
import { startPipelineMonitoring } from "./lib/pipeline-monitoring-interceptor";
import { startRegressionRunner } from "./lib/post-build-regression-runner";
import { startMonitoringPersistence } from "./lib/monitoring-persistence-service";
import { startSubsystemEmitters }    from "./lib/subsystem-emitters";

// Absorb non-fatal uncaught exceptions so the server stays alive during long scrape jobs.
// Known non-fatal patterns:
//   - "overwritten" — pino thread-stream buffer collision on large log writes
//   - "Connection terminated unexpectedly" — pg idle client drop (pool.on('error') should catch
//     these first, but belt-and-suspenders here)
process.on("uncaughtException", (err) => {
  const msg = (err as Error).message ?? String(err);
  const nonFatal =
    msg.includes("overwritten") ||
    msg.includes("Connection terminated unexpectedly") ||
    msg.includes("ECONNRESET");
  if (nonFatal) {
    console.error("[uncaughtException][non-fatal]", msg);
  } else {
    console.error("[uncaughtException][FATAL — re-throwing]", msg);
    process.exit(1);
  }
});

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // E1 — system-level health monitoring (60s interval, 5s warm-up)
  startMonitoringLoop(port, 60);

  // Phase 6.2 — pipeline-stage health + auto-repair (30s interval, 8s warm-up)
  startPipelineHealthLoop();

  // PH-2 — QA-3 pipeline monitoring interceptor (auto-captures stage snapshots)
  startPipelineMonitoring();

  // PH-3 — automatic regression validation after every Website Prime build
  startRegressionRunner();

  // PH-5 — persist QA-3 snapshots to R2 for cross-restart continuity
  void startMonitoringPersistence().catch((err) => {
    logger.error({ err }, "PH-5: persistence service failed to start");
  });

  // Background crawl worker
  startWorkerLoop().catch((workerErr) => {
    logger.error({ err: workerErr }, "Worker loop failed to start");
  });

  // Real-time SSE infrastructure — auto-emit from all subsystems
  startSubsystemEmitters();
});
