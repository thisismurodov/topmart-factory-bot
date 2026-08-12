// GPS outlier oldindan tekshiruvi (checkShopGps) — yangi do'kon saqlashdan
// oldin koordinata viloyat medianidan >60 km bo'lsa agentga ogohlantirish
// ko'rsatiladi (NewShopForm). Bu test: outlier javobi qaytadi, xato/timeout
// esa null (bloklamaydi — offline'da saqlash davom etadi).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkShopGps } from "./fieldApi";

const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("checkShopGps", () => {
  it("outlier javobini qaytaradi (agent ogohlantiriladi)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ outlier: true, distanceKm: 212, thresholdKm: 60, viloyat: "Namangan" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as typeof fetch;
    const res = await checkShopGps(41.31, 69.28);
    expect(res).not.toBeNull();
    expect(res!.outlier).toBe(true);
    expect(res!.distanceKm).toBe(212);
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("/shops/gps-check?lat=41.31&lon=69.28");
  });

  it("normal koordinata — outlier: false", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ outlier: false, distanceKm: null, thresholdKm: 60, viloyat: "Namangan" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as typeof fetch;
    const res = await checkShopGps(41.0, 71.6);
    expect(res!.outlier).toBe(false);
  });

  it("tarmoq xatosi — null (saqlashni bloklamaydi)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    expect(await checkShopGps(41.0, 71.6)).toBeNull();
  });

  it("server 500 — null (saqlashni bloklamaydi)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "ichki xato" }), { status: 500 }),
    ) as typeof fetch;
    expect(await checkShopGps(41.0, 71.6)).toBeNull();
  });
});
