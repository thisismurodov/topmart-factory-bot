// Production Flow Map — detal panellari (o'ng sheet). Har bir raqam API'dan
// (real DB holati) — hech narsa o'ylab topilmaydi. Graf holati yopilganda saqlanadi.
import type { ReactNode } from "react";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Ban } from "lucide-react";
import {
  CLASS_BADGE, CLASS_LABEL, PTYPE_BADGE, fmtInt, fmtKg, fmtMoney,
  type ContainerData, type DeptData, type FlowEdgeData, type FlowGraphResponse,
  type ProductData, type Selection, type WipData,
} from "./types";

const Row = ({ k, v, warn }: { k: string; v: ReactNode; warn?: boolean }) => (
  <div className="flex items-start justify-between gap-3 py-1 text-[13px]">
    <span className="text-zinc-500 shrink-0">{k}</span>
    <span className={`text-right tabular-nums ${warn ? "font-semibold text-red-600" : "text-zinc-900"}`}>{v}</span>
  </div>
);

const SectionTitle = ({ children }: { children: ReactNode }) => (
  <div className="mt-4 mb-1.5 text-[11px] font-bold uppercase tracking-wider text-zinc-400">{children}</div>
);

const NoData = ({ text }: { text: string }) => (
  <div className="flex items-center gap-2 rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-[12px] text-zinc-500">
    <Ban className="h-3.5 w-3.5 shrink-0" /> {text}
  </div>
);

function ContainerBody({ c }: { c: ContainerData }) {
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="outline" className={`${CLASS_BADGE[c.derived] ?? ""} text-[11px]`}>{CLASS_LABEL[c.derived] ?? c.derived}</Badge>
        <Badge variant="outline" className="text-[11px]">{c.loc === "container" ? "Konteyner" : c.loc}</Badge>
        {c.purpose && <Badge variant="outline" className="text-[11px]">DB purpose: {c.purpose}</Badge>}
      </div>
      {c.mismatch && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-orange-300 bg-orange-50 px-3 py-2 text-[12px] text-orange-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            DB'da purpose='<b>{c.purpose}</b>', lekin kontent <b>{c.dominant}</b>. Grafda kontent bo'yicha
            ko'rsatilmoqda; DB qiymati o'zgartirilmagan (№3 — alohida qaror).
          </span>
        </div>
      )}
      <SectionTitle>Umumiy</SectionTitle>
      <Row k="Og'irlik" v={`${fmtKg(c.kg)} kg`} />
      <Row k="Miqdor" v={`${fmtInt(c.dona)} dona`} />
      <Row k="Pozitsiyalar" v={c.positionsCount} />
      {c.cap != null && <Row k="Sig'im" v={`${fmtKg(c.cap)} kg`} />}
      <SectionTitle>Kontent turlari</SectionTitle>
      {Object.entries(c.byType).map(([t, v]) => (
        <Row key={t} k={CLASS_LABEL[t] ?? t} v={`${fmtKg(v.kg)} kg · ${fmtInt(v.dona)} dona · ${v.rows} qator`} />
      ))}
      <SectionTitle>Mahsulotlar ({c.items.length})</SectionTitle>
      <div className="overflow-hidden rounded-md border">
        <table className="w-full text-[12px]">
          <thead className="bg-zinc-50 text-zinc-500">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">Mahsulot</th>
              <th className="px-2 py-1.5 text-left font-medium">SKU</th>
              <th className="px-2 py-1.5 text-right font-medium">Dona</th>
              <th className="px-2 py-1.5 text-right font-medium">Kg</th>
              <th className="px-2 py-1.5 text-left font-medium">Turi</th>
            </tr>
          </thead>
          <tbody>
            {c.items.map((it, i) => (
              <tr key={i} className="border-t">
                <td className="px-2 py-1.5">{it.product}</td>
                <td className="px-2 py-1.5 font-mono text-[11px]">{it.sku ?? <span className="text-zinc-400">—</span>}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmtInt(it.qty)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmtKg(it.kg)}</td>
                <td className="px-2 py-1.5">
                  {it.ptype ? (
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${PTYPE_BADGE[it.ptype] ?? "bg-zinc-100 text-zinc-500"}`}>{it.ptype}</span>
                  ) : (
                    <span className="text-zinc-400 text-[10px]">belgilanmagan</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function DeptBody({ d, graph }: { d: DeptData; graph: FlowGraphResponse }) {
  const w = graph.nodes.wip.find((x) => x.lineId === d.id);
  const roleLabel = (rk: string) => d.roles.find((r) => r.roleKey === rk)?.label ?? rk;
  const byRole = new Map<string, string[]>();
  for (const x of d.workers) {
    if (!byRole.has(x.role)) byRole.set(x.role, []);
    byRole.get(x.role)!.push(x.worker);
  }
  return (
    <>
      <SectionTitle>WIP holati</SectionTitle>
      {w && w.rows > 0 ? (
        <>
          <Row k="Balans" v={`${fmtKg(w.balanceKg)} kg`} warn={w.balanceKg < 0} />
          <Row k="Kirim (RECEIVE)" v={w.receiveKg > 0 ? `${fmtKg(w.receiveKg)} kg` : "0 kg — yozuv yo'q"} warn={w.receiveKg <= 0} />
          <Row k="Chiqim (PRODUCE)" v={`${fmtKg(w.produceKg)} kg · ${w.rows} yozuv`} />
        </>
      ) : (
        <NoData text="WIP ledger yozuvi yo'q (wip_movements: 0 ta)" />
      )}
      <SectionTitle>Kirim (input)</SectionTitle>
      {graph.supplyEdges.some((e) => e.target === `d-${d.id}`) ? (
        graph.supplyEdges.filter((e) => e.target === `d-${d.id}`).map((e, i) => (
          <Row key={i} k={e.source} v={`${fmtKg(e.kg ?? 0)} kg · ${e.rows ?? 0} yozuv`} />
        ))
      ) : (
        <NoData text="Konteyner → bo'lim RECEIVE yozuvlari yo'q — flow data mavjud emas" />
      )}
      {d.bomInputs.length > 0 && (
        <>
          <div className="mt-2 text-[11px] text-zinc-500">Retsept bo'yicha kutiladigan materiallar (BOM, {d.bomInputs.length} ta):</div>
          <div className="mt-1 overflow-hidden rounded-md border">
            <table className="w-full text-[12px]">
              <thead className="bg-zinc-50 text-zinc-500">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">Material</th>
                  <th className="px-2 py-1.5 text-left font-medium">Mahsulot</th>
                  <th className="px-2 py-1.5 text-right font-medium">Birlikka</th>
                </tr>
              </thead>
              <tbody>
                {d.bomInputs.map((b, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-2 py-1.5">{b.material}</td>
                    <td className="px-2 py-1.5 text-zinc-500">{b.product}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{b.perUnit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <SectionTitle>Chiqim (output)</SectionTitle>
      {d.produce.length === 0 && d.batches.length === 0 && <NoData text="Chiqim ma'lumoti yo'q" />}
      {d.produce.map((p, i) => (
        <Row key={`p${i}`} k={p.product} v={`${fmtKg(p.kg)} kg · ${p.n} yozuv (${p.first} → ${p.last})`} />
      ))}
      {d.batches.length > 0 && (
        <>
          <div className="mt-1 text-[11px] text-zinc-500">Partiyalar (batches):</div>
          {d.batches.map((b, i) => (
            <Row key={`b${i}`} k={b.product} v={`${fmtKg(b.kg)} kg / ${fmtInt(b.dona)} dona · ${b.n} partiya`} />
          ))}
        </>
      )}
      <SectionTitle>Ishchilar ({d.workers.length})</SectionTitle>
      {d.workers.length === 0 && <NoData text="Ishchi biriktirilmagan" />}
      {[...byRole.entries()].map(([role, names]) => (
        <div key={role} className="py-1">
          <div className="text-[12px] font-semibold text-zinc-700">
            {roleLabel(role)} <span className="font-normal text-zinc-400">({names.length})</span>
          </div>
          <div className="text-[12px] text-zinc-600">{names.join(", ")}</div>
        </div>
      ))}
      {d.roles.length > 0 && (
        <>
          <div className="mt-1 text-[11px] text-zinc-500">Rol stavkalari:</div>
          {d.roles.map((r, i) => (
            <Row key={i} k={r.label} v={`${fmtMoney(r.rate)} (${r.payMode})${r.maxWorkers ? ` · max ${r.maxWorkers}` : ""}`} />
          ))}
        </>
      )}
      <SectionTitle>Oylik (salary)</SectionTitle>
      {d.salary.entries === 0 ? (
        <NoData text="Yopilgan kun yozuvlari yo'q" />
      ) : (
        <>
          <Row k="Jami hisoblangan" v={fmtMoney(d.salary.total)} />
          <Row k="Yozuvlar / ishchilar" v={`${d.salary.entries} ta / ${d.salary.workers} kishi`} />
          <Row k="Oxirgi sana" v={d.salary.lastDate ?? "—"} />
          {d.salaryByWorker.length > 0 && (
            <>
              <div className="mt-1 text-[11px] text-zinc-500">Ishchilar kesimida:</div>
              {d.salaryByWorker.map((s, i) => (
                <Row key={i} k={s.worker} v={`${fmtMoney(s.total)} · ${s.entries} yozuv · ${s.last}`} />
              ))}
            </>
          )}
        </>
      )}
    </>
  );
}

function WipBody({ w }: { w: WipData }) {
  return (
    <>
      {w.status === "NEGATIVE" && (
        <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Balans manfiy: kirim (RECEIVE) hech qachon yozilmagan, chiqim esa yozilgan. Bu real database
            holati — yashirilmagan. Kirim yozila boshlagach balans to'g'rilanadi.
          </span>
        </div>
      )}
      <SectionTitle>Balans</SectionTitle>
      <Row k="Kirim (RECEIVE)" v={w.receiveKg > 0 ? `${fmtKg(w.receiveKg)} kg` : `${fmtKg(w.receiveKg)} kg — yozuv yo'q`} warn={w.rows > 0 && w.receiveKg <= 0} />
      <Row k="Chiqim (PRODUCE)" v={`${fmtKg(w.produceKg)} kg`} />
      <Row k="Balans" v={`${fmtKg(w.balanceKg)} kg`} warn={w.balanceKg < 0} />
      <Row k="Yozuvlar" v={`${w.rows} ta${w.receiveKg <= 0 ? " (barchasi PRODUCE)" : ""}`} />
      <SectionTitle>Holat</SectionTitle>
      <Row k="Status" v={w.status === "NEGATIVE" ? "MANFIY — kirim yozilmagan" : w.status === "NO_LEDGER" ? "Ledger bo'sh" : "OK"} warn={w.status === "NEGATIVE"} />
      <Row k="Production line" v={w.lineName} />
      <Row k="Birinchi yozuv" v={w.first ?? "—"} />
      <Row k="Oxirgi yozuv" v={w.last ?? "—"} />
    </>
  );
}

function ProductBody({ p, graph }: { p: ProductData; graph: FlowGraphResponse }) {
  const stockKg = p.placements.reduce((s, x) => s + x.kg, 0);
  const stockDona = p.placements.reduce((s, x) => s + x.qty, 0);
  const lines = graph.nodes.departments.filter((d) => p.lineIds.includes(d.id)).map((d) => d.name);
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {p.sku ? (
          <Badge variant="outline" className="bg-teal-50 text-teal-700 border-teal-300 font-mono text-[11px]">{p.sku}</Badge>
        ) : (
          <Badge variant="outline" className="bg-zinc-100 text-zinc-500 text-[11px]">SKU biriktirilmagan (item_id bo'sh)</Badge>
        )}
        <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-300 text-[11px]">FINISHED</Badge>
      </div>
      <SectionTitle>Ishlab chiqarish</SectionTitle>
      <Row k="Bo'lim" v={lines.join(", ") || "—"} />
      {p.producedKg > 0 && <Row k="WIP chiqim (jami)" v={`${fmtKg(p.producedKg)} kg`} />}
      {(p.batchKg > 0 || p.batchDona > 0) && <Row k="Partiyalar (jami)" v={`${fmtKg(p.batchKg)} kg / ${fmtInt(p.batchDona)} dona`} />}
      <SectionTitle>Ombordagi qoldiq</SectionTitle>
      {p.placements.length === 0 ? (
        <NoData text="Inventarda nom bo'yicha mos yozuv topilmadi (item_id bog'i yo'q)" />
      ) : (
        <>
          <Row k="Jami" v={`${fmtKg(stockKg)} kg / ${fmtInt(stockDona)} dona`} />
          <div className="mt-1 overflow-hidden rounded-md border">
            <table className="w-full text-[12px]">
              <thead className="bg-zinc-50 text-zinc-500">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">Joylashuv</th>
                  <th className="px-2 py-1.5 text-right font-medium">Dona</th>
                  <th className="px-2 py-1.5 text-right font-medium">Kg</th>
                  <th className="px-2 py-1.5 text-left font-medium">Turi</th>
                </tr>
              </thead>
              <tbody>
                {p.placements.map((pl, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-2 py-1.5">{pl.container}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtInt(pl.qty)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtKg(pl.kg)}</td>
                    <td className="px-2 py-1.5">
                      {pl.ptype ? (
                        <span className={`rounded px-1.5 py-0.5 text-[10px] ${PTYPE_BADGE[pl.ptype] ?? "bg-zinc-100 text-zinc-500"}`}>{pl.ptype}</span>
                      ) : (
                        <span className="text-zinc-400 text-[10px]">belgilanmagan</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <SectionTitle>Retsept (BOM)</SectionTitle>
      {p.bom.length === 0 ? (
        <NoData text="BOM yozuvi yo'q" />
      ) : (
        p.bom.map((b, i) => (
          <Row key={i} k={b.material} v={`${b.perUnit} birlikka${b.stock != null ? ` · zaxira: ${fmtKg(b.stock)}` : ""}`} />
        ))
      )}
    </>
  );
}

function EdgeBody({ e }: { e: FlowEdgeData }) {
  const KIND_LABEL: Record<string, string> = {
    "dept-wip": "Bo'lim → WIP (ishlab chiqarish ledgeri)",
    "wip-product": "WIP → Mahsulot (PRODUCE chiqimi)",
    "batch-product": "Bo'lim → Mahsulot (partiya/batch)",
    "product-container": "Mahsulot → Ombor (inventar joylashuvi)",
    "container-dept": "Konteyner → Bo'lim (real RECEIVE kirimi)",
  };
  return (
    <>
      <SectionTitle>Real relationship (DB)</SectionTitle>
      <Row k="Turi" v={KIND_LABEL[e.kind] ?? e.kind} />
      <Row k="Jadval" v={<span className="font-mono text-[12px]">{e.table}</span>} />
      <Row k="Bog'lanish asosi" v={e.joinBasis} />
      <SectionTitle>Hajm</SectionTitle>
      {e.kg != null && <Row k="Og'irlik" v={`${fmtKg(e.kg)} kg`} />}
      {e.dona != null && <Row k="Miqdor" v={`${fmtInt(e.dona)} dona`} />}
      {e.rows != null && <Row k="Yozuvlar" v={`${e.rows} ta`} />}
      {(e.first || e.last) && <Row k="Davr" v={`${e.first ?? "…"} → ${e.last ?? "…"}`} />}
      {e.note && (
        <div className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-[12px] text-zinc-600">{e.note}</div>
      )}
    </>
  );
}

function GapBody({ code, graph }: { code: string; graph: FlowGraphResponse }) {
  const g = graph.gaps.find((x) => x.code === code);
  if (!g) return null;
  const u = graph.meta.unattributedBatches;
  return (
    <>
      <div className="flex items-start gap-2 rounded-md border border-orange-300 bg-orange-50 px-3 py-2 text-[13px] text-orange-800">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{g.detail}</span>
      </div>
      {code === "UNATTRIBUTED_BATCHES" && u && (
        <>
          <SectionTitle>Raqamlar (batches jadvalidan)</SectionTitle>
          <Row k="Partiyalar" v={`${fmtInt(u.batches)} ta`} />
          <Row k="Mahsulot turlari" v={`${fmtInt(u.products)} xil`} />
          <Row k="Miqdor" v={`${fmtInt(u.dona)} dona`} />
          <Row k="Og'irlik" v={`${fmtKg(u.kg)} kg`} />
        </>
      )}
      <SectionTitle>Nega bu ko'rsatilmoqda?</SectionTitle>
      <p className="text-[13px] leading-relaxed text-zinc-600">
        Qoida: mavjud bo'lmagan ma'lumot o'ylab topilmaydi. Bo'shliq — real holat, va u yashirilmaydi.
        Tegishli yozuvlar bazada paydo bo'lgach, bu joy avtomatik to'ladi.
      </p>
    </>
  );
}

export function DetailSheet({ graph, sel, onClose }: { graph: FlowGraphResponse; sel: Selection; onClose: () => void }) {
  let title = "";
  let desc = "";
  let body: ReactNode = null;
  const N = graph.nodes;

  if (sel) {
    if (sel.kind === "container") {
      const c = [...N.containersRaw, ...N.containersFinished, ...N.emptyContainers].find((x) => x.id === sel.id);
      if (c) { title = c.name; desc = "Konteyner tafsiloti — real inventar"; body = <ContainerBody c={c} />; }
    } else if (sel.kind === "regional" && N.regionalGroup) {
      const g = N.regionalGroup;
      title = g.name; desc = `${g.count} ta ombor (agregat)`;
      body = (
        <>
          <Row k="Jami" v={`${fmtKg(g.kg)} kg · ${fmtInt(g.dona)} dona`} />
          <SectionTitle>Omborlar</SectionTitle>
          {g.list.map((c) => (
            <Row key={c.id} k={c.name} v={`${fmtKg(c.kg)} kg · ${fmtInt(c.dona)} dona · ${c.positionsCount} poz.`} />
          ))}
        </>
      );
    } else if (sel.kind === "dept") {
      const d = N.departments.find((x) => x.id === sel.id);
      if (d) { title = d.name; desc = "Bo'lim (production_lines) — real ma'lumot"; body = <DeptBody d={d} graph={graph} />; }
    } else if (sel.kind === "wip") {
      const w = N.wip.find((x) => x.lineId === sel.id);
      if (w) { title = `WIP — ${w.lineName}`; desc = "wip_movements ledgeri"; body = <WipBody w={w} />; }
    } else if (sel.kind === "product") {
      const p = N.products.find((x) => x.key === sel.key);
      if (p) { title = p.name; desc = "Mahsulot tafsiloti"; body = <ProductBody p={p} graph={graph} />; }
    } else if (sel.kind === "edge") {
      const e = [...graph.edges, ...graph.supplyEdges].find((x) => x.id === sel.id);
      if (e) { title = "Bog'lanish (connection)"; desc = "Mavjud DB relationship"; body = <EdgeBody e={e} />; }
    } else if (sel.kind === "gap") {
      const g = graph.gaps.find((x) => x.code === sel.code);
      if (g) { title = g.title; desc = "Ma'lumot bo'shlig'i — halol ko'rsatiladi"; body = <GapBody code={sel.code} graph={graph} />; }
    }
  }

  return (
    <Sheet open={sel != null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-[92vw] sm:max-w-[440px] p-0" data-testid="flow-drawer">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="text-[16px]">{title}</SheetTitle>
          <SheetDescription className="text-[12px]">{desc}</SheetDescription>
        </SheetHeader>
        <ScrollArea className="h-[calc(100dvh-88px)] px-5 py-4">
          <div className="pb-8">{body}</div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
