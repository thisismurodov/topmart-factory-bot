import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import NotFound from "@/pages/not-found";
import { AppLayout } from "@/components/layout/AppLayout";

import StartScreen from "@/pages/StartScreen";
import RouteMap from "@/pages/RouteMap";
import DriveMode from "@/pages/DriveMode";
import VisitScreen from "@/pages/VisitScreen";
import SaleForm from "@/pages/SaleForm";
import NoSaleForm from "@/pages/NoSaleForm";
import SummaryScreen from "@/pages/SummaryScreen";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={StartScreen} />
      <Route path="/map" component={RouteMap} />
      <Route path="/drive" component={DriveMode} />
      <Route path="/visit/:id" component={VisitScreen} />
      <Route path="/visit/:id/sale" component={SaleForm} />
      <Route path="/visit/:id/nosale" component={NoSaleForm} />
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
          <Router />
        </AppLayout>
      </WouterRouter>
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
