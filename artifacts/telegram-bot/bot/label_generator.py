import io
import os
from datetime import date

from PIL import Image, ImageDraw, ImageFont
import qrcode

LABEL_W = 420
LABEL_H = 210

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
) -> Image.Image:
    img = Image.new("RGB", (LABEL_W, LABEL_H), "white")
    draw = ImageDraw.Draw(img)

    f_hdr   = _font(22, bold=True)
    f_num   = _font(28, bold=True)
    f_key   = _font(13)
    f_val   = _font(13, bold=True)
    f_foot  = _font(11)

    draw.rectangle([0, 0, LABEL_W, 40], fill="#111111")
    draw.text((LABEL_W // 2, 20), "TOPMART", font=f_hdr, fill="white", anchor="mm")

    draw.rectangle([1, 1, LABEL_W - 1, LABEL_H - 1], outline="#111111", width=2)

    qr = qrcode.QRCode(box_size=3, border=1,
                        error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(f"{batch_code} {unit_num}/{total_units}")
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    qr_size = 90
    qr_img = qr_img.resize((qr_size, qr_size), Image.LANCZOS)
    img.paste(qr_img, (LABEL_W - qr_size - 10, 45))

    unit_text = f"{unit_num} / {total_units}"
    draw.text((16, 48), unit_text, font=f_num, fill="#111111")

    fields = [
        ("Mahsulot:", product),
        ("Partiya:",  batch_code),
        ("Og'irlik:", f"~{unit_weight:.2f} kg"),
        ("Ishchi:",   worker),
        ("Sana:",     date.today().strftime("%d.%m.%Y")),
    ]

    y = 88
    for key, val in fields:
        draw.text((16, y), key, font=f_key, fill="#666666")
        draw.text((105, y), val, font=f_val, fill="#111111")
        y += 22

    draw.line([10, LABEL_H - 20, LABEL_W - 10, LABEL_H - 20], fill="#dddddd", width=1)
    draw.text((LABEL_W // 2, LABEL_H - 10),
              f"{batch_code}  •  {unit_num}/{total_units}",
              font=f_foot, fill="#aaaaaa", anchor="mm")

    return img


def generate_label_pdf(
    batch_code: str,
    worker: str,
    product: str,
    quantity: int,
    weight_kg: float,
) -> io.BytesIO:
    unit_weight = (weight_kg / quantity) if quantity > 0 else 0.0
    images = [
        _build_single(batch_code, worker, product, i, quantity, unit_weight)
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
) -> io.BytesIO:
    unit_weight = (weight_kg / quantity) if weight_kg and quantity > 0 else 0.0
    img = _build_single(batch_code, worker, product, 1, quantity, unit_weight)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf
