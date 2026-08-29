"""Sale creation — one all-or-nothing transaction."""

import hashlib
import json
import os
import uuid
import logging
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation

import psycopg2

from .connection import transaction
from .customers import update_dokon_repeat, update_balans_delta
from .replenishment_delivery import configured_recipient_ids

log = logging.getLogger("distribution.sales")


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


def is_vehicle_pilot_seller(telegram_id):
    """Yo'naltirish (dispatch) identiteti: True faqat shu telegram_id faol
    NAVRUZBEK delivery-agentiga tegishli bo'lib, unga faol DM-001/DAMAS
    biriktirilgan bo'lsa.

    MUHIM: yo'naltirish hech qachon distribution.users.name imlosiga
    tayanmaydi — prodda users jadvalida "Navro'zbek" (apostrof bilan),
    delivery_agents da esa "Navruzbek" yozilgan; ism solishtirish haqiqiy
    pilot savdosini jimgina oddiy yo'lga o'tkazib yuborar edi. Identitet
    manbai _create_vehicle_pilot_once ichidagi tranzaksion guard bilan bir
    xil zanjir. Takrorlangan konfiguratsiyada ham True — ichki guard aniq
    xato bilan to'xtatadi (jim chetlab o'tish yo'q).
    """
    if telegram_id is None:
        return False
    with transaction() as c:
        c.execute(
            """SELECT da.telegram_id
                 FROM distribution.delivery_agents da
                 JOIN distribution.vehicle_assignments va
                   ON va.delivery_agent_id=da.id AND va.status='active'
                 JOIN distribution.vehicles v ON v.id=va.vehicle_id
                WHERE da.faol=1 AND upper(btrim(da.name))='NAVRUZBEK'
                  AND v.plate_number='DM-001' AND v.vehicle_type='DAMAS'
                  AND v.status='active'""")
        rows = c.fetchall()
    return any(r[0] == telegram_id for r in rows)


def create_sale(dokon_id, agent_id, items, jami, tolov, foto, nasiya_summa):
    """Save a sale with its detail lines, repeat stats, revisit schedule and
    optional nasiya record — atomically. Returns (sale_id, owner_tg, jami_nasiya_qoldiq).

    items: iterable of (mahsulot_id, miqdor, narx) with miqdor > 0.
    """
    with transaction() as c:
        sid, owner_tg, qoldiq, _ = _insert_sale_core(
            c, dokon_id, agent_id, items, jami, tolov, foto, nasiya_summa)
    return sid, owner_tg, qoldiq


def _positive_quantity(value):
    """Musbat, chekli, ko'pi bilan 3 xona kasrli miqdor (Decimal).

    Dona/kg farqini bilmaydi: butunlik talabi birlik ma'lum bo'lgan joyda
    (_create_vehicle_pilot_once) qo'yiladi — kg mahsulotlar kasr sotiladi
    (masalan 5.7 kg), dona mahsulotlar esa faqat butun son.
    """
    try:
        d = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise VehiclePilotSaleError("Miqdor musbat son bo'lishi kerak.")
    if not d.is_finite() or d <= 0:
        raise VehiclePilotSaleError("Miqdor musbat son bo'lishi kerak.")
    try:
        if d != d.quantize(Decimal("0.001")):
            raise VehiclePilotSaleError(
                "Miqdor ko'pi bilan 3 xona kasr bo'lishi mumkin.")
    except InvalidOperation:
        raise VehiclePilotSaleError("Miqdor juda katta.")
    return d


def _fingerprint(dokon_id, agent_id, items, jami, tolov, foto, nasiya_summa,
                 balance_deduction, payment_values):
    def _qty_key(value):
        d = _positive_quantity(value)
        # Butun miqdor eski (int) ko'rinishda qoladi — mavjud dona
        # savdolarining fingerprintlari o'zgarmasligi shart.
        return int(d) if d == d.to_integral_value() else str(d.normalize())

    lines = sorted(
        [{"product_id": int(mid), "quantity": _qty_key(qty),
          "price": str(Decimal(str(price)).normalize()),
          "sum": str((Decimal(str(price)) * _positive_quantity(qty)).normalize())}
         for mid, qty, price in items],
        key=lambda x: (x["product_id"], x["price"], str(x["quantity"])),
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


def _create_auto_replenishment_request(c, *, sale_id, detail_id, agent_id,
                                       vehicle_id, mahsulot_id, public_product_id,
                                       product_name, sku, current_quantity):
    """Create F8's low-stock request inside the already-locked F7 sale tx.

    The caller holds the vehicle warehouse parent and inventory row locks.  Do
    not add a later advisory lock here: the open-request partial unique index is
    the concurrency arbiter and an equivalent winner must not fail the sale.
    """
    c.execute(
        """SELECT id,target_quantity,min_quantity
             FROM distribution.vehicle_stock_targets
            WHERE vehicle_id=%s AND public_product_id=%s
              AND effective_from<=CURRENT_DATE
              AND (effective_to IS NULL OR effective_to>=CURRENT_DATE)
            ORDER BY effective_from DESC,id DESC
            LIMIT 1""",
        (vehicle_id, public_product_id),
    )
    target = c.fetchone()
    if not target:
        return

    target_id, target_quantity, min_quantity = target
    current = Decimal(str(current_quantity))
    target_qty = Decimal(str(target_quantity))
    minimum = Decimal(str(min_quantity))
    if current > minimum:
        return
    deficit = target_qty - current
    if deficit <= 0:
        return
    if (target_qty != target_qty.to_integral_value()
            or minimum != minimum.to_integral_value()
            or current != current.to_integral_value()
            or deficit != deficit.to_integral_value()):
        raise VehiclePilotSaleError(
            "Pilot label stock and replenishment targets must be whole units.")

    operation_key = (
        "vehicle-replenishment:auto:sale:%s:detail:%s:product:%s"
        % (sale_id, detail_id, public_product_id)
    )
    fingerprint_payload = {
        "current_quantity": str(current.normalize()),
        "detail_id": int(detail_id),
        "mahsulot_id": int(mahsulot_id),
        "product_name": str(product_name),
        "public_product_id": int(public_product_id),
        "requested_quantity": str(deficit.normalize()),
        "sale_id": int(sale_id),
        "sku": str(sku),
        "target_id": int(target_id),
        "target_quantity": str(target_qty.normalize()),
        "vehicle_id": int(vehicle_id),
    }
    request_fingerprint = hashlib.sha256(
        json.dumps(
            fingerprint_payload, sort_keys=True, separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()
    c.execute(
        """INSERT INTO distribution.vehicle_replenishment_requests
             (vehicle_id,requested_by,mahsulot_id,public_product_id,product_name,sku,
              requested_quantity,status,operation_key,request_fingerprint,
              target_quantity_snapshot,current_quantity_snapshot,requested_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,'pending',%s,%s,%s,%s,NOW())
           ON CONFLICT (vehicle_id,public_product_id)
             WHERE status IN ('pending','approved')
           DO NOTHING
           RETURNING id""",
        (
            vehicle_id, agent_id, mahsulot_id, public_product_id, product_name,
            sku, deficit, operation_key, request_fingerprint, target_qty, current,
        ),
    )
    inserted = c.fetchone()
    if inserted:
        request_id = inserted[0]
    else:
        c.execute(
            """SELECT id FROM distribution.vehicle_replenishment_requests
               WHERE vehicle_id=%s AND public_product_id=%s
                 AND status IN ('pending','approved')""",
            (vehicle_id, public_product_id),
        )
        winner = c.fetchone()
        if not winner:
            return
        request_id = winner[0]
    try:
        recipients = configured_recipient_ids()
    except ValueError as exc:
        log.error("Vehicle replenishment Telegram config rejected: %s", exc)
        recipients = ()
    for recipient_id in recipients:
        c.execute(
            """INSERT INTO distribution.vehicle_replenishment_outbox
                 (request_id,recipient_chat_id)
               VALUES (%s,%s)
               ON CONFLICT (request_id,recipient_chat_id) DO NOTHING""",
            (request_id, recipient_id),
        )


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
            qty = _positive_quantity(qty_raw)
            c.execute("SELECT nomi,btrim(COALESCE(sku,'')),"
                      "lower(btrim(COALESCE(NULLIF(birlik,''),'dona'))) "
                      "FROM distribution.mahsulotlar WHERE id=%s AND faol=1", (mid,))
            dist = c.fetchone()
            if not dist:
                raise VehiclePilotSaleError("Mahsulot SKU bo'sh, faol emas yoki topilmadi.")
            if dist[2] != "dona":
                # kg (yoki boshqa o'lchov) mahsulot mashinaga yuklanmaydi:
                # yuklash (F6) faqat dona-etiketka orqali bo'ladi. Bunday qator
                # mashina zaxirasi/etiketka intizomiga tegmasdan oddiy savdo
                # sifatida yoziladi (savdo_tafsilotda qoladi, stock_movements,
                # allokatsiya va replenishment ochilmaydi).
                continue
            if qty != qty.to_integral_value():
                raise VehiclePilotSaleError(
                    "Dona mahsulot miqdori musbat butun son bo'lishi kerak.")
            qty = int(qty)
            if not dist[1]:
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
                           cl.barcode,cl.unit_weight_kg,cl.pieces_in_label,
                           cl.remaining_quantity,ev.id
                   FROM distribution.vehicle_label_claims cl
                   JOIN distribution.vehicle_unit_events ev
                     ON ev.label_claim_id=cl.id AND ev.event_type='load'
                    AND ev.vehicle_id=cl.vehicle_id
                   WHERE cl.vehicle_id=%s AND cl.mahsulot_id=%s AND cl.sku=%s
                      AND cl.status='loaded' AND cl.remaining_quantity>0
                    ORDER BY ev.event_at,ev.id,cl.id FOR UPDATE OF cl,ev""",
                (vehicle_id, mid, sku))
            claims = c.fetchall()
            selected = []
            remaining_to_allocate = Decimal(qty)
            for claim in claims:
                unit_weight = Decimal(str(claim[5]))
                claim_pieces = Decimal(str(claim[6]))
                claim_remaining = Decimal(str(claim[7]))
                if (unit_weight <= 0 or claim_pieces <= 0 or claim_remaining <= 0
                        or claim_remaining > claim_pieces
                        or claim_remaining != claim_remaining.to_integral_value()):
                    raise VehiclePilotSaleError("Yuklangan etiketka dona yoki og'irligi noto'g'ri.")
                allocated = min(remaining_to_allocate, claim_remaining)
                selected.append((claim, allocated, unit_weight * allocated))
                remaining_to_allocate -= allocated
                if remaining_to_allocate == 0:
                    break
            if remaining_to_allocate != 0:
                raise VehiclePilotSaleError("Yuklangan etiketkali dona yetarli emas.")
            total_weight = sum((allocation[2] for allocation in selected), Decimal("0"))
            c.execute(
                """UPDATE public.inventory
                   SET quantity=quantity-%s,weight_kg=weight_kg-%s,updated_at=NOW()
                   WHERE id=%s AND quantity>=%s AND weight_kg>=%s""",
                (qty, total_weight, inv[0], qty, total_weight))
            if c.rowcount != 1:
                raise VehiclePilotSaleError("Mashina qoldig'i yoki og'irligi yetarli emas.")
            post_sale_quantity = Decimal(str(inv[1])) - Decimal(qty)
            line += (selected, total_weight, post_sale_quantity)
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
        for (mid, qty, price, public_id, product_name, sku, selected,
             total_weight, post_sale_quantity) in mapped:
            detail_id = detail_by_mid[int(mid)]
            reference = "vehicle-sale:%s:detail:%s" % (sid, detail_id)
            c.execute(
                """INSERT INTO public.stock_movements
                   (product,quantity,movement_type,from_warehouse_id,note,created_by,
                    product_type,weight_kg,reference,reason)
                   VALUES (%s,%s,'OUT',%s,%s,%s,'finished',%s,%s,'vehicle_sale')""",
                (product_name, qty, warehouse_id, "DM-001 pilot savdo", str(agent_id),
                 total_weight, reference))
            for claim, allocated_quantity, allocated_weight in selected:
                (claim_id, handoff_id, handoff_item_id, label_id, barcode, _unit_weight,
                 _pieces_in_label, _remaining_quantity, load_event_id) = claim
                unit_key = "%s:detail:%s:claim:%s" % (operation_key, detail_id, claim_id)
                c.execute(
                    """INSERT INTO distribution.vehicle_sale_allocations
                       (handoff_id,savdo_id,savdo_tafsilot_id,mahsulot_id,product_name,
                        product_sku,vehicle_id,allocated_quantity,allocated_weight_kg,
                        production_label_id,barcode,source_unit_event_id,label_claim_id,operation_key)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (handoff_id, sid, detail_id, mid, product_name, sku, vehicle_id,
                     allocated_quantity, allocated_weight, label_id, barcode,
                     load_event_id, claim_id, unit_key))
                c.execute(
                    """UPDATE distribution.vehicle_label_claims
                        SET remaining_quantity=remaining_quantity-%s,
                            status=CASE WHEN remaining_quantity-%s=0 THEN 'sold'
                                        ELSE 'loaded' END,
                            updated_at=NOW()
                        WHERE id=%s AND status='loaded' AND remaining_quantity>=%s""",
                    (allocated_quantity, allocated_quantity, claim_id, allocated_quantity))
                if c.rowcount != 1:
                    raise VehiclePilotSaleError("Etiketka holati o'zgargan.")
                c.execute(
                    """INSERT INTO distribution.vehicle_unit_events
                       (vehicle_id,handoff_id,handoff_item_id,mahsulot_id,sku,event_type,
                        quantity,actor_id,production_label_id,barcode,operation_key,label_claim_id,notes)
                        VALUES (%s,%s,%s,%s,%s,'sale',%s,%s,%s,%s,%s,%s,%s)""",
                    (vehicle_id, handoff_id, handoff_item_id, mid, sku, -allocated_quantity,
                     agent_id, label_id, barcode, unit_key + ":event", claim_id,
                     "vehicle sale %s detail %s" % (sid, detail_id)))
            _create_auto_replenishment_request(
                c,
                sale_id=sid,
                detail_id=detail_id,
                agent_id=agent_id,
                vehicle_id=vehicle_id,
                mahsulot_id=mid,
                public_product_id=public_id,
                product_name=product_name,
                sku=sku,
                current_quantity=post_sale_quantity,
            )
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
        qty = _positive_quantity(qty)
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
    if (not declared_total.is_finite() or not debt.is_finite() or debt < 0 or
            not prepayment.is_finite() or prepayment < 0):
        raise VehiclePilotSaleError("Savdo jami yoki to'lov summasi qatorlarga mos emas.")
    # Deklaratsiya qilingan jami 0.001 to'rida YOTISHI va qatorlar yig'indisiga
    # AYNAN teng bo'lishi shart. Ikkala tomonni kvantlab solishtirish mumkin
    # emas: u ±0.0005 gacha boshqa jami (masalan 1.4996 vs 1.500) o'tkazib,
    # BIGINT yumaloqlashida sarlavha/qator summalarini ajratib yuborar edi.
    # Bot jami'ni round(...,3) bilan yuboradi — halol payload doim to'rda.
    try:
        on_grid = declared_total == declared_total.quantize(Decimal("0.001"))
    except InvalidOperation:
        on_grid = False
    if not on_grid or declared_total != expected_total:
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
