                      s.unit_price, s.total_amount, s.currency, s.status, s.created_at
               FROM sales s
               ORDER BY s.id DESC
               LIMIT %s""",
            (limit,),
        )
        return cur.fetchall()


def get_product_rate_type(product_name: str) -> str:
    with get_conn() as (conn, cur):
        cur.execute("SELECT rate_type FROM products WHERE name = %s", (product_name,))
        row = cur.fetchone()
    return row["rate_type"] if row else "dona"


# ── Sale products (sotuv uchun alohida tovar ro'yxati) ────────────────────────

def get_sale_products() -> list[dict]:
    """V3: unified products jadvalidan o'qiydi (default_sale_price, currency_type, unit_type)."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT id, name,
                      unit_type        AS unit,
                      default_sale_price AS default_price,
                      currency_type    AS currency
               FROM products WHERE active = TRUE AND in_sales = TRUE ORDER BY name"""
        )
        return cur.fetchall()


def get_store_product_names() -> list[str]:
    """Ombor mahsulotlari — katalogda bor, lekin sotuvda ham, ishlab chiqarishda ham
    yo'q (in_sales=FALSE, in_production=FALSE). Bot kirim oqimidagi
    «🏬 Ombor mahsuloti» toifasi shu ro'yxatdan oladi."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT name FROM products
               WHERE active = TRUE AND in_sales = FALSE AND in_production = FALSE
               ORDER BY name"""
        )
        return [r[0] if not isinstance(r, dict) else r["name"] for r in cur.fetchall()]


def get_sale_product_by_id(prod_id: int) -> dict | None:
    """V3: unified products jadvalidan id bo'yicha."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT id, name,
                      unit_type        AS unit,
                      default_sale_price AS default_price,
                      currency_type    AS currency
               FROM products WHERE id = %s AND active = TRUE AND in_sales = TRUE""",
            (prod_id,),
        )
        return cur.fetchone()


def get_price_for_qty(product_id: int, qty: float) -> tuple[float, str]:
    """V3: hajm bo'yicha mos bosqichni (product_price_tiers, min<=qty<=max) tanlaydi;
    mos bosqich bo'lmasa products.default_sale_price / currency_type qaytaradi."""
    with get_conn() as (conn, cur):
        if qty and qty > 0:
            cur.execute(
                """SELECT price, currency FROM product_price_tiers
                   WHERE product_id = %s AND min_quantity <= %s AND max_quantity >= %s
                   ORDER BY min_quantity LIMIT 1""",
                (product_id, qty, qty),
            )
            tier = cur.fetchone()
            if tier:
                return float(tier["price"] or 0), tier["currency"] or "UZS"
        cur.execute(
            """SELECT default_sale_price AS price, currency_type AS currency
               FROM products WHERE id = %s AND active = TRUE AND in_sales = TRUE""",
            (product_id,),
        )
        prod = cur.fetchone()
        if prod:
            return float(prod["price"] or 0), prod["currency"] or "UZS"
        return 0.0, "UZS"


def get_sale_product_unit(name: str) -> str:
    """V3: unified products jadvalidan unit_type qaytaradi."""
    with get_conn() as (conn, cur):
        cur.execute("SELECT unit_type FROM products WHERE name = %s", (name,))
        row = cur.fetchone()
    return row["unit_type"] if row else "dona"


def create_sale_multi(
    customer_id: int,
    customer_name: str,
    status: str,
    note: str,
    items: list[dict],
) -> int:
    """
    Transaction ichida sales + sale_items yaratadi.
    items: [{"product_name", "sale_type", "quantity", "unit_price", "currency", "line_total"}, ...]
    """
    total = sum(float(it["line_total"]) for it in items)
    with get_conn() as (conn, cur):
        cur.execute(
            """INSERT INTO sales (customer_id, customer_name, status, note, total_amount)
               VALUES (%s, %s, %s, %s, %s) RETURNING id""",
            (customer_id, customer_name, status, note, total),
        )
        sale_id = cur.fetchone()["id"]
        for it in items:
            cur.execute(
                """INSERT INTO sale_items
                   (sale_id, product_name, sale_type, quantity, unit_price, currency, line_total)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (
                    sale_id,
                    it["product_name"],
                    it.get("sale_type", "dona"),
                    float(it["quantity"]),
                    float(it["unit_price"]),
                    it.get("currency", "UZS"),
                    float(it["line_total"]),
                ),
            )
        return sale_id


def add_sale_product(name: str, code: str = "", unit: str = "dona", currency: str = "uzs") -> bool:
    """V3: unified products jadvaliga yozadi (sotuv tovari = mahsulot)."""
    cur_norm = currency.upper() if currency.upper() in ("UZS", "USD") else "UZS"
    unit_norm = unit if unit in ("kg", "dona") else "dona"
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                """INSERT INTO products (name, sku, unit_type, currency_type, rate_type)
                   VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (name) DO UPDATE
                   SET active=TRUE,
                       unit_type=EXCLUDED.unit_type,
                       currency_type=EXCLUDED.currency_type""",
                (name, code, unit_norm, cur_norm, unit_norm),
            )
            return True
    except Exception:
        return False


def delete_sale_product(name: str) -> bool:
    """V3: unified products jadvalida active=false qiladi.

    Mahsulot FAOL holatdan nofaolga o'tsa, biriktirilgan packer'lardan
    birortasi bo'sh faol ro'yxat bilan qolgan-qolmaganini tekshirib,
    adminlarga Telegram xabar yuboradi (best-effort, commit'dan keyin)."""
    with get_conn() as (conn, cur):
        cur.execute("SELECT active FROM products WHERE name = %s", (name,))
        row = cur.fetchone()
        was_active = bool(row and row["active"])
        cur.execute(
            "UPDATE products SET active = false WHERE name = %s",
            (name,),
        )
        changed = cur.rowcount > 0
    if changed and was_active:
        from bot.packer_alerts import notify_packers_left_without_products
        notify_packers_left_without_products(name)
    return changed


def get_packers_left_without_products(product_name: str) -> list[str]:
    """Shu mahsulot biriktirilgan va endi BITTA ham faol biriktirilgan
    mahsuloti qolmagan packer nomlari (deaktivatsiyadan KEYIN chaqiriladi)."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT DISTINCT pa.packer_name
               FROM packer_product_assignments pa
               WHERE pa.product_name = %s
                 AND NOT EXISTS (
                   SELECT 1
                   FROM packer_product_assignments pa2
                   JOIN products p ON p.name = pa2.product_name
                   WHERE pa2.packer_name = pa.packer_name
                     AND p.active = TRUE
                 )
               ORDER BY pa.packer_name""",
            (product_name,),
        )
        return [r["packer_name"] for r in cur.fetchall()]


# ── Debt / nasiya funksiyalari ─────────────────────────────────────────────

def get_debt_totals() -> dict:
    """Jami nasiya summalarini (USD va UZS) va qarzdor mijozlar sonini qaytaradi."""
    with get_conn() as (conn, cur):
        cur.execute("""
            SELECT
                COUNT(DISTINCT customer_id)::int AS customer_count,
                COALESCE(SUM(debt_amount) FILTER (
                    WHERE UPPER(COALESCE(currency,'USD')) = 'USD'
                ), 0) AS total_usd,
                COALESCE(SUM(debt_amount) FILTER (
                    WHERE UPPER(COALESCE(currency,'USD')) = 'UZS'
                ), 0) AS total_uzs
            FROM sales
            WHERE status IN ('pending', 'partial')
              AND COALESCE(debt_amount, 0) > 0
        """)
        row = cur.fetchone()
        return {
            "customer_count": int(row["customer_count"] or 0),
            "total_usd":      float(row["total_usd"] or 0),
            "total_uzs":      float(row["total_uzs"] or 0),
        }


def get_debt_customers() -> list[dict]:
    """Nasiyasi bor mijozlar ro'yxatini qaytaradi.

    Har bir satrda: customer_id, customer_name, phone,
    debt_usd, debt_uzs, sale_count, oldest_sale.
    """
    with get_conn() as (conn, cur):
        cur.execute("""
            SELECT
                s.customer_id,
                s.customer_name,
                COALESCE(c.phone, '') AS phone,
                COALESCE(SUM(s.debt_amount) FILTER (
                    WHERE UPPER(COALESCE(s.currency,'USD')) = 'USD'
                ), 0) AS debt_usd,
                COALESCE(SUM(s.debt_amount) FILTER (
                    WHERE UPPER(COALESCE(s.currency,'USD')) = 'UZS'
                ), 0) AS debt_uzs,
                COUNT(*)::int     AS sale_count,
                MIN(s.created_at) AS oldest_sale
            FROM sales s
            LEFT JOIN customers c ON c.id = s.customer_id
            WHERE s.status IN ('pending', 'partial')
              AND COALESCE(s.debt_amount, 0) > 0
            GROUP BY s.customer_id, s.customer_name, c.phone
            ORDER BY MIN(s.created_at) ASC
        """)
        return cur.fetchall()


def get_customer_debt_sales(customer_id: int) -> list[dict]:
    """Bitta mijozning barcha nasiyali savdolarini qaytaradi."""
    with get_conn() as (conn, cur):
        cur.execute("""
            SELECT
                id,
                customer_name,
                total_amount,
                COALESCE(paid_amount, 0)  AS paid_amount,
                COALESCE(debt_amount, 0)  AS debt_amount,
                UPPER(COALESCE(currency, 'USD')) AS currency,
                status,
                note,
                created_at
            FROM sales
            WHERE customer_id = %s
              AND status IN ('pending', 'partial')
              AND COALESCE(debt_amount, 0) > 0
            ORDER BY created_at DESC
        """, (customer_id,))
        return cur.fetchall()


def add_debt_payment(
    sale_id: int, amount: float, currency: str = "USD", note: str = ""
) -> dict:
    """Savdoga to'lov qo'shadi: paid_amount oshadi, debt_amount kamayadi.

    Returns:
        ok=True  → {ok, paid, new_debt, status}
        ok=False → {ok, error}
    """
    with get_conn() as (conn, cur):
        cur.execute(
            "SELECT id, total_amount, paid_amount, debt_amount, status FROM sales WHERE id = %s",
            (sale_id,),
        )
        sale = cur.fetchone()
        if not sale:
            return {"ok": False, "error": "Savdo topilmadi"}

        current_debt = float(sale["debt_amount"] or 0)
        if current_debt <= 0:
            return {"ok": False, "error": "Bu savdoda nasiya yo'q"}
        if amount > current_debt + 0.01:
            return {"ok": False, "error": f"Summa nasiyadan ko'p ({current_debt:,.2f})"}

        new_paid = float(sale["paid_amount"] or 0) + amount
        new_debt = max(0.0, round(current_debt - amount, 2))
        new_status = "paid" if new_debt < 0.01 else "partial"

        cur.execute("""
            UPDATE sales
               SET paid_amount = %s,
                   debt_amount = %s,
                   status      = %s
             WHERE id = %s
        """, (new_paid, new_debt, new_status, sale_id))

        # sale_payments jadvaliga yozamiz (agar jadval mavjud bo'lsa)
        try:
            cur.execute("""
                INSERT INTO sale_payments (sale_id, amount, currency, note)
                VALUES (%s, %s, %s, %s)
            """, (sale_id, amount, currency, note))
        except Exception:
            pass  # jadval hali yaratilmagan bo'lsa (eski muhit), o'tkazib yuboramiz

        return {"ok": True, "paid": amount, "new_debt": new_debt, "status": new_status}


# ══════════════════════════════════════════════════════════════════════════════
# OMBOR (INVENTORY) FUNCTIONS
# ══════════════════════════════════════════════════════════════════════════════

def get_warehouses() -> list[dict]:
    with get_conn() as (conn, cur):
        cur.execute("SELECT id, name FROM warehouses WHERE active=TRUE ORDER BY id")
        return cur.fetchall()


def get_vehicle_handoff_source_warehouses() -> list[dict]:
    """The canonical C-03 warehouse, flagged for handoff eligibility.

    Eligible = purpose 'finished' AND at least one piece-stock product whose
    SKU maps 1:1 to an active savdo-bot mahsulot (the exact acceptance rule of
    the handoff API). Other warehouses are intentionally excluded because new
    Top Mart vehicle handoffs can only originate from C-03.
    Returns [{id, name, eligible, reason}] ordered by name."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT w.id, w.name, COALESCE(w.purpose, '') AS purpose,
                      EXISTS (
                        SELECT 1 FROM inventory i
                         WHERE i.warehouse_id=w.id AND i.quantity>0
                      ) AS has_piece_stock,
                      EXISTS (
                        SELECT 1
                          FROM inventory i
                          JOIN products p ON p.name=i.product AND p.active=TRUE
                         WHERE i.warehouse_id=w.id AND i.quantity>0
                           AND COALESCE(p.sku, '') <> ''
                           AND (SELECT COUNT(*) FROM distribution.mahsulotlar d
                                 WHERE d.sku=p.sku AND d.faol=1
                                   AND COALESCE(d.sku, '') <> '')=1
                           AND (SELECT COUNT(*) FROM products px
                                 WHERE px.sku=p.sku AND px.active=TRUE)=1
                      ) AS has_eligible
                 FROM warehouses w
                WHERE w.active=TRUE
                  AND COALESCE(w.location_type, 'general') <> 'vehicle'
                  AND UPPER(TRIM(w.name))='C-03'
                ORDER BY w.name"""
        )
        rows = cur.fetchall()
    out = []
    for r in rows:
        if r["purpose"] != "finished":
            reason = "tayyor mahsulot ombori emas"
        elif not r["has_piece_stock"]:
            reason = "dona qoldiq yo‘q"
        elif not r["has_eligible"]:
            reason = "savdo bot SKU mosligi yo‘q"
        else:
            reason = None
        out.append({"id": r["id"], "name": r["name"],
                    "eligible": reason is None, "reason": reason})
    return out


def get_vehicle_handoff_products(warehouse_id: int) -> list[dict]:
    """Unique active SKU mappings that currently have piece stock at a source."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT d.id AS mahsulot_id, p.name, p.sku,
                      i.quantity AS available_quantity,
                      COALESCE(i.weight_kg, 0) AS available_weight_kg,
                       p.weight AS unit_weight_kg,
                       p.pieces_per_box
                 FROM inventory i
                 JOIN products p ON p.name=i.product AND p.active=TRUE
                 JOIN distribution.mahsulotlar d ON d.sku=p.sku
                WHERE i.warehouse_id=%s AND i.quantity>0
                  AND d.faol=1 AND COALESCE(d.sku, '') <> ''
                  AND (SELECT COUNT(*) FROM distribution.mahsulotlar dx
                        WHERE dx.sku=p.sku AND dx.faol=1
                          AND COALESCE(dx.sku, '') <> '')=1
                  AND (SELECT COUNT(*) FROM products px
                        WHERE px.sku=p.sku AND px.active=TRUE)=1
                ORDER BY p.name""",
            (warehouse_id,),
        )
        return cur.fetchall()


def get_vehicle_handoff_hidden_products(warehouse_id: int) -> list[dict]:
    """Piece-stock rows at the source that the product selector will NOT offer,
    each with an operator-readable reason (SKU mapping diagnostics).
    Returns [{name, reason}] ordered by product name."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT i.product AS name,
                      (p.id IS NULL) AS inactive_product,
                      COALESCE(p.sku, '') AS sku,
                      COALESCE((SELECT COUNT(*) FROM distribution.mahsulotlar d
                                 WHERE d.sku=p.sku AND d.faol=1
                                   AND COALESCE(d.sku, '') <> ''), 0) AS dist_matches,
                      COALESCE((SELECT COUNT(*) FROM products px
                                 WHERE px.sku=p.sku AND px.active=TRUE), 0) AS erp_matches
                 FROM inventory i
                 LEFT JOIN products p ON p.name=i.product AND p.active=TRUE
                WHERE i.warehouse_id=%s AND i.quantity>0
                ORDER BY i.product""",
            (warehouse_id,),
        )
        rows = cur.fetchall()
    hidden = []
    for r in rows:
        if r["inactive_product"]:
            reason = "ERP mahsuloti faol emas yoki topilmadi"
        elif not r["sku"]:
            reason = "SKU belgilanmagan"
        elif int(r["dist_matches"]) == 0:
            reason = "savdo botda bunday faol SKU yo‘q"
        elif int(r["dist_matches"]) > 1:
            reason = "savdo botda SKU dublikat"
        elif int(r["erp_matches"]) > 1:
            reason = "ERPda SKU dublikat"
        else:
            continue  # eligible — selector already shows it
        hidden.append({"name": r["name"], "reason": reason})
    return hidden


def get_mahsulot_prices(mahsulot_ids: list[int]) -> dict[int, Decimal | None]:
    """Savdo bot narxlari (distribution.mahsulotlar.narx, UZS) by mahsulot id.
    Missing ids are simply absent from the dict; NULL narx maps to None.
    NUMERIC stays Decimal end-to-end — pul hech qachon binary float'dan o'tmaydi."""
    ids = [int(x) for x in mahsulot_ids]
    if not ids:
        return {}
    with get_conn() as (conn, cur):
        cur.execute(
            "SELECT id, narx FROM distribution.mahsulotlar WHERE id = ANY(%s)",
            (ids,),
        )
        rows = cur.fetchall()
    return {
        int(r["id"]): (Decimal(str(r["narx"])) if r["narx"] is not None else None)
        for r in rows
    }


def get_containers() -> list[dict]:
    """Konteyner va ayvon turidagi omborlarni qaytaradi (C-01…C-27, Ayvon 1…3)."""
    with get_conn() as (conn, cur):
        cur.execute(
            "SELECT id, name FROM warehouses WHERE active=TRUE AND location_type IN ('container','ayvon') "
            "ORDER BY (location_type='ayvon'), name"
        )
        return cur.fetchall()


def get_warehouse_by_name(name: str) -> dict | None:
    with get_conn() as (conn, cur):
        cur.execute("SELECT id, name FROM warehouses WHERE name=%s AND active=TRUE", (name,))
        return cur.fetchone()


def get_stock_by_warehouse() -> list[dict]:
    """Returns list of {warehouse_name, product, quantity}"""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT w.name AS warehouse_name, i.product, i.quantity
               FROM inventory i
               JOIN warehouses w ON w.id = i.warehouse_id
               WHERE i.quantity > 0
               ORDER BY w.id, i.product"""
        )
        return cur.fetchall()


def get_stock_for_warehouse(warehouse_id: int) -> list[dict]:
    """Skladdagi mavjud pozitsiyalar. Mavjudlik = dona (quantity>0) YOKI
    og'irlik (weight_kg>0) — kg-qatorlar (qty=0, faqat og'irlik) ham ko'rinadi."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT product, quantity, COALESCE(weight_kg, 0) AS weight_kg, product_type
               FROM inventory
               WHERE warehouse_id=%s AND (quantity>0 OR COALESCE(weight_kg,0)>0)
               ORDER BY product""",
            (warehouse_id,),
        )
        return cur.fetchall()


def get_stock_locations(product: str) -> list[dict]:
    """Tovar qaysi skladlarda va qancha borligi (kirimda ko'rsatish uchun)."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT w.name AS warehouse, i.quantity, COALESCE(i.weight_kg,0) AS weight_kg
               FROM inventory i
               JOIN warehouses w ON w.id = i.warehouse_id
               WHERE i.product=%s AND (i.quantity>0 OR COALESCE(i.weight_kg,0)>0)
               ORDER BY w.name""",
            (product,),
        )
        return cur.fetchall()


def get_unit_for_item(name: str, category: str) -> str:
    """'kg' yoki 'dona' — kirim/chiqim rejimini aniqlash uchun.
    category='raw' → raw_materials.unit_type, aks holda products.unit_type."""
    with get_conn() as (conn, cur):
        if category == "raw":
            cur.execute(
                "SELECT COALESCE(unit_type, unit, 'kg') AS u FROM raw_materials WHERE name=%s",
                (name,),
            )
        else:
            cur.execute("SELECT unit_type AS u FROM products WHERE name=%s", (name,))
        row = cur.fetchone()
    if not row:
        return "kg" if category == "raw" else "dona"
    u = str(row.get("u") or "").strip().lower()
    return "kg" if u.startswith("kg") else "dona"


def get_inventory_line(warehouse_id: int, product: str) -> dict | None:
    """Bitta konteyner liniyasi: joriy miqdor, og'irlik va mahsulot birligi (kg/dona)."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT i.quantity,
                      COALESCE(i.weight_kg, 0)            AS weight_kg,
                      LOWER(COALESCE(p.unit_type, rm.unit_type, 'dona')) AS unit_type
               FROM inventory i
               LEFT JOIN products p ON p.name = i.product
               LEFT JOIN raw_materials rm ON rm.name = i.product
               WHERE i.warehouse_id = %s AND i.product = %s""",
            (warehouse_id, product),
        )
        return cur.fetchone()


def record_movement(
    product: str,
    quantity: float,
    movement_type: str,
    from_warehouse_id: int | None,
    to_warehouse_id: int | None,
    note: str = "",
    created_by: str = "",
    product_type: str = "finished",
    weight_kg: float = 0.0,
) -> bool:
    """movement_type: IN | OUT | TRANSFER; product_type: finished | raw | pre-finished

    Ikki rejim:
      • DONA rejimi (weight_kg=0): quantity dona sifatida yoziladi; og'irlik
        evristikasi eskicha — kirimda partiya nisbati, chiqimda proporsional.
      • KG rejimi (weight_kg>0, quantity=0): inventarda FAQAT weight_kg o'zgaradi,
        dona ustuni tegilmaydi. Harakat yozuvi:
          - raw uchun quantity=weight_kg (global xom ashyo ledgeri quantity'ni
            sanaydi — dashboard bilan bir xil konventsiya) va weight_kg ham to'ladi;
          - finished/pre-finished uchun quantity=0, weight_kg to'ladi.

    Xom ashyo globali (raw_materials.current_stock) ledger semantikasiga mos
    sinxronlanadi: IN → +miqdor; OUT skladdan (bo'limga berish) → global
    o'zgarmaydi; OUT skladsiz → −miqdor; TRANSFER → o'zgarmaydi.
    """
    kg_mode = float(weight_kg or 0) > 0
    amount = float(weight_kg) if kg_mode else float(quantity)
    try:
        with get_conn() as (conn, cur):
            def _incoming_weight() -> float:
                """Kirim uchun og'irlik — kg-mahsulot bo'lsa partiya nisbati bo'yicha."""
                cur.execute("SELECT unit_type FROM products WHERE name=%s", (product,))
                prow = cur.fetchone()
                if not prow or str(prow.get("unit_type") or "").lower() != "kg":
                    return 0.0
                cur.execute(
                    """SELECT CASE WHEN SUM(quantity) > 0
                                   THEN SUM(weight_kg)::numeric / SUM(quantity)
                                   ELSE 0 END AS kg_per_unit
                       FROM batches WHERE product=%s""",
                    (product,),
                )
                rr = cur.fetchone()
                kg_per_unit = float(rr["kg_per_unit"] or 0) if rr else 0.0
                return quantity * kg_per_unit

            def _outgoing_weight(wh_id: int) -> float:
                """Chiqim uchun og'irlik — joriy saqlangan nisbatdan proporsional.
                FOR UPDATE: nisbat hisoblanayotgan qator tranzaksiya oxirigacha
                qulflanadi (parallel chiqimlar nisbatni buzmasin)."""
                cur.execute(
                    "SELECT quantity, weight_kg FROM inventory WHERE warehouse_id=%s AND product=%s FOR UPDATE",
                    (wh_id, product),
                )
                row = cur.fetchone()
                if not row:
                    return 0.0
                cur_qty = float(row["quantity"] or 0)
                cur_w   = float(row["weight_kg"] or 0)
                if cur_qty <= 0 or cur_w <= 0:
                    return 0.0
                return min(cur_w, cur_w * quantity / cur_qty)

            # KG rejimida dona ustuni tegilmaydi; DONA rejimida eski evristika.
            in_qty = 0.0 if kg_mode else quantity

            # 1) MANBA (chiqim/o'tkazish skladdan) — yetarlilik SHARTI bilan
            #    atomar ayirish. Tanlash va tasdiqlash orasida boshqa foydalanuvchi
            #    qoldiqni kamaytirgan bo'lsa, shart bajarilmaydi va HECH NARSA
            #    yozilmaydi (harakat yozuvi ham) — yolg'on harakat qolmaydi.
            deduct_src = (
                (movement_type == "OUT" and from_warehouse_id)
                or (movement_type == "TRANSFER" and from_warehouse_id and to_warehouse_id)
            )
            src_w = 0.0
            if deduct_src:
                if kg_mode:
                    src_w = amount
                    cur.execute(
                        """UPDATE inventory
                              SET weight_kg = GREATEST(0, weight_kg - %s), updated_at = NOW()
                            WHERE warehouse_id=%s AND product=%s
                              AND COALESCE(weight_kg, 0) >= %s - 0.005""",
                        (amount, from_warehouse_id, product, amount),
                    )
                else:
                    src_w = _outgoing_weight(from_warehouse_id)
                    cur.execute(
                        """UPDATE inventory
                              SET quantity = GREATEST(0, quantity - %s),
                                  weight_kg = GREATEST(0, weight_kg - %s),
                                  updated_at = NOW()
                            WHERE warehouse_id=%s AND product=%s
                              AND quantity >= %s - 0.005""",
                        (quantity, src_w, from_warehouse_id, product, quantity),
                    )
                if cur.rowcount == 0:
                    conn.rollback()
                    return False

            # 2) Harakat yozuvi — manba tekshiruvidan KEYIN.
            move_qty = (
                amount if (kg_mode and product_type == "raw")
                else (0.0 if kg_mode else quantity)
            )
            cur.execute(
                """INSERT INTO stock_movements
                     (product, quantity, movement_type, from_warehouse_id, to_warehouse_id,
                      note, created_by, product_type, weight_kg)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (product, move_qty, movement_type, from_warehouse_id,
                 to_warehouse_id, note, created_by, product_type,
                 amount if kg_mode else None),
            )

            # 3) QABUL tomoni (kirim / o'tkazish qabul).
            if movement_type == "IN" and to_warehouse_id:
                w_in = amount if kg_mode else _incoming_weight()
                cur.execute(
                    """INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type, updated_at)
                       VALUES (%s,%s,%s,%s,%s,NOW())
                       ON CONFLICT (warehouse_id, product)
                       DO UPDATE SET quantity=inventory.quantity+%s,
                                     weight_kg=inventory.weight_kg+%s, updated_at=NOW()""",
                    (to_warehouse_id, product, in_qty, w_in, product_type, in_qty, w_in),
                )
            elif movement_type == "TRANSFER" and from_warehouse_id and to_warehouse_id:
                w_move = amount if kg_mode else src_w
                cur.execute(
                    """INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type, updated_at)
                       VALUES (%s,%s,%s,%s,%s,NOW())
                       ON CONFLICT (warehouse_id, product)
                       DO UPDATE SET quantity=inventory.quantity+%s,
                                     weight_kg=inventory.weight_kg+%s, updated_at=NOW()""",
                    (to_warehouse_id, product, in_qty, w_move, product_type, in_qty, w_move),
                )

            # 4) Xom ashyo globalini ledger semantikasiga mos sinxronlash:
            # IN → +miqdor; OUT skladdan → 0; OUT skladsiz → −miqdor; TRANSFER → 0.
            if product_type == "raw":
                if movement_type == "IN":
                    cur.execute(
                        "UPDATE raw_materials SET current_stock = current_stock + %s WHERE name = %s",
                        (amount, product),
                    )
                elif movement_type == "OUT" and from_warehouse_id is None:
                    cur.execute(
                        "UPDATE raw_materials SET current_stock = current_stock - %s WHERE name = %s",
                        (amount, product),
                    )
        return True
    except Exception as e:
        return False


def get_recent_movements(limit: int = 10) -> list[dict]:
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT m.product, m.quantity, m.movement_type, m.product_type,
                      COALESCE(m.weight_kg, 0) AS weight_kg,
                      fw.name AS from_wh, tw.name AS to_wh,
                      m.created_by, m.created_at
               FROM stock_movements m
               LEFT JOIN warehouses fw ON fw.id=m.from_warehouse_id
               LEFT JOIN warehouses tw ON tw.id=m.to_warehouse_id
               ORDER BY m.id DESC LIMIT %s""",
            (limit,),
        )
        return cur.fetchall()


# ══════════════════════════════════════════════════════════════════════════════
# PACKER PRODUCT ASSIGNMENTS
# ══════════════════════════════════════════════════════════════════════════════

def get_packer_assigned_products(packer_name: str) -> list[str]:
    """V3: Returns products assigned to a packer via packer_product_assignments.
    Returns [] if no assignments (caller should fallback to all active products)."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT pa.product_name
               FROM packer_product_assignments pa
               JOIN products p ON p.name = pa.product_name
               WHERE pa.packer_name = %s AND p.active = TRUE
               ORDER BY pa.product_name""",
            (packer_name,),
        )
        return [r["product_name"] for r in cur.fetchall()]


def has_packer_assignments(packer_name: str) -> bool:
    """Packer uchun packer_product_assignments'da yozuv bormi (faol/nofaol farqsiz)."""
    with get_conn() as (conn, cur):
        cur.execute(
            "SELECT 1 FROM packer_product_assignments WHERE packer_name = %s LIMIT 1",
            (packer_name,),
        )
        return cur.fetchone() is not None


def get_packer_product_rows(packer_name: str) -> list[str]:
    """Packer'ga biriktirilgan BARCHA mahsulot nomlari (faol/nofaol farqsiz) —
    admin boshqaruv UI'si mavjud yozuvlarni to'liq ko'rishi uchun."""
    with get_conn() as (conn, cur):
        cur.execute(
            "SELECT product_name FROM packer_product_assignments WHERE packer_name = %s ORDER BY product_name",
            (packer_name,),
        )
        return [r["product_name"] for r in cur.fetchall()]


def set_packer_products(packer_name: str, product_names: list[str]) -> None:
    """Packer mahsulot biriktirmalarini to'liq almashtiradi.
    Bo'sh ro'yxat = barcha yozuvlar o'chiriladi (fallback: hamma faol mahsulot)."""
    with get_conn() as (conn, cur):
        cur.execute(
            "DELETE FROM packer_product_assignments WHERE packer_name = %s",
            (packer_name,),
        )
        for p in product_names:
            cur.execute(
                """INSERT INTO packer_product_assignments (packer_name, product_name)
                   VALUES (%s, %s) ON CONFLICT DO NOTHING""",
                (packer_name, p),
            )


def get_products_for_packer(packer_name: str) -> list[str]:
    """V3: Packer uchun ko'rsatiladigan mahsulotlar ro'yxati.

    - Biriktirilgan faol mahsulotlar bo'lsa — faqat shular.
    - Umuman biriktirilmagan bo'lsa — barcha faol mahsulotlar (fallback).
    - Biriktirilgan, LEKIN hammasi nofaol bo'lsa — BO'SH ro'yxat. Fallback
      butun katalogni ochib yubormasligi kerak: admin ataylab cheklagan
      packer nofaol mahsulot tufayli hamma narsani ko'rmasin (keyboard
      "Mahsulotlar biriktirilmagan" tugmasini ko'rsatadi)."""
    assigned = get_packer_assigned_products(packer_name)
    if assigned:
        return assigned
    if has_packer_assignments(packer_name):
        return []
    return get_product_names()


# ══════════════════════════════════════════════════════════════════════════════
# XOM ASHYO (RAW MATERIALS)
# ══════════════════════════════════════════════════════════════════════════════

def get_raw_materials() -> list[dict]:
    """Barcha faol xom ashyolar ro'yxati."""
    with get_conn() as (conn, cur):
        cur.execute(
            "SELECT id, name, unit FROM raw_materials WHERE active=TRUE ORDER BY name"
        )
        return cur.fetchall()


def get_raw_material_names() -> list[str]:
    with get_conn() as (conn, cur):
        cur.execute("SELECT name FROM raw_materials WHERE active=TRUE ORDER BY name")
        return [r["name"] for r in cur.fetchall()]


def get_raw_materials_full() -> list[dict]:
    """id, name, unit va joriy zahira bilan faol xom ashyolar (to'g'rilash uchun)."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT id, name, unit, COALESCE(current_stock, 0) AS current_stock
               FROM raw_materials WHERE active=TRUE ORDER BY name"""
        )
        return cur.fetchall()


def get_raw_material_by_id(material_id: int) -> dict | None:
    """Bitta xom ashyoning joriy zahirasi va birligi."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT id, name, unit, COALESCE(current_stock, 0) AS current_stock
               FROM raw_materials WHERE id=%s AND active=TRUE""",
            (material_id,),
        )
        return cur.fetchone()


def add_raw_material(name: str, unit: str = "kg") -> bool:
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                "INSERT INTO raw_materials (name, unit) VALUES (%s,%s) ON CONFLICT (name) DO UPDATE SET active=TRUE, unit=%s",
                (name, unit, unit),
            )
        return True
    except Exception:
        return False


def delete_raw_material(name: str) -> bool:
    try:
        with get_conn() as (conn, cur):
            cur.execute("UPDATE raw_materials SET active=FALSE WHERE name=%s", (name,))
        return True
    except Exception:
        return False


def get_stock_by_warehouse_typed() -> dict:
    """Returns {'finished': [...], 'raw': [...]} grouped by product_type."""
    with get_conn() as (conn, cur):
        cur.execute(
            """SELECT w.name AS warehouse_name, i.product, i.quantity,
                      COALESCE(i.weight_kg, 0) AS weight_kg, i.product_type
               FROM inventory i
               JOIN warehouses w ON w.id = i.warehouse_id
               WHERE i.quantity > 0 OR COALESCE(i.weight_kg, 0) > 0
               ORDER BY i.product_type, w.id, i.product"""
        )
        rows = cur.fetchall()
    result: dict = {"finished": [], "raw": []}
    for r in rows:
        pt = r["product_type"] if r["product_type"] in ("finished", "raw") else "finished"
        result[pt].append(r)
    return result


# ── Sales report ──────────────────────────────────────────────────────────────

def get_sales_report_summary(from_date: str, to_date: str) -> dict:
    """Savdo hisoboti uchun umumiy statistika (from_date/to_date: 'YYYY-MM-DD')."""
    with get_conn() as (conn, cur):
        cur.execute("""
            SELECT
              COUNT(DISTINCT s.id)::int AS sale_count,
              COUNT(DISTINCT s.id) FILTER (WHERE s.status='paid')::int AS paid_count,
              COUNT(DISTINCT s.id) FILTER (WHERE s.status IN ('pending','partial'))::int AS pending_count,
              COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='usd'), 0) AS total_usd,
              COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='uzs'), 0) AS total_uzs
            FROM sales s
            LEFT JOIN sale_items si ON si.sale_id = s.id
            WHERE s.created_at::date BETWEEN %s AND %s
        """, (from_date, to_date))
        stats = dict(cur.fetchone() or {})

        cur.execute("""
            SELECT si.product_name,
                   ROUND(SUM(si.quantity)::numeric, 2) AS total_qty,
                   COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='usd'), 0) AS rev_usd,
                   COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='uzs'), 0) AS rev_uzs
            FROM sales s
            JOIN sale_items si ON si.sale_id = s.id
            WHERE s.created_at::date BETWEEN %s AND %s
            GROUP BY si.product_name
            ORDER BY rev_usd DESC, rev_uzs DESC
            LIMIT 10
        """, (from_date, to_date))
        products = cur.fetchall()

        cur.execute("""
            SELECT s.customer_name,
                   COUNT(DISTINCT s.id)::int AS sale_count,
                   COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='usd'), 0) AS total_usd,
                   COALESCE(SUM(si.line_total) FILTER (WHERE LOWER(si.currency)='uzs'), 0) AS total_uzs
            FROM sales s
            LEFT JOIN sale_items si ON si.sale_id = s.id
            WHERE s.created_at::date BETWEEN %s AND %s
            GROUP BY s.customer_name
            ORDER BY total_usd DESC, total_uzs DESC
            LIMIT 10
        """, (from_date, to_date))
        customers = cur.fetchall()

        cur.execute("""
            SELECT s.id, s.created_at::date AS date, s.customer_name,
                   s.status, s.payment_type,
                   si.product_name, si.quantity, si.sale_type,
                   si.unit_price, si.currency, si.line_total
            FROM sales s
            JOIN sale_items si ON si.sale_id = s.id
            WHERE s.created_at::date BETWEEN %s AND %s
            ORDER BY s.created_at DESC, s.id, si.id
            LIMIT 200
        """, (from_date, to_date))
        items = cur.fetchall()

    return {
        "stats": stats,
        "products": [dict(r) for r in products],
        "customers": [dict(r) for r in customers],
        "items": [dict(r) for r in items],
    }
