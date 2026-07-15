// ── AI marshrut rejalashtiruvchi ────────────────────────────────────────────────
// Deterministik geo-algoritm (LLM ishlatilmaydi):
//   1. Global markaz atrofida qutb burchagi bo'yicha saralash (sweep)
//   2. Eng katta burchak bo'shlig'idan boshlab k ta ketma-ket sektorga bo'lish
//      (qo'shni do'konlar — mahalla/ko'cha — bir sektorda qoladi)
//   3. Har sektor ichida tashrif tartibi: eng yaqin qo'shni (NN) + 2-opt
//   4. Sektorlar burchak tartibida hafta kunlariga biriktiriladi
// Hammasi haversine (havo chizig'i) asosida — yo'l tarmog'i ishlatilmaydi.

export type PlanShop = {
  id: number;
  nomi: string | null;
  hudud: string | null;
  lat: number;
  lng: number;
};

export type PlannedStop = PlanShop & { tartib: number };

export type RouteStats = {
  shopCount: number;
  totalKm: number;
  driveMinutes: number;
  startShop: string | null;
  endShop: string | null;
  score: number;
};

export type PlannedRoute = {
  kun: number;
  stops: PlannedStop[];
  stats: RouteStats;
};

export type PlanResult = {
  routes: PlannedRoute[];
  totalShops: number;
  totalKm: number;
  avgScore: number;
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

// Eng yaqin qo'shni (nearest neighbor) — sektor markaziga eng yaqin do'kondan boshlaymiz
function nearestNeighborOrder(shops: PlanShop[]): PlanShop[] {
  if (shops.length <= 2) return [...shops];
  const cLat = shops.reduce((s, p) => s + p.lat, 0) / shops.length;
  const cLng = shops.reduce((s, p) => s + p.lng, 0) / shops.length;
  let startIdx = 0;
  let best = Infinity;
  for (let i = 0; i < shops.length; i++) {
    const d = haversineKm(cLat, cLng, shops[i].lat, shops[i].lng);
    if (d < best) {
      best = d;
      startIdx = i;
    }
  }
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

// 2-opt: kesishgan segmentlarni to'g'rilaydi (zig-zag va ortga qaytishni kamaytiradi)
function twoOpt(stops: PlanShop[], maxPasses = 20): PlanShop[] {
  if (stops.length < 4) return [...stops];
  const arr = [...stops];
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (let i = 0; i < arr.length - 2; i++) {
      for (let j = i + 2; j < arr.length - 1; j++) {
        const a = arr[i], b = arr[i + 1], c = arr[j], d = arr[j + 1];
        const cur = haversineKm(a.lat, a.lng, b.lat, b.lng) + haversineKm(c.lat, c.lng, d.lat, d.lng);
        const alt = haversineKm(a.lat, a.lng, c.lat, c.lng) + haversineKm(b.lat, b.lng, d.lat, d.lng);
        if (alt + 1e-9 < cur) {
          // i+1..j oralig'ini teskari qilamiz
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
    if (!improved) break;
  }
  return arr;
}

// Tartiblangan to'xtashlar uchun statistika — route-map/routes endpointlari ham ishlatadi
export function computeRouteStats(
  stops: { lat: number; lng: number; nomi: string | null }[],
  targetSize = 25
): RouteStats {
  let totalKm = 0;
  for (let i = 1; i < stops.length; i++) {
    totalKm += haversineKm(stops[i - 1].lat, stops[i - 1].lng, stops[i].lat, stops[i].lng);
  }
  const n = stops.length;
  const driveMinutes = Math.round((totalKm / 25) * 60 + n * 5);
  const kmPerStop = n > 0 ? totalKm / n : 0;
  const score = Math.max(0, Math.min(100, Math.round(100 - 15 * Math.max(0, kmPerStop - 0.8) - 2 * Math.abs(n - targetSize))));
  return {
    shopCount: n,
    totalKm: Math.round(totalKm * 10) / 10,
    driveMinutes,
    startShop: stops[0]?.nomi ?? null,
    endShop: stops[n - 1]?.nomi ?? null,
    score,
  };
}

export type PlanOptions = {
  days?: number[]; // standart: [1,2,3,4,6,7] — juma (5) dam kuni
  targetSize?: number; // standart: 25
  minSize?: number; // ma'lumot uchun (balans base/base+1 bilan ta'minlanadi)
  maxSize?: number;
};

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

// Uzoqdagi nuqtadan boshlab markazlarni tanlash (farthest-point init) — deterministik
function farthestPointInit(shops: PlanShop[], k: number): { lat: number; lng: number }[] {
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
function balancedAssign(shops: PlanShop[], centers: { lat: number; lng: number }[], caps: number[]): number[] {
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

// Asosiy rejalashtirish funksiyasi — to'liq deterministik
export function planRoutes(shops: PlanShop[], opts: PlanOptions = {}): PlanResult {
  const days = opts.days ?? [1, 2, 3, 4, 6, 7];
  const targetSize = opts.targetSize ?? 25;

  if (shops.length === 0) {
    return { routes: [], totalShops: 0, totalKm: 0, avgScore: 0 };
  }

  // Nechta marshrut kerak: maqsad ~targetSize, lekin kunlar sonidan oshmaydi
  const k = Math.max(1, Math.min(days.length, Math.round(shops.length / targetSize) || 1));

  // Sig'imlar: base yoki base+1 — hajmlar muvozanatli bo'ladi
  const base = Math.floor(shops.length / k);
  const extra = shops.length % k;
  const caps = Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));

  // 1. Muvozanatli k-means: farthest-point init + sig'imli biriktirish + markaz yangilash.
  //    Uzoq tumanlardagi do'konlar o'z klasterida qoladi (sweep'dan farqli).
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

  // 2. Klasterlarni markaz burchagi bo'yicha tartiblab kunlarga biriktiramiz
  //    (qo'shni hududlar ketma-ket kunlarga tushadi)
  const gLat = stable.reduce((s, p) => s + p.lat, 0) / stable.length;
  const gLng = stable.reduce((s, p) => s + p.lng, 0) / stable.length;
  const clusterOrder = clusters
    .map((cl, i) => {
      const mLat = cl.reduce((s, m) => s + m.lat, 0) / (cl.length || 1);
      const mLng = cl.reduce((s, m) => s + m.lng, 0) / (cl.length || 1);
      return { i, angle: Math.atan2(mLat - gLat, mLng - gLng) };
    })
    .sort((a, b) => a.angle - b.angle || a.i - b.i);

  // 3. Har klaster ichida NN + 2-opt, keyin kunlarga biriktirish
  const routes: PlannedRoute[] = clusterOrder.map((co, i) => {
    const ordered = twoOpt(nearestNeighborOrder(clusters[co.i]));
    const stops: PlannedStop[] = ordered.map((s, idx) => ({ ...s, tartib: idx + 1 }));
    return { kun: days[i], stops, stats: computeRouteStats(ordered, targetSize) };
  });

  const totalKm = Math.round(routes.reduce((s, r) => s + r.stats.totalKm, 0) * 10) / 10;
  const avgScore = routes.length > 0 ? Math.round(routes.reduce((s, r) => s + r.stats.score, 0) / routes.length) : 0;

  return { routes, totalShops: shops.length, totalKm, avgScore };
}
