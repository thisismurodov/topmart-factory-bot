// =============================================================================
// R-B SQL GENERATOR (2026-08-17) — «R-B GO» uchun bitta-tranzaksiyali ijro SQL.
//
// MUHIM: bu skript BAZAGA ULANMAYDI — faqat muhrlangan hujjatlarni o'qiydi,
// dry-run'ning BARCHA nazoratlarini qayta bajaradi, natijani muhrlangan
// docs/r-b-mapping-preview-2026-08-17.md §3 jadvali bilan BAYT-AYNAN
// solishtiradi va faqat hammasi PASS bo'lsa SQL fayl yozadi.
// Ijro alohida qadam: psql "$RAILWAY_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/r-b-execution-2026-08-17.sql
//
// Egasining R-B GO shartlari (2026-08-17):
//   - faqat R-B mapping/registr yoziladi (2 YANGI jadval, boshqa hech narsa)
//   - 97 pozitsiya to'liq, qiymatlar sanoqdan AYNAN
//   - TM-000022 = 1 SKU, 2 lokatsiya satri
//   - 2 EXACT kandidat mapping QILINMAYDI (item_id=NULL)
//   - R-D boshlanmaydi, inventar/legacy/sotuvlar TEGILMAYDI
//   - counted_by = 'thisismurodov' (egasi tasdig'i 2026-08-17)
//   - birorta tekshiruv yiqilsa COMMIT YO'Q (butun txn ROLLBACK)
//
// P2.1 items pretsedenti bo'yicha jadvallar initializer/Drizzle'ga KIRMAYDI —
// faqat shu gated skript yaratadi (drift-xarita TABLES ro'yxatiga ham kirmaydi).
// Rollback (taklif §13): DROP TABLE physical_baseline_positions, physical_baselines.
// CREATE TABLE tranzaksiya ichida — ROLLBACK bo'lsa sequence qoldig'i ham qolmaydi.
// =============================================================================
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PREVIEW = path.join(ROOT, "docs/r-c-final-preview-2026-08-17.md");
const RECON = path.join(ROOT, "docs/physical-count-reconciliation-2026-08-15.md");
const C15DOC = path.join(ROOT, "docs/physical-count-c15-2026-08-16.md");
const C1617DOC = path.join(ROOT, "docs/physical-count-c16-c17-2026-08-15.md");
const SEAL = path.join(ROOT, "docs/r-b-mapping-preview-2026-08-17.md");
const OUT = path.join(ROOT, "scripts/sql/r-b-execution-2026-08-17.sql");

const COUNTED_BY = "thisismurodov"; // egasi tasdig'i: «R-B COUNTED_BY CONFIRMED» (2026-08-17)
const CREATED_BY = "thisismurodov";

// Fail-safe: SQL fayl diskda faqat oxirgi ijro 100% PASS bo'lgandagina turadi.
rmSync(OUT, { force: true });

function fail(msg: string): never {
  console.error(`✗ GENERATOR FAIL: ${msg}`);
  process.exit(1);
}
const num = (s: string) => {
  const clean = s.replace(/\*\*/g, "").replace(/[\s\u00A0\u202F\u2009]/g, "");
  const v = Number(clean);
  if (!Number.isFinite(v)) fail(`son o'qilmadi: "${s}"`);
  return v;
};
const cents = (s: string) => Math.round(num(s) * 100);
const fmt2 = (c: number) => {
  const v = (c / 100).toFixed(2);
  const [i, d] = v.split(".");
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, " ")}.${d}`;
};
const esc = (s: string) => s.replace(/'/g, "''");
const sqlNum = (c: number) => (c / 100).toFixed(2); // cents -> '1234.56'
const sqlStr = (s: string | null) => (s === null ? "NULL" : `'${esc(s)}'`);

// ── 1. §4 (94 item) — R-C/dry-run generatoridagi AYNAN o'sha parsing ─────────
type ItemRow = { sku: string; name: string; unit: "kg" | "dona"; countCell: string; joy: string };
const pmd = readFileSync(PREVIEW, "utf8");
const rowRe = /^\| (TM-\d{6}) \| (.+?) \| (kg|dona) \| (.+?) \| (.+?) \|\s*$/;
const items: ItemRow[] = [];
for (const line of pmd.split("\n")) {
  const m = line.match(rowRe);
  if (m) items.push({ sku: m[1], name: m[2], unit: m[3] as "kg" | "dona", countCell: m[4], joy: m[5] });
}
if (items.length !== 94) fail(`§4: 94 item kutilgan, topildi ${items.length}`);
items.forEach((r, i) => {
  const expected = `TM-${String(i + 1).padStart(6, "0")}`;
  if (r.sku !== expected) fail(`§4 SKU tartibi: ${i}-indeksda ${r.sku} ≠ ${expected}`);
});

// noteFor — R-C generatoridan AYNAN nusxa (jonli items notlarini pin qilish uchun)
function noteFor(r: ItemRow): string {
  if (r.sku === "TM-000022") {
    return "Sanoq 2026-08-15 · C-19 168.6 kg + C-04 261.2 kg = 429.8 kg";
  }
  const date = r.joy === "C-15" ? "2026-08-16" : "2026-08-15";
  if (r.unit === "dona") {
    return `Sanoq ${date} · ${r.joy} · ${r.countCell.replace(" (", " dona (")}`;
  }
  return `Sanoq ${date} · ${r.joy} · ${r.countCell} kg`;
}

// ── 2. §5 (2 EXACT kandidat) ─────────────────────────────────────────────────
type ExactCand = { name: string; kgCents: number; joy: string; legacySku: string };
const s5 = pmd.slice(pmd.indexOf("## 5."), pmd.indexOf("## 6."));
const exactCands: ExactCand[] = [];
for (const line of s5.split("\n")) {
  const m = line.match(/^\| (.+?) \| ([\d\s.,\u00A0\u202F\u2009]+) \| (C-\d{2}) \| `(.+?)` \| (.+?) \|\s*$/);
  if (m && !m[1].startsWith("Fizik nom")) {
    exactCands.push({ name: m[1], kgCents: cents(m[2]), joy: m[3], legacySku: m[4] });
  }
}
if (exactCands.length !== 2) fail(`§5: 2 EXACT kandidat kutilgan, topildi ${exactCands.length}`);

// ── 3. Sanoq pozitsiyalari (97) — asl hujjatlardan (dry-run bilan aynan) ─────
type Pos = {
  container: string;
  idx: number; // joy-ichki № (sanoq varag'i)
  name: string;
  qtyStr: string;
  qtyCents: number; // kg pozitsiyada kg-cents; dona pozitsiyada dona*100
  unit: "kg" | "dona";
  kgCents: number;
  kgStr: string;
  legacyStatus: string;
  legacyCand: string;
  annot: string;
  date: string;
  detail: string;
  boxes: number | null; // karobka/qop soni (faqat dona)
  perBox: number | null; // 1 karobka/qopdagi dona (faqat dona)
  grams: number | null; // birlik og'irlik gramm (faqat dona)
};
const positions: Pos[] = [];

// 3a. Reconciliation (C-20, C-19, C-18, C-02, C-04, C-06) — faqat 3-bosqich
const rmd = readFileSync(RECON, "utf8");
const s3 = rmd.slice(rmd.indexOf("## 3-bosqich"), rmd.indexOf("## 4-bosqich"));
if (!s3) fail("recon: 3-bosqich bo'limi topilmadi");
let curC = "";
for (const line of s3.split("\n")) {
  const h = line.match(/^### (C-\d{2}) /);
  if (h) {
    curC = h[1];
    continue;
  }
  const m = line.match(
    /^\| (\d+) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \| (kg|dona) \| ([A-Z_]+) \| (.+?) \|\s*$/,
  );
  if (!m) continue;
  if (!curC) fail("recon: qator konteyner sarlavhasidan oldin");
  const rawName = m[2];
  if (rawName !== rawName.trim())
    fail(`recon ${curC} №${m[1]}: nom katagida bosh/oxir probel — bayt-aynanlik buzilgan: "${rawName}"`);
  let name = rawName;
  let annot = "";
  const am = rawName.match(/^(.+) \*\(metr: NULL\)\*$/);
  if (am) {
    name = am[1];
    annot = "metr: NULL";
    if (name !== name.trim()) fail(`recon ${curC} №${m[1]}: annotatsiya ajratilgach nomda probel qoldi: "${name}"`);
  } else if (rawName.includes("*(")) {
    fail(`recon ${curC} №${m[1]}: kutilmagan annotatsiya turi (faqat «metr: NULL» ruxsat etilgan): "${rawName}"`);
  }
  const legacyItem = m[3].trim();
  const legacySku = m[4].trim();
  const legacyCand =
    legacyItem === "—" ? "—" : `${legacyItem}${legacySku !== "—" ? " " + legacySku.replace(/`/g, "") : ""}`;
  positions.push({
    container: curC,
    idx: Number(m[1]),
    name,
    qtyStr: m[6].trim(),
    qtyCents: cents(m[6]),
    unit: m[8] as "kg" | "dona",
    kgCents: cents(m[6]),
    kgStr: m[6].trim(),
    legacyStatus: m[9],
    legacyCand,
    annot,
    date: "2026-08-15",
    detail: "",
    boxes: null,
    perBox: null,
    grams: null,
  });
}

// 3b. C-15 (3 pozitsiya, sanoq 2026-08-16)
const c15md = readFileSync(C15DOC, "utf8");
const c15s = c15md.slice(c15md.indexOf("## 1."), c15md.indexOf("## 2."));
for (const line of c15s.split("\n")) {
  const m = line.match(/^\| (\d+) \| (.+?) \| ([\d\s.,\u00A0\u202F\u2009]+) \|\s*$/);
  if (!m) continue;
  if (m[2] !== m[2].trim() || m[2].includes("*(")) fail(`C-15 №${m[1]}: nom bayt-aynan emas: "${m[2]}"`);
  positions.push({
    container: "C-15",
    idx: Number(m[1]),
    name: m[2],
    qtyStr: m[3].trim(),
    qtyCents: cents(m[3]),
    unit: "kg",
    kgCents: cents(m[3]),
    kgStr: m[3].trim(),
    legacyStatus: "—",
    legacyCand: "—",
    annot: "",
    date: "2026-08-16",
    detail: "",
    boxes: null,
    perBox: null,
    grams: null,
  });
}

// 3c. C-16 (3) va C-17 (9) — dona pozitsiyalar, kg = hisobiy ekvivalent
const c1617md = readFileSync(C1617DOC, "utf8");
function parseDonaSection(md: string, from: string, to: string, container: string, boxWord: string) {
  const s = md.slice(md.indexOf(from), md.indexOf(to));
  if (!s) fail(`${container}: bo'lim topilmadi`);
  for (const line of s.split("\n")) {
    const m = line.match(
      /^\| (\d+) \| (.+?) \| ([\d\s\u00A0\u202F\u2009]+) \| ([\d\s\u00A0\u202F\u2009]+) \| ([\d\s\u00A0\u202F\u2009]+) \| ([\d\s\u00A0\u202F\u2009]+) \| ([\d\s.,\u00A0\u202F\u2009]+) \|\s*$/,
    );
    if (!m) continue;
    if (m[2] !== m[2].trim() || m[2].includes("*(")) fail(`${container} №${m[1]}: nom bayt-aynan emas: "${m[2]}"`);
    const boxes = num(m[3]);
    const perBox = num(m[4]);
    const grams = num(m[5]);
    const dona = num(m[6]);
    if (boxes * perBox !== dona) fail(`${container} «${m[2].trim()}»: ${boxes}×${perBox} ≠ ${dona}`);
    if (Math.round(dona * grams) !== Math.round(num(m[7]) * 1000))
      fail(`${container} «${m[2].trim()}»: dona×gramm ≠ kg (${dona}×${grams}g ≠ ${m[7]})`);
    positions.push({
      container,
      idx: Number(m[1]),
      name: m[2],
      qtyStr: m[6].trim(),
      qtyCents: Math.round(dona * 100),
      unit: "dona",
      kgCents: cents(m[7]),
      kgStr: m[7].trim(),
      legacyStatus: "—",
      legacyCand: "—",
      annot: "",
      date: "2026-08-15",
      detail: `${m[3].trim()} ${boxWord} × ${m[4].trim()} dona × ${m[5].trim()} g`,
      boxes,
      perBox,
      grams,
    });
  }
}
parseDonaSection(c1617md, "## 1. C-16", "## 2. C-17", "C-16", "karobka");
parseDonaSection(c1617md, "## 2. C-17", "Oraliq yig'indilar", "C-17", "qop");

// ── 4. Pozitsiya nazoratlari (dry-run bilan aynan) ───────────────────────────
const CONTAINERS = ["C-20", "C-19", "C-18", "C-02", "C-04", "C-06", "C-16", "C-17", "C-15"];
const EXPECTED_POS: Record<string, number> = {
  "C-20": 10, "C-19": 13, "C-18": 29, "C-02": 10, "C-04": 7, "C-06": 13, "C-16": 3, "C-17": 9, "C-15": 3,
};
const EXPECTED_KG: Record<string, number> = {
  "C-20": 1013645, "C-19": 871330, "C-18": 983945, "C-02": 605300, "C-04": 636330,
  "C-06": 743550, "C-16": 704520, "C-17": 325600, "C-15": 1302000,
};
// warehouses jadvalidagi tasdiqlangan ID'lar (taklif §4 + jonli tekshiruv 2026-08-17:
// name ustuni aynan konteyner yorlig'i)
const WAREHOUSE_ID: Record<string, number> = {
  "C-20": 26, "C-19": 25, "C-18": 24, "C-02": 8, "C-04": 10, "C-06": 12, "C-16": 22, "C-17": 23, "C-15": 21,
};
const COUNT_DATE: Record<string, string> = Object.fromEntries(
  CONTAINERS.map((c) => [c, c === "C-15" ? "2026-08-16" : "2026-08-15"]),
);
const SOURCE_DOC: Record<string, string> = Object.fromEntries(
  CONTAINERS.map((c) => [
    c,
    c === "C-15"
      ? "docs/physical-count-c15-2026-08-16.md"
      : c === "C-16" || c === "C-17"
        ? "docs/physical-count-c16-c17-2026-08-15.md"
        : "docs/physical-count-reconciliation-2026-08-15.md (3-bosqich)",
  ]),
);

if (positions.length !== 97) fail(`pozitsiyalar: 97 kutilgan, topildi ${positions.length}`);
for (const c of CONTAINERS) {
  const ps = positions.filter((p) => p.container === c);
  if (ps.length !== EXPECTED_POS[c]) fail(`${c}: ${EXPECTED_POS[c]} pozitsiya kutilgan, topildi ${ps.length}`);
  const sum = ps.reduce((a, p) => a + p.kgCents, 0);
  if (sum !== EXPECTED_KG[c]) fail(`${c} kg jami: ${fmt2(sum)} ≠ ${fmt2(EXPECTED_KG[c])}`);
}
const grand = positions.reduce((a, p) => a + p.kgCents, 0);
if (grand !== 7186220) fail(`97 pozitsiya jami ${fmt2(grand)} ≠ 71 862.20`);
const possibleCount = positions.filter((p) => p.legacyStatus === "POSSIBLE_MATCH").length;
if (possibleCount !== 15) fail(`legacy POSSIBLE_MATCH ${possibleCount} ≠ 15`);

const EXPECTED_METR = ["C-20:10", "C-18:11", "C-18:12", "C-18:23", "C-06:2", "C-06:3"];
const metrPos = positions.filter((p) => p.annot === "metr: NULL");
const metrKeys = metrPos.map((p) => `${p.container}:${p.idx}`).sort();
if (JSON.stringify(metrKeys) !== JSON.stringify([...EXPECTED_METR].sort()))
  fail(`metr-NULL annotatsiyalar kutilgan 6 joyga mos emas: [${metrKeys.join(", ")}]`);

const excluded = positions.filter((p) => p.legacyStatus === "EXACT_MATCH");
if (excluded.length !== 2) fail(`EXACT_MATCH pozitsiyalar ${excluded.length} ≠ 2`);
for (const cand of exactCands) {
  const p = excluded.find((x) => x.name === cand.name && x.container === cand.joy);
  if (!p) fail(`§5 kandidat «${cand.name}» (${cand.joy}) recon'da EXACT sifatida topilmadi`);
  if (p.kgCents !== cand.kgCents) fail(`«${cand.name}» kg: recon ${fmt2(p.kgCents)} ≠ §5 ${fmt2(cand.kgCents)}`);
}
const exclKg = excluded.reduce((a, p) => a + p.kgCents, 0);
if (exclKg !== 120755) fail(`EXACT jami ${fmt2(exclKg)} ≠ 1 207.55`);

// ── 5. Item-lokatsiyalar (95) va bijeksiya (dry-run bilan aynan) ─────────────
type ItemLoc = { item: ItemRow; container: string; qtyCents: number; kgCents: number };
const itemLocs: ItemLoc[] = [];
for (const r of items) {
  if (r.joy.includes("+")) {
    if (r.sku !== "TM-000022") fail(`kutilmagan ko'p-joyli item: ${r.sku}`);
    const m = r.countCell.match(
      /^\*\*([\d.,\s\u00A0\u202F\u2009]+)\*\* = ([\d.,\s\u00A0\u202F\u2009]+) \((C-\d{2})\) \+ ([\d.,\s\u00A0\u202F\u2009]+) \((C-\d{2})\)$/,
    );
    if (!m) fail(`TM-000022 katak formati: "${r.countCell}"`);
    const total = cents(m[1]);
    const q1 = cents(m[2]);
    const q2 = cents(m[4]);
    if (q1 + q2 !== total) fail(`TM-000022: ${fmt2(q1)}+${fmt2(q2)} ≠ ${fmt2(total)}`);
    const joyParts = r.joy.split(" + ").map((s) => s.trim());
    if (joyParts[0] !== m[3] || joyParts[1] !== m[5]) fail(`TM-000022 joy ≠ katak joylari`);
    itemLocs.push({ item: r, container: m[3], qtyCents: q1, kgCents: q1 });
    itemLocs.push({ item: r, container: m[5], qtyCents: q2, kgCents: q2 });
  } else if (r.unit === "dona") {
    const m = r.countCell.match(/^([\d\s\u00A0\u202F\u2009]+) \(([\d\s\u00A0\u202F\u2009.,]+) kg\)$/);
    if (!m) fail(`dona katak formati: "${r.countCell}" (${r.sku})`);
    itemLocs.push({ item: r, container: r.joy, qtyCents: Math.round(num(m[1]) * 100), kgCents: cents(m[2]) });
  } else {
    itemLocs.push({ item: r, container: r.joy, qtyCents: cents(r.countCell), kgCents: cents(r.countCell) });
  }
}
if (itemLocs.length !== 95) fail(`item-lokatsiyalar ${itemLocs.length} ≠ 95`);

const mappable = positions.filter((p) => p.legacyStatus !== "EXACT_MATCH");
if (mappable.length !== 95) fail(`mapping'ga kiruvchi pozitsiyalar ${mappable.length} ≠ 95`);
const posByKey = new Map<string, Pos>();
for (const p of mappable) {
  const key = `${p.container}::${p.name}`;
  if (posByKey.has(key)) fail(`takror pozitsiya kaliti: ${key}`);
  posByKey.set(key, p);
}
const consumed = new Set<string>();
const posToSku = new Map<Pos, ItemRow>();
for (const il of itemLocs) {
  const key = `${il.container}::${il.item.name}`;
  const p = posByKey.get(key);
  if (!p) fail(`item ${il.item.sku} «${il.item.name}» (${il.container}) uchun sanoq pozitsiyasi topilmadi`);
  if (consumed.has(key)) fail(`pozitsiya ikki marta ishlatildi: ${key}`);
  consumed.add(key);
  posToSku.set(p, il.item);
  if (p.unit !== il.item.unit) fail(`${il.item.sku} birlik: sanoq ${p.unit} ≠ item ${il.item.unit}`);
  if (p.qtyCents !== il.qtyCents)
    fail(`${il.item.sku} (${il.container}) miqdor: sanoq ${p.qtyCents / 100} ≠ item ${il.qtyCents / 100}`);
  if (p.kgCents !== il.kgCents) fail(`${il.item.sku} (${il.container}) kg: ${fmt2(p.kgCents)} ≠ ${fmt2(il.kgCents)}`);
}
if (consumed.size !== 95) fail(`iste'mol qilingan pozitsiyalar ${consumed.size} ≠ 95`);
const skusMapped = new Set(itemLocs.map((il) => il.item.sku));
if (skusMapped.size !== 94) fail(`mapping'dagi SKU soni ${skusMapped.size} ≠ 94`);

const kgDirect = itemLocs.filter((il) => il.item.unit === "kg").reduce((a, il) => a + il.kgCents, 0);
if (kgDirect !== 6035345) fail(`kg-itemlar jami ${fmt2(kgDirect)} ≠ 60 353.45`);
const donaTotal = itemLocs.filter((il) => il.item.unit === "dona").reduce((a, il) => a + il.qtyCents, 0);
if (donaTotal !== 12636000) fail(`dona jami ${donaTotal / 100} ≠ 126 360`);
const donaKg = itemLocs.filter((il) => il.item.unit === "dona").reduce((a, il) => a + il.kgCents, 0);
if (donaKg !== 1030120) fail(`dona kg-ekvivalent ${fmt2(donaKg)} ≠ 10 301.20`);
if (kgDirect + donaKg !== 7065465) fail(`mapped massa ≠ 70 654.65`);
if (kgDirect + donaKg + exclKg !== 7186220) fail(`umumiy nazorat ≠ 71 862.20`);

// ── 6. MUHR TEKSHIRUVI: muhrlangan preview §3 jadvali bilan bayt-aynan ───────
// Dry-run'dagi AYNAN o'sha satr-qurish mantig'i — natija muhrlangan fayldagi
// 97 satr bilan bayt-aynan tenglashtiriladi. Farq bo'lsa — manba hujjatlar
// GO'dan keyin o'zgargan degani → STOP.
let n = 0;
const rebuiltRows: string[] = [];
for (const c of CONTAINERS) {
  for (const p of positions.filter((x) => x.container === c)) {
    n++;
    const item = posToSku.get(p);
    const izoh: string[] = [];
    if (p.legacyStatus === "EXACT_MATCH") {
      const ec = exactCands.find((x) => x.name === p.name && x.joy === p.container)!;
      izoh.push(`egasi qarori №1: avto-mapping YO'Q — alohida kandidat (legacy ${ec.legacySku} bilan aynan mos)`);
    }
    if (p.legacyStatus === "POSSIBLE_MATCH") izoh.push(`legacy nomzod: ${p.legacyCand} (faqat ma'lumot — R-B'da ishlatilmaydi)`);
    if (p.annot) izoh.push(p.annot);
    if (p.detail) izoh.push(p.detail);
    if (p.date === "2026-08-16") izoh.push("sanoq 2026-08-16");
    if (item?.sku === "TM-000022") izoh.push(`ikkinchi joy: ${item.joy.replace(p.container, "").replace(" + ", "") || ""}`.trim());
    const turi = !item
      ? "**CHIQARILGAN** (EXACT kandidat)"
      : item.sku === "TM-000022"
        ? "AYNAN · 2-JOYLI"
        : "AYNAN 1:1";
    rebuiltRows.push(
      `| ${n} | ${p.container} | ${p.name} | ${p.qtyStr} | ${p.unit} | ${p.unit === "dona" ? p.kgStr + " (hisobiy)" : p.kgStr} | ${item ? item.sku : "—"} | ${item ? item.name : "—"} | ${turi} | ${izoh.join(" · ") || "—"} |`,
    );
  }
}
const sealMd = readFileSync(SEAL, "utf8");
const sealRows = sealMd.split("\n").filter((l) => /^\| \d+ \| C-\d{2} \| /.test(l));
if (sealRows.length !== 97) fail(`muhrlangan preview'da 97 jadval satri kutilgan, topildi ${sealRows.length}`);
for (let i = 0; i < 97; i++) {
  if (sealRows[i] !== rebuiltRows[i])
    fail(`MUHR BUZILGAN — §3 satr ${i + 1} mos emas:\n  muhr:  ${sealRows[i]}\n  qayta: ${rebuiltRows[i]}`);
}

// Global pozitsiya tartibi (position_no 1..97) = muhrlangan §3 tartibi
const ordered: Pos[] = [];
for (const c of CONTAINERS) for (const p of positions.filter((x) => x.container === c)) ordered.push(p);

// ── 7. SQL qatorlarini qurish ────────────────────────────────────────────────
type PosSql = {
  container: string;
  positionNo: number;
  containerPos: number;
  name: string;
  quantity: string; // numeric literal
  unit: string;
  boxes: string; // literal yoki NULL
  perBox: string;
  unitWeightG: string;
  weightKg: string;
  itemSku: string | null;
  mappingStatus: string;
  note: string | null;
};
const posSql: PosSql[] = ordered.map((p, i) => {
  const item = posToSku.get(p) ?? null;
  let note: string | null = null;
  if (p.legacyStatus === "EXACT_MATCH") {
    const ec = exactCands.find((x) => x.name === p.name && x.joy === p.container)!;
    note = `EXACT kandidat (egasi qarori №1 ochiq): avto-mapping YO'Q; legacy SKU ${ec.legacySku} bilan aynan mos`;
  } else if (item?.sku === "TM-000022") {
    const other = p.container === "C-19" ? "C-04 (261.2 kg)" : "C-19 (168.6 kg)";
    note = `AYNAN · 2-JOYLI: ikkinchi joy ${other}; jami 429.8 kg`;
  } else if (p.annot === "metr: NULL") {
    note = `metr: NULL — «N metr» nom tarkibida, fizik metr sanog'i berilmagan`;
  }
  return {
    container: p.container,
    positionNo: i + 1,
    containerPos: p.idx,
    name: p.name,
    quantity: sqlNum(p.qtyCents),
    unit: p.unit,
    boxes: p.boxes === null ? "NULL" : String(p.boxes),
    perBox: p.perBox === null ? "NULL" : String(p.perBox),
    unitWeightG: p.grams === null ? "NULL" : String(p.grams),
    weightKg: sqlNum(p.kgCents),
    itemSku: item ? item.sku : null,
    mappingStatus: item ? "MAPPED" : "EXCLUDED_EXACT_CANDIDATE",
    note,
  };
});
if (posSql.filter((r) => r.itemSku !== null).length !== 95) fail("posSql: mapped 95 emas");
if (posSql.filter((r) => r.itemSku === null).length !== 2) fail("posSql: excluded 2 emas");

const SEAL_REF = "docs/r-b-mapping-preview-2026-08-17.md";
function baselineNote(c: string): string {
  const base = `Mapping muhri: ${SEAL_REF}`;
  if (c === "C-18")
    return `29 pozitsiyadan 28 tasi mapping'da; «Rossiya Tros» (531 kg) — EXACT kandidat, item_id=NULL (egasi qarori №1). ${base}`;
  if (c === "C-02")
    return `10 pozitsiyadan 9 tasi mapping'da; «Shroki 3.5 Oq» (676.55 kg) — EXACT kandidat, item_id=NULL (egasi qarori №1). ${base}`;
  if (c === "C-17")
    return `Qop jami 279 — egasi tasdig'i 2026-08-16 (manba fayldagi «259» yozuv xatosi). ${base}`;
  if (c === "C-15")
    return `Kuzatuv: joy maqsadi 'finished', tarkib xomashyo (CF filament) — §16 №3 ochiq savol. ${base}`;
  return base;
}

const blValues = CONTAINERS.map((c) => {
  return `  ('${c}', ${WAREHOUSE_ID[c]}, '${COUNT_DATE[c]}', '${esc(SOURCE_DOC[c])}', '${COUNTED_BY}', ${EXPECTED_POS[c]}, ${sqlNum(EXPECTED_KG[c])}, 'MAPPED', '${esc(baselineNote(c))}', '${CREATED_BY}')`;
}).join(",\n");

const posValues = posSql
  .map(
    (r) =>
      `  ('${r.container}', ${r.positionNo}, ${r.containerPos}, '${esc(r.name)}', ${r.quantity}, '${r.unit}', ${r.boxes}, ${r.perBox}, ${r.unitWeightG}, ${r.weightKg}, ${sqlStr(r.itemSku)}, '${r.mappingStatus}', ${sqlStr(r.note)})`,
  )
  .join(",\n");

const itemsExpectedValues = items
  .map((r) => `  ('${r.sku}', '${esc(r.name)}', '${r.unit}', '${esc(noteFor(r))}')`)
  .join(",\n");

const whChecks = CONTAINERS.map(
  (c) =>
    `  IF NOT EXISTS (SELECT 1 FROM warehouses WHERE id=${WAREHOUSE_ID[c]} AND name='${c}' AND active) THEN\n    RAISE EXCEPTION 'PRE-GATE: warehouses id=${WAREHOUSE_ID[c]} nomi ''${c}'' emas yoki aktiv emas'; END IF;`,
).join("\n");

// ── 8. SQL fayl ──────────────────────────────────────────────────────────────
const sql = `-- =============================================================================
-- R-B IJRO SKRIPTI (2026-08-17) — «R-B GO» egasi ruxsati bilan, BIR MARTA.
-- Manba (muhr): ${SEAL_REF} (§3 jadval, 97 satr)
-- Generator: scripts/src/r-b-generate-sql.ts (qo'lda tahrir QILINMASIN) —
--   dry-run'ning barcha nazoratlarini qayta bajaradi va §3 bilan bayt-aynan
--   solishtiradi; birorta farq bo'lsa bu fayl umuman yaratilmaydi.
-- Ijro: psql "$RAILWAY_DATABASE_URL" -v ON_ERROR_STOP=1 -f <shu fayl>
-- Birorta tekshiruv yiqilsa — butun tranzaksiya ROLLBACK, bazada iz qolmaydi
-- (CREATE TABLE ham tranzaksiya ichida: ROLLBACK'da sequence qoldig'i qolmaydi).
--
-- Egasining R-B GO chegaralari:
--   * faqat 2 YANGI jadval yoziladi: physical_baselines (9) + physical_baseline_positions (97)
--   * items/inventory/stock_movements/legacy/sales'ga 0 yozuv (9.9 isbotlaydi)
--   * 2 EXACT kandidat item_id=NULL (mapping YO'Q) · TM-000022 = 2 lokatsiya satri
--   * R-D BOSHLANMAYDI (BASELINE harakatlar 0 — 9.9 tekshiradi)
-- Rollback (taklif §13): DROP TABLE physical_baseline_positions, physical_baselines;
--   satr-darajali o'chirish/o'zgartirish trigger bilan muzlatilgan.
-- =============================================================================
\\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
-- R-B o'qiydigan/bog'lanadigan mavjud jadvallar barqarorligi uchun yozishni
-- bloklaymiz (o'qish ochiq qoladi — zavod ishlayveradi; biznes jadvallari
-- qulflanmaydi). warehouses ham SHART (arxitektor topilmasi 2026-08-17):
-- registr container_label ↔ warehouse_id bog'lanishini MUZLATIB yozadi —
-- parallel rename/deaktivatsiya pre-gate'dan keyin COMMIT bo'lsa, registr
-- noto'g'ri joyga qotib qolardi. Qulflar birinchi SELECT'dan (snapshot'dan)
-- OLDIN olinadi — hech qanday parallel yozuv oralikka sig'masligi kafolatlanadi.
LOCK TABLE items IN SHARE MODE;
LOCK TABLE item_aliases IN SHARE MODE;
LOCK TABLE warehouses IN SHARE MODE;

-- ── 0. PRE-GATE ──────────────────────────────────────────────────────────────
DO $pre$
DECLARE v bigint; t text;
BEGIN
  -- yangi jadvallar hali YO'Q bo'lishi shart (takroriy ijro bloklanadi)
  IF to_regclass('public.physical_baselines') IS NOT NULL THEN
    RAISE EXCEPTION 'PRE-GATE: physical_baselines allaqachon mavjud — takroriy ijro taqiqlangan';
  END IF;
  IF to_regclass('public.physical_baseline_positions') IS NOT NULL THEN
    RAISE EXCEPTION 'PRE-GATE: physical_baseline_positions allaqachon mavjud — takroriy ijro taqiqlangan';
  END IF;
  -- items R-C holatida ekani
  SELECT COUNT(*) INTO v FROM items;
  IF v <> 94 THEN RAISE EXCEPTION 'PRE-GATE: items=% (94 kutilgan)', v; END IF;
  SELECT COUNT(DISTINCT sku) INTO v FROM items;
  IF v <> 94 THEN RAISE EXCEPTION 'PRE-GATE: DISTINCT sku=%', v; END IF;
  SELECT MIN(sku) INTO t FROM items; IF t <> 'TM-000001' THEN RAISE EXCEPTION 'PRE-GATE: MIN(sku)=%', t; END IF;
  SELECT MAX(sku) INTO t FROM items; IF t <> 'TM-000094' THEN RAISE EXCEPTION 'PRE-GATE: MAX(sku)=%', t; END IF;
  SELECT MIN(id) INTO v FROM items; IF v <> 2 THEN RAISE EXCEPTION 'PRE-GATE: MIN(items.id)=% (2 kutilgan)', v; END IF;
  SELECT MAX(id) INTO v FROM items; IF v <> 95 THEN RAISE EXCEPTION 'PRE-GATE: MAX(items.id)=% (95 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v FROM item_aliases;
  IF v <> 0 THEN RAISE EXCEPTION 'PRE-GATE: item_aliases=% (0 kutilgan)', v; END IF;
  -- 9 konteyner warehouses'da aynan kutilgan (id, nom) juftligida
${whChecks}
END $pre$;

-- ── 0b. Jonli items ≡ muhrlangan §4 (bayt-aynan, yozishdan OLDIN) ────────────
CREATE TEMP TABLE rb_items_expected (
  sku text PRIMARY KEY, display_name text NOT NULL, unit text NOT NULL, note text NOT NULL
) ON COMMIT DROP;
INSERT INTO rb_items_expected (sku, display_name, unit, note) VALUES
${itemsExpectedValues};
DO $items$
DECLARE v bigint;
BEGIN
  SELECT COUNT(*) INTO v FROM rb_items_expected;
  IF v <> 94 THEN RAISE EXCEPTION '0b: rb_items_expected=% (94 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v
    FROM rb_items_expected e FULL JOIN items i ON i.sku = e.sku
   WHERE i.sku IS NULL OR e.sku IS NULL
      OR i.display_name IS DISTINCT FROM e.display_name
      OR i.unit IS DISTINCT FROM e.unit
      OR i.note IS DISTINCT FROM e.note
      OR i.source_kind IS DISTINCT FROM 'physical_count'
      OR i.created_by IS DISTINCT FROM '${CREATED_BY}';
  IF v <> 0 THEN RAISE EXCEPTION '0b: jonli items muhrlangan §4 bilan mos emas (% satr)', v; END IF;
END $items$;

-- tranzaksiya-ichki «oldin» surati (9.9 uchun): son + qiymat yig'indilari
CREATE TEMP TABLE rb_pre ON COMMIT DROP AS SELECT
  (SELECT COUNT(*) FROM sales)                                    AS sales_n,
  (SELECT COUNT(*) FROM sale_items)                               AS sale_items_n,
  (SELECT COALESCE(SUM(quantity),0) FROM sale_items)              AS sale_items_qty,
  (SELECT COUNT(*) FROM stock_movements)                          AS sm_n,
  (SELECT COALESCE(SUM(quantity),0) FROM stock_movements)         AS sm_qty,
  (SELECT COUNT(*) FROM inventory)                                AS inv_n,
  (SELECT COALESCE(SUM(quantity),0) FROM inventory)               AS inv_qty,
  (SELECT COALESCE(SUM(weight_kg),0) FROM inventory)              AS inv_kg,
  (SELECT COUNT(*) FROM products)                                 AS products_n,
  (SELECT COUNT(*) FROM raw_materials)                            AS rm_n,
  (SELECT COALESCE(SUM(current_stock),0) FROM raw_materials)      AS rm_stock,
  (SELECT COUNT(*) FROM batches)                                  AS batches_n,
  (SELECT COUNT(*) FROM wip_movements)                            AS wip_n,
  (SELECT COUNT(*) FROM items)                                    AS items_n,
  (SELECT COUNT(*) FROM item_aliases)                             AS aliases_n,
  (SELECT COUNT(*) FROM legacy.inventory_baseline_pre)            AS lg_inv_n,
  (SELECT COUNT(*) FROM legacy.raw_material_stock_pre)            AS lg_rm_n,
  (SELECT COUNT(*) FROM legacy.wip_balances_pre)                  AS lg_wip_n,
  (SELECT COUNT(*) FROM legacy.container_summary_pre)             AS lg_cont_n,
  (SELECT COUNT(*) FROM stock_movements WHERE movement_type='BASELINE') AS sm_baseline_n;

-- ── 1. DDL: sanoq registri (R-B'ning YAGONA yozuv obyektlari) ────────────────
CREATE TABLE physical_baselines (
  id              SERIAL PRIMARY KEY,
  container_label TEXT NOT NULL UNIQUE,
  warehouse_id    INTEGER NOT NULL UNIQUE REFERENCES warehouses(id),
  count_date      DATE NOT NULL,
  source_doc      TEXT NOT NULL,
  counted_by      TEXT NOT NULL,
  positions_count INTEGER NOT NULL CHECK (positions_count > 0),
  total_weight_kg NUMERIC NOT NULL CHECK (total_weight_kg > 0),
  status          TEXT NOT NULL CHECK (status IN ('RECORDED','TOTAL_ONLY','MAPPED','LOADED')),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      TEXT NOT NULL
);
COMMENT ON TABLE physical_baselines IS
  'R-B sanoq registri (2026-08-17): har joy-sanoq bitta satr. Satrlar muzlatilgan (trigger): faqat status MAPPED->LOADED (R-D) o''zgarishi mumkin. Rollback = DROP TABLE (taklif §13).';

CREATE TABLE physical_baseline_positions (
  id            SERIAL PRIMARY KEY,
  baseline_id   INTEGER NOT NULL REFERENCES physical_baselines(id),
  position_no   INTEGER NOT NULL UNIQUE,
  container_pos INTEGER NOT NULL,
  name          TEXT NOT NULL,
  quantity      NUMERIC NOT NULL CHECK (quantity > 0),
  unit          TEXT NOT NULL CHECK (unit IN ('kg','dona')),
  boxes         NUMERIC CHECK (boxes > 0),
  per_box       NUMERIC CHECK (per_box > 0),
  unit_weight_g NUMERIC CHECK (unit_weight_g > 0),
  weight_kg     NUMERIC NOT NULL CHECK (weight_kg > 0),
  item_id       INTEGER REFERENCES items(id),
  mapping_status TEXT NOT NULL CHECK (mapping_status IN ('MAPPED','EXCLUDED_EXACT_CANDIDATE')),
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT NOT NULL,
  UNIQUE (baseline_id, container_pos),
  UNIQUE (baseline_id, name),
  CHECK ((mapping_status = 'MAPPED') = (item_id IS NOT NULL)),
  CHECK (unit <> 'kg'   OR (boxes IS NULL AND per_box IS NULL AND unit_weight_g IS NULL)),
  CHECK (unit <> 'kg'   OR quantity = weight_kg),
  CHECK (unit <> 'dona' OR (boxes IS NOT NULL AND per_box IS NOT NULL AND unit_weight_g IS NOT NULL)),
  CHECK (unit <> 'dona' OR boxes * per_box = quantity),
  CHECK (unit <> 'dona' OR quantity * unit_weight_g = weight_kg * 1000)
);
CREATE INDEX physical_baseline_positions_item_id_idx ON physical_baseline_positions (item_id);
COMMENT ON TABLE physical_baseline_positions IS
  '97 fizik pozitsiya — sanoq varag''idan BAYT-AYNAN (position_no = muhrlangan preview §3 tartibi). weight_kg dona satrlarda hisobiy (quantity × unit_weight_g / 1000). Muzlatilgan (trigger): faqat EXACT kandidatda item_id NULL->qiymat (+EXCLUDED->MAPPED, note bilan) mumkin — egasi qarori №1.';

-- ── 1b. Muzlatish triggerlari (satr-darajali immutability) ───────────────────
CREATE OR REPLACE FUNCTION physical_baselines_freeze_upd_fn() RETURNS trigger AS $fn$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.container_label IS DISTINCT FROM OLD.container_label
     OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
     OR NEW.count_date IS DISTINCT FROM OLD.count_date
     OR NEW.source_doc IS DISTINCT FROM OLD.source_doc
     OR NEW.counted_by IS DISTINCT FROM OLD.counted_by
     OR NEW.positions_count IS DISTINCT FROM OLD.positions_count
     OR NEW.total_weight_kg IS DISTINCT FROM OLD.total_weight_kg
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'physical_baselines MUZLATILGAN (id=%, %): faqat status MAPPED->LOADED o''zgarishi mumkin', OLD.id, OLD.container_label;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'MAPPED' AND NEW.status = 'LOADED') THEN
    RAISE EXCEPTION 'physical_baselines.status faqat MAPPED->LOADED (id=%, % -> %)', OLD.id, OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER physical_baselines_freeze_upd
  BEFORE UPDATE ON physical_baselines
  FOR EACH ROW EXECUTE FUNCTION physical_baselines_freeze_upd_fn();

CREATE OR REPLACE FUNCTION physical_baselines_no_delete_fn() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'physical_baselines satri o''chirilmaydi — registr append-only; rollback = DROP TABLE (taklif §13)';
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER physical_baselines_no_delete
  BEFORE DELETE ON physical_baselines
  FOR EACH ROW EXECUTE FUNCTION physical_baselines_no_delete_fn();
CREATE TRIGGER physical_baselines_no_truncate
  BEFORE TRUNCATE ON physical_baselines
  FOR EACH STATEMENT EXECUTE FUNCTION physical_baselines_no_delete_fn();

CREATE OR REPLACE FUNCTION physical_baseline_positions_freeze_upd_fn() RETURNS trigger AS $fn$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.baseline_id IS DISTINCT FROM OLD.baseline_id
     OR NEW.position_no IS DISTINCT FROM OLD.position_no
     OR NEW.container_pos IS DISTINCT FROM OLD.container_pos
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.unit IS DISTINCT FROM OLD.unit
     OR NEW.boxes IS DISTINCT FROM OLD.boxes
     OR NEW.per_box IS DISTINCT FROM OLD.per_box
     OR NEW.unit_weight_g IS DISTINCT FROM OLD.unit_weight_g
     OR NEW.weight_kg IS DISTINCT FROM OLD.weight_kg
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'physical_baseline_positions MUZLATILGAN (position_no=%, %): sanoq qiymatlari o''zgarmaydi', OLD.position_no, OLD.name;
  END IF;
  IF NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.mapping_status IS DISTINCT FROM OLD.mapping_status
     OR NEW.note IS DISTINCT FROM OLD.note THEN
    IF NOT (OLD.item_id IS NULL AND NEW.item_id IS NOT NULL
            AND OLD.mapping_status = 'EXCLUDED_EXACT_CANDIDATE'
            AND NEW.mapping_status = 'MAPPED') THEN
      RAISE EXCEPTION 'physical_baseline_positions (position_no=%): faqat EXACT kandidatga item_id NULL->qiymat (EXCLUDED->MAPPED, egasi qarori №1) ruxsat etiladi', OLD.position_no;
    END IF;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER physical_baseline_positions_freeze_upd
  BEFORE UPDATE ON physical_baseline_positions
  FOR EACH ROW EXECUTE FUNCTION physical_baseline_positions_freeze_upd_fn();

CREATE OR REPLACE FUNCTION physical_baseline_positions_no_delete_fn() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'physical_baseline_positions satri o''chirilmaydi — registr append-only; rollback = DROP TABLE (taklif §13)';
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER physical_baseline_positions_no_delete
  BEFORE DELETE ON physical_baseline_positions
  FOR EACH ROW EXECUTE FUNCTION physical_baseline_positions_no_delete_fn();
CREATE TRIGGER physical_baseline_positions_no_truncate
  BEFORE TRUNCATE ON physical_baseline_positions
  FOR EACH STATEMENT EXECUTE FUNCTION physical_baseline_positions_no_delete_fn();

-- ── 2. 9 baseline satri ──────────────────────────────────────────────────────
INSERT INTO physical_baselines
  (container_label, warehouse_id, count_date, source_doc, counted_by, positions_count, total_weight_kg, status, note, created_by)
VALUES
${blValues};

-- ── 3. 97 pozitsiya satri (muhrlangan §3 tartibida) ──────────────────────────
INSERT INTO physical_baseline_positions
  (baseline_id, position_no, container_pos, name, quantity, unit, boxes, per_box, unit_weight_g, weight_kg, item_id, mapping_status, note, created_by)
SELECT b.id, v.position_no::int, v.container_pos::int, v.name::text, v.quantity::numeric, v.unit::text,
       v.boxes::numeric, v.per_box::numeric, v.unit_weight_g::numeric, v.weight_kg::numeric,
       CASE WHEN v.item_sku IS NULL THEN NULL
            ELSE (SELECT i.id FROM items i WHERE i.sku = v.item_sku::text) END,
       v.mapping_status::text, v.note::text, '${CREATED_BY}'
FROM (VALUES
${posValues}
) AS v(container_label, position_no, container_pos, name, quantity, unit, boxes, per_box, unit_weight_g, weight_kg, item_sku, mapping_status, note)
JOIN physical_baselines b ON b.container_label = v.container_label::text;

-- ── 3b. Muhrlangan kutilma jadvali (97 satr, maydonma-maydon) ────────────────
CREATE TEMP TABLE rb_expected (
  container_label text NOT NULL, position_no int PRIMARY KEY, container_pos int NOT NULL,
  name text NOT NULL, quantity numeric NOT NULL, unit text NOT NULL,
  boxes numeric, per_box numeric, unit_weight_g numeric, weight_kg numeric NOT NULL,
  item_sku text, mapping_status text NOT NULL, note text
) ON COMMIT DROP;
INSERT INTO rb_expected
  (container_label, position_no, container_pos, name, quantity, unit, boxes, per_box, unit_weight_g, weight_kg, item_sku, mapping_status, note)
SELECT v.container_label::text, v.position_no::int, v.container_pos::int, v.name::text, v.quantity::numeric, v.unit::text,
       v.boxes::numeric, v.per_box::numeric, v.unit_weight_g::numeric, v.weight_kg::numeric,
       v.item_sku::text, v.mapping_status::text, v.note::text
FROM (VALUES
${posValues}
) AS v(container_label, position_no, container_pos, name, quantity, unit, boxes, per_box, unit_weight_g, weight_kg, item_sku, mapping_status, note);

-- ── 4. TEKSHIRUV (9.1–9.10) — birorta mismatch = EXCEPTION = ROLLBACK ────────
DO $ver$
DECLARE v bigint; v2 bigint; v3 bigint;
BEGIN
  -- 9.1 baselines: 9 satr, barcha maydonlar qoziqlarga mos
  SELECT COUNT(*) INTO v FROM physical_baselines;
  IF v <> 9 THEN RAISE EXCEPTION '9.1: baselines=% (9 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v FROM physical_baselines b
   JOIN (VALUES
     ('C-20',26,'2026-08-15'::date,10,10136.45::numeric), ('C-19',25,'2026-08-15',13,8713.30),
     ('C-18',24,'2026-08-15',29,9839.45), ('C-02',8,'2026-08-15',10,6053.00),
     ('C-04',10,'2026-08-15',7,6363.30), ('C-06',12,'2026-08-15',13,7435.50),
     ('C-16',22,'2026-08-15',3,7045.20), ('C-17',23,'2026-08-15',9,3256.00),
     ('C-15',21,'2026-08-16',3,13020.00)
   ) e(label, wid, cdate, pcount, kg)
     ON b.container_label = e.label AND b.warehouse_id = e.wid AND b.count_date = e.cdate
    AND b.positions_count = e.pcount AND b.total_weight_kg = e.kg
    AND b.status = 'MAPPED' AND b.counted_by = '${COUNTED_BY}' AND b.created_by = '${CREATED_BY}';
  IF v <> 9 THEN RAISE EXCEPTION '9.1: % baseline satri qoziqlarga mos (9 kutilgan)', v; END IF;
  -- baselines ichki izchillik: positions_count va total_weight_kg = haqiqiy agregat
  SELECT COUNT(*) INTO v FROM physical_baselines b
   WHERE b.positions_count <> (SELECT COUNT(*) FROM physical_baseline_positions p WHERE p.baseline_id = b.id)
      OR b.total_weight_kg <> (SELECT COALESCE(SUM(p.weight_kg),0) FROM physical_baseline_positions p WHERE p.baseline_id = b.id);
  IF v <> 0 THEN RAISE EXCEPTION '9.1: % baselineda agregat mos emas', v; END IF;

  -- 9.2 pozitsiyalar: 97, position_no zich 1..97
  SELECT COUNT(*) INTO v FROM physical_baseline_positions;
  IF v <> 97 THEN RAISE EXCEPTION '9.2: positions=% (97 kutilgan)', v; END IF;
  SELECT COUNT(DISTINCT position_no), MIN(position_no), MAX(position_no) INTO v, v2, v3 FROM physical_baseline_positions;
  IF v <> 97 OR v2 <> 1 OR v3 <> 97 THEN RAISE EXCEPTION '9.2: position_no zich emas (%..%, distinct %)', v2, v3, v; END IF;

  -- 9.3 massa yig'indilari (sentgacha aynan)
  IF (SELECT SUM(weight_kg) FROM physical_baseline_positions) <> 71862.20 THEN
    RAISE EXCEPTION '9.3: jami kg % (71862.20 kutilgan)', (SELECT SUM(weight_kg) FROM physical_baseline_positions);
  END IF;
  IF (SELECT SUM(weight_kg) FROM physical_baseline_positions WHERE unit='kg' AND item_id IS NOT NULL) <> 60353.45 THEN
    RAISE EXCEPTION '9.3: mapped kg-massa noto''g''ri';
  END IF;
  IF (SELECT SUM(weight_kg) FROM physical_baseline_positions WHERE unit='dona') <> 10301.20 THEN
    RAISE EXCEPTION '9.3: dona kg-ekvivalent noto''g''ri';
  END IF;
  IF (SELECT SUM(weight_kg) FROM physical_baseline_positions WHERE item_id IS NULL) <> 1207.55 THEN
    RAISE EXCEPTION '9.3: EXACT chetdagi massa noto''g''ri';
  END IF;
  IF (SELECT SUM(quantity) FROM physical_baseline_positions WHERE unit='dona') <> 126360 THEN
    RAISE EXCEPTION '9.3: dona jami noto''g''ri';
  END IF;

  -- 9.4 mapping tarkibi: 95 MAPPED + 2 EXCLUDED (aynan qaysi satrlar ekani pin)
  SELECT COUNT(*) INTO v FROM physical_baseline_positions WHERE item_id IS NOT NULL AND mapping_status='MAPPED';
  IF v <> 95 THEN RAISE EXCEPTION '9.4: mapped=% (95 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v FROM physical_baseline_positions WHERE item_id IS NULL;
  IF v <> 2 THEN RAISE EXCEPTION '9.4: item_id IS NULL % satr (2 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v FROM physical_baseline_positions p JOIN physical_baselines b ON b.id=p.baseline_id
   WHERE p.item_id IS NULL AND p.mapping_status='EXCLUDED_EXACT_CANDIDATE'
     AND ((b.container_label='C-18' AND p.name='Rossiya Tros' AND p.weight_kg=531)
       OR (b.container_label='C-02' AND p.name='Shroki 3.5 Oq' AND p.weight_kg=676.55));
  IF v <> 2 THEN RAISE EXCEPTION '9.4: EXACT kandidat satrlari qoziqqa mos emas (%)', v; END IF;

  -- 9.5 bijeksiya: 94 SKU; faqat TM-000022 ikki satrda (C-19 168.6 + C-04 261.2)
  SELECT COUNT(DISTINCT item_id) INTO v FROM physical_baseline_positions WHERE item_id IS NOT NULL;
  IF v <> 94 THEN RAISE EXCEPTION '9.5: DISTINCT item_id=% (94 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v FROM (
    SELECT item_id FROM physical_baseline_positions WHERE item_id IS NOT NULL GROUP BY item_id HAVING COUNT(*) <> 1
  ) x;
  IF v <> 1 THEN RAISE EXCEPTION '9.5: ko''p-satrli itemlar % (faqat 1 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v FROM physical_baseline_positions p
   JOIN items i ON i.id = p.item_id JOIN physical_baselines b ON b.id = p.baseline_id
   WHERE i.sku='TM-000022'
     AND ((b.container_label='C-19' AND p.weight_kg=168.6) OR (b.container_label='C-04' AND p.weight_kg=261.2));
  IF v <> 2 THEN RAISE EXCEPTION '9.5: TM-000022 ikki lokatsiya qoziqqa mos emas (%)', v; END IF;

  -- 9.6 nom/birlik bayt-aynan items bilan (mapped satrlar)
  SELECT COUNT(*) INTO v FROM physical_baseline_positions p JOIN items i ON i.id = p.item_id
   WHERE i.display_name IS DISTINCT FROM p.name OR i.unit IS DISTINCT FROM p.unit;
  IF v <> 0 THEN RAISE EXCEPTION '9.6: % satrda nom/birlik items bilan mos emas', v; END IF;

  -- 9.7 TO'LIQ maydonma-maydon muvofiqlik muhrlangan kutilma bilan (FULL JOIN)
  SELECT COUNT(*) INTO v FROM rb_expected;
  IF v <> 97 THEN RAISE EXCEPTION '9.7: rb_expected=% (97 kutilgan)', v; END IF;
  SELECT COUNT(*) INTO v
    FROM rb_expected e
    FULL JOIN (
      SELECT p.*, b.container_label AS bl_label, i.sku AS item_sku
        FROM physical_baseline_positions p
        JOIN physical_baselines b ON b.id = p.baseline_id
        LEFT JOIN items i ON i.id = p.item_id
    ) a ON a.position_no = e.position_no
   WHERE a.position_no IS NULL OR e.position_no IS NULL
      OR a.bl_label IS DISTINCT FROM e.container_label
      OR a.container_pos IS DISTINCT FROM e.container_pos
      OR a.name IS DISTINCT FROM e.name
      OR a.quantity IS DISTINCT FROM e.quantity
      OR a.unit IS DISTINCT FROM e.unit
      OR a.boxes IS DISTINCT FROM e.boxes
      OR a.per_box IS DISTINCT FROM e.per_box
      OR a.unit_weight_g IS DISTINCT FROM e.unit_weight_g
      OR a.weight_kg IS DISTINCT FROM e.weight_kg
      OR a.item_sku IS DISTINCT FROM e.item_sku
      OR a.mapping_status IS DISTINCT FROM e.mapping_status
      OR a.note IS DISTINCT FROM e.note
      OR a.created_by IS DISTINCT FROM '${CREATED_BY}';
  IF v <> 0 THEN RAISE EXCEPTION '9.7: % satr muhrlangan kutilmaga mos emas', v; END IF;

  -- 9.8 dona arifmetikasi (CHECK'lardan mustaqil qayta isbot)
  SELECT COUNT(*) INTO v FROM physical_baseline_positions
   WHERE unit='dona' AND (boxes * per_box <> quantity OR quantity * unit_weight_g <> weight_kg * 1000);
  IF v <> 0 THEN RAISE EXCEPTION '9.8: % dona-satrda arifmetika buzilgan', v; END IF;
  SELECT COUNT(*) INTO v FROM physical_baseline_positions WHERE unit='kg' AND quantity <> weight_kg;
  IF v <> 0 THEN RAISE EXCEPTION '9.8: % kg-satrda quantity≠weight_kg', v; END IF;

  -- 9.9 boshqa hech narsa o'zgarmadi (son + yig'indi, tranzaksiya-ichki)
  IF (SELECT sales_n FROM rb_pre) <> (SELECT COUNT(*) FROM sales) THEN RAISE EXCEPTION '9.9: sales o''zgardi'; END IF;
  IF (SELECT sale_items_n FROM rb_pre) <> (SELECT COUNT(*) FROM sale_items) THEN RAISE EXCEPTION '9.9: sale_items o''zgardi'; END IF;
  IF (SELECT sale_items_qty FROM rb_pre) <> (SELECT COALESCE(SUM(quantity),0) FROM sale_items) THEN RAISE EXCEPTION '9.9: sale_items.quantity o''zgardi'; END IF;
  IF (SELECT sm_n FROM rb_pre) <> (SELECT COUNT(*) FROM stock_movements) THEN RAISE EXCEPTION '9.9: stock_movements o''zgardi'; END IF;
  IF (SELECT sm_qty FROM rb_pre) <> (SELECT COALESCE(SUM(quantity),0) FROM stock_movements) THEN RAISE EXCEPTION '9.9: stock_movements.quantity o''zgardi'; END IF;
  IF (SELECT inv_n FROM rb_pre) <> (SELECT COUNT(*) FROM inventory) THEN RAISE EXCEPTION '9.9: inventory soni o''zgardi'; END IF;
  IF (SELECT inv_qty FROM rb_pre) <> (SELECT COALESCE(SUM(quantity),0) FROM inventory) THEN RAISE EXCEPTION '9.9: inventory.quantity o''zgardi'; END IF;
  IF (SELECT inv_kg FROM rb_pre) <> (SELECT COALESCE(SUM(weight_kg),0) FROM inventory) THEN RAISE EXCEPTION '9.9: inventory.weight_kg o''zgardi'; END IF;
  IF (SELECT products_n FROM rb_pre) <> (SELECT COUNT(*) FROM products) THEN RAISE EXCEPTION '9.9: products o''zgardi'; END IF;
  IF (SELECT rm_n FROM rb_pre) <> (SELECT COUNT(*) FROM raw_materials) THEN RAISE EXCEPTION '9.9: raw_materials o''zgardi'; END IF;
  IF (SELECT rm_stock FROM rb_pre) <> (SELECT COALESCE(SUM(current_stock),0) FROM raw_materials) THEN RAISE EXCEPTION '9.9: raw_materials.current_stock o''zgardi'; END IF;
  IF (SELECT batches_n FROM rb_pre) <> (SELECT COUNT(*) FROM batches) THEN RAISE EXCEPTION '9.9: batches o''zgardi'; END IF;
  IF (SELECT wip_n FROM rb_pre) <> (SELECT COUNT(*) FROM wip_movements) THEN RAISE EXCEPTION '9.9: wip_movements o''zgardi'; END IF;
  IF (SELECT items_n FROM rb_pre) <> (SELECT COUNT(*) FROM items) OR (SELECT COUNT(*) FROM items) <> 94 THEN RAISE EXCEPTION '9.9: items o''zgardi'; END IF;
  IF (SELECT aliases_n FROM rb_pre) <> (SELECT COUNT(*) FROM item_aliases) OR (SELECT COUNT(*) FROM item_aliases) <> 0 THEN RAISE EXCEPTION '9.9: item_aliases o''zgardi'; END IF;
  IF (SELECT lg_inv_n FROM rb_pre) <> (SELECT COUNT(*) FROM legacy.inventory_baseline_pre) THEN RAISE EXCEPTION '9.9: legacy.inventory_baseline_pre o''zgardi'; END IF;
  IF (SELECT lg_rm_n FROM rb_pre) <> (SELECT COUNT(*) FROM legacy.raw_material_stock_pre) THEN RAISE EXCEPTION '9.9: legacy.raw_material_stock_pre o''zgardi'; END IF;
  IF (SELECT lg_wip_n FROM rb_pre) <> (SELECT COUNT(*) FROM legacy.wip_balances_pre) THEN RAISE EXCEPTION '9.9: legacy.wip_balances_pre o''zgardi'; END IF;
  IF (SELECT lg_cont_n FROM rb_pre) <> (SELECT COUNT(*) FROM legacy.container_summary_pre) THEN RAISE EXCEPTION '9.9: legacy.container_summary_pre o''zgardi'; END IF;
  -- R-D BOSHLANMAGANI: BASELINE harakatlar avval ham, hozir ham 0
  IF (SELECT sm_baseline_n FROM rb_pre) <> 0
     OR (SELECT COUNT(*) FROM stock_movements WHERE movement_type='BASELINE') <> 0 THEN
    RAISE EXCEPTION '9.9: BASELINE harakat topildi — R-D chegarasi buzilgan';
  END IF;

  -- 9.10 counted_by/created_by (egasi tasdig'i)
  SELECT COUNT(*) INTO v FROM physical_baselines WHERE counted_by <> '${COUNTED_BY}' OR created_by <> '${CREATED_BY}';
  IF v <> 0 THEN RAISE EXCEPTION '9.10: baselines counted_by/created_by xato (%)', v; END IF;
  SELECT COUNT(*) INTO v FROM physical_baseline_positions WHERE created_by <> '${CREATED_BY}';
  IF v <> 0 THEN RAISE EXCEPTION '9.10: positions created_by xato (%)', v; END IF;

  RAISE NOTICE 'R-B TEKSHIRUV: 9.1–9.10 BARCHASI PASS';
END $ver$;

COMMIT;

-- ── 5. COMMIT'dan keyingi hisobot (faqat o'qish) ─────────────────────────────
SELECT b.container_label, b.warehouse_id, b.count_date, b.positions_count, b.total_weight_kg, b.status, b.counted_by
  FROM physical_baselines b ORDER BY b.id;
SELECT COUNT(*) AS positions,
       COUNT(*) FILTER (WHERE item_id IS NOT NULL) AS mapped,
       COUNT(*) FILTER (WHERE item_id IS NULL) AS excluded_exact,
       COUNT(DISTINCT item_id) AS distinct_items,
       SUM(weight_kg) AS total_kg,
       SUM(quantity) FILTER (WHERE unit='dona') AS total_dona
  FROM physical_baseline_positions;
SELECT p.position_no, b.container_label, p.name, p.quantity, p.unit, p.weight_kg,
       COALESCE(i.sku,'—') AS sku, p.mapping_status
  FROM physical_baseline_positions p
  JOIN physical_baselines b ON b.id=p.baseline_id
  LEFT JOIN items i ON i.id=p.item_id
 WHERE p.position_no IN (1, 22, 40, 61, 69, 83, 97)
 ORDER BY p.position_no;
`;

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, sql, "utf8");
const sha = createHash("sha256").update(sql).digest("hex");
console.log(`OK: ${path.relative(ROOT, OUT)} yozildi (sha256 ${sha.slice(0, 16)}…)`);
console.log(`  baselines: 9 (counted_by='${COUNTED_BY}') · positions: 97 (mapped 95, EXACT chetda 2)`);
console.log(`  massa: ${fmt2(kgDirect)} kg-item + ${fmt2(donaKg)} dona-ekv + ${fmt2(exclKg)} EXACT = ${fmt2(grand)} kg`);
console.log(`  muhr tekshiruvi: §3 97/97 satr bayt-aynan mos`);
