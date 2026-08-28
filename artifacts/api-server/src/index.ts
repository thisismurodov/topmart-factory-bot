import app from "./app";
import { logger } from "./lib/logger";
import { initDb } from "./init-db";
import { backfillRouteBizScores } from "./lib/routePlanService";
import { startPrintAgentHealthMonitor } from "./routes/vehicle-distribution/print-agent-health-router";

// DM-001 production activation: schema, backup/restore rehearsal, exact pilot
// bootstrap, and isolation checks were completed before this release. Keep the
// existing request-time gates as the enforcement point, but activate all three
// together from the traceable release when Railway variable control is absent.
process.env.VEHICLE_DISTRIBUTION_ENABLED = "1";
process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED = "1";
process.env.PRODUCTION_LABELS_SCHEMA_APPROVED = "1";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

initDb()
  .then(() => {
    logger.info("DB initialized");
    startPrintAgentHealthMonitor();
    // Eski marshrut qatorlariga biz_score/biz_reasons backfill (idempotent,
    // faqat NULL qatorlar). Xato bo'lsa server baribir ishga tushadi.
    backfillRouteBizScores()
      .then(({ scanned, updated }) => {
        if (scanned > 0) logger.info({ scanned, updated }, "Route biz-score backfill");
      })
      .catch((err) => logger.warn({ err }, "Route biz-score backfill failed"));
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening");
    });
  })
  .catch((err) => {
    logger.error({ err }, "DB init failed — aborting");
    process.exit(1);
  });
