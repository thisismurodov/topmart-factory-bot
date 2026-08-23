import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import { GetVehicleDistributionPilotWeeklySummaryResponse } from "@workspace/api-zod";
import {
  readPilotWeeklySummary,
  resolveWeeklyWindow,
  WeeklySummaryValidationError,
} from "../src/routes/vehicle-distribution/weekly-summary-service";
import {
  createVehicleWeeklySummaryRouter,
  makeWeeklySummaryAdminAuth,
} from "../src/routes/vehicle-distribution/weekly-summary-router";
import type { Pool } from "pg";

const weeklySummaryFixture: Awaited<
  ReturnType<typeof readPilotWeeklySummary>
> = {
  readiness: false,
  reasons: ["coverage"],
  week: {
    weekStart: "2026-08-17",
    weekEndExclusive: "2026-08-24",
    utcStart: "2026-08-16T19:00:00.000Z",
    utcEndExclusive: "2026-08-23T19:00:00.000Z",
    timezone: "+05:00",
    currentWeek: true,
    defaultedWeekStart: false,
    requiredThroughDate: "2026-08-23",
    requiredDayCount: 7,
  },
  tolerances: { quantity: 0.001, weightKg: 0.001 },
  kpis: {
    productCount: 0,
    inventoryCurrent: { quantity: 0, weightKg: 0 },
    expectedCurrent: { quantity: 0, weightKg: 0 },
    eventNet: { quantity: 0, weightKg: 0 },
    movementNet: { quantity: 0, weightKg: 0 },
    requiredDays: 7,
    appliedDays: 1,
    blockerCount: 1,
  },
  products: [],
  days: [
    {
      date: "2026-08-17",
      reconciliationId: 1,
      status: "applied",
      allCounted: true,
      discrepancyCount: 0,
      discrepancyQuantity: 0,
      missing: false,
    },
  ],
  blockers: [],
};

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

describe("F10 date-only response serialization", () => {
  it("keeps civil dates as YYYY-MM-DD strings while timestamps remain Date values", () => {
    const parsed =
      GetVehicleDistributionPilotWeeklySummaryResponse.parse(
        weeklySummaryFixture,
      );

    expect(parsed.week.weekStart).toBe("2026-08-17");
    expect(parsed.week.weekEndExclusive).toBe("2026-08-24");
    expect(parsed.week.requiredThroughDate).toBe("2026-08-23");
    expect(parsed.days[0].date).toBe("2026-08-17");
    expect(parsed.week.weekStart).not.toBeInstanceOf(Date);
    expect(parsed.days[0].date).not.toBeInstanceOf(Date);
    expect(parsed.week.utcStart).toBeInstanceOf(Date);
    expect(parsed.week.utcEndExclusive).toBeInstanceOf(Date);
  });

  it("returns exact date-only strings from the real Express router JSON boundary", async () => {
    const previous = {
      enabled: process.env.VEHICLE_DISTRIBUTION_ENABLED,
      schema: process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED,
    };
    process.env.VEHICLE_DISTRIBUTION_ENABLED = "1";
    process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED = "1";

    const client = { release() {} };
    const pool = {
      query: async () => ({ rows: [{ id: 1, role: "admin" }] }),
      connect: async () => client,
    } as unknown as Pool;
    const app = express();
    app.use(
      createVehicleWeeklySummaryRouter(
        pool,
        async () => weeklySummaryFixture,
      ),
    );
    const server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    const url = `http://127.0.0.1:${
      typeof address === "object" && address ? address.port : 0
    }/vehicle-distribution/pilot/weekly-summary?weekStart=2026-08-17`;

    try {
      const response = await fetch(url, {
        headers: { authorization: "Bearer admin-token" },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        week: Record<string, unknown>;
        days: Array<Record<string, unknown>>;
      };
      expect(body.week.weekStart).toBe("2026-08-17");
      expect(body.week.weekEndExclusive).toBe("2026-08-24");
      expect(body.week.requiredThroughDate).toBe("2026-08-23");
      expect(body.days[0].date).toBe("2026-08-17");
      expect(body.week.utcStart).toBe("2026-08-16T19:00:00.000Z");
      expect(body.week.utcEndExclusive).toBe("2026-08-23T19:00:00.000Z");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous.enabled == null) {
        delete process.env.VEHICLE_DISTRIBUTION_ENABLED;
      } else {
        process.env.VEHICLE_DISTRIBUTION_ENABLED = previous.enabled;
      }
      if (previous.schema == null) {
        delete process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED;
      } else {
        process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED = previous.schema;
      }
    }
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