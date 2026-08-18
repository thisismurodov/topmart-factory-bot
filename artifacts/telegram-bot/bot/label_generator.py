"""
100mm × 80mm termal etiketka generatori (203 DPI, yangi termal printer).
Landshaft, o'lcham QAT'IY 100×80 — die-cut stiker, pastki qismi kesilmaydi.

Dizayn (tepadan pastga):
  TOPMART                                    N/M
  ────────────────────────────────────────────
  PARTIYA KODI            (eng katta, moslashuvchan)
  Mahsulot nomi           (max 2 qator, moslashuvchan)
  [ 1 quti = N dona ]     (faqat qutili mahsulotlarda)
  Ishchi: ...
  OG'IRLIK                (yirik, pastga yaqin)
  ────────────────────────────────────────────
  sana                                     soat
"""
import io
import os
from datetime import datetime

import img2pdf
from PIL import Image, ImageDraw, ImageFont

# 100mm × 80mm @ 203 DPI
_DPI    = 203
LABEL_W = round(100 * _DPI / 25.4)   # 799 px
LABEL_H = round(80 * _DPI / 25.4)    # 639 px

BRAND = "TOPMART"

# Repo ichidagi shriftlar birinchi — Railway slim image'da /usr/share
# shriftlari YO'Q (receipt.py bilan bir xil yechim).
_FONT_DIR = os.path.join(os.path.dirname(__file__), "fonts")
_BOLD_PATHS = [
    os.path.join(_FONT_DIR, "DejaVuSans-Bold.ttf"),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
]
_REG_PATHS = [
    os.path.join(_FONT_DIR, "DejaVuSans.ttf"),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
]

# Chekka xavfsiz zonalar (die-cut stiker, ~4mm)
PAD_L = 32
PAD_R = 32
PAD_T = 20


def _font(px: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    for path in (_BOLD_PATHS if bold else _REG_PATHS):
        if os.path.exists(path):
            return ImageFont.truetype(path, px)
    try:
        return ImageFont.load_default(size=px)
    except TypeError:
        return ImageFont.load_default()


def _text_w(draw: ImageDraw.ImageDraw, text: str, font) -> int:
    try:
        b = draw.textbbox((0, 0), text, font=font)
        return b[2] - b[0]
    except AttributeError:
        return len(text) * font.size // 2


def _text_h(draw: ImageDraw.ImageDraw, text: str, font) -> int:
    try:
        b = draw.textbbox((0, 0), text, font=font)
        return b[3] - b[1]
    except AttributeError:
        return font.size


def _fit_font(draw, text: str, max_w: int, start: int, minimum: int = 28,
              bold: bool = True):
    """Matnni max_w ichiga sig'adigan eng katta fontni qaytaradi."""
    sz = start
    while sz >= minimum:
        f = _font(sz, bold)
        if _text_w(draw, text, f) <= max_w:
            return f, sz
        sz -= 2
    return _font(minimum, bold), minimum


def _wrap(draw, text: str, font, max_w: int) -> list[str]:
    """So'zlarni max 2 qatorga bo'ladi."""
    words = text.split()
    lines: list[str] = []
    cur = ""
    for w in words:
        test = f"{cur} {w}".strip()
        if _text_w(draw, test, font) > max_w and cur:
            lines.append(cur)
            cur = w
            if len(lines) == 2:
                break
        else:
            cur = test
    if cur and len(lines) < 2:
        lines.append(cur)
    return lines or [text]


def _product_rows(draw, product: str, content_w: int, sz: int):
    """Mahsulot nomini shu o'lchamda 1-2 qatorga joylashtiradi.
    Qatorlardan biri sig'masa None (chaqiruvchi kichikroq o'lcham sinaydi)."""
    f = _font(sz, bold=True)
    if _text_w(draw, product, f) <= content_w:
        return [(product, f)]
    lines = _wrap(draw, product, f, content_w)
    if all(_text_w(draw, ln, f) <= content_w for ln in lines):
        return [(ln, f) for ln in lines]
    return None


def _build_single(
    batch_code: str,
    worker: str,
    product: str,
    unit_num: int,
    total_units: int,
    unit_weight: float,
    ts: datetime,
    per_box: int = 1,
) -> Image.Image:
    date_str   = ts.strftime("%d.%m.%Y")
    time_str   = ts.strftime("%H:%M")
    weight_txt = f"{unit_weight:.2f} kg" if unit_weight > 0 else "—"

    img  = Image.new("RGB", (LABEL_W, LABEL_H), "white")
    draw = ImageDraw.Draw(img)

    left      = PAD_L
    right     = LABEL_W - PAD_R
    content_w = right - left

    # ── Pastki lenta (ankerlangan): chiziq + sana/soat ────────────────
    F_DT = _font(30, bold=True)
    footer_rule_y = LABEL_H - 68
    draw.line((left, footer_rule_y, right, footer_rule_y), fill="black", width=3)
    dt_y = footer_rule_y + 14
    draw.text((left, dt_y), date_str, font=F_DT, fill="#333333")
    draw.text((right, dt_y), time_str, font=F_DT, fill="#333333", anchor="ra")

    # ── Og'irlik (ankerlangan, yirik). Og'irliksiz mahsulotda bu blok
    #    chizilmaydi — katta «—» termal qog'ozda brak dog'iga o'xshaydi. ──
    if unit_weight > 0:
        w_font = _font(88, bold=True)
        w_h    = _text_h(draw, weight_txt, w_font)
        weight_y = footer_rule_y - 18 - w_h
        draw.text((left, weight_y), weight_txt, font=w_font, fill="black")
    else:
        weight_y = footer_rule_y - 18

    # ── Sarlavha: brend + N/M ─────────────────────────────────────────
    F_BRAND = _font(30, bold=True)
    F_PAGE  = _font(52, bold=True)
    draw.text((left, PAD_T + 10), BRAND, font=F_BRAND, fill="#333333")
    page_txt = f"{unit_num}/{total_units}"
    draw.text((right, PAD_T), page_txt, font=F_PAGE, fill="black", anchor="ra")
    header_rule_y = PAD_T + 64
    draw.line((left, header_rule_y, right, header_rule_y), fill="black", width=3)

    # ── Yuqori oqim: partiya kodi → mahsulot → quti → ishchi ─────────
    # Mahsulot shriftini og'irlik zonasiga tegmaydigan qilib tanlaymiz.
    F_WORKER = _font(36, bold=True)
    F_BOX    = _font(32, bold=True)

    prod_sz = 56
    while True:
        rows = _product_rows(draw, product, content_w, prod_sz)
        if rows is not None:
            # umumiy balandlikni o'lchaymiz
            y = header_rule_y + 14
            bc_font, _ = _fit_font(draw, batch_code, max_w=content_w,
                                   start=100, minimum=48, bold=True)
            y += _text_h(draw, batch_code, bc_font) + 12
            for ln, f in rows:
                y += _text_h(draw, ln, f) + 6
            if per_box > 1:
                y += _text_h(draw, "Xg", F_BOX) + 24 + 10
            y += _text_h(draw, "Ishchi", F_WORKER) + 8
            if y <= weight_y - 8 or prod_sz <= 34:
                break
        if prod_sz <= 34:
            rows = rows or [(product, _font(34, bold=True))]
            break
        prod_sz -= 4

    # Endi chizamiz
    y = header_rule_y + 14
    bc_font, _ = _fit_font(draw, batch_code, max_w=content_w,
                           start=100, minimum=48, bold=True)
    draw.text((left, y), batch_code, font=bc_font, fill="black")
    y += _text_h(draw, batch_code, bc_font) + 12

    for ln, f in rows:
        draw.text((left, y), ln, font=f, fill="black")
        y += _text_h(draw, ln, f) + 6

    if per_box > 1:
        box_txt = f"1 quti = {per_box} dona"
        bw = _text_w(draw, box_txt, F_BOX)
        bh = _text_h(draw, box_txt, F_BOX)
        y += 6
        draw.rounded_rectangle(
            (left, y, left + bw + 32, y + bh + 24),
            radius=10, outline="black", width=3,
        )
        draw.text((left + 16, y + 10), box_txt, font=F_BOX, fill="black")
        y += bh + 24 + 10
    else:
        y += 4

    draw.text((left, y), f"Ishchi: {worker}", font=F_WORKER, fill="black")

    return img


def generate_label_pdf(
    batch_code: str,
    worker: str,
    product: str,
    quantity: int,
    weight_kg: float,
    created_at: datetime | None = None,
) -> io.BytesIO:
    unit_weight = (weight_kg / quantity) if quantity > 0 else 0.0
    ts = created_at or datetime.now()

    png_pages: list[bytes] = []
    for i in range(1, quantity + 1):
        img = _build_single(batch_code, worker, product, i, quantity, unit_weight, ts)
        buf = io.BytesIO()
        img.save(buf, format="PNG", dpi=(_DPI, _DPI))
        png_pages.append(buf.getvalue())

    # img2pdf — PDF sahifasini aniq 100×80mm qiladi (printer 100% masshtabda chiqaradi)
    pdf_bytes = img2pdf.convert(
        png_pages,
        layout_fun=img2pdf.get_fixed_dpi_layout_fun((_DPI, _DPI)),
    )
    out = io.BytesIO(pdf_bytes)
    out.seek(0)
    return out


def generate_batch_session_pdf(
    batch_code: str,
    worker: str,
    items: list[dict],
    created_at: datetime | None = None,
) -> io.BytesIO:
    """Bitta batch_code ostidagi BARCHA mahsulotlar uchun yagona PDF.
    Har bir mahsulot o'z stikerlariga ega.
    pieces_per_box > 1 bo'lsa: N/M = quti raqami, og'irlik = quti og'irligi.

    items: [{"product", "quantity", "weight_kg", "pieces_per_box"}]
    """
    import math
    ts = created_at or datetime.now()
    png_pages: list[bytes] = []
    for it in items:
        product    = it["product"]
        quantity   = int(it["quantity"])
        weight_kg  = float(it.get("weight_kg") or 0.0)
        per_box    = max(1, int(it.get("pieces_per_box") or 1))

        if per_box > 1:
            # Qutili rejim: har bir qutiga 1 ta etiketika
            num_labels  = math.ceil(quantity / per_box)
            box_weight  = (weight_kg / num_labels) if num_labels > 0 else 0.0
            for i in range(1, num_labels + 1):
                img = _build_single(batch_code, worker, product, i, num_labels,
                                    box_weight, ts, per_box=per_box)
                buf = io.BytesIO()
                img.save(buf, format="PNG", dpi=(_DPI, _DPI))
                png_pages.append(buf.getvalue())
        else:
            # Donabay rejim (hozirgi xatti-harakat): har donaga 1 ta etiketika
            unit_weight = (weight_kg / quantity) if quantity > 0 else 0.0
            for i in range(1, quantity + 1):
                img = _build_single(batch_code, worker, product, i, quantity,
                                    unit_weight, ts, per_box=1)
                buf = io.BytesIO()
                img.save(buf, format="PNG", dpi=(_DPI, _DPI))
                png_pages.append(buf.getvalue())

    pdf_bytes = img2pdf.convert(
        png_pages,
        layout_fun=img2pdf.get_fixed_dpi_layout_fun((_DPI, _DPI)),
    )
    out = io.BytesIO(pdf_bytes)
    out.seek(0)
    return out


def generate_label(
    batch_code: str,
    worker: str,
    product: str,
    quantity: int,
    weight_kg: float = 0.0,
    created_at: datetime | None = None,
) -> io.BytesIO:
    unit_weight = (weight_kg / quantity) if weight_kg and quantity > 0 else 0.0
    img = _build_single(batch_code, worker, product, 1, quantity, unit_weight,
                        created_at or datetime.now())
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf
