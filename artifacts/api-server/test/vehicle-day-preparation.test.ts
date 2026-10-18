import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

test("daily preparation bot database and delivery regressions", () => {
  const url = new URL(process.env.VEHICLE_TEST_DATABASE_ADMIN_URL || "");
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Day preparation tests require isolated loopback PostgreSQL");
  }
  const env = { ...process.env, DATABASE_URL: url.toString() };
  delete env.RAILWAY_DATABASE_URL;
  execFileSync("python", ["-m", "unittest", "discover", "-s", "tests", "-p", "test_day_preparation.py"], {
    cwd: fileURLToPath(new URL("../../distribution-bot/", import.meta.url)),
    env, stdio: "pipe",
  });
}, 60000);
