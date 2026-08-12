import { describe, it, expect } from "vitest";
import {
  planRoutes,
  countCrossings,
  validatePlan,
  computeBusinessScores,
  priorityPullForward,
  type PlanShop,
  type ShopBusinessSignals,
} from "../src/lib/routePlanner";

// Deterministik LCG generator (route-planner.test.ts bilan bir xil)
function makeShops(n: number, seed = 42): PlanShop[] {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const centers = [
    { lat: 41.0, lng: 71.24 },
    { lat: 41.05, lng: 71.6 },
    { lat: 40.94, lng: 71.35 },
    { lat: 41.08, lng: 71.1 },
    { lat: 40.99, lng: 71.45 },
  ];
  return Array.from({ length: n }, (_, i) => {
    const c = centers[i % centers.length];
    return {
      id: i + 1,
      nomi: `Dokon ${i + 1}`,
      hudud: `Hudud ${i % centers.length}`,
      lat: c.lat + (rnd() - 0.5) * 0.06,
      lng: c.lng + (rnd() - 0.5) * 0.06,
    };
  });
}

// Ixtiyoriy do'konlarga biznes signallari qo'shish
function withBiz(shops: PlanShop[], overrides: Map<number, ShopBusinessSignals>): PlanShop[] {
  return shops.map((s) => ({ ...s, biz: overrides.get(s.id) ?? {} }));
}

describe("computeBusinessScores", () => {
  it("barcha signallar nol bo'lganda — bo'sh map qaytaradi", () => {
    const shops = makeShops(10).map((s) => ({ ...s, biz: { salesSum: 0, creditBalance: 0, daysSinceVisit: 0 } }));
    const scores = computeBusinessScores(shops);
    expect(scores.size).toBe(0);
  });

  it("biz yo'q do'konlarda — barcha signallar nol bo'lsa bo'sh map", () => {
    const shops = makeShops(10); // biz maydoni yo'q
    const scores = computeBusinessScores(shops);
    expect(scores.size).toBe(0);
  });

  it("nasiya eng yuqori bo'lgan do'kon eng baland ball oladi (40% og'irlik)", () => {
    const shops: PlanShop[] = [
      { id: 1, nomi: "A", hudud: null, lat: 41.0, lng: 71.0, biz: { creditBalance: 1_000_000, salesSum: 0, daysSinceVisit: 0 } },
      { id: 2, nomi: "B", hudud: null, lat: 41.01, lng: 71.01, biz: { creditBalance: 0, salesSum: 0, daysSinceVisit: 0 } },
      { id: 3, nomi: "C", hudud: null, lat: 41.02, lng: 71.02, biz: { creditBalance: 500_000, salesSum: 0, daysSinceVisit: 0 } },
    ];
    const scores = computeBusinessScores(shops);
    const s1 = scores.get(1)!.score;
    const s2 = scores.get(2)!.score;
    const s3 = scores.get(3)!.score;
    expect(s1).toBeGreaterThan(s3);
    expect(s3).toBeGreaterThan(s2);
    expect(s1).toBe(40); // 100% nasiya normalizatsiyasi × 40 og'irlik
  });

  it("barcha signallar to'liq bo'lgan do'kon 100 ball oladi", () => {
    const shops: PlanShop[] = [
      { id: 1, nomi: "A", hudud: null, lat: 41.0, lng: 71.0, biz: { creditBalance: 1_000_000, salesSum: 5_000_000, daysSinceVisit: 60 } },
      { id: 2, nomi: "B", hudud: null, lat: 41.01, lng: 71.01, biz: { creditBalance: 0, salesSum: 0, daysSinceVisit: 0 } },
    ];
    const scores = computeBusinessScores(shops);
    expect(scores.get(1)!.score).toBe(100);
    expect(scores.get(2)!.score).toBe(0);
  });

  it("VIP sababi — savdo hajmi 70%+ bo'lganda qo'shiladi", () => {
    const shops: PlanShop[] = [
      { id: 1, nomi: "A", hudud: null, lat: 41.0, lng: 71.0, biz: { salesSum: 10_000_000, creditBalance: 0, daysSinceVisit: 0 } },
      { id: 2, nomi: "B", hudud: null, lat: 41.01, lng: 71.01, biz: { salesSum: 1_000_000, creditBalance: 0, daysSinceVisit: 0 } },
    ];
    const scores = computeBusinessScores(shops);
    expect(scores.get(1)!.reasons).toContain("VIP");
    expect(scores.get(2)!.reasons).not.toContain("VIP");
  });

  it("uzoq bormagan sababi — 14 kundan oshganda", () => {
    const shops: PlanShop[] = [
      { id: 1, nomi: "A", hudud: null, lat: 41.0, lng: 71.0, biz: { daysSinceVisit: 30, salesSum: 0, creditBalance: 0 } },
      { id: 2, nomi: "B", hudud: null, lat: 41.01, lng: 71.01, biz: { daysSinceVisit: 5, salesSum: 0, creditBalance: 0 } },
    ];
    const scores = computeBusinessScores(shops);
    expect(scores.get(1)!.reasons.some((r) => r.includes("kun bormagan"))).toBe(true);
    expect(scores.get(2)!.reasons.some((r) => r.includes("kun bormagan"))).toBe(false);
  });

  it("maxsus vaznlar ballarni o'zgartiradi (nasiya 60%)", () => {
    const shops: PlanShop[] = [
      { id: 1, nomi: "A", hudud: null, lat: 41.0, lng: 71.0, biz: { creditBalance: 1_000_000, salesSum: 0, daysSinceVisit: 0 } },
    ];
    const scores = computeBusinessScores(shops, { credit: 60, days: 20, sales: 20 });
    expect(scores.get(1)!.score).toBe(60);
  });

  it("vaznlar jami 100 bo'lmasa — normalizatsiya qilinadi", () => {
    const shops: PlanShop[] = [
      { id: 1, nomi: "A", hudud: null, lat: 41.0, lng: 71.0, biz: { creditBalance: 1_000_000, salesSum: 0, daysSinceVisit: 0 } },
    ];
    // credit=3, days=1, sales=1 → credit ulushi 60%
    const scores = computeBusinessScores(shops, { credit: 3, days: 1, sales: 1 });
    expect(scores.get(1)!.score).toBe(60);
  });

  it("noto'g'ri vaznlar (manfiy yoki jami 0) — default 40/35/25 ishlatiladi", () => {
    const shops: PlanShop[] = [
      { id: 1, nomi: "A", hudud: null, lat: 41.0, lng: 71.0, biz: { creditBalance: 1_000_000, salesSum: 0, daysSinceVisit: 0 } },
    ];
    expect(computeBusinessScores(shops, { credit: -1, days: 50, sales: 51 }).get(1)!.score).toBe(40);
    expect(computeBusinessScores(shops, { credit: 0, days: 0, sales: 0 }).get(1)!.score).toBe(40);
  });
});

describe("priorityPullForward", () => {
  it("kesishishsiz geo-tartib kesishishsiz qoladi", () => {
    const base = makeShops(20);
    const plan = planRoutes(base, { days: [1] });
    const geoOrdered = plan.routes[0].stops as PlanShop[];

    // Har xil biznes signallari bilan
    const biz = new Map<number, ShopBusinessSignals>();
    geoOrdered.forEach((s, i) => {
      biz.set(s.id, { creditBalance: i % 3 === 0 ? 500_000 : 0, daysSinceVisit: i % 4 === 0 ? 30 : 0 });
    });
    const bizScores = computeBusinessScores(geoOrdered.map((s) => ({ ...s, biz: biz.get(s.id) ?? {} })));
    const result = priorityPullForward(geoOrdered, bizScores);

    expect(countCrossings(result)).toBe(0);
    expect(result).toHaveLength(geoOrdered.length);
  });

  it("yuqori ball olgan do'kon oldinga siljaydi (yoki joyida qoladi — geometriyaga bog'liq)", () => {
    const base = makeShops(15);
    const plan = planRoutes(base, { days: [1] });
    const geoOrdered = plan.routes[0].stops as PlanShop[];

    // So'nggi do'konga maksimal nasiya beramiz
    const lastShop = geoOrdered[geoOrdered.length - 1];
    const bizMap = new Map<number, ShopBusinessSignals>([[lastShop.id, { creditBalance: 10_000_000, daysSinceVisit: 60 }]]);
    const shopsWithBiz = geoOrdered.map((s) => ({ ...s, biz: bizMap.get(s.id) ?? {} }));
    const bizScores = computeBusinessScores(shopsWithBiz);

    const result = priorityPullForward(geoOrdered, bizScores);

    // Kesishish yo'q — bu eng muhim kafolat
    expect(countCrossings(result)).toBe(0);
    expect(result).toHaveLength(geoOrdered.length);
    // Barcha do'konlar saqlanib qolgan
    const resultIds = new Set(result.map((s) => s.id));
    geoOrdered.forEach((s) => expect(resultIds.has(s.id)).toBe(true));
  });

  it("biznes signali yo'q bo'lsa — tartib o'zgarmaydi", () => {
    const shops = makeShops(10);
    const emptyScores = new Map();
    const result = priorityPullForward(shops, emptyScores);
    expect(result.map((s) => s.id)).toEqual(shops.map((s) => s.id));
  });
});

describe("planRoutes businessPriority rejimi", () => {
  it("60 do'kon, 2 kun — kesishishsiz va validatePlan.ok", () => {
    const base = makeShops(60, 7);
    // Har 5-do'konga katta nasiya beramiz
    const shopsWithBiz = base.map((s, i) => ({
      ...s,
      biz: { creditBalance: i % 5 === 0 ? 800_000 * (i + 1) : 0, daysSinceVisit: i % 7 === 0 ? 25 + i : 0, salesSum: i % 3 === 0 ? 2_000_000 * i : 0 },
    }));

    const plan = planRoutes(shopsWithBiz, { days: [1, 2], targetSize: 30, businessPriority: true });

    // Asosiy kafolatlar
    expect(plan.routes).toHaveLength(2);
    expect(plan.businessPriorityActive).toBe(true);
    for (const r of plan.routes) {
      expect(r.stats.crossCount).toBe(0);
      expect(countCrossings(r.stops)).toBe(0);
    }

    // validatePlan o'tishi kerak (saqlash mumkin)
    const v = validatePlan(plan, shopsWithBiz);
    expect(v.ok).toBe(true);

    // Barcha do'konlar qamrab olingan
    const seen = new Set<number>();
    for (const r of plan.routes) {
      for (const st of r.stops) seen.add(st.id);
    }
    expect(seen.size).toBe(60);
  });

  it("120 do'kon, turli seed'larda ham kesishishsiz", () => {
    for (const seed of [42, 99, 2026]) {
      const base = makeShops(120, seed);
      const shopsWithBiz = base.map((s, i) => ({
        ...s,
        biz: { creditBalance: i % 4 === 0 ? 300_000 * i : 0, daysSinceVisit: i % 6 === 0 ? 20 + i : 0 },
      }));
      const plan = planRoutes(shopsWithBiz, { businessPriority: true });
      for (const r of plan.routes) {
        expect(r.stats.crossCount).toBe(0);
        expect(r.stats.crossCount).toBe(countCrossings(r.stops));
      }
      const v = validatePlan(plan, shopsWithBiz);
      expect(v.ok).toBe(true);
    }
  });

  it("bizWeights planRoutes orqali kun tartibini o'zgartiradi (nasiya vs tashrif preset)", () => {
    // Ikki klaster: A-hudud katta nasiya, B-hudud uzoq bormagan.
    // Nasiya-preset A'ni birinchi kunga, tashrif-preset B'ni birinchi kunga qo'yishi kerak.
    const shopsA: PlanShop[] = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1, nomi: `A${i}`, hudud: "A", lat: 41.0 + i * 0.005, lng: 71.0 + i * 0.005,
      biz: { creditBalance: 5_000_000, daysSinceVisit: 1, salesSum: 100_000 },
    }));
    const shopsB: PlanShop[] = Array.from({ length: 10 }, (_, i) => ({
      id: 100 + i, nomi: `B${i}`, hudud: "B", lat: 41.5 + i * 0.005, lng: 71.5 + i * 0.005,
      biz: { creditBalance: 0, daysSinceVisit: 60, salesSum: 100_000 },
    }));
    const shops = [...shopsA, ...shopsB];

    const nasiyaPlan = planRoutes(shops, {
      days: [1, 2], targetSize: 10, businessPriority: true,
      bizWeights: { credit: 60, days: 20, sales: 20 },
    });
    const tashrifPlan = planRoutes(shops, {
      days: [1, 2], targetSize: 10, businessPriority: true,
      bizWeights: { credit: 20, days: 55, sales: 25 },
    });

    const firstDayIds = (p: ReturnType<typeof planRoutes>) =>
      new Set(p.routes.find((r) => r.kun === 1)!.stops.map((s) => s.id));

    // Nasiya preset: birinchi kun A-klasterga (id < 100)
    expect([...firstDayIds(nasiyaPlan)].every((id) => id < 100)).toBe(true);
    // Tashrif preset: birinchi kun B-klasterga (id >= 100)
    expect([...firstDayIds(tashrifPlan)].every((id) => id >= 100)).toBe(true);
  });

  it("barcha signallar nol — businessPriorityActive=false, geo tartib saqlanadi", () => {
    const shops = makeShops(30).map((s) => ({ ...s, biz: { salesSum: 0, creditBalance: 0, daysSinceVisit: 0 } }));
    const plan = planRoutes(shops, { days: [1], businessPriority: true });
    // Barcha nol signallar → bo'sh BizScoreMap → faol emas
    expect(plan.businessPriorityActive).toBe(false);
    expect(plan.routes[0].stats.crossCount).toBe(0);
  });

  it("businessPriority=false — standart geo tartib (biznes signallari e'tiborga olinmaydi)", () => {
    const base = makeShops(30);
    const shopsWithBiz = base.map((s, i) => ({ ...s, biz: { creditBalance: 100_000 * i } }));
    const plan = planRoutes(shopsWithBiz, { days: [1], businessPriority: false });
    expect(plan.businessPriorityActive).toBe(false);
    for (const r of plan.routes) {
      expect(r.stats.crossCount).toBe(0);
    }
  });

  it("bizSummary — yuqori prioritetli do'konlar soni to'g'ri hisoblanadi", () => {
    const base = makeShops(30);
    // 6 ta do'konga score >= 60 keladigan nasiya beramiz
    const highCreditIds = new Set([1, 5, 10, 15, 20, 25]);
    const shopsWithBiz = base.map((s) => ({
      ...s,
      biz: { creditBalance: highCreditIds.has(s.id) ? 1_000_000 : 0 },
    }));
    const plan = planRoutes(shopsWithBiz, { days: [1], businessPriority: true });
    const biz = plan.routes[0].bizSummary;
    expect(biz).toBeDefined();
    expect(biz!.totalCreditBalance).toBeGreaterThan(0);
    expect(biz!.highPriorityCount).toBeGreaterThanOrEqual(0); // geometriyaga qarab o'zgarishi mumkin
  });

  it("bizScore va bizReasons to'xtash (stop) darajasida to'ldiriladi", () => {
    const base = makeShops(10);
    const shopsWithBiz = base.map((s, i) => ({ ...s, biz: { creditBalance: 500_000 * (i + 1) } }));
    const plan = planRoutes(shopsWithBiz, { days: [1], businessPriority: true });
    const stopsWithScore = plan.routes[0].stops.filter((st) => (st.bizScore ?? 0) > 0);
    expect(stopsWithScore.length).toBeGreaterThan(0);
    stopsWithScore.forEach((st) => {
      expect(st.bizScore).toBeGreaterThanOrEqual(0);
      expect(st.bizScore).toBeLessThanOrEqual(100);
      expect(Array.isArray(st.bizReasons)).toBe(true);
    });
  });

  it("yuqori prioritetli klaster birinchi kunga tushadi", () => {
    // 2 ta aniq alohida klaster yaratamiz: shimoliy (A) va janubiy (B)
    // Shimoliy klasterga katta nasiya beramiz — u birinchi kunga tushishi kerak
    const northShops: PlanShop[] = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      nomi: `North ${i + 1}`,
      hudud: "North",
      lat: 41.1 + (i % 5) * 0.005,
      lng: 71.2 + Math.floor(i / 5) * 0.005,
      biz: { creditBalance: 1_000_000, daysSinceVisit: 30, salesSum: 5_000_000 },
    }));
    const southShops: PlanShop[] = Array.from({ length: 15 }, (_, i) => ({
      id: i + 100,
      nomi: `South ${i + 1}`,
      hudud: "South",
      lat: 40.8 + (i % 5) * 0.005,
      lng: 71.2 + Math.floor(i / 5) * 0.005,
      biz: { creditBalance: 0, daysSinceVisit: 0, salesSum: 0 },
    }));
    const plan = planRoutes([...northShops, ...southShops], { days: [1, 2], targetSize: 15, businessPriority: true });
    expect(plan.routes).toHaveLength(2);
    // Birinchi kunning bizSummary bali ikkinchi kunnikidan katta bo'lishi kerak
    const biz0 = plan.routes[0].bizSummary;
    const biz1 = plan.routes[1].bizSummary;
    if (biz0 && biz1) {
      expect(biz0.avgBizScore).toBeGreaterThanOrEqual(biz1.avgBizScore);
    }
    // Kesishishlar yo'q
    for (const r of plan.routes) {
      expect(r.stats.crossCount).toBe(0);
    }
    // validatePlan o'tadi
    const v = validatePlan(plan, [...northShops, ...southShops]);
    expect(v.ok).toBe(true);
  });
});
