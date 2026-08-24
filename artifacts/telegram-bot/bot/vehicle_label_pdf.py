"""F4 vehicle-handoff label PDF adapter — PURE mapping, no I/O.

Maps the immutable label payload returned by the Node API
(GET /vehicle-distribution/handoffs/:id/labels or the confirm result) onto the
existing production label generator (generate_batch_session_pdf), producing one
100mm × 80mm page per physical label.

This module NEVER touches the database and NEVER generates barcodes — it only
reuses the persisted barcode values and the original produced_at timestamp
(rendered in Asia/Tashkent local time) already materialised server-side.
"""
from __future__ import annotations

import io
from datetime import datetime, timedelta, timezone

from .label_generator import generate_batch_session_pdf

_TASHKENT = timezone(timedelta(hours=5))


def _parse_produced_at(value: str) -> datetime:
    """Parse an ISO8601 producedAt into an Asia/Tashkent-local datetime.

    The API emits UTC ISO strings (…Z or +00:00). We convert to Tashkent so the
    printed date matches the workshop's local calendar day. Naive strings are
    treated as UTC.
    """
    raw = (value or "").strip()
    if not raw:
        raise ValueError("producedAt bo'sh — passport produced_at berilmadi")
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    dt = datetime.fromisoformat(raw)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(_TASHKENT)


def _passport_row(label: dict) -> dict:
    """Map one API label passport (camelCase) to a generator passport row
    (the snake_case shape generate_batch_session_pdf expects)."""
    barcode = str(label.get("barcodeValue") or "").strip()
    if not barcode:
        raise ValueError(
            "Passportda persisted barcode yo'q — etiketka chop etilmaydi"
        )
    length_m = label.get("lengthM")
    return {
        "label_number": int(label["labelNumber"]),
        "total_labels": int(label["totalLabels"]),
        "pieces_in_label": int(label.get("piecesInLabel") or 1),
        "pieces_per_box": int(label.get("piecesPerBox") or 1),
        "quantity_total": int(label["quantityTotal"]),
        "weight_kg": float(label.get("weightKg") or 0.0),
        "length_m": (float(length_m) if length_m is not None else None),
        "product_name": str(label.get("productName") or ""),
        "product_sku": str(label.get("productSku") or ""),
        "worker_name": str(label.get("workerName") or ""),
        "batch_code": str(label.get("batchCode") or ""),
        "barcode_value": barcode,
    }


def build_batch_session_pdf(payload: dict) -> io.BytesIO:
    """Render the full handoff label payload to a single multi-page PDF.

    payload is the object returned by prepare/get/confirm — it carries
    batchCode, totalLabels and a globally-ordered `labels` list. Because the F4
    passports use a single global 1..N numbering across all products, the whole
    payload is rendered as ONE generator item whose `labels` list is the ordered
    global passport set (the generator validates contiguity + total_labels).
    """
    labels = payload.get("labels")
    if not isinstance(labels, list) or not labels:
        raise ValueError("payloadda labels yo'q — chop etish uchun passport yo'q")

    ordered = sorted(labels, key=lambda row: int(row["labelNumber"]))
    declared_total = int(payload.get("totalLabels") or 0)
    if declared_total != len(ordered):
        raise ValueError(
            f"totalLabels={declared_total}, passportlar soni={len(ordered)}"
        )
    expected_numbers = list(range(1, declared_total + 1))
    actual_numbers = [int(row["labelNumber"]) for row in ordered]
    if actual_numbers != expected_numbers:
        raise ValueError(
            f"Passport labelNumber qiymatlari uzluksiz emas: {actual_numbers}"
        )
    expected_batch = str(payload.get("batchCode") or "").strip()
    if not expected_batch:
        raise ValueError("batchCode bo'sh — vehicle handoff aniqlanmadi")
    if any(str(row.get("batchCode") or "").strip() != expected_batch for row in ordered):
        raise ValueError("Passport batchCode qiymatlari handoff payloadga mos emas")
    barcode_values = [str(row.get("barcodeValue") or "").strip() for row in ordered]
    if len(set(barcode_values)) != len(barcode_values):
        raise ValueError("Bir xil persisted barcode bir necha passportda takrorlangan")
    produced_values = [str(row.get("producedAt") or "").strip() for row in ordered]
    if len(set(produced_values)) != 1:
        raise ValueError("Passport producedAt snapshotlari bir xil emas")

    passport_rows = [_passport_row(label) for label in ordered]

    # produced_at is identical across a handoff's passports (handoff.created_at
    # snapshot); take it from the first label.
    produced_at = _parse_produced_at(str(ordered[0].get("producedAt") or ""))
    batch_code = expected_batch
    worker = str(ordered[0].get("workerName") or "")

    item = {
        "product": passport_rows[0]["product_name"],
        "quantity": passport_rows[0]["quantity_total"],
        "weight_kg": passport_rows[0]["weight_kg"],
        "pieces_per_box": passport_rows[0]["pieces_per_box"],
        "sku": passport_rows[0]["product_sku"],
        "labels": passport_rows,
    }

    return generate_batch_session_pdf(
        batch_code=batch_code,
        worker=worker,
        items=[item],
        created_at=produced_at,
    )
