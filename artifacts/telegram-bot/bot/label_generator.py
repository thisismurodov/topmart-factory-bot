import io
import os
from datetime import datetime

from PIL import Image, ImageDraw, ImageFont

# 58mm x 40mm @ 203 dpi
MM      = 203 / 25.4
LABEL_W = round(58 * MM)   # 464 px
LABEL_H = round(40 * MM)   # 320 px

_FONT_BOLD = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
]
_FONT_REG = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
]


def _font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    for path in (_FONT_BOLD if bold else _FONT_REG):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def _text_width(draw: ImageDraw.ImageDraw, text: str, font) -> int:
    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        return bbox[2] - bbox[0]
    except AttributeError:
        return len(text) * font.size // 2


def _fit_font(draw: ImageDraw.ImageDraw, text: str, max_width: int,
              start_size: int, min_size: int = 28, bold: bool = True):
    """Matn max_width ichiga sig'guncha font o'lchamini kamaytiradi."""
    size = start_size
    while size >= min_size:
        f = _font(size, bold)
        if _text_width(draw, text, f) <= max_width:
            return f, size
        size -= 2
    return _font(min_size, bold), min_size


def _wrap_text(draw: ImageDraw.ImageDraw, text: str, font, max_width: int) -> list[str]:
    """Uzun matnni max 2 qatorga bo'ladi."""
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        test = f"{current} {word}".strip()
        if _text_width(draw, test, font) > max_width and current:
            lines.append(current)
            current = word
            if len(lines) >= 2:
                break
        else:
            current = test
    if current and len(lines) < 2:
        lines.append(current)
    return lines if lines else [text[:20]]


def _build_single(
    batch_code: str,
    worker: str,
    product: str,
    unit_num: int,
    total_units: int,
    unit_weight: float,
    created_at: datetime | None = None,
) -> Image.Image:
    now      = created_at or datetime.now()
    date_str = now.strftime("%d.%m.%Y")
    time_str = now.strftime("%H:%M")

    img  = Image.new("RGB", (LABEL_W, LABEL_H), "white")
    draw = ImageDraw.Draw(img)

    PAD = 8   # horizontal padding

    # ── 1. HEADER: TOPMART ───────────────────────────────────────
    HDR_H = 38
    draw.rectangle([0, 0, LABEL_W, HDR_H], fill="#111111")
    draw.text(
        (LABEL_W // 2, HDR_H // 2),
        "TOPMART",
        font=_font(24, bold=True),
        fill="white",
        anchor="mm",
    )

    # ── 2. BATCH CODE — eng katta element (~30% balandlik) ───────
    # Available zone: HDR_H..~HDR_H+100
    BC_MAX_W = LABEL_W - 2 * PAD
    bc_font, _ = _fit_font(draw, batch_code, BC_MAX_W, start_size=66, min_size=36, bold=True)
    BC_CENTER_Y = HDR_H + 54          # batch code markaziy nuqtasi
    draw.text(
        (LABEL_W // 2, BC_CENTER_Y),
        batch_code,
        font=bc_font,
        fill="#111111",
        anchor="mm",
    )

    # ── 3. DIVIDER ────────────────────────────────────────────────
    DIV_Y = HDR_H + 108
    draw.line([PAD, DIV_Y, LABEL_W - PAD, DIV_Y], fill="#999999", width=2)

    # ── 4. BODY — ikki ustun ─────────────────────────────────────
    # Sol ustun: Mahsulot nomi, Og'irlik, Ishchi
    # O'ng ustun: Sana, Soat, Dona
    BODY_TOP  = DIV_Y + 10
    COL_MID   = LABEL_W // 2 + 10    # ikki ustun orasidagi chegara
    LEFT_W    = COL_MID - PAD - 12   # chap ustun kengligi
    RIGHT_W   = LABEL_W - COL_MID - PAD

    f_val  = _font(24, bold=True)    # qiymat shrifti — katta, qalin
    f_lbl  = _font(15, bold=False)   # kalit so'z shrifti — kichik, kulrang
    ROW_H  = 42                      # bir qator balandligi

    weight_txt = f"{unit_weight:.2f} kg" if unit_weight > 0 else "—"
    page_txt   = f"{unit_num} / {total_units}"

    # Mahsulot nomini 2 qatorga bo'lish
    prod_lines = _wrap_text(draw, product, f_val, LEFT_W)

    # Chap ustun y boshlanishi
    y_l = BODY_TOP

    # Mahsulot nomi (1 yoki 2 qator)
    draw.text((PAD, y_l), "Mahsulot", font=f_lbl, fill="#888888")
    y_l += 16
    for line in prod_lines:
        draw.text((PAD, y_l), line, font=f_val, fill="#111111")
        y_l += 27

    # Og'irlik
    y_l = BODY_TOP + ROW_H + 8
    draw.text((PAD, y_l), "Og'irlik", font=f_lbl, fill="#888888")
    draw.text((PAD, y_l + 16), weight_txt, font=f_val, fill="#111111")

    # Ishchi
    y_l = BODY_TOP + ROW_H * 2 + 2
    draw.text((PAD, y_l), "Ishchi", font=f_lbl, fill="#888888")
    draw.text((PAD, y_l + 16), worker, font=f_val, fill="#222222")

    # O'ng ustun
    y_r = BODY_TOP
    draw.text((COL_MID, y_r), "Sana", font=f_lbl, fill="#888888")
    draw.text((COL_MID, y_r + 16), date_str, font=f_val, fill="#111111")

    y_r = BODY_TOP + ROW_H + 8
    draw.text((COL_MID, y_r), "Soat", font=f_lbl, fill="#888888")
    draw.text((COL_MID, y_r + 16), time_str, font=f_val, fill="#111111")

    y_r = BODY_TOP + ROW_H * 2 + 2
    draw.text((COL_MID, y_r), "Dona", font=f_lbl, fill="#888888")
    draw.text((COL_MID, y_r + 16), page_txt, font=_font(26, bold=True), fill="#555555")

    # ── Vertikal ajratgich (ikki ustun orasida) ───────────────────
    draw.line([COL_MID - 6, DIV_Y + 4, COL_MID - 6, LABEL_H - 4], fill="#e0e0e0", width=1)

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
    images = [
        _build_single(batch_code, worker, product, i, quantity, unit_weight, ts)
        for i in range(1, quantity + 1)
    ]
    buf = io.BytesIO()
    images[0].save(
        buf,
        format="PDF",
        save_all=True,
        append_images=images[1:],
        resolution=203.0,
    )
    buf.seek(0)
    return buf


def generate_label(
    batch_code: str,
    worker: str,
    product: str,
    quantity: int,
    weight_kg: float = 0.0,
    created_at: datetime | None = None,
) -> io.BytesIO:
    unit_weight = (weight_kg / quantity) if weight_kg and quantity > 0 else 0.0
    img = _build_single(batch_code, worker, product, 1, quantity, unit_weight, created_at)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf
