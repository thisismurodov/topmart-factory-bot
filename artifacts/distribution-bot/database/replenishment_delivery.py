"""Durable Telegram delivery for automatic vehicle replenishment requests."""

import os
import threading
import uuid

from .connection import transaction

ENV_NAME = "VEHICLE_REPLENISHMENT_TELEGRAM_CHAT_IDS"
SCHEMA_APPROVAL_ENV_NAME = "VEHICLE_DISTRIBUTION_SCHEMA_APPROVED"
MAX_ATTEMPTS = 5
CLAIM_STALE_MINUTES = 5
CLAIM_HEARTBEAT_SECONDS = 30


def vehicle_schema_approved(environ=None):
    """Keep delivery and acknowledgement inert unless schema use is approved."""
    source = os.environ if environ is None else environ
    return source.get(SCHEMA_APPROVAL_ENV_NAME) == "1"


def configured_recipient_ids(environ=None):
    """Return only explicitly configured chat IDs; malformed config is rejected."""
    source = os.environ if environ is None else environ
    raw = source.get(ENV_NAME, "").strip()
    if not raw:
        return ()
    recipients = []
    seen = set()
    for token in raw.split(","):
        token = token.strip()
        if not token or not token.lstrip("-").isdigit():
            raise ValueError("%s must contain comma-separated integer IDs" % ENV_NAME)
        recipient = int(token)
        if recipient == 0:
            raise ValueError("%s cannot contain zero" % ENV_NAME)
        if recipient not in seen:
            recipients.append(recipient)
            seen.add(recipient)
    return tuple(recipients)


def claim_retryable(limit=10):
    """Claim due rows transactionally, then return them after locks are released."""
    limit = max(1, min(int(limit), 50))
    claim_token = uuid.uuid4().hex
    with transaction() as c:
        c.execute(
            """WITH candidates AS (
                 SELECT id
                   FROM distribution.vehicle_replenishment_outbox
                  WHERE status IN ('PENDING','FAILED')
                    AND attempt_count < %s
                    AND next_attempt_at <= NOW()
                    AND (claimed_at IS NULL OR claimed_at < NOW() - (%s * INTERVAL '1 minute'))
                  ORDER BY next_attempt_at,id
                  FOR UPDATE SKIP LOCKED
                  LIMIT %s
               )
               UPDATE distribution.vehicle_replenishment_outbox o
                   SET claimed_at=NOW(),claim_token=%s,
                       attempt_count=o.attempt_count+1,updated_at=NOW()
                 FROM candidates
                WHERE o.id=candidates.id
               RETURNING o.id""",
            (MAX_ATTEMPTS, CLAIM_STALE_MINUTES, limit, claim_token),
        )
        ids = [row[0] for row in c.fetchall()]
        if not ids:
            return []
        c.execute(
            """SELECT o.id,o.request_id,o.recipient_chat_id,o.attempt_count,o.claim_token,
                      r.vehicle_id,r.product_name,r.sku,r.requested_quantity,
                      r.current_quantity_snapshot,r.target_quantity_snapshot
                 FROM distribution.vehicle_replenishment_outbox o
                 JOIN distribution.vehicle_replenishment_requests r ON r.id=o.request_id
                WHERE o.id=ANY(%s)
                ORDER BY o.id""",
            (ids,),
        )
        return c.fetchall()


def _renew_claim(outbox_id, claim_token):
    with transaction() as c:
        c.execute(
            """UPDATE distribution.vehicle_replenishment_outbox
                  SET claimed_at=NOW(),updated_at=NOW()
                WHERE id=%s AND claim_token=%s
                  AND status IN ('PENDING','FAILED')""",
            (outbox_id, claim_token),
        )
        return c.rowcount == 1


def _mark_sent(outbox_id, claim_token, message_id):
    with transaction() as c:
        c.execute(
            """UPDATE distribution.vehicle_replenishment_outbox
                  SET status='SENT',telegram_message_id=%s,sent_at=NOW(),
                      claimed_at=NULL,claim_token=NULL,last_error=NULL,updated_at=NOW()
                WHERE id=%s AND claim_token=%s
                  AND status IN ('PENDING','FAILED')""",
            (message_id, outbox_id, claim_token),
        )
        return c.rowcount == 1


def _mark_failed(outbox_id, claim_token, attempt_count, error):
    delay_minutes = min(60, 2 ** max(0, attempt_count - 1))
    with transaction() as c:
        c.execute(
            """UPDATE distribution.vehicle_replenishment_outbox
                  SET status='FAILED',last_error=%s,claimed_at=NULL,claim_token=NULL,
                      next_attempt_at=NOW()+(%s * INTERVAL '1 minute'),updated_at=NOW()
                WHERE id=%s AND claim_token=%s
                  AND status IN ('PENDING','FAILED')""",
            (str(error)[:2000], delay_minutes, outbox_id, claim_token),
        )
        return c.rowcount == 1


class _ClaimHeartbeat:
    def __init__(self, outbox_id, claim_token):
        self.outbox_id = outbox_id
        self.claim_token = claim_token
        self.stop = threading.Event()
        self.thread = None

    def __enter__(self):
        def run():
            while not self.stop.wait(CLAIM_HEARTBEAT_SECONDS):
                if not _renew_claim(self.outbox_id, self.claim_token):
                    return

        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.stop.set()
        self.thread.join(timeout=1)


def _message(row):
    (_, request_id, _, _, _, vehicle_id, product_name, sku, requested,
     current, target) = row
    return (
        "🚚 Mashina zaxirasini to'ldirish kerak\n"
        "So'rov: #%s | Mashina: #%s\n"
        "Mahsulot: %s (%s)\n"
        "Hozir: %s | Maqsad: %s | Kerak: %s"
        % (request_id, vehicle_id, product_name, sku, current, target, requested)
    )


def deliver_retryable(bot, markup_factory, limit=10):
    """Perform network sends for a claimed batch. The caller supplies TeleBot."""
    if not vehicle_schema_approved():
        return 0
    configured = set(configured_recipient_ids())
    delivered = 0
    for row in claim_retryable(limit):
        outbox_id, _, recipient_id, attempt_count, claim_token = row[:5]
        if recipient_id not in configured:
            _mark_failed(
                outbox_id,
                claim_token,
                attempt_count,
                "recipient is no longer configured",
            )
            continue
        try:
            with _ClaimHeartbeat(outbox_id, claim_token):
                sent = bot.send_message(
                    recipient_id,
                    _message(row),
                    reply_markup=markup_factory(outbox_id),
                )
            if _mark_sent(
                outbox_id, claim_token, getattr(sent, "message_id", None)
            ):
                delivered += 1
        except Exception as exc:
            _mark_failed(outbox_id, claim_token, attempt_count, exc)
    return delivered


def acknowledge(outbox_id, recipient_id):
    """Acknowledge from the configured recipient; repeated ACKs are successful."""
    if not vehicle_schema_approved():
        return False
    try:
        configured = set(configured_recipient_ids())
        outbox_id = int(outbox_id)
        recipient_id = int(recipient_id)
    except (TypeError, ValueError):
        return False
    if recipient_id not in configured:
        return False
    with transaction() as c:
        c.execute(
            """UPDATE distribution.vehicle_replenishment_outbox
                  SET status='ACKNOWLEDGED',
                      acknowledged_at=COALESCE(acknowledged_at,NOW()),updated_at=NOW()
                WHERE id=%s AND recipient_chat_id=%s
                  AND status IN ('SENT','ACKNOWLEDGED')
                RETURNING id""",
            (outbox_id, recipient_id),
        )
        return c.fetchone() is not None