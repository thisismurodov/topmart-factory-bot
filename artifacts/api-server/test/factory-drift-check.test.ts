import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Guard-of-the-guard test for the FACTORY schema drift check
// (scripts/src/check-schema-drift.ts). It compares the runtime DDL result
// (bot init_db + API initDb) against the canonical Drizzle schema. If that
// script silently broke, factory schema drift could go green forever. So we:
//
//   1. run it CLEAN and assert exit 0
//   2. run it with a deliberately injected drift (an extra column added to
//      the runtime throwaway DB via the FACTORY_DRIFT_TEST_EXTRA_DDL hook)
//      and assert exit 1 with a column-drift message
//
// Each run creates its own pid+timestamp-suffixed throwaway databases on the
// shared Railway server (see test-schema-contention memory), so parallel
// validations cannot collide. Runs are slow (python init + pnpm child
// processes + drizzle-kit push + 2 DB creates each) — generous timeouts,
// serial file execution (fileParallelism: false in vitest config).
// ─────────────────────────────────────────────────────────────────────────────

const adminUrl = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) throw new Error("RAILWAY_DATABASE_URL or DATABASE_URL must be set to run these tests");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

function runDriftCheck(extraEnv: Record<string, string> = {}): {
  status: number | null;
  out: string;
} {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: adminUrl,
    ...extraEnv,
  };
  const res = spawnSync(
    "pnpm",
    ["--filter", "@workspace/scripts", "run", "check-schema-drift"],
    { cwd: repoRoot, env, encoding: "utf8", timeout: 280_000 },
  );
  return { status: res.status, out: `${res.stdout ?? ""}\n${res.stderr ?? ""}` };
}

describe("check-schema-drift script self-test", () => {
  it("exits 0 on a clean (in-sync) state", { timeout: 300_000 }, () => {
    const { status, out } = runDriftCheck();
    expect(status, `expected clean run to pass, output:\n${out}`).toBe(0);
    expect(out).toContain("drift yo'q");
  });

  it("exits 1 when the runtime copy has an extra column (deliberate drift)", { timeout: 300_000 }, () => {
    const { status, out } = runDriftCheck({
      // Injected ONLY into the runtime-DDL throwaway DB — simulates someone
      // adding a column to bot init_db/API initDb without updating Drizzle.
      FACTORY_DRIFT_TEST_EXTRA_DDL:
        "ALTER TABLE products ADD COLUMN drift_test_extra_col TEXT",
    });
    expect(status, `expected drifted run to fail, output:\n${out}`).toBe(1);
    // The extra column must be reported as missing from the Drizzle schema.
    expect(out).toContain("Drizzle sxemasida yo'q ustun");
    expect(out).toContain("drift_test_extra_col");
  });
});
