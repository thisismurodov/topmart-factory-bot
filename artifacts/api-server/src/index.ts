import app from "./app";
import { logger } from "./lib/logger";
import { initDb } from "./init-db";
import { backfillRouteBizScores } from "./lib/routePlanService";

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
