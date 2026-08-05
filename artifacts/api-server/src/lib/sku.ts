import { pool } from "@workspace/db";

// Nomdan SKU taklifi: "Arqon 6 mm / Ko'k" -> "ARQON-6MM-KOK"
// Kirill harflarini lotinga o'girmaydi (katalog lotin alifbosida yuritiladi).
export function skuFromName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/['’ʼ`´]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return base || "P";
}

// public.products ichida unikal SKU qaytaradi (band bo'lsa -2, -3 ... qo'shiladi)
export async function uniqueProductSku(name: string): Promise<string> {
  const base = skuFromName(name);
  const { rows } = await pool.query(
    `SELECT sku FROM public.products WHERE sku = $1 OR sku LIKE $1 || '-%'`,
    [base]
  );
  const taken = new Set(rows.map((r) => String(r.sku)));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}
