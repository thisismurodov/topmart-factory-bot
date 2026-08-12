"""Packer bo'sh mahsulot ro'yxati Telegram ogohlantirishi.

Mahsulot nofaol qilinganda (active=false) shu mahsulot biriktirilgan
packer'larning FAOL biriktirilgan mahsuloti umuman qolmasa, ular ishlab
chiqarish kiritishdan jimgina to'silib qoladi ("Mahsulotlar biriktirilmagan"
tugmasi). Bu modul shunday packer'larni topib, admin rolidagi
foydalanuvchilarga Telegram xabar yuboradi — biriktirmalarni yangilash uchun.

Best-effort: Telegram yoki DB xatosi asosiy operatsiyani hech qachon
to'xtatmaydi. Tranzaksiya COMMIT bo'lgandan KEYIN chaqirilishi kerak.
"""

import json
import logging
import os
import urllib.request

log = logging.getLogger(__name__)


def _telegram_api_base() -> str:
    # Testlarda soxta Telegram serveriga yo'naltirish uchun override qilinadi.
    return os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org")


def _send(token: str, chat_id: str, text: str) -> None:
    req = urllib.request.Request(
        f"{_telegram_api_base()}/bot{token}/sendMessage",
        data=json.dumps({"chat_id": chat_id, "text": text}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    urllib.request.urlopen(req, timeout=10).read()


def notify_packers_left_without_products(product_name: str) -> list[str]:
    """Mahsulot deaktivatsiyasi packer(lar)ni bo'sh faol ro'yxat bilan
    qoldirgan bo'lsa adminlarga Telegram xabar yuboradi.

    Returns: ta'sirlangan packer nomlari (bo'sh — hech kim ta'sirlanmagan).
    Hech qachon exception ko'tarmaydi.
    """
    try:
        # Lokal import — bot.database ↔ packer_alerts aylanma importini oldini oladi.
        from bot import database as db

        packers = db.get_packers_left_without_products(product_name)
        if not packers:
            return []

        token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
        if not token:
            return packers

        with db.get_conn() as (conn, cur):
            cur.execute("SELECT chat_id FROM user_roles WHERE role='admin'")
            chat_ids = [str(r["chat_id"]) for r in cur.fetchall()]
        if not chat_ids and os.environ.get("ADMIN_CHAT_ID"):
            chat_ids = [str(os.environ["ADMIN_CHAT_ID"])]

        text = (
            f"⚠️ Mahsulot nofaol qilindi: {product_name}\n"
            "Quyidagi packer(lar)da endi bitta ham faol biriktirilgan mahsulot "
            "qolmadi va ishlab chiqarish kirita olmaydi:\n"
            + "\n".join(f"• {p}" for p in packers)
            + "\nIltimos, packer mahsulot biriktirmalarini yangilang."
        )
        for chat_id in chat_ids:
            try:
                _send(token, chat_id, text)
            except Exception:
                log.warning("Packer bo'sh ro'yxat xabari yuborilmadi (chat %s)", chat_id)
        return packers
    except Exception:
        log.exception("Packer bo'sh ro'yxat ogohlantirishi bajarilmadi")
        return []
