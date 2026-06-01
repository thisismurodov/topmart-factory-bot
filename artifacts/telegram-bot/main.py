import os
import logging
import warnings
from telegram.warnings import PTBUserWarning
from telegram.ext import ApplicationBuilder

warnings.filterwarnings(
    "ignore",
    message="If 'per_message=False'",
    category=PTBUserWarning,
)

from bot.database import init_db
from bot.handlers.input_handler import build_conversation_handler
from bot.handlers.start import register as register_start_handlers

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

    app = ApplicationBuilder().token(token).build()

    app.add_handler(build_conversation_handler())
    register_start_handlers(app)

    logger.info("TopMart Factory Bot started (polling) …")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
