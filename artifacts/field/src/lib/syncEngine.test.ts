import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";

// T013 — syncEngine xato siyosati testlari:
//   muvaffaqiyat -> navbatdan o'chadi
//   400/404/422  -> failed (KO'RINADIGAN holat, jim o'chirilmaydi)
//   401/403      -> pending qoladi (60s dan keyin qayta)
//   tarmoq xatosi -> pending + backoff, retry hech qachon tugamaydi

const submitSale = vi.fn();
const submitNoSale = vi.fn();
const submitPayment = vi.fn();
const submitNewShop = vi.fn();

class FieldApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

vi.mock("@/lib/fieldApi", () => ({
  FieldApiError,
  submitSale: (...a: unknown[]) => submitSale(...a),
  submitNoSale: (...a: unknown[]) => submitNoSale(...a),
  submitPayment: (...a: unknown[]) => submitPayment(...a),
  submitNewShop: (...a: unknown[]) => submitNewShop(...a),
}));

async function freshModules() {
  vi.resetModules();
  const eq = await import("@/lib/eventQueue");
  const se = await import("@/lib/syncEngine");
  return { eq, se };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("syncEngine.triggerSync", () => {
  it("muvaffaqiyatli yuborilgan hodisa navbatdan o'chadi", async () => {
    const { eq, se } = await freshModules();
    submitSale.mockResolvedValue({ ok: true });
    await eq.enqueueEvent("SALE", { clientOpId: "ok-1", dokonId: 1, tolovTuri: "naqd", items: [] } as never);

    await se.triggerSync({ manual: true });

    expect(submitSale).toHaveBeenCalledOnce();
    expect(await eq.getAllEvents()).toHaveLength(0);
    expect(se.getSyncStatusSnapshot().pendingCount).toBe(0);
    expect(se.getSyncStatusSnapshot().lastSyncAt).not.toBeNull();
  });

  it("422 -> failed holati, hodisa SAQLANADI va xato ma'lumoti yoziladi", async () => {
    const { eq, se } = await freshModules();
    submitSale.mockRejectedValue(new FieldApiError(422, "Validatsiya xatosi"));
    await eq.enqueueEvent("SALE", { clientOpId: "bad-1", dokonId: 1, tolovTuri: "naqd", items: [] } as never);

    await se.triggerSync({ manual: true });

    const [ev] = await eq.getAllEvents();
    expect(ev.syncStatus).toBe("failed");
    expect(ev.lastErrorStatus).toBe(422);
    expect(ev.lastErrorMessage).toContain("Validatsiya");
    expect(se.getSyncStatusSnapshot().failedCount).toBe(1);
  });

  it("422 dan keyingi sog'lom hodisa baribir yuboriladi (bitta zahar hammasini to'xtatmaydi)", async () => {
    const { eq, se } = await freshModules();
    submitSale.mockRejectedValue(new FieldApiError(400, "Xato so'rov"));
    submitPayment.mockResolvedValue({ ok: true });
    await eq.enqueueEvent("SALE", { clientOpId: "bad-2", dokonId: 1, tolovTuri: "naqd", items: [] } as never);
    await eq.enqueueEvent("PAYMENT", { clientOpId: "ok-2", dokonId: 1, summa: 100, nasiyagaHisoblash: false } as never);

    await se.triggerSync({ manual: true });

    expect(submitPayment).toHaveBeenCalledOnce();
    const all = await eq.getAllEvents();
    expect(all).toHaveLength(1);
    expect(all[0].eventId).toBe("bad-2");
    expect(all[0].syncStatus).toBe("failed");
  });

  it("tarmoq xatosi -> pending + backoff, keyingi hodisalar kutadi", async () => {
    const { eq, se } = await freshModules();
    submitSale.mockRejectedValue(new TypeError("Failed to fetch"));
    submitPayment.mockResolvedValue({ ok: true });
    await eq.enqueueEvent("SALE", { clientOpId: "net-1", dokonId: 1, tolovTuri: "naqd", items: [] } as never);
    await eq.enqueueEvent("PAYMENT", { clientOpId: "net-2", dokonId: 1, summa: 100, nasiyagaHisoblash: false } as never);

    await se.triggerSync({ manual: true });

    // Tarmoq xatosi — hech narsa failed bo'lmaydi, to'lov ham yuborilmaydi
    expect(submitPayment).not.toHaveBeenCalled();
    const all = await eq.getAllEvents();
    expect(all).toHaveLength(2);
    const netEv = all.find((e) => e.eventId === "net-1")!;
    expect(netEv.syncStatus).toBe("pending");
    expect(netEv.retryCount).toBe(1);
    expect(netEv.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(se.getSyncStatusSnapshot().lastError).toBe("network");
  });

  it("401 -> pending qoladi (failed EMAS), lastError=auth", async () => {
    const { eq, se } = await freshModules();
    submitSale.mockRejectedValue(new FieldApiError(401, "unauthorized"));
    await eq.enqueueEvent("SALE", { clientOpId: "auth-1", dokonId: 1, tolovTuri: "naqd", items: [] } as never);

    await se.triggerSync({ manual: true });

    const [ev] = await eq.getAllEvents();
    expect(ev.syncStatus).toBe("pending");
    expect(ev.retryCount).toBe(0); // auth xatosi retry hisoblanmaydi
    expect(ev.nextAttemptAt).toBeGreaterThan(Date.now() + 30_000);
    expect(se.getSyncStatusSnapshot().lastError).toBe("auth");
  });

  it("retryFailedAndSync failed hodisani qayta yuboradi", async () => {
    const { eq, se } = await freshModules();
    submitSale.mockRejectedValueOnce(new FieldApiError(422, "xato")).mockResolvedValueOnce({ ok: true });
    await eq.enqueueEvent("SALE", { clientOpId: "rf-1", dokonId: 1, tolovTuri: "naqd", items: [] } as never);

    await se.triggerSync({ manual: true });
    expect((await eq.getAllEvents())[0].syncStatus).toBe("failed");

    await se.retryFailedAndSync();
    expect(await eq.getAllEvents()).toHaveLength(0);
    expect(submitSale).toHaveBeenCalledTimes(2);
  });

  it("IDB butunlay ishlamasa legacy navbat localStorage'dan TO'G'RIDAN-TO'G'RI yuboriladi", async () => {
    const { se } = await freshModules();
    // IndexedDB'ni sindiramiz (ba'zi private-mode WebView'lar kabi)
    // @ts-expect-error — ataylab buzamiz
    globalThis.indexedDB = undefined;
    submitPayment.mockResolvedValue({ ok: true });
    localStorage.setItem(
      "field_sync_queue",
      JSON.stringify([{ type: "payment", id: "str-1", data: { clientOpId: "str-1", dokonId: 2, summa: 900, nasiyagaHisoblash: false } }]),
    );

    await se.triggerSync({ manual: true });

    expect(submitPayment).toHaveBeenCalledOnce();
    expect(localStorage.getItem("field_sync_queue")).toBeNull();
  });

  it("legacy localStorage navbati sync paytida avtomatik migratsiya qilinadi", async () => {
    const { eq, se } = await freshModules();
    submitNoSale.mockResolvedValue({ ok: true });
    localStorage.setItem(
      "field_sync_queue",
      JSON.stringify([{ type: "nosale", id: "leg-1", data: { clientOpId: "leg-1", dokonId: 7, sabab: "yopiq" } }]),
    );

    await se.triggerSync({ manual: true });

    expect(submitNoSale).toHaveBeenCalledOnce();
    expect(await eq.getAllEvents()).toHaveLength(0);
    expect(localStorage.getItem("field_sync_queue")).toBeNull();
  });

  it("403 -> pending qoladi (failed EMAS), 401 bilan bir xil siyosat", async () => {
    const { eq, se } = await freshModules();
    submitSale.mockRejectedValue(new FieldApiError(403, "forbidden"));
    await eq.enqueueEvent("SALE", { clientOpId: "auth-403", dokonId: 1, tolovTuri: "naqd", items: [] } as never);

    await se.triggerSync({ manual: true });

    const [ev] = await eq.getAllEvents();
    expect(ev.syncStatus).toBe("pending");
    expect(ev.lastErrorStatus).toBe(403);
    expect(ev.retryCount).toBe(0);
    expect(ev.nextAttemptAt).toBeGreaterThan(Date.now() + 30_000);
    expect(se.getSyncStatusSnapshot().lastError).toBe("auth");
    expect(se.getSyncStatusSnapshot().failedCount).toBe(0);
  });

  it("429 (rate-limit) -> pending + backoff (failed EMAS, cheksiz qayta urinish)", async () => {
    const { eq, se } = await freshModules();
    submitSale.mockRejectedValue(new FieldApiError(429, "Too Many Requests"));
    await eq.enqueueEvent("SALE", { clientOpId: "rl-1", dokonId: 1, tolovTuri: "naqd", items: [] } as never);

    await se.triggerSync({ manual: true });

    const [ev] = await eq.getAllEvents();
    expect(ev.syncStatus).toBe("pending");
    expect(ev.lastErrorStatus).toBe(429);
    expect(ev.retryCount).toBe(1);
    expect(ev.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(se.getSyncStatusSnapshot().lastError).toBe("network");
    expect(se.getSyncStatusSnapshot().failedCount).toBe(0);
  });

  it("boot'da tiqilib qolgan 'syncing' hodisa pending'ga qaytadi (majburiy yopilish)", async () => {
    // 1-sessiya: hodisa "syncing" holatida qoladi (WebView o'ldirilgan)
    const first = await freshModules();
    await first.eq.enqueueEvent("SALE", { clientOpId: "stuck-1", dokonId: 1, tolovTuri: "naqd", items: [] } as never);
    await first.eq.updateEvent("stuck-1", { syncStatus: "syncing", nextAttemptAt: 123 });
    expect((await first.eq.getAllEvents())[0].syncStatus).toBe("syncing");

    // 2-sessiya (qayta boot): startSyncEngine boot bloki tozalashi kerak.
    // Tarmoq sync'i aralashmasligi uchun offline qilamiz.
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { eq, se } = await freshModules();
    se.startSyncEngine();
    await vi.waitFor(async () => {
      const [ev] = await eq.getAllEvents();
      expect(ev.syncStatus).toBe("pending");
      expect(ev.nextAttemptAt).toBe(0);
    });
    expect(submitSale).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("flush paytida qo'shilgan element yo'qolmaydi — IDB'da qoladi, keyingi siklda yuboriladi", async () => {
    // Asosiy invariant: enqueueEvent() IDB'ga yozadi → hech narsa yo'qolmaydi.
    // Flush davomida qo'shilgan element joriy siklda yuborilmaydi lekin
    // IDB'da "pending" holatda saqlanadi — keyingi triggerSync uni oladi.
    const { eq, se } = await freshModules();

    // Birinchi submit paytida yangi to'lov navbatga qo'shiladi
    // (sync.ts wrapper haqiqiy ilovada xuddi shunday qiladi).
    submitSale.mockImplementationOnce(async () => {
      await eq.enqueueEvent("PAYMENT", {
        clientOpId: "during-flush-1",
        dokonId: 1,
        summa: 750,
        nasiyagaHisoblash: false,
      } as never);
      return { ok: true };
    });
    submitPayment.mockResolvedValue({ ok: true });

    await eq.enqueueEvent("SALE", {
      clientOpId: "before-flush-1",
      dokonId: 1,
      tolovTuri: "naqd",
      items: [],
    } as never);

    // 1-sikl: savdo yuboriladi; flush paytida qo'shilgan to'lov navbatda qoladi
    await se.triggerSync({ manual: true });

    expect(submitSale).toHaveBeenCalledOnce();
    const remaining = await eq.getAllEvents();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].eventId).toBe("during-flush-1");
    expect(remaining[0].syncStatus).toBe("pending");

    // 2-sikl: qo'shilgan element yuboriladi va o'chadi — hech narsa yo'qolmagan
    await se.triggerSync({ manual: true });
    expect(submitPayment).toHaveBeenCalledOnce();
    expect(await eq.getAllEvents()).toHaveLength(0);
  });
});
