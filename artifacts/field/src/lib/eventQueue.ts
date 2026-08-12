import {
  openFieldDb,
  type FieldEvent,
  type FieldOperation,
} from "./idb";
import type {
  SaleInput,
  NoSaleInput,
  PaymentInput,
  NewShopInput,
} from "./fieldApi";

// T002 — Offline hodisalar navbati (IndexedDB).
// Har bir yozuv operatsiyasi avval shu yerda lokal hodisa bo'lib saqlanadi,
// keyin syncEngine uni serverga yuboradi. eventId = clientOpId (UUID) —
// server field_ops.client_op_id UNIQUE bilan aynan bir xil qiymat, shuning
// uchun takror yuborish hech qachon dublikat yaratmaydi.

export const QUEUE_UPDATED_EVENT = "sync-queue-updated";

const LEGACY_KEY = "field_sync_queue";
const DEVICE_ID_KEY = "field_device_id";
const AGENT_ID_KEY = "field_agent_id";

export interface OperationPayloadMap {
  SALE: SaleInput;
  NO_SALE: NoSaleInput;
  PAYMENT: PaymentInput;
  NEW_SHOP: NewShopInput;
}

export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return "unknown-device";
  }
}

/** AuthGate /me muvaffaqiyatli bo'lganda chaqiradi — envelope uchun metadata. */
export function rememberAgentId(id: number): void {
  try {
    localStorage.setItem(AGENT_ID_KEY, String(id));
  } catch {
    // ixtiyoriy metadata
  }
}

function currentAgentId(): number | null {
  try {
    const raw = localStorage.getItem(AGENT_ID_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

export function notifyQueueUpdated(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(QUEUE_UPDATED_EVENT));
  }
}

export async function enqueueEvent<K extends FieldOperation>(
  operation: K,
  payload: OperationPayloadMap[K],
): Promise<void> {
  const event: FieldEvent = {
    eventId: payload.clientOpId,
    deviceId: getDeviceId(),
    agentId: currentAgentId(),
    createdAt: new Date().toISOString(),
    operation,
    payload,
    retryCount: 0,
    syncStatus: "pending",
    nextAttemptAt: 0,
    schemaVersion: 1,
  };

  try {
    const db = await openFieldDb();
    await db.put("events", event);
  } catch {
    // Favqulodda zaxira: IDB ochilmasa eski localStorage formatiga yozamiz —
    // keyingi sync siklida migrateLegacyQueue() uni IDB'ga ko'chiradi
    // (yoki IDB umuman ishlamasa, o'sha yerdan o'qiladi).
    writeLegacyItem(operation, payload);
  }
  notifyQueueUpdated();
}

// --- Eski localStorage navbati bilan moslik ---

type LegacyItem =
  | { type: "sale"; id: string; data: SaleInput }
  | { type: "nosale"; id: string; data: NoSaleInput }
  | { type: "payment"; id: string; data: PaymentInput }
  | { type: "shop"; id: string; data: NewShopInput };

const LEGACY_TYPE_TO_OP: Record<LegacyItem["type"], FieldOperation> = {
  sale: "SALE",
  nosale: "NO_SALE",
  payment: "PAYMENT",
  shop: "NEW_SHOP",
};

const OP_TO_LEGACY_TYPE: Record<FieldOperation, LegacyItem["type"]> = {
  SALE: "sale",
  NO_SALE: "nosale",
  PAYMENT: "payment",
  NEW_SHOP: "shop",
};

function readLegacyQueue(): LegacyItem[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    return raw ? (JSON.parse(raw) as LegacyItem[]) : [];
  } catch {
    return [];
  }
}

function writeLegacyItem(operation: FieldOperation, payload: { clientOpId: string }): void {
  try {
    const q = readLegacyQueue();
    q.push({
      type: OP_TO_LEGACY_TYPE[operation],
      id: payload.clientOpId,
      data: payload,
    } as LegacyItem);
    localStorage.setItem(LEGACY_KEY, JSON.stringify(q));
  } catch {
    // localStorage ham ishlamasa — qiladigan ishimiz qolmadi
  }
}

/** Eski localStorage navbatini IDB'ga ko'chiradi. Har boot va har sync
 *  siklida chaqirilsa ham xavfsiz (idempotent) — hech narsa yo'qolmaydi. */
export async function migrateLegacyQueue(): Promise<number> {
  const legacy = readLegacyQueue();
  if (legacy.length === 0) return 0;

  let migrated = 0;
  try {
    const db = await openFieldDb();
    const now = new Date().toISOString();
    for (const item of legacy) {
      if (!item || typeof item !== "object" || !item.id) continue;
      const existing = await db.get("events", item.id);
      if (existing) {
        migrated++;
        continue;
      }
      const event: FieldEvent = {
        eventId: item.id,
        deviceId: getDeviceId(),
        agentId: currentAgentId(),
        createdAt: now,
        operation: LEGACY_TYPE_TO_OP[item.type] ?? "SALE",
        payload: item.data,
        retryCount: 0,
        syncStatus: "pending",
        nextAttemptAt: 0,
        schemaVersion: 1,
      };
      await db.put("events", event);
      migrated++;
    }
    // Hammasi IDB'da — eski kalitni o'chiramiz
    localStorage.removeItem(LEGACY_KEY);
    if (migrated > 0) notifyQueueUpdated();
  } catch {
    // IDB ishlamayapti — legacy navbat joyida qoladi, keyinroq yana urinamiz
    return 0;
  }
  return migrated;
}

/** IDB butunlay ishlamayotgan qurilmalar uchun oxirgi chora: localStorage
 *  navbatidagi elementlarni to'g'ridan-to'g'ri yuborish uchun qaytaradi.
 *  IDB sog' bo'lsa bo'sh ro'yxat qaytadi (migrateLegacyQueue ko'chirgan bo'ladi). */
export async function getStrandedLegacyEvents(): Promise<
  { eventId: string; operation: FieldOperation; payload: unknown }[]
> {
  const legacy = readLegacyQueue();
  if (legacy.length === 0) return [];
  try {
    await openFieldDb();
    return []; // IDB ishlayapti — migratsiya o'zi hal qiladi
  } catch {
    return legacy
      .filter((item) => item && typeof item === "object" && item.id)
      .map((item) => ({
        eventId: item.id,
        operation: LEGACY_TYPE_TO_OP[item.type] ?? "SALE",
        payload: item.data,
      }));
  }
}

/** Legacy elementni YANGI (fresh) localStorage holatidan o'chiradi —
 *  flush paytida qo'shilgan yangi yozuvlar yo'qolmasligi uchun. */
export function removeLegacyItem(eventId: string): void {
  try {
    const q = readLegacyQueue().filter((item) => item.id !== eventId);
    if (q.length === 0) {
      localStorage.removeItem(LEGACY_KEY);
    } else {
      localStorage.setItem(LEGACY_KEY, JSON.stringify(q));
    }
    notifyQueueUpdated();
  } catch {
    // localStorage ishlamasa — keyingi sync yana urinadi
  }
}

// --- O'qish/holat funksiyalari ---

function byCreatedAt(a: FieldEvent, b: FieldEvent): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

export async function getAllEvents(): Promise<FieldEvent[]> {
  try {
    const db = await openFieldDb();
    const all = await db.getAll("events");
    return all.sort(byCreatedAt);
  } catch {
    return [];
  }
}

export interface QueueCounts {
  pending: number;
  failed: number;
  total: number;
}

export async function getQueueCounts(): Promise<QueueCounts> {
  const all = await getAllEvents();
  let pending = 0;
  let failed = 0;
  for (const e of all) {
    if (e.syncStatus === "failed") failed++;
    else pending++; // "syncing" ham amalda kutilayotgan hisoblanadi
  }
  return { pending, failed, total: all.length };
}

/** Yuborishga tayyor hodisalar — createdAt tartibida (to'lovlar FIFO).
 *  MUHIM: birinchi "hali navbati kelmagan" (backoff) hodisada to'xtaymiz,
 *  undan keyingilarini ham yubormaymiz — tartib buzilmasligi uchun. */
export async function getDueEvents(ignoreBackoff: boolean): Promise<FieldEvent[]> {
  const all = await getAllEvents();
  const now = Date.now();
  const due: FieldEvent[] = [];
  for (const e of all) {
    if (e.syncStatus === "failed") continue;
    if (!ignoreBackoff && e.nextAttemptAt > now) break;
    due.push(e);
  }
  return due;
}

export async function removeEvent(eventId: string): Promise<void> {
  try {
    const db = await openFieldDb();
    await db.delete("events", eventId);
  } catch {
    // o'chirib bo'lmasa — keyingi sync'da duplicate:true bilan yana o'chiriladi
  }
  notifyQueueUpdated();
}

export async function updateEvent(
  eventId: string,
  patch: Partial<FieldEvent>,
): Promise<void> {
  try {
    const db = await openFieldDb();
    const existing = await db.get("events", eventId);
    if (!existing) return;
    await db.put("events", { ...existing, ...patch });
  } catch {
    // holat yangilanmasa ham hodisa yo'qolmaydi
  }
  notifyQueueUpdated();
}

/** Boot-time tozalash: ilova sync o'rtasida majburan yopilsa (Telegram
 *  WebView'ni o'ldirsa), hodisa "syncing" holatida tiqilib qoladi. Server
 *  idempotent (client_op_id UNIQUE) — shuning uchun uni yana "pending" qilib
 *  darhol qayta yuborish xavfsiz. startSyncEngine() boot'da chaqiradi. */
export async function resetStaleSyncingEvents(): Promise<number> {
  try {
    const db = await openFieldDb();
    const all = await db.getAll("events");
    let n = 0;
    for (const e of all) {
      if (e.syncStatus !== "syncing") continue;
      await db.put("events", {
        ...e,
        syncStatus: "pending",
        nextAttemptAt: 0,
      });
      n++;
    }
    if (n > 0) notifyQueueUpdated();
    return n;
  } catch {
    return 0;
  }
}

/** T008 "Retry Failed": failed hodisalarni yana pending qilib qo'yadi. */
export async function retryFailedEvents(): Promise<number> {
  try {
    const db = await openFieldDb();
    const all = await db.getAll("events");
    let n = 0;
    for (const e of all) {
      if (e.syncStatus !== "failed") continue;
      await db.put("events", {
        ...e,
        syncStatus: "pending",
        retryCount: 0,
        nextAttemptAt: 0,
        lastErrorStatus: undefined,
        lastErrorMessage: undefined,
      });
      n++;
    }
    if (n > 0) notifyQueueUpdated();
    return n;
  } catch {
    return 0;
  }
}

/** Failed hodisani butunlay o'chirish (agent ataylab bekor qilsa). */
export async function discardEvent(eventId: string): Promise<void> {
  await removeEvent(eventId);
}
