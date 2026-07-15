import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client";
import { metaGet, metaSet, openFieldDb } from "./idb";

// T001/T011 — react-query keshini IndexedDB'da saqlash.
// Marshrut, mahsulotlar, do'kon ma'lumotlari va sessiya (/me) shu orqali
// brauzer qayta ochilganda ham tiklanadi. Biznes YOZUVLARI bu yerda EMAS —
// ular eventQueue'da (IDB events store).

const RQ_CACHE_KEY = "rq-cache";

// Ketma-ket yozuvlarni siyraklashtiramiz (har cache o'zgarishida IDB'ga
// yozmaslik uchun) — oxirgi holat baribir saqlanadi.
let pendingWrite: PersistedClient | null = null;
let writeTimer: number | null = null;

export function createIdbPersister(): Persister {
  return {
    persistClient(client: PersistedClient) {
      pendingWrite = client;
      if (writeTimer != null) return;
      writeTimer = window.setTimeout(() => {
        writeTimer = null;
        const toWrite = pendingWrite;
        pendingWrite = null;
        if (toWrite) void metaSet(RQ_CACHE_KEY, toWrite);
      }, 1000);
    },
    async restoreClient() {
      return await metaGet<PersistedClient>(RQ_CACHE_KEY);
    },
    async removeClient() {
      try {
        const db = await openFieldDb();
        await db.delete("meta", RQ_CACHE_KEY);
      } catch {
        // kesh o'chmasa ham davom etamiz
      }
    },
  };
}
