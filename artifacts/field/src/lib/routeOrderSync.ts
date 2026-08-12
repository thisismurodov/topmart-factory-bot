// ── Optimal tartib sinxronlagichi ─────────────────────────────────────────────
// Saqlangan dokonId tartibi ikki joyda yashaydi:
//   1. localStorage (tez, offline'da ham ishlaydi)
//   2. server (/api/field/route/order) — qurilmalar orasida sinxron
//
// Poyga (race) himoyasi: har bir lokal mutatsiya (saqlash/reset) monoton
// o'suvchi `seq` token oladi. Faqat JORIY (eng oxirgi) operatsiya:
//   - o'z dirty belgisini tozalashi mumkin (eski PUT/DELETE javobi yangi
//     operatsiyaning dirty belgisini o'chira olmaydi — retry yo'qolmaydi)
//   - GET javobini qabul qilishi mumkin (kechikkan GET foydalanuvchining
//     yangi harakatini ustidan yozib yubormaydi)
//
// Dirty belgisi localStorage'da: "set" (saqlash kutilmoqda) yoki "clear"
// (o'chirish kutilmoqda). Sync muvaffaqiyatida — va faqat seq o'zgarmagan
// bo'lsa — tozalanadi; offline'da 'online' hodisasida qayta uriladi.

export const OPTIMAL_ORDER_PREFIX = "field_optimal_order:";

export type DirtyOp = "set" | "clear";
export interface DirtyState {
  op: DirtyOp;
  /** Operatsiya belgisi (Date.now() asosida) — retry'da ham o'sha belgi
   *  yuboriladi, server undan yangiroq holatni ustidan yozmaydi. */
  opSeq: number;
}

export interface RouteOrderApi {
  fetchOrder(): Promise<{ order: number[] | null }>;
  /** applied=false — server bu operatsiyani eskirgan deb rad etdi
   *  (boshqa qurilmada yangiroq holat bor). */
  putOrder(order: number[], opSeq: number): Promise<{ applied: boolean }>;
  deleteOrder(opSeq: number): Promise<{ applied: boolean }>;
}

export function optimalOrderKey(agentId: number, sana: string): string {
  return `${OPTIMAL_ORDER_PREFIX}${agentId}:${sana}`;
}

export function loadSavedOrder(key: string): number[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.every(x => typeof x === "number")) return arr;
  } catch {}
  return null;
}

function saveOrderLocal(key: string, ids: number[]) {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {}
}

function clearOrderLocal(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

function dirtyKey(storageKey: string): string {
  return `${storageKey}:dirty`;
}

export function loadDirtyOp(storageKey: string): DirtyState | null {
  try {
    const v = localStorage.getItem(dirtyKey(storageKey));
    if (!v) return null;
    const [op, seqStr] = v.split(":");
    const opSeq = Number(seqStr);
    if ((op === "set" || op === "clear") && Number.isInteger(opSeq) && opSeq > 0) {
      return { op, opSeq };
    }
  } catch {}
  return null;
}

function saveDirtyOp(storageKey: string, op: DirtyOp, opSeq: number) {
  try {
    localStorage.setItem(dirtyKey(storageKey), `${op}:${opSeq}`);
  } catch {}
}

function clearDirtyOp(storageKey: string) {
  try {
    localStorage.removeItem(dirtyKey(storageKey));
  } catch {}
}

/** Eski kunlarning saqlangan tartiblarini tozalash (localStorage to'lib ketmasin).
 *  currentKey va unga bog'liq :dirty kaliti saqlab qolinadi. */
export function cleanupStaleOrders(currentKey: string) {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(OPTIMAL_ORDER_PREFIX) && !k.startsWith(currentKey)) stale.push(k);
    }
    stale.forEach(k => localStorage.removeItem(k));
  } catch {}
}

export class RouteOrderSyncer {
  private seq = 0;
  private lastOpSeq = 0;

  constructor(
    private storageKey: string,
    private api: RouteOrderApi,
    /** Server mutatsiyani rad etganda (applied=false) — server'dagi haqiqiy
     *  holat olinib, UI shu callback orqali yangilanadi. */
    private onServerState?: (order: number[] | null) => void,
    /** Testlarda almashtiriladigan vaqt manbai. */
    private now: () => number = () => Date.now(),
  ) {}

  /** Mutatsiya javobini qayta ishlash: qabul qilingan bo'lsa dirty tozalanadi;
   *  rad etilgan (eskirgan) bo'lsa — server holati olinib qabul qilinadi. */
  private acknowledge(op: number, applied: boolean): void {
    if (this.seq !== op) return; // orada yangi lokal harakat — unga tegmaymiz
    clearDirtyOp(this.storageKey); // rad etilgan opni retry qilish ma'nosiz
    if (!applied) void this.reconcile(op);
  }

  /** Serverdagi haqiqiy holatni olib, lokal + UI'ga qo'llash (poyga himoyali). */
  private async reconcile(op: number): Promise<void> {
    try {
      const res = await this.api.fetchOrder();
      if (this.seq !== op || loadDirtyOp(this.storageKey) !== null) return; // eskirdi
      if (res.order && res.order.length > 0) {
        saveOrderLocal(this.storageKey, res.order);
        this.onServerState?.(res.order);
      } else {
        clearOrderLocal(this.storageKey);
        this.onServerState?.(null);
      }
    } catch {
      // Offline — keyingi sync() (masalan 'online' hodisasida) hal qiladi
    }
  }

  /** Monoton o'suvchi operatsiya belgisi: devicelar orasida Date.now()
   *  taqqoslanadi; bitta device ichida bir ms'da ikki op bo'lsa +1. */
  private nextOpSeq(): number {
    this.lastOpSeq = Math.max(this.now(), this.lastOpSeq + 1);
    return this.lastOpSeq;
  }

  /** Yangi tartibni lokal saqlash + serverga fonda yuborish. */
  save(ids: number[]): void {
    const op = ++this.seq;
    const opSeq = this.nextOpSeq();
    saveOrderLocal(this.storageKey, ids);
    saveDirtyOp(this.storageKey, "set", opSeq);
    this.api
      .putOrder(ids, opSeq)
      .then((res) => this.acknowledge(op, res.applied))
      .catch(() => {}); // offline — sync() 'online' bo'lganda qayta uradi
  }

  /** Reset ("Asl tartib"): lokal o'chirish + serverga tombstone. */
  clear(): void {
    const op = ++this.seq;
    const opSeq = this.nextOpSeq();
    clearOrderLocal(this.storageKey);
    saveDirtyOp(this.storageKey, "clear", opSeq);
    this.api
      .deleteOrder(opSeq)
      .then((res) => this.acknowledge(op, res.applied))
      .catch(() => {});
  }

  /**
   * Server bilan sinxron. Qaytaradi:
   *   { changed: true, order }  — server nusxasi qabul qilindi (UI yangilansin)
   *   { changed: false }        — o'zgarish yo'q (dirty push yoki poyga/xato)
   *
   * Dirty bo'lsa — lokal o'zgarish serverga push qilinadi (server nusxasi
   * o'qilmaydi). Dirty bo'lmasa — server nusxasi ustun (boshqa qurilmada
   * saqlangan bo'lishi mumkin). Har await'dan keyin seq tekshiriladi:
   * orada yangi lokal harakat bo'lgan bo'lsa, eskirgan javob tashlanadi.
   */
  async sync(): Promise<{ changed: boolean; order?: number[] | null }> {
    const op = this.seq;
    try {
      const dirty = loadDirtyOp(this.storageKey);
      if (dirty !== null) {
        // Retry — asl opSeq bilan; server rad etsa (eskirgan), quyidagi GET
        // server holatini qabul qilib oladi.
        let applied = true;
        if (dirty.op === "set") {
          const local = loadSavedOrder(this.storageKey);
          if (local) {
            applied = (await this.api.putOrder(local, dirty.opSeq)).applied;
          }
        } else {
          applied = (await this.api.deleteOrder(dirty.opSeq)).applied;
        }
        if (this.seq !== op) return { changed: false }; // orada yangi harakat
        clearDirtyOp(this.storageKey);
        if (applied) return { changed: false };
        // Rad etildi — server nusxasi ustun, pastdagi GET'ga o'tamiz
      }
      const res = await this.api.fetchOrder();
      // Eskirgan GET: orada foydalanuvchi saqladi/reset qildi — tashlaymiz
      if (this.seq !== op || loadDirtyOp(this.storageKey) !== null) {
        return { changed: false };
      }
      if (res.order && res.order.length > 0) {
        saveOrderLocal(this.storageKey, res.order);
        return { changed: true, order: res.order };
      }
      // Serverda yo'q (boshqa qurilmada reset qilingan bo'lishi mumkin)
      clearOrderLocal(this.storageKey);
      return { changed: true, order: null };
    } catch {
      // Offline yoki server xatosi — localStorage bilan davom etamiz
      return { changed: false };
    }
  }
}
