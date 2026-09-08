import json
import unittest
from unittest import mock

from bot import api_client


class _FakeResp:
    def __init__(self, payload):
        self._data = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class WarehouseApiClientTest(unittest.TestCase):
    def test_receipt_calls_use_only_dedicated_warehouse_key(self):
        captured = []

        def fake_urlopen(req, timeout=None):
            captured.append(req)
            return _FakeResp({"ok": True})

        with (
            mock.patch.object(api_client, "API_BASE_URL", "http://api.test/api"),
            mock.patch.object(api_client, "AI_INTERNAL_KEY", "broad-ai-key"),
            mock.patch.object(api_client, "WAREHOUSE_BOT_KEY", "warehouse-key"),
            mock.patch("urllib.request.urlopen", fake_urlopen),
        ):
            self.assertTrue(api_client.list_external_purchase_products(100)[0])
            self.assertTrue(api_client.receive_external_purchase(
                1, "Supplier", 2, "3.5", "400", "INV-1", 100
            )[0])

        self.assertEqual(len(captured), 2)
        for req in captured:
            headers = {key.lower(): value for key, value in req.header_items()}
            self.assertEqual(headers["x-warehouse-bot-key"], "warehouse-key")
            self.assertEqual(headers["x-telegram-chat-id"], "100")
            self.assertNotIn("x-internal-key", headers)

    def test_receipt_calls_fail_closed_without_warehouse_key(self):
        with (
            mock.patch.object(api_client, "API_BASE_URL", "http://api.test/api"),
            mock.patch.object(api_client, "WAREHOUSE_BOT_KEY", ""),
        ):
            ok, error = api_client.list_external_purchase_products(100)
        self.assertFalse(ok)
        self.assertIn("WAREHOUSE_BOT_KEY", error)