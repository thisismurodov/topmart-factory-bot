import os
import logging
import traceback
import warnings
from telegram.warnings import PTBUserWarning

warnings.filterwarnings("ignore", message="If 'per_message=False'", category=PTBUserWarning)

from telegram import Update
from telegram.ext import ApplicationBuilder, PicklePersistence, ContextTypes

from bot.database import init_db
from bot.handlers.input_handler import build_conversation_handler
from bot.handlers.admin import build_admin_handler, register_cleardata
from bot.handlers.packer import build_packer_handler
from bot.handlers.start import register as register_start_handlers
from bot.handlers.labels import register as register_label_handlers
from bot.handlers.kpi import register as register_kpi_handlers
from bot.handlers.salary import register as register_salary_handlers
from bot.handlers.sales import register as register_sales_handlers
from bot.handlers.report import register as register_report_handlers
from bot.handlers.inventory import build_inventory_handler
from bot.handlers.debts import register as register_debt_handlers
from bot.scheduler import start_scheduler

logging.basicConfig(
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

ADMIN_CHAT_ID = os.environ.get("ADMIN_CHAT_ID", "")


async def global_error_handler(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Barcha ushlanshmagan xatolarni log qiladi va admin'ga xabar yuboradi."""
    tb = "".join(traceback.format_exception(None, context.error, context.error.__traceback__))
    logger.error("Unhandled exception:\n%s", tb)

    if ADMIN_CHAT_ID:
        short = tb[-3000:] if len(tb) > 3000 else tb
        try:
            await context.bot.send_message(
                chat_id=ADMIN_CHAT_ID,
                text=f"⚠️ *Bot xatosi*\n\n```\n{short}\n```",
                parse_mode="Markdown",
            )
        except Exception as notify_err:
            logger.warning("Admin bildirishnomasi yuborilmadi: %s", notify_err)


def main() -> None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN environment variable is not set")

    logger.info("Initialising database …")
    init_db()

    persistence = PicklePersistence(filepath="data/bot_state.pkl")
    app = (
        ApplicationBuilder()
        .token(token)
        .persistence(persistence)
        .connect_timeout(30)
        .read_timeout(30)
        .build()
    )

    app.add_error_handler(global_error_handler)

    register_cleardata(app)
    register_salary_handlers(app)
    register_report_handlers(app)
    register_sales_handlers(app)
    register_debt_handlers(app)
    app.add_handler(build_inventory_handler())
    app.add_handler(build_admin_handler())
    app.add_handler(build_packer_handler())
    app.add_handler(build_conversation_handler())
    register_label_handlers(app)
    register_kpi_handlers(app)
    register_start_handlers(app)

    start_scheduler(app.bot, ADMIN_CHAT_ID)

    logger.info("TopMart Factory Bot v3.1 started (polling) …")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
