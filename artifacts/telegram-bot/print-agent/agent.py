"""
TopMart Print Agent — Windows kompyuterda ishlaydigan script.
Telegram orqali tasdiqlangan vehicle handoff passport PDFlarini 100x80 printerga
xavfsiz yuboradi. Legacy rasm etiketalari ham faqat ruxsatli chatdan qabul qilinadi.
"""
import logging
import asyncio
from telegram import Update
from telegram.ext import ApplicationBuilder, ContextTypes, MessageHandler, CommandHandler, filters

from config import ConfigError, PrintAgentConfig, load_config
from printer import print_image, list_printers, probe_printer_health
from vehicle_api import VehicleApiClient
from vehicle_print import (
    ConfirmationPending,
    PrintJobStore,
    VehiclePrintSafetyError,
    VehiclePrintService,
)

logging.basicConfig(
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)


def _config(context: ContextTypes.DEFAULT_TYPE) -> PrintAgentConfig:
    return context.application.bot_data["config"]


def _service(context: ContextTypes.DEFAULT_TYPE) -> VehiclePrintService:
    return context.application.bot_data["vehicle_print_service"]


def _allowed(update: Update, context: ContextTypes.DEFAULT_TYPE) -> bool:
    chat = update.effective_chat
    allowed = chat is not None and chat.id in _config(context).allowed_chat_ids
    if not allowed:
        logger.warning("Ruxsatsiz chatdan so'rov rad etildi")
    return allowed


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _allowed(update, context):
        return
    chat_id = update.effective_chat.id
    printers = list_printers()
    printer_list = "\n".join(f"  • {p}" for p in printers) or "  (topilmadi)"
    await update.message.reply_text(
        f"🖨️ *TopMart Print Agent*\n\n"
        f"Chat ID: `{chat_id}`\n\n"
        f"Mavjud printerlar:\n{printer_list}\n\n"
        f"Vehicle print: `/vehicle_print HANDOFF_ID`\n"
        f"Reprint: `/vehicle_reprint HANDOFF_ID`\n"
        f"Tasdiqni davom ettirish: `/vehicle_resume JOB_ID`\n"
        f"Noaniq jobni fizik tekshiruvdan so'ng tasdiqlash: "
        f"`/vehicle_recover JOB_ID`\n"
        f"Noaniq jobni to'liq qayta bosish: `/vehicle_retry JOB_ID`",
        parse_mode="Markdown",
    )


async def handle_photo(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _allowed(update, context):
        return

    if not update.message.photo:
        return

    caption = update.message.caption or ""
    if "🏷️" not in caption and "Partiya" not in caption:
        logger.info("Etiketka emas, o'tkazib yuborildi.")
        return

    photo = update.message.photo[-1]
    file = await context.bot.get_file(photo.file_id)
    image_bytes = await file.download_as_bytearray()

    logger.info(f"Etiketka qabul qilindi: {caption[:60]}")

    success = await asyncio.to_thread(
        print_image,
        bytes(image_bytes),
        _config(context).printer_name,
    )

    if success:
        await update.message.reply_text("✅ Etiketka printerga yuborildi!")
        logger.info("Print muvaffaqiyatli.")
    else:
        await update.message.reply_text("❌ Printer xatosi. Log faylini tekshiring.")


def _positive_id(context: ContextTypes.DEFAULT_TYPE, label: str) -> int:
    if len(context.args) != 1:
        raise ValueError(f"{label} bitta musbat ID qabul qiladi")
    value = int(context.args[0])
    if value <= 0:
        raise ValueError(f"{label} musbat son bo'lishi kerak")
    return value


async def _vehicle_print_command(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    *,
    explicit_reprint: bool,
) -> None:
    if not _allowed(update, context):
        return
    try:
        handoff_id = _positive_id(context, "Handoff ID")
    except (ValueError, TypeError) as exc:
        await update.message.reply_text(f"❌ {exc}")
        return

    action = "qayta chop" if explicit_reprint else "chop"
    await update.message.reply_text(
        f"⏳ Handoff #{handoff_id} {action} etilmoqda..."
    )
    try:
        outcome = await asyncio.to_thread(
            _service(context).print_handoff,
            handoff_id,
            update.effective_chat.id,
            update.effective_message.message_id,
            explicit_reprint=explicit_reprint,
        )
        suffix = " (takroriy so'rov, qayta bosilmadi)" if outcome.deduplicated else ""
        await update.message.reply_text(
            f"✅ Job #{outcome.job_id}: {outcome.page_count} ta 100×80 sahifa "
            f"printer spooleriga topshirildi va lifecycle tasdiqlandi{suffix}."
        )
    except ConfirmationPending as exc:
        await update.message.reply_text(
            f"⚠️ Job #{exc.job_id} printerga topshirildi, lekin API tasdig'i "
            f"yetib bormadi. Qayta bosmang. `/vehicle_resume {exc.job_id}` ni yuboring.",
            parse_mode="Markdown",
        )
    except Exception as exc:
        logger.exception("Vehicle print xatosi")
        await update.message.reply_text(f"❌ Vehicle print rad etildi: {exc}")


async def cmd_vehicle_print(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    await _vehicle_print_command(update, context, explicit_reprint=False)


async def cmd_vehicle_reprint(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    await _vehicle_print_command(update, context, explicit_reprint=True)


async def cmd_vehicle_resume(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    if not _allowed(update, context):
        return
    try:
        job_id = _positive_id(context, "Job ID")
        outcome = await asyncio.to_thread(
            _service(context).resume_confirmation,
            job_id,
        )
        await update.message.reply_text(
            f"✅ Job #{outcome.job_id} lifecycle tasdig'i yakunlandi. "
            "Etiketkalar qayta bosilmadi."
        )
    except Exception as exc:
        logger.exception("Vehicle print resume xatosi")
        await update.message.reply_text(f"❌ Tasdiq davom ettirilmadi: {exc}")


async def cmd_vehicle_recover(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    if not _allowed(update, context):
        return
    try:
        job_id = _positive_id(context, "Job ID")
        outcome = await asyncio.to_thread(
            _service(context).recover_ambiguous_confirmation,
            job_id,
        )
        await update.message.reply_text(
            f"✅ Job #{outcome.job_id}: operator tekshirgan fizik bosma "
            "lifecycle'da tasdiqlandi. Qayta bosilmadi."
        )
    except Exception as exc:
        logger.exception("Vehicle print recover xatosi")
        await update.message.reply_text(f"❌ Recover bajarilmadi: {exc}")


async def cmd_vehicle_retry(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    if not _allowed(update, context):
        return
    try:
        job_id = _positive_id(context, "Job ID")
        outcome = await asyncio.to_thread(
            _service(context).retry_ambiguous,
            job_id,
            update.effective_chat.id,
            update.effective_message.message_id,
        )
        await update.message.reply_text(
            f"✅ Job #{outcome.job_id}: {outcome.page_count} ta sahifa to'liq "
            "qayta bosildi va lifecycle tasdiqlandi."
        )
    except Exception as exc:
        logger.exception("Vehicle print retry xatosi")
        await update.message.reply_text(f"❌ Retry bajarilmadi: {exc}")


async def report_health(context: ContextTypes.DEFAULT_TYPE) -> None:
    config = _config(context)
    health = await asyncio.to_thread(probe_printer_health, config.printer_name)
    payload = {
        "agentId": config.agent_id,
        "printerName": health.printer_name,
        "printerAvailable": health.printer_available,
        "mediaValid": health.media_valid,
        "printableAreaValid": health.printable_area_valid,
        "physicalWidthMm": health.physical_width_mm,
        "physicalHeightMm": health.physical_height_mm,
        "printableWidthMm": health.printable_width_mm,
        "printableHeightMm": health.printable_height_mm,
        "detail": health.detail,
    }
    try:
        await asyncio.to_thread(
            context.application.bot_data["vehicle_api"].send_heartbeat,
            payload,
        )
    except Exception:
        logger.exception("Print Agent heartbeat API'ga yetib bormadi")


def main() -> None:
    try:
        config = load_config()
    except ConfigError as exc:
        raise RuntimeError(f"Print Agent fail-closed: {exc}") from exc

    logger.info("TopMart Print Agent ishga tushdi...")
    printers = list_printers()
    logger.info(f"Mavjud printerlar: {printers}")
    if config.printer_name not in printers:
        logger.error(
            "PRINTER_NAME topilmadi; chop etish fail-closed, heartbeat unhealthy "
            "holatni omborga yuboradi: %s",
            config.printer_name,
        )

    app = ApplicationBuilder().token(config.telegram_bot_token).build()
    app.bot_data["config"] = config
    vehicle_api = VehicleApiClient(config.api_base_url, config.vehicle_bot_key)
    app.bot_data["vehicle_api"] = vehicle_api
    app.bot_data["vehicle_print_service"] = VehiclePrintService(
        vehicle_api,
        PrintJobStore(config.job_db_path),
        config.printer_name,
    )
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("vehicle_print", cmd_vehicle_print))
    app.add_handler(CommandHandler("vehicle_reprint", cmd_vehicle_reprint))
    app.add_handler(CommandHandler("vehicle_resume", cmd_vehicle_resume))
    app.add_handler(CommandHandler("vehicle_recover", cmd_vehicle_recover))
    app.add_handler(CommandHandler("vehicle_retry", cmd_vehicle_retry))
    app.add_handler(MessageHandler(filters.PHOTO, handle_photo))
    if app.job_queue is None:
        raise RuntimeError("Print Agent heartbeat scheduler mavjud emas")
    app.job_queue.run_repeating(
        report_health,
        interval=config.heartbeat_interval_seconds,
        first=0,
        name="print-agent-health",
    )

    logger.info("Telegram'dan etiketkalar kutilmoqda...")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
