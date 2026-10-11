"""No database, credentials, or polling: exercise the actual handler AST."""
import ast
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


class CatalogMessagesTests(unittest.TestCase):
    def setUp(self):
        path = Path(os.environ.get("CATALOG_SOURCE", Path(__file__).parents[1] / "main.py"))
        tree = ast.parse(path.read_text())
        nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef)
                 and n.name in ("_catalog_chunks", "mah_royxat")]
        for node in nodes:
            node.decorator_list = []
        self.bot = Mock()
        self.conn = Mock()
        self.ns = dict(bot=self.bot, get_db=lambda: self.conn,
                       is_admin=lambda uid: True, fmt=str,
                       mah_menu_kb=lambda: "keyboard")
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), "exec"), self.ns)

    def test_lossless_unicode_and_long_line(self):
        text = "📦" * 5000 + "\n" + "O‘zbek <nom> & *narx*\n" * 800
        chunks = self.ns["_catalog_chunks"](text)
        self.assertEqual("".join(chunks), text)
        self.assertTrue(all(0 < len(c.encode("utf-16-le")) // 2 <= 3500 for c in chunks))

    def test_large_catalog_handler(self):
        rows = [(i, f"Mahsulot 📦 {i}", 12345, "dona") for i in range(600)]
        self.conn.cursor.return_value.fetchall.return_value = rows
        self.ns["mah_royxat"](SimpleNamespace(from_user=SimpleNamespace(id=1)))
        calls = self.bot.send_message.call_args_list
        self.assertGreater(len(calls), 1)
        expected = "🛍 Mahsulotlar ro'yxati:\n\n" + "".join(
            f"  [{i}] {name} — {price}/{unit}\n" for i, name, price, unit in rows)
        self.assertEqual("".join(c.args[1] for c in calls), expected)
        self.assertTrue(all(len(c.args[1].encode("utf-16-le")) // 2 <= 3500 for c in calls))
        self.assertTrue(all(c.kwargs["reply_markup"] is None for c in calls[:-1]))
        self.assertEqual(calls[-1].kwargs["reply_markup"], "keyboard")
        self.conn.close.assert_called_once()

    def test_empty_and_unauthorized(self):
        self.conn.cursor.return_value.fetchall.return_value = []
        msg = SimpleNamespace(from_user=SimpleNamespace(id=1))
        self.ns["mah_royxat"](msg)
        self.assertIn("yo'q", self.bot.send_message.call_args.args[1])
        self.bot.reset_mock()
        self.ns["is_admin"] = lambda uid: False
        self.ns["mah_royxat"](msg)
        self.bot.send_message.assert_not_called()


if __name__ == "__main__":
    unittest.main()
