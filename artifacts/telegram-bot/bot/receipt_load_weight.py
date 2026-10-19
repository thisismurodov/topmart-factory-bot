"""Reconstruct receipt-backed FIFO weight without averaging mixed receipts."""
from decimal import Decimal
from .database import get_conn

D = Decimal
TOLERANCE = D("0.0001")


def receipt_weight(movements, stock_qty, stock_kg, requested):
    lots = []
    for row in movements:
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
                raise ValueError("Oldingi chiqim kirim partiyalari bilan mos emas.")
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


def get_receipt_load_weight(warehouse_id, product, quantity):
    with get_conn() as (conn, cur):
        conn.set_session(readonly=True, isolation_level="REPEATABLE READ")
        cur.execute("""SELECT quantity,weight_kg FROM inventory
            WHERE warehouse_id=%s AND product=%s AND product_type='finished'""",
                    (warehouse_id, product))
        inventories = cur.fetchall()
        if len(inventories) != 1:
            raise ValueError("Mahsulot qoldig‘i aniq topilmadi.")
        cur.execute("""SELECT m.quantity,m.weight_kg,
            CASE WHEN m.to_warehouse_id=%s THEN 'in' ELSE 'out' END AS direction,
            r.id AS receipt_id,r.quantity AS receipt_quantity,
            r.total_weight_kg AS receipt_weight
            FROM stock_movements m
            LEFT JOIN distribution.topmart_external_purchase_receipts r
              ON r.stock_movement_id=m.id AND r.c03_warehouse_id=%s
            WHERE m.product=%s AND m.product_type='finished'
              AND (m.from_warehouse_id=%s OR m.to_warehouse_id=%s)
            ORDER BY m.created_at,m.id""",
            (warehouse_id, warehouse_id, product, warehouse_id, warehouse_id))
        stock = inventories[0]
        return receipt_weight(cur.fetchall(), stock["quantity"], stock["weight_kg"], quantity)
