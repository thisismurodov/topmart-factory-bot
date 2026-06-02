import { useState } from "react";
import { useGetBatches, getGetBatchesQueryKey, useDeleteBatch } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency, formatNumber, formatDate } from "@/lib/format";
import { Trash2, Search, X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Batches() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const limit = 50;
  
  const [filters, setFilters] = useState({
    date: "",
    worker: "",
    product: ""
  });
  
  const [activeFilters, setActiveFilters] = useState({
    date: "",
    worker: "",
    product: ""
  });

  const { data, isLoading } = useGetBatches(
    { 
      limit, 
      offset: page * limit,
      ...(activeFilters.date ? { date: activeFilters.date } : {}),
      ...(activeFilters.worker ? { worker: activeFilters.worker } : {}),
      ...(activeFilters.product ? { product: activeFilters.product } : {})
    },
    { query: { queryKey: getGetBatchesQueryKey({ limit, offset: page * limit, ...activeFilters }) } }
  );

  const deleteBatch = useDeleteBatch({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBatchesQueryKey() });
      }
    }
  });

  const applyFilters = () => {
    setPage(0);
    setActiveFilters(filters);
  };

  const clearFilters = () => {
    setFilters({ date: "", worker: "", product: "" });
    setActiveFilters({ date: "", worker: "", product: "" });
    setPage(0);
  };

  return (
    <div className="space-y-6">
      <Card className="border-border">
        <CardHeader className="pb-4">
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">Filter Batches</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4 items-end">
            <div className="space-y-2 flex-1 min-w-[200px]">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Date (YYYY-MM-DD)</label>
              <Input 
                placeholder="e.g. 2024-01-15" 
                value={filters.date} 
                onChange={e => setFilters(f => ({...f, date: e.target.value}))}
                data-testid="filter-date"
              />
            </div>
            <div className="space-y-2 flex-1 min-w-[200px]">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Worker Name</label>
              <Input 
                placeholder="e.g. Alisher" 
                value={filters.worker} 
                onChange={e => setFilters(f => ({...f, worker: e.target.value}))}
                data-testid="filter-worker"
              />
            </div>
            <div className="space-y-2 flex-1 min-w-[200px]">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Product</label>
              <Input 
                placeholder="e.g. Rope 10mm" 
                value={filters.product} 
                onChange={e => setFilters(f => ({...f, product: e.target.value}))}
                data-testid="filter-product"
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={applyFilters} data-testid="btn-apply-filters">
                <Search className="w-4 h-4 mr-2" /> Search
              </Button>
              <Button variant="outline" onClick={clearFilters} data-testid="btn-clear-filters">
                <X className="w-4 h-4 mr-2" /> Clear
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border">
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="w-[180px]">Batch Code</TableHead>
                <TableHead>Date & Time</TableHead>
                <TableHead>Worker</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Weight</TableHead>
                <TableHead className="text-right">Earnings</TableHead>
                <TableHead className="text-right w-[80px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-5 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-32" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-24" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-5 w-12 ml-auto" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-5 w-16 ml-auto" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-5 w-20 ml-auto" /></TableCell>
                    <TableCell></TableCell>
                  </TableRow>
                ))
              ) : data?.items?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    No batches found.
                  </TableCell>
                </TableRow>
              ) : (
                data?.items.map(batch => (
                  <TableRow key={batch.id} data-testid={`batch-row-${batch.id}`}>
                    <TableCell className="font-mono text-xs font-medium">{batch.batchCode}</TableCell>
                    <TableCell className="text-sm">{formatDate(batch.createdAt)}</TableCell>
                    <TableCell className="font-medium">{batch.worker}</TableCell>
                    <TableCell>{batch.product}</TableCell>
                    <TableCell className="text-right font-mono">{formatNumber(batch.quantity)}</TableCell>
                    <TableCell className="text-right font-mono">{formatNumber(batch.weightKg)} kg</TableCell>
                    <TableCell className="text-right font-mono font-medium">{formatCurrency(batch.earnings)}</TableCell>
                    <TableCell className="text-right">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10" data-testid={`btn-delete-${batch.id}`}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete Batch?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This action cannot be undone. This will permanently delete batch {batch.batchCode} and remove it from the worker's earnings.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction 
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={() => deleteBatch.mutate({ id: batch.id })}
                              data-testid="btn-confirm-delete"
                            >
                              {deleteBatch.isPending ? "Deleting..." : "Delete Batch"}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Showing {data?.items.length || 0} of {data?.total || 0} records
        </div>
        <div className="flex gap-2">
          <Button 
            variant="outline" 
            size="sm" 
            disabled={page === 0 || isLoading} 
            onClick={() => setPage(p => Math.max(0, p - 1))}
            data-testid="btn-prev-page"
          >
            Previous
          </Button>
          <Button 
            variant="outline" 
            size="sm" 
            disabled={!data || data.items.length < limit || isLoading} 
            onClick={() => setPage(p => p + 1)}
            data-testid="btn-next-page"
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
