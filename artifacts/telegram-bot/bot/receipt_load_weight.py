"""Reconstruct receipt-backed FIFO weight without averaging mixed receipts."""
from decimal import Decimal
import re
from .database import get_conn

D = Decimal
TOLERANCE = D("0.0001")

def documented_movements(rows):
    """Accept a verified factory sale's IN once, not its audit TRANSFER twin."""
    transfers = {}
    for row in rows:
        ref = row.get("reference") or ""
        if re.fullmatch(r"topmart-sale:\d+:\d+:transfer", ref):
            transfers.setdefault(ref.rsplit(":", 1)[0], []).append(row)
    skipped = set()
    for row in rows:
        ref = row.get("reference") or ""
        if not re.fullmatch(r"topmart-sale:\d+:\d+:in", ref):
            continue
        if row.get("direction") != "in" or row.get("movement_type") != "IN":
            raise ValueError("Ichki kirim harakati noto‘g‘ri.")
        if not row.get("sale_item_id"):
            raise ValueError("Diyor → Top Mart ichki kirim hujjati topilmadi.")
        twins = transfers.get(ref.rsplit(":", 1)[0], [])
        if len(twins) != 1:
            raise ValueError("Ichki kirimning juft harakati aniq topilmadi.")
        twin = twins[0]
        if (twin.get("movement_type") != "TRANSFER"
                or twin.get("direction") != "in"
                or twin.get("from_warehouse_id") is not None
                or row.get("from_warehouse_id") is not None
                or twin.get("to_warehouse_id") != row.get("to_warehouse_id")
                or twin["quantity"] != row["quantity"]
                or twin["weight_kg"] != row["weight_kg"]
                or row.get("sale_type") != "dona"
                or D(str(row["sale_quantity"])) != D(str(row["quantity"]))):
            raise ValueError("Ichki kirim hujjati va harakatlari mos emas.")
        skipped.add(twin["id"])
        row = dict(row)
        row.update(receipt_id="sale:%s" % row["sale_item_id"],
                   receipt_quantity=row["sale_quantity"],
                   receipt_weight=row["weight_kg"])
        # Do not overwrite the input, which may be reused by callers/tests.
        yield row
    for row in rows:
        if row.get("id") in skipped:
            continue
        if re.fullmatch(r"topmart-sale:\d+:\d+:in", row.get("reference") or ""):
            continue
        yield dict(row)


def receipt_weight(movements, stock_qty, stock_kg, requested):
    lots = []
    for row in movements:
        if row["weight_kg"] is None or row["quantity"] is None:
            raise ValueError("Kirim/chiqim hujjatida vazn yoki dona soni yo‘q.")
        qty, kg = D(str(row["quantity"])), D(str(row["weight_kg"]))
        if qty < 0 or kg < 0 or qty != qty.to_integral_value():
            raise ValueError("Kirim tarixi miqdori noto‘g‘ri.")
        direction = row["direction"]
        if qty == 0:
            # A measured correction is attributable only while exactly one
            # receipt remains; never distribute a correction across mixed lots.
            if kg == 0:
                continue
            if len(lots) != 1:
                raise ValueError("Vazn tuzatishining qaysi kirimga tegishli ekani aniq emas.")
            lots[0][1] += kg if direction == "in" else -kg
            if lots[0][1] <= 0:
                raise ValueError("Tuzatilgan kirim vazni noto‘g‘ri.")
        elif direction == "in":
            if not row.get("receipt_id") or kg <= 0:
                raise ValueError("Asl kirim hujjati topilmadi; taxminiy vazn ishlatilmaydi.")
            if (D(str(row["receipt_quantity"])) != qty
                    or abs(D(str(row["receipt_weight"])) - kg) > TOLERANCE):
                raise ValueError("Kirim hujjati va kirim harakati mos emas.")
            lots.append([qty, kg])
        else:
            remaining, taken_weight = qty, D(0)
            while remaining > 0 and lots:
                available, weight = lots[0]
                take = min(remaining, available)
                take_weight = weight * take / available
                taken_weight += take_weight
                remaining -= take
                if take == available:
                    lots.pop(0)
                else:
                    lots[0] = [available - take, weight - take_weight]
            if remaining or abs(taken_weight - kg) > TOLERANCE:
                raise ValueError(
                    "Oldingi chiqim kirim partiyalari bilan mos emas: "
                    f"{qty:g} dona uchun kirim bo‘yicha {taken_weight:.4f} kg, "
                    f"chiqimda {kg:.4f} kg. Asl hujjat bo‘yicha vaznni tekshirish kerak.")
    if (sum((r[0] for r in lots), D(0)) != D(str(stock_qty))
            or abs(sum((r[1] for r in lots), D(0)) - D(str(stock_kg))) > TOLERANCE):
        raise ValueError("Kirim tarixi joriy qoldiq bilan mos emas.")
    qty = D(str(requested))
    if qty <= 0 or qty != qty.to_integral_value() or not lots:
        raise ValueError("Yuklash dona soni noto‘g‘ri.")
    # One handoff item currently has one unit-weight snapshot. Do not merge
    # different receipt weights into a fictitious average for its labels.
    unit = lots[0][1] / lots[0][0]
    available = D(0)
    for count, weight in lots:
        if abs(weight / count - unit) > D("0.00000001"):
            break
        available += count
    if qty > available:
        raise ValueError(f"Birinchi kirimdan {available:g} dona qolgan. Turli vaznli kirimlarni alohida yuklang.")
    return (qty * unit).quantize(D("0.0001"))

def apply_receipt_corrections(rows):
    """Project explicit receipt-scoped audit corrections; never edit history.

    The correction's kg delta also changes inventory. Apply it to its named
    receipt before replaying withdrawals, not to whichever lot remains today.
    Existing withdrawals must still match the corrected receipt or replay fails.
    """
    rows = [dict(row) for row in rows]
    by_id = {row.get("id"): row for row in rows if row.get("id") is not None}
    corrected = set()
    result = []
    for row in rows:
        if row.get("reason") != "receipt_weight_correction":
            result.append(row)
            continue
        match = re.fullmatch(r"receipt-weight-correction:(\d+)", row.get("reference") or "")
        target = by_id.get(int(match[1])) if match else None
        if (target is None or target["id"] in corrected
                or not target.get("receipt_id") or target.get("direction") != "in"
                or target.get("to_warehouse_id") != row.get("to_warehouse_id")
                or row.get("direction") != "in" or row.get("movement_type") != "IN"
                or row.get("from_warehouse_id") is not None
                or D(str(row["quantity"])) != 0
                or row.get("weight_kg") is None or D(str(row["weight_kg"])) <= 0
                or target["created_at"] > row["created_at"]):
            raise ValueError("Kirim vazni tuzatishining hujjati noto‘g‘ri yoki takrorlangan.")
        target["weight_kg"] = D(str(target["weight_kg"])) + D(str(row["weight_kg"]))
        target["receipt_weight"] = target["weight_kg"]
        corrected.add(target["id"])
    return result


def get_receipt_load_weight(warehouse_id, product, quantity):
    with get_conn() as (conn, cur):
        conn.set_session(readonly=True, isolation_level="REPEATABLE READ")
        cur.execute("""SELECT quantity,weight_kg FROM inventory
            WHERE warehouse_id=%s AND product=%s AND product_type='finished'""",
                    (warehouse_id, product))
        inventories = cur.fetchall()
        if len(inventories) != 1:
            raise ValueError("Mahsulot qoldig‘i aniq topilmadi.")
        cur.execute("""SELECT m.id,m.created_at,m.reference,m.reason,m.movement_type,
            m.from_warehouse_id,m.to_warehouse_id,m.quantity,m.weight_kg,
            CASE WHEN m.to_warehouse_id=%s THEN 'in' ELSE 'out' END AS direction,
            r.id AS receipt_id,r.quantity AS receipt_quantity,
            r.total_weight_kg AS receipt_weight,
            si.id AS sale_item_id,si.quantity AS sale_quantity,si.sale_type
            FROM stock_movements m
            LEFT JOIN distribution.topmart_external_purchase_receipts r
              ON r.stock_movement_id=m.id AND r.c03_warehouse_id=%s
            LEFT JOIN LATERAL (
                SELECT item.id,item.quantity,item.sale_type
                FROM sales s
                JOIN (
                    SELECT id,sale_id,product_name,quantity,sale_type,
                           row_number() OVER (PARTITION BY sale_id ORDER BY id) AS pos
                    FROM sale_items
                ) item ON item.sale_id=s.id
                WHERE m.reference='topmart-sale:'||s.id||':'||item.pos||':in'
                  AND s.topmart_warehouse_id=m.to_warehouse_id
                  AND item.product_name=m.product
            ) si ON TRUE
            WHERE m.product=%s AND m.product_type='finished'
              AND (m.from_warehouse_id=%s OR m.to_warehouse_id=%s)
            ORDER BY m.created_at,m.id""",
            (warehouse_id, warehouse_id, product, warehouse_id, warehouse_id))
        stock = inventories[0]
        rows = sorted(apply_receipt_corrections(list(documented_movements(cur.fetchall()))),
                      key=lambda row: (row["created_at"], row["id"]))
        return receipt_weight(rows, stock["quantity"], stock["weight_kg"], quantity)
