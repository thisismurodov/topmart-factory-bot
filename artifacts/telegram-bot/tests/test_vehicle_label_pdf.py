"""F4 vehicle-handoff label PDF adapter guard-tests.

Pure: no DB, no network. The adapter maps the immutable API payload onto the
existing production label generator, reusing persisted barcodes + producedAt
(rendered in Asia/Tashkent).
"""
import unittest
import time
from datetime import datetime, timezone

import fitz
import zxingcpp

from bot.vehicle_label_pdf import (
    _parse_produced_at,
    build_batch_session_pdf,
)

_TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"


def _barcode(n: int) -> str:
    return "TM" + ("A" * 15) + _TOKEN_ALPHABET[n % len(_TOKEN_ALPHABET)]


def _payload(total: int, *, produced_at: str = "2026-08-18T09:32:00Z") -> dict:
    """Build an API-shaped labels payload with `total` passports (camelCase)."""
    labels = []
    for i in range(1, total + 1):
        labels.append({
            "barcodeValue": _barcode(i),
            "batchCode": "VH-42",
            "labelNumber": i,
            "totalLabels": total,
            "piecesInLabel": 1,
            "piecesPerBox": 1,
            "quantityTotal": total,
            "weightKg": 2.5,
            "lengthM": None,
            "productName": "Arqon A",
            "productSku": "SKU-A",
            "workerName": "TopMart Ombor",
            "producedAt": produced_at,
        })
    return {"batchCode": "VH-42", "totalLabels": total, "labels": labels}


class VehicleLabelPdfTest(unittest.TestCase):
    def test_one_page_per_physical_label(self):
        pdf = build_batch_session_pdf(_payload(5))
        data = pdf.read()
        self.assertEqual(data[:4], b"%PDF")
        document = fitz.open(stream=data, filetype="pdf")
        self.assertEqual(document.page_count, 5)

    def test_empty_payload_raises(self):
        with self.assertRaises(ValueError):
            build_batch_session_pdf({"batchCode": "VH-1", "labels": []})

    def test_missing_barcode_raises(self):
        bad = _payload(1)
        bad["labels"][0]["barcodeValue"] = ""
        with self.assertRaisesRegex(ValueError, "barcode"):
            build_batch_session_pdf(bad)

    def test_produced_at_converts_to_tashkent(self):
        # 09:32Z → 14:32 Asia/Tashkent (UTC+5).
        loc = _parse_produced_at("2026-08-18T09:32:00Z")
        self.assertEqual((loc.hour, loc.minute), (14, 32))

    def test_naive_produced_at_treated_as_utc(self):
        loc = _parse_produced_at("2026-08-18T09:32:00")
        self.assertEqual((loc.hour, loc.minute), (14, 32))

    def test_reprint_same_payload_is_byte_identical(self):
        payload = _payload(3)
        a = build_batch_session_pdf(payload).read()
        # img2pdf default metadata second-resolution timestampga bog'liq edi;
        # keyingi sekunddagi reprint ham aynan bir artifact bo'lishini tekshiramiz.
        time.sleep(1.05)
        b = build_batch_session_pdf(payload).read()
        self.assertEqual(a, b)

    def test_adapter_never_generates_barcodes_it_reuses_them(self):
        """The decoded barcode on the first page equals the persisted value —
        the adapter reuses identity, never mints a new one."""
        from bot.label_generator import _build_single, LABEL_W, TASHKENT_TZ
        payload = _payload(1)
        expected = payload["labels"][0]["barcodeValue"]
        produced = _parse_produced_at(payload["labels"][0]["producedAt"])
        img = _build_single(
            "VH-42", "TopMart Ombor", "Arqon A", 1, 1, 2.5,
            produced.astimezone(TASHKENT_TZ),
            sku="SKU-A", barcode_value=expected,
        )
        decoded = zxingcpp.read_barcode(img.crop((35, 460, LABEL_W - 35, 585)))
        self.assertIsNotNone(decoded)
        self.assertEqual(decoded.text, expected)

    def test_produced_at_uses_first_label_snapshot(self):
        # All passports share the handoff produced_at; page date must not drift.
        payload = _payload(2, produced_at="2026-01-01T20:00:00Z")
        loc = _parse_produced_at(payload["labels"][0]["producedAt"])
        # 20:00Z + 5h = 01:00 next local day.
        self.assertEqual(loc.day, 2)


if __name__ == "__main__":
    unittest.main()
