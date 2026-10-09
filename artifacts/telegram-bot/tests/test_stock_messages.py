import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from bot.handlers import inventory


class StockMessageTests(unittest.IsolatedAsyncioTestCase):
    def test_boundaries_and_no_loss(self):
        for text in ("", "a" * 3500, "b" * 10000, "📦" * 5000,
                     ("C-03\nMahsulot_[*] — 25 dona\n" * 1000)):
            chunks = inventory._stock_message_chunks(text)
            self.assertEqual("".join(chunks), text)
            self.assertTrue(all(0 < len(c.encode("utf-16-le")) // 2 <= 3500 for c in chunks))

    async def test_large_report_sends_every_product_without_markdown(self):
        update = SimpleNamespace(message=SimpleNamespace(reply_text=AsyncMock()),
                                 effective_chat=SimpleNamespace(id=7))
        data = {
            "finished": [{"warehouse_name": "C-03", "product": f"Mahsulot_[{n}]*"}
                         for n in range(500)],
            "raw": [{"warehouse_name": "C-17", "product": "Xom_ashyo[*]"}],
        }
        with patch.object(inventory, "get_stock_by_warehouse_typed", return_value=data), \
             patch.object(inventory, "_stock_line", return_value="25 dona"):
            result = await inventory.qoldiqlar(update, None)
        self.assertEqual(result, inventory.INV_MAIN)
        calls = update.message.reply_text.await_args_list
        self.assertGreater(len(calls), 1)
        joined = "".join(c.args[0] for c in calls)
        for item in data["finished"] + data["raw"]:
            self.assertEqual(joined.count(item["product"]), 1)
        for call in calls:
            self.assertIsNone(call.kwargs["parse_mode"])
            self.assertLessEqual(len(call.args[0].encode("utf-16-le")) // 2, 3500)
        self.assertIsNotNone(calls[-1].kwargs["reply_markup"])

    async def test_empty_stock_has_one_reply(self):
        update = SimpleNamespace(message=SimpleNamespace(reply_text=AsyncMock()))
        with patch.object(inventory, "get_stock_by_warehouse_typed", return_value={}):
            self.assertEqual(await inventory.qoldiqlar(update, None), inventory.INV_MAIN)
        update.message.reply_text.assert_awaited_once()
