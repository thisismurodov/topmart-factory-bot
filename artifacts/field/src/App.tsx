import { lazy, Suspense, useEffect } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import NotFound from "@/pages/not-found";
import { AppLayout } from "@/components/layout/AppLayout";
import { AuthGate } from "@/components/AuthGate";
import { FieldApiError } from "@/lib/fieldApi";

import StartScreen from "@/pages/StartScreen";
import DriveMode from "@/pages/DriveMode";
import VisitScreen from "@/pages/VisitScreen";
import SaleForm from "@/pages/SaleForm";
import NoSaleForm from "@/pages/NoSaleForm";
import PaymentForm from "@/pages/PaymentForm";
import NewShopForm from "@/pages/NewShopForm";
import StatsScreen from "@/pages/StatsScreen";
import SummaryScreen from "@/pages/SummaryScreen";

// T014: Leaflet (xarita) — eng katta kutubxona. Uni alohida chunk qilamiz:
// ilova <2s ichida ochiladi, xarita chunk'i esa fonda oldindan yuklab olinadi
// (prefetch), shuning uchun /map ochilganda ham kutish bo'lmaydi.
const routeMapImport = () => import("@/pages/RouteMap");
const RouteMap = lazy(routeMapImport);

// 401/403 — avtorizatsiya xatosi: qayta urinish foydasiz, darhol xabar
// ko'rsatamiz. Boshqa xatolar 2 martagacha qayta uriniladi.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof FieldApiError && (error.status === 401 || error.status === 403)) {
          return false;
        }
        return failureCount < 2;
      },
    },
  },
});

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
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <AppLayout>
          <AuthGate>
            <Router />
          </AuthGate>
        </AppLayout>
      </WouterRouter>
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
