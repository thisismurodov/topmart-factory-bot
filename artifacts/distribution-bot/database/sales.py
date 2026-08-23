"""Sale creation — one all-or-nothing transaction."""

import hashlib
import json
import os
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation

import psycopg2

from .connection import transaction
from .customers import update_dokon_repeat, update_balans_delta


class VehiclePilotSaleError(ValueError):
    """A user-correctable F7 pilot domain conflict."""


class VehiclePilotIdempotencyConflict(VehiclePilotSaleError):
    pass


def _sale_dates():
    now = datetime.now()
    try:
        rdays = int(os.environ.get("REVISIT_DAYS", "7"))
    except ValueError:
        rdays = 7
    return now.isoformat(), (date.today() + timedelta(days=rdays)).isoformat()


def _insert_sale_core(c, dokon_id, agent_id, items, jami, tolov, foto, nasiya_summa,
                      operation_key=None, operation_fingerprint=None, posted=False):
    """Shared legacy sale effects. Caller owns the transaction."""
    now, revisit_date = _sale_dates()
    c.execute(
        """INSERT INTO distribution.savdolar
           (dokon_id,agent_id,jami_summa,tolov_turi,foto,created_at,
            operation_key,operation_fingerprint,status,posted_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
        (dokon_id, agent_id, jami, tolov, foto, now, operation_key,
         operation_fingerprint, "posted" if posted else "active",
         datetime.now() if posted else None),
    )
    sid = c.fetchone()[0]
    update_dokon_repeat(c, dokon_id, jami)
    c.execute(
        "UPDATE distribution.revisitlar SET status='superseded' "
        "WHERE dokon_id=%s AND status='pending'", (dokon_id,),
    )
    c.execute(
        """INSERT INTO distribution.revisitlar
           (dokon_id,agent_id,last_order_date,revisit_date,status,created_at)
           VALUES (%s,%s,%s,%s,%s,%s)""",
        (dokon_id, agent_id, date.today().isoformat(), revisit_date, "pending", now),
    )
    details = []
    for mid, miqdor, narx in items:
        c.execute(
            """INSERT INTO distribution.savdo_tafsilot
               (savdo_id,mahsulot_id,miqdor,narx,summa)
               VALUES (%s,%s,%s,%s,%s) RETURNING id""",
            (sid, mid, miqdor, narx, narx * miqdor),
        )
        details.append((c.fetchone()[0], mid, miqdor, narx))
    if nasiya_summa > 0:
        c.execute(
            """INSERT INTO distribution.nasiya
               (dokon_id,agent_id,savdo_id,jami_summa,tolangan,qoldiq,created_at,updated_at)
               VALUES (%s,%s,%s,%s,0,%s,%s,%s)""",
            (dokon_id, agent_id, sid, nasiya_summa, nasiya_summa, now, now),
        )
    c.execute("SELECT owner_telegram_id FROM distribution.dokonlar WHERE id=%s", (dokon_id,))
    row = c.fetchone()
    owner_tg = row[0] if row else None
    c.execute(
        "SELECT COALESCE(SUM(qoldiq),0) FROM distribution.nasiya "
        "WHERE dokon_id=%s AND qoldiq>0", (dokon_id,),
    )
    return sid, owner_tg, c.fetchone()[0], details


def create_sale(dokon_id, agent_id, items, jami, tolov, foto, nasiya_summa):
    """Save a sale with its detail lines, repeat stats, revisit schedule and
    optional nasiya record — atomically. Returns (sale_id, owner_tg, jami_nasiya_qoldiq).

    items: iterable of (mahsulot_id, miqdor, narx) with miqdor > 0.
    """
    with transaction() as c:
        sid, owner_tg, qoldiq, _ = _insert_sale_core(
            c, dokon_id, agent_id, items, jami, tolov, foto, nasiya_summa)
    return sid, owner_tg, qoldiq


def _integer(value):
    try:
        d = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise VehiclePilotSaleError("Miqdor musbat butun son bo'lishi kerak.")
    if not d.is_finite() or d <= 0 or d != d.to_integral_value():
        raise VehiclePilotSaleError("Miqdor musbat butun son bo'lishi kerak.")
    return int(d)


def _fingerprint(dokon_id, agent_id, items, jami, tolov, foto, nasiya_summa,
                 balance_deduction, payment_values):
    lines = sorted(
        [{"product_id": int(mid), "quantity": _integer(qty),
          "price": str(Decimal(str(price)).normalize()),
          "sum": str((Decimal(str(price)) * _integer(qty)).normalize())}
         for mid, qty, price in items],
        key=lambda x: (x["product_id"], x["price"], x["quantity"]),
    )
    payload = {
        "agent_id": int(agent_id), "customer_id": int(dokon_id), "lines": lines,
        "jami": str(Decimal(str(jami)).normalize()), "payment_type": str(tolov),
        "debt": str(Decimal(str(nasiya_summa)).normalize()),
        "prepayment_used": str(Decimal(str(balance_deduction)).normalize()),
        "payments": {str(k): str(Decimal(str(v)).normalize())
                     for k, v in sorted((payment_values or {}).items())},
        "photo": foto or None,
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _existing(c, operation_key, fingerprint):
    c.execute(
        """SELECT id,dokon_id,status FROM distribution.savdolar
           WHERE operation_key=%s""", (operation_key,))
    row = c.fetchone()
    if not row:
        return None
    c.execute("SELECT operation_fingerprint FROM distribution.savdolar WHERE id=%s", (row[0],))
    if c.fetchone()[0] != fingerprint:
        raise VehiclePilotIdempotencyConflict(
            "Bu savdo kaliti boshqa ma'lumot bilan avval ishlatilgan.")
    if row[2] != "posted":
        raise VehiclePilotIdempotencyConflict(
            "Bu savdo kaliti yakunlanmagan yozuvga tegishli.")
    c.execute("SELECT owner_telegram_id FROM distribution.dokonlar WHERE id=%s", (row[1],))
    owner = c.fetchone()
    c.execute("SELECT COALESCE(SUM(qoldiq),0) FROM distribution.nasiya "
              "WHERE dokon_id=%s AND qoldiq>0", (row[1],))
    return row[0], owner[0] if owner else None, c.fetchone()[0]


def _create_vehicle_pilot_once(dokon_id, agent_id, items, jami, tolov, foto,
                               nasiya_summa, operation_key, fingerprint,
                               balance_deduction):
    with transaction() as c:
        replay = _existing(c, operation_key, fingerprint)
        if replay:
            return replay

        # Exact active pilot identity. No caller-supplied vehicle/warehouse authority.
        c.execute(
            """SELECT da.id,da.telegram_id,v.id,v.warehouse_id
               FROM distribution.delivery_agents da
               JOIN distribution.vehicle_assignments va
                 ON va.delivery_agent_id=da.id AND va.status='active'
               JOIN distribution.vehicles v ON v.id=va.vehicle_id
               WHERE da.faol=1 AND upper(btrim(da.name))='NAVRUZBEK'
                 AND v.plate_number='DM-001' AND v.vehicle_type='DAMAS'
                 AND v.status='active'""")
        pilot = c.fetchall()
        if len(pilot) != 1 or pilot[0][1] != agent_id:
            raise VehiclePilotSaleError(
                "NAVRUZBEK uchun faol DM-001/DAMAS biriktirilishi topilmadi yoki takrorlangan.")
        _, _, vehicle_id, warehouse_id = pilot[0]

        # Shared lock order with F6: parent warehouse first, then inventory rows.
        c.execute(
            """SELECT id FROM public.warehouses
               WHERE id=%s AND name='DM-001 mashina ombori'
                 AND location_type='vehicle' AND purpose='finished' AND active=TRUE
               FOR UPDATE""", (warehouse_id,))
        if c.fetchone() is None:
            raise VehiclePilotSaleError("DM-001 faol mashina ombori mos emas.")
        # A concurrent same-key caller can only pass the first optimistic read
        # before the winner commits. The shared warehouse lock serializes both;
        # re-read here before observing the winner's depleted claims/inventory.
        replay = _existing(c, operation_key, fingerprint)
        if replay:
            return replay

        mapped = []
        for mid, qty_raw, price in items:
            qty = _integer(qty_raw)
            c.execute("SELECT nomi,btrim(COALESCE(sku,'')) FROM distribution.mahsulotlar "
                      "WHERE id=%s AND faol=1", (mid,))
            dist = c.fetchone()
            if not dist or not dist[1]:
                raise VehiclePilotSaleError("Mahsulot SKU bo'sh, faol emas yoki topilmadi.")
            sku = dist[1]
            c.execute(
                """SELECT id,name,sku FROM public.products
                   WHERE sku=%s AND active=TRUE AND in_sales=TRUE""", (sku,))
            products = c.fetchall()
            if len(products) != 1:
                raise VehiclePilotSaleError(
                    "SKU public mahsulotga aniq bitta faol savdo yozuvi sifatida mos kelmadi.")
            mapped.append((mid, qty, price, products[0][0], products[0][1], sku))

        # Lock inventory in stable product-name order after warehouse lock.
        for line in sorted(mapped, key=lambda x: (x[4], x[0])):
            mid, qty, price, public_id, product_name, sku = line
            c.execute(
                """SELECT id,quantity,weight_kg FROM public.inventory
                   WHERE warehouse_id=%s AND product=%s AND product_type='finished'
                   FOR UPDATE""", (warehouse_id, product_name))
            inv = c.fetchone()
            if not inv:
                raise VehiclePilotSaleError("Mashina omborida mahsulot qoldig'i topilmadi.")
            c.execute(
                """SELECT cl.id,cl.handoff_id,cl.handoff_item_id,cl.production_label_id,
                          cl.barcode,cl.unit_weight_kg,ev.id
                   FROM distribution.vehicle_label_claims cl
                   JOIN distribution.vehicle_unit_events ev
                     ON ev.label_claim_id=cl.id AND ev.event_type='load'
                    AND ev.vehicle_id=cl.vehicle_id
                   WHERE cl.vehicle_id=%s AND cl.mahsulot_id=%s AND cl.sku=%s
                     AND cl.status='loaded'
                   ORDER BY cl.id,ev.id FOR UPDATE OF cl,ev""",
                (vehicle_id, mid, sku))
            claims = c.fetchall()
            if len(claims) < qty:
                raise VehiclePilotSaleError("Yuklangan etiketkali dona yetarli emas.")
            selected = claims[:qty]
            if any(Decimal(str(r[5])) <= 0 for r in selected):
                raise VehiclePilotSaleError("Etiketka og'irligi musbat bo'lishi kerak.")
            total_weight = sum((Decimal(str(r[5])) for r in selected), Decimal("0"))
            c.execute(
                """UPDATE public.inventory
                   SET quantity=quantity-%s,weight_kg=weight_kg-%s,updated_at=NOW()
                   WHERE id=%s AND quantity>=%s AND weight_kg>=%s""",
                (qty, total_weight, inv[0], qty, total_weight))
            if c.rowcount != 1:
                raise VehiclePilotSaleError("Mashina qoldig'i yoki og'irligi yetarli emas.")
            line += (selected, total_weight)
            mapped[mapped.index(line[:6])] = line

        if balance_deduction:
            c.execute("SELECT balans FROM distribution.mijoz_balans "
                      "WHERE dokon_id=%s FOR UPDATE", (dokon_id,))
            bal = c.fetchone()
            if not bal or Decimal(str(bal[0])) < Decimal(str(balance_deduction)):
                raise VehiclePilotSaleError("Mijoz avans balansi o'zgargan, qayta urinib ko'ring.")
            update_balans_delta(c, dokon_id, -balance_deduction)

        sid, owner, qoldiq, details = _insert_sale_core(
            c, dokon_id, agent_id, items, jami, tolov, foto, nasiya_summa,
            operation_key, fingerprint, True)
        detail_by_mid = {int(x[1]): x[0] for x in details}
        for mid, qty, price, public_id, product_name, sku, selected, total_weight in mapped:
            detail_id = detail_by_mid[int(mid)]
            reference = "vehicle-sale:%s:detail:%s" % (sid, detail_id)
            c.execute(
                """INSERT INTO public.stock_movements
                   (product,quantity,movement_type,from_warehouse_id,note,created_by,
                    product_type,weight_kg,reference,reason)
                   VALUES (%s,%s,'OUT',%s,%s,%s,'finished',%s,%s,'vehicle_sale')""",
                (product_name, qty, warehouse_id, "DM-001 pilot savdo", str(agent_id),
                 total_weight, reference))
            for seq, claim in enumerate(selected, 1):
                claim_id, handoff_id, handoff_item_id, label_id, barcode, weight, load_event_id = claim
                unit_key = "%s:detail:%s:claim:%s" % (operation_key, detail_id, claim_id)
                c.execute(
                    """INSERT INTO distribution.vehicle_sale_allocations
                       (handoff_id,savdo_id,savdo_tafsilot_id,mahsulot_id,product_name,
                        product_sku,vehicle_id,allocated_quantity,allocated_weight_kg,
                        production_label_id,barcode,source_unit_event_id,label_claim_id,operation_key)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,1,%s,%s,%s,%s,%s,%s)""",
                    (handoff_id, sid, detail_id, mid, product_name, sku, vehicle_id,
                     weight, label_id, barcode, load_event_id, claim_id, unit_key))
                c.execute(
                    """UPDATE distribution.vehicle_label_claims
                       SET status='sold',updated_at=NOW()
                       WHERE id=%s AND status='loaded'""", (claim_id,))
                if c.rowcount != 1:
                    raise VehiclePilotSaleError("Etiketka holati o'zgargan.")
                c.execute(
                    """INSERT INTO distribution.vehicle_unit_events
                       (vehicle_id,handoff_id,handoff_item_id,mahsulot_id,sku,event_type,
                        quantity,actor_id,production_label_id,barcode,operation_key,label_claim_id,notes)
                       VALUES (%s,%s,%s,%s,%s,'sale',-1,%s,%s,%s,%s,%s,%s)""",
                    (vehicle_id, handoff_id, handoff_item_id, mid, sku, agent_id,
                     label_id, barcode, unit_key + ":event", claim_id,
                     "vehicle sale %s detail %s" % (sid, detail_id)))
        return sid, owner, qoldiq


def create_vehicle_pilot_sale(dokon_id, agent_id, items, jami, tolov, foto,
                              nasiya_summa, operation_key, balance_deduction=0,
                              payment_values=None):
    """Create the exact NAVRUZBEK vehicle sale across both schemas atomically."""
    try:
        parsed = uuid.UUID(str(operation_key))
    except (ValueError, TypeError, AttributeError):
        raise VehiclePilotSaleError("Savdo operatsiya kaliti noto'g'ri.")
    operation_key = "vehicle-sale:" + str(parsed)
    raw_items = list(items)
    merged = {}
    order = []
    for mid, qty, price in raw_items:
        mid = int(mid)
        qty = _integer(qty)
        try:
            price = Decimal(str(price))
        except (InvalidOperation, ValueError):
            raise VehiclePilotSaleError("Mahsulot narxi manfiy yoki noto'g'ri.")
        if not price.is_finite() or price < 0:
            raise VehiclePilotSaleError("Mahsulot narxi manfiy yoki noto'g'ri.")
        if mid in merged:
            if merged[mid][1] != price:
                raise VehiclePilotSaleError("Bir mahsulot ikki xil narxda takrorlangan.")
            merged[mid] = (merged[mid][0] + qty, price)
        else:
            order.append(mid)
            merged[mid] = (qty, price)
    items = [(mid, merged[mid][0], merged[mid][1]) for mid in order]
    if not items:
        raise VehiclePilotSaleError("Savdoda mahsulot yo'q.")
    expected_total = sum((Decimal(qty) * price for _, qty, price in items), Decimal("0"))
    try:
        declared_total = Decimal(str(jami))
        debt = Decimal(str(nasiya_summa))
        prepayment = Decimal(str(balance_deduction))
    except (InvalidOperation, ValueError):
        raise VehiclePilotSaleError("Savdo to'lov summasi noto'g'ri.")
    if (not declared_total.is_finite() or declared_total != expected_total or
            not debt.is_finite() or debt < 0 or not prepayment.is_finite() or
            prepayment < 0):
        raise VehiclePilotSaleError("Savdo jami yoki to'lov summasi qatorlarga mos emas.")
    fingerprint = _fingerprint(
        dokon_id, agent_id, items, jami, tolov, foto, nasiya_summa,
        balance_deduction, payment_values)
    try:
        return _create_vehicle_pilot_once(
            dokon_id, agent_id, items, jami, tolov, foto, nasiya_summa,
            operation_key, fingerprint, balance_deduction)
    except psycopg2.IntegrityError:
        # A concurrent same-key transaction may have won. The failed transaction
        # has rolled back; re-read in a clean transaction and apply fingerprint rules.
        with transaction() as c:
            replay = _existing(c, operation_key, fingerprint)
            if replay:
                return replay
        raise
