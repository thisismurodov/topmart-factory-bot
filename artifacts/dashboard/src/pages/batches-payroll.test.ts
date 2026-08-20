import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PayrollCell } from "./batches-payroll-cell";

const roleBasedBatch = {
  earnings: 0,
  payrollMethod: "ROLE_BASED_KG" as const,
  payrollLineName: "Arqon liniyasi",
  payrollWorkDate: "2026-08-19",
};

describe("Batches payroll cell", () => {
  it("shows the frozen daily total for a closed line-day", () => {
    const html = renderToStaticMarkup(
      createElement(PayrollCell, {
        batch: {
          ...roleBasedBatch,
          payrollStatus: "CLOSED",
          frozenDailyEarnings: 30000,
        },
      }),
    );

    expect(html).toContain("payroll-status-closed");
    expect(html).toContain("30");
    expect(html).toContain("Kunlik yakuniy maosh");
    expect(html).toContain("Arqon liniyasi");
    expect(html).not.toContain(">0<");
  });

  it("explains that an open line-day is calculated when the line closes", () => {
    const html = renderToStaticMarkup(
      createElement(PayrollCell, {
        batch: {
          ...roleBasedBatch,
          payrollStatus: "OPEN",
          frozenDailyEarnings: null,
        },
      }),
    );

    expect(html).toContain("payroll-status-open");
    expect(html).toContain("Liniya yopilganda hisoblanadi");
    expect(html).not.toContain("Kunlik yakuniy maosh");
  });

  it("keeps product-rate earnings unchanged", () => {
    const html = renderToStaticMarkup(
      createElement(PayrollCell, {
        batch: {
          earnings: 18000,
          payrollMethod: "PRODUCT_RATE",
          payrollStatus: "PRODUCT_RATE",
          payrollLineName: null,
          payrollWorkDate: "2026-08-18",
          frozenDailyEarnings: null,
        },
      }),
    );

    expect(html).toContain("18");
    expect(html).not.toContain("payroll-status-open");
    expect(html).not.toContain("payroll-status-closed");
  });
});