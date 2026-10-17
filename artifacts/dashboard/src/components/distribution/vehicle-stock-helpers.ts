/**
 * Pure helpers for the vehicle stock UI. Kept free of React so they can be unit-tested.
 */

/**
 * Exact (case-insensitive, trimmed) movement types that unambiguously mean a sale.
 * Substring matching is intentionally avoided: "TRANSFER_IN", "RETURN_OUT", "INBOUND"
 * etc. must never be treated as a sale.
 */
const SALE_MOVEMENT_TYPES = new Set(["SALE", "SOLD", "VEHICLE_SALE"]);
const LOAD_MOVEMENT_TYPES = new Set(["IN", "LOAD", "VEHICLE_LOAD", "TRANSFER_IN"]);
const UNLOAD_MOVEMENT_TYPES = new Set(["OUT", "UNLOAD", "VEHICLE_UNLOAD", "TRANSFER_OUT", "RETURN"]);

export type MovementKind = "sale" | "load" | "unload" | "other";

export function classifyMovementType(type: string | null | undefined): MovementKind {
  if (!type) return "other";
  const t = type.trim().toUpperCase();
  if (SALE_MOVEMENT_TYPES.has(t)) return "sale";
  if (LOAD_MOVEMENT_TYPES.has(t)) return "load";
  if (UNLOAD_MOVEMENT_TYPES.has(t)) return "unload";
  return "other";
}

export function isSaleMovement(type: string | null | undefined): boolean {
  return classifyMovementType(type) === "sale";
}

export function formatQty(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("uz-UZ", { maximumFractionDigits: 4 });
}

export function formatDateTime(s: string | null | undefined): string {
  return s ? s.slice(0, 16).replace("T", " ") : "—";
}

/** Optional stock-item fields (may be absent until the generated client is updated). */
export interface StockItemValueFields {
  unitType?: string | null;
  quantity?: number | null;
  weightKg?: number | null;
  loadedPackageCount?: number | null;
  currency?: string | null;
  costValue?: number | null;
  retailValue?: number | null;
}

export function isKgItem(item: StockItemValueFields): boolean {
  return (item.unitType ?? "").trim().toLowerCase() === "kg";
}

/** Primary stock display: kg goods in kg, otherwise pieces. Never falls back to 0. */
export function formatStockPrimary(item: StockItemValueFields): string {
  if (isKgItem(item)) return `${formatQty(item.weightKg)} kg`;
  return `${formatQty(item.quantity)} dona`;
}

/** Historical loaded package label for kg goods; null when not applicable/unknown. */
export function formatLoadedPackages(item: StockItemValueFields): string | null {
  if (!isKgItem(item)) return null;
  const n = item.loadedPackageCount;
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return `${formatQty(n)} qadoq yuklangan`;
}

/** Money with currency; "Noma’lum" when value or currency missing. Never 0 fallback. */
export function formatMoney(value: number | null | undefined, currency: string | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || !currency) return "Noma’lum";
  return `${value.toLocaleString("uz-UZ", { maximumFractionDigits: 2 })} ${currency}`;
}

/** Totals grouped by currency; items with unknown value counted separately. */
export function sumByCurrency(items: StockItemValueFields[], key: "costValue" | "retailValue") {
  const totals: Record<string, number> = {};
  let unknown = 0;
  for (const it of items) {
    const v = it[key];
    if (v === null || v === undefined || !Number.isFinite(v) || !it.currency) { unknown++; continue; }
    totals[it.currency] = (totals[it.currency] ?? 0) + v;
  }
  return { totals, unknown };
}
