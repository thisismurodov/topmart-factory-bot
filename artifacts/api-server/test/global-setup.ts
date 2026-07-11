// Vitest global setup: keeps the LOCAL Postgres awake for the whole suite.
//
// Nega kerak: local dev bazasi (Neon-backed) faollik bo'lmasa uxlab qoladi
// (scale-to-zero). Suite o'rtasida uzun Railway-only bo'lim bor
// (distribution-fresh-db + fresh-db-boot ~110s davomida local bazaga BIRORTA
// so'rov yubormaydi) — shu payt local baza suspend bo'lib, keyingi
// schema-izolyatsiyalangan testlar (ombor-weight, raw-in, flow-raw-in)
// uyg'onish paytidagi connect xatolari bilan flaky yiqiladi
// (pool.connect() reject → Express default HTML error page → "Unexpected
// token '<'"). Har 10 sekundda yangi ulanish bilan SELECT 1 ping bazani
// butun run davomida uyg'oq tutadi; ping o'zi ham uxlagan bazani uyg'otadi.
import { Client } from "pg";

export default function globalSetup(): () => void {
  const url = process.env.DATABASE_URL;
  if (!url) return () => {};

  let pinging = false;
  const ping = async () => {
    if (pinging) return; // sekin uyg'onishda pinglar ustma-ust tushmasin
    pinging = true;
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
    } catch {
      // Uyg'onish paytidagi xato suite'ni yiqitmasin — keyingi ping yana urinadi.
    } finally {
      await client.end().catch(() => {});
      pinging = false;
    }
  };

  void ping();
  const timer = setInterval(() => void ping(), 10_000);

  return () => clearInterval(timer);
}
