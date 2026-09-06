"""F11 route-end DB tests: qamrov, kunlik raqamlar, bir-marta marker, avto so'rov.

Safety contract (sale_f7 bilan bir xil): faqat loopback
VEHICLE_TEST_DATABASE_ADMIN_URL ostida child baza ochadi. MUHIM FARQ:
DATABASE_URL modul importida EMAS, setUpClass'da almashtiriladi va
tearDownClass'da tiklanadi — aks holda birlashgan discovery'da boshqa DB-modul
(masalan sale_f7) child bazalari chalkashib ketadi.
"""

import os
import unittest
import uuid
from unittest.mock import patch  # noqa: F401  (kept for parity/debugging)
from urllib.parse import urlparse, urlunparse

import psycopg2

ADMIN_URL = os.environ.get("VEHICLE_TEST_DATABASE_ADMIN_URL", "").strip()
if not ADMIN_URL:
    raise RuntimeError("VEHICLE_TEST_DATABASE_ADMIN_URL is required")
_parsed = urlparse(ADMIN_URL)
if _parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
    raise RuntimeError("VEHICLE_TEST_DATABASE_ADMIN_URL must use a loopback host")
DB_NAME = "dist_f11r_py_%s_%s" % (os.getpid(), uuid.uuid4().hex[:8])
CHILD_URL = urlunparse(_parsed._replace(path="/" + DB_NAME))

os.environ.pop("RAILWAY_DATABASE_URL", None)
if not os.environ.get("DATABASE_URL"):
    raise RuntimeError("DATABASE_URL must be an isolated test child DB URL")
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "123456:LOCAL_F11_TEST")
os.environ["VEHICLE_REPLENISHMENT_TELEGRAM_CHAT_IDS"] = "900001"

from database import connection as connmod  # noqa: E402
from database.connection import close_pool, init_db  # noqa: E402
from database import vehicle_fill as vfill  # noqa: E402


PUBLIC_DDL = """
CREATE TABLE IF NOT EXISTS public.products (
 id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, sku TEXT NOT NULL,
 active BOOLEAN NOT NULL DEFAULT TRUE, in_sales BOOLEAN NOT NULL DEFAULT FALSE,
 pieces_per_box INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku_unique ON public.products(sku) WHERE sku<>'';
CREATE TABLE IF NOT EXISTS public.warehouses (
 id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, active BOOLEAN NOT NULL DEFAULT TRUE,
 location_type TEXT NOT NULL DEFAULT 'general', capacity_kg NUMERIC DEFAULT 20000,
 purpose TEXT NOT NULL DEFAULT 'finished', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.inventory (
 id SERIAL PRIMARY KEY, warehouse_id INTEGER NOT NULL REFERENCES public.warehouses(id),
 product TEXT NOT NULL, quantity NUMERIC NOT NULL DEFAULT 0,
 weight_kg NUMERIC NOT NULL DEFAULT 0, product_type TEXT NOT NULL DEFAULT 'finished',
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(warehouse_id,product)
);
"""


def _admin():
    c = psycopg2.connect(ADMIN_URL)
    c.autocommit = True
    return c


def _db():
    return psycopg2.connect(CHILD_URL)


class VehicleRouteReportF11(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        admin = _admin()
        try:
            with admin.cursor() as cur:
                cur.execute("CREATE DATABASE %s" % DB_NAME)
        finally:
            admin.close()
        cls._prev_db_url = os.environ.get("DATABASE_URL")
        os.environ["DATABASE_URL"] = CHILD_URL
        cls._prev_dburl_attr = connmod.DB_URL
        connmod.DB_URL = CHILD_URL  # DB_URL importda muzlaydi — attr patch shart
        cls._prev_vapproved = connmod._VEHICLE_APPROVED
        connmod._VEHICLE_APPROVED = True  # vehicle DDL flagi ham importda muzlaydi
        close_pool()
        init_db()
        with _db() as conn, conn.cursor() as cur:
            cur.execute(PUBLIC_DDL)

    @classmethod
    def tearDownClass(cls):
        close_pool()
        connmod.DB_URL = cls._prev_dburl_attr
        connmod._VEHICLE_APPROVED = cls._prev_vapproved
        if cls._prev_db_url is not None:
            os.environ["DATABASE_URL"] = cls._prev_db_url
        admin = _admin()
        try:
            with admin.cursor() as cur:
                cur.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname=%s AND pid<>pg_backend_pid()", (DB_NAME,))
                cur.execute("DROP DATABASE IF EXISTS %s" % DB_NAME)
        finally:
            admin.close()

    def setUp(self):
        close_pool()
        self.today = vfill.today_str()
        with _db() as conn, conn.cursor() as c:
            c.execute("""
              TRUNCATE distribution.topmart_config,
                distribution.vehicle_route_reports,
                distribution.vehicle_sale_allocations,
                distribution.vehicle_replenishment_outbox,
                distribution.vehicle_replenishment_requests,
                distribution.vehicle_stock_targets,
                distribution.vehicle_handoff_items,distribution.vehicle_handoffs,
                distribution.vehicle_assignments,distribution.vehicles,
                distribution.delivery_agents,distribution.delivery_routes,
                distribution.olmagan_dokonlar,distribution.savdolar,
                distribution.mahsulotlar,distribution.dokonlar,
                public.inventory,public.warehouses,public.products
              RESTART IDENTITY CASCADE
            """)
            c.execute("INSERT INTO distribution.delivery_agents(name,telegram_id,faol) "
                      "VALUES('NAVRUZBEK',700,1) RETURNING id")
            self.da = c.fetchone()[0]
            c.execute("INSERT INTO public.warehouses(name,active,location_type,purpose) "
                      "VALUES('DM-001 mashina ombori',TRUE,'vehicle','finished') RETURNING id")
            self.vwh = c.fetchone()[0]
            c.execute("INSERT INTO public.warehouses(name,active,location_type,purpose) "
                      "VALUES('Tayyor ombor',TRUE,'general','finished') RETURNING id")
            self.swh = c.fetchone()[0]
            c.execute("INSERT INTO distribution.vehicles(plate_number,vehicle_type,status,warehouse_id) "
                      "VALUES('DM-001','DAMAS','active',%s) RETURNING id", (self.vwh,))
            self.veh = c.fetchone()[0]
            c.execute("INSERT INTO distribution.vehicle_assignments(vehicle_id,delivery_agent_id,status) "
                      "VALUES(%s,%s,'active')", (self.veh, self.da))
            c.execute("INSERT INTO distribution.mahsulotlar(nomi,narx,faol,sku) "
                      "VALUES('Arqon 10m',12000,1,'SKU-A') RETURNING id")
            self.mA = c.fetchone()[0]
            c.execute("INSERT INTO distribution.mahsulotlar(nomi,narx,faol,sku) "
                      "VALUES('Ip 5mm',5000,1,'SKU-B') RETURNING id")
            self.mB = c.fetchone()[0]
            c.execute("INSERT INTO public.products(name,sku,active,pieces_per_box) "
                      "VALUES('Arqon 10m','SKU-A',TRUE,24) RETURNING id")
            self.pA = c.fetchone()[0]
            c.execute("INSERT INTO public.products(name,sku,active,pieces_per_box) "
                      "VALUES('Ip 5mm','SKU-B',TRUE,10) RETURNING id")
            self.pB = c.fetchone()[0]

    # ── helpers ──────────────────────────────────────────────────────────────
    def _shop(self, c, nomi, holat="faol"):
        c.execute("INSERT INTO distribution.dokonlar(nomi,agent_id,holat) "
                  "VALUES(%s,700,%s) RETURNING id", (nomi, holat))
        return c.fetchone()[0]

    def _route(self, c, dokon_id, kun=1):
        c.execute("INSERT INTO distribution.delivery_routes(delivery_agent_id,kun,dokon_id) "
                  "VALUES(%s,%s,%s)", (self.da, kun, dokon_id))

    def _savdo(self, c, dokon_id, agent_id=700, status="active", when=None):
        c.execute("INSERT INTO distribution.savdolar(dokon_id,agent_id,jami_summa,status,created_at) "
                  "VALUES(%s,%s,200,%s,%s) RETURNING id",
                  (dokon_id, agent_id, status, when or (self.today + "T10:00:00")))
        return c.fetchone()[0]

    def _stock(self, c, wh, name, qty):
        c.execute("INSERT INTO public.inventory(warehouse_id,product,quantity,weight_kg) "
                  "VALUES(%s,%s,%s,1) "
                  "ON CONFLICT (warehouse_id,product) DO UPDATE SET quantity=EXCLUDED.quantity",
                  (wh, name, qty))

    def _target(self, c, mid, pid, name, sku, target, minimum, eff_offset_days=0,
                closed=False):
        # closed=True — almashtirilgan eski target: partial unique indeks
        # (vehicle_id, public_product_id) WHERE effective_to IS NULL faqat
        # bitta OCHIQ targetga ruxsat beradi.
        c.execute("INSERT INTO distribution.vehicle_stock_targets"
                  "(vehicle_id,mahsulot_id,public_product_id,product_name,sku,"
                  " target_quantity,min_quantity,effective_from,effective_to) "
                  "VALUES(%s,%s,%s,%s,%s,%s,%s,CURRENT_DATE + %s,"
                  " CASE WHEN %s THEN CURRENT_DATE END)",
                  (self.veh, mid, pid, name, sku, target, minimum, eff_offset_days,
                   closed))

    # ── route_end_status ─────────────────────────────────────────────────────
    def test_route_end_status_counts_only_today_active_own_coverage(self):
        with _db() as conn, conn.cursor() as c:
            s1 = self._shop(c, "Dokon 1")
            s2 = self._shop(c, "Dokon 2")
            s3 = self._shop(c, "Dokon 3")
            s4 = self._shop(c, "Yopiq dokon", holat="yopiq")
            s5 = self._shop(c, "Boshqa kun dokoni")
            for s in (s1, s2, s3, s4):
                self._route(c, s, kun=1)
            self._route(c, s5, kun=2)  # boshqa kun — hisobga kirmaydi
            self._savdo(c, s1)                                   # savdo bilan qamrov
            c.execute("INSERT INTO distribution.olmagan_dokonlar(dokon_id,agent_id,sabab,created_at) "
                      "VALUES(%s,700,'pul_yoq',%s)", (s2, self.today + "T11:00:00"))
            # s3: kechagi savdo, bekor qilingan savdo, boshqa agent savdosi —
            # hech biri qamrov EMAS.
            self._savdo(c, s3, when="2026-08-29T18:00:00")
            self._savdo(c, s3, status="cancelled")
            self._savdo(c, s3, agent_id=701)
        self.assertEqual(vfill.route_end_status(self.da, 700, 1, self.today), (3, 2))
        with _db() as conn, conn.cursor() as c:
            self._savdo(c, s3)
        self.assertEqual(vfill.route_end_status(self.da, 700, 1, self.today), (3, 3))

    def test_route_end_status_empty_route(self):
        self.assertEqual(vfill.route_end_status(self.da, 700, 1, self.today), (0, 0))

    # ── vehicle_day_numbers ──────────────────────────────────────────────────
    def test_vehicle_day_numbers_full_outer_join_sold_and_remaining(self):
        with _db() as conn, conn.cursor() as c:
            shop = self._shop(c, "Dokon")
            self._stock(c, self.vwh, "Arqon 10m", 8)   # qoldiq bor, sotuv ham
            c.execute("""INSERT INTO distribution.vehicle_handoffs
                       (vehicle_id,delivery_agent_id,source_warehouse_id,vehicle_warehouse_id,
                        handoff_date,status) VALUES(%s,%s,%s,%s,CURRENT_DATE,'stock_transferred')
                       RETURNING id""", (self.veh, self.da, self.swh, self.vwh))
            h = c.fetchone()[0]
            ok_sale = self._savdo(c, shop)
            cancelled_sale = self._savdo(c, shop, status="cancelled")
            old_sale = self._savdo(c, shop, when="2026-08-29T09:00:00")

            def alloc(savdo_id, mid, name, sku, qty, tafsilot):
                c.execute("""INSERT INTO distribution.vehicle_sale_allocations
                           (handoff_id,savdo_id,savdo_tafsilot_id,mahsulot_id,product_name,
                            product_sku,vehicle_id,allocated_quantity,allocated_weight_kg,
                            operation_key)
                           VALUES(%s,%s,%s,%s,%s,%s,%s,%s,0.5,%s)""",
                          (h, savdo_id, tafsilot, mid, name, sku, self.veh, qty,
                           "k-%s" % tafsilot))

            alloc(ok_sale, self.mA, "Arqon 10m", "SKU-A", 2, 1)
            alloc(ok_sale, self.mB, "Ip 5mm", "SKU-B", 3, 2)     # sotildi, qoldiq yo'q
            alloc(cancelled_sale, self.mA, "Arqon 10m", "SKU-A", 99, 3)  # bekor — kirmasin
            alloc(old_sale, self.mA, "Arqon 10m", "SKU-A", 77, 4)        # kecha — kirmasin
        rows = {r["mahsulot_id"]: r
                for r in vfill.vehicle_day_numbers(self.vwh, self.veh, self.today)}
        self.assertEqual(rows[self.mA]["sold"], 2)
        self.assertEqual(rows[self.mA]["remaining"], 8)
        self.assertEqual(rows[self.mB]["sold"], 3)
        self.assertEqual(rows[self.mB]["remaining"], 0)
        self.assertTrue(all(isinstance(r["sold"], int) and isinstance(r["remaining"], int)
                            for r in rows.values()))

    # ── try_insert_route_report ──────────────────────────────────────────────
    def test_route_report_marker_wins_exactly_once_per_day(self):
        self.assertTrue(vfill.try_insert_route_report(
            self.veh, self.today, self.da, 700, '{"x":1}'))
        self.assertFalse(vfill.try_insert_route_report(
            self.veh, self.today, self.da, 700, '{"x":2}'))
        self.assertTrue(vfill.try_insert_route_report(
            self.veh, "2026-08-29", self.da, 700, '{"x":3}'))
        with _db() as conn, conn.cursor() as c:
            c.execute("SELECT COUNT(*), MIN(payload) FROM distribution.vehicle_route_reports "
                      "WHERE vehicle_id=%s AND route_date=%s::date", (self.veh, self.today))
            n, payload = c.fetchone()
        self.assertEqual(n, 1)
        self.assertEqual(payload, '{"x":1}')  # ikkinchi urinish yozmagan

    # ── route_end_replenishment ──────────────────────────────────────────────
    def test_replenishment_creates_pending_request_with_outbox_once(self):
        with _db() as conn, conn.cursor() as c:
            self._target(c, self.mA, self.pA, "Arqon 10m", "SKU-A", 50, 20)
            self._target(c, self.mB, self.pB, "Ip 5mm", "SKU-B", 10, 3)
            self._stock(c, self.vwh, "Arqon 10m", 5)   # 5 <= 20 → deficit 45
            self._stock(c, self.vwh, "Ip 5mm", 7)      # 7 > 3  → so'rov yo'q
        created = vfill.route_end_replenishment(self.veh, 700, self.vwh, self.today)
        self.assertEqual(created, [("Arqon 10m", 45)])
        with _db() as conn, conn.cursor() as c:
            c.execute("""SELECT status, requested_quantity, operation_key,
                                current_quantity_snapshot, target_quantity_snapshot
                           FROM distribution.vehicle_replenishment_requests""")
            reqs = c.fetchall()
            self.assertEqual(len(reqs), 1)
            status, qty, opkey, cur, target = reqs[0]
            self.assertEqual(status, "pending")
            self.assertEqual(int(qty), 45)
            self.assertEqual(
                opkey,
                "vehicle-replenishment:auto:route-end:%s:product:%s:date:%s"
                % (self.veh, self.pA, self.today))
            self.assertEqual(int(cur), 5)
            self.assertEqual(int(target), 50)
            c.execute("SELECT recipient_chat_id FROM distribution.vehicle_replenishment_outbox")
            self.assertEqual([int(r[0]) for r in c.fetchall()], [900001])
        # Ikkinchi chaqiriq — ochiq so'rov dedupi: yangi hech narsa ochilmaydi.
        self.assertEqual(
            vfill.route_end_replenishment(self.veh, 700, self.vwh, self.today), [])
        with _db() as conn, conn.cursor() as c:
            c.execute("SELECT COUNT(*) FROM distribution.vehicle_replenishment_requests")
            self.assertEqual(c.fetchone()[0], 1)

    def test_finalize_atomic_marker_rolls_back_with_replenishment(self):
        with _db() as conn, conn.cursor() as c:
            self._target(c, self.mA, self.pA, "Arqon 10m", "SKU-A", 50, 20)
            self._stock(c, self.vwh, "Arqon 10m", 5)
            c.execute("SELECT id FROM distribution.delivery_agents LIMIT 1")
            da_id = c.fetchone()[0]
        # 1) Transient xato: configured_recipient_ids RuntimeError beradi
        #    (ValueError EMAS — ichkarida yutilmaydi) -> marker HAM bekor.
        with patch.object(vfill, "configured_recipient_ids",
                          side_effect=RuntimeError("tg config down")):
            with self.assertRaises(RuntimeError):
                vfill.try_route_end_finalize(self.veh, self.today, da_id,
                                             700, "{}", 700, self.vwh)
        with _db() as conn, conn.cursor() as c:
            c.execute("SELECT COUNT(*) FROM distribution.vehicle_route_reports")
            self.assertEqual(c.fetchone()[0], 0)  # marker yo'q — retry ochiq
            c.execute("SELECT COUNT(*) FROM distribution.vehicle_replenishment_requests")
            self.assertEqual(c.fetchone()[0], 0)
        # 2) Qayta urinish — marker + so'rov + outbox BIRGA yoziladi.
        won, created = vfill.try_route_end_finalize(self.veh, self.today, da_id,
                                                    700, "{}", 700, self.vwh)
        self.assertTrue(won)
        self.assertEqual(created, [("Arqon 10m", 45)])
        with _db() as conn, conn.cursor() as c:
            c.execute("SELECT COUNT(*) FROM distribution.vehicle_route_reports")
            self.assertEqual(c.fetchone()[0], 1)
            c.execute("SELECT status FROM distribution.vehicle_replenishment_requests")
            self.assertEqual(c.fetchall(), [("pending",)])
            c.execute("SELECT recipient_chat_id "
                      "FROM distribution.vehicle_replenishment_outbox")
            self.assertEqual(c.fetchall(), [(900001,)])
        # 3) Marker band: (False, []).
        self.assertEqual(
            vfill.try_route_end_finalize(self.veh, self.today, da_id,
                                         700, "{}", 700, self.vwh),
            (False, []))

    def test_replenishment_uses_latest_effective_target(self):
        with _db() as conn, conn.cursor() as c:
            self._target(c, self.mA, self.pA, "Arqon 10m", "SKU-A", 50, 20,
                         eff_offset_days=-5, closed=True)
            self._target(c, self.mA, self.pA, "Arqon 10m", "SKU-A", 60, 20)
            self._stock(c, self.vwh, "Arqon 10m", 5)
        created = vfill.route_end_replenishment(self.veh, 700, self.vwh, self.today)
        self.assertEqual(created, [("Arqon 10m", 55)])  # 60 - 5, eski 50 emas

    def test_replenishment_skips_fractional_current_stock(self):
        with _db() as conn, conn.cursor() as c:
            self._target(c, self.mA, self.pA, "Arqon 10m", "SKU-A", 50, 20)
            self._stock(c, self.vwh, "Arqon 10m", "5.5")
        self.assertEqual(
            vfill.route_end_replenishment(self.veh, 700, self.vwh, self.today), [])
        with _db() as conn, conn.cursor() as c:
            c.execute("SELECT COUNT(*) FROM distribution.vehicle_replenishment_requests")
            self.assertEqual(c.fetchone()[0], 0)

    # ── wizard manba ro'yxatlari (real DB, SKU-yagonalik sharti) ────────────
    def test_fill_sources_uses_only_configured_central_warehouse(self):
        with _db() as conn, conn.cursor() as c:
            self._stock(c, self.swh, "Arqon 10m", 40)
            c.execute(
                "INSERT INTO distribution.topmart_config"
                "(id,customer_id,central_warehouse_id) VALUES(1,700,%s)",
                (self.swh,),
            )
            # Bu ham yuklashga yaroqli, ammo konfiguratsiyada emas — F11
            # hech qachon ixtiyoriy omborlar ro'yxatini qaytarmaydi.
            c.execute("INSERT INTO public.warehouses(name,active,location_type,purpose) "
                      "VALUES('Boshqa tayyor ombor',TRUE,'general','finished') "
                      "RETURNING id")
            other_wh = c.fetchone()[0]
            self._stock(c, other_wh, "Arqon 10m", 40)
            # SKU dublikat: ikkinchi faol mahsulotlar yozuvi — guard yiqitadi.
            c.execute("INSERT INTO distribution.mahsulotlar(nomi,narx,faol,sku) "
                      "VALUES('Ip 5mm (dubl)',5100,1,'SKU-B')")
            self._stock(c, self.swh, "Ip 5mm", 15)
        whs = vfill.fill_source_warehouses()
        self.assertEqual([w["id"] for w in whs], [self.swh])
        prods = vfill.fill_products(self.swh)
        self.assertEqual([p["mahsulot_id"] for p in prods], [self.mA])
        p = prods[0]
        self.assertEqual(p["available_quantity"], 40)
        self.assertEqual(p["pieces_per_box"], 24)
        self.assertEqual(str(p["narx"]), "12000")

    def test_fill_sources_requires_configured_central_warehouse_eligibility(self):
        # Konfiguratsiya yo'q: boshqa yaroqli ombor bo'lsa ham bo'sh.
        with _db() as conn, conn.cursor() as c:
            self._stock(c, self.swh, "Arqon 10m", 40)
        self.assertEqual(vfill.fill_source_warehouses(), [])

        with _db() as conn, conn.cursor() as c:
            c.execute(
                "INSERT INTO distribution.topmart_config"
                "(id,customer_id,central_warehouse_id) VALUES(1,700,%s)",
                (self.swh,),
            )
        self.assertEqual([w["id"] for w in vfill.fill_source_warehouses()],
                         [self.swh])

        # Markaziy omborning har qanday eligibility sharti buzilsa bo'sh.
        for column, value in (("active", "FALSE"), ("location_type", "'vehicle'"),
                              ("purpose", "'raw'")):
            with _db() as conn, conn.cursor() as c:
                c.execute("UPDATE public.warehouses SET %s=%s WHERE id=%%s"
                          % (column, value), (self.swh,))
            self.assertEqual(vfill.fill_source_warehouses(), [])
            with _db() as conn, conn.cursor() as c:
                c.execute("UPDATE public.warehouses SET %s=%s WHERE id=%%s"
                          % (column, "TRUE" if column == "active"
                             else "'general'" if column == "location_type"
                             else "'finished'"), (self.swh,))

        with _db() as conn, conn.cursor() as c:
            c.execute("UPDATE public.inventory SET quantity=0 WHERE warehouse_id=%s",
                      (self.swh,))
        self.assertEqual(vfill.fill_source_warehouses(), [])

    def test_pilot_chain_resolves_active_assignment_only(self):
        chain = vfill.pilot_chain(700)
        self.assertEqual(chain["delivery_agent_id"], self.da)
        self.assertEqual(chain["vehicle_id"], self.veh)
        self.assertEqual(chain["vehicle_warehouse_id"], self.vwh)
        self.assertEqual(chain["plate_number"], "DM-001")
        with _db() as conn, conn.cursor() as c:
            c.execute("UPDATE distribution.vehicle_assignments SET status='ended'")
        self.assertIsNone(vfill.pilot_chain(700))
        self.assertIsNone(vfill.pilot_chain(701))


if __name__ == "__main__":
    unittest.main()
