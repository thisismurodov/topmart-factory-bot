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

  // Dev fallback
  if (import.meta.env.DEV) {
    let devId = localStorage.getItem("field_dev_tg_id");
    if (!devId) {
      const params = new URLSearchParams(window.location.search);
      const urlDevId = params.get("dev_tg");
      if (urlDevId) {
        devId = urlDevId;
        localStorage.setItem("field_dev_tg_id", urlDevId);
      }
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
  status: "sold" | "nosale" | "pending";
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

// Hooks
export const useFieldMe = () => useQuery<MeResponse, FieldApiError>({
  queryKey: ["field", "me"],
  queryFn: () => fetchFieldApi("/me"),
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
