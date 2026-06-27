"""AI yordamchisi — Node API'ning /ai/* endpointlariga so'rov yuboradi.

LLM chaqiruvlari Node API tomonida (Replit AI integratsiyasi). Bot faqat HTTP
orqali so'rov yuboradi va xatolik bo'lsa jim o'tib ketadi (None qaytaradi).
"""
import json
import logging
import urllib.error
import urllib.request

from .config import API_BASE_URL, AI_INTERNAL_KEY

_log = logging.getLogger(__name__)


def _request(method: str, path: str, payload: dict | None = None, timeout: int = 60) -> dict | None:
    if not API_BASE_URL:
        _log.info("API_BASE_URL o'rnatilmagan — AI so'rovi o'tkazib yuborildi.")
        return None

    url = API_BASE_URL.rstrip("/") + path
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"}
    if AI_INTERNAL_KEY:
        headers["x-internal-key"] = AI_INTERNAL_KEY

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        _log.warning("AI API HTTP %s xato: %s", exc.code, path)
        return None
    except Exception as exc:
        _log.warning("AI API so'rovida xato (%s): %s", path, exc)
        return None


def get_daily_analysis(refresh: bool = False) -> str | None:
    """Kunlik AI tahlilini matn ko'rinishida qaytaradi (yoki None)."""
    q = "?refresh=1" if refresh else ""
    res = _request("GET", f"/ai/daily-analysis{q}", timeout=120)
    if not res:
        return None
    return res.get("analysis")


def get_packer_tip(worker: str, items: list[dict]) -> str | None:
    """Partiya kiritilgandan keyin ishchiga qisqa maslahat (yoki None)."""
    payload = {
        "worker": worker,
        "items": [
            {
                "product": it.get("product"),
                "quantity": int(it.get("quantity") or 0),
                "weightKg": float(it.get("weight_kg") or 0),
            }
            for it in items
        ],
    }
    res = _request("POST", "/ai/packer-tip", payload, timeout=60)
    if not res:
        return None
    tip = res.get("tip")
    return tip or None
