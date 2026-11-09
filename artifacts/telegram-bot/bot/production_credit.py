"""C-03 production receipts must carry an approved Top Mart credit sale.

All writes use the batch caller's cursor; never commit independently.
"""
from decimal import Decimal


def quote_credit(cur, warehouse_id, items):
    cur.execute("SELECT id,name FROM warehouses WHERE id=%s AND active=TRUE FOR SHARE",
                (warehouse_id,))
    warehouse = cur.fetchone()
    if not warehouse:
        raise ValueError("Ombor topilmadi.")
    is_c03 = str(warehouse["name"]).strip().upper() == "C-03"
    if not is_c03:
        return None
    cur.execute("SELECT customer_id,central_warehouse_id FROM distribution.topmart_config WHERE id=1 FOR SHARE")
    config = cur.fetchone()
    if not config or not is_c03 or config["central_warehouse_id"] != warehouse_id:
        raise ValueError("Top Mart / C-03 sozlamasi mos emas.")
    cur.execute("SELECT id,name FROM customers WHERE id=%s AND deleted_at IS NULL FOR SHARE",
                (config["customer_id"],))
    customer = cur.fetchone()
    if not customer:
        raise ValueError("Top Mart xaridori topilmadi.")
    lines = []
    for item in items:
        weight = Decimal(str(item.get("weight_kg") or 0))
        if not weight.is_finite() or weight <= 0:
            raise ValueError("C-03 kirimi uchun haqiqiy vaznni kiriting: " + item["product"])
        cur.execute("""SELECT id,unit_type,default_sale_price,currency_type FROM products
                       WHERE name=%s AND active=TRUE AND in_sales=TRUE FOR SHARE""",
                    (item["product"],))
        product = cur.fetchone()
        if not product:
            raise ValueError("Sotuv mahsuloti topilmadi: " + item["product"])
        unit = str(product["unit_type"]).lower()
        if unit not in ("dona", "kg"):
            raise ValueError("Sotuv birligi noto‘g‘ri: " + item["product"])
        qty = Decimal(str(item["weight_kg"] if unit == "kg" else item["quantity"]))
        if not qty.is_finite() or qty <= 0:
            raise ValueError("Savdo miqdori musbat bo‘lishi kerak.")
        cur.execute("""SELECT price,currency FROM product_price_tiers
                       WHERE product_id=%s AND min_quantity<=%s AND max_quantity>=%s
                       ORDER BY min_quantity LIMIT 1 FOR SHARE""", (product["id"], qty, qty))
        tier = cur.fetchone()
        price = Decimal(str(tier["price"] if tier else product["default_sale_price"] or 0))
        currency = str((tier["currency"] if tier else product["currency_type"]) or "UZS").upper()
        if not price.is_finite() or price <= 0:
            raise ValueError("Diyor berish narxi kiritilmagan: " + item["product"])
        lines.append(dict(product=item["product"], unit=unit, quantity=str(qty),
                          price=str(price), currency=currency,
                          total=str((qty * price).quantize(Decimal("0.01"))),
                          pieces=str(item["quantity"]), weight=str(item["weight_kg"])))
    currencies = {line["currency"] for line in lines}
    if len(currencies) != 1:
        raise ValueError("Turli valyutadagi mahsulotlarni alohida kiriting.")
    return dict(customer_id=customer["id"], customer_name=customer["name"],
                warehouse_id=warehouse_id, lines=lines, currency=lines[0]["currency"],
                total=str(sum(Decimal(line["total"]) for line in lines)))


def save_credit(cur, quote, operation_key, batch_code):
    import uuid
    import hashlib
    import json
    key = str(uuid.UUID(operation_key))
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("topmart-sale:" + key,))
    cur.execute("SELECT id FROM sales WHERE operation_key=%s", (key,))
    if cur.fetchone():
        raise ValueError("Bu kirim oldin saqlangan. Takror kirim yaratilmadi.")
    cur.execute("""INSERT INTO sales
        (customer_id,customer_name,status,note,total_amount,currency,payment_type,
         paid_amount,debt_amount,topmart_warehouse_id,operation_key,request_fingerprint)
        VALUES (%s,%s,'pending',%s,%s,%s,'nasiya',0,%s,%s,%s,%s) RETURNING id""",
        (quote["customer_id"], quote["customer_name"], "Ishlab chiqarish: " + batch_code,
         quote["total"], quote["currency"], quote["total"], quote["warehouse_id"], key,
         hashlib.sha256(json.dumps(quote, sort_keys=True).encode()).hexdigest()))
    sale_id = cur.fetchone()["id"]
    for line in quote["lines"]:
        cur.execute("""INSERT INTO sale_items
            (sale_id,product_name,sale_type,quantity,unit_price,currency,line_total)
            VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (sale_id,line["product"],line["unit"],line["quantity"],line["price"],
             line["currency"],line["total"]))
    return sale_id


def credit_movements(cur, sale_id, index, item, warehouse_id, worker):
    reference = f"topmart-sale:{sale_id}:{index + 1}"
    cur.execute("""INSERT INTO stock_movements
        (product,quantity,movement_type,to_warehouse_id,note,created_by,product_type,weight_kg,reference)
        VALUES (%s,%s,'TRANSFER',%s,%s,%s,'finished',%s,%s),
               (%s,%s,'IN',%s,%s,%s,'finished',%s,%s)""",
        tuple(value for suffix in ("transfer", "in") for value in
              (item["product"],item["quantity"],warehouse_id,f"Top Mart sale #{sale_id}",
               worker,item["weight_kg"],reference + ":" + suffix)))
