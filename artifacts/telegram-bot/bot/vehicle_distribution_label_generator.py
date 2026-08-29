"""Vehicle Distribution-only 100×80 mm label template.

This renderer intentionally stays separate from the Production Bot label
template. It reuses only the shared low-level drawing/barcode utilities.
"""
from datetime import datetime

from PIL import Image, ImageDraw

from .label_generator import (
    LABEL_H,
    LABEL_W,
    _BORDER_INSET,
    _BORDER_RADIUS,
    _BORDER_W,
    _PAD,
    _fit_font,
    _fit_value_lines,
    _font,
    _icon_calendar,
    _icon_cube,
    _icon_kg,
    _icon_person,
    _icon_ruler,
    _icon_tag,
    _make_barcode,
    _num,
    _text_h,
    _text_w,
    extract_metr,
)

VEHICLE_DISTRIBUTION_BRANDING = (
    "Top Mart — Official Partner of Diyor Mahsulotlari"
)


def build_vehicle_distribution_label(
    batch_code: str,
    worker: str,
    product: str,
    unit_num: int,
    total_units: int,
    unit_weight: float,
    ts: datetime,
    *,
    per_box: int = 1,
    sku: str = "",
    metr: float | None = None,
    in_box: int | None = None,
    piece_weight: float | None = None,
    barcode_value: str = "",
) -> Image.Image:
    """Render one branded Vehicle Distribution label page."""
    img = Image.new("RGB", (LABEL_W, LABEL_H), "white")
    draw = ImageDraw.Draw(img)

    draw.rounded_rectangle(
        (
            _BORDER_INSET,
            _BORDER_INSET,
            LABEL_W - _BORDER_INSET,
            LABEL_H - _BORDER_INSET,
        ),
        radius=_BORDER_RADIUS,
        outline="black",
        width=_BORDER_W,
    )

    left = _BORDER_INSET + _BORDER_W + _PAD
    right = LABEL_W - _BORDER_INSET - _BORDER_W - _PAD
    icon_x = left
    label_x = left + 58
    value_rx = right

    brand_font = _fit_font(
        draw, VEHICLE_DISTRIBUTION_BRANDING, right - left, start=24, minimum=16
    )
    draw.text(
        ((left + right) // 2, 31),
        VEHICLE_DISTRIBUTION_BRANDING,
        font=brand_font,
        fill="black",
        anchor="mm",
    )
    draw.line((left, 56, right, 56), fill="black", width=2)

    sku = (sku or "").strip().upper()
    if metr is None or metr <= 0:
        metr = extract_metr(product)

    pieces = in_box if in_box is not None else per_box
    if piece_weight is None and unit_weight > 0 and pieces > 0:
        piece_weight = unit_weight / pieces
    kg_txt = (
        f"JAMI {_num(unit_weight)} KG · 1 DONA {_num(piece_weight)} KG"
        if unit_weight > 0 and piece_weight is not None and piece_weight > 0
        else "—"
    )
    metr_txt = f"{_num(metr)} METR" if metr is not None else "—"
    dt_txt = f"{ts:%d.%m.%Y}  {ts:%H:%M}"
    rows = [
        (_icon_cube, "MAHSULOT NOMI:", product.upper(), 36, 24, 24),
        (_icon_tag, "MAHSULOT SKU:", sku or "—", 34, 22, 20),
        (
            lambda d, x, y: _icon_kg(d, x, y, _font),
            "MAHSULOT KG:",
            kg_txt,
            34,
            22,
            20,
        ),
        (_icon_ruler, "MAHSULOT METRI:", metr_txt, 34, 22, 20),
        (_icon_person, "KIM ISHLAB CHIQARGANI:", worker.upper(), 32, 20, 19),
        (_icon_calendar, "SANA VA SOAT:", dt_txt, 32, 20, 19),
    ]

    label_font = _font(24, bold=True)
    row_h = 58
    y = 60
    for index, (icon_fn, label, value, start, minimum, wrap_size) in enumerate(rows):
        cy = y + row_h // 2
        icon_fn(draw, icon_x, cy - 22)
        draw.text((label_x, cy), label, font=label_font, fill="black", anchor="lm")
        available = value_rx - (label_x + _text_w(draw, label, label_font) + 16)
        value_font, lines = _fit_value_lines(
            draw,
            value,
            available,
            start=start,
            minimum=minimum,
            wrap_size=wrap_size,
        )
        if len(lines) == 1:
            draw.text(
                (value_rx, cy), value, font=value_font, fill="black", anchor="rm"
            )
        else:
            line_h = getattr(value_font, "size", wrap_size) + 2
            first_y = cy - line_h * (len(lines) - 1) // 2
            for line_index, line in enumerate(lines):
                draw.text(
                    (value_rx, first_y + line_index * line_h),
                    line,
                    font=value_font,
                    fill="black",
                    anchor="rm",
                )
        y += row_h
        if index < len(rows) - 1:
            draw.line((left, y, right, y), fill="black", width=2)

    dash_y = y + 5
    x = left
    while x < right:
        draw.line((x, dash_y, min(x + 12, right), dash_y), fill="black", width=3)
        x += 22

    barcode = (barcode_value or "").strip().upper()
    barcode_img = _make_barcode(barcode, max_w=right - left, height_px=76)
    barcode_top = dash_y + 8
    img.paste(
        barcode_img,
        (left + (right - left - barcode_img.width) // 2, barcode_top),
    )

    caption_y = barcode_top + barcode_img.height + 4
    barcode_font = _fit_font(draw, barcode, right - left, start=24, minimum=18)
    draw.text(
        ((left + right) // 2, caption_y),
        barcode,
        font=barcode_font,
        fill="black",
        anchor="ma",
    )
    caption_y += _text_h(draw, barcode, barcode_font) + 5

    extra = f"{batch_code} · {unit_num}/{total_units}"
    if per_box > 1:
        if pieces == per_box:
            extra += f" · 1 quti = {per_box} dona"
        else:
            extra += f" · oxirgi quti: {pieces} dona"
    extra_font = _fit_font(draw, extra, right - left, start=22, minimum=17)
    draw.text(
        ((left + right) // 2, caption_y),
        extra,
        font=extra_font,
        fill="#222222",
        anchor="ma",
    )

    return img