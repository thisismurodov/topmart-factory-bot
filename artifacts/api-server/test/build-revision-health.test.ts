import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import healthRouter from "../src/routes/health";

const ORIGINAL_COMMIT = process.env.TOPMART_BUILD_COMMIT;
const ORIGINAL_SOURCE_SHA = process.env.TOPMART_SOURCE_SHA256;
const ORIGINAL_RAILWAY_COMMIT = process.env.RAILWAY_GIT_COMMIT_SHA;
const ORIGINAL_COMPILED_COMMIT = (
  globalThis as typeof globalThis & { __TOPMART_BUILD_COMMIT__?: string }
).__TOPMART_BUILD_COMMIT__;

afterEach(() => {
  if (ORIGINAL_COMMIT === undefined) delete process.env.TOPMART_BUILD_COMMIT;
  else process.env.TOPMART_BUILD_COMMIT = ORIGINAL_COMMIT;
  if (ORIGINAL_SOURCE_SHA === undefined) delete process.env.TOPMART_SOURCE_SHA256;
  else process.env.TOPMART_SOURCE_SHA256 = ORIGINAL_SOURCE_SHA;
  if (ORIGINAL_RAILWAY_COMMIT === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
  else process.env.RAILWAY_GIT_COMMIT_SHA = ORIGINAL_RAILWAY_COMMIT;
  const buildGlobals = globalThis as typeof globalThis & {
    __TOPMART_BUILD_COMMIT__?: string;
  };
  if (ORIGINAL_COMPILED_COMMIT === undefined) {
    delete buildGlobals.__TOPMART_BUILD_COMMIT__;
  } else {
    buildGlobals.__TOPMART_BUILD_COMMIT__ = ORIGINAL_COMPILED_COMMIT;
  }
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

  it("falls back to the Railway runtime commit when the compiled commit is unknown", async () => {
    const railwayCommit = "976e326882e3ddc601022159071b52b60e2127b5";
    (
      globalThis as typeof globalThis & { __TOPMART_BUILD_COMMIT__?: string }
    ).__TOPMART_BUILD_COMMIT__ = "unknown";
    process.env.RAILWAY_GIT_COMMIT_SHA = railwayCommit;
    process.env.TOPMART_SOURCE_SHA256 = "b".repeat(64);

    const app = express();
    app.use(healthRouter);
    const server = app.listen(0);

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Test HTTP porti ochilmadi");
      }
      const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
      const version = await fetch(`http://127.0.0.1:${address.port}/version`);

      expect(health.status).toBe(200);
      expect(health.headers.get("x-topmart-build-commit")).toBe(railwayCommit);
      expect(await version.json()).toEqual({
        service: "topmart-api",
        revision: railwayCommit,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});