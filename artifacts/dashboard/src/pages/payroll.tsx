import { useState } from "react";
import { authFetch } from "@/App";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useGetPayrollRoleRates, getGetPayrollRoleRatesQueryKey, useUpdatePayrollRoleRate,
  useGetPayrollWorkerEarnings, getGetPayrollWorkerEarningsQueryKey,
  useGetPayrollDayStatus, getGetPayrollDayStatusQueryKey,
  useGetWorkers, getGetWorkersQueryKey,
  useGetProducts, getGetProductsQueryKey,
  useCreateProductionLine,
  useDeleteProductionLine,
  useAddProductionLineWorker,
  useRemoveProductionLineWorker,
  useClosePayrollDay,
} from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatNumber, formatDate } from "@/lib/format";
import {
  Lock, LockOpen, Save, Plus, Trash2, Weight, UserPlus, Factory,
  AlertTriangle, Hammer, Boxes, PackageCheck, Settings, Pencil,
} from "lucide-react";

const ROLE_UZ: Record<string, string> = {
  producer: "Ishlab chiqaruvchi",
  preparation: "Tayyorlash",
  packaging: "Qadoqlash",
  packer: "Qadoqlash",
};

const RATE_ROLES = ["producer", "preparation", "packaging"];

const METHOD_UZ: Record<string, string> = {
  PRODUCT_RATE: "Dona (mahsulot stavkasi)",
  ROLE_BASED_KG: "Liniya bo'yicha",
};

function roleLabel(role: string): string {
  return ROLE_UZ[role] ?? role;
}

function errMsg(e: unknown, fallback: string): string {
  const data = (e as { data?: { error?: string } } | null)?.data;
  if (data && typeof data.error === "string" && data.error.trim()) return data.error;
  return fallback;
}

// ── Types ──────────────────────────────────────────────────────────────────────
type Member = { id: number; workerName: string; role: string };

type LineRoleStatus = {
  roleKey: string;
  label: string;
  rate: number;
  maxWorkers: number;
  members: Member[];
  pool: number | null;
  perWorker: number | null;
};

type LineStatus = {
  lineId: number;
  lineName: string;
  totalKg: number;
  closed: boolean;
  closedAt: string | null;
  producers: Member[];
  preparation: Member[];
  packaging: Member[];
  producerRate: number;
  prepRate: number;
  packagingRate: number;
  prepPool: number;
  prepPerWorker: number;
  packagingPool: number;
  packagingPerWorker: number;
  roles?: LineRoleStatus[];
};

type LineConfig = {
  lineId: number;
  lineName: string;
  roles: { roleKey: string; label: string; rate: number; maxWorkers: number }[];
};

// ── Role rate row (global settings tab) ────────────────────────────────────────
function RoleRateRow({ role, rate, updatedAt }: { role: string; rate: number; updatedAt: string | null }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [value, setValue] = useState<string>(String(rate));
  const changed = Number(value) !== rate && value.trim() !== "";

  const update = useUpdatePayrollRoleRate({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetPayrollRoleRatesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetPayrollDayStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetPayrollWorkerEarningsQueryKey() });
        toast({ title: "Saqlandi", description: `${roleLabel(role)} stavkasi yangilandi.` });
      },
      onError: (e) => toast({ title: "Xato", description: errMsg(e, "Stavkani saqlab bo'lmadi."), variant: "destructive" }),
    },
  });

  return (
    <TableRow data-testid={`rate-row-${role}`}>
      <TableCell className="font-medium">{roleLabel(role)}</TableCell>
      <TableCell>
        <div className="flex items-center gap-2 max-w-[260px]">
          <Input
            type="number"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-9 font-mono"
            data-testid={`rate-input-${role}`}
          />
          <span className="text-xs text-muted-foreground whitespace-nowrap">so'm/kg</span>
        </div>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">{updatedAt ? formatDate(updatedAt) : "—"}</TableCell>
      <TableCell className="text-right">
        <Button
          size="sm"
          variant="outline"
          disabled={!changed || update.isPending}
          onClick={() => update.mutate({ data: { role, rate: Number(value) } })}
          data-testid={`btn-save-rate-${role}`}
        >
          <Save className="w-4 h-4 mr-2" />
          {update.isPending ? "Saqlanmoqda..." : "Saqlash"}
        </Button>
      </TableCell>
    </TableRow>
  );
}

// ── One role column inside a line card ──────────────────────────────────────────
function RoleSection({
  roleKey, label, members, availableWorkers, closed, totalKg, pool, perWorker, rate, maxWorkers, onAdd, onRemove, adding,
}: {
  roleKey: string;
  label: string;
  members: Member[];
  availableWorkers: string[];
  closed: boolean;
  totalKg: number;
  pool: number | null;
  perWorker: number | null;
  rate: number;
  maxWorkers: number;
  onAdd: (role: string, workerName: string) => void;
  onRemove: (memberId: number, workerName: string, role: string) => void;
  adding: boolean;
}) {
  const [sel, setSel] = useState<string>("");
  const atMax = members.length >= maxWorkers;
  const isPool = roleKey !== "producer";

  return (
    <div className="rounded-lg border border-border bg-card/40 flex flex-col" data-testid={`role-section-${roleKey}`}>
      <div className="px-3 py-2.5 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Hammer className="w-4 h-4 text-muted-foreground" />
          <span className="font-medium text-sm">{label || roleLabel(roleKey)}</span>
        </div>
        <Badge
          variant="outline"
          className={members.length === 0 ? "text-amber-600 border-amber-300" : "text-muted-foreground"}
        >
          {members.length}/{maxWorkers}
        </Badge>
      </div>

      <div className="px-3 py-2 text-xs border-b border-border bg-muted/20">
        {isPool ? (
          <div className="space-y-0.5">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Fond ({formatNumber(totalKg)}×{formatNumber(rate)})</span>
              <span className="font-mono font-medium">{formatCurrency(pool ?? 0)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Har biriga ({members.length || 0} kishi)</span>
              <span className="font-mono font-medium text-primary">{formatCurrency(perWorker ?? 0)}</span>
            </div>
          </div>
        ) : (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Stavka (har partiyada)</span>
            <span className="font-mono font-medium">{formatNumber(rate)} so'm/kg</span>
          </div>
        )}
      </div>

      <div className="flex-1 p-2 space-y-1 min-h-[60px]">
        {members.length === 0 ? (
          <div className="text-xs text-amber-600 flex items-center gap-1.5 px-1 py-2">
            <AlertTriangle className="w-3.5 h-3.5" /> Ishchi biriktirilmagan
          </div>
        ) : (
          members.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between gap-2 rounded-md bg-background border border-border px-2 py-1.5"
              data-testid={`member-${m.id}`}
            >
              <span className="text-sm truncate">{m.workerName || "(nomsiz)"}</span>
              {!closed && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => onRemove(m.id, m.workerName, roleKey)}
                  data-testid={`btn-remove-member-${m.id}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
          ))
        )}
      </div>

      {!closed && (
        <div className="p-2 border-t border-border flex gap-1.5">
          <Select value={sel} onValueChange={setSel} disabled={atMax}>
            <SelectTrigger className="h-8 text-xs" data-testid={`select-add-${roleKey}`}>
              <SelectValue placeholder={atMax ? `Maksimal (${maxWorkers})` : "Ishchi tanlang"} />
            </SelectTrigger>
            <SelectContent>
              {availableWorkers.length === 0 ? (
                <div className="px-2 py-2 text-xs text-muted-foreground text-center">Mavjud ishchi yo'q</div>
              ) : (
                availableWorkers.map((w) => (
                  <SelectItem key={w} value={w}>{w || "(nomsiz)"}</SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          <Button
            size="icon"
            className="h-8 w-8 shrink-0"
            disabled={!sel || atMax || adding}
            onClick={() => { onAdd(roleKey, sel); setSel(""); }}
            data-testid={`btn-add-${roleKey}`}
          >
            <Plus className="w-4 h-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Line Config Dialog ──────────────────────────────────────────────────────────
function LineConfigDialog({
  line, open, onClose, onRefresh,
}: {
  line: LineStatus;
  open: boolean;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Current role configs from day-status (roles array)
  const roles = line.roles ?? [];

  // Edit state for existing roles
  const [editMap, setEditMap] = useState<Record<string, { label: string; rate: string; maxWorkers: string }>>({});

  const getEdit = (roleKey: string, defaults: { label: string; rate: number; maxWorkers: number }) => {
    return editMap[roleKey] ?? {
      label: defaults.label,
      rate: String(defaults.rate),
      maxWorkers: String(defaults.maxWorkers),
    };
  };

  const setEdit = (roleKey: string, field: "label" | "rate" | "maxWorkers", value: string) => {
    setEditMap((prev) => ({
      ...prev,
      [roleKey]: { ...getEdit(roleKey, { label: "", rate: 0, maxWorkers: 5 }), [field]: value },
    }));
  };

  // New role form
  const [newRoleKey, setNewRoleKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newRate, setNewRate] = useState("");
  const [newMax, setNewMax] = useState("5");
  const [saving, setSaving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Line rename
  const [editName, setEditName] = useState(line.lineName);
  const [renamingSaving, setRenamingSaving] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetPayrollDayStatusQueryKey() });
    onRefresh();
  };

  const handleSaveRole = async (roleKey: string) => {
    const existing = roles.find((r) => r.roleKey === roleKey);
    if (!existing) return;
    const ed = getEdit(roleKey, existing);
    setSaving(roleKey);
    try {
      const res = await authFetch(`/api/payroll/lines/${line.lineId}/roles/${encodeURIComponent(roleKey)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: ed.label.trim() || roleKey,
          rate: Number(ed.rate),
          maxWorkers: Number(ed.maxWorkers),
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        toast({ title: "Xato", description: d.error ?? "Saqlab bo'lmadi.", variant: "destructive" });
        return;
      }
      toast({ title: "Saqlandi", description: `${ed.label || roleKey} yangilandi.` });
      setEditMap((prev) => { const n = { ...prev }; delete n[roleKey]; return n; });
      invalidate();
    } finally {
      setSaving(null);
    }
  };

  const handleDeleteRole = async (roleKey: string) => {
    setDeleting(roleKey);
    try {
      const res = await authFetch(`/api/payroll/lines/${line.lineId}/roles/${encodeURIComponent(roleKey)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        toast({ title: "Xato", description: d.error ?? "O'chirib bo'lmadi.", variant: "destructive" });
        return;
      }
      toast({ title: "O'chirildi", description: `${roleKey} roli olib tashlandi.` });
      invalidate();
    } finally {
      setDeleting(null);
    }
  };

  const handleAddRole = async () => {
    if (!newRoleKey.trim() || !newRate.trim()) {
      toast({ title: "Xato", description: "Rol kaliti va stavka majburiy.", variant: "destructive" });
      return;
    }
    setAdding(true);
    try {
      const res = await authFetch(`/api/payroll/lines/${line.lineId}/roles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roleKey: newRoleKey.trim(),
          label: newLabel.trim() || newRoleKey.trim(),
          rate: Number(newRate),
          maxWorkers: Number(newMax) || 5,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        toast({ title: "Xato", description: d.error ?? "Qo'shib bo'lmadi.", variant: "destructive" });
        return;
      }
      toast({ title: "Qo'shildi", description: `${newLabel || newRoleKey} roli qo'shildi.` });
      setNewRoleKey(""); setNewLabel(""); setNewRate(""); setNewMax("5");
      invalidate();
    } finally {
      setAdding(false);
    }
  };

  const handleRename = async () => {
    if (!editName.trim() || editName.trim() === line.lineName) return;
    setRenamingSaving(true);
    try {
      const res = await authFetch(`/api/payroll/lines/${line.lineId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        toast({ title: "Xato", description: d.error ?? "Nom saqlab bo'lmadi.", variant: "destructive" });
        return;
      }
      toast({ title: "Saqlandi", description: "Liniya nomi yangilandi." });
      invalidate();
    } finally {
      setRenamingSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="w-4 h-4" /> Liniya sozlamalari
          </DialogTitle>
        </DialogHeader>

        {/* Rename line */}
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Liniya nomi</Label>
          <div className="flex gap-2">
            <Input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="h-9"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!editName.trim() || editName.trim() === line.lineName || renamingSaving}
              onClick={handleRename}
            >
              <Save className="w-4 h-4 mr-1" /> Saqlash
            </Button>
          </div>
        </div>

        {/* Current roles */}
        <div className="space-y-2">
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Rollar ({roles.length > 0 ? "sozlangan" : "standart (3 ta)"})
          </Label>
          {roles.length === 0 && (
            <p className="text-xs text-muted-foreground bg-muted/30 rounded-md p-3">
              Hali maxsus rol yo'q — standart 3 ta rol ishlatilmoqda
              (Ishlab chiqaruvchi 1125/kg · Tayyorlash 375/kg · Qadoqlash 750/kg).
              Quyida yangi rol qo'shib, liniyani moslashtiring.
            </p>
          )}
          {roles.map((r) => {
            const ed = getEdit(r.roleKey, r);
            const isChanged =
              ed.label !== r.label ||
              Number(ed.rate) !== r.rate ||
              Number(ed.maxWorkers) !== r.maxWorkers;
            const members = line.roles?.find((lr) => lr.roleKey === r.roleKey)?.members ?? [];
            return (
              <div key={r.roleKey} className="border border-border rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-mono text-muted-foreground bg-muted/40 px-2 py-0.5 rounded">{r.roleKey}</span>
                  <span className="text-xs text-muted-foreground">{members.length} ishchi</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Nom</Label>
                    <Input
                      value={ed.label}
                      onChange={(e) => setEdit(r.roleKey, "label", e.target.value)}
                      className="h-8 text-sm"
                      placeholder={r.roleKey}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Stavka (so'm/kg)</Label>
                    <Input
                      type="number"
                      value={ed.rate}
                      onChange={(e) => setEdit(r.roleKey, "rate", e.target.value)}
                      className="h-8 text-sm font-mono"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Max ishchi</Label>
                    <Input
                      type="number"
                      value={ed.maxWorkers}
                      onChange={(e) => setEdit(r.roleKey, "maxWorkers", e.target.value)}
                      className="h-8 text-sm font-mono"
                      min={1}
                    />
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!isChanged || saving === r.roleKey}
                    onClick={() => handleSaveRole(r.roleKey)}
                  >
                    <Save className="w-3.5 h-3.5 mr-1" />
                    {saving === r.roleKey ? "Saqlanmoqda..." : "Saqlash"}
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        disabled={deleting === r.roleKey}
                      >
                        <Trash2 className="w-3.5 h-3.5 mr-1" /> O'chirish
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Rolni o'chirish</AlertDialogTitle>
                        <AlertDialogDescription>
                          <strong>{r.label || r.roleKey}</strong> roli liniyadan olib tashlanadi.
                          Bu rolda ishchilar bo'lmasligi kerak.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Bekor</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => handleDeleteRole(r.roleKey)}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          O'chirish
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            );
          })}
        </div>

        {/* Add new role */}
        <div className="space-y-2 border-t border-border pt-4">
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Yangi rol qo'shish
          </Label>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Rol kaliti (lotin, bo'sh joysiz)</Label>
              <Input
                value={newRoleKey}
                onChange={(e) => setNewRoleKey(e.target.value.replace(/\s/g, "_"))}
                placeholder="masalan: cutting"
                className="h-8 text-sm font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Nom (uzbekcha)</Label>
              <Input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="masalan: Kesish"
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Stavka (so'm/kg)</Label>
              <Input
                type="number"
                value={newRate}
                onChange={(e) => setNewRate(e.target.value)}
                placeholder="masalan: 500"
                className="h-8 text-sm font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Max ishchi soni</Label>
              <Input
                type="number"
                value={newMax}
                onChange={(e) => setNewMax(e.target.value)}
                className="h-8 text-sm font-mono"
                min={1}
              />
            </div>
          </div>
          <Button
            size="sm"
            disabled={!newRoleKey.trim() || !newRate.trim() || adding}
            onClick={handleAddRole}
            className="w-full"
          >
            <Plus className="w-4 h-4 mr-2" />
            {adding ? "Qo'shilmoqda..." : "Rol qo'shish"}
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Yopish</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── A single production line card ────────────────────────────────────────────────
function LineCard({
  line, workers, globalRoleMembers, onAdd, onRemove, onDelete, adding, deleting,
}: {
  line: LineStatus;
  workers: string[];
  globalRoleMembers: Map<string, Set<string>>;
  onAdd: (lineId: number, role: string, workerName: string) => void;
  onRemove: (memberId: number, workerName: string, role: string) => void;
  onDelete: (lineId: number, lineName: string) => void;
  adding: boolean;
  deleting: boolean;
}) {
  const [configOpen, setConfigOpen] = useState(false);
  const queryClient = useQueryClient();

  // Use per-line roles if configured, else build from legacy fields
  const roles: LineRoleStatus[] = line.roles?.length
    ? line.roles
    : [
        { roleKey: "producer", label: "Ishlab chiqaruvchi", rate: line.producerRate, maxWorkers: 5,
          members: line.producers, pool: null, perWorker: null },
        { roleKey: "preparation", label: "Tayyorlash", rate: line.prepRate, maxWorkers: 3,
          members: line.preparation, pool: line.prepPool, perWorker: line.prepPerWorker },
        { roleKey: "packaging", label: "Qadoqlash", rate: line.packagingRate, maxWorkers: 5,
          members: line.packaging, pool: line.packagingPool, perWorker: line.packagingPerWorker },
      ];

  return (
    <Card className="border-border overflow-hidden" data-testid={`line-card-${line.lineId}`}>
      <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3 bg-muted/30">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Factory className="w-4.5 h-4.5" />
          </div>
          <div>
            <h3 className="font-semibold tracking-tight">{line.lineName}</h3>
            <div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
              <Weight className="w-3.5 h-3.5" />
              Bugun: <span className="font-medium text-foreground">{formatNumber(line.totalKg)} kg</span>
              {line.roles?.length ? (
                <span className="ml-1 text-primary/70">· {line.roles.length} rol</span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {line.closed ? (
            <Badge className="bg-primary/15 text-primary border-primary/30 hover:bg-primary/15 cursor-default">
              <Lock className="w-3 h-3 mr-1" /> Yopilgan
            </Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground cursor-default">
              <LockOpen className="w-3 h-3 mr-1" /> Ochiq
            </Badge>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={() => setConfigOpen(true)}
            data-testid={`btn-config-line-${line.lineId}`}
            title="Liniya sozlamalari"
          >
            <Settings className="w-4 h-4" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                disabled={deleting}
                data-testid={`btn-delete-line-${line.lineId}`}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Liniyani o'chirish</AlertDialogTitle>
                <AlertDialogDescription>
                  <strong>{line.lineName}</strong> liniyasi va unga biriktirilgan barcha ishchilar o'chiriladi.
                  Avval hisoblangan maoshlar saqlanib qoladi. Davom etilsinmi?
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => onDelete(line.lineId, line.lineName)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  data-testid={`btn-confirm-delete-line-${line.lineId}`}
                >
                  O'chirish
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <CardContent className="p-4">
        <div className={`grid gap-3 ${roles.length <= 2 ? "grid-cols-1 sm:grid-cols-2" : roles.length === 3 ? "grid-cols-1 md:grid-cols-3" : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4"}`}>
          {roles.map((roleStatus) => {
            const roleWorkers = new Set(roleStatus.members.map((m) => m.workerName));
            const globalSet = globalRoleMembers.get(roleStatus.roleKey) ?? new Set<string>();
            const available = workers.filter((w) => !globalSet.has(w) && !roleWorkers.has(w));
            return (
              <RoleSection
                key={roleStatus.roleKey}
                roleKey={roleStatus.roleKey}
                label={roleStatus.label}
                members={roleStatus.members}
                availableWorkers={available}
                closed={line.closed}
                totalKg={line.totalKg}
                pool={roleStatus.pool}
                perWorker={roleStatus.perWorker}
                rate={roleStatus.rate}
                maxWorkers={roleStatus.maxWorkers}
                onAdd={(rk, w) => onAdd(line.lineId, rk, w)}
                onRemove={onRemove}
                adding={adding}
              />
            );
          })}
        </div>
      </CardContent>

      <LineConfigDialog
        line={line}
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        onRefresh={() => queryClient.invalidateQueries({ queryKey: getGetPayrollDayStatusQueryKey() })}
      />
    </Card>
  );
}

export default function Payroll() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: dayStatus, isLoading: dayLoading } = useGetPayrollDayStatus({
    query: { queryKey: getGetPayrollDayStatusQueryKey() },
  });
  const { data: roleRates, isLoading: ratesLoading } = useGetPayrollRoleRates({
    query: { queryKey: getGetPayrollRoleRatesQueryKey() },
  });
  const { data: workers } = useGetWorkers({ query: { queryKey: getGetWorkersQueryKey() } });
  const { data: products, isLoading: productsLoading } = useGetProducts({
    query: { queryKey: getGetProductsQueryKey() },
  });
  const { data: earnings, isLoading: earningsLoading } = useGetPayrollWorkerEarnings({
    query: { queryKey: getGetPayrollWorkerEarningsQueryKey() },
  });

  const invalidateDay = () => {
    queryClient.invalidateQueries({ queryKey: getGetPayrollDayStatusQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPayrollWorkerEarningsQueryKey() });
  };

  const [newLineName, setNewLineName] = useState<string>("");

  const createLine = useCreateProductionLine({
    mutation: {
      onSuccess: () => {
        invalidateDay();
        setNewLineName("");
        toast({ title: "Yaratildi", description: "Yangi liniya qo'shildi." });
      },
      onError: (e) => toast({ title: "Xato", description: errMsg(e, "Liniyani yaratib bo'lmadi."), variant: "destructive" }),
    },
  });

  const deleteLine = useDeleteProductionLine({
    mutation: {
      onSuccess: () => { invalidateDay(); toast({ title: "O'chirildi", description: "Liniya o'chirildi." }); },
      onError: (e) => toast({ title: "Xato", description: errMsg(e, "Liniyani o'chirib bo'lmadi."), variant: "destructive" }),
    },
  });

  const addWorker = useAddProductionLineWorker({
    mutation: {
      onSuccess: () => { invalidateDay(); toast({ title: "Qo'shildi", description: "Ishchi liniyaga biriktirildi." }); },
      onError: (e) => toast({ title: "Xato", description: errMsg(e, "Ishchini biriktirib bo'lmadi."), variant: "destructive" }),
    },
  });

  const removeWorker = useRemoveProductionLineWorker({
    mutation: {
      onSuccess: () => { invalidateDay(); toast({ title: "Olib tashlandi", description: "Ishchi liniyadan olib tashlandi." }); },
      onError: (e) => toast({ title: "Xato", description: errMsg(e, "Ishchini olib tashlab bo'lmadi."), variant: "destructive" }),
    },
  });

  const closeDay = useClosePayrollDay({
    mutation: {
      onSuccess: (res) => {
        invalidateDay();
        if (res.alreadyClosed) {
          toast({ title: "Allaqachon yopilgan", description: "Bugungi kun barcha liniyalar uchun yopilgan." });
        } else {
          toast({
            title: "Kun yopildi",
            description: `${res.newEntryCount} ta ulush hisoblandi · jami ${formatNumber(res.totalKg)} kg.`,
          });
        }
      },
      onError: (e) => toast({ title: "Xato", description: errMsg(e, "Kunni yopib bo'lmadi."), variant: "destructive" }),
    },
  });

  const updateMethod = useMutation({
    mutationFn: async ({ name, method }: { name: string; method: string }) => {
      const res = await authFetch(`/api/products/${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payrollMethod: method }),
      });
      if (!res.ok) throw new Error("Saqlashda xato");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getGetProductsQueryKey() });
      toast({ title: "Saqlandi", description: "Mahsulot maosh usuli yangilandi." });
    },
    onError: () => toast({ title: "Xato", description: "Maosh usulini saqlab bo'lmadi.", variant: "destructive" }),
  });

  const lines = (dayStatus?.lines ?? []) as LineStatus[];
  const workerNames = (workers ?? []).map((w) => w.name).filter((n): n is string => !!n);

  // Build global member sets per role (to prevent same worker in same role on two lines)
  const globalRoleMembers = new Map<string, Set<string>>();
  for (const l of lines) {
    const roles: LineRoleStatus[] = l.roles?.length
      ? l.roles
      : [
          { roleKey: "producer", label: "", rate: 0, maxWorkers: 5, members: l.producers, pool: null, perWorker: null },
          { roleKey: "preparation", label: "", rate: 0, maxWorkers: 3, members: l.preparation, pool: 0, perWorker: 0 },
          { roleKey: "packaging", label: "", rate: 0, maxWorkers: 5, members: l.packaging, pool: 0, perWorker: 0 },
        ];
    for (const rs of roles) {
      const s = globalRoleMembers.get(rs.roleKey) ?? new Set<string>();
      for (const m of rs.members) s.add(m.workerName);
      globalRoleMembers.set(rs.roleKey, s);
    }
  }

  const unassignedKg = dayStatus?.unassignedKg ?? 0;
  const allClosed = dayStatus?.closed ?? false;

  // Warning: lines with production but missing non-producer roles
  const emptyRoleLines = lines.filter((l) => {
    if (l.totalKg === 0) return false;
    const roles: LineRoleStatus[] = l.roles?.length
      ? l.roles
      : [
          { roleKey: "preparation", label: "Tayyorlash", rate: 0, maxWorkers: 3, members: l.preparation, pool: 0, perWorker: 0 },
          { roleKey: "packaging", label: "Qadoqlash", rate: 0, maxWorkers: 5, members: l.packaging, pool: 0, perWorker: 0 },
        ];
    return roles.some((r) => r.roleKey !== "producer" && r.members.length === 0);
  });
  const hasWarnings = unassignedKg > 0 || emptyRoleLines.length > 0;

  const totalToday = (earnings ?? []).reduce((a, r) => a + r.todayEarnings, 0);
  const totalMonth = (earnings ?? []).reduce((a, r) => a + r.monthEarnings, 0);
  const totalLifetime = (earnings ?? []).reduce((a, r) => a + r.lifetimeEarnings, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Ishlab chiqarish liniyalari</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Har bir liniya o'z rollari, stavkalari va ishchilariga ega. ⚙️ tugmasi orqali liniyani sozlang.
        </p>
      </div>

      {/* Day status banner */}
      <Card className="border-border">
        <CardContent className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 ${allClosed ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>
              {allClosed ? <Lock className="w-5 h-5" /> : <LockOpen className="w-5 h-5" />}
            </div>
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">
                Bugungi kun {dayStatus ? `(${formatDate(dayStatus.workDate)})` : ""}
              </div>
              {dayLoading ? (
                <Skeleton className="h-6 w-56" />
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-lg font-semibold tracking-tight flex items-center gap-1.5">
                    <Weight className="w-4 h-4 text-muted-foreground" />
                    {formatNumber(dayStatus?.totalKg ?? 0)} kg
                  </span>
                  {allClosed ? (
                    <Badge className="bg-primary/15 text-primary border-primary/30 hover:bg-primary/15 cursor-default">Yopilgan</Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground cursor-default">Ochiq</Badge>
                  )}
                  {unassignedKg > 0 && (
                    <Badge variant="outline" className="text-amber-600 border-amber-300 cursor-default" data-testid="badge-unassigned">
                      <AlertTriangle className="w-3 h-3 mr-1" /> {formatNumber(unassignedKg)} kg liniyasiz
                    </Badge>
                  )}
                </div>
              )}
            </div>
          </div>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button disabled={closeDay.isPending || lines.length === 0} data-testid="btn-close-day">
                <Lock className="w-4 h-4 mr-2" />
                {closeDay.isPending ? "Yopilmoqda..." : "Kunni yopish"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Kunni yopish</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-2">
                    <p>
                      Barcha liniyalar uchun bugungi ulush hisoblanadi va ishchilarga Telegram orqali xabar yuboriladi.
                      Bu amal har bir liniya uchun kuniga bir marta bajariladi.
                    </p>
                    {hasWarnings && (
                      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-800 text-sm space-y-1">
                        <div className="font-medium flex items-center gap-1.5">
                          <AlertTriangle className="w-4 h-4" /> Diqqat
                        </div>
                        {unassignedKg > 0 && (
                          <p>{formatNumber(unassignedKg)} kg hech qaysi liniyaga biriktirilmagan — bu ulush hisoblanmaydi.</p>
                        )}
                        {emptyRoleLines.map((l) => (
                          <p key={l.lineId}>
                            <strong>{l.lineName}</strong>: ba'zi rollarda ishchi yo'q — ushbu fond hisoblanmaydi.
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
                <AlertDialogAction onClick={() => closeDay.mutate()} data-testid="btn-confirm-close-day">
                  Kunni yopish
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>

      <Tabs defaultValue="lines" className="space-y-6">
        <TabsList>
          <TabsTrigger value="lines" data-testid="tab-lines">Liniyalar</TabsTrigger>
          <TabsTrigger value="earnings" data-testid="tab-earnings">Ishchilar daromadi</TabsTrigger>
          <TabsTrigger value="settings" data-testid="tab-settings">Sozlamalar</TabsTrigger>
        </TabsList>

        {/* ── Lines tab ── */}
        <TabsContent value="lines" className="space-y-5">
          <Card className="border-border">
            <CardContent className="p-4 flex flex-col sm:flex-row gap-3 sm:items-end">
              <div className="flex-1 space-y-1.5">
                <Label className="text-xs">Yangi liniya nomi</Label>
                <Input
                  value={newLineName}
                  onChange={(e) => setNewLineName(e.target.value)}
                  placeholder="Masalan: Arqon Bo'limi 2"
                  data-testid="input-new-line"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newLineName.trim()) createLine.mutate({ data: { name: newLineName.trim() } });
                  }}
                />
              </div>
              <Button
                disabled={!newLineName.trim() || createLine.isPending}
                onClick={() => createLine.mutate({ data: { name: newLineName.trim() } })}
                data-testid="btn-create-line"
              >
                <Plus className="w-4 h-4 mr-2" />
                {createLine.isPending ? "Qo'shilmoqda..." : "Liniya qo'shish"}
              </Button>
            </CardContent>
          </Card>

          {dayLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-64 w-full rounded-xl" />)}
            </div>
          ) : lines.length === 0 ? (
            <Card className="border-border border-dashed">
              <CardContent className="py-12 text-center text-muted-foreground">
                <Factory className="w-8 h-8 mx-auto mb-3 opacity-40" />
                Hali liniya yo'q. Yuqorida birinchi liniyani qo'shing.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {lines.map((line) => (
                <LineCard
                  key={line.lineId}
                  line={line}
                  workers={workerNames}
                  globalRoleMembers={globalRoleMembers}
                  onAdd={(lineId, role, workerName) => addWorker.mutate({ id: lineId, data: { workerName, role } })}
                  onRemove={(memberId) => removeWorker.mutate({ id: memberId })}
                  onDelete={(lineId) => deleteLine.mutate({ id: lineId })}
                  adding={addWorker.isPending}
                  deleting={deleteLine.isPending}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Earnings tab ── */}
        <TabsContent value="earnings" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className="border-border bg-sidebar text-sidebar-foreground">
              <CardContent className="p-5">
                <div className="text-xs font-bold uppercase tracking-wider mb-2 text-sidebar-foreground/70">Bugun</div>
                {earningsLoading ? <Skeleton className="h-8 w-24 bg-sidebar-accent" /> : (
                  <div className="text-2xl font-semibold tracking-tight">{formatCurrency(totalToday)}</div>
                )}
              </CardContent>
            </Card>
            <Card className="border-border">
              <CardContent className="p-5">
                <div className="text-xs font-bold uppercase tracking-wider mb-2 text-muted-foreground">Bu oy</div>
                {earningsLoading ? <Skeleton className="h-8 w-24" /> : (
                  <div className="text-2xl font-semibold tracking-tight">{formatCurrency(totalMonth)}</div>
                )}
              </CardContent>
            </Card>
            <Card className="border-border">
              <CardContent className="p-5">
                <div className="text-xs font-bold uppercase tracking-wider mb-2 text-muted-foreground">Jami (umrbod)</div>
                {earningsLoading ? <Skeleton className="h-8 w-24" /> : (
                  <div className="text-2xl font-semibold tracking-tight text-primary">{formatCurrency(totalLifetime)}</div>
                )}
              </CardContent>
            </Card>
          </div>

          <Card className="border-border">
            <CardContent className="p-0">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Ishchi</TableHead>
                    <TableHead>Liniya</TableHead>
                    <TableHead>Rol</TableHead>
                    <TableHead className="text-right">Bugun kg</TableHead>
                    <TableHead className="text-right">Oy kg</TableHead>
                    <TableHead className="text-right">Jami kg</TableHead>
                    <TableHead className="text-right">Bugun</TableHead>
                    <TableHead className="text-right">Oy</TableHead>
                    <TableHead className="text-right">Jami</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {earningsLoading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <TableRow key={i}>
                        <TableCell><Skeleton className="h-5 w-32" /></TableCell>
                        {Array.from({ length: 8 }).map((__, j) => (
                          <TableCell key={j} className="text-right"><Skeleton className="h-5 w-16 ml-auto" /></TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : (earnings ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">Daromad ma'lumotlari yo'q.</TableCell>
                    </TableRow>
                  ) : (
                    (earnings ?? []).map((r) => (
                      <TableRow key={r.worker} data-testid={`earnings-row-${r.worker}`}>
                        <TableCell className="font-medium">{r.worker || "(nomsiz)"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{r.lineName ?? "—"}</TableCell>
                        <TableCell>{r.role ? <Badge variant="outline">{roleLabel(r.role)}</Badge> : "—"}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatNumber(r.todayKg)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatNumber(r.monthKg)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatNumber(r.lifetimeKg)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatCurrency(r.todayEarnings)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatCurrency(r.monthEarnings)}</TableCell>
                        <TableCell className="text-right font-mono text-sm font-medium">{formatCurrency(r.lifetimeEarnings)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Settings tab ── */}
        <TabsContent value="settings" className="space-y-6">
          <Card className="border-border">
            <CardContent className="p-0">
              <div className="px-5 py-4 border-b border-border">
                <h2 className="font-semibold">Global rol stavkalari</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Liniya sozlamalarida (⚙️) o'ziga xos stavka yo'q liniyalar uchun zaxira stavkalar.
                </p>
              </div>
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Rol</TableHead>
                    <TableHead>Stavka</TableHead>
                    <TableHead>Yangilangan</TableHead>
                    <TableHead className="text-right w-[140px]">Amal</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ratesLoading ? (
                    Array.from({ length: 3 }).map((_, i) => (
                      <TableRow key={i}>
                        <TableCell><Skeleton className="h-5 w-28" /></TableCell>
                        <TableCell><Skeleton className="h-9 w-48" /></TableCell>
                        <TableCell><Skeleton className="h-5 w-24" /></TableCell>
                        <TableCell className="text-right"><Skeleton className="h-8 w-24 ml-auto" /></TableCell>
                      </TableRow>
                    ))
                  ) : (
                    RATE_ROLES.map((role) => {
                      const r = (roleRates ?? []).find((x) => x.role === role);
                      return (
                        <RoleRateRow
                          key={role}
                          role={role}
                          rate={r?.rate ?? 0}
                          updatedAt={r?.updatedAt ?? null}
                        />
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Product methods */}
          <Card className="border-border">
            <CardContent className="p-0">
              <div className="px-5 py-4 border-b border-border">
                <h2 className="font-semibold">Mahsulot maosh usuli</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Kg (rol asosida) — ishlab chiqaruvchi kg×stavka oladi. Dona — eski mahsulot stavkasi.
                </p>
              </div>
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Mahsulot</TableHead>
                    <TableHead>Birlik</TableHead>
                    <TableHead className="w-[280px]">Maosh usuli</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {productsLoading ? (
                    Array.from({ length: 4 }).map((_, i) => (
                      <TableRow key={i}>
                        <TableCell><Skeleton className="h-5 w-40" /></TableCell>
                        <TableCell><Skeleton className="h-5 w-16" /></TableCell>
                        <TableCell><Skeleton className="h-9 w-64" /></TableCell>
                      </TableRow>
                    ))
                  ) : (products ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">Mahsulotlar topilmadi.</TableCell>
                    </TableRow>
                  ) : (
                    (products ?? []).map((p) => (
                      <TableRow key={p.name} data-testid={`product-method-row-${p.name}`}>
                        <TableCell className="font-medium">{p.name}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{p.rateType}</TableCell>
                        <TableCell>
                          <Select
                            value={p.payrollMethod || "PRODUCT_RATE"}
                            onValueChange={(method) => updateMethod.mutate({ name: p.name, method })}
                          >
                            <SelectTrigger className="max-w-[260px]" data-testid={`select-method-${p.name}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="PRODUCT_RATE">{METHOD_UZ.PRODUCT_RATE}</SelectItem>
                              <SelectItem value="ROLE_BASED_KG">{METHOD_UZ.ROLE_BASED_KG}</SelectItem>
                            </SelectContent>
                          </Select>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
