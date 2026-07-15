import { describe, it, expect } from "vitest";
import {
  planRoutes,
  haversineKm,
  splitOutliers,
  countCrossings,
  computeRouteStats,
  validatePlan,
  type PlanShop,
} from "../src/lib/routePlanner";

// Namangan atrofida sun'iy, lekin real ko'rinishdagi 153 do'kon generatsiya qilamiz
// (deterministik LCG — testlar barqaror bo'lishi uchun)
function makeShops(n: number, seed = 42): PlanShop[] {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  // 5 ta "mahalla" klasteri + tarqoq do'konlar
  const centers = [
    { lat: 41.0, lng: 71.24 },
    { lat: 41.05, lng: 71.6 },
    { lat: 40.94, lng: 71.35 },
    { lat: 41.08, lng: 71.1 },
    { lat: 40.99, lng: 71.45 },
  ];
  const shops: PlanShop[] = [];
  for (let i = 0; i < n; i++) {
    const c = centers[i % centers.length];
    shops.push({
      id: i + 1,
      nomi: `Dokon ${i + 1}`,
      hudud: `Hudud ${i % centers.length}`,
      lat: c.lat + (rnd() - 0.5) * 0.06,
      lng: c.lng + (rnd() - 0.5) * 0.06,
    });
  }
  return shops;
}

describe("routePlanner", () => {
  it("153 do'konni 6 kunga bo'ladi, dublikatsiz va to'liq qamrov bilan", () => {
    const shops = makeShops(153);
    const plan = planRoutes(shops);

    expect(plan.routes).toHaveLength(6);
    expect(plan.routes.map((r) => r.kun)).toEqual([1, 2, 3, 4, 6, 7]); // juma (5) yo'q

    // Har do'kon roppa-rosa bitta marshrutda
    const seen = new Set<number>();
    for (const r of plan.routes) {
      for (const st of r.stops) {
        expect(seen.has(st.id)).toBe(false);
        seen.add(st.id);
      }
    }
    expect(seen.size).toBe(153);
    expect(plan.totalShops).toBe(153);

    // Hajmlar 22-28 oralig'ida (153/6 → 25 yoki 26)
    for (const r of plan.routes) {
      expect(r.stats.shopCount).toBeGreaterThanOrEqual(22);
      expect(r.stats.shopCount).toBeLessThanOrEqual(28);
    }
  });

  it("tartib 1..N ketma-ket va statistika to'g'ri", () => {
    const plan = planRoutes(makeShops(153));
    for (const r of plan.routes) {
      r.stops.forEach((st, i) => expect(st.tartib).toBe(i + 1));
      expect(r.stats.totalKm).toBeGreaterThan(0);
      expect(r.stats.driveMinutes).toBeGreaterThan(0);
      expect(r.stats.score).toBeGreaterThanOrEqual(0);
      expect(r.stats.score).toBeLessThanOrEqual(100);
      expect(r.stats.startShop).toBe(r.stops[0].nomi);
      expect(r.stats.endShop).toBe(r.stops[r.stops.length - 1].nomi);
    }
  });

  it("deterministik — bir xil kirish bir xil natija beradi", () => {
    const a = planRoutes(makeShops(153));
    const b = planRoutes(makeShops(153));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("NN+2-opt tasodifiy tartibdan sezilarli yaxshi", () => {
    const shops = makeShops(60);
    const plan = planRoutes(shops, { days: [1, 2], targetSize: 30 });
    for (const r of plan.routes) {
      // Tasodifiy (kiritilgan) tartib bo'yicha km
      let naiveKm = 0;
      const raw = shops.filter((s) => r.stops.some((st) => st.id === s.id));
      for (let i = 1; i < raw.length; i++) {
        naiveKm += haversineKm(raw[i - 1].lat, raw[i - 1].lng, raw[i].lat, raw[i].lng);
      }
      expect(r.stats.totalKm).toBeLessThan(naiveKm);
    }
  });

  it("kichik ro'yxat — bitta marshrut", () => {
    const plan = planRoutes(makeShops(10));
    expect(plan.routes).toHaveLength(1);
    expect(plan.routes[0].kun).toBe(1);
    expect(plan.routes[0].stops).toHaveLength(10);
  });

  it("45 do'kon (Farg'ona misoli) — 2 ta muvozanatli marshrut", () => {
    const plan = planRoutes(makeShops(45));
    expect(plan.routes).toHaveLength(2);
    const sizes = plan.routes.map((r) => r.stats.shopCount).sort();
    expect(sizes).toEqual([22, 23]);
  });

  it("bo'sh ro'yxat — bo'sh natija", () => {
    const plan = planRoutes([]);
    expect(plan.routes).toHaveLength(0);
    expect(plan.totalShops).toBe(0);
  });

  it("splitOutliers — GPS xatosi bo'lgan do'konni ajratadi", () => {
    const shops = makeShops(50);
    // Toshkent koordinatasi bilan saqlanib qolgan "Namangan" do'koni
    shops.push({ id: 999, nomi: "Xato GPS", hudud: null, lat: 41.2584, lng: 69.157 });
    const { inliers, outliers } = splitOutliers(shops);
    expect(outliers).toHaveLength(1);
    expect(outliers[0].id).toBe(999);
    expect(inliers).toHaveLength(50);
  });

  it("splitOutliers — normal to'plamda hech kim chiqarilmaydi", () => {
    const { inliers, outliers } = splitOutliers(makeShops(153));
    expect(outliers).toHaveLength(0);
    expect(inliers).toHaveLength(153);
  });

  // ── v2: kesishish, orqaga qaytish, samaradorlik ──────────────────────────────

  it("v2: har bir marshrutda kesishish (crossing) 0 ta", () => {
    const plan = planRoutes(makeShops(153));
    for (const r of plan.routes) {
      expect(r.stats.crossCount).toBe(0);
      expect(countCrossings(r.stops)).toBe(0);
    }
  });

  it("v2: turli seed'larda ham kesishishsiz", () => {
    for (const seed of [7, 99, 2026]) {
      const plan = planRoutes(makeShops(120, seed));
      for (const r of plan.routes) {
        expect(r.stats.crossCount).toBe(0);
      }
    }
  });

  it("v2: countCrossings kesishgan yo'lni aniqlaydi", () => {
    // X shaklidagi yo'l: (0,0)→(1,1)→(1,0)→(0,1) — 1 ta kesishish
    const cross = countCrossings([
      { lat: 41.0, lng: 71.0 },
      { lat: 41.01, lng: 71.01 },
      { lat: 41.01, lng: 71.0 },
      { lat: 41.0, lng: 71.01 },
    ]);
    expect(cross).toBe(1);
    // To'g'ri chiziq — 0 kesishish
    const straight = countCrossings([
      { lat: 41.0, lng: 71.0 },
      { lat: 41.0, lng: 71.01 },
      { lat: 41.0, lng: 71.02 },
      { lat: 41.0, lng: 71.03 },
    ]);
    expect(straight).toBe(0);
  });

  it("v2: computeRouteStats yangi KPI'larni qaytaradi", () => {
    const stats = computeRouteStats([
      { lat: 41.0, lng: 71.0, nomi: "A" },
      { lat: 41.0, lng: 71.02, nomi: "B" },
      { lat: 41.0, lng: 71.04, nomi: "C" },
      { lat: 41.0, lng: 71.06, nomi: "D" },
    ]);
    expect(stats.crossCount).toBe(0);
    expect(stats.backtrackPct).toBe(0); // to'g'ri chiziq — orqaga qaytish yo'q
    expect(stats.efficiency).toBe(100);
    expect(stats.score).toBeGreaterThan(0);
  });

  it("v2: zig-zag yo'lda backtrackPct > 0 va efficiency < 100", () => {
    // A→B→A' (deyarli orqaga) →B' ... sun'iy orqaga qaytish
    const stats = computeRouteStats([
      { lat: 41.0, lng: 71.0, nomi: "A" },
      { lat: 41.0, lng: 71.05, nomi: "B" },
      { lat: 41.0, lng: 71.005, nomi: "C" }, // to'liq orqaga
      { lat: 41.0, lng: 71.045, nomi: "D" }, // yana orqaga
    ]);
    expect(stats.backtrackPct).toBeGreaterThan(0);
    expect(stats.efficiency).toBeLessThan(100);
  });

  it("v2: marshrutlarda orqaga qaytish past darajada", () => {
    const plan = planRoutes(makeShops(153));
    for (const r of plan.routes) {
      expect(r.stats.backtrackPct).toBeLessThanOrEqual(35);
      expect(r.stats.efficiency).toBeGreaterThanOrEqual(50);
    }
  });

  it("v2: efficiency va score 0-100 oralig'ida", () => {
    for (const seed of [42, 7, 99]) {
      const plan = planRoutes(makeShops(100, seed));
      for (const r of plan.routes) {
        expect(r.stats.efficiency).toBeGreaterThanOrEqual(0);
        expect(r.stats.efficiency).toBeLessThanOrEqual(100);
        expect(r.stats.score).toBeGreaterThanOrEqual(0);
        expect(r.stats.score).toBeLessThanOrEqual(100);
      }
    }
  });

  it("v2: vaqt KPI'lari — driveMinutes + visitMinutes = totalMinutes", () => {
    const plan = planRoutes(makeShops(50));
    for (const r of plan.routes) {
      expect(r.stats.visitMinutes).toBe(r.stats.shopCount * 5);
      expect(r.stats.totalMinutes).toBe(r.stats.driveMinutes + r.stats.visitMinutes);
      expect(r.stats.avgHopKm).toBeGreaterThan(0);
      expect(r.stats.maxHopKm).toBeGreaterThanOrEqual(r.stats.avgHopKm);
    }
  });

  // ── v3: validatsiya dvigateli ────────────────────────────────────────────────

  it("validatePlan: sog'lom reja tekshiruvdan o'tadi", () => {
    const shops = makeShops(153);
    const plan = planRoutes(shops);
    const v = validatePlan(plan, shops);
    expect(v.ok).toBe(true);
    expect(v.issues).toHaveLength(0);
  });

  it("validatePlan: dublikat do'konni bloklaydi", () => {
    const shops = makeShops(30);
    const plan = planRoutes(shops);
    // Birinchi to'xtashni sun'iy ravishda ikkinchi marta qo'shamiz
    const first = plan.routes[0].stops[0];
    plan.routes[0].stops.push({ ...first, tartib: plan.routes[0].stops.length + 1 });
    const v = validatePlan(plan, shops);
    expect(v.ok).toBe(false);
    expect(v.issues.some((s) => s.includes("dublikat"))).toBe(true);
  });

  it("validatePlan: yo'qolgan do'konni bloklaydi", () => {
    const shops = makeShops(30);
    const plan = planRoutes(shops);
    plan.routes[0].stops.splice(0, 1); // bitta do'konni o'chirib tashlaymiz
    plan.routes[0].stops.forEach((st, i) => (st.tartib = i + 1)); // tartibni tuzatamiz
    const v = validatePlan(plan, shops);
    expect(v.ok).toBe(false);
    expect(v.issues.some((s) => s.includes("kirmagan"))).toBe(true);
  });

  it("validatePlan: buzilgan tartib raqamlarini bloklaydi", () => {
    const shops = makeShops(30);
    const plan = planRoutes(shops);
    plan.routes[0].stops[0].tartib = 99;
    const v = validatePlan(plan, shops);
    expect(v.ok).toBe(false);
    expect(v.issues.some((s) => s.includes("tartib"))).toBe(true);
  });
});
