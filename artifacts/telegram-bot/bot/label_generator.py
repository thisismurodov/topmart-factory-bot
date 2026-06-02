import io
import os
from datetime import datetime

from PIL import Image, ImageDraw, ImageFont

# 40mm x 40mm @ 203 dpi  →  320 x 320 px
MM = 203 / 25.4
LABEL_W = round(40 * MM)   # 320
LABEL_H = round(40 * MM)   # 320

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

    # ── Header strip ──────────────────────────────────────────────
    HDR_H = 36
    draw.rectangle([0, 0, LABEL_W, HDR_H], fill="#111111")
    draw.text(
        (LABEL_W // 2, HDR_H // 2),
        "TOPMART",
        font=_font(22, bold=True),
        fill="white",
        anchor="mm",
    )

    # ── Unit number ───────────────────────────────────────────────
    draw.text(
        (LABEL_W // 2, HDR_H + 22),
        f"{unit_num} / {total_units}",
        font=_font(28, bold=True),
        fill="#111111",
        anchor="mm",
    )

    # ── Batch code ────────────────────────────────────────────────
    draw.text(
        (LABEL_W // 2, HDR_H + 48),
        batch_code,
        font=_font(22, bold=True),
        fill="#333333",
        anchor="mm",
    )

    # ── Divider ───────────────────────────────────────────────────
    DIV_Y = HDR_H + 62
    draw.line([6, DIV_Y, LABEL_W - 6, DIV_Y], fill="#cccccc", width=1)

    # ── Fields ────────────────────────────────────────────────────
    weight_txt = f"~{unit_weight:.2f} kg" if unit_weight > 0 else "—"
    fields = [
        ("Mahsulot:", product),
        ("Og'irlik:", weight_txt),
        ("Ishchi:",   worker),
        ("Sana:",     date_str),
        ("Soat:",     time_str),
    ]

    f_key = _font(16)
    f_val = _font(16, bold=True)
    PAD   = 8
    y     = DIV_Y + 8
    for key, val in fields:
        draw.text((PAD,      y), key, font=f_key, fill="#666666")
        draw.text((PAD + 90, y), val, font=f_val, fill="#111111")
        y += 26

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
