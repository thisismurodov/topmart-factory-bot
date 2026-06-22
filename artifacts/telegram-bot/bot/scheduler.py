"""Kunlik low-stock bildirisnomasi, backup va boshqa scheduled tasklar."""
import asyncio
import gzip
import io
import logging
import os
import subprocess
from datetime import datetime, timedelta

from .database import get_conn
from .config import SUPERADMIN_CHAT_ID

_log = logging.getLogger(__name__)


# ── Low-stock ─────────────────────────────────────────────────────────────────

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


# ── Database backup ───────────────────────────────────────────────────────────

def create_db_backup() -> tuple[bytes, str]:
    """pg_dump → gzip — muvaffaqiyatli bo'lsa (bytes, filename) qaytaradi."""
    db_url = os.environ.get("DATABASE_URL", "")
    if not db_url:
        raise RuntimeError("DATABASE_URL topilmadi")

    stamp    = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"topmart-backup-{stamp}.sql.gz"

    result = subprocess.run(
        ["pg_dump", "--no-password", "--format=plain", db_url],
        capture_output=True,
        timeout=120,
    )
    if result.returncode != 0:
        err = result.stderr.decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"pg_dump xatosi: {err}")

    sql_bytes  = result.stdout
    gz_bytes   = gzip.compress(sql_bytes, compresslevel=6)
    _log.info("Backup yaratildi: %s (%d KB)", filename, len(gz_bytes) // 1024)
    return gz_bytes, filename


async def send_backup_to_telegram(bot, chat_id: int | str) -> None:
    """Backup faylni Telegram'ga hujjat sifatida yuboradi."""
    now_str = datetime.now().strftime("%d.%m.%Y %H:%M")
    try:
        await bot.send_message(
            chat_id=chat_id,
            text=f"⏳ *Backup tayyorlanmoqda…*\n🕐 {now_str}",
            parse_mode="Markdown",
        )
        gz_bytes, filename = create_db_backup()
        size_kb = len(gz_bytes) // 1024
        await bot.send_document(
            chat_id=chat_id,
            document=io.BytesIO(gz_bytes),
            filename=filename,
            caption=(
                f"✅ *TopMart DB Backup*\n"
                f"📅 {now_str}\n"
                f"📦 Hajm: {size_kb} KB\n"
                f"🗄 Fayl: `{filename}`\n\n"
                f"_Tiklash uchun: psql DATABASE\\_URL < fayl.sql_"
            ),
            parse_mode="Markdown",
        )
        _log.info("Backup Telegram'ga yuborildi: %s", filename)
    except Exception as exc:
        _log.error("Backup yuborishda xato: %s", exc)
        try:
            await bot.send_message(
                chat_id=chat_id,
                text=f"❌ *Backup xatosi*\n`{exc}`",
                parse_mode="Markdown",
            )
        except Exception:
            pass


# ── Scheduler loop ────────────────────────────────────────────────────────────

def _schedule_loop(bot, admin_chat_id: str, low_stock_hour: int = 8, backup_hour: int = 3) -> None:
    """Blocking loop — alohida threadda ishga tushiriladi."""
    import time

    _log.info(
        "Scheduler ishga tushdi (low-stock: %02d:00, backup: %02d:00).",
        low_stock_hour, backup_hour,
    )

    def _next_run_at(hour: int) -> datetime:
        now = datetime.now()
        t   = now.replace(hour=hour, minute=0, second=0, microsecond=0)
        if now >= t:
            t += timedelta(days=1)
        return t

    while True:
        now      = datetime.now()
        next_ls  = _next_run_at(low_stock_hour)
        next_bkp = _next_run_at(backup_hour)
        sleep_secs = min(
            (next_ls  - now).total_seconds(),
            (next_bkp - now).total_seconds(),
        )
        time.sleep(max(sleep_secs, 30))

        now = datetime.now()
        tasks = []

        if abs((now - next_ls.replace(second=0, microsecond=0)).total_seconds()) < 90:
            tasks.append(_send_low_stock_report(bot, admin_chat_id))

        if abs((now - next_bkp.replace(second=0, microsecond=0)).total_seconds()) < 90:
            tasks.append(send_backup_to_telegram(bot, SUPERADMIN_CHAT_ID))

        if tasks:
            try:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                for coro in tasks:
                    loop.run_until_complete(coro)
                loop.close()
            except Exception as exc:
                _log.error("Scheduler xato: %s", exc)


def start_scheduler(bot, admin_chat_id: str, low_stock_hour: int = 8, backup_hour: int = 3) -> None:
    """Scheduler'ni daemon threadda ishga tushiradi."""
    if not admin_chat_id:
        _log.info("ADMIN_CHAT_ID o'rnatilmagan — scheduler o'chirildi.")
        return

    import threading
    t = threading.Thread(
        target=_schedule_loop,
        args=(bot, admin_chat_id, low_stock_hour, backup_hour),
        daemon=True,
        name="topmart-scheduler",
    )
    t.start()
    _log.info("Scheduler thread ishga tushdi.")
