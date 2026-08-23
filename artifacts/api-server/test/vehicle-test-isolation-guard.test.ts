import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// STATIC ISOLATION GUARD (source assertions).
//
// The vehicle-distribution test harnesses provision/drop databases. This guard
// statically proves — by inspecting their SOURCE — that none of them can select
// an admin/provisioning URL from the runtime RAILWAY_DATABASE_URL / DATABASE_URL.
// The admin URL MUST come exclusively from VEHICLE_TEST_DATABASE_ADMIN_URL via
// the shared helper. This fails loudly if anyone re-introduces a runtime-URL
// fallback for provisioning.
// ─────────────────────────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));

const HARNESSES = [
  "vehicle-handoff.test.ts",
  "vehicle-handoff-f3-f4-upgrade.test.ts",
  "vehicle-distribution-pilot.test.ts",
  "distribution-fresh-db.test.ts",
  "vehicle-return-f9.test.ts",
];

function read(rel: string): string {
  return readFileSync(path.join(here, rel), "utf8");
}

// Strip line and block comments so assertions about "source that selects an
// admin URL" ignore prose in comments (which legitimately mentions the runtime
// vars while explaining the contract).
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("vehicle harness DB-isolation static guard", () => {
  for (const file of HARNESSES) {
    describe(file, () => {
      const raw = read(file);
      const code = stripComments(raw);

      it("imports the isolated-admin-URL helper", () => {
        expect(code).toContain("requireVehicleTestAdminUrl");
        expect(code).toMatch(/from ["']\.\/helpers\/vehicle-test-db["']/);
      });

      it("derives its admin URL ONLY from requireVehicleTestAdminUrl()", () => {
        // The only admin-URL assignment must be the helper call.
        expect(code).toMatch(
          /const\s+adminUrl\s*=\s*requireVehicleTestAdminUrl\(\)/,
        );
      });

      it("never falls back to RAILWAY_DATABASE_URL / DATABASE_URL for admin selection", () => {
        // No `X || process.env.DATABASE_URL` fallback expressions.
        expect(code).not.toMatch(
          /process\.env\.RAILWAY_DATABASE_URL\s*\|\|\s*process\.env\.DATABASE_URL/,
        );
        // adminUrl must never be assigned from the runtime vars.
        expect(code).not.toMatch(
          /adminUrl\s*=\s*process\.env\.(RAILWAY_DATABASE_URL|DATABASE_URL)/,
        );
        // No READ of the runtime vars in executable code. They may only be
        // WRITTEN with a derived child URL (`process.env.X = ...`) or removed
        // (`delete process.env.X`). Any other occurrence — a read in a
        // condition/expression — is forbidden.
        for (const varName of ["RAILWAY_DATABASE_URL", "DATABASE_URL"]) {
          const re = new RegExp(`process\\.env\\.${varName}\\b`, "g");
          let m: RegExpExecArray | null;
          while ((m = re.exec(code)) !== null) {
            const before = code.slice(Math.max(0, m.index - 8), m.index);
            const after = code.slice(m.index + m[0].length);
            const isDelete = /delete\s+$/.test(before);
            const isWrite = /^\s*=(?!=)/.test(after);
            expect(
              isDelete || isWrite,
              `${varName} is READ (not write/delete) at index ${m.index}: "${code.slice(m.index, m.index + 40)}"`,
            ).toBe(true);
          }
        }
      });

      it("only ever WRITES a derived child URL to the app runtime env", () => {
        // Any assignment to the runtime URLs must use childEnv/tmpUrl-derived
        // values, never process.env.* reads. We assert no assignment copies a
        // runtime var into another runtime var.
        expect(code).not.toMatch(
          /process\.env\.(RAILWAY_DATABASE_URL|DATABASE_URL)\s*=\s*process\.env\./,
        );
      });
    });
  }

  describe("helpers/vehicle-test-db.ts", () => {
    const code = stripComments(read("helpers/vehicle-test-db.ts"));

    it("selects the admin URL ONLY from VEHICLE_TEST_DATABASE_ADMIN_URL", () => {
      expect(code).toContain("process.env.VEHICLE_TEST_DATABASE_ADMIN_URL");
    });

    it("does not read RAILWAY_DATABASE_URL / DATABASE_URL for admin selection", () => {
      // The helper may only WRITE these (in botDbEnv return objects); it must
      // never READ process.env.RAILWAY_DATABASE_URL / DATABASE_URL.
      expect(code).not.toMatch(/process\.env\.RAILWAY_DATABASE_URL/);
      expect(code).not.toMatch(/process\.env\.DATABASE_URL/);
    });

    it("fails closed when the isolated admin URL is absent", () => {
      expect(code).toMatch(/throw new Error\(/);
      expect(code).toContain("VEHICLE_TEST_DATABASE_ADMIN_URL must be set");
    });
  });
});
