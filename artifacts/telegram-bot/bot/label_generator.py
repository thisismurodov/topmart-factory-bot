import io
import os
from datetime import date

from PIL import Image, ImageDraw, ImageFont
import qrcode

LABEL_W = 420
LABEL_H = 310

_FONT_CANDIDATES_BOLD = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
]
_FONT_CANDIDATES_REGULAR = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
]


def _font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    candidates = _FONT_CANDIDATES_BOLD if bold else _FONT_CANDIDATES_REGULAR
    for path in candidates:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def generate_label(batch_code: str, worker: str, product: str, quantity: int) -> io.BytesIO:
    img = Image.new("RGB", (LABEL_W, LABEL_H), "white")
    draw = ImageDraw.Draw(img)

    f_header = _font(26, bold=True)
    f_key    = _font(15)
    f_val    = _font(15, bold=True)
    f_footer = _font(12)

    draw.rectangle([0, 0, LABEL_W, 48], fill="#111111")
    draw.text((LABEL_W // 2, 24), "TOPMART", font=f_header, fill="white", anchor="mm")

    draw.rectangle([1, 1, LABEL_W - 1, LABEL_H - 1], outline="#111111", width=2)

    qr = qrcode.QRCode(box_size=4, border=1, error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(batch_code)
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    qr_size = 108
    qr_img = qr_img.resize((qr_size, qr_size), Image.LANCZOS)
    img.paste(qr_img, (LABEL_W - qr_size - 14, 58))

    fields = [
        ("Mahsulot:",  product),
        ("Partiya:",   batch_code),
        ("Miqdor:",    f"{quantity} dona"),
        ("Ishchi:",    worker),
        ("Sana:",      date.today().strftime("%d.%m.%Y")),
    ]

    y = 62
    for key, val in fields:
        draw.text((16, y), key, font=f_key, fill="#666666")
        draw.text((118, y), val, font=f_val, fill="#111111")
        y += 36

    draw.line([10, LABEL_H - 26, LABEL_W - 10, LABEL_H - 26], fill="#dddddd", width=1)
    draw.text((LABEL_W // 2, LABEL_H - 12), batch_code, font=f_footer,
              fill="#aaaaaa", anchor="mm")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf
