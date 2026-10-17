"""Focused Telegram tests for the Top Mart external-purchase receipt flow."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from telegram.ext import ConversationHandler

from bot.handlers import inventory
from bot.keyboards import admin_reply_keyboard, omborchi_reply_keyboard


def _message(text=""):
    return SimpleNamespace(text=text, reply_text=AsyncMock())


def _button_texts(keyboard):
    return [button.text for row in keyboard.keyboard for button in row]


class ExternalPurchaseHandlerTest(unittest.IsolatedAsyncioTestCase):
    async def test_dashboard_cost_suggestion_uses_correct_unit(self):
        for unit, cost, expected in (("dona", "1250.25", "1250250.00"), ("kg", "10000", "450000.00")):
            with self.subTest(unit=unit):
                state = {"product": {"unitType": unit, "costPrice": cost, "currencyType": "UZS"},
                         "quantity": 1000}
                ctx = SimpleNamespace(user_data={"external_purchase": state})
                update = SimpleNamespace(message=_message("45"))
                self.assertEqual(await inventory.external_weight(update, ctx), inventory.INV_EXT_COST)
                self.assertEqual(state["suggested_cost"], expected)
                self.assertNotIn("total_cost", state)
                text = update.message.reply_text.await_args.args[0]
                self.assertIn("Dashboarddagi tan narx", text)

    async def test_missing_invalid_or_foreign_cost_requires_manual_sum(self):
        for price, currency in (("0", "UZS"), ("NaN", "UZS"), ("bad", "UZS"), ("10", "USD")):
            state = {"product": {"unitType": "dona", "costPrice": price, "currencyType": currency},
                     "quantity": 1000, "suggested_cost": "123"}
            ctx = SimpleNamespace(user_data={"external_purchase": state})
            update = SimpleNamespace(message=_message("45"))
            self.assertEqual(await inventory.external_weight(update, ctx), inventory.INV_EXT_COST)
            self.assertNotIn("suggested_cost", state)
            self.assertNotIn("total_cost", state)

    async def test_accept_cost_and_manual_override(self):
        state = {"suggested_cost": "450000.00", "cost_token": "current"}
        ctx = SimpleNamespace(user_data={"external_purchase": state})
        query = SimpleNamespace(data="extcost:current:yes", answer=AsyncMock(),
                                edit_message_text=AsyncMock(), message=_message())
        update = SimpleNamespace(callback_query=query, effective_chat=SimpleNamespace(id=7))
        with patch.object(inventory, "_is_external_purchase_allowed", return_value=True):
            self.assertEqual(await inventory.external_cost_cb(update, ctx), inventory.INV_EXT_REFERENCE)
        self.assertEqual(state["total_cost"], "450000.00")
        self.assertNotIn("cost_token", state)
        state.update(suggested_cost="450000.00", cost_token="another")
        manual = SimpleNamespace(message=_message("440000"))
        self.assertEqual(await inventory.external_cost(manual, ctx), inventory.INV_EXT_REFERENCE)
        self.assertEqual(state["total_cost"], "440000")
        self.assertNotIn("suggested_cost", state)
        self.assertNotIn("cost_token", state)

    async def test_edit_and_stale_cost_buttons_do_not_save(self):
        state = {"suggested_cost": "450000.00", "cost_token": "current"}
        ctx = SimpleNamespace(user_data={"external_purchase": state})
        query = SimpleNamespace(data="extcost:old:yes", answer=AsyncMock(),
                                edit_message_text=AsyncMock(), message=_message())
        update = SimpleNamespace(callback_query=query, effective_chat=SimpleNamespace(id=7))
        with patch.object(inventory, "_is_external_purchase_allowed", return_value=True):
            self.assertEqual(await inventory.external_cost_cb(update, ctx), inventory.INV_EXT_COST)
            self.assertNotIn("total_cost", state)
            query.data = "extcost:current:edit"
            self.assertEqual(await inventory.external_cost_cb(update, ctx), inventory.INV_EXT_COST)
        self.assertNotIn("total_cost", state)
        self.assertNotIn("cost_token", state)

    def test_warehouse_permissions_preserve_admin_access_and_reject_other_roles(self):
        for role in ("admin", "omborchi"):
            with self.subTest(role=role), patch.object(
                inventory, "get_user_role", return_value={"role": role}
            ):
                self.assertTrue(inventory._is_allowed(7))
                self.assertTrue(inventory._is_external_purchase_allowed(7))
        for role in ("worker", "blocked"):
            with self.subTest(role=role), patch.object(
                inventory, "get_user_role", return_value={"role": role}
            ):
                self.assertFalse(inventory._is_allowed(7))
                self.assertFalse(inventory._is_external_purchase_allowed(7))
        with patch.object(inventory, "get_user_role", return_value=None):
            self.assertFalse(inventory._is_allowed(7))
            self.assertFalse(inventory._is_external_purchase_allowed(7))

    async def test_admin_and_omborchi_receive_same_inventory_actions(self):
        menus = []
        for role in ("admin", "omborchi"):
            update = SimpleNamespace(
                effective_chat=SimpleNamespace(id=7), message=_message(),
            )
            with patch.object(inventory, "get_user_role", return_value={"role": role}):
                state = await inventory.ombor_entry(update, SimpleNamespace(user_data={}))
            self.assertEqual(state, inventory.INV_MAIN)
            menus.append(_button_texts(
                update.message.reply_text.await_args.kwargs["reply_markup"]
            ))
        self.assertEqual(menus[0], menus[1])
        for action in ("➕ Kirim", "➖ Chiqim", "🔄 Skladlararo o'tkazish",
                       "🛒 Tashqi xarid kirimi", "📋 Qoldiqlar", "📜 Harakatlar tarixi"):
            self.assertIn(action, menus[1])

    def test_role_keyboards_expose_warehouse_entry_and_admin_external_receipt(self):
        omborchi_buttons = _button_texts(omborchi_reply_keyboard())
        self.assertIn("🏬 Ombor", omborchi_buttons)
        self.assertIn("🚚 Mashinani to‘ldirish", omborchi_buttons)
        inventory_buttons = _button_texts(inventory._inv_main_kb())
        self.assertIn("🛒 Tashqi xarid kirimi", inventory_buttons)
        self.assertIn("🏬 Ombor", _button_texts(admin_reply_keyboard()))

    async def test_omborchi_can_enter_then_return_to_omborchi_keyboard(self):
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=7),
            message=_message(),
        )
        context = SimpleNamespace(user_data={})
        with patch.object(inventory, "get_user_role",
                          return_value={"role": "omborchi", "worker_name": "Omborchi"}):
            state = await inventory.ombor_entry(update, context)
            self.assertEqual(state, inventory.INV_MAIN)
            entry_keyboard = update.message.reply_text.await_args.kwargs["reply_markup"]
            self.assertIn("🛒 Tashqi xarid kirimi", _button_texts(entry_keyboard))
            result = await inventory.ombor_back(update, context)
        self.assertEqual(result, ConversationHandler.END)
        return_keyboard = update.message.reply_text.await_args.kwargs["reply_markup"]
        self.assertIn("🏬 Ombor", _button_texts(return_keyboard))
        self.assertNotIn("⚙️ Admin panel", _button_texts(return_keyboard))

    async def test_ombor_back_returns_admin_and_packer_to_their_own_menus(self):
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=7),
            message=_message(),
        )
        context = SimpleNamespace(user_data={})
        with patch.object(inventory, "get_user_role", return_value={"role": "admin"}):
            await inventory.ombor_back(update, context)
        self.assertIn("⚙️ Admin panel", _button_texts(
            update.message.reply_text.await_args.kwargs["reply_markup"]
        ))
        with patch.object(inventory, "get_user_role", return_value={"role": "packer"}):
            await inventory.ombor_back(update, context)
        packer_buttons = _button_texts(
            update.message.reply_text.await_args.kwargs["reply_markup"]
        )
        self.assertIn("✅ Bugungi partiyalar tugadi", packer_buttons)
        self.assertNotIn("⚙️ Admin panel", packer_buttons)

    async def test_only_active_external_products_from_api_are_shown(self):
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=7),
            message=_message(),
        )
        context = SimpleNamespace(user_data={})
        products = [{"id": 4, "name": "Import A", "sku": "A"}]
        with patch.object(inventory, "_is_external_purchase_allowed", return_value=True), \
             patch.object(inventory, "list_external_purchase_products",
                          return_value=(True, products)):
            state = await inventory.external_purchase_start(update, context)
        self.assertEqual(state, inventory.INV_EXT_PRODUCT)
        self.assertEqual(context.user_data["external_purchase"]["products"], products)
        keyboard = update.message.reply_text.await_args.kwargs["reply_markup"].inline_keyboard
        self.assertEqual([button.text for row in keyboard for button in row][0], "Import A")

    async def test_validation_requires_integer_pieces_positive_kg_and_reference(self):
        context = SimpleNamespace(user_data={"external_purchase": {}})
        update = SimpleNamespace(message=_message("1.5"))
        self.assertEqual(
            await inventory.external_quantity(update, context),
            inventory.INV_EXT_QTY,
        )
        update.message = _message("0")
        self.assertEqual(
            await inventory.external_weight(update, context),
            inventory.INV_EXT_WEIGHT,
        )
        update.message = _message("   ")
        self.assertEqual(
            await inventory.external_reference(update, context),
            inventory.INV_EXT_REFERENCE,
        )

    async def test_confirmation_preserves_exact_weight_and_cost_decimals(self):
        context = SimpleNamespace(user_data={"external_purchase": {
            "product": {"id": 4, "name": "Import A"},
            "supplier": "Supplier",
            "quantity": 8,
            "total_weight_kg": "1.234",
            "total_cost": "1234567890.25",
        }})
        update = SimpleNamespace(message=_message("INV-EXACT"))

        result = await inventory.external_reference(update, context)

        self.assertEqual(result, inventory.INV_EXT_CONFIRM)
        text = update.message.reply_text.await_args.args[0]
        self.assertIn("1.234 kg", text)
        self.assertIn("1 234 567 890.25 so'm", text)

    async def test_decimal_scales_are_canonical_and_cost_is_limited_to_two_places(self):
        context = SimpleNamespace(user_data={"external_purchase": {}})
        update = SimpleNamespace(message=_message("00012.250"))
        self.assertEqual(await inventory.external_weight(update, context), inventory.INV_EXT_COST)
        self.assertEqual(context.user_data["external_purchase"]["total_weight_kg"], "12.25")
        update.message = _message("100.001")
        self.assertEqual(await inventory.external_cost(update, context), inventory.INV_EXT_COST)
        update.message = _message("00010.20")
        self.assertEqual(await inventory.external_cost(update, context), inventory.INV_EXT_REFERENCE)
        self.assertEqual(context.user_data["external_purchase"]["total_cost"], "10.2")

    async def test_confirm_uses_api_and_never_local_record_movement(self):
        query = SimpleNamespace(
            data="extconfirm:yes",
            answer=AsyncMock(),
            edit_message_text=AsyncMock(),
        )
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=7),
            callback_query=query,
        )
        state = {
            "product": {"id": 4, "name": "Import A"},
            "supplier": "Supplier",
            "quantity": 8,
            "total_weight_kg": 12.5,
            "total_cost": 90000,
            "receipt_reference": "INV-42",
        }
        context = SimpleNamespace(user_data={"external_purchase": state})
        with patch.object(inventory, "_is_external_purchase_allowed", return_value=True), \
             patch.object(inventory, "get_user_role",
                          return_value={"worker_name": "Omborchi"}), \
             patch.object(inventory, "receive_external_purchase",
                          return_value=(True, {"replayed": False})) as api, \
             patch.object(inventory, "record_movement") as local:
            result = await inventory.external_confirm_cb(update, context)
        self.assertEqual(result, inventory.INV_MAIN)
        api.assert_called_once()
        local.assert_not_called()

    async def test_non_omborchi_cannot_start(self):
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=7),
            message=_message(),
        )
        with patch.object(inventory, "_is_external_purchase_allowed", return_value=False):
            result = await inventory.external_purchase_start(
                update, SimpleNamespace(user_data={})
            )
        self.assertEqual(result, inventory.INV_MAIN)
