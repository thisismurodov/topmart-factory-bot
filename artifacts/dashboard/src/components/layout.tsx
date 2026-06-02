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
  Factory
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/batches", label: "Batches", icon: Package },
  { href: "/workers", label: "Workers", icon: Users },
  { href: "/products", label: "Products", icon: FileBox },
  { href: "/salary", label: "Salary", icon: Banknote },
];

export function Layout({ children }: { children: ReactNode }) {
  const [, setLocation] = useLocation();
  const [location] = useLocation();
  const queryClient = useQueryClient();

  const { data: user, error, isLoading } = useGetMe({
    query: {
      retry: false,
      queryKey: getGetMeQueryKey(),
    }
  });

  const { data: health } = useHealthCheck({
    query: {
      refetchInterval: 30000,
      queryKey: getHealthCheckQueryKey(),
    }
  });

  useEffect(() => {
    if (error) {
      setLocation("/login");
    }
  }, [error, setLocation]);

  const logout = useLogout({
    mutation: {
      onSuccess: () => {
        queryClient.clear();
        setLocation("/login");
      }
    }
  });

  if (isLoading || !user) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-muted/20">
        <div className="animate-pulse flex flex-col items-center">
          <Factory className="w-12 h-12 text-muted-foreground mb-4" />
          <div className="text-muted-foreground">Initializing Control Room...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-muted/20 overflow-hidden">
      <aside className="w-64 bg-sidebar border-r border-sidebar-border flex flex-col shrink-0">
        <div className="h-16 flex items-center px-6 border-b border-sidebar-border bg-sidebar-accent/50">
          <Factory className="w-6 h-6 text-primary mr-3" />
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
                      ? "bg-primary text-primary-foreground font-medium shadow-sm" 
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                  }`}
                  data-testid={`nav-${item.label.toLowerCase()}`}
                >
                  <item.icon className={`w-5 h-5 mr-3 ${active ? "text-primary-foreground" : "text-sidebar-foreground/50"}`} />
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
                <span className={`w-2 h-2 rounded-full mr-2 ${health?.status === 'ok' ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className="text-[10px] uppercase tracking-wider text-sidebar-foreground/50">
                  {health?.status === 'ok' ? 'System Online' : 'System Offline'}
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
            Sign Out
          </Button>
        </div>
      </aside>
      <main className="flex-1 flex flex-col overflow-hidden relative">
        <div className="h-16 border-b border-border bg-card flex items-center px-8 shrink-0">
          <h1 className="text-xl font-semibold text-foreground tracking-tight">
            {NAV_ITEMS.find(i => location.startsWith(i.href))?.label || "Dashboard"}
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
