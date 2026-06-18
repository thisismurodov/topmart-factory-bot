import { authFetch } from "@/App";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { ClipboardList, ChevronLeft, ChevronRight, Eye } from "lucide-react";

type AuditItem = {
  id: number;
  tableName: string;
  action: string;
  recordId: string | null;
  changedBy: string;
  oldData: unknown;
  newData: unknown;
  createdAt: string;
};

const PAGE_SIZE = 50;

const ACTION_COLORS: Record<string, string> = {
  CREATE: "bg-green-100 text-green-700 border-green-200",
  UPDATE: "bg-blue-100 text-blue-700 border-blue-200",
  DELETE: "bg-red-100 text-red-700 border-red-200",
  ARCHIVE: "bg-amber-100 text-amber-700 border-amber-200",
};

const TABLE_OPTIONS = [
  "workers", "products", "sales", "batches", "customers",
  "raw_materials", "salary_payments",
];

function ActionBadge({ action }: { action: string }) {
  const cls = ACTION_COLORS[action.toUpperCase()] ?? "bg-muted text-muted-foreground";
  return <Badge className={`${cls} shadow-none text-xs`}>{action}</Badge>;
}

function DataDialog({ item }: { item: AuditItem }) {
  const [open, setOpen] = useState(false);
  const hasData = item.oldData || item.newData;
  if (!hasData) return null;

  return (
    <>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setOpen(true)}>
        <Eye className="w-3.5 h-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ClipboardList className="w-4 h-4" />
              {item.tableName} · {item.action} · #{item.recordId}
            </DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4 text-sm">
            {item.oldData != null && (
              <div>
                <p className="font-medium text-muted-foreground mb-2 text-xs uppercase tracking-wide">Oldingi</p>
                <pre className="rounded bg-muted p-3 text-xs overflow-x-auto whitespace-pre-wrap">
                  {JSON.stringify(item.oldData, null, 2)}
                </pre>
              </div>
            )}
            {item.newData != null && (
              <div>
                <p className="font-medium text-muted-foreground mb-2 text-xs uppercase tracking-wide">Yangi</p>
                <pre className="rounded bg-muted p-3 text-xs overflow-x-auto whitespace-pre-wrap">
                  {JSON.stringify(item.newData, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function AuditLog() {
  const [page, setPage]         = useState(0);
  const [tableFilter, setTable] = useState("");
  const [actionFilter, setAction] = useState("");

  const params = new URLSearchParams({
    limit:  String(PAGE_SIZE),
    offset: String(page * PAGE_SIZE),
    ...(tableFilter  ? { table:  tableFilter  } : {}),
    ...(actionFilter ? { action: actionFilter } : {}),
  });

  const { data, isLoading } = useQuery({
    queryKey: ["audit-logs", page, tableFilter, actionFilter],
    queryFn: async () => {
      const res = await authFetch(`/api/audit-logs?${params}`);
      if (!res.ok) throw new Error("Yuklab bo'lmadi");
      return res.json() as Promise<{ total: number; items: AuditItem[] }>;
    },
  });

  const total = data?.total ?? 0;
  const items = data?.items ?? [];
  const totalPages = Math.ceil(total / PAGE_SIZE);

  function applyFilter() { setPage(0); }

  return (
    <div>
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ClipboardList className="w-6 h-6 text-primary" /> Audit log
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isLoading ? "Yuklanmoqda..." : `Jami ${total.toLocaleString()} yozuv`}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <Select value={tableFilter} onValueChange={v => { setTable(v === "__all__" ? "" : v); applyFilter(); }}>
          <SelectTrigger className="w-44 h-9">
            <SelectValue placeholder="Jadval (barchasi)" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Barchasi</SelectItem>
            {TABLE_OPTIONS.map(t => (
              <SelectItem key={t} value={t}>{t}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={actionFilter} onValueChange={v => { setAction(v === "__all__" ? "" : v); applyFilter(); }}>
          <SelectTrigger className="w-36 h-9">
            <SelectValue placeholder="Amal (barchasi)" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Barchasi</SelectItem>
            {["CREATE","UPDATE","DELETE","ARCHIVE"].map(a => (
              <SelectItem key={a} value={a}>{a}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {(tableFilter || actionFilter) && (
          <Button variant="ghost" size="sm" onClick={() => { setTable(""); setAction(""); setPage(0); }}>
            Filterni tozalash
          </Button>
        )}
      </div>

      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">ID</TableHead>
              <TableHead>Jadval</TableHead>
              <TableHead>Amal</TableHead>
              <TableHead>Yozuv ID</TableHead>
              <TableHead>Kim</TableHead>
              <TableHead>Vaqt</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 10 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 7 }).map((_, j) => (
                    <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-16 text-muted-foreground">
                  <ClipboardList className="w-10 h-10 mx-auto mb-2 opacity-20" />
                  Yozuvlar yo'q
                </TableCell>
              </TableRow>
            ) : (
              items.map(item => (
                <TableRow key={item.id}>
                  <TableCell className="font-mono text-xs text-muted-foreground">{item.id}</TableCell>
                  <TableCell>
                    <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
                      {item.tableName}
                    </span>
                  </TableCell>
                  <TableCell><ActionBadge action={item.action} /></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{item.recordId ?? "—"}</TableCell>
                  <TableCell className="text-sm">{item.changedBy}</TableCell>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(item.createdAt).toLocaleString("ru-RU", {
                      day: "2-digit", month: "2-digit", year: "2-digit",
                      hour: "2-digit", minute: "2-digit",
                    })}
                  </TableCell>
                  <TableCell><DataDialog item={item} /></TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-sm text-muted-foreground">
            Sahifa {page + 1} / {totalPages}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
