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
// opts.excludeName — tahrirlanayotgan mahsulotning o'zi hisobga olinmaydi
// (o'zining joriy SKU'si unga "band" bo'lib ko'rinmasligi uchun)
export async function uniqueProductSku(
  name: string,
  opts?: { excludeName?: string },
): Promise<string> {
  const base = skuFromName(name);
  const params: string[] = [base];
  let where = `(sku = $1 OR sku LIKE $1 || '-%')`;
  if (opts?.excludeName) {
    params.push(opts.excludeName);
    where += ` AND name <> $2`;
  }
  const { rows } = await pool.query(
    `SELECT sku FROM public.products WHERE ${where}`,
    params
  );
  const taken = new Set(rows.map((r) => String(r.sku)));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}
