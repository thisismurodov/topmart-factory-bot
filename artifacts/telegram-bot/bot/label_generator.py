import io
import os
from datetime import datetime

from PIL import Image, ImageDraw, ImageFont

# 58mm x 40mm @ 203 dpi
MM = 203 / 25.4
LABEL_W = round(58 * MM)   # ≈ 464 px
LABEL_H = round(40 * MM)   # ≈ 320 px

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
    HDR_H = 38
    draw.rectangle([0, 0, LABEL_W, HDR_H], fill="#111111")
    # TOPMART text centered in left 60% of header
    draw.text(
        (LABEL_W // 2 - 30, HDR_H // 2),
        "TOPMART",
        font=_font(24, bold=True),
        fill="white",
        anchor="mm",
    )
    # Unit counter on the right side of header
    draw.text(
        (LABEL_W - 10, HDR_H // 2),
        f"{unit_num}/{total_units}",
        font=_font(18, bold=True),
        fill="#aaaaaa",
        anchor="rm",
    )

    # ── Batch code ────────────────────────────────────────────────
    draw.text(
        (LABEL_W // 2, HDR_H + 20),
        batch_code,
        font=_font(24, bold=True),
        fill="#111111",
        anchor="mm",
    )

    # ── Divider ───────────────────────────────────────────────────
    DIV_Y = HDR_H + 36
    draw.line([6, DIV_Y, LABEL_W - 6, DIV_Y], fill="#cccccc", width=1)

    # ── Two-column fields ─────────────────────────────────────────
    weight_txt = f"~{unit_weight:.2f} kg" if unit_weight > 0 else "—"

    # Truncate long product name
    prod_display = product if len(product) <= 22 else product[:20] + "…"

    left_fields = [
        ("Mahsulot:", prod_display),
        ("Og'irlik:", weight_txt),
        ("Ishchi:",   worker),
    ]
    right_fields = [
        ("Sana:", date_str),
        ("Soat:", time_str),
    ]

    f_key = _font(15)
    f_val = _font(15, bold=True)
    PAD   = 8
    COL2  = LABEL_W // 2 + 4
    y     = DIV_Y + 9

    for key, val in left_fields:
        draw.text((PAD,      y), key, font=f_key, fill="#666666")
        draw.text((PAD + 80, y), val, font=f_val, fill="#111111")
        y += 24

    # Right column starts aligned to top
    y2 = DIV_Y + 9
    for key, val in right_fields:
        draw.text((COL2,      y2), key, font=f_key, fill="#666666")
        draw.text((COL2 + 62, y2), val, font=f_val, fill="#111111")
        y2 += 24

    # ── Bottom border ─────────────────────────────────────────────
    draw.line([0, LABEL_H - 1, LABEL_W, LABEL_H - 1], fill="#eeeeee", width=1)

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
