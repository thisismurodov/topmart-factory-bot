import { beforeAll, afterAll, describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import apiRouter from "../src/routes/index";
import vehicleDistributionRouter from "../src/routes/vehicle-distribution";
import vehicleWeeklySummaryRouter from "../src/routes/vehicle-distribution/weekly-summary-router";

// ─────────────────────────────────────────────────────────────────────────────
// Router-STACK regression test (task: bugungi 401 sinfini avtomatik to'sish).
//
// Bugning ildizi: vehicle routerlar routes/index.ts dagi PATH'SIZ auth
// devorlaridan (requireAuthOrInternalKey, requireAuth) KEYIN mount qilinsa,
// faqat x-vehicle-distribution-bot-key yuborgan ombor bot so'rovi vehicle
// devoriga yetib bormasdan 401 oladi. Bu test ATAYIN haqiqiy routes/index.ts
// ni (izolyatsiyalangan router emas!) xuddi prod kabi /api ostida ko'tarib,
// autentifikatsiya OQIMINING o'zini tekshiradi:
//
//   - to'g'ri bot kalit  → vehicle devoridan O'TADI (401 EMAS; gate 503 marker)
//   - kalitsiz / noto'g'ri kalit / x-internal-key → vehicle devorida 401
//   - /pilot/stock kabi dashboard yo'llari endi replenishment/return
//     devorlariga ILINMAYDI (#230 toraytirish) — bot kalit u yerda 403 emas,
//     keyingi pathsiz devorda 401 oladi
//   - pathsiz devorlar pastdagi yo'llarni hali ham qo'riqlaydi
//
// DB KERAK EMAS: bot-kalit yo'li env solishtirish, gate esa handlerdan OLDIN
// javob beradi (503) — hech qanday so'rov bazaga bormaydi.
// ─────────────────────────────────────────────────────────────────────────────

const BOT_KEY = "router-stack-test-vehicle-key-123456";
const SAVED = {
  botKey: process.env.VEHICLE_DISTRIBUTION_BOT_KEY,
  enabled: process.env.VEHICLE_DISTRIBUTION_ENABLED,
  approved: process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED,
  labels: process.env.PRODUCTION_LABELS_SCHEMA_APPROVED,
};

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  // Gate marker rejimi: ENABLED=1, SCHEMA_APPROVED yo'q → autentifikatsiyadan
  // o'tgan so'rov AYNAN vehicle gate'ining 503 javobini oladi. 401 bo'lsa —
  // so'rov vehicle devoriga yetmagan (bugungi xato sinfi qaytgan).
  process.env.VEHICLE_DISTRIBUTION_BOT_KEY = BOT_KEY;
  process.env.VEHICLE_DISTRIBUTION_ENABLED = "1";
  delete process.env.VEHICLE_DISTRIBUTION_SCHEMA_APPROVED;
  delete process.env.PRODUCTION_LABELS_SCHEMA_APPROVED;

  const app = express();
  app.use(express.json());
  app.use("/api", apiRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [k, v] of [
    ["VEHICLE_DISTRIBUTION_BOT_KEY", SAVED.botKey],
    ["VEHICLE_DISTRIBUTION_ENABLED", SAVED.enabled],
    ["VEHICLE_DISTRIBUTION_SCHEMA_APPROVED", SAVED.approved],
    ["PRODUCTION_LABELS_SCHEMA_APPROVED", SAVED.labels],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(baseUrl + path, { headers });
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

const botHeaders = { "x-vehicle-distribution-bot-key": BOT_KEY };

describe("bot kaliti vehicle devoriga YETIB BORADI (bugungi 401 sinfi)", () => {
  it("GET /handoffs + to'g'ri kalit → 503 gate-marker (401 EMAS)", async () => {
    const r = await get("/api/vehicle-distribution/handoffs", botHeaders);
    // 401 bo'lsa: pathsiz devor so'rovni vehicle devoridan OLDIN yutgan —
    // mount tartibi buzilgan (routes/index.ts dagi izohga qarang).
    expect(r.status).toBe(503);
    expect(r.body?.error).toBe("Vehicle distribution schema not approved");
  });

  it("POST lifecycle yo'llari ham devordan o'tadi (503, 401 emas)", async () => {
    const res = await fetch(
      baseUrl + "/api/vehicle-distribution/handoffs/1/labels/prepare",
      { method: "POST", headers: { ...botHeaders, "content-type": "application/json" }, body: "{}" },
    );
    expect(res.status).toBe(503);
  });

  it("replenishment yo'llari: bot kalit → 503 gate-marker", async () => {
    const r = await get(
      "/api/vehicle-distribution/pilot/replenishment-requests",
      botHeaders,
    );
    expect(r.status).toBe(503);
  });

  it("returns yo'llari: bot kalit autentifikatsiyadan o'tadi, lekin admin emas → 403", async () => {
    const r = await get("/api/vehicle-distribution/pilot/returnable-labels", botHeaders);
    expect(r.status).toBe(403);
    expect(r.body?.error).toBe("Admin role required");
  });
});

describe("vehicle devori fail-closed qoladi", () => {
  it("kalitsiz → 401", async () => {
    const r = await get("/api/vehicle-distribution/handoffs");
    expect(r.status).toBe(401);
  });

  it("noto'g'ri kalit → 401", async () => {
    const r = await get("/api/vehicle-distribution/handoffs", {
      "x-vehicle-distribution-bot-key": "wrong-key-000000000000",
    });
    expect(r.status).toBe(401);
  });

  it("x-internal-key vehicle yo'llarini HECH QACHON ochmaydi → 401", async () => {
    const r = await get("/api/vehicle-distribution/handoffs", {
      "x-internal-key": "whatever-internal-key",
    });
    expect(r.status).toBe(401);
  });
});

describe("#230: keng /pilot devorlari toraytirilgan", () => {
  it("/pilot/stock endi return/replenishment devoriga ilinmaydi (403 EMAS)", async () => {
    // Toraytirishdan OLDIN: return devori bot aktyorni ushlab 403 berardi.
    // KEYIN: so'rov vehicle routerlardan o'tib, pathsiz devorda 401 oladi
    // (vehicle bot kaliti dashboard o'qishlariga huquq bermaydi — to'g'ri).
    const r = await get("/api/vehicle-distribution/pilot/stock", botHeaders);
    expect(r.status).toBe(401);
  });

  it("/pilot/movements ham xuddi shunday", async () => {
    const r = await get("/api/vehicle-distribution/pilot/movements", botHeaders);
    expect(r.status).toBe(401);
  });

  it("/pilot/reconciliations ham return devori orqasida emas", async () => {
    const r = await get(
      "/api/vehicle-distribution/pilot/reconciliations",
      botHeaders,
    );
    expect(r.status).toBe(401);
  });

  it("/pilot/weekly-summary o'z admin devoriga tushadi (401 EMAS)", async () => {
    // Weekly routerning O'Z devori bot kalitni autentifikatsiya qiladi, lekin
    // admin talab qiladi → 403 "Admin role required". 401 bo'lsa — so'rov
    // vehicle-aware devorlarga yetmasdan pathsiz devorda yutilgan (regressiya).
    const r = await get(
      "/api/vehicle-distribution/pilot/weekly-summary",
      botHeaders,
    );
    expect(r.status).toBe(403);
    expect(String(r.body?.error)).toMatch(/^Admin (session|role) required$/);
  });

  it("o'z yo'llari hali ham devor ortida: /pilot/stock-targets kalitsiz → 401", async () => {
    const r = await get("/api/vehicle-distribution/pilot/stock-targets");
    expect(r.status).toBe(401);
  });

  it("/pilot/returns kalitsiz → 401 (fail-closed)", async () => {
    const r = await get("/api/vehicle-distribution/pilot/returns");
    expect(r.status).toBe(401);
  });
});

// Router stekidan ro'yxatdan o'tgan route path'larini yig'ish (express 5 /
// router 2.x: .get/.post qatlamlarida layer.route.path bor).
function registeredRoutePaths(r: unknown): string[] {
  const stack =
    (r as { stack?: Array<{ route?: { path?: string | string[] } }> }).stack ?? [];
  const out: string[] = [];
  for (const layer of stack) {
    const p = layer.route?.path;
    if (typeof p === "string") out.push(p);
    else if (Array.isArray(p)) out.push(...p);
  }
  return out;
}

describe("anti-rot: sibling yo'llar HAQIQATAN ro'yxatdan o'tgan", () => {
  // Yuqoridagi 401-assertlar route o'chirilsa/qayta nomlansa ham 401 bo'lib
  // qolaverardi (vakuum test). Bu blok yo'llarning mavjudligini alohida pinlaydi.
  it("pilot dashboard routeri sibling yo'llarni ro'yxatga olgan", () => {
    const paths = registeredRoutePaths(vehicleDistributionRouter);
    expect(paths).toContain("/vehicle-distribution/pilot");
    expect(paths).toContain("/vehicle-distribution/pilot/stock");
    expect(paths).toContain("/vehicle-distribution/pilot/movements");
    expect(paths).toContain("/vehicle-distribution/pilot/reconciliations");
  });

  it("weekly routeri /pilot/weekly-summary ni ro'yxatga olgan", () => {
    expect(registeredRoutePaths(vehicleWeeklySummaryRouter)).toContain(
      "/vehicle-distribution/pilot/weekly-summary",
    );
  });
});

describe("pathsiz devorlar pastdagi yo'llarni hali ham qo'riqlaydi", () => {
  it("vehicle bot kaliti boshqa yo'llarga huquq BERMAYDI", async () => {
    const r = await get("/api/dashboard/summary", botHeaders);
    expect(r.status).toBe(401);
  });

  it("kalitsiz ixtiyoriy pastki yo'l → 401 (ochilib qolmagan)", async () => {
    const r = await get("/api/definitely-not-a-route");
    expect(r.status).toBe(401);
  });
});
