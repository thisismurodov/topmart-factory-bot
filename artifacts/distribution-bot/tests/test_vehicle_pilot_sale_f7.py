"""F7 vehicle-sale integration tests.

Safety contract: this module only provisions a child database beneath an
explicit loopback VEHICLE_TEST_DATABASE_ADMIN_URL.  It never consults runtime
DATABASE_URL/RAILWAY_DATABASE_URL for provisioning, and removes the latter
before importing the bot database package.
"""

import os
import subprocess
import threading
import time
import unittest
import uuid
from datetime import date, timedelta
from decimal import Decimal
from urllib.parse import urlparse, urlunparse
from pathlib import Path

import psycopg2


ADMIN_URL = os.environ.get("VEHICLE_TEST_DATABASE_ADMIN_URL", "").strip()
if not ADMIN_URL:
    raise RuntimeError("VEHICLE_TEST_DATABASE_ADMIN_URL is required")
_parsed = urlparse(ADMIN_URL)
if _parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
    raise RuntimeError("VEHICLE_TEST_DATABASE_ADMIN_URL must use a loopback host")
DB_NAME = "dist_f7_py_%s_%s" % (os.getpid(), uuid.uuid4().hex[:8])
CHILD_URL = urlunparse(_parsed._replace(path="/" + DB_NAME))

# Must happen before database.connection is imported.
os.environ.pop("RAILWAY_DATABASE_URL", None)
os.environ["DATABASE_URL"] = CHILD_URL
os.environ["VEHICLE_DISTRIBUTION_SCHEMA_APPROVED"] = "1"
os.environ["VEHICLE_REPLENISHMENT_TELEGRAM_CHAT_IDS"] = "900001"

from database.connection import close_pool, init_db  # noqa: E402
from database.sales import (  # noqa: E402
    VehiclePilotIdempotencyConflict,
    VehiclePilotSaleError,
    create_sale,
    create_vehicle_pilot_sale,
)
from database.replenishment_delivery import (  # noqa: E402
    acknowledge,
    configured_recipient_ids,
    deliver_retryable,
)


PUBLIC_DDL = """
CREATE TABLE IF NOT EXISTS public.products (
 id SERIAL PRIMARY KEY, name TEXT NOT NULL, sku TEXT NOT NULL,
 active BOOLEAN NOT NULL DEFAULT TRUE, in_sales BOOLEAN NOT NULL DEFAULT FALSE
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
CREATE TABLE IF NOT EXISTS public.stock_movements (
 id SERIAL PRIMARY KEY, product TEXT NOT NULL, quantity NUMERIC NOT NULL DEFAULT 0,
 movement_type TEXT NOT NULL CHECK(movement_type IN ('IN','OUT','TRANSFER','BASELINE')),
 from_warehouse_id INTEGER REFERENCES public.warehouses(id),
 to_warehouse_id INTEGER REFERENCES public.warehouses(id), note TEXT NOT NULL DEFAULT '',
 created_by TEXT NOT NULL DEFAULT '', product_type TEXT NOT NULL DEFAULT 'finished',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), weight_kg NUMERIC,
 reference TEXT, reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movements_vehicle_sale_reference
 ON public.stock_movements(reference) WHERE reference LIKE 'vehicle-sale:%';
"""


def _admin(autocommit=True):
    c = psycopg2.connect(ADMIN_URL)
    c.autocommit = autocommit
    return c


def _db():
    return psycopg2.connect(CHILD_URL)


class VehiclePilotSaleF7(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        admin = _admin()
        try:
            with admin.cursor() as cur:
                cur.execute("CREATE DATABASE %s" % DB_NAME)
        finally:
            admin.close()
        init_db()
        with _db() as conn, conn.cursor() as cur:
            cur.execute(PUBLIC_DDL)

    @classmethod
    def tearDownClass(cls):
        close_pool()
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
        with _db() as conn, conn.cursor() as c:
            c.execute("""
              TRUNCATE distribution.vehicle_sale_allocations,
                distribution.vehicle_replenishment_outbox,
                distribution.vehicle_replenishment_requests,
                distribution.vehicle_stock_targets,
                distribution.vehicle_reconciliation_items,
                distribution.vehicle_reconciliations,
                distribution.vehicle_unit_events,distribution.vehicle_label_claims,
                distribution.vehicle_handoff_items,distribution.vehicle_handoffs,
                distribution.vehicle_assignments,distribution.vehicles,
                distribution.delivery_agents,distribution.nasiya,
                distribution.revisitlar,distribution.savdo_tafsilot,
                distribution.savdolar,distribution.mijoz_balans,
                distribution.mahsulotlar,distribution.dokonlar,distribution.users,
                public.stock_movements,public.inventory,public.warehouses,
                public.products RESTART IDENTITY CASCADE
            """)
            c.execute("INSERT INTO distribution.users(telegram_id,name,role) VALUES(700,'NAVRUZBEK','agent')")
            c.execute("INSERT INTO distribution.dokonlar(nomi,agent_id,holat,owner_telegram_id) "
                      "VALUES('Test shop',700,'faol',999) RETURNING id")
            self.shop = c.fetchone()[0]
            c.execute("INSERT INTO distribution.mahsulotlar(nomi,narx,faol,sku) "
                      "VALUES('Pilot rope',100,1,'SKU-1') RETURNING id")
            self.mid = c.fetchone()[0]
            c.execute("INSERT INTO public.products(name,sku,active,in_sales) "
                      "VALUES('ERP rope','SKU-1',TRUE,TRUE) RETURNING id")
            self.public_product_id = c.fetchone()[0]
            c.execute("INSERT INTO public.warehouses(name,active,location_type,purpose) "
                      "VALUES('DM-001 mashina ombori',TRUE,'vehicle','finished') RETURNING id")
            self.warehouse = c.fetchone()[0]
            c.execute("INSERT INTO public.inventory(warehouse_id,product,quantity,weight_kg) "
                      "VALUES(%s,'ERP rope',5,7.5)", (self.warehouse,))
            c.execute("INSERT INTO distribution.delivery_agents(name,telegram_id,faol) "
                      "VALUES('NAVRUZBEK',700,1) RETURNING id")
            da = c.fetchone()[0]
            c.execute("INSERT INTO distribution.vehicles(plate_number,vehicle_type,status,warehouse_id) "
                      "VALUES('DM-001','DAMAS','active',%s) RETURNING id", (self.warehouse,))
            self.vehicle = c.fetchone()[0]
            c.execute("INSERT INTO distribution.vehicle_assignments(vehicle_id,delivery_agent_id,status) "
                      "VALUES(%s,%s,'active')", (self.vehicle, da))
            c.execute("""INSERT INTO distribution.vehicle_handoffs
                      (vehicle_id,delivery_agent_id,source_warehouse_id,vehicle_warehouse_id,
                       handoff_date,status) VALUES(%s,%s,%s,%s,CURRENT_DATE,'stock_transferred')
                      RETURNING id""", (self.vehicle, da, self.warehouse, self.warehouse))
            handoff = c.fetchone()[0]
            c.execute("""INSERT INTO distribution.vehicle_handoff_items
                      (handoff_id,mahsulot_id,sku,quantity_dispatched)
                      VALUES(%s,%s,'SKU-1',5) RETURNING id""", (handoff, self.mid))
            item = c.fetchone()[0]
            self.claims = []
            for i, weight in enumerate(("1.200", "1.300", "1.400"), 1):
                c.execute("""INSERT INTO distribution.vehicle_label_claims
                    (vehicle_id,handoff_id,handoff_item_id,production_label_id,barcode,
                     mahsulot_id,sku,unit_weight_kg,status)
                    VALUES(%s,%s,%s,%s,%s,%s,'SKU-1',%s,'loaded') RETURNING id""",
                    (self.vehicle, handoff, item, i, "BC-%s" % i, self.mid, weight))
                claim = c.fetchone()[0]
                self.claims.append(claim)
                c.execute("""INSERT INTO distribution.vehicle_unit_events
                    (vehicle_id,handoff_id,handoff_item_id,mahsulot_id,sku,event_type,
                     quantity,actor_id,production_label_id,barcode,label_claim_id)
                    VALUES(%s,%s,%s,%s,'SKU-1','load',1,700,%s,%s,%s)""",
                    (self.vehicle, handoff, item, self.mid, i, "BC-%s" % i, claim))
            c.execute("INSERT INTO distribution.mijoz_balans(dokon_id,balans) VALUES(%s,80)",
                      (self.shop,))

    def sale(self, key=None, qty=2, total=None, debt=120, prepayment=80):
        return create_vehicle_pilot_sale(
            self.shop, 700, [(self.mid, qty, 100)],
            total if total is not None else qty * 100,
            "nasiya", None, debt, key or str(uuid.uuid4()), prepayment,
            {"naqd": 0, "karta": 0, "nasiya": debt})

    def scalar(self, sql, args=()):
        with _db() as conn, conn.cursor() as c:
            c.execute(sql, args)
            return c.fetchone()[0]

    def snapshot(self):
        tables = [
            "savdolar", "savdo_tafsilot", "nasiya", "revisitlar",
            "vehicle_sale_allocations", "vehicle_unit_events",
            "vehicle_replenishment_requests",
            "vehicle_replenishment_outbox",
        ]
        out = {}
        with _db() as conn, conn.cursor() as c:
            for t in tables:
                where = " WHERE event_type='sale'" if t == "vehicle_unit_events" else ""
                c.execute("SELECT count(*) FROM distribution.%s%s" % (t, where))
                out[t] = c.fetchone()[0]
            c.execute("SELECT balans FROM distribution.mijoz_balans WHERE dokon_id=%s", (self.shop,))
            out["balance"] = c.fetchone()[0]
            c.execute("SELECT quantity,weight_kg FROM public.inventory WHERE warehouse_id=%s",
                      (self.warehouse,))
            out["inventory"] = c.fetchone()
            c.execute("SELECT count(*) FROM public.stock_movements")
            out["movements"] = c.fetchone()[0]
            c.execute("SELECT count(*) FROM distribution.vehicle_label_claims WHERE status='sold'")
            out["sold"] = c.fetchone()[0]
            c.execute("SELECT total_orders,total_sales FROM distribution.dokonlar WHERE id=%s",
                      (self.shop,))
            out["shop_stats"] = c.fetchone()
        return out

    def add_target(self, target=10, minimum=3, effective_from="CURRENT_DATE",
                   effective_to="NULL", operation_key=None):
        with _db() as conn, conn.cursor() as c:
            c.execute(
                """INSERT INTO distribution.vehicle_stock_targets
                   (vehicle_id,mahsulot_id,public_product_id,product_name,sku,
                    target_quantity,min_quantity,effective_from,effective_to,
                    operation_key,actor_type,actor_ref)
                   VALUES(%s,%s,%s,'ERP rope','SKU-1',%s,%s,%s,%s,%s,'admin','f8-test')
                   RETURNING id""",
                (
                    self.vehicle, self.mid, self.public_product_id, target, minimum,
                    date.today() if effective_from == "CURRENT_DATE" else effective_from,
                    None if effective_to == "NULL" else effective_to,
                    operation_key,
                ),
            )
            return c.fetchone()[0]

    def test_success_qty_two_exact_effects_and_replay(self):
        key = str(uuid.uuid4())
        first = self.sale(key)
        before = self.snapshot()
        second = self.sale(key)
        self.assertEqual(first, second)
        self.assertEqual(before, self.snapshot())
        self.assertEqual(before["savdolar"], 1)
        self.assertEqual(before["savdo_tafsilot"], 1)
        self.assertEqual(before["nasiya"], 1)
        self.assertEqual(
            self.scalar("SELECT qoldiq FROM distribution.nasiya"), 120)
        self.assertEqual(before["balance"], 0)
        self.assertEqual(before["inventory"], (Decimal("3"), Decimal("5.000")))
        self.assertEqual(before["movements"], 1)
        self.assertEqual(before["vehicle_sale_allocations"], 2)
        self.assertEqual(before["vehicle_unit_events"], 2)
        self.assertEqual(before["sold"], 2)
        with _db() as conn, conn.cursor() as c:
            c.execute("SELECT status,operation_key,posted_at FROM distribution.savdolar")
            status, op, posted = c.fetchone()
            self.assertEqual((status, op), ("posted", "vehicle-sale:" + key))
            self.assertIsNotNone(posted)
            c.execute("""SELECT allocated_quantity,label_claim_id,source_unit_event_id,barcode
                         FROM distribution.vehicle_sale_allocations ORDER BY id""")
            rows = c.fetchall()
            self.assertEqual([r[0] for r in rows], [Decimal("1"), Decimal("1")])
            self.assertEqual(len({r[1] for r in rows}), 2)
            self.assertEqual(len({r[2] for r in rows}), 2)
            self.assertEqual(len({r[3] for r in rows}), 2)
            c.execute("SELECT quantity,weight_kg,reference FROM public.stock_movements")
            movement = c.fetchone()
            self.assertEqual(movement[:2], (Decimal("2"), Decimal("2.500")))
            self.assertRegex(movement[2], r"^vehicle-sale:\d+:detail:\d+$")

    def test_key_fingerprint_conflict(self):
        key = str(uuid.uuid4())
        self.sale(key)
        with self.assertRaises(VehiclePilotIdempotencyConflict):
            self.sale(key, qty=1, total=100, debt=20)
        self.assertEqual(self.snapshot()["savdolar"], 1)

    def test_concurrent_same_key_one_commit(self):
        key = str(uuid.uuid4())
        barrier = threading.Barrier(2)
        results, errors = [], []
        def run():
            try:
                barrier.wait()
                results.append(self.sale(key))
            except Exception as exc:  # asserted below
                errors.append(exc)
        threads = [threading.Thread(target=run) for _ in range(2)]
        for t in threads: t.start()
        for t in threads: t.join(15)
        self.assertFalse(any(t.is_alive() for t in threads), "deadlock")
        self.assertEqual(errors, [])
        self.assertEqual(results[0], results[1])
        s = self.snapshot()
        self.assertEqual((s["savdolar"], s["movements"], s["balance"]), (1, 1, 0))
        self.assertEqual(s["inventory"], (Decimal("3"), Decimal("5.000")))

    def assert_rollback(self, mutate, **sale_kwargs):
        mutate()
        before = self.snapshot()
        with self.assertRaises(VehiclePilotSaleError):
            self.sale(**sale_kwargs)
        self.assertEqual(self.snapshot(), before)

    def test_shortages_and_quantity_validation_rollback(self):
        self.assert_rollback(
            lambda: self._exec("UPDATE public.inventory SET quantity=1"), qty=2)
        self.setUp()
        self.assert_rollback(
            lambda: self._exec("UPDATE public.inventory SET weight_kg=1"), qty=2)
        self.setUp()
        self.assert_rollback(
            lambda: self._exec("UPDATE distribution.vehicle_label_claims "
                               "SET status='returned' WHERE id<>%s", (self.claims[0],)), qty=2)
        for bad in (Decimal("1.5"), float("nan"), float("inf")):
            self.setUp()
            before = self.snapshot()
            with self.assertRaises(VehiclePilotSaleError):
                self.sale(qty=bad, total=100)
            self.assertEqual(self.snapshot(), before)

    def test_sku_mapping_failures_rollback(self):
        mutations = [
            ("UPDATE distribution.mahsulotlar SET sku=''", ()),
            ("UPDATE distribution.mahsulotlar SET sku='MISSING'", ()),
            ("UPDATE public.products SET active=FALSE", ()),
            ("UPDATE public.products SET in_sales=FALSE", ()),
        ]
        for sql, args in mutations:
            self.setUp()
            self.assert_rollback(lambda s=sql, a=args: self._exec(s, a))
        self.setUp()
        def ambiguous():
            self._exec("DROP INDEX public.idx_products_sku_unique")
            self._exec("INSERT INTO public.products(name,sku,active,in_sales) "
                       "VALUES('ERP rope duplicate','SKU-1',TRUE,TRUE)")
        self.assert_rollback(ambiguous)

    def test_identity_and_warehouse_failures_rollback(self):
        mutations = [
            ("UPDATE distribution.delivery_agents SET telegram_id=701", ()),
            ("UPDATE distribution.vehicle_assignments SET status='ended'", ()),
            ("UPDATE distribution.vehicles SET plate_number='WRONG'", ()),
            ("UPDATE public.warehouses SET active=FALSE", ()),
            ("UPDATE public.warehouses SET location_type='general'", ()),
        ]
        for sql, args in mutations:
            self.setUp()
            self.assert_rollback(lambda s=sql, a=args: self._exec(s, a))

    def test_forced_post_balance_failure_rolls_everything_back(self):
        self._exec("""
          CREATE OR REPLACE FUNCTION distribution.f7_test_fail() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced'; END $$;
          CREATE TRIGGER f7_test_fail BEFORE INSERT ON distribution.vehicle_sale_allocations
          FOR EACH ROW EXECUTE FUNCTION distribution.f7_test_fail()
        """)
        before = self.snapshot()
        with self.assertRaises(psycopg2.Error):
            self.sale()
        self.assertEqual(self.snapshot(), before)
        self._exec("DROP TRIGGER f7_test_fail ON distribution.vehicle_sale_allocations")

    def test_immutability_constraints_and_legacy_regression(self):
        sid = self.sale()[0]
        detail = self.scalar("SELECT id FROM distribution.savdo_tafsilot WHERE savdo_id=%s", (sid,))
        for sql, args in [
            ("UPDATE distribution.savdolar SET jami_summa=1 WHERE id=%s", (sid,)),
            ("DELETE FROM distribution.savdolar WHERE id=%s", (sid,)),
            ("UPDATE distribution.savdo_tafsilot SET summa=1 WHERE id=%s", (detail,)),
            ("DELETE FROM distribution.savdo_tafsilot WHERE id=%s", (detail,)),
        ]:
            with self.assertRaises(psycopg2.Error):
                self._exec(sql, args)
        legacy = create_sale(self.shop, 701, [(self.mid, 1, 100)], 100, "naqd", None, 0)[0]
        self._exec("UPDATE distribution.savdolar SET jami_summa=101 WHERE id=%s", (legacy,))
        self._exec("DELETE FROM distribution.savdo_tafsilot WHERE savdo_id=%s", (legacy,))
        self.assertEqual(self.scalar("SELECT jami_summa FROM distribution.savdolar WHERE id=%s",
                                     (legacy,)), 101)

    def test_partial_unique_constraints(self):
        sid = self.sale()[0]
        with _db() as conn, conn.cursor() as c:
            c.execute("SELECT * FROM distribution.vehicle_sale_allocations LIMIT 1")
            cols = [d.name for d in c.description]
            row = dict(zip(cols, c.fetchone()))
        def duplicate(column):
            fields = [
                "handoff_id","savdo_id","savdo_tafsilot_id","mahsulot_id","product_name",
                "product_sku","vehicle_id","allocated_quantity","allocated_weight_kg",
                "production_label_id","barcode","source_unit_event_id","label_claim_id","operation_key",
            ]
            vals = [row[x] for x in fields]
            vals[-1] = "different-" + uuid.uuid4().hex
            if column == "source_unit_event_id":
                vals[-2] = None
            else:
                vals[-3] = None
            with self.assertRaises(psycopg2.Error):
                self._exec(
                    "INSERT INTO distribution.vehicle_sale_allocations(%s) VALUES(%s)" %
                    (",".join(fields), ",".join(["%s"] * len(fields))), tuple(vals))
        duplicate("label_claim_id")
        duplicate("source_unit_event_id")
        ref = self.scalar("SELECT reference FROM public.stock_movements LIMIT 1")
        with self.assertRaises(psycopg2.Error):
            self._exec("""INSERT INTO public.stock_movements
                       (product,quantity,movement_type,reference)
                       VALUES('x',1,'OUT',%s)""", (ref,))

    def test_f8_no_target_and_above_min_create_no_request(self):
        self.sale()
        self.assertEqual(
            self.scalar("SELECT count(*) FROM distribution.vehicle_replenishment_requests"),
            0,
        )
        self.setUp()
        self.add_target(target=10, minimum=2)
        self.sale()  # post-sale quantity=3, above min=2
        self.assertEqual(
            self.scalar("SELECT count(*) FROM distribution.vehicle_replenishment_requests"),
            0,
        )

    def test_f8_at_min_creates_exact_deficit_and_snapshots(self):
        target_id = self.add_target(target=10, minimum=3)
        sid = self.sale()[0]  # post-sale quantity=3
        with _db() as conn, conn.cursor() as c:
            c.execute(
                """SELECT vehicle_id,mahsulot_id,public_product_id,product_name,sku,
                          requested_quantity,target_quantity_snapshot,
                          current_quantity_snapshot,status,operation_key,
                          request_fingerprint
                     FROM distribution.vehicle_replenishment_requests"""
            )
            row = c.fetchone()
        self.assertEqual(
            row[:9],
            (
                self.vehicle,
                self.mid,
                self.public_product_id,
                "ERP rope",
                "SKU-1",
                Decimal("7"),
                Decimal("10"),
                Decimal("3"),
                "pending",
            ),
        )
        detail_id = self.scalar(
            "SELECT id FROM distribution.savdo_tafsilot WHERE savdo_id=%s", (sid,)
        )
        self.assertEqual(
            row[9],
            "vehicle-replenishment:auto:sale:%s:detail:%s:product:%s"
            % (sid, detail_id, self.public_product_id),
        )
        self.assertRegex(row[10], r"^[0-9a-f]{64}$")
        self.assertEqual(
            self.scalar(
                "SELECT id FROM distribution.vehicle_stock_targets WHERE id=%s",
                (target_id,),
            ),
            target_id,
        )
        self.assertEqual(
            self.scalar(
                """SELECT count(*) FROM distribution.vehicle_replenishment_outbox
                   WHERE request_id=(SELECT id FROM distribution.vehicle_replenishment_requests)
                     AND recipient_chat_id=900001 AND status='PENDING'"""
            ),
            1,
        )

    def test_f8_sale_replay_does_not_duplicate_request(self):
        self.add_target(target=10, minimum=3)
        key = str(uuid.uuid4())
        first = self.sale(key)
        before = self.snapshot()
        self.assertEqual(self.sale(key), first)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(before["vehicle_replenishment_requests"], 1)
        self.assertEqual(before["vehicle_replenishment_outbox"], 1)

    def test_f8_existing_open_request_gets_one_outbox_row(self):
        self.add_target(target=10, minimum=5)
        self.sale(key=str(uuid.uuid4()), qty=1, total=100, debt=0, prepayment=0)
        self.sale(key=str(uuid.uuid4()), qty=1, total=100, debt=0, prepayment=0)
        self.assertEqual(self.snapshot()["vehicle_replenishment_requests"], 1)
        self.assertEqual(self.snapshot()["vehicle_replenishment_outbox"], 1)

    def test_replenishment_recipient_config_has_no_admin_fallback(self):
        self.assertEqual(
            configured_recipient_ids({
                "VEHICLE_REPLENISHMENT_TELEGRAM_CHAT_IDS": " 900001, -77,900001 ",
                "ADMIN_IDS": "123",
            }),
            (900001, -77),
        )
        self.assertEqual(configured_recipient_ids({"ADMIN_IDS": "123"}), ())
        with self.assertRaises(ValueError):
            configured_recipient_ids({
                "VEHICLE_REPLENISHMENT_TELEGRAM_CHAT_IDS": "900001;123"
            })

    def test_replenishment_delivery_is_inert_when_schema_gate_is_closed(self):
        self.add_target(target=10, minimum=3)
        self.sale()

        class UnexpectedBot:
            calls = 0

            def send_message(self, *_args, **_kwargs):
                self.calls += 1
                raise AssertionError("closed gate must not send")

        bot = UnexpectedBot()
        previous = os.environ.pop("VEHICLE_DISTRIBUTION_SCHEMA_APPROVED", None)
        try:
            self.assertEqual(deliver_retryable(bot, lambda _oid: object()), 0)
            outbox_id = self.scalar(
                "SELECT id FROM distribution.vehicle_replenishment_outbox"
            )
            self.assertFalse(acknowledge(outbox_id, 900001))
        finally:
            if previous is not None:
                os.environ["VEHICLE_DISTRIBUTION_SCHEMA_APPROVED"] = previous
        self.assertEqual(bot.calls, 0)
        self.assertEqual(
            self.scalar("SELECT status FROM distribution.vehicle_replenishment_outbox"),
            "PENDING",
        )

    def test_replenishment_delivery_failure_retry_sent_and_ack(self):
        self.add_target(target=10, minimum=3)
        self.sale()

        class FailingBot:
            def send_message(self, *_args, **_kwargs):
                raise RuntimeError("telegram unavailable")

        deliver_retryable(FailingBot(), lambda _oid: object())
        self.assertEqual(
            self.scalar("SELECT status FROM distribution.vehicle_replenishment_outbox"),
            "FAILED",
        )
        self._exec(
            "UPDATE distribution.vehicle_replenishment_outbox SET next_attempt_at=NOW()"
        )

        class Sent:
            message_id = 456

        class WorkingBot:
            def __init__(self):
                self.calls = []

            def send_message(self, *args, **kwargs):
                self.calls.append((args, kwargs))
                return Sent()

        bot = WorkingBot()
        self.assertEqual(deliver_retryable(bot, lambda oid: ("ack", oid)), 1)
        self.assertEqual(len(bot.calls), 1)
        outbox_id = self.scalar(
            "SELECT id FROM distribution.vehicle_replenishment_outbox"
        )
        with _db() as conn, conn.cursor() as c:
            c.execute(
                """SELECT status,attempt_count,telegram_message_id,claimed_at
                   FROM distribution.vehicle_replenishment_outbox WHERE id=%s""",
                (outbox_id,),
            )
            self.assertEqual(c.fetchone(), ("SENT", 2, 456, None))
        self.assertFalse(acknowledge(outbox_id, 123))
        self.assertTrue(acknowledge(outbox_id, 900001))
        first_ack = self.scalar(
            "SELECT acknowledged_at FROM distribution.vehicle_replenishment_outbox"
        )
        self.assertTrue(acknowledge(outbox_id, 900001))
        self.assertEqual(
            self.scalar(
                "SELECT acknowledged_at FROM distribution.vehicle_replenishment_outbox"
            ),
            first_ack,
        )

    def test_telegram_failure_cannot_rollback_committed_sale(self):
        self.add_target(target=10, minimum=3)
        sid = self.sale()[0]

        class FailingBot:
            def send_message(self, *_args, **_kwargs):
                raise RuntimeError("telegram unavailable")

        deliver_retryable(FailingBot(), lambda _oid: object())
        self.assertEqual(
            self.scalar("SELECT count(*) FROM distribution.savdolar WHERE id=%s", (sid,)),
            1,
        )
        self.assertEqual(
            self.scalar("SELECT status FROM distribution.vehicle_replenishment_outbox"),
            "FAILED",
        )

    def test_inflight_send_renews_claim_and_suppresses_stale_reclaim(self):
        from database import replenishment_delivery as delivery

        self.add_target(target=10, minimum=3)
        self.sale()
        started = threading.Event()
        release = threading.Event()

        class Sent:
            message_id = 789

        class SlowBot:
            calls = 0

            def send_message(self, *_args, **_kwargs):
                self.calls += 1
                started.set()
                self.assert_released = release.wait(3)
                return Sent()

        class UnexpectedBot:
            calls = 0

            def send_message(self, *_args, **_kwargs):
                self.calls += 1
                return Sent()

        slow = SlowBot()
        unexpected = UnexpectedBot()
        previous_heartbeat = delivery.CLAIM_HEARTBEAT_SECONDS
        delivery.CLAIM_HEARTBEAT_SECONDS = 0.02
        worker = threading.Thread(
            target=lambda: delivery.deliver_retryable(slow, lambda oid: ("ack", oid))
        )
        try:
            worker.start()
            self.assertTrue(started.wait(2))
            self._exec(
                """UPDATE distribution.vehicle_replenishment_outbox
                      SET claimed_at=NOW()-INTERVAL '10 minutes'"""
            )
            time.sleep(0.08)
            self.assertEqual(
                delivery.deliver_retryable(unexpected, lambda oid: ("ack", oid)),
                0,
            )
            self.assertEqual(unexpected.calls, 0)
        finally:
            release.set()
            worker.join(3)
            delivery.CLAIM_HEARTBEAT_SECONDS = previous_heartbeat
        self.assertFalse(worker.is_alive())
        self.assertEqual(slow.calls, 1)
        self.assertEqual(
            self.scalar("SELECT status FROM distribution.vehicle_replenishment_outbox"),
            "SENT",
        )

    def test_f8_concurrent_sales_leave_one_open_request_without_sale_failure(self):
        self.add_target(target=10, minimum=5)
        barrier = threading.Barrier(2)
        results, errors = [], []

        def run():
            try:
                barrier.wait()
                results.append(
                    self.sale(
                        key=str(uuid.uuid4()), qty=1, total=100,
                        debt=0, prepayment=0,
                    )
                )
            except Exception as exc:  # asserted below
                errors.append(exc)

        threads = [threading.Thread(target=run) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(15)
        self.assertFalse(any(thread.is_alive() for thread in threads), "deadlock")
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 2)
        self.assertEqual(self.scalar("SELECT count(*) FROM distribution.savdolar"), 2)
        self.assertEqual(
            self.scalar(
                """SELECT count(*) FROM distribution.vehicle_replenishment_requests
                   WHERE status IN ('pending','approved')"""
            ),
            1,
        )
        self.assertEqual(
            self.scalar(
                "SELECT quantity FROM public.inventory WHERE warehouse_id=%s",
                (self.warehouse,),
            ),
            Decimal("3"),
        )

    def test_f8_only_current_effective_target_is_used(self):
        yesterday = date.today() - timedelta(days=1)
        tomorrow = date.today() + timedelta(days=1)
        self.add_target(
            target=20, minimum=5, effective_from=yesterday, effective_to=yesterday
        )
        self.add_target(
            target=30, minimum=5, effective_from=tomorrow, effective_to=tomorrow
        )
        self.sale(qty=1, total=100, debt=0, prepayment=0)
        self.assertEqual(
            self.scalar("SELECT count(*) FROM distribution.vehicle_replenishment_requests"),
            0,
        )

        self.setUp()
        self.add_target(
            target=9, minimum=4,
            effective_from=yesterday, effective_to=tomorrow,
        )
        self.sale(qty=1, total=100, debt=0, prepayment=0)
        self.assertEqual(
            self.scalar(
                "SELECT requested_quantity FROM distribution.vehicle_replenishment_requests"
            ),
            Decimal("5"),
        )

    def test_f8_request_schema_failure_rolls_back_entire_sale(self):
        self.add_target(target=10, minimum=3)
        self._exec(
            """
            CREATE OR REPLACE FUNCTION distribution.f8_test_fail() RETURNS trigger
            LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced f8'; END $$;
            CREATE TRIGGER f8_test_fail BEFORE INSERT
              ON distribution.vehicle_replenishment_requests
            FOR EACH ROW EXECUTE FUNCTION distribution.f8_test_fail()
            """
        )
        before = self.snapshot()
        with self.assertRaises(psycopg2.Error):
            self.sale()
        self.assertEqual(self.snapshot(), before)
        self._exec(
            "DROP TRIGGER f8_test_fail ON distribution.vehicle_replenishment_requests"
        )

    def test_f8_schema_checks_and_canonical_partial_uniques(self):
        with self.assertRaises(psycopg2.Error):
            self.add_target(target=2, minimum=3)
        self.add_target(target=10, minimum=3, operation_key="target-op")
        with self.assertRaises(psycopg2.Error):
            self.add_target(target=11, minimum=3, operation_key="target-op-2")

        self.sale()
        with self.assertRaises(psycopg2.Error):
            self._exec(
                "UPDATE distribution.vehicle_replenishment_requests "
                "SET approved_quantity=0"
            )
        with self.assertRaises(psycopg2.Error):
            self._exec(
                """UPDATE distribution.vehicle_replenishment_requests
                      SET status='approved',approved_quantity=requested_quantity-1,
                          approved_by=1,approved_at=NOW(),source_warehouse_id=%s,
                          handoff_id=(SELECT id FROM distribution.vehicle_handoffs LIMIT 1)""",
                (self.warehouse,),
            )

        with _db() as conn, conn.cursor() as c:
            c.execute(
                """SELECT indexname,indexdef FROM pg_indexes
                   WHERE schemaname='distribution'
                     AND indexname IN (
                       'uq_vehicle_stock_targets_current',
                       'uq_vehicle_replenishment_open',
                       'uq_vehicle_replenishment_operation_key',
                       'uq_vehicle_replenishment_fingerprint',
                       'uq_vehicle_replenishment_handoff')
                   ORDER BY indexname"""
            )
            indexes = dict(c.fetchall())
        self.assertEqual(len(indexes), 5)
        self.assertIn(
            "(vehicle_id, public_product_id) WHERE (effective_to IS NULL)",
            indexes["uq_vehicle_stock_targets_current"],
        )
        self.assertIn(
            "(vehicle_id, public_product_id)",
            indexes["uq_vehicle_replenishment_open"],
        )
        self.assertIn(
            "status = ANY (ARRAY['pending'::text, 'approved'::text])",
            indexes["uq_vehicle_replenishment_open"],
        )

    def _approved_reconciliation(self):
        with _db() as conn, conn.cursor() as c:
            c.execute("""INSERT INTO distribution.vehicle_reconciliations
                      (vehicle_id,delivery_agent_id,reconciliation_date,status)
                      SELECT v.id,va.delivery_agent_id,CURRENT_DATE,'approved'
                      FROM distribution.vehicles v
                      JOIN distribution.vehicle_assignments va ON va.vehicle_id=v.id
                      RETURNING id""")
            rid = c.fetchone()[0]
            c.execute("""INSERT INTO distribution.vehicle_reconciliation_items
                      (reconciliation_id,public_product_id,product_name,sku,
                       expected_quantity,expected_weight_kg,actual_quantity,discrepancy)
                      SELECT %s,p.id,p.name,p.sku,5,7.5,5,0
                      FROM public.products p WHERE p.sku='SKU-1'""", (rid,))
            return rid

    def _run_real_f6_apply(self, rid):
        api_dir = Path(__file__).resolve().parents[2] / "api-server"
        script = """
          import pg from 'pg';
          import {applyReconciliationInTx} from './src/routes/vehicle-distribution/reconciliation-service.ts';
          (async()=>{
          const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:false});
          const c=await pool.connect();
          try {
            await c.query('BEGIN');
            const r=await applyReconciliationInTx(c,Number(process.argv[1]),
              {type:'admin',ref:'f7-test',actorId:1});
            await c.query('COMMIT');
            console.log('OK:'+r.status);
          } catch(e) {
            await c.query('ROLLBACK');
            console.log('ERR:'+e.constructor.name+':'+e.message);
          } finally { c.release(); await pool.end(); }
          })();
        """
        env = dict(os.environ)
        env.pop("RAILWAY_DATABASE_URL", None)
        env["DATABASE_URL"] = CHILD_URL
        p = subprocess.run(
            ["pnpm", "exec", "tsx", "-e", script, str(rid)],
            cwd=api_dir, env=env, text=True, capture_output=True, check=True,
            timeout=30)
        return p.stdout.strip().splitlines()[-1]

    def _wait_for_blocked_writer(self, minimum=1):
        deadline = time.time() + 10
        while time.time() < deadline:
            with _db() as conn, conn.cursor() as c:
                c.execute("""SELECT count(*) FROM pg_stat_activity
                             WHERE datname=current_database()
                               AND wait_event_type='Lock'""")
                if c.fetchone()[0] >= minimum:
                    return
            time.sleep(0.05)
        self.fail("writer did not reach the shared warehouse lock")

    def test_real_f6_apply_and_f7_sale_serial_outcomes(self):
        # Hold the shared parent row, queue F7 first and the real F6 apply
        # second, then release. PostgreSQL's row-lock waiter order yields the
        # writer-first serial outcome: F6 observes the committed sale as stale.
        rid = self._approved_reconciliation()
        locker = _db()
        locker.cursor().execute("SELECT id FROM public.warehouses WHERE id=%s FOR UPDATE",
                                (self.warehouse,))
        sale_result, sale_errors, f6_result = [], [], []
        def run_sale():
            try:
                sale_result.append(self.sale())
            except Exception as exc:
                sale_errors.append(exc)
        sale_thread = threading.Thread(target=run_sale)
        f6_thread = threading.Thread(
            target=lambda: f6_result.append(self._run_real_f6_apply(rid)))
        sale_thread.start()
        self._wait_for_blocked_writer(1)
        f6_thread.start()
        self._wait_for_blocked_writer(2)
        locker.commit()
        locker.close()
        sale_thread.join(15)
        f6_thread.join(15)
        self.assertFalse(sale_thread.is_alive() or f6_thread.is_alive(), "deadlock")
        self.assertEqual(sale_errors, [])
        self.assertEqual(len(sale_result), 1)
        out = f6_result[0]
        self.assertIn("ERR:ReconciliationConflictError", out)
        self.assertIn("stale", out)
        self.assertEqual(
            self.scalar("SELECT status FROM distribution.vehicle_reconciliations WHERE id=%s",
                        (rid,)), "approved")

        # Queue F6 first and F7 second behind the same held warehouse row.
        # F6 applies the matching snapshot, then F7 commits: valid apply-first
        # serial outcome with real overlap and no deadlock.
        self.setUp()
        rid = self._approved_reconciliation()
        locker = _db()
        locker.cursor().execute("SELECT id FROM public.warehouses WHERE id=%s FOR UPDATE",
                                (self.warehouse,))
        f6_result, sale_result, sale_errors = [], [], []
        f6_thread = threading.Thread(
            target=lambda: f6_result.append(self._run_real_f6_apply(rid)))
        sale_thread = threading.Thread(target=run_sale)
        f6_thread.start()
        self._wait_for_blocked_writer(1)
        sale_thread.start()
        self._wait_for_blocked_writer(2)
        locker.commit()
        locker.close()
        f6_thread.join(15)
        sale_thread.join(15)
        self.assertFalse(sale_thread.is_alive() or f6_thread.is_alive(), "deadlock")
        self.assertEqual(f6_result, ["OK:applied"])
        self.assertEqual(sale_errors, [])
        self.assertEqual(len(sale_result), 1)
        self.assertEqual(self.snapshot()["savdolar"], 1)
        self.assertEqual(
            self.scalar("SELECT status FROM distribution.vehicle_reconciliations WHERE id=%s",
                        (rid,)), "applied")

    def _exec(self, sql, args=()):
        with _db() as conn, conn.cursor() as c:
            c.execute(sql, args)


if __name__ == "__main__":
    unittest.main()