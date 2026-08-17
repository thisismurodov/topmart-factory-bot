// READ-ONLY ISBOT SKRIPTI — GET /ombor/flow/graph builderini real DB'da
// ishga tushiradi va tegishi mumkin bo'lgan barcha jadvallarning satr soni +
// MAX(id) qiymatlarini oldin/keyin taqqoslaydi. Skriptning o'zi ham faqat
// SELECT bajaradi. Natija /tmp/flowgraph_prod.json ga yoziladi.
//
// Ishga tushirish:
//   pnpm --filter @workspace/api-server exec tsx src/scripts/flow-graph-proof.ts
import { writeFileSync } from "node:fs";
import { pool } from "@workspace/db";
import { buildFlowGraph } from "../lib/flowGraph";

const TABLES = [
  "warehouses",
  "inventory",
  "items",
  "production_lines",
  "production_line_workers",
  "line_role_config",
  "wip_movements",
  "batches",
  "product_materials",
  "raw_materials",
  "salary_payments",
  "products",
];

async function snapshot(): Promise<Record<string, { n: number; maxId: string }>> {
  const out: Record<string, { n: number; maxId: string }> = {};
  for (const t of TABLES) {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(MAX(id), 0)::bigint::text AS max_id FROM ${t}`,
    );
    out[t] = { n: r.rows[0].n, maxId: r.rows[0].max_id };
  }
  return out;
}

async function main(): Promise<void> {
  const before = await snapshot();
  const t0 = Date.now();
  const g = await buildFlowGraph(pool);
  const ms = Date.now() - t0;
  const after = await snapshot();

  const edgeKinds: Record<string, number> = {};
  for (const e of g.edges) edgeKinds[e.kind] = (edgeKinds[e.kind] || 0) + 1;

  console.log("=== GET /ombor/flow/graph — jonli natija (" + ms + " ms) ===");
  console.log(
    JSON.stringify(
      {
        generatedAt: g.generatedAt,
        readOnly: g.readOnly,
        nodes: {
          containersRaw: g.nodes.containersRaw.map((c) => c.name),
          containersFinished: g.nodes.containersFinished.map((c) => c.name),
          emptyContainers: g.nodes.emptyContainers.length,
          regional: g.nodes.regionalGroup ? g.nodes.regionalGroup.count : 0,
          departments: g.nodes.departments.map((d) => `${d.id}:${d.name}`),
          inactiveDepartments: g.nodes.inactiveDepartments,
          wip: g.nodes.wip.map((w) => `${w.lineName}: ${w.balanceKg} kg / ${w.status}`),
          products: g.nodes.products.map((p) => `${p.name} [sku=${p.sku ?? "yo'q"}]`),
        },
        edges: { total: g.edges.length, byKind: edgeKinds },
        supplyEdges: g.supplyEdges.length,
        gaps: g.gaps.map((x) => x.code),
        meta: { dataQuality: g.meta.dataQuality, counts: g.meta.counts },
      },
      null,
      2,
    ),
  );

  console.log("=== Jadval holati: oldin vs keyin ===");
  let dirty = 0;
  for (const t of TABLES) {
    const same = before[t].n === after[t].n && before[t].maxId === after[t].maxId;
    if (!same) dirty++;
    console.log(
      `${same ? "OK " : "DIFF"} ${t}: oldin n=${before[t].n} maxId=${before[t].maxId} | keyin n=${after[t].n} maxId=${after[t].maxId}`,
    );
  }
  writeFileSync("/tmp/flowgraph_prod.json", JSON.stringify(g, null, 1));
  console.log("To'liq javob: /tmp/flowgraph_prod.json");
  if (dirty > 0) {
    console.log(
      `DIQQAT: ${dirty} jadvalda farq bor — bu builder yozgani ANGLATMAYDI ` +
        "(builder READ ONLY tranzaksiyada), parallel bot/dashboard faoliyatini tekshiring.",
    );
    process.exitCode = 2;
  } else {
    console.log("DATABASE WRITE = 0 — barcha jadvallar o'zgarmagan.");
  }
  await pool.end();
}

void main().catch((e) => {
  console.error("Isbot skripti xatosi:", e);
  process.exitCode = 1;
});
