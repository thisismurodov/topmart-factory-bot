"""Mahsulot deaktivatsiyasi packer'ni bo'sh ro'yxat bilan qoldirsa —
adminlarga Telegram ogohlantirish testlari.

Qamrov:
  • get_packers_left_without_products SQL: faqat faol biriktirmasi qolmagan
    packer'lar qaytadi (boshqa faol mahsuloti borlar EMAS).
  • delete_sale_product FAOL→nofaol o'tishda notify chaqiradi va ta'sirlangan
    packer'ni nomlaydi (soxta _send orqali).
  • Allaqachon nofaol mahsulotni qayta "o'chirish" xabar yubormaydi (spam yo'q).
  • Hech kim ta'sirlanmasa xabar yuborilmaydi.

Izolyatsiya: bir martalik sxema (pid+timestamp), test_packer_products bilan
bir xil uslub.
"""

import os
import time
import unittest
from unittest import mock

import psycopg2

from tests._db_isolation import point_db_to_schema, restore_db_url, schema_url
from bot import database as db
from bot import packer_alerts

SCHEMA = f"topmart_packer_alert_test_{os.getpid()}_{int(time.time())}"


def _conn():
    return psycopg2.connect(schema_url(SCHEMA))


class PackerEmptyAlertTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._old_url = point_db_to_schema(SCHEMA)
        conn = _conn()
        cur = conn.cursor()
        cur.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
        cur.execute(f"CREATE SCHEMA {SCHEMA}")
        cur.execute(
            """
            CREATE TABLE workers (
                name TEXT PRIMARY KEY,
                role TEXT NOT NULL DEFAULT 'worker'
            );
            CREATE TABLE products (
                name TEXT PRIMARY KEY,
                active BOOLEAN NOT NULL DEFAULT TRUE
            );
            CREATE TABLE packer_product_assignments (
                id SERIAL PRIMARY KEY,
                packer_name TEXT NOT NULL REFERENCES workers(name) ON DELETE CASCADE,
                product_name TEXT NOT NULL REFERENCES products(name) ON DELETE CASCADE,
                UNIQUE (packer_name, product_name)
            );
            CREATE TABLE user_roles (
                chat_id BIGINT PRIMARY KEY,
                worker_name TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'worker'
            );
            """
        )
        cur.execute(
            "INSERT INTO workers (name, role) VALUES "
            "('PackerSolo','packer'), ('PackerRich','packer')"
        )
        cur.execute(
            "INSERT INTO products (name, active) VALUES "
            "('Arqon 4mm', TRUE), ('Arqon 6mm', TRUE)"
        )
        # PackerSolo → faqat 'Arqon 4mm'; PackerRich → ikkalasi ham.
        cur.execute(
            "INSERT INTO packer_product_assignments (packer_name, product_name) VALUES "
            "('PackerSolo','Arqon 4mm'), "
            "('PackerRich','Arqon 4mm'), ('PackerRich','Arqon 6mm')"
        )
        cur.execute(
            "INSERT INTO user_roles (chat_id, worker_name, role) VALUES "
            "(111111,'Admin Bir','admin'), (222222,'Admin Ikki','admin'), "
            "(333333,'Oddiy','worker')"
        )
        conn.commit()
        cur.close()
        conn.close()

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            conn = _conn()
            conn.cursor().execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
            conn.commit()
            conn.close()
        finally:
            restore_db_url(cls._old_url)

    def setUp(self):
        # Har testdan oldin ikkala mahsulotni faol holatga qaytaramiz.
        conn = _conn()
        cur = conn.cursor()
        cur.execute("UPDATE products SET active = TRUE")
        conn.commit()
        cur.close()
        conn.close()

    def test_helper_returns_only_packers_left_empty(self):
        conn = _conn()
        cur = conn.cursor()
        cur.execute("UPDATE products SET active = FALSE WHERE name = 'Arqon 4mm'")
        conn.commit()
        cur.close()
        conn.close()
        # PackerSolo bo'sh qoldi; PackerRich'da hali 'Arqon 6mm' faol.
        self.assertEqual(
            db.get_packers_left_without_products("Arqon 4mm"), ["PackerSolo"]
        )

    def test_deactivation_notifies_admins_naming_packer(self):
        sent: list[tuple[str, str]] = []
        with mock.patch.object(packer_alerts, "_send",
                               side_effect=lambda t, c, x: sent.append((c, x))), \
             mock.patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "test-token"}):
            self.assertTrue(db.delete_sale_product("Arqon 4mm"))
        chat_ids = {c for c, _ in sent}
        self.assertEqual(chat_ids, {"111111", "222222"})
        for _, text in sent:
            self.assertIn("PackerSolo", text)
            self.assertIn("Arqon 4mm", text)
            self.assertNotIn("PackerRich", text)

    def test_already_inactive_product_does_not_notify_again(self):
        with mock.patch.object(packer_alerts, "_send") as send, \
             mock.patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "test-token"}):
            db.delete_sale_product("Arqon 4mm")   # birinchi — xabar
            send.reset_mock()
            db.delete_sale_product("Arqon 4mm")   # takroriy — xabar YO'Q
            send.assert_not_called()

    def test_no_notification_when_no_packer_left_empty(self):
        sent: list[tuple[str, str]] = []
        with mock.patch.object(packer_alerts, "_send",
                               side_effect=lambda t, c, x: sent.append((c, x))), \
             mock.patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "test-token"}):
            # 'Arqon 6mm' o'chsa: PackerRich'da 'Arqon 4mm' faol qoladi,
            # PackerSolo'ga bu mahsulot biriktirilmagan.
            self.assertTrue(db.delete_sale_product("Arqon 6mm"))
        self.assertEqual(sent, [])

    def test_telegram_failure_never_breaks_deactivation(self):
        with mock.patch.object(packer_alerts, "_send",
                               side_effect=RuntimeError("tg down")), \
             mock.patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "test-token"}):
            self.assertTrue(db.delete_sale_product("Arqon 4mm"))
        conn = _conn()
        cur = conn.cursor()
        cur.execute("SELECT active FROM products WHERE name = 'Arqon 4mm'")
        self.assertFalse(cur.fetchone()[0])
        cur.close()
        conn.close()


if __name__ == "__main__":
    unittest.main()
