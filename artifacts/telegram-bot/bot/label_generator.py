"""
100mm × 80mm termal etiketka generatori (203 DPI) — jadval shablon.

Dizayn (foydalanuvchi shabloni, 2026-08-18):
  ┌───────────────────────────────────────────────┐
  │ [□]  MAHSULOT NOMI:                    TULPOR │
  │ ───────────────────────────────────────────── │
  │ [🏷]  MAHSULOT SKU:                TPLR-00087 │
  │ [⚖]  MAHSULOT KG:                      3.1 KG │
  │ [📏]  MAHSULOT METRI:                 80 METR │
  │ [👤]  KIM ISHLAB CHIQARGANI:          SAYYORA │
  │ [📅]  SANA VA SOAT:          18.08.2026 09:00 │
  │ ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
  │ ║║│║║║│║│║║ (Code128)                         │
  │      TPLR-00087-20260818-0900                 │
  │      B-1808-3 · 3/12 · 1 quti = 25 dona       │
  └───────────────────────────────────────────────┘

- METRI mahsulot nomidan olinadi («70 metr Sariq Strupa» → 70 METR), yo'q bo'lsa «—».
- SKU bo'lmasa qator «—», shtrix-kod partiya kodidan tuziladi.
- Qutili mahsulotda: N/M = quti raqami, KG = quti og'irligi.
"""
import io
import os
import re
from datetime import datetime, timedelta, timezone

import img2pdf
from PIL import Image, ImageDraw, ImageFont

# O'zbekiston doimiy UTC+5 (DST yo'q) — Railway/DB UTC'da ishlaydi,
# etiketkadagi sana/soat esa doim Toshkent bo'yicha bo'lishi kerak.
TASHKENT_TZ = timezone(timedelta(hours=5))

try:
    import barcode as _barcode
    from barcode.writer import ImageWriter as _BarcodeImageWriter
    _HAS_BARCODE = True
except Exception:                                    # pragma: no cover
    _HAS_BARCODE = False

# 100mm × 80mm @ 203 DPI
_DPI    = 203
LABEL_W = round(100 * _DPI / 25.4)   # 799 px
LABEL_H = round(80 * _DPI / 25.4)    # 639 px

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

# Ramka / joylashuv
_BORDER_INSET  = 10
_BORDER_W      = 4
_BORDER_RADIUS = 24
_PAD           = 30          # ramka ichidagi bo'sh joy
_ROW_H         = 70
_ROWS_TOP      = 24

_METR_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(?:metr|метр)", re.IGNORECASE)


def _font(px: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    for path in (_BOLD_PATHS if bold else _REG_PATHS):
        if os.path.exists(path):
            return ImageFont.truetype(path, px)
    try:
        return ImageFont.load_default(size=px)
    except TypeError:
        return ImageFont.load_default()


def _text_w(draw, text: str, font) -> int:
    try:
        b = draw.textbbox((0, 0), text, font=font)
        return b[2] - b[0]
    except AttributeError:
        return len(text) * font.size // 2


def _text_h(draw, text: str, font) -> int:
    try:
        b = draw.textbbox((0, 0), text, font=font)
        return b[3] - b[1]
    except AttributeError:
        return font.size


def _fit_font(draw, text: str, max_w: int, start: int, minimum: int,
              bold: bool = True):
    sz = start
    while sz >= minimum:
        f = _font(sz, bold)
        if _text_w(draw, text, f) <= max_w:
            return f
        sz -= 2
    return _font(minimum, bold)


def _ellipsize(draw, text: str, font, max_w: int) -> str:
    """Matn sig'masa belgilab-belgilab qisqartiradi («…» bilan) —
    bitta uzun so'z ham yozuv/ikonka ustiga chiqib ketmasligi kerak."""
    if _text_w(draw, text, font) <= max_w:
        return text
    t = text
    while t and _text_w(draw, t + "…", font) > max_w:
        t = t[:-1].rstrip()
    return (t + "…") if t else "…"


def _wrap2(draw, text: str, font, max_w: int) -> list[str]:
    """So'zlarni max 2 qatorga bo'ladi; har bir qator max_w ga qat'iy sig'adi."""
    words = text.split()
    lines: list[str] = []
    cur = ""
    for i, w in enumerate(words):
        test = f"{cur} {w}".strip()
        if _text_w(draw, test, font) > max_w and cur:
            lines.append(cur)
            cur = w
            if len(lines) == 2:
                cur = " ".join(words[i:])
                break
        else:
            cur = test
    if cur and len(lines) < 2:
        lines.append(cur)
    elif cur and len(lines) == 2:
        lines[1] = f"{lines[1]} {cur}".strip() if lines[1] != cur else cur
    lines = lines or [text]
    return [_ellipsize(draw, ln, font, max_w) for ln in lines[:2]]


def barcode_safe(text: str) -> str:
    """Code128 uchun xavfsiz ASCII identifikator.

    Apostrof variantlari (oʻ/o'/o') olib tashlanadi, boshqa nomaqbul
    belgilar «-» ga almashtiriladi — aks holda python-barcode xato beradi
    va shtrix-kod indamay yo'qolib qolardi."""
    t = (text or "").strip().upper()
    t = re.sub(r"[ʼʻ''`´’]", "", t)
    t = t.replace("‐", "-").replace("–", "-").replace("—", "-")
    t = re.sub(r"[^A-Z0-9\-\._/]", "-", t)
    t = re.sub(r"-{2,}", "-", t).strip("-")
    return t


def extract_metr(product_name: str) -> float | None:
    """«70 metr Sariq Strupa 16» → 70.0; topilmasa None."""
    m = _METR_RE.search(product_name or "")
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", "."))
    except ValueError:
        return None


def _num(v: float) -> str:
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return s if s else "0"


# ── Ikonkalar (44×44 katak, to'liq qora — shablon uslubi) ─────────────

def _icon_cube(d, x, y):
    d.polygon([(x + 4, y + 14), (x + 22, y + 4), (x + 40, y + 14),
               (x + 22, y + 24)], outline="black", width=4)
    d.line((x + 4, y + 14, x + 4, y + 32), fill="black", width=4)
    d.line((x + 40, y + 14, x + 40, y + 32), fill="black", width=4)
    d.line((x + 22, y + 24, x + 22, y + 42), fill="black", width=4)
    d.line((x + 4, y + 32, x + 22, y + 42), fill="black", width=4)
    d.line((x + 40, y + 32, x + 22, y + 42), fill="black", width=4)


def _icon_tag(d, x, y):
    d.polygon([(x + 2, y + 18), (x + 18, y + 2), (x + 26, y + 2),
               (x + 42, y + 18), (x + 42, y + 26), (x + 26, y + 42),
               (x + 18, y + 42), (x + 2, y + 26)], fill="black")
    d.ellipse((x + 17, y + 9, x + 27, y + 19), fill="white")


def _icon_kg(d, x, y, font_fn):
    d.rectangle((x + 16, y + 2, x + 28, y + 10), outline="black", width=4)
    d.rounded_rectangle((x + 4, y + 10, x + 40, y + 42), radius=8, fill="black")
    f = font_fn(15, True)
    d.text((x + 22, y + 26), "KG", font=f, fill="white", anchor="mm")


def _icon_ruler(d, x, y):
    d.rounded_rectangle((x + 2, y + 12, x + 42, y + 32), radius=4,
                        outline="black", width=4)
    for i in range(1, 4):
        tx = x + 2 + i * 10
        d.line((tx, y + 12, tx, y + 22), fill="black", width=3)


def _icon_person(d, x, y):
    d.ellipse((x + 13, y + 2, x + 31, y + 20), fill="black")
    d.pieslice((x + 4, y + 22, x + 40, y + 58), 180, 360, fill="black")


def _icon_calendar(d, x, y):
    d.rounded_rectangle((x + 3, y + 8, x + 41, y + 42), radius=6, fill="black")
    d.rectangle((x + 11, y + 2, x + 16, y + 12), fill="black")
    d.rectangle((x + 28, y + 2, x + 33, y + 12), fill="black")
    d.rectangle((x + 7, y + 12, x + 37, y + 16), fill="white")
    for r in range(2):
        for c in range(4):
            cx = x + 10 + c * 8
            cy = y + 22 + r * 9
            d.ellipse((cx, cy, cx + 4, cy + 4), fill="white")


def _make_barcode(content: str, max_w: int, height_px: int) -> Image.Image | None:
    """Code128 shtrix-kod PIL rasm sifatida (matn yozuvisiz)."""
    if not _HAS_BARCODE:
        return None
    try:
        code = _barcode.get("code128", content, writer=_BarcodeImageWriter())
        img = code.render(writer_options={
            "module_width": 0.25,        # mm
            "module_height": height_px / _DPI * 25.4,
            "quiet_zone": 1.0,
            "write_text": False,
            "dpi": _DPI,
        })
        if img.width > max_w:
            img = img.resize((max_w, height_px), Image.LANCZOS)
            img = img.convert("L").point(lambda p: 0 if p < 128 else 255).convert("RGB")
        return img
    except Exception:
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
    sku: str = "",
) -> Image.Image:
    img  = Image.new("RGB", (LABEL_W, LABEL_H), "white")
    draw = ImageDraw.Draw(img)

    # Tashqi ramka
    draw.rounded_rectangle(
        (_BORDER_INSET, _BORDER_INSET,
         LABEL_W - _BORDER_INSET, LABEL_H - _BORDER_INSET),
        radius=_BORDER_RADIUS, outline="black", width=_BORDER_W,
    )

    left  = _BORDER_INSET + _BORDER_W + _PAD           # 44
    right = LABEL_W - _BORDER_INSET - _BORDER_W - _PAD  # 755
    icon_x   = left
    label_x  = left + 64
    value_rx = right

    sku = (sku or "").strip().upper()
    metr = extract_metr(product)

    # Qiymatlar
    kg_txt   = f"{_num(unit_weight)} KG" if unit_weight > 0 else "—"
    metr_txt = f"{_num(metr)} METR" if metr is not None else "—"
    dt_txt   = f"{ts:%d.%m.%Y}  {ts:%H:%M}"

    rows = [
        (_icon_cube,     "MAHSULOT NOMI:",         product.upper(), 44, 30, 27),
        (_icon_tag,      "MAHSULOT SKU:",          sku or "—",      42, 24, 22),
        (lambda d, x, y: _icon_kg(d, x, y, _font),
                         "MAHSULOT KG:",           kg_txt,          42, 24, 22),
        (_icon_ruler,    "MAHSULOT METRI:",        metr_txt,        42, 24, 22),
        (_icon_person,   "KIM ISHLAB CHIQARGANI:", worker.upper(),  42, 24, 22),
        (_icon_calendar, "SANA VA SOAT:",          dt_txt,          42, 24, 22),
    ]

    F_LABEL = _font(28, bold=True)
    y = _ROWS_TOP
    for i, (icon_fn, label, value, v_start, v_min, v_wrap) in enumerate(rows):
        cy = y + _ROW_H // 2
        icon_fn(draw, icon_x, cy - 22)
        draw.text((label_x, cy), label, font=F_LABEL, fill="black", anchor="lm")

        avail = value_rx - (label_x + _text_w(draw, label, F_LABEL) + 20)
        f = _fit_font(draw, value, avail, start=v_start, minimum=v_min)
        if _text_w(draw, value, f) <= avail:
            draw.text((value_rx, cy), value, font=f, fill="black", anchor="rm")
        else:
            # Bir qatorga sig'madi — 2 qatorga bo'lamiz (yozuv ustiga chiqmasin)
            f2 = _font(v_wrap, bold=True)
            lines = _wrap2(draw, value, f2, avail)
            lh = v_wrap + 5
            y0 = cy - lh * (len(lines) - 1) // 2
            for j, ln in enumerate(lines):
                draw.text((value_rx, y0 + j * lh), ln, font=f2,
                          fill="black", anchor="rm")

        y += _ROW_H
        if i < len(rows) - 1:
            draw.line((left, y, right, y), fill="black", width=2)

    # Punktir ajratkich
    dash_y = y + 8
    x = left
    while x < right:
        draw.line((x, dash_y, min(x + 12, right), dash_y), fill="black", width=3)
        x += 22

    # Shtrix-kod: SKU (bo'lmasa partiya kodi) + sana + soat
    ident = barcode_safe(sku) or barcode_safe(batch_code) or "ETIKETKA"
    bc_content = f"{ident}-{ts:%Y%m%d}-{ts:%H%M}"
    bc_top     = dash_y + 10
    bc_h       = 84
    bc_img = _make_barcode(bc_content, max_w=right - left, height_px=bc_h)
    if bc_img is not None:
        img.paste(bc_img, (left + (right - left - bc_img.width) // 2, bc_top))
        cap_y = bc_top + bc_img.height + 6
    else:
        cap_y = bc_top + 6

    # Izoh qatorlari: kod + partiya/N-M/quti
    f_cap = _fit_font(draw, bc_content, right - left, start=26, minimum=20)
    draw.text(((left + right) // 2, cap_y), bc_content,
              font=f_cap, fill="black", anchor="ma")
    cap_y += _text_h(draw, bc_content, f_cap) + 8

    # SKU bo'lmasa partiya kodi shtrix-kod matnida allaqachon bor — takrorlamaymiz
    extra = f"{batch_code} · {unit_num}/{total_units}" if sku else f"{unit_num}/{total_units}"
    if per_box > 1:
        extra += f" · 1 quti = {per_box} dona"
    f_ext = _fit_font(draw, extra, right - left, start=24, minimum=18)
    draw.text(((left + right) // 2, cap_y), extra,
              font=f_ext, fill="#222222", anchor="ma")

    return img


def _render_pages(pages: list[Image.Image]) -> io.BytesIO:
    if not pages:
        raise ValueError(
            "Etiketka sahifalari yo'q — miqdor 0 yoki mahsulotlar ro'yxati bo'sh"
        )
    png_pages: list[bytes] = []
    for im in pages:
        buf = io.BytesIO()
        im.save(buf, format="PNG", dpi=(_DPI, _DPI))
        png_pages.append(buf.getvalue())
    # img2pdf — PDF sahifasini aniq 100×80mm qiladi (printer 100% masshtabda)
    pdf_bytes = img2pdf.convert(
        png_pages,
        layout_fun=img2pdf.get_fixed_dpi_layout_fun((_DPI, _DPI)),
    )
    out = io.BytesIO(pdf_bytes)
    out.seek(0)
    return out


def generate_label_pdf(
    batch_code: str,
    worker: str,
    product: str,
    quantity: int,
    weight_kg: float,
    created_at: datetime | None = None,
    sku: str = "",
) -> io.BytesIO:
    unit_weight = (weight_kg / quantity) if quantity > 0 else 0.0
    ts = created_at or datetime.now()
    pages = [
        _build_single(batch_code, worker, product, i, quantity, unit_weight,
                      ts, sku=sku)
        for i in range(1, quantity + 1)
    ]
    return _render_pages(pages)


def generate_batch_session_pdf(
    batch_code: str,
    worker: str,
    items: list[dict],
    created_at: datetime | None = None,
) -> io.BytesIO:
    """Bitta batch_code ostidagi BARCHA mahsulotlar uchun yagona PDF.
    pieces_per_box > 1 bo'lsa: N/M = quti raqami, og'irlik = quti og'irligi.

    items: [{"product", "quantity", "weight_kg", "pieces_per_box", "sku"?}]
    """
    import math
    ts = created_at or datetime.now()
    pages: list[Image.Image] = []
    for it in items:
        product   = it["product"]
        quantity  = int(it["quantity"])
        weight_kg = float(it.get("weight_kg") or 0.0)
        per_box   = max(1, int(it.get("pieces_per_box") or 1))
        sku       = str(it.get("sku") or "")

        if per_box > 1:
            # Qutili rejim: har bir qutiga 1 ta etiketika
            num_labels = math.ceil(quantity / per_box)
            box_weight = (weight_kg / num_labels) if num_labels > 0 else 0.0
            for i in range(1, num_labels + 1):
                pages.append(_build_single(batch_code, worker, product, i,
                                           num_labels, box_weight, ts,
                                           per_box=per_box, sku=sku))
        else:
            # Donabay rejim: har donaga 1 ta etiketika
            unit_weight = (weight_kg / quantity) if quantity > 0 else 0.0
            for i in range(1, quantity + 1):
                pages.append(_build_single(batch_code, worker, product, i,
                                           quantity, unit_weight, ts,
                                           per_box=1, sku=sku))

    return _render_pages(pages)


def generate_label(
    batch_code: str,
    worker: str,
    product: str,
    quantity: int,
    weight_kg: float = 0.0,
    created_at: datetime | None = None,
    sku: str = "",
) -> io.BytesIO:
    unit_weight = (weight_kg / quantity) if weight_kg and quantity > 0 else 0.0
    img = _build_single(batch_code, worker, product, 1, quantity, unit_weight,
                        created_at or datetime.now(), sku=sku)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf
