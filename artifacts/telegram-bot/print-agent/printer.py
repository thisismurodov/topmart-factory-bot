import logging
from dataclasses import dataclass
from typing import Iterable

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PrintReceipt:
    printer_name: str
    page_count: int
    spool_job_id: int


class PrintDeliveryError(RuntimeError):
    def __init__(self, message: str, *, may_have_printed: bool = False):
        super().__init__(message)
        self.may_have_printed = may_have_printed


def list_printers() -> list[str]:
    try:
        import win32print
        return [
            p[2]
            for p in win32print.EnumPrinters(
                win32print.PRINTER_ENUM_LOCAL
                | win32print.PRINTER_ENUM_CONNECTIONS
            )
        ]
    except ImportError:
        return []


def require_named_printer(
    printer_name: str,
    available_printers: Iterable[str] | None = None,
) -> str:
    target = (printer_name or "").strip()
    if not target:
        raise PrintDeliveryError(
            "PRINTER_NAME bo'sh — default printerga yuborish taqiqlangan"
        )
    available = list(
        list_printers() if available_printers is None else available_printers
    )
    if target not in available:
        raise PrintDeliveryError(
            f"Sozlangan printer topilmadi: {target}. "
            f"Mavjud printerlar: {', '.join(available) or '(yoq)'}"
        )
    return target


def validate_100x80_media(
    physical_width_px: int,
    physical_height_px: int,
    dpi_x: int,
    dpi_y: int,
    *,
    tolerance_mm: float = 2.0,
) -> tuple[float, float]:
    if min(physical_width_px, physical_height_px, dpi_x, dpi_y) <= 0:
        raise PrintDeliveryError("Printer media o'lchamini aniqlab bo'lmadi")
    width_mm = physical_width_px / dpi_x * 25.4
    height_mm = physical_height_px / dpi_y * 25.4
    if (
        abs(width_mm - 100.0) > tolerance_mm
        or abs(height_mm - 80.0) > tolerance_mm
    ):
        raise PrintDeliveryError(
            f"Printer media {width_mm:.1f}×{height_mm:.1f} mm; "
            "100×80 mm profil majburiy"
        )
    return width_mm, height_mm


def validate_100x80_printable_area(
    printable_width_px: int,
    printable_height_px: int,
    dpi_x: int,
    dpi_y: int,
    *,
    max_hardware_margin_mm: float = 2.0,
) -> tuple[float, float]:
    if min(printable_width_px, printable_height_px, dpi_x, dpi_y) <= 0:
        raise PrintDeliveryError("Printer printable area o'lchami aniqlanmadi")
    width_mm = printable_width_px / dpi_x * 25.4
    height_mm = printable_height_px / dpi_y * 25.4
    minimum_width = 100.0 - max_hardware_margin_mm
    minimum_height = 80.0 - max_hardware_margin_mm
    if width_mm < minimum_width or height_mm < minimum_height:
        raise PrintDeliveryError(
            f"Printer printable area {width_mm:.1f}×{height_mm:.1f} mm; "
            f"100×80 profil uchun kamida {minimum_width:.1f}×"
            f"{minimum_height:.1f} mm kerak"
        )
    return width_mm, height_mm


def _spool_images(images, printer_name: str, document_name: str) -> PrintReceipt:
    try:
        import win32con
        import win32ui
        from PIL import ImageWin
    except ImportError as exc:
        raise PrintDeliveryError(
            "pywin32/Pillow o'rnatilmagan; install.bat ni qayta ishga tushiring"
        ) from exc

    target = require_named_printer(printer_name)
    pages = list(images)
    if not pages:
        raise PrintDeliveryError("Chop etiladigan sahifa yo'q")

    dc = win32ui.CreateDC()
    started = False
    ended = False
    job_id = 0
    try:
        dc.CreatePrinterDC(target)
        validate_100x80_media(
            int(dc.GetDeviceCaps(win32con.PHYSICALWIDTH)),
            int(dc.GetDeviceCaps(win32con.PHYSICALHEIGHT)),
            int(dc.GetDeviceCaps(win32con.LOGPIXELSX)),
            int(dc.GetDeviceCaps(win32con.LOGPIXELSY)),
        )
        printable_w = int(dc.GetDeviceCaps(win32con.HORZRES))
        printable_h = int(dc.GetDeviceCaps(win32con.VERTRES))
        validate_100x80_printable_area(
            printable_w,
            printable_h,
            int(dc.GetDeviceCaps(win32con.LOGPIXELSX)),
            int(dc.GetDeviceCaps(win32con.LOGPIXELSY)),
        )
        job_id = int(dc.StartDoc(document_name) or 0)
        started = True
        if job_id <= 0:
            raise PrintDeliveryError(
                "Windows spooler job ID qaytarmadi",
                may_have_printed=True,
            )
        for image in pages:
            page = image.convert("RGB")
            scale = min(printable_w / page.width, printable_h / page.height)
            draw_w = max(1, round(page.width * scale))
            draw_h = max(1, round(page.height * scale))
            left = (printable_w - draw_w) // 2
            top = (printable_h - draw_h) // 2
            dc.StartPage()
            ImageWin.Dib(page).draw(
                dc.GetHandleOutput(),
                (left, top, left + draw_w, top + draw_h),
            )
            dc.EndPage()
        dc.EndDoc()
        ended = True
        logger.info(
            "Windows spooler qabul qildi: printer=%s pages=%s job=%s",
            target,
            len(pages),
            job_id,
        )
        return PrintReceipt(target, len(pages), job_id)
    except PrintDeliveryError:
        raise
    except Exception as exc:
        if started and not ended:
            try:
                dc.AbortDoc()
            except Exception:
                pass
        raise PrintDeliveryError(
            f"Windows spooler xatosi: {exc}",
            may_have_printed=started,
        ) from exc
    finally:
        try:
            dc.DeleteDC()
        except Exception:
            pass


def print_pdf(
    pdf_bytes: bytes,
    printer_name: str,
    *,
    document_name: str = "TopMart vehicle labels",
) -> PrintReceipt:
    if not pdf_bytes.startswith(b"%PDF"):
        raise PrintDeliveryError("Vehicle etiketka fayli PDF emas")
    try:
        import fitz
        from PIL import Image
    except ImportError as exc:
        raise PrintDeliveryError(
            "PyMuPDF/Pillow o'rnatilmagan; install.bat ni qayta ishga tushiring"
        ) from exc

    try:
        document = fitz.open(stream=pdf_bytes, filetype="pdf")
        scale = 203 / 72
        images = []
        for page in document:
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            images.append(Image.frombytes("RGB", (pix.width, pix.height), pix.samples))
        return _spool_images(images, printer_name, document_name)
    except PrintDeliveryError:
        raise
    except Exception as exc:
        raise PrintDeliveryError(f"PDF o'qilmadi: {exc}") from exc


def print_image(image_bytes: bytes, printer_name: str) -> bool:
    try:
        import io
        from PIL import Image

        image = Image.open(io.BytesIO(image_bytes))
        _spool_images([image], printer_name, "TopMart legacy label")
        return True
    except Exception as exc:
        logger.error("Print error: %s", exc)
        return False
