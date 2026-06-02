"""
TopMart Print Agent — Windows kompyuterda ishlaydigan script.
Telegram'dan yangi etiketka rasmlarini qabul qilib, printerga avtomatik yuboradi.
"""
import logging
import asyncio
from telegram import Update
from telegram.ext import ApplicationBuilder, ContextTypes, MessageHandler, CommandHandler, filters

from config import TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_IDS, PRINTER_NAME
from printer import print_image, list_printers

logging.basicConfig(
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    printers = list_printers()
    printer_list = "\n".join(f"  • {p}" for p in printers) or "  (topilmadi)"
    await update.message.reply_text(
        f"🖨️ *TopMart Print Agent*\n\n"
        f"Chat ID: `{chat_id}`\n\n"
        f"Mavjud printerlar:\n{printer_list}\n\n"
        f"_config.py ga ALLOWED\\_CHAT\\_IDS va PRINTER\\_NAME ni kiriting._",
        parse_mode="Markdown",
    )


async def handle_photo(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id

    if ALLOWED_CHAT_IDS and chat_id not in ALLOWED_CHAT_IDS:
        logger.warning(f"Ruxsatsiz chat_id: {chat_id}")
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

    success = print_image(bytes(image_bytes), PRINTER_NAME)

    if success:
        await update.message.reply_text("✅ Etiketka printerga yuborildi!")
        logger.info("Print muvaffaqiyatli.")
    else:
        await update.message.reply_text("❌ Printer xatosi. Log faylini tekshiring.")


def main() -> None:
    if not TELEGRAM_BOT_TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN ni config.py ga kiriting!")

    logger.info("TopMart Print Agent ishga tushdi...")
    printers = list_printers()
    logger.info(f"Mavjud printerlar: {printers}")

    app = ApplicationBuilder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(MessageHandler(filters.PHOTO, handle_photo))

    logger.info("Telegram'dan etiketkalar kutilmoqda...")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
