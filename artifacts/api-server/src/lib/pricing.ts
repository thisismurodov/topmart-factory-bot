import { pool } from "@workspace/db";

// Server-authoritative tier-price resolver. Given a product name and a quantity,
// returns the price + currency that MUST be stored on the sale item — selecting the
// matching volume tier (inclusive min<=qty<=max) or falling back to the product's
// default sale price. Used by POST /sales so clients cannot tamper with tier prices.

export interface ResolvedPrice {
  found: boolean;
  unitPrice: number;
  currency: string;
  saleType: string;
  fromTier: boolean;
}

export async function resolveProductPrice(
  productName: string,
  quantity: number,
): Promise<ResolvedPrice> {
  const p = await pool.query(
    "SELECT id, unit_type, default_sale_price, currency_type FROM products WHERE name=$1",
    [productName],
  );
  if (!p.rows.length) {
    return { found: false, unitPrice: 0, currency: "USD", saleType: "dona", fromTier: false };
  }
  const prod = p.rows[0];

  if (quantity > 0) {
    const t = await pool.query(
      `SELECT price, currency FROM product_price_tiers
       WHERE product_id=$1 AND min_quantity <= $2 AND max_quantity >= $2
       ORDER BY min_quantity LIMIT 1`,
      [prod.id, quantity],
    );
    if (t.rows.length) {
      return {
        found: true,
        unitPrice: Number(t.rows[0].price),
        currency: t.rows[0].currency,
        saleType: prod.unit_type,
        fromTier: true,
      };
    }
  }

  return {
    found: true,
    unitPrice: Number(prod.default_sale_price),
    currency: prod.currency_type,
    saleType: prod.unit_type,
    fromTier: false,
  };
}
