import { lazy, Suspense, useEffect } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { Toaster } from "@/components/ui/toaster";
import NotFound from "@/pages/not-found";
import { AppLayout } from "@/components/layout/AppLayout";
import { AuthGate } from "@/components/AuthGate";
import { CrashRecovery } from "@/components/CrashRecovery";
import { FieldApiError } from "@/lib/fieldApi";
import { createIdbPersister } from "@/lib/queryPersister";

import StartScreen from "@/pages/StartScreen";
import DriveMode from "@/pages/DriveMode";
import VisitScreen from "@/pages/VisitScreen";
import SaleForm from "@/pages/SaleForm";
import NoSaleForm from "@/pages/NoSaleForm";
import PaymentForm from "@/pages/PaymentForm";
import NewShopForm from "@/pages/NewShopForm";
import StatsScreen from "@/pages/StatsScreen";
import SummaryScreen from "@/pages/SummaryScreen";
import SyncCenter from "@/pages/SyncCenter";

// T014: Leaflet (xarita) — eng katta kutubxona. Uni alohida chunk qilamiz:
// ilova <2s ichida ochiladi, xarita chunk'i esa fonda oldindan yuklab olinadi
// (prefetch), shuning uchun /map ochilganda ham kutish bo'lmaydi.
const routeMapImport = () => import("@/pages/RouteMap");
const RouteMap = lazy(routeMapImport);

// 401/403 — avtorizatsiya xatosi: qayta urinish foydasiz, darhol xabar
// ko'rsatamiz. Boshqa xatolar 2 martagacha qayta uriniladi.
// T005: gcTime uzun — kesh IndexedDB'ga saqlanib, offline ochilishda ishlaydi.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 24 * 60 * 60 * 1000, // 24 soat — persist uchun shart
      retry: (failureCount, error) => {
        if (error instanceof FieldApiError && (error.status === 401 || error.status === 403)) {
          return false;
        }
        return failureCount < 2;
      },
    },
  },
});

// T001/T011 — react-query keshi IndexedDB'da (marshrut, mahsulotlar,
// do'kon ma'lumotlari, sessiya). Telegram yopilib qolsa ham tiklanadi.
const persister = createIdbPersister();

function MapLoading() {
  return (
    <div className="flex-1 flex items-center justify-center py-20">
      <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function Router() {
  // Xarita chunk'ini birinchi renderdan keyin fonda yuklab qo'yamiz
  useEffect(() => {
    const idle = window.setTimeout(() => { routeMapImport(); }, 300);
    return () => window.clearTimeout(idle);
  }, []);

  // Sync engine hodisalarni serverga yetkazgach, ekrandagi marshrut va
  // statistikani yangilaymiz (optimistik holat -> server holati).
  useEffect(() => {
    const onFlushed = () => {
      void queryClient.invalidateQueries({ queryKey: ["field"] });
    };
    window.addEventListener("sync-flushed", onFlushed);
    return () => window.removeEventListener("sync-flushed", onFlushed);
  }, []);

  return (
    <Switch>
      <Route path="/" component={StartScreen} />
      <Route path="/map">
        <Suspense fallback={<MapLoading />}>
          <RouteMap />
        </Suspense>
      </Route>
      <Route path="/drive" component={DriveMode} />
      <Route path="/visit/:id" component={VisitScreen} />
      <Route path="/visit/:id/sale" component={SaleForm} />
      <Route path="/visit/:id/nosale" component={NoSaleForm} />
      <Route path="/visit/:id/payment" component={PaymentForm} />
      <Route path="/shop/new" component={NewShopForm} />
      <Route path="/stats" component={StatsScreen} />
      <Route path="/summary" component={SummaryScreen} />
      <Route path="/sync" component={SyncCenter} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: 24 * 60 * 60 * 1000, // 24 soat
        buster: "offline-v1", // sxema o'zgarsa eski kesh tashlanadi
      }}
    >
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <AppLayout>
          <AuthGate>
            <CrashRecovery />
            <Router />
          </AuthGate>
        </AppLayout>
      </WouterRouter>
      <Toaster />
    </PersistQueryClientProvider>
  );
}

export default App;
