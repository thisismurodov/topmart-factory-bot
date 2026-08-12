// Task: yangi/tahrirlangan do'kon GPS koordinatasi viloyat medianidan >60 km
// bo'lsa ogohlantirish. gpsOutlierKm — DB'siz mock query bilan tekshiriladi.
import { describe, it, expect } from "vitest";
import { gpsOutlierKm, GPS_OUTLIER_KM } from "../src/lib/gpsOutlier";

function fakeDb(rows: { latitude: number; longitude: number }[]) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  return {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows };
    },
  };
}

// Namangan atrofidagi klaster (~41.0N, 71.6E)
const namangan = [
  { latitude: 41.0, longitude: 71.6 },
  { latitude: 41.01, longitude: 71.62 },
  { latitude: 40.99, longitude: 71.58 },
  { latitude: 41.02, longitude: 71.61 },
];

describe("gpsOutlierKm", () => {
  it("klaster ichidagi nuqta — null (outlier emas)", async () => {
    const db = fakeDb(namangan);
    expect(await gpsOutlierKm(db, "Namangan", 41.005, 71.605)).toBeNull();
  });

  it("Toshkent koordinatasi Namangan klasteridan — masofa qaytadi (>60 km)", async () => {
    const db = fakeDb(namangan);
    const dist = await gpsOutlierKm(db, "Namangan", 41.31, 69.28);
    expect(dist).not.toBeNull();
    expect(dist!).toBeGreaterThan(GPS_OUTLIER_KM);
  });

  it("3 tadan kam do'kon — tekshirilmaydi (null)", async () => {
    const db = fakeDb(namangan.slice(0, 2));
    expect(await gpsOutlierKm(db, "Namangan", 41.31, 69.28)).toBeNull();
  });

  it("koordinata yoki viloyat yo'q — null, DB so'rovi yuborilmaydi", async () => {
    const db = fakeDb(namangan);
    expect(await gpsOutlierKm(db, null, 41.0, 71.6)).toBeNull();
    expect(await gpsOutlierKm(db, "Namangan", null, 71.6)).toBeNull();
    expect(db.calls.length).toBe(0);
  });

  it("excludeId berilsa SQL'da id <> filtri bo'ladi", async () => {
    const db = fakeDb(namangan);
    await gpsOutlierKm(db, "Namangan", 41.0, 71.6, 77);
    expect(db.calls[0].sql).toContain("id <> $2");
    expect(db.calls[0].params).toEqual(["Namangan", 77]);
  });
});
