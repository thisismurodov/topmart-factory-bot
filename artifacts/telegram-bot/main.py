import os
import logging
import warnings
from telegram.warnings import PTBUserWarning

warnings.filterwarnings("ignore", message="If 'per_message=False'", category=PTBUserWarning)

from telegram.ext import ApplicationBuilder, PicklePersistence

from bot.database import init_db
from bot.handlers.input_handler import build_conversation_handler
from bot.handlers.admin import build_admin_handler, register_cleardata
from bot.handlers.packer import build_packer_handler
from bot.handlers.start import register as register_start_handlers
from bot.handlers.labels import register as register_label_handlers
from bot.handlers.kpi import register as register_kpi_handlers
from bot.handlers.salary import register as register_salary_handlers
from bot.handlers.sales import register as register_sales_handlers
from bot.handlers.inventory import build_inventory_handler

logging.basicConfig(
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)


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

    register_cleardata(app)
    register_salary_handlers(app)
    register_sales_handlers(app)
    app.add_handler(build_inventory_handler())
    app.add_handler(build_admin_handler())
    app.add_handler(build_packer_handler())
    app.add_handler(build_conversation_handler())
    register_label_handlers(app)
    register_kpi_handlers(app)
    register_start_handlers(app)

    logger.info("TopMart Factory Bot started (polling) …")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
