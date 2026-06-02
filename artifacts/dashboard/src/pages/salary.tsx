import { useState } from "react";
import { useGetSalaryReport, getGetSalaryReportQueryKey, useMarkSalaryPaid } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/format";
import { CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";
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

export default function Salary() {
  const queryClient = useQueryClient();
  const currentDate = new Date();
  const [year, setYear] = useState(currentDate.getFullYear());
  const [month, setMonth] = useState(currentDate.getMonth() + 1); // 1-12

  const { data: report, isLoading } = useGetSalaryReport(
    { year, month },
    { query: { queryKey: getGetSalaryReportQueryKey({ year, month }) } }
  );

  const markPaid = useMarkSalaryPaid({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSalaryReportQueryKey({ year, month }) });
      }
    }
  });

  const nextMonth = () => {
    if (month === 12) {
      setMonth(1);
      setYear(y => y + 1);
    } else {
      setMonth(m => m + 1);
    }
  };

  const prevMonth = () => {
    if (month === 1) {
      setMonth(12);
      setYear(y => y - 1);
    } else {
      setMonth(m => m - 1);
    }
  };

  const monthName = new Date(year, month - 1).toLocaleString('default', { month: 'long' });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Payroll Management</h1>
        <div className="flex items-center gap-4 bg-card px-4 py-2 border border-border rounded-md shadow-sm">
          <Button variant="ghost" size="icon" onClick={prevMonth} className="h-8 w-8" data-testid="btn-prev-month">
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <div className="text-sm font-bold uppercase tracking-wider min-w-[120px] text-center" data-testid="current-period">
            {monthName} {year}
          </div>
          <Button variant="ghost" size="icon" onClick={nextMonth} className="h-8 w-8" data-testid="btn-next-month">
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card className="border-border bg-sidebar text-sidebar-foreground">
          <CardContent className="p-5">
            <div className="text-xs font-bold uppercase tracking-wider mb-2 text-sidebar-foreground/70">Total Payroll</div>
            {isLoading ? <Skeleton className="h-8 w-24 bg-sidebar-accent" /> : (
              <div className="text-2xl font-semibold tracking-tight">
                {formatCurrency(report?.reduce((acc, row) => acc + row.totalEarnings, 0))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card className="border-border">
          <CardContent className="p-5">
            <div className="text-xs font-bold uppercase tracking-wider mb-2 text-muted-foreground">Pending Payment</div>
            {isLoading ? <Skeleton className="h-8 w-24" /> : (
              <div className="text-2xl font-semibold tracking-tight text-destructive">
                {formatCurrency(report?.filter(r => !r.isPaid).reduce((acc, row) => acc + row.totalEarnings, 0))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card className="border-border">
          <CardContent className="p-5">
            <div className="text-xs font-bold uppercase tracking-wider mb-2 text-muted-foreground">Settled</div>
            {isLoading ? <Skeleton className="h-8 w-24" /> : (
              <div className="text-2xl font-semibold tracking-tight text-primary">
                {formatCurrency(report?.filter(r => r.isPaid).reduce((acc, row) => acc + row.totalEarnings, 0))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="border-border">
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Worker</TableHead>
                <TableHead className="text-right">Total Earnings</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Payment Date</TableHead>
                <TableHead className="text-right w-[150px]">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-5 w-32" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-5 w-24 ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-6 w-20 rounded-full" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-24" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-8 w-24 ml-auto" /></TableCell>
                  </TableRow>
                ))
              ) : report?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                    No production activity recorded for {monthName} {year}.
                  </TableCell>
                </TableRow>
              ) : (
                report?.map(row => (
                  <TableRow key={row.worker} data-testid={`salary-row-${row.worker}`}>
                    <TableCell className="font-medium text-base">{row.worker}</TableCell>
                    <TableCell className="text-right font-mono text-base font-medium">
                      {formatCurrency(row.totalEarnings)}
                    </TableCell>
                    <TableCell>
                      {row.isPaid ? (
                        <Badge className="bg-primary/20 text-primary-foreground border-primary/30 hover:bg-primary/20 cursor-default">
                          Settled
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-destructive border-destructive/50 bg-destructive/10 cursor-default">
                          Pending
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.paidAt ? formatDate(row.paidAt) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {!row.isPaid && row.totalEarnings > 0 && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button size="sm" variant="outline" className="border-primary/50 text-primary-foreground hover:bg-primary/10" data-testid={`btn-pay-${row.worker}`}>
                              <CheckCircle2 className="w-4 h-4 mr-2" /> Mark Paid
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Confirm Payment</AlertDialogTitle>
                              <AlertDialogDescription>
                                Are you sure you want to mark <strong>{formatCurrency(row.totalEarnings)}</strong> as paid for <strong>{row.worker}</strong> for {monthName} {year}?
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction 
                                onClick={() => markPaid.mutate({ data: { worker: row.worker, year, month, amount: row.totalEarnings } })}
                                data-testid="btn-confirm-pay"
                                className="bg-primary text-primary-foreground hover:bg-primary/90"
                              >
                                {markPaid.isPending ? "Processing..." : "Confirm Payment"}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
