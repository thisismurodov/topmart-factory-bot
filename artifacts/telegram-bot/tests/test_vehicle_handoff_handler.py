"""Focused safety tests for the DM-001 Telegram conversation (cart flow)."""
import io
import unittest
from contextlib import ExitStack
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from telegram.ext import CallbackQueryHandler, ConversationHandler

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


def _ctx(state):
    return SimpleNamespace(user_data={"vh": state})


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
        context = _ctx({"token": "new-token"})
        with patch.object(vh, "_admin", return_value=True):
            state, _ = vh._valid(query, context)
        self.assertIsNone(state)

    async def test_quantity_must_be_positive_integer(self):
        update = SimpleNamespace(effective_user=SimpleNamespace(id=10), message=_message("0"))
        context = _ctx({"pending_product": {"available_quantity": 4}})
        with patch.object(vh, "_admin", return_value=True):
            state = await vh.enter_quantity(update, context)
        self.assertEqual(state, vh.QUANTITY)
        update.message.reply_text.assert_awaited_once()

    async def test_weight_allows_at_most_three_decimal_places(self):
        update = SimpleNamespace(effective_user=SimpleNamespace(id=10), message=_message("1.2345"))
        context = _ctx({})
        with patch.object(vh, "_admin", return_value=True):
            state = await vh.enter_weight(update, context)
        self.assertEqual(state, vh.WEIGHT)
        update.message.reply_text.assert_awaited_once()

    async def test_warehouse_selector_shows_hidden_reasons(self):
        query = _query("vh:tok:new")
        context = _ctx({"token": "tok", "done": set()})
        warehouses = [
            {"id": 1, "name": "Tayyor A", "eligible": True, "reason": None},
            {"id": 2, "name": "C-05", "eligible": False, "reason": "dona qoldiq yo‘q"},
            {"id": 3, "name": "Xomashyo", "eligible": False,
             "reason": "tayyor mahsulot ombori emas"},
        ]
        with patch.object(vh, "_admin", return_value=True), \
             patch.object(vh, "get_vehicle_handoff_source_warehouses",
                          return_value=warehouses):
            state = await vh.menu_callback(SimpleNamespace(callback_query=query), context)
        self.assertEqual(state, vh.SOURCE)
        text = query.edit_message_text.await_args.args[0]
        self.assertIn("C-05", text)
        self.assertIn("dona qoldiq yo‘q", text)
        self.assertIn("tayyor mahsulot ombori emas", text)
        keyboard = query.edit_message_text.await_args.kwargs["reply_markup"].inline_keyboard
        # 1 eligible warehouse button + cancel — hidden ones are NOT selectable.
        self.assertEqual(len(keyboard), 2)
        self.assertEqual(keyboard[0][0].text, "Tayyor A")

    async def test_no_eligible_warehouse_still_lists_reasons(self):
        query = _query("vh:tok:new")
        context = _ctx({"token": "tok", "done": set()})
        warehouses = [
            {"id": 2, "name": "C-05", "eligible": False, "reason": "dona qoldiq yo‘q"},
        ]
        with patch.object(vh, "_admin", return_value=True), \
             patch.object(vh, "get_vehicle_handoff_source_warehouses",
                          return_value=warehouses):
            state = await vh.menu_callback(SimpleNamespace(callback_query=query), context)
        self.assertEqual(state, ConversationHandler.END)
        text = query.edit_message_text.await_args.args[0]
        self.assertIn("C-05", text)
        self.assertIn("dona qoldiq yo‘q", text)

    async def test_weight_entry_appends_item_and_shows_cart(self):
        update = SimpleNamespace(effective_user=SimpleNamespace(id=10), message=_message("7.5"))
        state = {
            "token": "tok", "done": set(),
            "warehouse": {"id": 4, "name": "A"},
            "cart": [],
            "pending_product": {"mahsulot_id": 29, "name": "P",
                                "unit_weight_kg": 2.5, "available_quantity": 10},
            "pending_qty": 3,
        }
        with patch.object(vh, "_admin", return_value=True):
            result = await vh.enter_weight(update, _ctx(state))
        self.assertEqual(result, vh.CART)
        self.assertEqual(state["cart"], [
            {"mahsulot_id": 29, "name": "P", "quantity": 3, "weight": 7.5},
        ])
        self.assertNotIn("pending_product", state)
        self.assertNotIn("pending_qty", state)

    async def test_finish_prices_cart_with_savdo_prices(self):
        query = _query("vh:tok:finish")
        state = {
            "token": "tok", "done": set(),
            "warehouse": {"id": 4, "name": "A"},
            "cart": [
                {"mahsulot_id": 29, "name": "P", "quantity": 3, "weight": 7.5},
                {"mahsulot_id": 31, "name": "Q", "quantity": 2, "weight": 1.0},
            ],
        }
        with patch.object(vh, "_admin", return_value=True), \
             patch.object(vh, "get_mahsulot_prices",
                          return_value={29: 4500.0}) as prices:
            result = await vh.cart_callback(
                SimpleNamespace(callback_query=query), _ctx(state))
        self.assertEqual(result, vh.REVIEW)
        prices.assert_called_once_with([29, 31])
        text = query.edit_message_text.await_args.args[0]
        # 3 × 4 500 = 13 500 so‘m; Q has no savdo price → explicit warning.
        self.assertIn("13 500 so‘m", text)
        self.assertIn("Narxi yo‘q", text)
        self.assertIn("Q", text)

    async def test_fractional_decimal_prices_round_half_up_exactly(self):
        """NUMERIC narx Decimal bo'lib keladi; kasr narxda float xatosi bo'lmasin."""
        query = _query("vh:tok:finish")
        state = {
            "token": "tok", "done": set(),
            "warehouse": {"id": 4, "name": "A"},
            "cart": [{"mahsulot_id": 29, "name": "P", "quantity": 3, "weight": 7.5}],
        }
        with patch.object(vh, "_admin", return_value=True), \
             patch.object(vh, "get_mahsulot_prices",
                          return_value={29: Decimal("4500.5")}):
            result = await vh.cart_callback(
                SimpleNamespace(callback_query=query), _ctx(state))
        self.assertEqual(result, vh.REVIEW)
        text = query.edit_message_text.await_args.args[0]
        # 3 × 4500.5 = 13501.5 → HALF_UP → 13 502 (hech qachon 13 501.499…)
        self.assertIn("13 502 so‘m", text)
        # Per-line narx ham HALF_UP: 4500.5 → 4 501 so‘m
        self.assertIn("4 501 so‘m × 3", text)

    async def test_all_callback_states_reject_stale_token_without_side_effects(self):
        """Persisted eski suhbatlar (state indekslari siljigan) xavfsiz tugashi shart.

        Har bir holatdagi HAR BIR callback handler eskirgan token bilan
        chaqirilganda: hech qanday API chaqiruvsiz, holatni oldinga surmasdan
        suhbatni tugatadi. Bu CART kabi yangi holat qo'shilganda eski pickle
        qilingan suhbatlar noto'g'ri handlerga tushsa ham zarar yo'qligini pinlaydi.
        """
        handler = vh.build_vehicle_handoff_handler()
        # Mutatsiyalar: eskirgan token bilan HECH QACHON chaqirilmasligi shart.
        mutation_fns = [
            "create_vehicle_handoff", "prepare_handoff_labels",
            "confirm_handoff_labels_printed", "mark_handoff_handed_over",
            "mark_handoff_stock_transferred",
        ]
        # O'qishlar: chaqirilishi mumkin (masalan catch-all ro'yxatni qayta
        # ko'rsatadi) — lekin tarmoqqa chiqmasin deb benign mock qilamiz.
        read_fns = {
            "list_vehicle_handoffs": (True, []),
            "get_vehicle_handoff": (True, {}),
            "get_handoff_labels": (True, {"totalLabels": 0, "labels": []}),
            "get_vehicle_handoff_products": [],
            "get_vehicle_handoff_hidden_products": [],
            "get_vehicle_handoff_source_warehouses": [],
            "get_mahsulot_prices": {},
        }
        checked = 0
        with ExitStack() as es:
            es.enter_context(patch.object(vh, "_admin", return_value=True))
            mocks = {
                fn: es.enter_context(patch.object(vh, fn))
                for fn in mutation_fns if hasattr(vh, fn)
            }
            for fn, ret in read_fns.items():
                if hasattr(vh, fn):
                    es.enter_context(patch.object(vh, fn, return_value=ret))
            for state_id, handlers in handler.states.items():
                for h in handlers:
                    if not isinstance(h, CallbackQueryHandler):
                        continue
                    for payload in ("create", "finish", "new", "do:stock:8", "cancel"):
                        data = f"vh:STALE-TOKEN:{payload}"
                        # Haqiqiy dispatchni aks ettiramiz: PTB pattern mos
                        # kelmagan update'ni handlerga bermaydi.
                        if not h.pattern.match(data):
                            continue
                        query = _query(data)
                        ctx = _ctx({
                            "token": "CURRENT-TOKEN", "done": set(),
                            "warehouse": {"id": 4, "name": "A"},
                            "cart": [{"mahsulot_id": 29, "name": "P",
                                      "quantity": 1, "weight": 1.0}],
                        })
                        result = await h.callback(
                            SimpleNamespace(callback_query=query), ctx)
                        # END, joyida qolish yoki hub'ga (MENU / EXISTING
                        # ro'yxati) qaytish mumkin — lekin ish oqimida OLDINGA
                        # siljish (SOURCE→…→REVIEW yoki lifecycle ijro) taqiq.
                        self.assertIn(
                            result,
                            (ConversationHandler.END, state_id, vh.MENU, vh.EXISTING),
                            f"state={state_id} payload={payload}: eskirgan token "
                            f"holatni {result!r} ga surdi",
                        )
                        checked += 1
            for fn, m in mocks.items():
                self.assertFalse(
                    m.called, f"{fn} eskirgan token bilan chaqirildi!")
        self.assertGreater(checked, 10, "callback handlerlar topilmadi — test vakuum")

    def test_shifted_old_review_create_lands_on_stale_callback(self):
        """Eski pickle: REVIEW numeric 5 edi; yangi 5 = CART. Token user_data
        bilan birga saqlangani uchun mos kelishi mumkin — shuning uchun eski
        'create' tugmasi CART holatida stale_callback'ga (END) tushishi SHART,
        cart_callback yoki create yo'liga emas."""
        handler = vh.build_vehicle_handoff_handler()
        data = "vh:tok:create"
        matching = [h for h in handler.states[vh.CART] if h.pattern.match(data)]
        self.assertTrue(matching, "CART holatida 'create' hech kimga tushmayapti")
        self.assertIs(matching[0].callback, vh.stale_callback)

    def test_review_state_ignores_old_existing_payloads(self):
        """Eski EXISTING numeric 6 edi; yangi 6 = REVIEW. REVIEWda ^vh: catch-all
        yo'q — eski ro'yxat/lifecycle tugmalari umuman match bo'lmasligi shart."""
        handler = vh.build_vehicle_handoff_handler()
        for data in ("vh:tok:hd:14", "vh:tok:warn:stock:14",
                     "vh:tok:do:stock:14", "vh:tok:refresh"):
            hits = [h for h in handler.states[vh.REVIEW] if h.pattern.match(data)]
            self.assertFalse(hits, f"REVIEW eski payloadni ushladi: {data}")

    async def test_shifted_old_warning_do_tap_cannot_execute_lifecycle(self):
        """Eski WARNING numeric 7 edi; yangi 7 = EXISTING (catch-all existing_callback).
        Token mos kelsa ham 'do:stock:N' u yerdan lifecycle BAJARMASLIGI shart."""
        query = _query("vh:tok:do:stock:8")
        state = {"token": "tok", "done": set()}
        with patch.object(vh, "_admin", return_value=True), \
             patch.object(vh, "mark_handoff_stock_transferred") as transfer, \
             patch.object(vh, "mark_handoff_handed_over") as handed, \
             patch.object(vh, "confirm_handoff_labels_printed") as printed, \
             patch.object(vh, "list_vehicle_handoffs", return_value=(True, [])):
            result = await vh.existing_callback(
                SimpleNamespace(callback_query=query), _ctx(state))
        transfer.assert_not_called()
        handed.assert_not_called()
        printed.assert_not_called()
        self.assertIn(result, (ConversationHandler.END, vh.EXISTING))

    async def test_finish_with_empty_cart_is_rejected(self):
        query = _query("vh:tok:finish")
        state = {"token": "tok", "done": set(), "cart": []}
        with patch.object(vh, "_admin", return_value=True), \
             patch.object(vh, "get_mahsulot_prices") as prices:
            result = await vh.cart_callback(
                SimpleNamespace(callback_query=query), _ctx(state))
        self.assertEqual(result, vh.CART)
        prices.assert_not_called()

    async def test_drop_removes_only_last_item(self):
        query = _query("vh:tok:drop")
        state = {
            "token": "tok", "done": set(),
            "warehouse": {"id": 4, "name": "A"},
            "cart": [
                {"mahsulot_id": 29, "name": "P", "quantity": 3, "weight": 7.5},
                {"mahsulot_id": 31, "name": "Q", "quantity": 1, "weight": 2.0},
            ],
        }
        with patch.object(vh, "_admin", return_value=True):
            result = await vh.cart_callback(
                SimpleNamespace(callback_query=query), _ctx(state))
        self.assertEqual(result, vh.CART)
        self.assertEqual([it["mahsulot_id"] for it in state["cart"]], [29])

    async def test_duplicate_create_is_not_sent_twice(self):
        query = _query("vh:tok:create")
        state = {"token": "tok", "done": {"create"},
                 "cart": [{"mahsulot_id": 29, "name": "P", "quantity": 3, "weight": 7.5}]}
        with patch.object(vh, "_admin", return_value=True), \
             patch.object(vh, "create_vehicle_handoff") as create:
            result = await vh.confirm_create(
                SimpleNamespace(callback_query=query), _ctx(state)
            )
        self.assertEqual(result, vh.REVIEW)
        create.assert_not_called()

    async def test_pdf_send_never_confirms_printed(self):
        query = _query("vh:tok:create")
        state = {
            "token": "tok", "done": set(),
            "warehouse": {"id": 4, "name": "A"},
            "cart": [{"mahsulot_id": 29, "name": "P", "quantity": 3, "weight": 7.5}],
            "prices": {29: 4500.0},
        }
        labels = {"totalLabels": 1, "labels": []}
        with patch.object(vh, "_admin", return_value=True), \
             patch.object(vh, "create_vehicle_handoff", return_value=(True, {"id": 8})) as create, \
             patch.object(vh, "prepare_handoff_labels", return_value=(True, labels)), \
             patch.object(vh, "get_handoff_labels", return_value=(True, labels)), \
             patch.object(vh, "build_batch_session_pdf", return_value=io.BytesIO(b"%PDF")), \
             patch.object(vh, "confirm_handoff_labels_printed") as confirm:
            result = await vh.confirm_create(
                SimpleNamespace(callback_query=query), _ctx(state)
            )
        self.assertEqual(result, vh.EXISTING)
        create.assert_called_once_with(
            4,
            [{"mahsulot_id": 29, "quantity": 3, "weight": 7.5}],
            "telegram-factory:create:tok",
            "Telegram factory bot; 1 ta tovar; operator jami kg: 7.5",
        )
        # Success message carries the savdo-priced total.
        success_text = query.edit_message_text.await_args.args[0]
        self.assertIn("13 500 so‘m", success_text)
        query.message.reply_document.assert_awaited_once()
        confirm.assert_not_called()

    async def test_lifecycle_warning_does_not_perform_transition(self):
        query = _query("vh:tok:warn:stock:8")
        state = {"token": "tok", "done": set()}
        with patch.object(vh, "_admin", return_value=True), \
             patch.object(vh, "mark_handoff_stock_transferred") as transfer:
            result = await vh.warning_callback(
                SimpleNamespace(callback_query=query), _ctx(state)
            )
        self.assertEqual(result, vh.WARNING)
        transfer.assert_not_called()
        keyboard = query.edit_message_text.await_args.kwargs["reply_markup"]
        self.assertEqual(keyboard.inline_keyboard[0][0].callback_data, "vh:tok:do:stock:8")


if __name__ == "__main__":
    unittest.main()
