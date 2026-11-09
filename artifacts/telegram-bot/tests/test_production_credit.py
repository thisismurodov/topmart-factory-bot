"""Run only on a disposable loopback PostgreSQL database."""
import os
import uuid
from urllib.parse import urlsplit
from unittest.mock import patch

from tests import test_bom_deduction as fixture
from bot import database as db
from bot.production_credit import quote_credit


class ProductionCreditTest(fixture.BomDeductionTest):
    @classmethod
    def setUpClass(cls):
        if urlsplit(os.environ["DATABASE_URL"]).hostname not in ("localhost", "127.0.0.1"):
            raise RuntimeError("Production credit tests require disposable local PostgreSQL")
        super().setUpClass()
        conn = fixture._conn()
        with conn.cursor() as cur:
            cur.execute("""
                CREATE SCHEMA distribution;
                CREATE TABLE distribution.topmart_config
                  (id integer,customer_id integer,central_warehouse_id integer);
                CREATE TABLE customers (id integer,name text,deleted_at timestamptz);
                INSERT INTO customers VALUES (1,'Top Mart',NULL);
                ALTER TABLE products ADD COLUMN id serial,
                  ADD COLUMN active boolean DEFAULT true, ADD COLUMN in_sales boolean DEFAULT true,
                  ADD COLUMN default_sale_price numeric DEFAULT 100,
                  ADD COLUMN currency_type text DEFAULT 'UZS';
                CREATE TABLE product_price_tiers
                  (product_id integer,min_quantity numeric,max_quantity numeric,price numeric,currency text);
                ALTER TABLE stock_movements ADD COLUMN weight_kg numeric, ADD COLUMN reference text;
                CREATE TABLE sales (id serial PRIMARY KEY,customer_id integer,customer_name text,
                  status text,note text,total_amount numeric,currency text,payment_type text,
                  paid_amount numeric,debt_amount numeric,topmart_warehouse_id integer,
                  operation_key text UNIQUE,request_fingerprint text);
                CREATE TABLE sale_items (id serial PRIMARY KEY,sale_id integer,product_name text,
                  sale_type text,quantity numeric,unit_price numeric,currency text,line_total numeric);
            """)
        conn.commit()
        conn.close()

    def credit_setup(self):
        self.cur.execute("UPDATE warehouses SET name='C-03' WHERE id=%s", (self.wh,))
        self.cur.execute("DELETE FROM distribution.topmart_config")
        self.cur.execute("INSERT INTO distribution.topmart_config VALUES (1,1,%s)", (self.wh,))
        self.cur.execute("TRUNCATE sales,sale_items")
        self.conn.commit()
        self.items = [dict(product="BomProduct",quantity=10,weight_kg=2,earnings=500)]
        with db.get_conn() as (_, cur):
            self.quote = quote_credit(cur, self.wh, self.items)
        self.key = str(uuid.uuid4())

    def save(self, **kwargs):
        return db.create_batch_session("Ali", "AL", self.items, warehouse_id=self.wh,
            credit_quote=self.quote, credit_operation_key=self.key, **kwargs)

    def test_credit_stock_and_debt_once(self):
        self.credit_setup()
        result = self.save()
        self.assertIsNotNone(result["credit_sale_id"])
        self.cur.execute("SELECT total_amount,debt_amount,paid_amount,payment_type FROM sales")
        row = self.cur.fetchone()
        self.assertEqual(tuple(row.values()), (1000,1000,0,"nasiya"))
        self.cur.execute("SELECT quantity,weight_kg FROM inventory")
        self.assertEqual(tuple(self.cur.fetchone().values()), (10,2))
        self.cur.execute("SELECT COUNT(*) AS n FROM stock_movements WHERE reference LIKE 'topmart-sale:%'")
        self.assertEqual(self.cur.fetchone()["n"], 2)
        with self.assertRaisesRegex(ValueError, "oldin saqlangan"):
            self.save()
        self.cur.execute("SELECT COUNT(*) AS n FROM batches")
        self.assertEqual(self.cur.fetchone()["n"], 1)
        self.assertEqual(self._stock(self.rm_un), 95)

    def test_confirmation_and_price_change_fail_without_writes(self):
        self.credit_setup()
        with self.assertRaisesRegex(ValueError, "tasdiqlang"):
            db.create_batch_session("Ali", "AL", self.items, warehouse_id=self.wh)
        self.cur.execute("UPDATE products SET default_sale_price=200")
        self.conn.commit()
        with self.assertRaisesRegex(ValueError, "o‘zgardi"):
            self.save()
        self.cur.execute("SELECT COUNT(*) AS n FROM batches")
        self.assertEqual(self.cur.fetchone()["n"], 0)

    def test_late_failure_rolls_back_sale_batch_and_stock(self):
        self.credit_setup()
        with patch("bot.production_credit.credit_movements", side_effect=ValueError("injected")):
            with self.assertRaisesRegex(ValueError, "injected"):
                self.save()
        for table in ("sales", "sale_items", "batches", "inventory"):
            self.cur.execute(f"SELECT COUNT(*) AS n FROM {table}")
            self.assertEqual(self.cur.fetchone()["n"], 0)
        self.assertEqual(self._stock(self.rm_un), 100)

    def test_kg_uses_measured_weight_not_pieces(self):
        self.credit_setup()
        self.cur.execute("UPDATE products SET unit_type='kg' WHERE name='BomProduct'")
        self.conn.commit()
        with db.get_conn() as (_, cur):
            self.quote = quote_credit(cur, self.wh, self.items)
        self.save()
        self.cur.execute("SELECT quantity,line_total FROM sale_items")
        self.assertEqual(tuple(self.cur.fetchone().values()), (2,200))
