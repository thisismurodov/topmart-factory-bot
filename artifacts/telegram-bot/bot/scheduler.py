"""Kunlik low-stock bildirisnomasi va boshqa scheduled tasklar."""
import asyncio
import logging
from datetime import datetime

from .database import get_conn

_log = logging.getLogger(__name__)


def _get_low_stock_items() -> list[dict]:
    """Minimal zahiradan kam bo'lgan faol xom ashyolar ro'yxati."""
    try:
        with get_conn() as (conn, cur):
            cur.execute("""
                SELECT name, unit_type, current_stock, minimum_stock
                FROM raw_materials
                WHERE active = TRUE
                  AND minimum_stock > 0
                  AND current_stock <= minimum_stock
                ORDER BY (current_stock / NULLIF(minimum_stock, 0)) ASC
            """)
            return cur.fetchall()
    except Exception as exc:
        _log.error("Low-stock tekshirishda xato: %s", exc)
        return []


async def _send_low_stock_report(bot, admin_chat_id: str) -> None:
    """Kam qolgan xom ashyolar haqida admin'ga xabar yuboradi."""
    if not admin_chat_id:
        return

    items = _get_low_stock_items()
    if not items:
        _log.info("Low-stock: hamma xom ashyo yetarli.")
        return

    lines = ["⚠️ *Kam qolgan xom ashyolar*\n"]
    for item in items:
        cur = float(item["current_stock"] or 0)
        mn  = float(item["minimum_stock"] or 0)
        pct = int(cur / mn * 100) if mn else 0
        lines.append(
            f"• *{item['name']}*: {cur:g} {item['unit_type']} "
            f"(minimal: {mn:g}, {pct}%)"
        )

    text = "\n".join(lines)
    try:
        await bot.send_message(chat_id=admin_chat_id, text=text, parse_mode="Markdown")
        _log.info("Low-stock hisoboti yuborildi (%d element).", len(items))
    except Exception as exc:
        _log.warning("Low-stock xabarni yuborishda xato: %s", exc)


def _schedule_loop(bot, admin_chat_id: str, hour: int = 8) -> None:
    """Blocking loop — alohida threadda ishga tushiriladi."""
    import time

    _log.info("Scheduler ishga tushdi (har kuni %02d:00 da hisobot).", hour)
    while True:
        now = datetime.now()
        # Keyingi keladigan soatni hisoblash
        next_run = now.replace(minute=0, second=0, microsecond=0)
        if now.hour >= hour:
            from datetime import timedelta
            next_run = next_run.replace(hour=hour) + timedelta(days=1)
        else:
            next_run = next_run.replace(hour=hour)

        sleep_secs = (next_run - now).total_seconds()
        _log.debug("Keyingi hisobot: %s (%.0f soniyadan keyin)", next_run, sleep_secs)
        time.sleep(max(sleep_secs, 1))

        # Async funksiyani yangi event loop'da ishlatamiz (threading muhiti)
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            loop.run_until_complete(_send_low_stock_report(bot, admin_chat_id))
            loop.close()
        except Exception as exc:
            _log.error("Scheduler xato: %s", exc)


def start_scheduler(bot, admin_chat_id: str, hour: int = 8) -> None:
    """Scheduler'ni daemon threadda ishga tushiradi."""
    if not admin_chat_id:
        _log.info("ADMIN_CHAT_ID o'rnatilmagan — scheduler o'chirildi.")
        return

    import threading
    t = threading.Thread(
        target=_schedule_loop,
        args=(bot, admin_chat_id, hour),
        daemon=True,
        name="low-stock-scheduler",
    )
    t.start()
    _log.info("Low-stock scheduler thread ishga tushdi.")
