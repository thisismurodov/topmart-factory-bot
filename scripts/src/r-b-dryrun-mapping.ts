// =============================================================================
// R-B DRY-RUN — 97 fizik pozitsiya ↔ 94 kanonik SKU mapping PREVIEW (2026-08-17)
// FAQAT O'QISH: bazaga 0 yozuv (sessiya read-only qilinadi), hech narsa
// yaratilmaydi/o'zgartirilmaydi. Natija: docs/r-b-mapping-preview-2026-08-17.md
// Manbalar (bayt-aynan solishtiriladi):
//   1. Jonli Railway DB: items (94) + item_aliases (0 kutiladi)
//   2. docs/r-c-final-preview-2026-08-17.md §4 (94 item) + §5 (2 EXACT kandidat)
//   3. docs/physical-count-reconciliation-2026-08-15.md 3-bosqich (6 konteyner)
//   4. docs/physical-count-c15-2026-08-16.md (C-15, 3 pozitsiya)
//   5. docs/physical-count-c16-c17-2026-08-15.md (C-16: 3, C-17: 9 pozitsiya)
// Birorta tekshiruv yiqilsa — skript xato bilan to'xtaydi, hujjat yozilmaydi.
// =============================================================================
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PREVIEW = path.join(ROOT, "docs/r-c-final-preview-2026-08-17.md");
const RECON = path.join(ROOT, "docs/physical-count-reconciliation-2026-08-15.md");
const C15DOC = path.join(ROOT, "docs/physical-count-c15-2026-08-16.md");
const C1617DOC = path.join(ROOT, "docs/physical-count-c16-c17-2026-08-15.md");
const OUT = path.join(ROOT, "docs/r-b-mapping-preview-2026-08-17.md");

// Fail-safe nashr: avvalgi preview DARHOL o'chiriladi — bu fayl diskda faqat
// oxirgi ijro 100% PASS bo'lgandagina mavjud bo'ladi (eski nusxa yolg'on
// «muvaffaqiyat» sifatida qolib ketmasligi uchun).
rmSync(OUT, { force: true });

function fail(msg: string): never {
  console.error(`✗ DRY-RUN FAIL: ${msg}`);
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

// ── 1. §4 (94 item) — R-C generatoridagi AYNAN o'sha regex/parsing ───────────
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

// noteFor — R-C generatoridan AYNAN nusxa (DB notlarini qayta hisoblash uchun)
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

// ── 3. Sanoq pozitsiyalari (97) — asl hujjatlardan ──────────────────────────
type Pos = {
  container: string;
  idx: number;
  name: string; // tozalangan (annotatsiyasiz), bayt-aynan sanoq nomi
  qtyStr: string; // manba satridagi ko'rinish
  qtyCents: number; // kg pozitsiyada kg-cents; dona pozitsiyada dona*100
  unit: "kg" | "dona";
  kgCents: number; // fizik massa (dona uchun hisobiy ekvivalent)
  kgStr: string;
  legacyStatus: string; // EXACT_MATCH / POSSIBLE_MATCH / UNMATCHED / —
  legacyCand: string; // «...» legacy nomzod (recon 3-bosqich) yoki —
  annot: string; // masalan "metr: NULL"
  date: string;
  detail: string; // dona: karobka/qop × dona × gramm
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
    });
  }
}
parseDonaSection(c1617md, "## 1. C-16", "## 2. C-17", "C-16", "karobka");
parseDonaSection(c1617md, "## 2. C-17", "Oraliq yig'indilar", "C-17", "qop");

// ── 4. Pozitsiya nazoratlari ─────────────────────────────────────────────────
const CONTAINERS = ["C-20", "C-19", "C-18", "C-02", "C-04", "C-06", "C-16", "C-17", "C-15"];
const EXPECTED_POS: Record<string, number> = {
  "C-20": 10, "C-19": 13, "C-18": 29, "C-02": 10, "C-04": 7, "C-06": 13, "C-16": 3, "C-17": 9, "C-15": 3,
};
const EXPECTED_KG: Record<string, number> = {
  "C-20": 1013645, "C-19": 871330, "C-18": 983945, "C-02": 605300, "C-04": 636330,
  "C-06": 743550, "C-16": 704520, "C-17": 325600, "C-15": 1302000,
};
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
if (possibleCount !== 15) fail(`legacy POSSIBLE_MATCH ${possibleCount} ≠ 15 (recon 6-bosqich bilan zid)`);

// metr-annotatsiya nazorati: aynan 6 ta, aynan kutilgan joylarda
const EXPECTED_METR = ["C-20:10", "C-18:11", "C-18:12", "C-18:23", "C-06:2", "C-06:3"];
const metrPos = positions.filter((p) => p.annot === "metr: NULL");
const metrKeys = metrPos.map((p) => `${p.container}:${p.idx}`).sort();
if (JSON.stringify(metrKeys) !== JSON.stringify([...EXPECTED_METR].sort()))
  fail(`metr-NULL annotatsiyalar kutilgan 6 joyga mos emas: [${metrKeys.join(", ")}]`);
const metrList = CONTAINERS.filter((c) => metrPos.some((p) => p.container === c))
  .map((c) => `${c} ${metrPos.filter((p) => p.container === c).map((p) => `№${p.idx}`).join("/")}`)
  .join("; ");

// EXACT chiqariladiganlar
const excluded = positions.filter((p) => p.legacyStatus === "EXACT_MATCH");
if (excluded.length !== 2) fail(`EXACT_MATCH pozitsiyalar ${excluded.length} ≠ 2`);
for (const cand of exactCands) {
  const p = excluded.find((x) => x.name === cand.name && x.container === cand.joy);
  if (!p) fail(`§5 kandidat «${cand.name}» (${cand.joy}) recon'da EXACT sifatida topilmadi`);
  if (p.kgCents !== cand.kgCents) fail(`«${cand.name}» kg: recon ${fmt2(p.kgCents)} ≠ §5 ${fmt2(cand.kgCents)}`);
}
const exclKg = excluded.reduce((a, p) => a + p.kgCents, 0);
if (exclKg !== 120755) fail(`EXACT jami ${fmt2(exclKg)} ≠ 1 207.55`);

// ── 5. Item-lokatsiyalar (95) va bijeksiya ───────────────────────────────────
type ItemLoc = { item: ItemRow; container: string; qtyCents: number; kgCents: number; multi: boolean };
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
    itemLocs.push({ item: r, container: m[3], qtyCents: q1, kgCents: q1, multi: true });
    itemLocs.push({ item: r, container: m[5], qtyCents: q2, kgCents: q2, multi: true });
  } else if (r.unit === "dona") {
    const m = r.countCell.match(/^([\d\s\u00A0\u202F\u2009]+) \(([\d\s\u00A0\u202F\u2009.,]+) kg\)$/);
    if (!m) fail(`dona katak formati: "${r.countCell}" (${r.sku})`);
    itemLocs.push({ item: r, container: r.joy, qtyCents: Math.round(num(m[1]) * 100), kgCents: cents(m[2]), multi: false });
  } else {
    itemLocs.push({ item: r, container: r.joy, qtyCents: cents(r.countCell), kgCents: cents(r.countCell), multi: false });
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
  if (!p) fail(`item ${il.item.sku} «${il.item.name}» (${il.container}) uchun sanoq pozitsiyasi topilmadi (nom bayt-aynan mos emas?)`);
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

// Jami nazoratlar (§7 bilan)
const kgDirect = itemLocs.filter((il) => il.item.unit === "kg").reduce((a, il) => a + il.kgCents, 0);
if (kgDirect !== 6035345) fail(`kg-itemlar jami ${fmt2(kgDirect)} ≠ 60 353.45`);
const donaTotal = itemLocs.filter((il) => il.item.unit === "dona").reduce((a, il) => a + il.qtyCents, 0);
if (donaTotal !== 12636000) fail(`dona jami ${donaTotal / 100} ≠ 126 360`);
const donaKg = itemLocs.filter((il) => il.item.unit === "dona").reduce((a, il) => a + il.kgCents, 0);
if (donaKg !== 1030120) fail(`dona kg-ekvivalent ${fmt2(donaKg)} ≠ 10 301.20`);
if (kgDirect + donaKg !== 7065465) fail(`mapped massa ≠ 70 654.65`);
if (kgDirect + donaKg + exclKg !== 7186220) fail(`umumiy nazorat ≠ 71 862.20`);
// §7 joy kesimi (mapped-only): C-18 va C-02 EXACT'siz
const mappedC18 = itemLocs.filter((il) => il.container === "C-18").reduce((a, il) => a + il.kgCents, 0);
if (mappedC18 !== 930845) fail(`C-18 mapped ${fmt2(mappedC18)} ≠ 9 308.45`);
const mappedC02 = itemLocs.filter((il) => il.container === "C-02").reduce((a, il) => a + il.kgCents, 0);
if (mappedC02 !== 537645) fail(`C-02 mapped ${fmt2(mappedC02)} ≠ 5 376.45`);

// ── 6. Jonli DB bilan bayt-aynan solishtirish (FAQAT SELECT, read-only) ──────
const url = process.env.RAILWAY_DATABASE_URL;
if (!url) fail("RAILWAY_DATABASE_URL yo'q");
const client = new pg.Client({ connectionString: url });
await client.connect();
let dbInfo = { aliases: 0, minId: 0, maxId: 0 };
try {
  await client.query("SET default_transaction_read_only = on");
  const res = await client.query(
    "SELECT sku, display_name, unit, note, created_by, id FROM items ORDER BY sku",
  );
  if (res.rows.length !== 94) fail(`DB items ${res.rows.length} ≠ 94`);
  for (let i = 0; i < 94; i++) {
    const db = res.rows[i];
    const doc = items[i];
    if (db.sku !== doc.sku) fail(`DB[${i}] sku ${db.sku} ≠ ${doc.sku}`);
    if (db.display_name !== doc.name) fail(`${doc.sku} nom: DB «${db.display_name}» ≠ §4 «${doc.name}»`);
    if (db.unit !== doc.unit) fail(`${doc.sku} birlik: DB ${db.unit} ≠ §4 ${doc.unit}`);
    if (db.note !== noteFor(doc)) fail(`${doc.sku} note: DB «${db.note}» ≠ kutilgan «${noteFor(doc)}»`);
    if (db.created_by !== "thisismurodov") fail(`${doc.sku} created_by ≠ thisismurodov`);
  }
  const al = await client.query("SELECT COUNT(*)::int AS n FROM item_aliases");
  dbInfo.aliases = al.rows[0].n;
  if (dbInfo.aliases !== 0) fail(`item_aliases ${dbInfo.aliases} ≠ 0`);
  const ids = await client.query("SELECT MIN(id)::int AS mn, MAX(id)::int AS mx FROM items");
  dbInfo.minId = ids.rows[0].mn;
  dbInfo.maxId = ids.rows[0].mx;
  if (dbInfo.minId !== 2 || dbInfo.maxId !== 95) fail(`items id oralig'i ${dbInfo.minId}..${dbInfo.maxId} ≠ 2..95`);
} finally {
  await client.end();
}

// ── 7. Preview hujjatini yozish ──────────────────────────────────────────────
const CONTROLS: [string, string][] = [
  ["97 fizik pozitsiya to'liq chiqdi (9 joy)", `97/97 ✓ (C-20:10 · C-19:13 · C-18:29 · C-02:10 · C-04:7 · C-06:13 · C-16:3 · C-17:9 · C-15:3)`],
  ["94 kanonik SKU bilan bog'landi", `95 pozitsiya → 94 SKU (bijeksiya, har biri roppa-rosa 1 marta) ✓`],
  ["TM-000022 = 1 SKU, 2 lokatsiya", `C-19 168.6 kg + C-04 261.2 kg = 429.8 kg ✓`],
  ["Jami 71 862.20 kg mosligi", `${fmt2(kgDirect)} (kg-itemlar) + ${fmt2(donaKg)} (dona ekviv.) + ${fmt2(exclKg)} (2 EXACT) = ${fmt2(grand)} ✓`],
  ["2 EXACT kandidat mapping'ga KIRMADI", `Rossiya Tros (C-18, 531) · Shroki 3.5 Oq (C-02, 676.55) — item_id bo'sh qoladi ✓`],
  ["Nom mosligi bayt-aynan", `95/95 pozitsiya nomi = kanonik nom (0 normalizatsiya, 0 trim, 0 rename; 6 metr-annotatsiya qat'iy qolipda ajratildi va joylari tasdiqlandi) ✓`],
  ["Jonli DB ≡ muhrlangan §4", `94/94: sku+nom+birlik+note+created_by aynan; id 2..95; item_aliases=0 ✓`],
  ["Legacy POSSIBLE nomzodlar tegilmadi", `15/15 faqat ma'lumot ustunida ✓`],
  ["Bazaga yozuv", `0 (sessiya read-only, faqat SELECT) ✓`],
];

let n = 0;
const tableRows: string[] = [];
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
    tableRows.push(
      `| ${n} | ${p.container} | ${p.name} | ${p.qtyStr} | ${p.unit} | ${p.unit === "dona" ? p.kgStr + " (hisobiy)" : p.kgStr} | ${item ? item.sku : "—"} | ${item ? item.name : "—"} | ${turi} | ${izoh.join(" · ") || "—"} |`,
    );
  }
}

const perContainer = CONTAINERS.map((c) => {
  const ps = positions.filter((p) => p.container === c);
  const mapped = ps.filter((p) => posToSku.has(p));
  const kgSum = ps.reduce((a, p) => a + p.kgCents, 0);
  const mappedKg = mapped.reduce((a, p) => a + p.kgCents, 0);
  return `| ${c} | ${ps.length} | ${mapped.length} | ${fmt2(kgSum)} | ${fmt2(mappedKg)} | ${ps.length - mapped.length ? fmt2(kgSum - mappedKg) + " (EXACT)" : "—"} |`;
}).join("\n");

const doc = `# R-B DRY-RUN — MAPPING PREVIEW (2026-08-17)

**Holat: FAQAT PREVIEW — bazaga 0 yozuv. Hech qanday item yaratilmadi/ulanmadi/rename qilinmadi. R-D boshlanmadi. «R-B GO» kutilmoqda.**

Generator: \`scripts/src/r-b-dryrun-mapping.ts\` (deterministik — qayta ishga tushirilsa bayt-aynan shu hujjat chiqadi). Skript boshida avvalgi preview o'chiriladi va hujjat faqat BARCHA nazoratlar o'tgachgina yoziladi — demak bu faylning diskda mavjudligi = oxirgi ijro 100% PASS.
Manbalar: jonli \`items\` (94) · muhrlangan \`docs/r-c-final-preview-2026-08-17.md\` §4/§5 · \`docs/physical-count-reconciliation-2026-08-15.md\` (3-bosqich) · \`docs/physical-count-c15-2026-08-16.md\` · \`docs/physical-count-c16-c17-2026-08-15.md\`.

## 1. Nazorat paneli (egasining talablari)

| Talab | Natija |
|---|---|
${CONTROLS.map(([a, b]) => `| ${a} | ${b} |`).join("\n")}

## 2. Joy kesimida balans

| Joy | Pozitsiya | Mapping'da | Jami kg | Mapped kg | Chetda |
|---|---|---|---|---|---|
${perContainer}
| **JAMI** | **97** | **95** | **${fmt2(grand)}** | **${fmt2(kgDirect + donaKg)}** | **${fmt2(exclKg)}** |

Dona bloki: **126 360 dona** (C-16: 61 080 · C-17: 65 280) = hisobiy **${fmt2(donaKg)} kg** (birlik og'irlik × dona, sanoq varag'idan).

## 3. To'liq mapping jadvali — 97 pozitsiya

Nomlar sanoq varaqlaridan **aynan** (bayt-aynan solishtirilgan). «Mapping turi»: AYNAN 1:1 — nom va joy bo'yicha yagona mos; AYNAN · 2-JOYLI — bitta SKU'ning ikki joydagi qismi; CHIQARILGAN — egasi qarori bilan R-B'dan tashqarida.

| № | Joy | Fizik nom (aynan) | Real sanoq | Birlik | kg | TM-SKU | Kanonik nom | Mapping turi | Izoh |
|---|---|---|---|---|---|---|---|---|---|
${tableRows.join("\n")}

## 4. Noaniqliklar va e'tibor punktlari

1. **2 EXACT kandidat (№1 ochiq qaror):** «Rossiya Tros» (C-18, 531 kg, legacy \`ROSSIYATROS\`) va «Shroki 3.5 Oq» (C-02, 676.55 kg, legacy \`SHROKI-3-5-OQ\`) — egasi qarorigacha registrda **item_id = NULL** bo'lib turadi (pozitsiya sifatida saqlanadi, mapping YO'Q). Bular 94 ta TM-SKU'ga ta'sir qilmaydi.
2. **TM-000022 (Yashil PP TWS Strupa 16 talik):** registrda 2 alohida pozitsiya satri (C-19 168.6 + C-04 261.2), ikkalasi bitta SKU'ga ulanadi — R-D'da ham 2 alohida BASELINE harakat bo'ladi (har joyning o'z miqdori).
3. **«metr» spetsifikatsiyali 6 pozitsiya** (${metrList} — sanoq varag'idagi \`*(metr: NULL)*\` belgisidan avtomatik aniqlandi va joylari tasdiqlandi): «N metr» nom tarkibida, fizik metr sanog'i berilmagan — kg'dan metr hisoblanmagan va hisoblanmaydi.
4. **Dona↔kg:** 12 dona-itemning kg qiymati **hisobiy** (karobka/qop × dona × birlik og'irlik — sanoq varag'i dalili bilan qatorma-qator qayta tekshirildi). R-D'da \`weight_kg\` sifatida yozish taklif etiladi; kg-itemlarda \`quantity\` semantikasi (№ ochiq savol, recon 5-bosqich) R-D'gacha egasi javobini kutadi.
5. **Legacy POSSIBLE nomzodlar (15 ta)** jadvalning «Izoh» ustunida faqat ma'lumot sifatida turibdi — R-B ularni ISHLATMAYDI (alias/merge alohida bosqich, alohida GO). Bundan tashqari C-17 oilasi bo'yicha sanoq hujjatida (\`docs/physical-count-c16-c17-2026-08-15.md\`, §5 ERP snapshot va nomlash-farqi qaydi) fizik «Qop ip N gramm RANG» ↔ legacy ERP «Reja ip N gr / RANG» juftliklari alias-NOMZOD sifatida qayd etilgan — bular ham R-B'dan tashqarida.
6. **Legacy «Reja ip PP / 50 gr» (C-17, ERP'da 100 dona):** fizik sanoqda YO'Q — R-B registriga kirmaydi (registr faqat sanalgan faktni saqlaydi); taqdiri legacy-arxiv siyosati bilan hal bo'ladi.
7. **C-15 purpose ziddiyati** (sanoq hujjatida qayd etilgan kuzatuv, qaror EMAS — \`docs/physical-count-c15-2026-08-16.md\`): konteyner maqsadi \`finished\` (DB ID 21), tarkibi esa sof xomashyo (CF filament) — R-E/keyingi bosqich savoli, mapping'ga ta'sir qilmaydi.
8. **C-17 «259 qop» manba xatosi:** sanoq hujjatida «✅ HAL QILINDI (2026-08-16)» deb qayd etilgan — egasi tasdig'i bilan to'g'risi **279 qop** (162+59+58); jadval 279 asosida, dona/kg jamlariga ta'sir yo'q (manba: \`docs/physical-count-c16-c17-2026-08-15.md\`, arifmetik tekshiruv bo'limi).
9. **Oilalar birlashtirilmadi:** «80/100/120 talik», «30/50/100 gramm», ranglar — barchasi alohida SKU (egasi taqiqi bo'yicha); «16 mm Alpinist» (C-20) va «Alpinist 16 mm» (C-18) ham 2 alohida SKU (TM-000007 / TM-000049) — nomlar sanoqda shunday yozilgan.

## 5. «R-B GO» nimani anglatadi (bu hujjat EMAS — faqat ma'lumot)

R-B GO = sanoq registri jadvallari (\`physical_baselines\` + \`physical_baseline_positions\`, 97 satr — shu jadvaldagi tartibda) + 95 satrda \`item_id\` mapping (2 EXACT satrda NULL). **Inventar qoldiqlariga, harakatlarga, legacy/sotuvlarga TEGILMAYDI** — bular R-D (konteyner-boshiga alohida GO). \`counted_by\` qiymati (№6 savolning R-B qismi) GO'dan oldin egasidan so'raladi.

---

**Business Impact:** ★★★★☆ — 95/97 pozitsiya kanonik SKU bilan isbotlangan bog'lanishga ega, 2 EXACT pozitsiya egasi qarori bilan ataylab ochiq; registr uchun hamma narsa tayyor.
**Technical Risk:** ☆☆☆☆☆ — 0 yozuv (read-only sessiya), 9 qatlam nazorat, bayt-aynan solishtiruv.
**User Value:** ★★★★★ — to'liq shaffof preview: egasi har bir satrni GO'dan oldin ko'radi.
**Future Dependency:** ★★★★★ — R-B GO shu jadvalni muhrlangan spetsifikatsiya sifatida oladi; R-D har pozitsiyani BASELINE harakatga aylantiradi.

«Biz taxmin qilmaymiz. Biz bilamiz.»
`;
writeFileSync(OUT, doc);

console.log("R-B DRY-RUN PASS — barcha nazoratlar o'tdi, bazaga 0 yozuv.");
for (const [a, b] of CONTROLS) console.log(`  ✓ ${a}: ${b}`);
console.log(`Hujjat: ${path.relative(ROOT, OUT)} (97 satr jadval)`);
