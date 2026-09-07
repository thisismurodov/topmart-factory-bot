import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "@/App";
import { useToast } from "@/hooks/use-toast";
import { SalesBotProductsSection } from "@/components/distribution/SalesBotProductsSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText, Link2, Search } from "lucide-react";

type ExternalPurchaseReceipt = {
  id: number;
  reference: string;
  productId: number;
  productName: string;
  supplier: string;
  quantity: number;
  totalWeightKg: string;
  totalCost: string;
  warehouseId: number;
  receivedBy: string;
  receivedAt: string;
  stockMovement: { id: number; type: string; reference: string; createdAt: string };
};

function formatNumber(value: string | number, maximumFractionDigits = 2) {
  return new Intl.NumberFormat("uz-UZ", { maximumFractionDigits }).format(Number(value));
}

function ExternalPurchaseHistory() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [supplier, setSupplier] = useState("");
  const [product, setProduct] = useState("");
  const [reference, setReference] = useState("");

  const receiptsQuery = useQuery<ExternalPurchaseReceipt[]>({
    queryKey: ["topmart-external-purchase-history", from, to, supplier, product, reference],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (supplier.trim()) params.set("supplier", supplier.trim());
      if (product.trim()) params.set("product", product.trim());
      if (reference.trim()) params.set("reference", reference.trim());
      const res = await authFetch(`/api/topmart/external-purchases?${params}`);
      if (!res.ok) throw new Error("Kirim cheklari tarixini yuklab bo'lmadi");
      return res.json();
    },
  });
  const clearFilters = () => {
    setFrom("");
    setTo("");
    setSupplier("");
    setProduct("");
    setReference("");
  };

  return (
    <Card data-testid="section-external-purchase-history">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg"><FileText className="h-5 w-5" /> Tashqi xarid kirim cheklari</CardTitle>
        <CardDescription>O'zgartirib yoki o'chirib bo'lmaydigan kirim tarixi va unga bog'langan ombor harakati.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <Input data-testid="input-receipt-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="Boshlanish sanasi" />
          <Input data-testid="input-receipt-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="Tugash sanasi" />
          <Input data-testid="input-receipt-supplier" placeholder="Yetkazib beruvchi" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
          <Input data-testid="input-receipt-product" placeholder="Mahsulot" value={product} onChange={(e) => setProduct(e.target.value)} />
          <div className="relative">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input data-testid="input-receipt-reference" className="pl-9" placeholder="Chek / hujjat raqami" value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
          <Button data-testid="button-clear-receipt-filters" variant="outline" onClick={clearFilters}>Filtrlarni tozalash</Button>
        </div>

        {receiptsQuery.isLoading ? (
          <div data-testid="status-receipts-loading" className="py-8 text-center text-sm text-muted-foreground">Yuklanmoqda...</div>
        ) : receiptsQuery.isError ? (
          <div data-testid="status-receipts-error" className="py-8 text-center text-sm text-destructive">{receiptsQuery.error.message}</div>
        ) : !receiptsQuery.data?.length ? (
          <div data-testid="status-receipts-empty" className="py-8 text-center text-sm text-muted-foreground">Kirim cheklari topilmadi</div>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Sana</TableHead><TableHead>Hujjat</TableHead><TableHead>Yetkazib beruvchi</TableHead>
                <TableHead>Mahsulot</TableHead><TableHead className="text-right">Dona</TableHead>
                <TableHead className="text-right">Kg</TableHead><TableHead className="text-right">Jami xarajat</TableHead>
                <TableHead>Operator</TableHead><TableHead>Ombor harakati</TableHead>
              </TableRow></TableHeader>
              <TableBody>{receiptsQuery.data.map((receipt) => (
                <TableRow key={receipt.id} data-testid={`row-external-receipt-${receipt.id}`}>
                  <TableCell className="whitespace-nowrap">{new Date(receipt.receivedAt).toLocaleString("uz-UZ")}</TableCell>
                  <TableCell className="font-medium">{receipt.reference}</TableCell>
                  <TableCell>{receipt.supplier}</TableCell><TableCell>{receipt.productName}</TableCell>
                  <TableCell className="text-right">{formatNumber(receipt.quantity, 0)}</TableCell>
                  <TableCell className="text-right">{formatNumber(receipt.totalWeightKg, 3)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">{formatNumber(receipt.totalCost)} UZS</TableCell>
                  <TableCell>{receipt.receivedBy}</TableCell>
                  <TableCell>
                    <span data-testid={`text-stock-movement-${receipt.stockMovement.id}`} className="inline-flex items-center gap-1 whitespace-nowrap text-sm font-medium text-primary" title={receipt.stockMovement.reference}>
                      <Link2 className="h-3.5 w-3.5" /> #{receipt.stockMovement.id} · {receipt.stockMovement.type}
                    </span>
                  </TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          </div>
        )}
        <p data-testid="text-receipt-count" className="text-xs text-muted-foreground">Ko'rsatilgan yozuvlar: {receiptsQuery.data?.length ?? 0} (eng ko'pi 500 ta)</p>
      </CardContent>
    </Card>
  );
}

function CreateExternalProductDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [unitType, setUnitType] = useState("dona");
  const [currencyType, setCurrencyType] = useState("UZS");
  const [defaultSalePrice, setDefaultSalePrice] = useState("");
  const [piecesPerBox, setPiecesPerBox] = useState("1");

  const { toast } = useToast();
  const qc = useQueryClient();

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Mahsulot nomi kiritilishi shart");
      const price = Number(defaultSalePrice);
      if (!Number.isFinite(price) || price < 0) throw new Error("Narx to'g'ri kiritilmadi");
      const ppb = Number(piecesPerBox);
      if (!Number.isSafeInteger(ppb) || ppb < 1) throw new Error("Qutidagi soni 1 yoki undan katta butun son bo'lishi kerak");

      const body = {
        name: name.trim(),
        unitType,
        currencyType,
        defaultSalePrice: price,
        piecesPerBox: ppb,
        inSales: true,
        inProduction: false,
        active: true,
        // Generic defaults for external products to pass API validations
        weight: 1,
        rate: 0,
        rateType: unitType,
      };

      const res = await authFetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || "Qo'shishda xatolik yuz berdi");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Tashqi mahsulot qo'shildi" });
      qc.invalidateQueries({ queryKey: ["savdo-bot-products"] });
      qc.invalidateQueries({ queryKey: ["v3-products"] });
      onClose();
      // Reset form
      setName("");
      setDefaultSalePrice("");
      setPiecesPerBox("1");
      setUnitType("dona");
      setCurrencyType("UZS");
    },
    onError: (err: any) => {
      toast({ title: "Xatolik", description: err.message, variant: "destructive" });
    }
  });

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Tashqi mahsulot qo'shish</DialogTitle>
          <DialogDescription>
            Faqat Top Mart sotadigan, Diyor Mahsulotlari ishlab chiqarmaydigan mahsulot yaratish.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Nomi</Label>
            <Input placeholder="Masalan: Pepsi 1L" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Sotuv narxi</Label>
              <Input type="number" min="0" placeholder="10000" value={defaultSalePrice} onChange={e => setDefaultSalePrice(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Valyuta</Label>
              <Select value={currencyType} onValueChange={setCurrencyType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="UZS">So'm (UZS)</SelectItem>
                  <SelectItem value="USD">Dollar (USD)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>O'lchov birligi</Label>
              <Select value={unitType} onValueChange={setUnitType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="dona">Dona</SelectItem>
                  <SelectItem value="kg">Kg</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Qutidagi soni (dona)</Label>
              <Input type="number" min="1" step="1" value={piecesPerBox} onChange={e => setPiecesPerBox(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={createMutation.isPending}>Bekor qilish</Button>
          <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending || !name.trim() || !defaultSalePrice}>
            {createMutation.isPending ? "Saqlanmoqda..." : "Saqlash"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function TopMartProductsTab() {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="space-y-6">
      <ExternalPurchaseHistory />
      <SalesBotProductsSection onCreateMaster={() => setCreateOpen(true)} />
      {createOpen && <CreateExternalProductDialog open={createOpen} onClose={() => setCreateOpen(false)} />}
    </div>
  );
}
