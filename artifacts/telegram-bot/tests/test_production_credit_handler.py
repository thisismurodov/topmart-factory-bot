import ast
import math
from pathlib import Path
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock


class CreditConfirmationHandlerTest(IsolatedAsyncioTestCase):
    async def test_missing_weight_input_validates_and_resumes_quote(self):
        tree = ast.parse((Path(__file__).parents[1] / "bot/handlers/input_handler.py").read_text())
        fn = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef)
                  and n.name == "enter_credit_weight")
        fn.returns = None
        for arg in fn.args.args:
            arg.annotation = None
        prepare = AsyncMock(return_value=7)
        ns = {"math": math, "_prepare_credit": prepare, "CREDIT_WEIGHT": 8}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), "weight", "exec"), ns)
        data = {"items": [{"weight_kg": 0}], "credit_weight_index": 0}
        for text in ("nan", "inf", "0", "-1", "0.00001"):
            update = SimpleNamespace(message=SimpleNamespace(text=text, reply_text=AsyncMock()))
            self.assertEqual(await ns["enter_credit_weight"](update, SimpleNamespace(user_data=data)), 8)
            prepare.assert_not_awaited()
        update.message.text = "0,75"
        self.assertEqual(await ns["enter_credit_weight"](update, SimpleNamespace(user_data=data)), 7)
        self.assertEqual(data["items"][0]["weight_kg"], 0.75)
        prepare.assert_awaited_once()

    async def run_handler(self, action, data):
        tree = ast.parse((Path(__file__).parents[1] / "bot/handlers/input_handler.py").read_text())
        fn = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef)
                  and n.name == "confirm_credit")
        fn.returns = None
        for arg in fn.args.args:
            arg.annotation = None
        save = AsyncMock(return_value=-1)
        ns = {"_finalize": save, "get_containers": lambda: [],
              "containers_inline_keyboard": lambda x: x, "CHOOSE_CONTAINER": 5}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), "handler", "exec"), ns)
        query = SimpleNamespace(data=action, answer=AsyncMock(),
            edit_message_reply_markup=AsyncMock(),
            message=SimpleNamespace(reply_text=AsyncMock()))
        result = await ns["confirm_credit"](
            SimpleNamespace(callback_query=query), SimpleNamespace(user_data=data))
        return result, save

    async def test_only_confirmation_calls_save(self):
        quote = {"total": "100"}
        data = {"pending_credit_quote": quote}
        _, save = await self.run_handler("credit_ok", data)
        save.assert_awaited_once()
        self.assertEqual(data["credit_quote"], quote)

    async def test_back_never_saves(self):
        data = {"pending_credit_quote": {}, "credit_operation_key": "key"}
        result, save = await self.run_handler("credit_back", data)
        save.assert_not_awaited()
        self.assertEqual(result, 5)
        self.assertNotIn("credit_operation_key", data)

    async def test_stale_confirmation_never_saves(self):
        result, save = await self.run_handler("credit_ok", {})
        save.assert_not_awaited()
        self.assertEqual(result, 5)
