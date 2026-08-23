import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
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
