"""F11: savdo-bot -> API server HTTP klienti (Telegram-first mashina yuklash).

stdlib urllib — requirements.txt ga yangi paket qo'shilmaydi (omborchi
botdagi bot/api_client.py bilan bir xil yondashuv). Auth: dedicated
`x-vehicle-distribution-bot-key` sarlavhasi (VEHICLE_DISTRIBUTION_BOT_KEY).

Muvaffaqiyat = parsed JSON; xato = VehicleApiError (status + qisqa matn).
Handler kod har doim try/except VehicleApiError bilan chaqiradi — agentga
xom traceback emas, API bergan izohli xabar ko'rsatiladi.
"""

import json
import logging
import os
import urllib.error
import urllib.request

log = logging.getLogger(__name__)

API_BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:80/api").rstrip("/")
VEHICLE_DISTRIBUTION_BOT_KEY = os.environ.get("VEHICLE_DISTRIBUTION_BOT_KEY", "")
TIMEOUT_S = 30


class VehicleApiError(Exception):
    """API xatosi — status (HTTP kodi yoki None=tarmoq) + odam o'qiydigan matn."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def _request(method, path, payload=None):
    if not API_BASE_URL:
        raise VehicleApiError("API_BASE_URL o'rnatilmagan")
    if not VEHICLE_DISTRIBUTION_BOT_KEY:
        raise VehicleApiError("VEHICLE_DISTRIBUTION_BOT_KEY o'rnatilmagan")
    url = API_BASE_URL + path
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Content-Type": "application/json",
            "x-vehicle-distribution-bot-key": VEHICLE_DISTRIBUTION_BOT_KEY,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read().decode("utf-8"))
            message = body.get("error") or ("HTTP %s" % exc.code)
        except Exception:
            message = "HTTP %s" % exc.code
        raise VehicleApiError(str(message)[:400], status=exc.code)
    except Exception as exc:
        log.warning("vehicle API %s %s xato: %s", method, path, exc)
        raise VehicleApiError("API bilan aloqa yo'q: %s" % exc)


def create_handoff(source_warehouse_id, items, operation_key, notes=None):
    """POST /vehicle-distribution/handoffs — topshiriq yaratish.

    items: [{"mahsulot_id": int, "quantity": int}, ...]
    totalWeightKg YUBORILMAYDI — server mahsulot profilidagi birlik og'irlikdan
    o'zi hisoblaydi (approve oqimi bilan bir xil semantika).
    Zaxira YECHILMAYDI — u faqat omborchi jismonan tasdiqlaganda ko'chadi.
    """
    payload = {
        "sourceWarehouseId": int(source_warehouse_id),
        "items": [
            {"mahsulotId": int(i["mahsulot_id"]), "quantity": int(i["quantity"])}
            for i in items
        ],
        "operationKey": str(operation_key),
    }
    if notes:
        payload["notes"] = str(notes)[:500]
    return _request("POST", "/vehicle-distribution/handoffs", payload)
