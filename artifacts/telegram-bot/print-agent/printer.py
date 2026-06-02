import io
import tempfile
import os
import logging
import subprocess

logger = logging.getLogger(__name__)


def print_image(image_bytes: bytes, printer_name: str = "") -> bool:
    try:
        import win32print
        import win32api

        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            tmp.write(image_bytes)
            tmp_path = tmp.name

        try:
            target_printer = printer_name or win32print.GetDefaultPrinter()
            logger.info(f"Printing to: {target_printer}")
            win32api.ShellExecute(
                0,
                "printto",
                tmp_path,
                f'"{target_printer}"',
                ".",
                0,
            )
            logger.info(f"Print sent: {tmp_path}")
            return True
        finally:
            import time
            time.sleep(3)
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

    except ImportError:
        logger.error("pywin32 not installed. Run: pip install pywin32")
        return False
    except Exception as e:
        logger.error(f"Print error: {e}")
        return False


def list_printers() -> list[str]:
    try:
        import win32print
        return [p[2] for p in win32print.EnumPrinters(
            win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
        )]
    except ImportError:
        return []
