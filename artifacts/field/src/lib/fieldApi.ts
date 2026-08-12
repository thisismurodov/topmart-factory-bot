import { QueryClient, useQuery, useMutation } from "@tanstack/react-query";

const BASE_URL = "/api/field";

export class FieldApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  
  if (typeof window !== "undefined" && window.Telegram?.WebApp) {
    const initData = window.Telegram.WebApp.initData;
    if (initData) {
      headers["X-Telegram-Init-Data"] = initData;
    }
  }

  // Dev fallback — URL'dagi ?dev_tg= har doim localStorage'dan ustun turadi
  // (aks holda birinchi agent keshda qolib, boshqa agentni test qilib bo'lmaydi)
  if (import.meta.env.DEV) {
    const params = new URLSearchParams(window.location.search);
    const urlDevId = params.get("dev_tg");
    const devId = urlDevId || localStorage.getItem("field_dev_tg_id");
    if (urlDevId) {
      localStorage.setItem("field_dev_tg_id", urlDevId);
    }
    if (devId && !headers["X-Telegram-Init-Data"]) {
      headers["X-Field-Dev-Id"] = devId;
    }
  }
  
  return headers;
}

async function fetchFieldApi<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      ...getAuthHeaders(),
      ...options.headers,
    },
  });

  if (!res.ok) {
    let msg = res.statusText;
    try {
      const data = await res.json();
      if (data.error) msg = data.error;
    } catch {}
    throw new FieldApiError(res.status, msg);
  }

  return res.json();
}

// Types
export interface FieldAgent {
  id: number;
  name: string;
  hudud: string | null;
}

export interface MeResponse {
  agent: FieldAgent;
  today: string;
  kun: number;
}

export interface RouteShop {
  dokonId: number;
  tartib: number;
  nomi: string;
  egasi: string;
  telefon: string;
  hudud: string;
  latitude: number | null;
  longitude: number | null;
  lastOrderDate: string | null;
  totalOrders: number;
  lastPurchase: number | null;
  daysSinceVisit: number | null;
  rating: number;
  avgRepeatDays: number;
  status: "sold" | "nosale" | "pending";
  /** Rejalashtirishda hisoblangan ustuvorlik bali (0-100), bo'lmasa null */
  bizScore: number | null;
  /** Ustuvorlik sabablari, masalan ["VIP", "Nasiya: 1.2M so'm", "35 kun bormagan"] */
  bizReasons: string[] | null;
}

export interface RouteStats {
  total: number;
  done: number;
  sold: number;
  nosale: number;
  pending: number;
  savdoSumma: number;
}

export interface RouteTodayResponse {
  kun: number;
  sana: string;
  dam: boolean;
  shops: RouteShop[];
  stats: RouteStats;
}

export interface Product {
  id: number;
  nomi: string;
  narx: number;
  birlik: string;
}

export interface SummaryTodayResponse {
  sana: string;
  savdolar: number;
  savdoSumma: number;
  olinmadi: number;
  km: number;
  daqiqa: number;
}

export interface SaleItemInput {
  mahsulotId: number;
  miqdor: number;
}

export interface SaleInput {
  clientOpId: string;
  dokonId: number;
  tolovTuri: "naqd" | "karta" | "nasiya" | "aralash";
  items: SaleItemInput[];
  nasiyaQism?: number;
}

export interface SaleResponse {
  ok: boolean;
  duplicate: boolean;
  savdoId?: number;
  jami?: number;
  nasiyaSumma?: number;
}

export interface NoSaleInput {
  clientOpId: string;
  dokonId: number;
  sabab: string;
  sababText?: string;
  qaytishSanasi?: string;
  lat?: number;
  lon?: number;
}

export interface NoSaleResponse {
  ok: boolean;
  duplicate: boolean;
  id?: number;
}

export interface GpsInput {
  lat: number;
  lon: number;
}

export interface StatsTodayResponse {
  sana: string;
  savdolar: number;
  savdoSumma: number;
  kechaSumma: number;
  pctVsYesterday: number | null;
  olinmadi: number;
  km: number;
  yigilganPul: number;
  nasiyaQoldiq: number;
  nasiyaSoni: number;
  qaytishTashriflar: number;
}

export interface StatsWeekDay {
  sana: string;
  savdolar: number;
  summa: number;
  olinmadi: number;
  yigilganPul: number;
}

export interface StatsWeekResponse {
  days: StatsWeekDay[];
}

export interface ShopDetail {
  id: number;
  nomi: string;
  egasi: string;
  telefon: string;
  hudud: string;
  latitude: number | null;
  longitude: number | null;
  totalOrders: number;
  totalSales: number;
  avgRepeatDays: number;
  lastOrderDate: string | null;
  daysSinceVisit: number | null;
  rating: number;
}

export interface ShopSaleRow {
  id: number;
  summa: number;
  tolovTuri: string;
  sana: string;
  items: string;
}

export interface ShopNoSaleRow {
  sabab: string;
  sababText: string;
  sana: string;
}

export interface ShopDetailResponse {
  dokon: ShopDetail;
  nasiyaQoldiq: number;
  balans: number;
  topProduct: string | null;
  tavsiyalar: string[];
  savdolar: ShopSaleRow[];
  olinmadi: ShopNoSaleRow[];
}

export interface PaymentInput {
  clientOpId: string;
  dokonId: number;
  summa: number;
  nasiyagaHisoblash: boolean;
}

export interface PaymentResponse {
  ok: boolean;
  duplicate: boolean;
  pulOlishId?: number | null;
  nasiyagaHisoblandi?: number;
  ortiqcha?: number;
  yangiQoldiq?: number;
}

export interface NewShopInput {
  clientOpId: string;
  nomi: string;
  egasi?: string;
  telefon?: string;
  hudud?: string;
  lat?: number | null;
  lon?: number | null;
}

export interface NewShopResponse {
  ok: boolean;
  duplicate: boolean;
  dokonId?: number | null;
  routeAdded?: boolean;
  gpsWarning?: { distanceKm: number; thresholdKm: number } | null;
}

export interface GpsCheckResponse {
  outlier: boolean;
  distanceKm: number | null;
  thresholdKm: number;
  viloyat: string | null;
}

// Saqlashdan OLDIN koordinatani tekshirish (online bo'lsa). Xato/timeout —
// null (bloklamaydi): offline'da yoki server javob bermasa saqlash davom etadi.
export async function checkShopGps(lat: number, lon: number, timeoutMs = 4000): Promise<GpsCheckResponse | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetchFieldApi<GpsCheckResponse>(
      `/shops/gps-check?lat=${lat}&lon=${lon}`,
      { signal: ctrl.signal },
    );
    clearTimeout(t);
    return res;
  } catch {
    return null;
  }
}

// Hooks
// staleTime: bir nechta komponent (AuthGate, StartScreen, ...) shu so'rovga
// obuna — har mount'da qayta so'rov ketmasligi uchun 1 daqiqa yangi hisoblanadi.
export const useFieldMe = () => useQuery<MeResponse, FieldApiError>({
  queryKey: ["field", "me"],
  queryFn: () => fetchFieldApi("/me"),
  staleTime: 60_000,
});

// Dev-only: ?kun=1..7 bilan boshqa kun marshrutini ko'rish (server FIELD_DEV_BYPASS
// yoqilganda qabul qiladi) — dam kunida ham xarita testlash uchun.
function getDevKunQs(): string {
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const kun = new URLSearchParams(window.location.search).get("kun");
    if (kun && /^[1-7]$/.test(kun)) return `?kun=${kun}`;
  }
  return "";
}

// Bitta joyda hisoblanadi — useFieldRouteToday va useOptimisticStatus
// AYNAN bir xil kalitni ishlatishi shart, aks holda optimistik yangilanish
// boshqa (o'lik) cache yozuviga tushib qoladi.
export const routeTodayQueryKey = () => ["field", "route", "today", getDevKunQs()] as const;

export const useFieldRouteToday = () => {
  const devKunQs = getDevKunQs();
  return useQuery<RouteTodayResponse, FieldApiError>({
    queryKey: routeTodayQueryKey(),
    queryFn: () => fetchFieldApi(`/route/today${devKunQs}`),
  });
};

export const useFieldProducts = () => useQuery<Product[], FieldApiError>({
  queryKey: ["field", "products"],
  queryFn: () => fetchFieldApi("/products"),
});

export const useFieldSummaryToday = () => useQuery<SummaryTodayResponse, FieldApiError>({
  queryKey: ["field", "summary", "today"],
  queryFn: () => fetchFieldApi("/summary/today"),
});

export const submitSale = (data: SaleInput) => 
  fetchFieldApi<SaleResponse>("/visits/sale", {
    method: "POST",
    body: JSON.stringify(data),
  });

export const submitNoSale = (data: NoSaleInput) => 
  fetchFieldApi<NoSaleResponse>("/visits/no-sale", {
    method: "POST",
    body: JSON.stringify(data),
  });

export const submitGps = (data: GpsInput) => 
  fetchFieldApi<{ok: boolean}>("/gps", {
    method: "POST",
    body: JSON.stringify(data),
  });

export const useFieldStatsToday = () => useQuery<StatsTodayResponse, FieldApiError>({
  queryKey: ["field", "stats", "today"],
  queryFn: () => fetchFieldApi("/stats/today"),
  staleTime: 30_000,
});

export const useFieldStatsWeek = () => useQuery<StatsWeekResponse, FieldApiError>({
  queryKey: ["field", "stats", "week"],
  queryFn: () => fetchFieldApi("/stats/week"),
  staleTime: 60_000,
});

export const useFieldShopDetail = (dokonId: number | null) =>
  useQuery<ShopDetailResponse, FieldApiError>({
    queryKey: ["field", "shop", dokonId],
    queryFn: () => fetchFieldApi(`/shops/${dokonId}`),
    enabled: dokonId != null && dokonId > 0,
    staleTime: 60_000,
  });

export const submitPayment = (data: PaymentInput) =>
  fetchFieldApi<PaymentResponse>("/visits/payment", {
    method: "POST",
    body: JSON.stringify(data),
  });

export const submitNewShop = (data: NewShopInput) =>
  fetchFieldApi<NewShopResponse>("/shops", {
    method: "POST",
    body: JSON.stringify(data),
  });
