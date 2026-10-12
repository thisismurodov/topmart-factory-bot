"""No database writes: exercise the correction conversation with mocked I/O."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from bot.handlers import inventory


class AdjustWeightTests(unittest.IsolatedAsyncioTestCase):
    async def test_client_uses_warehouse_transport_with_actor_and_weight(self):
        from bot import api_client
        with patch.object(api_client, "_warehouse_request", return_value=(True, {"ok": True})) as transport:
            self.assertEqual(api_client.adjust_inventory(
                9, "Test gloves", 1200, weight_kg=30.6, chat_id=7,
            ), (True, None))
            self.assertEqual(transport.call_args.args[:2], ("POST", "/ombor/adjust"))
            self.assertEqual(transport.call_args.args[2]["weightKg"], 30.6)
            self.assertEqual(transport.call_args.kwargs["chat_id"], 7)

    def context(self, unit="dona"):
        return SimpleNamespace(user_data={
            "adj_unit": unit, "adj_wh_id": 9, "adj_wh_name": "C-03",
            "adj_product": "Test gloves", "adj_old_qty": 1200,
            "adj_old_weight": 25.5, "adj_qty": 1200,
        })

    def update(self, text=""):
        return SimpleNamespace(
            effective_chat=SimpleNamespace(id=7),
            message=SimpleNamespace(text=text, reply_text=AsyncMock()),
            callback_query=SimpleNamespace(
                data="aconfirm:yes", answer=AsyncMock(), edit_message_text=AsyncMock()),
        )

    async def test_both_units_prompt_weight_and_send_exact_total(self):
        for unit in ("dona", "kg"):
            with self.subTest(unit=unit):
                ctx = self.context(unit)
                update = self.update("1200")
                state = await getattr(inventory.adjust_qty, "__wrapped__", inventory.adjust_qty)(update, ctx)
                self.assertEqual(state, inventory.INV_ADJ_WEIGHT)
                update.message.text = "30.6"
                state = await getattr(inventory.adjust_weight, "__wrapped__", inventory.adjust_weight)(update, ctx)
                self.assertEqual(state, inventory.INV_ADJ_CONFIRM)
                text = update.message.reply_text.await_args.args[0]
                self.assertIn("25.5", text)
                self.assertIn("30.6", text)
                with patch.object(inventory, "get_user_role", return_value=None), \
                     patch.object(inventory, "adjust_inventory", return_value=(True, None)) as api:
                    await getattr(inventory.adjust_confirm_cb, "__wrapped__", inventory.adjust_confirm_cb)(update, ctx)
                    self.assertEqual(api.call_args.kwargs["weight_kg"], 30.6)
                    self.assertEqual(api.call_args.kwargs["qty"], 1200)
                    self.assertEqual(api.call_args.kwargs["chat_id"], 7)
                self.assertIn("30.6 kg", update.callback_query.edit_message_text.await_args.args[0])

    async def test_invalid_weight_stays_on_input_without_calling_api(self):
        for text in ("-1", "nan", "inf", "0.0255", "wrong"):
            ctx = self.context()
            self.assertEqual(
                await getattr(inventory.adjust_weight, "__wrapped__", inventory.adjust_weight)(self.update(text), ctx),
                inventory.INV_ADJ_WEIGHT,
            )
            self.assertNotIn("adj_weight", ctx.user_data)

    async def test_zero_weight_is_explicit_and_cancel_never_writes(self):
        ctx = self.context()
        update = self.update("0")
        await getattr(inventory.adjust_weight, "__wrapped__", inventory.adjust_weight)(update, ctx)
        self.assertEqual(ctx.user_data["adj_weight"], 0)
        update.callback_query.data = "aconfirm:no"
        with patch.object(inventory, "adjust_inventory") as api:
            await getattr(inventory.adjust_confirm_cb, "__wrapped__", inventory.adjust_confirm_cb)(update, ctx)
            api.assert_not_called()


if __name__ == "__main__":
    unittest.main()
