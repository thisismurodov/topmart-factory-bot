"""
Ombor (Inventory) handlers for Telegram bot.
Menu: ➕ Kirim | ➖ Chiqim | 🔄 O'tkazish | 📋 Qoldiqlar | 📜 Tarix
"""
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, ReplyKeyboardMarkup
from telegram.ext import (
    ContextTypes, ConversationHandler, MessageHandler,
    CallbackQueryHandler, filters,
)
from ..database import (
    get_user_role, get_warehouses, get_warehouse_by_name,
    get_stock_by_warehouse, get_stock_for_warehouse,
    record_movement, get_recent_movements, get_product_names,
)

# ── States ────────────────────────────────────────────────────────────────────
(
    INV_MAIN,
    INV_IN_PRODUCT, INV_IN_QTY, INV_IN_WAREHOUSE, INV_IN_CONFIRM,
    INV_OUT_WAREHOUSE, INV_OUT_PRODUCT, INV_OUT_QTY, INV_OUT_CONFIRM,
    INV_TR_FROM, INV_TR_PRODUCT, INV_TR_QTY, INV_TR_TO, INV_TR_CONFIRM,
) = range(14)


# ── Keyboards ─────────────────────────────────────────────────────────────────

def _inv_main_kb() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        [
            ["➕ Kirim", "➖ Chiqim"],
            ["🔄 Skladlararo o'tkazish"],
            ["📋 Qoldiqlar", "📜 Harakatlar tarixi"],
            ["🔙 Asosiy menyu"],
        ],
        resize_keyboard=True,
    )


def _warehouse_inline(warehouses: list[dict], prefix: str) -> InlineKeyboardMarkup:
    buttons = [
        [InlineKeyboardButton(w["name"], callback_data=f"{prefix}:{w['id']}:{w['name']}")]
        for w in warehouses
    ]
    buttons.append([InlineKeyboardButton("❌ Bekor", callback_data=f"{prefix}:cancel")])
    return InlineKeyboardMarkup(buttons)


def _product_inline(products: list[str], prefix: str) -> InlineKeyboardMarkup:
    rows = []
    for i in range(0, len(products), 2):
        row = [InlineKeyboardButton(products[i], callback_data=f"{prefix}:{products[i]}")]
        if i + 1 < len(products):
            row.append(InlineKeyboardButton(products[i + 1], callback_data=f"{prefix}:{products[i + 1]}"))
        rows.append(row)
    rows.append([InlineKeyboardButton("❌ Bekor", callback_data=f"{prefix}:cancel")])
    return InlineKeyboardMarkup(rows)


def _is_allowed(chat_id: int) -> bool:
    row = get_user_role(chat_id)
    return row is not None and row["role"] in ("admin", "packer")


# ── Entry: "🏬 Ombor" button ──────────────────────────────────────────────────

async def ombor_entry(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    if not _is_allowed(update.effective_chat.id):
        await update.message.reply_text("❌ Ruxsat yo'q.")
        return ConversationHandler.END
    await update.message.reply_text(
        "🏬 *Ombor Boshqaruvi*\n\nAmalni tanlang:",
        parse_mode="Markdown",
        reply_markup=_inv_main_kb(),
    )
    return INV_MAIN


async def ombor_back(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    from ..keyboards import admin_reply_keyboard
    await update.message.reply_text("Asosiy menyuga qaytdingiz.", reply_markup=admin_reply_keyboard())
    return ConversationHandler.END


# ══════════════════════════════════════════════════════════════════════════════
# ➕  KIRIM
# ══════════════════════════════════════════════════════════════════════════════

async def kirim_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    products = get_product_names()
    if not products:
        await update.message.reply_text("❌ Mahsulotlar ro'yxati bo'sh.")
        return INV_MAIN
    await update.message.reply_text(
        "➕ *Kirim*\n\nMahsulotni tanlang:",
        parse_mode="Markdown",
        reply_markup=_product_inline(products, "kp"),
    )
    return INV_IN_PRODUCT


async def kirim_product_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data == "kp:cancel":
        await q.edit_message_text("❌ Bekor qilindi.")
        return INV_MAIN
    ctx.user_data["inv_product"] = q.data.split(":", 1)[1]
    await q.edit_message_text(
        f"📦 Mahsulot: *{ctx.user_data['inv_product']}*\n\nMiqdor kiriting (dona yoki kg):",
        parse_mode="Markdown",
    )
    return INV_IN_QTY


async def kirim_qty(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    try:
        qty = float(update.message.text.replace(",", "."))
        if qty <= 0:
            raise ValueError
    except ValueError:
        await update.message.reply_text("⚠️ Musbat son kiriting:")
        return INV_IN_QTY
    ctx.user_data["inv_qty"] = qty
    warehouses = get_warehouses()
    await update.message.reply_text(
        "🏬 Qaysi skladga kiritiladi?",
        reply_markup=_warehouse_inline(warehouses, "kw"),
    )
    return INV_IN_WAREHOUSE


async def kirim_warehouse_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data == "kw:cancel":
        await q.edit_message_text("❌ Bekor.")
        return INV_MAIN
    parts = q.data.split(":", 2)
    ctx.user_data["inv_wh_id"] = int(parts[1])
    ctx.user_data["inv_wh_name"] = parts[2]
    p = ctx.user_data["inv_product"]
    qty = ctx.user_data["inv_qty"]
    wh = ctx.user_data["inv_wh_name"]
    await q.edit_message_text(
        f"✅ *Tasdiqlang:*\n\n📦 Mahsulot: *{p}*\n📊 Miqdor: *{qty}*\n🏬 Sklad: *{wh}*",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("✅ Tasdiqlash", callback_data="kconfirm:yes"),
            InlineKeyboardButton("❌ Bekor", callback_data="kconfirm:no"),
        ]]),
    )
    return INV_IN_CONFIRM


async def kirim_confirm_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data != "kconfirm:yes":
        await q.edit_message_text("❌ Bekor qilindi.")
        return INV_MAIN
    user = get_user_role(update.effective_chat.id)
    created_by = user["worker_name"] if user else str(update.effective_chat.id)
    ok = record_movement(
        product=ctx.user_data["inv_product"],
        quantity=ctx.user_data["inv_qty"],
        movement_type="IN",
        from_warehouse_id=None,
        to_warehouse_id=ctx.user_data["inv_wh_id"],
        created_by=created_by,
    )
    if ok:
        await q.edit_message_text(
            f"✅ *Kirim qabul qilindi!*\n\n"
            f"📦 {ctx.user_data['inv_product']} — {ctx.user_data['inv_qty']} dona\n"
            f"🏬 {ctx.user_data['inv_wh_name']}",
            parse_mode="Markdown",
        )
    else:
        await q.edit_message_text("❌ Xatolik yuz berdi.")
    return INV_MAIN


# ══════════════════════════════════════════════════════════════════════════════
# ➖  CHIQIM
# ══════════════════════════════════════════════════════════════════════════════

async def chiqim_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    warehouses = get_warehouses()
    await update.message.reply_text(
        "➖ *Chiqim*\n\nQaysi skladdan chiqariladi?",
        parse_mode="Markdown",
        reply_markup=_warehouse_inline(warehouses, "cw"),
    )
    return INV_OUT_WAREHOUSE


async def chiqim_warehouse_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data == "cw:cancel":
        await q.edit_message_text("❌ Bekor.")
        return INV_MAIN
    parts = q.data.split(":", 2)
    ctx.user_data["inv_from_id"] = int(parts[1])
    ctx.user_data["inv_from_name"] = parts[2]
    # Show only products available in that warehouse
    items = get_stock_for_warehouse(int(parts[1]))
    if not items:
        await q.edit_message_text("⚠️ Bu skladda mahsulot yo'q.")
        return INV_MAIN
    products = [i["product"] for i in items]
    await q.edit_message_text(
        f"🏬 Sklad: *{parts[2]}*\n\nMahsulotni tanlang:",
        parse_mode="Markdown",
        reply_markup=_product_inline(products, "cp"),
    )
    return INV_OUT_PRODUCT


async def chiqim_product_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data == "cp:cancel":
        await q.edit_message_text("❌ Bekor.")
        return INV_MAIN
    ctx.user_data["inv_product"] = q.data.split(":", 1)[1]
    await q.edit_message_text(
        f"📦 *{ctx.user_data['inv_product']}*\n\nMiqdor kiriting:",
        parse_mode="Markdown",
    )
    return INV_OUT_QTY


async def chiqim_qty(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    try:
        qty = float(update.message.text.replace(",", "."))
        if qty <= 0:
            raise ValueError
    except ValueError:
        await update.message.reply_text("⚠️ Musbat son kiriting:")
        return INV_OUT_QTY
    ctx.user_data["inv_qty"] = qty
    p = ctx.user_data["inv_product"]
    wh = ctx.user_data["inv_from_name"]
    await update.message.reply_text(
        f"✅ *Tasdiqlang:*\n\n📦 {p}\n📊 {qty} dona\n🏬 {wh} dan chiqim",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("✅ Tasdiqlash", callback_data="cconfirm:yes"),
            InlineKeyboardButton("❌ Bekor", callback_data="cconfirm:no"),
        ]]),
    )
    return INV_OUT_CONFIRM


async def chiqim_confirm_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data != "cconfirm:yes":
        await q.edit_message_text("❌ Bekor.")
        return INV_MAIN
    user = get_user_role(update.effective_chat.id)
    created_by = user["worker_name"] if user else str(update.effective_chat.id)
    ok = record_movement(
        product=ctx.user_data["inv_product"],
        quantity=ctx.user_data["inv_qty"],
        movement_type="OUT",
        from_warehouse_id=ctx.user_data["inv_from_id"],
        to_warehouse_id=None,
        created_by=created_by,
    )
    if ok:
        await q.edit_message_text(
            f"✅ *Chiqim amalga oshirildi!*\n\n"
            f"📦 {ctx.user_data['inv_product']} — {ctx.user_data['inv_qty']} dona\n"
            f"🏬 {ctx.user_data['inv_from_name']}",
            parse_mode="Markdown",
        )
    else:
        await q.edit_message_text("❌ Xatolik.")
    return INV_MAIN


# ══════════════════════════════════════════════════════════════════════════════
# 🔄  SKLADLARARO O'TKAZISH
# ══════════════════════════════════════════════════════════════════════════════

async def transfer_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    warehouses = get_warehouses()
    await update.message.reply_text(
        "🔄 *Skladlararo o'tkazish*\n\nQayerdan?",
        parse_mode="Markdown",
        reply_markup=_warehouse_inline(warehouses, "tf"),
    )
    return INV_TR_FROM


async def transfer_from_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data == "tf:cancel":
        await q.edit_message_text("❌ Bekor.")
        return INV_MAIN
    parts = q.data.split(":", 2)
    ctx.user_data["inv_from_id"] = int(parts[1])
    ctx.user_data["inv_from_name"] = parts[2]
    items = get_stock_for_warehouse(int(parts[1]))
    if not items:
        await q.edit_message_text(f"⚠️ *{parts[2]}* da mahsulot yo'q.", parse_mode="Markdown")
        return INV_MAIN
    products = [i["product"] for i in items]
    await q.edit_message_text(
        f"🏬 Dan: *{parts[2]}*\n\nMahsulot tanlang:",
        parse_mode="Markdown",
        reply_markup=_product_inline(products, "tp"),
    )
    return INV_TR_PRODUCT


async def transfer_product_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data == "tp:cancel":
        await q.edit_message_text("❌ Bekor.")
        return INV_MAIN
    ctx.user_data["inv_product"] = q.data.split(":", 1)[1]
    await q.edit_message_text(
        f"📦 *{ctx.user_data['inv_product']}*\n\nMiqdor kiriting:",
        parse_mode="Markdown",
    )
    return INV_TR_QTY


async def transfer_qty(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    try:
        qty = float(update.message.text.replace(",", "."))
        if qty <= 0:
            raise ValueError
    except ValueError:
        await update.message.reply_text("⚠️ Musbat son kiriting:")
        return INV_TR_QTY
    ctx.user_data["inv_qty"] = qty
    warehouses = [w for w in get_warehouses() if w["id"] != ctx.user_data.get("inv_from_id")]
    await update.message.reply_text(
        "🏬 Qayerga o'tkaziladi?",
        reply_markup=_warehouse_inline(warehouses, "tt"),
    )
    return INV_TR_TO


async def transfer_to_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data == "tt:cancel":
        await q.edit_message_text("❌ Bekor.")
        return INV_MAIN
    parts = q.data.split(":", 2)
    ctx.user_data["inv_to_id"] = int(parts[1])
    ctx.user_data["inv_to_name"] = parts[2]
    p = ctx.user_data["inv_product"]
    qty = ctx.user_data["inv_qty"]
    frm = ctx.user_data["inv_from_name"]
    to = ctx.user_data["inv_to_name"]
    await q.edit_message_text(
        f"✅ *Tasdiqlang:*\n\n📦 {p}\n📊 {qty}\n🏬 {frm} → {to}",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("✅ Tasdiqlash", callback_data="tconfirm:yes"),
            InlineKeyboardButton("❌ Bekor", callback_data="tconfirm:no"),
        ]]),
    )
    return INV_TR_CONFIRM


async def transfer_confirm_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data != "tconfirm:yes":
        await q.edit_message_text("❌ Bekor.")
        return INV_MAIN
    user = get_user_role(update.effective_chat.id)
    created_by = user["worker_name"] if user else str(update.effective_chat.id)
    ok = record_movement(
        product=ctx.user_data["inv_product"],
        quantity=ctx.user_data["inv_qty"],
        movement_type="TRANSFER",
        from_warehouse_id=ctx.user_data["inv_from_id"],
        to_warehouse_id=ctx.user_data["inv_to_id"],
        created_by=created_by,
    )
    if ok:
        await q.edit_message_text(
            f"✅ *O'tkazma amalga oshirildi!*\n\n"
            f"📦 {ctx.user_data['inv_product']} — {ctx.user_data['inv_qty']}\n"
            f"🏬 {ctx.user_data['inv_from_name']} → {ctx.user_data['inv_to_name']}",
            parse_mode="Markdown",
        )
    else:
        await q.edit_message_text("❌ Xatolik.")
    return INV_MAIN


# ══════════════════════════════════════════════════════════════════════════════
# 📋  QOLDIQLAR
# ══════════════════════════════════════════════════════════════════════════════

async def qoldiqlar(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    rows = get_stock_by_warehouse()
    if not rows:
        await update.message.reply_text("📋 Ombor bo'sh.", reply_markup=_inv_main_kb())
        return INV_MAIN

    groups: dict[str, list] = {}
    for r in rows:
        wh = r["warehouse_name"]
        if wh not in groups:
            groups[wh] = []
        groups[wh].append(r)

    lines = ["📋 *Ombor Qoldiqlari*\n"]
    for wh, items in groups.items():
        lines.append(f"🏬 *{wh}*")
        for i in items:
            lines.append(f"  • {i['product']} — {float(i['quantity']):.1f}")
        lines.append("")

    await update.message.reply_text(
        "\n".join(lines),
        parse_mode="Markdown",
        reply_markup=_inv_main_kb(),
    )
    return INV_MAIN


# ══════════════════════════════════════════════════════════════════════════════
# 📜  HARAKATLAR TARIXI
# ══════════════════════════════════════════════════════════════════════════════

async def tarix(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    rows = get_recent_movements(15)
    if not rows:
        await update.message.reply_text("📜 Harakatlar yo'q.", reply_markup=_inv_main_kb())
        return INV_MAIN

    icons = {"IN": "➕", "OUT": "➖", "TRANSFER": "🔄"}
    lines = ["📜 *Oxirgi harakatlar*\n"]
    for r in rows:
        icon = icons.get(r["movement_type"], "•")
        t = r["created_at"]
        time_str = t.strftime("%d/%m %H:%M") if hasattr(t, "strftime") else str(t)[:16]
        where = ""
        if r["movement_type"] == "IN":
            where = f"→ {r['to_wh']}"
        elif r["movement_type"] == "OUT":
            where = f"← {r['from_wh']}"
        else:
            where = f"{r['from_wh']} → {r['to_wh']}"
        lines.append(f"{icon} `{time_str}` | *{r['product']}* {r['quantity']} | {where}")

    await update.message.reply_text(
        "\n".join(lines),
        parse_mode="Markdown",
        reply_markup=_inv_main_kb(),
    )
    return INV_MAIN


# ══════════════════════════════════════════════════════════════════════════════
# BUILD
# ══════════════════════════════════════════════════════════════════════════════

def build_inventory_handler() -> ConversationHandler:
    from telegram.ext import filters as f

    OMBOR_TEXT = f.Regex(r"^🏬 Ombor$")

    return ConversationHandler(
        entry_points=[MessageHandler(OMBOR_TEXT, ombor_entry)],
        states={
            INV_MAIN: [
                MessageHandler(f.Regex(r"^➕ Kirim$"), kirim_start),
                MessageHandler(f.Regex(r"^➖ Chiqim$"), chiqim_start),
                MessageHandler(f.Regex(r"^🔄 Skladlararo o'tkazish$"), transfer_start),
                MessageHandler(f.Regex(r"^📋 Qoldiqlar$"), qoldiqlar),
                MessageHandler(f.Regex(r"^📜 Harakatlar tarixi$"), tarix),
                MessageHandler(f.Regex(r"^🔙 Asosiy menyu$"), ombor_back),
            ],
            INV_IN_PRODUCT:  [CallbackQueryHandler(kirim_product_cb, pattern=r"^kp:")],
            INV_IN_QTY:      [MessageHandler(f.TEXT & ~f.COMMAND, kirim_qty)],
            INV_IN_WAREHOUSE:[CallbackQueryHandler(kirim_warehouse_cb, pattern=r"^kw:")],
            INV_IN_CONFIRM:  [CallbackQueryHandler(kirim_confirm_cb, pattern=r"^kconfirm:")],

            INV_OUT_WAREHOUSE:[CallbackQueryHandler(chiqim_warehouse_cb, pattern=r"^cw:")],
            INV_OUT_PRODUCT:  [CallbackQueryHandler(chiqim_product_cb, pattern=r"^cp:")],
            INV_OUT_QTY:      [MessageHandler(f.TEXT & ~f.COMMAND, chiqim_qty)],
            INV_OUT_CONFIRM:  [CallbackQueryHandler(chiqim_confirm_cb, pattern=r"^cconfirm:")],

            INV_TR_FROM:   [CallbackQueryHandler(transfer_from_cb, pattern=r"^tf:")],
            INV_TR_PRODUCT:[CallbackQueryHandler(transfer_product_cb, pattern=r"^tp:")],
            INV_TR_QTY:    [MessageHandler(f.TEXT & ~f.COMMAND, transfer_qty)],
            INV_TR_TO:     [CallbackQueryHandler(transfer_to_cb, pattern=r"^tt:")],
            INV_TR_CONFIRM:[CallbackQueryHandler(transfer_confirm_cb, pattern=r"^tconfirm:")],
        },
        fallbacks=[
            MessageHandler(f.Regex(r"^🔙 Asosiy menyu$"), ombor_back),
        ],
        allow_reentry=True,
    )
