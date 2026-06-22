from __future__ import annotations

import io
import os
from datetime import date, timedelta

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ContextTypes, CommandHandler, MessageHandler,
    CallbackQueryHandler, filters,
)
from ..config import SUPERADMIN_CHAT_ID
from ..database import get_user_role, get_sales_report_summary

MONTHS_UZ = {
    1: "Yanvar", 2: "Fevral", 3: "Mart", 4: "Aprel",
    5: "May", 6: "Iyun", 7: "Iyul", 8: "Avgust",
    9: "Sentabr", 10: "Oktabr", 11: "Noyabr", 12: "Dekabr",
}


def _is_admin(chat_id: int) -> bool:
    row = get_user_role(chat_id)
    return row is not None and row["role"] == "admin"


def _period_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton("📅 Bugun",      callback_data="rp:today"),
            InlineKeyboardButton("📅 Bu hafta",   callback_data="rp:week"),
        ],
        [
            InlineKeyboardButton("📅 Bu oy",      callback_data="rp:month"),
            InlineKeyboardButton("📅 Oxirgi 30 kun", callback_data="rp:30d"),
        ],
        [InlineKeyboardButton("❌ Bekor", callback_data="rp:cancel")],
    ])


def _fmt_usd(v: float) -> str:
    if v <= 0:
        return "—"
    return f"${v:,.0f}"


def _fmt_uzs(v: float) -> str:
    if v <= 0:
        return "—"
    if v >= 1_000_000:
        return f"{v / 1_000_000:.1f}M so'm"
    if v >= 1_000:
        return f"{v / 1_000:.0f}K so'm"
    return f"{v:,.0f} so'm"


def _period_dates(period: str) -> tuple[str, str, str]:
    today = date.today()
    if period == "today":
        label = f"Bugun ({today.strftime('%d.%m.%Y')})"
        return str(today), str(today), label
    if period == "week":
        start = today - timedelta(days=today.weekday())
        label = f"Bu hafta ({start.strftime('%d.%m')}–{today.strftime('%d.%m.%Y')})"
        return str(start), str(today), label
    if period == "month":
        start = today.replace(day=1)
        label = f"{MONTHS_UZ[today.month]} {today.year}"
        return str(start), str(today), label
    if period == "30d":
        start = today - timedelta(days=29)
        label = f"Oxirgi 30 kun ({start.strftime('%d.%m')}–{today.strftime('%d.%m.%Y')})"
        return str(start), str(today), label
    return str(today), str(today), "Bugun"


def _build_text_report(data: dict, period_label: str) -> str:
    st = data["stats"]
    products = data["products"]
    customers = data["customers"]

    lines = [
        f"📊 *Savdo hisoboti*",
        f"📅 {period_label}",
        "",
        f"📦 Jami savdolar: *{st.get('sale_count', 0)} ta*",
        f"✅ To'langan: *{st.get('paid_count', 0)} ta*",
        f"⏳ Kutilmoqda: *{st.get('pending_count', 0)} ta*",
        "",
    ]

    total_usd = float(st.get("total_usd") or 0)
    total_uzs = float(st.get("total_uzs") or 0)
    if total_usd > 0:
        lines.append(f"💵 Jami (USD): *{_fmt_usd(total_usd)}*")
    if total_uzs > 0:
        lines.append(f"🇺🇿 Jami (UZS): *{_fmt_uzs(total_uzs)}*")
    if total_usd <= 0 and total_uzs <= 0:
        lines.append("_Savdo yo'q_")

    if products:
        lines.append("")
        lines.append("*📦 Mahsulotlar:*")
        for i, p in enumerate(products[:7], 1):
            name = p.get("product_name") or p.get("name") or "—"
            qty = float(p.get("total_qty") or 0)
            rev_usd = float(p.get("rev_usd") or 0)
            rev_uzs = float(p.get("rev_uzs") or 0)
            amt = _fmt_usd(rev_usd) if rev_usd > 0 else _fmt_uzs(rev_uzs)
            lines.append(f"{i}. {name} — {qty:g} birlik → *{amt}*")

    if customers:
        lines.append("")
        lines.append("*👤 Mijozlar:*")
        for i, c in enumerate(customers[:7], 1):
            name = c.get("customer_name") or c.get("name") or "—"
            cnt = c.get("sale_count", 0)
            cusd = float(c.get("total_usd") or 0)
            cuzs = float(c.get("total_uzs") or 0)
            amt = _fmt_usd(cusd) if cusd > 0 else _fmt_uzs(cuzs)
            lines.append(f"{i}. {name} ({cnt} ta) → *{amt}*")

    return "\n".join(lines)


def _build_pdf_report(data: dict, period_label: str) -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib import colors
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable,
    )
    from reportlab.lib.units import cm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    GREEN = colors.HexColor("#0B5D2A")
    LIGHT_GREEN = colors.HexColor("#f0fdf4")
    HEADER_BG = colors.HexColor("#0B5D2A")
    ALT_ROW = colors.HexColor("#f8fafc")

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=1.5 * cm,
        rightMargin=1.5 * cm,
        topMargin=1.5 * cm,
        bottomMargin=1.5 * cm,
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "TitleStyle",
        parent=styles["Title"],
        fontSize=16,
        textColor=GREEN,
        spaceAfter=4,
    )
    subtitle_style = ParagraphStyle(
        "SubStyle",
        parent=styles["Normal"],
        fontSize=10,
        textColor=colors.HexColor("#64748b"),
        spaceAfter=12,
    )
    section_style = ParagraphStyle(
        "SectionStyle",
        parent=styles["Normal"],
        fontSize=11,
        fontName="Helvetica-Bold",
        textColor=GREEN,
        spaceAfter=4,
        spaceBefore=10,
    )

    st = data["stats"]
    products = data["products"]
    customers = data["customers"]
    items = data["items"]

    total_usd = float(st.get("total_usd") or 0)
    total_uzs = float(st.get("total_uzs") or 0)

    today_str = date.today().strftime("%d.%m.%Y")

    story = []

    story.append(Paragraph("TopMart — Savdo Hisoboti", title_style))
    story.append(Paragraph(f"Davr: {period_label}  |  Yaratildi: {today_str}", subtitle_style))
    story.append(HRFlowable(width="100%", thickness=2, color=GREEN, spaceAfter=10))

    summary_data = [
        ["Ko'rsatkich", "Qiymat"],
        ["Jami savdolar", f"{st.get('sale_count', 0)} ta"],
        ["To'langan", f"{st.get('paid_count', 0)} ta"],
        ["Kutilmoqda", f"{st.get('pending_count', 0)} ta"],
    ]
    if total_usd > 0:
        summary_data.append(["Jami summa (USD)", f"${total_usd:,.0f}"])
    if total_uzs > 0:
        summary_data.append(["Jami summa (UZS)", f"{total_uzs:,.0f} so'm"])

    summary_table = Table(summary_data, colWidths=[8 * cm, 8 * cm])
    summary_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), HEADER_BG),
        ("TEXTCOLOR",  (0, 0), (-1, 0), colors.white),
        ("FONTNAME",   (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",   (0, 0), (-1, -1), 10),
        ("PADDING",    (0, 0), (-1, -1), 6),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, ALT_ROW]),
        ("GRID",       (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
        ("FONTNAME",   (0, 1), (0, -1), "Helvetica-Bold"),
        ("VALIGN",     (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.append(summary_table)

    if products:
        story.append(Paragraph("Mahsulotlar bo'yicha", section_style))
        prod_data = [["#", "Mahsulot", "Miqdor", "Summa (USD)", "Summa (UZS)"]]
        for i, p in enumerate(products[:15], 1):
            name = p.get("product_name") or p.get("name") or "—"
            qty = float(p.get("total_qty") or 0)
            rev_usd = float(p.get("rev_usd") or 0)
            rev_uzs = float(p.get("rev_uzs") or 0)
            prod_data.append([
                str(i),
                name,
                f"{qty:g}",
                f"${rev_usd:,.0f}" if rev_usd > 0 else "—",
                f"{rev_uzs:,.0f} so'm" if rev_uzs > 0 else "—",
            ])
        prod_table = Table(prod_data, colWidths=[1 * cm, 6.5 * cm, 2 * cm, 3.5 * cm, 4.5 * cm])
        prod_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), HEADER_BG),
            ("TEXTCOLOR",  (0, 0), (-1, 0), colors.white),
            ("FONTNAME",   (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE",   (0, 0), (-1, -1), 9),
            ("PADDING",    (0, 0), (-1, -1), 5),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, ALT_ROW]),
            ("GRID",       (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
            ("VALIGN",     (0, 0), (-1, -1), "MIDDLE"),
        ]))
        story.append(prod_table)

    if customers:
        story.append(Paragraph("Mijozlar bo'yicha", section_style))
        cust_data = [["#", "Mijoz", "Savdolar", "Jami (USD)", "Jami (UZS)"]]
        for i, c in enumerate(customers[:15], 1):
            name = c.get("customer_name") or c.get("name") or "—"
            cnt = c.get("sale_count", 0)
            cusd = float(c.get("total_usd") or 0)
            cuzs = float(c.get("total_uzs") or 0)
            cust_data.append([
                str(i),
                name,
                f"{cnt} ta",
                f"${cusd:,.0f}" if cusd > 0 else "—",
                f"{cuzs:,.0f} so'm" if cuzs > 0 else "—",
            ])
        cust_table = Table(cust_data, colWidths=[1 * cm, 6.5 * cm, 2 * cm, 3.5 * cm, 4.5 * cm])
        cust_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), HEADER_BG),
            ("TEXTCOLOR",  (0, 0), (-1, 0), colors.white),
            ("FONTNAME",   (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE",   (0, 0), (-1, -1), 9),
            ("PADDING",    (0, 0), (-1, -1), 5),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, ALT_ROW]),
            ("GRID",       (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
            ("VALIGN",     (0, 0), (-1, -1), "MIDDLE"),
        ]))
        story.append(cust_table)

    if items:
        story.append(Paragraph("Batafsil savdolar", section_style))
        items_data = [["ID", "Sana", "Mijoz", "Mahsulot", "Miqdor", "Narx", "Jami", "Holat"]]
        status_map = {"paid": "To'langan", "pending": "Kutilmoqda", "partial": "Qisman"}
        for it in items[:100]:
            qty = float(it.get("quantity") or 0)
            unit_price = float(it.get("unit_price") or 0)
            line_total = float(it.get("line_total") or 0)
            cur = (it.get("currency") or "UZS").upper()
            total_str = f"${line_total:,.0f}" if cur == "USD" else f"{line_total:,.0f} so'm"
            price_str = f"${unit_price:,.0f}" if cur == "USD" else f"{unit_price:,.0f} so'm"
            items_data.append([
                f"#{it.get('id', '')}",
                str(it.get("date") or ""),
                str(it.get("customer_name") or "")[:18],
                str(it.get("product_name") or "")[:18],
                f"{qty:g} {it.get('sale_type') or ''}",
                price_str,
                total_str,
                status_map.get(str(it.get("status") or ""), str(it.get("status") or "")),
            ])
        items_table = Table(
            items_data,
            colWidths=[1.3 * cm, 2 * cm, 3.5 * cm, 3.5 * cm, 2 * cm, 2.5 * cm, 2.5 * cm, 2.2 * cm],
        )
        items_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), HEADER_BG),
            ("TEXTCOLOR",  (0, 0), (-1, 0), colors.white),
            ("FONTNAME",   (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE",   (0, 0), (-1, -1), 7.5),
            ("PADDING",    (0, 0), (-1, -1), 4),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, ALT_ROW]),
            ("GRID",       (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
            ("VALIGN",     (0, 0), (-1, -1), "MIDDLE"),
        ]))
        story.append(items_table)

    story.append(Spacer(1, 0.5 * cm))
    story.append(Paragraph(
        f"<font color='#94a3b8' size='8'>TopMart Factory ERP  ·  {today_str}</font>",
        styles["Normal"],
    ))

    doc.build(story)
    buf.seek(0)
    return buf.read()


async def cmd_hisobot(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    if not _is_admin(chat_id):
        await update.message.reply_text("❌ Faqat admin uchun.")
        return
    await update.message.reply_text(
        "📊 *Savdo hisoboti*\n\nQaysi davrni ko'rmoqchisiz?",
        parse_mode="Markdown",
        reply_markup=_period_keyboard(),
    )


async def period_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()

    period = query.data.split(":", 1)[1]
    if period == "cancel":
        await query.edit_message_text("❌ Bekor qilindi.")
        return

    from_date, to_date, period_label = _period_dates(period)

    await query.edit_message_text(f"⏳ Hisobot tayyorlanmoqda…\n📅 {period_label}")

    try:
        data = get_sales_report_summary(from_date, to_date)
    except Exception as e:
        await query.edit_message_text(f"❌ Ma'lumot olishda xatolik: {e}")
        return

    text = _build_text_report(data, period_label)

    pdf_kb = InlineKeyboardMarkup([
        [InlineKeyboardButton(
            "📄 PDF yuklab olish",
            callback_data=f"rp_pdf:{from_date}:{to_date}:{period_label[:30]}",
        )],
    ])

    try:
        await query.edit_message_text(text, parse_mode="Markdown", reply_markup=pdf_kb)
    except Exception:
        await query.message.reply_text(text, parse_mode="Markdown", reply_markup=pdf_kb)


async def pdf_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer("PDF tayyorlanmoqda…")

    parts = query.data.split(":", 3)
    from_date  = parts[1] if len(parts) > 1 else str(date.today())
    to_date    = parts[2] if len(parts) > 2 else str(date.today())
    period_label = parts[3] if len(parts) > 3 else f"{from_date} — {to_date}"

    try:
        data = get_sales_report_summary(from_date, to_date)
        pdf_bytes = _build_pdf_report(data, period_label)
        filename = f"savdo-hisobot-{from_date}-{to_date}.pdf"
        await query.message.reply_document(
            document=io.BytesIO(pdf_bytes),
            filename=filename,
            caption=f"📄 Savdo hisoboti\n📅 {period_label}",
        )
    except Exception as e:
        await query.message.reply_text(f"❌ PDF yaratishda xatolik: {e}")


async def cmd_backup(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Qo'lda backup yaratish — faqat superadmin uchun."""
    chat_id = update.effective_chat.id
    if chat_id != SUPERADMIN_CHAT_ID:
        await update.message.reply_text("❌ Faqat superadmin uchun.")
        return
    from ..scheduler import send_backup_to_telegram
    await send_backup_to_telegram(context.bot, chat_id)


def register(app) -> None:
    app.add_handler(CommandHandler("hisobot", cmd_hisobot))
    app.add_handler(CommandHandler("backup",  cmd_backup))
    app.add_handler(MessageHandler(
        filters.Regex(r"^📊 Savdo Hisobot$"),
        cmd_hisobot,
    ))
    app.add_handler(CallbackQueryHandler(period_callback, pattern=r"^rp:[^_]"))
    app.add_handler(CallbackQueryHandler(pdf_callback,    pattern=r"^rp_pdf:"))
