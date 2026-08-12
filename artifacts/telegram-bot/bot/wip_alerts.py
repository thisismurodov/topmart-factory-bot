"""Manfiy WIP balans Telegram ogohlantirishi (yozuvchi tomonda).

Bo'lim balansi (RECEIVE − PRODUCE) minusga tushsa, admin rolidagi
foydalanuvchilarga darhol Telegram xabar yuboriladi — partiya yozilgan
paytning o'zida (dashboard ochilishini kutmasdan). Spam bo'lmasligi uchun
wip_negative_alerts jadvali orqali har bir bo'lim uchun kuniga ko'pi bilan
BIR marta (API lib/wipAlerts.ts bilan bir xil dedupe jadvali — API va bot
hech qachon bir kunda ikki marta yubormaydi).

Best-effort: Telegram yoki DB xatosi asosiy operatsiyani hech qachon
to'xtatmaydi.
"""

import json
import logging
import os
import urllib.request

log = logging.getLogger(__name__)

# Floating-point shovqinini (masalan -1e-12) minus deb hisoblamaslik uchun.
NEG_EPS = 1e-6

_BALANCE_SQL = """
    SELECT COALESCE(SUM(
        CASE WHEN movement_type='RECEIVE' THEN weight_kg
             WHEN movement_type='PRODUCE' THEN -weight_kg
             ELSE 0 END
    ), 0)::numeric AS wip_kg
    FROM wip_movements WHERE line_id=%s
"""


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


def check_and_notify_negative_wip(line_ids) -> list[int]:
    """Berilgan liniyalarning JORIY balansini tekshiradi; minus bo'lsa
    adminlarga Telegram xabar yuboradi (kuniga liniya boshiga 1 marta).

    Tranzaksiya COMMIT bo'lgandan KEYIN chaqirilishi kerak — balans real
    yozilgan holatdan o'qiladi. Hech qachon exception ko'tarmaydi.

    Returns: xabar yuborishga urinilgan line_id ro'yxati.
    """
    alerted: list[int] = []
    try:
        # Lokal import — bot.database ↔ wip_alerts aylanma importini oldini oladi.
        from bot import database as db

        token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
        if not token or not line_ids:
            return alerted

        with db.get_conn() as (conn, cur):
            for line_id in sorted(set(int(i) for i in line_ids if i)):
                cur.execute(_BALANCE_SQL, (line_id,))
                wip_kg = float(cur.fetchone()["wip_kg"] or 0)
                if wip_kg >= -NEG_EPS:
                    continue

                # Dedupe: shu bo'lim uchun bugun allaqachon yuborilgan bo'lsa — o'tkazamiz.
                cur.execute(
                    """INSERT INTO wip_negative_alerts (line_id, alert_date, wip_kg)
                       VALUES (%s, (NOW() AT TIME ZONE 'Asia/Tashkent')::date, %s)
                       ON CONFLICT (line_id, alert_date) DO NOTHING
                       RETURNING line_id""",
                    (line_id, wip_kg),
                )
                if not cur.fetchone():
                    continue

                cur.execute("SELECT name FROM production_lines WHERE id=%s", (line_id,))
                row = cur.fetchone()
                line_name = row["name"] if row else f"Bo'lim #{line_id}"

                cur.execute("SELECT chat_id FROM user_roles WHERE role='admin'")
                chat_ids = [str(r["chat_id"]) for r in cur.fetchall()]
                # Hech bir admin ro'yxatdan o'tmagan bo'lsa — scheduler'dagi kabi
                # ADMIN_CHAT_ID env'iga tushamiz.
                if not chat_ids and os.environ.get("ADMIN_CHAT_ID"):
                    chat_ids = [str(os.environ["ADMIN_CHAT_ID"])]

                text = (
                    "🚨 Bo'lim balansi minusga tushdi!\n"
                    f"🏭 Bo'lim: {line_name}\n"
                    f"📉 Balans: −{abs(wip_kg):.2f} kg (kamomad)\n"
                    "Ish jarayoni sahifasida bo'lim harakatlarini tekshiring."
                )
                for chat_id in chat_ids:
                    try:
                        _send(token, chat_id, text)
                    except Exception:
                        log.warning("Manfiy WIP xabari yuborilmadi (chat %s)", chat_id)
                alerted.append(line_id)
    except Exception:
        log.exception("Manfiy WIP ogohlantirishi bajarilmadi")
    return alerted
