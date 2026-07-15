import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";

// T013 — eventQueue unit testlari: envelope, migratsiya, FIFO, retry siyosati.

async function freshModules() {
  vi.resetModules();
  const idb = await import("@/lib/idb");
  const eq = await import("@/lib/eventQueue");
  return { idb, eq };
}

beforeEach(() => {
  // Har test uchun toza IndexedDB va localStorage
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});

describe("eventQueue", () => {
  it("enqueue to'liq envelope bilan hodisa yozadi (eventId=clientOpId)", async () => {
    const { eq } = await freshModules();
    const clientOpId = crypto.randomUUID();
    await eq.enqueueEvent("SALE", {
      clientOpId,
      dokonId: 5,
      tolovTuri: "naqd",
      items: [{ mahsulotId: 1, miqdor: 2 }],
    } as never);

    const all = await eq.getAllEvents();
    expect(all).toHaveLength(1);
    const ev = all[0];
    expect(ev.eventId).toBe(clientOpId);
    expect(ev.operation).toBe("SALE");
    expect(ev.syncStatus).toBe("pending");
    expect(ev.retryCount).toBe(0);
    expect(ev.deviceId).toBeTruthy();
    expect(ev.schemaVersion).toBe(1);
    expect(new Date(ev.createdAt).getTime()).toBeGreaterThan(0);
  });

  it("bir xil clientOpId ikki marta yozilsa dublikat bo'lmaydi", async () => {
    const { eq } = await freshModules();
    const clientOpId = crypto.randomUUID();
    const payload = { clientOpId, dokonId: 1, summa: 100, nasiyagaHisoblash: true } as never;
    await eq.enqueueEvent("PAYMENT", payload);
    await eq.enqueueEvent("PAYMENT", payload);
    expect(await eq.getAllEvents()).toHaveLength(1);
  });

  it("eski localStorage navbati IDB'ga ko'chiriladi va kalit o'chadi", async () => {
    const { eq } = await freshModules();
    const legacy = [
      { type: "sale", id: "op-1", data: { clientOpId: "op-1", dokonId: 3, tolovTuri: "naqd", items: [] } },
      { type: "payment", id: "op-2", data: { clientOpId: "op-2", dokonId: 3, summa: 5000, nasiyagaHisoblash: false } },
      { type: "nosale", id: "op-3", data: { clientOpId: "op-3", dokonId: 4, sabab: "yopiq" } },
      { type: "shop", id: "op-4", data: { clientOpId: "op-4", nomi: "Test dokon", lat: null, lon: null } },
    ];
    localStorage.setItem("field_sync_queue", JSON.stringify(legacy));

    const migrated = await eq.migrateLegacyQueue();
    expect(migrated).toBe(4);
    expect(localStorage.getItem("field_sync_queue")).toBeNull();

    const all = await eq.getAllEvents();
    expect(all).toHaveLength(4);
    expect(all.map((e) => e.operation).sort()).toEqual(["NEW_SHOP", "NO_SALE", "PAYMENT", "SALE"]);

    // Idempotent: ikkinchi chaqiruv hech narsa buzmaydi
    localStorage.setItem("field_sync_queue", JSON.stringify(legacy));
    await eq.migrateLegacyQueue();
    expect(await eq.getAllEvents()).toHaveLength(4);
  });

  it("getDueEvents: birinchi backoff'dagi hodisada TO'XTAYDI (FIFO saqlanadi)", async () => {
    const { eq } = await freshModules();
    await eq.enqueueEvent("PAYMENT", { clientOpId: "p-1", dokonId: 1, summa: 1, nasiyagaHisoblash: false } as never);
    await eq.enqueueEvent("PAYMENT", { clientOpId: "p-2", dokonId: 1, summa: 2, nasiyagaHisoblash: false } as never);

    // Birinchisini kelajakka backoff qilamiz
    await eq.updateEvent("p-1", { nextAttemptAt: Date.now() + 60_000 });

    const due = await eq.getDueEvents(false);
    expect(due).toHaveLength(0); // p-2 ham yuborilmaydi — tartib buzilmasin

    const manual = await eq.getDueEvents(true);
    expect(manual.map((e) => e.eventId)).toEqual(["p-1", "p-2"]); // manual hammasini oladi
  });

  it("failed hodisalar getDueEvents'ga kirmaydi, retryFailedEvents ularni qaytaradi", async () => {
    const { eq } = await freshModules();
    await eq.enqueueEvent("SALE", { clientOpId: "s-1", dokonId: 1, tolovTuri: "naqd", items: [] } as never);
    await eq.updateEvent("s-1", { syncStatus: "failed", lastErrorStatus: 422, retryCount: 3 });

    expect(await eq.getDueEvents(true)).toHaveLength(0);
    const counts = await eq.getQueueCounts();
    expect(counts.failed).toBe(1);
    expect(counts.pending).toBe(0);

    const n = await eq.retryFailedEvents();
    expect(n).toBe(1);
    const [ev] = await eq.getAllEvents();
    expect(ev.syncStatus).toBe("pending");
    expect(ev.retryCount).toBe(0);
    expect(ev.nextAttemptAt).toBe(0);
  });

  it("discardEvent hodisani butunlay o'chiradi", async () => {
    const { eq } = await freshModules();
    await eq.enqueueEvent("SALE", { clientOpId: "s-9", dokonId: 1, tolovTuri: "naqd", items: [] } as never);
    await eq.discardEvent("s-9");
    expect(await eq.getAllEvents()).toHaveLength(0);
  });
});
