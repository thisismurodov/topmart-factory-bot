"""
Ombor (Inventory) handlers for Telegram bot.
Menu: ➕ Kirim | ➖ Chiqim | 🔄 O'tkazish | 📋 Qoldiqlar | 📜 Tarix
Kirimda kategoriya tanlanadi: 📦 Tayyor mahsulot | 🧵 Xom ashyo
"""
import re

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, ReplyKeyboardMarkup
from telegram.ext import (
    ContextTypes, ConversationHandler, MessageHandler,
    CallbackQueryHandler, filters,
)
from ..database import (
    get_user_role, get_warehouses, get_warehouse_by_name,
    get_stock_by_warehouse, get_stock_for_warehouse, get_stock_by_warehouse_typed,
    record_movement, get_recent_movements, get_product_names,
    get_sale_products, get_raw_material_names, get_store_product_names,
    get_containers, get_inventory_line,
    get_raw_materials_full, get_raw_material_by_id,
    get_stock_locations, get_unit_for_item,
)
from ..api_client import adjust_inventory, adjust_raw_material

# ── States ─────────────────────────────────────────────────────────────────────
(
    INV_MAIN,
    INV_IN_CATEGORY, INV_IN_PRODUCT, INV_IN_QTY, INV_IN_WAREHOUSE, INV_IN_CONFIRM,
    INV_OUT_WAREHOUSE, INV_OUT_PRODUCT, INV_OUT_QTY, INV_OUT_CONFIRM,
    INV_TR_FROM, INV_TR_PRODUCT, INV_TR_QTY, INV_TR_TO, INV_TR_CONFIRM,
    INV_ADJ_CONTAINER, INV_ADJ_PRODUCT, INV_ADJ_QTY, INV_ADJ_WEIGHT, INV_ADJ_CONFIRM,
    INV_RADJ_MATERIAL, INV_RADJ_STOCK, INV_RADJ_CONFIRM,
) = range(23)


# ── Keyboards ──────────────────────────────────────────────────────────────────

def _inv_main_kb() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        [
            ["➕ Kirim", "➖ Chiqim"],
            ["🔄 Skladlararo o'tkazish"],
            ["✏️ Konteynerni to'g'rilash"],
            ["🧵 Xom ashyoni to'g'rilash"],
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


def _fmt_amt(v) -> str:
    """837.7 → '837.7', 61080 → '61 080', 4572.25 → '4 572.3'."""
    s = f"{float(v):,.1f}".replace(",", " ")
    return s[:-2] if s.endswith(".0") else s


def _stock_line(r: dict) -> str:
    """Inventar qatori uchun 'X dona · Y kg' ko'rinishidagi matn."""
    parts = []
    if float(r.get("quantity") or 0) > 0:
        parts.append(f"{_fmt_amt(r['quantity'])} dona")
    if float(r.get("weight_kg") or 0) > 0:
        parts.append(f"{_fmt_amt(r['weight_kg'])} kg")
    return " · ".join(parts) if parts else "0"


def _md(s) -> str:
    """Telegram legacy-Markdown maxsus belgilarini ekranlash (_ * ` [)."""
    return re.sub(r"([_*`\[])", r"\\\1", str(s))


def _stock_list_text(items: list[dict], key: str = "product", max_lines: int = 25) -> str:
    lines = [f"  • {_md(i[key])} — {_stock_line(i)}" for i in items[:max_lines]]
    if len(items) > max_lines:
        lines.append(f"  … yana {len(items) - max_lines} ta")
    return "\n".join(lines)


# ── Entry ──────────────────────────────────────────────────────────────────────

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
# ➕  KIRIM — 1. Kategoriya tanlash
# ══════════════════════════════════════════════════════════════════════════════

async def kirim_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    await update.message.reply_text(
        "➕ *Kirim*\n\nQaysi kategoriya?",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup([
            [
                InlineKeyboardButton("📦 Tayyor mahsulot", callback_data="kcat:finished"),
                InlineKeyboardButton("🧵 Xom ashyo",       callback_data="kcat:raw"),
            ],
            [InlineKeyboardButton("🏬 Ombor mahsuloti", callback_data="kcat:store")],
            [InlineKeyboardButton("❌ Bekor", callback_data="kcat:cancel")],
        ]),
    )
    return INV_IN_CATEGORY


async def kirim_category_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data == "kcat:cancel":
        await q.edit_message_text("❌ Bekor qilindi.")
        return INV_MAIN

    cat = q.data.split(":", 1)[1]  # 'finished' / 'store' / 'raw'
    # 'store' (ombor mahsuloti) inventar va harakat turi bo'yicha 'finished':
    # birlik products.unit_type dan olinadi, harakat product_type='finished' yoziladi.
    ctx.user_data["inv_product_type"] = "finished" if cat == "store" else cat

    if cat == "finished":
        # sotuv mahsulotlari — unified products jadvali
        prods = [p["name"] for p in get_sale_products()]
        label = "📦 Tayyor mahsulot tanlang:"
    elif cat == "store":
        # ombor mahsulotlari — katalogda bor, sotuv/ishlab chiqarishda yo'q
        prods = get_store_product_names()
        label = "🏬 Ombor mahsulotini tanlang:"
    else:
        # xom ashyo
        prods = get_raw_material_names()
        label = "🧵 Xom ashyo tanlang:"

    if not prods:
        await q.edit_message_text(
            "❌ Ro'yxat bo'sh.\n"
            + ("Admin panelidan sotuv mahsulotlari qo'shing." if cat == "finished"
               else "Ombor mahsulotlari topilmadi." if cat == "store"
               else "Admin panelidan xom ashyo qo'shing.")
        )
        return INV_MAIN

    await q.edit_message_text(
        label,
        reply_markup=_product_inline(prods, "kp"),
    )
    return INV_IN_PRODUCT


# ── 2. Mahsulot tanlash ───────────────────────────────────────────────────────

async def kirim_product_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data == "kp:cancel":
        await q.edit_message_text("❌ Bekor qilindi.")
        return INV_MAIN
    ctx.user_data["inv_product"] = q.data.split(":", 1)[1]
    unit = get_unit_for_item(
        ctx.user_data["inv_product"],
        ctx.user_data.get("inv_product_type", "finished"),
    )
    ctx.user_data["inv_unit"] = unit
    prompt = "⚖️ Og'irlikni kiriting (kg):" if unit == "kg" else "📊 Miqdorni kiriting (dona):"
    await q.edit_message_text(
        f"📦 Mahsulot: *{_md(ctx.user_data['inv_product'])}*\n\n{prompt}",
        parse_mode="Markdown",
    )
    return INV_IN_QTY


# ── 3. Miqdor ─────────────────────────────────────────────────────────────────

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
    product = ctx.user_data["inv_product"]
    locs = get_stock_locations(product)
    if locs:
        stock_txt = (
            f"📍 *{_md(product)}* hozir skladlarda:\n"
            + _stock_list_text(locs, key="warehouse")
            + "\n\n"
        )
    else:
        stock_txt = f"📍 *{_md(product)}* hozircha hech bir skladda yo'q.\n\n"
    await update.message.reply_text(
        stock_txt + "🏬 Qaysi skladga kiritiladi?",
        parse_mode="Markdown",
        reply_markup=_warehouse_inline(warehouses, "kw"),
    )
    return INV_IN_WAREHOUSE


# ── 4. Sklad ──────────────────────────────────────────────────────────────────

async def kirim_warehouse_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data == "kw:cancel":
        await q.edit_message_text("❌ Bekor.")
        return INV_MAIN
    parts = q.data.split(":", 2)
    ctx.user_data["inv_wh_id"]   = int(parts[1])
    ctx.user_data["inv_wh_name"] = parts[2]
    p   = ctx.user_data["inv_product"]
    qty = ctx.user_data["inv_qty"]
    wh  = ctx.user_data["inv_wh_name"]
    cat = ctx.user_data.get("inv_product_type", "finished")
    unit = ctx.user_data.get("inv_unit", "dona")
    cat_label = "📦 Tayyor mahsulot" if cat == "finished" else "🧵 Xom ashyo"
    amt_line = (
        f"⚖️ Og'irlik: *{_fmt_amt(qty)} kg*" if unit == "kg"
        else f"📊 Miqdor: *{_fmt_amt(qty)} dona*"
    )
    await q.edit_message_text(
        f"✅ *Tasdiqlang:*\n\n"
        f"Kategoriya: *{cat_label}*\n"
        f"📦 Mahsulot: *{_md(p)}*\n"
        f"{amt_line}\n"
        f"🏬 Sklad: *{_md(wh)}*",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("✅ Tasdiqlash", callback_data="kconfirm:yes"),
            InlineKeyboardButton("❌ Bekor",      callback_data="kconfirm:no"),
        ]]),
    )
    return INV_IN_CONFIRM


# ── 5. Tasdiqlash ─────────────────────────────────────────────────────────────

async def kirim_confirm_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data != "kconfirm:yes":
        await q.edit_message_text("❌ Bekor qilindi.")
        return INV_MAIN
    user       = get_user_role(update.effective_chat.id)
    created_by = user["worker_name"] if user else str(update.effective_chat.id)
    cat        = ctx.user_data.get("inv_product_type", "finished")
    unit       = ctx.user_data.get("inv_unit", "dona")
    qty        = ctx.user_data["inv_qty"]
    if unit == "kg":
        ok = record_movement(
            product=ctx.user_data["inv_product"],
            quantity=0,
            movement_type="IN",
            from_warehouse_id=None,
            to_warehouse_id=ctx.user_data["inv_wh_id"],
            note=f"Bot kirim: {qty} kg",
            created_by=created_by,
            product_type=cat,
            weight_kg=qty,
        )
    else:
        ok = record_movement(
            product=ctx.user_data["inv_product"],
            quantity=qty,
            movement_type="IN",
            from_warehouse_id=None,
            to_warehouse_id=ctx.user_data["inv_wh_id"],
            note=f"Bot kirim: {qty} dona",
            created_by=created_by,
            product_type=cat,
        )
    cat_label = "📦 Tayyor mahsulot" if cat == "finished" else "🧵 Xom ashyo"
    if ok:
        await q.edit_message_text(
            f"✅ *Kirim qabul qilindi!*\n\n"
            f"{cat_label}\n"
            f"📦 {_md(ctx.user_data['inv_product'])} — {_fmt_amt(qty)} {unit}\n"
            f"🏬 {_md(ctx.user_data['inv_wh_name'])}",
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
    ctx.user_data["inv_from_id"]   = int(parts[1])
    ctx.user_data["inv_from_name"] = parts[2]
    items = get_stock_for_warehouse(int(parts[1]))
    if not items:
        await q.edit_message_text("⚠️ Bu skladda mahsulot yo'q.")
        return INV_MAIN
    products = [i["product"] for i in items]
    await q.edit_message_text(
        f"🏬 Sklad: *{_md(parts[2])}*\n\n{_stock_list_text(items)}\n\nMahsulotni tanlang:",
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
    line = get_inventory_line(ctx.user_data["inv_from_id"], ctx.user_data["inv_product"])
    qty_av = float(line["quantity"] or 0) if line else 0.0
    w_av   = float(line["weight_kg"] or 0) if line else 0.0
    unit = "kg" if (line and (line["unit_type"] == "kg" or (qty_av <= 0 and w_av > 0))) else "dona"
    ctx.user_data["inv_unit"]  = unit
    ctx.user_data["inv_avail"] = w_av if unit == "kg" else qty_av
    prompt = (
        f"⚖️ Og'irlik kiriting (bor: {_fmt_amt(w_av)} kg):" if unit == "kg"
        else f"📊 Miqdor kiriting (bor: {_fmt_amt(qty_av)} dona):"
    )
    await q.edit_message_text(
        f"📦 *{_md(ctx.user_data['inv_product'])}*\n\n{prompt}",
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
    unit  = ctx.user_data.get("inv_unit", "dona")
    avail = float(ctx.user_data.get("inv_avail") or 0)
    if qty > avail + 1e-9:
        await update.message.reply_text(
            f"⚠️ Skladda faqat {_fmt_amt(avail)} {unit} bor. Qaytadan kiriting:"
        )
        return INV_OUT_QTY
    ctx.user_data["inv_qty"] = qty
    p  = ctx.user_data["inv_product"]
    wh = ctx.user_data["inv_from_name"]
    await update.message.reply_text(
        f"✅ *Tasdiqlang:*\n\n📦 {_md(p)}\n📊 {_fmt_amt(qty)} {unit}\n🏬 {_md(wh)} dan chiqim",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("✅ Tasdiqlash", callback_data="cconfirm:yes"),
            InlineKeyboardButton("❌ Bekor",      callback_data="cconfirm:no"),
        ]]),
    )
    return INV_OUT_CONFIRM


async def chiqim_confirm_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data != "cconfirm:yes":
        await q.edit_message_text("❌ Bekor.")
        return INV_MAIN
    user       = get_user_role(update.effective_chat.id)
    created_by = user["worker_name"] if user else str(update.effective_chat.id)
    # product_type ni inventory jadvalidan olamiz
    items = get_stock_for_warehouse(ctx.user_data["inv_from_id"])
    pt = "finished"
    for i in items:
        if i["product"] == ctx.user_data["inv_product"]:
            pt = i.get("product_type", "finished")
            break
    unit = ctx.user_data.get("inv_unit", "dona")
    qty  = ctx.user_data["inv_qty"]
    if unit == "kg":
        ok = record_movement(
            product=ctx.user_data["inv_product"],
            quantity=0,
            movement_type="OUT",
            from_warehouse_id=ctx.user_data["inv_from_id"],
            to_warehouse_id=None,
            note=f"Bot chiqim: {qty} kg",
            created_by=created_by,
            product_type=pt,
            weight_kg=qty,
        )
    else:
        ok = record_movement(
            product=ctx.user_data["inv_product"],
            quantity=qty,
            movement_type="OUT",
            from_warehouse_id=ctx.user_data["inv_from_id"],
            to_warehouse_id=None,
            note=f"Bot chiqim: {qty} dona",
            created_by=created_by,
            product_type=pt,
        )
    if ok:
        await q.edit_message_text(
            f"✅ *Chiqim amalga oshirildi!*\n\n"
            f"📦 {_md(ctx.user_data['inv_product'])} — {_fmt_amt(qty)} {unit}\n"
            f"🏬 {_md(ctx.user_data['inv_from_name'])}",
            parse_mode="Markdown",
        )
    else:
        line = get_inventory_line(ctx.user_data["inv_from_id"], ctx.user_data["inv_product"])
        avail_now = 0.0
        if line:
            avail_now = float(line["weight_kg"] or 0) if unit == "kg" else float(line["quantity"] or 0)
        await q.edit_message_text(
            f"❌ Bajarilmadi: skladda yetarli qoldiq yo'q.\n"
            f"Hozir bor: {_fmt_amt(avail_now)} {unit}, so'ralgan: {_fmt_amt(qty)} {unit}.\n"
            f"Qoldiq boshqa amal bilan o'zgargan bo'lishi mumkin — qaytadan urinib ko'ring."
        )
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
    ctx.user_data["inv_from_id"]   = int(parts[1])
    ctx.user_data["inv_from_name"] = parts[2]
    items = get_stock_for_warehouse(int(parts[1]))
    if not items:
        await q.edit_message_text(f"⚠️ *{_md(parts[2])}* da mahsulot yo'q.", parse_mode="Markdown")
        return INV_MAIN
    products = [i["product"] for i in items]
    await q.edit_message_text(
        f"🏬 Dan: *{_md(parts[2])}*\n\n{_stock_list_text(items)}\n\nMahsulot tanlang:",
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
    line = get_inventory_line(ctx.user_data["inv_from_id"], ctx.user_data["inv_product"])
    qty_av = float(line["quantity"] or 0) if line else 0.0
    w_av   = float(line["weight_kg"] or 0) if line else 0.0
    unit = "kg" if (line and (line["unit_type"] == "kg" or (qty_av <= 0 and w_av > 0))) else "dona"
    ctx.user_data["inv_unit"]  = unit
    ctx.user_data["inv_avail"] = w_av if unit == "kg" else qty_av
    prompt = (
        f"⚖️ Og'irlik kiriting (bor: {_fmt_amt(w_av)} kg):" if unit == "kg"
        else f"📊 Miqdor kiriting (bor: {_fmt_amt(qty_av)} dona):"
    )
    await q.edit_message_text(
        f"📦 *{_md(ctx.user_data['inv_product'])}*\n\n{prompt}",
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
    unit  = ctx.user_data.get("inv_unit", "dona")
    avail = float(ctx.user_data.get("inv_avail") or 0)
    if qty > avail + 1e-9:
        await update.message.reply_text(
            f"⚠️ Skladda faqat {_fmt_amt(avail)} {unit} bor. Qaytadan kiriting:"
        )
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
    ctx.user_data["inv_to_id"]   = int(parts[1])
    ctx.user_data["inv_to_name"] = parts[2]
    p   = ctx.user_data["inv_product"]
    qty = ctx.user_data["inv_qty"]
    frm = ctx.user_data["inv_from_name"]
    to  = ctx.user_data["inv_to_name"]
    unit = ctx.user_data.get("inv_unit", "dona")
    await q.edit_message_text(
        f"✅ *Tasdiqlang:*\n\n📦 {_md(p)}\n📊 {_fmt_amt(qty)} {unit}\n🏬 {_md(frm)} → {_md(to)}",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("✅ Tasdiqlash", callback_data="tconfirm:yes"),
            InlineKeyboardButton("❌ Bekor",      callback_data="tconfirm:no"),
        ]]),
    )
    return INV_TR_CONFIRM


async def transfer_confirm_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data != "tconfirm:yes":
        await q.edit_message_text("❌ Bekor.")
        return INV_MAIN
    user       = get_user_role(update.effective_chat.id)
    created_by = user["worker_name"] if user else str(update.effective_chat.id)
    items = get_stock_for_warehouse(ctx.user_data["inv_from_id"])
    pt = "finished"
    for i in items:
        if i["product"] == ctx.user_data["inv_product"]:
            pt = i.get("product_type", "finished")
            break
    unit = ctx.user_data.get("inv_unit", "dona")
    qty  = ctx.user_data["inv_qty"]
    if unit == "kg":
        ok = record_movement(
            product=ctx.user_data["inv_product"],
            quantity=0,
            movement_type="TRANSFER",
            from_warehouse_id=ctx.user_data["inv_from_id"],
            to_warehouse_id=ctx.user_data["inv_to_id"],
            note=f"Bot o'tkazma: {qty} kg",
            created_by=created_by,
            product_type=pt,
            weight_kg=qty,
        )
    else:
        ok = record_movement(
            product=ctx.user_data["inv_product"],
            quantity=qty,
            movement_type="TRANSFER",
            from_warehouse_id=ctx.user_data["inv_from_id"],
            to_warehouse_id=ctx.user_data["inv_to_id"],
            note=f"Bot o'tkazma: {qty} dona",
            created_by=created_by,
            product_type=pt,
        )
    if ok:
        await q.edit_message_text(
            f"✅ *O'tkazma amalga oshirildi!*\n\n"
            f"📦 {_md(ctx.user_data['inv_product'])} — {_fmt_amt(qty)} {unit}\n"
            f"🏬 {_md(ctx.user_data['inv_from_name'])} → {_md(ctx.user_data['inv_to_name'])}",
            parse_mode="Markdown",
        )
    else:
        line = get_inventory_line(ctx.user_data["inv_from_id"], ctx.user_data["inv_product"])
        avail_now = 0.0
        if line:
            avail_now = float(line["weight_kg"] or 0) if unit == "kg" else float(line["quantity"] or 0)
        await q.edit_message_text(
            f"❌ Bajarilmadi: skladda yetarli qoldiq yo'q.\n"
            f"Hozir bor: {_fmt_amt(avail_now)} {unit}, so'ralgan: {_fmt_amt(qty)} {unit}.\n"
            f"Qoldiq boshqa amal bilan o'zgargan bo'lishi mumkin — qaytadan urinib ko'ring."
        )
    return INV_MAIN


# ══════════════════════════════════════════════════════════════════════════════
# ✏️  KONTEYNERNI TO'G'RILASH (qayta sanash / to'kilish tuzatishi)
# Bot inventarni o'zi o'zgartirmaydi — Node API (/ombor/adjust) orqali o'tadi,
# shunda miqdor VA og'irlik (kg) bir amalda halol to'g'rilanadi.
# ══════════════════════════════════════════════════════════════════════════════

async def adjust_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    containers = get_containers()
    if not containers:
        await update.message.reply_text("⚠️ Konteyner topilmadi.", reply_markup=_inv_main_kb())
        return INV_MAIN
    await update.message.reply_text(
        "✏️ *Konteynerni to'g'rilash*\n\nQaysi konteyner?",
        parse_mode="Markdown",
        reply_markup=_warehouse_inline(containers, "aw"),
    )
    return INV_ADJ_CONTAINER


async def adjust_container_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data == "aw:cancel":
        await q.edit_message_text("❌ Bekor.")
        return INV_MAIN
    parts = q.data.split(":", 2)
    ctx.user_data["adj_wh_id"]   = int(parts[1])
    ctx.user_data["adj_wh_name"] = parts[2]
    items = get_stock_for_warehouse(int(parts[1]))
    if not items:
        await q.edit_message_text(f"⚠️ *{parts[2]}* bo'sh.", parse_mode="Markdown")
        return INV_MAIN
    products = [i["product"] for i in items]
    await q.edit_message_text(
        f"🏬 Konteyner: *{parts[2]}*\n\nMahsulotni tanlang:",
        parse_mode="Markdown",
        reply_markup=_product_inline(products, "ap"),
    )
    return INV_ADJ_PRODUCT


async def adjust_product_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data == "ap:cancel":
        await q.edit_message_text("❌ Bekor.")
        return INV_MAIN
    product = q.data.split(":", 1)[1]
    line = get_inventory_line(ctx.user_data["adj_wh_id"], product)
    if not line:
        await q.edit_message_text("⚠️ Mahsulot bu konteynerda topilmadi.")
        return INV_MAIN
    unit = str(line.get("unit_type") or "dona").lower()
    ctx.user_data["adj_product"]    = product
    ctx.user_data["adj_unit"]       = unit
    ctx.user_data["adj_old_qty"]    = float(line["quantity"] or 0)
    ctx.user_data["adj_old_weight"] = float(line["weight_kg"] or 0)

    txt = (
        f"📦 *{product}*\n"
        f"Joriy miqdor: *{ctx.user_data['adj_old_qty']:g}*"
    )
    if unit == "kg":
        txt += f"\nJoriy og'irlik: *{ctx.user_data['adj_old_weight']:g} kg*"
    txt += "\n\nTo'g'ri miqdorni kiriting:"
    await q.edit_message_text(txt, parse_mode="Markdown")
    return INV_ADJ_QTY


async def adjust_qty(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    try:
        qty = float(update.message.text.replace(",", "."))
        if qty < 0:
            raise ValueError
    except ValueError:
        await update.message.reply_text("⚠️ 0 yoki musbat son kiriting:")
        return INV_ADJ_QTY
    ctx.user_data["adj_qty"] = qty
    # kg-mahsulot uchun og'irlik majburiy; dona uchun so'ramaymiz.
    if ctx.user_data.get("adj_unit") == "kg":
        await update.message.reply_text("⚖️ To'g'ri og'irlikni kiriting (kg):")
        return INV_ADJ_WEIGHT
    return await _adjust_show_confirm(update, ctx)


async def adjust_weight(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    try:
        w = float(update.message.text.replace(",", "."))
        if w < 0:
            raise ValueError
    except ValueError:
        await update.message.reply_text("⚠️ 0 yoki musbat son kiriting:")
        return INV_ADJ_WEIGHT
    ctx.user_data["adj_weight"] = w
    return await _adjust_show_confirm(update, ctx)


async def _adjust_show_confirm(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    unit = ctx.user_data.get("adj_unit", "dona")
    lines = [
        "✅ *Tasdiqlang:*\n",
        f"🏬 Konteyner: *{ctx.user_data['adj_wh_name']}*",
        f"📦 Mahsulot: *{ctx.user_data['adj_product']}*",
        f"📊 Miqdor: {ctx.user_data['adj_old_qty']:g} → *{ctx.user_data['adj_qty']:g}*",
    ]
    if unit == "kg":
        lines.append(
            f"⚖️ Og'irlik: {ctx.user_data['adj_old_weight']:g} → *{ctx.user_data['adj_weight']:g} kg*"
        )
    await update.message.reply_text(
        "\n".join(lines),
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("✅ Tasdiqlash", callback_data="aconfirm:yes"),
            InlineKeyboardButton("❌ Bekor",      callback_data="aconfirm:no"),
        ]]),
    )
    return INV_ADJ_CONFIRM


async def adjust_confirm_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data != "aconfirm:yes":
        await q.edit_message_text("❌ Bekor.")
        return INV_MAIN
    user = get_user_role(update.effective_chat.id)
    who  = user["worker_name"] if user else str(update.effective_chat.id)
    unit = ctx.user_data.get("adj_unit", "dona")
    weight = ctx.user_data.get("adj_weight") if unit == "kg" else None

    ok, err = adjust_inventory(
        warehouse_id=ctx.user_data["adj_wh_id"],
        product=ctx.user_data["adj_product"],
        qty=ctx.user_data["adj_qty"],
        weight_kg=weight,
        note=f"Bot orqali tuzatish: {who}",
        operator=who,
    )
    if ok:
        msg = (
            f"✅ *To'g'rilandi!*\n\n"
            f"🏬 {ctx.user_data['adj_wh_name']}\n"
            f"📦 {ctx.user_data['adj_product']} — {ctx.user_data['adj_qty']:g}"
        )
        if unit == "kg" and weight is not None:
            msg += f"\n⚖️ {weight:g} kg"
        await q.edit_message_text(msg, parse_mode="Markdown")
    else:
        reason = err or "nomalum"
        await q.edit_message_text(f"❌ Xatolik: {reason}")
    return INV_MAIN


# ══════════════════════════════════════════════════════════════════════════════
# 🧵  XOM ASHYONI TO'G'RILASH (qayta sanash / to'kilish tuzatishi)
# Bot raw_materials ni o'zi o'zgartirmaydi — Node API (/ombor/raw-adjust) orqali
# o'tadi: yangi qiymat ABSOLYUT o'rnatiladi va delta IN/OUT log qilinadi.
# ══════════════════════════════════════════════════════════════════════════════

def _raw_material_inline(materials: list[dict], prefix: str) -> InlineKeyboardMarkup:
    rows = []
    for i in range(0, len(materials), 2):
        m = materials[i]
        row = [InlineKeyboardButton(m["name"], callback_data=f"{prefix}:{m['id']}")]
        if i + 1 < len(materials):
            m2 = materials[i + 1]
            row.append(InlineKeyboardButton(m2["name"], callback_data=f"{prefix}:{m2['id']}"))
        rows.append(row)
    rows.append([InlineKeyboardButton("❌ Bekor", callback_data=f"{prefix}:cancel")])
    return InlineKeyboardMarkup(rows)


async def raw_adjust_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    materials = get_raw_materials_full()
    if not materials:
        await update.message.reply_text("⚠️ Xom ashyo topilmadi.", reply_markup=_inv_main_kb())
        return INV_MAIN
    await update.message.reply_text(
        "🧵 *Xom ashyoni to'g'rilash*\n\nQaysi xom ashyo?",
        parse_mode="Markdown",
        reply_markup=_raw_material_inline(materials, "rm"),
    )
    return INV_RADJ_MATERIAL


async def raw_adjust_material_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data == "rm:cancel":
        await q.edit_message_text("❌ Bekor.")
        return INV_MAIN
    material_id = int(q.data.split(":", 1)[1])
    mat = get_raw_material_by_id(material_id)
    if not mat:
        await q.edit_message_text("⚠️ Xom ashyo topilmadi.")
        return INV_MAIN
    ctx.user_data["radj_id"]    = material_id
    ctx.user_data["radj_name"]  = mat["name"]
    ctx.user_data["radj_unit"]  = mat["unit"] or "kg"
    ctx.user_data["radj_old"]   = float(mat["current_stock"] or 0)
    await q.edit_message_text(
        f"🧵 *{mat['name']}*\n"
        f"Joriy zahira: *{ctx.user_data['radj_old']:g} {ctx.user_data['radj_unit']}*\n\n"
        f"To'g'ri zahirani kiriting:",
        parse_mode="Markdown",
    )
    return INV_RADJ_STOCK


async def raw_adjust_stock(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    try:
        stock = float(update.message.text.replace(",", "."))
        if stock < 0:
            raise ValueError
    except ValueError:
        await update.message.reply_text("⚠️ 0 yoki musbat son kiriting:")
        return INV_RADJ_STOCK
    ctx.user_data["radj_stock"] = stock
    await update.message.reply_text(
        "✅ *Tasdiqlang:*\n\n"
        f"🧵 Xom ashyo: *{ctx.user_data['radj_name']}*\n"
        f"📊 Zahira: {ctx.user_data['radj_old']:g} → *{stock:g} {ctx.user_data['radj_unit']}*",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("✅ Tasdiqlash", callback_data="raconfirm:yes"),
            InlineKeyboardButton("❌ Bekor",      callback_data="raconfirm:no"),
        ]]),
    )
    return INV_RADJ_CONFIRM


async def raw_adjust_confirm_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    q = update.callback_query
    await q.answer()
    if q.data != "raconfirm:yes":
        await q.edit_message_text("❌ Bekor.")
        return INV_MAIN
    user = get_user_role(update.effective_chat.id)
    who  = user["worker_name"] if user else str(update.effective_chat.id)
    ok, err = adjust_raw_material(
        material_id=ctx.user_data["radj_id"],
        stock=ctx.user_data["radj_stock"],
        note=f"Bot orqali tuzatish: {who}",
        operator=who,
    )
    if ok:
        await q.edit_message_text(
            f"✅ *To'g'rilandi!*\n\n"
            f"🧵 {ctx.user_data['radj_name']} — "
            f"{ctx.user_data['radj_stock']:g} {ctx.user_data['radj_unit']}",
            parse_mode="Markdown",
        )
    else:
        reason = err or "nomalum"
        await q.edit_message_text(f"❌ Xatolik: {reason}")
    return INV_MAIN


# ══════════════════════════════════════════════════════════════════════════════
# 📋  QOLDIQLAR — kategoriya bo'yicha ajratilgan
# ══════════════════════════════════════════════════════════════════════════════

async def qoldiqlar(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    data = get_stock_by_warehouse_typed()
    finished = data.get("finished", [])
    raw      = data.get("raw", [])

    if not finished and not raw:
        await update.message.reply_text("📋 Ombor bo'sh.", reply_markup=_inv_main_kb())
        return INV_MAIN

    lines = ["📋 *Ombor Qoldiqlari*\n"]

    # Tayyor mahsulotlar
    if finished:
        lines.append("📦 *Tayyor mahsulotlar*")
        groups: dict = {}
        for r in finished:
            wh = r["warehouse_name"]
            groups.setdefault(wh, []).append(r)
        for wh, items in groups.items():
            lines.append(f"  🏬 {wh}")
            for i in items:
                lines.append(f"    • {i['product']} — {_stock_line(i)}")
        lines.append("")

    # Xom ashyo
    if raw:
        lines.append("🧵 *Xom ashyo*")
        groups2: dict = {}
        for r in raw:
            wh = r["warehouse_name"]
            groups2.setdefault(wh, []).append(r)
        for wh, items in groups2.items():
            lines.append(f"  🏬 {wh}")
            for i in items:
                lines.append(f"    • {i['product']} — {_stock_line(i)}")

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
        t    = r["created_at"]
        time_str = t.strftime("%d/%m %H:%M") if hasattr(t, "strftime") else str(t)[:16]
        pt_icon = "📦" if r.get("product_type") == "finished" else "🧵"
        if r["movement_type"] == "IN":
            where = f"→ {r['to_wh']}"
        elif r["movement_type"] == "OUT":
            where = f"← {r['from_wh']}"
        else:
            where = f"{r['from_wh']} → {r['to_wh']}"
        qty_v = float(r["quantity"] or 0)
        w_v   = float(r.get("weight_kg") or 0)
        if r.get("product_type") == "raw":
            amount = f"{_fmt_amt(qty_v if qty_v > 0 else w_v)} kg"
        elif qty_v > 0:
            amount = f"{_fmt_amt(qty_v)} dona"
        elif w_v > 0:
            amount = f"{_fmt_amt(w_v)} kg"
        else:
            amount = "0"
        lines.append(f"{icon}{pt_icon} `{time_str}` | *{r['product']}* {amount} | {where}")

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
                MessageHandler(f.Regex(r"^➕ Kirim$"),                  kirim_start),
                MessageHandler(f.Regex(r"^➖ Chiqim$"),                 chiqim_start),
                MessageHandler(f.Regex(r"^🔄 Skladlararo o'tkazish$"), transfer_start),
                MessageHandler(f.Regex(r"^✏️ Konteynerni to'g'rilash$"), adjust_start),
                MessageHandler(f.Regex(r"^🧵 Xom ashyoni to'g'rilash$"), raw_adjust_start),
                MessageHandler(f.Regex(r"^📋 Qoldiqlar$"),              qoldiqlar),
                MessageHandler(f.Regex(r"^📜 Harakatlar tarixi$"),      tarix),
                MessageHandler(f.Regex(r"^🔙 Asosiy menyu$"),           ombor_back),
            ],
            INV_IN_CATEGORY:  [CallbackQueryHandler(kirim_category_cb,  pattern=r"^kcat:")],
            INV_IN_PRODUCT:   [CallbackQueryHandler(kirim_product_cb,   pattern=r"^kp:")],
            INV_IN_QTY:       [MessageHandler(f.TEXT & ~f.COMMAND,      kirim_qty)],
            INV_IN_WAREHOUSE: [CallbackQueryHandler(kirim_warehouse_cb, pattern=r"^kw:")],
            INV_IN_CONFIRM:   [CallbackQueryHandler(kirim_confirm_cb,   pattern=r"^kconfirm:")],

            INV_OUT_WAREHOUSE: [CallbackQueryHandler(chiqim_warehouse_cb, pattern=r"^cw:")],
            INV_OUT_PRODUCT:   [CallbackQueryHandler(chiqim_product_cb,   pattern=r"^cp:")],
            INV_OUT_QTY:       [MessageHandler(f.TEXT & ~f.COMMAND,       chiqim_qty)],
            INV_OUT_CONFIRM:   [CallbackQueryHandler(chiqim_confirm_cb,   pattern=r"^cconfirm:")],

            INV_TR_FROM:    [CallbackQueryHandler(transfer_from_cb,    pattern=r"^tf:")],
            INV_TR_PRODUCT: [CallbackQueryHandler(transfer_product_cb, pattern=r"^tp:")],
            INV_TR_QTY:     [MessageHandler(f.TEXT & ~f.COMMAND,       transfer_qty)],
            INV_TR_TO:      [CallbackQueryHandler(transfer_to_cb,      pattern=r"^tt:")],
            INV_TR_CONFIRM: [CallbackQueryHandler(transfer_confirm_cb, pattern=r"^tconfirm:")],

            INV_ADJ_CONTAINER: [CallbackQueryHandler(adjust_container_cb, pattern=r"^aw:")],
            INV_ADJ_PRODUCT:   [CallbackQueryHandler(adjust_product_cb,   pattern=r"^ap:")],
            INV_ADJ_QTY:       [MessageHandler(f.TEXT & ~f.COMMAND,       adjust_qty)],
            INV_ADJ_WEIGHT:    [MessageHandler(f.TEXT & ~f.COMMAND,       adjust_weight)],
            INV_ADJ_CONFIRM:   [CallbackQueryHandler(adjust_confirm_cb,   pattern=r"^aconfirm:")],

            INV_RADJ_MATERIAL: [CallbackQueryHandler(raw_adjust_material_cb, pattern=r"^rm:")],
            INV_RADJ_STOCK:    [MessageHandler(f.TEXT & ~f.COMMAND,         raw_adjust_stock)],
            INV_RADJ_CONFIRM:  [CallbackQueryHandler(raw_adjust_confirm_cb, pattern=r"^raconfirm:")],
        },
        fallbacks=[
            MessageHandler(f.Regex(r"^🔙 Asosiy menyu$"), ombor_back),
        ],
        allow_reentry=True,
    )
