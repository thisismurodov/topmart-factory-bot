import {
  getDueEvents,
  getQueueCounts,
  getStrandedLegacyEvents,
  migrateLegacyQueue,
  notifyQueueUpdated,
  removeEvent,
  removeLegacyItem,
  retryFailedEvents,
  updateEvent,
  QUEUE_UPDATED_EVENT,
} from "./eventQueue";
import { metaGet, metaSet, requestPersistentStorage } from "./idb";
import {
  submitSale,
  submitNoSale,
  submitPayment,
  submitNewShop,
  FieldApiError,
  type SaleInput,
  type NoSaleInput,
  type PaymentInput,
  type NewShopInput,
} from "./fieldApi";
import type { FieldEvent } from "./idb";

// T003 — Sync Engine (fon sinxronizatsiya xizmati).
// Ishga tushadi: ilova ochilganda, internet qaytganda, har 30 soniyada,
// va "Sync Now" tugmasi bosilganda.
//
// Xato siyosati (MUHIM — eski koddan farqi):
//   400/404/422  -> "failed" holatiga o'tadi va Sync Center'da KO'RINADI
//                   (oldin jimgina o'chirilardi — endi hech narsa yo'qolmaydi).
//   401/403      -> pending qoladi (initData eskirgan — Mini App botdan qayta
//                   ochilganda yangilanadi), 60s dan keyin qayta uriniladi.
//   tarmoq/5xx/429 -> pending qoladi, eksponensial backoff (maks 5 daqiqa),
//                   retryCount cheksiz — offline qishloqda ham hech narsa
//                   avtomatik "failed" bo'lmaydi (spec: manual aralashuvsiz).

export type ConnectionState = "online" | "syncing" | "offline";

export interface SyncStatusSnapshot {
  connection: ConnectionState;
  online: boolean;
  syncing: boolean;
  pendingCount: number;
  failedCount: number;
  lastSyncAt: number | null;
  /** Oxirgi sinxronizatsiya urinishidagi xato (auth/tarmoq) — UI uchun */
  lastError: "auth" | "network" | null;
}

const SYNC_INTERVAL_MS = 30_000;
const AUTH_RETRY_MS = 60_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 300_000; // 5 daqiqa

function backoffDelay(retryCount: number): number {
  const raw = BACKOFF_BASE_MS * Math.pow(2, Math.min(retryCount, 10));
  const capped = Math.min(raw, BACKOFF_CAP_MS);
  // Jitter: ±20% — hamma qurilma bir vaqtda urilmasligi uchun
  return Math.round(capped * (0.8 + Math.random() * 0.4));
}

const emitter = new EventTarget();

let snapshot: SyncStatusSnapshot = {
  connection: typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "online",
  online: typeof navigator !== "undefined" ? navigator.onLine : true,
  syncing: false,
  pendingCount: 0,
  failedCount: 0,
  lastSyncAt: null,
  lastError: null,
};

function computeConnection(): ConnectionState {
  if (!snapshot.online) return "offline";
  if (snapshot.syncing || snapshot.pendingCount > 0) return "syncing";
  return "online";
}

function emit(patch: Partial<SyncStatusSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  snapshot = { ...snapshot, connection: computeConnection() };
  emitter.dispatchEvent(new Event("change"));
}

export function getSyncStatusSnapshot(): SyncStatusSnapshot {
  return snapshot;
}

export function subscribeSyncStatus(cb: () => void): () => void {
  emitter.addEventListener("change", cb);
  return () => emitter.removeEventListener("change", cb);
}

async function refreshCounts(): Promise<void> {
  const counts = await getQueueCounts();
  emit({ pendingCount: counts.pending, failedCount: counts.failed });
}

async function submitEvent(event: FieldEvent): Promise<void> {
  switch (event.operation) {
    case "SALE":
      await submitSale(event.payload as SaleInput);
      return;
    case "NO_SALE":
      await submitNoSale(event.payload as NoSaleInput);
      return;
    case "PAYMENT":
      await submitPayment(event.payload as PaymentInput);
      return;
    case "NEW_SHOP":
      await submitNewShop(event.payload as NewShopInput);
      return;
  }
}

let isSyncing = false;
// Sync ketayotganda kelgan so'rov yo'qolmasin — tugagach qayta ishga tushadi
// (masalan, "Hozir sinxronlash" avtomatik sikl paytida bosilsa).
let queuedRun: { manual: boolean } | null = null;

/** IDB butunlay ishlamaydigan qurilmalar (ba'zi private-mode WebView'lar)
 *  uchun oxirgi chora: localStorage navbatini to'g'ridan-to'g'ri yuboramiz. */
async function flushStrandedLegacy(): Promise<{ net: boolean; auth: boolean }> {
  const result = { net: false, auth: false };
  const stranded = await getStrandedLegacyEvents();
  for (const item of stranded) {
    try {
      await submitEvent(item as unknown as FieldEvent);
      removeLegacyItem(item.eventId);
    } catch (err) {
      const status = err instanceof FieldApiError ? err.status : undefined;
      if (status === 400 || status === 404 || status === 422) {
        // IDB'siz "failed" holatini ko'rsatib bo'lmaydi — zaharli element
        // navbatni abadiy bloklamasligi uchun o'chiramiz (oxirgi chora rejimi)
        removeLegacyItem(item.eventId);
        continue;
      }
      if (status === 401 || status === 403) {
        result.auth = true;
      } else {
        result.net = true;
      }
      break; // tarmoq/auth muammosi — qolganini keyinroq uramiz
    }
  }
  return result;
}

export async function triggerSync(opts?: { manual?: boolean }): Promise<void> {
  const manual = opts?.manual ?? false;
  if (isSyncing) {
    queuedRun = { manual: queuedRun?.manual || manual };
    return;
  }
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    emit({ online: false });
    return;
  }

  isSyncing = true;
  emit({ online: true, syncing: true });

  let sawNetworkError = false;
  let sawAuthError = false;

  try {
    // Eski localStorage navbati (yoki IDB ishlamay qolganda yozilgan zaxira
    // elementlar) har sync siklida IDB'ga ko'chiriladi. IDB butunlay
    // ishlamasa — localStorage'dan to'g'ridan-to'g'ri yuboriladi.
    await migrateLegacyQueue();
    const strandedResult = await flushStrandedLegacy();
    if (strandedResult.net) sawNetworkError = true;
    if (strandedResult.auth) sawAuthError = true;

    const due = await getDueEvents(manual);
    let successCount = 0;

    for (const event of due) {
      await updateEvent(event.eventId, { syncStatus: "syncing" });
      try {
        // Muvaffaqiyat (shu jumladan serverdagi duplicate:true) -> o'chiramiz
        await submitEvent(event);
        await removeEvent(event.eventId);
        successCount++;
      } catch (err) {
        const status = err instanceof FieldApiError ? err.status : undefined;
        const message = err instanceof Error ? err.message : String(err);

        if (status === 400 || status === 404 || status === 422) {
          // "Zaharli" so'rov — validatsiya/topilmadi. FAILED deb belgilaymiz,
          // Sync Center'da ko'rinadi, agent Retry/O'chirish qila oladi.
          await updateEvent(event.eventId, {
            syncStatus: "failed",
            lastErrorStatus: status,
            lastErrorMessage: message,
          });
          continue; // keyingi hodisalar zaharlanmagan bo'lishi mumkin
        }

        if (status === 401 || status === 403) {
          // initData eskirgan — Mini App qayta ochilganda tuzaladi
          sawAuthError = true;
          await updateEvent(event.eventId, {
            syncStatus: "pending",
            nextAttemptAt: Date.now() + AUTH_RETRY_MS,
            lastErrorStatus: status,
            lastErrorMessage: message,
          });
          break; // qolganlari ham xuddi shu 401 ni oladi
        }

        // Tarmoq / 5xx / 429 — backoff bilan pending qoladi
        sawNetworkError = true;
        const retryCount = event.retryCount + 1;
        await updateEvent(event.eventId, {
          syncStatus: "pending",
          retryCount,
          nextAttemptAt: Date.now() + backoffDelay(retryCount),
          lastErrorStatus: status,
          lastErrorMessage: message,
        });
        break; // tarmoq yo'q — qolganlarini keyinroq uramiz
      }
    }

    if (!sawNetworkError && !sawAuthError) {
      const now = Date.now();
      emit({ lastSyncAt: now, lastError: null });
      void metaSet("lastSyncAt", now);
    } else {
      emit({ lastError: sawAuthError ? "auth" : "network" });
    }

    // Hodisalar serverga yetib bordi — ekrandagi marshrut/statistika
    // so'rovlarini yangilash uchun signal (App.tsx tinglaydi).
    if (successCount > 0 && typeof window !== "undefined") {
      window.dispatchEvent(new Event("sync-flushed"));
    }
  } finally {
    isSyncing = false;
    const counts = await getQueueCounts();
    emit({
      syncing: false,
      pendingCount: counts.pending,
      failedCount: counts.failed,
    });
    // Sync paytida yangi so'rov kelgan bo'lsa — darhol yana ishga tushiramiz
    if (queuedRun !== null) {
      const next = queuedRun;
      queuedRun = null;
      void triggerSync(next);
    }
  }
}

/** T008 "Retry Failed" tugmasi: failed -> pending, so'ng darhol sync. */
export async function retryFailedAndSync(): Promise<void> {
  await retryFailedEvents();
  await refreshCounts();
  await triggerSync({ manual: true });
}

let started = false;

/** Ilova ochilganda BIR MARTA chaqiriladi (main.tsx). */
export function startSyncEngine(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  requestPersistentStorage();

  window.addEventListener("online", () => {
    emit({ online: true });
    void triggerSync();
  });
  window.addEventListener("offline", () => {
    emit({ online: false });
  });
  window.addEventListener(QUEUE_UPDATED_EVENT, () => {
    void refreshCounts();
  });

  window.setInterval(() => {
    void triggerSync();
  }, SYNC_INTERVAL_MS);

  // Boot: saqlangan lastSync ni yuklaymiz, navbatni ko'chiramiz, sync'laymiz
  void (async () => {
    const saved = await metaGet<number>("lastSyncAt");
    if (typeof saved === "number") emit({ lastSyncAt: saved });
    await migrateLegacyQueue();
    await refreshCounts();
    // Boot sync backoff'ni e'tiborsiz qoldiradi (manual): Mini App qayta
    // ochilganda initData yangi bo'ladi — auth backoff'da qolgan hodisalar
    // 60s kutmasdan darhol yuboriladi.
    await triggerSync({ manual: true });
    notifyQueueUpdated();
  })();
}
