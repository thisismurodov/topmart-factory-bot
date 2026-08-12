"""BOM bo'yicha xom ashyo kamayishi (create_batch_session) regressiya testlari.

Tekshiradi:
  • BOM'li mahsulot uchun batch yaratilganda raw_materials.current_stock
    to'g'ri kamayadi (quantity_required × quantity).
  • stock_movements'ga OUT/raw ledger yozuvi tushadi.
  • minimum_stock ostiga tushsa low_materials qaytadi (dedup bilan).
  • BOM'siz mahsulot uchun xom ashyo va ledger o'zgarmaydi (skip).

Izolyatsiya: throwaway sxema (test_inventory_weight.py naqshiga o'xshash).
"""

import os
import time
import unittest

import psycopg2
import psycopg2.extras

from tests._db_isolation import point_db_to_schema, restore_db_url, schema_url
from bot import database as db

SCHEMA = f"topmart_bom_bot_test_{os.getpid()}_{int(time.time())}"


def _conn():
    return psycopg2.connect(schema_url(SCHEMA))


class BomDeductionTest(unittest.TestCase):
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
            "TRUNCATE inventory, stock_movements, batches, "
            "product_materials, raw_materials, products, warehouses "
            "RESTART IDENTITY"
        )
        # Ombor + mahsulotlar
        self.cur.execute("INSERT INTO warehouses (name) VALUES ('C-A') RETURNING id")
        self.wh = self.cur.fetchone()["id"]
        self.cur.execute(
            "INSERT INTO products (name, unit_type) VALUES ('BomProduct','dona'), ('NoBomProduct','dona')"
        )
        # Xom ashyolar: Un (min 50), Shakar (min 0)
        self.cur.execute(
            """INSERT INTO raw_materials (name, unit, minimum_stock, current_stock)
               VALUES ('Un','kg',50,100), ('Shakar','kg',0,30) RETURNING id"""
        )
        ids = [r["id"] for r in self.cur.fetchall()]
        self.rm_un, self.rm_shakar = ids[0], ids[1]
        # BOM: BomProduct → 0.5 kg Un + 0.2 kg Shakar (har dona uchun)
        self.cur.execute(
            """INSERT INTO product_materials (product_name, raw_material_id, quantity_required)
               VALUES ('BomProduct', %s, 0.5), ('BomProduct', %s, 0.2)""",
            (self.rm_un, self.rm_shakar),
        )
        self.conn.commit()

    def tearDown(self) -> None:
        self.cur.close()
        self.conn.close()

    def _stock(self, rm_id):
        self.cur.execute("SELECT current_stock FROM raw_materials WHERE id=%s", (rm_id,))
        return float(self.cur.fetchone()["current_stock"])

    def _raw_out_movements(self):
        self.cur.execute(
            """SELECT product, quantity, movement_type, product_type, note
               FROM stock_movements
               WHERE movement_type='OUT' AND product_type='raw'
               ORDER BY id"""
        )
        return self.cur.fetchall()

    # ── BOM'li mahsulot: zahira kamayadi + ledger yoziladi ────────────────
    def test_bom_deducts_stock_and_writes_ledger(self):
        res = db.create_batch_session(
            "Ali", "AL",
            [{"product": "BomProduct", "quantity": 40, "weight_kg": 0, "earnings": 0}],
            warehouse_id=self.wh,
        )
        # Un: 100 − 0.5×40 = 80; Shakar: 30 − 0.2×40 = 22
        self.assertAlmostEqual(self._stock(self.rm_un), 80.0, places=3)
        self.assertAlmostEqual(self._stock(self.rm_shakar), 22.0, places=3)

        moves = self._raw_out_movements()
        self.assertEqual(len(moves), 2)
        by_name = {m["product"]: m for m in moves}
        self.assertAlmostEqual(float(by_name["Un"]["quantity"]), 20.0, places=3)
        self.assertAlmostEqual(float(by_name["Shakar"]["quantity"]), 8.0, places=3)
        self.assertIn(res["batch_code"], by_name["Un"]["note"])
        # Un 80 > min 50 → past emas
        self.assertEqual(res["low_materials"], [])

    # ── minimum_stock ostiga tushsa low_materials qaytadi ─────────────────
    def test_low_materials_returned_when_below_minimum(self):
        # 0.5×120 = 60 → Un: 100 − 60 = 40 ≤ min 50
        res = db.create_batch_session(
            "Ali", "AL",
            [{"product": "BomProduct", "quantity": 120, "weight_kg": 0, "earnings": 0}],
            warehouse_id=self.wh,
        )
        low = {m["name"]: m for m in res["low_materials"]}
        self.assertIn("Un", low)
        self.assertAlmostEqual(low["Un"]["current_stock"], 40.0, places=3)
        self.assertAlmostEqual(low["Un"]["minimum_stock"], 50.0, places=3)
        # Shakar min_stock=0 → hech qachon low bo'lmaydi
        self.assertNotIn("Shakar", low)

    # ── low_materials dedup: bir sessiyada bir xil xom ashyo bir marta ────
    def test_low_materials_dedup_across_items(self):
        res = db.create_batch_session(
            "Ali", "AL",
            [
                {"product": "BomProduct", "quantity": 60, "weight_kg": 0, "earnings": 0},
                {"product": "BomProduct", "quantity": 60, "weight_kg": 0, "earnings": 0},
            ],
            warehouse_id=self.wh,
        )
        names = [m["name"] for m in res["low_materials"]]
        self.assertEqual(names.count("Un"), 1)
        # Ikkala item ham chegirilgan: 100 − 0.5×120 = 40
        self.assertAlmostEqual(self._stock(self.rm_un), 40.0, places=3)

    # ── BOM'siz mahsulot: hech narsa o'zgarmaydi ──────────────────────────
    def test_no_bom_product_skips_deduction(self):
        res = db.create_batch_session(
            "Ali", "AL",
            [{"product": "NoBomProduct", "quantity": 50, "weight_kg": 0, "earnings": 0}],
            warehouse_id=self.wh,
        )
        self.assertAlmostEqual(self._stock(self.rm_un), 100.0, places=3)
        self.assertAlmostEqual(self._stock(self.rm_shakar), 30.0, places=3)
        self.assertEqual(self._raw_out_movements(), [])
        self.assertEqual(res["low_materials"], [])


if __name__ == "__main__":
    unittest.main()
