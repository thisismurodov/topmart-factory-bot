// Production Flow Map — sof graf logikasi testlari (F3 §24 birlik qismi).
// Muhit: node (DOM'siz). Interaktiv/vizual holatlar Playwright e2e bilan tekshiriladi.
import { describe, expect, it } from "vitest";
import {
  COL_X, EDGE_STYLE, buildScaffold, computeVisible, edgeLabel,
  isEmptyGraph, selectionForNodeId, type FilterKey,
} from "./model";
import type {
  ContainerData, DeptData, FlowGraphResponse, ProductData, WipData,
} from "./types";

// ---------- mini fixture yordamchilari ----------

const mkContainer = (o: Partial<ContainerData> & { id: number; name: string }): ContainerData => ({
  purpose: null, loc: "container", cap: null, kg: 0, dona: 0, positionsCount: 0,
  byType: {}, derived: "unclassified", dominant: null, mismatch: false, items: [],
  ...o,
});

const mkDept = (id: number, name: string): DeptData => ({
  id, name, workers: [], roles: [], wipKg: 0, wipRows: 0,
  salary: { entries: 0, workers: 0, total: 0, lastDate: null },
  salaryByWorker: [], produce: [], batches: [], bomInputs: [],
});

const mkWip = (o: Partial<WipData> & { lineId: number; lineName: string; status: WipData["status"] }): WipData => ({
  balanceKg: 0, rows: 0, produceKg: 0, receiveKg: 0, first: null, last: null, ...o,
});

const mkProduct = (o: Partial<ProductData> & { key: string; name: string }): ProductData => ({
  sku: null, lineIds: [], producedKg: 0, batchKg: 0, batchDona: 0, placements: [], bom: [],
  ...o,
});

const GAPS = [
  { code: "NO_RECEIVE_DATA", title: "Container → Bo'lim oqimi: ma'lumot yo'q", detail: "RECEIVE 0 ta." },
  { code: "NEGATIVE_WIP", title: "Manfiy WIP balansi", detail: "Kirim yozilmagan." },
  { code: "ITEM_LINKS_EMPTY", title: "item_id bog'lari bo'sh", detail: "SKU biriktirilmagan." },
  { code: "PURPOSE_MISMATCH", title: "purpose ≠ kontent", detail: "6 ta konteyner." },
  { code: "UNATTRIBUTED_BATCHES", title: "Bo'limga biriktirilmagan partiyalar", detail: "71 ta partiya." },
];

// Real prod strukturasini aks ettiruvchi kichik graf:
// c-7 (raw, mixed), c-10 (raw, mismatch), c-20 (finished) + bo'sh c-30 + regional;
// d-6 faol, id=10 nofaol; w-6 MANFIY, w-8 ledger'siz; p-arqon SKU'siz, p-qopip SKU bilan.
const MINI: FlowGraphResponse = {
  generatedAt: "2026-08-17",
  readOnly: true,
  source: "test",
  nodes: {
    containersRaw: [
      mkContainer({
        id: 7, name: "C-01", purpose: "raw", cap: 20000, kg: 25000, dona: 50000, positionsCount: 2,
        byType: { raw: { kg: 25000, dona: 25000, rows: 1 }, finished: { kg: 0, dona: 25000, rows: 1 } },
        derived: "mixed", dominant: "raw",
        items: [{ wid: 7, product: "Sholcha", sku: null, qty: 25000, kg: 0, ptype: "raw" }],
      }),
      mkContainer({
        id: 10, name: "C-04", purpose: "finished", kg: 6363.3, positionsCount: 1,
        byType: { raw: { kg: 6363.3, dona: 0, rows: 1 } },
        derived: "raw", dominant: "raw", mismatch: true,
        items: [{ wid: 10, product: "Granula", sku: null, qty: 0, kg: 6363.3, ptype: "raw" }],
      }),
    ],
    containersFinished: [
      mkContainer({
        id: 20, name: "C-10", purpose: "finished", kg: 50, dona: 6000, positionsCount: 1,
        byType: { finished: { kg: 50, dona: 6000, rows: 1 } },
        derived: "finished", dominant: "finished",
        items: [{ wid: 20, product: "Qop Ip - 100 talik", sku: "TM-000080", qty: 6000, kg: 50, ptype: "finished" }],
      }),
    ],
    emptyContainers: [mkContainer({ id: 30, name: "C-EMPTY", derived: "empty" })],
    regionalGroup: {
      name: "Viloyat omborlari", count: 2, kg: -100.5, dona: -50,
      list: [mkContainer({ id: 40, name: "Andijon ombor", kg: -100.5, dona: -50 })],
    },
    departments: [mkDept(6, "Arqon Bo'lim 3")],
    inactiveDepartments: [{ id: 10, name: "Eski liniya" }],
    wip: [
      mkWip({ lineId: 6, lineName: "Arqon Bo'lim 3", status: "NEGATIVE", balanceKg: -8964.77, rows: 171, produceKg: 8964.77 }),
      mkWip({ lineId: 8, lineName: "Lenta 1", status: "NO_LEDGER" }),
    ],
    products: [
      mkProduct({ key: "p-arqon4kg", name: "Ikki qavat arqon 4kg", lineIds: [6], producedKg: 100 }),
      mkProduct({
        key: "p-qopip100", name: "Qop Ip - 100 talik", sku: "TM-000080", lineIds: [6], batchKg: 120,
        placements: [{ wid: 20, container: "C-10", kg: 50, qty: 6000, ptype: "finished", skuInContainer: "TM-000080" }],
      }),
    ],
  },
  edges: [
    { id: "e-0", kind: "dept-wip", source: "d-6", target: "w-6", table: "wip_movements", joinBasis: "line_id (FK)", rows: 171 },
    { id: "e-1", kind: "wip-product", source: "w-6", target: "p-arqon4kg", table: "wip_movements", joinBasis: "product nomi", kg: 8964.77 },
    { id: "e-2", kind: "batch-product", source: "d-6", target: "p-qopip100", table: "batches", joinBasis: "production_line_id (FK)", kg: 120 },
    { id: "e-3", kind: "product-container", source: "p-qopip100", target: "c-20", table: "inventory", joinBasis: "product nomi", kg: 50, dona: 6000 },
    { id: "e-4", kind: "product-container", source: "p-arqon4kg", target: "regional", table: "inventory", joinBasis: "product nomi", kg: 10 },
  ],
  supplyEdges: [],
  gaps: GAPS,
  meta: {
    unattributedBatches: { products: 9, kg: 0, dona: 82748, batches: 71 },
    dataQuality: {},
  },
};

const SUPPLY_EDGE = {
  id: "s-0", kind: "container-dept" as const, source: "c-7", target: "d-6",
  table: "wip_movements (RECEIVE)", joinBasis: "from_warehouse_id + line_id (FK)",
  kg: 500, rows: 3, first: "2026-08-01", last: "2026-08-15",
};

const act = (...keys: FilterKey[]) => new Set<FilterKey>(keys);

// ---------- buildScaffold ----------

describe("buildScaffold — node'lar", () => {
  const s = buildScaffold(MINI, false);

  it("5 ta ustun yorlig'i chiziladi va har node o'z ustunida turadi", () => {
    const labels = s.nodes.filter((n) => n.type === "colLabel");
    expect(labels.map((l) => l.id).sort()).toEqual(
      ["label-dept", "label-finished", "label-product", "label-raw", "label-wip"],
    );
    const colXs = new Set<number>(Object.values(COL_X));
    for (const n of s.nodes) {
      if (n.type === "gap") continue; // gap ustunlar orasida turadi
      expect(colXs.has(n.position.x)).toBe(true);
    }
  });

  it("node turlari to'g'ri sonda; nofaol bo'lim va bo'sh konteyner chizilmaydi", () => {
    const byType = (t: string) => s.nodes.filter((n) => n.type === t);
    expect(byType("container")).toHaveLength(3); // 2 raw + 1 finished, bo'sh yo'q
    expect(byType("dept")).toHaveLength(1);      // faqat faol d-6 (id=10 nofaol — yo'q)
    expect(byType("wip")).toHaveLength(2);
    expect(byType("product")).toHaveLength(2);
    expect(byType("regional")).toHaveLength(1);
    expect(s.nodes.find((n) => n.id === "d-10")).toBeUndefined();
    expect(s.nodes.find((n) => n.id === "c-30")).toBeUndefined();
  });

  it("showEmpty=true bo'sh konteynerni finished ustuniga qo'shadi", () => {
    const s2 = buildScaffold(MINI, true);
    const empty = s2.nodes.find((n) => n.id === "c-30");
    expect(empty).toBeDefined();
    expect(empty!.position.x).toBe(COL_X.finished);
    expect(s2.metaById.get("c-30")!.classes).toEqual(["empty"]);
  });

  it("gap-receive faqat NO_RECEIVE_DATA gap mavjud bo'lsa chiziladi", () => {
    expect(s.nodes.find((n) => n.id === "gap-receive")).toBeDefined();
    const noGap: FlowGraphResponse = { ...MINI, gaps: GAPS.filter((g) => g.code !== "NO_RECEIVE_DATA") };
    expect(buildScaffold(noGap, false).nodes.find((n) => n.id === "gap-receive")).toBeUndefined();
  });

  it("manfiy WIP balansi aslicha o'tadi — clamp/yashirish yo'q", () => {
    const w6 = s.nodes.find((n) => n.id === "w-6");
    expect((w6!.data as { wip: WipData }).wip.balanceKg).toBe(-8964.77);
    expect((w6!.data as { wip: WipData }).wip.status).toBe("NEGATIVE");
  });

  it("SKU null aslicha qoladi — taxmin qilinmaydi", () => {
    const p = s.nodes.find((n) => n.id === "p-arqon4kg");
    expect((p!.data as { product: ProductData }).product.sku).toBeNull();
  });
});

describe("buildScaffold — edge'lar", () => {
  const s = buildScaffold(MINI, false);

  it("faqat API bergan edge'lar chiziladi — supply bo'sh bo'lsa container→dept yo'q", () => {
    expect(s.edges).toHaveLength(MINI.edges.length);
    const containerToDept = s.edges.filter((e) => e.source.startsWith("c-") && e.target.startsWith("d-"));
    expect(containerToDept).toHaveLength(0);
  });

  it("edge label har kind uchun to'g'ri formatlanadi", () => {
    expect(edgeLabel(MINI.edges[0])).toBe("171 yozuv");
    expect(edgeLabel(MINI.edges[1])).toContain("kg");
    expect(edgeLabel(MINI.edges[2])).toContain("batch:");
    expect(edgeLabel(MINI.edges[3])).toContain("dona");
    expect(edgeLabel(SUPPLY_EDGE)).toContain("RECEIVE:");
  });

  it("supply edge real RECEIVE sifatida qo'shiladi (amber, adjacency bilan)", () => {
    const withSupply: FlowGraphResponse = { ...MINI, supplyEdges: [SUPPLY_EDGE] };
    const s2 = buildScaffold(withSupply, false);
    const sup = s2.edges.find((e) => e.id === "s-0");
    expect(sup).toBeDefined();
    expect((sup!.style as { stroke?: string }).stroke).toBe(EDGE_STYLE["container-dept"].stroke);
    expect(s2.adjacency.get("c-7")?.has("d-6")).toBe(true);
    expect(s2.adjacency.get("d-6")?.has("c-7")).toBe(true);
  });
});

// ---------- computeVisible (qidiruv + filtr) ----------

describe("computeVisible", () => {
  const s = buildScaffold(MINI, false);

  it("query ham filtr ham bo'lmasa null — hammasi ko'rinadi", () => {
    expect(computeVisible("", act(), s.metaById, s.adjacency)).toBeNull();
  });

  it("qidiruv topilmani VA u bilan bog'langan zanjirni yoritadi (path highlight)", () => {
    const v = computeVisible("qop ip", act(), s.metaById, s.adjacency)!;
    expect(v.has("p-qopip100")).toBe(true); // topilma (nom bo'yicha)
    expect(v.has("c-20")).toBe(true);       // e-3 orqali bog'langan
    expect(v.has("d-6")).toBe(true);        // e-2 orqali bog'langan
    expect(v.has("c-10")).toBe(false);      // izolyatsiya qilingan — yoritilmaydi
  });

  it("SKU bo'yicha qidiruv ishlaydi", () => {
    const v = computeVisible("TM-000080", act(), s.metaById, s.adjacency)!;
    expect(v.has("p-qopip100")).toBe(true);
    expect(v.has("c-20")).toBe(true); // konteyner item SKU'si ham haystack'da
  });

  it("apostrof variantlari normalizatsiya qilinadi (bo'lim ≈ bolim)", () => {
    const v1 = computeVisible("Arqon Bo'lim", act(), s.metaById, s.adjacency)!;
    const v2 = computeVisible("arqon bolim", act(), s.metaById, s.adjacency)!;
    expect(v1.has("d-6")).toBe(true);
    expect([...v1].sort()).toEqual([...v2].sort());
  });

  it("hech narsa topilmasa bo'sh Set — UI 'Hech qanday ma'lumot topilmadi.' ko'rsatadi", () => {
    const v = computeVisible("mavjudemasmahsulot", act(), s.metaById, s.adjacency)!;
    expect(v.size).toBe(0);
  });

  it("kind filtr faqat o'sha tur node'larini qoldiradi", () => {
    const v = computeVisible("", act("wip"), s.metaById, s.adjacency)!;
    expect([...v].sort()).toEqual(["w-6", "w-8"]);
  });

  it("class filtr kontent klassi bo'yicha ishlaydi (mixed konteyner ham raw'ga kiradi)", () => {
    const v = computeVisible("", act("raw"), s.metaById, s.adjacency)!;
    expect(v.has("c-7")).toBe(true);  // byType'da raw bor (mixed)
    expect(v.has("c-10")).toBe(true); // sof raw kontent
    expect(v.has("c-20")).toBe(false);
    expect(v.has("p-qopip100")).toBe(false); // product klass filtri bilan: finished, raw emas
  });

  it("qidiruv + filtr kesishma sifatida ishlaydi", () => {
    const v = computeVisible("qop ip", act("container"), s.metaById, s.adjacency)!;
    expect(v.has("c-20")).toBe(true);       // zanjirda ham bor, container ham
    expect(v.has("p-qopip100")).toBe(false); // topilma, lekin container emas
  });
});

// ---------- selection / bo'sh graf ----------

describe("selectionForNodeId", () => {
  it("har bir id sxemasi to'g'ri tanlovga aylanadi", () => {
    expect(selectionForNodeId("c-7")).toEqual({ kind: "container", id: 7 });
    expect(selectionForNodeId("regional")).toEqual({ kind: "regional" });
    expect(selectionForNodeId("d-6")).toEqual({ kind: "dept", id: 6 });
    expect(selectionForNodeId("w-8")).toEqual({ kind: "wip", id: 8 });
    expect(selectionForNodeId("p-qopip100")).toEqual({ kind: "product", key: "p-qopip100" });
    expect(selectionForNodeId("gap-receive")).toEqual({ kind: "gap", code: "NO_RECEIVE_DATA" });
    expect(selectionForNodeId("label-raw")).toBeNull();
  });
});

describe("isEmptyGraph", () => {
  it("ma'lumotli graf bo'sh emas", () => {
    expect(isEmptyGraph(MINI)).toBe(false);
  });
  it("hamma guruhlar bo'sh bo'lsa true", () => {
    const empty: FlowGraphResponse = {
      ...MINI,
      nodes: {
        containersRaw: [], containersFinished: [], emptyContainers: [], regionalGroup: null,
        departments: [], inactiveDepartments: [], wip: [], products: [],
      },
    };
    expect(isEmptyGraph(empty)).toBe(true);
  });
});
