import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  resolveWeeklyWindow,
  WeeklySummaryValidationError,
} from "../src/routes/vehicle-distribution/weekly-summary-service";
import { makeWeeklySummaryAdminAuth } from "../src/routes/vehicle-distribution/weekly-summary-router";
import type { Pool } from "pg";

describe("F10 weekly window contract", () => {
  it("uses a fixed +05:00 half-open interval without server-local timezone", () => {
    const w = resolveWeeklyWindow(
      "2025-01-06",
      new Date("2025-01-08T08:00:00.000Z"),
    );
    expect(w.utcStart).toBe("2025-01-05T19:00:00.000Z");
    expect(w.utcEndExclusive).toBe("2025-01-12T19:00:00.000Z");
    expect(new Date("2025-01-05T18:59:59.999Z") >= new Date(w.utcStart)).toBe(false);
    expect(new Date("2025-01-05T19:00:00.000Z") >= new Date(w.utcStart)).toBe(true);
    expect(new Date("2025-01-12T19:00:00.000Z") < new Date(w.utcEndExclusive)).toBe(false);
  });

  it("defaults to current Tashkent Monday and requires only elapsed days", () => {
    const w = resolveWeeklyWindow(undefined, new Date("2025-01-08T20:30:00Z"));
    expect(w.weekStart).toBe("2025-01-06");
    expect(w.today).toBe("2025-01-09");
    expect(w.defaulted).toBe(true);
    expect(w.requiredDates).toEqual([
      "2025-01-06",
      "2025-01-07",
      "2025-01-08",
      "2025-01-09",
    ]);
  });

  it("requires all seven days for completed weeks", () => {
    const w = resolveWeeklyWindow(
      "2024-12-30",
      new Date("2025-01-08T08:00:00Z"),
    );
    expect(w.currentWeek).toBe(false);
    expect(w.requiredDates).toHaveLength(7);
  });

  it.each(["2025-01-07", "not-a-date", "2025-02-31"])(
    "rejects invalid/non-Monday civil date %s",
    (date) => {
      expect(() =>
        resolveWeeklyWindow(date, new Date("2025-01-08T08:00:00Z")),
      ).toThrow(WeeklySummaryValidationError);
    },
  );

  it("rejects future weeks", () => {
    expect(() =>
      resolveWeeklyWindow("2025-01-13", new Date("2025-01-08T08:00:00Z")),
    ).toThrow(/Future/);
  });
});

describe("F10 service remains SELECT-only", () => {
  it("contains no SQL writers, transaction mutations, or row locks", () => {
    const source = readFileSync(
      path.resolve(
        import.meta.dirname,
        "../src/routes/vehicle-distribution/weekly-summary-service.ts",
      ),
      "utf8",
    );
    expect(source).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|UPSERT|TRUNCATE|ALTER|BEGIN|COMMIT|ROLLBACK)\b|FOR\s+UPDATE/i,
    );
  });
});

describe("F10 explicit admin-session auth", () => {
  function response() {
    const state = { status: 0, body: undefined as unknown };
    return {
      state,
      value: {
        status(code: number) {
          state.status = code;
          return this;
        },
        json(body: unknown) {
          state.body = body;
          return this;
        },
      },
    };
  }

  it("forbids a bot credential without consulting session auth", async () => {
    let queried = false;
    const pool = {
      query: async () => {
        queried = true;
        return { rows: [] };
      },
    } as unknown as Pool;
    const res = response();
    let next = false;
    await makeWeeklySummaryAdminAuth(pool)(
      {
        headers: { "x-vehicle-distribution-bot-key": "valid-bot-key" },
      } as never,
      res.value as never,
      (() => {
        next = true;
      }) as never,
    );
    expect(res.state.status).toBe(403);
    expect(queried).toBe(false);
    expect(next).toBe(false);
  });

  it.each([
    ["viewer", 403, false],
    ["admin", 0, true],
  ])("resolves %s authority server-side", async (role, status, expectedNext) => {
    const pool = {
      query: async () => ({ rows: [{ id: 1, role }] }),
    } as unknown as Pool;
    const res = response();
    let next = false;
    await makeWeeklySummaryAdminAuth(pool)(
      { headers: { authorization: "Bearer session-token" } } as never,
      res.value as never,
      (() => {
        next = true;
      }) as never,
    );
    expect(res.state.status).toBe(status);
    expect(next).toBe(expectedNext);
  });
});