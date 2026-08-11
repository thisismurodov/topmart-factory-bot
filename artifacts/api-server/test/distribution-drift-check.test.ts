import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Guard-of-the-guard test (Task: confirm the distribution drift check itself
// works). `check-distribution-drift` compares three schema copies (bot DDL,
// init-distribution.ts, Drizzle mirror). If that script silently broke, drift
// could go green forever. So we:
//
//   1. run it CLEAN and assert exit 0
//   2. run it with a deliberately injected drift (an extra index applied to
//      one copy's throwaway DB via the DIST_DRIFT_TEST_EXTRA_DDL test hook)
//      and assert exit 1 with an index-drift message
//
// Each run creates its own pid+timestamp-suffixed throwaway databases on the
// shared Railway server (see test-schema-contention memory), so parallel
// validations cannot collide. Runs are slow (python init + pnpm child
// processes + 2 DB creates each) — generous timeouts, serial file execution.
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
    ["--filter", "@workspace/scripts", "run", "check-distribution-drift"],
    { cwd: repoRoot, env, encoding: "utf8", timeout: 280_000 },
  );
  return { status: res.status, out: `${res.stdout ?? ""}\n${res.stderr ?? ""}` };
}

describe("check-distribution-drift script self-test", () => {
  it("exits 0 on a clean (in-sync) state", { timeout: 300_000 }, () => {
    const { status, out } = runDriftCheck();
    expect(status, `expected clean run to pass, output:\n${out}`).toBe(0);
    expect(out).toContain("drift yo'q");
  });

  it("exits 1 when one copy has an extra index (deliberate drift)", { timeout: 300_000 }, () => {
    const { status, out } = runDriftCheck({
      // Injected ONLY into the init-distribution.ts throwaway DB — simulates
      // someone adding an index to one schema copy but not the others.
      DIST_DRIFT_TEST_EXTRA_DDL:
        "CREATE INDEX drift_test_extra_idx ON distribution.dokonlar (viloyat, hudud)",
    });
    expect(status, `expected drifted run to fail, output:\n${out}`).toBe(1);
    // The extra index must be reported as unexpected vs the Drizzle mirror.
    expect(out).toContain("ko'zda tutilmagan indeks");
    expect(out).toContain("dokonlar(viloyat, hudud)");
  });
});
