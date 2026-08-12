import { beforeEach, describe, expect, it } from "vitest";
import {
  RouteOrderSyncer,
  optimalOrderKey,
  loadSavedOrder,
  loadDirtyOp,
  cleanupStaleOrders,
  type RouteOrderApi,
} from "./routeOrderSync";

// ─────────────────────────────────────────────────────────────────────────────
// Optimal tartib sinxronlagichi — poyga (race) testlari.
//
// Deferred promise'lar bilan tarmoq javoblari ATAYIN kechiktiriladi:
//   1. Mount'dagi GET kechikkanida foydalanuvchi saqlagan/reset qilgan
//      tartibni USTIDAN YOZMASLIGI kerak
//   2. Eski PUT/DELETE javobi yangi operatsiyaning dirty belgisini
//      tozalamasligi kerak (retry yo'qolmaydi)
//   3. Offline (reject) — dirty qoladi, keyingi sync() push qiladi
// ─────────────────────────────────────────────────────────────────────────────

const KEY = optimalOrderKey(7, "2026-08-12");

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type FetchRes = { order: number[] | null };

function makeApi() {
  const fetchCalls: Array<ReturnType<typeof deferred<FetchRes>>> = [];
  const putCalls: Array<{ order: number[]; opSeq: number; d: ReturnType<typeof deferred<{ applied: boolean }>> }> = [];
  const delCalls: Array<{ opSeq: number; d: ReturnType<typeof deferred<{ applied: boolean }>> }> = [];
  const api: RouteOrderApi = {
    fetchOrder: () => {
      const d = deferred<FetchRes>();
      fetchCalls.push(d);
      return d.promise;
    },
    putOrder: (order, opSeq) => {
      const d = deferred<{ applied: boolean }>();
      putCalls.push({ order, opSeq, d });
      return d.promise;
    },
    deleteOrder: (opSeq) => {
      const d = deferred<{ applied: boolean }>();
      delCalls.push({ opSeq, d });
      return d.promise;
    },
  };
  return { api, fetchCalls, putCalls, delCalls };
}

beforeEach(() => {
  localStorage.clear();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("RouteOrderSyncer poyga himoyasi", () => {
  it("kechikkan mount-GET foydalanuvchining yangi saqlashini ustidan yozmaydi", async () => {
    const { api, fetchCalls } = makeApi();
    const s = new RouteOrderSyncer(KEY, api);

    const syncP = s.sync(); // GET boshlandi, hali javob yo'q
    s.save([5, 6, 7]); // foydalanuvchi orada Optimal tartibni yoqdi

    fetchCalls[0].resolve({ order: [1, 2, 3] }); // eskirgan server javobi
    const res = await syncP;

    expect(res.changed).toBe(false); // eskirgan GET tashlanadi
    expect(loadSavedOrder(KEY)).toEqual([5, 6, 7]); // lokal saqlash joyida
  });

  it("dirty holatda sync() GET qilmaydi; orada reset bo'lsa dirty'ni tozalamaydi", async () => {
    const { api, fetchCalls, putCalls } = makeApi();
    const s = new RouteOrderSyncer(KEY, api);
    s.save([1, 2]); // PUT #1 (javobsiz qoladi)

    const syncP = s.sync(); // dirty="set" — GET emas, PUT #2 push bo'ladi
    await tick();
    expect(fetchCalls.length).toBe(0); // dirty push holatida fetch chaqirilmaydi
    expect(putCalls.length).toBe(2);

    s.clear(); // orada reset — dirty "clear" bo'ldi, DELETE ketdi
    putCalls[1].d.resolve({ applied: true }); // sync'ning PUT javobi kech keldi
    await syncP;
    expect(loadSavedOrder(KEY)).toBeNull();
    expect(loadDirtyOp(KEY)?.op).toBe("clear"); // eskirgan sync uni tozalamagan
  });

  it("eski PUT javobi yangi reset'ning dirty belgisini tozalamaydi", async () => {
    const { api, putCalls, delCalls } = makeApi();
    const s = new RouteOrderSyncer(KEY, api);

    s.save([1, 2, 3]); // PUT #1 (javob hali yo'q)
    s.clear(); // reset — dirty="clear", DELETE #1 (javob hali yo'q)

    putCalls[0].d.resolve({ applied: true }); // eski PUT kech keldi
    await tick();
    expect(loadDirtyOp(KEY)?.op).toBe("clear"); // clear retry saqlanib qoladi

    delCalls[0].d.resolve({ applied: true }); // joriy DELETE javobi
    await tick();
    expect(loadDirtyOp(KEY)).toBeNull(); // endi tozalanadi
  });

  it("eski DELETE javobi yangi saqlashning dirty belgisini tozalamaydi", async () => {
    const { api, putCalls, delCalls } = makeApi();
    const s = new RouteOrderSyncer(KEY, api);

    s.save([1]);
    putCalls[0].d.resolve({ applied: true });
    await tick();

    s.clear(); // DELETE #1
    s.save([9, 8]); // yangi saqlash — dirty="set", PUT #2

    delCalls[0].d.resolve({ applied: true }); // eski DELETE kech keldi
    await tick();
    expect(loadDirtyOp(KEY)?.op).toBe("set"); // yangi PUT hali tasdiqlanmagan

    putCalls[1].d.resolve({ applied: true });
    await tick();
    expect(loadDirtyOp(KEY)).toBeNull();
  });

  it("offline saqlash: dirty qoladi, keyingi sync() serverga push qiladi", async () => {
    const { api, putCalls } = makeApi();
    const s = new RouteOrderSyncer(KEY, api);

    s.save([4, 5]);
    putCalls[0].d.reject(new Error("offline"));
    await tick();
    expect(loadDirtyOp(KEY)?.op).toBe("set");
    expect(loadSavedOrder(KEY)).toEqual([4, 5]);

    // "online" — sync dirty'ni push qiladi
    const syncP = s.sync();
    await tick();
    expect(putCalls[1].order).toEqual([4, 5]);
    putCalls[1].d.resolve({ applied: true });
    const res = await syncP;
    expect(res.changed).toBe(false);
    expect(loadDirtyOp(KEY)).toBeNull();
  });

  it("offline reset: dirty='clear' qoladi, keyingi sync() DELETE yuboradi", async () => {
    const { api, delCalls } = makeApi();
    const s = new RouteOrderSyncer(KEY, api);

    s.clear();
    delCalls[0].d.reject(new Error("offline"));
    await tick();
    expect(loadDirtyOp(KEY)?.op).toBe("clear");

    const syncP = s.sync();
    await tick();
    delCalls[1].d.resolve({ applied: true });
    await syncP;
    expect(loadDirtyOp(KEY)).toBeNull();
  });

  it("toza holatda sync() server nusxasini qabul qiladi (boshqa qurilma)", async () => {
    const { api, fetchCalls } = makeApi();
    const s = new RouteOrderSyncer(KEY, api);

    const syncP = s.sync();
    fetchCalls[0].resolve({ order: [3, 1, 2] });
    const res = await syncP;
    expect(res).toEqual({ changed: true, order: [3, 1, 2] });
    expect(loadSavedOrder(KEY)).toEqual([3, 1, 2]);

    // Server bo'sh — boshqa qurilmada reset qilingan: lokal ham tozalanadi
    const syncP2 = s.sync();
    fetchCalls[1].resolve({ order: null });
    const res2 = await syncP2;
    expect(res2).toEqual({ changed: true, order: null });
    expect(loadSavedOrder(KEY)).toBeNull();
  });

  it("GET xatosi (offline) — o'zgarish yo'q, lokal joyida", async () => {
    const { api, fetchCalls } = makeApi();
    localStorage.setItem(KEY, JSON.stringify([1, 2]));
    const s = new RouteOrderSyncer(KEY, api);
    const syncP = s.sync();
    fetchCalls[0].reject(new Error("offline"));
    const res = await syncP;
    expect(res.changed).toBe(false);
    expect(loadSavedOrder(KEY)).toEqual([1, 2]);
  });

  it("cleanupStaleOrders eski kun kalitlarini o'chiradi, joriy + dirty saqlaydi", () => {
    const old = optimalOrderKey(7, "2026-08-11");
    localStorage.setItem(old, "[1]");
    localStorage.setItem(`${old}:dirty`, "set:123");
    localStorage.setItem(KEY, "[2]");
    localStorage.setItem(`${KEY}:dirty`, "set:456");
    cleanupStaleOrders(KEY);
    expect(localStorage.getItem(old)).toBeNull();
    expect(localStorage.getItem(`${old}:dirty`)).toBeNull();
    expect(loadSavedOrder(KEY)).toEqual([2]);
    expect(loadDirtyOp(KEY)?.op).toBe("set");
  });

  it("rad etilgan PUT (applied=false) — server holati olinib qabul qilinadi", async () => {
    const { api, putCalls, fetchCalls } = makeApi();
    const seen: Array<number[] | null> = [];
    const s = new RouteOrderSyncer(KEY, api, (o) => seen.push(o));

    s.save([1, 2, 3]);
    putCalls[0].d.resolve({ applied: false }); // boshqa qurilmada yangiroq holat
    await tick();
    expect(loadDirtyOp(KEY)).toBeNull(); // eskirgan opni retry qilmaymiz
    expect(fetchCalls.length).toBe(1); // server holati so'raldi

    fetchCalls[0].resolve({ order: [7, 8] });
    await tick();
    expect(loadSavedOrder(KEY)).toEqual([7, 8]); // lokal server bilan bir xil
    expect(seen).toEqual([[7, 8]]); // UI xabardor qilindi
  });

  it("rad etilgan DELETE (applied=false) — server tartibi qayta tiklanadi", async () => {
    const { api, delCalls, fetchCalls } = makeApi();
    const seen: Array<number[] | null> = [];
    const s = new RouteOrderSyncer(KEY, api, (o) => seen.push(o));

    s.clear();
    delCalls[0].d.resolve({ applied: false }); // boshqa qurilma yangiroq saqlagan
    await tick();
    fetchCalls[0].resolve({ order: [4, 5, 6] });
    await tick();
    expect(loadSavedOrder(KEY)).toEqual([4, 5, 6]);
    expect(seen).toEqual([[4, 5, 6]]);
  });

  it("rad etilgan mutatsiya reconcile'i orada yangi harakat bo'lsa qo'llanmaydi", async () => {
    const { api, putCalls, fetchCalls } = makeApi();
    const seen: Array<number[] | null> = [];
    const s = new RouteOrderSyncer(KEY, api, (o) => seen.push(o));

    s.save([1]);
    putCalls[0].d.resolve({ applied: false });
    await tick(); // reconcile GET boshlandi
    s.save([2, 3]); // foydalanuvchi yana saqladi (yangi seq)
    fetchCalls[0].resolve({ order: [9] }); // eskirgan reconcile javobi
    await tick();
    expect(seen).toEqual([]); // eskirgan server holati UI'ga tegmadi
    expect(loadSavedOrder(KEY)).toEqual([2, 3]);
  });

  it("sync() retry rad etilsa — server nusxasi qabul qilinadi", async () => {
    const { api, putCalls, fetchCalls } = makeApi();
    const s = new RouteOrderSyncer(KEY, api);

    s.save([4, 5]);
    putCalls[0].d.reject(new Error("offline"));
    await tick();
    expect(loadDirtyOp(KEY)?.op).toBe("set");

    const syncP = s.sync(); // retry PUT #2
    await tick();
    putCalls[1].d.resolve({ applied: false }); // server: eskirgan
    await tick();
    fetchCalls[0].resolve({ order: [6, 7] }); // haqiqiy server holati
    const res = await syncP;
    expect(res).toEqual({ changed: true, order: [6, 7] });
    expect(loadSavedOrder(KEY)).toEqual([6, 7]);
    expect(loadDirtyOp(KEY)).toBeNull();
  });
});
