import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getUsdToUzsRate } from "../lib/exchangeRate";
import { uniqueProductSku } from "../lib/sku";
import { notifyPackersLeftWithoutProducts } from "../lib/packerAlerts";

// SKU orqali bog'langan savdo bot mahsulotiga narx/nom o'zgarishini uzatish.
// narx faqat UZS mahsulotlarda sinxronlanadi (mahsulotlar.narx UZS'da).
async function propagateToDistribution(productName: string): Promise<void> {
  await pool.query(
    `UPDATE distribution.mahsulotlar m SET
       nomi = p.name,
       narx = CASE WHEN p.currency_type = 'UZS' AND p.default_sale_price > 0
                   THEN ROUND(p.default_sale_price) ELSE m.narx END
     FROM public.products p
     WHERE p.name = $1 AND p.sku <> '' AND m.sku = p.sku`,
    [productName]
  );
}

// ── Bitta mahsulot bazasi (ONE PRODUCT = ONE MASTER RECORD) sinxronizatsiyasi ──
// in_sales = TRUE bo'lgan master mahsulot savdo katalogida (distribution.
// mahsulotlar) avtomatik faol bo'ladi. Bog'lash tartibi:
//   1) SKU bo'yicha mavjud qator → yangilash (nomi/birlik, UZS bo'lsa narx) + faol=1
//   2) Normallashtirilgan nom bo'yicha mavjud (bog'lanmagan) qator → SKU muhrlash
//      (eski savdo mahsulotini master yozuvga migratsiya qilish yo'li)
//   3) Hech biri topilmasa → yangi qator INSERT (USD narx jonli kursda UZS'ga)
// in_sales FALSE qilinganda SKU orqali bog'langan qator faol=0 bo'ladi.
const distNameNorm = (expr: string): string =>
  "regexp_replace(regexp_replace(lower(trim(" + expr + ")), '[''’ʼ`´]', '', 'g'), '\\s+', ' ', 'g')";

async function distCatalogExists(): Promise<boolean> {
  const r = await pool.query(`SELECT to_regclass('distribution.mahsulotlar') IS NOT NULL AS ok`);
  return r.rows[0]?.ok === true;
}

export async function syncSalesCatalog(productName: string): Promise<void> {
  if (!(await distCatalogExists())) return;
  const pr = await pool.query(
    `SELECT name, sku, unit_type, currency_type, default_sale_price, in_sales
     FROM products WHERE name = $1`, [productName]
  );
  if (!pr.rows.length) return;
  const p = pr.rows[0];
  const sku = String(p.sku || "");
  const inSales = p.in_sales === true;

  if (!inSales) {
    // Savdodan chiqarilgan — bog'langan savdo qatorini nofaol qilamiz
    if (sku !== "") {
      await pool.query(
        `UPDATE distribution.mahsulotlar SET faol = 0 WHERE sku = $1 AND faol = 1`, [sku]
      );
    }
    return;
  }
  if (sku === "") return; // master yozuvda SKU bo'lishi shart (avto-yaratiladi)

  const birlik = String(p.unit_type) === "kg" ? "kg" : "dona";
  const isUzs = String(p.currency_type) === "UZS";
  const price = Number(p.default_sale_price) || 0;

  // 1) SKU bo'yicha mavjud qator
  const upd = await pool.query(
    `UPDATE distribution.mahsulotlar SET
       nomi = $2, birlik = $3, faol = 1,
       narx = CASE WHEN $4::boolean AND $5::bigint > 0 THEN $5::bigint ELSE narx END
     WHERE sku = $1`,
    [sku, String(p.name), birlik, isUzs, isUzs ? Math.round(price) : 0]
  );
  if ((upd.rowCount ?? 0) > 0) return;

  // 2) Nom bo'yicha mavjud (SKU'siz yoki nofaol) qator — migratsiya bog'lash
  const byName = await pool.query(
    `SELECT id FROM distribution.mahsulotlar
     WHERE ${distNameNorm("nomi")} = ${distNameNorm("$1")}
       AND (sku IS NULL OR sku = '')
     ORDER BY faol DESC, id LIMIT 1`,
    [String(p.name)]
  );
  // UZS bo'lmasa yoki narx 0 bo'lsa — jonli kursda UZS'ga aylantiramiz (insert uchun)
  let narxUzs = isUzs ? Math.round(price) : 0;
  if (!isUzs && price > 0) {
    try {
      const { rate } = await getUsdToUzsRate();
      narxUzs = Math.round(price * rate);
    } catch { narxUzs = 0; }
  }
  if (byName.rows.length > 0) {
    await pool.query(
      `UPDATE distribution.mahsulotlar SET
         sku = $2, nomi = $3, birlik = $4, faol = 1,
         narx = CASE WHEN $5::bigint > 0 THEN $5::bigint ELSE narx END
       WHERE id = $1`,
      [byName.rows[0].id, sku, String(p.name), birlik, narxUzs]
    );
    return;
  }

  // 3) Yangi savdo katalog qatori
  await pool.query(
    `INSERT INTO distribution.mahsulotlar (nomi, narx, birlik, faol, sku)
     VALUES ($1, $2, $3, 1, $4)`,
    [String(p.name), narxUzs, birlik, sku]
  );
}

const router: IRouter = Router();

// Og'irlik o'zgarishi ledger himoyasi: wip_movements PRODUCE qatorlari mahsulot
// og'irligi (products.weight) asosida yozilgan. Og'irlik keyin o'zgartirilsa,
// eski qatorlar jimgina eski qiymatda qoladi va bo'lim WIP balansi buziladi.
// Mavjud ledger qatorlari bo'lsa — aniq tasdiqsiz og'irlik o'zgarishiga 409
// qaytariladigan konflikt obyektini beradi (aks holda null).
async function weightLedgerConflict(
  productName: string,
  newWeight: number,
): Promise<Record<string, unknown> | null> {
  const curRes = await pool.query(
    "SELECT weight FROM products WHERE name=$1", [productName],
  );
  if (!curRes.rows.length) return null;
  const curWeight = Number(curRes.rows[0].weight);
  if (Math.abs(curWeight - newWeight) <= 1e-9) return null;
  const lgRes = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM wip_movements
     WHERE movement_type='PRODUCE' AND LOWER(product)=LOWER($1)`,
    [productName],
  );
  const ledgerRows = Number(lgRes.rows[0].cnt) || 0;
  if (ledgerRows === 0) return null;
  return {
    code: "WEIGHT_LEDGER_CONFLICT",
    ledgerRows,
    oldWeight: curWeight,
    newWeight,
    error:
      `Bu mahsulot bo'yicha ${ledgerRows} ta ishlab chiqarish (ledger) yozuvi mavjud. ` +
      `Og'irlikni ${curWeight} → ${newWeight} kg ga o'zgartirsangiz, eski yozuvlar eski og'irlikda qoladi ` +
      `va bo'lim WIP balansi tarixiy qiymatlarga tayangan holda hisoblanaveradi. ` +
      `Davom etish uchun tasdiqlang.`,
  };
}

// ── GET /products — list all ──────────────────────────────────────────────────
router.get("/products", async (_req, res): Promise<void> => {
  const { rate } = await getUsdToUzsRate();
  const { rows } = await pool.query(`
    SELECT
      p.id, p.name, p.sku, p.unit_type, p.currency_type,
      p.default_sale_price, p.weight, p.rate, p.rate_type,
      p.salary_cost, p.electricity_cost, p.other_cost, p.cost_price,
      p.minimum_stock, p.active, p.created_at, p.payroll_method,
      p.in_sales, p.in_production,
      p.line_id,
      pl.name AS line_name,
      COALESCE(p.pieces_per_box, 1) AS pieces_per_box,
      COALESCE(
        (SELECT SUM(rm.default_cost * pm.quantity_required * CASE WHEN UPPER(rm.currency)='USD' THEN $1::numeric ELSE 1 END)
         FROM product_materials pm
         JOIN raw_materials rm ON rm.id = pm.raw_material_id
         WHERE pm.product_name = p.name), 0
      ) AS raw_material_cost,
      CASE WHEN p.payroll_method = 'ROLE_BASED_KG' AND p.line_id IS NOT NULL
        THEN COALESCE((SELECT SUM(rate) FROM line_role_config WHERE line_id = p.line_id), 0)
        ELSE 0
      END AS line_salary_rate
    FROM products p
    LEFT JOIN production_lines pl ON pl.id = p.line_id
    ORDER BY p.name
  `, [rate]);

  res.json(rows.map(row => {
    // weight (og'irlik) — narx va xarajatlar 1 birlik (kg/dona) uchun kiritiladi,
    // jami = og'irlik × narx. Xom ashyo (BOM) allaqachon mutlaq miqdor bo'yicha.
    const w               = Number(row.weight) > 0 ? Number(row.weight) : 1;
    const salePriceBase   = Number(row.default_sale_price);
    const saleRate        = String(row.currency_type) === "USD" ? rate : 1;
    const isKg            = String(row.unit_type) === "kg";
    const isRoleBased     = String(row.payroll_method) === "ROLE_BASED_KG";
    const lineSalaryRate  = Number(row.line_salary_rate) || 0;
    // ROLE_BASED_KG: liniya rollarining umumiy stavkasi (SUM(rate)) ishlatiladi.
    // dona: 1 dona uchun SUM(rate); kg: SUM(rate) × og'irlik.
    // PRODUCT_RATE: mahsulot stavkasi: kg → rate×og'irlik, dona → rate.
    const laborCost       = isRoleBased
      ? (isKg ? lineSalaryRate * w : lineSalaryRate)
      : (String(row.rate_type) === "kg" ? Number(row.rate) * w : Number(row.rate));
    const elecBase        = Number(row.electricity_cost);
    const otherBase       = Number(row.other_cost);
    const rawCost         = Number(row.raw_material_cost);
    // Qo'lda tan narx (>0) — BOM/mehnat/elektr hisobini TO'LIQ almashtiradi.
    // Sotuv narxi kabi: mahsulot valyutasida, kg mahsulotda 1 kg uchun kiritiladi.
    const costPriceBase   = Number(row.cost_price) || 0;
    const effectiveSale   = salePriceBase * saleRate * (isKg ? w : 1);
    const totalCost       = costPriceBase > 0
      ? costPriceBase * saleRate * (isKg ? w : 1)
      : rawCost + laborCost + (isKg ? (elecBase + otherBase) * w : (elecBase + otherBase));
    const profit          = effectiveSale - totalCost;
    const marginPct       = effectiveSale > 0
      ? Math.round((profit / effectiveSale) * 10000) / 100
      : 0;
    return {
      id:                 row.id,
      name:               row.name,
      sku:                row.sku,
      unitType:           row.unit_type,
      currencyType:       row.currency_type,
      defaultSalePrice:   salePriceBase,
      weight:             w,
      effectiveSalePrice: effectiveSale,
      rate:               Number(row.rate),
      rateType:           row.rate_type,
      payrollMethod:      row.payroll_method ?? "PRODUCT_RATE",
      lineId:             row.line_id ?? null,
      lineName:           row.line_name ?? null,
      lineSalaryRate,
      salaryCost:         laborCost,
      electricityCost:    elecBase,
      otherCost:          otherBase,
      costPrice:          costPriceBase,
      rawMaterialCost:    rawCost,
      totalCost,
      profit,
      marginPct,
      minimumStock:       row.minimum_stock,
      piecesPerBox:       Number(row.pieces_per_box) || 1,
      inSales:            row.in_sales === true,
      inProduction:       row.in_production !== false,
      active:             row.active,
      createdAt:          row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
  }));
});

// ── POST /products — create ───────────────────────────────────────────────────
router.post("/products", async (req, res): Promise<void> => {
  const {
    name, sku = "", unitType = "dona", currencyType = "UZS",
    defaultSalePrice = 0, weight = 1, rate = 0, rateType,
    salaryCost = 0, electricityCost = 0, otherCost = 0,
    minimumStock = 0, active = true, piecesPerBox = 1,
    lineId = null, costPrice = 0,
  } = req.body ?? {};
  // Bitta mahsulot bazasi modullari: aniq berilmasa mavjud qiymat saqlanadi
  // (yangi yozuvda: in_sales=FALSE, in_production=TRUE default'lari ishlaydi)
  const inSales: boolean | null =
    typeof req.body?.inSales === "boolean" ? req.body.inSales : null;
  const inProduction: boolean | null =
    typeof req.body?.inProduction === "boolean" ? req.body.inProduction : null;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name is required" }); return;
  }

  const finalRateType = rateType || unitType;
  const finalWeight   = Number(weight) > 0 ? Number(weight) : 1;

  try {
    // POST upsert (ON CONFLICT (name) DO UPDATE) mavjud mahsulot og'irligini ham
    // yangilaydi — PATCH bilan bir xil ledger himoyasi shu yerda ham kerak.
    if (req.body?.confirmWeightChange !== true) {
      const conflict = await weightLedgerConflict(name.trim(), finalWeight);
      if (conflict) { res.status(409).json(conflict); return; }
    }
    // SKU kiritilmagan bo'lsa — nomdan avtomatik unikal SKU beriladi
    const skuProvided = typeof sku === "string" && sku.trim() !== "";
    let finalSku = skuProvided ? sku.trim().toUpperCase() : await uniqueProductSku(name.trim());
    const finalLineId = lineId != null && !isNaN(Number(lineId)) ? Number(lineId) : null;
    let rows: any[] = [];
    // SKU unikal indeksga (idx_products_sku_unique) urilsa — avto-SKU'ni qayta
    // yaratib 2 marta urinamiz (parallel yaratishdagi poyga uchun)
    for (let attempt = 0; ; attempt++) {
      try {
        ({ rows } = await pool.query(
          `INSERT INTO products
             (name, sku, unit_type, currency_type, default_sale_price, weight, rate, rate_type,
              salary_cost, electricity_cost, other_cost, minimum_stock, active, pieces_per_box, line_id,
              in_sales, in_production, cost_price)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                   COALESCE($16, FALSE), COALESCE($17, TRUE), $18)
           ON CONFLICT (name) DO UPDATE SET
             sku = CASE WHEN products.sku <> '' THEN products.sku ELSE EXCLUDED.sku END,
             unit_type=$3, currency_type=$4, default_sale_price=$5, weight=$6, rate=$7, rate_type=$8,
             salary_cost=$9, electricity_cost=$10, other_cost=$11, minimum_stock=$12, active=$13,
             pieces_per_box=$14, line_id=$15,
             in_sales=COALESCE($16, products.in_sales),
             in_production=COALESCE($17, products.in_production),
             cost_price=$18
           RETURNING id, name, sku, unit_type, currency_type, default_sale_price, weight, rate, rate_type,
                     salary_cost, electricity_cost, other_cost, minimum_stock, active, pieces_per_box, line_id,
                     in_sales, in_production, cost_price`,
          [name.trim(), finalSku, unitType, currencyType, Number(defaultSalePrice), finalWeight, Number(rate),
           finalRateType, Number(salaryCost), Number(electricityCost), Number(otherCost),
           Number(minimumStock), Boolean(active), Math.max(1, Number(piecesPerBox) || 1), finalLineId,
           inSales, inProduction, Math.max(0, Number(costPrice) || 0)]
        ));
        break;
      } catch (e: any) {
        if (e?.code === "23505" && String(e?.constraint) === "idx_products_sku_unique") {
          if (skuProvided) {
            res.status(409).json({ error: `SKU '${finalSku}' allaqachon boshqa mahsulotda ishlatilgan` });
            return;
          }
          if (attempt < 2) { finalSku = await uniqueProductSku(name.trim()); continue; }
        }
        throw e;
      }
    }
    const p = rows[0];
    // Savdo katalogi sinxronizatsiyasi (in_sales bo'yicha)
    await syncSalesCatalog(p.name);
    // Legacy (in_sales=FALSE, lekin SKU orqali bog'langan) mahsulotlar uchun
    // POST upsert ham PATCH kabi nom/narx'ni savdo botga uzatishi kerak —
    // aks holda dashboard POST orqali narx yangilasa agentlar eski narxni ko'radi.
    if (p.in_sales !== true) {
      await propagateToDistribution(p.name);
    }
    res.status(201).json({
      id: p.id, name: p.name, sku: p.sku,
      unitType: p.unit_type, currencyType: p.currency_type,
      defaultSalePrice: Number(p.default_sale_price), weight: Number(p.weight),
      rate: Number(p.rate), rateType: p.rate_type,
      salaryCost: Number(p.salary_cost), electricityCost: Number(p.electricity_cost),
      otherCost: Number(p.other_cost), costPrice: Number(p.cost_price), minimumStock: p.minimum_stock,
      piecesPerBox: Number(p.pieces_per_box) || 1, active: p.active,
      inSales: p.in_sales === true, inProduction: p.in_production !== false,
    });
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

// ── PATCH /products/:name — update ────────────────────────────────────────────
router.patch("/products/:name", async (req, res): Promise<void> => {
  const productName = decodeURIComponent(req.params.name);
  const fields: string[] = [];
  const vals: unknown[] = [];

  const allowed = [
    ["sku", "sku"], ["unit_type", "unitType"], ["currency_type", "currencyType"],
    ["default_sale_price", "defaultSalePrice"], ["weight", "weight"], ["rate", "rate"], ["rate_type", "rateType"],
    ["salary_cost", "salaryCost"], ["electricity_cost", "electricityCost"],
    ["other_cost", "otherCost"], ["cost_price", "costPrice"],
    ["minimum_stock", "minimumStock"], ["active", "active"],
    ["payroll_method", "payrollMethod"], ["pieces_per_box", "piecesPerBox"], ["line_id", "lineId"],
    ["in_sales", "inSales"], ["in_production", "inProduction"],
  ];

  for (const [col, key] of allowed) {
    if (req.body[key] !== undefined) {
      // og'irlik 0 yoki manfiy bo'lsa 1 ga tenglaymiz (manfiy narx oldini olish)
      const value = col === "weight"
        ? (Number(req.body[key]) > 0 ? Number(req.body[key]) : 1)
        : col === "cost_price"
        ? Math.max(0, Number(req.body[key]) || 0)
        : req.body[key];
      vals.push(value);
      fields.push(`${col}=$${vals.length}`);
    }
  }

  if (fields.length === 0) { res.status(400).json({ error: "No fields to update" }); return; }

  // Deaktivatsiya packer'ni bo'sh ro'yxat bilan qoldirishini aniqlash uchun
  // avvalgi holatni olamiz (takroriy active=false PATCH spam qilmasin).
  let wasActive = false;
  if (req.body.active === false) {
    const prev = await pool.query(`SELECT active FROM products WHERE name=$1`, [productName]);
    wasActive = prev.rows.length > 0 && prev.rows[0].active === true;
  }

  // Og'irlik ledger himoyasi (izoh yuqorida — weightLedgerConflict).
  if (req.body.weight !== undefined && req.body.confirmWeightChange !== true) {
    const newWeight = Number(req.body.weight) > 0 ? Number(req.body.weight) : 1;
    const conflict = await weightLedgerConflict(productName, newWeight);
    if (conflict) { res.status(409).json(conflict); return; }
  }

  vals.push(productName);

  await pool.query(`UPDATE products SET ${fields.join(",")} WHERE name=$${vals.length}`, vals);

  // Mahsulot ENDI nofaol bo'ldi — biriktirilgan packer'lardan birortasi bo'sh
  // faol ro'yxat bilan qolgan bo'lsa adminlarga Telegram xabar (best-effort,
  // fire-and-forget — javobni kechiktirmaydi).
  if (req.body.active === false && wasActive) {
    void notifyPackersLeftWithoutProducts(productName);
  }
  // Savdo katalogi sinxronizatsiyasi:
  //  - in_sales aniq o'zgartirilgan bo'lsa → to'liq sync (faollashtirish/o'chirish)
  //  - aks holda in_sales=TRUE mahsulotlar uchun ham to'liq sync
  //  - legacy (in_sales=FALSE, lekin SKU bog'langan) uchun nom/narx propagatsiyasi
  if (req.body.inSales !== undefined) {
    await syncSalesCatalog(productName);
  } else {
    const st = await pool.query(`SELECT in_sales FROM products WHERE name=$1`, [productName]);
    if (st.rows.length && st.rows[0].in_sales === true) {
      await syncSalesCatalog(productName);
    } else {
      // Narx o'zgargan bo'lsa — SKU orqali bog'langan savdo bot mahsulotiga uzatamiz
      await propagateToDistribution(productName);
    }
  }
  res.json({ ok: true });
});

// ── DELETE /products/:name ─────────────────────────────────────────────────────
router.delete("/products/:name", async (req, res): Promise<void> => {
  const productName = decodeURIComponent(req.params.name);
  const result = await pool.query("DELETE FROM products WHERE name=$1", [productName]);
  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Product not found" }); return;
  }
  res.json({ ok: true });
});

// ── GET /products/:name/profitability ─────────────────────────────────────────
router.get("/products/:name/profitability", async (req, res): Promise<void> => {
  const productName = decodeURIComponent(req.params.name);
  const { rate } = await getUsdToUzsRate();

  const [prodRes, salesRes] = await Promise.all([
    pool.query(
      `SELECT p.*,
        COALESCE((
          SELECT SUM(rm.default_cost * pm.quantity_required * CASE WHEN UPPER(rm.currency)='USD' THEN $2::numeric ELSE 1 END)
          FROM product_materials pm
          JOIN raw_materials rm ON rm.id = pm.raw_material_id
          WHERE pm.product_name = p.name
        ), 0) AS raw_material_cost,
        CASE WHEN p.payroll_method = 'ROLE_BASED_KG' AND p.line_id IS NOT NULL
          THEN COALESCE((SELECT SUM(rate) FROM line_role_config WHERE line_id = p.line_id), 0)
          ELSE 0
        END AS line_salary_rate
       FROM products p WHERE p.name=$1`, [productName, rate]
    ),
    pool.query(
      `SELECT
         COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='uzs'), 0) AS revenue_uzs,
         COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='usd'), 0) AS revenue_usd,
         COALESCE(SUM(si.quantity), 0) AS units_sold
       FROM sale_items si
       WHERE si.product_name = $1`, [productName]
    ),
  ]);

  if (!prodRes.rows.length) { res.status(404).json({ error: "Product not found" }); return; }

  const p = prodRes.rows[0];
  const s = salesRes.rows[0];
  const w               = Number(p.weight) > 0 ? Number(p.weight) : 1;
  const rawCost         = Number(p.raw_material_cost);
  const isKg            = String(p.unit_type) === "kg";
  const isRoleBased     = String(p.payroll_method) === "ROLE_BASED_KG";
  const lineSalaryRate  = Number(p.line_salary_rate) || 0;
  const laborCost       = isRoleBased
    ? (isKg ? lineSalaryRate * w : lineSalaryRate)
    : (String(p.rate_type) === "kg" ? Number(p.rate) * w : Number(p.rate));
  const electricityCost = isKg ? Number(p.electricity_cost) * w : Number(p.electricity_cost);
  const otherCost       = isKg ? Number(p.other_cost) * w : Number(p.other_cost);
  // USD narx jonli kursda UZS'ga aylantiriladi (xarajatlar UZS'da — izchillik uchun).
  const saleRate        = String(p.currency_type) === "USD" ? rate : 1;
  const salePrice       = Number(p.default_sale_price) * saleRate * (isKg ? w : 1);
  // Qo'lda tan narx (>0) — komponent xarajatlar (BOM/mehnat/elektr) o'rniga to'liq ishlatiladi
  const costPriceBase   = Number(p.cost_price) || 0;
  const totalCost       = costPriceBase > 0
    ? costPriceBase * saleRate * (isKg ? w : 1)
    : rawCost + laborCost + electricityCost + otherCost;
  const profit          = salePrice - totalCost;
  const marginPct       = salePrice > 0 ? (profit / salePrice) * 100 : 0;

  res.json({
    name:            p.name,
    weight:          w,
    salePrice,
    costPrice:       costPriceBase,
    rawMaterialCost: rawCost,
    salaryCost:      laborCost,
    electricityCost,
    otherCost,
    totalCost,
    profit,
    marginPct:       Math.round(marginPct * 100) / 100,
    revenueUzs:      Number(s.revenue_uzs),
    revenueUsd:      Number(s.revenue_usd),
    unitsSold:       Number(s.units_sold),
  });
});

// ── GET /products/:name/weight-audit ──────────────────────────────────────────
// Og'irlik auditi: har bir PRODUCE (wip_movements) qatorining nazarda tutilgan
// birlik og'irligini (weight_kg / miqdor) joriy products.weight bilan solishtiradi.
// Miqdor ledgerda saqlanmaydi — u ikki manbadan tiklanadi:
//   1) Bot partiyalari: note = 'Partiya: <batch_code>' → batches jadvalidan
//      SUM(quantity) (bitta batch_code ostida bir mahsulot bir necha qatorda
//      bo'lishi mumkin, shu bois SUM).
//   2) Dashboard /ombor/flow/produce: standart note = 'Tayyor chiqarildi: <qty>'
//      dan regexp bilan ajratiladi.
// Miqdor tiklanmasa qator status='unknown' bilan qaytadi (audit halol bo'lsin).
// Chegirma (tolerance): joriy og'irlikning 1% i yoki 0.001 kg — kattarog'i.
router.get("/products/:name/weight-audit", async (req, res): Promise<void> => {
  const productName = decodeURIComponent(req.params.name);
  const prodRes = await pool.query(
    "SELECT name, weight, unit_type FROM products WHERE name=$1", [productName],
  );
  if (!prodRes.rows.length) { res.status(404).json({ error: "Product not found" }); return; }
  const currentWeight = Number(prodRes.rows[0].weight) > 0 ? Number(prodRes.rows[0].weight) : 1;

  // batches — bot jadvali; yangi bo'sh DBda bo'lmasligi mumkin.
  const hasBatches = (await pool.query(
    `SELECT to_regclass('batches') IS NOT NULL AS ok`,
  )).rows[0]?.ok === true;

  const batchJoin = hasBatches
    ? `LEFT JOIN LATERAL (
         SELECT SUM(b.quantity)::numeric AS qty
         FROM batches b
         WHERE wm.note = 'Partiya: ' || b.batch_code
           AND LOWER(b.product) = LOWER(wm.product)
       ) bq ON TRUE`
    : `LEFT JOIN LATERAL (SELECT NULL::numeric AS qty) bq ON TRUE`;

  const { rows } = await pool.query(
    `SELECT wm.id, wm.line_id, wm.weight_kg::float8 AS weight_kg, wm.note,
            wm.created_by, wm.created_at,
            COALESCE(
              bq.qty,
              substring(wm.note FROM '^Tayyor (?:mahsulot )?chiqarildi: ([0-9]+(?:\\.[0-9]+)?)$')::numeric
            )::float8 AS quantity
     FROM wip_movements wm
     ${batchJoin}
     WHERE wm.movement_type='PRODUCE' AND LOWER(wm.product)=LOWER($1)
     ORDER BY wm.created_at DESC, wm.id DESC`,
    [productName],
  );

  const tolerance = Math.max(0.001, currentWeight * 0.01);
  let mismatched = 0;
  let unknownQty = 0;
  const auditRows = rows.map((r) => {
    const qty = r.quantity != null && Number(r.quantity) > 0 ? Number(r.quantity) : null;
    const weightKg = Number(r.weight_kg) || 0;
    const implied = qty != null ? weightKg / qty : null;
    let status: "ok" | "outdated" | "unknown";
    if (implied == null) { status = "unknown"; unknownQty++; }
    else if (Math.abs(implied - currentWeight) > tolerance) { status = "outdated"; mismatched++; }
    else { status = "ok"; }
    return {
      id:                r.id,
      createdAt:         r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      lineId:            r.line_id,
      createdBy:         r.created_by,
      note:              r.note,
      weightKg,
      quantity:          qty,
      impliedUnitWeight: implied != null ? Math.round(implied * 1000) / 1000 : null,
      deviationKg:       implied != null ? Math.round((implied - currentWeight) * 1000) / 1000 : null,
      deviationPct:      implied != null && currentWeight > 0
        ? Math.round(((implied - currentWeight) / currentWeight) * 10000) / 100
        : null,
      status,
    };
  });

  res.json({
    product:       prodRes.rows[0].name,
    unitType:      prodRes.rows[0].unit_type,
    currentWeight,
    tolerance,
    totals: {
      ledgerRows: auditRows.length,
      ok:         auditRows.length - mismatched - unknownQty,
      outdated:   mismatched,
      unknownQty,
      totalKg:    Math.round(auditRows.reduce((s, r) => s + r.weightKg, 0) * 1000) / 1000,
    },
    rows: auditRows,
  });
});

export default router;
