"""Node API'ga umumiy HTTP so'rovlar (AI'dan tashqari endpointlar).

Bot inventarni to'g'ridan-to'g'ri o'zgartirmaydi — Node API orqali o'tadi, shunda
og'irlik (kg) halol qoladi va stock_movement log qilinadi.
"""
import json
import logging
import urllib.error
import urllib.request

from .config import API_BASE_URL, AI_INTERNAL_KEY

_log = logging.getLogger(__name__)


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
