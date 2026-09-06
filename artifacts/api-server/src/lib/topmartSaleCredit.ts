import type { PoolClient } from "pg";

export type TopmartCreditItem = {
  productName: string;
  removedQuantity: number;
  removedWeightKg: number;
};

/**
 * Credit one completed factory sale to the configured central warehouse.
 * Caller owns the transaction: any rejected query must abort the sale.
 * Production-label tables are intentionally not read or written.
 */
export async function creditTopmartSale(
  client: Pick<PoolClient, "query">,
  saleId: number,
  warehouseId: number,
  items: TopmartCreditItem[],
): Promise<void> {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const creditQuantity = item.removedQuantity;
    const creditWeightKg = item.removedWeightKg;
    await client.query(
      `INSERT INTO inventory
         (warehouse_id, product, quantity, weight_kg, product_type, updated_at)
       VALUES ($1,$2,$3,$4,'finished',NOW())
       ON CONFLICT (warehouse_id, product) DO UPDATE SET
         quantity=inventory.quantity + EXCLUDED.quantity,
         weight_kg=COALESCE(inventory.weight_kg,0) + EXCLUDED.weight_kg,
         updated_at=NOW()`,
      [warehouseId, item.productName, creditQuantity, creditWeightKg],
    );
    const referenceBase = `topmart-sale:${saleId}:${index + 1}`;
    await client.query(
      `INSERT INTO stock_movements
         (product, quantity, movement_type, to_warehouse_id, note,
          created_by, product_type, weight_kg, reference)
       VALUES
         ($1,$2,'TRANSFER',$3,$4,'system','finished',$5,$6),
         ($1,$2,'IN',$3,$4,'system','finished',$5,$7)`,
      [
        item.productName,
        creditQuantity,
        warehouseId,
        `Top Mart sale #${saleId}`,
        creditWeightKg || null,
        `${referenceBase}:transfer`,
        `${referenceBase}:in`,
      ],
    );
  }
}