"""Xom ashyo zahirasi himoyasi (create_batch_session) testlari.

Batch yaratilganda BOM bo'yicha xom ashyo ayirilishidan OLDIN zahira
tekshiriladi:
  • Talab > current_stock → RawStockError (mahsulot, kerak/mavjud bilan);
    hech qaysi jadvalga yozilmaydi (tranzaksiya bekor).
  • allow_negative_stock=True (operator tasdiqlagan) → yoziladi, zahira
    minusga tushadi.
  • Talab <= zahira → oddiy oqim, current_stock to'g'ri kamayadi.
  • Bir sessiyada bir necha mahsulot BITTA xom ashyoni jamlab ishlatsa,
    jami talab hisoblanadi.

Izolyatsiya: throwaway sxema (search_path libpq `options` orqali).
"""

import os
import time
import unittest

import psycopg2
import psycopg2.extras

from tests._db_isolation import point_db_to_schema, restore_db_url, schema_url
from bot import database as db

SCHEMA = f"topmart_raw_stock_guard_test_{os.getpid()}_{int(time.time())}"


def _conn():
    return psycopg2.connect(schema_url(SCHEMA))


class RawStockGuardTest(unittest.TestCase):
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
                active BOOLEAN NOT NULL DEFAULT TRUE,
                location_type TEXT NOT NULL DEFAULT 'container',
                capacity_kg NUMERIC DEFAULT 20000
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
            "TRUNCATE inventory, stock_movements, batches, wip_movements, "
            "product_materials, raw_materials RESTART IDENTITY"
        )
        self.cur.execute("TRUNCATE products, warehouses RESTART IDENTITY")
        self.cur.execute("INSERT INTO warehouses (name) VALUES ('C-A') RETURNING id")
        self.wh = self.cur.fetchone()["id"]
        # Liniyasiz dona mahsulot — WIP guard aralashmaydi, faqat BOM ishlaydi.
        self.cur.execute(
            "INSERT INTO products (name, unit_type, weight) VALUES ('Non','dona',0)"
        )
        self.cur.execute(
            "INSERT INTO raw_materials (name, unit, current_stock) "
            "VALUES ('Un','kg',10) RETURNING id"
        )
        self.rm = self.cur.fetchone()["id"]
        # Non: 1 dona = 2 kg Un
        self.cur.execute(
            "INSERT INTO product_materials (product_name, raw_material_id, quantity_required) "
            "VALUES ('Non', %s, 2)",
            (self.rm,),
        )
        self.conn.commit()

    def tearDown(self) -> None:
        self.cur.close()
        self.conn.close()

    def _count(self, table: str) -> int:
        self.cur.execute(f"SELECT COUNT(*) AS c FROM {table}")
        return int(self.cur.fetchone()["c"])

    def _stock(self) -> float:
        self.cur.execute("SELECT current_stock FROM raw_materials WHERE id=%s", (self.rm,))
        return float(self.cur.fetchone()["current_stock"])

    def _items(self, qty: int) -> list[dict]:
        return [{"product": "Non", "quantity": qty, "weight_kg": 0, "earnings": 0}]

    # ── 1) Talab > zahira → RawStockError, hech narsa yozilmaydi ────────────
    def test_insufficient_stock_rejected_with_details(self):
        with self.assertRaises(db.RawStockError) as ctx:
            db.create_batch_session("Ali", "AL", self._items(6), warehouse_id=self.wh)
        s = ctx.exception.shortages
        self.assertEqual(len(s), 1)
        self.assertEqual(s[0]["name"], "Un")
        self.assertAlmostEqual(s[0]["required"], 12.0)
        self.assertAlmostEqual(s[0]["available"], 10.0)
        # Xabar matnida ham nom/kerak/mavjud bor.
        self.assertIn("Un", str(ctx.exception))
        # To'liq rollback — zahira o'zgarmagan, hech narsa yozilmagan.
        self.assertAlmostEqual(self._stock(), 10.0)
        self.assertEqual(self._count("batches"), 0)
        self.assertEqual(self._count("inventory"), 0)
        self.assertEqual(self._count("stock_movements"), 0)

    # ── 2) Operator tasdiqlagan → minusga tushishga ruxsat ──────────────────
    def test_confirmed_override_allows_negative(self):
        res = db.create_batch_session(
            "Ali", "AL", self._items(6), warehouse_id=self.wh,
            allow_negative_stock=True,
        )
        self.assertTrue(res["batch_code"])
        self.assertAlmostEqual(self._stock(), -2.0)
        self.assertEqual(self._count("batches"), 1)

    # ── 3) Zahira yetarli → oddiy oqim ──────────────────────────────────────
    def test_sufficient_stock_deducts_normally(self):
        db.create_batch_session("Ali", "AL", self._items(4), warehouse_id=self.wh)
        self.assertAlmostEqual(self._stock(), 2.0)
        self.assertEqual(self._count("batches"), 1)

    # ── 4) Ko'p itemli sessiya jami talabni hisoblaydi ──────────────────────
    def test_multi_item_total_requirement_checked(self):
        items = self._items(3) + self._items(3)  # jami 6 dona → 12 kg > 10 kg
        with self.assertRaises(db.RawStockError):
            db.create_batch_session("Ali", "AL", items, warehouse_id=self.wh)
        self.assertAlmostEqual(self._stock(), 10.0)
        self.assertEqual(self._count("batches"), 0)


if __name__ == "__main__":
    unittest.main()
