import { Router, type IRouter } from "express";
import { getUsdToUzsRate } from "../lib/exchangeRate";

const router: IRouter = Router();

router.get("/exchange-rate", async (_req, res): Promise<void> => {
  const info = await getUsdToUzsRate();
  res.json({
    rate:   info.rate,
    date:   info.date,
    source: info.source,
    cached: info.cached,
    stale:  info.stale,
  });
});

export default router;
