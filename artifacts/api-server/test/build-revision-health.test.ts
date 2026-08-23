import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import healthRouter from "../src/routes/health";

const ORIGINAL_COMMIT = process.env.TOPMART_BUILD_COMMIT;
const ORIGINAL_SOURCE_SHA = process.env.TOPMART_SOURCE_SHA256;

afterEach(() => {
  if (ORIGINAL_COMMIT === undefined) delete process.env.TOPMART_BUILD_COMMIT;
  else process.env.TOPMART_BUILD_COMMIT = ORIGINAL_COMMIT;
  if (ORIGINAL_SOURCE_SHA === undefined) delete process.env.TOPMART_SOURCE_SHA256;
  else process.env.TOPMART_SOURCE_SHA256 = ORIGINAL_SOURCE_SHA;
});

describe("build revision health evidence", () => {
  it("returns commit and deterministic source hash in no-store headers", async () => {
    const sourceSha = "a".repeat(64);
    process.env.TOPMART_BUILD_COMMIT = "reviewed-commit";
    process.env.TOPMART_SOURCE_SHA256 = sourceSha;

    const app = express();
    app.use(healthRouter);
    const server = app.listen(0);

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Test HTTP porti ochilmadi");
      }
      const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-topmart-build-commit")).toBe(
        "reviewed-commit",
      );
      expect(response.headers.get("x-topmart-source-sha256")).toBe(sourceSha);
      expect(await response.json()).toEqual({ status: "ok" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});