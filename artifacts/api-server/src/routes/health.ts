import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getBuildRevision } from "../lib/build-revision";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const revision = getBuildRevision();
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-TopMart-Build-Commit", revision.commit);
  res.setHeader("X-TopMart-Source-SHA256", revision.sourceSha256);
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/version", (_req, res) => {
  res.json({
    service: "topmart-api",
    revision:
      process.env.RAILWAY_GIT_COMMIT_SHA ??
      process.env.SOURCE_VERSION ??
      process.env.GIT_COMMIT_SHA ??
      "unknown",
  });
});

export default router;
