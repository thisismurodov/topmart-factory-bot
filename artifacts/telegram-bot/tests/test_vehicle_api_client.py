"""F4 vehicle-distribution API client guard-tests.

Verify the dedicated-key helpers:
  - send the x-vehicle-distribution-bot-key header (NEVER the AI key),
  - hit the correct paths with a strict {operationKey} body,
  - surface API errors as (False, message).

No real network: urllib.request.urlopen is stubbed.
"""
import io
import json
import unittest
import urllib.error
from unittest import mock

from bot import api_client


class _FakeResp:
    def __init__(self, payload: dict):
        self._data = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class VehicleApiClientTest(unittest.TestCase):
    def setUp(self):
        # Deterministic config: distinct AI key and vehicle key.
        self._patches = [
            mock.patch.object(api_client, "API_BASE_URL", "http://api.test/api"),
            mock.patch.object(api_client, "AI_INTERNAL_KEY", "AI-KEY-SECRET"),
            mock.patch.object(
                api_client, "VEHICLE_DISTRIBUTION_BOT_KEY", "VEH-KEY-SECRET"
            ),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in self._patches:
            p.stop()

    def _capture(self, payload: dict):
        captured = {}

        def _fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            captured["headers"] = dict(req.header_items())
            captured["body"] = req.data
            return _FakeResp(payload)

        return captured, _fake_urlopen

    def test_prepare_uses_dedicated_key_and_never_ai_key(self):
        captured, fake = self._capture({"totalLabels": 3})
        with mock.patch("urllib.request.urlopen", fake):
            ok, data = api_client.prepare_handoff_labels(42, "op-1")
        self.assertTrue(ok)
        self.assertEqual(data["totalLabels"], 3)
        self.assertEqual(captured["method"], "POST")
        self.assertTrue(
            captured["url"].endswith(
                "/vehicle-distribution/handoffs/42/labels/prepare"
            )
        )
        # Header keys are capitalised by urllib — normalise.
        headers = {k.lower(): v for k, v in captured["headers"].items()}
        self.assertEqual(headers["x-vehicle-distribution-bot-key"], "VEH-KEY-SECRET")
        # The AI key must NOT leak anywhere.
        self.assertNotIn("authorization", headers)
        self.assertNotIn("AI-KEY-SECRET", json.dumps(headers))
        # Strict operationKey body.
        self.assertEqual(json.loads(captured["body"]), {"operationKey": "op-1"})

    def test_get_labels_is_get_with_dedicated_key(self):
        captured, fake = self._capture({"totalLabels": 0, "labels": []})
        with mock.patch("urllib.request.urlopen", fake):
            ok, data = api_client.get_handoff_labels(7)
        self.assertTrue(ok)
        self.assertEqual(captured["method"], "GET")
        self.assertIsNone(captured["body"])
        self.assertTrue(
            captured["url"].endswith("/vehicle-distribution/handoffs/7/labels")
        )
        headers = {k.lower(): v for k, v in captured["headers"].items()}
        self.assertEqual(headers["x-vehicle-distribution-bot-key"], "VEH-KEY-SECRET")

    def test_confirm_sends_operation_key(self):
        captured, fake = self._capture(
            {"handoff": {"status": "labels_printed"}, "isReprint": False,
             "atLeastOnce": True, "labels": []}
        )
        with mock.patch("urllib.request.urlopen", fake):
            ok, data = api_client.confirm_handoff_labels_printed(9, "recovery-key")
        self.assertTrue(ok)
        self.assertFalse(data["isReprint"])
        self.assertTrue(
            captured["url"].endswith(
                "/vehicle-distribution/handoffs/9/confirm-labels-printed"
            )
        )
        self.assertEqual(
            json.loads(captured["body"]), {"operationKey": "recovery-key"}
        )

    def test_confirm_recovery_key_is_idempotent_from_caller_view(self):
        # Reusing the same operationKey yields the same server response; the
        # caller sees a stable (ok, data). We assert the body carries the key
        # verbatim on both calls.
        bodies = []

        def _fake(req, timeout=None):
            bodies.append(json.loads(req.data))
            return _FakeResp({"atLeastOnce": True, "isReprint": True, "labels": []})

        with mock.patch("urllib.request.urlopen", _fake):
            api_client.confirm_handoff_labels_printed(9, "same-key")
            api_client.confirm_handoff_labels_printed(9, "same-key")
        self.assertEqual(bodies, [{"operationKey": "same-key"},
                                  {"operationKey": "same-key"}])

    def test_http_error_returns_false_with_message(self):
        def _raise(req, timeout=None):
            raise urllib.error.HTTPError(
                req.full_url, 409, "Conflict", {},
                io.BytesIO(json.dumps({"error": "already prepared"}).encode()),
            )

        with mock.patch("urllib.request.urlopen", _raise):
            ok, msg = api_client.prepare_handoff_labels(1, "k")
        self.assertFalse(ok)
        self.assertEqual(msg, "already prepared")

    def test_missing_vehicle_key_fails_closed(self):
        with mock.patch.object(api_client, "VEHICLE_DISTRIBUTION_BOT_KEY", ""):
            ok, msg = api_client.get_handoff_labels(1)
        self.assertFalse(ok)
        self.assertIn("VEHICLE_DISTRIBUTION_BOT_KEY", msg)


if __name__ == "__main__":
    unittest.main()
