// Shared USD→UZS exchange-rate helper (cbu.uz) with in-memory cache + stale/fallback.
// Used by the /exchange-rate route and server-side cost/profit calculations so that
// raw-material costs entered in USD are converted to a *current* UZS equivalent.

interface RateCache {
  rate: number;
  date: string;
  fetchedAt: number;
}

let cache: RateCache | null = null;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
// Last-resort value used only when cbu.uz has never been reachable in this process.
const FALLBACK_RATE = 12650;

export interface RateResult {
  rate: number;
  date: string;
  source: "cbu.uz" | "fallback";
  cached: boolean;
  stale: boolean;
}

export async function getUsdToUzsRate(): Promise<RateResult> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL) {
    return { rate: cache.rate, date: cache.date, source: "cbu.uz", cached: true, stale: false };
  }

  try {
    const r = await fetch("https://cbu.uz/uz/arkhiv-kursov-valyut/json/USD/", {
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error(`CBU API ${r.status}`);

    const data = (await r.json()) as Array<{ Rate: string; Date: string }>;
    const rate = parseFloat(data[0].Rate);
    const date = data[0].Date;

    cache = { rate, date, fetchedAt: now };
    return { rate, date, source: "cbu.uz", cached: false, stale: false };
  } catch {
    if (cache) {
      return { rate: cache.rate, date: cache.date, source: "cbu.uz", cached: true, stale: true };
    }
    return { rate: FALLBACK_RATE, date: "", source: "fallback", cached: false, stale: true };
  }
}
