from telegram import Update
from telegram.ext import ContextTypes
from ..database import get_today_batches
from ..keyboards import main_menu_keyboard


async def show_today_batches(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    rows = get_today_batches()

    if not rows:
        await update.message.reply_text(
            "📋 Bugun hali partiya kiritilmagan.",
            reply_markup=main_menu_keyboard(),
        )
        return

    total_qty = sum(r["quantity"] for r in rows)
    lines = [f"📋 *Bugungi partiyalar* — {len(rows)} ta\n"]
    for r in rows:
        lines.append(f"• `{r['batch_code']}` | {r['product']} | *{r['quantity']} dona*")
    lines.append(f"\n📦 Jami: *{total_qty} dona*")

    await update.message.reply_text(
        "\n".join(lines),
        parse_mode="Markdown",
        reply_markup=main_menu_keyboard(),
    )
