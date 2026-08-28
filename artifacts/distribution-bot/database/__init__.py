"""TopMart Distribution Bot — PostgreSQL database layer.

All SQL lives in this package. The bot code (main.py handlers) must go
through these modules — never write raw SQL in handlers.
"""

from .connection import get_db, init_db, transaction, close_pool, DatabaseUnavailable
from .users import get_user, get_admin_telegram_ids
from .customers import get_balans, update_balans_delta, apply_balans_delta, update_dokon_repeat
from .sales import (
    create_sale, create_vehicle_pilot_sale, VehiclePilotSaleError,
    VehiclePilotIdempotencyConflict,
)
from .payments import record_pul_olish, pay_nasiya_fifo
from .replenishment_delivery import (
    acknowledge, configured_recipient_ids, deliver_retryable,
)

__all__ = [
    "get_db",
    "init_db",
    "transaction",
    "close_pool",
    "DatabaseUnavailable",
    "get_user",
    "get_admin_telegram_ids",
    "get_balans",
    "update_balans_delta",
    "apply_balans_delta", "create_vehicle_pilot_sale", "VehiclePilotSaleError",
    "VehiclePilotIdempotencyConflict",
    "update_dokon_repeat",
    "create_sale",
    "record_pul_olish",
    "pay_nasiya_fifo",
    "acknowledge",
    "configured_recipient_ids",
    "deliver_retryable",
]
