import io
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import fitz

BOT_ROOT = Path(__file__).resolve().parents[1]
PRINT_AGENT = BOT_ROOT / "print-agent"
if str(PRINT_AGENT) not in sys.path:
    sys.path.insert(0, str(PRINT_AGENT))

from config import ConfigError, load_config
import printer as printer_module
from printer import (
    PrintDeliveryError,
    PrintReceipt,
    require_named_printer,
    validate_100x80_media,
    validate_100x80_printable_area,
)
from vehicle_api import VehicleApiClient, VehicleApiError
from vehicle_print import (
    ConfirmationPending,
    PrintJobStore,
    VehiclePrintSafetyError,
    VehiclePrintService,
)

from bot.vehicle_label_pdf import build_batch_session_pdf


def _barcode(n: int) -> str:
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    return "TM" + ("A" * 15) + alphabet[n]


def _payload(handoff_id: int = 42, total: int = 2) -> dict:
    labels = []
    for index in range(1, total + 1):
        labels.append(
            {
                "productionLabelId": 100 + index,
                "handoffItemId": 200,
                "mahsulotId": 300,
                "barcodeValue": _barcode(index),
                "batchCode": f"VH-{handoff_id}",
                "labelType": "unit",
                "labelNumber": index,
                "totalLabels": total,
                "piecesInLabel": 1,
                "piecesPerBox": 1,
                "quantityTotal": total,
                "weightKg": 2.5,
                "lengthM": None,
                "productName": "Arqon A",
                "productSku": "SKU-A",
                "workerName": "TopMart Ombor",
                "producedAt": "2026-08-18T09:32:00Z",
                "warehouseId": 1,
                "warehouseName": "Main",
                "status": "created",
                "printCount": 0,
                "lastPrintedAt": None,
            }
        )
    return {
        "handoffId": handoff_id,
        "vehicleId": 7,
        "batchCode": f"VH-{handoff_id}",
        "totalLabels": total,
        "preparedActorType": "admin",
        "preparedActorRef": "test",
        "labels": labels,
    }


class _FakeApi:
    def __init__(self, payload: dict):
        self.payload = payload
        self.status = "prepared"
        self.prepared = False
        self.prepare_calls = []
        self.confirm_calls = []
        self.confirm_failures = 0

    def get_handoff(self, handoff_id: int):
        return {"id": handoff_id, "status": self.status}

    def get_labels(self, handoff_id: int):
        if not self.prepared:
            raise VehicleApiError(404, "Labels have not been prepared")
        return self.payload

    def prepare_labels(self, handoff_id: int, operation_key: str):
        self.prepare_calls.append((handoff_id, operation_key))
        self.prepared = True
        return self.payload

    def confirm_printed(self, handoff_id: int, operation_key: str):
        self.confirm_calls.append((handoff_id, operation_key))
        if self.confirm_failures > 0:
            self.confirm_failures -= 1
            raise VehicleApiError(None, "temporary timeout")
        is_reprint = self.status != "prepared"
        self.status = "labels_printed"
        return {
            "handoff": {"id": handoff_id, "status": self.status},
            "labels": self.payload,
            "isReprint": is_reprint,
            "atLeastOnce": True,
        }


class _FakePrinter:
    def __init__(self):
        self.calls = []
        self.fail = None

    def __call__(self, pdf_bytes, printer_name, *, document_name):
        self.calls.append((pdf_bytes, printer_name, document_name))
        if self.fail:
            raise self.fail
        pages = fitz.open(stream=pdf_bytes, filetype="pdf").page_count
        return PrintReceipt(printer_name, pages, 900 + len(self.calls))


class VehiclePrintAgentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.payload = _payload()
        self.api = _FakeApi(self.payload)
        self.printer = _FakePrinter()
        self.store = PrintJobStore(os.path.join(self.tmp.name, "jobs.sqlite3"))
        self.service = VehiclePrintService(
            self.api,
            self.store,
            "Zebra 100x80",
            renderer=build_batch_session_pdf,
            printer=self.printer,
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_prepare_print_confirm_and_same_message_deduplicate(self):
        first = self.service.print_handoff(42, 123, 456)
        self.assertEqual(first.page_count, 2)
        self.assertFalse(first.is_reprint)
        self.assertEqual(len(self.api.prepare_calls), 1)
        self.assertEqual(len(self.printer.calls), 1)
        self.assertEqual(len(self.api.confirm_calls), 1)
        pdf_bytes = self.printer.calls[0][0]
        self.assertTrue(pdf_bytes.startswith(b"%PDF"))

        replay = self.service.print_handoff(42, 123, 456)
        self.assertTrue(replay.deduplicated)
        self.assertEqual(replay.job_id, first.job_id)
        self.assertEqual(len(self.printer.calls), 1)
        self.assertEqual(len(self.api.confirm_calls), 1)

    def test_reprint_requires_explicit_command_and_reuses_same_pdf_identity(self):
        self.api.prepared = True
        first = self.service.print_handoff(42, 123, 1)
        with self.assertRaisesRegex(VehiclePrintSafetyError, "vehicle_reprint"):
            self.service.print_handoff(42, 123, 2)

        second = self.service.print_handoff(
            42, 123, 3, explicit_reprint=True
        )
        self.assertFalse(first.is_reprint)
        self.assertTrue(second.is_reprint)
        self.assertEqual(len(self.printer.calls), 2)
        self.assertEqual(self.printer.calls[0][0], self.printer.calls[1][0])

    def test_reprint_command_rejects_logically_unprinted_handoff(self):
        self.api.prepared = True
        with self.assertRaisesRegex(VehiclePrintSafetyError, "birinchi bosma"):
            self.service.print_handoff(
                42, 123, 4, explicit_reprint=True
            )
        self.assertEqual(self.printer.calls, [])

    def test_spooled_job_resumes_confirmation_without_reprinting(self):
        self.api.prepared = True
        self.api.confirm_failures = 1
        with self.assertRaises(ConfirmationPending) as caught:
            self.service.print_handoff(42, 123, 10)
        job_id = caught.exception.job_id
        self.assertEqual(len(self.printer.calls), 1)

        outcome = self.service.resume_confirmation(job_id)
        self.assertTrue(outcome.resumed)
        self.assertEqual(len(self.printer.calls), 1)
        self.assertEqual(len(self.api.confirm_calls), 2)
        self.assertEqual(
            self.api.confirm_calls[0][1],
            self.api.confirm_calls[1][1],
        )

    def test_print_failure_never_confirms_lifecycle(self):
        self.api.prepared = True
        self.printer.fail = PrintDeliveryError("offline")
        with self.assertRaises(PrintDeliveryError):
            self.service.print_handoff(42, 123, 20)
        self.assertEqual(self.api.confirm_calls, [])
        with self.assertRaises(VehiclePrintSafetyError):
            self.service.print_handoff(42, 123, 20)
        self.assertEqual(len(self.printer.calls), 1)

    def test_mismatched_handoff_payload_never_prints(self):
        self.api.prepared = True
        self.payload["handoffId"] = 99
        with self.assertRaisesRegex(VehiclePrintSafetyError, "boshqa handoff"):
            self.service.print_handoff(42, 123, 30)
        self.assertEqual(self.printer.calls, [])
        self.assertEqual(self.api.confirm_calls, [])

    def test_operator_can_recover_crash_window_without_reprint(self):
        row = self.store.create("crash-key", 42, "print")
        self.store.update(int(row["id"]), "printing", page_count=2)
        outcome = self.service.recover_ambiguous_confirmation(int(row["id"]))
        self.assertTrue(outcome.resumed)
        self.assertEqual(self.printer.calls, [])
        self.assertEqual(self.api.confirm_calls, [(42, "crash-key")])

    def test_cross_process_store_claim_allows_only_one_active_job(self):
        other_store = PrintJobStore(self.store.path)
        first = self.store.create("process-a", 42, "print")
        with self.assertRaises(sqlite3.IntegrityError):
            other_store.create("process-b", 42, "print")
        self.store.update(int(first["id"]), "failed")
        second = other_store.create("process-b", 42, "print")
        self.assertEqual(int(second["handoff_id"]), 42)

    def test_ambiguous_job_can_be_retried_only_by_explicit_job_command(self):
        self.api.prepared = True
        row = self.store.create("ambiguous-key", 42, "print")
        self.store.update(int(row["id"]), "ambiguous", page_count=2)
        outcome = self.service.retry_ambiguous(int(row["id"]), 123, 99)
        self.assertEqual(outcome.page_count, 2)
        self.assertEqual(len(self.printer.calls), 1)
        old = self.store.get_by_id(int(row["id"]))
        self.assertEqual(old["state"], "abandoned")


class FailClosedConfigTest(unittest.TestCase):
    def test_empty_allowlist_and_printer_fail_closed(self):
        with self.assertRaises(ConfigError) as caught:
            load_config(
                {
                    "TELEGRAM_BOT_TOKEN": "token",
                    "ALLOWED_CHAT_IDS": "",
                    "PRINTER_NAME": "",
                    "API_BASE_URL": "https://api.example/api",
                    "VEHICLE_DISTRIBUTION_BOT_KEY": "key",
                    "PRINT_JOB_DB": "jobs.sqlite3",
                }
            )
        self.assertIn("ALLOWED_CHAT_IDS", str(caught.exception))
        self.assertIn("PRINTER_NAME", str(caught.exception))

    def test_named_printer_must_exist_and_never_falls_back(self):
        with self.assertRaises(PrintDeliveryError):
            require_named_printer("", ["Default"])
        with self.assertRaises(PrintDeliveryError):
            require_named_printer("Zebra", ["Default"])
        self.assertEqual(
            require_named_printer("Zebra", ["Default", "Zebra"]),
            "Zebra",
        )

    def test_active_media_must_be_100x80_in_print_orientation(self):
        width, height = validate_100x80_media(799, 639, 203, 203)
        self.assertAlmostEqual(width, 100, delta=1)
        self.assertAlmostEqual(height, 80, delta=1)
        with self.assertRaises(PrintDeliveryError):
            validate_100x80_media(639, 799, 203, 203)
        with self.assertRaises(PrintDeliveryError):
            validate_100x80_media(2550, 3300, 300, 300)

    def test_printable_area_cannot_silently_scale_label_down(self):
        width, height = validate_100x80_printable_area(790, 630, 203, 203)
        self.assertGreaterEqual(width, 98)
        self.assertGreaterEqual(height, 78)
        with self.assertRaises(PrintDeliveryError):
            validate_100x80_printable_area(700, 600, 203, 203)

    def test_pdf_path_rasterizes_one_image_per_physical_page(self):
        pdf_bytes = build_batch_session_pdf(_payload(total=2)).read()
        receipt = PrintReceipt("Zebra", 2, 77)
        with mock.patch.object(
            printer_module, "_spool_images", return_value=receipt
        ) as spool:
            actual = printer_module.print_pdf(pdf_bytes, "Zebra")
        self.assertEqual(actual, receipt)
        images = spool.call_args.args[0]
        self.assertEqual(len(images), 2)
        self.assertTrue(all(image.size == (799, 639) for image in images))

    def test_vehicle_api_requires_https_except_loopback(self):
        with self.assertRaises(ValueError):
            VehicleApiClient("http://api.example/api", "key")
        VehicleApiClient("https://api.example/api", "key")
        VehicleApiClient("http://127.0.0.1:8080/api", "key")


if __name__ == "__main__":
    unittest.main()