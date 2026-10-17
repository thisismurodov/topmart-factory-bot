import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from telegram.ext import ApplicationHandlerStop
from bot import access
from bot.handlers import inventory


class V1AccessTests(unittest.IsolatedAsyncioTestCase):
    async def test_active_then_blocked_cannot_resume_messages_or_callbacks(self):
        for callback in (None, SimpleNamespace(answer=AsyncMock())):
            update = SimpleNamespace(
                effective_user=SimpleNamespace(id=7), callback_query=callback,
                effective_message=SimpleNamespace(reply_text=AsyncMock()),
            )
            with patch.object(access, "get_user_role", return_value={"role": "omborchi"}):
                await access.reject_blocked_user(update, None)
            with patch.object(access, "get_user_role", return_value={"role": "blocked"}):
                with self.assertRaises(ApplicationHandlerStop):
                    await access.reject_blocked_user(update, None)

    async def test_all_adjustment_steps_deny_non_superadmin_without_writes(self):
        names = ("adjust_start", "adjust_container_cb", "adjust_product_cb",
                 "adjust_qty", "adjust_weight", "adjust_confirm_cb",
                 "raw_adjust_start", "raw_adjust_material_cb", "raw_adjust_stock",
                 "raw_adjust_confirm_cb")
        for name in names:
            update = SimpleNamespace(effective_user=SimpleNamespace(id=7),
                callback_query=SimpleNamespace(answer=AsyncMock()))
            self.assertEqual(await getattr(inventory, name)(update, None), inventory.INV_MAIN)
            update.callback_query.answer.assert_awaited_once()

    async def test_superadmin_guard_preserves_handler(self):
        handler = AsyncMock(return_value=123)
        update = SimpleNamespace(effective_user=SimpleNamespace(id=inventory.SUPERADMIN_CHAT_ID))
        self.assertEqual(await inventory._superadmin_only(handler)(update, None), 123)
        handler.assert_awaited_once()

    def test_adjustment_buttons_hidden_from_omborchi(self):
        text = lambda uid: [b.text for row in inventory._inv_main_kb(uid).keyboard for b in row]
        self.assertNotIn("✏️ Konteynerni to'g'rilash", text(7))
        self.assertIn("✏️ Konteynerni to'g'rilash", text(inventory.SUPERADMIN_CHAT_ID))
        for label in ("➕ Kirim", "➖ Chiqim", "🔄 Skladlararo o'tkazish"):
            self.assertIn(label, text(7))