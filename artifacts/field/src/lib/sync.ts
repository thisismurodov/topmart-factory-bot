import { submitSale, submitNoSale, SaleInput, NoSaleInput, FieldApiError } from "./fieldApi";

type SyncItem = 
  | { type: "sale"; id: string; data: SaleInput }
  | { type: "nosale"; id: string; data: NoSaleInput };

const QUEUE_KEY = "field_sync_queue";

export function getQueue(): SyncItem[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveQueue(queue: SyncItem[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  window.dispatchEvent(new Event("sync-queue-updated"));
}

export function enqueueSale(data: SaleInput) {
  const q = getQueue();
  q.push({ type: "sale", id: data.clientOpId, data });
  saveQueue(q);
  triggerSync();
}

export function enqueueNoSale(data: NoSaleInput) {
  const q = getQueue();
  q.push({ type: "nosale", id: data.clientOpId, data });
  saveQueue(q);
  triggerSync();
}

let isSyncing = false;

// MUHIM: har doim localStorage'dagi ENG YANGI holatdan o'chiramiz.
// Flush davomida yangi element qo'shilsa (enqueue), eski snapshot'ni
// qayta yozish uni yo'qotib yuborardi.
function removeFromQueue(id: string) {
  saveQueue(getQueue().filter(x => x.id !== id));
}

export async function triggerSync() {
  if (isSyncing || !navigator.onLine) return;
  isSyncing = true;

  try {
    const snapshot = getQueue();

    for (const item of snapshot) {
      try {
        if (item.type === "sale") {
          await submitSale(item.data);
        } else {
          await submitNoSale(item.data);
        }
        // Success (including duplicate: true) -> remove from queue
        removeFromQueue(item.id);
      } catch (err) {
        const status = err instanceof FieldApiError ? err.status : undefined;
        // Faqat haqiqiy "zaharli" so'rovlarni tashlaymiz (validatsiya/topilmadi).
        // 401/403/429 — qayta urinish mumkin (masalan, initData eskirgan bo'lsa
        // Mini App qayta ochilganda yangilanadi); navbatda qoldiramiz.
        if (status === 400 || status === 404 || status === 422) {
          removeFromQueue(item.id);
          window.dispatchEvent(
            new CustomEvent("sync-item-dropped", { detail: { id: item.id, status } })
          );
          continue; // keyingi elementlar zaharlanmagan bo'lishi mumkin
        }
        break; // Tarmoq/server/auth xatosi — keyinroq qayta urinamiz
      }
    }
  } finally {
    isSyncing = false;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", triggerSync);
  setInterval(triggerSync, 60000);
}
