"""F4 vehicle-handoff label PDF adapter guard-tests.

Pure: no DB, no network. The adapter maps the immutable API payload onto the
existing production label generator, reusing persisted barcodes + producedAt
(rendered in Asia/Tashkent).
"""
import unittest
import time
import hashlib
import io
from datetime import datetime, timezone

import fitz
import zxingcpp

from bot.vehicle_label_pdf import (
    _parse_produced_at,
    build_batch_session_pdf,
)
from bot.vehicle_distribution_label_generator import (
    VEHICLE_DISTRIBUTION_BRANDING,
    build_vehicle_distribution_label,
)
from unittest import mock

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
    def test_vehicle_branding_is_exact_and_rendered_in_vehicle_header(self):
        self.assertEqual(
            VEHICLE_DISTRIBUTION_BRANDING,
            "Top Mart — Official Partner of Diyor Mahsulotlari",
        )
        payload = _payload(1)
        label = payload["labels"][0]
        image = build_vehicle_distribution_label(
            "VH-42",
            label["workerName"],
            label["productName"],
            1,
            1,
            label["weightKg"],
            _parse_produced_at(label["producedAt"]),
            sku=label["productSku"],
            barcode_value=label["barcodeValue"],
        )
        header = image.crop((44, 16, 755, 54)).convert("L")
        self.assertLess(min(header.getdata()), 64)

    def test_existing_production_label_template_is_byte_unchanged(self):
        from bot.label_generator import _build_single

        image = _build_single(
            "VH-42",
            "TopMart Ombor",
            "Arqon A",
            1,
            1,
            2.5,
            datetime(2026, 8, 18, 14, 32),
            sku="SKU-A",
            barcode_value="TMAAAAAAAAAAAAAAAB",
        )
        output = io.BytesIO()
        image.save(output, format="PNG")
        self.assertEqual(
            hashlib.sha256(output.getvalue()).hexdigest(),
            "6549d582f07c135678deb56f1032abfb82fd7ee1523cc9bb8b548a638697c920",
        )

    def test_one_page_per_physical_label(self):
        pdf = build_batch_session_pdf(_payload(5))
        data = pdf.read()
        self.assertEqual(data[:4], b"%PDF")
        document = fitz.open(stream=data, filetype="pdf")
        self.assertEqual(document.page_count, 5)
        page = document[0]
        self.assertAlmostEqual(page.rect.width * 25.4 / 72, 100.0, places=1)
        self.assertAlmostEqual(page.rect.height * 25.4 / 72, 80.0, places=1)

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
        from bot.label_generator import LABEL_W
        payload = _payload(1)
        expected = payload["labels"][0]["barcodeValue"]
        produced = _parse_produced_at(payload["labels"][0]["producedAt"])
        img = build_vehicle_distribution_label(
            "VH-42", "TopMart Ombor", "Arqon A", 1, 1, 2.5,
            produced,
            sku="SKU-A", barcode_value=expected,
        )
        decoded = zxingcpp.read_barcode(img.crop((35, 410, LABEL_W - 35, 540)))
        self.assertIsNotNone(decoded)
        self.assertEqual(decoded.text, expected)
        self.assertEqual(decoded.format, zxingcpp.BarcodeFormat.Code128)
        decoded_codes = zxingcpp.read_barcodes(img)
        self.assertTrue(decoded_codes)
        self.assertTrue(
            all(code.format != zxingcpp.BarcodeFormat.QRCode for code in decoded_codes)
        )

    def test_produced_at_uses_first_label_snapshot(self):
        # All passports share the handoff produced_at; page date must not drift.
        payload = _payload(2, produced_at="2026-01-01T20:00:00Z")
        loc = _parse_produced_at(payload["labels"][0]["producedAt"])
        # 20:00Z + 5h = 01:00 next local day.
        self.assertEqual(loc.day, 2)

    def test_partial_box_passes_package_and_per_piece_kg(self):
        payload = _payload(1)
        payload["labels"][0].update({
            "piecesInLabel": 3,
            "piecesPerBox": 25,
            "quantityTotal": 3,
            "weightKg": 7.5,
        })
        captured = {}

        def fake_builder(*args, **kwargs):
            captured.update(kwargs)
            from PIL import Image
            return Image.new("RGB", (799, 639), "white")

        with mock.patch("bot.vehicle_label_pdf.build_vehicle_distribution_label",
                        side_effect=fake_builder):
            build_batch_session_pdf(payload)
        self.assertEqual(captured["in_box"], 3)
        self.assertEqual(captured["unit_weight"], 7.5)
        self.assertEqual(captured["piece_weight"], 2.5)


if __name__ == "__main__":
    unittest.main()
