import { describe, expect, it } from "vitest";
import { classifyMovementType, isSaleMovement, formatQty, formatDateTime } from "./vehicle-stock-helpers";

describe("classifyMovementType", () => {
  it("faqat aniq sotuv turlarini sotuv deb belgilaydi", () => {
    expect(isSaleMovement("SALE")).toBe(true);
    expect(isSaleMovement(" sold ")).toBe(true);
    expect(isSaleMovement("VEHICLE_SALE")).toBe(true);
  });
  it("substring to'qnashuvlarini sotuv deb hisoblamaydi", () => {
    for (const t of ["TRANSFER", "TRANSFER_IN", "INBOUND", "RETURN_OUT", "PRESALE", "SALE_RETURN", "wholesale", "", null, undefined]) {
      expect(isSaleMovement(t as string)).toBe(false);
    }
  });
  it("yuklash/tushirishni aniq ajratadi", () => {
    expect(classifyMovementType("IN")).toBe("load");
    expect(classifyMovementType("OUT")).toBe("unload");
    expect(classifyMovementType("TRANSFER")).toBe("other");
    expect(classifyMovementType("INVENTORY")).toBe("other");
  });
});

describe("format", () => {
  it("noma'lum qiymat uchun tire", () => {
    expect(formatQty(undefined)).toBe("—");
    expect(formatQty(Number.NaN)).toBe("—");
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("2025-01-02T03:04:05Z")).toBe("2025-01-02 03:04");
  });
});

import { formatStockPrimary as _fsp, formatLoadedPackages as _flp, formatMoney as _fm, sumByCurrency as _sbc } from "./vehicle-stock-helpers";
describe("stock value helpers", () => {
  it("kg goods show kg and historical packages", () => {
    expect(_fsp({ unitType: "kg", quantity: 0, weightKg: 12.5 })).toContain("kg");
    expect(_flp({ unitType: "kg", loadedPackageCount: 4 })).toBe("4 qadoq yuklangan");
    expect(_flp({ unitType: "kg", loadedPackageCount: null })).toBeNull();
    expect(_flp({ unitType: "dona", loadedPackageCount: 4 })).toBeNull();
    expect(_fsp({ unitType: "dona", quantity: 3 })).toBe("3 dona");
  });
  it("money never falls back to zero and never mixes currencies", () => {
    expect(_fm(null, "UZS")).toBe("Noma’lum");
    expect(_fm(10, null)).toBe("Noma’lum");
    const r = _sbc([{ costValue: 5, currency: "UZS" }, { costValue: 2, currency: "USD" }, { costValue: null, currency: "UZS" }], "costValue");
    expect(r.totals).toEqual({ UZS: 5, USD: 2 });
    expect(r.unknown).toBe(1);
  });
});
