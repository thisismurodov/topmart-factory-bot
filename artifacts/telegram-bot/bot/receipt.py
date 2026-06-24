"""Savdo cheki — matn va chiroyli PNG rasm generatsiyasi."""
import io
import os
from datetime import datetime
from zoneinfo import ZoneInfo

from PIL import Image, ImageDraw, ImageFont

TZ = ZoneInfo("Asia/Tashkent")

# Shriftlar loyiha ichida (Railway/Docker'da tizim shriftlari bo'lmasligi mumkin).
_FONT_DIR = os.path.join(os.path.dirname(__file__), "fonts")
FONT_REG = os.path.join(_FONT_DIR, "DejaVuSans.ttf")
FONT_BOLD = os.path.join(_FONT_DIR, "DejaVuSans-Bold.ttf")


def _font(bold: bool, size: int):
    """Bundlangan shriftni yuklaydi; topilmasa zaxira default shriftga tushadi."""
    path = FONT_BOLD if bold else FONT_REG
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        try:
            return ImageFont.load_default(size)
        except TypeError:
            return ImageFont.load_default()

BRAND = "TopMart"

# Ranglar
ORANGE = (234, 88, 12)
ORANGE_LIGHT = (255, 237, 213)
DARK = (23, 23, 23)
GRAY = (115, 115, 115)
LINE = (224, 224, 224)
BG = (255, 255, 255)


def _now_str() -> str:
    return datetime.now(TZ).strftime("%d.%m.%Y  %H:%M")


def _sym(currency: str) -> str:
    return "$" if (currency or "uzs").lower() in ("usd", "$") else "so'm"


def _fmt(amount: float, currency: str) -> str:
    if _sym(currency) == "$":
        return f"{amount:,.2f} $"
    return f"{amount:,.0f}".replace(",", " ") + " so'm"


def _group_totals(items: list) -> dict:
    totals: dict[str, float] = {}
    for it in items:
        cur = (it.get("currency") or "UZS").upper()
        totals[cur] = totals.get(cur, 0.0) + float(it["line_total"])
    return totals


# ── Matn cheki (monospace blok) ────────────────────────────────────────────────

def build_receipt_text(sale_id: int, customer_name: str, items: list, created_str: str | None = None) -> str:
    created_str = created_str or _now_str()
    W = 30
    sep = "=" * W
    sub = "-" * W

    lines: list[str] = []
    lines.append(sep)
    lines.append(f"{BRAND:^{W}}")
    lines.append(f"{'Savdo cheki':^{W}}")
    lines.append(sep)
    lines.append(f"Chek:  #{sale_id}")
    lines.append(f"Sana:  {created_str}")
    lines.append(f"Mijoz: {customer_name}")
    lines.append(sub)
    for i, it in enumerate(items, 1):
        qty = f"{float(it['quantity']):g}"
        unit = it.get("sale_type", "")
        price = _fmt(float(it["unit_price"]), it["currency"])
        total = _fmt(float(it["line_total"]), it["currency"])
        lines.append(f"{i}. {it['product_name']}")
        lines.append(f"   {qty} {unit} x {price}")
        lines.append(f"   = {total}")
    lines.append(sub)
    for cur, amt in _group_totals(items).items():
        lines.append(f"JAMI:  {_fmt(amt, cur)}")
    lines.append(sep)
    lines.append(f"{'Xaridingiz uchun rahmat!':^{W}}")

    return "```\n" + "\n".join(lines) + "\n```"


# ── PNG chek rasmi ──────────────────────────────────────────────────────────────

def _text_right(d: ImageDraw.ImageDraw, x_right: int, y: int, text: str, font, fill) -> None:
    w = d.textlength(text, font=font)
    d.text((x_right - w, y), text, font=font, fill=fill)


def _text_center(d: ImageDraw.ImageDraw, cx: float, y: int, text: str, font, fill) -> None:
    w = d.textlength(text, font=font)
    d.text((cx - w / 2, y), text, font=font, fill=fill)


def render_receipt_png(sale_id: int, customer_name: str, items: list, created_str: str | None = None) -> io.BytesIO:
    created_str = created_str or _now_str()

    f_brand = _font(True, 46)
    f_sub = _font(False, 22)
    f_label = _font(False, 22)
    f_val = _font(True, 22)
    f_item = _font(True, 24)
    f_item_sub = _font(False, 20)
    f_total_lbl = _font(False, 24)
    f_total = _font(True, 30)
    f_foot = _font(False, 20)

    W = 640
    pad = 40
    totals = _group_totals(items)

    # Yetarli balandlikdagi tuvalga chizamiz, so'ng kontent bo'yicha kesamiz.
    canvas_h = 400 + len(items) * 92 + len(totals) * 56 + 200
    img = Image.new("RGB", (W, canvas_h), BG)
    d = ImageDraw.Draw(img)

    # Sarlavha bandi
    header_h = 132
    d.rectangle([0, 0, W, header_h], fill=ORANGE)
    _text_center(d, W / 2, 30, BRAND, f_brand, (255, 255, 255))
    _text_center(d, W / 2, 88, "SAVDO CHEKI", f_sub, ORANGE_LIGHT)

    y = header_h + 28
    for label, val in (("Chek", f"#{sale_id}"), ("Sana", created_str), ("Mijoz", customer_name)):
        d.text((pad, y), label, font=f_label, fill=GRAY)
        _text_right(d, W - pad, y, val, f_val, DARK)
        y += 40

    y += 6
    d.line([pad, y, W - pad, y], fill=LINE, width=2)
    y += 26

    for i, it in enumerate(items, 1):
        qty = f"{float(it['quantity']):g}"
        unit = it.get("sale_type", "")
        price = _fmt(float(it["unit_price"]), it["currency"])
        total = _fmt(float(it["line_total"]), it["currency"])
        d.text((pad, y), f"{i}. {it['product_name']}", font=f_item, fill=DARK)
        _text_right(d, W - pad, y, total, f_item, ORANGE)
        y += 34
        d.text((pad + 18, y), f"{qty} {unit} × {price}", font=f_item_sub, fill=GRAY)
        y += 38

    y += 4
    d.line([pad, y, W - pad, y], fill=LINE, width=2)
    y += 26

    for cur, amt in totals.items():
        d.text((pad, y + 5), "JAMI", font=f_total_lbl, fill=DARK)
        _text_right(d, W - pad, y, _fmt(amt, cur), f_total, ORANGE)
        y += 52

    y += 16
    d.line([pad, y, W - pad, y], fill=LINE, width=2)
    y += 24
    _text_center(d, W / 2, y, "Xaridingiz uchun rahmat!", f_foot, GRAY)
    y += 36

    img = img.crop((0, 0, W, y + pad))

    bio = io.BytesIO()
    img.save(bio, format="PNG")
    bio.seek(0)
    bio.name = f"chek_{sale_id}.png"
    return bio
