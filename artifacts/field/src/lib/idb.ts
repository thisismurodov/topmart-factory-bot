import { openDB, type DBSchema, type IDBPDatabase } from "idb";

// T001 — Lokal offline baza (IndexedDB). Bitta baza, 4 ta store:
//   events    — offline hodisalar navbati (yagona haqiqat manbai offline'da)
//   snapshots — marshrut/mahsulotlar/do'kon ma'lumotlari keshi
//   meta      — deviceId, lastSync, lastPath, schemaVersion kabi kalit-qiymatlar
//   tiles     — Leaflet xarita plitkalarining keshi
// MUHIM: biznes ma'lumotlari uchun Service Worker ISHLATILMAYDI (spec talabi).

export type FieldOperation = "SALE" | "NO_SALE" | "PAYMENT" | "NEW_SHOP";
export type EventSyncStatus = "pending" | "syncing" | "failed";

export interface FieldEvent {
  /** = clientOpId (server field_ops.client_op_id UNIQUE kaliti bilan bir xil UUID) */
  eventId: string;
  deviceId: string;
  agentId: number | null;
  createdAt: string; // ISO
  operation: FieldOperation;
  payload: unknown;
  retryCount: number;
  syncStatus: EventSyncStatus;
  /** Keyingi urinish vaqti (epoch ms) — eksponensial backoff uchun */
  nextAttemptAt: number;
  lastErrorStatus?: number;
  lastErrorMessage?: string;
  schemaVersion: 1;
}

export interface SnapshotRow {
  key: string;
  data: unknown;
  savedAt: number; // epoch ms
}

export interface TileRow {
  key: string; // "z/x/y"
  blob: Blob;
  savedAt: number;
}

interface FieldDB extends DBSchema {
  events: {
    key: string;
    value: FieldEvent;
    indexes: { "by-status": string };
  };
  snapshots: { key: string; value: SnapshotRow };
  meta: { key: string; value: unknown };
  tiles: { key: string; value: TileRow };
}

const DB_NAME = "topmart-field";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<FieldDB>> | null = null;

export function openFieldDb(): Promise<IDBPDatabase<FieldDB>> {
  if (!dbPromise) {
    dbPromise = openDB<FieldDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("events")) {
          const events = db.createObjectStore("events", { keyPath: "eventId" });
          events.createIndex("by-status", "syncStatus");
        }
        if (!db.objectStoreNames.contains("snapshots")) {
          db.createObjectStore("snapshots", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta");
        }
        if (!db.objectStoreNames.contains("tiles")) {
          db.createObjectStore("tiles", { keyPath: "key" });
        }
      },
      // Boshqa tab/versiya bloklasa — eski promise'ni tashlab, keyingi
      // chaqiriqda qayta ochishga imkon beramiz.
      blocked() {},
      terminated() {
        dbPromise = null;
      },
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

// --- meta store yordamchilari ---

export async function metaGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await openFieldDb();
    return (await db.get("meta", key)) as T | undefined;
  } catch {
    return undefined;
  }
}

export async function metaSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await openFieldDb();
    await db.put("meta", value, key);
  } catch {
    // IDB ishlamasa — meta yozuvi kritik emas, jim o'tamiz
  }
}

// --- snapshot store yordamchilari (T001/T005) ---

export async function snapshotGet<T>(key: string): Promise<{ data: T; savedAt: number } | undefined> {
  try {
    const db = await openFieldDb();
    const row = await db.get("snapshots", key);
    if (!row) return undefined;
    return { data: row.data as T, savedAt: row.savedAt };
  } catch {
    return undefined;
  }
}

export async function snapshotSet(key: string, data: unknown): Promise<void> {
  try {
    const db = await openFieldDb();
    await db.put("snapshots", { key, data, savedAt: Date.now() });
  } catch {
    // kesh yozib bo'lmasa ham ilova ishlashda davom etadi
  }
}

/** T008 "Clear Cache (Admin)" — faqat keshlar tozalanadi:
 *  snapshot'lar, xarita plitkalari va react-query keshi.
 *  events navbati va deviceId/lastSync TEGILMAYDI (biznes ma'lumoti). */
export async function clearOfflineCache(): Promise<void> {
  const db = await openFieldDb();
  await db.clear("snapshots");
  await db.clear("tiles");
  await db.delete("meta", "rq-cache");
}

/** Brauzer storage'ni "persistent" deb belgilashga urinamiz —
 *  Telegram WebView keshni o'chirib yubormasligi uchun (best-effort). */
export function requestPersistentStorage(): void {
  try {
    if (typeof navigator !== "undefined" && navigator.storage?.persist) {
      void navigator.storage.persist();
    }
  } catch {
    // qo'llab-quvvatlanmasa — muammo emas
  }
}
