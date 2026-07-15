import { openFieldDb, metaGet, metaSet } from "./idb";

// T006 — Leaflet xarita plitkalarini IndexedDB'da keshlash.
// Cache-first: plitka avval lokal bazadan olinadi (tez + offline ishlaydi),
// topilmasa tarmoqdan yuklab keshga qo'shiladi. Service Worker YO'Q.

export const TILE_URL_TEMPLATE = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

// LRU chegara: ~3000 plitka × ~15KB ≈ 45MB (spec: 50MB gacha)
const MAX_TILES = 3000;
const PREFETCH_MAX_TILES = 700; // bir yurishda ko'pi bilan shuncha yuklaymiz
const PREFETCH_ZOOMS = [12, 13, 14, 15];

export async function getCachedTile(key: string): Promise<Blob | undefined> {
  try {
    const db = await openFieldDb();
    const row = await db.get("tiles", key);
    if (row) {
      // LRU "touch" — fonda, kutmasdan
      void db.put("tiles", { ...row, savedAt: Date.now() }).catch(() => {});
      return row.blob;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// Oddiy aylantirish/zoom paytida ham LRU chegarasi saqlanishi uchun har
// N ta yozuvdan keyin fonda tozalash ishga tushadi (faqat prefetch emas).
let savesSincePrune = 0;
const PRUNE_EVERY_N_SAVES = 50;

export async function saveTile(key: string, blob: Blob): Promise<void> {
  try {
    const db = await openFieldDb();
    await db.put("tiles", { key, blob, savedAt: Date.now() });
    savesSincePrune++;
    if (savesSincePrune >= PRUNE_EVERY_N_SAVES) {
      savesSincePrune = 0;
      void pruneTiles();
    }
  } catch {
    // kesh to'lib qolsa yoki IDB ishlamasa — xarita baribir onlayn ishlaydi
  }
}

/** Eng eski plitkalarni o'chirib, keshni MAX_TILES chegarasida ushlaymiz. */
export async function pruneTiles(): Promise<void> {
  try {
    const db = await openFieldDb();
    const count = await db.count("tiles");
    if (count <= MAX_TILES) return;
    const all = await db.getAll("tiles");
    all.sort((a, b) => a.savedAt - b.savedAt);
    const toDelete = all.slice(0, count - MAX_TILES);
    const tx = db.transaction("tiles", "readwrite");
    for (const row of toDelete) void tx.store.delete(row.key);
    await tx.done;
  } catch {
    // tozalash muvaffaqiyatsiz bo'lsa keyingi safar yana uriniladi
  }
}

// --- Marshrut hududini oldindan yuklab olish (prefetch) ---

function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}

function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z),
  );
}

function tileUrl(z: number, x: number, y: number): string {
  const s = ["a", "b", "c"][(x + y) % 3];
  return TILE_URL_TEMPLATE.replace("{s}", s)
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}

export interface LatLonPoint {
  lat: number;
  lon: number;
}

let prefetchRunning = false;

/** Bugungi marshrut atrofidagi plitkalarni oldindan yuklab qo'yadi.
 *  Kuniga bir marta (marshrut nuqtalari o'zgarmagan bo'lsa) ishlaydi. */
export async function prefetchRouteTiles(points: LatLonPoint[]): Promise<void> {
  if (prefetchRunning) return;
  if (typeof navigator !== "undefined" && !navigator.onLine) return;
  const pts = points.filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.lat !== 0 && p.lon !== 0,
  );
  if (pts.length === 0) return;

  // Kuniga bir marta — bbox + sana imzosi bilan
  const lats = pts.map((p) => p.lat);
  const lons = pts.map((p) => p.lon);
  const pad = 0.02; // ~2km atrof
  const minLat = Math.min(...lats) - pad;
  const maxLat = Math.max(...lats) + pad;
  const minLon = Math.min(...lons) - pad;
  const maxLon = Math.max(...lons) + pad;
  const today = new Date().toISOString().slice(0, 10);
  const signature = `${today}:${minLat.toFixed(3)},${minLon.toFixed(3)},${maxLat.toFixed(3)},${maxLon.toFixed(3)}`;
  const prev = await metaGet<string>("tilesPrefetched");
  if (prev === signature) return;

  prefetchRunning = true;
  try {
    const db = await openFieldDb();
    const jobs: { key: string; url: string }[] = [];

    for (const z of PREFETCH_ZOOMS) {
      const x1 = lonToTileX(minLon, z);
      const x2 = lonToTileX(maxLon, z);
      const y1 = latToTileY(maxLat, z); // lat teskari
      const y2 = latToTileY(minLat, z);
      for (let x = x1; x <= x2; x++) {
        for (let y = y1; y <= y2; y++) {
          jobs.push({ key: `${z}/${x}/${y}`, url: tileUrl(z, x, y) });
          if (jobs.length >= PREFETCH_MAX_TILES * 2) break;
        }
      }
    }

    // Faqat keshda yo'qlarini yuklaymiz, 4 talik guruhlar bilan
    let downloaded = 0;
    for (let i = 0; i < jobs.length && downloaded < PREFETCH_MAX_TILES; i += 4) {
      if (typeof navigator !== "undefined" && !navigator.onLine) return;
      const batch = jobs.slice(i, i + 4);
      const results = await Promise.all(
        batch.map(async (job) => {
          const existing = await db.get("tiles", job.key).catch(() => undefined);
          if (existing) return 0;
          try {
            const resp = await fetch(job.url);
            if (!resp.ok) return 0;
            const blob = await resp.blob();
            await saveTile(job.key, blob);
            return 1;
          } catch {
            return 0;
          }
        }),
      );
      downloaded += results.reduce((a: number, b: number) => a + b, 0);
    }

    await metaSet("tilesPrefetched", signature);
    await pruneTiles();
  } catch {
    // prefetch — best-effort; xarita onlaynda baribir ishlaydi
  } finally {
    prefetchRunning = false;
  }
}
