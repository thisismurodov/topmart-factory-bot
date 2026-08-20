import React from "react";
import { formatCurrency } from "../lib/format";

export type BatchPayroll = {
  earnings: number;
  payrollMethod: "PRODUCT_RATE" | "ROLE_BASED_KG";
  payrollStatus: "PRODUCT_RATE" | "OPEN" | "CLOSED" | "UNASSIGNED";
  payrollLineName: string | null;
  payrollWorkDate: string;
  frozenDailyEarnings: number | null;
};

export function PayrollCell({ batch }: { batch: BatchPayroll }) {
  if (batch.payrollMethod !== "ROLE_BASED_KG") {
    return <span>{formatCurrency(batch.earnings)}</span>;
  }

  const context = [batch.payrollLineName, batch.payrollWorkDate].filter(Boolean).join(" · ");

  if (batch.payrollStatus === "CLOSED") {
    return (
      <div className="flex flex-col items-end gap-0.5" data-testid="payroll-status-closed">
        <span>{formatCurrency(batch.frozenDailyEarnings ?? 0)}</span>
        <span className="font-sans text-[11px] font-normal text-muted-foreground">
          Kunlik yakuniy maosh{context ? ` · ${context}` : ""}
        </span>
      </div>
    );
  }

  if (batch.payrollStatus === "UNASSIGNED") {
    return (
      <div className="flex flex-col items-end gap-0.5" data-testid="payroll-status-unassigned">
        <span className="font-sans text-xs font-medium text-destructive">Liniya biriktirilmagan</span>
        <span className="font-sans text-[11px] font-normal text-muted-foreground">
          {batch.payrollWorkDate}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-0.5" data-testid="payroll-status-open">
      <span className="font-sans text-xs font-medium text-amber-700 dark:text-amber-400">
        Liniya yopilganda hisoblanadi
      </span>
      {context && (
        <span className="font-sans text-[11px] font-normal text-muted-foreground">{context}</span>
      )}
    </div>
  );
}