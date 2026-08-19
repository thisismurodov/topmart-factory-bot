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
  │      TM6X4N7G2PK9R3WQ5B                       │
  │      B-1808-3 · 3/12 · 1 quti = 25 dona       │
  └───────────────────────────────────────────────┘

- METRI profildan (products.roll_length_m); 0 bo'lsa mahsulot nomidan («70 metr …»), yo'q bo'lsa «—».
- KG profildagi og'irlikdan (weight > 0 va ≠ 1.0 bo'lsa); aks holda tarozidagi haqiqiydan.
- SKU bo'lmasa qator «—»; shtrix-kod har doim fizik label passport tokeni.
- Qutili mahsulotda: N/M = quti raqami, KG = quti og'irligi (profil bo'lsa: weight × quti dona).
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


def _fit_value_lines(
    draw, text: str, max_w: int, start: int, minimum: int = 10,
    wrap_size: int | None = None,
) -> tuple[ImageFont.FreeTypeFont, list[str]]:
    """Qiymatni hech bir belgisini kesmasdan 1 yoki 2 qatorga sig'diradi.

    Uzun, bo'shliqsiz SKU'lar ham ikki qator orasida belgi chegarasidan
    bo'linishi mumkin. Sig'maydigan favqulodda matn jim «…» bo'lib qolmaydi.
    """
    # Mavjud dizayndagi kabi avval shriftni minimal o'lchamgacha kichraytirib,
    # bir qatorga sig'dirishga harakat qilamiz.
    for size in range(start, minimum - 1, -1):
        font = _font(size, bold=True)
        if _text_w(draw, text, font) <= max_w:
            return font, [text]

    # Faqat shundan keyin ikki qator: avval tabiiy chegara (bo'shliq,
    # defis va h.k.), bo'lmasa uzun SKU uchun belgi chegarasi.
    first_wrap_size = wrap_size if wrap_size is not None else minimum
    for size in range(first_wrap_size, 9, -1):
        font = _font(size, bold=True)
        midpoint = len(text) // 2
        candidates = sorted(
            range(1, len(text)),
            key=lambda pos: (
                text[pos - 1:pos] not in " -_/." and text[pos:pos + 1] not in " -_/.",
                abs(pos - midpoint),
            ),
        )
        for pos in candidates:
            left = text[:pos].rstrip()
            right = text[pos:].lstrip()
            if left and right and _text_w(draw, left, font) <= max_w \
                    and _text_w(draw, right, font) <= max_w:
                return font, [left, right]
    raise ValueError(f"Etiketka qiymati 2 qatorga ham sig'madi: {text!r}")


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


def box_contents(quantity: int, per_box: int, box_num: int) -> int:
    """box_num-qutidagi dona soni (oxirgi quti to'liq bo'lmasligi mumkin)."""
    if per_box <= 1:
        return 1
    remaining = quantity - (box_num - 1) * per_box
    return max(0, min(per_box, remaining))


def kg_profile_meaningful(profile_kg: float) -> bool:
    """Profil og'irligi haqiqatan to'ldirilganmi? 1.0 — standart qiymat,
    "to'ldirilmagan" hisoblanadi (bot QC'sidagi qoida bilan bir xil)."""
    return profile_kg > 0 and abs(profile_kg - 1.0) > 0.001


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


def _make_barcode(content: str, max_w: int, height_px: int) -> Image.Image:
    """Code128 shtrix-kod PIL rasm sifatida (matn yozuvisiz)."""
    if not _HAS_BARCODE:
        raise RuntimeError("python-barcode topilmadi — etiketka shtrix-kodsiz chiqarilmadi")
    normalized = barcode_safe(content)
    if not normalized or normalized != content.strip().upper():
        raise ValueError(f"Barcode qiymati Code 128 passport formatiga mos emas: {content!r}")
    try:
        code = _barcode.get("code128", normalized, writer=_BarcodeImageWriter())
        img = code.render(writer_options={
            "module_width": 0.25,        # mm
            "module_height": height_px / _DPI * 25.4,
            "quiet_zone": 1.0,
            "write_text": False,
            "dpi": _DPI,
        })
        if img.width > max_w:
            raise ValueError(
                f"Barcode {img.width}px — mavjud {max_w}px joyga sig'madi; "
                "modul kengligini buzib resize qilinmadi"
            )
        return img
    except (RuntimeError, ValueError):
        raise
    except Exception as exc:
        raise RuntimeError(f"Code 128 generatsiya xatosi: {exc}") from exc


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
    metr: float | None = None,
    in_box: int | None = None,
    barcode_value: str = "",
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
    # METRI: profil qiymati ustuvor, 0/berilmagan bo'lsa mahsulot nomidan
    if metr is None or metr <= 0:
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
        f, lines = _fit_value_lines(
            draw, value, avail, start=v_start, minimum=v_min, wrap_size=v_wrap,
        )
        if len(lines) == 1:
            draw.text((value_rx, cy), value, font=f, fill="black", anchor="rm")
        else:
            # Bir qatorga sig'madi — to'liq qiymatni 2 qatorga bo'lamiz.
            lh = getattr(f, "size", v_wrap) + 3
            y0 = cy - lh * (len(lines) - 1) // 2
            for j, ln in enumerate(lines):
                draw.text((value_rx, y0 + j * lh), ln, font=f,
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

    # Shtrix-kod: faqat persisted fizik-label passport identity.
    bc_content = (barcode_value or "").strip().upper()
    if not re.fullmatch(r"TM[A-Z2-7]{16}", bc_content):
        raise ValueError(
            "Etiketkaga production label passport barcode berilmadi "
            "yoki formati noto'g'ri"
        )
    bc_top     = dash_y + 10
    bc_h       = 84
    bc_img = _make_barcode(bc_content, max_w=right - left, height_px=bc_h)
    img.paste(bc_img, (left + (right - left - bc_img.width) // 2, bc_top))
    cap_y = bc_top + bc_img.height + 6

    # Izoh qatorlari: kod + partiya/N-M/quti
    f_cap = _fit_font(draw, bc_content, right - left, start=26, minimum=20)
    draw.text(((left + right) // 2, cap_y), bc_content,
              font=f_cap, fill="black", anchor="ma")
    cap_y += _text_h(draw, bc_content, f_cap) + 8

    extra = f"{batch_code} · {unit_num}/{total_units}"
    if per_box > 1:
        n = in_box if in_box is not None else per_box
        if n == per_box:
            extra += f" · 1 quti = {per_box} dona"
        else:
            extra += f" · oxirgi quti: {n} dona"
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
    profile_kg: float = 0.0,
    metr: float | None = None,
    barcode_values: list[str] | None = None,
) -> io.BytesIO:
    actual = (weight_kg / quantity) if quantity > 0 else 0.0
    unit_weight = profile_kg if kg_profile_meaningful(profile_kg) else actual
    ts = created_at or datetime.now()
    if not barcode_values or len(barcode_values) != quantity:
        raise ValueError("Har bir etiketka uchun persisted barcode qiymati kerak")
    pages = [
        _build_single(batch_code, worker, product, i, quantity, unit_weight,
                      ts, sku=sku, metr=metr, barcode_value=barcode_values[i - 1])
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

    items: [{"product", "quantity", "weight_kg", "pieces_per_box",
             "sku"?, "profile_kg"?, "metr"?, "labels": [...passport rows...]}]
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
        profile_kg = float(it.get("profile_kg") or 0.0)
        metr_raw   = it.get("metr")
        metr       = float(metr_raw) if metr_raw else None

        labels = it.get("labels")
        if not isinstance(labels, list) or not labels:
            raise ValueError(
                f"{product}: persisted label passportlar berilmadi"
            )
        # Reprint uchun tashqi item yoki joriy mahsulot profili emas, aynan
        # yaratilish paytidagi passport snapshoti mutlaq manba hisoblanadi.
        first = labels[0]
        quantity = int(first.get("quantity_total") or quantity)
        per_box = max(1, int(first.get("pieces_per_box") or per_box))
        expected_labels = len(labels)
        product = str(first.get("product_name") or product)
        worker = str(first.get("worker_name") or worker)
        sku = str(first.get("product_sku") or sku)
        labels = sorted(labels, key=lambda row: int(row["label_number"]))
        expected_numbers = list(range(1, expected_labels + 1))
        actual_numbers = [int(row["label_number"]) for row in labels]
        if actual_numbers != expected_numbers:
            raise ValueError(f"{product}: label raqamlari uzluksiz emas: {actual_numbers}")

        for label in labels:
            i = int(label["label_number"])
            label_total = int(label["total_labels"])
            if label_total != expected_labels:
                raise ValueError(
                    f"{product}: passport total_labels={label_total}, "
                    f"kutilgan={expected_labels}"
                )
            label_per_box = max(1, int(label.get("pieces_per_box") or per_box))
            in_box = int(label.get("pieces_in_label") or 1)
            label_metr_raw = label.get("length_m")
            label_metr = float(label_metr_raw) if label_metr_raw is not None else None
            pages.append(_build_single(
                str(label.get("batch_code") or batch_code),
                str(label.get("worker_name") or worker),
                str(label.get("product_name") or product),
                i,
                label_total,
                float(label.get("weight_kg") or 0.0),
                ts,
                per_box=label_per_box,
                sku=str(label.get("product_sku") or sku),
                metr=label_metr,
                in_box=in_box,
                barcode_value=str(label.get("barcode_value") or ""),
            ))

    return _render_pages(pages)


def generate_label(
    batch_code: str,
    worker: str,
    product: str,
    quantity: int,
    weight_kg: float = 0.0,
    created_at: datetime | None = None,
    sku: str = "",
    profile_kg: float = 0.0,
    metr: float | None = None,
    barcode_value: str = "",
) -> io.BytesIO:
    actual = (weight_kg / quantity) if weight_kg and quantity > 0 else 0.0
    unit_weight = profile_kg if kg_profile_meaningful(profile_kg) else actual
    img = _build_single(batch_code, worker, product, 1, quantity, unit_weight,
                        created_at or datetime.now(), sku=sku, metr=metr,
                        barcode_value=barcode_value)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf
