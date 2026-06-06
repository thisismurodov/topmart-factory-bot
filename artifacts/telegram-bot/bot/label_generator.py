"""
58mm × 40mm thermal label generator (XPrinter XP-365B, 203 DPI).
Landscape layout — uses 95% of sticker area, readable from 1 metre.
"""
import io
import os
from datetime import datetime

import img2pdf
from PIL import Image, ImageDraw, ImageFont

# 58mm × 40mm @ 203 DPI
_DPI    = 203
LABEL_W = round(58 * _DPI / 25.4)   # 464 px
LABEL_H = round(40 * _DPI / 25.4)   # 320 px

_BOLD_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
]
_REG_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
]


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


def _build_single(
    batch_code: str,
    worker: str,
    product: str,
    unit_num: int,
    total_units: int,
    unit_weight: float,
    ts: datetime,
) -> Image.Image:
    date_str   = ts.strftime("%d.%m.%Y")
    time_str   = ts.strftime("%H:%M")
    weight_txt = f"{unit_weight:.2f} kg" if unit_weight > 0 else "—"

    img  = Image.new("RGB", (LABEL_W, LABEL_H), "white")
    draw = ImageDraw.Draw(img)

    PAD_L = 42    # chap xavfsiz zona: ~5.2mm
    PAD_R = 18    # o'ng chegara

    # ── Fontlar (203 DPI, 1pt ≈ 2.82px) ──────────────────────────
    F_HDR  = _font(22, bold=True)
    F_PROD = _font(27, bold=True)
    F_INFO = _font(24, bold=True)
    F_DT   = _font(21, bold=True)

    # Batch code uchun mavjud kenglik (chap offset hisobga olingan)
    BC_MAX_W = LABEL_W - PAD_L - PAD_R

    # ── Satır 1: TOPMART (chap) + N/M (o'ng) ─────────────────────
    y = 16
    draw.text((PAD_L, y), "TOPMART", font=F_HDR, fill="black")
    page_txt = f"{unit_num}/{total_units}"
    draw.text((LABEL_W - PAD_R, y), page_txt, font=F_HDR, fill="black", anchor="ra")
    y += _text_h(draw, "TOPMART", F_HDR) + 6

    # ── Satır 2: Partiya kodi — ENG KATTA ────────────────────────
    bc_font, _ = _fit_font(draw, batch_code,
                           max_w=BC_MAX_W,
                           start=58, minimum=28, bold=True)
    draw.text((PAD_L, y), batch_code, font=bc_font, fill="black")
    y += _text_h(draw, batch_code, bc_font) + 7

    # ── Satır 3: Mahsulot nomi (wrap → max 2 qator) ───────────────
    prod_lines = _wrap(draw, product, F_PROD, BC_MAX_W)
    for line in prod_lines:
        draw.text((PAD_L, y), line, font=F_PROD, fill="black")
        y += _text_h(draw, line, F_PROD) + 3
    y += 2

    # ── Satır 4: Ishchi ───────────────────────────────────────────
    draw.text((PAD_L, y), f"Ishchi: {worker}", font=F_INFO, fill="black")
    y += _text_h(draw, worker, F_INFO) + 6

    # ── Satır 5: Og'irlik ─────────────────────────────────────────
    draw.text((PAD_L, y), weight_txt, font=F_INFO, fill="black")
    y += _text_h(draw, weight_txt, F_INFO) + 6

    # ── Satır 6: Sana (chap) + Soat (o'ng) — og'irlik ostida ─────
    draw.text((PAD_L, y), date_str, font=F_DT, fill="#444444")
    draw.text((LABEL_W - PAD_R, y), time_str, font=F_DT, fill="#444444", anchor="ra")
    y += _text_h(draw, date_str, F_DT) + 16   # 16px pastki bo'shliq

    # Quyi bo'sh qismni kesib tashlash — faqat mazmun balandligi qoladi
    return img.crop((0, 0, LABEL_W, y))


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

    # img2pdf — PDF/MediaBox sahifasini aniq 58×40mm qiladi (Foxit 100% da chiqaradi)
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
