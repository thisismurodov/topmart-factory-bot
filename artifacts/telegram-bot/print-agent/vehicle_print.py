from __future__ import annotations

import sqlite3
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from printer import PrintDeliveryError, PrintReceipt, print_pdf
from vehicle_api import VehicleApiClient, VehicleApiError

_BOT_ROOT = Path(__file__).resolve().parents[1]
if str(_BOT_ROOT) not in sys.path:
    sys.path.insert(0, str(_BOT_ROOT))

from bot.vehicle_label_pdf import build_batch_session_pdf


class VehiclePrintSafetyError(RuntimeError):
    pass


class ConfirmationPending(RuntimeError):
    def __init__(self, job_id: int, message: str):
        super().__init__(message)
        self.job_id = job_id


@dataclass(frozen=True)
class VehiclePrintOutcome:
    job_id: int
    handoff_id: int
    operation_key: str
    page_count: int
    is_reprint: bool
    deduplicated: bool = False
    resumed: bool = False


class PrintJobStore:
    def __init__(self, path: str):
        self.path = path
        self._init()

    def _connect(self):
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        return connection

    def _init(self) -> None:
        with self._connect() as db:
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS vehicle_print_jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    operation_key TEXT NOT NULL UNIQUE,
                    handoff_id INTEGER NOT NULL,
                    requested_mode TEXT NOT NULL,
                    state TEXT NOT NULL,
                    page_count INTEGER NOT NULL DEFAULT 0,
                    is_reprint INTEGER,
                    spool_job_id INTEGER,
                    error TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            db.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS
                    uq_vehicle_print_jobs_active_handoff
                ON vehicle_print_jobs(handoff_id)
                WHERE state IN ('claimed', 'printing', 'spooled', 'ambiguous')
                """
            )

    def get_by_key(self, operation_key: str):
        with self._connect() as db:
            return db.execute(
                "SELECT * FROM vehicle_print_jobs WHERE operation_key = ?",
                (operation_key,),
            ).fetchone()

    def get_by_id(self, job_id: int):
        with self._connect() as db:
            return db.execute(
                "SELECT * FROM vehicle_print_jobs WHERE id = ?",
                (job_id,),
            ).fetchone()

    def create(self, operation_key: str, handoff_id: int, mode: str):
        with self._connect() as db:
            cursor = db.execute(
                """
                INSERT INTO vehicle_print_jobs
                    (operation_key, handoff_id, requested_mode, state)
                VALUES (?, ?, ?, 'claimed')
                """,
                (operation_key, handoff_id, mode),
            )
            return db.execute(
                "SELECT * FROM vehicle_print_jobs WHERE id = ?",
                (cursor.lastrowid,),
            ).fetchone()

    def unresolved_for_handoff(self, handoff_id: int, excluding_key: str):
        with self._connect() as db:
            return db.execute(
                """
                SELECT * FROM vehicle_print_jobs
                 WHERE handoff_id = ? AND operation_key <> ?
                   AND state IN ('claimed', 'printing', 'spooled', 'ambiguous')
                 ORDER BY id DESC LIMIT 1
                """,
                (handoff_id, excluding_key),
            ).fetchone()

    def abandon_job(self, job_id: int) -> None:
        with self._connect() as db:
            cursor = db.execute(
                """
                UPDATE vehicle_print_jobs
                   SET state = 'abandoned',
                       error = 'Operator explicit reprint tanladi',
                       updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?
                   AND state IN ('claimed', 'printing', 'spooled', 'ambiguous')
                """,
                (job_id,),
            )
            if cursor.rowcount != 1:
                raise VehiclePrintSafetyError(
                    f"Print job #{job_id} noaniq/active holatda emas"
                )

    def update(self, job_id: int, state: str, **values) -> None:
        allowed = {"page_count", "is_reprint", "spool_job_id", "error"}
        unknown = set(values) - allowed
        if unknown:
            raise ValueError(f"Unknown job fields: {sorted(unknown)}")
        assignments = ["state = ?", "updated_at = CURRENT_TIMESTAMP"]
        params: list[object] = [state]
        for key, value in values.items():
            assignments.append(f"{key} = ?")
            params.append(value)
        params.append(job_id)
        with self._connect() as db:
            db.execute(
                f"UPDATE vehicle_print_jobs SET {', '.join(assignments)} WHERE id = ?",
                params,
            )


class VehiclePrintService:
    FIRST_PRINT_STATE = "prepared"
    REPRINT_STATES = {"labels_printed", "handed_over", "stock_transferred"}

    def __init__(
        self,
        api: VehicleApiClient,
        store: PrintJobStore,
        printer_name: str,
        *,
        renderer: Callable[[dict], object] = build_batch_session_pdf,
        printer: Callable[..., PrintReceipt] = print_pdf,
    ):
        self.api = api
        self.store = store
        self.printer_name = printer_name
        self.renderer = renderer
        self.printer = printer
        self._locks_guard = threading.Lock()
        self._locks: dict[int, threading.Lock] = {}

    def _lock_for(self, handoff_id: int) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(handoff_id, threading.Lock())

    @staticmethod
    def operation_key(
        handoff_id: int,
        chat_id: int,
        message_id: int,
        *,
        explicit_reprint: bool,
    ) -> str:
        mode = "reprint" if explicit_reprint else "print"
        return (
            f"vehicle-print:v1:{mode}:{int(handoff_id)}:"
            f"{int(chat_id)}:{int(message_id)}"
        )

    @staticmethod
    def _validate_payload(payload: dict, handoff_id: int) -> int:
        if int(payload.get("handoffId") or 0) != handoff_id:
            raise VehiclePrintSafetyError("API boshqa handoff label payloadini qaytardi")
        labels = payload.get("labels")
        total = int(payload.get("totalLabels") or 0)
        if not isinstance(labels, list) or total <= 0 or len(labels) != total:
            raise VehiclePrintSafetyError("Label payload soni noto'g'ri")
        return total

    def _confirmed_outcome(self, row, *, deduplicated=False, resumed=False):
        return VehiclePrintOutcome(
            job_id=int(row["id"]),
            handoff_id=int(row["handoff_id"]),
            operation_key=str(row["operation_key"]),
            page_count=int(row["page_count"]),
            is_reprint=bool(row["is_reprint"]),
            deduplicated=deduplicated,
            resumed=resumed,
        )

    def _confirm(self, row, *, resumed: bool) -> VehiclePrintOutcome:
        job_id = int(row["id"])
        handoff_id = int(row["handoff_id"])
        operation_key = str(row["operation_key"])
        try:
            response = self.api.confirm_printed(handoff_id, operation_key)
        except Exception as exc:
            self.store.update(job_id, "spooled", error=str(exc))
            raise ConfirmationPending(job_id, str(exc)) from exc

        handoff = response.get("handoff") or {}
        labels = response.get("labels") or {}
        if (
            int(handoff.get("id") or 0) != handoff_id
            or int(labels.get("handoffId") or 0) != handoff_id
            or response.get("atLeastOnce") is not True
        ):
            self.store.update(
                job_id,
                "spooled",
                error="API print confirmation response mismatch",
            )
            raise ConfirmationPending(
                job_id, "API print confirmation response mismatch"
            )
        is_reprint = bool(response.get("isReprint"))
        self.store.update(
            job_id,
            "confirmed",
            is_reprint=int(is_reprint),
            error=None,
        )
        fresh = self.store.get_by_id(job_id)
        return self._confirmed_outcome(fresh, resumed=resumed)

    def print_handoff(
        self,
        handoff_id: int,
        chat_id: int,
        message_id: int,
        *,
        explicit_reprint: bool = False,
    ) -> VehiclePrintOutcome:
        if handoff_id <= 0:
            raise VehiclePrintSafetyError("Handoff ID musbat son bo'lishi kerak")
        operation_key = self.operation_key(
            handoff_id,
            chat_id,
            message_id,
            explicit_reprint=explicit_reprint,
        )
        with self._lock_for(handoff_id):
            existing = self.store.get_by_key(operation_key)
            if existing is not None:
                state = str(existing["state"])
                if state == "confirmed":
                    return self._confirmed_outcome(existing, deduplicated=True)
                if state == "spooled":
                    return self._confirm(existing, resumed=True)
                if state in {"claimed", "printing", "ambiguous"}:
                    raise VehiclePrintSafetyError(
                        f"Print job #{existing['id']} holati noaniq ({state}); "
                        "avtomatik qayta chop etilmadi"
                    )
                raise VehiclePrintSafetyError(
                    f"Print job #{existing['id']} avval '{state}' bilan yakunlangan; "
                    "yangi Telegram buyrug'i yuboring"
                )

            unresolved = self.store.unresolved_for_handoff(
                handoff_id, operation_key
            )
            if unresolved is not None:
                raise VehiclePrintSafetyError(
                    f"Handoff uchun print job #{unresolved['id']} "
                    f"yakunlanmagan ({unresolved['state']}); /vehicle_resume, "
                    "/vehicle_recover yoki /vehicle_retry buyrug'idan foydalaning"
                )

            try:
                row = self.store.create(
                    operation_key,
                    handoff_id,
                    "reprint" if explicit_reprint else "print",
                )
            except sqlite3.IntegrityError as exc:
                active = self.store.unresolved_for_handoff(
                    handoff_id, operation_key
                )
                if active is not None:
                    raise VehiclePrintSafetyError(
                        f"Handoff uchun boshqa agentdagi print job "
                        f"#{active['id']} active ({active['state']})"
                    ) from exc
                replay = self.store.get_by_key(operation_key)
                if replay is not None and str(replay["state"]) == "confirmed":
                    return self._confirmed_outcome(replay, deduplicated=True)
                raise VehiclePrintSafetyError(
                    "Print job atomik claim qilinmadi; qayta chop etilmadi"
                ) from exc
            job_id = int(row["id"])
            try:
                detail = self.api.get_handoff(handoff_id)
                status = str(detail.get("status") or "")
                if not explicit_reprint and status != self.FIRST_PRINT_STATE:
                    raise VehiclePrintSafetyError(
                        f"Handoff holati '{status}'. Takroriy chop uchun "
                        "/vehicle_reprint buyrug'i shart"
                    )
                if explicit_reprint and status not in (
                    self.REPRINT_STATES
                ):
                    raise VehiclePrintSafetyError(
                        f"'{status}' holatidagi handoff reprint qilinmaydi; "
                        "birinchi bosma uchun /vehicle_print ishlating"
                    )

                try:
                    payload = self.api.get_labels(handoff_id)
                except VehicleApiError as exc:
                    if exc.status_code != 404 or status != self.FIRST_PRINT_STATE:
                        raise
                    payload = self.api.prepare_labels(
                        handoff_id, f"vehicle-prepare:v1:{handoff_id}"
                    )

                expected_pages = self._validate_payload(payload, handoff_id)
                pdf = self.renderer(payload)
                pdf_bytes = pdf.read() if hasattr(pdf, "read") else bytes(pdf)
                self.store.update(job_id, "printing", page_count=expected_pages)
                receipt = self.printer(
                    pdf_bytes,
                    self.printer_name,
                    document_name=f"TopMart handoff {handoff_id}",
                )
                if receipt.page_count != expected_pages:
                    self.store.update(
                        job_id,
                        "ambiguous",
                        spool_job_id=receipt.spool_job_id,
                        error=(
                            f"Spool pages={receipt.page_count}, "
                            f"expected={expected_pages}"
                        ),
                    )
                    raise VehiclePrintSafetyError(
                        "Windows spooler sahifa soni payloadga mos emas; "
                        "lifecycle tasdiqlanmadi"
                    )
                self.store.update(
                    job_id,
                    "spooled",
                    page_count=receipt.page_count,
                    spool_job_id=receipt.spool_job_id,
                    error=None,
                )
                return self._confirm(self.store.get_by_id(job_id), resumed=False)
            except ConfirmationPending:
                raise
            except PrintDeliveryError as exc:
                self.store.update(
                    job_id,
                    "ambiguous" if exc.may_have_printed else "failed",
                    error=str(exc),
                )
                raise
            except Exception as exc:
                current = self.store.get_by_id(job_id)
                if current is not None and str(current["state"]) == "claimed":
                    self.store.update(job_id, "failed", error=str(exc))
                raise

    def resume_confirmation(self, job_id: int) -> VehiclePrintOutcome:
        row = self.store.get_by_id(job_id)
        if row is None:
            raise VehiclePrintSafetyError(f"Print job #{job_id} topilmadi")
        state = str(row["state"])
        if state == "confirmed":
            return self._confirmed_outcome(row, deduplicated=True, resumed=True)
        if state != "spooled":
            raise VehiclePrintSafetyError(
                f"Print job #{job_id} holati '{state}'; faqat spooled job "
                "tasdiqini davom ettirish mumkin"
            )
        with self._lock_for(int(row["handoff_id"])):
            return self._confirm(row, resumed=True)

    def recover_ambiguous_confirmation(
        self, job_id: int
    ) -> VehiclePrintOutcome:
        row = self.store.get_by_id(job_id)
        if row is None:
            raise VehiclePrintSafetyError(f"Print job #{job_id} topilmadi")
        state = str(row["state"])
        if state not in {"printing", "ambiguous"}:
            raise VehiclePrintSafetyError(
                f"Print job #{job_id} holati '{state}'; recover faqat "
                "printing/ambiguous job uchun"
            )
        with self._lock_for(int(row["handoff_id"])):
            self.store.update(
                job_id,
                "spooled",
                error="Operator fizik sahifalarni tekshirib tasdiqladi",
            )
            return self._confirm(self.store.get_by_id(job_id), resumed=True)

    def retry_ambiguous(
        self,
        job_id: int,
        chat_id: int,
        message_id: int,
    ) -> VehiclePrintOutcome:
        row = self.store.get_by_id(job_id)
        if row is None:
            raise VehiclePrintSafetyError(f"Print job #{job_id} topilmadi")
        state = str(row["state"])
        if state not in {"printing", "ambiguous"}:
            raise VehiclePrintSafetyError(
                f"Print job #{job_id} holati '{state}'; retry faqat "
                "printing/ambiguous job uchun"
            )
        handoff_id = int(row["handoff_id"])
        with self._lock_for(handoff_id):
            detail = self.api.get_handoff(handoff_id)
            status = str(detail.get("status") or "")
            self.store.abandon_job(job_id)
        return self.print_handoff(
            handoff_id,
            chat_id,
            message_id,
            explicit_reprint=status in self.REPRINT_STATES,
        )