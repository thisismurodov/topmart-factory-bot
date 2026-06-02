from datetime import date
from telegram import Update
from telegram.ext import ContextTypes, CommandHandler, MessageHandler, filters
from ..keyboards import main_menu_keyboard
from ..database import get_today_batches


MONTHS_UZ = {
    1: "Yanvar", 2: "Fevral", 3: "Mart", 4: "Aprel",
    5: "May", 6: "Iyun", 7: "Iyul", 8: "Avgust",
    9: "Sentabr", 10: "Oktabr", 11: "Noyabr", 12: "Dekabr",
}


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "👋 Xush kelibsiz!\n\n*TopMart Factory Bot* 🏭\n"
        "Arqon ishlab chiqarish zavodi boshqaruv tizimi.\n\n"
        "Quyidagi tugmalardan foydalaning:",
        parse_mode="Markdown",
        reply_markup=main_menu_keyboard(),
    )


async def today_batches_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    rows = get_today_batches()

    if not rows:
        await update.message.reply_text(
            "📋 Bugun hali partiya kiritilmagan.",
            reply_markup=main_menu_keyboard(),
        )
        return

    total_qty      = sum(r["quantity"] for r in rows)
    total_kg       = sum(r["weight_kg"] for r in rows)
    total_earnings = sum(r["earnings"]  for r in rows)

    today_str = date.today().strftime("%d.%m.%Y")
    lines = [f"📋 *Bugungi partiyalar* ({today_str}) — {len(rows)} ta\n"]
    for r in rows:
        kg_part = f" | {r['weight_kg']:.1f} kg" if r["weight_kg"] > 0 else ""
        lines.append(
            f"• `{r['batch_code']}` | {r['product']} | *{r['quantity']} dona*{kg_part}"
        )
    lines.append(f"\n📦 Jami: *{total_qty} dona*")
    if total_kg > 0:
        lines.append(f"⚖️ Jami og'irlik: *{total_kg:.1f} kg*")
    lines.append(f"💰 Jami haq: *{total_earnings:,.0f} so'm*")

    await update.message.reply_text(
        "\n".join(lines),
        parse_mode="Markdown",
        reply_markup=main_menu_keyboard(),
    )


async def unknown_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "Iltimos, quyidagi tugmalardan foydalaning:",
        reply_markup=main_menu_keyboard(),
    )


def register(app) -> None:
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(
        MessageHandler(filters.Regex(r"^📋 Bugungi partiyalar$"), today_batches_handler)
    )
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, unknown_handler))
