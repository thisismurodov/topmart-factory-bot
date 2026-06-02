import io
import os
from datetime import datetime

from PIL import Image, ImageDraw, ImageFont

# 40mm x 80mm @ 203 dpi  →  320 x 640 px
# 1 mm = 203/25.4 ≈ 8 px
MM = 203 / 25.4
LABEL_W = round(40 * MM)   # 320
LABEL_H = round(80 * MM)   # 640

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

    # ── Outer border ──────────────────────────────────────────────
    draw.rectangle([0, 0, LABEL_W - 1, LABEL_H - 1], outline="#111111", width=2)

    # ── Header strip ──────────────────────────────────────────────
    HDR_H = 42
    draw.rectangle([0, 0, LABEL_W, HDR_H], fill="#111111")
    draw.text(
        (LABEL_W // 2, HDR_H // 2),
        "TOPMART",
        font=_font(24, bold=True),
        fill="white",
        anchor="mm",
    )

    # ── Unit number (large, centered) ─────────────────────────────
    unit_text = f"{unit_num} / {total_units}"
    draw.text(
        (LABEL_W // 2, HDR_H + 28),
        unit_text,
        font=_font(34, bold=True),
        fill="#111111",
        anchor="mm",
    )

    # ── Divider ───────────────────────────────────────────────────
    DIV1_Y = HDR_H + 52
    draw.line([8, DIV1_Y, LABEL_W - 8, DIV1_Y], fill="#cccccc", width=1)

    # ── Batch code (large, centered, replaces QR) ─────────────────
    draw.text(
        (LABEL_W // 2, DIV1_Y + 80),
        batch_code,
        font=_font(30, bold=True),
        fill="#111111",
        anchor="mm",
    )

    # ── Divider ───────────────────────────────────────────────────
    DIV2_Y = DIV1_Y + 160
    draw.line([8, DIV2_Y, LABEL_W - 8, DIV2_Y], fill="#cccccc", width=1)

    # ── Fields ────────────────────────────────────────────────────
    weight_txt = f"~{unit_weight:.2f} kg" if unit_weight > 0 else "—"
    fields = [
        ("Mahsulot:", product),
        ("Og'irlik:", weight_txt),
        ("Ishchi:",   worker),
        ("Sana:",     date_str),
        ("Soat:",     time_str),
    ]

    f_key = _font(14)
    f_val = _font(14, bold=True)
    PAD   = 10
    y     = DIV2_Y + 10
    for key, val in fields:
        draw.text((PAD, y),     key, font=f_key, fill="#666666")
        draw.text((PAD + 85, y), val, font=f_val, fill="#111111")
        y += 24

    # ── Footer ────────────────────────────────────────────────────
    FOOT_Y = LABEL_H - 22
    draw.line([8, FOOT_Y - 6, LABEL_W - 8, FOOT_Y - 6], fill="#dddddd", width=1)
    draw.text(
        (LABEL_W // 2, FOOT_Y + 4),
        f"{batch_code}  •  {unit_num}/{total_units}",
        font=_font(11),
        fill="#aaaaaa",
        anchor="mm",
    )

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
