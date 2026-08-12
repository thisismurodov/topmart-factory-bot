// ── AI marshrut rejalashtiruvchi v2 ─────────────────────────────────────────────
// Deterministik geo-algoritm (LLM ishlatilmaydi):
//   1. Muvozanatli k-means klasterlash (farthest-point init + sig'imli biriktirish)
//   2. Klaster chegaralarini almashtirish (swap refinement) — hududiy yaxlitlik
//   3. Har klaster ichida: multi-start NN → 2-opt + Or-opt (to'liq konvergensiya)
//   4. Kesishish (crossing) detektori — kesishish topilsa avto qayta-optimallash
//   5. KPI: masofa, vaqt, kesishishlar soni, orqaga qaytish %, samaradorlik, score
// Hammasi haversine (havo chizig'i) asosida — yo'l tarmog'i ishlatilmaydi.

// Ixtiyoriy biznes signallari — marshrut ustuvorligini boyitadi
export type ShopBusinessSignals = {
  salesSum?: number;       // so'm bilan, oxirgi 90 kun jami savdo
  creditBalance?: number;  // ochiq nasiya (qarz) qoldig'i (so'm)
  daysSinceVisit?: number; // oxirgi tashrifdan o'tgan kunlar (ko'rsatilmasa = hech bormagan)
};

export type PlanShop = {
  id: number;
  nomi: string | null;
  hudud: string | null;
  lat: number;
  lng: number;
  biz?: ShopBusinessSignals; // ixtiyoriy biznes signallari
};

export type PlannedStop = PlanShop & {
  tartib: number;
  bizScore?: number;      // 0-100 biznes ball (businessPriority=true bo'lganda to'ldiriladi)
  bizReasons?: string[];  // e.g. ["VIP", "Nasiya: 500K so'm", "35 kun bormagan"]
};

export type RouteStats = {
  shopCount: number;
  totalKm: number;
  driveMinutes: number; // faqat harakat vaqti (25 km/soat)
  visitMinutes: number; // tashrif vaqti (har do'kon ~5 daqiqa)
  totalMinutes: number; // harakat + tashrif
  startShop: string | null;
  endShop: string | null;
  crossCount: number; // marshrut chiziqlarining o'zaro kesishishlari
  backtrackPct: number; // umumiy masofaning necha % i "orqaga qaytish"ga sarflangan
  longJumps: number; // "uzun sakrash"lar soni (median segmentdan 4x uzun va >3km)
  avgHopKm: number; // o'rtacha segment uzunligi
  maxHopKm: number; // eng uzun segment
  efficiency: number; // 0-100: 100 - backtrack% - kesishish/sakrash jarimalari
  score: number; // AI Route Score (0-100)
};

export type RouteBizSummary = {
  avgBizScore: number;          // klasterning o'rtacha biznes bali (0-100)
  highPriorityCount: number;    // bizScore >= 60 bo'lgan do'konlar soni
  totalCreditBalance: number;   // klaster ichidagi jami ochiq nasiya (so'm)
};

export type PlannedRoute = {
  kun: number;
  stops: PlannedStop[];
  stats: RouteStats;
  bizSummary?: RouteBizSummary; // businessPriority=true bo'lganda to'ldiriladi
};

export type PlanResult = {
  routes: PlannedRoute[];
  totalShops: number;
  totalKm: number;
  avgScore: number;
  businessPriorityActive?: boolean; // biznes signallari ishlatildimi
};

const EARTH_R = 6371; // km

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

type GeoPt = { lat: number; lng: number };

function pathKm(stops: GeoPt[]): number {
  let km = 0;
  for (let i = 1; i < stops.length; i++) {
    km += haversineKm(stops[i - 1].lat, stops[i - 1].lng, stops[i].lat, stops[i].lng);
  }
  return km;
}

// ── Kesishish (crossing) detektori ─────────────────────────────────────────────
// Lokal tekislik proyeksiyasi (kichik hudud uchun yetarli aniqlik)
function toXY(p: GeoPt, refLat: number): { x: number; y: number } {
  return { x: p.lng * Math.cos((refLat * Math.PI) / 180), y: p.lat };
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(v) < 1e-12) return 0;
  return v > 0 ? 1 : -1;
}

// Ikki segment "haqiqiy" kesishadimi (umumiy uchlar hisobga olinmaydi)
function properCross(p1: GeoPt, p2: GeoPt, p3: GeoPt, p4: GeoPt, refLat: number): boolean {
  const a = toXY(p1, refLat), b = toXY(p2, refLat), c = toXY(p3, refLat), d = toXY(p4, refLat);
  const o1 = orient(a.x, a.y, b.x, b.y, c.x, c.y);
  const o2 = orient(a.x, a.y, b.x, b.y, d.x, d.y);
  const o3 = orient(c.x, c.y, d.x, d.y, a.x, a.y);
  const o4 = orient(c.x, c.y, d.x, d.y, b.x, b.y);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

// Marshrutdagi qo'shni bo'lmagan segmentlar orasidagi kesishishlar soni
export function countCrossings(stops: GeoPt[]): number {
  const n = stops.length;
  if (n < 4) return 0;
  const refLat = stops.reduce((s, p) => s + p.lat, 0) / n;
  let cnt = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 2; j < n - 1; j++) {
      if (properCross(stops[i], stops[i + 1], stops[j], stops[j + 1], refLat)) cnt++;
    }
  }
  return cnt;
}

// ── Tartiblash: NN + 2-opt + Or-opt + uncross ──────────────────────────────────
function nearestNeighborFrom(shops: PlanShop[], startIdx: number): PlanShop[] {
  const remaining = [...shops];
  const ordered: PlanShop[] = remaining.splice(startIdx, 1);
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(last.lat, last.lng, remaining[i].lat, remaining[i].lng);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    ordered.push(remaining.splice(bi, 1)[0]);
  }
  return ordered;
}

// Bitta 2-opt o'tishi — yaxshilanish bo'lsa true
function twoOptPass(arr: PlanShop[]): boolean {
  let improved = false;
  for (let i = 0; i < arr.length - 2; i++) {
    for (let j = i + 2; j < arr.length - 1; j++) {
      const a = arr[i], b = arr[i + 1], c = arr[j], d = arr[j + 1];
      const cur = haversineKm(a.lat, a.lng, b.lat, b.lng) + haversineKm(c.lat, c.lng, d.lat, d.lng);
      const alt = haversineKm(a.lat, a.lng, c.lat, c.lng) + haversineKm(b.lat, b.lng, d.lat, d.lng);
      if (alt + 1e-9 < cur) {
        let lo = i + 1, hi = j;
        while (lo < hi) {
          const t = arr[lo];
          arr[lo] = arr[hi];
          arr[hi] = t;
          lo++;
          hi--;
        }
        improved = true;
      }
    }
  }
  return improved;
}

// Or-opt: 1..3 uzunlikdagi segmentni boshqa joyga ko'chirish (ikkala yo'nalishda).
// 2-opt topolmaydigan "uzun sakrash" va zig-zag'larni tuzatadi.
function orOptPass(arr: PlanShop[]): boolean {
  const n = arr.length;
  let improved = false;
  const d = (p: PlanShop | undefined, q: PlanShop | undefined) =>
    p && q ? haversineKm(p.lat, p.lng, q.lat, q.lng) : 0;
  for (let segLen = 1; segLen <= 3; segLen++) {
    for (let i = 0; i + segLen <= n; i++) {
      const prev = arr[i - 1];
      const next = arr[i + segLen];
      const segStart = arr[i];
      const segEnd = arr[i + segLen - 1];
      // Segmentni olib tashlash "tejami"
      const removeGain = d(prev, segStart) + d(segEnd, next) - d(prev, next);
      if (removeGain <= 1e-9) continue;
      // Eng yaxshi qo'yish joyini izlaymiz
      let bestGain = 1e-9;
      let bestJ = -1;
      let bestRev = false;
      for (let j = 0; j <= n - segLen; j++) {
        // O'z joyi va segment ichiga qo'yish ma'nosiz — o'tkazib yuboramiz
        if (j >= i && j <= i + segLen) continue;
        const before = arr[j - 1];
        const after = arr[j];
        const baseCut = d(before, after);
        const insFwd = d(before, segStart) + d(segEnd, after) - baseCut;
        const insRev = d(before, segEnd) + d(segStart, after) - baseCut;
        const gainFwd = removeGain - insFwd;
        const gainRev = removeGain - insRev;
        if (gainFwd > bestGain) {
          bestGain = gainFwd;
          bestJ = j;
          bestRev = false;
        }
        if (gainRev > bestGain) {
          bestGain = gainRev;
          bestJ = j;
          bestRev = true;
        }
      }
      if (bestJ >= 0) {
        const seg = arr.splice(i, segLen);
        if (bestRev) seg.reverse();
        const insertAt = bestJ > i ? bestJ - segLen : bestJ;
        arr.splice(insertAt, 0, ...seg);
        improved = true;
      }
    }
  }
  return improved;
}

// Kesishishlarni to'g'ridan-to'g'ri yo'qotish: kesishgan juftlik uchun 2-opt reverse
function uncrossPass(arr: PlanShop[]): boolean {
  const n = arr.length;
  if (n < 4) return false;
  const refLat = arr.reduce((s, p) => s + p.lat, 0) / n;
  let fixed = false;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 2; j < n - 1; j++) {
      if (properCross(arr[i], arr[i + 1], arr[j], arr[j + 1], refLat)) {
        let lo = i + 1, hi = j;
        while (lo < hi) {
          const t = arr[lo];
          arr[lo] = arr[hi];
          arr[hi] = t;
          lo++;
          hi--;
        }
        fixed = true;
      }
    }
  }
  return fixed;
}

// To'liq lokal optimallash: 2-opt + Or-opt konvergensiyagacha, keyin uncross-loop
function optimizeOrder(stops: PlanShop[]): PlanShop[] {
  const arr = [...stops];
  if (arr.length < 3) return arr;
  for (let iter = 0; iter < 60; iter++) {
    const imp2 = twoOptPass(arr);
    const impOr = orOptPass(arr);
    if (!imp2 && !impOr) break;
  }
  // Avto qayta-optimallash: kesishish qolgan bo'lsa — uncross + yana lokal qidiruv
  for (let iter = 0; iter < 12; iter++) {
    if (countCrossings(arr) === 0) break;
    if (!uncrossPass(arr)) break;
    for (let k = 0; k < 30; k++) {
      const imp2 = twoOptPass(arr);
      const impOr = orOptPass(arr);
      if (!imp2 && !impOr) break;
    }
  }
  return arr;
}

// Multi-start: bir nechta deterministik boshlanish nuqtasidan eng yaxshisi
// (avval kesishishlar soni, keyin masofa bo'yicha)
function orderCluster(shops: PlanShop[], startPoint?: GeoPt): PlanShop[] {
  if (shops.length <= 2) {
    const arr = [...shops];
    return startPoint ? orientTowardStart(arr, startPoint) : arr;
  }
  const cLat = shops.reduce((s, p) => s + p.lat, 0) / shops.length;
  const cLng = shops.reduce((s, p) => s + p.lng, 0) / shops.length;
  const idxBy = (fn: (s: PlanShop) => number, min: boolean) => {
    let bi = 0;
    let bv = min ? Infinity : -Infinity;
    shops.forEach((s, i) => {
      const v = fn(s);
      if (min ? v < bv : v > bv) {
        bv = v;
        bi = i;
      }
    });
    return bi;
  };
  const starts = new Set<number>([
    idxBy((s) => haversineKm(cLat, cLng, s.lat, s.lng), true), // markazga eng yaqin
    idxBy((s) => haversineKm(cLat, cLng, s.lat, s.lng), false), // eng chekka
    idxBy((s) => s.lng, true), // eng g'arbiy
    idxBy((s) => s.lat, false), // eng shimoliy
  ]);
  if (startPoint) {
    // Bazaga eng yaqin do'kondan boshlash ham nomzod bo'lsin
    starts.add(idxBy((s) => haversineKm(startPoint.lat, startPoint.lng, s.lat, s.lng), true));
  }
  let best: PlanShop[] | null = null;
  let bestCross = Infinity;
  let bestKm = Infinity;
  for (const st of starts) {
    const cand = optimizeOrder(nearestNeighborFrom(shops, st));
    const cross = countCrossings(cand);
    const km = pathKm(cand);
    if (cross < bestCross || (cross === bestCross && km < bestKm - 1e-9)) {
      best = cand;
      bestCross = cross;
      bestKm = km;
    }
  }
  const result = best ?? [...shops];
  return startPoint ? orientTowardStart(result, startPoint) : result;
}

// Marshrut yo'nalishini bazaga qarab to'g'rilash: birinchi to'xtash bazaga
// oxirgisidan uzoq bo'lsa — marshrut teskari aylantiriladi. Shunda agent
// kunni bazaga yaqin do'kondan boshlab, uzoqqa qarab yuradi (orqaga qaytmaydi).
function orientTowardStart(arr: PlanShop[], startPoint: GeoPt): PlanShop[] {
  if (arr.length < 2) return arr;
  const dFirst = haversineKm(startPoint.lat, startPoint.lng, arr[0].lat, arr[0].lng);
  const dLast = haversineKm(startPoint.lat, startPoint.lng, arr[arr.length - 1].lat, arr[arr.length - 1].lng);
  return dLast < dFirst ? [...arr].reverse() : arr;
}

// ── KPI hisoblash ───────────────────────────────────────────────────────────────
// Orqaga qaytish: to'xtashda burilish burchagi 120° dan katta bo'lsa, keyingi
// segment masofasi "backtrack" hisoblanadi. % = backtrackKm / totalKm.
function backtrackKm(stops: GeoPt[], refLat: number): number {
  let bk = 0;
  for (let i = 1; i < stops.length - 1; i++) {
    const a = toXY(stops[i - 1], refLat);
    const b = toXY(stops[i], refLat);
    const c = toXY(stops[i + 1], refLat);
    const v1x = b.x - a.x, v1y = b.y - a.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    const n1 = Math.hypot(v1x, v1y);
    const n2 = Math.hypot(v2x, v2y);
    if (n1 < 1e-12 || n2 < 1e-12) continue;
    const cos = (v1x * v2x + v1y * v2y) / (n1 * n2);
    if (cos < -0.5) {
      // burilish > 120° — ortga qaytish
      bk += haversineKm(stops[i].lat, stops[i].lng, stops[i + 1].lat, stops[i + 1].lng);
    }
  }
  return bk;
}

// Uzun sakrashlar: median segmentdan 4 baravar uzun VA 3 km dan katta segmentlar
function longJumpCount(stops: GeoPt[]): number {
  const n = stops.length;
  if (n < 3) return 0;
  const lens: number[] = [];
  for (let i = 1; i < n; i++) {
    lens.push(haversineKm(stops[i - 1].lat, stops[i - 1].lng, stops[i].lat, stops[i].lng));
  }
  const sorted = [...lens].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return lens.filter((l) => l > Math.max(3, median * 4)).length;
}

// Tartiblangan to'xtashlar uchun statistika — route-map/routes endpointlari ham ishlatadi
export function computeRouteStats(
  stops: { lat: number; lng: number; nomi: string | null }[],
  targetSize = 30
): RouteStats {
  const n = stops.length;
  const totalKm = pathKm(stops);
  const driveMinutes = Math.round((totalKm / 25) * 60);
  const visitMinutes = n * 5;
  const totalMinutes = driveMinutes + visitMinutes;
  const refLat = n > 0 ? stops.reduce((s, p) => s + p.lat, 0) / n : 0;
  const crossCount = countCrossings(stops);
  const bkKm = backtrackKm(stops, refLat);
  const backtrackPct = totalKm > 0 ? Math.round((bkKm / totalKm) * 100) : 0;
  const longJumps = longJumpCount(stops);
  // Segment (hop) statistikasi
  let maxHop = 0;
  for (let i = 1; i < n; i++) {
    const d = haversineKm(stops[i - 1].lat, stops[i - 1].lng, stops[i].lat, stops[i].lng);
    if (d > maxHop) maxHop = d;
  }
  const avgHop = n > 1 ? totalKm / (n - 1) : 0;
  // Samaradorlik: 100 dan kesishish/orqaga qaytish/sakrash jarimalari ayiriladi
  const efficiency = Math.max(0, Math.min(100, Math.round(100 - backtrackPct - 10 * crossCount - 4 * longJumps)));
  // AI Route Score: samaradorlik + zichlik (o'rtacha hop) + hajm balansi
  const score = Math.max(
    0,
    Math.min(100, Math.round(efficiency - 15 * Math.max(0, avgHop - 0.8) - 2 * Math.abs(n - targetSize)))
  );
  return {
    shopCount: n,
    totalKm: Math.round(totalKm * 10) / 10,
    driveMinutes,
    visitMinutes,
    totalMinutes,
    startShop: stops[0]?.nomi ?? null,
    endShop: stops[n - 1]?.nomi ?? null,
    crossCount,
    backtrackPct,
    longJumps,
    avgHopKm: Math.round(avgHop * 100) / 100,
    maxHopKm: Math.round(maxHop * 10) / 10,
    efficiency,
    score,
  };
}

// ── Validatsiya dvigateli ───────────────────────────────────────────────────────
// Saqlashdan oldin har bir reja avtomatik tekshiriladi. Muammo topilsa
// planRoutes ichidagi uncross-loop allaqachon qayta-optimallashtirgan bo'ladi;
// shunga qaramay qolgan strukturaviy xatolar saqlashni bloklaydi.
export type PlanValidation = {
  ok: boolean; // saqlash mumkinmi
  issues: string[]; // strukturaviy xatolar (saqlashni bloklaydi)
  warnings: string[]; // sifat ogohlantirishlari (saqlash mumkin, lekin ko'rsatiladi)
  // forceable: barcha blocking issues faqat crossing bilan bog'liq bo'lsa true —
  // bu holda force=true bilan saqlash mumkin (boshqa xatolar yo'q)
  forceable: boolean;
};

export function validatePlan(plan: PlanResult, inputShops: PlanShop[]): PlanValidation {
  const issues: string[] = [];
  const warnings: string[] = [];

  // 1. Dublikat / yo'qolgan do'konlar
  const seen = new Map<number, number>();
  for (const r of plan.routes) {
    for (const st of r.stops) {
      seen.set(st.id, (seen.get(st.id) ?? 0) + 1);
    }
  }
  const dups = [...seen.entries()].filter(([, c]) => c > 1);
  if (dups.length > 0) {
    issues.push(`${dups.length} ta do'kon bir nechta marshrutga tushgan (dublikat)`);
  }
  const missing = inputShops.filter((s) => !seen.has(s.id));
  if (missing.length > 0) {
    issues.push(`${missing.length} ta do'kon hech bir marshrutga kirmagan`);
  }

  // 2. Tartib ketma-ketligi (1..N uzilishsiz)
  for (const r of plan.routes) {
    const bad = r.stops.some((st, i) => st.tartib !== i + 1);
    if (bad) issues.push(`kun=${r.kun} marshrutida tartib raqamlari uzilgan`);
  }

  // 3. Sifat tekshiruvlari
  const crossingIssues: string[] = [];
  for (const r of plan.routes) {
    if (r.stats.crossCount > 0) {
      const msg = `kun=${r.kun}: ${r.stats.crossCount} ta kesishish qoldi (qayta-optimallash yordam bermadi)`;
      issues.push(msg);
      crossingIssues.push(msg);
    }
    if (r.stats.longJumps > 0) {
      warnings.push(`kun=${r.kun}: ${r.stats.longJumps} ta uzun sakrash (tarqoq hudud bo'lishi mumkin)`);
    }
    if (r.stats.score < 50) {
      warnings.push(`kun=${r.kun}: score past (${r.stats.score}) — hudud juda tarqoq`);
    }
  }

  // forceable: saqlashni bloklayan BARCHA xatolar faqat crossing bilan bog'liq bo'lsa —
  // boshqa agent force=true bilan saqlay oladi
  const forceable = issues.length > 0 && issues.length === crossingIssues.length;

  return { ok: issues.length === 0, issues, warnings, forceable };
}

export type PlanOptions = {
  days?: number[]; // standart: [1,2,3,4,6,7] — juma (5) dam kuni
  targetSize?: number; // standart: 30
  minSize?: number; // ma'lumot uchun (balans base/base+1 bilan ta'minlanadi)
  maxSize?: number;
  // Agent kunni boshlaydigan nuqta (baza/ombor). Berilsa, har kun marshruti
  // bazaga YAQIN do'kondan boshlanib, uzoqqa qarab ketadi (teskari emas).
  startPoint?: { lat: number; lng: number };
  // Biznes ustuvorligi: do'konda biz? ma'lumotlari bo'lsa, nasiya/savdo/tashrif
  // asosida klasterlarni kunlarga va kun ichidagi tartibni ustuvorlik bilan belgilaydi.
  businessPriority?: boolean;
  // Biznes ballari vaznlari (nasiya/tashrif/savdo) — berilmasa DEFAULT_BIZ_WEIGHTS
  bizWeights?: Partial<BizWeights> | null;
};

// Agentlar kunni boshlaydigan baza: Dang'ara, Farg'ona viloyati
export const DEFAULT_START_POINT = { lat: 40.5786, lng: 70.9203 };

// ── Biznes ustuvorlik ballari ────────────────────────────────────────────────────

type BizEntry = { score: number; reasons: string[] };
type BizScoreMap = Map<number, BizEntry>;

function fmtUzs(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M so'm`;
  if (amount >= 1_000) return `${Math.round(amount / 1_000)}K so'm`;
  return `${Math.round(amount)} so'm`;
}

// Biznes ustuvorlik vaznlari (foizlarda, jami 100 bo'lishi shart emas — normalizatsiya qilinadi)
export type BizWeights = {
  credit: number; // nasiya balansi
  days: number;   // oxirgi tashrifdan o'tgan kunlar
  sales: number;  // savdo hajmi
};

export const DEFAULT_BIZ_WEIGHTS: BizWeights = { credit: 40, days: 35, sales: 25 };

// Har qanday manfiy bo'lmagan vaznlarni jami 100 ga normalizatsiya qiladi.
// Noto'g'ri (manfiy/NaN/jami 0) bo'lsa — default qaytadi.
export function normalizeBizWeights(w?: Partial<BizWeights> | null): BizWeights {
  if (!w) return DEFAULT_BIZ_WEIGHTS;
  const credit = Number(w.credit);
  const days = Number(w.days);
  const sales = Number(w.sales);
  if (![credit, days, sales].every((v) => Number.isFinite(v) && v >= 0)) return DEFAULT_BIZ_WEIGHTS;
  const sum = credit + days + sales;
  if (sum <= 0) return DEFAULT_BIZ_WEIGHTS;
  return {
    credit: (credit / sum) * 100,
    days: (days / sum) * 100,
    sales: (sales / sum) * 100,
  };
}

// Har do'kon uchun biznes bali (0-100) va sabablar ro'yxatini hisoblaydi.
// Signallar (default): nasiya balansi (40%), oxirgi tashrifdan kunlar (35%), savdo hajmi (25%).
// weights parametri orqali sessiyaga mos vaznlar berilishi mumkin.
export function computeBusinessScores(shops: PlanShop[], weights?: Partial<BizWeights> | null): BizScoreMap {
  const w = normalizeBizWeights(weights);
  const result: BizScoreMap = new Map();
  let maxSales = 0, maxCredit = 0, maxDays = 0;
  for (const s of shops) {
    if (!s.biz) continue;
    maxSales = Math.max(maxSales, s.biz.salesSum ?? 0);
    maxCredit = Math.max(maxCredit, s.biz.creditBalance ?? 0);
    maxDays = Math.max(maxDays, s.biz.daysSinceVisit ?? 0);
  }
  if (maxSales === 0 && maxCredit === 0 && maxDays === 0) return result;

  for (const s of shops) {
    const biz = s.biz;
    if (!biz) {
      result.set(s.id, { score: 0, reasons: [] });
      continue;
    }
    const salesNorm  = maxSales  > 0 ? (biz.salesSum       ?? 0) / maxSales  : 0;
    const creditNorm = maxCredit > 0 ? (biz.creditBalance   ?? 0) / maxCredit : 0;
    const daysNorm   = maxDays   > 0 ? (biz.daysSinceVisit  ?? 0) / maxDays   : 0;

    const score = Math.min(100, Math.round(creditNorm * w.credit + daysNorm * w.days + salesNorm * w.sales));
    const reasons: string[] = [];
    if (salesNorm >= 0.7) reasons.push("VIP");
    if ((biz.creditBalance ?? 0) > 0) reasons.push(`Nasiya: ${fmtUzs(biz.creditBalance!)}`);
    if ((biz.daysSinceVisit ?? 0) > 14) reasons.push(`${biz.daysSinceVisit} kun bormagan`);

    result.set(s.id, { score, reasons });
  }
  return result;
}

// Geo-optimal (kesishishsiz) tartibdan so'ng yuqori prioritetli do'konlarni
// oldinga "tortish". Faqat kesishish paydo qilmaydigan siljishlar qabul qilinadi,
// shuning uchun yakuniy reja albatta kesishishsiz bo'ladi.
//
// Algoritm: balllar bo'yicha kamayish tartibida (eng muhim avval) har bir
// yuqori prioritetli do'kon uchun mumkin bo'lgan eng oldingi pozitsiyani izlaymiz.
// Agar siljish kesishish keltirmasa — qabul qilinadi; aks holda do'kon joyida qoladi.
export function priorityPullForward(geoOrdered: PlanShop[], bizScores: BizScoreMap): PlanShop[] {
  if (geoOrdered.length <= 2 || bizScores.size === 0) return geoOrdered;
  const hasAny = geoOrdered.some((s) => (bizScores.get(s.id)?.score ?? 0) > 0);
  if (!hasAny) return geoOrdered;

  const result = [...geoOrdered];

  // Yuqori prioritetli do'konlar (ball >= 50) — eng muhimidan boshlash
  const highPriority = geoOrdered
    .map((s) => ({ id: s.id, score: bizScores.get(s.id)?.score ?? 0 }))
    .filter((x) => x.score >= 50)
    .sort((a, b) => b.score - a.score);

  for (const { id } of highPriority) {
    const curIdx = result.findIndex((s) => s.id === id);
    if (curIdx <= 0) continue; // Allaqachon boshida

    // Eng oldingi kesishishsiz pozitsiyani izlaymiz
    for (let j = 0; j < curIdx; j++) {
      // j-pozitsiyaga siljishni sinab ko'ramiz
      const trial = [...result];
      trial.splice(curIdx, 1);
      trial.splice(j, 0, result[curIdx]);
      if (countCrossings(trial) === 0) {
        // Kesishishsiz — qabul qilamiz
        const shop = result.splice(curIdx, 1)[0];
        result.splice(j, 0, shop);
        break;
      }
    }
    // Agar hech bir pozitsiya kesishishsiz bo'lmasa — do'kon joyida qoladi
  }

  return result;
}

// Klaster uchun biznes statistikasi
function clusterBizSummary(cl: PlanShop[], bizScores: BizScoreMap): RouteBizSummary {
  let totalCredit = 0;
  let highPriority = 0;
  let scoreSum = 0;
  for (const s of cl) {
    const entry = bizScores.get(s.id);
    const score = entry?.score ?? 0;
    scoreSum += score;
    if (score >= 60) highPriority++;
    totalCredit += s.biz?.creditBalance ?? 0;
  }
  return {
    avgBizScore: cl.length > 0 ? Math.round(scoreSum / cl.length) : 0,
    highPriorityCount: highPriority,
    totalCreditBalance: totalCredit,
  };
}

// Shubhali (anomal) koordinatali do'konlarni ajratish: mintaqa medianidan
// maxKm dan uzoq nuqtalar — GPS xatosi ehtimoli katta (masalan, Namangan
// do'koni Toshkent koordinatasi bilan saqlangan). Ular rejaga kiritilmaydi,
// alohida ro'yxatda qaytariladi — foydalanuvchi koordinatani to'g'rilashi kerak.
export function splitOutliers(shops: PlanShop[], maxKm = 60): { inliers: PlanShop[]; outliers: PlanShop[] } {
  if (shops.length < 3) return { inliers: [...shops], outliers: [] };
  const lats = shops.map((s) => s.lat).sort((a, b) => a - b);
  const lngs = shops.map((s) => s.lng).sort((a, b) => a - b);
  const mLat = lats[Math.floor(lats.length / 2)];
  const mLng = lngs[Math.floor(lngs.length / 2)];
  const inliers: PlanShop[] = [];
  const outliers: PlanShop[] = [];
  for (const s of shops) {
    (haversineKm(mLat, mLng, s.lat, s.lng) <= maxKm ? inliers : outliers).push(s);
  }
  return { inliers, outliers };
}

// ── Hududiy bo'lish (territory split) ──────────────────────────────────────────
// Do'konlarni N ta agent o'rtasida GEOGRAFIK ZICH zonalarga bo'ladi.
// caps[i] — i-zona sig'imi (masalan [180, 81]). Sig'imlar yig'indisi
// do'konlar soniga teng bo'lishi shart. Xuddi planRoutes'dagi kabi
// muvozanatli k-means + swap-refine ishlatiladi — zonalar bir-biriga
// kirib ketmaydi, umumiy yurish masofasi kamayadi.
export function splitTerritories(shops: PlanShop[], caps: number[]): PlanShop[][] {
  const k = caps.length;
  const total = caps.reduce((s, c) => s + c, 0);
  if (total !== shops.length) {
    throw new Error(`splitTerritories: caps yig'indisi (${total}) do'konlar soniga (${shops.length}) teng emas`);
  }
  if (k === 1) return [[...shops]];
  const stable = [...shops].sort((a, b) => a.id - b.id);
  let centers = farthestPointInit(stable, k);
  let assign: number[] = [];
  for (let iter = 0; iter < 40; iter++) {
    const next = balancedAssign(stable, centers, caps);
    if (assign.length > 0 && next.every((v, i) => v === assign[i])) break;
    assign = next;
    centers = centers.map((c, ci) => {
      const members = stable.filter((_, i) => assign[i] === ci);
      if (members.length === 0) return c;
      return {
        lat: members.reduce((s, m) => s + m.lat, 0) / members.length,
        lng: members.reduce((s, m) => s + m.lng, 0) / members.length,
      };
    });
  }
  const zones: PlanShop[][] = Array.from({ length: k }, () => []);
  stable.forEach((s, i) => zones[assign[i]].push(s));
  refineClustersBySwapCapped(zones);
  return zones;
}

// Swap-refine, hajmlar o'zgarmaydi — splitTerritories uchun ham ishlatiladi
function refineClustersBySwapCapped(clusters: PlanShop[][]): void {
  refineClustersBySwap(clusters);
}

// Uzoqdagi nuqtadan boshlab markazlarni tanlash (farthest-point init) — deterministik
function farthestPointInit(shops: PlanShop[], k: number): GeoPt[] {
  const cLat = shops.reduce((s, p) => s + p.lat, 0) / shops.length;
  const cLng = shops.reduce((s, p) => s + p.lng, 0) / shops.length;
  let firstIdx = 0;
  let firstBest = -1;
  for (let i = 0; i < shops.length; i++) {
    const d = haversineKm(cLat, cLng, shops[i].lat, shops[i].lng);
    if (d > firstBest) {
      firstBest = d;
      firstIdx = i;
    }
  }
  const centers = [{ lat: shops[firstIdx].lat, lng: shops[firstIdx].lng }];
  while (centers.length < k) {
    let bi = 0;
    let bd = -1;
    for (let i = 0; i < shops.length; i++) {
      let dMin = Infinity;
      for (const c of centers) {
        const d = haversineKm(c.lat, c.lng, shops[i].lat, shops[i].lng);
        if (d < dMin) dMin = d;
      }
      if (dMin > bd) {
        bd = dMin;
        bi = i;
      }
    }
    centers.push({ lat: shops[bi].lat, lng: shops[bi].lng });
  }
  return centers;
}

// Sig'imli (muvozanatli) biriktirish: har do'kon eng yaqin BO'SH markazga.
// "Regret" (eng yaqin va 2-eng yaqin markaz farqi) katta do'konlar avval
// biriktiriladi — ular uchun noto'g'ri markaz eng qimmatga tushadi.
function balancedAssign(shops: PlanShop[], centers: GeoPt[], caps: number[]): number[] {
  const k = centers.length;
  const order = shops
    .map((s, idx) => {
      const ds = centers.map((c) => haversineKm(c.lat, c.lng, s.lat, s.lng));
      const sorted = [...ds].sort((a, b) => a - b);
      const regret = (sorted[1] ?? sorted[0]) - sorted[0];
      return { idx, ds, regret };
    })
    .sort((a, b) => b.regret - a.regret || a.idx - b.idx);

  const assign = new Array<number>(shops.length).fill(-1);
  const used = new Array<number>(k).fill(0);
  for (const o of order) {
    let best = -1;
    let bd = Infinity;
    for (let c = 0; c < k; c++) {
      if (used[c] >= caps[c]) continue;
      if (o.ds[c] < bd) {
        bd = o.ds[c];
        best = c;
      }
    }
    assign[o.idx] = best;
    used[best]++;
  }
  return assign;
}

// Klaster chegaralarini yaxshilash: ikki klasterdagi do'konlarni almashtirish
// umumiy markaz-masofani kamaytirsa — swap (hajmlar o'zgarmaydi, hududiy
// yaxlitlik oshadi, klasterlar bir-biriga "kirib ketishi" kamayadi)
function refineClustersBySwap(clusters: PlanShop[][], maxPasses = 8): void {
  const centroid = (cl: PlanShop[]): GeoPt => ({
    lat: cl.reduce((s, m) => s + m.lat, 0) / (cl.length || 1),
    lng: cl.reduce((s, m) => s + m.lng, 0) / (cl.length || 1),
  });
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    const cents = clusters.map(centroid);
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        for (let i = 0; i < clusters[a].length; i++) {
          for (let j = 0; j < clusters[b].length; j++) {
            const sa = clusters[a][i];
            const sb = clusters[b][j];
            const cur =
              haversineKm(sa.lat, sa.lng, cents[a].lat, cents[a].lng) +
              haversineKm(sb.lat, sb.lng, cents[b].lat, cents[b].lng);
            const alt =
              haversineKm(sa.lat, sa.lng, cents[b].lat, cents[b].lng) +
              haversineKm(sb.lat, sb.lng, cents[a].lat, cents[a].lng);
            if (alt + 1e-9 < cur) {
              clusters[a][i] = sb;
              clusters[b][j] = sa;
              cents[a] = centroid(clusters[a]);
              cents[b] = centroid(clusters[b]);
              improved = true;
            }
          }
        }
      }
    }
    if (!improved) break;
  }
}

// Asosiy rejalashtirish funksiyasi — to'liq deterministik
export function planRoutes(shops: PlanShop[], opts: PlanOptions = {}): PlanResult {
  const days = opts.days ?? [1, 2, 3, 4, 6, 7];
  const targetSize = opts.targetSize ?? 30;

  if (shops.length === 0) {
    return { routes: [], totalShops: 0, totalKm: 0, avgScore: 0 };
  }

  // Nechta marshrut kerak: kunlik limit (targetSize) oshmasligi uchun CEIL —
  // masalan 56 do'kon / 25 = 3 kun (19+19+18), 2 kun (28+28) EMAS.
  // Kunlar sonidan oshmaydi; do'kon > days*targetSize bo'lsa limit oshishi mumkin.
  const k = Math.max(1, Math.min(days.length, Math.ceil(shops.length / targetSize)));

  // Sig'imlar: base yoki base+1 — hajmlar muvozanatli bo'ladi
  const base = Math.floor(shops.length / k);
  const extra = shops.length % k;
  const caps = Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));

  // 1. Muvozanatli k-means: farthest-point init + sig'imli biriktirish + markaz yangilash.
  const stable = [...shops].sort((a, b) => a.id - b.id);
  let centers = farthestPointInit(stable, k);
  let assign: number[] = [];
  for (let iter = 0; iter < 40; iter++) {
    const next = balancedAssign(stable, centers, caps);
    if (assign.length > 0 && next.every((v, i) => v === assign[i])) break;
    assign = next;
    centers = centers.map((c, ci) => {
      const members = stable.filter((_, i) => assign[i] === ci);
      if (members.length === 0) return c;
      return {
        lat: members.reduce((s, m) => s + m.lat, 0) / members.length,
        lng: members.reduce((s, m) => s + m.lng, 0) / members.length,
      };
    });
  }

  const clusters: PlanShop[][] = Array.from({ length: k }, () => []);
  stable.forEach((s, i) => clusters[assign[i]].push(s));

  // 2. Chegaralarni swap bilan yaxshilash — hududiy yaxlitlik
  refineClustersBySwap(clusters);

  // Biznes signallari mavjud bo'lsa — ballar hisoblanadi
  const bizActive = opts.businessPriority === true;
  const bizScores: BizScoreMap = bizActive ? computeBusinessScores(shops, opts.bizWeights) : new Map();

  // 3. Klasterlarni kunlarga biriktirish
  //    • Biznes ustuvorligi yoqilgan: eng yuqori o'rtacha bal → birinchi kun (dushanba)
  //    • Aks holda: markaz burchagi bo'yicha (qo'shni hududlar ketma-ket kunlarga tushadi)
  const gLat = stable.reduce((s, p) => s + p.lat, 0) / stable.length;
  const gLng = stable.reduce((s, p) => s + p.lng, 0) / stable.length;
  const clusterOrder = clusters
    .map((cl, i) => {
      const mLat = cl.reduce((s, m) => s + m.lat, 0) / (cl.length || 1);
      const mLng = cl.reduce((s, m) => s + m.lng, 0) / (cl.length || 1);
      const angle = Math.atan2(mLat - gLat, mLng - gLng);
      const avgBiz = bizActive && bizScores.size > 0
        ? cl.reduce((s, sh) => s + (bizScores.get(sh.id)?.score ?? 0), 0) / (cl.length || 1)
        : 0;
      return { i, angle, avgBiz };
    });

  if (bizActive && bizScores.size > 0) {
    // Yuqori prioritetli klaster birinchi kun (ustuvorlik bo'yicha kamayish tartibida)
    clusterOrder.sort((a, b) => b.avgBiz - a.avgBiz || a.i - b.i);
  } else {
    // Geografik ketma-ketlik (qo'shni hududlar bir-birining yonida bo'lsin)
    clusterOrder.sort((a, b) => a.angle - b.angle || a.i - b.i);
  }

  // 4. Har klaster ichida multi-start NN + 2-opt/Or-opt + uncross, keyin biznes blend
  const routes: PlannedRoute[] = clusterOrder.map((co, i) => {
    const geoOrdered = orderCluster(clusters[co.i], opts.startPoint);
    // Biznes ustuvorligi: yuqori prioritetli do'konlarni kesishishsiz siljitish
    const ordered = bizActive && bizScores.size > 0
      ? priorityPullForward(geoOrdered, bizScores)
      : geoOrdered;
    const stops: PlannedStop[] = ordered.map((s, idx) => {
      const entry = bizScores.get(s.id);
      return {
        ...s,
        tartib: idx + 1,
        ...(bizActive && entry ? { bizScore: entry.score, bizReasons: entry.reasons } : {}),
      };
    });
    const bizSummary = bizActive && bizScores.size > 0
      ? clusterBizSummary(clusters[co.i], bizScores)
      : undefined;
    return { kun: days[i], stops, stats: computeRouteStats(ordered, targetSize), bizSummary };
  });

  const totalKm = Math.round(routes.reduce((s, r) => s + r.stats.totalKm, 0) * 10) / 10;
  const avgScore = routes.length > 0 ? Math.round(routes.reduce((s, r) => s + r.stats.score, 0) / routes.length) : 0;

  return {
    routes,
    totalShops: shops.length,
    totalKm,
    avgScore,
    businessPriorityActive: bizActive && bizScores.size > 0,
  };
}
