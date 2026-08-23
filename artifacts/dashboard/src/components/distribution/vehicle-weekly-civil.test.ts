import type { VehiclePilotWeeklySummary } from "@workspace/api-client-react";
import { describe, expect, it } from "vitest";
import {
  buildWeeklyCoverage,
  currentTashkentMonday,
  formatCivilWeekRange,
} from "./vehicle-weekly-civil";

describe("F10 serialized civil-date dashboard contract", () => {
  it("matches daily coverage, renders the week, and classifies future days from real JSON strings", () => {
    const response = JSON.parse(`{
      "readiness": false,
      "reasons": ["coverage"],
      "week": {
        "weekStart": "2026-08-17",
        "weekEndExclusive": "2026-08-24",
        "utcStart": "2026-08-16T19:00:00.000Z",
        "utcEndExclusive": "2026-08-23T19:00:00.000Z",
        "timezone": "+05:00",
        "currentWeek": true,
        "defaultedWeekStart": false,
        "requiredThroughDate": "2026-08-19",
        "requiredDayCount": 3
      },
      "tolerances": { "quantity": 0.001, "weightKg": 0.001 },
      "kpis": {
        "productCount": 0,
        "inventoryCurrent": { "quantity": 0, "weightKg": 0 },
        "expectedCurrent": { "quantity": 0, "weightKg": 0 },
        "eventNet": { "quantity": 0, "weightKg": 0 },
        "movementNet": { "quantity": 0, "weightKg": 0 },
        "requiredDays": 3,
        "appliedDays": 2,
        "blockerCount": 1
      },
      "products": [],
      "days": [
        {
          "date": "2026-08-17",
          "reconciliationId": 1,
          "status": "applied",
          "allCounted": true,
          "discrepancyCount": 0,
          "discrepancyQuantity": 0,
          "missing": false
        },
        {
          "date": "2026-08-18",
          "reconciliationId": 2,
          "status": "applied",
          "allCounted": true,
          "discrepancyCount": 0,
          "discrepancyQuantity": 0,
          "missing": false
        }
      ],
      "blockers": []
    }`) as VehiclePilotWeeklySummary;

    const coverage = buildWeeklyCoverage(
      response.week.weekStart,
      response.week.requiredThroughDate,
      response.days,
    );

    expect(coverage[0].day?.date).toBe("2026-08-17");
    expect(coverage[1].day?.date).toBe("2026-08-18");
    expect(coverage[2]).toMatchObject({
      date: "2026-08-19",
      day: undefined,
      futureNotRequired: false,
    });
    expect(coverage[3]).toMatchObject({
      date: "2026-08-20",
      day: undefined,
      futureNotRequired: true,
    });
    expect(
      formatCivilWeekRange(
        response.week.weekStart,
        response.week.weekEndExclusive,
      ),
    ).toContain("23");
  });

  it("does not shift the civil week across the UTC/+05:00 midnight boundary", () => {
    expect(
      currentTashkentMonday(Date.parse("2026-08-16T18:59:59.999Z")),
    ).toBe("2026-08-10");
    expect(
      currentTashkentMonday(Date.parse("2026-08-16T19:00:00.000Z")),
    ).toBe("2026-08-17");
  });
});