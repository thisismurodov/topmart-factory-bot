"""Focused safety tests for the DM-001 Telegram conversation."""
import io
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from telegram.ext import ConversationHandler

from bot.handlers import vehicle_handoff as vh


def _message(text=""):
    return SimpleNamespace(
        text=text,
        reply_text=AsyncMock(),
        reply_document=AsyncMock(),
    )


def _query(data):
    msg = _message()
    return SimpleNamespace(
        data=data,
        from_user=SimpleNamespace(id=10),
        message=msg,
        answer=AsyncMock(),
        edit_message_text=AsyncMock(),
    )


class VehicleHandoffSafetyTest(unittest.IsolatedAsyncioTestCase):
    async def test_non_admin_cannot_start(self):
        update = SimpleNamespace(
            effective_user=SimpleNamespace(id=99),
            effective_chat=SimpleNamespace(id=99),
            update_id=1,
            message=_message(),
        )
        with patch.object(vh, "_admin", return_value=False):
            state = await vh.start(update, SimpleNamespace(user_data={}))
        self.assertEqual(state, ConversationHandler.END)
        update.message.reply_text.assert_awaited_once()

    def test_stale_token_is_rejected_before_callback_data_is_used(self):
        query = _query("vh:old-token:create")
        context = SimpleNamespace(user_data={"vh": {"token": "new-token"}})
        with patch.object(vh, "_admin", return_value=True):
            state, _ = vh._valid(query, context)
        self.assertIsNone(state)

    async def test_quantity_must_be_positive_integer(self):
        update = SimpleNamespace(effective_user=SimpleNamespace(id=10), message=_message("0"))
        context = SimpleNamespace(user_data={"vh": {"product": {"available_quantity": 4}}})
        with patch.object(vh, "_admin", return_value=True):
            state = await vh.enter_quantity(update, context)
        self.assertEqual(state, vh.QUANTITY)
        update.message.reply_text.assert_awaited_once()

    async def test_weight_allows_at_most_three_decimal_places(self):
        update = SimpleNamespace(effective_user=SimpleNamespace(id=10), message=_message("1.2345"))
        context = SimpleNamespace(user_data={"vh": {}})
        with patch.object(vh, "_admin", return_value=True):
            state = await vh.enter_weight(update, context)
        self.assertEqual(state, vh.WEIGHT)
        update.message.reply_text.assert_awaited_once()

    async def test_duplicate_create_is_not_sent_twice(self):
        query = _query("vh:tok:create")
        state = {"token": "tok", "done": {"create"}}
        with patch.object(vh, "_admin", return_value=True), \
             patch.object(vh, "create_vehicle_handoff") as create:
            result = await vh.confirm_create(
                SimpleNamespace(callback_query=query), SimpleNamespace(user_data={"vh": state})
            )
        self.assertEqual(result, vh.REVIEW)
        create.assert_not_called()

    async def test_pdf_send_never_confirms_printed(self):
        query = _query("vh:tok:create")
        state = {
            "token": "tok", "done": set(),
            "warehouse": {"id": 4, "name": "A"},
            "product": {"mahsulot_id": 29, "name": "P"},
            "quantity": 3, "weight": 7.5,
        }
        labels = {"totalLabels": 1, "labels": []}
        with patch.object(vh, "_admin", return_value=True), \
             patch.object(vh, "create_vehicle_handoff", return_value=(True, {"id": 8})) as create, \
             patch.object(vh, "prepare_handoff_labels", return_value=(True, labels)), \
             patch.object(vh, "get_handoff_labels", return_value=(True, labels)), \
             patch.object(vh, "build_batch_session_pdf", return_value=io.BytesIO(b"%PDF")), \
             patch.object(vh, "confirm_handoff_labels_printed") as confirm:
            result = await vh.confirm_create(
                SimpleNamespace(callback_query=query), SimpleNamespace(user_data={"vh": state})
            )
        self.assertEqual(result, vh.EXISTING)
        create.assert_called_once_with(4, 29, 3, 7.5, "telegram-factory:create:tok",
                                       "Telegram factory bot; operator total kg: 7.5")
        query.message.reply_document.assert_awaited_once()
        confirm.assert_not_called()

    async def test_lifecycle_warning_does_not_perform_transition(self):
        query = _query("vh:tok:warn:stock:8")
        state = {"token": "tok", "done": set()}
        with patch.object(vh, "_admin", return_value=True), \
             patch.object(vh, "mark_handoff_stock_transferred") as transfer:
            result = await vh.warning_callback(
                SimpleNamespace(callback_query=query), SimpleNamespace(user_data={"vh": state})
            )
        self.assertEqual(result, vh.WARNING)
        transfer.assert_not_called()
        keyboard = query.edit_message_text.await_args.kwargs["reply_markup"]
        self.assertEqual(keyboard.inline_keyboard[0][0].callback_data, "vh:tok:do:stock:8")


if __name__ == "__main__":
    unittest.main()