import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEffect } from "react";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import Batches from "@/pages/batches";
import Workers from "@/pages/workers";
import Products from "@/pages/products";
import Salary from "@/pages/salary";
import Customers from "@/pages/customers";
import Sales from "@/pages/sales";
import Inventory from "@/pages/inventory";
import Login from "@/pages/login";
import { Layout } from "@/components/layout";
import { setAuthTokenGetter } from "@workspace/api-client-react";

const AUTH_TOKEN_KEY = "topmart_auth_token";

export function getStoredToken(): string | null {
  return localStorage.getItem(AUTH_TOKEN_KEY);
}
export function storeToken(token: string): void {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(AUTH_TOKEN_KEY);
}

setAuthTokenGetter(() => getStoredToken());

const queryClient = new QueryClient();

function RedirectToDashboard() {
  const [, setLocation] = useLocation();
  useEffect(() => { setLocation("/dashboard"); }, [setLocation]);
  return null;
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/">
        <RedirectToDashboard />
      </Route>
      <Route>
        <Layout>
          <Switch>
            <Route path="/dashboard" component={Dashboard} />
            <Route path="/batches" component={Batches} />
            <Route path="/workers" component={Workers} />
            <Route path="/products" component={Products} />
            <Route path="/salary" component={Salary} />
            <Route path="/customers" component={Customers} />
            <Route path="/sales" component={Sales} />
            <Route path="/inventory" component={Inventory} />
            <Route component={NotFound} />
          </Switch>
        </Layout>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
