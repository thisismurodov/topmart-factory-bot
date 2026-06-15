import { ReactNode, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useGetMe, getGetMeQueryKey, useLogout, useHealthCheck, getHealthCheckQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { 
  LayoutDashboard, 
  Package, 
  Users, 
  FileBox, 
  Banknote, 
  LogOut,
  ShoppingCart,
  Building2,
  ShoppingBag,
  Warehouse,
  CreditCard,
  BarChart2,
  HardHat,
  Boxes,
  Scale,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

const NAV_ITEMS = [
  { href: "/dashboard",  label: "Bosh sahifa", icon: LayoutDashboard },
  { href: "/batches",    label: "Partiyalar",  icon: Package },
  { href: "/workers",    label: "Ishchilar",   icon: Users },
  { href: "/products",   label: "Mahsulotlar", icon: FileBox },
  { href: "/raw-materials", label: "Xom ashyolar", icon: Boxes },
  { href: "/packers",    label: "Packerlar",   icon: HardHat },
  { href: "/salary",     label: "Maosh",       icon: Banknote },
  { href: "/payroll",    label: "Kg maosh",    icon: Scale },
  { href: "/customers",  label: "Mijozlar",    icon: Building2 },
  { href: "/sales",      label: "Savdolar",    icon: ShoppingBag },
  { href: "/debts",      label: "Nasiya",      icon: CreditCard },
  { href: "/reports",    label: "Hisobotlar",  icon: BarChart2 },
  { href: "/inventory",  label: "Ombor",       icon: Warehouse },
];

export function Layout({ children }: { children: ReactNode }) {
  const [, setLocation] = useLocation();
  const [location] = useLocation();
  const queryClient = useQueryClient();

  const { data: user, error, isLoading, refetch } = useGetMe({
    query: {
      queryKey: getGetMeQueryKey(),
      // Cold-start tolerant: retry transient/network errors (autoscale waking up),
      // but never retry a genuine 401 (invalid/expired token) — that goes to login.
      retry: (failureCount, err) => {
        const status = (err as { status?: number } | null)?.status;
        if (status === 401) return false;
        return failureCount < 4;
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    }
  });

  const { data: health } = useHealthCheck({
    query: {
      refetchInterval: 30000,
      queryKey: getHealthCheckQueryKey(),
    }
  });

  useEffect(() => {
    const status = (error as { status?: number } | null)?.status;
    // Only a real 401 means the session is invalid — log out then.
    // Transient errors (cold start / network) must NOT log the user out.
    if (status === 401) {
      import("@/App").then(({ clearToken }) => clearToken());
      setLocation("/login");
    }
  }, [error, setLocation]);

  const logout = useLogout({
    mutation: {
      onSuccess: () => {
        import("@/App").then(({ clearToken }) => clearToken());
        queryClient.clear();
        setLocation("/login");
      }
    }
  });

  const errorStatus = (error as { status?: number } | null)?.status;

  // Server unreachable after retries (e.g. autoscale cold start) — offer a manual
  // retry instead of silently logging the user out or spinning forever.
  if (!user && error && errorStatus !== 401) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-muted/20">
        <div className="flex flex-col items-center text-center max-w-sm px-4">
          <ShoppingCart className="w-12 h-12 text-muted-foreground mb-4" />
          <div className="text-foreground font-medium mb-1">Serverga ulanib bo'lmadi</div>
          <div className="text-sm text-muted-foreground mb-4">
            Server ishga tushayotgan bo'lishi mumkin. Bir necha soniyadan so'ng qayta urinib ko'ring.
          </div>
          <Button onClick={() => refetch()}>Qayta urinish</Button>
        </div>
      </div>
    );
  }

  if (isLoading || !user) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-muted/20">
        <div className="animate-pulse flex flex-col items-center">
          <ShoppingCart className="w-12 h-12 text-muted-foreground mb-4" />
          <div className="text-muted-foreground">Tizim yuklanmoqda...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-muted/20 overflow-hidden">
      <aside className="w-64 bg-sidebar border-r border-sidebar-border flex flex-col shrink-0">
        <div className="h-16 flex items-center px-6 border-b border-sidebar-border bg-sidebar-accent/50">
          <ShoppingCart className="w-6 h-6 text-sidebar-foreground mr-3" />
          <span className="font-bold text-lg tracking-tight text-sidebar-foreground uppercase">TopMart ERP</span>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const active = location.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href}>
                <div 
                  className={`flex items-center px-3 py-2.5 rounded-md cursor-pointer transition-colors ${
                    active 
                      ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium shadow-sm" 
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                  }`}
                  data-testid={`nav-${item.href.slice(1)}`}
                >
                  <item.icon className={`w-5 h-5 mr-3 ${active ? "text-sidebar-primary-foreground" : "text-sidebar-foreground/50"}`} />
                  {item.label}
                </div>
              </Link>
            );
          })}
        </nav>
        <div className="p-4 border-t border-sidebar-border">
          <div className="flex items-center justify-between mb-4 px-2">
            <div className="flex flex-col">
              <div className="text-sm font-medium text-sidebar-foreground/80">
                {user.username}
              </div>
              <div className="flex items-center mt-1">
                <span className={`w-2 h-2 rounded-full mr-2 ${health?.status === 'ok' ? 'bg-green-400' : 'bg-red-500'}`} />
                <span className="text-[10px] uppercase tracking-wider text-sidebar-foreground/50">
                  {health?.status === 'ok' ? 'Tizim faol' : 'Tizim o\'chiq'}
                </span>
              </div>
            </div>
            <div className="text-xs uppercase tracking-wider text-sidebar-foreground/50 font-mono bg-sidebar-accent px-2 py-1 rounded">
              {user.role}
            </div>
          </div>
          <Button 
            variant="outline" 
            className="w-full justify-start text-sidebar-foreground border-sidebar-accent bg-transparent hover:bg-sidebar-accent hover:text-sidebar-foreground"
            onClick={() => logout.mutate(undefined)}
            data-testid="btn-logout"
          >
            <LogOut className="w-4 h-4 mr-2" />
            Chiqish
          </Button>
        </div>
      </aside>
      <main className="flex-1 flex flex-col overflow-hidden relative">
        <div className="h-16 border-b border-border bg-card flex items-center px-8 shrink-0">
          <h1 className="text-xl font-semibold text-foreground tracking-tight">
            {NAV_ITEMS.find(i => location.startsWith(i.href))?.label || "Bosh sahifa"}
          </h1>
        </div>
        <div className="flex-1 overflow-y-auto p-8">
          <div className="max-w-7xl mx-auto">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
