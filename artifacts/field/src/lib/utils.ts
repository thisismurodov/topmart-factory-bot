import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number): string {
  return amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// Haversine distance in meters
export function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3; // metres
  const φ1 = lat1 * Math.PI/180; // φ, λ in radians
  const φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180;
  const Δλ = (lon2-lon1) * Math.PI/180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return Math.round(R * c); 
}

// Rough ETA (assuming ~30km/h average city speed -> ~500m/min)
export function estimateEtaMinutes(distanceMeters: number): number {
  return Math.max(1, Math.round(distanceMeters / 500));
}

// Taxminiy tugash vaqti: har pending do'kon ≈ 5 daqiqa tashrif + ~4 daqiqa yo'l.
// Birinchi do'kongacha aniq masofa ma'lum bo'lsa, uni alohida qo'shamiz.
export function estimateFinishTime(pendingCount: number, distToNextMeters: number | null): string {
  if (pendingCount <= 0) return "—";
  const perShopMin = 5 + 4;
  let minutes = pendingCount * perShopMin;
  if (distToNextMeters !== null) {
    minutes = minutes - 4 + estimateEtaMinutes(distToNextMeters);
  }
  const t = new Date(Date.now() + minutes * 60_000);
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// T007 — "✓ Saqlandi" animatsiyasi uchun flag: forma saqlagach xaritaga
// qaytishdan OLDIN qo'yiladi, RouteMap bir marta o'qib o'chiradi.
const SAVED_FLAG_KEY = "field_visit_saved";

export function markVisitSaved(): void {
  try {
    sessionStorage.setItem(SAVED_FLAG_KEY, "1");
  } catch {}
}

export function consumeVisitSaved(): boolean {
  try {
    const v = sessionStorage.getItem(SAVED_FLAG_KEY);
    if (v) sessionStorage.removeItem(SAVED_FLAG_KEY);
    return v === "1";
  } catch {
    return false;
  }
}
