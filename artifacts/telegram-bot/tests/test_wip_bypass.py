"""Telegram bot partiyasi WIP oqimidan ajratilganini tekshiradi.

Omborlar Production Flow jarayoniga tayyor bo'lguncha create_batch_session:
  • bo'lim WIP balansi 0 bo'lsa ham partiyani yaratadi;
  • wip_movements'ga PRODUCE yozmaydi;
  • mavjud RECEIVE tarixini o'zgartirmaydi;
  • batch, label, tayyor inventory va BOM sarfini avvalgidek atomar yozadi.

Izolyatsiya: barcha so'rovlar bir martalik throwaway sxemada bajariladi.
"""

import os
import threading
import time
import unittest

import psycopg2
import psycopg2.extras

from tests._db_isolation import point_db_to_schema, restore_db_url, schema_url
from bot import database as db

SCHEMA = f"topmart_wip_bypass_test_{os.getpid()}_{int(time.time())}"


def _conn():
    return psycopg2.connect(schema_url(SCHEMA))


class WipBypassTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._old_url = point_db_to_schema(SCHEMA)
        conn = _conn()
        cur = conn.cursor()
        cur.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
        cur.execute(f"CREATE SCHEMA {SCHEMA}")
        cur.execute(
            """
            CREATE TABLE warehouses (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                active BOOLEAN NOT NULL DEFAULT TRUE
            );
            CREATE TABLE production_lines (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL
            );
            CREATE TABLE products (
                name TEXT PRIMARY KEY,
                unit_type TEXT NOT NULL DEFAULT 'dona',
                payroll_method TEXT NOT NULL DEFAULT 'PRODUCT_RATE',
                line_id INTEGER,
                weight NUMERIC(12,3) NOT NULL DEFAULT 1
            );
            CREATE TABLE production_line_workers (
                worker_name TEXT NOT NULL,
                role TEXT NOT NULL,
                line_id INTEGER
            );
            CREATE TABLE line_role_config (
                line_id INTEGER NOT NULL,
                role TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE daily_payroll_runs (
                id SERIAL PRIMARY KEY,
                scope TEXT NOT NULL,
                line_id INTEGER NOT NULL,
                work_date DATE NOT NULL,
                total_kg NUMERIC NOT NULL,
                status TEXT NOT NULL,
                closed_by TEXT NOT NULL,
                UNIQUE (scope, work_date, line_id)
            );
            CREATE TABLE raw_materials (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                unit TEXT NOT NULL DEFAULT 'kg',
                minimum_stock NUMERIC NOT NULL DEFAULT 0,
                current_stock NUMERIC NOT NULL DEFAULT 0
            );
            CREATE TABLE product_materials (
                id SERIAL PRIMARY KEY,
                product_name TEXT NOT NULL,
                raw_material_id INTEGER NOT NULL,
                quantity_required NUMERIC NOT NULL DEFAULT 0
            );
            CREATE TABLE batches (
                id SERIAL PRIMARY KEY,
                batch_code TEXT NOT NULL,
                worker TEXT NOT NULL DEFAULT '',
                product TEXT NOT NULL,
                quantity INTEGER NOT NULL,
                weight_kg NUMERIC(10,3) NOT NULL DEFAULT 0,
                earnings NUMERIC(12,2) NOT NULL DEFAULT 0,
                payroll_method TEXT NOT NULL DEFAULT 'PRODUCT_RATE',
                production_line_id INTEGER,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE TABLE production_labels (
                id SERIAL PRIMARY KEY, barcode_value TEXT NOT NULL, batch_id INTEGER,
                batch_code TEXT NOT NULL, label_type TEXT NOT NULL, label_number INTEGER NOT NULL,
                total_labels INTEGER NOT NULL, pieces_in_label INTEGER NOT NULL,
                pieces_per_box INTEGER NOT NULL, quantity_total INTEGER NOT NULL,
                weight_kg NUMERIC NOT NULL, length_m NUMERIC, product_name TEXT NOT NULL,
                product_sku TEXT NOT NULL, worker_name TEXT NOT NULL, produced_at TIMESTAMPTZ NOT NULL,
                warehouse_id INTEGER, warehouse_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'created',
                print_count INTEGER NOT NULL DEFAULT 0, last_printed_at TIMESTAMPTZ
            );
            CREATE TABLE inventory (
                id SERIAL PRIMARY KEY,
                warehouse_id INTEGER NOT NULL,
                product TEXT NOT NULL,
                quantity NUMERIC NOT NULL DEFAULT 0,
                weight_kg NUMERIC NOT NULL DEFAULT 0,
                product_type TEXT NOT NULL DEFAULT 'finished',
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (warehouse_id, product)
            );
            CREATE TABLE stock_movements (
                id SERIAL PRIMARY KEY,
                product TEXT NOT NULL,
                quantity NUMERIC NOT NULL,
                movement_type TEXT NOT NULL,
                from_warehouse_id INTEGER,
                to_warehouse_id INTEGER,
                note TEXT NOT NULL DEFAULT '',
                created_by TEXT NOT NULL DEFAULT '',
                product_type TEXT NOT NULL DEFAULT 'finished',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE TABLE wip_movements (
                id SERIAL PRIMARY KEY,
                line_id INTEGER NOT NULL,
                movement_type TEXT NOT NULL,
                raw_material TEXT,
                product TEXT,
                weight_kg NUMERIC(12,3) NOT NULL DEFAULT 0,
                from_warehouse_id INTEGER,
                batch_id INTEGER,
                note TEXT NOT NULL DEFAULT '',
                created_by TEXT NOT NULL DEFAULT 'admin',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            """
        )
        conn.commit()
        cur.close()
        conn.close()

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            conn = _conn()
            cur = conn.cursor()
            cur.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
            conn.commit()
            cur.close()
            conn.close()
        finally:
            restore_db_url(cls._old_url)

    def setUp(self) -> None:
        self.conn = _conn()
        self.cur = self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        self.cur.execute(
            """TRUNCATE production_labels, inventory, stock_movements, batches,
                        wip_movements, product_materials, raw_materials,
                        daily_payroll_runs
               RESTART IDENTITY"""
        )
        self.cur.execute(
            "TRUNCATE products, warehouses, production_lines RESTART IDENTITY"
        )
        self.cur.execute("INSERT INTO warehouses (name) VALUES ('C-17') RETURNING id")
        self.wh = self.cur.fetchone()["id"]
        self.cur.execute(
            "INSERT INTO production_lines (name) VALUES ('Arqon Bo''lim 3') RETURNING id"
        )
        self.line = self.cur.fetchone()["id"]
        self.cur.execute(
            """INSERT INTO products (name, unit_type, payroll_method, line_id, weight)
               VALUES ('Ikki Qavat Arqon | 4 kg', 'kg', 'ROLE_BASED_KG', %s, 1)""",
            (self.line,),
        )
        self.conn.commit()

    def tearDown(self) -> None:
        self.cur.close()
        self.conn.close()

    def _count(self, table: str) -> int:
        self.cur.execute(f"SELECT COUNT(*) AS c FROM {table}")
        return int(self.cur.fetchone()["c"])

    def _receive(self, kg: float) -> None:
        self.cur.execute(
            """INSERT INTO wip_movements (line_id, movement_type, weight_kg)
               VALUES (%s, 'RECEIVE', %s)""",
            (self.line, kg),
        )
        self.conn.commit()

    def _batch(self, weight_kg: float, quantity: int = 1):
        return db.create_batch_session(
            "Aziza",
            "AZ",
            [{
                "product": "Ikki Qavat Arqon | 4 kg",
                "quantity": quantity,
                "weight_kg": weight_kg,
                "earnings": 0,
                "payroll_method": "ROLE_BASED_KG",
                "pieces_per_box": quantity,
            }],
            warehouse_id=self.wh,
        )

    def test_zero_wip_allows_batch_and_keeps_wip_empty(self):
        result = self._batch(55.6, quantity=4)

        self.assertTrue(result["batch_code"])
        self.assertEqual(self._count("batches"), 1)
        self.assertEqual(self._count("wip_movements"), 0)
        self.assertEqual(self._count("production_labels"), 1)

        self.cur.execute(
            """SELECT quantity, weight_kg FROM inventory
               WHERE warehouse_id=%s AND product='Ikki Qavat Arqon | 4 kg'""",
            (self.wh,),
        )
        inventory = self.cur.fetchone()
        self.assertEqual(float(inventory["quantity"]), 4.0)
        self.assertAlmostEqual(float(inventory["weight_kg"]), 55.6, places=3)

    def test_close_and_batch_share_line_day_lock(self):
        """Close birinchi bo'lsa, parallel batch kutadi va maoshsiz yozilmaydi."""
        lock_acquired = threading.Event()
        thread_errors: list[Exception] = []

        def close_line_first():
            conn = _conn()
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            try:
                cur.execute(
                    "SELECT (NOW() AT TIME ZONE 'Asia/Tashkent')::date AS d"
                )
                work_date = cur.fetchone()["d"]
                cur.execute(
                    "SELECT pg_advisory_xact_lock(hashtext(%s))",
                    (f"close_day:arqon:{self.line}:{work_date}",),
                )
                cur.execute(
                    """INSERT INTO daily_payroll_runs
                         (scope, line_id, work_date, total_kg, status, closed_by)
                       VALUES ('arqon', %s, %s, 0, 'closed', 'test-close')""",
                    (self.line, work_date),
                )
                lock_acquired.set()
                time.sleep(0.35)
                conn.commit()
            except Exception as exc:
                conn.rollback()
                thread_errors.append(exc)
                lock_acquired.set()
            finally:
                cur.close()
                conn.close()

        closer = threading.Thread(target=close_line_first)
        closer.start()
        self.assertTrue(lock_acquired.wait(timeout=3))

        with self.assertRaises(db.ClosedPayrollDayError):
            self._batch(10.0)

        closer.join(timeout=3)
        self.assertFalse(closer.is_alive())
        self.assertEqual(thread_errors, [])
        self.assertEqual(self._count("batches"), 0)

    def test_existing_receive_is_not_consumed_or_followed_by_produce(self):
        self._receive(100.0)
        self._batch(60.0)

        self.cur.execute(
            """SELECT movement_type, weight_kg FROM wip_movements
               WHERE line_id=%s ORDER BY id""",
            (self.line,),
        )
        rows = self.cur.fetchall()
        self.assertEqual(
            [(r["movement_type"], float(r["weight_kg"])) for r in rows],
            [("RECEIVE", 100.0)],
        )

    def test_multi_item_session_can_exceed_old_wip_balance_without_touching_it(self):
        self._receive(100.0)
        result = db.create_batch_session(
            "Aziza",
            "AZ",
            [
                {
                    "product": "Ikki Qavat Arqon | 4 kg",
                    "quantity": 1,
                    "weight_kg": 60.0,
                    "earnings": 0,
                    "payroll_method": "ROLE_BASED_KG",
                },
                {
                    "product": "Ikki Qavat Arqon | 4 kg",
                    "quantity": 1,
                    "weight_kg": 60.0,
                    "earnings": 0,
                    "payroll_method": "ROLE_BASED_KG",
                },
            ],
            warehouse_id=self.wh,
        )

        self.assertEqual(len(result["label_items"]), 2)
        self.assertEqual(self._count("batches"), 2)
        self.assertEqual(self._count("wip_movements"), 1)
        self.cur.execute("SELECT movement_type, weight_kg FROM wip_movements")
        row = self.cur.fetchone()
        self.assertEqual(row["movement_type"], "RECEIVE")
        self.assertEqual(float(row["weight_kg"]), 100.0)

    def test_bom_and_finished_inventory_still_update_without_wip(self):
        self.cur.execute(
            """INSERT INTO raw_materials (name, current_stock)
               VALUES ('PP xomashyo', 100) RETURNING id"""
        )
        raw_id = self.cur.fetchone()["id"]
        self.cur.execute(
            """INSERT INTO product_materials
                 (product_name, raw_material_id, quantity_required)
               VALUES ('Ikki Qavat Arqon | 4 kg', %s, 2)""",
            (raw_id,),
        )
        self.conn.commit()

        self._batch(55.6, quantity=4)

        self.cur.execute("SELECT current_stock FROM raw_materials WHERE id=%s", (raw_id,))
        self.assertEqual(float(self.cur.fetchone()["current_stock"]), 92.0)
        self.cur.execute(
            """SELECT movement_type, product_type, quantity FROM stock_movements
               ORDER BY id"""
        )
        rows = self.cur.fetchall()
        self.assertEqual(
            [(r["movement_type"], r["product_type"], float(r["quantity"])) for r in rows],
            [("IN", "finished", 4.0), ("OUT", "raw", 8.0)],
        )
        self.assertEqual(self._count("wip_movements"), 0)

    def test_batch_does_not_query_wip_table(self):
        self.cur.execute("ALTER TABLE wip_movements RENAME TO wip_movements_hidden")
        self.conn.commit()
        try:
            result = self._batch(55.6, quantity=4)
            self.assertTrue(result["batch_code"])
            self.assertEqual(self._count("batches"), 1)
            self.assertEqual(self._count("production_labels"), 1)
            self.assertEqual(self._count("inventory"), 1)
        finally:
            self.cur.execute("ALTER TABLE wip_movements_hidden RENAME TO wip_movements")
            self.conn.commit()

    def test_late_bom_failure_rolls_back_batch_label_inventory_and_raw_stock(self):
        self.cur.execute(
            """INSERT INTO raw_materials (name, current_stock)
               VALUES ('PP rollback xomashyo', 100) RETURNING id"""
        )
        raw_id = self.cur.fetchone()["id"]
        self.cur.execute(
            """INSERT INTO product_materials
                 (product_name, raw_material_id, quantity_required)
               VALUES ('Ikki Qavat Arqon | 4 kg', %s, 2)""",
            (raw_id,),
        )
        self.cur.execute(
            """ALTER TABLE stock_movements
               ADD CONSTRAINT reject_raw_movement_for_rollback_test
               CHECK (product_type <> 'raw')"""
        )
        self.conn.commit()

        try:
            with self.assertRaises(psycopg2.errors.CheckViolation):
                self._batch(55.6, quantity=4)
        finally:
            self.cur.execute(
                """ALTER TABLE stock_movements
                   DROP CONSTRAINT reject_raw_movement_for_rollback_test"""
            )
            self.conn.commit()

        self.assertEqual(self._count("batches"), 0)
        self.assertEqual(self._count("production_labels"), 0)
        self.assertEqual(self._count("inventory"), 0)
        self.assertEqual(self._count("stock_movements"), 0)
        self.assertEqual(self._count("wip_movements"), 0)
        self.cur.execute("SELECT current_stock FROM raw_materials WHERE id=%s", (raw_id,))
        self.assertEqual(float(self.cur.fetchone()["current_stock"]), 100.0)


if __name__ == "__main__":
    unittest.main()