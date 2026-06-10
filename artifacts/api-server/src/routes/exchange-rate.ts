import { Router, type IRouter } from "express";

const router: IRouter = Router();

interface RateCache {
  rate: number;
  date: string;
  fetchedAt: number;
}

let cache: RateCache | null = null;
const CACHE_TTL = 30 * 60 * 1000;

router.get("/exchange-rate", async (_req, res): Promise<void> => {
  try {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL) {
      res.json({ rate: cache.rate, date: cache.date, source: "cbu.uz", cached: true });
      return;
    }

    const r = await fetch("https://cbu.uz/uz/arkhiv-kursov-valyut/json/USD/", {
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error(`CBU API ${r.status}`);

    const data = (await r.json()) as Array<{ Rate: string; Date: string }>;
    const rate = parseFloat(data[0].Rate);
    const date = data[0].Date;

    cache = { rate, date, fetchedAt: now };
    res.json({ rate, date, source: "cbu.uz", cached: false });
  } catch (e: any) {
    if (cache) {
      res.json({ rate: cache.rate, date: cache.date, source: "cbu.uz", cached: true, stale: true });
    } else {
      res.status(503).json({ error: "Kurs ma'lumotini olishda xato", message: e.message });
    }
  }
});

export default router;
