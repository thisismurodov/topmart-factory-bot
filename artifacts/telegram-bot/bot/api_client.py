"""Node API'ga umumiy HTTP so'rovlar (AI'dan tashqari endpointlar).

Bot inventarni to'g'ridan-to'g'ri o'zgartirmaydi — Node API orqali o'tadi, shunda
og'irlik (kg) halol qoladi va stock_movement log qilinadi.
"""
import json
import logging
import urllib.error
import urllib.request

from .config import API_BASE_URL, AI_INTERNAL_KEY, VEHICLE_DISTRIBUTION_BOT_KEY

_log = logging.getLogger(__name__)


# ── Vehicle-distribution dedicated-key helpers ───────────────────────────────
# These endpoints authenticate with the dedicated x-vehicle-distribution-bot-key
# header — NEVER the AI_INTERNAL_KEY. All return (ok, data_or_error).

def _vehicle_headers() -> dict:
    headers = {"Content-Type": "application/json"}
    if VEHICLE_DISTRIBUTION_BOT_KEY:
        headers["x-vehicle-distribution-bot-key"] = VEHICLE_DISTRIBUTION_BOT_KEY
    return headers


def _vehicle_request(
    method: str,
    path: str,
    payload: dict | None = None,
) -> tuple[bool, object]:
    """Dedicated-key HTTP call to a vehicle-distribution endpoint.

    Returns (True, parsed_json) on success, (False, error_message) otherwise.
    """
    if not API_BASE_URL:
        return False, "API_BASE_URL o'rnatilmagan"
    if not VEHICLE_DISTRIBUTION_BOT_KEY:
        return False, "VEHICLE_DISTRIBUTION_BOT_KEY o'rnatilmagan"

    url = API_BASE_URL.rstrip("/") + path
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        url, data=data, headers=_vehicle_headers(), method=method
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return True, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read().decode("utf-8"))
            return False, body.get("error") or f"HTTP {exc.code}"
        except Exception:
            return False, f"HTTP {exc.code}"
    except Exception as exc:
        _log.warning("vehicle %s %s so'rovida xato: %s", method, path, exc)
        return False, str(exc)


def vehicle_get(path: str) -> tuple[bool, object]:
    """Generic dedicated-key GET to a vehicle-distribution endpoint."""
    return _vehicle_request("GET", path)


def vehicle_post(path: str, payload: dict | None = None) -> tuple[bool, object]:
    """Generic dedicated-key POST to a vehicle-distribution endpoint."""
    return _vehicle_request("POST", path, payload)


def list_vehicle_handoffs() -> tuple[bool, object]:
    """List persisted DM-001 handoffs."""
    return vehicle_get("/vehicle-distribution/handoffs")


def get_vehicle_handoff(handoff_id: int) -> tuple[bool, object]:
    """Fetch one persisted handoff and its item snapshots."""
    return vehicle_get(f"/vehicle-distribution/handoffs/{int(handoff_id)}")


def create_vehicle_handoff(
    source_warehouse_id: int,
    mahsulot_id: int,
    quantity: int,
    total_weight_kg: float,
    operation_key: str,
    notes: str | None = None,
) -> tuple[bool, object]:
    """Create one idempotent prepared handoff for the frozen pilot vehicle."""
    payload = {
        "sourceWarehouseId": int(source_warehouse_id),
        "items": [{
            "mahsulotId": int(mahsulot_id),
            "quantity": int(quantity),
            "totalWeightKg": float(total_weight_kg),
        }],
        "operationKey": operation_key,
    }
    if notes:
        payload["notes"] = notes
    return vehicle_post("/vehicle-distribution/handoffs", payload)


def mark_handoff_handed_over(handoff_id: int) -> tuple[bool, object]:
    return vehicle_post(
        f"/vehicle-distribution/handoffs/{int(handoff_id)}/handed-over", {}
    )


def mark_handoff_stock_transferred(handoff_id: int) -> tuple[bool, object]:
    return vehicle_post(
        f"/vehicle-distribution/handoffs/{int(handoff_id)}/stock-transferred", {}
    )


def prepare_handoff_labels(
    handoff_id: int, operation_key: str
) -> tuple[bool, object]:
    """POST /vehicle-distribution/handoffs/:id/labels/prepare — idempotent."""
    return vehicle_post(
        f"/vehicle-distribution/handoffs/{int(handoff_id)}/labels/prepare",
        {"operationKey": operation_key},
    )


def get_handoff_labels(handoff_id: int) -> tuple[bool, object]:
    """GET /vehicle-distribution/handoffs/:id/labels — printable payload."""
    return vehicle_get(
        f"/vehicle-distribution/handoffs/{int(handoff_id)}/labels"
    )


def confirm_handoff_labels_printed(
    handoff_id: int, operation_key: str
) -> tuple[bool, object]:
    """POST /vehicle-distribution/handoffs/:id/confirm-labels-printed."""
    return vehicle_post(
        f"/vehicle-distribution/handoffs/{int(handoff_id)}/confirm-labels-printed",
        {"operationKey": operation_key},
    )


def adjust_inventory(
    warehouse_id: int,
    product: str,
    qty: float,
    weight_kg: float | None = None,
    note: str = "",
    operator: str | None = None,
) -> tuple[bool, str | None]:
    """POST /ombor/adjust — konteyner liniyasining miqdor (va kg) ni to'g'rilaydi.

    Yangi qiymatlar absolyut (ustiga emas). kg-mahsulotlar uchun weight_kg majburiy.
    `operator` — tuzatishni bajargan Telegram operatori (audit uchun created_by'ga
    yoziladi; aks holda "bot" qoladi).
    Muvaffaqiyatda (True, None), aks holda (False, xato matni) qaytaradi.
    """
    if not API_BASE_URL:
        return False, "API_BASE_URL o'rnatilmagan"

    url = API_BASE_URL.rstrip("/") + "/ombor/adjust"
    payload: dict = {"warehouseId": warehouse_id, "product": product, "qty": qty}
    if weight_kg is not None:
        payload["weightKg"] = weight_kg
    if note:
        payload["note"] = note
    if operator:
        payload["operator"] = operator

    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if AI_INTERNAL_KEY:
        headers["x-internal-key"] = AI_INTERNAL_KEY

    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30):
            return True, None
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read().decode("utf-8"))
            return False, body.get("error") or f"HTTP {exc.code}"
        except Exception:
            return False, f"HTTP {exc.code}"
    except Exception as exc:
        _log.warning("adjust_inventory so'rovida xato: %s", exc)
        return False, str(exc)


def adjust_raw_material(
    material_id: int,
    stock: float,
    note: str = "",
    operator: str | None = None,
) -> tuple[bool, str | None]:
    """POST /ombor/raw-adjust — xom ashyo zahirasini ABSOLYUT qiymatga to'g'rilaydi.

    Yangi qiymat ustiga emas, to'g'ridan-to'g'ri o'rnatiladi; API delta'ni IN/OUT
    sifatida log qiladi. `operator` — tuzatishni bajargan Telegram operatori
    (audit uchun created_by'ga yoziladi; aks holda "bot" qoladi).
    Muvaffaqiyatda (True, None), aks holda (False, xato).
    """
    if not API_BASE_URL:
        return False, "API_BASE_URL o'rnatilmagan"

    url = API_BASE_URL.rstrip("/") + "/ombor/raw-adjust"
    payload: dict = {"materialId": material_id, "stock": stock}
    if note:
        payload["note"] = note
    if operator:
        payload["operator"] = operator

    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if AI_INTERNAL_KEY:
        headers["x-internal-key"] = AI_INTERNAL_KEY

    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30):
            return True, None
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read().decode("utf-8"))
            return False, body.get("error") or f"HTTP {exc.code}"
        except Exception:
            return False, f"HTTP {exc.code}"
    except Exception as exc:
        _log.warning("adjust_raw_material so'rovida xato: %s", exc)
        return False, str(exc)
