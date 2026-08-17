// F4 — Department Detail paneli. Real API: GET /api/ombor/flow/department/:id
// (sessiya auth, read-only). DATABASE'DA BOR NARSA = KO'RSATISH,
// YO'Q NARSA = "MA'LUMOT MAVJUD EMAS". Taxmin yo'q.
//
// Yagona gate qoidasi: bu query'ning pending/error holatiga FAQAT shu komponent
// qaraydi (react-query refetch bo'ronining oldini olish uchun).
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Ban, Loader2 } from "lucide-react";
import { authFetch } from "@/App";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import { PTYPE_BADGE, fmtInt, fmtKg, fmtMoney } from "./types";

// ── API kontrakt turlari (departmentDetail.ts bilan bir xil) ─────────────────
interface DeptEmployee {
  worker: string; role: string; roleLabel: string | null; phone: string | null;
  prefix: string | null; joinedAt: string | null; otherLines: { id: number; name: string }[];
}
interface DeptRole {
  roleKey: string; label: string; rate: number; payMode: string;
  maxWorkers: number; workersNow: number;
}
interface DeptWipMovement {
  id: number; type: string; rawMaterial: string | null; product: string | null;
  kg: number; fromWid: number | null; fromName: string | null; batchId: number | null;
  note: string | null; by: string | null; at: string | null; itemLinked: boolean;
}
interface DeptSalaryEntry {
  worker: string; role: string | null; sourceType: string | null; batchId: number | null;
  workDate: string | null; kg: number | null; rate: number | null; amount: number;
}
interface DeptPayrollRun {
  workDate: string; totalKg: number; status: string | null;
  closedBy: string | null; closedAt: string | null;
}
interface DeptWorkerPayment {
  worker: string; year: number; month: number; amount: number; paidAt: string | null;
}
interface DeptProduceAgg { product: string; kg: number; n: number; first: string; last: string }
interface DeptBatchAgg { product: string; kg: number; dona: number; n: number; last: string; archivedN: number }
interface DeptBatchRow {
  id: number; code: string | null; worker: string | null; product: string;
  qty: number; kg: number; at: string | null; payrollMethod: string | null;
  archived: boolean; itemLinked: boolean;
}
interface DeptReceiveAgg {
  fromWid: number | null; fromName: string | null; kg: number; rows: number;
  first: string | null; last: string | null;
}
interface DeptBomInput { product: string; material: string; perUnit: number; stock: number | null; currency: string | null }
interface DeptPlacement { wid: number; container: string; loc: string | null; kg: number; qty: number; ptype: string | null }
interface DeptProduct {
  name: string; sku: string | null; producedKg: number; produceN: number;
  batchKg: number; batchDona: number; batchN: number;
  placements: DeptPlacement[]; bom: { material: string; perUnit: number; stock: number | null; currency: string | null }[];
}
interface DeptDestination { wid: number; container: string; loc: string | null; kg: number; dona: number; products: number }
interface DeptWarning { code: string; title: string; detail: string }
export interface DeptDetailResponse {
  generatedAt: string; readOnly: true; source: string;
  department: { id: number; name: string; active: boolean; createdAt: string | null; inFlowScope: boolean };
  header: { employees: number; roles: number; wipKg: number; wipStatus: "OK" | "NEGATIVE" | "NO_LEDGER"; warnings: number };
  employees: DeptEmployee[];
  roles: DeptRole[];
  salary: {
    lineEntries: { rows: DeptSalaryEntry[]; total: number; count: number; workers: number; first: string | null; last: string | null };
    payrollRuns: { rows: DeptPayrollRun[]; count: number; totalKg: number };
    workerPayments: { rows: DeptWorkerPayment[]; total: number; count: number };
  };
  wip: {
    balanceKg: number; receiveKg: number; produceKg: number; rows: number;
    status: "OK" | "NEGATIVE" | "NO_LEDGER"; first: string | null; last: string | null;
    movements: DeptWipMovement[]; movementsTotal: number;
  };
  inputs: { receives: DeptReceiveAgg[]; receiveRows: number; bom: DeptBomInput[] };
  outputs: {
    produce: DeptProduceAgg[]; produceKg: number; batchesByProduct: DeptBatchAgg[];
    batchRows: DeptBatchRow[]; batchesTotal: number; batchKg: number; batchDona: number;
  };
  products: DeptProduct[];
  destinations: DeptDestination[];
  warnings: DeptWarning[];
  meta: { itemLinks: { wip: string; batches: string }; limits: Record<string, number> };
}

// ── Yordamchilar ─────────────────────────────────────────────────────────────
const Row = ({ k, v, warn }: { k: string; v: ReactNode; warn?: boolean }) => (
  <div className="flex items-start justify-between gap-3 py-1 text-[13px]">
    <span className="text-zinc-500 shrink-0">{k}</span>
    <span className={`text-right tabular-nums ${warn ? "font-semibold text-red-600" : "text-zinc-900"}`}>{v}</span>
  </div>
);
const SubTitle = ({ children }: { children: ReactNode }) => (
  <div className="mt-3 mb-1 text-[11px] font-bold uppercase tracking-wider text-zinc-400">{children}</div>
);
const NoData = ({ text }: { text: string }) => (
  <div className="flex items-center gap-2 rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-[12px] text-zinc-500">
    <Ban className="h-3.5 w-3.5 shrink-0" /> {text}
  </div>
);
const SourceChip = ({ children }: { children: ReactNode }) => (
  <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">{children}</span>
);

// UTC ISO → Toshkent vaqti "YYYY-MM-DD HH:MM"
const fmtDT = (s: string | null): string => {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString("sv-SE", {
    timeZone: "Asia/Tashkent",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
};
const fmtD = (s: string | null): string => (s ? fmtDT(s).slice(0, 10) : "—");

const TH = ({ children, right }: { children: ReactNode; right?: boolean }) => (
  <th className={`px-2 py-1.5 font-medium ${right ? "text-right" : "text-left"}`}>{children}</th>
);
const TD = ({ children, right, mono }: { children: ReactNode; right?: boolean; mono?: boolean }) => (
  <td className={`px-2 py-1.5 ${right ? "text-right tabular-nums" : ""} ${mono ? "font-mono text-[11px]" : ""}`}>{children}</td>
);
const Tbl = ({ children }: { children: ReactNode }) => (
  <div className="overflow-x-auto rounded-md border">
    <table className="w-full min-w-[420px] text-[12px]">{children}</table>
  </div>
);

async function fetchDeptDetail(id: number): Promise<DeptDetailResponse> {
  let res: Response;
  try {
    res = await authFetch(`/api/ombor/flow/department/${id}`, { signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new Error("So'rov vaqti tugadi — server javob bermadi (60s).");
    }
    throw new Error("Tarmoq xatosi — serverga ulanib bo'lmadi.");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(body.error || `Server xatosi (HTTP ${res.status})`);
  }
  return res.json();
}

// ── Panel ────────────────────────────────────────────────────────────────────
export function DepartmentPanel({ id }: { id: number }) {
  const q = useQuery<DeptDetailResponse>({
    queryKey: ["flow-dept", id],
    queryFn: () => fetchDeptDetail(id),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  if (q.isPending) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center" data-testid="dept-loading">
        <Loader2 className="h-7 w-7 animate-spin text-emerald-600" />
        <div className="text-sm text-muted-foreground">Bo'lim tafsiloti yuklanmoqda...</div>
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-center" data-testid="dept-error">
        <AlertTriangle className="mx-auto h-7 w-7 text-red-500" />
        <div className="mt-2 text-sm font-semibold text-red-800">Bo'lim tafsilotini yuklab bo'lmadi.</div>
        <div className="mt-1 text-[12px] text-red-700">{(q.error as Error).message}</div>
        <Button className="mt-3" size="sm" variant="outline" onClick={() => q.refetch()} data-testid="dept-retry">
          Qayta urinish
        </Button>
      </div>
    );
  }

  const d = q.data;
  const neg = d.wip.balanceKg < 0;

  return (
    <div data-testid="dept-panel">
      {/* ── 1. Department Overview (§4) ─────────────────────────────────── */}
      <div data-testid="dept-header">
        <div className="flex flex-wrap gap-1.5">
          {d.department.active ? (
            <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-[11px] text-emerald-700">Faol</Badge>
          ) : (
            <Badge variant="outline" className="bg-zinc-100 text-[11px] text-zinc-500">Nofaol</Badge>
          )}
          {!d.department.inFlowScope && (
            <Badge variant="outline" className="border-amber-300 bg-amber-50 text-[11px] text-amber-700">
              Oqim xaritasida chizilmaydi
            </Badge>
          )}
          <Badge variant="outline" className="text-[11px]">READ-ONLY</Badge>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-lg border bg-white px-3 py-2">
            <div className="text-[11px] text-zinc-500">Ishchilar</div>
            <div className="text-[18px] font-bold tabular-nums text-zinc-900">{d.header.employees}</div>
          </div>
          <div className="rounded-lg border bg-white px-3 py-2">
            <div className="text-[11px] text-zinc-500">Rollar</div>
            <div className="text-[18px] font-bold tabular-nums text-zinc-900">{d.header.roles}</div>
          </div>
          <div className={`rounded-lg border px-3 py-2 ${neg ? "border-red-300 bg-red-50" : "bg-white"}`}>
            <div className={`text-[11px] ${neg ? "text-red-600" : "text-zinc-500"}`}>WIP balans</div>
            <div
              className={`text-[20px] font-bold tabular-nums ${neg ? "text-red-600" : "text-zinc-900"}`}
              data-testid="dept-wip-big"
            >
              {d.wip.status === "NO_LEDGER" ? "ledger bo'sh" : `${fmtKg(d.wip.balanceKg)} kg`}
            </div>
          </div>
          <div className="rounded-lg border bg-white px-3 py-2">
            <div className="text-[11px] text-zinc-500">Ogohlantirish</div>
            <div className={`text-[18px] font-bold tabular-nums ${d.header.warnings ? "text-amber-600" : "text-zinc-900"}`}>
              {d.header.warnings}
            </div>
          </div>
        </div>
        <div className="mt-2 text-[11px] text-zinc-400">
          production_lines #{d.department.id} · yaratilgan: {fmtD(d.department.createdAt)}
        </div>
      </div>

      {/* Ogohlantirish chiplari (§17: warnings alohida) */}
      {d.warnings.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5" data-testid="dept-warning-chips">
          {d.warnings.map((w) => (
            <span
              key={w.code}
              className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                w.code === "NEGATIVE_WIP"
                  ? "border-red-300 bg-red-50 text-red-700"
                  : "border-amber-300 bg-amber-50 text-amber-700"
              }`}
            >
              {w.code}
            </span>
          ))}
        </div>
      )}

      <Accordion type="multiple" defaultValue={["employees", "wip"]} className="mt-2">
        {/* ── 2. Employees (§5) ───────────────────────────────────────────── */}
        <AccordionItem value="employees" data-testid="dept-sec-employees">
          <AccordionTrigger className="text-[13px]">Ishchilar ({d.employees.length})</AccordionTrigger>
          <AccordionContent>
            {d.employees.length === 0 ? (
              <NoData text="Ishchi biriktirilmagan (production_line_workers bo'sh)" />
            ) : (
              <Tbl>
                <thead className="bg-zinc-50 text-zinc-500">
                  <tr><TH>Ism</TH><TH>Rol</TH><TH>Telefon</TH><TH>Biriktirilgan</TH></tr>
                </thead>
                <tbody>
                  {d.employees.map((e, i) => (
                    <tr key={i} className="border-t">
                      <TD>
                        <div className="font-medium">{e.worker}</div>
                        {e.otherLines.length > 0 && (
                          <div className="text-[10px] text-amber-600">
                            boshqa liniyada ham: {e.otherLines.map((l) => l.name).join(", ")}
                          </div>
                        )}
                      </TD>
                      <TD>{e.roleLabel ?? e.role}</TD>
                      <TD>{e.phone ?? <span className="text-zinc-400">Ma'lumot mavjud emas</span>}</TD>
                      <TD>{fmtD(e.joinedAt)}</TD>
                    </tr>
                  ))}
                </tbody>
              </Tbl>
            )}
            {d.roles.length > 0 && (
              <>
                <SubTitle>Rol stavkalari (line_role_config)</SubTitle>
                {d.roles.map((r, i) => (
                  <Row
                    key={i}
                    k={r.label}
                    v={`${fmtMoney(r.rate)} (${r.payMode}) · hozir ${r.workersNow}${r.maxWorkers ? ` / max ${r.maxWorkers}` : ""}`}
                  />
                ))}
              </>
            )}
          </AccordionContent>
        </AccordionItem>

        {/* ── 3. Salary / Payments (§6) ───────────────────────────────────── */}
        <AccordionItem value="salary" data-testid="dept-sec-salary">
          <AccordionTrigger className="text-[13px]">
            Oylik / to'lovlar ({d.salary.lineEntries.count + d.salary.workerPayments.count})
          </AccordionTrigger>
          <AccordionContent>
            <SubTitle>Liniyaga bog'langan hisob-kitoblar <SourceChip>salary_entries · line_id</SourceChip></SubTitle>
            {d.salary.lineEntries.count === 0 ? (
              <NoData text="Ma'lumot mavjud emas — bu liniyaga bog'langan hisob-kitob yozuvi yo'q" />
            ) : (
              <>
                <Row k="Jami hisoblangan" v={fmtMoney(d.salary.lineEntries.total)} />
                <Row k="Yozuvlar / ishchilar" v={`${d.salary.lineEntries.count} ta / ${d.salary.lineEntries.workers} kishi`} />
                <Row k="Davr" v={`${d.salary.lineEntries.first ?? "…"} → ${d.salary.lineEntries.last ?? "…"}`} />
                <div className="mt-1.5">
                  <Tbl>
                    <thead className="bg-zinc-50 text-zinc-500">
                      <tr><TH>Sana</TH><TH>Ishchi</TH><TH>Rol</TH><TH right>Kg</TH><TH right>Stavka</TH><TH right>Summa</TH></tr>
                    </thead>
                    <tbody>
                      {d.salary.lineEntries.rows.map((s, i) => (
                        <tr key={i} className="border-t">
                          <TD>{s.workDate ?? "—"}</TD>
                          <TD>{s.worker}</TD>
                          <TD>{s.role ?? "—"}</TD>
                          <TD right>{s.kg != null ? fmtKg(s.kg) : "—"}</TD>
                          <TD right>{s.rate != null ? fmtMoney(s.rate) : "—"}</TD>
                          <TD right>{fmtMoney(s.amount)}</TD>
                        </tr>
                      ))}
                    </tbody>
                  </Tbl>
                </div>
              </>
            )}

            <SubTitle>Yopilgan kunlar <SourceChip>daily_payroll_runs · line_id</SourceChip></SubTitle>
            {d.salary.payrollRuns.count === 0 ? (
              <NoData text="Ma'lumot mavjud emas — yopilgan kun yozuvi yo'q" />
            ) : (
              <Tbl>
                <thead className="bg-zinc-50 text-zinc-500">
                  <tr><TH>Sana</TH><TH right>Jami kg</TH><TH>Holat</TH><TH>Yopgan</TH><TH>Vaqt</TH></tr>
                </thead>
                <tbody>
                  {d.salary.payrollRuns.rows.map((r, i) => (
                    <tr key={i} className="border-t">
                      <TD>{r.workDate}</TD>
                      <TD right>{fmtKg(r.totalKg)}</TD>
                      <TD>{r.status ?? "—"}</TD>
                      <TD>{r.closedBy ?? "—"}</TD>
                      <TD>{fmtDT(r.closedAt)}</TD>
                    </tr>
                  ))}
                </tbody>
              </Tbl>
            )}

            <SubTitle>Ishchi to'lovlari <SourceChip>salary_payments · ishchi darajasida</SourceChip></SubTitle>
            <div className="mb-1.5 text-[11px] text-zinc-500">
              Bu to'lovlarda line_id yo'q — ular ishchiga tegishli, liniyaga taxminan taqsimlanmaydi.
            </div>
            {d.salary.workerPayments.count === 0 ? (
              <NoData text="Ma'lumot mavjud emas — bu liniya ishchilariga to'lov yozuvi yo'q" />
            ) : (
              <>
                <Row k="Jami to'langan" v={fmtMoney(d.salary.workerPayments.total)} />
                <Tbl>
                  <thead className="bg-zinc-50 text-zinc-500">
                    <tr><TH>Ishchi</TH><TH>Davr</TH><TH right>Summa</TH><TH>To'langan</TH></tr>
                  </thead>
                  <tbody>
                    {d.salary.workerPayments.rows.map((p, i) => (
                      <tr key={i} className="border-t">
                        <TD>{p.worker}</TD>
                        <TD mono>{p.year}-{String(p.month).padStart(2, "0")}</TD>
                        <TD right>{fmtMoney(p.amount)}</TD>
                        <TD>{fmtD(p.paidAt)}</TD>
                      </tr>
                    ))}
                  </tbody>
                </Tbl>
              </>
            )}
          </AccordionContent>
        </AccordionItem>

        {/* ── 4. WIP (§7) ─────────────────────────────────────────────────── */}
        <AccordionItem value="wip" data-testid="dept-sec-wip">
          <AccordionTrigger className="text-[13px]">
            WIP — ish jarayoni ({d.wip.rows})
          </AccordionTrigger>
          <AccordionContent>
            {d.wip.status === "NEGATIVE" && (
              <div className="mb-2 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-[12px] text-red-700" data-testid="dept-wip-negative">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <b>Negative WIP.</b> Balans manfiy: {fmtKg(d.wip.balanceKg)} kg. Kirim (RECEIVE) yozilmagan,
                  chiqim esa yozilgan. Bu real database holati — 0 ga aylantirilmagan, yashirilmagan.
                </span>
              </div>
            )}
            {d.wip.status === "NO_LEDGER" ? (
              <NoData text="WIP ledger yozuvi yo'q (wip_movements: 0 ta)" />
            ) : (
              <>
                <Row k="Balans" v={`${fmtKg(d.wip.balanceKg)} kg`} warn={neg} />
                <Row k="Kirim (RECEIVE)" v={d.wip.receiveKg > 0 ? `${fmtKg(d.wip.receiveKg)} kg` : "0 kg — yozuv yo'q"} warn={d.wip.receiveKg <= 0} />
                <Row k="Chiqim (PRODUCE)" v={`${fmtKg(d.wip.produceKg)} kg`} />
                <Row k="Davr" v={`${fmtDT(d.wip.first)} → ${fmtDT(d.wip.last)}`} />
                <SubTitle>Harakatlar <SourceChip>wip_movements</SourceChip></SubTitle>
                <Tbl>
                  <thead className="bg-zinc-50 text-zinc-500">
                    <tr><TH>Vaqt</TH><TH>Turi</TH><TH>Mahsulot / xomashyo</TH><TH right>Kg</TH><TH>Kim</TH></tr>
                  </thead>
                  <tbody>
                    {d.wip.movements.map((m) => (
                      <tr key={m.id} className="border-t" title={m.note ?? undefined}>
                        <TD mono>{fmtDT(m.at)}</TD>
                        <TD>
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            m.type === "PRODUCE" ? "bg-emerald-100 text-emerald-800" : "bg-sky-100 text-sky-800"
                          }`}>{m.type}</span>
                        </TD>
                        <TD>
                          {m.product ?? m.rawMaterial ?? "—"}
                          {m.fromName && <span className="text-[10px] text-zinc-400"> ← {m.fromName}</span>}
                        </TD>
                        <TD right>{fmtKg(m.kg)}</TD>
                        <TD>{m.by ?? "—"}</TD>
                      </tr>
                    ))}
                  </tbody>
                </Tbl>
                {d.wip.movementsTotal > d.wip.movements.length && (
                  <div className="mt-1 text-[11px] text-zinc-400">
                    Oxirgi {d.wip.movements.length} ta ko'rsatildi (jami {d.wip.movementsTotal}).
                  </div>
                )}
              </>
            )}
          </AccordionContent>
        </AccordionItem>

        {/* ── 5. Inputs (§8) ──────────────────────────────────────────────── */}
        <AccordionItem value="inputs" data-testid="dept-sec-inputs">
          <AccordionTrigger className="text-[13px]">Kirim / xomashyo ({d.inputs.receiveRows})</AccordionTrigger>
          <AccordionContent>
            {d.inputs.receives.length === 0 ? (
              <>
                <NoData text="RECEIVE ma'lumotlari mavjud emas" />
                <div className="mt-1.5 text-[11px] text-zinc-500">
                  Konteyner → bo'lim kirimi hech qachon ro'yxatga olinmagan. Soxta bog'lanish chizilmaydi;
                  kirim yozila boshlagach bu bo'lim avtomatik to'ladi.
                </div>
              </>
            ) : (
              <Tbl>
                <thead className="bg-zinc-50 text-zinc-500">
                  <tr><TH>Manba</TH><TH right>Kg</TH><TH right>Yozuv</TH><TH>Davr</TH></tr>
                </thead>
                <tbody>
                  {d.inputs.receives.map((r, i) => (
                    <tr key={i} className="border-t">
                      <TD>{r.fromName ?? (r.fromWid != null ? `#${r.fromWid}` : "manba ko'rsatilmagan")}</TD>
                      <TD right>{fmtKg(r.kg)}</TD>
                      <TD right>{r.rows}</TD>
                      <TD>{fmtD(r.first)} → {fmtD(r.last)}</TD>
                    </tr>
                  ))}
                </tbody>
              </Tbl>
            )}
            {d.inputs.bom.length > 0 && (
              <>
                <SubTitle>Retsept bo'yicha kutiladigan materiallar <SourceChip>product_materials (BOM)</SourceChip></SubTitle>
                <div className="mb-1 text-[11px] text-zinc-500">Bu real kirim oqimi emas — retsept (BOM) ma'lumoti.</div>
                <Tbl>
                  <thead className="bg-zinc-50 text-zinc-500">
                    <tr><TH>Material</TH><TH>Mahsulot</TH><TH right>Birlikka</TH><TH right>Zaxira</TH></tr>
                  </thead>
                  <tbody>
                    {d.inputs.bom.map((b, i) => (
                      <tr key={i} className="border-t">
                        <TD>{b.material}</TD>
                        <TD>{b.product}</TD>
                        <TD right>{b.perUnit}</TD>
                        <TD right>{b.stock != null ? fmtKg(b.stock) : "—"}</TD>
                      </tr>
                    ))}
                  </tbody>
                </Tbl>
              </>
            )}
          </AccordionContent>
        </AccordionItem>

        {/* ── 6. Production Outputs (§9) ──────────────────────────────────── */}
        <AccordionItem value="outputs" data-testid="dept-sec-outputs">
          <AccordionTrigger className="text-[13px]">
            Ishlab chiqarish chiqimi ({d.outputs.produce.length + d.outputs.batchesTotal})
          </AccordionTrigger>
          <AccordionContent>
            <SubTitle>WIP chiqimi <SourceChip>wip_movements · PRODUCE</SourceChip></SubTitle>
            {d.outputs.produce.length === 0 ? (
              <NoData text="PRODUCE yozuvi yo'q" />
            ) : (
              d.outputs.produce.map((p, i) => (
                <Row key={i} k={p.product} v={`${fmtKg(p.kg)} kg · ${p.n} yozuv (${p.first} → ${p.last})`} />
              ))
            )}
            <SubTitle>Partiyalar <SourceChip>batches · production_line_id</SourceChip></SubTitle>
            {d.outputs.batchesTotal === 0 ? (
              <NoData text="Bu liniyaga biriktirilgan partiya yo'q" />
            ) : (
              <>
                {d.outputs.batchesByProduct.map((b, i) => (
                  <Row key={i} k={b.product} v={`${fmtKg(b.kg)} kg / ${fmtInt(b.dona)} dona · ${b.n} partiya${b.archivedN ? ` (${b.archivedN} arxiv)` : ""}`} />
                ))}
                <div className="mt-1.5">
                  <Tbl>
                    <thead className="bg-zinc-50 text-zinc-500">
                      <tr><TH>Kod</TH><TH>Ishchi</TH><TH>Mahsulot</TH><TH right>Dona</TH><TH right>Kg</TH><TH>Sana</TH></tr>
                    </thead>
                    <tbody>
                      {d.outputs.batchRows.map((b) => (
                        <tr key={b.id} className="border-t">
                          <TD mono>{b.code ?? "—"}</TD>
                          <TD>{b.worker ?? "—"}</TD>
                          <TD>{b.product}{b.archived && <span className="ml-1 text-[10px] text-zinc-400">(arxiv)</span>}</TD>
                          <TD right>{fmtInt(b.qty)}</TD>
                          <TD right>{fmtKg(b.kg)}</TD>
                          <TD>{fmtD(b.at)}</TD>
                        </tr>
                      ))}
                    </tbody>
                  </Tbl>
                </div>
                {d.outputs.batchesTotal > d.outputs.batchRows.length && (
                  <div className="mt-1 text-[11px] text-zinc-400">
                    Oxirgi {d.outputs.batchRows.length} ta ko'rsatildi (jami {d.outputs.batchesTotal}).
                  </div>
                )}
              </>
            )}
          </AccordionContent>
        </AccordionItem>

        {/* ── 7. Products (§10) ───────────────────────────────────────────── */}
        <AccordionItem value="products" data-testid="dept-sec-products">
          <AccordionTrigger className="text-[13px]">Mahsulotlar ({d.products.length})</AccordionTrigger>
          <AccordionContent>
            {d.products.length === 0 ? (
              <NoData text="Bu bo'lim bilan bog'langan mahsulot yo'q" />
            ) : (
              <div className="space-y-2">
                {d.products.map((p, i) => {
                  const ptype = p.placements.find((x) => x.ptype)?.ptype ?? null;
                  return (
                    <div key={i} className="rounded-lg border px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13px] font-semibold text-zinc-900">{p.name}</span>
                        {p.sku ? (
                          <Badge variant="outline" className="border-teal-300 bg-teal-50 font-mono text-[10px] text-teal-700">{p.sku}</Badge>
                        ) : (
                          <Badge variant="outline" className="bg-zinc-100 text-[10px] text-zinc-500">SKU biriktirilmagan</Badge>
                        )}
                        {ptype ? (
                          <span className={`rounded px-1.5 py-0.5 text-[10px] ${PTYPE_BADGE[ptype] ?? "bg-zinc-100 text-zinc-500"}`}>{ptype}</span>
                        ) : (
                          <span className="text-[10px] text-zinc-400">turi: ma'lumot mavjud emas</span>
                        )}
                      </div>
                      {p.producedKg > 0 && <Row k="WIP chiqim" v={`${fmtKg(p.producedKg)} kg · ${p.produceN} yozuv`} />}
                      {(p.batchKg > 0 || p.batchDona > 0) && (
                        <Row k="Partiyalar" v={`${fmtKg(p.batchKg)} kg / ${fmtInt(p.batchDona)} dona · ${p.batchN} ta`} />
                      )}
                      <div className="mt-1 text-[11px] text-zinc-500">
                        {p.placements.length === 0 ? (
                          <span className="text-zinc-400">Destination aniqlanmagan — inventarda mos yozuv yo'q</span>
                        ) : (
                          p.placements.map((pl, j) => (
                            <div key={j}>
                              → {pl.container}: {fmtKg(pl.kg)} kg / {fmtInt(pl.qty)} dona
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </AccordionContent>
        </AccordionItem>

        {/* ── 8. Destinations (§12) ───────────────────────────────────────── */}
        <AccordionItem value="destinations" data-testid="dept-sec-destinations">
          <AccordionTrigger className="text-[13px]">Destination'lar ({d.destinations.length})</AccordionTrigger>
          <AccordionContent>
            {d.destinations.length === 0 ? (
              <>
                <NoData text="Destination aniqlanmagan" />
                <div className="mt-1.5 text-[11px] text-zinc-500">
                  Bu bo'lim mahsulotlari inventarda hech qaysi konteyner bilan bog'lanmagan. Taxmin qilinmaydi.
                </div>
              </>
            ) : (
              <Tbl>
                <thead className="bg-zinc-50 text-zinc-500">
                  <tr><TH>Joylashuv</TH><TH>Turi</TH><TH right>Kg</TH><TH right>Dona</TH><TH right>Mahsulot</TH></tr>
                </thead>
                <tbody>
                  {d.destinations.map((x) => (
                    <tr key={x.wid} className="border-t">
                      <TD>{x.container}</TD>
                      <TD>{x.loc === "container" ? "Konteyner" : (x.loc ?? "—")}</TD>
                      <TD right>{fmtKg(x.kg)}</TD>
                      <TD right>{fmtInt(x.dona)}</TD>
                      <TD right>{x.products}</TD>
                    </tr>
                  ))}
                </tbody>
              </Tbl>
            )}
            <div className="mt-1.5 text-[11px] text-zinc-400">
              Bog'lanish asosi: inventory · product nomi (norm) — item_id bo'sh bo'lgani uchun ehtiyotkor text-bog'lanish.
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* ── 9. Data Quality / Warnings (§15) ────────────────────────────── */}
        <AccordionItem value="quality" data-testid="dept-sec-quality">
          <AccordionTrigger className="text-[13px]">Data Quality / Ogohlantirishlar ({d.warnings.length})</AccordionTrigger>
          <AccordionContent>
            {d.warnings.length === 0 ? (
              <NoData text="Bu bo'lim uchun ogohlantirish yo'q" />
            ) : (
              <div className="space-y-2">
                {d.warnings.map((w) => (
                  <div
                    key={w.code}
                    className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[12px] ${
                      w.code === "NEGATIVE_WIP"
                        ? "border-red-300 bg-red-50 text-red-700"
                        : "border-amber-300 bg-amber-50 text-amber-800"
                    }`}
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      <span className="font-mono text-[10px]">{w.code}</span> — <b>{w.title}</b>
                      <br />
                      {w.detail}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <SubTitle>item_id bog'lari (shu liniya)</SubTitle>
            <Row k="wip_movements" v={d.meta.itemLinks.wip} />
            <Row k="batches" v={d.meta.itemLinks.batches} />
            <p className="mt-2 text-[12px] leading-relaxed text-zinc-500">
              Qoida: mavjud bo'lmagan ma'lumot o'ylab topilmaydi. Bo'shliq — real holat va u yashirilmaydi.
              Tegishli yozuvlar bazada paydo bo'lgach, bu joylar avtomatik to'ladi.
            </p>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <div className="mt-3 pb-2 text-[10px] text-zinc-400">{d.source}</div>
    </div>
  );
}
