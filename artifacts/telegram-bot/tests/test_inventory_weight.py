"""Konteyner kilogrammlari (inventory.weight_kg) yaxlitligi testlari.

Bot tomonidagi mutatsiya yo'llarini tekshiradi:
  • create_batch_session — partiya KIRIM og'irlikni to'g'ri qo'shadi (jamlanadi).
  • record_movement OUT — saqlangan og'irlikdan proporsional ayiradi.
  • record_movement TRANSFER — qisman ko'chirishda og'irlik manbadan
    proporsional ayiriladi va qabul qiluvchiga qo'shiladi.

Izolyatsiya: barcha so'rovlar bir martalik (throwaway) sxemada bajariladi
(search_path libpq `options` parametri orqali beriladi), shu bois haqiqiy
ma'lumotlarga tegmaydi.
"""

import os
import time
import unittest

import psycopg2
import psycopg2.extras

from tests._db_isolation import point_db_to_schema, restore_db_url, schema_url
from bot import database as db

SCHEMA = f"topmart_kg_bot_test_{os.getpid()}_{int(time.time())}"


def _conn():
    return psycopg2.connect(schema_url(SCHEMA))


class ContainerWeightTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._old_url = point_db_to_schema(SCHEMA)
        conn = _conn()
        cur = conn.cursor()
        cur.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
        cur.execute(f"CREATE SCHEMA {SCHEMA}")
        # Bot funksiyalari teguvchi jadvallarning minimal nusxalari.
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
                unit_type TEXT NOT NULL DEFAULT 'kg',
                minimum_stock NUMERIC NOT NULL DEFAULT 0,
                current_stock NUMERIC NOT NULL DEFAULT 0,
                active BOOLEAN NOT NULL DEFAULT TRUE
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
                weight_kg NUMERIC,
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
            "TRUNCATE production_labels, inventory, stock_movements, batches RESTART IDENTITY"
        )
        self.cur.execute("TRUNCATE products, warehouses, raw_materials RESTART IDENTITY")
        # KG va dona mahsulot
        self.cur.execute(
            "INSERT INTO products (name, unit_type) VALUES ('TestKg','kg'), ('TestDona','dona')"
        )
        # Ikkita konteyner
        self.cur.execute(
            "INSERT INTO warehouses (name) VALUES ('C-A'),('C-B') RETURNING id"
        )
        self.conn.commit()
        self.cur.execute("SELECT id, name FROM warehouses ORDER BY id")
        rows = self.cur.fetchall()
        self.wh_a = rows[0]["id"]
        self.wh_b = rows[1]["id"]

    def tearDown(self) -> None:
        self.cur.close()
        self.conn.close()

    def _inv(self, warehouse_id: int, product: str):
        self.cur.execute(
            "SELECT quantity, weight_kg FROM inventory WHERE warehouse_id=%s AND product=%s",
            (warehouse_id, product),
        )
        return self.cur.fetchone()

    def _seed_inventory(self, warehouse_id, product, quantity, weight_kg, product_type="finished"):
        self.cur.execute(
            """INSERT INTO inventory (warehouse_id, product, quantity, weight_kg, product_type)
               VALUES (%s,%s,%s,%s,%s)""",
            (warehouse_id, product, quantity, weight_kg, product_type),
        )
        self.conn.commit()

    def _seed_raw(self, name, current_stock, unit_type="kg"):
        self.cur.execute(
            "INSERT INTO raw_materials (name, unit, unit_type, current_stock) VALUES (%s,'kg',%s,%s)",
            (name, unit_type, current_stock),
        )
        self.conn.commit()

    def _raw_stock(self, name) -> float:
        self.cur.execute("SELECT current_stock FROM raw_materials WHERE name=%s", (name,))
        return float(self.cur.fetchone()["current_stock"])

    def _last_movement(self) -> dict:
        self.cur.execute("SELECT * FROM stock_movements ORDER BY id DESC LIMIT 1")
        return self.cur.fetchone()

    def _movement_count(self) -> int:
        self.cur.execute("SELECT COUNT(*) AS c FROM stock_movements")
        return int(self.cur.fetchone()["c"])

    def _reconcile_gap(self, name) -> float:
        """Dashboard raw-reconcile formulasi: current_stock − Σ(ledger).
        Bot amali bu farqni O'ZGARTIRMASLIGI shart (drift invarianti)."""
        self.cur.execute(
            """SELECT COALESCE(SUM(CASE
                     WHEN movement_type='IN' THEN quantity
                     WHEN movement_type='OUT' AND from_warehouse_id IS NULL THEN -quantity
                     ELSE 0 END), 0) AS led
               FROM stock_movements WHERE product=%s AND product_type='raw'""",
            (name,),
        )
        led = float(self.cur.fetchone()["led"])
        return self._raw_stock(name) - led

    # ── create_batch_session: KIRIM og'irligi ──────────────────────────────
    def test_batch_creates_unique_immutable_label_passports(self):
        result = db.create_batch_session(
            "Ali", "AL",
            [{
                "product": "TestDona",
                "quantity": 26,
                "weight_kg": 52.0,
                "earnings": 0,
                "pieces_per_box": 25,
                "profile_kg": 2.0,
                "sku": "LONG-SKU-TEST-01",
                "metr": 80,
            }],
            warehouse_id=self.wh_a,
        )

        labels = result["label_items"][0]["labels"]
        self.assertEqual(len(labels), 2)
        self.assertEqual(len({r["barcode_value"] for r in labels}), 2)
        for row in labels:
            self.assertRegex(row["barcode_value"], r"^TM[A-Z2-7]{16}$")

        self.assertEqual([r["pieces_in_label"] for r in labels], [25, 1])
        self.assertEqual([float(r["weight_kg"]) for r in labels], [50.0, 2.0])
        self.assertTrue(all(r["warehouse_name"] == "C-A" for r in labels))
        self.assertTrue(all(r["status"] == "created" for r in labels))

        persisted = db.get_production_labels(result["batch_code"])
        self.assertEqual(
            [r["barcode_value"] for r in persisted],
            [r["barcode_value"] for r in labels],
        )
        self.assertEqual(db.mark_batch_labels_printed(result["batch_code"]), 2)
        printed = db.get_production_labels(result["batch_code"])
        self.assertTrue(all(r["status"] == "printed" for r in printed))
        self.assertTrue(all(r["print_count"] == 1 for r in printed))

    def test_batch_in_adds_and_accumulates_weight(self):
        db.create_batch_session(
            "Ali", "AL",
            [{"product": "TestKg", "quantity": 100, "weight_kg": 250.0, "earnings": 0}],
            warehouse_id=self.wh_a,
        )
        row = self._inv(self.wh_a, "TestKg")
        self.assertEqual(float(row["quantity"]), 100.0)
        self.assertAlmostEqual(float(row["weight_kg"]), 250.0, places=3)

        # Ikkinchi partiya — og'irlik jamlanadi (qo'shiladi, almashtirmaydi)
        db.create_batch_session(
            "Ali", "AL",
            [{"product": "TestKg", "quantity": 40, "weight_kg": 110.0, "earnings": 0}],
            warehouse_id=self.wh_a,
        )
        row = self._inv(self.wh_a, "TestKg")
        self.assertEqual(float(row["quantity"]), 140.0)
        self.assertAlmostEqual(float(row["weight_kg"]), 360.0, places=3)

    # ── record_movement IN: partiya nisbati bo'yicha og'irlik ──────────────
    def test_manual_in_adds_batch_ratio_weight(self):
        # Partiya nisbati 2.5 kg/dona (250/100) — KIRIM og'irligi shundan olinadi.
        self.cur.execute(
            "INSERT INTO batches (batch_code, product, quantity, weight_kg) VALUES ('B-1','TestKg',100,250)"
        )
        self.conn.commit()

        ok = db.record_movement("TestKg", 40, "IN", None, self.wh_a, product_type="finished")
        self.assertTrue(ok)

        row = self._inv(self.wh_a, "TestKg")
        # 40 * 2.5 = 100 kg
        self.assertEqual(float(row["quantity"]), 40.0)
        self.assertAlmostEqual(float(row["weight_kg"]), 100.0, places=3)

    def test_manual_in_dona_product_stays_weightless(self):
        ok = db.record_movement("TestDona", 25, "IN", None, self.wh_a, product_type="finished")
        self.assertTrue(ok)
        row = self._inv(self.wh_a, "TestDona")
        self.assertEqual(float(row["quantity"]), 25.0)
        self.assertAlmostEqual(float(row["weight_kg"]), 0.0, places=3)

    # ── record_movement OUT: proporsional ayirish ──────────────────────────
    def test_manual_out_subtracts_proportional_stored_weight(self):
        # Saqlangan nisbat 3.0 kg/dona (300/100).
        self._seed_inventory(self.wh_a, "TestKg", 100, 300)

        ok = db.record_movement("TestKg", 40, "OUT", self.wh_a, None, product_type="finished")
        self.assertTrue(ok)

        row = self._inv(self.wh_a, "TestKg")
        # 300 * 40/100 = 120 ayiriladi → 60 dona / 180 kg
        self.assertEqual(float(row["quantity"]), 60.0)
        self.assertAlmostEqual(float(row["weight_kg"]), 180.0, places=3)

    # ── record_movement TRANSFER: qisman ko'chirish ────────────────────────
    def test_partial_transfer_moves_proportional_weight(self):
        self._seed_inventory(self.wh_a, "TestKg", 100, 300)

        ok = db.record_movement("TestKg", 40, "TRANSFER", self.wh_a, self.wh_b, product_type="finished")
        self.assertTrue(ok)

        src = self._inv(self.wh_a, "TestKg")
        dst = self._inv(self.wh_b, "TestKg")
        # moveWeight = 300 * 40/100 = 120
        self.assertEqual(float(src["quantity"]), 60.0)
        self.assertAlmostEqual(float(src["weight_kg"]), 180.0, places=3)
        self.assertEqual(float(dst["quantity"]), 40.0)
        self.assertAlmostEqual(float(dst["weight_kg"]), 120.0, places=3)

    # ══════════════════════════════════════════════════════════════════════
    # KG REJIMI (weight_kg>0, quantity=0) — FDY 837.7 regressiyasi va do'stlari
    # ══════════════════════════════════════════════════════════════════════

    def test_kg_in_adds_weight_only(self):
        """KG kirim dona ustunini EMAS, og'irlikni oshiradi (FDY 837.7 bugi)."""
        self._seed_inventory(self.wh_a, "TestKg", 0, 4572.25, product_type="pre-finished")

        ok = db.record_movement(
            "TestKg", 0, "IN", None, self.wh_a,
            product_type="pre-finished", weight_kg=837.7,
        )
        self.assertTrue(ok)

        row = self._inv(self.wh_a, "TestKg")
        self.assertEqual(float(row["quantity"]), 0.0)
        self.assertAlmostEqual(float(row["weight_kg"]), 5409.95, places=3)

        m = self._last_movement()
        self.assertEqual(float(m["quantity"]), 0.0)  # finished/pre-finished: qty=0
        self.assertAlmostEqual(float(m["weight_kg"]), 837.7, places=3)

    def test_kg_in_raw_syncs_catalog_and_ledger(self):
        """Xom ashyo KG kirimi: inventar og'irligi, global zahira va ledger
        (movement.quantity=kg) bir vaqtda, bir xil miqdorga o'zgaradi."""
        self._seed_raw("TestRaw", 100)
        self._seed_inventory(self.wh_a, "TestRaw", 0, 100, product_type="raw")
        gap_before = self._reconcile_gap("TestRaw")

        ok = db.record_movement(
            "TestRaw", 0, "IN", None, self.wh_a,
            product_type="raw", weight_kg=50,
        )
        self.assertTrue(ok)

        row = self._inv(self.wh_a, "TestRaw")
        self.assertAlmostEqual(float(row["weight_kg"]), 150.0, places=3)
        self.assertEqual(float(row["quantity"]), 0.0)
        self.assertAlmostEqual(self._raw_stock("TestRaw"), 150.0, places=3)

        m = self._last_movement()
        # raw ledger quantity'ni sanaydi — kg u yerga yoziladi
        self.assertAlmostEqual(float(m["quantity"]), 50.0, places=3)
        self.assertAlmostEqual(float(m["weight_kg"]), 50.0, places=3)

        # drift invarianti: reconcile farqi o'zgarmadi
        self.assertAlmostEqual(self._reconcile_gap("TestRaw"), gap_before, places=3)

    def test_dona_in_raw_also_syncs_catalog(self):
        """Dona rejimidagi raw kirim ham globalni sinxronlaydi (drift bo'lmasin)."""
        self._seed_raw("TestRaw", 10)
        gap_before = self._reconcile_gap("TestRaw")

        ok = db.record_movement("TestRaw", 20, "IN", None, self.wh_a, product_type="raw")
        self.assertTrue(ok)
        self.assertAlmostEqual(self._raw_stock("TestRaw"), 30.0, places=3)
        self.assertAlmostEqual(self._reconcile_gap("TestRaw"), gap_before, places=3)

    def test_kg_out_from_warehouse_keeps_raw_global(self):
        """Skladdan chiqim (bo'limga berish) globalni O'ZGARTIRMAYDI —
        reconcile semantikasi (OUT from_warehouse bilan = 0)."""
        self._seed_raw("TestRaw", 100)
        self._seed_inventory(self.wh_a, "TestRaw", 0, 80, product_type="raw")
        gap_before = self._reconcile_gap("TestRaw")

        ok = db.record_movement(
            "TestRaw", 0, "OUT", self.wh_a, None,
            product_type="raw", weight_kg=30,
        )
        self.assertTrue(ok)

        row = self._inv(self.wh_a, "TestRaw")
        self.assertAlmostEqual(float(row["weight_kg"]), 50.0, places=3)
        self.assertAlmostEqual(self._raw_stock("TestRaw"), 100.0, places=3)
        self.assertAlmostEqual(self._reconcile_gap("TestRaw"), gap_before, places=3)

    def test_kg_transfer_moves_weight_only(self):
        self._seed_inventory(self.wh_a, "TestKg", 0, 300, product_type="pre-finished")

        ok = db.record_movement(
            "TestKg", 0, "TRANSFER", self.wh_a, self.wh_b,
            product_type="pre-finished", weight_kg=120,
        )
        self.assertTrue(ok)

        src = self._inv(self.wh_a, "TestKg")
        dst = self._inv(self.wh_b, "TestKg")
        self.assertEqual(float(src["quantity"]), 0.0)
        self.assertAlmostEqual(float(src["weight_kg"]), 180.0, places=3)
        self.assertEqual(float(dst["quantity"]), 0.0)
        self.assertAlmostEqual(float(dst["weight_kg"]), 120.0, places=3)

    # ── kg-qatorlar ko'rinishi va birlik aniqlash ──────────────────────────

    def test_stock_helpers_see_weight_only_rows(self):
        """qty=0, og'irlik>0 qatorlar chiqim/o'tkazish ro'yxatida va
        kirimdagi 'qayerda qancha bor' ko'rsatkichida ko'rinishi shart."""
        self._seed_inventory(self.wh_a, "TestKg", 0, 300, product_type="pre-finished")
        self._seed_inventory(self.wh_b, "TestKg", 0, 120, product_type="pre-finished")

        items = db.get_stock_for_warehouse(self.wh_a)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["product"], "TestKg")
        self.assertAlmostEqual(float(items[0]["weight_kg"]), 300.0, places=3)

        locs = db.get_stock_locations("TestKg")
        self.assertEqual(len(locs), 2)
        self.assertEqual({l["warehouse"] for l in locs}, {"C-A", "C-B"})

    def test_unit_helper(self):
        self._seed_raw("TestRaw", 0)
        self.assertEqual(db.get_unit_for_item("TestKg", "finished"), "kg")
        self.assertEqual(db.get_unit_for_item("TestDona", "finished"), "dona")
        self.assertEqual(db.get_unit_for_item("TestRaw", "raw"), "kg")
        # katalogda yo'q raw — default kg
        self.assertEqual(db.get_unit_for_item("Yo'q Xom Ashyo", "raw"), "kg")

    # ══════════════════════════════════════════════════════════════════════
    # ATOMAR YETARLILIK NAZORATI — tanlash↔tasdiqlash oralig'idagi poyga:
    # shart bajarilmasa HECH NARSA yozilmasligi kerak (harakat yozuvi ham).
    # ══════════════════════════════════════════════════════════════════════

    def test_out_insufficient_rejected_dona(self):
        self._seed_inventory(self.wh_a, "TestDona", 30, 0)
        ok = db.record_movement("TestDona", 50, "OUT", self.wh_a, None, product_type="finished")
        self.assertFalse(ok)
        self.assertEqual(self._movement_count(), 0)
        row = self._inv(self.wh_a, "TestDona")
        self.assertEqual(float(row["quantity"]), 30.0)

    def test_out_insufficient_rejected_kg(self):
        self._seed_raw("TestRaw", 100)
        self._seed_inventory(self.wh_a, "TestRaw", 0, 30, product_type="raw")
        ok = db.record_movement(
            "TestRaw", 0, "OUT", self.wh_a, None, product_type="raw", weight_kg=50,
        )
        self.assertFalse(ok)
        self.assertEqual(self._movement_count(), 0)
        row = self._inv(self.wh_a, "TestRaw")
        self.assertAlmostEqual(float(row["weight_kg"]), 30.0, places=3)
        self.assertAlmostEqual(self._raw_stock("TestRaw"), 100.0, places=3)

    def test_transfer_insufficient_no_partial(self):
        self._seed_inventory(self.wh_a, "TestKg", 0, 30, product_type="pre-finished")
        ok = db.record_movement(
            "TestKg", 0, "TRANSFER", self.wh_a, self.wh_b,
            product_type="pre-finished", weight_kg=50,
        )
        self.assertFalse(ok)
        self.assertEqual(self._movement_count(), 0)
        self.assertIsNone(self._inv(self.wh_b, "TestKg"))
        src = self._inv(self.wh_a, "TestKg")
        self.assertAlmostEqual(float(src["weight_kg"]), 30.0, places=3)

    def test_out_missing_row_rejected(self):
        """Sklad qatori umuman yo'q bo'lsa ham chiqim rad etiladi."""
        ok = db.record_movement("Yo'q Mahsulot", 5, "OUT", self.wh_a, None, product_type="finished")
        self.assertFalse(ok)
        self.assertEqual(self._movement_count(), 0)


if __name__ == "__main__":
    unittest.main()
