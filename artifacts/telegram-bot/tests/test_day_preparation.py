import unittest
from contextlib import contextmanager
from datetime import datetime, date, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from bot import day_preparation as prep
from bot.handlers import day_preparation as handler
from bot.keyboards import omborchi_reply_keyboard, admin_reply_keyboard


class PreparationTests(unittest.TestCase):
    def test_local_midnight_and_year_boundary(self):
        self.assertEqual(prep.yesterday(datetime(2026, 10, 18, 19, tzinfo=timezone.utc)),
                         date(2026, 10, 18))
        self.assertEqual(prep.yesterday(datetime(2026, 1, 1, 1, tzinfo=timezone.utc)),
                         date(2025, 12, 31))

    def test_format_units_empty_chunking_and_menus(self):
        rows = [{"name": "Tovar", "unit": "dona", "quantity": Decimal("100.000")},
                {"name": "Ip", "unit": "kg", "quantity": Decimal("3.5000")}]
        text = prep.messages(date(2026, 10, 18), rows)[0]
        self.assertIn("100 dona", text)
        self.assertIn("3.5 kg", text)
        self.assertIn("18.10.2026", text)
        self.assertIn("sotuv yo‘q", prep.messages(date.today(), [])[0])
        chunks = prep.messages(date.today(), rows * 300)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(t) <= 3000 for t in chunks))
        self.assertEqual(sum(t.count("• ") for t in chunks), 600)
        for keyboard in (omborchi_reply_keyboard(), admin_reply_keyboard()):
            self.assertIn(prep.BUTTON, [b.text for row in keyboard.keyboard for b in row])

    def test_read_only_date_bounds_and_no_seller_filter(self):
        conn, cur = Mock(), Mock()
        cur.fetchall.side_effect = [[{"warehouse_id": 37}],
                                   [{"name": "Tovar", "unit": "dona", "quantity": Decimal(20)}]]
        @contextmanager
        def connection():
            yield conn, cur
        with patch.object(prep, "get_conn", connection):
            self.assertEqual(prep.read_rows(date(2026, 10, 18))[0]["quantity"], 20)
        conn.set_session.assert_called_once_with(readonly=True)
        sql, args = cur.execute.call_args.args
        self.assertNotIn("agent_id=", sql)
        self.assertIn("s.status='posted'", sql)
        self.assertIn("sm.reason='vehicle_sale'", sql)
        self.assertEqual(args[1].astimezone(timezone.utc).isoformat(), "2026-10-17T19:00:00+00:00")
        self.assertEqual(args[2].astimezone(timezone.utc).isoformat(), "2026-10-18T19:00:00+00:00")


class HandlerTests(unittest.IsolatedAsyncioTestCase):
    async def test_denial_and_allowed_roles_no_conversation_mutation(self):
        for role in ("worker", "omborchi", "admin"):
            update = SimpleNamespace(effective_user=SimpleNamespace(id=42),
                                     effective_message=SimpleNamespace(reply_text=AsyncMock()))
            context = SimpleNamespace(user_data={"cart": ["keep"]})
            with patch.object(handler, "get_user_role", return_value={"role": role}), \
                 patch.object(handler, "read_rows", return_value=[]) as read:
                await handler.show_yesterday(update, context)
                self.assertEqual(read.call_count, 0 if role == "worker" else 1)
                self.assertEqual(context.user_data, {"cart": ["keep"]})
                update.effective_message.reply_text.assert_awaited_once()

    async def test_database_error_is_not_empty_sales(self):
        update = SimpleNamespace(effective_user=SimpleNamespace(id=42),
                                 effective_message=SimpleNamespace(reply_text=AsyncMock()))
        with patch.object(handler, "get_user_role", return_value={"role": "omborchi"}), \
             patch.object(handler, "read_rows", side_effect=RuntimeError("unavailable")), \
             self.assertLogs(handler.log, level="ERROR"):
            await handler.show_yesterday(update, SimpleNamespace())
        self.assertIn("xatolik", update.effective_message.reply_text.call_args.args[0])
